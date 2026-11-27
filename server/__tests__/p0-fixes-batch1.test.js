/**
 * 第 1 批止血回归测试（2026-11-26）
 * 覆盖：SEC-01 拉黑绕过、DET-01 名册同步熔断、UX-01 键盘委托、PERF-01/02 定时器泄漏
 */
const request = require('supertest');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ==================== SEC-01 拉黑绕过 ====================
const mockPool = { query: jest.fn(), getConnection: jest.fn() };
const mockConn = {
  beginTransaction: jest.fn(() => Promise.resolve()),
  commit: jest.fn(() => Promise.resolve()),
  rollback: jest.fn(() => Promise.resolve()),
  release: jest.fn(),
  query: jest.fn(() => Promise.resolve([[]]))
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
    getAvatarUrl: () => '/api/avatar/default',
    paginate: (req, opts = {}) => {
      const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), 10000);
      const pageSize = Math.min(opts.maxSize || 100, Math.max(1, parseInt(req.query.pageSize, 10) || opts.defaultSize || 20));
      return { page, pageSize, offset: (page - 1) * pageSize };
    },
    ErrorCodes: actual.ErrorCodes
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
  a.use((req, res, next) => { req.session = userId ? { userId, displayName: 'U' } : {}; next(); });
  a.use('/api/friends', friendsRouter());
  return a;
}

describe('SEC-01 拉黑不能被对方解除', () => {
  beforeEach(() => { jest.clearAllMocks(); mockPool.getConnection.mockResolvedValue(mockConn); });

  test('DELETE /friends/:id 的 SQL 必须排除对方的 blocked 行', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const res = await request(app(1)).delete('/api/friends/2');
    expect(res.status).toBe(200);
    const sql = mockPool.query.mock.calls[0][0];
    // 关键断言：对方方向（第三个占位符起）必须带 status <> 'blocked'
    expect(sql).toMatch(/status\s*<>\s*'blocked'/);
    // 且必须仍然允许删除自己方向的行
    expect(sql).toMatch(/user_id = \? AND friend_id = \?\)/);
  });

  test('DELETE /friends/:id 参数顺序仍为 [me, other, other, me]', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    await request(app(7)).delete('/api/friends/9');
    const params = mockPool.query.mock.calls[0][1];
    expect(params).toEqual([7, 9, 9, 7]);
  });

  test('只剩对方 blocked 行时返回 404（无关系可删）', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const res = await request(app(1)).delete('/api/friends/2');
    expect(res.status).toBe(404);
  });

  test('POST /block 清除对称行时不得删除对方对我的 blocked', async () => {
    // 调用顺序：userExists(1) → existing 检查(2) → 事务内 3 条写
    mockPool.query
      .mockResolvedValueOnce([[{ id: 2 }]])  // userExists
      .mockResolvedValueOnce([[]]);          // existing（我还没拉黑他）
    mockConn.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])  // INSERT blocked
      .mockResolvedValueOnce([{ affectedRows: 0 }])  // DELETE 对称行
      .mockResolvedValueOnce([{ affectedRows: 0 }]); // DELETE 关注
    mockPool.getConnection.mockResolvedValue(mockConn);

    const res = await request(app(1)).post('/api/friends/block').send({ targetUserId: 2 });
    expect(res.status).toBe(200);
    const delCall = mockConn.query.mock.calls.find(c => /DELETE FROM user_friends/.test(c[0]));
    expect(delCall).toBeTruthy();
    expect(delCall[0]).toMatch(/status\s*<>\s*'blocked'/);
  });

  test('解除拉黑（unblock）仍只删自己方向（未被误伤）', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const res = await request(app(1)).delete('/api/friends/block/2');
    expect(res.status).toBe(200);
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/user_id = \? AND friend_id = \? AND status = 'blocked'/);
    expect(sql).not.toMatch(/status\s*<>\s*'blocked'/);
  });
});

