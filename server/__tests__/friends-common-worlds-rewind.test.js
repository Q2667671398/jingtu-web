/**
 * G-04 共同世界 + G-11 年度回顾 测试
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
function buildApp(userId = ME) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId }; next(); });
  app.use('/api/friends', friendsRouter({ notifyUser: jest.fn() }));
  return app;
}

describe('G-04 共同世界', () => {
  beforeEach(() => jest.clearAllMocks());

  test('参数非法/自己 → 400', async () => {
    expect((await request(buildApp()).get('/api/friends/common-worlds/abc')).status).toBe(400);
    expect((await request(buildApp()).get('/api/friends/common-worlds/1')).status).toBe(400);
  });

  test('非好友 → 403', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(buildApp()).get('/api/friends/common-worlds/2');
    expect(res.status).toBe(403);
  });

  test('返回共同世界，含双方访问次数与富化世界名', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM user_friends/.test(sql)) return Promise.resolve([[{ id: 9 }]]);
      if (/FROM users WHERE id IN/.test(sql)) return Promise.resolve([[
        { id: 1, vrchat_id: 'usr_me', vrchat_name: 'Me' },
        { id: 2, vrchat_id: 'usr_ta', vrchat_name: 'Ta' }
      ]]);
      if (/FROM world_visit_log/.test(sql)) return Promise.resolve([[
        { world_id: 'wrld_x', world_name: 'FISH ǃ ［PYRAMID］', image_url: 'img', my_visits: 5, their_visits: 3, first_visit_at: '2026-01-01', last_visit_at: '2026-11-01' }
      ]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/common-worlds/2');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({ worldName: 'FISH ǃ ［PYRAMID］', myVisits: 5, theirVisits: 3 });
    // SQL 必须有双侧子查询交集
    const sql = mockPool.query.mock.calls.find(c => /FROM world_visit_log/.test(c[0]))[0];
    expect(sql).toMatch(/world_id IN \(/);
    expect(sql.match(/world_id IN \(/g).length).toBe(2); // 两侧各一个
  });

  test('无共同世界 → 空列表', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM user_friends/.test(sql)) return Promise.resolve([[{ id: 9 }]]);
      if (/FROM users WHERE id IN/.test(sql)) return Promise.resolve([[
        { id: 1, vrchat_id: 'usr_me', vrchat_name: 'Me' },
        { id: 2, vrchat_id: 'usr_ta', vrchat_name: 'Ta' }
      ]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/common-worlds/2');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

describe('G-11 年度回顾', () => {
  beforeEach(() => jest.clearAllMocks());

  test('游客 → 403', async () => {
    const res = await request(buildApp(0)).get('/api/friends/rewind');
    expect(res.status).toBe(403);
  });

  test('用户无 vrchat 标识 → hasData=false', async () => {
    mockPool.query.mockResolvedValueOnce([[{ id: 1, display_name: 'Me', vrchat_id: null, vrchat_name: null }]]);
    const res = await request(buildApp()).get('/api/friends/rewind');
    expect(res.status).toBe(200);
    expect(res.body.hasData).toBe(false);
    expect(res.body.totalMinutes).toBe(0);
  });

  test('返回年度聚合：时长/会话/天数/世界/最长会话/TOP5', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM users WHERE id = \?/.test(sql)) return Promise.resolve([[{ id: 1, display_name: 'Me', vrchat_id: 'usr_me', vrchat_name: 'Me' }]]);
      if (/COUNT\(\*\) AS sessions/.test(sql)) return Promise.resolve([[{ sessions: 12, minutes: 1234 }]]);
      if (/ORDER BY \(CASE WHEN ended_at/.test(sql)) return Promise.resolve([[{ started_at: '2026-05-01', duration_minutes: 300, world_name: 'FISH' }]]);
      if (/SUM\(w\.visit_count\) AS visits/.test(sql)) return Promise.resolve([[
        { world_id: 'wrld_a', world_name: 'Idle Merchant', image_url: 'i', visits: 20 }
      ]]);
      if (/COUNT\(DISTINCT DATE\(started_at\)\)/.test(sql)) return Promise.resolve([[{ days: 40 }]]);
      if (/COUNT\(DISTINCT world_id\)/.test(sql)) return Promise.resolve([[{ worlds: 7 }]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/rewind?year=2026');
    expect(res.status).toBe(200);
    expect(res.body.year).toBe(2026);
    expect(res.body.hasData).toBe(true);
    expect(res.body.totalMinutes).toBe(1234);
    expect(res.body.totalHours).toBe(20.6);
    expect(res.body.sessionCount).toBe(12);
    expect(res.body.activeDays).toBe(40);
    expect(res.body.worldCount).toBe(7);
    expect(res.body.longestSession).toMatchObject({ minutes: 300, worldName: 'FISH' });
    expect(res.body.topWorlds[0]).toMatchObject({ worldName: 'Idle Merchant', visits: 20 });
  });

  test('year 参数钳制到合法范围', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM users WHERE id = \?/.test(sql)) return Promise.resolve([[{ id: 1, vrchat_id: 'usr_me', vrchat_name: 'Me' }]]);
      return Promise.resolve([[{ sessions: 0, minutes: 0, days: 0, worlds: 0 }]]);
    });
    const res = await request(buildApp()).get('/api/friends/rewind?year=9999');
    expect(res.body.year).toBe(2100);
  });
});
