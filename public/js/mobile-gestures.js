/* ============================================================
 * mobile-gestures.js — G-13 移动端手势（Tab 左右横滑切换）
 * 仅在触屏 + 窄屏生效；不干扰横向可滚动容器（相册/表格/热力图等）。
 * 依赖：loader.js 暴露的 window.switchTab 与 TAB_MODULES 顺序
 * ============================================================ */
(function () {
  'use strict';
  if (window.__mobileGesturesInited) return;
  window.__mobileGesturesInited = true;

  // 与顶部导航一致的顺序（仅取主 Tab，排除 profile-user / admin 等非导航项）
  var TAB_ORDER = [
    'home', 'members', 'vrc', 'announcements', 'events',
    'album', 'map', 'chat', 'birthday', 'posts', 'friends', 'follows'
  ];

  var MIN_DX = 70;        // 最小水平位移（px）
  var MAX_DY = 60;        // 最大垂直偏移（px），超出视为滚动
  var MAX_MS = 700;       // 最长手势时长

  function isEnabled() {
    if (!window.matchMedia) return false;
    return window.matchMedia('(hover: none), (pointer: coarse)').matches
      && window.matchMedia('(max-width: 900px)').matches;
  }

  function currentTab() {
    var el = document.querySelector('.tab-content:not(.d-none)');
    if (!el || !el.id) return '';
    return el.id.replace(/^tab-/, '');
  }

  // 若起点位于可横向滚动容器内，则不劫持手势
  function inScrollableX(target) {
    var node = target;
    var depth = 0;
    while (node && node !== document.body && depth < 8) {
      var st = window.getComputedStyle(node);
      var ox = st.overflowX;
      if ((ox === 'auto' || ox === 'scroll') && node.scrollWidth > node.clientWidth + 4) return true;
      node = node.parentElement;
      depth++;
    }
    return false;
  }

  var sx = 0, sy = 0, st = 0, tracking = false;

  document.addEventListener('touchstart', function (e) {
    if (!isEnabled() || !e.touches || e.touches.length !== 1) { tracking = false; return; }
    var t = e.touches[0];
    if (inScrollableX(e.target)) { tracking = false; return; }
    sx = t.clientX; sy = t.clientY; st = Date.now(); tracking = true;
  }, { passive: true });

  document.addEventListener('touchend', function (e) {
    if (!tracking) return;
    tracking = false;
    if (!e.changedTouches || !e.changedTouches.length) return;
    var t = e.changedTouches[0];
    var dx = t.clientX - sx;
    var dy = t.clientY - sy;
    var dt = Date.now() - st;
    if (dt > MAX_MS) return;
    if (Math.abs(dx) < MIN_DX || Math.abs(dy) > MAX_DY) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.6) return; // 需要明显的横向意图

    var cur = currentTab();
    var idx = TAB_ORDER.indexOf(cur);
    if (idx === -1) return;
    // 左滑（dx<0）→ 下一个；右滑 → 上一个
    var next = dx < 0 ? idx + 1 : idx - 1;
    if (next < 0 || next >= TAB_ORDER.length) return;
    if (typeof window.switchTab === 'function') {
      window.switchTab(TAB_ORDER[next], true);
    }
  }, { passive: true });

  // 供调试/测试
  window.__mobileGestures = { isEnabled: isEnabled, currentTab: currentTab, TAB_ORDER: TAB_ORDER };
})();
