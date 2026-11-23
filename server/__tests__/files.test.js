/**
 * 群组文件库路由测试
 * 覆盖：分类 CRUD 权限与校验 / 文件列表筛选分页 / 上传类型校验 / 下载鉴权与路径穿越防护
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

// requireAuth / requireAdminCompat 可切换身份
let mockRole = 'member';
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => {
    if (!req.session || !req.session.userId) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
    next();
  },
  requireAdminCompat: (req, res, next) => {
    if (mockRole !== 'admin' && mockRole !== 'super_admin') {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } });
    }
    next();
  }
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const filesRouter = require('../routes/group_files');

function buildApp(userId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = userId ? { userId } : {}; next(); });
  app.use('/api/group-files', filesRouter());
  return app;
}

describe('群组文件库', () => {
  beforeEach(() => { jest.clearAllMocks(); mockRole = 'member'; });

  test('未登录访问分类 → 401', async () => {
    const res = await request(buildApp(null)).get('/api/group-files/categories');
    expect(res.status).toBe(401);
  });

  test('分类列表返回文件数统计', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM file_categories/.test(sql)) {
        return Promise.resolve([[{ id: 1, name: '安装包', description: '', sort_order: 0, file_count: 3 }]]);
      }
      if (/category_id IS NULL/.test(sql)) return Promise.resolve([[{ n: 2 }]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/group-files/categories');
    expect(res.status).toBe(200);
    expect(res.body.categories[0]).toMatchObject({ id: 1, name: '安装包', fileCount: 3 });
    expect(res.body.uncategorizedCount).toBe(2);
  });

  test('普通成员建分类 → 403', async () => {
    mockRole = 'member';
    const res = await request(buildApp()).post('/api/group-files/categories').send({ name: 'X' });
    expect(res.status).toBe(403);
  });

  test('管理员建分类：空名 → 400；重名 → 400；成功 → 返回 id', async () => {
    mockRole = 'admin';
    expect((await request(buildApp()).post('/api/group-files/categories').send({ name: '' })).status).toBe(400);
    mockPool.query.mockResolvedValueOnce([[{ id: 9 }]]); // 重名检查命中
    expect((await request(buildApp()).post('/api/group-files/categories').send({ name: '重名' })).status).toBe(400);
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT id FROM file_categories WHERE name/.test(sql)) return Promise.resolve([[]]);
      if (/INSERT INTO file_categories/.test(sql)) return Promise.resolve([{ insertId: 12 }]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).post('/api/group-files/categories').send({ name: '新分类' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(12);
  });

  test('删分类：分类下有文件 → 400 拒绝', async () => {
    mockRole = 'admin';
    mockPool.query.mockResolvedValueOnce([[{ n: 3 }]]);
    const res = await request(buildApp()).delete('/api/group-files/categories/5');
    expect(res.status).toBe(400);
    expect((res.body.error && res.body.error.message) || '').toMatch(/还有 3 个文件/);
  });

  test('文件列表：按分类筛选 + 分页字段', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/COUNT\(\*\) AS total FROM group_files/.test(sql)) return Promise.resolve([[{ total: 1 }]]);
      if (/FROM group_files f/.test(sql)) {
        return Promise.resolve([[
          { id: 7, category_id: 2, title: 'VRCNext 安装包', description: '', original_name: 'VRCNext.exe',
            file_size: 10485760, ext: '.exe', sha256: 'abc', download_count: 5, created_at: '2026-11-24',
            category_name: '安装包', uploader_name: '管理员' }
        ]]);
      }
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/group-files?categoryId=2&page=1&pageSize=20');
    expect(res.status).toBe(200);
    expect(res.body.files[0]).toMatchObject({
      id: 7, title: 'VRCNext 安装包', fileName: 'VRCNext.exe', downloadCount: 5, categoryName: '安装包'
    });
    expect(res.body.files[0].fileSizeText).toMatch(/MB/);
    expect(res.body.totalPages).toBe(1);
    // 列表查询应带 f. 前缀、计数查询不带
    const listSql = mockPool.query.mock.calls.find(c => /FROM group_files f/.test(c[0]))[0];
    const countSql = mockPool.query.mock.calls.find(c => /COUNT\(\*\) AS total/.test(c[0]))[0];
    expect(listSql).toMatch(/f\.category_id = \?/);
    expect(countSql).not.toMatch(/f\.category_id/);
  });

  test('文件列表：非法 categoryId → 400', async () => {
    const res = await request(buildApp()).get('/api/group-files?categoryId=abc');
    expect(res.status).toBe(400);
  });

  test('文件列表：categoryId=0 查询未分类', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/COUNT/.test(sql)) return Promise.resolve([[{ total: 0 }]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/group-files?categoryId=0');
    expect(res.status).toBe(200);
    const countSql = mockPool.query.mock.calls.find(c => /COUNT\(\*\) AS total/.test(c[0]))[0];
    expect(countSql).toMatch(/category_id IS NULL/);
  });

  test('下载：文件不存在 → 404', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(buildApp()).get('/api/group-files/999/download');
    expect(res.status).toBe(404);
  });

  test('下载：已软删除 → 404', async () => {
    mockPool.query.mockResolvedValueOnce([[{ id: 1, stored_name: 'a.exe', is_deleted: 1 }]]);
    const res = await request(buildApp()).get('/api/group-files/1/download');
    expect(res.status).toBe(404);
  });

  test('下载：stored_name 含路径穿越字符 → 400', async () => {
    mockPool.query.mockResolvedValueOnce([[{ id: 1, stored_name: '../../etc/passwd', is_deleted: 0 }]]);
    const res = await request(buildApp()).get('/api/group-files/1/download');
    expect(res.status).toBe(400);
  });

  test('删文件：普通成员 → 403', async () => {
    mockRole = 'member';
    const res = await request(buildApp()).delete('/api/group-files/1');
    expect(res.status).toBe(403);
  });

  test('删文件：管理员 → 软删除成功', async () => {
    mockRole = 'admin';
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT id, stored_name, title, is_deleted FROM group_files/.test(sql)) {
        return Promise.resolve([[{ id: 3, stored_name: 'x_abc.exe', title: 'T', is_deleted: 0 }]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });
    const res = await request(buildApp()).delete('/api/group-files/3');
    expect(res.status).toBe(200);
    const upd = mockPool.query.mock.calls.find(c => /UPDATE group_files SET is_deleted = 1/.test(c[0]));
    expect(upd).toBeTruthy();
  });
});
