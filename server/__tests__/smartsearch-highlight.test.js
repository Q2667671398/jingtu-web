/**
 * G-07 搜索关键词高亮的安全测试
 * 关键约束：高亮必须在「已转义」的文本上做，用户输入不参与 HTML 拼接 → 不可注入。
 * 通过读取 smartsearch.js 源码断言实现方式（前端纯函数，无独立导出）。
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'smartsearch.js'), 'utf8');

describe('G-07 搜索高亮', () => {
  test('highlight 函数先 esc 转义再插入 <mark>', () => {
    const fn = SRC.match(/function highlight\([\s\S]*?\n  \}/);
    expect(fn).toBeTruthy();
    const body = fn[0];
    // 必须先转义
    expect(body).toMatch(/var safe = esc\(/);
    // 且用 safe（转义后文本）做切片，而不是原始 text
    expect(body).toMatch(/safe\.slice/);
    // 不允许把原始 text/query 直接拼进 HTML
    expect(body).not.toMatch(/\+\s*text\s*\+/);
    expect(body).not.toMatch(/\+\s*query\s*\+/);
  });

  test('renderList 使用 highlight 渲染标题，副标题仍 esc', () => {
    const body = SRC.match(/function renderList\([\s\S]*?\n  \}/);
    expect(body).toBeTruthy();
    expect(body[0]).toMatch(/highlight\(item\.title/);
    expect(body[0]).toMatch(/esc\(item\.sub/);
  });

  test('高亮循环有上限保护，避免异常输入造成死循环', () => {
    const body = SRC.match(/function highlight\([\s\S]*?\n  \}/)[0];
    expect(body).toMatch(/guard\s*<\s*\d+/);
  });

  test('查询词会去掉 /cmd 前缀再高亮', () => {
    const body = SRC.match(/function renderList\([\s\S]*?\n  \}/)[0];
    expect(body).toMatch(/replace\(\/\^\\s\*\\\/\\w\+\\s\*\//);
  });
});
