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

  let _filesState = { categories: [], categoryId: '', q: '', page: 1, pageSize: 20, totalPages: 1 };
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
        return `
          <div class="files-item" data-file-id="${f.id}">
            <div class="files-icon">${icon}</div>
            <div class="files-main">
              <div class="files-title">${esc(f.title)}</div>
              ${f.description ? `<div class="files-desc">${esc(f.description)}</div>` : ''}
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
              <button type="button" class="btn btn-sm btn-accent" data-file-download="${f.id}">⬇ ${esc(__('files.download'))}</button>
              ${canDel ? `<button type="button" class="btn btn-sm btn-outline" data-file-delete="${f.id}">${esc(__('common.delete'))}</button>` : ''}
            </div>
          </div>`;
      }).join('');
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
  }

  function fillUploadCats() {
    const sel = document.getElementById('fileUploadCat');
    if (!sel) return;
    sel.innerHTML = `<option value="">${esc(__('files.uncategorized'))}</option>` +
      _filesState.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }

  async function doUpload() {
    if (_uploading) return;
    const input = document.getElementById('fileUploadInput');
    const titleEl = document.getElementById('fileUploadTitle');
    const catEl = document.getElementById('fileUploadCat');
    const descEl = document.getElementById('fileUploadDesc');
    const prog = document.getElementById('fileUploadProgress');
    const btn = document.getElementById('fileUploadSubmit');
    if (!input || !input.files || !input.files.length) { toast(__('files.pick_file_first'), 'error'); return; }
    const file = input.files[0];

    const fd = new FormData();
    fd.append('file', file);
    fd.append('title', (titleEl && titleEl.value.trim()) || file.name);
    fd.append('categoryId', catEl ? catEl.value : '');
    fd.append('description', descEl ? descEl.value.trim() : '');

    _uploading = true;
    if (btn) btn.disabled = true;
    if (prog) { prog.style.display = ''; prog.textContent = __('files.uploading'); }
    try {
      // 复用 core.js 的 apiForm（内部 XHR 带 CSRF + 统一 401/403/429/500 处理），
      // 避免自造上传通道导致会话过期时行为不一致。
      let res;
      try {
        res = await apiForm('/api/group-files/upload', fd, { timeout: 600000 });
      } catch (e) {
        // apiForm 已 toast 过网络/权限类错误，这里只补业务文案
        throw new Error(e && e.message && e.message !== 'UNAUTHORIZED' && e.message !== 'FORBIDDEN'
          ? e.message : __('files.upload_failed'));
      }
      if (!res || !res.ok) {
        let msg = __('files.upload_failed');
        try { const d = await res.json(); msg = errText(d) || msg; } catch (e) { /* ignore */ }
        throw new Error(msg);
      }
      toast(__('files.upload_ok'), 'success');
      closeModal('fileUploadModal');
      if (input) input.value = '';
      if (titleEl) titleEl.value = '';
      if (descEl) descEl.value = '';
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
