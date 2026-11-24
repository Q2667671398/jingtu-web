/**
 * G-07 活动候补队列 + 开抢提醒
 * 说明：events 路由涉及 enforceEventVisibility → currentRole 等中间件链，
 * 因此这里用一个「按 SQL 特征分派」的万能 mock，避免逐条精确匹配导致脆弱。
 */
const request = require('supertest');
const express = require('express');

const mockConn = {
  beginTransaction: jest.fn(() => Promise.resolve()),
  commit: jest.fn(() => Promise.resolve()),
  rollback: jest.fn(() => Promise.resolve()),
  release: jest.fn(),
  query: jest.fn()
};
const mockPool = {
  query: jest.fn(),
  getConnection: jest.fn(() => Promise.resolve(mockConn))
};
jest.mock('../utils', () => {
  const actual = jest.requireActual('../utils');
  return {
    ...actual,
    getPool: () => mockPool,
    sendError: (res, status, code, message, detail) => res.status(status).json({
      success: false, error: detail ? { code, message, detail } : { code, message }
    }),
    handleError: (res, e) => res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: e.message } }),
    logOper: jest.fn(() => Promise.resolve()),
    appNow: () => new Date(),
    validateFields: () => ({ ok: true }),
    escapeLike: (s) => String(s),
    ErrorCodes: actual.ErrorCodes
  };
});
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => req.session && req.session.userId ? next() : res.status(401).json({ success: false }),
  requireAdminCompat: (req, res, next) => next(),
  requireSuperAdmin: (req, res, next) => next(),
  requirePerm: () => (req, res, next) => next(),
  getAvatarUrl: () => '/api/avatar/default',
  currentRole: () => Promise.resolve('member'),
  ROLE_LEVEL: { member: 1, admin: 2, super_admin: 3 },
  ROLE_LEVEL_SRC: {}
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../vrc', () => ({ vrchatGetGroupEvents: jest.fn(() => Promise.resolve({ status: 200, data: [] })) }));
jest.mock('../cache_service', () => ({
  get: jest.fn(() => null), set: jest.fn(), del: jest.fn(), invalidate: jest.fn()
}));

const eventsRouter = require('../routes/events');

function app(userId = 1) {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.session = userId ? { userId, displayName: '测试员' } : {}; next(); });
  a.use('/api/events', eventsRouter(() => 'cookie', null, null));
  return a;
}

// 万能 mock：按 SQL 特征给默认值，测试可覆写
function baseQuery(overrides = {}) {
  return (sql, params) => {
    for (const [re, val] of Object.entries(overrides)) {
      if (new RegExp(re).test(sql)) {
        return Promise.resolve(typeof val === 'function' ? val(params) : val);
      }
    }
    if (/SELECT visibility, create_user_id AS createUserId FROM event WHERE id/.test(sql)) {
      return Promise.resolve([[{ visibility: 'public', createUserId: 999 }]]);
    }
    if (/SELECT banned FROM users/.test(sql)) return Promise.resolve([[{ banned: 0 }]]);
    if (/FROM event WHERE id/.test(sql)) {
      return Promise.resolve([[{
        id: 1, title: 'T', visibility: 'public', maxSign: 10,
        eventTime: '2099-01-01', endsAt: '2099-01-02'
      }]]);
    }
    return Promise.resolve([[]]);
  };
}

