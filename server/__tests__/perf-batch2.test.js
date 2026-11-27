/**
 * 第 2 批 性能主攻 回归测试
 * PERF-05 位置落库节流 / PERF-11 group-stats 查询合并 / PERF-04 聊天双触发 / DET-05 共享快照 / PERF-12 批量写
 */
const fs = require('fs');
const path = require('path');

const WS = fs.readFileSync(path.join(__dirname, '../ws_service.js'), 'utf8');
const SCHED = fs.readFileSync(path.join(__dirname, '../schedule.js'), 'utf8');
const STATS = fs.readFileSync(path.join(__dirname, '../routes/groups_members.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(__dirname, '../../public/js/main.js'), 'utf8');

// ==================== PERF-05 位置落库节流 ====================
describe('PERF-05 位置落库节流', () => {
  test('节流周期必须是 60s（原为每次上报都写 = 5s）', () => {
    expect(WS).toMatch(/LOCATION_PERSIST_INTERVAL_MS\s*=\s*60000/);
  });

  test('提供调度/立即写/丢弃三个入口', () => {
    expect(WS).toMatch(/function schedulePersistLocation/);
    expect(WS).toMatch(/function flushPendingLocation/);
    expect(WS).toMatch(/function dropPendingLocation/);
  });

  test('重复上报只保留最新坐标（覆盖而非排队）', () => {
    const idx = WS.indexOf('function schedulePersistLocation');
    const block = WS.slice(idx, idx + 900);
    expect(block).toMatch(/pending\.lat = lat/);
    expect(block).toMatch(/pending\.lng = lng/);
    // 已有待写项时直接返回，不再新建定时器
    expect(block).toMatch(/return;\s*\/\/ 已有定时器在等/);
  });

  test('断线时 flush（保留最近位置）', () => {
    const idx = WS.indexOf('function forceOffline');
    const block = WS.slice(idx, idx + 700);
    expect(block).toMatch(/flushPendingLocation/);
  });

  test('停止共享时 drop（不把已关闭共享的坐标写回）', () => {
    const idx = WS.indexOf('function stopLocation');
    const block = WS.slice(idx, idx + 700);
    expect(block).toMatch(/dropPendingLocation/);
  });

  test('后台定时器 unref，不阻止进程退出', () => {
    const idx = WS.indexOf('function schedulePersistLocation');
    const block = WS.slice(idx, idx + 900);
    expect(block).toMatch(/unref/);
  });
});

// ==================== PERF-11 group/stats 查询合并 ====================
describe('PERF-11 /group/stats 查询合并与缓存', () => {
  test('4 条 COUNT 合并为 1 条条件聚合', () => {
    expect(STATS).toMatch(/SUM\(is_online = 1\) AS onlineCnt/);
    expect(STATS).toMatch(/SUM\(is_in_game = 1\) AS inGameCnt/);
    expect(STATS).toMatch(/SUM\(is_online = 1 AND is_friend = 0\) AS unknownCnt/);
    // 不应再有独立的 COUNT(*) 成员查询
    expect(STATS).not.toMatch(/SELECT COUNT\(\*\) as count FROM group_roster WHERE is_member=1`/);
  });

  test('其余查询并行（Promise.all）', () => {
    const idx = STATS.indexOf("router.get('/group/stats'");
    const block = STATS.slice(idx, idx + 2600);
    expect(block).toMatch(/Promise\.all/);
  });

  test('有 25s 缓存且 TTL 小于前端 30s 轮询', () => {
    expect(STATS).toMatch(/STATS_CACHE_TTL\s*=\s*25000/);
    expect(STATS).toMatch(/_statsCache\.data && Date\.now\(\) - _statsCache\.at < STATS_CACHE_TTL/);
  });

  test('提供缓存失效入口', () => {
    expect(STATS).toMatch(/function invalidateStatsCache/);
  });

  test('joined_at 仍用半开区间（未回退到 DATE() 函数包裹）', () => {
    expect(STATS).toMatch(/joined_at >= CURDATE\(\) AND joined_at < CURDATE\(\) \+ INTERVAL 1 DAY/);
    expect(STATS).not.toMatch(/DATE\(joined_at\)\s*=\s*CURDATE\(\)/);
  });
});

// ==================== PERF-04 聊天双触发 ====================
describe('PERF-04 聊天列表不再双重刷新', () => {
  test('main.js 优先走 chat.js 的防抖入口', () => {
    const idx = MAIN.indexOf("msg.type === 'chat:new'");
    const block = MAIN.slice(idx, idx + 800);
    expect(block).toMatch(/scheduleChatListRefresh/);
    // 裸 setTimeout 只允许出现在兜底分支里（chat 模块未加载时）
    const hasSchedule = block.indexOf('scheduleChatListRefresh') > -1;
    expect(hasSchedule).toBe(true);
  });

  test('防抖入口本身仍是 2.5s 合并', () => {
    const chat = fs.readFileSync(path.join(__dirname, '../../public/js/chat.js'), 'utf8');
    const idx = chat.indexOf('function scheduleChatListRefresh');
    const block = chat.slice(idx, idx + 400);
    expect(block).toMatch(/2500/);
    expect(block).toMatch(/clearTimeout/);
  });
});

// ==================== DET-05 共享快照 ====================
describe('DET-05 四个每分钟任务共用一次查询', () => {
  test('提供共享快照与失效入口', () => {
    expect(SCHED).toMatch(/async function getFriendsSnapshot/);
    expect(SCHED).toMatch(/function invalidateRosterSnapshot/);
    expect(SCHED).toMatch(/ROSTER_SNAPSHOT_TTL_MS\s*=\s*30 \* 1000/);
  });

  test('4 个任务都改用快照，不再各自查 group_roster', () => {
    const calls = (SCHED.match(/const rows = await getFriendsSnapshot\(\);/g) || []).length;
    expect(calls).toBe(4);
    // 不应再有「按 is_friend 从 group_roster 取名册」的裸查询（快照定义本身除外）
    const bareFriendQueries = SCHED.match(/const \[rows\] = await pool\.query\(\s*`SELECT[^`]*FROM group_roster[^`]*is_friend\s*=\s*1/g) || [];
    expect(bareFriendQueries.length).toBe(0);
  });

  test('快照字段是 4 个任务的并集', () => {
    const idx = SCHED.indexOf('async function getFriendsSnapshot');
    const block = SCHED.slice(idx, idx + 900);
    for (const col of ['vrchat_id', 'display_name', 'avatar_url', 'avatar_id', 'is_online', 'vrchat_status', 'world_name']) {
      expect(block).toContain(col);
    }
  });
});

// ==================== PERF-12 批量写 ====================
describe('PERF-12 定时任务逐条写改批量', () => {
  test('friend_log 判重改为一次查 Set（不再是循环内 SELECT）', () => {
    expect(SCHED).toMatch(/const dupSet = new Set\(\)/);
    expect(SCHED).toMatch(/dupSet\.add\(/);
    expect(SCHED).toMatch(/const toInsert = historyInserts\.filter/);
  });

  test('friend_log 插入改多值 VALUES', () => {
    expect(SCHED).toMatch(/INSERT INTO friend_log \(vrchat_id, change_type, old_value, new_value\) VALUES \$\{chunk\.map/);
  });

  test('四个 *_current 快照都改批量 UPSERT', () => {
    expect(SCHED).toMatch(/INSERT INTO friend_log_current[\s\S]{0,200}VALUES \$\{chunk\.map/);
    expect(SCHED).toMatch(/INSERT INTO world_visit_current[\s\S]{0,200}VALUES \$\{chunk\.map/);
    expect(SCHED).toMatch(/INSERT INTO avatar_history_current[\s\S]{0,200}VALUES \$\{chunk\.map/);
  });

  test('两个 *_log 事件表都改多值写', () => {
    expect(SCHED).toMatch(/INSERT INTO world_visit_log[\s\S]{0,200}VALUES \$\{chunk\.map/);
    expect(SCHED).toMatch(/INSERT INTO avatar_history_log[\s\S]{0,200}VALUES \$\{chunk\.map/);
  });

  test('不再有逐条 for-of await 写库（4 个任务内）', () => {
    expect(SCHED).not.toMatch(/for \(const ev of events\)/);
    expect(SCHED).not.toMatch(/for \(const c of currentUpserts\)/);
    expect(SCHED).not.toMatch(/for \(const h of historyInserts\)/);
  });
});