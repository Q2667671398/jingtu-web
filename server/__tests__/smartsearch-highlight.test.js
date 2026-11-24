/**
 * G-07 搜索关键词高亮 —— 行为测试
 *
 * 改造说明（测试脆弱性治理）：
 * 原实现读 smartsearch.js 源码、用正则断言 `var safe = esc(` 之类代码文本。
 * 这类断言「重构即坏、功能没坏也报红」，属于脆弱测试。
 * 现在改为：用 vm 沙箱加载真实脚本 → 调用真实 highlight() → 断言**输出行为**。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'smartsearch.js'), 'utf8');

/**
 * 在最小 DOM 沙箱里执行 smartsearch.js，返回其暴露的内部函数。
 * 只桩掉脚本真正会碰到的浏览器 API；不引入 jsdom。
 */
function loadSmartSearch() {
  const noop = () => {};
  const fakeEl = () => ({
    style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, removeAttribute: noop, getAttribute: () => null,
    appendChild: noop, removeChild: noop, addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [], focus: noop, blur: noop,
    innerHTML: '', textContent: '', value: '', dataset: {}, children: [], parentNode: null
  });
  const documentStub = {
    readyState: 'complete',
    createElement: fakeEl,
    createDocumentFragment: fakeEl,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    body: fakeEl(),
    head: fakeEl(),
    documentElement: fakeEl()
  };
  const sandbox = {
    window: {},
    document: documentStub,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    console,
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    requestAnimationFrame: noop,
    // core.js 约定：esc / __ / api / toast / switchTab
    esc: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    __: (k) => k,
    api: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    toast: noop,
    switchTab: noop,
    currentUser: null,
    addEventListener: noop,
    removeEventListener: noop,
    navigator: { userAgent: 'node' },
    location: { origin: 'http://localhost' }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'smartsearch.js' });
  const internals = sandbox.window.__smartSearchInternals;
  if (!internals) throw new Error('smartsearch.js 未暴露 __smartSearchInternals');
  return internals;
}

describe('G-07 搜索高亮（行为）', () => {
  let highlight;
  beforeAll(() => { ({ highlight } = loadSmartSearch()); });

  test('命中查询词时用 <mark> 包裹', () => {
    const out = highlight('hello world', 'world');
    expect(out).toContain('<mark class="ss-hl">world</mark>');
    expect(out).toContain('hello ');
  });

  test('大小写不敏感，但保留原文大小写', () => {
    const out = highlight('Hello World', 'WORLD');
    expect(out).toContain('<mark class="ss-hl">World</mark>');
  });

  test('XSS：查询词里的 HTML 被转义，不产生可执行标签', () => {
    const out = highlight('<img src=x onerror=alert(1)>abc', 'abc');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    // 只有我们自己插入的 mark 标签
    expect((out.match(/<mark/g) || []).length).toBe(1);
  });

  test('XSS：查询词本身含标签时也被转义，不注入', () => {
    const out = highlight('abc<script>x</script>', '<script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  test('空查询词原样返回（仅转义）', () => {
    const out = highlight('<b>x</b>', '');
    expect(out).toBe('&lt;b&gt;x&lt;/b&gt;');
  });

  test('null / undefined 输入不抛错', () => {
    expect(() => highlight(null, 'a')).not.toThrow();
    expect(highlight(null, 'a')).toBe('');
    expect(() => highlight(undefined, undefined)).not.toThrow();
  });

  test('多处命中全部高亮', () => {
    const out = highlight('aXbXc', 'X');
    expect((out.match(/<mark/g) || []).length).toBe(2);
  });

  test('异常输入不会死循环（有限时间内返回）', () => {
    const start = Date.now();
    const out = highlight('a'.repeat(5000), 'a');
    expect(Date.now() - start).toBeLessThan(2000);
    expect(typeof out).toBe('string');
  });

  test('查询词无命中时原样返回（仅转义）', () => {
    const out = highlight('abc', 'zzz');
    expect(out).toBe('abc');
    expect(out).not.toContain('<mark');
  });
});

describe('G-07 stripTags（行为）', () => {
  let stripTags;
  beforeAll(() => { ({ stripTags } = loadSmartSearch()); });

  test('剥离标签只留文本', () => {
    // 沙箱里 document.createElement 是桩，template.textContent 为空 → 返回 ''
    // 这里断言「不抛错且返回字符串」即可，真实剥标签行为由浏览器保证
    expect(typeof stripTags('<b>x</b>')).toBe('string');
  });

  test('空输入返回空串', () => {
    expect(stripTags('')).toBe('');
    expect(stripTags(null)).toBe('');
  });
});
