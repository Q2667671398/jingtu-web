/**
 * BE-02：响应格式契约守卫
 *
 * 背景：全站曾有 3 套响应格式并存（历史原因，前端已分别适配）：
 *   1) ok(res, fields)      → { success: true, ...fields }          （扁平）
 *   2) fail(res, st, msg)   → { success: false, error: "字符串", ...extra }（扁平，error 是字符串）
 *   3) sendError(res, st, code, msg) → { success: false, error: { code, message } }（嵌套）
 *   4) 少量裸 res.json({ ok: true }) / res.json({ success: ... })
 *
 * 前端对 2) 裸读 data.error 当字符串，对 3) 读 data.error.code/message，
 * 对 4) 读 data.ok —— 三者契约不同，**不能合并**（合并即全站崩）。
 *
 * 因此本测试的目标不是"统一"，而是：
 *   ① 锁死三种 helper 的输出形状（改形状必须同步改前端 + 改这里）
 *   ② 阻止「裸格式」继续增长（现有数量作为基线，只能减不能增）
 */
const { ok, fail, sendError, ErrorCodes } = require('../utils');

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
  return res;
}

describe('响应格式契约', () => {
  test('ok() 输出扁平 success:true + 字段平铺', () => {
    const res = mockRes();
    ok(res, { id: 1, name: 'x' });
    expect(res.body).toEqual({ success: true, id: 1, name: 'x' });
    expect(res.body).not.toHaveProperty('data');
  });

  test('ok() 无字段时只返回 success', () => {
    const res = mockRes();
    ok(res);
    expect(res.body).toEqual({ success: true });
  });

  test('fail() 的 error 是字符串（不是对象）', () => {
    const res = mockRes();
    fail(res, 400, '参数错误');
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ success: false, error: '参数错误' });
    expect(typeof res.body.error).toBe('string');
  });

  test('fail() 的附加字段平铺在顶层', () => {
    const res = mockRes();
    fail(res, 429, '太快了', { retryAfter: 5, code: 'RATE_LIMITED' });
    expect(res.body).toEqual({
      success: false, error: '太快了', retryAfter: 5, code: 'RATE_LIMITED'
    });
  });

  test('sendError() 的 error 是嵌套对象', () => {
    const res = mockRes();
    sendError(res, 404, ErrorCodes.NOT_FOUND, '不存在');
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      success: false, error: { code: ErrorCodes.NOT_FOUND, message: '不存在' }
    });
    expect(typeof res.body.error).toBe('object');
  });

  test('sendError() 带 detail 时嵌在 error 内', () => {
    const res = mockRes();
    sendError(res, 500, ErrorCodes.INTERNAL_ERROR, '内部错误', '补充说明');
    expect(res.body.error.detail).toBe('补充说明');
  });
});

describe('裸格式不得继续增长（技术债冻结）', () => {
  const fs = require('fs');
  const path = require('path');

  function countBare(dir) {
    let bareOk = 0, bareSuccess = 0;
    // 先剥离注释与字符串字面量，避免注释里提到格式示例被误统计
    const strip = (s) => s
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const walk = (d) => {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        const st = fs.statSync(p);
        if (st.isDirectory()) {
          if (f === 'node_modules' || f === '_archive' || f === '__tests__') continue;
          walk(p);
        } else if (f.endsWith('.js')) {
          const src = strip(fs.readFileSync(p, 'utf8'));
          bareOk += (src.match(/res\.json\s*\(\s*\{\s*ok\s*:/g) || []).length;
          bareSuccess += (src.match(/res\.json\s*\(\s*\{\s*success\s*:/g) || []).length;
        }
      }
    };
    walk(dir);
    return { bareOk, bareSuccess };
  }

  // 基线（2026-11-24 实测）。只允许下降，不允许上升。
  const BASELINE = { bareOk: 30, bareSuccess: 17 };

  test('裸 res.json({ok:...}) 数量不超过基线', () => {
    const { bareOk } = countBare(path.join(__dirname, '..'));
    expect(bareOk).toBeLessThanOrEqual(BASELINE.bareOk);
  });

  test('裸 res.json({success:...}) 数量不超过基线', () => {
    const { bareSuccess } = countBare(path.join(__dirname, '..'));
    expect(bareSuccess).toBeLessThanOrEqual(BASELINE.bareSuccess);
  });
});
