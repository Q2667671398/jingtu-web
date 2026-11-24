/**
 * G-14 全局搜索增强：6 类实体覆盖 + 匹配度排序
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
    escapeLike: (s) => String(s).replace(/[!%_]/g, m => '!' + m),
    ErrorCodes: actual.ErrorCodes
  };
});
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => req.session && req.session.userId ? next() : res.status(401).json({ success: false })
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const statsRouter = require('../routes/stats');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.session = { userId: 1 }; next(); });
  a.use('/api', statsRouter({}));
  return a;
}

describe('G-14 全局搜索增强', () => {
  beforeEach(() => jest.clearAllMocks());

  test('查询词过短 → 返回空结构（含新字段）', async () => {
    const res = await request(app()).get('/api/search?q=a');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      announcements: [], events: [], users: [], posts: [], members: [], files: [], results: []
    });
  });

  test('覆盖 6 类实体（各自发一次查询）', async () => {
    mockPool.query.mockResolvedValue([[]]);
    await request(app()).get('/api/search?q=test');
    const sqls = mockPool.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => /FROM announcement/.test(s))).toBe(true);
    expect(sqls.some(s => /FROM event\b/.test(s))).toBe(true);
    expect(sqls.some(s => /FROM users/.test(s))).toBe(true);
    expect(sqls.some(s => /FROM posts p/.test(s))).toBe(true);
    expect(sqls.some(s => /FROM group_roster/.test(s))).toBe(true);
    expect(sqls.some(s => /FROM group_files/.test(s))).toBe(true);
  });

  test('动态搜索只查可见范围（不泄露私密）', async () => {
    mockPool.query.mockResolvedValue([[]]);
    await request(app()).get('/api/search?q=test');
    const postSql = mockPool.query.mock.calls.map(c => c[0]).find(s => /FROM posts p/.test(s));
    expect(postSql).toMatch(/visibility IN \('public','members_only'\)/);
  });

  test('群组文件只搜最新版且未删除', async () => {
    mockPool.query.mockResolvedValue([[]]);
    await request(app()).get('/api/search?q=test');
    const fileSql = mockPool.query.mock.calls.map(c => c[0]).find(s => /FROM group_files/.test(s));
    expect(fileSql).toMatch(/is_deleted = 0/);
    expect(fileSql).toMatch(/is_latest = 1/);
  });

  test('results 按 score 降序汇总（完全匹配 > 前缀 > 包含）', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM announcement/.test(sql)) {
        return Promise.resolve([[{ id: 1, title: 'test', content: 'x', score: 100 }]]);
      }
      if (/FROM users/.test(sql)) {
        return Promise.resolve([[{ id: 2, loginId: 'u', displayName: 'testuser', score: 60 }]]);
      }
      if (/FROM group_roster/.test(sql)) {
        return Promise.resolve([[{ vrchatId: 'usr_x', displayName: 'mytest', trustLevel: 'x', score: 30 }]]);
      }
      return Promise.resolve([[]]);
    });
    const res = await request(app()).get('/api/search?q=test');
    const r = res.body.results;
    expect(r.length).toBe(3);
    expect(r[0]).toMatchObject({ type: 'announcement', score: 100 });
    expect(r[1]).toMatchObject({ type: 'user', score: 60 });
    expect(r[2]).toMatchObject({ type: 'member', score: 30 });
    // 严格降序
    for (let i = 1; i < r.length; i++) expect(r[i - 1].score).toBeGreaterThanOrEqual(r[i].score);
  });

  test('SQL 错误时降级为空结果（不 500）', async () => {
    mockPool.query.mockRejectedValue(new Error('db down'));
    const res = await request(app()).get('/api/search?q=test');
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  test('limit 参数被钳制在 1-20', async () => {
    mockPool.query.mockResolvedValue([[]]);
    await request(app()).get('/api/search?q=test&limit=999');
    const params = mockPool.query.mock.calls[0][1];
    expect(params[params.length - 1]).toBe(20);
  });
});
