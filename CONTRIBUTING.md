# 贡献指南

## 开发环境

```bash
git clone https://github.com/iiiiiiiiiiiiiKK/repoops.git
cd repoops
npm install
```

```bash
npm run db:migrate:local   # 初始化本地 D1
npm run worker:dev         # 终端 1：Worker + D1，localhost:8787
npm run dev                # 终端 2：Vite 热更新，localhost:5173
```

没配 OAuth 也能开发：打开 `localhost:5173` 就是演示模式。

## 提交前必须通过

```bash
npm run typecheck   # 前端 + Worker 两套 tsconfig 的严格类型检查
npm test            # 58 个单元测试
npm run build       # 生产构建
```

如果改动涉及路由、鉴权或同步，请额外跑一次真实链路的测试（需要一个只读 token 和部署地址）：

```bash
node tests/integration/run.mjs http://127.0.0.1:8787
node tests/e2e/run.mjs http://127.0.0.1:8787
```

## 代码约定

- **纯逻辑放 `shared/`**。任何需要同时被 Worker 和前端使用的规则（分桶、筛选、周报），都写成无副作用的纯函数，并配单元测试。
- **不引入新的运行时依赖**除非有充分理由。当前生产依赖只有 `react` + `react-dom`。
- **样式用设计变量**。颜色、圆角、间距都从 `src/styles.css` 顶部的 `:root` 取，不要在组件里写死 `#rrggbb`（标签颜色除外，那来自 GitHub）。
- **错误要能被用户读懂**。Worker 抛 `ApiError(status, CODE, humanMessage)`，前端把 `message` 直接展示，不要吞掉。
- **不要为测试关闭安全检查**。测试要覆盖 401/403/429/404 的真实行为，而不是绕过它们。

## 关键约束（改动前请先读）

1. **只读**。不要给 Worker 增加任何写入 GitHub 的调用。草稿类功能只能生成文本。
2. **token 不出服务端**。任何新接口都不得返回 token、cookie 或密钥。
3. **演示数据与用户数据隔离**。`demo_*` 表不能和 `cached_*` 表混用。
4. **增量同步只 upsert**。只有「非增量 + 完整」的同步才允许清空缓存重建（否则会丢数据，历史上出过这个 bug）。
5. **SSRF 边界**。所有 GitHub 调用必须经过 `buildApiUrl()`，禁止拼接任意 host。

## 提 PR

- 一个 PR 只做一件事，描述里写清「为什么」而不只是「改了什么」。
- 有 UI 改动请附截图（桌面 + 移动端）。
- 新增行为请附测试。
- 提交信息用 `feat:` / `fix:` / `docs:` / `test:` / `refactor:` / `chore:` 前缀。

## 报告问题

开 issue 时请包含：复现步骤、期望结果、实际结果、浏览器与视口、以及 `/api/health` 与 `/api/session` 的输出（**不要贴 token**）。
