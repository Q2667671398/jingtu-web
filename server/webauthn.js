/**
 * WebAuthn 通行密钥（Passkey）服务
 *
 * 用途：让网站**原生调用**浏览器认证器完成登录/二次验证——
 * 用户点按钮 → Windows Hello / 指纹 / 面容 / 手机确认 → 直接通过，
 * 无需像 TOTP 那样手输 6 位验证码，且天然抗钓鱼（凭据绑定域名）。
 *
 * 与「浏览器扩展」的区别（重要）：
 *   扩展运行在隔离环境，网页 JS 无权调用它；而 WebAuthn 是浏览器**原生标准 API**
 *   （navigator.credentials.create/get），网站可以合法调用。
 *
 * 安全实现要点：
 *   1. 挑战（challenge）随机、一次性、短时效，存 session，用完即删
 *   2. 严格校验 origin 与 RP ID
 *   3. counter 必须单调递增（检测认证器克隆）
 *   4. 私钥永不离开认证器；服务端只存公钥
 */
const crypto = require('crypto');
const logger = require('./logger');

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');

const RP_NAME = '境途同游';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * 从请求推断 RP ID 与 origin。
 * - RP ID 必须是当前站点的**有效域名后缀**（localhost 可直接用 localhost）
 * - WebAuthn 只在 HTTPS 或 localhost 下可用（浏览器强制）
 */
function resolveRp(req) {
  const host = String(req.headers.host || '').trim();
  const hostname = host.replace(/:\d+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  // 反代常见：x-forwarded-host
  const fwdHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const rpId = (fwdHost || hostname || 'localhost').replace(/:\d+$/, '');
  const origin = `${proto}://${fwdHost || host}`;
  return { rpId, origin, rpName: RP_NAME };
}

/** 判断当前请求环境是否支持 WebAuthn（HTTPS 或 localhost） */
function isSecureContext(req) {
  const { rpId, origin } = resolveRp(req);
  const isLocal = rpId === 'localhost' || rpId === '127.0.0.1' || rpId === '[::1]';
  return origin.startsWith('https://') || isLocal;
}

/** 生成并暂存一次性挑战 */
function stashChallenge(req, challenge, extra = {}) {
  if (!req.session) return;
  req.session.webauthnChallenge = {
    challenge,
    createdAt: Date.now(),
    ...extra
  };
}

/** 取出并清除挑战（一次性，防重放） */
function takeChallenge(req, expectedKind) {
  const s = req.session && req.session.webauthnChallenge;
  if (!s) return { ok: false, reason: '挑战不存在或已使用，请重试' };
  if (Date.now() - Number(s.createdAt || 0) > CHALLENGE_TTL_MS) {
    delete req.session.webauthnChallenge;
    return { ok: false, reason: '挑战已过期，请重试' };
  }
  if (expectedKind && s.kind && s.kind !== expectedKind) {
    return { ok: false, reason: '挑战类型不匹配' };
  }
  delete req.session.webauthnChallenge;
  return { ok: true, challenge: s.challenge, data: s };
}

/** 把认证器返回的凭据字段整理成入库行 */
function toRow(userId, regInfo, transports, name) {
  const c = regInfo.credential;
  return {
    user_id: userId,
    credential_id: c.id,
    public_key: Buffer.from(c.publicKey).toString('base64'),
    counter: Number(c.counter) || 0,
    transports: Array.isArray(transports) ? transports.join(',') : '',
    device_type: regInfo.credentialDeviceType || '',
    backed_up: regInfo.credentialBackedUp ? 1 : 0,
    aaguid: regInfo.aaguid || '',
    name: String(name || '').slice(0, 100) || '我的通行密钥'
  };
}

/** 生成注册选项 */
async function buildRegistrationOptions(req, user, existingCredentials) {
  const { rpId, rpName } = resolveRp(req);
  const opts = await generateRegistrationOptions({
    rpName,
    rpID: rpId,
    userID: Buffer.from(String(user.id)),
    userName: user.loginId || user.login_id || `user-${user.id}`,
    userDisplayName: user.displayName || user.display_name || '',
    attestationType: 'none',
    excludeCredentials: (existingCredentials || []).map(c => ({
      id: c.credential_id,
      transports: c.transports ? c.transports.split(',').filter(Boolean) : undefined
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred'
    }
  });
  stashChallenge(req, opts.challenge, { kind: 'register', userId: user.id });
  return opts;
}

/** 验证注册响应 */
async function verifyRegistration(req, response, expectedUserId) {
  const { rpId, origin } = resolveRp(req);
  const ch = takeChallenge(req, 'register');
  if (!ch.ok) return { ok: false, reason: ch.reason };
  if (Number(ch.data.userId) !== Number(expectedUserId)) {
    return { ok: false, reason: '挑战与当前用户不匹配' };
  }
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: false
    });
    if (!result.verified) return { ok: false, reason: '验证未通过' };
    return { ok: true, registrationInfo: result.registrationInfo };
  } catch (e) {
    logger.warn('webauthn', '注册验证失败:', e && e.message);
    return { ok: false, reason: '验证失败：' + (e && e.message ? e.message : '未知错误') };
  }
}

/** 生成登录选项 */
async function buildAuthenticationOptions(req, credentials, userId) {
  const { rpId } = resolveRp(req);
  const opts = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: (credentials || []).map(c => ({
      id: c.credential_id,
      transports: c.transports ? c.transports.split(',').filter(Boolean) : undefined
    })),
    userVerification: 'preferred'
  });
  stashChallenge(req, opts.challenge, { kind: 'login', userId: userId || null });
  return opts;
}

/** 验证登录响应 */
async function verifyAuthentication(req, response, credentialRow) {
  const { rpId, origin } = resolveRp(req);
  const ch = takeChallenge(req, 'login');
  if (!ch.ok) return { ok: false, reason: ch.reason };
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: {
        id: credentialRow.credential_id,
        publicKey: Buffer.from(credentialRow.public_key, 'base64'),
        counter: Number(credentialRow.counter) || 0,
        transports: credentialRow.transports ? credentialRow.transports.split(',').filter(Boolean) : undefined
      },
      requireUserVerification: false
    });
    if (!result.verified) return { ok: false, reason: '验证未通过' };
    return { ok: true, newCounter: Number(result.authenticationInfo.newCounter) || 0 };
  } catch (e) {
    logger.warn('webauthn', '认证验证失败:', e && e.message);
    return { ok: false, reason: '验证失败：' + (e && e.message ? e.message : '未知错误') };
  }
}

/** 生成用于展示的随机友好名称建议 */
function suggestName(ua) {
  const s = String(ua || '');
  if (/Windows/i.test(s)) return 'Windows 设备';
  if (/Macintosh|Mac OS/i.test(s)) return 'Mac 设备';
  if (/Android/i.test(s)) return 'Android 设备';
  if (/iPhone|iPad/i.test(s)) return 'iPhone / iPad';
  if (/Linux/i.test(s)) return 'Linux 设备';
  return '通行密钥';
}

module.exports = {
  resolveRp,
  isSecureContext,
  buildRegistrationOptions,
  verifyRegistration,
  buildAuthenticationOptions,
  verifyAuthentication,
  toRow,
  suggestName,
  CHALLENGE_TTL_MS,
  _internal: { stashChallenge, takeChallenge, crypto }
};
