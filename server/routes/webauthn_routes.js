/**
 * WebAuthn 通行密钥路由
 *
 * 注册（需登录）：/webauthn/register/options → /webauthn/register/verify
 * 登录（免登录）：/webauthn/login/options    → /webauthn/login/verify
 * 管理（需登录）：GET/DELETE /webauthn/credentials
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { getPool, sendError, handleError, ErrorCodes, ok, logOper } = require('../utils');
const { requireAuth } = require('../auth');
const webauthn = require('../webauthn');
const logger = require('../logger');

module.exports = function () {
  const router = express.Router();

  // 登录接口限流（防爆破；WebAuthn 本身抗爆破，但仍限制调用频率）
  const loginLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    // 必须走 ipKeyGenerator 处理 IPv6，否则 express-rate-limit 判定可绕过并拒绝启动
    keyGenerator: (req) => `wa_${rateLimit.ipKeyGenerator(req.ip)}`
  });

  /** 环境自检：WebAuthn 只在 HTTPS / localhost 下可用 */
  router.get('/status', async (req, res) => {
    try {
      const { rpId, origin } = webauthn.resolveRp(req);
      const supported = webauthn.isSecureContext(req);
      let myCount = 0;
      if (req.session && req.session.userId) {
        const [[row]] = await getPool().query(
          'SELECT COUNT(*) AS c FROM webauthn_credentials WHERE user_id = ?', [req.session.userId]
        );
        myCount = Number(row && row.c) || 0;
      }
      res.json({
        supported,
        rpId,
        origin,
        myCredentialCount: myCount,
        reason: supported ? '' : 'WebAuthn 需要 HTTPS 或 localhost 访问（浏览器安全限制）'
      });
    } catch (e) { handleError(res, e, '[webauthn/status]'); }
  });

  // ==================== 注册（已登录用户添加通行密钥） ====================
  router.post('/register/options', requireAuth, async (req, res) => {
    try {
      if (!webauthn.isSecureContext(req)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST,
          'WebAuthn 需要 HTTPS 或 localhost 访问，当前环境不支持');
      }
      const pool = getPool();
      const uid = req.session.userId;
      const [[user]] = await pool.query(
        'SELECT id, login_id, display_name FROM users WHERE id = ? AND deleted_at IS NULL', [uid]
      );
      if (!user) return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
      const [existing] = await pool.query(
        'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?', [uid]
      );
      const options = await webauthn.buildRegistrationOptions(req, user, existing);
      ok(res, { options });
    } catch (e) { handleError(res, e, '[webauthn/register/options]'); }
  });

  router.post('/register/verify', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const response = body.response || body.credential;
      if (!response || !response.id) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '缺少认证器响应');
      }
      const uid = req.session.userId;
      const result = await webauthn.verifyRegistration(req, response, uid);
      if (!result.ok) return sendError(res, 400, ErrorCodes.BAD_REQUEST, result.reason);

      const row = webauthn.toRow(uid, result.registrationInfo, body.transports,
        body.name || webauthn.suggestName(req.headers['user-agent']));
      const pool = getPool();
      try {
        await pool.query(
          `INSERT INTO webauthn_credentials
             (user_id, credential_id, public_key, counter, transports, device_type, backed_up, aaguid, name)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [row.user_id, row.credential_id, row.public_key, row.counter, row.transports,
            row.device_type, row.backed_up, row.aaguid, row.name]
        );
      } catch (e) {
        if (e && (e.errno === 1062 || e.code === 'ER_DUP_ENTRY')) {
          return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该通行密钥已注册过了');
        }
        throw e;
      }
      try { await logOper(uid, '添加通行密钥', row.name); } catch (e) { /* ignore */ }
      ok(res, { message: '通行密钥已添加', name: row.name });
    } catch (e) { handleError(res, e, '[webauthn/register/verify]'); }
  });

  // ==================== 登录（未登录可用） ====================
  // body.loginId 可选：给了就只允许该用户名下的凭据（更安全）；不给则允许任意可发现凭据
  router.post('/login/options', loginLimiter, async (req, res) => {
    try {
      if (!webauthn.isSecureContext(req)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST,
          'WebAuthn 需要 HTTPS 或 localhost 访问，当前环境不支持');
      }
      const pool = getPool();
      const loginId = String((req.body && req.body.loginId) || '').trim();
      let creds = [];
      let uid = null;
      if (loginId) {
        const [[user]] = await pool.query(
          `SELECT id FROM users WHERE (login_id = ? OR display_name = ?)
             AND deleted_at IS NULL AND approved = 1 AND banned = 0`, [loginId, loginId]
        );
        if (!user) return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在或不可用');
        uid = user.id;
        const [rows] = await pool.query(
          'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?', [uid]
        );
        creds = rows;
        if (!creds.length) {
          return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该账户还没有绑定通行密钥');
        }
      } else {
        // 无用户名：允许浏览器列出所有可发现凭据（resident key）
        const [rows] = await pool.query(
          `SELECT w.credential_id, w.transports FROM webauthn_credentials w
           JOIN users u ON u.id = w.user_id
           WHERE u.deleted_at IS NULL AND u.approved = 1 AND u.banned = 0 LIMIT 50`
        );
        creds = rows;
        if (!creds.length) {
          return sendError(res, 400, ErrorCodes.BAD_REQUEST, '本站还没有任何已绑定的通行密钥');
        }
      }
      const options = await webauthn.buildAuthenticationOptions(req, creds, uid);
      ok(res, { options });
    } catch (e) { handleError(res, e, '[webauthn/login/options]'); }
  });

  router.post('/login/verify', loginLimiter, async (req, res) => {
    try {
      const body = req.body || {};
      const response = body.response || body.credential;
      if (!response || !response.id) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '缺少认证器响应');
      }
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT w.*, u.login_id, u.display_name, u.role, u.approved, u.banned, u.deleted_at
         FROM webauthn_credentials w JOIN users u ON u.id = w.user_id
         WHERE w.credential_id = ?`, [response.id]
      );
      if (!rows.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '该通行密钥未注册');
      const cred = rows[0];
      if (cred.deleted_at) return sendError(res, 403, ErrorCodes.FORBIDDEN, '账户已注销');
      if (!cred.approved) return sendError(res, 403, ErrorCodes.FORBIDDEN, '账户尚未通过审核');
      if (cred.banned) return sendError(res, 403, ErrorCodes.FORBIDDEN, '账户已被封禁');

      const result = await webauthn.verifyAuthentication(req, response, cred);
      if (!result.ok) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, result.reason);

      // counter 单调递增：新值不大于旧值可能是认证器被克隆
      if (result.newCounter > 0 && Number(cred.counter) > 0 && result.newCounter <= Number(cred.counter)) {
        logger.warn('webauthn', `计数器未递增，疑似克隆：user=${cred.user_id} old=${cred.counter} new=${result.newCounter}`);
        return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '认证器计数器异常，已拒绝本次登录');
      }
      await pool.query(
        'UPDATE webauthn_credentials SET counter = ?, last_used_at = NOW() WHERE id = ?',
        [result.newCounter, cred.id]
      );

      // 建立会话
      req.session.userId = cred.user_id;
      req.session.loginId = cred.login_id;
      req.session.displayName = cred.display_name;
      req.session.role = cred.role;
      req.session.loginAt = Date.now();
      try { await logOper(cred.user_id, '通行密钥登录', cred.name || ''); } catch (e) { /* ignore */ }

      ok(res, {
        userId: cred.user_id,
        loginId: cred.login_id,
        displayName: cred.display_name,
        role: cred.role
      });
    } catch (e) { handleError(res, e, '[webauthn/login/verify]'); }
  });

  // ==================== 凭据管理 ====================
  router.get('/credentials', requireAuth, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT id, credential_id, name, device_type, backed_up, transports, created_at, last_used_at
         FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC`,
        [req.session.userId]
      );
      res.json({
        credentials: rows.map(r => ({
          id: r.id,
          name: r.name || '通行密钥',
          deviceType: r.device_type || '',
          backedUp: !!r.backed_up,
          transports: r.transports || '',
          createdAt: r.created_at,
          lastUsedAt: r.last_used_at
        }))
      });
    } catch (e) { handleError(res, e, '[webauthn/credentials]'); }
  });

  router.delete('/credentials/:id', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const [r] = await getPool().query(
        'DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?',
        [id, req.session.userId]
      );
      if (!r.affectedRows) return sendError(res, 404, ErrorCodes.NOT_FOUND, '凭据不存在');
      try { await logOper(req.session.userId, '删除通行密钥', `#${id}`); } catch (e) { /* ignore */ }
      ok(res, { message: '已删除' });
    } catch (e) { handleError(res, e, '[webauthn/credentials/delete]'); }
  });

  return router;
};
