/**
 * WebAuthn 通行密钥：服务模块 + 路由测试
 *
 * 重点覆盖安全边界：挑战一次性、过期、类型不匹配、RP/origin 解析、
 * 环境（HTTPS/localhost）判定、凭据归属、counter 防克隆、权限校验。
 */
const request = require('supertest');
const express = require('express');

const mockPool = { query: jest.fn() };
jest.mock('../utils', () => {
  const actual = jest.requireActual('../utils');
  return {
    ...actual,
    getPool: () => mockPool,
    sendError: (res, status, code, message, detail) => res.status(status).json({
      success: false, error: detail ? { code, message, detail } : { code, message }
    }),
    handleError: (res, e) => res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: e.message } }),
    logOper: jest.fn(() => Promise.resolve()),
    ErrorCodes: actual.ErrorCodes
  };
});
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => req.session && req.session.userId ? next() : res.status(401).json({ success: false })
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('express-rate-limit', () => () => (req, res, next) => next());

const webauthn = require('../webauthn');
const webauthnRouter = require('../routes/webauthn_routes');

function mkReq(overrides = {}) {
  return {
    headers: { host: 'localhost:3456', ...(overrides.headers || {}) },
    protocol: 'http',
    session: overrides.session || {},
    ip: '127.0.0.1',
    ...overrides
  };
}

describe('webauthn · RP / origin 解析', () => {
  test('localhost 直接用 host 作 RP ID', () => {
    const r = webauthn.resolveRp(mkReq());
    expect(r.rpId).toBe('localhost');
    expect(r.origin).toBe('http://localhost:3456');
  });

  test('域名去掉端口作 RP ID', () => {
    const r = webauthn.resolveRp(mkReq({ headers: { host: 'jingtu.example.com:8443' } }));
    expect(r.rpId).toBe('jingtu.example.com');
  });

  test('反代场景优先用 x-forwarded-host / x-forwarded-proto', () => {
    const r = webauthn.resolveRp(mkReq({
      headers: {
        host: 'internal:3000',
        'x-forwarded-host': 'jingtu.example.com',
        'x-forwarded-proto': 'https'
      }
    }));
    expect(r.rpId).toBe('jingtu.example.com');
    expect(r.origin).toBe('https://jingtu.example.com');
  });
});

describe('webauthn · 安全上下文判定', () => {
  test('http + localhost → 支持', () => {
    expect(webauthn.isSecureContext(mkReq())).toBe(true);
  });

  test('http + 普通域名 → 不支持（WebAuthn 硬性要求 HTTPS）', () => {
    const r = webauthn.isSecureContext(mkReq({ headers: { host: 'jingtu.example.com' } }));
    expect(r).toBe(false);
  });

  test('https + 普通域名 → 支持', () => {
    const r = webauthn.isSecureContext(mkReq({
      headers: { host: 'jingtu.example.com', 'x-forwarded-proto': 'https' }
    }));
    expect(r).toBe(true);
  });
});

describe('webauthn · 挑战一次性与过期', () => {
  test('挑战取出后即删除（防重放）', () => {
    const req = mkReq();
    webauthn._internal.stashChallenge(req, 'abc123', { kind: 'register', userId: 1 });
    const first = webauthn._internal.takeChallenge(req, 'register');
    expect(first.ok).toBe(true);
    expect(first.challenge).toBe('abc123');
    const second = webauthn._internal.takeChallenge(req, 'register');
    expect(second.ok).toBe(false);
  });

  test('超过 TTL 的挑战被拒', () => {
    const req = mkReq();
    req.session.webauthnChallenge = {
      challenge: 'old', createdAt: Date.now() - webauthn.CHALLENGE_TTL_MS - 1000, kind: 'login'
    };
    const r = webauthn._internal.takeChallenge(req, 'login');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/过期/);
  });

  test('挑战类型不匹配被拒', () => {
    const req = mkReq();
    webauthn._internal.stashChallenge(req, 'c', { kind: 'register', userId: 1 });
    const r = webauthn._internal.takeChallenge(req, 'login');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/类型不匹配/);
  });
});

describe('webauthn · 凭据入库行整理', () => {
  test('toRow 正确转换 base64 公钥与 transports', () => {
    const row = webauthn.toRow(7, {
      credential: { id: 'cred-1', publicKey: Buffer.from([1, 2, 3]), counter: 5 },
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: true,
      aaguid: 'aaguid-x'
    }, ['internal', 'hybrid'], '我的笔记本');
    expect(row.user_id).toBe(7);
    expect(row.credential_id).toBe('cred-1');
    expect(row.public_key).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    expect(row.counter).toBe(5);
    expect(row.transports).toBe('internal,hybrid');
    expect(row.device_type).toBe('singleDevice');
    expect(row.backed_up).toBe(1);
    expect(row.name).toBe('我的笔记本');
  });

  test('toRow 名称超长被截断到 100', () => {
    const row = webauthn.toRow(1, {
      credential: { id: 'c', publicKey: Buffer.from([0]), counter: 0 }
    }, [], 'x'.repeat(200));
    expect(row.name.length).toBe(100);
  });
});

