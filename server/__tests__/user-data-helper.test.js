// QA-02: user-data-helper 行为测试（此前覆盖率 2.22%，0% functions）
// 覆盖 csvField/safeParseJson 纯函数、resolveUserIdByVrcId、collectUserData 聚合、
// importUserData 各类型导入与无效项跳过。
const mockPool = { query: jest.fn() };
jest.mock('../utils', () => ({
  getPool: () => mockPool,
  formatDateOnly: jest.fn((v) => (v ? String(v).slice(0, 10) : null))
}));

let helper;
beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  helper = require('../routes/user-data-helper');
});

// 按顺序返回每次 query 的结果
function mockQueries(...results) {
  let i = 0;
  mockPool.query.mockImplementation(() => Promise.resolve(results[i++]));
}

describe('csvField / safeParseJson 纯函数', () => {
  test('csvField：普通值原样；含逗号/引号/控制字符加引号并转义内部引号', () => {
    expect(helper.csvField('hello')).toBe('hello');
    expect(helper.csvField(123)).toBe('123');
    expect(helper.csvField(null)).toBe('');
    expect(helper.csvField(undefined)).toBe('');
    expect(helper.csvField('a,b')).toBe('"a,b"');
    expect(helper.csvField('a"b')).toBe('"a""b"');
    expect(helper.csvField('a\nb')).toBe('"a\nb"');
  });

  test('safeParseJson：对象直通 / null 直通 / 合法 JSON 解析 / 非法原样返回', () => {
    const obj = { a: 1 };
    expect(helper.safeParseJson(obj)).toBe(obj);
    expect(helper.safeParseJson(null)).toBeNull();
    expect(helper.safeParseJson('')).toBe('');
    expect(helper.safeParseJson('{"x":2}')).toEqual({ x: 2 });
    expect(helper.safeParseJson('not-json')).toBe('not-json');
  });
});

describe('resolveUserIdByVrcId', () => {
  test('空 ID 返回 0，不查库', async () => {
    expect(await helper.resolveUserIdByVrcId('')).toBe(0);
    expect(mockPool.query).not.toHaveBeenCalled();
  });
  test('查到返回 id，未查到返回 0', async () => {
    mockPool.query.mockResolvedValueOnce([[{ id: 42 }]]);
    expect(await helper.resolveUserIdByVrcId('usr_1')).toBe(42);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('vrchat_id = ?'), ['usr_1']
    );
    mockPool.query.mockResolvedValueOnce([[]]);
    expect(await helper.resolveUserIdByVrcId('usr_x')).toBe(0);
  });
});

describe('collectUserData', () => {
  test('用户不存在返回 null（只查第一张表）', async () => {
    mockQueries([[]]);
    expect(await helper.collectUserData(999)).toBeNull();
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test('完整用户：聚合各表并把 tags/社交/隐私 JSON 字段解析为对象', async () => {
    const user = { id: 1, login_id: 'u', display_name: 'U', vrchat_id: 'v1', vrchat_name: 'V', email: 'e@x',
      birthday: '2000-01-02', location: 'Tokyo', lat: 1, lng: 2 };
    mockQueries(
      [[user]],                                                   // users
      [[{ tag_name: 't1', color: '#fff', create_time: '2026-01-01' }]], // tags
      [[{ id: 5, note_text: 'n', note_color: '#000', note_tags: 'x', update_time: '2026-01-02', target_vrcid: 'v2' }]], // notes
      [[{ friend_id: 2, status: 'friend', requested_by: 1, created_at: '2026-01-01', friend_vrchat_id: 'v2', friend_vrchat_name: 'F', friend_display_name: 'Friend' }]], // friends
      [[{ following_id: 3, created_at: '2026-01-01', following_vrchat_id: 'v3', following_vrchat_name: 'G', following_display_name: 'Guy' }]], // follows
      [[{ world_id: 'w1' }]],                                     // worldFavs
      [[{ avatar_id: 'a1' }]],                                    // avatarFavs
      [[{ name: 'folder1', sort_order: 0, created_at: '2026-01-01' }]], // folders
      [[{ kind: 'world', target_id: 'w1', tags: '["x","y"]' }]],  // collections
      [[{ motto: 'm', social_links: '{"kook":"x"}', privacy_settings: '{"bio":false}' }]] // profile
    );
    const data = await helper.collectUserData(1);
    expect(data.meta.user.id).toBe(1);
    expect(data.meta.user.birthday).toBe('2000-01-02');
    expect(data.tags[0]).toEqual({ name: 't1', color: '#fff', createdAt: '2026-01-01' });
    expect(data.notes[0].targetVrcId).toBe('v2');
    expect(data.friends[0].vrchatId).toBe('v2');
    expect(data.follows[0].followingId).toBeUndefined(); // 字段名是 userId
    expect(data.follows[0].userId).toBe(3);
    expect(data.collections[0].tags).toEqual(['x', 'y']);
    expect(data.profile.socialLinks).toEqual({ kook: 'x' });
    expect(data.profile.privacySettings).toEqual({ bio: false });
  });

  test('无 profile 行 → profile 为 null', async () => {
    const user = { id: 2 };
    mockQueries([[user]], [[]], [[]], [[]], [[]], [[]], [[]], [[]], [[]], [[]]);
    const data = await helper.collectUserData(2);
    expect(data.profile).toBeNull();
  });
});

describe('importUserData', () => {
  test('用户不存在 → 抛 statusCode=404 错误', async () => {
    mockQueries([[]]);
    await expect(helper.importUserData(999, {})).rejects.toMatchObject({ statusCode: 404 });
  });

  test('各类型导入：有效项计数、无效项跳过（空名称/自关注/非法 kind）', async () => {
    const user = { vrchat_id: 'v1' };
    mockPool.query.mockImplementation((sql) => {
      if (/SELECT vrchat_id FROM users/.test(sql)) return Promise.resolve([[user]]);
      if (/SELECT id FROM users WHERE vrchat_id/.test(sql)) return Promise.resolve([[{ id: 99 }]]);
      return Promise.resolve([{}]);
    });
    const body = {
      tags: [{ name: 't1', color: '#fff' }, { name: '  ', color: 'x' }],           // 1 有效
      notes: [{ targetVrcId: 'v2', text: 'n' }, { targetVrcId: '', text: 'x' }],    // 1 有效
      follows: [{ userId: 5 }, { userId: 1 }, { vrchatId: 'v2' }, { userId: 0 }],  // 2 有效（5 + 反查99自? 1抛? userId=1 是自身跳过；vrchatId→99 有效）
      worldFavorites: [{ world_id: 'w1' }, { world_id: '' }],                       // 1 有效
      avatarFavorites: [{ avatar_id: 'a1' }],                                       // 1
      folders: [{ name: 'f1' }, { name: '' }],                                      // 1
      collections: [{ kind: 'world', target_id: 'w1' }, { kind: 'bad', target_id: 'x' }, { kind: 'world', target_id: '' }] // 1
    };
    const res = await helper.importUserData(1, body);
    expect(res.imported).toMatchObject({ tags: 1, notes: 1, worldFavorites: 1, avatarFavorites: 1, folders: 1, collections: 1 });
    // follows: userId=5 有效；userId=1 是自身跳过；vrchatId=v2→99 有效；userId=0 无效 → 2
    expect(res.imported.follows).toBe(2);
  });

  test('空 body → 全 0 且不抛错', async () => {
    mockQueries([[{}]]);
    const res = await helper.importUserData(1, {});
    expect(Object.values(res.imported).every(v => v === 0)).toBe(true);
  });
});
