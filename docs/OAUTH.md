# GitHub OAuth 配置指南

RepoOps 的 OAuth 流程完全按 GitHub 官方文档实现（**Authorization Code Grant**，无 PKCE —— 因为 client secret 只在服务端持有，属于机密客户端）。

参考文档：
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app

## 1. 创建 OAuth App

1. 打开 https://github.com/settings/developers
2. **OAuth Apps** → **New OAuth App**
3. 填写：

| 字段 | 值 |
| --- | --- |
| Application name | `RepoOps`（可自定义） |
| Homepage URL | `https://<你的域名>` |
| Application description | 可选 |
| **Authorization callback URL** | `https://<你的域名>/api/auth/callback` |

> 本地开发时 callback 用 `http://localhost:8787/api/auth/callback`。GitHub 一个 OAuth App 只能填一个回调地址，所以本地和生产建议建两个 App。

4. 创建后点 **Generate a new client secret**，复制 `Client ID` 与 `Client Secret`（secret 只显示一次）。

## 2. 写入部署环境

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET   # 加密 token 用，见下
```

本地开发写 `.dev.vars`：

```
GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxx
GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SESSION_SECRET=<48 字节随机串>
```

生成 `SESSION_SECRET`：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

> ⚠️ `SESSION_SECRET` 一旦更换，所有已存的加密 token 都无法解密，用户需要重新登录（这是预期行为，见 `worker/session.ts` 中解密失败即销毁会话的处理）。

## 3. 权限范围（Scope）

RepoOps 只申请完成任务所需的权限：

| 入口 | Scope | 能做什么 |
| --- | --- | --- |
| 默认 `/api/auth/login` | `read:user public_repo` | 读登录名 + 读**公开**仓库的 issue / PR |
| `/api/auth/login?private=1` | `read:user repo` | 额外读取**私有**仓库 |

`read:user` 用来拿登录名和头像；RepoOps 不读邮箱、不读组织成员、不写任何东西。

> 为什么不用 GitHub App？GitHub App 能给出更细的权限粒度（比如只读 issues），但需要额外的 installation → installation token 交换流程，且安装流程对个人维护者更繁琐。当前设计选择 OAuth App，把「最小权限」落在 scope 上；GitHub App 在路线图里。

## 4. 流程细节

```
GET /api/auth/login?private=1
  ├─ 生成 32 字节随机 state
  ├─ Set-Cookie: repoops_oauth_state=<state>; HttpOnly; SameSite=Lax; Max-Age=600
  └─ 302 → https://github.com/login/oauth/authorize
             ?client_id=…&redirect_uri=…&scope=…&state=…&allow_signup=false

GET /api/auth/callback?code=…&state=…
  ├─ 比较 cookie 里的 state 与查询参数（常量时间比较，防时序侧信道）
  ├─ POST https://github.com/login/oauth/access_token  (Accept: application/json)
  ├─ GET  https://api.github.com/user  （验证 token 并取 login/avatar）
  ├─ AES-256-GCM 加密 token → 写 sessions 表
  └─ Set-Cookie: repoops_sid=<sid>; HttpOnly; SameSite=Lax; Secure
     302 → <origin>?auth=ok
```

失败时会带 `?auth=error&reason=<原因>` 回到首页，UI 顶部显示可读错误（`state_mismatch` / `missing_code` / `token_endpoint_unreachable` / `bad_verification_code` 等），并提示可以改用 Token 登录。

### 为什么 callback 里要重新校验 `/user`

GitHub 的 token 端点可能成功但 token 实际无效（比如用户已在设置里撤销了 App）。多一次 `/user` 调用可以确保入库的 token 立刻可用，也顺便拿到 login 做归属键。

## 5. Token 刷新与过期

GitHub 传统 OAuth App 的 access token **默认不过期**（除非用户撤销或 App 开启了 token expiration）。

RepoOps 的处理：

- 如果 token 端点返回 `expires_in`（即 App 开启了 token 过期），会把 `tokenExpiresAt` 记进 `sessions`，侧栏与设置页都会显示「令牌到期：x 天后」。
- 运行时遇到 GitHub `401`，统一转换为 `TOKEN_INVALID`，前端提示重新连接，并在设置里提供「断开并重新授权」。
- 本实现**不**自动用 refresh token 续期 —— 因为 scope 固定的只读场景下，重新授权一次的成本远低于维护刷新逻辑出错的风险。这一点在文档里明确写出，而不是假装支持。

## 6. 验证 OAuth 是否配好

访问 `/api/session`，看 `oauthConfigured`：

```bash
curl -s https://<你的域名>/api/session | jq
# { "authenticated": false, "oauthConfigured": true, ... }
```

- `oauthConfigured: true` → 登录按钮会跳转 GitHub
- `oauthConfigured: false` → UI 显示黄色提示，只提供 Token 登录与演示模式（不会给出一个点了没反应的按钮）

## 7. 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `redirect_uri_mismatch` | OAuth App 里的 callback 与部署域名不一致 | 改成 `https://<域名>/api/auth/callback` |
| `?auth=error&reason=state_mismatch` | 中间隔太久（>10 分钟）或 cookie 被清 | 重新点登录 |
| `500 MISSING_SECRET` | 没配 `SESSION_SECRET` | `wrangler secret put SESSION_SECRET` |
| 登录成功但仓库读不到 | 只给了 `public_repo` 却要看私有仓库 | 用 `/api/auth/login?private=1` 重新授权 |
| `401 TOKEN_INVALID` | 用户在 GitHub 撤销了授权 | 重新连接 |
