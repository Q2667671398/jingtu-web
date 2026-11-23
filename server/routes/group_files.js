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
                c.name AS category_name, u.display_name AS uploader_name
         FROM group_files f
         LEFT JOIN file_categories c ON c.id = f.category_id
         LEFT JOIN users u ON u.id = f.uploaded_by
         ${whereSql}
         ORDER BY f.created_at DESC, f.id DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
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
          createdAt: r.created_at
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

        const [r] = await getPool().query(
          `INSERT INTO group_files
             (category_id, title, description, original_name, stored_name, file_size, mime_type, ext, sha256, uploaded_by)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [categoryId, title, description, f.originalname, f.filename, f.size,
            f.mimetype || '', ext, sha256, req.session.userId || null]
        );
        try { await logOper(req.session.userId, '上传群组文件', `${title} (${humanSize(f.size)})`); } catch (e) { /* ignore */ }

        ok(res, {
          id: r.insertId,
          title,
          fileName: f.originalname,
          fileSize: f.size,
          fileSizeText: humanSize(f.size),
          sha256,
          categoryId
        });
      } catch (e) {
        safeUnlink(f && f.path);
        handleError(res, e, '[files:upload]');
      }
    });
  });

  // ==================== 下载（登录可见，流式 + Range 断点续传 + 计数） ====================

  router.get('/:id/download', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const [rows] = await getPool().query(
        `SELECT id, original_name, stored_name, file_size, mime_type, is_deleted
         FROM group_files WHERE id = ?`, [id]
      );
      if (!rows.length || rows[0].is_deleted) {
        return sendError(res, 404, ErrorCodes.NOT_FOUND, '文件不存在或已删除');
      }
      const row = rows[0];
      // 防路径穿越：先检查原始值不含路径分隔符/上级引用，再用 basename 兜底
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
