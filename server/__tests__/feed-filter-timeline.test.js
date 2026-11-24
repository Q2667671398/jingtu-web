/**
 * G-06 好友动态类型筛选 + G-03 入群时间线可见性
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
    logOper: jest.fn(() => Promise.resolve()),
    ErrorCodes: actual.ErrorCodes,
    getAvatarUrl: () => '/api/avatar/default',
    paginate: (req, opts = {}) => {
      const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), 10000);
      const sizeParam = opts.sizeParam || 'pageSize';
      const pageSize = Math.min(opts.maxSize || 100,
        Math.max(1, parseInt(req.query[sizeParam], 10) || opts.defaultSize || 20));
      return { page, pageSize, offset: (page - 1) * pageSize };
    }
  };
});
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => req.session && req.session.userId ? next() : res.status(401).json({ success: false }),
  requireAdminCompat: (req, res, next) => next()
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const friendsRouter = require('../routes/friends');

function app(userId = 1) {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.session = userId ? { userId } : {}; next(); });
  a.use('/api/friends', friendsRouter());
  return a;
}

describe('G-06 好友动态类型筛选', () => {
  beforeEach(() => jest.clearAllMocks());

  function mockFriendsAndEmpty() {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT friend_id FROM user_friends/.test(sql)) return Promise.resolve([[{ friend_id: 2 }, { friend_id: 3 }]]);
      return Promise.resolve([[]]);
    });
  }

  test('不传 kind → 查全部三类', async () => {
    mockFriendsAndEmpty();
    await request(app()).get('/api/friends/feed');
    const sqls = mockPool.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => /FROM posts p/.test(s))).toBe(true);
    expect(sqls.some(s => /FROM event_sign s/.test(s))).toBe(true);
    expect(sqls.some(s => /FROM album_photo a/.test(s))).toBe(true);
  });

  test('kind=post → 只查动态，跳过报名与照片', async () => {
    mockFriendsAndEmpty();
    const res = await request(app()).get('/api/friends/feed?kind=post');
    expect(res.status).toBe(200);
    const sqls = mockPool.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => /FROM posts p/.test(s))).toBe(true);
    expect(sqls.some(s => /FROM event_sign s/.test(s))).toBe(false);
    expect(sqls.some(s => /FROM album_photo a/.test(s))).toBe(false);
  });

  test('kind=photo,event_sign → 查两类，不查 posts', async () => {
    mockFriendsAndEmpty();
    const res = await request(app()).get('/api/friends/feed?kind=photo,event_sign');
    expect(res.status).toBe(200);
    const sqls = mockPool.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => /FROM posts p/.test(s))).toBe(false);
    expect(sqls.some(s => /FROM event_sign s/.test(s))).toBe(true);
    expect(sqls.some(s => /FROM album_photo a/.test(s))).toBe(true);
  });

  test('非法 kind 被忽略 → 回退查全部', async () => {
    mockFriendsAndEmpty();
    const res = await request(app()).get('/api/friends/feed?kind=hacker');
    expect(res.status).toBe(200);
    const sqls = mockPool.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => /FROM posts p/.test(s))).toBe(true); // 回退全量
  });

  test('响应回显生效的 kinds', async () => {
    mockFriendsAndEmpty();
    const res = await request(app()).get('/api/friends/feed?kind=post');
    expect(res.body.kinds).toEqual(['post']);
  });
});

describe('G-03 入群时间线（成员可见）', () => {
  test('后端 /group/members/changes 使用 requireAuth 而非管理员守卫（源码级）', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../routes/groups_members.js'), 'utf8');
    const idx = src.indexOf('/group/members/changes');
    expect(idx).toBeGreaterThan(-1);
    const head = src.slice(idx - 60, idx + 120);
    expect(head).toMatch(/requireAuth/);
    expect(head).not.toMatch(/requireAdminCompat|requireSuperAdmin/);
  });

  test('前端不再对非管理员隐藏该区块，且加入群时长（源码级）', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../../public/js/group.js'), 'utf8');
    const idx = src.indexOf("document.getElementById('groupChangesList')");
    expect(idx).toBeGreaterThan(-1);
    // 截到下一个顶层函数声明为止（函数体可能较长）
    const rest = src.slice(idx);
    const endRel = rest.search(/\nfunction |\n\/\/ ====================/);
    const block = endRel > 0 ? rest.slice(0, endRel) : rest.slice(0, 5000);
    // 不得再出现「非管理员直接 return」的硬拦截
    expect(block).not.toMatch(/if\s*\(\s*!isAdmin\s*\)\s*\{[^}]*return/);
    // 必须包含入群时长渲染
    expect(block).toMatch(/fmtDuration/);
    expect(block).toMatch(/group-change-dur/);
  });
});
