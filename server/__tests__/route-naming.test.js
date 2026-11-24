/**
 * BE-04：路由命名规范守卫
 *
 * 审计结论（2026-11-24，532 条路由）：
 *   单字小写        372 条  /login  /register
 *   param-first     85 条  /:id/attachments
 *   kebab-case      52 条  /change-password
 *   root            18 条  /
 *   other            5 条  /2fa/verify  /sitemap.xml  /robots.txt
 *
 * **不存在**同一资源用不同风格的冲突（snake_case / camelCase 均为 0）。
 * 也就是说历史命名整体是合理的 RESTful 分层，不是"混乱"。
 *
 * 因此本测试的目标是：把现有风格**固化为规范**，阻止未来新增违规写法：
 *   ✅ 允许：小写单词、kebab-case（连字符）、/:param 段、根路径
 *   ❌ 禁止：snake_case、camelCase、大写字母、尾随斜杠
 */
const fs = require('fs');
const path = require('path');

const ROUTE_RE = /router\.(get|post|put|delete|patch|all)\s*\(\s*['"`]([^'"`]+)['"`]/g;

function collectRoutes(dir) {
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        if (f === 'node_modules' || f === '_archive' || f === '__tests__') continue;
        walk(p);
      } else if (f.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        let m;
        ROUTE_RE.lastIndex = 0;
        while ((m = ROUTE_RE.exec(src)) !== null) {
          out.push({ method: m[1].toUpperCase(), route: m[2], file: f });
        }
      }
    }
  };
  walk(dir);
  return out;
}

describe('路由命名规范', () => {
  const routes = collectRoutes(path.join(__dirname, '..'));

  test('能收集到路由（防止正则失效导致空跑）', () => {
    expect(routes.length).toBeGreaterThan(400);
  });

  test('不得使用 snake_case 段', () => {
    const bad = routes.filter(r => r.route.split('/').some(s => /^[a-z]+(_[a-z0-9]+)+$/i.test(s)));
    expect(bad.map(r => `${r.method} ${r.route} [${r.file}]`)).toEqual([]);
  });

  test('不得使用 camelCase 段（URL 惯例用连字符）', () => {
    const bad = routes.filter(r => r.route.split('/').some(s => /^[a-z]+[A-Z][A-Za-z0-9]*$/.test(s)));
    expect(bad.map(r => `${r.method} ${r.route} [${r.file}]`)).toEqual([]);
  });

  test('不得有大写字母段', () => {
    const bad = routes.filter(r => r.route.split('/').some(s => /[A-Z]/.test(s) && !s.startsWith(':')));
    expect(bad.map(r => `${r.method} ${r.route} [${r.file}]`)).toEqual([]);
  });

  test('不得有尾随斜杠（根路径除外）', () => {
    const bad = routes.filter(r => r.route.length > 1 && r.route.endsWith('/'));
    expect(bad.map(r => `${r.method} ${r.route} [${r.file}]`)).toEqual([]);
  });

  test('参数段统一用 :name 冒号形式（不用 * 或 :name? 以外的花式写法）', () => {
    const bad = routes.filter(r => r.route.split('/').some(s => s.startsWith(':') && !/^:[A-Za-z][A-Za-z0-9]*$/.test(s)));
    // 允许 Express 5 风格的 :id? 可选参数——当前项目未用，若引入需在此放行
    expect(bad.map(r => `${r.method} ${r.route} [${r.file}]`)).toEqual([]);
  });

  test('静态文件类特例（sitemap.xml / robots.txt）单独放行', () => {
    const special = routes.filter(r => /\.(xml|txt)$/.test(r.route));
    for (const s of special) {
      expect(['/sitemap.xml', '/robots.txt']).toContain(s.route);
    }
  });
});
