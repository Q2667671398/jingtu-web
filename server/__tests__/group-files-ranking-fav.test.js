/**
 * 群组文件库：下载排行榜 + 收藏 测试
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
    paginate: (req, opts = {}) => {
      const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), 10000);
      const pageSize = Math.min(opts.maxSize || 100, Math.max(1, parseInt(req.query.pageSize, 10) || opts.defaultSize || 20));
      return { page, pageSize, offset: (page - 1) * pageSize };
    }
  };
});
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => req.session && req.session.userId ? next() : res.status(401).json({ success: false }),
  requireAdminCompat: (req, res, next) => next()
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const router = require('../routes/group_files');
function app(userId = 1) {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.session = userId ? { userId } : {}; next(); });
  a.use('/api/group-files', router());
  return a;
}

describe('下载排行榜', () => {
  beforeEach(() => jest.clearAllMocks());

  test('未登录 → 401', async () => {
    const res = await request(app(null)).get('/api/group-files/ranking');
    expect(res.status).toBe(401);
  });

  test('返回按下载次数排序的排行', async () => {
    mockPool.query.mockResolvedValueOnce([[
      { id: 3, title: 'A', original_name: 'a.zip', file_size: 10485760, ext: '.zip', download_count: 88, version: '1', category_name: '安装包' },
      { id: 5, title: 'B', original_name: 'b.zip', file_size: 2048, ext: '.zip', download_count: 12, version: '2', category_name: '' }
    ]]);
    const res = await request(app()).get('/api/group-files/ranking?top=10');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({ rank: 1, id: 3, downloadCount: 88 });
    expect(res.body.items[1].rank).toBe(2);
    expect(res.body.items[0].fileSizeText).toMatch(/MB/);
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/ORDER BY f\.download_count DESC/);
    expect(sql).toMatch(/download_count > 0/);
  });

  test('top 参数钳制 1-50', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    await request(app()).get('/api/group-files/ranking?top=999');
    const params = mockPool.query.mock.calls[0][1];
    expect(params[params.length - 1]).toBe(50);
  });

  test('days 参数生效时加时间条件', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    await request(app()).get('/api/group-files/ranking?days=7');
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/INTERVAL \? DAY/);
  });

  test('无下载记录 → 空列表', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(app()).get('/api/group-files/ranking');
    expect(res.body.items).toEqual([]);
  });
});

describe('文件收藏', () => {
  beforeEach(() => jest.clearAllMocks());

  test('收藏列表：未登录 → 401', async () => {
    const res = await request(app(null)).get('/api/group-files/favorites');
    expect(res.status).toBe(401);
  });

  test('收藏列表返回文件信息', async () => {
    mockPool.query.mockResolvedValueOnce([[
      { id: 2, title: 'T', original_name: 't.zip', file_size: 1024, ext: '.zip', version: '1', download_count: 5, category_name: 'C', favorited_at: '2026-11-24' }
    ]]);
    const res = await request(app()).get('/api/group-files/favorites');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: 2, title: 'T' });
  });

  test('toggle：fileId 非法 → 400', async () => {
    const res = await request(app()).post('/api/group-files/favorites/toggle').send({ fileId: 0 });
    expect(res.status).toBe(400);
  });

  test('toggle：文件不存在 → 404', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(app()).post('/api/group-files/favorites/toggle').send({ fileId: 99 });
    expect(res.status).toBe(404);
  });

  test('toggle：未收藏 → 收藏（favorited=true）', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT id FROM group_files/.test(sql)) return Promise.resolve([[{ id: 5 }]]);
      if (/SELECT id FROM file_favorites/.test(sql)) return Promise.resolve([[]]); // 未收藏
      if (/INSERT INTO file_favorites/.test(sql)) return Promise.resolve([{ affectedRows: 1 }]);
      return Promise.resolve([[]]);
    });
    const res = await request(app()).post('/api/group-files/favorites/toggle').send({ fileId: 5 });
    expect(res.status).toBe(200);
    expect(res.body.favorited).toBe(true);
    const ins = mockPool.query.mock.calls.find(c => /INSERT INTO file_favorites/.test(c[0]));
    expect(ins).toBeTruthy();
  });

  test('toggle：已收藏 → 取消（favorited=false）', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT id FROM group_files/.test(sql)) return Promise.resolve([[{ id: 5 }]]);
      if (/SELECT id FROM file_favorites/.test(sql)) return Promise.resolve([[{ id: 1 }]]); // 已收藏
      if (/DELETE FROM file_favorites/.test(sql)) return Promise.resolve([{ affectedRows: 1 }]);
      return Promise.resolve([[]]);
    });
    const res = await request(app()).post('/api/group-files/favorites/toggle').send({ fileId: 5 });
    expect(res.status).toBe(200);
    expect(res.body.favorited).toBe(false);
    const del = mockPool.query.mock.calls.find(c => /DELETE FROM file_favorites/.test(c[0]));
    expect(del).toBeTruthy();
  });

  test('列表接口返回 isFavorited 标记', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/COUNT\(\*\) AS total FROM group_files/.test(sql)) return Promise.resolve([[{ total: 1 }]]);
      if (/FROM group_files f/.test(sql)) {
        return Promise.resolve([[{
          id: 1, title: 'T', original_name: 'a.zip', file_size: 100, ext: '.zip',
          download_count: 0, file_group_id: 1, version: '1', is_latest: 1,
          access_level: 'all', allowed_group_ids: null, version_count: 1, is_favorited: 1,
          category_name: '', uploader_name: ''
        }]]);
      }
      return Promise.resolve([[]]);
    });
    const res = await request(app()).get('/api/group-files');
    expect(res.status).toBe(200);
    expect(res.body.files[0].isFavorited).toBe(true);
    // 查询里应带 EXISTS 子查询且第一个参数是 userId
    const listSql = mockPool.query.mock.calls.find(c => /FROM group_files f/.test(c[0]));
    expect(listSql[0]).toMatch(/EXISTS\(SELECT 1 FROM file_favorites/);
    expect(listSql[1][0]).toBe(1);
  });
});
