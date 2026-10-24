/**
 * API integration tests.
 *
 * Runs against a live deployment (local `wrangler dev` or production) and
 * checks the real HTTP contract: auth guards, validation, SSRF refusal,
 * rate limiting, pagination/cache reporting and demo isolation.
 *
 * Usage: node tests/integration/run.mjs [baseUrl]
 */
const BASE = (process.argv[2] ?? process.env.REPOROPS_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function req(path, init) {
  const res = await fetch(BASE + path, { redirect: 'manual', ...init });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON (HTML) */
  }
  return { status: res.status, headers: res.headers, text, json };
}

/* ------------------------------------------------------------ health/session */

const health = await req('/api/health');
check('GET /api/health → 200', health.status === 200, `status ${health.status}`);
check('health 报告 demo 模式（无会话时）', health.json?.mode === 'demo', health.json?.mode);
check('health 不泄露任何密钥', !/ghp_|github_pat_|cfat_|client_secret/i.test(health.text));

const session = await req('/api/session');
check('GET /api/session → 200 且未认证', session.status === 200 && session.json?.authenticated === false);
check('session 不回传任何 token 字段', !("token" in (session.json ?? {})) && !/ghp_/.test(session.text));
check(
  'session 公开 demo 仓库名，便于前端展示',
  typeof session.json?.demoRepo === 'string' && session.json.demoRepo.includes('/'),
  session.json?.demoRepo,
);

/* ------------------------------------------------------------------ guards */

const noAuthRepos = await req('/api/repos');
check('未认证访问 /api/repos → 401', noAuthRepos.status === 401, `status ${noAuthRepos.status}`);
check('401 带结构化错误码', noAuthRepos.json?.error?.code === 'UNAUTHENTICATED', noAuthRepos.json?.error?.code);

const noAuthSync = await req('/api/repos/honojs/hono/sync', { method: 'POST' });
check('未认证触发同步 → 401（写操作有鉴权）', noAuthSync.status === 401);

const noAuthReport = await req('/api/repos/honojs/hono/report');
check('未认证取周报 → 401', noAuthReport.status === 401);

const noAuthLogout = await req('/api/auth/logout', { method: 'POST' });
check('未认证登出 → 401', noAuthLogout.status === 401);

const noAuthDelete = await req('/api/repos/honojs/hono', { method: 'DELETE' });
check('未认证移除仓库 → 401', noAuthDelete.status === 401);

/* -------------------------------------------------------------- bad inputs */

const badToken = await req('/api/auth/token', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: '   ' }),
});
check('空 token → 400', badToken.status === 400, `status ${badToken.status}`);

const shortToken = await req('/api/auth/token', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: 'short' }),
});
check('格式错误的 token → 400', shortToken.status === 400, shortToken.json?.error?.code);

const invalidToken = await req('/api/auth/token', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: 'ghp_' + 'a'.repeat(36) }),
});
check('GitHub 拒绝的 token → 401', invalidToken.status === 401, invalidToken.json?.error?.code);

const malformedBody = await req('/api/auth/token', { method: 'POST', body: 'not json' });
check('非 JSON body → 400', malformedBody.status === 400, malformedBody.json?.error?.code);

const badRepo = await req('/api/demo?repo=..%2F..%2Fetc%2Fpasswd');
check('SSRF/路径穿越输入被拒绝 → 400', badRepo.status === 400, `${badRepo.status} ${badRepo.json?.error?.code}`);
check('拒绝时给出可读原因', typeof badRepo.json?.error?.message === 'string');

const badRepoUrl = await req('/api/demo?repo=' + encodeURIComponent('https://evil.example.com/owner/repo'));
check('拒绝非 github.com 的仓库输入 → 400', badRepoUrl.status === 400);

/* --------------------------------------------------------------- demo data */

const demo = await req('/api/demo');
check('GET /api/demo → 200', demo.status === 200, `status ${demo.status}`);
const items = demo.json?.items ?? [];
check('演示返回真实条目', items.length > 0, `${items.length} items`);
check('演示模式被显式标记', demo.json?.mode === 'demo');
check('演示模式带只读说明', typeof demo.json?.notice === 'string' && demo.json.notice.length > 0);
check(
  '每个条目都有真实 GitHub URL',
  items.every((i) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+$/.test(i.htmlUrl)),
  items[0]?.htmlUrl,
);
check('条目 id 与 repo#number 一致', items.every((i) => i.id === `${i.repo}#${i.number}`));
check('没有重复条目（分页去重）', new Set(items.map((i) => i.id)).size === items.length);
check('条目区分 issue 与 pr', items.some((i) => i.kind === 'issue') && items.some((i) => i.kind === 'pr'));
check('时间字段可解析', items.every((i) => !Number.isNaN(Date.parse(i.createdAt)) && !Number.isNaN(Date.parse(i.updatedAt))));
check('正文被截断以避免超大载荷', items.every((i) => i.body === null || i.body.length <= 800));

