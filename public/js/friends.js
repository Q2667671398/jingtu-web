// ==================== 好友系统（成员端） ====================
// 对应后端 server/routes/friends.js（契约见后端 friends.js 内联注释）。
// 通过 GET/POST/DELETE /api/friends/* 驱动；目标用户通过 GET /api/users/search 发现。
(function () {
  'use strict';

  async function req(method, path, body) {
    const opts = { method };
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const res = await api(path, opts);
    const d = await res.json().catch(() => ({}));
    return { res, d };
  }

  function avatar(u) {
    return (u && (u.avatarUrl || u.vrchat_avatar_url)) || '/api/avatar/default';
  }
  function name(u) {
    return (u && (u.displayName || u.display_name)) || __('nav.members') || __('common.user');
  }

  function userRowHtml(u, actionsHtml) {
    return `
      <div class="social-row">
        <img class="social-avatar" src="${escAttr(avatar(u))}" alt="${escAttr(name(u))}" data-avatar-fail-src="${escAttr(avatar(u))}" loading="lazy">
        <div class="social-meta">
          <div class="social-name">${esc(name(u))}</div>
          ${u && u.vrchatName ? `<div class="social-sub text-13 text-muted2">${esc(u.vrchatName)}</div>` : ''}
        </div>
        <div class="social-actions">${actionsHtml}</div>
      </div>`;
  }

  function btn(action, id, label, cls) {
    return `<button class="btn btn-sm ${cls || 'btn-outline'}" data-action="${action}" data-id="${id}">${esc(label)}</button>`;
  }
  // F-11 共同好友徽章（点击展开共同好友列表）
  function mutualBadge(id, n) {
    const label = (__('friends.mutual_badge') || __('auto_friends_1')) + ' ' + n;
    return `<button class="btn btn-sm btn-ghost mutual-badge" data-action="mutual" data-id="${id}" title="${esc(label)}">${esc(label)}</button>`;
  }
  // F-11 衍生：共同好友最多 Top5（纯前端只读聚合，零后端/零写入，复用 counts）
  function mutualTopHtml(counts, byId) {
    const entries = Object.keys(counts || {})
      .map(id => ({ id: parseInt(id, 10), count: counts[id] }))
      .filter(x => x.count > 0 && byId[x.id])
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    if (!entries.length) return '';
    const title = __('friends.mutual_top_title') || __('auto_friends_2');
    return `
      <div class="mutual-top" style="margin:0 0 12px;padding:12px;background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-radius:12px;">
        <div style="font-weight:600;margin-bottom:8px;font-size:13px;">${esc(title)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${entries.map(e => {
            const u = byId[e.id];
            const nm = name(u);
            return `<button class="mutual-top-item" data-action="mutual" data-id="${e.id}" title="${esc(nm + ' · ' + e.count)}" style="display:flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid var(--border,#e5e7eb);border-radius:999px;background:transparent;cursor:pointer;">
              <img class="mutual-item-avatar" src="${escAttr(avatar(u))}" alt="${escAttr(nm)}" style="width:26px;height:26px;border-radius:50%;object-fit:cover;" data-avatar-fail-src="${escAttr(avatar(u))}" loading="lazy">
              <span style="font-size:12px;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(nm)}</span>
              <span style="font-size:11px;color:var(--muted,#888);">${e.count}</span>
            </button>`;
          }).join('')}
        </div>
      </div>`;
  }

  // ==================== 渲染入口 ====================
  function showFriends() {
    const root = document.getElementById('tab-friends');
    if (!root) return;
    root.innerHTML = `
      <div class="social-wrap">
        <div class="social-back-row">
          <button type="button" class="btn btn-sm btn-outline" data-action="back-to-chat">← ${__('nav.chat')}</button>
        </div>
        <h2 class="section-title">${__('friends.title')}</h2>
        <div class="social-search">
          <input id="friendSearch" class="form-control" type="text" placeholder="${escAttr(__('friends.search_placeholder'))}" autocomplete="off">
          <div id="friendSearchResults" class="social-search-results"></div>
        </div>
        <div class="social-section">
          <h3 class="social-h3">${__('friends.friend_requests')}</h3>
          <div id="friendRequests"></div>
        </div>
        <div class="social-section">
          <h3 class="social-h3">${__('friends.my_friends')}</h3>
          <div class="friend-toolbar" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
            <select id="friendSort" class="form-input" style="max-width:150px" aria-label="${escAttr(__('friends.sort_label'))}">
              <option value="recent">${__('friends.sort_recent')}</option>
              <option value="name">${__('friends.sort_name')}</option>
              <option value="since">${__('friends.sort_since')}</option>
            </select>
            <select id="friendOnline" class="form-input" style="max-width:130px" aria-label="${escAttr(__('friends.online_label'))}">
              <option value="">${__('friends.online_all')}</option>
              <option value="online">${__('friends.online_only')}</option>
              <option value="offline">${__('friends.offline_only')}</option>
            </select>
            <input id="friendFilterQ" class="form-input" type="text" style="max-width:180px" placeholder="${escAttr(__('friends.filter_placeholder'))}" autocomplete="off">
          </div>
          <div id="friendList"></div>
          <div id="friendListPager" class="flex-row gap-8 align-center mt-8" style="display:none">
            <button type="button" class="btn btn-sm btn-outline" id="friendPrev">${__('friends.prev_page')}</button>
            <span id="friendPageInfo" class="text-12 text-muted2"></span>
            <button type="button" class="btn btn-sm btn-outline" id="friendNext">${__('friends.next_page')}</button>
          </div>
        </div>
        <div class="social-section">
          <h3 class="social-h3">${__('friends.feed_title')}</h3>
          <div id="friendFeed"></div>
        </div>
        <div class="social-section">
          <h3 class="social-h3">🏆 <span data-i18n="friends.world_ranking">群组世界热度</span></h3>
          <div id="friendWorldRanking"><p class="text-muted2 text-13">${__('common.loading')}</p></div>
        </div>
        <div class="social-section">
          <h3 class="social-h3">⏱️ <span data-i18n="friends.activity_ranking">好友活跃榜（近 30 天）</span></h3>
          <div id="friendActivityRanking"><p class="text-muted2 text-13">${__('common.loading')}</p></div>
        </div>
        <div class="social-section">
          <h3 class="social-h3">🎊 <span data-i18n="friends.rewind">年度回顾</span></h3>
          <div id="friendRewind"><p class="text-muted2 text-13">${__('common.loading')}</p></div>
        </div>
        <div class="social-section">
          <h3 class="social-h3">${__('friends.blocked_list')}</h3>
          <div id="friendBlocked"></div>
        </div>
      </div>`;
    bindFriendsEvents();
    bindFriendListControls();
    loadRequests();
    loadFriends();
    loadFeed();
    loadBlocked();
    loadWorldRanking();
    loadActivityRanking();
    loadRewind();
  }

  // G-11 年度回顾（我的）
  async function loadRewind() {
    const el = document.getElementById('friendRewind');
    if (!el) return;
    try {
      const year = new Date().getFullYear();
      const res = await api('/api/friends/rewind?year=' + year, { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { el.innerHTML = `<div class="text-muted2 text-13">${esc(errText(d))}</div>`; return; }
      if (!d.hasData) {
        el.innerHTML = `<div class="text-muted2 text-13">${esc((__('friends.rewind_empty') || '{y} 年暂无数据').replace('{y}', d.year || year))}</div>`;
        return;
      }
      const stat = (label, value) => `
        <div style="flex:1 1 120px;min-width:110px;background:var(--bg-secondary,rgba(124,92,252,.06));border-radius:10px;padding:10px 12px">
          <div class="text-12 text-muted2">${esc(label)}</div>
          <div style="font-size:20px;font-weight:700;color:var(--accent,#7c5cfc);line-height:1.3">${esc(value)}</div>
        </div>`;
      const topWorlds = (d.topWorlds || []).map((w, i) => `
        <div style="display:flex;gap:8px;align-items:center;padding:6px 0">
          <span class="text-12" style="flex:0 0 18px;color:var(--accent,#7c5cfc);font-weight:700">#${i + 1}</span>
          ${w.imageUrl ? `<img src="${escAttr(w.imageUrl)}" alt="" loading="lazy" style="width:32px;height:32px;border-radius:6px;object-fit:cover">` : ''}
          <span class="text-13" style="flex:1;min-width:0;word-break:break-all">${esc(w.worldName)}</span>
          <span class="text-12 text-muted2">${esc((__('friends.rewind_visits') || '{n} 次').replace('{n}', w.visits))}</span>
        </div>`).join('');
      const longest = d.longestSession
        ? `<div class="text-12 text-muted2" style="margin-top:6px">${esc((__('friends.rewind_longest') || '最长一次：{m} 分钟 · {w}')
            .replace('{m}', d.longestSession.minutes).replace('{w}', d.longestSession.worldName || '—'))}</div>`
        : '';
      el.innerHTML = `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
          ${stat(__('friends.rewind_hours'), (d.totalHours || 0) + ' h')}
          ${stat(__('friends.rewind_sessions'), d.sessionCount || 0)}
          ${stat(__('friends.rewind_days'), d.activeDays || 0)}
          ${stat(__('friends.rewind_worlds'), d.worldCount || 0)}
        </div>
        ${longest}
        ${topWorlds ? `<div class="text-12 text-muted2" style="margin:10px 0 4px">${esc(__('friends.rewind_top_worlds'))}</div>${topWorlds}` : ''}`;
    } catch (e) {
      if (!isApiHandledError(e)) el.innerHTML = `<div class="text-muted2 text-13">${esc(e.message)}</div>`;
    }
  }

  // G-02 好友活跃度榜（近 N 天在线时长）
  async function loadActivityRanking() {
    const el = document.getElementById('friendActivityRanking');
    if (!el) return;
    try {
      const res = await api('/api/friends/activity-ranking?days=30&top=10', { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { el.innerHTML = `<div class="text-muted2 text-13">${esc(errText(d))}</div>`; return; }
      const items = d.items || [];
      if (!items.length) { el.innerHTML = `<div class="text-muted2 text-13">${esc(__('friends.activity_ranking_empty'))}</div>`; return; }
      el.innerHTML = items.map(it => {
        const h = Math.floor(it.totalMinutes / 60);
        const m = it.totalMinutes % 60;
        const dur = h > 0 ? `${h}h ${m}m` : `${m}m`;
        return `
        <div class="world-rank-item" data-action="member-open" data-id="${it.userId}" style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border,#e5e7eb);cursor:pointer">
          <span class="text-13" style="flex:0 0 24px;font-weight:700;color:var(--accent,#7c5cfc)">#${it.rank}</span>
          <img src="${escAttr(it.avatarUrl)}" alt="" loading="lazy" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex:0 0 auto">
          <div style="flex:1;min-width:0">
            <div class="text-13" style="font-weight:600;word-break:break-all">${esc(it.displayName)}</div>
            <div class="text-12 text-muted2">${esc((__('friends.activity_rank_detail') || '{t} · {n} 次会话').replace('{t}', dur).replace('{n}', it.sessionCount))}</div>
          </div>
        </div>`;
      }).join('');
    } catch (e) {
      if (!isApiHandledError(e)) el.innerHTML = `<div class="text-muted2 text-13">${esc(e.message)}</div>`;
    }
  }

  // G-01 群组世界热度排行
  async function loadWorldRanking() {
    const el = document.getElementById('friendWorldRanking');
    if (!el) return;
    try {
      const res = await api('/api/friends/world-ranking?top=10', { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { el.innerHTML = `<div class="text-muted2 text-13">${esc(errText(d))}</div>`; return; }
      const items = d.items || [];
      if (!items.length) { el.innerHTML = `<div class="text-muted2 text-13">${esc(__('friends.world_ranking_empty'))}</div>`; return; }
      el.innerHTML = items.map(it => `
        <div class="world-rank-item" data-action="world-rank-open" data-world-id="${escAttr(it.worldId)}" style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border,#e5e7eb);cursor:pointer">
          <span class="text-13" style="flex:0 0 24px;font-weight:700;color:var(--accent,#7c5cfc)">#${it.rank}</span>
          ${it.imageUrl ? `<img src="${escAttr(it.imageUrl)}" alt="" loading="lazy" style="width:40px;height:40px;border-radius:8px;object-fit:cover;flex:0 0 auto">` : ''}
          <div style="flex:1;min-width:0">
            <div class="text-13" style="font-weight:600;word-break:break-all">${esc(it.worldName)}</div>
            <div class="text-12 text-muted2">${esc((__('friends.world_rank_visits') || '访问 {v} 次 · {u} 人去过').replace('{v}', it.totalVisits).replace('{u}', it.visitorCount))}</div>
          </div>
        </div>`).join('');
    } catch (e) {
      if (!isApiHandledError(e)) el.innerHTML = `<div class="text-muted2 text-13">${esc(e.message)}</div>`;
    }
  }

  // ==================== 数据加载 ====================
  async function loadRequests() {
    const el = document.getElementById('friendRequests');
    if (!el) return;
    try {
      const res = await api('/api/friends/requests', { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { el.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      const incoming = (d.incoming || []);
      const outgoing = (d.outgoing || []);
      if (!incoming.length && !outgoing.length) {
        el.innerHTML = `<div class="text-muted2 p-16">${esc(__('friends.no_requests'))}</div>`;
        return;
      }
      let html = '';
      if (incoming.length) {
        html += `<div class="social-sublabel">${esc(__('friends.incoming'))}</div>`;
        html += incoming.map(r => userRowHtml(r,
          btn('accept', r.requestId, __('friends.accept'), 'btn-accent') +
          btn('reject', r.requestId, __('friends.reject'), 'btn-danger')
        )).join('');
      }
      if (outgoing.length) {
        html += `<div class="social-sublabel">${esc(__('friends.outgoing'))}</div>`;
        html += outgoing.map(r => userRowHtml(r,
          btn('cancel', r.id, __('friends.cancel_request'))
        )).join('');
      }
      el.innerHTML = html;
    } catch (e) {
      if (isApiHandledError(e)) return;
      el.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  // G-08 好友列表状态（排序/在线筛选/搜索/分页）
  const _friendListState = { page: 1, pageSize: 50, sort: 'recent', online: '', q: '', totalPages: 1 };

  async function loadFriends(page) {
    const el = document.getElementById('friendList');
    if (!el) return;
    if (page) _friendListState.page = page;
    try {
      const qs = new URLSearchParams({
        status: 'accepted',
        sort: _friendListState.sort,
        page: String(_friendListState.page),
        pageSize: String(_friendListState.pageSize)
      });
      if (_friendListState.online) qs.set('online', _friendListState.online);
      if (_friendListState.q) qs.set('q', _friendListState.q);
      const [fRes, mRes] = await Promise.all([
        api('/api/friends?' + qs.toString(), { method: 'GET' }),
        api('/api/friends/mutuals', { method: 'GET' })
      ]);
      const d = await fRes.json().catch(() => ({}));
      if (!fRes.ok) { el.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      const list = (d.list || []);
      _friendListState.totalPages = d.totalPages || 1;
      const md = await mRes.json().catch(() => ({}));
      const counts = (md && md.counts) || {};
      if (!list.length) {
        el.innerHTML = `<div class="text-muted2 p-16">${esc(__('friends.no_friends'))}</div>`;
        renderFriendPager();
        return;
      }
      const byId = {};
      list.forEach(u => { byId[u.id] = u; });
      el.innerHTML = mutualTopHtml(counts, byId) + list.map(r => {
        const onlineDot = r.isOnline
          ? `<span class="friend-online-dot" title="${escAttr(__('friends.online_only'))}" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:6px;vertical-align:middle"></span>`
          : '';
        return userRowHtml(r,
          mutualBadge(r.id, counts[r.id] || 0) +
          btn('history', r.id, __('friends.history'), 'btn-ghost') +
          btn('worldhist', r.id, __('friends.world_history'), 'btn-ghost') +
          btn('timeline', r.id, __('friends.activity_timeline'), 'btn-ghost') +
          btn('milestones', r.id, __('friends.milestones'), 'btn-ghost') +
        btn('commonworlds', r.id, __('friends.common_worlds'), 'btn-ghost') +
          btn('message', r.id, __('chat.dm'), 'btn-outline') +
          btn('block', r.id, __('friends.block'), 'btn-outline') +
          btn('remove', r.id, __('friends.remove'), 'btn-danger')
        ).replace(/^(\s*<[^>]*class="[^"]*user-row[^"]*"[^>]*>)/, `$1${onlineDot}`);
      }).join('');
      renderFriendPager();
    } catch (e) {
      if (isApiHandledError(e)) return;
      el.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  function renderFriendPager() {
    const pager = document.getElementById('friendListPager');
    const info = document.getElementById('friendPageInfo');
    const prev = document.getElementById('friendPrev');
    const next = document.getElementById('friendNext');
    if (!pager) return;
    const tp = _friendListState.totalPages || 1;
    pager.style.display = tp > 1 ? '' : 'none';
    if (info) info.textContent = `${_friendListState.page} / ${tp}`;
    if (prev) prev.disabled = _friendListState.page <= 1;
    if (next) next.disabled = _friendListState.page >= tp;
  }

  function bindFriendListControls() {
    const sortEl = document.getElementById('friendSort');
    if (sortEl && !sortEl.dataset.bound) {
      sortEl.dataset.bound = '1';
      sortEl.addEventListener('change', () => { _friendListState.sort = sortEl.value; loadFriends(1); });
    }
    const onEl = document.getElementById('friendOnline');
    if (onEl && !onEl.dataset.bound) {
      onEl.dataset.bound = '1';
      onEl.addEventListener('change', () => { _friendListState.online = onEl.value; loadFriends(1); });
    }
    const qEl = document.getElementById('friendFilterQ');
    if (qEl && !qEl.dataset.bound) {
      qEl.dataset.bound = '1';
      let timer = null;
      qEl.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { _friendListState.q = qEl.value.trim(); loadFriends(1); }, 300);
      });
    }
    const prev = document.getElementById('friendPrev');
    if (prev && !prev.dataset.bound) { prev.dataset.bound = '1'; prev.addEventListener('click', () => loadFriends(_friendListState.page - 1)); }
    const next = document.getElementById('friendNext');
    if (next && !next.dataset.bound) { next.dataset.bound = '1'; next.addEventListener('click', () => loadFriends(_friendListState.page + 1)); }
  }

  async function loadBlocked() {
    const el = document.getElementById('friendBlocked');
    if (!el) return;
    try {
      const res = await api('/api/friends?status=blocked', { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { el.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      const list = (d.list || []);
      if (!list.length) { el.innerHTML = `<div class="text-muted2 p-16">${esc(__('friends.no_friends'))}</div>`; return; }
      el.innerHTML = list.map(r => userRowHtml(r,
        btn('unblock', r.id, __('friends.unblock'), 'btn-accent')
      )).join('');
    } catch (e) {
      if (isApiHandledError(e)) return;
      el.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  async function loadSearch(q) {
    const el = document.getElementById('friendSearchResults');
    if (!el) return;
    if (!q || q.trim().length < 2) { el.innerHTML = ''; return; }
    try {
      const res = await api('/api/users/search?q=' + encodeURIComponent(q.trim()), { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { el.innerHTML = `<div class="text-muted2 p-8">${esc(errText(d))}</div>`; return; }
      const users = d.users || [];
      if (!users.length) { el.innerHTML = `<div class="text-muted2 p-8">${esc(__('friends.no_friends'))}</div>`; return; }
      el.innerHTML = users.map(u => userRowHtml(u,
        btn('add', u.id, __('friends.send_request'), 'btn-accent')
      )).join('');
    } catch (e) {
      if (isApiHandledError(e)) return;
      el.innerHTML = `<div class="text-muted2 p-8">${esc(e.message)}</div>`;
    }
  }

  // ==================== F-12 好友动态 Feed ====================
  let _feedPage = 1;
  let _feedDone = false;

  function fmtTime(t) {
    if (!t) return '';
    const d = new Date(t);
    if (isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtDate(t) {
    if (!t) return '';
    const d = new Date(t);
    if (isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function feedItemHtml(it) {
    const nm = esc(it.userName || '');
    const time = esc(fmtTime(it.time));
    const av = escAttr(it.avatarUrl || '/api/avatar/default');
    let body = '';
    if (it.kind === 'post') {
      const verb = __('friends.feed_post');
      body = `<div class="text-13" style="margin:4px 0 0;color:var(--text,#333);">${esc(it.content || '')}</div>`;
      body += `<div class="text-12" style="margin-top:4px;color:var(--muted,#999);">❤ ${it.likeCount || 0} · 💬 ${it.commentCount || 0}</div>`;
    } else if (it.kind === 'event_sign') {
      const verb = __('friends.feed_sign');
      body = `<div class="text-13" style="margin:4px 0 0;color:var(--text,#333);">${esc(it.eventTitle || '')}</div>`;
    } else if (it.kind === 'photo') {
      const verb = __('friends.feed_photo');
      body = `<img src="${escAttr(it.thumbPath || it.photoPath)}" alt="" loading="lazy" data-img-fallback="1" style="margin-top:6px;max-width:100%;border-radius:8px;max-height:220px;object-fit:cover;">`;
      if (it.desc) body += `<div class="text-13" style="margin:4px 0 0;color:var(--text,#333);">${esc(it.desc)}</div>`;
    } else {
      return '';
    }
    return `
      <div class="social-row feed-item" style="align-items:flex-start;">
        <img class="social-avatar" src="${av}" alt="${nm}" data-avatar-fail-src="${escAttr(it.avatarUrl || '/api/avatar/default')}" loading="lazy">
        <div class="social-meta" style="flex:1;">
          <div class="social-name">${nm} <span class="text-12 text-muted2">${esc(__('friends.feed_' + (it.kind === 'post' ? 'post' : it.kind === 'event_sign' ? 'sign' : 'photo')))}</span></div>
          <div class="text-12 text-muted2">${time}</div>
          ${body}
        </div>
      </div>`;
  }

  async function loadFeed(reset) {
    const el = document.getElementById('friendFeed');
    if (!el) return;
    if (reset) { _feedPage = 1; _feedDone = false; }
    try {
      const res = await api(`/api/friends/feed?page=${_feedPage}&pageSize=15`, { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { if (reset) el.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      const items = d.items || [];
      if (reset && !items.length) {
        el.innerHTML = `<div class="text-muted2 p-16">${esc(__('friends.feed_empty'))}</div>`;
        _feedDone = true;
        return;
      }
      let html = (reset ? '' : el.innerHTML.replace(/<button[^>]*data-feed-more[\s\S]*$/, ''));
      html += items.map(feedItemHtml).join('');
      // “加载更多”按钮：本页仍有下一页数据时展示
      if (items.length >= 15 && !_feedDone) {
        html += `<div class="text-center p-8"><button class="btn btn-sm btn-outline" data-feed-more>${esc(__('friends.feed_load_more'))}</button></div>`;
      } else {
        _feedDone = true;
      }
      el.innerHTML = html;
      _feedPage += 1;
    } catch (e) {
      if (isApiHandledError(e)) return;
      if (reset) el.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  // ==================== F-11 共同好友弹窗 ====================
  let _mutualModalReady = false;
  function ensureMutualModal() {
    if (_mutualModalReady && document.getElementById('mutualFriendsModal')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'mutualFriendsModal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="mutualFriendsTitle" class="modal-title"></h3>
          <button class="modal-close" data-modal-close="mutualFriendsModal" aria-label="close">&times;</button>
        </div>
        <div class="modal-body" id="mutualFriendsBody"></div>
      </div>`;
    document.body.appendChild(el);
    _mutualModalReady = true;
  }

  async function showMutualFriends(id) {
    ensureMutualModal();
    const title = document.getElementById('mutualFriendsTitle');
    const body = document.getElementById('mutualFriendsBody');
    if (title) title.textContent = __('friends.mutual_title') || __('auto_friends_4');
    if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(__('common.loading') || __('auto_friends_5'))}</div>`;
    showModal('mutualFriendsModal');
    try {
      const res = await api('/api/friends/mutuals/' + id, { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      const list = d.mutualFriends || [];
      if (title) title.textContent = (__('friends.mutual_title') || __('auto_friends_6')) + '（' + (d.count || 0) + '）';
      if (body) body.innerHTML = list.length
        ? list.map(u => userRowHtml(u, btn('message', u.id, __('chat.dm'), 'btn-outline'))).join('')
        : `<div class="text-muted2 p-16">${esc(__('friends.no_mutual') || __('auto_friends_7'))}</div>`;
    } catch (e) {
      if (isApiHandledError(e)) return;
      if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  // ==================== F-13 好友变更历史 ====================
  let _histModalReady = false;
  function ensureHistModal() {
    if (_histModalReady && document.getElementById('friendHistModal')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'friendHistModal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="friendHistTitle" class="modal-title"></h3>
          <button class="modal-close" data-modal-close="friendHistModal" aria-label="close">&times;</button>
        </div>
        <div class="modal-body" id="friendHistBody"></div>
      </div>`;
    document.body.appendChild(el);
    _histModalReady = true;
  }

  // change_type → 本地化文案映射（后端返回 name|avatar|online|offline|status|world）
  function histTypeLabel(t) {
    const map = {
      name: 'friends.hist_name',
      avatar: 'friends.hist_avatar',
      online: 'friends.hist_online',
      offline: 'friends.hist_offline',
      status: 'friends.hist_status',
      world: 'friends.hist_world'
    };
    const key = map[t] || 'friends.hist_unknown';
    return __(key);
  }

  async function showFriendHistory(id) {
    ensureHistModal();
    const title = document.getElementById('friendHistTitle');
    const body = document.getElementById('friendHistBody');
    if (title) title.textContent = __('friends.hist_title');
    if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(__('common.loading') || '加载中...')}</div>`;
    showModal('friendHistModal');
    try {
      const res = await api('/api/friends/history/' + id, { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      const items = d.items || [];
      if (!items.length) {
        if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(__('friends.hist_empty'))}</div>`;
        return;
      }
      if (body) body.innerHTML = `
        <div class="flex-row gap-8 align-center" style="margin-bottom:8px">
          <button type="button" class="btn btn-sm btn-outline" id="friendHistExport" style="margin-left:auto">${esc(__('friends.export_csv') || '导出 CSV')}</button>
        </div>` + items.map(r => {
        const t = fmtTime(r.time);
        return `
          <div class="hist-item" style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border,#e5e7eb);">
            <div style="flex-shrink:0;width:auto;min-width:72px;font-size:12px;color:var(--muted,#888);padding-top:2px;">${esc(t)}</div>
            <div style="flex:1;min-width:0;">
              <div class="text-13" style="font-weight:600;">${esc(histTypeLabel(r.type))}</div>
              <div class="text-13 text-muted2" style="word-break:break-all;">
                ${esc(r.oldValue || '—')} → ${esc(r.newValue || '—')}
              </div>
            </div>
          </div>`;
      }).join('');
      const expBtn = document.getElementById('friendHistExport');
      if (expBtn) expBtn.addEventListener('click', () => exportFriendsCsv('history', id));
    } catch (e) {
      if (isApiHandledError(e)) return;
      if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  // ==================== F-14 世界访问足迹 ====================
  let _worldHistModalReady = false;
  function ensureWorldHistModal() {
    if (_worldHistModalReady && document.getElementById('friendWorldHistModal')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'friendWorldHistModal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="friendWorldHistTitle" class="modal-title"></h3>
          <button class="modal-close" data-modal-close="friendWorldHistModal" aria-label="close">&times;</button>
        </div>
        <div class="modal-body" id="friendWorldHistBody"></div>
      </div>`;
    document.body.appendChild(el);
    _worldHistModalReady = true;
  }

  async function showFriendWorldHistory(id) {
    ensureWorldHistModal();
    const title = document.getElementById('friendWorldHistTitle');
    const body = document.getElementById('friendWorldHistBody');
    if (title) title.textContent = __('friends.world_hist_title');
    if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(__('common.loading') || '加载中...')}</div>`;
    showModal('friendWorldHistModal');
    try {
      const res = await api('/api/friends/world-history/' + id, { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      const items = (d.items || []);
      if (!items.length) {
        if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(__('friends.world_hist_empty'))}</div>`;
        return;
      }
      // 汇总行：共 X 个世界 · Y 次访问
      const summary = (__('friends.world_hist_summary') || '{worlds} 个世界 · {visits} 次访问')
        .replace('{worlds}', d.totalWorlds || items.length)
        .replace('{visits}', d.totalVisits || 0);
      // G-06：排序切换（前端排序，避免额外请求）
      const renderWorldHist = (sortBy) => {
        const sorted = items.slice().sort((a, b) => {
          if (sortBy === 'visits') return (b.visitCount || 0) - (a.visitCount || 0);
          if (sortBy === 'first') return new Date(a.firstVisitAt || 0) - new Date(b.firstVisitAt || 0);
          return new Date(b.lastVisitAt || 0) - new Date(a.lastVisitAt || 0); // recent 默认
        });
        const rows = sorted.map(r => {
          const name = r.worldName || r.worldId || '—';
          const showId = name !== r.worldId;
          return `
            <div class="hist-item" style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border,#e5e7eb);align-items:center;">
              <div style="flex:1;min-width:0;">
                <div class="text-13" style="font-weight:600;word-break:break-all;">${esc(name)}</div>
                <div class="text-12 text-muted2" style="word-break:break-all;">
                  ${showId ? esc(r.worldId) + ' · ' : ''}${r.visitCount}${esc(__('friends.world_hist_visits'))}
                </div>
                <div class="text-12 text-muted2" style="margin-top:2px;">
                  ${esc(__('friends.world_hist_first'))}: ${esc(fmtTime(r.firstVisitAt))} · ${esc(__('friends.world_hist_last'))}: ${esc(fmtTime(r.lastVisitAt))}
                </div>
              </div>
            </div>`;
        }).join('');
        const listEl = document.getElementById('worldHistList');
        if (listEl) listEl.innerHTML = rows;
      };
      if (body) body.innerHTML = `
        <div class="flex-row gap-8 align-center" style="margin-bottom:10px;flex-wrap:wrap">
          <span class="text-13 text-muted2">${esc(summary)}</span>
          <select id="worldHistSort" class="form-input" style="max-width:150px;margin-left:auto" aria-label="${escAttr(__('friends.sort_label'))}">
            <option value="recent">${esc(__('friends.world_sort_recent'))}</option>
            <option value="visits">${esc(__('friends.world_sort_visits'))}</option>
            <option value="first">${esc(__('friends.world_sort_first'))}</option>
          </select>
          <button type="button" class="btn btn-sm btn-outline" id="worldHistExport">${esc(__('friends.export_csv') || '导出 CSV')}</button>
        </div>
        <div id="worldHistList"></div>`;
      renderWorldHist('recent');
      const sortEl = document.getElementById('worldHistSort');
      if (sortEl) sortEl.addEventListener('change', () => renderWorldHist(sortEl.value));
      const expBtn = document.getElementById('worldHistExport');
      if (expBtn) expBtn.addEventListener('click', () => exportFriendsCsv('worlds', id));
    } catch (e) {
      if (isApiHandledError(e)) return;
      if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  // G-12 历史流水 CSV 导出
  async function exportFriendsCsv(type, userId) {
    try {
      const q = `?type=${encodeURIComponent(type)}` + (userId ? `&userId=${userId}` : '');
      const res = await api('/api/friends/export-csv' + q, { method: 'GET' });
      if (!res.ok) { toast(__('friends.export_failed') || '导出失败', 'error'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `friends_${type}_${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      toast(__('friends.export_ok') || '已开始下载', 'success');
    } catch (e) {
      if (!isApiHandledError(e)) toast(e.message, 'error');
    }
  }

  // ==================== G-04 共同世界 ====================
  let _commonWorldsModalReady = false;
  function ensureCommonWorldsModal() {
    if (_commonWorldsModalReady && document.getElementById('commonWorldsModal')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'commonWorldsModal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="commonWorldsTitle" class="modal-title"></h3>
          <button class="modal-close" data-modal-close="commonWorldsModal" aria-label="close">&times;</button>
        </div>
        <div class="modal-body" id="commonWorldsBody"></div>
      </div>`;
    document.body.appendChild(el);
    _commonWorldsModalReady = true;
  }

  async function showCommonWorlds(id) {
    ensureCommonWorldsModal();
    const title = document.getElementById('commonWorldsTitle');
    const body = document.getElementById('commonWorldsBody');
    if (title) title.textContent = __('friends.common_worlds_title');
    if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(__('common.loading') || '加载中…')}</div>`;
    showModal('commonWorldsModal');
    try {
      const res = await api('/api/friends/common-worlds/' + id, { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      const items = d.items || [];
      if (!items.length) {
        if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(__('friends.common_worlds_empty'))}</div>`;
        return;
      }
      if (body) body.innerHTML = items.map(it => `
        <div class="hist-item" style="display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border,#e5e7eb)">
          ${it.imageUrl ? `<img src="${escAttr(it.imageUrl)}" alt="" loading="lazy" style="width:44px;height:44px;border-radius:8px;object-fit:cover;flex:0 0 auto">` : ''}
          <div style="flex:1;min-width:0">
            <div class="text-13" style="font-weight:600;word-break:break-all">${esc(it.worldName)}</div>
            <div class="text-12 text-muted2">${esc((__('friends.common_worlds_detail') || '我 {a} 次 · TA {b} 次').replace('{a}', it.myVisits).replace('{b}', it.theirVisits))}</div>
          </div>
        </div>`).join('');
    } catch (e) {
      if (isApiHandledError(e)) return;
      if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  // ==================== F-05 友谊里程碑 ====================
  let _milestonesModalReady = false;
  function ensureMilestonesModal() {
    if (_milestonesModalReady && document.getElementById('friendMilestonesModal')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'friendMilestonesModal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="friendMilestonesTitle" class="modal-title"></h3>
          <button class="modal-close" data-modal-close="friendMilestonesModal" aria-label="close">&times;</button>
        </div>
        <div class="modal-body" id="friendMilestonesBody"></div>
      </div>`;
    document.body.appendChild(el);
    _milestonesModalReady = true;
  }

  const MILESTONE_META = {
    first_meet: { icon: '🌟', key: 'friends.ms_first_meet', fallback: '初次相遇' },
    reunion: { icon: '🤗', key: 'friends.ms_reunion', fallback: '再次重逢' },
    world_change: { icon: '🌐', key: 'friends.ms_world_change', fallback: '一起换到新世界' }
  };

  async function showFriendMilestones(id) {
    ensureMilestonesModal();
    const title = document.getElementById('friendMilestonesTitle');
    const body = document.getElementById('friendMilestonesBody');
    if (title) title.textContent = __('friends.milestones_title');
    if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(__('common.loading') || '加载中…')}</div>`;
    showModal('friendMilestonesModal');
    try {
      const res = await api('/api/friends/milestones/' + id, { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      const ms = d.milestones || [];
      if (!ms.length) {
        if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(__('friends.ms_empty'))}</div>`;
        return;
      }
      const head = `
        <div class="text-13 text-muted2" style="margin-bottom:12px;display:flex;gap:10px;flex-wrap:wrap">
          <span class="badge badge-outline">${esc((__('friends.ms_sessions') || '见面 {n} 次').replace('{n}', d.totalSessions || 0))}</span>
          <span class="badge badge-outline">${esc((__('friends.ms_span') || '跨越 {n} 天').replace('{n}', d.spanDays || 0))}</span>
        </div>`;
      const list = ms.map(m => {
        const meta = MILESTONE_META[m.type] || { icon: '•', key: '', fallback: m.type };
        const label = meta.key ? (__(meta.key) || meta.fallback) : meta.fallback;
        let detail = m.detail || '';
        if (m.type === 'world_change' && m.from) detail = `${m.from} → ${detail}`;
        if (m.type === 'reunion' && m.gapDays) detail = `${detail} · ${(m.gapDays)}天`;
        return `
          <div class="hist-item" style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border,#e5e7eb)">
            <span style="flex:0 0 auto;font-size:16px">${meta.icon}</span>
            <div style="flex:1;min-width:0">
              <div class="text-13" style="font-weight:600">${esc(label)}</div>
              <div class="text-12 text-muted2" style="word-break:break-all">${esc(detail)}</div>
            </div>
            <span class="text-12 text-muted2" style="flex:0 0 auto">${esc(fmtDate(m.time))}</span>
          </div>`;
      }).join('');
      if (body) body.innerHTML = head + list;
    } catch (e) {
      if (isApiHandledError(e)) return;
      if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  // ==================== F-21 在线活动时间轴 ====================
  let _actTimelineModalReady = false;
  function ensureActTimelineModal() {
    if (_actTimelineModalReady && document.getElementById('friendActTimelineModal')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'friendActTimelineModal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="friendActTimelineTitle" class="modal-title"></h3>
          <button class="modal-close" data-modal-close="friendActTimelineModal" aria-label="close">&times;</button>
        </div>
        <div class="modal-body" id="friendActTimelineBody"></div>
      </div>`;
    document.body.appendChild(el);
    _actTimelineModalReady = true;
  }

  // F-01（借鉴 VRCX Activity Heatmap）：把会话按「星期×小时」聚合成 7×24 热力图。
  // 纯前端基于已加载的 items.startedAt 计算，不加后端接口/DB 字段。
  function renderActivityHeatmap(items) {
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const r of items) {
      const d = r.startedAt ? new Date(r.startedAt) : null;
      if (!d || isNaN(d.getTime())) continue;
      const wd = d.getDay();       // 0=周日
      const hr = d.getHours();     // 0-23
      const mins = r.ongoing
        ? Math.max(1, Math.round((Date.now() - d.getTime()) / 60000))
        : (r.durationMinutes || 0);
      grid[wd][hr] += Math.max(1, mins);
    }
    const max = Math.max(1, ...grid.flat());
    const wdLabels = ['日', '一', '二', '三', '四', '五', '六'];
    // G-14 峰值统计：找出最活跃的「星期×小时」组合与最活跃星期/小时
    let peakVal = 0, peakWd = -1, peakHr = -1;
    const wdTotals = new Array(7).fill(0);
    const hrTotals = new Array(24).fill(0);
    for (let wd = 0; wd < 7; wd++) {
      for (let hr = 0; hr < 24; hr++) {
        const v = grid[wd][hr];
        wdTotals[wd] += v;
        hrTotals[hr] += v;
        if (v > peakVal) { peakVal = v; peakWd = wd; peakHr = hr; }
      }
    }
    const topWd = wdTotals.indexOf(Math.max(...wdTotals));
    const topHr = hrTotals.indexOf(Math.max(...hrTotals));
    const peakLine = peakVal > 0
      ? `<div class="text-12 text-muted2" style="margin-bottom:6px">
           ${esc((__('friends.heatmap_peak') || '峰值：周{wd} {hr}:00 · {m} 分钟').replace('{wd}', wdLabels[peakWd]).replace('{hr}', String(peakHr).padStart(2, '0')).replace('{m}', peakVal))}
           <br>${esc((__('friends.heatmap_top') || '最活跃：周{wd} · {hr} 点时段').replace('{wd}', wdLabels[topWd]).replace('{hr}', topHr))}
         </div>`
      : '';
    let rows = '';
    for (let wd = 0; wd < 7; wd++) {
      let cells = '';
      for (let hr = 0; hr < 24; hr++) {
        const v = grid[wd][hr];
        const level = v === 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4));
        const title = `${wdLabels[wd]} ${String(hr).padStart(2, '0')}:00 · ${v}min`;
        cells += `<span class="act-heat-cell" data-level="${level}" title="${escAttr(title)}" aria-label="${escAttr(title)}"></span>`;
      }
      rows += `<div class="act-heat-row"><span class="act-heat-label">${wdLabels[wd]}</span>${cells}</div>`;
    }
    const hours = `<div class="act-heat-row act-heat-hours"><span class="act-heat-label"></span>${Array.from({ length: 24 }, (_, h) => `<span class="act-heat-hour">${h % 3 === 0 ? h : ''}</span>`).join('')}</div>`;
    return `<div class="act-heatmap" style="margin:10px 0 14px;">
      <div class="text-12 text-muted2" style="margin-bottom:6px;">${esc(__('friends.activity_heatmap_title') || '活跃时段分布')}</div>
      ${peakLine}
      ${hours}${rows}
    </div>`;
  }

  async function showFriendActivityTimeline(id) {
    ensureActTimelineModal();
    const title = document.getElementById('friendActTimelineTitle');
    const body = document.getElementById('friendActTimelineBody');
    if (title) title.textContent = __('friends.activity_timeline_title');
    if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(__('common.loading') || '加载中...')}</div>`;
    showModal('friendActTimelineModal');
    try {
      const res = await api('/api/friends/activity-sessions/' + id, { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      // F-04：并发拉取「共度时间」（失败不影响主时间轴展示）
      const together = await api('/api/friends/together-time/' + id, { method: 'GET' })
        .then(r => (r.ok ? r.json() : null)).catch(() => null);
      const items = (d.items || []);
      if (!items.length) {
        if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(__('friends.activity_timeline_empty'))}</div>`;
        return;
      }
      // 汇总行：当前在线徽章 + 总在线时长（近 30 天）
      const summary = (__('friends.activity_timeline_total') || '近 30 天在线 {minutes} 分钟')
        .replace('{minutes}', d.totalMinutes || 0);
      const onlineBadge = d.onlineNow
        ? `<span class="badge badge-success">${esc(__('friends.activity_timeline_online_now'))}</span>`
        : '';
      // F-04：共度时间徽章（双方在线会话重叠总时长）
      const togetherBadge = (together && together.totalMinutes > 0)
        ? `<span class="badge badge-info">${esc((__('friends.together_time_badge') || '共度 {m} 分钟').replace('{m}', together.totalMinutes))}</span>`
        : '';
      if (body) body.innerHTML = `
        <div class="text-13 text-muted2" style="margin-bottom:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span>${esc(summary)}</span>${onlineBadge}${togetherBadge}
          <button type="button" class="btn btn-sm btn-outline" id="actTimelineExport" style="margin-left:auto">${esc(__('friends.export_csv') || '导出 CSV')}</button>
        </div>
        ${renderActivityHeatmap(items)}
        ${items.map(r => {
          const day = fmtDate(r.startedAt);
          const start = fmtTime(r.startedAt);
          const end = r.ongoing
            ? esc(__('friends.activity_timeline_ongoing'))
            : fmtTime(r.endedAt);
          const mins = r.ongoing
            ? Math.max(1, Math.round((Date.now() - new Date(r.startedAt).getTime()) / 60000))
            : (r.durationMinutes || 0);
          const world = r.worldName || r.worldId || '—';
          return `
            <div class="hist-item" style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border,#e5e7eb);">
              <div style="flex-shrink:0;width:auto;min-width:96px;font-size:12px;color:var(--muted,#888);padding-top:2px;">${esc(day)}</div>
              <div style="flex:1;min-width:0;">
                <div class="text-13" style="font-weight:600;">
                  ${esc(start)} — ${end}
                  ${r.ongoing ? '' : ''}
                  <span class="text-muted2 text-12" style="font-weight:400;"> · ${mins}${esc(__('friends.activity_timeline_minutes'))}</span>
                </div>
                <div class="text-12 text-muted2" style="word-break:break-all;margin-top:2px;">
                  ${esc(__('friends.activity_timeline_world'))}: ${esc(world)}
                </div>
              </div>
            </div>`;
        }).join('')}`;
      const expBtn = document.getElementById('actTimelineExport');
      if (expBtn) expBtn.addEventListener('click', () => exportFriendsCsv('sessions', id));
    } catch (e) {
      if (isApiHandledError(e)) return;
      if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  // ==================== 操作 ====================
  async function doAction(action, id) {
    // 破坏性操作（移除好友 / 拉黑）需二次确认，避免误触且移除不可逆
    if (action === 'remove' || action === 'block') {
      const label = action === 'remove' ? __('friends.remove') : __('friends.block');
      const warn = action === 'remove'
        ? __('friends.confirm_remove')
        : __('friends.confirm_block');
      const ok = await new Promise((resolve) => showConfirm(`${warn}\n\n${label}：${__('friends.op_irreversible')}`, () => resolve(true), () => resolve(false)));
      if (!ok) return;
    }
    try {
      let r;
      if (action === 'add') r = await req('POST', '/api/friends/request', { targetUserId: id });
      else if (action === 'accept' || action === 'reject') r = await req('POST', '/api/friends/respond', { requestId: id, action });
      else if (action === 'cancel' || action === 'remove') r = await req('DELETE', '/api/friends/' + id);
      else if (action === 'block') r = await req('POST', '/api/friends/block', { targetUserId: id });
      else if (action === 'unblock') r = await req('DELETE', '/api/friends/block/' + id);
      else return;

      if (!r.res.ok) { toast(errText(r.d) || __('friends.op_failed'), 'error'); return; }
      const msg = {
        add: __('friends.request_sent'),
        accept: __('friends.request_accepted'),
        reject: __('friends.request_rejected'),
        cancel: __('friends.removed'),
        remove: __('friends.removed'),
        block: __('friends.blocked'),
        unblock: __('friends.unblocked')
      }[action] || __('friends.request_sent');
      toast(msg, 'success');
      // 刷新相关列表
      if (action === 'add') { const s = document.getElementById('friendSearch'); if (s) loadSearch(s.value); }
      loadRequests(); loadFriends(); loadBlocked();
    } catch (e) {
      if (isApiHandledError(e)) return;
      toast(e.message, 'error');
    }
  }

  function bindFriendsEvents() {
    const root = document.getElementById('tab-friends');
    if (!root) return;
    // 根节点点击委托只需绑定一次（root 容器本身不会被替换）
    if (!root.dataset.bound) {
      root.dataset.bound = '1';
      root.addEventListener('click', (e) => {
        const more = e.target.closest('[data-feed-more]');
        if (more) { loadFeed(false); return; }
        const b = e.target.closest('[data-action]');
        if (!b) return;
        const action = b.dataset.action;
        const id = parseInt(b.dataset.id);
        if (action === 'back-to-chat') { switchTab('chat'); return; }
        if (action === 'message') { if (typeof openChat === 'function') openChat(id); else switchTab('chat'); return; }
        if (action === 'mutual') { showMutualFriends(id); return; }
        if (action === 'history') { showFriendHistory(id); return; }
        if (action === 'worldhist') { showFriendWorldHistory(id); return; }
        if (action === 'timeline') { showFriendActivityTimeline(id); return; }
        if (action === 'milestones') { showFriendMilestones(id); return; }
        if (action === 'commonworlds') { showCommonWorlds(id); return; }
        if (action === 'member-open') {
          const uid = b.dataset.id;
          if (uid && typeof window.openMemberCard === 'function') window.openMemberCard(uid);
          return;
        }
        if (action === 'world-rank-open') {
          const wid = b.dataset.worldId;
          if (wid && typeof window.openWorldSearch === 'function') {
            switchTab('vrc');
            setTimeout(function () {
              window.openWorldSearch('evt');
              const box = document.getElementById('worldSearchInput');
              if (box) { box.value = wid; if (typeof window.doWorldSearch === 'function') window.doWorldSearch(); }
            }, 160);
          }
          return;
        }
        doAction(action, id);
      });
    }
    // 搜索输入框每次渲染都会被重建，必须重新绑定，否则二次进入 tab 后搜索失效
    const search = document.getElementById('friendSearch');
    if (search) {
      search.addEventListener('input', debounce(() => loadSearch(search.value), 300));
    }
  }

  window.showFriends = showFriends;
})();
