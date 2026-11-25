/**
 * webauthn-client.js — 通行密钥（Passkey）前端
 *
 * 与「浏览器扩展」的本质区别：
 *   扩展运行在隔离沙箱，网页 JS 无权调用；而 WebAuthn 是浏览器**原生标准 API**
 *   （navigator.credentials.create / get），网站可以合法调用，
 *   用户点按钮后由系统弹窗（Windows Hello / 触控 ID / 手机）完成认证。
 *
 * 依赖：core.js 的 api / toast / __
 */
(function () {
  'use strict';

  const b64urlToBuf = (s) => {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  };

  const bufToB64url = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  /** 浏览器是否支持 WebAuthn（还需 HTTPS/localhost，由后端 /status 判定） */
  function supported() {
    return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
  }

  /** 是否在安全上下文（HTTPS / localhost） */
  function secureContext() {
    return window.isSecureContext === true;
  }

  /**
   * 把服务端 options 里的 base64url 字段转成 ArrayBuffer。
   * @simplewebauthn 浏览器端有官方转换函数，但这里只依赖后端库，
   * 前端手写转换避免再引一个包（逻辑很短且可测）。
   */
  function prepareCreationOptions(options) {
    const o = JSON.parse(JSON.stringify(options));
    o.challenge = b64urlToBuf(o.challenge);
    if (o.user && o.user.id) o.user.id = b64urlToBuf(o.user.id);
    if (Array.isArray(o.excludeCredentials)) {
      o.excludeCredentials = o.excludeCredentials.map((c) => ({
        ...c,
        id: b64urlToBuf(c.id)
      }));
    }
    return o;
  }

  function prepareRequestOptions(options) {
    const o = JSON.parse(JSON.stringify(options));
    o.challenge = b64urlToBuf(o.challenge);
    if (Array.isArray(o.allowCredentials)) {
      o.allowCredentials = o.allowCredentials.map((c) => ({
        ...c,
        id: b64urlToBuf(c.id)
      }));
    }
    return o;
  }

  /** 把认证器返回值序列化成后端可验证的 JSON */
  function serializeRegistration(cred) {
    return {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
        attestationObject: bufToB64url(cred.response.attestationObject),
        transports: cred.response.getTransports ? cred.response.getTransports() : undefined
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}
    };
  }

  function serializeAuthentication(cred) {
    return {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
        authenticatorData: bufToB64url(cred.response.authenticatorData),
        signature: bufToB64url(cred.response.signature),
        userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : undefined
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}
    };
  }

  // ==================== 注册通行密钥 ====================
  async function registerPasskey(name) {
    if (!supported()) throw new Error(__('webauthn.unsupported') || '当前浏览器不支持通行密钥');
    const optRes = await api('/api/auth/webauthn/register/options', { method: 'POST' });
    const optData = await optRes.json().catch(() => ({}));
    if (!optRes.ok) throw new Error(errText(optData) || __('webauthn.register_failed') || '获取注册选项失败');

    const publicKey = prepareCreationOptions(optData.options);
    let cred;
    try {
      cred = await navigator.credentials.create({ publicKey });
    } catch (e) {
      // 用户取消 / 超时
      if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
        throw new Error(__('webauthn.cancelled') || '已取消');
      }
      throw e;
    }
    if (!cred) throw new Error(__('webauthn.cancelled') || '已取消');

    const payload = serializeRegistration(cred);
    const verRes = await api('/api/auth/webauthn/register/verify', {
      method: 'POST',
      body: { response: payload, name: name || '', transports: payload.response.transports }
    });
    const verData = await verRes.json().catch(() => ({}));
    if (!verRes.ok) throw new Error(errText(verData) || __('webauthn.register_failed') || '注册失败');
    return verData;
  }

  // ==================== 用通行密钥登录 ====================
  async function loginWithPasskey(loginId) {
    if (!supported()) throw new Error(__('webauthn.unsupported') || '当前浏览器不支持通行密钥');
    const optRes = await api('/api/auth/webauthn/login/options', {
      method: 'POST',
      body: { loginId: loginId || '' }
    });
    const optData = await optRes.json().catch(() => ({}));
    if (!optRes.ok) throw new Error(errText(optData) || __('webauthn.no_credential') || '无法开始通行密钥登录');

    const publicKey = prepareRequestOptions(optData.options);
    let assertion;
    try {
      assertion = await navigator.credentials.get({ publicKey });
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
        throw new Error(__('webauthn.cancelled') || '已取消');
      }
      throw e;
    }
    if (!assertion) throw new Error(__('webauthn.cancelled') || '已取消');

    const payload = serializeAuthentication(assertion);
    const verRes = await api('/api/auth/webauthn/login/verify', {
      method: 'POST', body: { response: payload }
    });
    const verData = await verRes.json().catch(() => ({}));
    if (!verRes.ok) throw new Error(errText(verData) || __('webauthn.login_failed') || '登录失败');
    return verData;
  }

  // ==================== 绑定按钮 ====================
  function bindLoginButton() {
    const btn = document.getElementById('loginPasskeyBtn');
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    // 仅当浏览器支持 + 安全上下文 + 后端报告有可用凭据时才显示
    (async () => {
      if (!supported() || !secureContext()) return;
      try {
        const res = await api('/api/auth/webauthn/status', { method: 'GET' });
        if (!res.ok) return;
        const d = await res.json().catch(() => ({}));
        if (d && d.supported) btn.classList.remove('d-none');
      } catch (e) { /* 静默：不支持就不显示按钮 */ }
    })();

    btn.addEventListener('click', async () => {
      const idEl = document.getElementById('loginId');
      const loginId = idEl ? idEl.value.trim() : '';
      btn.disabled = true;
      try {
        const r = await loginWithPasskey(loginId);
        toast(__('webauthn.login_ok') || '登录成功', 'success');
        if (typeof onLoginSuccess === 'function') onLoginSuccess(r);
        else location.reload();
      } catch (e) {
        toast(e.message || __('webauthn.login_failed') || '登录失败', 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindLoginButton);
  } else {
    bindLoginButton();
  }

  // ==================== 设置页：凭据管理 ====================
  async function loadCredentialList() {
    const card = document.getElementById('passkeySettingsCard');
    if (!card) return;
    const statusEl = document.getElementById('passkeyStatus');
    const listEl = document.getElementById('passkeyList');
    const unsupEl = document.getElementById('passkeyUnsupported');
    const addBtn = document.getElementById('passkeyAddBtn');

    if (!supported()) {
      if (statusEl) statusEl.classList.add('d-none');
      if (unsupEl) {
        unsupEl.classList.remove('d-none');
        unsupEl.textContent = __('webauthn.browser_unsupported') || '当前浏览器不支持通行密钥';
      }
      if (addBtn) addBtn.disabled = true;
      return;
    }
    // 后端会告知是否 HTTPS/localhost（WebAuthn 硬性要求）
    try {
      const stRes = await api('/api/auth/webauthn/status', { method: 'GET' });
      const st = await stRes.json().catch(() => ({}));
      if (st && st.supported === false) {
        if (statusEl) statusEl.classList.add('d-none');
        if (unsupEl) {
          unsupEl.classList.remove('d-none');
          unsupEl.textContent = st.reason || (__('webauthn.need_https') || '需要 HTTPS 或 localhost 访问');
        }
        if (addBtn) addBtn.disabled = true;
        return;
      }
    } catch (e) { /* 忽略：继续尝试读列表 */ }

    try {
      const res = await api('/api/auth/webauthn/credentials', { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      const list = d.credentials || [];
      if (statusEl) {
        statusEl.textContent = list.length
          ? (__('webauthn.count') || '已绑定 {n} 个通行密钥').replace('{n}', list.length)
          : (__('webauthn.none') || '还没有绑定通行密钥');
      }
      if (listEl) {
        listEl.innerHTML = list.map((c) => {
          const meta = [];
          if (c.deviceType === 'multiDevice') meta.push(__('webauthn.synced') || '可同步');
          if (c.backedUp) meta.push(__('webauthn.backed_up') || '已备份');
          if (c.lastUsedAt) meta.push((__('webauthn.last_used') || '上次使用 {t}').replace('{t}', fmtDate(c.lastUsedAt)));
          return `<div class="passkey-row">
            <span class="passkey-icon">🔑</span>
            <div class="passkey-main">
              <div class="text-13">${esc(c.name)}</div>
              <div class="text-12 text-muted2">${esc(meta.join(' · '))}${meta.length ? '' : esc(fmtDate(c.createdAt))}</div>
            </div>
            <button type="button" class="btn btn-sm btn-outline" data-passkey-del="${c.id}">${esc(__('common.delete'))}</button>
          </div>`;
        }).join('');
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = e.message || '';
    }
  }

  function bindSettingsCard() {
    const card = document.getElementById('passkeySettingsCard');
    if (!card || card.dataset.bound === '1') return;
    card.dataset.bound = '1';

    const addBtn = document.getElementById('passkeyAddBtn');
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        const nameEl = document.getElementById('passkeyName');
        const name = nameEl ? nameEl.value.trim() : '';
        addBtn.disabled = true;
        addBtn.textContent = (__('webauthn.waiting') || '请在弹出的系统窗口中确认…');
        try {
          await registerPasskey(name);
          toast(__('webauthn.add_ok') || '通行密钥已添加', 'success');
          if (nameEl) nameEl.value = '';
          await loadCredentialList();
        } catch (e) {
          toast(e.message || (__('webauthn.register_failed') || '添加失败'), 'error');
        } finally {
          addBtn.disabled = false;
          addBtn.textContent = (__('webauthn.add') || '添加通行密钥');
        }
      });
    }

    card.addEventListener('click', async (e) => {
      const del = e.target && e.target.closest ? e.target.closest('[data-passkey-del]') : null;
      if (!del) return;
      const confirmFn = typeof showConfirm === 'function' ? showConfirm : null;
      const asked = confirmFn
        ? await new Promise((resolve) => confirmFn(
            __('webauthn.del_confirm') || '删除后该设备将无法用于登录，确定吗？',
            () => resolve(true), () => resolve(false)))
        : window.confirm(__('webauthn.del_confirm') || '确定删除？');
      if (!asked) return;
      try {
        const res = await api('/api/auth/webauthn/credentials/' + encodeURIComponent(del.dataset.passkeyDel), { method: 'DELETE' });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          toast(errText(d) || (__('webauthn.del_failed') || '删除失败'), 'error');
          return;
        }
        toast(__('webauthn.del_ok') || '已删除', 'success');
        await loadCredentialList();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  // 切到「我的」页或点侧栏「通行密钥」时加载
  function refreshSettings() {
    bindSettingsCard();
    loadCredentialList();
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
      // 侧栏导航点击后重新拉一次（元素可能刚被显示）
      document.addEventListener('click', (e) => {
        const nav = e.target && e.target.closest ? e.target.closest('[data-me-target="passkeySettingsCard"]') : null;
        if (nav) setTimeout(refreshSettings, 50);
      });
    });
  }

  window.webauthnClient = {
    supported, secureContext,
    registerPasskey, loginWithPasskey,
    bindLoginButton, loadCredentialList, refreshSettings,
    _internal: { b64urlToBuf, bufToB64url, prepareCreationOptions, prepareRequestOptions, serializeRegistration, serializeAuthentication }
  };
})();