// ==================== DET-01 名册同步熔断 ====================
describe('DET-01 名册同步熔断', () => {
  test('源码必须包含空名单与骤降两道熔断', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/groups_helpers.js'), 'utf8');
    expect(src).toMatch(/validMembers\.length === 0/);
    expect(src).toMatch(/oldMap\.size \* 0\.5/);
    // 熔断必须先 rollback 再抛错，而不是先 UPDATE is_member=0
    const zeroIdx = src.indexOf('validMembers.length === 0');
    const dropIdx = src.indexOf('oldMap.size * 0.5');
    const updateIdx = src.indexOf("UPDATE group_roster SET is_member=0 WHERE is_member=1");
    expect(zeroIdx).toBeGreaterThan(-1);
    expect(dropIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(-1);
    // 两个熔断都必须排在破坏性 UPDATE 之前
    expect(zeroIdx).toBeLessThan(updateIdx);
    expect(dropIdx).toBeLessThan(updateIdx);
  });

  test('熔断分支必须 rollback（不留下半截事务）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/groups_helpers.js'), 'utf8');
    const idx = src.indexOf('validMembers.length === 0');
    const block = src.slice(idx, idx + 700);
    expect(block).toMatch(/rollback/);
    expect(block).toMatch(/logger\.error/);
  });
});

// ==================== UX-01 键盘委托 ====================
describe('UX-01 键盘委托不劫持原生按钮', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../public/js/core.js'), 'utf8');

  test('keydown 委托必须排除 button/a', () => {
    const idx = src.indexOf("// 全局键盘委托");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 900);
    expect(block).toMatch(/tag === 'button' \|\| tag === 'a'/);
    // 排除判断必须在 el.click() 之前
    expect(block.indexOf("tag === 'button'")).toBeLessThan(block.indexOf('el.click()'));
  });

  test('输入类元素仍然被排除', () => {
    const idx = src.indexOf("// 全局键盘委托");
    const block = src.slice(idx, idx + 900);
    expect(block).toMatch(/tag === 'input'/);
  });
});

// ==================== PERF-01 / PERF-02 定时器泄漏 ====================
describe('PERF-01 活动倒计时可被停止', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../public/js/events.js'), 'utf8');

  test('必须导出 stopSignCountdown', () => {
    expect(src).toMatch(/function stopSignCountdown\s*\(/);
    expect(src).toMatch(/clearInterval\(_signCountdownTimer\)/);
  });

  test('tick 内元素消失时自停（不再空转）', () => {
    const idx = src.indexOf('function startSignCountdown');
    const block = src.slice(idx, idx + 1400);
    expect(block).toMatch(/if \(!cur\) \{ stopSignCountdown\(\); return; \}/);
  });

  test('switchTab 离开 events 时调用 stopSignCountdown', () => {
    const uiSrc = fs.readFileSync(path.join(__dirname, '../../public/js/ui.js'), 'utf8');
    expect(uiSrc).toMatch(/tab !== 'events'.*stopSignCountdown/);
  });
});

describe('PERF-02 振铃必须有超时', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../public/js/rtc.js'), 'utf8');

  test('定义振铃超时常量与计时器', () => {
    expect(src).toMatch(/RTC_RING_TIMEOUT_MS\s*=\s*\d+/);
    expect(src).toMatch(/rtcRingTimeout/);
  });

  test('rtcPlayRing 内 setTimeout 到点自动取消来电', () => {
    const idx = src.indexOf('function rtcPlayRing');
    const block = src.slice(idx, idx + 1400);
    expect(block).toMatch(/setTimeout\(/);
    expect(block).toMatch(/rtc:cancel/);
    expect(block).toMatch(/hideRtcIncomingPopup/);
  });

  test('rtcStopRing 同时清理 interval 与 timeout', () => {
    const idx = src.indexOf('function rtcStopRing');
    const block = src.slice(idx, idx + 400);
    expect(block).toMatch(/clearInterval\(rtcRingTimer\)/);
    expect(block).toMatch(/clearTimeout\(rtcRingTimeout\)/);
  });

  test('后台标签不响铃（document.hidden 守卫）', () => {
    const idx = src.indexOf('function rtcPlayRing');
    const block = src.slice(idx, idx + 800);
    expect(block).toMatch(/document\.hidden/);
  });
});