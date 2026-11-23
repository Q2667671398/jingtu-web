/**
 * F-05 友谊里程碑端点测试：GET /api/friends/milestones/:userId
 * 覆盖：参数校验/越权/无标识空结果/初识+重逢+换世界识别/spanDays 计算。
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

const t = (dayOffset, hour = 12) => {
  const base = new Date('2026-01-01T00:00:00Z');
  base.setDate(base.getDate() + dayOffset);
  base.setHours(hour, 0, 0, 0);
  return base.toISOString().slice(0, 19).replace('T', ' ');
};

describe('F-05 友谊里程碑', () => {
  beforeEach(() => jest.clearAllMocks());

  test('参数非法 → 400', async () => {
    const res = await request(buildApp()).get('/api/friends/milestones/abc');
    expect(res.status).toBe(400);
  });

  test('target 等于自己 → 400', async () => {
    const res = await request(buildApp()).get('/api/friends/milestones/1');
    expect(res.status).toBe(400);
  });

  test('非好友 → 403', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM user_friends/.test(sql)) return Promise.resolve([[]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/milestones/2');
    expect(res.status).toBe(403);
  });

  test('无 vrchat 标识 → 空结果', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM user_friends/.test(sql)) return Promise.resolve([[{ id: 9 }]]);
      if (/SELECT vrchat_name, vrchat_id FROM users/.test(sql)) return Promise.resolve([[{ vrchat_name: null, vrchat_id: null }]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/milestones/2');
    expect(res.status).toBe(200);
    expect(res.body.milestones).toEqual([]);
    expect(res.body.firstMet).toBeNull();
  });

  test('识别初识/重逢(间隔≥7天)/换世界，并计算 spanDays', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM user_friends/.test(sql)) return Promise.resolve([[{ id: 9 }]]);
      if (/SELECT vrchat_name, vrchat_id FROM users/.test(sql)) return Promise.resolve([[{ vrchat_name: 'Alice', vrchat_id: 'usr_a' }]]);
      if (/FROM activity_sessions/.test(sql)) {
        return Promise.resolve([[
          { started_at: t(0), ended_at: t(0, 13), duration_minutes: 60, world_name: 'W1', world_id: 'w1' },  // 初识
          { started_at: t(1), ended_at: t(1, 13), duration_minutes: 60, world_name: 'W2', world_id: 'w2' },  // 换世界
          { started_at: t(20), ended_at: t(20, 13), duration_minutes: 60, world_name: 'W2', world_id: 'w2' } // 重逢(19天)
        ]]);
      }
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/milestones/2');
    expect(res.status).toBe(200);
    expect(res.body.totalSessions).toBe(3);
    expect(res.body.spanDays).toBe(20);
    const types = res.body.milestones.map(m => m.type);
    expect(types[0]).toBe('first_meet');
    expect(types).toContain('world_change');
    expect(types).toContain('reunion');
    const reunion = res.body.milestones.find(m => m.type === 'reunion');
    expect(reunion.gapDays).toBeGreaterThanOrEqual(7);
    // 验证按 vrchat_id 匹配
    const q = mockPool.query.mock.calls.find(c => /FROM activity_sessions/.test(c[0]));
    expect(q[0]).toMatch(/vrchat_id IN \(/);
    expect(q[1]).toEqual(expect.arrayContaining(['usr_a', 'Alice']));
  });

  test('无会话 → 空里程碑', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM user_friends/.test(sql)) return Promise.resolve([[{ id: 9 }]]);
      if (/SELECT vrchat_name, vrchat_id FROM users/.test(sql)) return Promise.resolve([[{ vrchat_name: 'A', vrchat_id: 'usr_a' }]]);
      if (/FROM activity_sessions/.test(sql)) return Promise.resolve([[]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/milestones/2');
    expect(res.status).toBe(200);
    expect(res.body.milestones).toEqual([]);
    expect(res.body.totalSessions).toBe(0);
  });
});
