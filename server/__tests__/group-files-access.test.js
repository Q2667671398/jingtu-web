/**
 * 群组文件库：下载权限 / 批量移动 / 维护 测试
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

describe('下载权限细分', () => {
  beforeEach(() => { jest.clearAllMocks(); mockRole = 'admin'; });

  function mockFile(accessLevel, groupIds) {
    return {
      id: 1, original_name: 'a.zip', stored_name: 'x_abc.zip', file_size: 10,
      mime_type: 'application/zip', is_deleted: 0,
      access_level: accessLevel, allowed_group_ids: groupIds
    };
  }

  test('access_level=all：普通成员可下载', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT role FROM users/.test(sql)) return Promise.resolve([[{ role: 'member' }]]);
      if (/FROM group_files WHERE id = \?/.test(sql)) return Promise.resolve([[mockFile('all', null)]]);
      if (/UPDATE group_files SET download_count/.test(sql)) return Promise.resolve([{}]);
      return Promise.resolve([[]]);
    });
    const res = await request(app(2)).get('/api/group-files/1/download');
    // 文件不存在于磁盘 → 404，但权限已通过（说明未被 403 拦）
    expect(res.status).not.toBe(403);
  });

  test('access_level=admin：普通成员 → 403', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT role FROM users/.test(sql)) return Promise.resolve([[{ role: 'member' }]]);
      if (/FROM group_files WHERE id = \?/.test(sql)) return Promise.resolve([[mockFile('admin', null)]]);
      return Promise.resolve([[]]);
    });
    const res = await request(app(2)).get('/api/group-files/1/download');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/仅管理员/);
  });

  test('access_level=admin：管理员放行', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT role FROM users/.test(sql)) return Promise.resolve([[{ role: 'admin' }]]);
      if (/FROM group_files WHERE id = \?/.test(sql)) return Promise.resolve([[mockFile('admin', null)]]);
      return Promise.resolve([[]]);
    });
    const res = await request(app(1)).get('/api/group-files/1/download');
    expect(res.status).not.toBe(403);
  });

  test('access_level=groups：用户不在分组 → 403', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT role FROM users/.test(sql)) return Promise.resolve([[{ role: 'member' }]]);
      if (/FROM group_files WHERE id = \?/.test(sql)) return Promise.resolve([[mockFile('groups', '[3,4]')]]);
      if (/FROM user_group_membership/.test(sql)) return Promise.resolve([[]]); // 不在任何允许分组
      return Promise.resolve([[]]);
    });
    const res = await request(app(2)).get('/api/group-files/1/download');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/用户组/);
  });

  test('access_level=groups：用户在允许分组 → 放行', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT role FROM users/.test(sql)) return Promise.resolve([[{ role: 'member' }]]);
      if (/FROM group_files WHERE id = \?/.test(sql)) return Promise.resolve([[mockFile('groups', '[3,4]')]]);
      if (/FROM user_group_membership/.test(sql)) return Promise.resolve([[{ 1: 1 }]]); // 命中
      return Promise.resolve([[]]);
    });
    const res = await request(app(2)).get('/api/group-files/1/download');
    expect(res.status).not.toBe(403);
  });
});

describe('批量移动分类', () => {
  beforeEach(() => { jest.clearAllMocks(); mockRole = 'admin'; });

  test('空 ids → 400', async () => {
    const res = await request(app()).post('/api/group-files/batch-move').send({ ids: [], categoryId: 1 });
    expect(res.status).toBe(400);
  });

  test('超过 200 个 → 400', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    const res = await request(app()).post('/api/group-files/batch-move').send({ ids, categoryId: 1 });
    expect(res.status).toBe(400);
  });

  test('目标分类不存在 → 400', async () => {
    mockPool.query.mockResolvedValueOnce([[]]); // 分类查不到
    const res = await request(app()).post('/api/group-files/batch-move').send({ ids: [1, 2], categoryId: 99 });
    expect(res.status).toBe(400);
  });

  test('移到未分类（categoryId=0）成功', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/UPDATE group_files SET category_id/.test(sql)) return Promise.resolve([{ affectedRows: 2 }]);
      return Promise.resolve([[]]);
    });
    const res = await request(app()).post('/api/group-files/batch-move').send({ ids: [1, 2], categoryId: 0 });
    expect(res.status).toBe(200);
    expect(res.body.moved).toBe(2);
    const upd = mockPool.query.mock.calls.find(c => /UPDATE group_files SET category_id/.test(c[0]));
    expect(upd[1][0]).toBeNull(); // 移到未分类
  });

  test('普通成员 → 403', async () => {
    mockRole = 'member';
    const res = await request(app()).post('/api/group-files/batch-move').send({ ids: [1], categoryId: 1 });
    expect(res.status).toBe(403);
  });
});

describe('维护接口', () => {
  beforeEach(() => { jest.clearAllMocks(); mockRole = 'admin'; });

  test('清理过期会话返回 removed', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT id FROM file_upload_sessions/.test(sql)) return Promise.resolve([[]]);
      if (/DELETE FROM file_upload_sessions/.test(sql)) return Promise.resolve([{ affectedRows: 3 }]);
      return Promise.resolve([[]]);
    });
    const res = await request(app()).post('/api/group-files/maintenance/cleanup-sessions').send({});
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(3);
  });

  test('孤儿扫描：统计 broken 与 orphan', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT id, stored_name, title FROM group_files/.test(sql)) {
        // 一个磁盘不存在的文件 → broken
        return Promise.resolve([[{ id: 1, stored_name: 'not_exist_xyz.zip', title: 'T' }]]);
      }
      return Promise.resolve([[]]);
    });
    const res = await request(app()).post('/api/group-files/maintenance/orphans').send({ mode: 'scan' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('scan');
    expect(res.body.brokenCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.orphanFiles)).toBe(true);
  });

  test('普通成员不能访问维护接口 → 403', async () => {
    mockRole = 'member';
    const res = await request(app()).post('/api/group-files/maintenance/orphans').send({ mode: 'scan' });
    expect(res.status).toBe(403);
  });
});
