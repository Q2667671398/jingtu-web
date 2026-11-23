/**
 * 境途同游 V7.10 — 好友系统路由
 * 单向行 + status 表示 user_id 对 friend_id 的视角；
 *   accepted 写两条对称行便于双向查询；
 *   blocked 单向优先（私聊模块据此拦截，见本文件内联契约注释）。
 * 接口契约（入参/出参/越权/错误码）遵循本文件内联契约注释。
 */
const express = require('express');
const { ok,  getPool, getAvatarUrl, handleError, sendError, ErrorCodes, paginate  } = require('../utils');;
const { requireAuth } = require('../auth');

module.exports = function (notificationService) {
  const router = express.Router();

  // 用户摘要（JOIN users 后映射，复用 user_like 既有字段约定；users 无 bio 列）
  function toUserSummary(u) {
    if (!u) return null;
    return {
      id: u.id,
      displayName: u.display_name || '',
      vrchatName: u.vrchat_name || '',
      avatarUrl: getAvatarUrl(u) || '/api/avatar/default'
    };
  }

  async function userExists(id) {
    const [rows] = await getPool().query(
      `SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`, [id]
    );
    return rows.length > 0;
  }

  /**
   * 将一条 pending 申请转为双向 accepted 好友关系（事务）。
   * @param {object} pool  - mysql2 连接池
   * @param {number} pendingId - 待接受的 pending 行 id（user_id=发起方, friend_id=当前用户）
   * @param {number} requester - 发起方 user_id
   * @param {number} me       - 当前接受方 user_id
   */
  async function acceptFriendship(pool, pendingId, requester, me) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE user_friends SET status='accepted' WHERE id = ? AND friend_id = ? AND status='pending'`,
        [pendingId, me]
      );
      await conn.query(
        `INSERT IGNORE INTO user_friends (user_id, friend_id, status, requested_by)
         VALUES (?, ?, 'accepted', ?)`,
        [me, requester, requester]
      );
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  // ==================== POST /api/friends/request ====================
  router.post('/request', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const targetUserId = parseInt(req.body.targetUserId);
      if (!targetUserId || isNaN(targetUserId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      if (targetUserId === me) {
        return sendError(res, 400, ErrorCodes.SELF_FRIEND, '不能添加自己为好友');
      }
      if (!(await userExists(targetUserId))) {
        return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
      }

      const pool = getPool();

      let conn;
      try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        // 对方已拉黑我 → 禁止互动（BLOCKED 403）
        const [blockedByThem] = await conn.query(
          `SELECT 1 FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'blocked' FOR UPDATE`,
          [targetUserId, me]
        );
        if (blockedByThem.length) {
          await conn.rollback();
          return sendError(res, 403, ErrorCodes.BLOCKED, '已被对方拉黑，无法互动');
        }

        // 我 → 对方 现有关系（锁行，避免并发 check-then-insert 竞态）
        const [mine] = await conn.query(
          `SELECT status FROM user_friends WHERE user_id = ? AND friend_id = ? FOR UPDATE`,
          [me, targetUserId]
        );
        if (mine.length) {
          const st = mine[0].status;
          if (st === 'accepted') {
            await conn.rollback();
            return sendError(res, 409, ErrorCodes.ALREADY_FRIENDS, '你们已经是好友了');
          }
          if (st === 'pending') {
            await conn.rollback();
            return sendError(res, 409, ErrorCodes.FRIEND_REQUEST_EXISTS, '好友申请已发送，等待对方确认');
          }
          if (st === 'blocked') {
            await conn.rollback();
            return sendError(res, 409, ErrorCodes.ALREADY_BLOCKED, '你已拉黑该用户，请先解除拉黑');
          }
        }

        // 对方 → 我 已有 pending（对方先申请了我）：我的申请即视为接受（同一事务内原子完成）
        const [incoming] = await conn.query(
          `SELECT id, user_id AS requester FROM user_friends
           WHERE user_id = ? AND friend_id = ? AND status = 'pending' FOR UPDATE`,
          [targetUserId, me]
        );
        if (incoming.length) {
          await conn.query(
            `UPDATE user_friends SET status='accepted' WHERE id = ? AND friend_id = ? AND status='pending'`,
            [incoming[0].id, me]
          );
          await conn.query(
            `INSERT IGNORE INTO user_friends (user_id, friend_id, status, requested_by)
             VALUES (?, ?, 'accepted', ?)`,
            [me, incoming[0].requester, incoming[0].requester]
          );
          await conn.commit();
          if (notificationService) {
            const [meU] = await pool.query(`SELECT display_name FROM users WHERE id = ?`, [me]);
            const myName = meU[0]?.display_name || '用户';
            await notificationService.notifyUser(
              targetUserId, 'friend_accepted', '好友请求已通过',
              `${myName} 接受了你的好友请求`, { targetType: 'user', targetId: me }
            );
          }
          return ok(res, { status: 'accepted', friendship: { status: 'accepted' } });
        }

        // 新建 pending 申请（同向并发重复 → 唯一键冲突 → 409，避免 500）
        let insertId;
        try {
          const [r] = await conn.query(
            `INSERT INTO user_friends (user_id, friend_id, status, requested_by)
             VALUES (?, ?, 'pending', ?)`,
            [me, targetUserId, me]
          );
          insertId = r.insertId;
        } catch (e) {
          await conn.rollback();
          if (e && e.code === 'ER_DUP_ENTRY') {
            return sendError(res, 409, ErrorCodes.FRIEND_REQUEST_EXISTS, '好友申请已发送，等待对方确认');
          }
          throw e;
        }
        await conn.commit();
        if (notificationService) {
          const [meU] = await pool.query(`SELECT display_name FROM users WHERE id = ?`, [me]);
          const myName = meU[0]?.display_name || '用户';
          await notificationService.notifyUser(
            targetUserId, 'friend_request', '新的好友请求',
            `${myName} 想加你为好友`, { targetType: 'user', targetId: me }
          );
        }
        return ok(res, {
          status: 'pending',
          friendship: { id: insertId, status: 'pending', targetUserId }
        });
      } catch (e) {
        if (conn) await conn.rollback().catch(() => {});
        handleError(res, e, '[friends/request]');
      } finally {
        if (conn) conn.release();
      }
    } catch (e) {
      handleError(res, e, '[friends/request]');
    }
  });

  // ==================== POST /api/friends/respond ====================
  router.post('/respond', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const requestId = parseInt(req.body.requestId);
      const action = req.body.action;
      if (!requestId || isNaN(requestId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      if (!['accept', 'reject'].includes(action)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '操作无效');
      }

      const pool = getPool();

      const [rows] = await pool.query(
        `SELECT * FROM user_friends WHERE id = ? AND status = 'pending'`,
        [requestId]
      );
      if (rows.length === 0) {
        return sendError(res, 404, ErrorCodes.FRIEND_NOT_FOUND, '好友申请不存在');
      }
      const row = rows[0];
      // 只能响应发给自己的申请，否则 FORBIDDEN
      if (row.friend_id !== me) {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权处理该好友申请');
      }

      if (action === 'reject') {
        // P3-53: 仅删除仍处于 pending 的关系——并发 accept 已改 accepted 并写对称行时，
        // 无条件 DELETE 会把主行删掉留下单向悬挂关系；受影响行数为 0 说明状态已变化，返回 409
        const [delResult] = await pool.query(
          `DELETE FROM user_friends WHERE id = ? AND status = 'pending'`,
          [requestId]
        );
        if (delResult.affectedRows === 0) {
          return sendError(res, 409, ErrorCodes.CONFLICT, '该好友申请状态已变化，请刷新后重试');
        }
        return ok(res, { status: 'rejected' });
      }

      // accept → 对称 accepted
      await acceptFriendship(pool, requestId, row.user_id, me);
      if (notificationService) {
        const [meU] = await pool.query(`SELECT display_name FROM users WHERE id = ?`, [me]);
        const myName = meU[0]?.display_name || '用户';
        await notificationService.notifyUser(
          row.user_id, 'friend_accepted', '好友请求已通过',
          `${myName} 接受了你的好友请求`, { targetType: 'user', targetId: me }
        );
      }
      return ok(res, { status: 'accepted' });
    } catch (e) {
      handleError(res, e, '[friends/respond]');
    }
  });

  // ==================== DELETE /api/friends/block/:targetUserId（先于 /:friendUserId 注册） ====================
  router.delete('/block/:targetUserId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const targetUserId = parseInt(req.params.targetUserId);
      if (!targetUserId || isNaN(targetUserId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();
      const [r] = await pool.query(
        `DELETE FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'blocked'`,
        [me, targetUserId]
      );
      if (r.affectedRows === 0) {
        return sendError(res, 404, ErrorCodes.FRIEND_NOT_FOUND, '未拉黑该用户');
      }
      return ok(res, { ok: true });
    } catch (e) {
      handleError(res, e, '[friends/unblock]');
    }
  });

  // ==================== DELETE /api/friends/:friendUserId ====================
  router.delete('/:friendUserId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const otherId = parseInt(req.params.friendUserId);
      if (!otherId || isNaN(otherId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();
      // 双向清除（无论 accepted / pending / blocked 视角），非好友则 404
      const [r] = await pool.query(
        `DELETE FROM user_friends
         WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
        [me, otherId, otherId, me]
      );
      if (r.affectedRows === 0) {
        return sendError(res, 404, ErrorCodes.FRIEND_NOT_FOUND, '好友关系不存在');
      }
      return ok(res, { ok: true });
    } catch (e) {
      handleError(res, e, '[friends/delete]');
    }
  });

  // ==================== POST /api/friends/block ====================
  router.post('/block', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const targetUserId = parseInt(req.body.targetUserId);
      if (!targetUserId || isNaN(targetUserId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      if (targetUserId === me) {
        return sendError(res, 400, ErrorCodes.SELF_FRIEND, '不能拉黑自己');
      }
      if (!(await userExists(targetUserId))) {
        return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
      }

      const pool = getPool();
      const [existing] = await pool.query(
        `SELECT 1 FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'blocked'`,
        [me, targetUserId]
      );
      if (existing.length) {
        return sendError(res, 409, ErrorCodes.ALREADY_BLOCKED, '你已经拉黑了该用户');
      }

      // 同一事务内：upsert 单向 blocked + 清除对称行 + 删除双方关注关系，
      // 保证「拉黑即解除关注/好友」原子生效，避免半途失败留下脏数据。
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query(
          `INSERT INTO user_friends (user_id, friend_id, status, requested_by)
           VALUES (?, ?, 'blocked', ?)
           ON DUPLICATE KEY UPDATE status = 'blocked', requested_by = VALUES(requested_by), updated_at = CURRENT_TIMESTAMP`,
          [me, targetUserId, me]
        );
        await conn.query(
          `DELETE FROM user_friends WHERE user_id = ? AND friend_id = ?`,
          [targetUserId, me]
        );
        // 拉黑同时解除双向关注
        await conn.query(
          `DELETE FROM user_follows WHERE (follower_id = ? AND following_id = ?) OR (follower_id = ? AND following_id = ?)`,
          [me, targetUserId, targetUserId, me]
        );
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
      return ok(res, { ok: true });
    } catch (e) {
      handleError(res, e, '[friends/block]');
    }
  });

  // ==================== GET /api/friends?status=accepted（当前用户视角列表） ====================
  router.get('/', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const status = ['pending', 'accepted', 'blocked'].includes(req.query.status)
        ? req.query.status : 'accepted';
      const pool = getPool();

      // G-08：排序/筛选/分页
      // sort: recent(默认,按好友关系更新时间) | name(昵称) | since(加好友时间)
      // online: all(默认) | online | offline（按 group_roster.is_online）
      // q: 按显示名/VRChat 名模糊搜索
      const sortMap = {
        recent: 'f.updated_at DESC',
        name: 'u.display_name ASC',
        since: 'f.created_at DESC'
      };
      const sort = sortMap[req.query.sort] || sortMap.recent;
      const onlineFilter = ['online', 'offline'].includes(req.query.online) ? req.query.online : '';
      const q = (req.query.q || '').trim();
      const { page, pageSize, offset } = paginate(req, { defaultSize: 50, maxSize: 200 });

      const where = ['f.user_id = ?', 'f.status = ?', 'u.deleted_at IS NULL'];
      const params = [me, status];
      if (q) {
        where.push('(u.display_name LIKE ? OR u.vrchat_name LIKE ?)');
        const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;
        params.push(like, like);
      }
      // 在线筛选：JOIN group_roster 判断
      const onlineJoin = `LEFT JOIN group_roster gr ON gr.vrchat_id = u.vrchat_id`;
      if (onlineFilter === 'online') where.push('gr.is_online = 1');
      else if (onlineFilter === 'offline') where.push('(gr.is_online = 0 OR gr.is_online IS NULL)');
      const whereSql = 'WHERE ' + where.join(' AND ');

      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total
         FROM user_friends f JOIN users u ON u.id = f.friend_id ${onlineJoin} ${whereSql}`,
        params
      );

      const [rows] = await pool.query(
        `SELECT u.id, u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
                f.status, f.created_at AS since, f.requested_by AS requestedBy,
                COALESCE(gr.is_online, 0) AS isOnline, gr.vrchat_status, gr.world_name, gr.location
         FROM user_friends f
         JOIN users u ON u.id = f.friend_id
         ${onlineJoin}
         ${whereSql}
         ORDER BY ${sort}
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );
      const list = rows.map(r => ({
        ...toUserSummary(r),
        status: r.status,
        since: r.since,
        requestedBy: r.requestedBy,
        isOnline: !!r.isOnline,
        vrchatStatus: r.vrchat_status || 'offline'
      }));
      res.json({
        list,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      });
    } catch (e) {
      handleError(res, e, '[friends/list]');
    }
  });

  // ==================== GET /api/friends/requests（待处理 incoming/outgoing） ====================
  router.get('/requests', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const pool = getPool();
      const [incoming] = await pool.query(
        `SELECT u.id, u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
                f.id AS requestId, f.created_at AS requestedAt
         FROM user_friends f
         JOIN users u ON u.id = f.user_id
         WHERE f.friend_id = ? AND f.status = 'pending' AND u.deleted_at IS NULL
         ORDER BY f.created_at DESC`,
        [me]
      );
      const [outgoing] = await pool.query(
        `SELECT u.id, u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
                f.id AS requestId, f.created_at AS requestedAt
         FROM user_friends f
         JOIN users u ON u.id = f.friend_id
         WHERE f.user_id = ? AND f.status = 'pending' AND u.deleted_at IS NULL
         ORDER BY f.created_at DESC`,
        [me]
      );
      res.json({
        incoming: incoming.map(r => ({
          ...toUserSummary(r), requestId: r.requestId, requestedAt: r.requestedAt
        })),
        outgoing: outgoing.map(r => ({
          ...toUserSummary(r), requestId: r.requestId, requestedAt: r.requestedAt
        }))
      });
    } catch (e) {
      handleError(res, e, '[friends/requests]');
    }
  });

  // ==================== GET /api/friends/status/:userId ====================
  router.get('/status/:userId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const target = parseInt(req.params.userId);
      if (!target || isNaN(target)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();
      const [mine] = await pool.query(
        `SELECT status FROM user_friends WHERE user_id = ? AND friend_id = ?`,
        [me, target]
      );
      const [theirs] = await pool.query(
        `SELECT status FROM user_friends WHERE user_id = ? AND friend_id = ?`,
        [target, me]
      );
      const myStatus = mine.length ? mine[0].status : null;
      const theirStatus = theirs.length ? theirs[0].status : null;

      let status = 'none';
      let direction = null;
      let blockedByThem = false;
      if (myStatus === 'accepted') {
        status = 'accepted';
      } else if (myStatus === 'pending') {
        status = 'pending'; direction = 'out';
      } else if (myStatus === 'blocked') {
        status = 'blocked'; direction = 'out';
      } else if (theirStatus === 'pending') {
        status = 'pending'; direction = 'in';
      } else if (theirStatus === 'blocked') {
        status = 'blocked'; direction = 'in'; blockedByThem = true;
      }
      res.json({ status, direction, blockedByThem });
    } catch (e) {
      handleError(res, e, '[friends/status]');
    }
  });

  // ==================== F-11 共同好友（本地 user_friends 交集） ====================
  // 批量：当前用户每个「已接受好友」的共同好友数量（一次查询返回 { [friendId]: count }）
  router.get('/mutuals', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT f2.user_id AS friendId, COUNT(*) AS mutualCount
         FROM user_friends f1
         JOIN user_friends f2 ON f1.friend_id = f2.friend_id
         WHERE f1.user_id = ? AND f1.status = 'accepted' AND f2.status = 'accepted'
           AND f1.friend_id != ? AND f1.friend_id != f2.user_id
         GROUP BY f2.user_id`,
        [me, me]
      );
      const counts = {};
      rows.forEach(r => { counts[r.friendId] = r.mutualCount; });
      res.json({ counts });
    } catch (e) {
      handleError(res, e, '[friends/mutuals]');
    }
  });

  // ==================== F-12 好友动态 Feed ====================
  // 聚合「已接受好友」近期内容动态（动态/活动报名/相册照片），按时间倒序分页。
  // 纯读聚合现有内容表，无需新增表；可见性沿用各表既有规则：
  //   动态：public / members_only（私密动态不外泄）
  //   活动报名：仅展示报名动作本身（event_sign.sign_time 非空）
  //   相册照片：public / members_only 且未回收
  router.get('/feed', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const { page, pageSize, offset } = paginate(req, { defaultSize: 20, maxSize: 50 });
      const pool = getPool();

      // 取出已接受好友 id 列表（空则直接返回空 feed，避免 IN () 语法错误）
      const [friends] = await pool.query(
        `SELECT friend_id FROM user_friends WHERE user_id = ? AND status = 'accepted'`,
        [me]
      );
      const ids = friends.map(f => f.friend_id);
      if (!ids.length) {
        return res.json({ items: [], total: 0, page, pageSize });
      }
      const ph = ids.map(() => '?').join(',');
      // album/event_sign 的 user_vrcid 存数字用户ID（字符串）或 VRChat ID（usr_xxx），
      // 同时兼容历史存 vrchat_name 的旧数据——三者都匹配，避免任一格式漏查。
      const idStrs = ids.map(String);
      const phStr = idStrs.map(() => '?').join(',');

      // 三类动态分别查询（各自 LIMIT 保证足够候选，最终统一排序截断）
      // 1) 动态 posts
      const [posts] = await pool.query(
        `SELECT p.id, p.user_id, p.content, p.type, p.created_at, p.like_count, p.comment_count,
                u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
         FROM posts p JOIN users u ON u.id = p.user_id
         WHERE p.user_id IN (${ph}) AND p.visibility IN ('public','members_only')
           AND u.deleted_at IS NULL
         ORDER BY p.created_at DESC LIMIT ?`, [...ids, pageSize]
      );
      // 2) 活动报名 event_sign（仅已确认报名）
      const [signs] = await pool.query(
        `SELECT s.id, s.event_id, s.user_vrcid, s.user_name, s.sign_time,
                e.title AS event_title
         FROM event_sign s JOIN event e ON e.id = s.event_id
         WHERE (s.user_vrcid IN (${phStr}) OR s.user_vrcid IN (
           SELECT vrchat_name FROM users WHERE id IN (${ph}) AND vrchat_name IS NOT NULL AND vrchat_name != ''
         ) OR s.user_vrcid IN (
           SELECT vrchat_id FROM users WHERE id IN (${ph}) AND vrchat_id IS NOT NULL AND vrchat_id != ''
         )) AND s.is_sign = 1 AND s.sign_time IS NOT NULL
         ORDER BY s.sign_time DESC LIMIT ?`, [...idStrs, ...ids, ...ids, pageSize]
      );
      // 3) 相册照片 album_photo
      const [photos] = await pool.query(
        `SELECT a.id, a.upload_vrcid, a.upload_name, a.photo_desc, a.photo_path, a.thumb_path,
                a.like_count, a.create_time
         FROM album_photo a
         WHERE (a.upload_vrcid IN (${phStr}) OR a.upload_vrcid IN (
           SELECT vrchat_name FROM users WHERE id IN (${ph}) AND vrchat_name IS NOT NULL AND vrchat_name != ''
         ) OR a.upload_vrcid IN (
           SELECT vrchat_id FROM users WHERE id IN (${ph}) AND vrchat_id IS NOT NULL AND vrchat_id != ''
         )) AND a.visibility IN ('public','members_only') AND a.is_recycle = 0
         ORDER BY a.create_time DESC LIMIT ?`, [...idStrs, ...ids, ...ids, pageSize]
      );

      // 归一化为统一 feed item
      const items = [];
      posts.forEach(p => {
        items.push({
          kind: 'post',
          id: 'post_' + p.id,
          userId: p.user_id,
          userName: p.display_name || p.vrchat_name || '用户',
          avatarUrl: getAvatarUrl(p) || '/api/avatar/default',
          time: p.created_at,
          content: p.content || '',
          type: p.type,
          likeCount: p.like_count || 0,
          commentCount: p.comment_count || 0
        });
      });
      signs.forEach(s => {
        items.push({
          kind: 'event_sign',
          id: 'sign_' + s.id,
          userName: s.user_name || '用户',
          avatarUrl: '/api/avatar/default',
          time: s.sign_time,
          eventId: s.event_id,
          eventTitle: s.event_title || ''
        });
      });
      photos.forEach(a => {
        items.push({
          kind: 'photo',
          id: 'photo_' + a.id,
          userName: a.upload_name || '用户',
          avatarUrl: '/api/avatar/default',
          time: a.create_time,
          photoPath: a.photo_path,
          thumbPath: a.thumb_path,
          desc: a.photo_desc || '',
          likeCount: a.like_count || 0
        });
      });

      // 统一按时间倒序排序，截断到本页
      items.sort((x, y) => new Date(y.time) - new Date(x.time));
      const total = items.length;
      const pageItems = items.slice(offset, offset + pageSize);

      res.json({ items: pageItems, total, page, pageSize });
    } catch (e) {
      handleError(res, e, '[friends/feed]');
    }
  });

  // ==================== F-13 GET /api/friends/history/:userId ====================
  // 好友变更历史（改名/换头像/上下线/状态/世界），由定时任务写入 friend_log 表
  router.get('/history/:userId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const target = parseInt(req.params.userId);
      if (!target || isNaN(target)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();

      // 校验 target 是本人或已接受好友，越权直接拒绝
      if (target !== me) {
        const [rel] = await pool.query(
          `SELECT id FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
          [me, target]
        );
        if (!rel.length) {
          return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权查看该用户的好友变更历史');
        }
      }

      // 取目标用户的 VRChat 标识（friend_log.vrchat_id 存的是 VRChat 用户 ID 如 usr_xxx；
      // 兼容历史上可能存的 vrchat_name）。历史 bug：只用 vrchat_name 匹配导致查询恒空。
      const [urows] = await pool.query(
        `SELECT vrchat_name, vrchat_id FROM users WHERE id = ? AND deleted_at IS NULL`, [target]
      );
      if (!urows.length || (!urows[0].vrchat_id && !urows[0].vrchat_name)) {
        return res.json({ items: [], total: 0 });
      }
      const vrcids = [urows[0].vrchat_id, urows[0].vrchat_name].filter(Boolean);

      const { page, pageSize, offset } = paginate(req, { defaultSize: 30, maxSize: 100 });

      const idPh = vrcids.map(() => '?').join(',');
      const [cntRows] = await pool.query(
        `SELECT COUNT(*) AS c FROM friend_log WHERE vrchat_id IN (${idPh})`, vrcids
      );
      const total = cntRows[0].c || 0;

      const [items] = await pool.query(
        `SELECT id, change_type, old_value, new_value, created_at
         FROM friend_log WHERE vrchat_id IN (${idPh})
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
        [...vrcids, pageSize, offset]
      );

      res.json({
        items: items.map(r => ({
          id: r.id,
          type: r.change_type,
          oldValue: r.old_value,
          newValue: r.new_value,
          time: r.created_at
        })),
        total, page, pageSize
      });
    } catch (e) {
      handleError(res, e, '[friends/history]');
    }
  });

  // ==================== F-14 GET /api/friends/world-history/:userId ====================
  // 世界访问足迹（进入过的世界 + 访问次数 + 首次/最近访问时间），由定时任务写入 world_visit_log 表。
  router.get('/world-history/:userId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const target = parseInt(req.params.userId);
      if (!target || isNaN(target)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();

      // 校验 target 是本人或已接受好友（与 F-13 历史接口一致）
      if (target !== me) {
        const [rel] = await pool.query(
          `SELECT id FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
          [me, target]
        );
        if (!rel.length) {
          return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权查看该用户的足迹');
        }
      }

      // 取目标用户 VRChat 标识（world_visit_log.vrchat_id 存 VRChat 用户 ID 如 usr_xxx；
      // 兼容历史 vrchat_name）。历史 bug：只用 vrchat_name 匹配导致查询恒空。
      const [urows] = await pool.query(
        `SELECT vrchat_name, vrchat_id FROM users WHERE id = ? AND deleted_at IS NULL`, [target]
      );
      if (!urows.length || (!urows[0].vrchat_id && !urows[0].vrchat_name)) {
        return res.json({ items: [], total: 0 });
      }
      const vrcids = [urows[0].vrchat_id, urows[0].vrchat_name].filter(Boolean);
      const idPh = vrcids.map(() => '?').join(',');

      // 足迹聚合：LEFT JOIN vrc_worlds_cache 富化真实世界名（world_visit_log.world_name 实存 world_id）
      const [items] = await pool.query(
        `SELECT w.world_id, COALESCE(NULLIF(c.world_name,''), w.world_name) AS world_name,
                w.visit_count, w.first_visit_at, w.last_visit_at
         FROM world_visit_log w
         LEFT JOIN vrc_worlds_cache c ON c.world_id = w.world_id
         WHERE w.vrchat_id IN (${idPh})
         ORDER BY w.last_visit_at DESC, w.visit_count DESC
         LIMIT 100`,
        vrcids
      );

      // 缓存未命中的世界（仍是裸 wrld_ ID 且验证格式）→ 异步回填，不阻塞本次响应
      try {
        const missing = items
          .filter(it => /^wrld_[0-9a-fA-F-]+$/i.test(it.world_name || '') && it.world_id === it.world_name)
          .map(it => it.world_id)
          .slice(0, 10);
        if (missing.length) {
          const { getCachedWorld } = require('../world_cache');
          missing.forEach(id => { getCachedWorld(id).catch(() => {}); });
        }
      } catch (e) { /* 回填失败不影响响应 */ }

      const [cntRows] = await pool.query(
        `SELECT COUNT(*) AS c, COALESCE(SUM(visit_count),0) AS visits FROM world_visit_log WHERE vrchat_id IN (${idPh})`,
        vrcids
      );

      res.json({
        items: items.map(r => ({
          worldId: r.world_id,
          worldName: r.world_name,
          visitCount: r.visit_count,
          firstVisitAt: r.first_visit_at,
          lastVisitAt: r.last_visit_at
        })),
        totalWorlds: cntRows[0].c || 0,
        totalVisits: cntRows[0].visits || 0
      });
    } catch (e) {
      handleError(res, e, '[friends/world-history]');
    }
  });

  // ==================== F-16 GET /api/friends/avatar-history/:userId ====================
  // 头像使用历史（使用过的头像 + 使用次数 + 首次/最近使用时间 + 最近观测缩略图），由定时任务写入 avatar_history_log 表。
  router.get('/avatar-history/:userId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const target = parseInt(req.params.userId);
      if (!target || isNaN(target)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();

      // 校验 target 是本人或已接受好友（与 F-13/F-14 历史接口一致）
      if (target !== me) {
        const [rel] = await pool.query(
          `SELECT id FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
          [me, target]
        );
        if (!rel.length) {
          return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权查看该用户的头像历史');
        }
      }

      // 取目标用户 VRChat 标识（avatar_history_log.vrchat_id 存 VRChat 用户 ID 如 usr_xxx；
      // 兼容历史 vrchat_name）。历史 bug：只用 vrchat_name 匹配导致查询恒空。
      const [urows] = await pool.query(
        `SELECT vrchat_name, vrchat_id FROM users WHERE id = ? AND deleted_at IS NULL`, [target]
      );
      if (!urows.length || (!urows[0].vrchat_id && !urows[0].vrchat_name)) {
        return res.json({ items: [], total: 0 });
      }
      const vrcids = [urows[0].vrchat_id, urows[0].vrchat_name].filter(Boolean);
      const idPh = vrcids.map(() => '?').join(',');

      // 头像历史聚合：按 avatar_id 去重，返回使用次数与首次/最近使用时间，按最近使用倒序
      const [items] = await pool.query(
        `SELECT avatar_id, avatar_url, use_count, first_seen_at, last_seen_at
         FROM avatar_history_log WHERE vrchat_id IN (${idPh})
         ORDER BY last_seen_at DESC, use_count DESC
         LIMIT 100`,
        vrcids
      );

      const [cntRows] = await pool.query(
        `SELECT COUNT(*) AS c, COALESCE(SUM(use_count),0) AS uses FROM avatar_history_log WHERE vrchat_id IN (${idPh})`,
        vrcids
      );

      res.json({
        items: items.map(r => ({
          avatarId: r.avatar_id,
          avatarUrl: r.avatar_url,
          useCount: r.use_count,
          firstSeenAt: r.first_seen_at,
          lastSeenAt: r.last_seen_at
        })),
        totalAvatars: cntRows[0].c || 0,
        totalUses: cntRows[0].uses || 0
      });
    } catch (e) {
      handleError(res, e, '[friends/avatar-history]');
    }
  });

  // ==================== F-21 GET /api/friends/activity-sessions/:userId ====================
  // 在线活动时间轴：会话明细（开始/结束/时长/所在世界）+ 按天在线分钟聚合，
  // 由定时任务（schedule.js F-21 在线会话采样）写入 activity_sessions 表。
  // days 参数（默认 30，上限 90）限定时间范围；进行中会话始终返回（便于「当前在线」展示）。
  router.get('/activity-sessions/:userId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const target = parseInt(req.params.userId);
      if (!target || isNaN(target)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const days = Math.min(parseInt(req.query.days) || 30, 90);
      const pool = getPool();

      // 校验 target 是本人或已接受好友（与 F-13/F-14/F-16 历史接口一致，防社交图枚举）
      if (target !== me) {
        const [rel] = await pool.query(
          `SELECT id FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
          [me, target]
        );
        if (!rel.length) {
          return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权查看该用户的在线活动');
        }
      }

      // 取目标用户的 VRChat ID（activity_sessions.vrchat_id 存的是 VRChat 用户 ID
      // 如 usr_xxx，来自 group_roster.vrchat_id，而非显示名 vrchat_name）。
      // 历史 bug：此处曾用 vrchat_name 匹配，导致所有会话查询恒为空。
      const [urows] = await pool.query(
        `SELECT vrchat_id FROM users WHERE id = ? AND deleted_at IS NULL`, [target]
      );
      if (!urows.length || !urows[0].vrchat_id) {
        return res.json({ items: [], daily: [], totalMinutes: 0, onlineNow: false });
      }
      const vrcid = urows[0].vrchat_id;

      // 会话明细：时间范围内已封口会话 + 全部进行中会话（进行中即使 started_at 在范围外也返回）
      const [items] = await pool.query(
        `SELECT id, vrchat_id, started_at, ended_at, duration_minutes, world_id, world_name
         FROM activity_sessions WHERE vrchat_id = ?
         AND (started_at >= NOW() - INTERVAL ? DAY OR ended_at IS NULL)
         ORDER BY started_at DESC
         LIMIT 500`,
        [vrcid, days]
      );

      // 按天聚合在线分钟数（进行中会话按已持续分钟计入当天）
      const [dailyRows] = await pool.query(
        `SELECT DATE(started_at) AS day,
           SUM(CASE WHEN ended_at IS NOT NULL THEN duration_minutes
                    ELSE TIMESTAMPDIFF(MINUTE, started_at, NOW()) END) AS minutes
         FROM activity_sessions WHERE vrchat_id = ? AND started_at >= NOW() - INTERVAL ? DAY
         GROUP BY DATE(started_at) ORDER BY day DESC`,
        [vrcid, days]
      );

      // 当前是否在线（存在进行中会话）
      const [nowRows] = await pool.query(
        `SELECT id FROM activity_sessions WHERE vrchat_id = ? AND ended_at IS NULL LIMIT 1`,
        [vrcid]
      );

      res.json({
        items: items.map(r => ({
          id: r.id,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          durationMinutes: r.duration_minutes,
          worldId: r.world_id,
          worldName: r.world_name,
          ongoing: !r.ended_at
        })),
        daily: dailyRows.map(r => ({
          day: r.day,
          minutes: Math.max(0, Math.round(r.minutes || 0))
        })),
        totalMinutes: Math.max(0, Math.round(dailyRows.reduce((s, r) => s + (r.minutes || 0), 0))),
        onlineNow: nowRows.length > 0
      });
    } catch (e) {
      handleError(res, e, '[friends/activity-sessions]');
    }
  });

  // ==================== F-04 GET /api/friends/together-time/:userId ====================
  // 计算「我」与指定好友的在线会话重叠总时长（借鉴 VRCNext Stats「共度时间」）。
  // 数据源 activity_sessions（按 vrchat_id 存会话区间），双指针求两串区间交集。
  router.get('/together-time/:userId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const target = parseInt(req.params.userId);
      if (!target || isNaN(target) || target === me) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const days = Math.min(parseInt(req.query.days) || 30, 90);
      const pool = getPool();

      // 越权校验：仅本人或已接受好友可查（防社交图枚举）
      const [rel] = await pool.query(
        `SELECT id FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
        [me, target]
      );
      if (!rel.length) {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权查看与该用户的共度时间');
      }

      // 取双方 VRChat ID（activity_sessions.vrchat_id 存 VRChat 用户 ID，非显示名）
      const [urows] = await pool.query(
        `SELECT id, vrchat_id FROM users WHERE id IN (?, ?) AND deleted_at IS NULL`, [me, target]
      );
      const meRow = urows.find(u => u.id === me);
      const tRow = urows.find(u => u.id === target);
      if (!meRow || !meRow.vrchat_id || !tRow || !tRow.vrchat_id) {
        return res.json({ totalMinutes: 0, sessions: [], myMinutes: 0, theirMinutes: 0, days });
      }

      const loadSessions = async (vrcid) => {
        const [rows] = await pool.query(
          `SELECT started_at, ended_at, duration_minutes, world_name, world_id
           FROM activity_sessions WHERE vrchat_id = ?
             AND (started_at >= NOW() - INTERVAL ? DAY OR ended_at IS NULL)
           ORDER BY started_at ASC LIMIT 1000`,
          [vrcid, days]
        );
        const now = Date.now();
        return rows.map(r => {
          const start = new Date(r.started_at).getTime();
          const end = r.ended_at ? new Date(r.ended_at).getTime() : now;
          return { start, end, worldName: r.world_name || '', worldId: r.world_id || '' };
        }).filter(s => s.end > s.start);
      };

      const [mine, theirs] = await Promise.all([loadSessions(meRow.vrchat_id), loadSessions(tRow.vrchat_id)]);
      const sumMin = (arr) => Math.round(arr.reduce((s, x) => s + (x.end - x.start), 0) / 60000);

      // 双指针求区间交集（两者均已按 start 升序）
      const sessions = [];
      let totalMs = 0, i = 0, j = 0;
      while (i < mine.length && j < theirs.length) {
        const s = Math.max(mine[i].start, theirs[j].start);
        const e = Math.min(mine[i].end, theirs[j].end);
        if (e > s) {
          totalMs += (e - s);
          sessions.push({
            startedAt: new Date(s).toISOString(),
            endedAt: new Date(e).toISOString(),
            minutes: Math.round((e - s) / 60000),
            worldName: mine[i].worldName || theirs[j].worldName || ''
          });
        }
        if (mine[i].end < theirs[j].end) i++; else j++;
      }
      // 重叠明细按时间倒序（最近的在前），最多 50 条
      sessions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

      res.json({
        totalMinutes: Math.round(totalMs / 60000),
        sessions: sessions.slice(0, 50),
        sessionCount: sessions.length,
        myMinutes: sumMin(mine),
        theirMinutes: sumMin(theirs),
        days
      });
    } catch (e) {
      handleError(res, e, '[friends/together-time]');
    }
  });

  // ==================== F-05 GET /api/friends/milestones/:userId ====================
  // 友谊里程碑：把在线会话聚合成带语义的时间线（初识 / 重逢 / 换世界）。
  // 数据源 activity_sessions（vrchat_id 为键，已验证与 users.vrchat_id 同源）。
  router.get('/milestones/:userId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const target = parseInt(req.params.userId);
      if (!target || isNaN(target) || target === me) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();
      // 越权校验：仅本人或已接受好友
      const [rel] = await pool.query(
        `SELECT id FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
        [me, target]
      );
      if (!rel.length) {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权查看该用户的里程碑');
      }
      const [urows] = await pool.query(
        `SELECT vrchat_name, vrchat_id FROM users WHERE id = ? AND deleted_at IS NULL`, [target]
      );
      if (!urows.length || (!urows[0].vrchat_id && !urows[0].vrchat_name)) {
        return res.json({ firstMet: null, milestones: [], totalSessions: 0, spanDays: 0 });
      }
      const vrcids = [urows[0].vrchat_id, urows[0].vrchat_name].filter(Boolean);
      const idPh = vrcids.map(() => '?').join(',');

      const [rows] = await pool.query(
        `SELECT started_at, ended_at, duration_minutes, world_name, world_id
         FROM activity_sessions WHERE vrchat_id IN (${idPh})
         ORDER BY started_at ASC LIMIT 2000`, vrcids
      );
      if (!rows.length) {
        return res.json({ firstMet: null, milestones: [], totalSessions: 0, spanDays: 0 });
      }

      const REUNION_GAP_MS = 7 * 24 * 3600 * 1000; // 间隔 ≥7 天视为「重逢」
      const milestones = [];
      let prev = null;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const t = new Date(r.started_at).getTime();
        if (i === 0) {
          milestones.push({ type: 'first_meet', time: r.started_at, detail: r.world_name || '' });
        } else {
          const gap = t - new Date(prev.started_at).getTime();
          if (gap >= REUNION_GAP_MS) {
            milestones.push({ type: 'reunion', time: r.started_at, detail: r.world_name || '', gapDays: Math.round(gap / 86400000) });
          } else if (r.world_name && prev.world_name && r.world_name !== prev.world_name) {
            milestones.push({ type: 'world_change', time: r.started_at, detail: r.world_name, from: prev.world_name });
          }
        }
        prev = r;
      }
      // 里程碑过多时保留首尾与重逢/换世界（限制 200 条防刷屏）
      const trimmed = milestones.length > 200 ? milestones.slice(0, 1).concat(milestones.slice(-199)) : milestones;

      const first = rows[0];
      const last = rows[rows.length - 1];
      const spanDays = Math.max(0, Math.round(
        (new Date(last.started_at).getTime() - new Date(first.started_at).getTime()) / 86400000
      ));

      res.json({
        firstMet: first ? { time: first.started_at, worldName: first.world_name || '' } : null,
        lastSeen: last ? { time: last.started_at, worldName: last.world_name || '' } : null,
        totalSessions: rows.length,
        spanDays,
        milestones: trimmed.map(m => ({
          type: m.type,
          time: m.time,
          detail: m.detail || '',
          from: m.from || '',
          gapDays: m.gapDays || 0
        }))
      });
    } catch (e) {
      handleError(res, e, '[friends/milestones]');
    }
  });

  // ==================== F-06 GET /api/friends/in-world/:worldId ====================
  // 世界详情增强：查询「我的好友中有谁正在这个世界的哪个实例」。
  // group_roster.location 形如 wrld_xxx:instanceId~hidden(usr_x)~region(jp)，world_name 列实存 world_id。
  // 仅返回我的已接受好友（防泄露非好友行踪）。
  router.get('/in-world/:worldId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const worldId = String(req.params.worldId || '').trim();
      if (!/^wrld_[A-Za-z0-9-]+$/.test(worldId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '世界 ID 格式不正确');
      }
      const pool = getPool();

      // 取我的已接受好友对应的 users 记录（vrchat_id 为关联键）
      const [rows] = await pool.query(
        `SELECT r.vrchat_id, r.vrchat_name, r.display_name, r.location, r.world_name,
                u.id AS user_id, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
         FROM group_roster r
         JOIN users u ON u.vrchat_id = r.vrchat_id AND u.deleted_at IS NULL
         JOIN user_friends f ON f.friend_id = u.id AND f.user_id = ? AND f.status = 'accepted'
         WHERE r.is_online = 1
           AND (r.location LIKE CONCAT(?, ':%') OR r.location = ? OR r.world_name = ?)
         ORDER BY r.display_name ASC
         LIMIT 200`,
        [me, worldId, worldId, worldId]
      );

      // 富化世界名（group_roster.world_name 实存 world_id）：查缓存，未命中则异步回填
      let worldName = '';
      try {
        const [wc] = await pool.query(
          `SELECT world_name FROM vrc_worlds_cache WHERE world_id = ? AND world_name != '' LIMIT 1`, [worldId]
        );
        if (wc.length && wc[0].world_name) worldName = wc[0].world_name;
        else {
          const { getCachedWorld } = require('../world_cache');
          getCachedWorld(worldId).catch(() => {});
        }
      } catch (e) { /* 富化失败不影响主响应 */ }

      // 解析实例信息：type（public/friends+/hidden/private）+ region
      const parseInstance = (loc) => {
        if (!loc || loc === 'private') return { instanceType: 'private', region: '', instanceId: '' };
        const [head, ...tags] = String(loc).split('~');
        const instanceId = (head || '').split(':')[1] || '';
        let instanceType = 'public';
        let region = '';
        for (const tag of tags) {
          if (tag.startsWith('hidden(')) instanceType = 'friends+';
          else if (tag.startsWith('friends(')) instanceType = 'friends';
          else if (tag.startsWith('private(')) instanceType = 'private';
          else if (tag.startsWith('region(')) region = tag.slice(7, -1);
          else if (tag === 'canRequestInvite') instanceType = instanceType === 'public' ? 'invite+' : instanceType;
        }
        if (!instanceId) instanceType = 'private';
        return { instanceType, region, instanceId };
      };

      const friends = rows.map(r => {
        const info = parseInstance(r.location);
        return {
          userId: r.user_id,
          vrchatId: r.vrchat_id,
          displayName: r.display_name || r.vrchat_name || '',
          avatarUrl: getAvatarUrl(r) || '/api/avatar/default',
          instanceType: info.instanceType,
          region: info.region,
          instanceId: info.instanceId
        };
      });

      // 按实例分组统计
      const byInstance = {};
      friends.forEach(f => {
        const k = f.instanceId || 'unknown';
        if (!byInstance[k]) byInstance[k] = { instanceId: k, instanceType: f.instanceType, region: f.region, count: 0 };
        byInstance[k].count++;
      });

      res.json({
        worldId,
        worldName,   // 真实世界名（缓存未命中时为空，前端可回退显示 ID）
        friendCount: friends.length,
        friends,
        instances: Object.values(byInstance).sort((a, b) => b.count - a.count)
      });
    } catch (e) {
      handleError(res, e, '[friends/in-world]');
    }
  });

  // ==================== F-06 POST /api/friends/in-worlds ====================
  // 批量版：一次查询多个世界里各有几位我的好友（供世界搜索结果列表展示徽章）。
  // body: { worldIds: ['wrld_x', 'wrld_y'] }（最多 30 个）
  router.post('/in-worlds', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const raw = Array.isArray(req.body && req.body.worldIds) ? req.body.worldIds : [];
      const ids = [...new Set(raw.map(String).filter(w => /^wrld_[A-Za-z0-9-]+$/.test(w)))].slice(0, 30);
      if (!ids.length) return res.json({ counts: {} });
      const pool = getPool();
      const ph = ids.map(() => '?').join(',');
      // 一次性取这些世界内、且属于我好友的在线成员，按世界分组计数
      const [rows] = await pool.query(
        `SELECT r.world_name AS wid, COUNT(*) AS n
         FROM group_roster r
         JOIN users u ON u.vrchat_id = r.vrchat_id AND u.deleted_at IS NULL
         JOIN user_friends f ON f.friend_id = u.id AND f.user_id = ? AND f.status = 'accepted'
         WHERE r.is_online = 1 AND r.world_name IN (${ph})
         GROUP BY r.world_name`,
        [me, ...ids]
      );
      const counts = {};
      ids.forEach(id => { counts[id] = 0; });
      rows.forEach(r => { if (r.wid) counts[r.wid] = Number(r.n) || 0; });
      res.json({ counts });
    } catch (e) {
      handleError(res, e, '[friends/in-worlds]');
    }
  });

  // ==================== G-01 GET /api/friends/world-ranking ====================
  // 群组世界热度排行：全体成员最常去的世界（访问次数 + 去过的成员数），
  // 世界名通过 vrc_worlds_cache 富化（world_visit_log.world_name 实存 world_id）。
  router.get('/world-ranking', requireAuth, async (req, res) => {
    try {
      // 取前 N 名（top，非分页参数，避免与 paginate 守卫冲突）
      const topN = Math.min(Math.max(parseInt(req.query.top, 10) || 20, 1), 50);
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT w.world_id,
                COALESCE(NULLIF(c.world_name, ''), w.world_name) AS world_name,
                c.image_url,
                SUM(w.visit_count) AS total_visits,
                COUNT(DISTINCT w.vrchat_id) AS visitor_count
         FROM world_visit_log w
         LEFT JOIN vrc_worlds_cache c ON c.world_id = w.world_id
         WHERE w.world_id LIKE 'wrld_%'
         GROUP BY w.world_id, world_name, c.image_url
         ORDER BY total_visits DESC, visitor_count DESC
         LIMIT ?`,
        [topN]
      );
      // 缓存未命中的世界异步回填真实名称（不阻塞响应）
      try {
        const { getCachedWorld } = require('../world_cache');
        rows
          .filter(r => /^wrld_[0-9a-fA-F-]+$/i.test(r.world_name || '') && r.world_name === r.world_id)
          .slice(0, 10)
          .forEach(r => { getCachedWorld(r.world_id).catch(() => {}); });
      } catch (e) { /* 回填失败不影响响应 */ }

      res.json({
        items: rows.map((r, i) => ({
          rank: i + 1,
          worldId: r.world_id,
          worldName: r.world_name || r.world_id,
          imageUrl: r.image_url || '',
          totalVisits: Number(r.total_visits) || 0,
          visitorCount: Number(r.visitor_count) || 0
        }))
      });
    } catch (e) {
      handleError(res, e, '[friends/world-ranking]');
    }
  });

  // ==================== G-02 GET /api/friends/activity-ranking ====================
  // 好友活跃度榜：按时间窗口聚合在线时长排行（仅统计我的已接受好友）。
  // 数据源 activity_sessions（vrchat_id 为键），JOIN users + user_friends 限定好友范围。
  router.get('/activity-ranking', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
      const topN = Math.min(Math.max(parseInt(req.query.top, 10) || 20, 1), 50);
      const pool = getPool();

      const [rows] = await pool.query(
        `SELECT u.id AS user_id, u.display_name, u.vrchat_name, u.vrchat_id,
                u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
                COUNT(a.id) AS session_count,
                COALESCE(SUM(CASE WHEN a.ended_at IS NOT NULL THEN a.duration_minutes
                                  ELSE TIMESTAMPDIFF(MINUTE, a.started_at, NOW()) END), 0) AS total_minutes
         FROM users u
         JOIN user_friends f ON f.friend_id = u.id AND f.user_id = ? AND f.status = 'accepted'
         JOIN activity_sessions a ON a.vrchat_id = u.vrchat_id
         WHERE u.deleted_at IS NULL AND u.vrchat_id IS NOT NULL AND u.vrchat_id != ''
           AND (a.started_at >= NOW() - INTERVAL ? DAY OR a.ended_at IS NULL)
         GROUP BY u.id, u.display_name, u.vrchat_name, u.vrchat_id, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
         ORDER BY total_minutes DESC, session_count DESC
         LIMIT ?`,
        [me, days, topN]
      );

      res.json({
        days,
        items: rows.map((r, i) => ({
          rank: i + 1,
          userId: r.user_id,
          displayName: r.display_name || r.vrchat_name || '',
          avatarUrl: getAvatarUrl(r) || '/api/avatar/default',
          sessionCount: Number(r.session_count) || 0,
          totalMinutes: Math.max(0, Math.round(Number(r.total_minutes) || 0))
        }))
      });
    } catch (e) {
      handleError(res, e, '[friends/activity-ranking]');
    }
  });

  // 指定好友的共同好友列表（点开详情）
  router.get('/mutuals/:targetUserId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const target = parseInt(req.params.targetUserId);
      if (!target || isNaN(target) || target === me) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();

      // 校验 target 必须是本人或已接受好友，否则拒绝（与 F-13 history 一致，防社交图枚举）
      if (target !== me) {
        const [rel] = await pool.query(
          `SELECT id FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
          [me, target]
        );
        if (!rel.length) {
          return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权查看该用户的共同好友');
        }
      }

      const [rows] = await pool.query(
        `SELECT u.id, u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
         FROM user_friends f1
         JOIN user_friends f2 ON f1.friend_id = f2.friend_id
         JOIN users u ON u.id = f1.friend_id
         WHERE f1.user_id = ? AND f2.user_id = ? AND f1.status = 'accepted' AND f2.status = 'accepted'
           AND u.deleted_at IS NULL AND f1.friend_id != ? AND f1.friend_id != f2.user_id
         ORDER BY u.display_name`,
        [me, target, me]
      );
      res.json({
        targetId: target,
        count: rows.length,
        mutualFriends: rows.map(r => toUserSummary(r))
      });
    } catch (e) {
      handleError(res, e, '[friends/mutuals/target]');
    }
  });

  return router;
};
