# RepoOps 架构说明

## 一句话

一个 Cloudflare Worker 同时承担三件事：托管 SPA 静态资源、提供 `/api/*`、跑定时任务。所有 GitHub 访问都在服务端完成，浏览器永远拿不到 token。

## 目录结构

```
repoops/
├── shared/                  # 前端与 Worker 共享的纯 TypeScript
│   ├── types.ts             # 领域类型（Bucket / NormalizedItem / WeeklyReport……）
│   └── board.ts             # 分桶、筛选、排序、周报、草稿 —— 全部是纯函数
├── worker/                  # Cloudflare Worker 后端
│   ├── index.ts             # 路由表 + 定时任务
│   ├── auth.ts              # OAuth / Token 登录 / 登出
│   ├── session.ts           # 会话读写、账号数据清除
│   ├── crypto.ts            # AES-256-GCM 封装、随机 ID、常量时间比较
│   ├── github.ts            # 只读 GitHub 客户端（含 SSRF 边界）
│   ├── normalize.ts         # GitHub 原始结构 → NormalizedItem
│   ├── sync.ts              # 同步服务、缓存、演示快照
│   └── migrations/          # D1 schema（按序号执行）
├── src/                     # React SPA
│   ├── App.tsx              # 状态编排、数据加载、键盘交互
│   ├── api.ts               # 类型化 API client
│   ├── components/          # Sidebar / TopBar / Toolbar / Board / Detail / Report / Settings / BatchBar
│   ├── lib/                 # 格式化、主题、toast
│   └── styles.css           # 设计变量 + 全部样式（19 KB）
├── tests/
│   ├── unit/                # Vitest，纯函数
│   ├── integration/run.mjs  # 真实 HTTP 契约测试
│   ├── live-auth.mjs        # 登录态真实流程测试
│   └── e2e/run.mjs          # Playwright 浏览器测试（含截图）
└── scripts/seed-demo.mjs    # 生成演示缓存 SQL
```

## 为什么前后端共享 `board.ts`

分桶规则如果只在服务端实现，前端的滑块就不能即时生效；如果只在前端实现，服务端周报就可能和看板对不上。

把规则做成**纯函数**放在 `shared/`，两边共用同一份代码：

```
用户拖动停滞阈值
   └─> filter/sort/bucket（浏览器，0 次网络请求，即时）

POST /api/repos/:owner/:name/report
   └─> buildWeeklyReport（Worker，同一函数）
         └─> 数字必然与看板一致
```

E2E 测试里有一项专门对账：从 DOM 读取每列卡片数，从 Markdown 周报里读取同行数字，逐列比较。当前结果 `{36,23,1,22,42}` 完全相等。

## 认证与令牌

```
浏览器                      Worker                        D1
  │  GET /api/auth/login      │                             │
  │ ─────────────────────────>│  302 → github.com/oauth     │
  │                           │  Set-Cookie: state=…        │
  │  GET /api/auth/callback?code=…&state=…                  │
  │ ─────────────────────────>│  校验 state（常量时间比较）  │
  │                           │  POST /login/oauth/access_token
  │                           │  GET /user（拿 login）      │
  │                           │  AES-256-GCM(token) ───────>│ sessions
  │  Set-Cookie: sid=…        │                             │
  │ <─────────────────────────│                             │
  │                           │                             │
  │  GET /api/repos           │                             │
  │  Cookie: sid=…            │  查 sessions → 解密 token   │
  │ ─────────────────────────>│  → 用于 GitHub 调用         │
```

要点：

- Cookie 是 `HttpOnly; SameSite=Lax; Secure`(https)，JS 读不到。
- `SESSION_SECRET` 经 SHA-256 派生密钥；每次加密用随机 12 字节 IV。
- 解密失败（密钥轮换/脏数据）→ 直接销毁会话要求重登，不抛 500。
- 会话 14 天过期，Cron 每天清理。

## 同步与缓存策略

| 场景 | 请求量 | 说明 |
| --- | --- | --- |
| 首次全量 | 1（元数据）+ 1–6（分页）+ 1（GraphQL） | 上限 600 条 |
| 增量（有游标） | 1 + 页数 + 1 | 带 `since=<cursor>` |
| 演示模式 | 0（命中 D1 缓存） | 6 小时 TTL，Cron 预热 |
| 打开看板 | 0 次 GitHub 调用 | 只读 D1 缓存 |

**关键实现细节**：只有**非增量且完整**的同步才清空并重建缓存。增量同步只 upsert —— 否则「自游标以来变化过的条目」会把未变化的条目全删掉（这个 bug 在登录态测试里被抓到并修复，见 `tests/live-auth.mjs` 的「增量同步后条目数不减少」）。

