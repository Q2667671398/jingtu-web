/**
 * G-01 群组世界热度排行测试：GET /api/friends/world-ranking
 * 覆盖：JOIN 世界名富化 / 排序 / limit 钳制 / 空结果。
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
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
  app.use('/api/friends', friendsRouter({ notifyUser: jest.fn() }));
  return app;
}

describe('G-01 世界热度排行', () => {
  beforeEach(() => jest.clearAllMocks());

  test('返回按访问次数排序的排行，含富化世界名与名次', async () => {
    mockPool.query.mockResolvedValueOnce([[
      { world_id: 'wrld_a', world_name: 'Idle Merchant', image_url: 'img_a', total_visits: 78, visitor_count: 58 },
      { world_id: 'wrld_b', world_name: 'wrld_b', image_url: null, total_visits: 48, visitor_count: 38 }
    ]]);
    const res = await request(buildApp()).get('/api/friends/world-ranking');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({ rank: 1, worldName: 'Idle Merchant', totalVisits: 78, visitorCount: 58 });
    expect(res.body.items[1].rank).toBe(2);
    // 未命中缓存的仍回退显示 ID
    expect(res.body.items[1].worldName).toBe('wrld_b');
    // SQL 应 JOIN 缓存并按访问次数排序
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/LEFT JOIN vrc_worlds_cache/);
    expect(sql).toMatch(/ORDER BY total_visits DESC/);
  });

  test('top 参数钳制：超大取 50，0/非法回退默认 20', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    await request(buildApp()).get('/api/friends/world-ranking?top=999');
    expect(mockPool.query.mock.calls[0][1][0]).toBe(50);
    mockPool.query.mockResolvedValueOnce([[]]);
    await request(buildApp()).get('/api/friends/world-ranking?top=0');
    expect(mockPool.query.mock.calls[1][1][0]).toBe(20); // 0 视为无效 → 默认 20
  });

  test('无数据 → 空列表', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(buildApp()).get('/api/friends/world-ranking');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});
