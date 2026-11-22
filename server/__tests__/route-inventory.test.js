/**
 * P2-66 路由守恒守卫：god-route 拆分（groups.js / users.js 等）前后，
 * 全应用路由清单必须与基线快照保持一致。
 *
 * 基线 fixtures/route-inventory.json 由 route_guard.collectRoutes 在拆分前生成。
 *
 * QA-04（2026-11-23）：由「逐条全等（含顺序、条数）」放宽为「只增不删」——
 *  · 删除/改名守卫：fixture 中登记的每一条路由（以 `METHOD /path` 精确匹配，
 *    即保留对方法/路径属性的校验）必须仍存在于当前路由表；缺失或未登记即失败；
 *  · 新增路由自动放行：当前路由表里 fixture 未登记的路由不再阻断 CI，仅在
 *    末尾 console.warn 提示维护者择机更新 fixture；
 *  · 不再强制条数相等与注册顺序一致（新增路由天然会打破这两者）。
 * 这样增删路由不必手改快照才能过 CI，同时守住「已登记路由不被偷偷删改」的底线。
 */
const fs = require('fs');
const path = require('path');
const app = require('../server');
const { collectRoutes } = require('../route_guard');

// 按路由字符串计数（保留重复项语义，避免 fixture 中同串多条时被单次命中蒙混过关）
function countBy(list) {
  const m = new Map();
  for (const x of list) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

describe('路由守恒（P2-66 god-route 拆分守卫）', () => {
  it('基线登记的路由必须全部仍存在（允许新增，禁止删除/改名，方法+路径精确匹配）', () => {
    const golden = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures', 'route-inventory.json'), 'utf8')
    );
    const live = collectRoutes(app).map(r => `${r.method} ${r.path}`);

    const goldenCount = countBy(golden);
    const liveCount = countBy(live);

    // 1) 删除/改名守卫：fixture 中每条路由（含重复计数）必须在当前路由表中仍然存在。
    //    路由字符串由 method + path 组成，任一变化都会令该 fixture 项「消失」→ 失败。
    const missing = [];
    for (const [route, n] of goldenCount) {
      const have = liveCount.get(route) || 0;
      if (have < n) missing.push(`${route}（基线 ${n} 条，当前 ${have} 条）`);
    }
    expect(missing).toEqual([]);

    // 2) 新增路由自动放行，仅提示更新 fixture（不阻断 CI）。
    const added = [];
    for (const [route, n] of liveCount) {
      const base = goldenCount.get(route) || 0;
      for (let i = base; i < n; i += 1) added.push(route);
    }
    if (added.length) {
      console.warn(
        `[route-inventory] 检测到 ${added.length} 条新增路由（不影响本守卫通过）；` +
        `建议择机更新 fixtures/route-inventory.json：\n  ${added.join('\n  ')}`
      );
    }
  });
});
