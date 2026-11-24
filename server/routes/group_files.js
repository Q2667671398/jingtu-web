/**
 * 境途同游 — 群组文件库路由（安装包/工具分发）
 *
 * 场景：管理员创建分类并上传安装包等文件，登录成员浏览下载。
 * 设计要点：
 *  - 文件落盘 uploads/files/，文件名随机化（stored_name），**不暴露静态直链**；
 *    下载统一走 /api/files/:id/download（鉴权 + 次数统计 + 强制 attachment）。
 *  - 上传限 2GB，用 multer diskStorage 直接写盘（不占内存）；流式 SHA256 计算完整性。
 *  - 拒绝危险可执行脚本扩展名（.php/.jsp/.asp 等），避免在服务器上形成可执行落点。
 *  - 只有 admin/super_admin 能建分类/上传/删除；浏览下载要求登录。
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { ok, getPool, handleError, sendError, ErrorCodes, paginate, logOper } = require('../utils');
const { requireAuth, requireAdminCompat } = require('../auth');
const logger = require('../logger');

module.exports = function () {
  const router = express.Router();

  const ROOT_DIR = path.join(__dirname, '..', '..');
  const FILES_DIR = path.join(ROOT_DIR, 'uploads', 'files');
  const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

  // 允许的类型（安装包 / 压缩包 / 文档 / 镜像）
  const ALLOWED_EXTS = new Set([
    '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz',
    '.exe', '.msi', '.apk', '.dmg', '.pkg', '.deb', '.rpm', '.appimage', '.ipa',
    '.iso', '.img', '.bin',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md',
    '.json', '.xml', '.csv', '.yml', '.yaml',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
    '.mp4', '.mp3', '.wav',
    '.unitypackage', '.vrca', '.vrcw'
  ]);
  // 明确的危险落点（即使在白名单外也必须拒绝）
  const BLOCKED_EXTS = new Set([
    '.php', '.php3', '.php4', '.php5', '.phtml', '.jsp', '.jspx', '.asp', '.aspx',
    '.cgi', '.pl', '.py', '.rb', '.sh', '.bash', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.mjs', '.htaccess'
  ]);

  try {
    if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });
  } catch (e) {
    logger.warn('files', '创建 uploads/files 目录失败:', e.message);
  }

  // ---------- multer：磁盘直写 + 随机名 ----------
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, FILES_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 20);
      cb(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`);
    }
  });

  const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE, files: 1 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (BLOCKED_EXTS.has(ext)) return cb(new Error('该扩展名不被允许'));
      if (!ALLOWED_EXTS.has(ext)) return cb(new Error('不支持的文件类型'));
      cb(null, true);
    }
  });

  // 清理刚落盘但后续校验失败的文件
  const safeUnlink = (p) => {
    if (!p) return;
    try { fs.unlinkSync(p); } catch (e) { /* 忽略 */ }
  };

  // 流式计算 SHA256（大文件不整体读入内存）
  function sha256File(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  // 人类可读大小
  function humanSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
  }

  // ==================== 下载权限校验 ====================
  const ADMIN_ROLES = new Set(['admin', 'super_admin']);

  function parseGroupIds(raw) {
    if (!raw) return [];
    try {
      const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(v)) return [];
      return v.map(x => parseInt(x, 10)).filter(n => Number.isInteger(n) && n > 0);
    } catch (e) { return []; }
  }

  /**
   * 判断用户能否下载该文件。
   * - 管理员/超管：永远可以
   * - access_level=all：所有登录成员
   * - access_level=admin：仅管理员
   * - access_level=groups：需属于 allowed_group_ids 中任一权限分组
   */
  async function canDownload(file, userId) {
    if (!userId) return { ok: false, reason: '请先登录' };
    const pool = getPool();
    const [urows] = await pool.query(
      `SELECT role FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]
    );
    if (!urows.length) return { ok: false, reason: '用户不存在' };
    if (ADMIN_ROLES.has(urows[0].role)) return { ok: true };

    const level = file.access_level || 'all';
    if (level === 'all') return { ok: true };
    if (level === 'admin') return { ok: false, reason: '该文件仅管理员可下载' };
    if (level === 'groups') {
      const gids = parseGroupIds(file.allowed_group_ids);
      if (!gids.length) return { ok: false, reason: '该文件未配置可下载分组' };
      const ph = gids.map(() => '?').join(',');
      const [rows] = await pool.query(
        `SELECT 1 FROM user_group_membership WHERE user_id = ? AND group_id IN (${ph}) LIMIT 1`,
        [userId, ...gids]
      );
      return rows.length
        ? { ok: true }
        : { ok: false, reason: '你所在的用户组无权下载该文件' };
    }
    return { ok: false, reason: '权限配置异常' };
  }

  // ==================== 下载排行榜（登录可见） ====================
  // 注意：本路由必须声明在 `/:id` 类路由之前，否则 "ranking" 会被当成 :id
  router.get('/ranking', requireAuth, async (req, res) => {
    try {
      const topN = Math.min(Math.max(parseInt(req.query.top, 10) || 10, 1), 50);
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 0, 0), 3650);
      const pool = getPool();
      const where = ['f.is_deleted = 0', 'f.download_count > 0'];
      const params = [];
      if (days > 0) {
        where.push('f.created_at >= NOW() - INTERVAL ? DAY');
        params.push(days);
      }
      const [rows] = await pool.query(
        `SELECT f.id, f.title, f.original_name, f.file_size, f.ext, f.download_count, f.version,
                c.name AS category_name
         FROM group_files f
         LEFT JOIN file_categories c ON c.id = f.category_id
         WHERE ${where.join(' AND ')}
         ORDER BY f.download_count DESC, f.id DESC
         LIMIT ?`,
        [...params, topN]
      );
      res.json({
        days,
        items: rows.map((r, i) => ({
          rank: i + 1,
          id: r.id,
          title: r.title,
          fileName: r.original_name,
          fileSizeText: humanSize(r.file_size),
          ext: r.ext || '',
          version: r.version || '1',
          downloadCount: Number(r.download_count) || 0,
          categoryName: r.category_name || ''
        }))
      });
    } catch (e) { handleError(res, e, '[files/ranking]'); }
  });

  // ==================== 我的收藏（登录可见） ====================
  // 同样必须在 `/:id` 之前
  router.get('/favorites', requireAuth, async (req, res) => {
    try {
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT f.id, f.title, f.original_name, f.file_size, f.ext, f.version,
                f.download_count, f.created_at, fav.created_at AS favorited_at,
                c.name AS category_name
         FROM file_favorites fav
         JOIN group_files f ON f.id = fav.file_id AND f.is_deleted = 0
         LEFT JOIN file_categories c ON c.id = f.category_id
         WHERE fav.user_id = ?
         ORDER BY fav.created_at DESC, f.id DESC
         LIMIT 200`,
        [req.session.userId]
      );
      res.json({
        items: rows.map(r => ({
          id: r.id,
          title: r.title,
          fileName: r.original_name,
          fileSizeText: humanSize(r.file_size),
          ext: r.ext || '',
          version: r.version || '1',
          downloadCount: Number(r.download_count) || 0,
          categoryName: r.category_name || '',
          favoritedAt: r.favorited_at
        }))
      });
    } catch (e) { handleError(res, e, '[files/favorites]'); }
  });

  // 切换收藏状态（幂等：已收藏则取消）
  router.post('/favorites/toggle', requireAuth, async (req, res) => {
    try {
      const fileId = parseInt(req.body && req.body.fileId, 10);
      if (!fileId || fileId <= 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '文件 ID 不合法');
      const pool = getPool();
      const [frows] = await pool.query(
        `SELECT id FROM group_files WHERE id = ? AND is_deleted = 0`, [fileId]
      );
      if (!frows.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '文件不存在');
      const [exist] = await pool.query(
        `SELECT id FROM file_favorites WHERE user_id = ? AND file_id = ?`,
        [req.session.userId, fileId]
      );
      let favorited;
      if (exist.length) {
        await pool.query(`DELETE FROM file_favorites WHERE user_id = ? AND file_id = ?`,
          [req.session.userId, fileId]);
        favorited = false;
      } else {
        await pool.query(`INSERT INTO file_favorites (user_id, file_id) VALUES (?,?)`,
          [req.session.userId, fileId]);
        favorited = true;
      }
      ok(res, { favorited });
    } catch (e) { handleError(res, e, '[files/favorites/toggle]'); }
  });

  // ==================== 分类 ====================

  // 分类列表（含每个分类的文件数），登录可见
  router.get('/categories', requireAuth, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT c.id, c.name, c.description, c.sort_order, c.created_at,
                (SELECT COUNT(*) FROM group_files f
                  WHERE f.category_id = c.id AND f.is_deleted = 0) AS file_count
         FROM file_categories c
         ORDER BY c.sort_order ASC, c.id ASC`
      );
      // 未分类文件数（category_id IS NULL）
      const [[uc]] = await getPool().query(
        `SELECT COUNT(*) AS n FROM group_files WHERE category_id IS NULL AND is_deleted = 0`
      );
      res.json({
        categories: rows.map(r => ({
          id: r.id,
          name: r.name,
          description: r.description || '',
          sortOrder: r.sort_order || 0,
          fileCount: Number(r.file_count) || 0
        })),
        uncategorizedCount: Number(uc.n) || 0
      });
    } catch (e) { handleError(res, e, '[files/categories]'); }
  });

  // 建分类（管理员）
  router.post('/categories', requireAdminCompat, async (req, res) => {
    try {
      const name = String((req.body && req.body.name) || '').trim();
      const description = String((req.body && req.body.description) || '').trim().slice(0, 500);
      const sortOrder = parseInt(req.body && req.body.sortOrder, 10) || 0;
      if (!name) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请填写分类名');
      if (name.length > 100) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '分类名不能超过100字');
      const pool = getPool();
      const [exist] = await pool.query(`SELECT id FROM file_categories WHERE name = ?`, [name]);
      if (exist.length) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该分类名已存在');
      const [r] = await pool.query(
        `INSERT INTO file_categories (name, description, sort_order, created_by) VALUES (?,?,?,?)`,
        [name, description, sortOrder, req.session.userId || null]
      );
      try { await logOper(req.session.userId, '创建文件分类', name); } catch (e) { /* 日志失败不影响 */ }
      ok(res, { id: r.insertId, name, description, sortOrder, fileCount: 0 });
    } catch (e) { handleError(res, e, '[files/categories:create]'); }
  });

  // 改分类（管理员）
  router.put('/categories/:id', requireAdminCompat, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const pool = getPool();
      const [rows] = await pool.query(`SELECT id FROM file_categories WHERE id = ?`, [id]);
      if (!rows.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '分类不存在');
      const updates = [];
      const params = [];
      if (req.body && req.body.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!name || name.length > 100) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '分类名不合法');
        const [dup] = await pool.query(`SELECT id FROM file_categories WHERE name = ? AND id <> ?`, [name, id]);
        if (dup.length) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该分类名已存在');
        updates.push('name = ?'); params.push(name);
      }
      if (req.body && req.body.description !== undefined) {
        updates.push('description = ?');
        params.push(String(req.body.description).trim().slice(0, 500));
      }
      if (req.body && req.body.sortOrder !== undefined) {
        updates.push('sort_order = ?');
        params.push(parseInt(req.body.sortOrder, 10) || 0);
      }
      if (!updates.length) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '没有需要更新的字段');
      params.push(id);
      await pool.query(`UPDATE file_categories SET ${updates.join(', ')} WHERE id = ?`, params);
      ok(res, { message: '已更新' });
    } catch (e) { handleError(res, e, '[files/categories:update]'); }
  });

  // 删分类（管理员；分类下仍有文件时拒绝，避免文件变孤儿）
  router.delete('/categories/:id', requireAdminCompat, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const pool = getPool();
      const [[cnt]] = await pool.query(
        `SELECT COUNT(*) AS n FROM group_files WHERE category_id = ? AND is_deleted = 0`, [id]
      );
      if (Number(cnt.n) > 0) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, `该分类下还有 ${cnt.n} 个文件，请先移除或转移`);
      }
      const [r] = await pool.query(`DELETE FROM file_categories WHERE id = ?`, [id]);
      if (!r.affectedRows) return sendError(res, 404, ErrorCodes.NOT_FOUND, '分类不存在');
      try { await logOper(req.session.userId, '删除文件分类', `#${id}`); } catch (e) { /* ignore */ }
      ok(res, { message: '已删除' });
    } catch (e) { handleError(res, e, '[files/categories:delete]'); }
  });

  // ==================== 文件列表 ====================

  router.get('/', requireAuth, async (req, res) => {
    try {
      const { page, pageSize, offset } = paginate(req, { defaultSize: 20, maxSize: 100 });
      // 条件直接带 f. 前缀（列表查询用别名 f，计数查询无别名走同一段 where 会出错 → 分开拼）
      const where = ['f.is_deleted = 0'];
      const params = [];
      // 默认只列每组的最新版本；allVersions=1 时列出全部（管理/排查用）
      if (req.query.allVersions !== '1') where.push('f.is_latest = 1');
      if (req.query.categoryId !== undefined && req.query.categoryId !== '') {
        const cid = parseInt(req.query.categoryId, 10);
        if (Number.isNaN(cid)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '分类参数错误');
        if (cid === 0) where.push('f.category_id IS NULL');
        else { where.push('f.category_id = ?'); params.push(cid); }
      }
      const q = String(req.query.q || '').trim();
      if (q) {
        where.push('(f.title LIKE ? OR f.original_name LIKE ? OR f.description LIKE ?)');
        const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;
        params.push(like, like, like);
      }
      const whereSql = 'WHERE ' + where.join(' AND ');
      const countSql = 'WHERE ' + where.map(w => w.replace(/\bf\./g, '')).join(' AND ');

      const [[{ total }]] = await getPool().query(
        `SELECT COUNT(*) AS total FROM group_files ${countSql}`, params
      );
      const [rows] = await getPool().query(
        `SELECT f.id, f.category_id, f.title, f.description, f.original_name, f.file_size,
                f.ext, f.sha256, f.download_count, f.created_at,
                f.file_group_id, f.version, f.is_latest,
                f.access_level, f.allowed_group_ids,
                (SELECT COUNT(*) FROM group_files v
                  WHERE v.file_group_id = f.file_group_id AND v.is_deleted = 0) AS version_count,
                EXISTS(SELECT 1 FROM file_favorites fav
                       WHERE fav.file_id = f.id AND fav.user_id = ?) AS is_favorited,
                c.name AS category_name, u.display_name AS uploader_name
         FROM group_files f
         LEFT JOIN file_categories c ON c.id = f.category_id
         LEFT JOIN users u ON u.id = f.uploaded_by
         ${whereSql}
         ORDER BY f.created_at DESC, f.id DESC
         LIMIT ? OFFSET ?`,
        [req.session.userId, ...params, pageSize, offset]
      );

      res.json({
        files: rows.map(r => ({
          id: r.id,
          categoryId: r.category_id,
          categoryName: r.category_name || '',
          title: r.title,
          description: r.description || '',
          fileName: r.original_name,
          fileSize: Number(r.file_size) || 0,
          fileSizeText: humanSize(r.file_size),
          ext: r.ext || '',
          sha256: r.sha256 || '',
          downloadCount: Number(r.download_count) || 0,
          uploaderName: r.uploader_name || '',
          createdAt: r.created_at,
          fileGroupId: r.file_group_id,
          version: r.version || '1',
          isLatest: !!r.is_latest,
          versionCount: Number(r.version_count) || 1,
          accessLevel: r.access_level || 'all',
          allowedGroupIds: parseGroupIds(r.allowed_group_ids),
          isFavorited: !!r.is_favorited
        })),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      });
    } catch (e) { handleError(res, e, '[files:list]'); }
  });

  // ==================== 上传（管理员） ====================

  router.post('/upload', requireAdminCompat, (req, res) => {
    upload.single('file')(req, res, async (err) => {
      if (err) {
        // multer 错误（超限/类型不符）统一转 400
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? `文件超过上限（${humanSize(MAX_FILE_SIZE)}）`
          : (err.message || '上传失败');
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, msg);
      }
      const f = req.file;
      if (!f) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '没有收到文件');
      try {
        const title = String((req.body && req.body.title) || '').trim() || f.originalname;
        if (title.length > 200) {
          safeUnlink(f.path);
          return sendError(res, 400, ErrorCodes.BAD_REQUEST, '标题不能超过200字');
        }
        const description = String((req.body && req.body.description) || '').trim();
        let categoryId = null;
        if (req.body && req.body.categoryId !== undefined && req.body.categoryId !== '') {
          const cid = parseInt(req.body.categoryId, 10);
          if (Number.isNaN(cid) || cid <= 0) {
            safeUnlink(f.path);
            return sendError(res, 400, ErrorCodes.BAD_REQUEST, '分类参数错误');
          }
          const [crows] = await getPool().query(`SELECT id FROM file_categories WHERE id = ?`, [cid]);
          if (!crows.length) {
            safeUnlink(f.path);
            return sendError(res, 400, ErrorCodes.BAD_REQUEST, '分类不存在');
          }
          categoryId = cid;
        }

        const ext = path.extname(f.originalname || '').toLowerCase();
        let sha256 = '';
        try { sha256 = await sha256File(f.path); } catch (e) { /* 校验失败不阻塞上传 */ }

        // 版本管理：指定 groupId 则作为该组新版本（旧版本 is_latest 置 0）
        const version = String((req.body && req.body.version) || '1').trim().slice(0, 30) || '1';
        // 下载权限：all / admin / groups（配 allowedGroupIds）
        const accessLevel = ['all', 'admin', 'groups'].includes(String(req.body && req.body.accessLevel))
          ? String(req.body.accessLevel) : 'all';
        const allowedGroupIds = accessLevel === 'groups'
          ? parseGroupIds(req.body && req.body.allowedGroupIds) : [];
        if (accessLevel === 'groups' && !allowedGroupIds.length) {
          safeUnlink(f.path);
          return sendError(res, 400, ErrorCodes.BAD_REQUEST, '选择「指定分组」时必须至少选一个分组');
        }
        let groupId = null;
        if (req.body && req.body.groupId !== undefined && req.body.groupId !== '') {
          const gid = parseInt(req.body.groupId, 10);
          if (Number.isNaN(gid) || gid <= 0) {
            safeUnlink(f.path);
            return sendError(res, 400, ErrorCodes.BAD_REQUEST, '文件组参数错误');
          }
          const [grows] = await getPool().query(
            `SELECT file_group_id FROM group_files WHERE id = ? AND is_deleted = 0`, [gid]
          );
          if (!grows.length) {
            safeUnlink(f.path);
            return sendError(res, 400, ErrorCodes.BAD_REQUEST, '目标文件不存在');
          }
          groupId = grows[0].file_group_id || gid;
        }

        const pool = getPool();
        const [r] = await pool.query(
          `INSERT INTO group_files
             (category_id, title, description, original_name, stored_name, file_size, mime_type, ext, sha256, uploaded_by,
              file_group_id, version, is_latest, access_level, allowed_group_ids)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
          [categoryId, title, description, f.originalname, f.filename, f.size,
            f.mimetype || '', ext, sha256, req.session.userId || null, groupId, version,
            accessLevel, allowedGroupIds.length ? JSON.stringify(allowedGroupIds) : null]
        );
        // 新上传即该组最新：旧版本置为非最新；若未指定 groupId，则自成一组
        if (groupId) {
          await pool.query(
            `UPDATE group_files SET is_latest = 0 WHERE file_group_id = ? AND id <> ?`,
            [groupId, r.insertId]
          );
        } else {
          await pool.query(`UPDATE group_files SET file_group_id = ? WHERE id = ?`, [r.insertId, r.insertId]);
          groupId = r.insertId;
        }
        try { await logOper(req.session.userId, '上传群组文件', `${title} v${version} (${humanSize(f.size)})`); } catch (e) { /* ignore */ }

        ok(res, {
          id: r.insertId,
          title,
          fileName: f.originalname,
          fileSize: f.size,
          fileSizeText: humanSize(f.size),
          sha256,
          fileGroupId: groupId,
          version,
          accessLevel,
          allowedGroupIds,
          categoryId
        });
      } catch (e) {
        safeUnlink(f && f.path);
        handleError(res, e, '[files:upload]');
      }
    });
  });

  // ==================== 版本历史（登录可见） ====================
  router.get('/:id/versions', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const pool = getPool();
      const [cur] = await pool.query(
        `SELECT file_group_id FROM group_files WHERE id = ? AND is_deleted = 0`, [id]
      );
      if (!cur.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '文件不存在');
      const gid = cur[0].file_group_id || id;
      const [rows] = await pool.query(
        `SELECT f.id, f.title, f.original_name, f.file_size, f.ext, f.sha256,
                f.version, f.is_latest, f.download_count, f.created_at,
                u.display_name AS uploader_name
         FROM group_files f
         LEFT JOIN users u ON u.id = f.uploaded_by
         WHERE f.file_group_id = ? AND f.is_deleted = 0
         ORDER BY f.created_at DESC, f.id DESC`,
        [gid]
      );
      res.json({
        fileGroupId: gid,
        versions: rows.map(r => ({
          id: r.id,
          title: r.title,
          fileName: r.original_name,
          fileSize: Number(r.file_size) || 0,
          fileSizeText: humanSize(r.file_size),
          ext: r.ext || '',
          sha256: r.sha256 || '',
          version: r.version || '1',
          isLatest: !!r.is_latest,
          downloadCount: Number(r.download_count) || 0,
          uploaderName: r.uploader_name || '',
          createdAt: r.created_at
        }))
      });
    } catch (e) { handleError(res, e, '[files/versions]'); }
  });

  // ==================== 分片上传（断点续传） ====================
  // 流程：init（建/复用会话）→ chunk（逐片上传）→ complete（合并成正式文件）
  // 会话按 (uploader_id, file_hash) 复用，前端中断后重新 init 即拿到已上传进度。
  const CHUNK_DIR = path.join(FILES_DIR, '_chunks');

  // 1) 初始化/续传查询
  router.post('/upload/init', requireAdminCompat, async (req, res) => {
    try {
      const b = req.body || {};
      const fileHash = String(b.fileHash || '').trim().toLowerCase();
      const originalName = String(b.fileName || '').trim();
      const totalSize = parseInt(b.totalSize, 10);
      const chunkSize = parseInt(b.chunkSize, 10);
      if (!/^[a-f0-9]{64}$/.test(fileHash)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'fileHash 必须是 64 位十六进制');
      }
      if (!originalName) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '缺少文件名');
      if (!Number.isFinite(totalSize) || totalSize <= 0 || totalSize > MAX_FILE_SIZE) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, `文件大小不合法（上限 ${humanSize(MAX_FILE_SIZE)}）`);
      }
      const ext = path.extname(originalName).toLowerCase();
      if (BLOCKED_EXTS.has(ext)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该扩展名不被允许');
      if (!ALLOWED_EXTS.has(ext)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '不支持的文件类型');
      const cs = (Number.isFinite(chunkSize) && chunkSize >= 256 * 1024 && chunkSize <= 32 * 1024 * 1024)
        ? chunkSize : 5 * 1024 * 1024;
      const totalChunks = Math.ceil(totalSize / cs);
      if (totalChunks > 20000) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '分片数过多，请增大分片');

      const pool = getPool();
      // 复用未完成会话（同一上传者 + 同一文件哈希）
      const [exist] = await pool.query(
        `SELECT id, received_chunks, total_chunks, chunk_size FROM file_upload_sessions
         WHERE uploader_id = ? AND file_hash = ? AND status = 'uploading'
           AND total_size = ? AND total_chunks = ?
         ORDER BY created_at DESC LIMIT 1`,
        [req.session.userId, fileHash, totalSize, totalChunks]
      );
      if (exist.length) {
        // 返回已收到的分片序号，前端跳过
        const sid = exist[0].id;
        const dir = path.join(CHUNK_DIR, sid);
        let received = [];
        try {
          received = fs.readdirSync(dir)
            .map(n => parseInt(n.split('.')[0], 10))
            .filter(n => Number.isInteger(n))
            .sort((a, b) => a - b);
        } catch (e) { /* 目录不存在=尚未上传任何片 */ }
        return ok(res, {
          uploadId: sid, chunkSize: cs, totalChunks, resumed: true,
          receivedChunks: received
        });
      }

      const uploadId = crypto.randomBytes(16).toString('hex');
      const initAccess = ['all', 'admin', 'groups'].includes(String(b.accessLevel)) ? String(b.accessLevel) : 'all';
      const initGroupIds = initAccess === 'groups' ? parseGroupIds(b.allowedGroupIds) : [];
      if (initAccess === 'groups' && !initGroupIds.length) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '选择「指定分组」时必须至少选一个分组');
      }
      await pool.query(
        `INSERT INTO file_upload_sessions
           (id, uploader_id, file_hash, original_name, total_size, chunk_size, total_chunks,
            category_id, title, description, version, file_group_id, access_level, allowed_group_ids)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uploadId, req.session.userId, fileHash, originalName, totalSize, cs, totalChunks,
          (b.categoryId ? parseInt(b.categoryId, 10) : null),
          String(b.title || '').slice(0, 200),
          String(b.description || ''),
          String(b.version || '1').slice(0, 30),
          (b.groupId ? parseInt(b.groupId, 10) : null),
          initAccess,
          initGroupIds.length ? JSON.stringify(initGroupIds) : null]
      );
      try { fs.mkdirSync(path.join(CHUNK_DIR, uploadId), { recursive: true }); } catch (e) { /* ignore */ }
      ok(res, { uploadId, chunkSize: cs, totalChunks, resumed: false, receivedChunks: [] });
    } catch (e) { handleError(res, e, '[files/upload/init]'); }
  });

  // 2) 上传单个分片（原始二进制体，index 在查询串）
  router.post('/upload/chunk', requireAdminCompat, async (req, res) => {
    try {
      const uploadId = String(req.query.uploadId || '').trim();
      const index = parseInt(req.query.index, 10);
      if (!/^[a-f0-9]{32}$/.test(uploadId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'uploadId 不合法');
      }
      if (!Number.isInteger(index) || index < 0) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '分片序号不合法');
      }
      const pool = getPool();
      const [sess] = await pool.query(
        `SELECT id, uploader_id, total_chunks, status FROM file_upload_sessions WHERE id = ?`, [uploadId]
      );
      if (!sess.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '上传会话不存在或已过期');
      if (sess[0].uploader_id !== req.session.userId) {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权操作该上传会话');
      }
      if (sess[0].status !== 'uploading') {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该会话已结束');
      }
      if (index >= sess[0].total_chunks) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '分片序号越界');
      }
      const dir = path.join(CHUNK_DIR, uploadId);
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
      const partPath = path.join(dir, `${index}.part`);

      // 直接流式写盘（不占内存）
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(partPath);
        let bytes = 0;
        req.on('data', (c) => { bytes += c.length; });
        req.pipe(ws);
        ws.on('finish', () => resolve(bytes));
        ws.on('error', reject);
        req.on('error', reject);
      });
      // 统计已收分片数（去重后）
      let receivedCount = 0;
      try { receivedCount = fs.readdirSync(dir).filter(n => n.endsWith('.part')).length; } catch (e) { /* ignore */ }
      await pool.query(
        `UPDATE file_upload_sessions SET received_chunks = ? WHERE id = ?`, [receivedCount, uploadId]
      );
      ok(res, { index, receivedChunks: receivedCount, totalChunks: sess[0].total_chunks });
    } catch (e) { handleError(res, e, '[files/upload/chunk]'); }
  });

  // 3) 合并分片 → 正式文件入库
  router.post('/upload/complete', requireAdminCompat, async (req, res) => {
    try {
      const uploadId = String((req.body && req.body.uploadId) || '').trim();
      if (!/^[a-f0-9]{32}$/.test(uploadId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'uploadId 不合法');
      }
      const pool = getPool();
      const [sess] = await pool.query(
        `SELECT * FROM file_upload_sessions WHERE id = ?`, [uploadId]
      );
      if (!sess.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '上传会话不存在');
      const s = sess[0];
      if (s.uploader_id !== req.session.userId) {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权操作该上传会话');
      }
      if (s.status === 'completed') return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该会话已完成');

      const dir = path.join(CHUNK_DIR, uploadId);
      const parts = [];
      for (let i = 0; i < s.total_chunks; i++) {
        const p = path.join(dir, `${i}.part`);
        if (!fs.existsSync(p)) {
          return sendError(res, 400, ErrorCodes.BAD_REQUEST, `缺少第 ${i} 个分片，请重传`);
        }
        parts.push(p);
      }

      // 合并到最终文件
      const ext = path.extname(s.original_name || '').toLowerCase().slice(0, 20);
      const storedName = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
      const finalPath = path.join(FILES_DIR, storedName);
      let written = 0;
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(finalPath);
        ws.on('error', reject);
        ws.on('finish', resolve);
        const pipeNext = (i) => {
          if (i >= parts.length) { ws.end(); return; }
          const rs = fs.createReadStream(parts[i]);
          rs.on('error', reject);
          rs.on('end', () => { written += fs.statSync(parts[i]).size; pipeNext(i + 1); });
          rs.pipe(ws, { end: false });
        };
        pipeNext(0);
      });

      // 校验哈希
      let sha256 = '';
      try { sha256 = await sha256File(finalPath); } catch (e) { /* ignore */ }
      if (sha256 && sha256 !== s.file_hash) {
        safeUnlink(finalPath);
        return sendError(res, 400, ErrorCodes.BAD_REQUEST,
          '文件校验失败（SHA256 不匹配），可能分片损坏，请重新上传');
      }

      // 入库（版本逻辑同单次上传）
      let groupId = s.file_group_id || null;
      if (groupId) {
        const [grows] = await pool.query(
          `SELECT file_group_id FROM group_files WHERE id = ? AND is_deleted = 0`, [groupId]
        );
        if (grows.length) groupId = grows[0].file_group_id || groupId;
        else groupId = null;
      }
      const title = (s.title || '').trim() || s.original_name;
      const [r] = await pool.query(
        `INSERT INTO group_files
           (category_id, title, description, original_name, stored_name, file_size, mime_type, ext, sha256, uploaded_by,
            file_group_id, version, is_latest, access_level, allowed_group_ids)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
        [s.category_id, title, s.description || '', s.original_name, storedName, written,
          '', ext, sha256, s.uploader_id, groupId, s.version || '1',
          s.access_level || 'all', s.allowed_group_ids || null]
      );
      if (groupId) {
        await pool.query(
          `UPDATE group_files SET is_latest = 0 WHERE file_group_id = ? AND id <> ?`, [groupId, r.insertId]
        );
      } else {
        await pool.query(`UPDATE group_files SET file_group_id = ? WHERE id = ?`, [r.insertId, r.insertId]);
        groupId = r.insertId;
      }
      await pool.query(
        `UPDATE file_upload_sessions SET status = 'completed', received_chunks = total_chunks WHERE id = ?`,
        [uploadId]
      );
      // 清理分片目录
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      try { await logOper(s.uploader_id, '上传群组文件(分片)', `${title} v${s.version} (${humanSize(written)})`); } catch (e) { /* ignore */ }

      ok(res, {
        id: r.insertId, title, fileName: s.original_name,
        fileSize: written, fileSizeText: humanSize(written),
        sha256, fileGroupId: groupId, version: s.version || '1'
      });
    } catch (e) { handleError(res, e, '[files/upload/complete]'); }
  });

  // ==================== 批量移动分类（管理员） ====================
  router.post('/batch-move', requireAdminCompat, async (req, res) => {
    try {
      const b = req.body || {};
      const ids = Array.isArray(b.ids) ? b.ids.map(x => parseInt(x, 10)).filter(n => Number.isInteger(n) && n > 0) : [];
      if (!ids.length) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请选择要移动的文件');
      if (ids.length > 200) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '单次最多移动 200 个文件');
      // categoryId: 0 或 '' 表示移到未分类
      let categoryId = null;
      if (b.categoryId !== undefined && b.categoryId !== '' && b.categoryId !== 0 && b.categoryId !== '0') {
        const cid = parseInt(b.categoryId, 10);
        if (Number.isNaN(cid) || cid <= 0) {
          return sendError(res, 400, ErrorCodes.BAD_REQUEST, '分类参数错误');
        }
        const [crows] = await getPool().query(`SELECT id FROM file_categories WHERE id = ?`, [cid]);
        if (!crows.length) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '分类不存在');
        categoryId = cid;
      }
      const ph = ids.map(() => '?').join(',');
      const [r] = await getPool().query(
        `UPDATE group_files SET category_id = ? WHERE id IN (${ph}) AND is_deleted = 0`,
        [categoryId, ...ids]
      );
      try { await logOper(req.session.userId, '批量移动文件分类', `${r.affectedRows} 个 → ${categoryId || '未分类'}`); } catch (e) { /* ignore */ }
      ok(res, { moved: r.affectedRows });
    } catch (e) { handleError(res, e, '[files/batch-move]'); }
  });

  // ==================== 编辑文件（标题/描述/分类/权限，管理员） ====================
  router.put('/:id', requireAdminCompat, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT id FROM group_files WHERE id = ? AND is_deleted = 0`, [id]
      );
      if (!rows.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '文件不存在');

      const b = req.body || {};
      const sets = [];
      const params = [];
      if (b.title !== undefined) {
        const t = String(b.title).trim();
        if (!t || t.length > 200) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '标题不能为空且不超过200字');
        sets.push('title = ?'); params.push(t);
      }
      if (b.description !== undefined) {
        sets.push('description = ?'); params.push(String(b.description).slice(0, 10000));
      }
      if (b.categoryId !== undefined) {
        if (b.categoryId === '' || b.categoryId === 0 || b.categoryId === '0' || b.categoryId === null) {
          sets.push('category_id = ?'); params.push(null);
        } else {
          const cid = parseInt(b.categoryId, 10);
          if (Number.isNaN(cid) || cid <= 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '分类参数错误');
          const [crows] = await pool.query(`SELECT id FROM file_categories WHERE id = ?`, [cid]);
          if (!crows.length) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '分类不存在');
          sets.push('category_id = ?'); params.push(cid);
        }
      }
      if (b.accessLevel !== undefined) {
        const lv = ['all', 'admin', 'groups'].includes(String(b.accessLevel)) ? String(b.accessLevel) : null;
        if (!lv) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '权限值不合法');
        const gids = lv === 'groups' ? parseGroupIds(b.allowedGroupIds) : [];
        if (lv === 'groups' && !gids.length) {
          return sendError(res, 400, ErrorCodes.BAD_REQUEST, '选择「指定分组」时必须至少选一个分组');
        }
        sets.push('access_level = ?'); params.push(lv);
        sets.push('allowed_group_ids = ?'); params.push(gids.length ? JSON.stringify(gids) : null);
      }
      if (!sets.length) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '没有需要更新的字段');
      params.push(id);
      await pool.query(`UPDATE group_files SET ${sets.join(', ')} WHERE id = ?`, params);
      try { await logOper(req.session.userId, '编辑群组文件', `#${id}`); } catch (e) { /* ignore */ }
      ok(res, { message: '已更新' });
    } catch (e) { handleError(res, e, '[files:update]'); }
  });

  // ==================== 维护：清理过期上传会话 ====================
  // 超过 24h 未完成的会话视为过期，连同分片目录一起清理。
  router.post('/maintenance/cleanup-sessions', requireAdminCompat, async (req, res) => {
    try {
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT id FROM file_upload_sessions
         WHERE status = 'uploading' AND updated_at < NOW() - INTERVAL 24 HOUR
         LIMIT 500`
      );
      let removed = 0;
      for (const r of rows) {
        try { fs.rmSync(path.join(CHUNK_DIR, r.id), { recursive: true, force: true }); } catch (e) { /* ignore */ }
        removed++;
      }
      const [del] = await pool.query(
        `DELETE FROM file_upload_sessions
         WHERE status = 'uploading' AND updated_at < NOW() - INTERVAL 24 HOUR`
      );
      try { await logOper(req.session.userId, '清理过期上传会话', `${del.affectedRows} 个`); } catch (e) { /* ignore */ }
      ok(res, { removed: del.affectedRows });
    } catch (e) { handleError(res, e, '[files/maintenance]'); }
  });

  // ==================== 维护：孤儿文件检测/清理 ====================
  // mode=scan  仅统计（默认）；mode=clean 物理删除判定为孤儿的文件
  // 孤儿定义：DB 有记录但磁盘无文件（broken），或磁盘有文件但 DB 无记录（orphan）
  router.post('/maintenance/orphans', requireAdminCompat, async (req, res) => {
    try {
      const mode = (req.body && req.body.mode) === 'clean' ? 'clean' : 'scan';
      const pool = getPool();
      // 1) DB 记录但磁盘缺失
      const [rows] = await pool.query(
        `SELECT id, stored_name, title FROM group_files WHERE is_deleted = 0`
      );
      const broken = [];
      for (const r of rows) {
        const name = path.basename(String(r.stored_name || ''));
        if (!/^[A-Za-z0-9_.-]+$/.test(name)) { broken.push({ id: r.id, name, reason: '非法文件名' }); continue; }
        if (!fs.existsSync(path.join(FILES_DIR, name))) {
          broken.push({ id: r.id, name, title: r.title, reason: '磁盘缺失' });
        }
      }
      // 2) 磁盘有文件但 DB 无记录
      const dbNames = new Set(rows.map(r => path.basename(String(r.stored_name || ''))));
      const orphans = [];
      let files = [];
      try { files = fs.readdirSync(FILES_DIR); } catch (e) { /* ignore */ }
      for (const f of files) {
        if (f === '_chunks') continue;
        const full = path.join(FILES_DIR, f);
        try { if (!fs.statSync(full).isFile()) continue; } catch (e) { continue; }
        if (!dbNames.has(f)) orphans.push({ name: f, size: fs.statSync(full).size });
      }

      let cleaned = 0;
      if (mode === 'clean') {
        // 孤儿文件：物理删除（DB 里没有记录，等同于垃圾）
        for (const o of orphans) {
          try { fs.unlinkSync(path.join(FILES_DIR, o.name)); cleaned++; } catch (e) { /* ignore */ }
        }
        // 破损记录：标记软删除（保留可追溯），文件已不存在无需再删
        if (broken.length) {
          const ids = broken.map(b => b.id).filter(Boolean);
          if (ids.length) {
            await pool.query(
              `UPDATE group_files SET is_deleted = 1 WHERE id IN (${ids.map(() => '?').join(',')})`, ids
            );
          }
        }
        try { await logOper(req.session.userId, '清理孤儿文件', `删除 ${cleaned} 个文件、标记 ${broken.length} 条破损记录`); } catch (e) { /* ignore */ }
      }
      ok(res, {
        mode,
        brokenCount: broken.length,
        orphanCount: orphans.length,
        brokenFiles: broken.slice(0, 50),
        orphanFiles: orphans.slice(0, 50).map(o => ({ name: o.name, sizeText: humanSize(o.size) })),
        cleaned
      });
    } catch (e) { handleError(res, e, '[files/orphans]'); }
  });

  // ==================== 下载（登录可见，流式 + Range 断点续传 + 计数） ====================

  router.get('/:id/download', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const [rows] = await getPool().query(
        `SELECT id, original_name, stored_name, file_size, mime_type, is_deleted,
                access_level, allowed_group_ids
         FROM group_files WHERE id = ?`, [id]
      );
      if (!rows.length || rows[0].is_deleted) {
        return sendError(res, 404, ErrorCodes.NOT_FOUND, '文件不存在或已删除');
      }
      const row = rows[0];
      // 防路径穿越：先做廉价的结构校验（不查库），再做需要查库的权限校验
      const rawStored = String(row.stored_name || '');
      if (rawStored.includes('/') || rawStored.includes('\\') || rawStored.includes('..')) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '文件记录异常');
      }
      const safeName = path.basename(rawStored);
      if (!/^[A-Za-z0-9_.-]+$/.test(safeName)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '文件记录异常');
      }
      const abs = path.join(FILES_DIR, safeName);
      // 确保解析后仍在 FILES_DIR 内
      if (!abs.startsWith(FILES_DIR + path.sep)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '非法路径');
      }
      // 权限校验放在「文件是否存在」之前：避免无权限用户通过 403/404 差异探测文件是否存在
      const perm = await canDownload(row, req.session.userId);
      if (!perm.ok) {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, perm.reason || '无权下载该文件');
      }
      if (!fs.existsSync(abs)) {
        return sendError(res, 404, ErrorCodes.NOT_FOUND, '文件已不在服务器上');
      }

      // 计数（异步，不阻塞下载）
      getPool().query(`UPDATE group_files SET download_count = download_count + 1 WHERE id = ?`, [id])
        .catch(() => {});

      const stat = fs.statSync(abs);
      const total = stat.size;
      const mime = row.mime_type || 'application/octet-stream';
      // 强制附件下载：避免 .html/.svg 等被浏览器当页面渲染（同源 XSS 面）
      // filename 用 ASCII 安全兜底名（非 ASCII 会乱码），filename* 给 UTF-8 原名；
      // 两者都基于「原始文件名」，让下载文件名可读，而不是暴露随机存储名。
      const origName = String(row.original_name || safeName);
      const asciiFallback = origName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || safeName;
      const filenameStar = encodeURIComponent(origName);
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${filenameStar}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Accept-Ranges', 'bytes');

      // Range 支持（断点续传 / 播放器拖动）
      const range = req.headers.range;
      if (range && /^bytes=\d*-\d*$/.test(range)) {
        const [startStr, endStr] = range.replace('bytes=', '').split('-');
        let start = startStr ? parseInt(startStr, 10) : 0;
        let end = endStr ? parseInt(endStr, 10) : total - 1;
        if (Number.isNaN(start) || start < 0) start = 0;
        if (Number.isNaN(end) || end >= total) end = total - 1;
        if (start > end) {
          res.setHeader('Content-Range', `bytes */${total}`);
          return res.status(416).end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', String(end - start + 1));
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
      }

      res.setHeader('Content-Length', String(total));
      fs.createReadStream(abs).pipe(res);
    } catch (e) { handleError(res, e, '[files:download]'); }
  });

  // ==================== 临时分享链接（token） ====================
  // 用途：把文件分享给未登录用户（群外朋友）。凭 token 公开下载，可设有效期/次数上限/撤销。
  const SHARE_MAX_EXPIRE_DAYS = 30;

  // 生成分享链接（管理员）
  router.post('/:id/share', requireAdminCompat, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT id, title FROM group_files WHERE id = ? AND is_deleted = 0`, [id]
      );
      if (!rows.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '文件不存在');

      const b = req.body || {};
      const hours = parseInt(b.expiresInHours, 10);
      const validHours = Number.isFinite(hours) && hours > 0
        ? Math.min(hours, SHARE_MAX_EXPIRE_DAYS * 24) : 24;
      const maxDownloads = parseInt(b.maxDownloads, 10);
      const validMax = Number.isFinite(maxDownloads) && maxDownloads > 0
        ? Math.min(maxDownloads, 100000) : 0;

      const token = crypto.randomBytes(32).toString('hex');
      const [r] = await pool.query(
        `INSERT INTO file_share_links (token, file_id, created_by, expires_at, max_downloads)
         VALUES (?,?,?, DATE_ADD(NOW(), INTERVAL ? HOUR), ?)`,
        [token, id, req.session.userId || null, validHours, validMax]
      );
      try { await logOper(req.session.userId, '创建文件分享链接', `#${id} ${validHours}h`); } catch (e) { /* ignore */ }
      const [[row]] = await pool.query(
        `SELECT expires_at FROM file_share_links WHERE id = ?`, [r.insertId]
      );
      ok(res, {
        id: r.insertId,
        token,
        url: `/api/group-files/share/${token}`,
        expiresAt: row && row.expires_at,
        expiresInHours: validHours,
        maxDownloads: validMax
      });
    } catch (e) { handleError(res, e, '[files/share:create]'); }
  });

  // 列出某文件的分享链接（管理员）
  router.get('/:id/shares', requireAdminCompat, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const [rows] = await getPool().query(
        `SELECT s.id, s.token, s.expires_at, s.max_downloads, s.download_count, s.is_revoked, s.created_at,
                u.display_name AS creator_name
         FROM file_share_links s
         LEFT JOIN users u ON u.id = s.created_by
         WHERE s.file_id = ?
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT 50`,
        [id]
      );
      const now = Date.now();
      res.json({
        links: rows.map(r => ({
          id: r.id,
          token: r.token,
          url: `/api/group-files/share/${r.token}`,
          expiresAt: r.expires_at,
          expired: r.expires_at ? new Date(r.expires_at).getTime() < now : false,
          maxDownloads: Number(r.max_downloads) || 0,
          downloadCount: Number(r.download_count) || 0,
          isRevoked: !!r.is_revoked,
          creatorName: r.creator_name || '',
          createdAt: r.created_at
        }))
      });
    } catch (e) { handleError(res, e, '[files/share:list]'); }
  });

  // 撤销分享链接（管理员）
  router.delete('/share/:linkId', requireAdminCompat, async (req, res) => {
    try {
      const lid = parseInt(req.params.linkId, 10);
      if (!lid) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const [r] = await getPool().query(
        `UPDATE file_share_links SET is_revoked = 1 WHERE id = ?`, [lid]
      );
      if (!r.affectedRows) return sendError(res, 404, ErrorCodes.NOT_FOUND, '链接不存在');
      try { await logOper(req.session.userId, '撤销文件分享链接', `#${lid}`); } catch (e) { /* ignore */ }
      ok(res, { message: '已撤销' });
    } catch (e) { handleError(res, e, '[files/share:revoke]'); }
  });

  // 凭 token 公开下载（**无需登录**）
  // 注意：必须在 `/:id/...` 类路由之前不冲突（/share/:token 段数与 /:id/download 不同，安全）
  router.get('/share/:token', async (req, res) => {
    try {
      const token = String(req.params.token || '').trim();
      if (!/^[a-f0-9]{64}$/.test(token)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '分享链接无效');
      }
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT s.id, s.file_id, s.expires_at, s.max_downloads, s.download_count, s.is_revoked,
                f.original_name, f.stored_name, f.file_size, f.mime_type, f.is_deleted
         FROM file_share_links s
         JOIN group_files f ON f.id = s.file_id
         WHERE s.token = ?`,
        [token]
      );
      if (!rows.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '分享链接不存在');
      const s = rows[0];
      if (s.is_revoked) return sendError(res, 403, ErrorCodes.FORBIDDEN, '该分享链接已被撤销');
      if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '该分享链接已过期');
      }
      if (s.max_downloads > 0 && s.download_count >= s.max_downloads) {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '该分享链接下载次数已达上限');
      }
      if (s.is_deleted) return sendError(res, 404, ErrorCodes.NOT_FOUND, '文件已删除');

      // 路径安全校验
      const rawStored = String(s.stored_name || '');
      if (rawStored.includes('/') || rawStored.includes('\\') || rawStored.includes('..')) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '文件记录异常');
      }
      const safeName = path.basename(rawStored);
      if (!/^[A-Za-z0-9_.-]+$/.test(safeName)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '文件记录异常');
      }
      const abs = path.join(FILES_DIR, safeName);
      if (!abs.startsWith(FILES_DIR + path.sep)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '非法路径');
      }
      if (!fs.existsSync(abs)) {
        return sendError(res, 404, ErrorCodes.NOT_FOUND, '文件已不在服务器上');
      }

      // 计数（链接次数 + 文件总下载次数）
      pool.query(`UPDATE file_share_links SET download_count = download_count + 1 WHERE id = ?`, [s.id]).catch(() => {});
      pool.query(`UPDATE group_files SET download_count = download_count + 1 WHERE id = ?`, [s.file_id]).catch(() => {});

      const stat = fs.statSync(abs);
      const total = stat.size;
      const origName = String(s.original_name || safeName);
      const asciiFallback = origName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || safeName;
      res.setHeader('Content-Type', s.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(origName)}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Accept-Ranges', 'bytes');

      const range = req.headers.range;
      if (range && /^bytes=\d*-\d*$/.test(range)) {
        const [startStr, endStr] = range.replace('bytes=', '').split('-');
        let start = startStr ? parseInt(startStr, 10) : 0;
        let end = endStr ? parseInt(endStr, 10) : total - 1;
        if (Number.isNaN(start) || start < 0) start = 0;
        if (Number.isNaN(end) || end >= total) end = total - 1;
        if (start > end) {
          res.setHeader('Content-Range', `bytes */${total}`);
          return res.status(416).end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', String(end - start + 1));
        return fs.createReadStream(abs, { start, end }).pipe(res);
      }
      res.setHeader('Content-Length', String(total));
      fs.createReadStream(abs).pipe(res);
    } catch (e) { handleError(res, e, '[files/share:download]'); }
  });

  // ==================== 删除（管理员，软删除 + 物理删除） ====================

  router.delete('/:id', requireAdminCompat, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT id, stored_name, title, is_deleted FROM group_files WHERE id = ?`, [id]
      );
      if (!rows.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '文件不存在');
      await pool.query(`UPDATE group_files SET is_deleted = 1 WHERE id = ?`, [id]);
      // 物理文件：软删除后仍保留一段时间不方便排查，这里直接删除（记录仍在库中可追溯）
      const safeName = path.basename(String(rows[0].stored_name || ''));
      if (/^[A-Za-z0-9_.-]+$/.test(safeName)) {
        safeUnlink(path.join(FILES_DIR, safeName));
      }
      try { await logOper(req.session.userId, '删除群组文件', rows[0].title || `#${id}`); } catch (e) { /* ignore */ }
      ok(res, { message: '已删除' });
    } catch (e) { handleError(res, e, '[files:delete]'); }
  });

  return router;
};
