# 部署指南

RepoOps 需要服务端能力（OAuth 密钥保管、服务端调用 GitHub、token 加密入库），因此**不能**部署成纯静态站点（GitHub Pages / 纯静态 CDN）。本指南给出 Cloudflare Workers 的完整部署流程 —— 本项目线上版本就是用这套流程发布的。

> 也可以部署到 Vercel，但需要把 Worker 改成 Vercel Functions 并换掉 D1（例如改为 Postgres/Neon）。本项目没有采用，因为 Workers + D1 + 静态资源同源是零成本的组合。

## 前置条件

- Node.js ≥ 20
- Cloudflare 账号（免费版足够）
- 一个 GitHub OAuth App（见 [OAUTH.md](OAUTH.md)），或只用演示模式

```bash
npm install
npx wrangler login          # 或设置 CLOUDFLARE_API_TOKEN
```

## 1. 创建 D1 数据库

```bash
npx wrangler d1 create repoops-db
```

输出里会有 `database_id`，把它填进 `wrangler.jsonc`：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "repoops-db",
    "database_id": "<上一步输出的 id>",
    "migrations_dir": "worker/migrations"
  }
]
```

应用 schema：

```bash
npx wrangler d1 migrations apply repoops-db --remote
```

## 2. 设置密钥

```bash
# 会话加密密钥（必需，缺失时登录会 500）
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" \
  | npx wrangler secret put SESSION_SECRET

# OAuth（想启用 GitHub 登录就需要）
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET

# 可选：只读 PAT，用于演示缓存，缓解匿名配额（60 请求/小时）
npx wrangler secret put GITHUB_TOKEN
```

## 3. 构建并部署

```bash
npm run build       # tsc 双配置类型检查 + vite build → dist/
npx wrangler deploy
```

输出会给出 `https://repoops.<你的-subdomain>.workers.dev`。

### 可选：绑定自定义域名

如果 `workers.dev` 在你的网络下不可达（部分地区会超时），在 Cloudflare 托管的 zone 下绑一个 Custom Domain：

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/domains" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"environment":"production","hostname":"repoops.example.com","service":"repoops","zone_id":"<zone>","zone_name":"example.com"}'
```

或用 Dashboard：**Workers & Pages → repoops → Settings → Domains & Routes → Add custom domain**。

绑定后记得把 OAuth App 的 callback 改成新域名。

## 4. 配置定时任务

`wrangler.jsonc` 已包含：

```jsonc
"triggers": { "crons": ["17 */6 * * *"] }
```

`wrangler deploy` 会自动注册。它做两件事：预热演示缓存、清理 14 天前的会话。

## 5. 演示数据预热（可选但推荐）

Cloudflare 出口 IP 共享 GitHub 的**匿名配额（60 请求/小时/IP）**，冷缓存时首次 `/api/demo` 可能直接 429。两种解法：

**A. 设置 `GITHUB_TOKEN`**（推荐）—— 用只读 PAT 把配额提到 5000/h。

**B. 离线播种**：

```bash
export GITHUB_TOKEN=ghp_xxx
node scripts/seed-demo.mjs honojs/hono        # 生成 .seed-demo.sql
npx wrangler d1 execute repoops-db --remote --file .seed-demo.sql
```

> 演示数据按行存储在 `demo_items`，因为把 300 条塞进单个 JSON 会触发 D1 的 `SQLITE_TOOBIG`。

## 6. 部署后验收清单

```bash
BASE=https://<你的域名>

curl -s $BASE/api/health          # {"ok":true,...,"mode":"demo"}
curl -s $BASE/api/session         # {"authenticated":false,"oauthConfigured":true,...}
curl -s $BASE/api/demo | head -c 300

