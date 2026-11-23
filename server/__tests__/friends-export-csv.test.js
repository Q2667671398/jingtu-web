/**
 * G-12 历史流水 CSV 导出 + G-13 移动端手势 测试
 */
const request = require('supertest');
const express = require('express');
const fs = require('fs');
const path = require('path');

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

describe('G-12 历史流水 CSV 导出', () => {
  beforeEach(() => jest.clearAllMocks());

  test('未绑定 VRChat → 400', async () => {
    mockPool.query.mockResolvedValueOnce([[{ vrchat_id: null, vrchat_name: null }]]);
    const res = await request(buildApp()).get('/api/friends/export-csv?type=sessions');
    expect(res.status).toBe(400);
  });

  test('导出 sessions：返回 CSV 含 BOM/表头/Content-Disposition', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT vrchat_id, vrchat_name FROM users/.test(sql)) return Promise.resolve([[{ vrchat_id: 'usr_a', vrchat_name: 'A' }]]);
      if (/FROM activity_sessions/.test(sql)) return Promise.resolve([[
        { started_at: '2026-11-01 10:00', ended_at: '2026-11-01 11:00', duration_minutes: 60, world_id: 'wrld_x', world_name: 'FISH' }
      ]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/export-csv?type=sessions');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="friends_sessions_/);
    const body = res.text || res.body.toString();
    expect(body.charCodeAt(0)).toBe(0xFEFF); // UTF-8 BOM
    expect(body).toContain('开始时间');
    expect(body).toContain('FISH');
  });

  test('CSV 注入防护：字段含逗号/引号/换行时被正确转义', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT vrchat_id, vrchat_name FROM users/.test(sql)) return Promise.resolve([[{ vrchat_id: 'usr_a', vrchat_name: 'A' }]]);
      if (/FROM friend_log/.test(sql)) return Promise.resolve([[
        { change_type: 'world', old_value: 'a,b', new_value: 'he said "hi"\nline2', created_at: '2026-11-01' }
      ]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/export-csv?type=history');
    expect(res.status).toBe(200);
    const body = res.text || res.body.toString();
    // 含逗号的字段必须整体加引号
    expect(body).toContain('"a,b"');
    // 内部引号必须双写
    expect(body).toContain('""hi""');
  });

  test('他人非好友 → 403', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM user_friends/.test(sql)) return Promise.resolve([[]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/export-csv?type=sessions&userId=99');
    expect(res.status).toBe(403);
  });

  test('非法 type 回退 sessions', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT vrchat_id, vrchat_name FROM users/.test(sql)) return Promise.resolve([[{ vrchat_id: 'usr_a', vrchat_name: 'A' }]]);
      if (/FROM activity_sessions/.test(sql)) return Promise.resolve([[]]);
      return Promise.resolve([[]]);
    });
    const res = await request(buildApp()).get('/api/friends/export-csv?type=evil');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/friends_sessions_/);
  });
});

describe('G-13 移动端手势脚本', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'mobile-gestures.js'), 'utf8');

  test('仅在触屏 + 窄屏启用', () => {
    expect(src).toMatch(/pointer: coarse/);
    expect(src).toMatch(/max-width: 900px/);
  });

  test('不劫持横向可滚动容器内的手势', () => {
    expect(src).toMatch(/function inScrollableX/);
    expect(src).toMatch(/scrollWidth > node\.clientWidth/);
  });

  test('有最小位移与最大时长阈值，避免误触', () => {
    expect(src).toMatch(/MIN_DX\s*=\s*\d+/);
    expect(src).toMatch(/MAX_MS\s*=\s*\d+/);
    expect(src).toMatch(/Math\.abs\(dx\) < Math\.abs\(dy\)/);
  });

  test('通过 window.switchTab 按 TAB_ORDER 切换', () => {
    expect(src).toMatch(/window\.switchTab\(TAB_ORDER\[next\]/);
  });

  test('index.html 已引入该脚本', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
    expect(html).toMatch(/mobile-gestures\.js/);
  });
});