配额用尽时：GitHub 返回 `403` + `x-ratelimit-remaining: 0`，统一转换为 `429 RATE_LIMITED` 并附 `resetAt`，UI 顶栏亮黄标。

## 数据模型

```sql
sessions      (sid PK, login, avatar_url, scopes, token_cipher, token_iv,
               token_expires_at, created_at, last_seen_at)
tracked_repos (login, repo_full_name, owner, name, html_url, description,
               stars, is_private, language, pushed_at, added_at,
               PK(login, repo_full_name))
cached_items  (login, repo_full_name, item_id, number, kind, payload,
               updated_at, PK(login, item_id))
sync_state    (login, repo_full_name, last_sync_at, cursor, pages_fetched,
               item_count, complete, rate_limit_json, errors_json,
               last_duration_ms, last_mode, PK(login, repo_full_name))
reports       (login, repo_full_name, window_key, payload, generated_at,
               PK(login, repo_full_name, window_key))
demo_meta     (repo_full_name PK, payload, fetched_at, expires_at)
demo_items    (repo_full_name, item_id, updated_at, payload,
               PK(repo_full_name, item_id))
rate_limits   (bucket, window_start, count, PK(bucket, window_start))
```

`demo_*` 与用户数据**没有任何共享行**：即使演示仓库和用户仓库同名，也是两张表，物理隔离。

单条 payload 存 JSON 而不是拆列，原因是 GitHub 返回的 label / assignee 结构会变，拆列会让迁移成本远高于收益；读取时按 `updated_at DESC` 限制 2000 行。

## 分桶规则的完整定义

`shared/board.ts → bucketOf()`，自上而下匹配，第一个命中即返回：

```ts
1. state === 'closed'            → done   （仅当在完成窗口内才上板）
2. 距 updatedAt > staleDays      → stalled
3. PR 且 (isDraft ||
      reviewDecision === 'CHANGES_REQUESTED') → author
4. PR                            → review
5. Issue 且 (无标签 || 无负责人)  → triage
6. Issue                         → author
```

顺序是有意为之：停滞优先级高于「等审查」，因为一个 40 天没人理的 PR 更需要你注意，而不是继续挂在「等待审查」里假装在推进。

演示模式下拿不到 `reviewDecision` 时（无 token 的 GraphQL），PR 一律落 `review`，这是已知降级路径，UI 不会假装知道审查状态。

## 前端状态

不引入 Redux/Zustand。`App.tsx` 里集中管理：

- `session` / `repos` / `activeRepo`：连接态与仓库列表
- `items`：当前仓库缓存（服务端返回或演示快照）
- `filters` / `sort` / `thresholds`：纯视图状态，`useMemo` 派生 `visibleItems → buckets`
- `checked`：批量选择（`Set<string>`）
- `selectedId`：详情面板
- 模态：`reportOpen` / `settingsOpen`

`thresholds` 与 `activeRepo` 写进 `localStorage`，刷新后保持;搜索词和筛选不持久化（每次打开都是干净视图）。

## 限流

D1 固定窗口计数（`rate_limits` 表，`(bucket, window_start)` 主键），每个请求一次 UPSERT：

```
POST /api/session      cost 1   limit 90/min
POST /api/auth/token   cost 3   limit 90/min
GET  /api/demo         cost 2   limit 90/min
POST .../sync          cost 5   limit 90/min
```

历史：最初用 Durable Object 做这件事。每请求 1 次 get + 1 次 put，把免费额度里的 DO 行读吃光，整个 API 直接返回 `Exceeded allowed rows read in Durable Objects free tier`。**限流器把被保护的服务打挂了**，于是改成 D1 —— 读路径上本来就依赖的数据库，没有新增失败点。计数写失败时直接放行（fail-open），因为拒绝正常请求的代价远高于放宽一次限流。

不用 KV 的原因：KV 最终一致，并发请求会读到同一个旧计数。

## 定时任务

`wrangler.jsonc → triggers.crons = ["17 */6 * * *"]`

每次执行：
1. `refreshDemoSnapshot()` 原地刷新（不清表；失败时保留上一份可用快照）。
2. 删除 `created_at` 超过 14 天的会话（兜底 Cookie 丢失的情况）。

## 部署拓扑

```
GitHub OAuth App ──redirect──> https://repoops.852367856.dpdns.org/api/auth/callback
                                       │
                                       ▼
                        Cloudflare Worker "repoops"
                        ├── ASSETS (dist/)
                        ├── DB (D1: repoops-db)
                        └── Cron: 17 */6 * * *
```

`workers.dev` 域名在部分网络下不可达，因此额外绑定了自有域名 `repoops.852367856.dpdns.org`（Cloudflare 托管 zone 下的 Custom Domain，自动签发证书）。
