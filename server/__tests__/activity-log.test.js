/**
 * F-08 个人活动日志端点测试
 * GET /api/users/me/activity-log 与 /me/activity-log-types
 * 覆盖：游客拒绝/三种标识匹配（userId/login_id/vrchat_id）/类型筛选/分页/类型统计。
 * 关键：sys_oper_log.admin_vrcid 历史混存 login_id / 数字 user_id / vrchat_id。
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
    paginate: (req, opts = {}) => {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(opts.maxSize || 100, Math.max(1, parseInt(req.query.pageSize, 10) || opts.defaultSize || 20));
      return { page, pageSize, offset: (page - 1) * pageSize };
    }
  };
});
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => next(),
  getAvatarUrl: () => '/api/avatar/default',
  encryptAES: (v) => v,
  decryptAES: (v) => v
}));
jest.mock('../vrc', () => ({ VRC_API: '', VRC_API_KEY: '', vrchatGetUser: jest.fn(), resolveTrustLevelFromTags: jest.fn(() => [null, null]) }));
jest.mock('../ws_service', () => ({}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// sharp/multer 在模块加载时被 require，需桩掉避免原生依赖
jest.mock('sharp', () => jest.fn(() => ({ resize: () => ({ toFile: jest.fn() }) })));
jest.mock('multer', () => {
  const mw = jest.fn(() => ({ single: () => (req, res, next) => next(), array: () => (req, res, next) => next() }));
  mw.diskStorage = jest.fn(() => ({}));
  return mw;
});

const usersProfileRouter = require('../routes/users_profile');

function buildApp(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId }; next(); });
  app.use('/api/users', usersProfileRouter);
  return app;
}

describe('F-08 个人活动日志', () => {
  beforeEach(() => jest.clearAllMocks());

  test('游客（userId=0）→ 403', async () => {
    const res = await request(buildApp(0)).get('/api/users/me/activity-log');
    expect(res.status).toBe(403);
  });

  test('按三种标识（userId/login_id/vrchat_id）同时匹配并分页返回', async () => {
    mockPool.query.mockImplementation((sql, params) => {
      if (/SELECT login_id, vrchat_id FROM users/.test(sql)) {
        return Promise.resolve([[{ login_id: 'alice', vrchat_id: 'usr_abc' }]]);
      }
      if (/COUNT\(\*\) AS total/.test(sql)) return Promise.resolve([[{ total: 2 }]]);
      if (/FROM sys_oper_log/.test(sql)) {
        return Promise.resolve([[
          { id: 2, oper_type: '用户登录', content: 'alice 登录', create_time: '2026-11-23 10:00:00' },
          { id: 1, oper_type: '用户注册', content: 'alice 注册', create_time: '2026-11-22 09:00:00' }
        ]]);
      }
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp(5)).get('/api/users/me/activity-log?page=1&pageSize=20');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.logs).toHaveLength(2);
    expect(res.body.logs[0].operType).toBe('用户登录');
    // 验证 IN 查询参数包含三种标识
    const inCall = mockPool.query.mock.calls.find(c => /FROM sys_oper_log/.test(c[0]));
    expect(inCall[1]).toEqual(expect.arrayContaining(['5', 'alice', 'usr_abc']));
  });

  test('按类型筛选时 WHERE 增加 oper_type 条件', async () => {
    mockPool.query.mockImplementation((sql, params) => {
      if (/SELECT login_id, vrchat_id FROM users/.test(sql)) return Promise.resolve([[{ login_id: 'alice', vrchat_id: null }]]);
      if (/COUNT/.test(sql)) return Promise.resolve([[{ total: 1 }]]);
      if (/FROM sys_oper_log/.test(sql)) return Promise.resolve([[{ id: 1, oper_type: '用户登录', content: 'x', create_time: '2026-11-23' }]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp(5)).get('/api/users/me/activity-log?type=' + encodeURIComponent('用户登录'));
    expect(res.status).toBe(200);
    const inCall = mockPool.query.mock.calls.find(c => /FROM sys_oper_log/.test(c[0]));
    expect(inCall[0]).toMatch(/oper_type = \?/);
    expect(inCall[1]).toContain('用户登录');
  });

  test('用户不存在 → 404', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(buildApp(999)).get('/api/users/me/activity-log');
    expect(res.status).toBe(404);
  });

  test('activity-log-types 返回类型与计数', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT login_id, vrchat_id FROM users/.test(sql)) return Promise.resolve([[{ login_id: 'alice', vrchat_id: 'usr_abc' }]]);
      if (/GROUP BY oper_type/.test(sql)) return Promise.resolve([[{ oper_type: '用户登录', n: 3 }, { oper_type: '用户注册', n: 1 }]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp(5)).get('/api/users/me/activity-log-types');
    expect(res.status).toBe(200);
    expect(res.body.types).toEqual([{ type: '用户登录', count: 3 }, { type: '用户注册', count: 1 }]);
  });

  test('activity-log-types 游客返回空数组', async () => {
    const res = await request(buildApp(0)).get('/api/users/me/activity-log-types');
    expect(res.status).toBe(200);
    expect(res.body.types).toEqual([]);
  });
});
