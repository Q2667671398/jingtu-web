/**
 * G-02 好友活跃度榜测试：GET /api/friends/activity-ranking
 * 覆盖：仅好友范围（JOIN user_friends）/ 时长排序 / days 与 top 钳制 / 空结果。
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
const ME = 7;
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: ME }; next(); });
  app.use('/api/friends', friendsRouter({ notifyUser: jest.fn() }));
  return app;
}

describe('G-02 好友活跃度榜', () => {
  beforeEach(() => jest.clearAllMocks());

  test('返回按在线时长排序的好友榜，含名次/时长/会话数', async () => {
    mockPool.query.mockResolvedValueOnce([[
      { user_id: 2, display_name: 'Alice', session_count: 5, total_minutes: 300 },
      { user_id: 3, display_name: 'Bob', session_count: 3, total_minutes: 90 }
    ]]);
    const res = await request(buildApp()).get('/api/friends/activity-ranking');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({ rank: 1, displayName: 'Alice', totalMinutes: 300, sessionCount: 5 });
    expect(res.body.items[1].rank).toBe(2);
    expect(res.body.days).toBe(30);
    // SQL 必须限定为我的好友并按时长排序
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/JOIN user_friends/);
    expect(sql).toMatch(/ORDER BY total_minutes DESC/);
    // 参数含我的 userId
    expect(mockPool.query.mock.calls[0][1][0]).toBe(ME);
  });

  test('days 与 top 钳制到合法范围', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(buildApp()).get('/api/friends/activity-ranking?days=999&top=999');
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(90); // days 上限 90
    const params = mockPool.query.mock.calls[0][1];
    expect(params[1]).toBe(90);  // days
    expect(params[2]).toBe(50);  // top 上限 50
  });

  test('负数/非法参数回退默认值', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(buildApp()).get('/api/friends/activity-ranking?days=0&top=-5');
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30); // days 0 → 默认 30
  });

  test('无活跃数据 → 空列表', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(buildApp()).get('/api/friends/activity-ranking');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});