node tests/integration/run.mjs $BASE
node tests/e2e/run.mjs $BASE
```

期望：健康检查 200、`oauthConfigured` 与你的配置一致（**不要**出现配了 secret 却报 false）、演示接口返回真实条目、集成测试全绿。

## 7. 更新部署

```bash
npm run build && npx wrangler deploy
```

数据库变更走新迁移文件：

```bash
npx wrangler d1 migrations apply repoops-db --remote
```

迁移是顺序执行的，已应用的不会重跑；`wrangler d1 migrations list --remote` 可查看状态。

## 8. 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| **点「用 GitHub 登录」啥也没发生 / 页面像刷新了一下** | `assets.run_worker_first` 缺了 `/api/*`，SPA 回退把导航请求用 `index.html` 兜住，Worker 没执行 | 保留 `"run_worker_first": ["/api/*"]`；用 `node tests/navigation-routing.mjs <url>` 复查 |
| `Actor migration tag precondition failed` | 同名 Worker 已存在且 Durable Object 迁移标签不同 | 删除旧 Worker 后重新 deploy，或手工统一 `migrations` 标签 |
| `does not export class 'X' which is depended on by existing Durable Objects` | 删掉了 DO 类但历史迁移里还有它 | 在 `migrations` 里追加 `{ "tag": "v2", "deleted_classes": ["X"] }` 后再 deploy |
| `Exceeded allowed rows read in Durable Objects free tier` | 早期版本用 DO 做限流 | 本项目已改为 D1 限流；老部署请按 `0004_rate_limits.sql` 迁移并删除 DO 绑定 |
| `This Worker does not exist on your account` | 首次部署时 workers.dev 子域未启用 | Dashboard 里启用 workers.dev，或直接绑自定义域名 |
| 登录 `500 MISSING_SECRET` | 未设 `SESSION_SECRET` | `npx wrangler secret put SESSION_SECRET` |
| `/api/demo` 返回 `429 RATE_LIMITED` | 匿名 GitHub 配额用尽 | 配 `GITHUB_TOKEN` 或按第 5 步播种 |
| 页面 404 | `dist/` 未构建 | `npm run build` 再 deploy |
| 静态资源旧版本 | 浏览器缓存 | 资源带 hash 文件名，刷新即可 |
| 500 且日志有 `D1_ERROR` | 迁移未应用 | `wrangler d1 migrations apply --remote` |

查看实时日志：

```bash
npx wrangler tail repoops --format pretty
```

## 9. 免费额度参考

截至本文写作时 Cloudflare 官方公布的免费额度（会变，请以官网为准）：

| 资源 | 免费额度 | 说明 |
| --- | --- | --- |
| Workers 请求 | 100,000/天 | 静态资源请求也算，但同源命中缓存后很低 |
| Workers CPU | 10 ms/请求 | 本项目的路由与 JSON 处理远低于此；GitHub 调用是 IO 等待，不占 CPU |
| D1 存储 | 5 GB | 300 条缓存 ≈ 0.6 MB，可存约 250 个仓库快照 |
| D1 行读取 | 500 万/天 | 打开一次看板读一个仓库的行；限流计数每请求 1 行 |
| Cron Triggers | 免费 | 每天 4 次 |

> 限流计数为什么放 D1 而不是 Durable Object：早期版本用 DO 做限流，每次请求一次 get + 一次 put，把 DO 免费额度的行读吃光后整个 API 返回 500。防护组件不应该能弄挂被保护的服务，所以改成 D1 里的一次 UPSERT（详见 README 的「工程教训」）。

**不承诺「永久免费无限使用」**：如果仓库 Issue 数上万、或日活用户超出额度，会产生费用。生产使用前请自行核算。

## 10. 安全提醒

- 不要把 `.env`、`.dev.vars`、`.session-secret.txt` 提交进仓库（`.gitignore` 已覆盖）。
- OAuth `client_secret` 只放 Worker Secret，绝不出现在前端 bundle（本项目前端代码里没有任何 secret 引用）。
- 如果 secret 曾经进过 git 历史，必须**轮换** GitHub OAuth App 的 client secret 并重新 `wrangler secret put`，仅删除文件不够。
