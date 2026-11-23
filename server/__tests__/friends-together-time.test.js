/**
 * F-04 共度时间端点测试：GET /api/friends/together-time/:userId
 * 覆盖参数校验/越权/无 vrchat_id/正常区间交集/无重叠。
 * 注意：activity_sessions.vrchat_id 存的是 VRChat 用户 ID（usr_xxx），
 * 端点按 users.vrchat_id 匹配，而非显示名 vrchat_name。
 */
const request = require('supertest');
const express = require('express');

const mockPool = { query: jest.fn(), getConnection: jest.fn() };
jest.mock('../utils', () => {
  const actual = jest.requireActual('../utils');
  return {
    ...actual,
    getPool: () => mockPool,
    sendError: (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } }),
    handleError: (res, e) => res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: e.message } }),
    getAvatarUrl: () => '/api/avatar/default',
    ErrorCodes: actual.ErrorCodes
  };
});
jest.mock('../auth', () => ({ requireAuth: (req, res, next) => next(), requireRole: () => (req, res, next) => next() }));

const friendsRouter = require('../routes/friends');
const ME = 1;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: ME }; next(); });
  app.use('/api/friends', friendsRouter({ notifyUser: jest.fn() }));
  return app;
}

describe('F-04 共度时间 GET /together-time/:userId', () => {
  beforeEach(() => jest.clearAllMocks());

  test('参数非法（非数字）→ 400', async () => {
    const res = await request(buildApp()).get('/api/friends/together-time/abc');
    expect(res.status).toBe(400);
  });

  test('target 等于自己 → 400', async () => {
    const res = await request(buildApp()).get('/api/friends/together-time/1');
    expect(res.status).toBe(400);
  });

  test('非好友 → 403', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM user_friends/.test(sql)) return Promise.resolve([[]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/together-time/2');
    expect(res.status).toBe(403);
  });

  test('任一方无 vrchat_id → 空结果', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM user_friends/.test(sql)) return Promise.resolve([[{ id: 9 }]]);
      if (/FROM users WHERE id IN/.test(sql)) return Promise.resolve([[{ id: 1, vrchat_id: 'usr_v1' }, { id: 2, vrchat_id: null }]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/together-time/2');
    expect(res.status).toBe(200);
    expect(res.body.totalMinutes).toBe(0);
    expect(res.body.sessions).toEqual([]);
  });

  test('正常区间交集：两个会话重叠 30 分钟', async () => {
    const base = Date.now() - 3600 * 1000;
    const t = (m) => new Date(base + m * 60000).toISOString().slice(0, 19).replace('T', ' ');
    mockPool.query.mockImplementation((sql, params) => {
      if (/FROM user_friends/.test(sql)) return Promise.resolve([[{ id: 9 }]]);
      if (/FROM users WHERE id IN/.test(sql)) return Promise.resolve([[{ id: 1, vrchat_id: 'usr_v1' }, { id: 2, vrchat_id: 'usr_v2' }]]);
      if (/FROM activity_sessions/.test(sql)) {
        if (params[0] === 'usr_v1') return Promise.resolve([[{ started_at: t(0), ended_at: t(60), duration_minutes: 60, world_name: 'W1', world_id: 'w1' }]]);
        return Promise.resolve([[{ started_at: t(30), ended_at: t(90), duration_minutes: 60, world_name: 'W2', world_id: 'w2' }]]);
      }
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/together-time/2');
    expect(res.status).toBe(200);
    expect(res.body.totalMinutes).toBe(30);
    expect(res.body.sessions.length).toBe(1);
    expect(res.body.sessions[0].minutes).toBe(30);
    expect(res.body.myMinutes).toBe(60);
    expect(res.body.theirMinutes).toBe(60);
  });

  test('无重叠 → totalMinutes 0', async () => {
    const base = Date.now() - 7200 * 1000;
    const t = (m) => new Date(base + m * 60000).toISOString().slice(0, 19).replace('T', ' ');
    mockPool.query.mockImplementation((sql, params) => {
      if (/FROM user_friends/.test(sql)) return Promise.resolve([[{ id: 9 }]]);
      if (/FROM users WHERE id IN/.test(sql)) return Promise.resolve([[{ id: 1, vrchat_id: 'usr_v1' }, { id: 2, vrchat_id: 'usr_v2' }]]);
      if (/FROM activity_sessions/.test(sql)) {
        if (params[0] === 'usr_v1') return Promise.resolve([[{ started_at: t(0), ended_at: t(30), duration_minutes: 30, world_name: 'W', world_id: 'w' }]]);
        return Promise.resolve([[{ started_at: t(60), ended_at: t(90), duration_minutes: 30, world_name: 'W', world_id: 'w' }]]);
      }
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/together-time/2');
    expect(res.status).toBe(200);
    expect(res.body.totalMinutes).toBe(0);
    expect(res.body.sessions).toEqual([]);
  });
});
