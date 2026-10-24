# 隐私政策 / Privacy Policy

最后更新：2026-10-25

RepoOps 是一个**只读**的开源项目维护工作台。这份文档说明它会接触哪些数据、存在哪里、什么时候删除。

## 1. 我们收集什么

| 数据 | 何时 | 存多久 |
| --- | --- | --- |
| GitHub 登录名 + 头像 URL | 你连接 GitHub 时 | 会话有效期（14 天）或直到你断开连接 |
| OAuth access token（**加密后**） | 你连接 GitHub 时 | 同上 |
| 授权范围（scope 字符串） | 同上 | 同上 |
| 你添加的仓库列表（owner/name、公开元数据） | 你添加仓库时 | 直到你移除该仓库或断开连接 |
| Issue / PR 的**公开可见字段**缓存副本 | 同步时 | 直到你移除仓库或断开连接 |
| 同步元数据（时间、页数、配额、错误） | 同步时 | 同上 |
| 生成的周报快照 | 你打开周报时 | 同上 |

**不收集**：邮箱、真实姓名、组织成员关系、代码内容、私有仓库的代码文件、任何分析/埋点数据、IP 归属画像。

## 2. token 如何存储

- OAuth token 或你粘贴的 PAT 用 **AES-256-GCM** 加密后写入 D1。
- 密钥由 Worker Secret `SESSION_SECRET` 经 SHA-256 派生，密钥本身不在数据库里。
- 浏览器只持有一个 `HttpOnly; SameSite=Lax; Secure` 的会话 ID（随机 32 字节）。**没有任何接口会把 token 回传给浏览器**。
- 解密失败（密钥轮换/数据损坏）时会话立即销毁，要求重新登录。

## 3. 我们会写入 GitHub 吗

**不会。**

- Worker 代码里不存在对 `api.github.com` 的 `POST` / `PATCH` / `PUT` / `DELETE` 调用。
- 唯一的 `POST` 是 GraphQL，且请求体是写死的 `query`（只读取 `reviewDecision` / `isDraft`）。
- 「评论草稿」「任务清单」「周报」全部只在浏览器里生成文本，需要你**手动复制**后在 GitHub 上确认发布。
- 集成测试断言 `/api/repos/:owner/:name/issues/:n/close` 与 `/api/comment` 都返回 404。

## 4. 演示模式的数据

公开演示加载的是一个**公开仓库**（默认 `honojs/hono`）的真实数据快照，缓存 6 小时。

- 演示数据存在 `demo_meta` / `demo_items` 表，与任何用户的数据**没有共享行**。
- 界面始终显示橙色「演示数据」角标。
- 演示模式不使用、也不创建任何用户会话。

## 5. 第三方

RepoOps 只在服务端调用两个第三方：

| 服务 | 用途 | 传输内容 |
| --- | --- | --- |
| `api.github.com` | 读仓库、issue、PR | 你的 token（如已连接）、仓库名、分页参数 |
| `github.com/login/oauth` | OAuth 换 token | client id/secret、授权码 |

部署平台（Cloudflare Workers）会记录平台级访问日志，这是平台行为，不在本应用控制范围内。

**没有**任何广告、分析、错误追踪 SDK。

## 6. 你能怎么删

在应用内：**⚙ 设置 → 连接 → 断开 GitHub 连接**。

这会一次性删除：

- `sessions` 里你的所有会话
- `tracked_repos` 里你的所有仓库
- `cached_items` 里你的所有缓存条目
- `sync_state` 里你的所有同步记录
- `reports` 里你的所有周报快照

并立即清除 Cookie。GitHub 上的 Issue / PR 不受任何影响。授权本身可以在 https://github.com/settings/applications 撤销。

也可以单独「移除某个仓库」—— 只删该仓库的缓存与同步状态。

## 7. 儿童

本服务不是面向 13 岁以下用户设计的，也不会主动收集其数据。

## 8. 变更

本政策如有变更会更新本文件顶部的日期，并在仓库 commit 中可见。

## 9. 联系

作者：𝕏 [@0xkillcoin](https://x.com/0xkillcoin) · 或在本仓库开 issue。
