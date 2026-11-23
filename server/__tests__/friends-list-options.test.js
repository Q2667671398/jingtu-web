/**
 * G-08 好友列表排序/筛选/分页测试
 * GET /api/friends?status=&sort=&online=&q=&page=&pageSize=
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
      const pageSize = Math.min(opts.maxSize || 200, Math.max(1, parseInt(req.query.pageSize, 10) || opts.defaultSize || 50));
      return { page, pageSize, offset: (page - 1) * pageSize };
    }
  };
});
jest.mock('../auth', () => ({ requireAuth: (req, res, next) => next(), requireRole: () => (req, res, next) => next() }));

const friendsRouter = require('../routes/friends');
const ME = 3;
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: ME }; next(); });
  app.use('/api/friends', friendsRouter({ notifyUser: jest.fn() }));
  return app;
}

describe('G-08 好友列表排序/筛选/分页', () => {
  beforeEach(() => jest.clearAllMocks());

  function mockList(rows, total) {
    mockPool.query.mockImplementation((sql) => {
      if (/COUNT\(\*\) AS total/.test(sql)) return Promise.resolve([[{ total }]]);
      if (/FROM user_friends f/.test(sql)) return Promise.resolve([rows]);
      return Promise.resolve([[]]);
    });
  }

  test('默认按最近互动排序，返回分页信息', async () => {
    mockList([{ id: 2, display_name: 'Alice', status: 'accepted', isOnline: 1 }], 1);
    const res = await request(buildApp()).get('/api/friends');
    expect(res.status).toBe(200);
    expect(res.body.list).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
    expect(res.body.totalPages).toBe(1);
    const sql = mockPool.query.mock.calls.find(c => /ORDER BY/.test(c[0]))[0];
    expect(sql).toMatch(/ORDER BY f\.updated_at DESC/);
  });

  test('sort=name 切换为按昵称排序', async () => {
    mockList([], 0);
    await request(buildApp()).get('/api/friends?sort=name');
    const sql = mockPool.query.mock.calls.find(c => /ORDER BY/.test(c[0]))[0];
    expect(sql).toMatch(/ORDER BY u\.display_name ASC/);
  });

  test('sort=since 按加好友时间排序', async () => {
    mockList([], 0);
    await request(buildApp()).get('/api/friends?sort=since');
    const sql = mockPool.query.mock.calls.find(c => /ORDER BY/.test(c[0]))[0];
    expect(sql).toMatch(/ORDER BY f\.created_at DESC/);
  });

  test('online=online 追加 is_online=1 过滤', async () => {
    mockList([], 0);
    await request(buildApp()).get('/api/friends?online=online');
    const sql = mockPool.query.mock.calls.find(c => /ORDER BY/.test(c[0]))[0];
    expect(sql).toMatch(/gr\.is_online = 1/);
  });

  test('online=offline 匹配离线或无名册记录', async () => {
    mockList([], 0);
    await request(buildApp()).get('/api/friends?online=offline');
    const sql = mockPool.query.mock.calls.find(c => /ORDER BY/.test(c[0]))[0];
    expect(sql).toMatch(/gr\.is_online = 0 OR gr\.is_online IS NULL/);
  });

  test('q 搜索对 display_name/vrchat_name 模糊匹配并转义 %_', async () => {
    mockList([], 0);
    await request(buildApp()).get('/api/friends?q=' + encodeURIComponent('a%b_c'));
    const call = mockPool.query.mock.calls.find(c => /ORDER BY/.test(c[0]));
    expect(call[0]).toMatch(/u\.display_name LIKE \?/);
    // % 和 _ 应被反斜杠转义
    expect(call[1]).toContain('%a\\%b\\_c%');
  });

  test('非法 sort 回退默认，非法 online 忽略', async () => {
    mockList([], 0);
    await request(buildApp()).get('/api/friends?sort=hack&online=evil');
    const sql = mockPool.query.mock.calls.find(c => /ORDER BY/.test(c[0]))[0];
    expect(sql).toMatch(/ORDER BY f\.updated_at DESC/);
    expect(sql).not.toMatch(/gr\.is_online = 1/);
  });

  test('分页参数生效：page=2&pageSize=10 → OFFSET 10', async () => {
    mockList([], 0);
    const res = await request(buildApp()).get('/api/friends?page=2&pageSize=10');
    expect(res.body.page).toBe(2);
    const call = mockPool.query.mock.calls.find(c => /ORDER BY/.test(c[0]));
    expect(call[1].slice(-2)).toEqual([10, 10]); // pageSize, offset
  });
});
