/**
 * 第 3 批 体验可恢复性 回归测试
 * UX-02/11/12/13 失败态 · UX-14 重试入口 · UX-03/06/18/19 写操作锁 · UX-20 确认框无障碍 · UX-21/25 移动端
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '../../public/js', p), 'utf8');
const readCss = (p) => fs.readFileSync(path.join(__dirname, '../../public/css', p), 'utf8');

const UI = read('ui.js');
const HOME = read('home.js');
const EVENTS = read('events.js');
const ALBUM = read('album.js');
const CORE = read('core.js');
const RTC = read('rtc.js');
const CHAT = read('chat.js');
const MEMBERS = read('members.js');
const PROFILE_PAGE = read('profile-page.js');
const GESTURES = read('mobile-gestures.js');
const CSS99 = readCss('99-design-system.css');

// ==================== UX-14 统一重试入口 ====================
describe('UX-14 统一加载失败+重试封装', () => {
  test('ui.js 提供 renderLoadFailed 并带重试按钮', () => {
    expect(UI).toMatch(/window\.renderLoadFailed\s*=\s*function/);
    const idx = UI.indexOf('window.renderLoadFailed');
    const block = UI.slice(idx, idx + 900);
    expect(block).toMatch(/label:.*retry|common\.retry/);
    expect(block).toMatch(/onClick:\s*retryFn/);
  });
});

// ==================== UX-02/11/12/13 失败态不再留骨架屏 ====================
describe('UX-02/11/12/13 失败态不留骨架屏', () => {
  test('UX-02 home.js 三处失败态都调 renderLoadFailed', () => {
    const count = (HOME.match(/renderLoadFailed/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(3);
    // 不应再有「isApiHandledError 时什么都不做」的裸分支（配合骨架屏即永久转圈）
    expect(HOME).not.toMatch(/if \(!isApiHandledError\(err\)\) \{\s*renderEmpty\(container, \{ icon: '⚠️', text: __\('load_failed'\) \}\);\s*\}/);
  });

  test('UX-11 ui.js 通知列表补 else 分支', () => {
    // res.ok 之后必须有 else 处理非 2xx
    const idx = UI.indexOf("const res = await api('/api/notifications?'");
    expect(idx).toBeGreaterThan(-1);
    const block = UI.slice(idx, idx + 6000);
    expect(block).toMatch(/\}\s*else\s*\{/);
    expect(block).toMatch(/renderLoadFailed|ui\.load_failed/);
  });

  test('UX-12 events.js 补 else 且 catch 不留骨架屏', () => {
    const idx = EVENTS.indexOf('async function loadEvents');
    const block = EVENTS.slice(idx, idx + 1800);
    expect(block).toMatch(/renderLoadFailed/);
    // catch 里不再提前 return（那会跳过渲染）
    expect(block).not.toMatch(/catch \(err\) \{\s*if \(isApiHandledError\(err\)\) return;/);
  });

  test('UX-13 album.js 首屏失败给失败态', () => {
    const idx = ALBUM.indexOf('async function loadAlbum');
    const block = ALBUM.slice(idx, idx + 1900);
    expect(block).toMatch(/renderLoadFailed/);
    expect(block).toMatch(/albumPage === 1/);
  });
});

// ==================== UX-03/06/18/19 写操作锁 ====================
describe('UX-03 发起通话防连点', () => {
  test('startPrivateCall 有同步占位锁', () => {
    expect(RTC).toMatch(/_rtcStartingCall/);
    const idx = RTC.indexOf('async function startPrivateCall');
    const block = RTC.slice(idx, idx + 900);
    expect(block).toMatch(/if \(_rtcStartingCall\)/);
    expect(block).toMatch(/_rtcStartingCall = true/);
    expect(block).toMatch(/finally/);
  });
});

describe('UX-06 聊天发送失败回填', () => {
  test('记录待发内容并在 chat:error 回填', () => {
    expect(CHAT).toMatch(/_pendingChatText/);
    const errIdx = CHAT.indexOf("if (msg.type === 'chat:error')");
    expect(errIdx).toBeGreaterThan(-1);
    const block = CHAT.slice(errIdx, errIdx + 700);
    expect(block).toMatch(/_pendingChatText/);
    expect(block).toMatch(/input\.value = _pendingChatText/);
  });

  test('发送成功时清空待回填，避免误回填旧文本', () => {
    const okIdx = CHAT.indexOf("if (msg.type === 'chat:sent')");
    const block = CHAT.slice(okIdx, okIdx + 300);
    expect(block).toMatch(/_pendingChatText = ''/);
  });
});

describe('UX-18 点赞按钮防连点 + 失败提示', () => {
  test('点击即 disable，finally 恢复，并补 else 提示', () => {
    const idx = PROFILE_PAGE.indexOf('async function');
    // 找点赞函数体
    const likeIdx = PROFILE_PAGE.indexOf("_profileLikedToday");
    expect(likeIdx).toBeGreaterThan(-1);
    const block = PROFILE_PAGE.slice(likeIdx, likeIdx + 6000);
    expect(block).toMatch(/likeBtn\.disabled = true/);
    expect(block).toMatch(/finally/);
    expect(block).toMatch(/likeBtn\.disabled = false/);
  });
});

describe('UX-19 备注/举报防重复提交', () => {
  test('保存备注按钮 disable + finally 恢复', () => {
    const idx = MEMBERS.indexOf('async function saveMemberNote');
    const block = MEMBERS.slice(idx, idx + 1600);
    expect(block).toMatch(/saveBtn\.disabled = true/);
    expect(block).toMatch(/finally/);
    expect(block).toMatch(/saveBtn\.disabled = false/);
  });

  test('提交举报按钮 disable + finally 恢复', () => {
    const idx = MEMBERS.indexOf('async function submitUserReport');
    const block = MEMBERS.slice(idx, idx + 1800);
    expect(block).toMatch(/reportBtn\.disabled = true/);
    expect(block).toMatch(/reportBtn\.disabled = false/);
  });
});

// ==================== UX-20 确认框无障碍 ====================
describe('UX-20 confirm-overlay 无障碍', () => {
  test('设置 role=dialog / aria-modal', () => {
    const idx = CORE.indexOf('function createOverlayDialog');
    const block = CORE.slice(idx, idx + 5200);
    expect(block).toMatch(/setAttribute\('role', 'dialog'\)/);
    expect(block).toMatch(/setAttribute\('aria-modal', 'true'\)/);
  });

  test('Esc 关闭', () => {
    const idx = CORE.indexOf('function createOverlayDialog');
    const block = CORE.slice(idx, idx + 5200);
    expect(block).toMatch(/e\.key === 'Escape'/);
  });

  test('Tab 焦点陷阱（首尾循环）', () => {
    const idx = CORE.indexOf('function createOverlayDialog');
    const block = CORE.slice(idx, idx + 5200);
    expect(block).toMatch(/e\.key !== 'Tab'/);
    expect(block).toMatch(/e\.shiftKey/);
    expect(block).toMatch(/first\.focus\(\)/);
    expect(block).toMatch(/last\.focus\(\)/);
  });

  test('打开移入焦点 + 关闭归还焦点', () => {
    const idx = CORE.indexOf('function createOverlayDialog');
    const block = CORE.slice(idx, idx + 5200);
    expect(block).toMatch(/_prevFocus/);
    expect(block).toMatch(/target\.focus\(\)|overlay\.focus\(\)/);
    expect(block).toMatch(/_prevFocus\.focus/);
  });
});

// ==================== UX-21/25 移动端 ====================
describe('UX-21 移动端触控目标 44px', () => {
  test('max-width:768px 块内 .btn-xs 不得小于 44px', () => {
    // 取移动端媒体块
    const mediaIdx = CSS99.indexOf('@media (max-width: 768px)');
    expect(mediaIdx).toBeGreaterThan(-1);
    const block = CSS99.slice(mediaIdx);
    const m = block.match(/\.btn-xs\s*\{\s*min-height:\s*(\d+)px/);
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBeGreaterThanOrEqual(44);
  });
});

describe('UX-25 横滑不穿透覆盖层', () => {
  test('touchend 切换前检查覆盖层', () => {
    expect(GESTURES).toMatch(/lightbox/);
    expect(GESTURES).toMatch(/confirm-overlay/);
    expect(GESTURES).toMatch(/media-viewer-overlay/);
    // 检查必须发生在 switchTab 之前
    const guardIdx = GESTURES.indexOf('.confirm-overlay');
    const switchIdx = GESTURES.indexOf("window.switchTab(TAB_ORDER[next]");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(switchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(switchIdx);
  });
});