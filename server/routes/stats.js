/**
 * 统计 / 公开统计 / 全局搜索 / 客户端配置（P2-4 第二步第二批）
 * 从 server.js 原地抽取为 /api 前缀路由；「在线」语义与降级行为保持不变。
 *
 * 守卫语义（round5-regressions）：
 * - /api/stats 与 /api/public/stats 的 online/onlineCount 必须取 wsService.onlineUsers.size
 *   （本站 WebSocket 实时名单），而不是 group_roster.is_online（VRChat 游戏内在线）。
 */
const express = require('express');
const { requireAuth } = require('../auth');
const wsService = require('../ws_service');
const { getPool, fail, safeError, escapeLike, paginate } = require('../utils');
const logger = require('../logger');

module.exports = function createStatsRouter() {
  const router = express.Router();

  // 前端运行环境配置：暴露可通过环境变量部署调整的客户端参数（如 WebSocket 地址）。
  // 前端 connectWebSocket 优先读取本接口返回的 wsUrl，否则按当前协议自动探测。
  router.get('/client-config', (req, res) => {
    const wsUrl = process.env.WS_URL || '';
    res.json({ wsUrl });
  });

  router.get('/stats', requireAuth, async (req, res) => {
    try {
      // 统计条上的「在线」点开是本站在线成员列表（WebSocket 实时名单），
      // 数字必须和它同源。原来这里查的是 group_roster.is_online —— 那是
      // VRChat 群组成员在游戏里的在线状态，语义完全不同；两个数写进同一个
      // #dashOnline，谁后到谁赢，用户看到的数字会来回跳。
      const onlineCount = wsService.onlineUsers.size;
      const [
        [memberRes], [photoRes], [eventRes], [postRes], [vrcOnlineRes],
        [memberGrowth], [eventSignRate], [postActivity], [checkinStats], [recentUsers]
      ] = await Promise.all([
        getPool().query('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL AND approved = 1 AND banned = 0'),
        getPool().query('SELECT COUNT(*) as count FROM album_photo WHERE is_recycle=0'),
        getPool().query('SELECT COUNT(*) as count FROM event WHERE is_archive=0'),
        getPool().query('SELECT COUNT(*) as count FROM posts'),
        getPool().query('SELECT COUNT(*) as count FROM group_roster WHERE is_member=1 AND is_online=1'),
        getPool().query(`SELECT DATE(created_at) as date, COUNT(*) as count FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) GROUP BY DATE(created_at) ORDER BY date`),
        getPool().query(`SELECT e.id, e.title, e.event_time as eventTime, COUNT(es.id) as signCount, e.max_sign as maxSign FROM event e LEFT JOIN event_sign es ON e.id = es.event_id WHERE e.is_archive=0 GROUP BY e.id ORDER BY e.event_time DESC LIMIT 10`),
        getPool().query(`SELECT DATE(created_at) as date, COUNT(*) as posts, SUM(like_count) as likes, SUM(comment_count) as comments FROM posts WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY DATE(created_at) ORDER BY date`),
        getPool().query(`SELECT COUNT(*) as total FROM event_checkin`),
        getPool().query(`SELECT id, display_name, created_at FROM users WHERE deleted_at IS NULL AND banned = 0 ORDER BY created_at DESC LIMIT 10`)
      ]);

      res.json({
        members: memberRes[0].count,
        photos: photoRes[0].count,
        events: eventRes[0].count,
        posts: postRes[0].count,
        online: onlineCount,
        vrcOnline: vrcOnlineRes[0].count,
        checkins: checkinStats[0].total,
        memberGrowth: memberGrowth,
        eventSignRate: eventSignRate.map(e => ({
          id: e.id,
          title: e.title,
          eventTime: e.eventTime,
          signCount: e.signCount,
          maxSign: e.maxSign,
          rate: e.maxSign > 0 ? Math.round((e.signCount / e.maxSign) * 100) : 0
        })),
        postActivity: postActivity,
        recentUsers: recentUsers
      });
    } catch (e) { logger.error('[stats]', e.message, e.stack); fail(res, 500, safeError(e.message)); }
  });

  router.get('/public/stats', async (req, res) => {
    try {
      const [
        [memberRes], [photoRes], [eventRes], [postRes], [onlineRes]
      ] = await Promise.all([
        getPool().query('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL AND approved = 1 AND banned = 0'),
        getPool().query('SELECT COUNT(*) as count FROM album_photo WHERE is_recycle=0'),
        getPool().query('SELECT COUNT(*) as count FROM event WHERE is_archive=0'),
        getPool().query('SELECT COUNT(*) as count FROM posts'),
        getPool().query('SELECT COUNT(*) as count FROM group_roster WHERE is_member=1 AND is_online=1')
      ]);

      // 站点展示信息（hero 区 + 页脚链接）：只暴露非敏感的展示字段，
      // 供首页 loadHeroStats / loadSocialLinks 读取，主页管理与网站信息保存后立即生效。
      const SITE_DISPLAY_KEYS = [
        'site_name', 'hero_title', 'hero_subtitle', 'hero_description',
        'hero_bg_url', 'hero_bg_color', 'hero_bg_overlay_opacity', 'hero_accent_color',
        'hero_badge_text', 'hero_show_badge', 'hero_show_stats', 'hero_animation',
        'vrcGroupUrl', 'kookUrl', 'oopzUrl'
      ];
      let siteConfig = {};
      try {
        const [cfgRows] = await getPool().query(
          `SELECT config_key, config_value FROM system_config WHERE config_key IN (${SITE_DISPLAY_KEYS.map(() => '?').join(',')})`,
          SITE_DISPLAY_KEYS
        );
        for (const row of cfgRows) siteConfig[row.config_key] = row.config_value || '';
      } catch (e) {
        logger.error('[public/stats] site-config', e.message);
      }

      res.json({
        totalUsers: memberRes[0].count,
        totalPhotos: photoRes[0].count,
        totalEvents: eventRes[0].count,
        totalPosts: postRes[0].count,
        // 与 /api/stats 保持同一语义：本站实时在线（WebSocket 名单），
        // 而不是 VRChat 群成员在游戏里的在线状态。
        onlineCount: wsService.onlineUsers.size,
        vrcOnlineCount: onlineRes[0].count,
        // hero 展示配置（首页直接消费）
        site_name: siteConfig.site_name,
        hero_title: siteConfig.hero_title,
        hero_subtitle: siteConfig.hero_subtitle,
        hero_description: siteConfig.hero_description,
        hero_bg_url: siteConfig.hero_bg_url,
        hero_bg_color: siteConfig.hero_bg_color,
        hero_bg_overlay_opacity: siteConfig.hero_bg_overlay_opacity,
        hero_accent_color: siteConfig.hero_accent_color,
        hero_badge_text: siteConfig.hero_badge_text,
        hero_show_badge: siteConfig.hero_show_badge,
        hero_show_stats: siteConfig.hero_show_stats,
        hero_animation: siteConfig.hero_animation,
        // 页脚社群链接
        vrcGroupUrl: siteConfig.vrcGroupUrl,
        kookUrl: siteConfig.kookUrl,
        oopzUrl: siteConfig.oopzUrl
      });
    } catch (e) {
      logger.error('[public/stats]', e.message, e.stack);
      res.json({
        totalUsers: '-',
        totalPhotos: '-',
        totalEvents: '-',
        totalPosts: '-',
        onlineCount: 0
      });
    }
  });

  // ==================== 全局搜索 ====================
  // G-14 增强：原来只搜 announcement/event/users 三类。现扩展到 6 类
  // （+ 动态 posts / 群成员 group_roster / 群组文件 group_files），
  // 并按「匹配度」排序：完全相等 > 前缀匹配 > 包含匹配。
  // 兼容性：原有 announcements/events/users 字段保持不变，新增字段为增量。
  router.get('/search', requireAuth, async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (q.length < 2) {
        return res.json({
          announcements: [], events: [], users: [], posts: [], members: [], files: [],
          results: []
        });
      }
      const like = `%${escapeLike(q)}%`;
      const prefix = `${escapeLike(q)}%`;
      const exact = q;
      // 每类返回条数上限：复用统一分页解析（P2-70 禁止手写 parseInt(...limit)）
      const { pageSize: limit } = paginate(req, { sizeParam: 'limit', defaultSize: 5, maxSize: 20 });
      const pool = getPool();

      // 匹配度打分：完全相等 100 / 前缀 60 / 包含 30
      const score = (col) => `CASE WHEN ${col} = ? THEN 100 WHEN ${col} LIKE ? ESCAPE '!' THEN 60 ELSE 30 END`;
      const scoreParams = [exact, prefix];

      const [announcements] = await pool.query(
        `SELECT id, title, content, ${score('title')} AS score
         FROM announcement
         WHERE title LIKE ? ESCAPE '!' OR content LIKE ? ESCAPE '!'
         ORDER BY score DESC, create_time DESC LIMIT ?`,
        [...scoreParams, like, like, limit]
      );

      const [events] = await pool.query(
        `SELECT id, title, description, ${score('title')} AS score
         FROM event
         WHERE (title LIKE ? ESCAPE '!' OR description LIKE ? ESCAPE '!') AND is_archive = 0
         ORDER BY score DESC, event_time DESC LIMIT ?`,
        [...scoreParams, like, like, limit]
      );

      const [users] = await pool.query(
        `SELECT id, login_id AS loginId, display_name AS displayName, ${score('display_name')} AS score
         FROM users
         WHERE deleted_at IS NULL AND approved = 1 AND banned = 0
           AND (login_id LIKE ? ESCAPE '!' OR display_name LIKE ? ESCAPE '!')
         ORDER BY score DESC, display_name ASC LIMIT ?`,
        [...scoreParams, like, like, limit]
      );

      // 动态 posts（只搜可见范围，避免泄露私密内容）
      const [posts] = await pool.query(
        `SELECT p.id, p.content, p.created_at, u.display_name AS authorName, 30 AS score
         FROM posts p JOIN users u ON u.id = p.user_id
         WHERE p.content LIKE ? ESCAPE '!' AND p.visibility IN ('public','members_only')
           AND u.deleted_at IS NULL
         ORDER BY p.created_at DESC LIMIT ?`,
        [like, limit]
      );

      // 群成员 group_roster
      const [members] = await pool.query(
        `SELECT vrchat_id AS vrchatId, display_name AS displayName, trust_level AS trustLevel,
                ${score('display_name')} AS score
         FROM group_roster
         WHERE display_name LIKE ? ESCAPE '!' OR vrchat_id LIKE ? ESCAPE '!'
         ORDER BY score DESC, display_name ASC LIMIT ?`,
        [...scoreParams, like, like, limit]
      );

      // 群组文件 group_files（仅最新版、未删除）
      const [files] = await pool.query(
        `SELECT id, title, original_name AS fileName, file_size AS fileSize, ext,
                ${score('title')} AS score
         FROM group_files
         WHERE is_deleted = 0 AND is_latest = 1
           AND (title LIKE ? ESCAPE '!' OR original_name LIKE ? ESCAPE '!' OR description LIKE ? ESCAPE '!')
         ORDER BY score DESC, created_at DESC LIMIT ?`,
        [...scoreParams, like, like, like, limit]
      );

      // 汇总为统一结果（按 score 降序），供前端统一渲染
      const results = [];
      const push = (type, rows, map) => rows.forEach(r => {
        const m = map(r);
        if (m) results.push({ type, score: Number(r.score) || 0, ...m });
      });
      push('announcement', announcements, r => ({ id: r.id, title: r.title, snippet: (r.content || '').slice(0, 120) }));
      push('event', events, r => ({ id: r.id, title: r.title, snippet: (r.description || '').slice(0, 120) }));
      push('user', users, r => ({ id: r.id, title: r.displayName || r.loginId, snippet: r.loginId || '' }));
      push('post', posts, r => ({ id: r.id, title: r.authorName || '', snippet: (r.content || '').slice(0, 120) }));
      push('member', members, r => ({ id: r.vrchatId, title: r.displayName || r.vrchatId, snippet: r.vrchatId || '' }));
      push('file', files, r => ({ id: r.id, title: r.title, snippet: r.fileName || '' }));
      results.sort((a, b) => b.score - a.score);

      res.json({ announcements, events, users, posts, members, files, results });
    } catch (e) {
      logger.error('[search]', e.message, e.stack);
      res.json({ announcements: [], events: [], users: [], posts: [], members: [], files: [], results: [] });
    }
  });

  return router;
};
