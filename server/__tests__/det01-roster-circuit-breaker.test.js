/**
 * DET-01 熔断行为测试
 *
 * 关键防护：上游返回空/骤降时绝不能执行
 * `UPDATE group_roster SET is_member=0`（否则全群误判退群）。
 * syncRosterFromVrc 通过注入的 pool 操作 DB、通过 ../vrc 拉上游，故只 mock ../vrc。
 */
const fs = require('fs');
const path = require('path');

const MOD = path.join(__dirname, '../routes/groups_helpers.js');
const SRC = fs.readFileSync(MOD, 'utf8');

// ==================== 结构校验 ====================
describe('DET-01 熔断（结构校验）', () => {
  test('空名单熔断必须在破坏性 UPDATE 之前', () => {
    const zeroIdx = SRC.indexOf('validMembers.length === 0');
    const updateIdx = SRC.indexOf('UPDATE group_roster SET is_member=0');
    expect(zeroIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(zeroIdx).toBeLessThan(updateIdx);
  });

  test('骤降熔断阈值 50%，同样在 UPDATE 之前', () => {
    const dropIdx = SRC.indexOf('oldMap.size * 0.5');
    expect(dropIdx).toBeGreaterThan(-1);
    expect(dropIdx).toBeLessThan(SRC.indexOf('UPDATE group_roster SET is_member=0'));
  });

  test('首次同步（本地无名册）不做骤降判断', () => {
    expect(SRC).toMatch(/oldMap\.size > 0 && validMembers\.length < oldMap\.size \* 0\.5/);
  });
});

// ==================== 行为校验 ====================
let mockUpstreamData = [];
jest.mock('../vrc', () => ({
  // 必须尊重 offset/pageSize 分页，否则 batch.length >= pageSize 会让调用方无限翻页
  vrchatGetGroupMembers: jest.fn((groupId, cookie, pageSize, offset) =>
    Promise.resolve({ status: 200, data: mockUpstreamData.slice(offset, offset + pageSize) })),
  vrchatGetUser: jest.fn(() => Promise.resolve({ status: 200, data: {} })),
  resolveTrustLevelFromTags: jest.fn(() => 'user'),
  vrcBacklog: jest.fn(() => 0)
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

function buildPool(oldCount) {
  const calls = [];
  const conn = {
    beginTransaction: jest.fn(() => Promise.resolve()),
    commit: jest.fn(() => Promise.resolve()),
    rollback: jest.fn(() => Promise.resolve()),
    release: jest.fn(),
    query: jest.fn((sql) => {
      calls.push(sql);
      if (/SELECT vrchat_id, vrchat_name, is_member FROM group_roster WHERE is_member=1/.test(sql)) {
        return Promise.resolve([Array.from({ length: oldCount }, (_, i) => ({
          vrchat_id: `usr_${i}`, vrchat_name: `M${i}`, is_member: 1
        }))]);
      }
      return Promise.resolve([[]]);
    })
  };
  const pool = {
    getConnection: jest.fn(() => Promise.resolve(conn)),
    query: jest.fn((sql) => { calls.push(sql); return Promise.resolve([[]]); })
  };
  return { pool, conn, calls };
}

function memberList(n) {
  return Array.from({ length: n }, (_, i) => ({
    userId: `usr_${i}`,
    user: { displayName: `M${i}`, currentAvatarThumbnailImageUrl: '' },
    membershipStatus: 'member',
    roleIds: []
  }));
}

const helpers = require('../routes/groups_helpers');

beforeEach(() => jest.clearAllMocks());

describe('DET-01 熔断（行为）', () => {
  test('上游返回空数组 → 抛错且绝不执行 is_member=0', async () => {
    mockUpstreamData = [];
    const { pool, conn, calls } = buildPool(100);
    await expect(helpers.syncRosterFromVrc({ pool, groupId: 'grp_x', vrcCookie: 'c' }))
      .rejects.toThrow();
    expect(calls.find(s => /UPDATE group_roster SET is_member=0/.test(s))).toBeUndefined();
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  });

  test('上游骤降 100 → 10 → 抛错且不执行 is_member=0', async () => {
    mockUpstreamData = memberList(10);
    const { pool, conn, calls } = buildPool(100);
    await expect(helpers.syncRosterFromVrc({ pool, groupId: 'grp_x', vrcCookie: 'c' }))
      .rejects.toThrow();
    expect(calls.find(s => /UPDATE group_roster SET is_member=0/.test(s))).toBeUndefined();
    expect(conn.rollback).toHaveBeenCalled();
  });

  test('正常小幅减员 100 → 90 → 放行并 commit', async () => {
    mockUpstreamData = memberList(90);
    const { pool, conn, calls } = buildPool(100);
    await helpers.syncRosterFromVrc({ pool, groupId: 'grp_x', vrcCookie: 'c' });
    expect(calls.find(s => /UPDATE group_roster SET is_member=0/.test(s))).toBeTruthy();
    expect(conn.commit).toHaveBeenCalled();
  });

  test('首次同步（本地 0 → 上游 5）→ 放行', async () => {
    mockUpstreamData = memberList(5);
    const { pool, conn, calls } = buildPool(0);
    await helpers.syncRosterFromVrc({ pool, groupId: 'grp_x', vrcCookie: 'c' });
    expect(calls.find(s => /UPDATE group_roster SET is_member=0/.test(s))).toBeTruthy();
    expect(conn.commit).toHaveBeenCalled();
  });

  test('上游增长 100 → 150 → 放行', async () => {
    mockUpstreamData = memberList(150);
    const { pool, conn, calls } = buildPool(100);
    await helpers.syncRosterFromVrc({ pool, groupId: 'grp_x', vrcCookie: 'c' });
    expect(calls.find(s => /UPDATE group_roster SET is_member=0/.test(s))).toBeTruthy();
    expect(conn.commit).toHaveBeenCalled();
  });
});