const demoRepoMeta = demo.json?.repo;
check('演示返回仓库元数据与同步状态', Boolean(demoRepoMeta?.fullName && demoRepoMeta?.sync));
check('演示同步状态记录页数与条目数', typeof demoRepoMeta.sync.pagesFetched === 'number' && demoRepoMeta.sync.itemCount > 0,
  `pages=${demoRepoMeta?.sync?.pagesFetched} items=${demoRepoMeta?.sync?.itemCount}`);
check('演示模式标记为 demo', demoRepoMeta.sync.mode === 'demo');

const demoSecond = await req('/api/demo');
check('重复请求命中缓存（同一 fetchedAt）', demoSecond.json?.fetchedAt === demo.json?.fetchedAt);

const otherRepo = await req('/api/demo?repo=withastro/astro');
check('可请求另一个公开仓库', otherRepo.status === 200 || otherRepo.status === 429,
  `status ${otherRepo.status}${otherRepo.status === 429 ? ' (GitHub 未认证配额耗尽，已正确返回 429)' : ''}`);
if (otherRepo.status === 429) {
  check('配额耗尽返回 RATE_LIMITED 且带重置时间',
    otherRepo.json?.error?.code === 'RATE_LIMITED' && Boolean(otherRepo.json?.error?.details?.resetAt),
    otherRepo.json?.error?.details?.resetAt);
}

/* ------------------------------------------------------------- read-only */

const writeAttempts = [
  ['POST', '/api/repos/honojs/hono/sync'],
  ['DELETE', '/api/repos/honojs/hono'],
];
for (const [method, path] of writeAttempts) {
  const res = await req(path, { method });
  check(`${method} ${path} 需要认证（不静默执行）`, res.status === 401, `status ${res.status}`);
}

/* --------------------------------------------------------------- no writes to GitHub */

// The worker's source has no GitHub write endpoints. Assert at the HTTP layer:
// every route that is not a known GET/POST-auth path returns 404, so there is
// no hidden mutation surface.
const unknown = await req('/api/repos/honojs/hono/issues/1/close', { method: 'POST' });
check('不存在关闭 Issue 的接口 → 404', unknown.status === 404, `status ${unknown.status}`);

const unknown2 = await req('/api/comment', { method: 'POST', body: '{}' });
check('不存在发表评论的接口 → 404', unknown2.status === 404);

/* ----------------------------------------------------------- static assets */

const root = await fetch(BASE + '/');
const rootHtml = await root.text();
check('根路径返回 SPA HTML', root.status === 200 && rootHtml.includes('<div id="root">'));
check('HTML 声明 viewport（移动端自适应前提）', /name="viewport"[^>]*width=device-width/i.test(rootHtml));
check('HTML 声明 lang=zh-CN', /<html[^>]*lang="zh-CN"/i.test(rootHtml));

const spaFallback = await fetch(BASE + '/some/deep/link');
check('SPA 深链接回落到 index.html', spaFallback.status === 200 && (await spaFallback.text()).includes('<div id="root">'));

/* ------------------------------------------------------------- rate limit */

let sawLimit = false;
let hitCount = 0;
for (let i = 0; i < 100; i += 1) {
  const res = await fetch(BASE + '/api/session');
  hitCount += 1;
  if (res.status === 429) {
    sawLimit = true;
    const body = await res.json();
    check('超限返回 LOCAL_RATE_LIMITED', body?.error?.code === 'LOCAL_RATE_LIMITED', body?.error?.code);
    check('限流响应带 resetAt 提示', Boolean(body?.error?.details?.resetAt), body?.error?.details?.resetAt);
    break;
  }
}
check('公共接口有速率限制（连续请求最终被拦截）', sawLimit, `在 ${hitCount} 次请求后命中限制`);

/* ------------------------------------------------------------------ summary */

const failed = results.filter((r) => !r.ok);
console.log('\n----------------------------------------');
console.log(`${results.length - failed.length}/${results.length} checks passed against ${BASE}`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  process.exitCode = 1;
}
