// QA-02: cache_service 行为测试（此前覆盖率 1.87%，仅静态断言）
// 参数化覆盖所有 getX/setX 的 key+TTL、invalidateX 的删除键集、invalidateRelated、
// getCacheStatus 分组统计、clearAll、warmup 的 Redis 未启用短路。
const mockCache = {
  get: jest.fn(), set: jest.fn(), del: jest.fn(), flushAll: jest.fn(),
  getStats: jest.fn(), keys: jest.fn(), isEnabled: jest.fn()
};
jest.mock('../cache', () => mockCache);
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../logger', () => mockLogger);

let svc;
beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  svc = require('../cache_service');
});

describe('cache_service 行为测试', () => {
  // getX(keyFn, args) / setX —— 单实体（带 id）
  const single = [
    ['getUser', 'setUser', 'user', 'USER', 7],
    ['getActivity', 'setActivity', 'activity', 'ACTIVITY', 11],
    ['getPost', 'setPost', 'post', 'POST', 3],
    ['getPhoto', 'setPhoto', 'photo', 'PHOTO', 20],
    ['getAnnouncement', 'setAnnouncement', 'announcement', 'ANNOUNCEMENT', 9],
    ['getWorld', 'setWorld', 'world', 'WORLD_CACHE', 42],
    ['getProfileCard', 'setProfileCard', 'profileCard', 'PROFILE_CARD', 5]
  ];
  test.each(single)('%s/%s 使用正确 key 与 TTL', async (gFn, sFn, keyName, ttlName, id) => {
    const data = { id, v: 1 };
    await svc[sFn](id, data);
    expect(mockCache.set).toHaveBeenCalledWith(svc.cacheKeys[keyName](id), data, svc.CACHE_TTL[ttlName]);
    mockCache.get.mockResolvedValueOnce(data);
    expect(await svc[gFn](id)).toEqual(data);
    expect(mockCache.get).toHaveBeenCalledWith(svc.cacheKeys[keyName](id));
  });

  // 列表型 getX/setX
  const lists = [
    ['getUsers', 'setUsers', 'users', 'USER'],
    ['getActivities', 'setActivities', 'activities', 'ACTIVITY'],
    ['getActivityCalendar', 'setActivityCalendar', 'activitiesCalendar', 'ACTIVITY_CALENDAR'],
    ['getPosts', 'setPosts', 'posts', 'POST'],
    ['getPhotos', 'setPhotos', 'photos', 'PHOTO'],
    ['getAnnouncements', 'setAnnouncements', 'announcements', 'ANNOUNCEMENT'],
    ['getConfig', 'setConfig', 'config', 'CONFIG'],
    ['getStats', 'setStats', 'stats', 'STATS'],
    ['getTopLikes', 'setTopLikes', 'topLikes', 'STATS_TOP_LIKES'],
    ['getOnlineUsers', 'setOnlineUsers', 'onlineUsers', 'USER_ONLINE'],
    ['getWorldList', 'setWorldList', 'worldList', 'WORLD_CACHE'],
    ['getGroupRoster', 'setGroupRoster', 'groupRoster', 'GROUP_ROSTER'],
    ['getGroupRosterOnline', 'setGroupRosterOnline', 'groupRosterOnline', 'USER_ONLINE']
  ];
  test.each(lists)('%s/%s 使用正确 key 与 TTL', async (gFn, sFn, keyName, ttlName) => {
    const data = [{ x: 1 }];
    await svc[sFn](data);
    expect(mockCache.set).toHaveBeenCalledWith(svc.cacheKeys[keyName](), data, svc.CACHE_TTL[ttlName]);
    mockCache.get.mockResolvedValueOnce(data);
    expect(await svc[gFn]()).toEqual(data);
  });

  test('invalidateUser 删用户单条 + 列表 + 资料卡三个 key', async () => {
    await svc.invalidateUser(77);
    const dels = mockCache.del.mock.calls.map(c => c[0]);
    expect(dels).toEqual([
      svc.cacheKeys.user(77), svc.cacheKeys.users(), svc.cacheKeys.profileCard(77)
    ]);
  });

  test('各 invalidateX 删除单条与对应列表 key', async () => {
    const cases = [
      ['invalidateActivity', 1, ['activity', 'activities', 'activitiesCalendar']],
      ['invalidatePost', 2, ['post', 'posts']],
      ['invalidatePhoto', 3, ['photo', 'photos']],
      ['invalidateAnnouncement', 4, ['announcement', 'announcements']],
      ['invalidateWorld', 5, ['world', 'worldList']],
      ['invalidateProfileCard', 6, ['profileCard']],
      ['invalidateGroupRoster', null, ['groupRoster', 'groupRosterOnline']]
    ];
    for (const [fn, id, keys] of cases) {
      mockCache.del.mockClear();
      if (id == null) await svc[fn](); else await svc[fn](id);
      const dels = mockCache.del.mock.calls.map(c => c[0]);
      expect(dels).toEqual(keys.map(k => id == null ? svc.cacheKeys[k]() : svc.cacheKeys[k](id)));
    }
  });

  test('invalidateConfig / invalidateOnlineUsers 删除对应 key', async () => {
    await svc.invalidateConfig();
    expect(mockCache.del).toHaveBeenCalledWith(svc.cacheKeys.config());
    mockCache.del.mockClear();
    await svc.invalidateOnlineUsers();
    expect(mockCache.del).toHaveBeenCalledWith(svc.cacheKeys.onlineUsers());
  });

  test('invalidateRelated 各类型删除正确的关联 key 集合', async () => {
    const expectations = {
      post: ['posts', 'stats'],
      activity: ['activities', 'activitiesCalendar', 'stats'],
      photo: ['photos', 'stats'],
      user: ['users', 'onlineUsers', 'groupRosterOnline', 'topLikes'],
      world: ['worldList'],
      announcement: ['announcements'],
      stats: ['stats', 'topLikes'],
      unknown: []
    };
    for (const [type, keys] of Object.entries(expectations)) {
      mockCache.del.mockClear();
      await svc.invalidateRelated(type);
      expect(mockCache.del.mock.calls.map(c => c[0])).toEqual(keys.map(k => svc.cacheKeys[k]()));
    }
  });

  test('getCacheStatus 按 key 前缀分组统计 + 透传 enabled/redisStats', async () => {
    mockCache.isEnabled.mockReturnValue(true);
    mockCache.keys.mockResolvedValue(['user:1', 'user:2', 'posts:list', 'stats:summary']);
    mockCache.getStats.mockResolvedValue({ hits: 5 });
    const status = await svc.getCacheStatus();
    expect(status).toEqual({
      enabled: true, keyCount: 4,
      keysByType: { user: 2, posts: 1, stats: 1 },
      redisStats: { hits: 5 }
    });
  });

  test('clearAll / del 透传到底层', async () => {
    await svc.clearAll();
    expect(mockCache.flushAll).toHaveBeenCalled();
    await svc.del('custom:key');
    expect(mockCache.del).toHaveBeenCalledWith('custom:key');
  });

  test('warmup：Redis 未启用时短路，不查库', async () => {
    mockCache.isEnabled.mockReturnValue(false);
    const getPool = jest.fn();
    await svc.warmup(getPool);
    expect(getPool).not.toHaveBeenCalled();
  });
});