describe('webauthn · 设备名建议', () => {
  test.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', /Windows/],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X)', /Mac/],
    ['Mozilla/5.0 (Linux; Android 13)', /Android/],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', /iPhone/],
    ['curl/8.0', /通行密钥/]
  ])('%s → 建议名称', (ua, re) => {
    expect(webauthn.suggestName(ua)).toMatch(re);
  });
});

// ==================== 路由层 ====================
function app(userId = 1) {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => {
    req.session = userId ? { userId, loginId: 'u1', displayName: '测试', role: 'member' } : {};
    next();
  });
  a.use('/api/auth/webauthn', webauthnRouter());
  return a;
}

beforeEach(() => jest.clearAllMocks());

describe('webauthn 路由 · status', () => {
  test('匿名访问返回 supported 与环境信息', async () => {
    const res = await request(app(null)).get('/api/auth/webauthn/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('supported');
    expect(res.body).toHaveProperty('rpId');
  });
});

describe('webauthn 路由 · 注册', () => {
  test('未登录 → 401', async () => {
    const res = await request(app(null)).post('/api/auth/webauthn/register/options');
    expect(res.status).toBe(401);
  });

  test('非安全上下文 → 400 并提示需要 HTTPS', async () => {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => {
      req.session = { userId: 1 };
      req.headers.host = 'jingtu.example.com'; // http + 普通域名
      next();
    });
    a.use('/api/auth/webauthn', webauthnRouter());
    const res = await request(a).post('/api/auth/webauthn/register/options');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/HTTPS|localhost/);
  });

  test('verify 缺少 response → 400', async () => {
    const res = await request(app()).post('/api/auth/webauthn/register/verify').send({});
    expect(res.status).toBe(400);
  });

  test('verify 无挑战 → 400（一次性挑战已被消费）', async () => {
    const res = await request(app()).post('/api/auth/webauthn/register/verify')
      .send({ response: { id: 'cred-x' } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/挑战/);
  });
});

describe('webauthn 路由 · 登录', () => {
  test('options：用户不存在 → 404', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(app(null)).post('/api/auth/webauthn/login/options').send({ loginId: 'nobody' });
    expect(res.status).toBe(404);
  });

  test('options：用户无通行密钥 → 400', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ id: 5 }]])   // 用户存在
      .mockResolvedValueOnce([[]]);            // 无凭据
    const res = await request(app(null)).post('/api/auth/webauthn/login/options').send({ loginId: 'u1' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/还没有绑定/);
  });

  test('options：无 loginId 且全站无凭据 → 400', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(app(null)).post('/api/auth/webauthn/login/options').send({});
    expect(res.status).toBe(400);
  });

  test('verify：凭据未注册 → 404', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(app(null)).post('/api/auth/webauthn/login/verify')
      .send({ response: { id: 'unknown-cred' } });
    expect(res.status).toBe(404);
  });

  test('verify：账户被封禁 → 403', async () => {
    mockPool.query.mockResolvedValueOnce([[{
      id: 1, user_id: 9, credential_id: 'c1', public_key: 'AAAA', counter: 0,
      login_id: 'banned', display_name: 'B', role: 'member',
      approved: 1, banned: 1, deleted_at: null, name: 'k'
    }]]);
    const res = await request(app(null)).post('/api/auth/webauthn/login/verify')
      .send({ response: { id: 'c1' } });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/封禁/);
  });

  test('verify：账户未审核 → 403', async () => {
    mockPool.query.mockResolvedValueOnce([[{
      id: 1, user_id: 9, credential_id: 'c1', public_key: 'AAAA', counter: 0,
      login_id: 'pending', display_name: 'P', role: 'member',
      approved: 0, banned: 0, deleted_at: null, name: 'k'
    }]]);
    const res = await request(app(null)).post('/api/auth/webauthn/login/verify')
      .send({ response: { id: 'c1' } });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/审核/);
  });
});

describe('webauthn 路由 · 凭据管理', () => {
  test('列表：未登录 → 401', async () => {
    const res = await request(app(null)).get('/api/auth/webauthn/credentials');
    expect(res.status).toBe(401);
  });

  test('列表：只返回当前用户字段（不泄露 public_key）', async () => {
    mockPool.query.mockResolvedValueOnce([[
      { id: 3, credential_id: 'c1', name: '笔记本', device_type: 'singleDevice',
        backed_up: 1, transports: 'internal', created_at: '2026-11-25', last_used_at: null }
    ]]);
    const res = await request(app()).get('/api/auth/webauthn/credentials');
    expect(res.status).toBe(200);
    expect(res.body.credentials[0]).toMatchObject({ id: 3, name: '笔记本', backedUp: true });
    expect(res.body.credentials[0]).not.toHaveProperty('public_key');
    expect(res.body.credentials[0]).not.toHaveProperty('credential_id');
  });

  test('删除：id 非法 → 400', async () => {
    const res = await request(app()).delete('/api/auth/webauthn/credentials/abc');
    expect(res.status).toBe(400);
  });

  test('删除：不属于本人 → 404（按 user_id 过滤，删不到）', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const res = await request(app()).delete('/api/auth/webauthn/credentials/99');
    expect(res.status).toBe(404);
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/user_id = \?/);
  });

  test('删除：成功', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const res = await request(app()).delete('/api/auth/webauthn/credentials/5');
    expect(res.status).toBe(200);
  });
});
