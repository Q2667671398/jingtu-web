/**
 * F-06 世界详情增强测试：
 * GET /api/friends/in-world/:worldId（好友在此世界 + 实例解析）
 * POST /api/friends/in-worlds（批量计数）
 */
const request = require('supertest');
const express = require('express');

const mockPool = { query: jest.fn() };
jest.mock('../utils', () => {
  const actual = jest.requireActual('../utils');
  return {
    ...actual,
    getPool: () => mockPool,
    sendError: (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } }),
    handleError: (res, e) => res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: e.message } }),
    getAvatarUrl: () => '/api/avatar/default',
    ErrorCodes: actual.ErrorCodes
  };
});
jest.mock('../auth', () => ({ requireAuth: (req, res, next) => next(), requireRole: () => (req, res, next) => next() }));

const friendsRouter = require('../routes/friends');
const ME = 1;
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: ME }; next(); });
  app.use('/api/friends', friendsRouter({ notifyUser: jest.fn() }));
  return app;
}

describe('F-06 世界详情增强', () => {
  beforeEach(() => jest.clearAllMocks());

  test('世界 ID 格式非法 → 400', async () => {
    const res = await request(buildApp()).get('/api/friends/in-world/not-a-world');
    expect(res.status).toBe(400);
  });

  test('返回该世界好友并解析实例类型/region', async () => {
    mockPool.query.mockResolvedValueOnce([[
      { vrchat_id: 'usr_a', vrchat_name: 'A', display_name: 'Alice', location: 'wrld_x:123~hidden(usr_h)~region(jp)', world_name: 'wrld_x', user_id: 2 },
      { vrchat_id: 'usr_b', vrchat_name: 'B', display_name: 'Bob', location: 'wrld_x:456~region(us)', world_name: 'wrld_x', user_id: 3 }
    ]]);
    const res = await request(buildApp()).get('/api/friends/in-world/wrld_x');
    expect(res.status).toBe(200);
    expect(res.body.friendCount).toBe(2);
    const alice = res.body.friends.find(f => f.displayName === 'Alice');
    expect(alice.instanceType).toBe('friends+'); // hidden( 映射为 friends+
    expect(alice.region).toBe('jp');
    const bob = res.body.friends.find(f => f.displayName === 'Bob');
    expect(bob.instanceType).toBe('public');
    expect(bob.region).toBe('us');
    // 实例分组
    expect(res.body.instances.length).toBe(2);
    // 查询参数含我的 userId 与世界 ID
    const q = mockPool.query.mock.calls[0];
    expect(q[1]).toContain(ME);
    expect(q[1]).toContain('wrld_x');
  });

  test('private 位置 → instanceType=private', async () => {
    mockPool.query.mockResolvedValueOnce([[
      { vrchat_id: 'usr_c', vrchat_name: 'C', display_name: 'Cee', location: 'private', world_name: 'wrld_x', user_id: 4 }
    ]]);
    const res = await request(buildApp()).get('/api/friends/in-world/wrld_x');
    expect(res.status).toBe(200);
    expect(res.body.friends[0].instanceType).toBe('private');
  });

  test('无人 → friendCount 0', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(buildApp()).get('/api/friends/in-world/wrld_x');
    expect(res.status).toBe(200);
    expect(res.body.friendCount).toBe(0);
    expect(res.body.friends).toEqual([]);
  });

  test('批量 in-worlds：过滤非法 ID 并返回计数映射', async () => {
    mockPool.query.mockResolvedValueOnce([[
      { wid: 'wrld_a', n: 3 },
      { wid: 'wrld_b', n: 1 }
    ]]);
    const res = await request(buildApp())
      .post('/api/friends/in-worlds')
      .send({ worldIds: ['wrld_a', 'wrld_b', 'bad-id', 'wrld_a'] });
    expect(res.status).toBe(200);
    expect(res.body.counts.wrld_a).toBe(3);
    expect(res.body.counts.wrld_b).toBe(1);
    expect(res.body.counts['bad-id']).toBeUndefined(); // 非法 ID 被过滤
    // 去重 + 过滤后只传 2 个 ID
    const q = mockPool.query.mock.calls[0];
    expect(q[1].filter(x => typeof x === 'string' && x.startsWith('wrld_')).length).toBe(2);
  });

  test('批量 in-worlds：空数组直接返回空映射不查库', async () => {
    const res = await request(buildApp()).post('/api/friends/in-worlds').send({ worldIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({});
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});
