# WebAuthn 通行密钥（Passkey）

> 2026-11-25 实施。目标：让用户**点按钮 + 指纹/面容/设备 PIN** 即可登录，
> 不再手输 6 位验证码，且天然抗钓鱼。

## 一、先澄清一个技术前提（重要）

需求原话是「支持 Web2FA - Authenticator 这个浏览器扩展，网站放扩展安装按钮」。
调研后必须说明一个**硬限制**：

**浏览器扩展运行在隔离沙箱（isolated world），网页 JS 无权调用它。**
网站无法「让扩展生成验证码」——除非扩展作者主动注入 content script 并与站点约定
`window.postMessage` 协议。第三方扩展不可能为本站改代码。

**能真正做到「点按钮 → 浏览器完成认证」的是 WebAuthn（FIDO2）**：
它是浏览器**原生标准 API**（`navigator.credentials.create/get`），网站可以合法调用。

| | TOTP（原有） | WebAuthn 通行密钥（本实现） |
|---|---|---|
| 用户操作 | 看手机/扩展 → 手输 6 位码 | 点按钮 → 系统弹窗 → 指纹/面容确认 |
| 网站能否调用浏览器 | ❌ | ✅ 原生 API |
| 抗钓鱼 | ❌ 假站也能骗到码 | ✅ 凭据绑定域名，假站拿不到 |
| 私钥位置 | 双方共享 secret | **永不离开认证器**，服务端只存公钥 |

## 二、实现结构

| 文件 | 作用 |
|---|---|
| `server/webauthn.js` | RP/origin 解析、安全上下文判定、挑战暂存/取用、选项生成与响应验证 |
| `server/routes/webauthn_routes.js` | HTTP 层：注册/登录/凭据管理 |
| `public/js/webauthn-client.js` | 前端：base64url ↔ ArrayBuffer 转换、调用原生 API、按钮绑定 |
| `webauthn_credentials` 表 | 存 credential_id / 公钥 / counter / transports / device_type / backed_up |

依赖：`@simplewebauthn/server@14`（**CBOR 解析与签名验证绝不可手写**，这是安全关键）。

### 接口

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/auth/webauthn/status` | 匿名 | 环境自检：是否 HTTPS/localhost、RP ID、我的凭据数 |
| POST | `/api/auth/webauthn/register/options` | 登录 | 生成注册挑战 |
| POST | `/api/auth/webauthn/register/verify` | 登录 | 验证并入库 |
| POST | `/api/auth/webauthn/login/options` | **匿名** | 生成登录挑战（可带 loginId 限定范围） |
| POST | `/api/auth/webauthn/login/verify` | **匿名** | 验证签名 → 建立会话 |
| GET | `/api/auth/webauthn/credentials` | 登录 | 我的凭据列表（**不返回公钥**） |
| DELETE | `/api/auth/webauthn/credentials/:id` | 登录 | 删除（按 user_id 过滤，删不到别人的） |

## 三、安全设计

1. **挑战一次性**：随机生成，存 session，验证时**取出即删**，5 分钟过期，并校验 kind（register/login）防止跨用途重放
2. **origin / RP ID 严格校验**：`verifyRegistrationResponse` / `verifyAuthenticationResponse` 都传 `expectedOrigin` + `expectedRPID`
3. **counter 单调递增**：新值不大于旧值时判定认证器可能被克隆，**拒绝登录**并记日志
4. **私钥不出认证器**：服务端只存 COSE 公钥（base64）
5. **凭据归属隔离**：删除/列表都带 `user_id = ?`，无法越权操作他人凭据
6. **列表不泄露敏感字段**：只返回 id/name/deviceType/backedUp/时间，不返回 `credential_id` 与 `public_key`
7. **登录限流**：10 分钟 30 次/IP（`rateLimit.ipKeyGenerator` 处理 IPv6，否则库会拒绝启动）
8. **账户状态校验**：登录时检查 `deleted_at` / `approved` / `banned`

## 四、环境要求（部署必读）

**WebAuthn 只在 HTTPS 或 localhost 下可用**（浏览器强制，非本站限制）。

- 开发：`http://localhost:3456` / `http://127.0.0.1:3456` ✅ 可用
- 生产：必须 HTTPS。若用 Nginx 反代，需正确传 `X-Forwarded-Proto: https` 与 `X-Forwarded-Host`，
  否则后端会把 origin 判成 http，验证失败
- 用 `http://内网IP:3456` 访问 → **不可用**（`/status` 会返回 `supported:false` 并说明原因）

## 五、测试

`server/__tests__/webauthn.test.js` —— 32 例：
- RP/origin 解析（含反代 `x-forwarded-*`）
- 安全上下文判定（http+localhost ✅ / http+域名 ❌ / https+域名 ✅）
- 挑战一次性 / 过期 / 类型不匹配
- `toRow` 字段转换与名称截断
- 设备名建议（Windows/Mac/Android/iPhone/其他）
- 路由层：401/400/403/404 各错误路径、凭据列表不泄露敏感字段、删除按 user_id 过滤

**端到端实测**（真库 + 真 HTTP）：环境自检 → 注册选项返回正确 challenge/rp/user →
**伪造注册响应被签名校验拒绝** → **挑战一次性（重复用失败）** → 凭据列表 →
登录选项各分支 → 安全上下文检测（普通域名返回 `supported:false`）。

> 真实「指纹/面容认证」需要真人+真设备，无法自动化；协议层已全部验证。

## 六、与 TOTP 的关系

两者**并存**，不互相替代：
- TOTP：超管可选开启（`requireSuperAdmin`），作为第二因素
- 通行密钥：任意登录用户可添加多个，**可单独用于登录**（免密码）

后续可选增强：把通行密钥作为「已登录用户的二次确认」（敏感操作前要求重新认证）。
