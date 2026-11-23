/**
 * 历史接口字段修复测试：friend_log / world_visit_log / avatar_history_log
 * 均以 vrchat_id（usr_xxx）为键，此前误用 users.vrchat_name（显示名）导致查询恒空。
 * 本测试守护「按 vrchat_id 匹配」并兼容 vrchat_name。
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
    getAvatarUrl: () => '/api/avatar/default',
    ErrorCodes: actual.ErrorCodes,
    paginate: (req, opts = {}) => {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(opts.maxSize || 100, Math.max(1, parseInt(req.query.pageSize, 10) || opts.defaultSize || 20));
      return { page, pageSize, offset: (page - 1) * pageSize };
    }
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

const USER_ROW = { vrchat_name: 'Alice', vrchat_id: 'usr_alice_123' };

describe('历史接口按 vrchat_id 匹配（兼容 vrchat_name）', () => {
  beforeEach(() => jest.clearAllMocks());

  test('/history 用 vrchat_id IN 查询 friend_log', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM user_friends/.test(sql)) return Promise.resolve([[{ id: 9 }]]);
      if (/SELECT vrchat_name, vrchat_id FROM users/.test(sql)) return Promise.resolve([[USER_ROW]]);
      if (/COUNT\(\*\) AS c FROM friend_log/.test(sql)) return Promise.resolve([[{ c: 1 }]]);
      if (/FROM friend_log/.test(sql)) return Promise.resolve([[{ id: 1, change_type: 'world', old_value: 'a', new_value: 'b', created_at: '2026-11-01' }]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/history/2');
    expect(res.status).toBe(200);
    const q = mockPool.query.mock.calls.find(c => /FROM friend_log/.test(c[0]));
    expect(q[0]).toMatch(/vrchat_id IN \(/);
    expect(q[1]).toEqual(expect.arrayContaining(['usr_alice_123', 'Alice']));
  });

  test('/world-history 用 vrchat_id IN 查询 world_visit_log', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM user_friends/.test(sql)) return Promise.resolve([[{ id: 9 }]]);
      if (/SELECT vrchat_name, vrchat_id FROM users/.test(sql)) return Promise.resolve([[USER_ROW]]);
      if (/SUM\(visit_count\)/.test(sql)) return Promise.resolve([[{ c: 2, visits: 5 }]]);
      if (/FROM world_visit_log/.test(sql)) return Promise.resolve([[{ world_id: 'w1', world_name: 'W1', visit_count: 3, first_visit_at: '2026-10-01', last_visit_at: '2026-11-01' }]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/world-history/2');
    expect(res.status).toBe(200);
    expect(res.body.totalWorlds).toBe(2);
    const q = mockPool.query.mock.calls.find(c => /FROM world_visit_log/.test(c[0]));
    expect(q[0]).toMatch(/vrchat_id IN \(/);
    expect(q[1]).toEqual(expect.arrayContaining(['usr_alice_123', 'Alice']));
  });

  test('/avatar-history 用 vrchat_id IN 查询 avatar_history_log', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM user_friends/.test(sql)) return Promise.resolve([[{ id: 9 }]]);
      if (/SELECT vrchat_name, vrchat_id FROM users/.test(sql)) return Promise.resolve([[USER_ROW]]);
      if (/SUM\(use_count\)/.test(sql)) return Promise.resolve([[{ c: 1, uses: 4 }]]);
      if (/FROM avatar_history_log/.test(sql)) return Promise.resolve([[{ avatar_id: 'av1', avatar_url: 'u', use_count: 4, first_seen_at: '2026-10-01', last_seen_at: '2026-11-01' }]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/avatar-history/2');
    expect(res.status).toBe(200);
    const q = mockPool.query.mock.calls.find(c => /FROM avatar_history_log/.test(c[0]));
    expect(q[0]).toMatch(/vrchat_id IN \(/);
    expect(q[1]).toEqual(expect.arrayContaining(['usr_alice_123', 'Alice']));
  });

  test('无 vrchat_id 且无 vrchat_name → 空结果不报错', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM user_friends/.test(sql)) return Promise.resolve([[{ id: 9 }]]);
      if (/SELECT vrchat_name, vrchat_id FROM users/.test(sql)) return Promise.resolve([[{ vrchat_name: null, vrchat_id: null }]]);
      return Promise.resolve([[]]);
    });
    for (const path of ['/api/friends/history/2', '/api/friends/world-history/2', '/api/friends/avatar-history/2']) {
      const res = await request(buildApp()).get(path);
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    }
  });
});
