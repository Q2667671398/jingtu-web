/**
 * DB-01：checkAndUnlock 的 N+1 优化（行为测试）
 * 断言：①29 个成就只查 1 次 user_achievements（原来 29 次）
 *       ②新增/已解锁/未达标三分支行为正确
 */
const mockPool = { query: jest.fn() };
jest.mock('../utils', () => {
  const actual = jest.requireActual('../utils');
  return { ...actual, getPool: () => mockPool };
});
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const router = require('../routes/achievements');
const checkAndUnlock = router.__checkAndUnlock;

function mkAchievements(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1, type: 'checkin', condition_type: 'streak', condition_value: 7,
    points: 10, is_active: 1
  }));
}

describe('checkAndUnlock N+1 优化', () => {
  beforeEach(() => jest.clearAllMocks());

  test('29 个成就只查 1 次 user_achievements（不再逐个查）', async () => {
    const achs = mkAchievements(29);
    mockPool.query.mockImplementation((sql) => {
      if (/FROM achievements WHERE type/.test(sql)) return Promise.resolve([achs]);
      if (/SELECT id, achievement_id, is_unlocked, progress FROM user_achievements WHERE user_id/.test(sql)) {
        return Promise.resolve([[]]); // 该用户尚无任何记录
      }
      if (/INSERT INTO user_achievements/.test(sql)) return Promise.resolve([{ affectedRows: 1 }]);
      if (/UPDATE users SET achievement_points/.test(sql)) return Promise.resolve([{ affectedRows: 1 }]);
      return Promise.resolve([{ affectedRows: 0 }]);
    });

    await checkAndUnlock(1, 'checkin', { streak: 1 });

    const selectCalls = mockPool.query.mock.calls.filter(c =>
      /SELECT[^]*FROM user_achievements/i.test(c[0]) && !/INSERT|UPDATE/i.test(c[0]));
    expect(selectCalls.length).toBe(1); // 关键断言：1 次而不是 29 次
  });

  test('达到条件且无记录 → 插入并加分', async () => {
    const achs = [{
      id: 1, type: 'checkin', condition_type: 'streak', condition_value: 7, points: 10, is_active: 1
    }];
    let inserted = false;
    let pointsAdded = 0;
    mockPool.query.mockImplementation((sql, params) => {
      if (/FROM achievements WHERE type/.test(sql)) return Promise.resolve([achs]);
      if (/SELECT id, achievement_id, is_unlocked, progress FROM user_achievements WHERE user_id/.test(sql)) {
        return Promise.resolve([[]]);
      }
      if (/UPDATE user_achievements SET progress = \?, is_unlocked = 1/.test(sql)) {
        return Promise.resolve([{ affectedRows: 0 }]); // 无行可翻转
      }
      if (/INSERT INTO user_achievements/.test(sql)) { inserted = true; return Promise.resolve([{ affectedRows: 1 }]); }
      if (/UPDATE users SET achievement_points/.test(sql)) { pointsAdded = params[0]; return Promise.resolve([{ affectedRows: 1 }]); }
      return Promise.resolve([{ affectedRows: 0 }]);
    });

    const r = await checkAndUnlock(1, 'checkin', { streak: 10 });
    expect(inserted).toBe(true);
    expect(pointsAdded).toBe(10);
    expect(r.unlockedCount).toBe(1);
    expect(r.unlockedAchievements).toHaveLength(1);
  });

  test('已解锁 → 只推进度，不重复加分', async () => {
    const achs = [{
      id: 1, type: 'checkin', condition_type: 'streak', condition_value: 7, points: 10, is_active: 1
    }];
    let pointsAdded = 0;
    let progressUpdated = 0;
    mockPool.query.mockImplementation((sql, params) => {
      if (/FROM achievements WHERE type/.test(sql)) return Promise.resolve([achs]);
      if (/SELECT id, achievement_id, is_unlocked, progress FROM user_achievements WHERE user_id/.test(sql)) {
        return Promise.resolve([[{ id: 9, achievement_id: 1, is_unlocked: 1, progress: 5 }]]);
      }
      if (/UPDATE user_achievements SET progress = \?, is_unlocked = 1/.test(sql)) {
        return Promise.resolve([{ affectedRows: 0 }]);
      }
      if (/UPDATE users SET achievement_points/.test(sql)) { pointsAdded = params[0]; return Promise.resolve([{ affectedRows: 1 }]); }
      if (/UPDATE user_achievements SET progress = \? WHERE/.test(sql)) { progressUpdated = params[0]; return Promise.resolve([{ affectedRows: 1 }]); }
      return Promise.resolve([{ affectedRows: 0 }]);
    });

    const r = await checkAndUnlock(1, 'checkin', { streak: 10 });
    expect(pointsAdded).toBe(0);      // 不重复加分
    expect(progressUpdated).toBe(10); // 进度推进
    expect(r.unlockedCount).toBe(0);
  });

  test('未达标 → 仅记录进度', async () => {
    const achs = [{
      id: 1, type: 'checkin', condition_type: 'streak', condition_value: 7, points: 10, is_active: 1
    }];
    let progressUpdated = 0;
    let inserted = false;
    mockPool.query.mockImplementation((sql, params) => {
      if (/FROM achievements WHERE type/.test(sql)) return Promise.resolve([achs]);
      if (/SELECT id, achievement_id, is_unlocked, progress FROM user_achievements WHERE user_id/.test(sql)) {
        return Promise.resolve([[{ id: 9, achievement_id: 1, is_unlocked: 0, progress: 2 }]]);
      }
      if (/INSERT INTO user_achievements/.test(sql)) { inserted = true; return Promise.resolve([{ affectedRows: 1 }]); }
      if (/UPDATE user_achievements SET progress = \? WHERE/.test(sql)) { progressUpdated = params[0]; return Promise.resolve([{ affectedRows: 1 }]); }
      return Promise.resolve([{ affectedRows: 0 }]);
    });

    const r = await checkAndUnlock(1, 'checkin', { streak: 3 }); // 3 < 7
    expect(inserted).toBe(false);
    expect(progressUpdated).toBe(3);
    expect(r.unlockedCount).toBe(0);
  });

  test('进度传非数值 → 归一化为 0，不写脏数据', async () => {
    const achs = [{
      id: 1, type: 'checkin', condition_type: 'streak', condition_value: 7, points: 10, is_active: 1
    }];
    let progressUpdated = null;
    mockPool.query.mockImplementation((sql, params) => {
      if (/FROM achievements WHERE type/.test(sql)) return Promise.resolve([achs]);
      if (/SELECT id, achievement_id, is_unlocked, progress FROM user_achievements WHERE user_id/.test(sql)) {
        return Promise.resolve([[{ id: 9, achievement_id: 1, is_unlocked: 0, progress: 2 }]]);
      }
      if (/UPDATE user_achievements SET progress = \? WHERE/.test(sql)) { progressUpdated = params[0]; return Promise.resolve([{ affectedRows: 1 }]); }
      return Promise.resolve([{ affectedRows: 0 }]);
    });

    await checkAndUnlock(1, 'checkin', { streak: { bad: true } });
    expect(progressUpdated).toBe(0);
  });
});
