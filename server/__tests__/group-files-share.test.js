/**
 * 群组文件库：临时分享链接（token）测试
 */
const request = require('supertest');
const express = require('express');

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
let mockAdmin = true;
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => req.session && req.session.userId ? next() : res.status(401).json({ success: false }),
  requireAdminCompat: (req, res, next) => mockAdmin ? next() : res.status(403).json({ success: false })
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

const TOKEN = 'a'.repeat(64);

describe('临时分享链接', () => {
  beforeEach(() => { jest.clearAllMocks(); mockAdmin = true; });

  test('生成链接：文件不存在 → 404', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(app()).post('/api/group-files/99/share').send({ expiresInHours: 24 });
    expect(res.status).toBe(404);
  });

  test('生成链接：返回 64 位 token 与过期时间', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT id, title FROM group_files/.test(sql)) return Promise.resolve([[{ id: 5, title: 'T' }]]);
      if (/INSERT INTO file_share_links/.test(sql)) return Promise.resolve([{ insertId: 11 }]);
      if (/SELECT expires_at FROM file_share_links/.test(sql)) return Promise.resolve([[{ expires_at: '2026-11-25 12:00:00' }]]);
      return Promise.resolve([[]]);
    });
    const res = await request(app()).post('/api/group-files/5/share').send({ expiresInHours: 24, maxDownloads: 10 });
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.url).toBe('/api/group-files/share/' + res.body.token);
    expect(res.body.expiresInHours).toBe(24);
    expect(res.body.maxDownloads).toBe(10);
  });

  test('生成链接：expiresInHours 超上限被钳制到 30 天', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT id, title FROM group_files/.test(sql)) return Promise.resolve([[{ id: 5 }]]);
      if (/INSERT INTO file_share_links/.test(sql)) return Promise.resolve([{ insertId: 11 }]);
      if (/SELECT expires_at/.test(sql)) return Promise.resolve([[{ expires_at: '2026-12-24' }]]);
      return Promise.resolve([[]]);
    });
    const res = await request(app()).post('/api/group-files/5/share').send({ expiresInHours: 99999 });
    expect(res.body.expiresInHours).toBe(30 * 24);
  });

  test('普通成员不能生成链接 → 403', async () => {
    mockAdmin = false;
    const res = await request(app()).post('/api/group-files/5/share').send({});
    expect(res.status).toBe(403);
  });

  test('公开下载：token 格式非法 → 400', async () => {
    const res = await request(app(null)).get('/api/group-files/share/badtoken');
    expect(res.status).toBe(400);
  });

  test('公开下载：token 不存在 → 404', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(app(null)).get('/api/group-files/share/' + TOKEN);
    expect(res.status).toBe(404);
  });

  test('公开下载：已撤销 → 403', async () => {
    mockPool.query.mockResolvedValueOnce([[
      { id: 1, file_id: 5, expires_at: '2099-01-01', max_downloads: 0, download_count: 0, is_revoked: 1,
        original_name: 'a.zip', stored_name: 'x.zip', mime_type: 'application/zip', is_deleted: 0 }
    ]]);
    const res = await request(app(null)).get('/api/group-files/share/' + TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/撤销/);
  });

  test('公开下载：已过期 → 403', async () => {
    mockPool.query.mockResolvedValueOnce([[
      { id: 1, file_id: 5, expires_at: '2020-01-01', max_downloads: 0, download_count: 0, is_revoked: 0,
        original_name: 'a.zip', stored_name: 'x.zip', mime_type: 'application/zip', is_deleted: 0 }
    ]]);
    const res = await request(app(null)).get('/api/group-files/share/' + TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/过期/);
  });

  test('公开下载：次数用尽 → 403', async () => {
    mockPool.query.mockResolvedValueOnce([[
      { id: 1, file_id: 5, expires_at: '2099-01-01', max_downloads: 3, download_count: 3, is_revoked: 0,
        original_name: 'a.zip', stored_name: 'x.zip', mime_type: 'application/zip', is_deleted: 0 }
    ]]);
    const res = await request(app(null)).get('/api/group-files/share/' + TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/上限/);
  });

  test('公开下载：路径穿越的 stored_name → 400', async () => {
    mockPool.query.mockResolvedValueOnce([[
      { id: 1, file_id: 5, expires_at: '2099-01-01', max_downloads: 0, download_count: 0, is_revoked: 0,
        original_name: 'a.zip', stored_name: '../../etc/passwd', mime_type: 'application/zip', is_deleted: 0 }
    ]]);
    const res = await request(app(null)).get('/api/group-files/share/' + TOKEN);
    expect(res.status).toBe(400);
  });

  test('撤销链接：成功', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const res = await request(app()).delete('/api/group-files/share/11');
    expect(res.status).toBe(200);
    const upd = mockPool.query.mock.calls[0][0];
    expect(upd).toMatch(/SET is_revoked = 1/);
  });

  test('撤销链接：不存在 → 404', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const res = await request(app()).delete('/api/group-files/share/999');
    expect(res.status).toBe(404);
  });

  test('列出分享链接：返回状态字段', async () => {
    mockPool.query.mockResolvedValueOnce([[
      { id: 1, token: TOKEN, expires_at: '2099-01-01', max_downloads: 5, download_count: 2,
        is_revoked: 0, created_at: '2026-11-24', creator_name: 'admin' }
    ]]);
    const res = await request(app()).get('/api/group-files/5/shares');
    expect(res.status).toBe(200);
    expect(res.body.links[0]).toMatchObject({
      id: 1, maxDownloads: 5, downloadCount: 2, isRevoked: false, expired: false
    });
  });
});