describe('G-07 活动候补队列', () => {
  beforeEach(() => jest.clearAllMocks());

  test('满员时进入候补（不再是 400 满员错误）', async () => {
    mockPool.query.mockImplementation(baseQuery());
    mockConn.query.mockImplementation((sql) => {
      if (/SELECT max_sign AS maxSign/.test(sql)) {
        return Promise.resolve([[{ maxSign: 2, title: 'T', createUserId: 999, eventTime: '2099-01-01', endsAt: '2099-01-02' }]]);
      }
      if (/SELECT id, is_sign, is_waitlist/.test(sql)) return Promise.resolve([[]]);
      if (/COUNT\(\*\) AS c FROM event_sign WHERE event_id=\? AND is_waitlist = 0/.test(sql)) {
        return Promise.resolve([[{ c: 2 }]]);
      }
      if (/INSERT INTO event_sign/.test(sql)) return Promise.resolve([{ affectedRows: 1 }]);
      return Promise.resolve([[]]);
    });
    mockPool.query.mockImplementation(baseQuery({
      'COUNT\\(\\*\\) AS c FROM event_sign WHERE event_id = \\? AND is_waitlist = 1': [[{ c: 3 }]]
    }));
    const res = await request(app(5)).post('/api/events/1/sign');
    expect(res.status).toBe(200);
    expect(res.body.waitlisted).toBe(true);
    expect(res.body.position).toBe(3);
    const ins = mockConn.query.mock.calls.find(c => /INSERT INTO event_sign/.test(c[0]));
    expect(ins[0]).toMatch(/is_waitlist/);
  });

  test('未满员正常报名（不返回 waitlisted）', async () => {
    mockPool.query.mockImplementation(baseQuery());
    mockConn.query.mockImplementation((sql) => {
      if (/SELECT max_sign AS maxSign/.test(sql)) {
        return Promise.resolve([[{ maxSign: 10, title: 'T', createUserId: 999, eventTime: '2099-01-01', endsAt: '2099-01-02' }]]);
      }
      if (/SELECT id, is_sign, is_waitlist/.test(sql)) return Promise.resolve([[]]);
      if (/COUNT\(\*\) AS c FROM event_sign WHERE event_id=\? AND is_waitlist = 0/.test(sql)) {
        return Promise.resolve([[{ c: 3 }]]);
      }
      if (/INSERT INTO event_sign/.test(sql)) return Promise.resolve([{ affectedRows: 1 }]);
      return Promise.resolve([[]]);
    });
    const res = await request(app(5)).post('/api/events/1/sign');
    expect(res.status).toBe(200);
    expect(res.body.waitlisted).toBeUndefined();
  });

  test('未到开抢时间 → 403，且 detail 含开放时间', async () => {
    mockPool.query.mockImplementation(baseQuery());
    mockConn.query.mockImplementation((sql) => {
      if (/SELECT max_sign AS maxSign/.test(sql)) {
        return Promise.resolve([[{
          maxSign: 10, title: 'T', createUserId: 999,
          eventTime: '2099-01-01', endsAt: '2099-01-02',
          signStartAt: '2099-01-01T00:00:00'
        }]]);
      }
      return Promise.resolve([[]]);
    });
    const res = await request(app(5)).post('/api/events/1/sign');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/尚未开始/);
    expect(String(res.body.error.detail || '')).toMatch(/报名开放时间/);
  });

  test('候补队列查询：返回位置、总数、标出自己', async () => {
    mockPool.query.mockImplementation(baseQuery({
      'SELECT id, max_sign AS maxSign FROM event': [[{ id: 1, maxSign: 5 }]],
      'FROM event_sign WHERE event_id = \\? AND is_waitlist = 1': [[
        { vrchatId: '1', userName: '我', joinedAt: '2026-11-01' },
        { vrchatId: '2', userName: '他', joinedAt: '2026-11-02' }
      ]]
    }));
    const res = await request(app(1)).get('/api/events/1/waitlist');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.myPosition).toBe(1);
    expect(res.body.waitlist[0]).toMatchObject({ position: 1, isMe: true, name: '我' });
  });

  test('取消正式报名 → 递补候补第一名并返回 promoted', async () => {
    mockPool.query.mockImplementation(baseQuery({
      'SELECT event_time AS eventTime, ends_at AS endsAt, title': [[{ eventTime: '2099-01-01', endsAt: '2099-01-02', title: 'T' }]],
      'SELECT is_sign, is_waitlist FROM event_sign': [[{ is_sign: 1, is_waitlist: 0 }]],
      'DELETE FROM event_sign': [{ affectedRows: 1 }],
      'SELECT id, user_vrcid, user_name, user_id FROM event_sign': [[{ id: 9, user_vrcid: '7', user_name: '候补者', user_id: 7 }]],
      'UPDATE event_sign SET is_waitlist = 0, is_sign = 1': [{ affectedRows: 1 }]
    }));
    const res = await request(app(5)).post('/api/events/1/unsign');
    expect(res.status).toBe(200);
    expect(res.body.promoted).toMatchObject({ name: '候补者' });
  });

  test('退出候补 → 不触发递补', async () => {
    mockPool.query.mockImplementation(baseQuery({
      'SELECT event_time AS eventTime, ends_at AS endsAt, title': [[{ eventTime: '2099-01-01', endsAt: '2099-01-02', title: 'T' }]],
      'SELECT is_sign, is_waitlist FROM event_sign': [[{ is_sign: 0, is_waitlist: 1 }]],
      'DELETE FROM event_sign': [{ affectedRows: 1 }]
    }));
    const res = await request(app(5)).post('/api/events/1/unsign');
    expect(res.status).toBe(200);
    expect(res.body.promoted).toBeUndefined();
    const upd = mockPool.query.mock.calls.find(c => /UPDATE event_sign SET is_waitlist = 0, is_sign = 1/.test(c[0]));
    expect(upd).toBeUndefined();
  });
});
