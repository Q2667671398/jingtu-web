/* ============================================================
 * files.js — 群组文件库（安装包/工具分发）
 * 管理员：创建分类、上传文件、删除
 * 登录成员：按分类浏览、搜索、下载
 * 依赖：core.js 的 api/__/esc/escAttr/toast/showModal/closeModal/showConfirm
 * ============================================================ */
(function () {
  'use strict';
  if (window.__filesModuleInited) return;
  window.__filesModuleInited = true;

  let _filesState = { categories: [], categoryId: '', q: '', page: 1, pageSize: 20, totalPages: 1, view: 'list' };
  let _filesSeq = 0;
  let _uploading = false;

  const isAdmin = () => {
    const u = window.currentUser;
    return !!(u && (u.role === 'admin' || u.role === 'super_admin'));
  };

  // ---------- 分类栏 ----------
  function renderCatBar() {
    const bar = document.getElementById('filesCatBar');
    if (!bar) return;
    const total = _filesState.categories.reduce((s, c) => s + (c.fileCount || 0), 0);
    const items = [{ id: '', name: __('files.all'), count: total }]
      .concat(_filesState.categories.map(c => ({ id: String(c.id), name: c.name, count: c.fileCount })));
    bar.innerHTML = items.map(it => {
      const active = String(_filesState.categoryId) === String(it.id) ? ' active' : '';
      return `<button type="button" class="files-cat-chip${active}" data-cat="${escAttr(String(it.id))}">${esc(it.name)} <span class="files-cat-count">${it.count || 0}</span></button>`;
    }).join('');
  }

  async function loadCategories() {
    try {
      const res = await api('/api/group-files/categories', { method: 'GET' });
      if (!res.ok) return;
      const d = await res.json().catch(() => ({}));
      _filesState.categories = d.categories || [];
      renderCatBar();
    } catch (e) { /* 分类失败不影响主列表 */ }
  }

  // ---------- 文件列表 ----------
  async function loadFiles(page) {
    const el = document.getElementById('filesList');
    if (!el) return;
    if (page) _filesState.page = page;
    const mySeq = ++_filesSeq;
    el.innerHTML = `<div class="text-muted2 p-16">${esc(__('common.loading'))}</div>`;
    try {
      const qs = new URLSearchParams({ page: String(_filesState.page), pageSize: String(_filesState.pageSize) });
      if (_filesState.categoryId !== '') qs.set('categoryId', _filesState.categoryId);
      if (_filesState.q) qs.set('q', _filesState.q);
      const res = await api('/api/group-files?' + qs.toString(), { method: 'GET' });
      if (mySeq !== _filesSeq) return;
      if (!res.ok) {
        el.innerHTML = `<div class="text-muted2 p-16">${esc(__('files.load_failed'))}</div>`;
        return;
      }
      const d = await res.json().catch(() => ({}));
      const files = d.files || [];
      _filesState.totalPages = d.totalPages || 1;
      if (!files.length) {
        el.innerHTML = `<div class="files-empty">${esc(__('files.empty'))}</div>`;
        renderPager();
        return;
      }
      el.innerHTML = files.map(f => {
        const icon = fileIcon(f.ext);
        const canDel = isAdmin();
        const verBadge = (f.version && f.version !== '1') || f.versionCount > 1
          ? `<span class="files-ver-badge">v${esc(f.version || '1')}</span>` : '';
        const histBtn = f.versionCount > 1
          ? `<button type="button" class="btn btn-sm btn-outline" data-file-versions="${f.id}">🕘 ${esc(__('files.versions') || '历史版本')} (${f.versionCount})</button>`
          : '';
        // 权限标记：仅管理员 / 指定分组
        const lv = f.accessLevel || 'all';
        const lockBadge = lv === 'admin'
          ? `<span class="files-lock-badge">🔒 ${esc(__('files.access_admin') || '仅管理员')}</span>`
          : (lv === 'groups'
            ? `<span class="files-lock-badge">🔐 ${esc(__('files.access_groups') || '指定分组')}</span>`
            : '');
        const checkbox = canDel
          ? `<label class="files-check"><input type="checkbox" data-file-check="${f.id}"></label>`
          : '';
        return `
          <div class="files-item" data-file-id="${f.id}">
            ${checkbox}
            <div class="files-icon">${icon}</div>
            <div class="files-main">
              <div class="files-title">${esc(f.title)}${verBadge}${lockBadge}</div>
              ${f.description ? `<div class="files-desc files-desc-md">${renderSimpleMarkdown(f.description)}</div>` : ''}
              <div class="files-meta">
                <span>${esc(f.fileName)}</span>
                <span>·</span><span>${esc(f.fileSizeText)}</span>
                ${f.categoryName ? `<span>·</span><span>${esc(f.categoryName)}</span>` : ''}
                <span>·</span><span>⬇ ${f.downloadCount}</span>
                ${f.uploaderName ? `<span>·</span><span>${esc(f.uploaderName)}</span>` : ''}
                <span>·</span><span>${esc(fmtDate(f.createdAt))}</span>
              </div>
            </div>
            <div class="files-actions">
              <button type="button" class="btn btn-sm ${f.isFavorited ? 'btn-accent' : 'btn-outline'}" data-file-fav="${f.id}" title="${esc(__('files.favorite') || '收藏')}">${f.isFavorited ? '★' : '☆'}</button>
              <button type="button" class="btn btn-sm btn-accent" data-file-download="${f.id}">⬇ ${esc(__('files.download'))}</button>
              ${histBtn}
              ${canDel ? `<button type="button" class="btn btn-sm btn-outline" data-file-edit="${f.id}">✏️ ${esc(__('common.edit') || '编辑')}</button>` : ''}
              ${canDel ? `<button type="button" class="btn btn-sm btn-outline" data-file-share="${f.id}">🔗 ${esc(__('files.share') || '分享')}</button>` : ''}
              ${canDel ? `<button type="button" class="btn btn-sm btn-outline" data-file-delete="${f.id}">${esc(__('common.delete'))}</button>` : ''}
            </div>
          </div>`;
      }).join('');
      window.__filesLastList = files; // 供上传弹窗的「归组」下拉与批量操作使用
      renderBatchBar();
      renderPager();
    } catch (e) {
      if (mySeq !== _filesSeq) return;
      el.innerHTML = `<div class="text-muted2 p-16">${esc(__('files.load_failed'))}</div>`;
    }
  }

  function fileIcon(ext) {
    const e = String(ext || '').toLowerCase();
    if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'].includes(e)) return '🗜';
    if (['.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.appimage', '.apk', '.ipa'].includes(e)) return '⚙';
    if (['.pdf'].includes(e)) return '📄';
    if (['.doc', '.docx', '.txt', '.md'].includes(e)) return '📝';
    if (['.xls', '.xlsx', '.csv'].includes(e)) return '📊';
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(e)) return '🖼';
    if (['.mp4', '.mp3', '.wav'].includes(e)) return '🎬';
    if (['.unitypackage', '.vrca', '.vrcw'].includes(e)) return '🧩';
    return '📦';
  }

  function renderPager() {
    const pager = document.getElementById('filesPager');
    const info = document.getElementById('filesPageInfo');
    const prev = document.getElementById('filesPrev');
    const next = document.getElementById('filesNext');
    if (!pager) return;
    const tp = _filesState.totalPages || 1;
    pager.style.display = tp > 1 ? '' : 'none';
    if (info) info.textContent = `${_filesState.page} / ${tp}`;
    if (prev) prev.disabled = _filesState.page <= 1;
    if (next) next.disabled = _filesState.page >= tp;
  }

  // ---------- 下载 ----------
  async function downloadFile(id) {
    // 用临时 <a> 触发浏览器原生下载（服务端已设 attachment + Range 支持）
    const a = document.createElement('a');
    a.href = `/api/group-files/${encodeURIComponent(id)}/download`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 稍后刷新计数
    setTimeout(() => { if (document.getElementById('tab-files') && !document.getElementById('tab-files').classList.contains('d-none')) loadFiles(_filesState.page); }, 2500);
  }

  // ---------- 删除 ----------
  async function deleteFile(id) {
    const okDel = await new Promise((resolve) => {
      showConfirm(__('files.confirm_delete'), () => resolve(true), () => resolve(false));
    });
    if (!okDel) return;
    try {
      const res = await api('/api/group-files/' + id, { method: 'DELETE' });
      if (!res.ok) { toast(__('files.delete_failed'), 'error'); return; }
      toast(__('files.deleted'), 'success');
      loadCategories();
      loadFiles(_filesState.page);
    } catch (e) { toast(e.message || __('files.delete_failed'), 'error'); }
  }

  // ---------- 上传弹窗 ----------
  function ensureUploadModal() {
    if (document.getElementById('fileUploadModal')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'fileUploadModal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 class="modal-title">⬆ ${esc(__('files.upload'))}</h3>
          <button type="button" class="modal-close" data-modal-close="fileUploadModal" aria-label="close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label for="fileUploadInput">${esc(__('files.pick_file'))}</label>
            <input type="file" id="fileUploadInput" class="form-input">
            <p class="text-12 text-muted2 mt-4">${esc(__('files.size_hint'))}</p>
          </div>
          <div class="form-group"><label for="fileUploadTitle">${esc(__('files.title_label'))}</label>
            <input type="text" id="fileUploadTitle" class="form-input" maxlength="200" placeholder="${escAttr(__('files.title_ph'))}">
          </div>
          <div class="form-group"><label for="fileUploadCat">${esc(__('files.category'))}</label>
            <select id="fileUploadCat" class="form-input"></select>
          </div>
          <div class="form-group"><label for="fileUploadVersion">${esc(__('files.version') || '版本号')}</label>
            <input type="text" id="fileUploadVersion" class="form-input" maxlength="30" placeholder="1.0.0" value="1">
          </div>
          <div class="form-group"><label for="fileUploadGroup">${esc(__('files.as_new_version') || '作为新版本加入已有文件（可选）')}</label>
            <select id="fileUploadGroup" class="form-input"></select>
          </div>
          <div class="form-group"><label for="fileUploadAccess">${esc(__('files.access_level') || '下载权限')}</label>
            <select id="fileUploadAccess" class="form-input">
              <option value="all">${esc(__('files.access_all') || '所有登录成员')}</option>
              <option value="admin">${esc(__('files.access_admin') || '仅管理员')}</option>
              <option value="groups">${esc(__('files.access_groups') || '指定分组')}</option>
            </select>
          </div>
          <div class="form-group" id="fileUploadGroupsWrap" style="display:none">
            <label>${esc(__('files.allowed_groups') || '允许的分组（可多选）')}</label>
            <div id="fileUploadGroups" class="files-groups-pick"></div>
          </div>
          <div class="form-group"><label for="fileUploadDesc">${esc(__('files.desc_label'))}</label>
            <textarea id="fileUploadDesc" class="form-input" rows="3" maxlength="1000"></textarea>
          </div>
          <div id="fileUploadProgress" class="text-13 text-muted2" style="display:none"></div>
          <div class="flex-row gap-8 mt-12">
            <button type="button" class="btn btn-accent" id="fileUploadSubmit">${esc(__('files.do_upload'))}</button>
            <button type="button" class="btn btn-outline" data-modal-close="fileUploadModal">${esc(__('common.cancel'))}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target && e.target.hasAttribute('data-modal-close')) closeModal('fileUploadModal');
    });
    document.getElementById('fileUploadSubmit').addEventListener('click', doUpload);
    document.getElementById('fileUploadAccess').addEventListener('change', async (e) => {
      const wrap = document.getElementById('fileUploadGroupsWrap');
      if (wrap) wrap.style.display = e.target.value === 'groups' ? '' : 'none';
      if (e.target.value === 'groups') await fillUploadGroups();
    });
  }

  // 上传弹窗的分组多选
  async function fillUploadGroups() {
    const box = document.getElementById('fileUploadGroups');
    if (!box || box.dataset.filled === '1') return;
    const groups = await loadPermGroups();
    if (!groups.length) {
      box.innerHTML = `<p class="text-12 text-muted2">${esc(__('files.no_groups') || '暂无可选分组')}</p>`;
    } else {
      box.innerHTML = groups.map(g => `
        <label class="files-group-opt">
          <input type="checkbox" value="${g.id}">
          <span>${esc(g.name)}</span>
        </label>`).join('');
    }
    box.dataset.filled = '1';
  }

  function fillUploadCats() {
    const sel = document.getElementById('fileUploadCat');
    if (!sel) return;
    sel.innerHTML = `<option value="">${esc(__('files.uncategorized'))}</option>` +
      _filesState.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    // 归组下拉：列出当前列表里已有的文件（可"作为新版本"加入）
    const grp = document.getElementById('fileUploadGroup');
    if (grp) {
      const cur = (window.__filesLastList || []);
      grp.innerHTML = `<option value="">${esc(__('files.new_file') || '新建文件（不归组）')}</option>` +
        cur.map(f => `<option value="${f.id}" data-group="${f.fileGroupId || f.id}">${esc(f.title)} (v${esc(f.version || '1')})</option>`).join('');
    }
  }

  async function doUpload() {
    if (_uploading) return;
    const input = document.getElementById('fileUploadInput');
    const titleEl = document.getElementById('fileUploadTitle');
    const catEl = document.getElementById('fileUploadCat');
    const descEl = document.getElementById('fileUploadDesc');
    const verEl = document.getElementById('fileUploadVersion');
    const grpEl = document.getElementById('fileUploadGroup');
    const prog = document.getElementById('fileUploadProgress');
    const btn = document.getElementById('fileUploadSubmit');
    if (!input || !input.files || !input.files.length) { toast(__('files.pick_file_first'), 'error'); return; }
    const file = input.files[0];

    const accessEl = document.getElementById('fileUploadAccess');
    const accessLevel = accessEl ? accessEl.value : 'all';
    const allowedGroupIds = Array.from(document.querySelectorAll('#fileUploadGroups input:checked'))
      .map(el => parseInt(el.value, 10)).filter(n => Number.isInteger(n));
    if (accessLevel === 'groups' && !allowedGroupIds.length) {
      toast(__('files.must_pick_group') || '选择「指定分组」时必须至少选一个分组', 'error');
      return;
    }
    const meta = {
      title: (titleEl && titleEl.value.trim()) || file.name,
      categoryId: catEl ? catEl.value : '',
      description: descEl ? descEl.value.trim() : '',
      version: (verEl && verEl.value.trim()) || '1',
      groupId: grpEl ? grpEl.value : '',
      accessLevel,
      allowedGroupIds
    };

    _uploading = true;
    if (btn) btn.disabled = true;
    if (prog) { prog.style.display = ''; prog.textContent = __('files.uploading'); }
    try {
      // 小文件（<8MB）走单次上传；大文件走分片（断点续传）
      const CHUNK_THRESHOLD = 8 * 1024 * 1024;
      if (file.size < CHUNK_THRESHOLD) {
        await uploadSingle(file, meta, prog);
      } else {
        await uploadChunked(file, meta, prog);
      }
      toast(__('files.upload_ok'), 'success');
      closeModal('fileUploadModal');
      if (input) input.value = '';
      if (titleEl) titleEl.value = '';
      if (descEl) descEl.value = '';
      if (verEl) verEl.value = '';
      loadCategories();
      loadFiles(1);
    } catch (e) {
      toast(e.message || __('files.upload_failed'), 'error');
    } finally {
      _uploading = false;
      if (btn) btn.disabled = false;
      if (prog) prog.style.display = 'none';
    }
  }

  // 单次上传（复用 core.js 的 apiForm：内部带 CSRF + 统一错误处理）
  async function uploadSingle(file, meta, prog) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('title', meta.title);
    fd.append('categoryId', meta.categoryId);
    fd.append('description', meta.description);
    fd.append('version', meta.version);
    if (meta.groupId) fd.append('groupId', meta.groupId);
    fd.append('accessLevel', meta.accessLevel || 'all');
    if (meta.allowedGroupIds && meta.allowedGroupIds.length) {
      fd.append('allowedGroupIds', JSON.stringify(meta.allowedGroupIds));
    }
    let res;
    try {
      res = await apiForm('/api/group-files/upload', fd, { timeout: 600000 });
    } catch (e) {
      throw new Error(e && e.message && e.message !== 'UNAUTHORIZED' && e.message !== 'FORBIDDEN'
        ? e.message : __('files.upload_failed'));
    }
    if (!res || !res.ok) {
      let msg = __('files.upload_failed');
      try { const d = await res.json(); msg = errText(d) || msg; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
  }

  // 计算文件 SHA256（分块读取，不占内存）
  async function sha256OfFile(file) {
    if (!(window.crypto && crypto.subtle && crypto.subtle.digest)) return '';
    const CHUNK = 4 * 1024 * 1024;
    // 大文件一次性读入会爆内存；这里分块但 crypto.subtle.digest 不支持流式，
    // 故对 >64MB 的文件跳过哈希（服务端会再算，续传识别退化为按大小+文件名）
    if (file.size > 64 * 1024 * 1024) return '';
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // 分片上传（断点续传）
  async function uploadChunked(file, meta, prog) {
    const CHUNK_SIZE = 5 * 1024 * 1024;
    const setProg = (txt) => { if (prog) prog.textContent = txt; };

    setProg(__('files.calc_hash') || '正在计算文件指纹…');
    let fileHash = await sha256OfFile(file);
    // 超大文件跳过哈希时，用大小+文件名构造稳定的伪哈希（仅用于续传识别）
    if (!fileHash) {
      const seed = `${file.name}|${file.size}|${file.lastModified}`;
      const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
      fileHash = Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    setProg(__('files.init_upload') || '正在初始化上传…');
    const initRes = await api('/api/group-files/upload/init', {
      method: 'POST',
      body: {
        fileHash, fileName: file.name, totalSize: file.size, chunkSize: CHUNK_SIZE,
        title: meta.title, categoryId: meta.categoryId, description: meta.description,
        version: meta.version, groupId: meta.groupId,
        accessLevel: meta.accessLevel || 'all',
        allowedGroupIds: meta.allowedGroupIds || []
      },
      timeout: 60000
    });
    if (!initRes.ok) {
      let msg = __('files.upload_failed');
      try { const d = await initRes.json(); msg = errText(d) || msg; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    const init = await initRes.json();
    const uploadId = init.uploadId;
    const cs = init.chunkSize || CHUNK_SIZE;
    const total = init.totalChunks;
    const received = new Set(init.receivedChunks || []);
    if (init.resumed && received.size) {
      setProg((__('files.resume_hint') || '断点续传：已完成 {d}/{t} 片').replace('{d}', received.size).replace('{t}', total));
    }

    // 分片用原生 XHR（发原始二进制），需自行带 CSRF；每片前重新取一次新鲜 token
    // （core.js 的 token 是单次消费的池模式，复用旧 token 会被 403 拒绝）
    for (let i = 0; i < total; i++) {
      if (received.has(i)) continue;
      const start = i * cs;
      const blob = file.slice(start, Math.min(start + cs, file.size));
      let token = '';
      try {
        token = (typeof ensureCsrf === 'function') ? (await ensureCsrf()) || '' : '';
      } catch (e) { /* 拿不到就让服务端判定 */ }
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/group-files/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${i}`, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        if (token) xhr.setRequestHeader('X-CSRF-Token', token);
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300)
          ? resolve()
          : reject(new Error(`分片 ${i} 上传失败（${xhr.status}）`));
        xhr.onerror = () => reject(new Error(`分片 ${i} 网络错误`));
        xhr.send(blob);
      });
      setProg(`${__('files.uploading')} ${Math.round(((i + 1) / total) * 100)}%  (${i + 1}/${total})`);
    }

    setProg(__('files.merging') || '正在合并分片…');
    const doneRes = await api('/api/group-files/upload/complete', {
      method: 'POST', body: { uploadId }, timeout: 600000
    });
    if (!doneRes.ok) {
      let msg = __('files.upload_failed');
      try { const d = await doneRes.json(); msg = errText(d) || msg; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
  }

  // ---------- 极简安全 Markdown（只用于文件描述） ----------
  // 关键：先整体 esc() 转义，再在「已转义文本」上做标记替换 → 用户输入永不参与 HTML 拼接。
  // 仅支持：**粗体** / *斜体* / `代码` / [文本](http链接) / 换行。不支持任何原始 HTML。
  function renderSimpleMarkdown(raw) {
    if (!raw) return '';
    let s = esc(String(raw));
    // 行内代码（优先处理，避免内部符号被后续规则误伤）
    s = s.replace(/`([^`\n]{1,200})`/g, '<code>$1</code>');
    // 粗体 **text**
    s = s.replace(/\*\*([^*\n]{1,200})\*\*/g, '<strong>$1</strong>');
    // 斜体 *text*（避开已生成的标签：要求前面不是 * 或字母数字）
    s = s.replace(/(^|[^*\w])\*([^*\n]{1,200})\*(?=[^*\w]|$)/g, '$1<em>$2</em>');
    // 链接 [text](url)：url 只允许 http/https（esc 后 &amp; 需还原判断）
    s = s.replace(/\[([^\]\n]{1,100})\]\((https?:\/\/[^\s)]{1,300})\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer nofollow">$1</a>');
    // 换行
    s = s.replace(/\r?\n/g, '<br>');
    return s;
  }

  // ---------- 批量操作栏 ----------
  function selectedFileIds() {
    return Array.from(document.querySelectorAll('[data-file-check]:checked'))
      .map(el => parseInt(el.dataset.fileCheck, 10))
      .filter(n => Number.isInteger(n));
  }

  function renderBatchBar() {
    const bar = document.getElementById('filesBatchBar');
    if (!bar) return;
    if (!isAdmin()) { bar.style.display = 'none'; return; }
    const n = selectedFileIds().length;
    bar.style.display = '';
    const cnt = document.getElementById('filesBatchCount');
    if (cnt) cnt.textContent = n ? (__('files.selected_n') || '已选 {n} 项').replace('{n}', n) : '';
    const moveBtn = document.getElementById('filesBatchMove');
    const clearBtn = document.getElementById('filesBatchClear');
    if (moveBtn) moveBtn.disabled = !n;
    if (clearBtn) clearBtn.disabled = !n;
  }

  function ensureBatchMoveModal() {
    if (document.getElementById('filesBatchMoveModal')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'filesBatchMoveModal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 class="modal-title">📁 ${esc(__('files.batch_move') || '批量移动到分类')}</h3>
          <button type="button" class="modal-close" data-modal-close="filesBatchMoveModal" aria-label="close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label for="filesBatchTargetCat">${esc(__('files.target_category') || '目标分类')}</label>
            <select id="filesBatchTargetCat" class="form-input"></select>
          </div>
          <div class="flex-row gap-8 mt-12">
            <button type="button" class="btn btn-accent" id="filesBatchMoveConfirm">${esc(__('files.do_move') || '确定移动')}</button>
            <button type="button" class="btn btn-outline" data-modal-close="filesBatchMoveModal">${esc(__('common.cancel'))}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target && e.target.hasAttribute('data-modal-close')) closeModal('filesBatchMoveModal');
    });
    document.getElementById('filesBatchMoveConfirm').addEventListener('click', doBatchMove);
  }

  async function doBatchMove() {
    const ids = selectedFileIds();
    if (!ids.length) { toast(__('files.pick_files_first') || '请先选择文件', 'error'); return; }
    const sel = document.getElementById('filesBatchTargetCat');
    const target = sel ? sel.value : '';
    try {
      const res = await api('/api/group-files/batch-move', {
        method: 'POST', body: { ids, categoryId: target }
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast(errText(d) || __('files.move_failed') || '移动失败', 'error'); return; }
      toast((__('files.moved_n') || '已移动 {n} 个文件').replace('{n}', d.moved || 0), 'success');
      closeModal('filesBatchMoveModal');
      loadCategories();
      loadFiles(_filesState.page);
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- 编辑文件（标题/描述/分类/权限） ----------
  function ensureEditModal() {
    if (document.getElementById('filesEditModal')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'filesEditModal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 class="modal-title">✏️ ${esc(__('common.edit') || '编辑')}</h3>
          <button type="button" class="modal-close" data-modal-close="filesEditModal" aria-label="close">&times;</button>
        </div>
        <div class="modal-body">
          <input type="hidden" id="filesEditId">
          <div class="form-group"><label for="filesEditTitle">${esc(__('files.title_label'))}</label>
            <input type="text" id="filesEditTitle" class="form-input" maxlength="200"></div>
          <div class="form-group"><label for="filesEditDesc">${esc(__('files.desc_label'))} <span class="text-12 text-muted2">(支持 **粗体**、*斜体*、\`代码\`、[链接](url))</span></label>
            <textarea id="filesEditDesc" class="form-input" rows="4" maxlength="10000"></textarea></div>
          <div class="form-group"><label for="filesEditCat">${esc(__('files.category'))}</label>
            <select id="filesEditCat" class="form-input"></select></div>
          <div class="form-group"><label for="filesEditAccess">${esc(__('files.access_level') || '下载权限')}</label>
            <select id="filesEditAccess" class="form-input">
              <option value="all">${esc(__('files.access_all') || '所有登录成员')}</option>
              <option value="admin">${esc(__('files.access_admin') || '仅管理员')}</option>
              <option value="groups">${esc(__('files.access_groups') || '指定分组')}</option>
            </select></div>
          <div class="form-group" id="filesEditGroupsWrap" style="display:none">
            <label>${esc(__('files.allowed_groups') || '允许的分组（可多选）')}</label>
            <div id="filesEditGroups" class="files-groups-pick"></div>
          </div>
          <div class="flex-row gap-8 mt-12">
            <button type="button" class="btn btn-accent" id="filesEditSave">${esc(__('common.save') || '保存')}</button>
            <button type="button" class="btn btn-outline" data-modal-close="filesEditModal">${esc(__('common.cancel'))}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target && e.target.hasAttribute('data-modal-close')) closeModal('filesEditModal');
    });
    document.getElementById('filesEditAccess').addEventListener('change', (e) => {
      const wrap = document.getElementById('filesEditGroupsWrap');
      if (wrap) wrap.style.display = e.target.value === 'groups' ? '' : 'none';
    });
    document.getElementById('filesEditSave').addEventListener('click', saveEdit);
  }

  let _groupsCache = null;
  async function loadPermGroups() {
    if (_groupsCache) return _groupsCache;
    try {
      const res = await api('/api/admin/perm-groups', { method: 'GET' });
      if (!res.ok) return [];
      const d = await res.json().catch(() => ({}));
      _groupsCache = d.groups || d.list || [];
      return _groupsCache;
    } catch (e) { return []; }
  }

  async function openEdit(fileId) {
    const f = (window.__filesLastList || []).find(x => String(x.id) === String(fileId));
    if (!f) return;
    ensureEditModal();
    document.getElementById('filesEditId').value = f.id;
    document.getElementById('filesEditTitle').value = f.title || '';
    document.getElementById('filesEditDesc').value = f.description || '';
    // 分类下拉
    const catSel = document.getElementById('filesEditCat');
    catSel.innerHTML = `<option value="">${esc(__('files.uncategorized'))}</option>` +
      _filesState.categories.map(c => `<option value="${c.id}"${String(c.id) === String(f.categoryId) ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    // 权限
    const lv = f.accessLevel || 'all';
    document.getElementById('filesEditAccess').value = lv;
    document.getElementById('filesEditGroupsWrap').style.display = lv === 'groups' ? '' : 'none';
    // 分组多选
    const box = document.getElementById('filesEditGroups');
    const groups = await loadPermGroups();
    const picked = new Set((f.allowedGroupIds || []).map(String));
    if (!groups.length) {
      box.innerHTML = `<p class="text-12 text-muted2">${esc(__('files.no_groups') || '暂无可选分组')}</p>`;
    } else {
      box.innerHTML = groups.map(g => `
        <label class="files-group-opt">
          <input type="checkbox" value="${g.id}"${picked.has(String(g.id)) ? ' checked' : ''}>
          <span>${esc(g.name)}</span>
        </label>`).join('');
    }
    showModal('filesEditModal');
  }

  async function saveEdit() {
    const id = document.getElementById('filesEditId').value;
    const title = document.getElementById('filesEditTitle').value.trim();
    const description = document.getElementById('filesEditDesc').value;
    const categoryId = document.getElementById('filesEditCat').value;
    const accessLevel = document.getElementById('filesEditAccess').value;
    const allowedGroupIds = Array.from(document.querySelectorAll('#filesEditGroups input:checked'))
      .map(el => parseInt(el.value, 10)).filter(n => Number.isInteger(n));
    if (accessLevel === 'groups' && !allowedGroupIds.length) {
      toast(__('files.must_pick_group') || '选择「指定分组」时必须至少选一个分组', 'error');
      return;
    }
    try {
      const res = await api('/api/group-files/' + encodeURIComponent(id), {
        method: 'PUT',
        body: { title, description, categoryId, accessLevel, allowedGroupIds }
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast(errText(d) || __('files.save_failed') || '保存失败', 'error'); return; }
      toast(__('files.saved') || '已保存', 'success');
      closeModal('filesEditModal');
      loadFiles(_filesState.page);
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- 维护面板 ----------
  function ensureMaintenanceModal() {
    if (document.getElementById('filesMaintModal')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'filesMaintModal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 class="modal-title">🧹 ${esc(__('files.maintenance') || '维护')}</h3>
          <button type="button" class="modal-close" data-modal-close="filesMaintModal" aria-label="close">&times;</button>
        </div>
        <div class="modal-body">
          <p class="text-13 text-muted2">${esc(__('files.maint_hint') || '清理过期上传会话、检测并清理孤儿文件。')}</p>
          <div class="files-maint-row">
            <div>
              <div class="text-14" style="font-weight:600">${esc(__('files.clean_sessions') || '清理过期上传会话')}</div>
              <div class="text-12 text-muted2">${esc(__('files.clean_sessions_hint') || '超过 24 小时未完成的分片上传会话')}</div>
            </div>
            <button type="button" class="btn btn-sm btn-outline" id="filesCleanSessions">${esc(__('files.do_clean') || '清理')}</button>
          </div>
          <div class="files-maint-row">
            <div>
              <div class="text-14" style="font-weight:600">${esc(__('files.scan_orphans') || '孤儿文件检测')}</div>
              <div class="text-12 text-muted2">${esc(__('files.scan_orphans_hint') || 'DB 有记录但磁盘缺失 / 磁盘有文件但 DB 无记录')}</div>
            </div>
            <button type="button" class="btn btn-sm btn-outline" id="filesScanOrphans">${esc(__('files.do_scan') || '扫描')}</button>
          </div>
          <div id="filesMaintResult" class="mt-12"></div>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target && e.target.hasAttribute('data-modal-close')) closeModal('filesMaintModal');
    });
    document.getElementById('filesCleanSessions').addEventListener('click', () => runMaint('cleanup-sessions', {}));
    document.getElementById('filesScanOrphans').addEventListener('click', () => runMaint('orphans', { mode: 'scan' }));
  }

  async function runMaint(action, body) {
    const box = document.getElementById('filesMaintResult');
    if (box) box.innerHTML = `<p class="text-muted2 text-13">${esc(__('common.loading'))}</p>`;
    try {
      const res = await api('/api/group-files/maintenance/' + action, { method: 'POST', body });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { if (box) box.innerHTML = `<p class="text-13">${esc(errText(d) || '失败')}</p>`; return; }
      if (action === 'cleanup-sessions') {
        if (box) box.innerHTML = `<p class="text-13">✅ ${esc((__('files.cleaned_n') || '已清理 {n} 个过期会话').replace('{n}', d.removed || 0))}</p>`;
        return;
      }
      // orphans 扫描结果
      let html = `<div class="text-13" style="margin-bottom:8px">
        <b>${esc(__('files.broken') || 'DB 有记录但磁盘缺失')}: ${d.brokenCount}</b><br>
        <b>${esc(__('files.orphan') || '磁盘有文件但无记录')}: ${d.orphanCount}</b></div>`;
      if (d.brokenFiles && d.brokenFiles.length) {
        html += `<div class="text-12 text-muted2" style="margin-bottom:4px">${esc(__('files.broken_list') || '缺失文件（最多显示 50 条）')}:</div>`;
        html += d.brokenFiles.map(b => `<div class="text-12" style="word-break:break-all">· #${b.id} ${esc(b.title || b.name || '')} — ${esc(b.reason || '')}</div>`).join('');
      }
      if (d.orphanFiles && d.orphanFiles.length) {
        html += `<div class="text-12 text-muted2" style="margin:8px 0 4px">${esc(__('files.orphan_list') || '孤儿文件（最多显示 50 条）')}:</div>`;
        html += d.orphanFiles.map(o => `<div class="text-12" style="word-break:break-all">· ${esc(o.name)} (${esc(o.sizeText)})</div>`).join('');
      }
      if ((d.brokenCount + d.orphanCount) > 0) {
        html += `<div class="mt-12"><button type="button" class="btn btn-sm btn-danger" id="filesCleanOrphans">${esc(__('files.clean_orphans') || '清理孤儿文件（删除无记录文件、标记破损记录）')}</button></div>`;
      }
      if (box) box.innerHTML = html;
      const btn = document.getElementById('filesCleanOrphans');
      if (btn) btn.addEventListener('click', async () => {
        const okDel = await new Promise(r => showConfirm(__('files.confirm_clean_orphans') || '确定清理？孤儿文件将被物理删除，破损记录将被标记删除。', () => r(true), () => r(false)));
        if (!okDel) return;
        await runMaint('orphans', { mode: 'clean' });
        loadFiles(_filesState.page);
      });
    } catch (e) {
      if (box) box.innerHTML = `<p class="text-13">${esc(e.message)}</p>`;
    }
  }

  // ---------- 收藏切换 ----------
  async function toggleFavorite(fileId) {
    try {
      const res = await api('/api/group-files/favorites/toggle', {
        method: 'POST', body: { fileId: Number(fileId) }
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast(errText(d) || __('files.fav_failed') || '操作失败', 'error'); return; }
      const btn = document.querySelector(`[data-file-fav="${fileId}"]`);
      if (btn) {
        btn.textContent = d.favorited ? '★' : '☆';
        btn.classList.toggle('btn-accent', !!d.favorited);
        btn.classList.toggle('btn-outline', !d.favorited);
      }
      // 同步本地快照，避免重新渲染时状态回退
      const item = (window.__filesLastList || []).find(x => String(x.id) === String(fileId));
      if (item) item.isFavorited = !!d.favorited;
      if (_filesState.view === 'favorites') loadFiles(1);
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- 排行榜视图 ----------
  async function loadRanking() {
    const el = document.getElementById('filesList');
    if (!el) return;
    el.innerHTML = `<div class="text-muted2 p-16">${esc(__('common.loading'))}</div>`;
    try {
      const res = await api('/api/group-files/ranking?top=20', { method: 'GET' });
      if (!res.ok) { el.innerHTML = `<div class="text-muted2 p-16">${esc(__('files.load_failed'))}</div>`; return; }
      const d = await res.json().catch(() => ({}));
      const items = d.items || [];
      if (!items.length) { el.innerHTML = `<div class="files-empty">${esc(__('files.ranking_empty') || '暂无下载记录')}</div>`; return; }
      el.innerHTML = items.map(it => `
        <div class="files-item" data-file-id="${it.id}">
          <span class="files-rank">#${it.rank}</span>
          <div class="files-icon">${fileIcon(it.ext)}</div>
          <div class="files-main">
            <div class="files-title">${esc(it.title)} <span class="files-ver-badge">v${esc(it.version)}</span></div>
            <div class="files-meta">
              <span>${esc(it.fileName)}</span><span>·</span><span>${esc(it.fileSizeText)}</span>
              ${it.categoryName ? `<span>·</span><span>${esc(it.categoryName)}</span>` : ''}
              <span>·</span><b>⬇ ${it.downloadCount}</b>
            </div>
          </div>
          <div class="files-actions">
            <button type="button" class="btn btn-sm btn-accent" data-file-download="${it.id}">⬇ ${esc(__('files.download'))}</button>
          </div>
        </div>`).join('');
      const pager = document.getElementById('filesPager');
      if (pager) pager.style.display = 'none';
      const bar = document.getElementById('filesBatchBar');
      if (bar) bar.style.display = 'none';
    } catch (e) {
      el.innerHTML = `<div class="text-muted2 p-16">${esc(__('files.load_failed'))}</div>`;
    }
  }

  // ---------- 我的收藏视图 ----------
  async function loadFavorites() {
    const el = document.getElementById('filesList');
    if (!el) return;
    el.innerHTML = `<div class="text-muted2 p-16">${esc(__('common.loading'))}</div>`;
    try {
      const res = await api('/api/group-files/favorites', { method: 'GET' });
      if (!res.ok) { el.innerHTML = `<div class="text-muted2 p-16">${esc(__('files.load_failed'))}</div>`; return; }
      const d = await res.json().catch(() => ({}));
      const items = d.items || [];
      if (!items.length) { el.innerHTML = `<div class="files-empty">${esc(__('files.fav_empty') || '还没有收藏任何文件')}</div>`; return; }
      el.innerHTML = items.map(it => `
        <div class="files-item" data-file-id="${it.id}">
          <div class="files-icon">${fileIcon(it.ext)}</div>
          <div class="files-main">
            <div class="files-title">${esc(it.title)} <span class="files-ver-badge">v${esc(it.version)}</span></div>
            <div class="files-meta">
              <span>${esc(it.fileName)}</span><span>·</span><span>${esc(it.fileSizeText)}</span>
              ${it.categoryName ? `<span>·</span><span>${esc(it.categoryName)}</span>` : ''}
              <span>·</span><span>⬇ ${it.downloadCount}</span>
            </div>
          </div>
          <div class="files-actions">
            <button type="button" class="btn btn-sm btn-accent" data-file-fav="${it.id}" title="${esc(__('files.unfavorite') || '取消收藏')}">★</button>
            <button type="button" class="btn btn-sm btn-accent" data-file-download="${it.id}">⬇ ${esc(__('files.download'))}</button>
          </div>
        </div>`).join('');
      const pager = document.getElementById('filesPager');
      if (pager) pager.style.display = 'none';
      const bar = document.getElementById('filesBatchBar');
      if (bar) bar.style.display = 'none';
    } catch (e) {
      el.innerHTML = `<div class="text-muted2 p-16">${esc(__('files.load_failed'))}</div>`;
    }
  }

  // ---------- 临时分享链接 ----------
  function ensureShareModal() {
    if (document.getElementById('filesShareModal')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'filesShareModal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 class="modal-title">🔗 ${esc(__('files.share') || '分享')}</h3>
          <button type="button" class="modal-close" data-modal-close="filesShareModal" aria-label="close">&times;</button>
        </div>
        <div class="modal-body">
          <p class="text-13 text-muted2">${esc(__('files.share_hint') || '生成临时链接，未登录用户也可凭链接下载。可设置有效期与下载次数上限。')}</p>
          <div class="flex-row gap-8 align-center mb-8" style="flex-wrap:wrap">
            <label class="text-13">${esc(__('files.share_expire') || '有效期')}</label>
            <select id="filesShareExpire" class="form-input" style="max-width:150px">
              <option value="1">1 ${esc(__('files.hour') || '小时')}</option>
              <option value="24" selected>1 ${esc(__('files.day') || '天')}</option>
              <option value="168">7 ${esc(__('files.day') || '天')}</option>
              <option value="720">30 ${esc(__('files.day') || '天')}</option>
            </select>
            <label class="text-13">${esc(__('files.share_max') || '次数上限')}</label>
            <input type="number" id="filesShareMax" class="form-input" style="max-width:110px" min="0" max="100000" value="0" placeholder="0=不限">
            <button type="button" class="btn btn-sm btn-accent" id="filesShareCreate">${esc(__('files.share_create') || '生成链接')}</button>
          </div>
          <div id="filesShareList"></div>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target && e.target.hasAttribute('data-modal-close')) closeModal('filesShareModal');
    });
    document.getElementById('filesShareCreate').addEventListener('click', createShareLink);
    // 复制链接
    el.addEventListener('click', (e) => {
      const cp = e.target && e.target.closest ? e.target.closest('[data-share-copy]') : null;
      if (cp) {
        const url = location.origin + cp.dataset.shareCopy;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(
            () => toast(__('files.copied') || '已复制', 'success'),
            () => toast(url, 'info')
          );
        } else {
          toast(url, 'info');
        }
        return;
      }
      const rv = e.target && e.target.closest ? e.target.closest('[data-share-revoke]') : null;
      if (rv) { revokeShareLink(rv.dataset.shareRevoke); }
    });
  }

  let _shareFileId = null;

  async function openShare(fileId) {
    ensureShareModal();
    _shareFileId = fileId;
    const box = document.getElementById('filesShareList');
    if (box) box.innerHTML = `<p class="text-muted2 text-13">${esc(__('common.loading'))}</p>`;
    showModal('filesShareModal');
    await loadShareList();
  }

  async function loadShareList() {
    const box = document.getElementById('filesShareList');
    if (!box || !_shareFileId) return;
    try {
      const res = await api('/api/group-files/' + encodeURIComponent(_shareFileId) + '/shares', { method: 'GET' });
      if (!res.ok) { box.innerHTML = `<p class="text-13">${esc(__('files.load_failed'))}</p>`; return; }
      const d = await res.json().catch(() => ({}));
      const links = d.links || [];
      if (!links.length) {
        box.innerHTML = `<p class="text-muted2 text-13">${esc(__('files.share_empty') || '还没有生成分享链接')}</p>`;
        return;
      }
      box.innerHTML = links.map(l => {
        const dead = l.isRevoked || l.expired || (l.maxDownloads > 0 && l.downloadCount >= l.maxDownloads);
        const status = l.isRevoked ? (__('files.share_revoked') || '已撤销')
          : l.expired ? (__('files.share_expired') || '已过期')
          : (l.maxDownloads > 0 && l.downloadCount >= l.maxDownloads) ? (__('files.share_exhausted') || '次数用尽')
          : (__('files.share_active') || '有效');
        return `
          <div class="files-share-row${dead ? ' dead' : ''}">
            <div class="files-share-main">
              <div class="text-12" style="word-break:break-all">${esc(l.url)}</div>
              <div class="text-12 text-muted2">
                ${esc(status)} · ${esc(__('files.share_used') || '已下载')} ${l.downloadCount}${l.maxDownloads > 0 ? '/' + l.maxDownloads : ''}
                · ${esc(__('files.share_expire_at') || '到期')} ${esc(fmtDateTime(l.expiresAt))}
                ${l.creatorName ? ' · ' + esc(l.creatorName) : ''}
              </div>
            </div>
            <button type="button" class="btn btn-sm btn-outline" data-share-copy="${escAttr(l.url)}">📋</button>
            ${!l.isRevoked ? `<button type="button" class="btn btn-sm btn-outline" data-share-revoke="${l.id}">${esc(__('files.share_revoke') || '撤销')}</button>` : ''}
          </div>`;
      }).join('');
    } catch (e) {
      box.innerHTML = `<p class="text-13">${esc(e.message)}</p>`;
    }
  }

  async function createShareLink() {
    if (!_shareFileId) return;
    const expireEl = document.getElementById('filesShareExpire');
    const maxEl = document.getElementById('filesShareMax');
    const expiresInHours = parseInt(expireEl ? expireEl.value : '24', 10) || 24;
    const maxDownloads = parseInt(maxEl ? maxEl.value : '0', 10) || 0;
    try {
      const res = await api('/api/group-files/' + encodeURIComponent(_shareFileId) + '/share', {
        method: 'POST', body: { expiresInHours, maxDownloads }
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast(errText(d) || __('files.share_failed') || '生成失败', 'error'); return; }
      const url = location.origin + d.url;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).catch(() => {});
      }
      toast((__('files.share_created') || '已生成并复制链接') + '：' + url, 'success');
      await loadShareList();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function revokeShareLink(linkId) {
    const okDel = await new Promise(r => showConfirm(
      __('files.share_revoke_confirm') || '撤销后该链接立即失效，确定吗？', () => r(true), () => r(false)));
    if (!okDel) return;
    try {
      const res = await api('/api/group-files/share/' + encodeURIComponent(linkId), { method: 'DELETE' });
      if (!res.ok) { toast(__('files.share_revoke_failed') || '撤销失败', 'error'); return; }
      toast(__('files.share_revoked_done') || '已撤销', 'success');
      await loadShareList();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- 版本历史弹窗 ----------
  function ensureVersionsModal() {
    if (document.getElementById('fileVersionsModal')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'fileVersionsModal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 class="modal-title">🕘 ${esc(__('files.versions') || '历史版本')}</h3>
          <button type="button" class="modal-close" data-modal-close="fileVersionsModal" aria-label="close">&times;</button>
        </div>
        <div class="modal-body" id="fileVersionsBody"></div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target && e.target.hasAttribute('data-modal-close')) closeModal('fileVersionsModal');
    });
  }

  async function showVersions(fileId) {
    ensureVersionsModal();
    const body = document.getElementById('fileVersionsBody');
    if (body) body.innerHTML = `<p class="text-muted2 text-13">${esc(__('common.loading'))}</p>`;
    showModal('fileVersionsModal');
    try {
      const res = await api('/api/group-files/' + encodeURIComponent(fileId) + '/versions', { method: 'GET' });
      if (!res.ok) { if (body) body.innerHTML = `<p class="text-muted2 text-13">${esc(__('files.load_failed'))}</p>`; return; }
      const d = await res.json().catch(() => ({}));
      const vs = d.versions || [];
      if (!vs.length) { if (body) body.innerHTML = `<p class="text-muted2 text-13">${esc(__('files.empty'))}</p>`; return; }
      if (body) body.innerHTML = vs.map(v => `
        <div class="files-ver-row">
          <span class="files-ver-tag${v.isLatest ? ' latest' : ''}">v${esc(v.version)}</span>
          <div class="files-ver-main">
            <div class="text-13" style="word-break:break-all">${esc(v.fileName)}</div>
            <div class="text-12 text-muted2">${esc(v.fileSizeText)} · ⬇ ${v.downloadCount} · ${esc(fmtDate(v.createdAt))}${v.uploaderName ? ' · ' + esc(v.uploaderName) : ''}${v.isLatest ? ' · <b>' + esc(__('files.latest') || '最新') + '</b>' : ''}</div>
          </div>
          <button type="button" class="btn btn-sm btn-accent" data-file-download="${v.id}">⬇</button>
        </div>`).join('');
    } catch (e) {
      if (body) body.innerHTML = `<p class="text-muted2 text-13">${esc(e.message)}</p>`;
    }
  }

  // ---------- 分类管理弹窗 ----------
  function ensureCatModal() {
    if (document.getElementById('fileCatModal')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'fileCatModal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 class="modal-title">🗂 ${esc(__('files.manage_cats'))}</h3>
          <button type="button" class="modal-close" data-modal-close="fileCatModal" aria-label="close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="flex-row gap-8 align-center mb-12" style="flex-wrap:wrap">
            <input type="text" id="fileCatName" class="form-input" style="max-width:200px" maxlength="100" placeholder="${escAttr(__('files.cat_name_ph'))}">
            <button type="button" class="btn btn-sm btn-accent" id="fileCatAdd">${esc(__('files.add_cat'))}</button>
          </div>
          <div id="fileCatList"></div>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target && e.target.hasAttribute('data-modal-close')) closeModal('fileCatModal');
    });
    document.getElementById('fileCatAdd').addEventListener('click', addCategory);
  }

  function renderCatMgr() {
    const box = document.getElementById('fileCatList');
    if (!box) return;
    if (!_filesState.categories.length) {
      box.innerHTML = `<p class="text-muted2 text-13">${esc(__('files.no_cats'))}</p>`;
      return;
    }
    box.innerHTML = _filesState.categories.map(c => `
      <div class="files-cat-row">
        <span class="files-cat-name">${esc(c.name)}</span>
        <span class="text-12 text-muted2">${c.fileCount || 0} ${esc(__('files.files_unit'))}</span>
        <button type="button" class="btn btn-sm btn-outline" data-cat-del="${c.id}">${esc(__('common.delete'))}</button>
      </div>`).join('');
  }

  async function addCategory() {
    const input = document.getElementById('fileCatName');
    const name = input ? input.value.trim() : '';
    if (!name) { toast(__('files.cat_name_ph'), 'error'); return; }
    try {
      const res = await api('/api/group-files/categories', { method: 'POST', body: { name } });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast(errText(d) || __('files.add_cat_failed'), 'error'); return; }
      if (input) input.value = '';
      toast(__('files.cat_added'), 'success');
      await loadCategories();
      renderCatMgr();
      fillUploadCats();
    } catch (e) { toast(e.message || __('files.add_cat_failed'), 'error'); }
  }

  async function deleteCategory(id) {
    const okDel = await new Promise((resolve) => {
      showConfirm(__('files.confirm_del_cat'), () => resolve(true), () => resolve(false));
    });
    if (!okDel) return;
    try {
      const res = await api('/api/group-files/categories/' + id, { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast(errText(d) || __('files.del_cat_failed'), 'error'); return; }
      toast(__('files.deleted'), 'success');
      await loadCategories();
      renderCatMgr();
      fillUploadCats();
      if (String(_filesState.categoryId) === String(id)) { _filesState.categoryId = ''; renderCatBar(); loadFiles(1); }
    } catch (e) { toast(e.message || __('files.del_cat_failed'), 'error'); }
  }

  // ---------- 事件绑定 ----------
  function bindOnce() {
    const root = document.getElementById('tab-files');
    if (!root || root.dataset.bound) return;
    root.dataset.bound = '1';

    root.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const chip = t.closest('.files-cat-chip');
      if (chip) {
        _filesState.categoryId = chip.dataset.cat || '';
        renderCatBar();
        loadFiles(1);
        return;
      }
      const dl = t.closest('[data-file-download]');
      if (dl) { downloadFile(dl.dataset.fileDownload); return; }
      const del = t.closest('[data-file-delete]');
      if (del) { deleteFile(del.dataset.fileDelete); return; }
      const ver = t.closest('[data-file-versions]');
      if (ver) { showVersions(ver.dataset.fileVersions); return; }
      const edit = t.closest('[data-file-edit]');
      if (edit) { openEdit(edit.dataset.fileEdit); return; }
      const fav = t.closest('[data-file-fav]');
      if (fav) { toggleFavorite(fav.dataset.fileFav); return; }
      const share = t.closest('[data-file-share]');
      if (share) { openShare(share.dataset.fileShare); return; }
      const catDel = t.closest('[data-cat-del]');
      if (catDel) { deleteCategory(catDel.dataset.catDel); return; }
    });

    const search = document.getElementById('filesSearch');
    if (search) {
      let timer = null;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { _filesState.q = search.value.trim(); loadFiles(1); }, 300);
      });
    }
    const upBtn = document.getElementById('filesUploadBtn');
    if (upBtn) upBtn.addEventListener('click', () => {
      ensureUploadModal();
      fillUploadCats();
      const catEl = document.getElementById('fileUploadCat');
      if (catEl && _filesState.categoryId !== '') catEl.value = _filesState.categoryId;
      showModal('fileUploadModal');
    });
    const catBtn = document.getElementById('filesCatMgrBtn');
    if (catBtn) catBtn.addEventListener('click', () => {
      ensureCatModal();
      renderCatMgr();
      showModal('fileCatModal');
    });
    // 管理员：跳到后台「文件存放管理」（uploads 目录运维）
    const storageBtn = document.getElementById('filesStorageBtn');
    if (storageBtn) storageBtn.addEventListener('click', () => {
      if (typeof window.switchTab === 'function') window.switchTab('admin', true);
      setTimeout(() => {
        const nav = document.querySelector('.admin-nav-item[data-target="files"]');
        if (nav) nav.click();
      }, 400);
    });
    const prev = document.getElementById('filesPrev');
    if (prev) prev.addEventListener('click', () => loadFiles(_filesState.page - 1));
    const next = document.getElementById('filesNext');
    if (next) next.addEventListener('click', () => loadFiles(_filesState.page + 1));

    // 视图切换（列表 / 下载排行 / 我的收藏）
    root.addEventListener('click', (e) => {
      const tab = e.target && e.target.closest ? e.target.closest('[data-files-view]') : null;
      if (!tab) return;
      const view = tab.dataset.filesView;
      _filesState.view = view;
      document.querySelectorAll('[data-files-view]').forEach(b => {
        b.classList.toggle('active', b.dataset.filesView === view);
      });
      // 排行榜/收藏视图隐藏分类栏与批量栏
      const catBar = document.getElementById('filesCatBar');
      if (catBar) catBar.style.display = view === 'list' ? '' : 'none';
      if (view === 'ranking') loadRanking();
      else if (view === 'favorites') loadFavorites();
      else loadFiles(1);
    });

    // 批量选择
    root.addEventListener('change', (e) => {
      if (e.target && e.target.matches('[data-file-check]')) renderBatchBar();
    });
    const moveBtn = document.getElementById('filesBatchMove');
    if (moveBtn) moveBtn.addEventListener('click', () => {
      ensureBatchMoveModal();
      const sel = document.getElementById('filesBatchTargetCat');
      if (sel) {
        sel.innerHTML = `<option value="">${esc(__('files.uncategorized'))}</option>` +
          _filesState.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      }
      showModal('filesBatchMoveModal');
    });
    const clearBtn = document.getElementById('filesBatchClear');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      document.querySelectorAll('[data-file-check]:checked').forEach(el => { el.checked = false; });
      renderBatchBar();
    });
    // 维护面板
    const maintBtn = document.getElementById('filesMaintBtn');
    if (maintBtn) maintBtn.addEventListener('click', () => {
      ensureMaintenanceModal();
      const box = document.getElementById('filesMaintResult');
      if (box) box.innerHTML = '';
      showModal('filesMaintModal');
    });
  }

  // 进入 Tab 时初始化（loader 懒加载该模块后调用）
  async function init() {
    const root = document.getElementById('tab-files');
    if (!root) return;
    bindOnce();
    // 管理员按钮显示控制
    const adminBtns = root.querySelectorAll('[data-admin-only]');
    adminBtns.forEach(b => { b.hidden = !isAdmin(); });
    await loadCategories();
    renderCatBar();
    await loadFiles(1);
  }

  window.filesModule = { init, reload: () => { loadCategories(); loadFiles(_filesState.page); } };
})();
