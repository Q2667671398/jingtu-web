/**
 * 群组文件库增强测试：版本管理 + 分片上传
 */
const request = require('supertest');
const express = require('express');
const fs = require('fs');
const path = require('path');

const mockPool = { query: jest.fn() };
jest.mock('../utils', () => {
  const actual = jest.requireActual('../utils');
  return {
    ...actual,
    getPool: () => mockPool,
    sendError: (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } }),
    handleError: (res, e) => res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: e.message } }),
    logOper: jest.fn(() => Promise.resolve()),
    ErrorCodes: actual.ErrorCodes,
    paginate: (req, opts = {}) => {
      const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), 10000);
      const pageSize = Math.min(opts.maxSize || 100, Math.max(1, parseInt(req.query.pageSize, 10) || opts.defaultSize || 20));
      return { page, pageSize, offset: (page - 1) * pageSize };
    }
  };
});
let mockRole = 'admin';
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => req.session && req.session.userId ? next() : res.status(401).json({ success: false }),
  requireAdminCompat: (req, res, next) => (mockRole === 'admin' || mockRole === 'super_admin')
    ? next() : res.status(403).json({ success: false })
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const router = require('../routes/group_files');

function app(userId = 1) {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.session = userId ? { userId } : {}; next(); });
  a.use('/api/group-files', router());
  return a;
}

describe('群组文件库 · 版本管理', () => {
  beforeEach(() => { jest.clearAllMocks(); mockRole = 'admin'; });

  test('列表默认只查最新版本', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/COUNT/.test(sql)) return Promise.resolve([[{ total: 0 }]]);
      return Promise.resolve([[]]);
    });
    await request(app()).get('/api/group-files');
    const countSql = mockPool.query.mock.calls.find(c => /COUNT\(\*\) AS total/.test(c[0]))[0];
    expect(countSql).toMatch(/is_latest = 1/);
  });

  test('allVersions=1 时不加 is_latest 过滤', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/COUNT/.test(sql)) return Promise.resolve([[{ total: 0 }]]);
      return Promise.resolve([[]]);
    });
    await request(app()).get('/api/group-files?allVersions=1');
    const countSql = mockPool.query.mock.calls.find(c => /COUNT\(\*\) AS total/.test(c[0]))[0];
    expect(countSql).not.toMatch(/is_latest = 1/);
  });

  test('版本历史接口返回同组所有版本', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT file_group_id FROM group_files/.test(sql)) return Promise.resolve([[{ file_group_id: 7 }]]);
      if (/WHERE f\.file_group_id = \?/.test(sql)) {
        return Promise.resolve([[
          { id: 10, title: 'T', original_name: 'a.zip', file_size: 100, ext: '.zip', version: '2', is_latest: 1, download_count: 3, created_at: '2026-11-24' },
          { id: 5, title: 'T', original_name: 'a.zip', file_size: 90, ext: '.zip', version: '1', is_latest: 0, download_count: 9, created_at: '2026-11-20' }
        ]]);
      }
      return Promise.resolve([[]]);
    });
    const res = await request(app()).get('/api/group-files/10/versions');
    expect(res.status).toBe(200);
    expect(res.body.fileGroupId).toBe(7);
    expect(res.body.versions).toHaveLength(2);
    expect(res.body.versions[0]).toMatchObject({ version: '2', isLatest: true });
    expect(res.body.versions[1]).toMatchObject({ version: '1', isLatest: false });
  });

  test('版本历史：文件不存在 → 404', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(app()).get('/api/group-files/999/versions');
    expect(res.status).toBe(404);
  });

  test('普通成员不能初始化分片上传 → 403', async () => {
    mockRole = 'member';
    const res = await request(app()).post('/api/group-files/upload/init').send({
      fileHash: 'a'.repeat(64), fileName: 'x.zip', totalSize: 1000, chunkSize: 5242880
    });
    expect(res.status).toBe(403);
  });
});

describe('群组文件库 · 分片上传', () => {
  beforeEach(() => { jest.clearAllMocks(); mockRole = 'admin'; });

  test('init：非法 fileHash → 400', async () => {
    const res = await request(app()).post('/api/group-files/upload/init').send({
      fileHash: 'xyz', fileName: 'x.zip', totalSize: 1000, chunkSize: 5242880
    });
    expect(res.status).toBe(400);
  });

  test('init：超过大小上限 → 400', async () => {
    const res = await request(app()).post('/api/group-files/upload/init').send({
      fileHash: 'a'.repeat(64), fileName: 'x.zip', totalSize: 5 * 1024 * 1024 * 1024, chunkSize: 5242880
    });
    expect(res.status).toBe(400);
  });

  test('init：危险扩展名 → 400', async () => {
    const res = await request(app()).post('/api/group-files/upload/init').send({
      fileHash: 'a'.repeat(64), fileName: 'shell.php', totalSize: 1000, chunkSize: 5242880
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/扩展名/);
  });

  test('init：新建会话返回 uploadId/totalChunks', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT id, received_chunks/.test(sql)) return Promise.resolve([[]]); // 无可复用会话
      if (/INSERT INTO file_upload_sessions/.test(sql)) return Promise.resolve([{ affectedRows: 1 }]);
      return Promise.resolve([[]]);
    });
    const res = await request(app()).post('/api/group-files/upload/init').send({
      fileHash: 'a'.repeat(64), fileName: 'x.zip', totalSize: 12 * 1024 * 1024, chunkSize: 5 * 1024 * 1024
    });
    expect(res.status).toBe(200);
    expect(res.body.uploadId).toMatch(/^[a-f0-9]{32}$/);
    expect(res.body.totalChunks).toBe(3);
    expect(res.body.resumed).toBe(false);
  });

  test('chunk：uploadId 非法 → 400', async () => {
    const res = await request(app()).post('/api/group-files/upload/chunk?uploadId=bad&index=0');
    expect(res.status).toBe(400);
  });

  test('chunk：会话不属于当前用户 → 403', async () => {
    mockPool.query.mockResolvedValueOnce([[{ id: 'a'.repeat(32), uploader_id: 999, total_chunks: 3, status: 'uploading' }]]);
    const res = await request(app(1)).post(`/api/group-files/upload/chunk?uploadId=${'a'.repeat(32)}&index=0`);
    expect(res.status).toBe(403);
  });

  test('chunk：分片序号越界 → 400', async () => {
    mockPool.query.mockResolvedValueOnce([[{ id: 'a'.repeat(32), uploader_id: 1, total_chunks: 3, status: 'uploading' }]]);
    const res = await request(app(1)).post(`/api/group-files/upload/chunk?uploadId=${'a'.repeat(32)}&index=99`);
    expect(res.status).toBe(400);
  });

  test('complete：会话不存在 → 404', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(app()).post('/api/group-files/upload/complete').send({ uploadId: 'b'.repeat(32) });
    expect(res.status).toBe(404);
  });

  test('complete：已完成会话 → 400', async () => {
    mockPool.query.mockResolvedValueOnce([[{
      id: 'b'.repeat(32), uploader_id: 1, status: 'completed', total_chunks: 1
    }]]);
    const res = await request(app()).post('/api/group-files/upload/complete').send({ uploadId: 'b'.repeat(32) });
    expect(res.status).toBe(400);
  });
});
