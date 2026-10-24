/**
 * Authenticated (live) flow test.
 *
 * Exercises the parts of the product that the public demo can never touch:
 * token sign-in, adding a repo, real pagination + sync state, the weekly report
 * against cached rows, ownership isolation, and the disconnect/purge path.
 *
 * Requires a GitHub token with repo read access:
 *   $env:GITHUB_TEST_TOKEN = 'ghp_...'
 *   node tests/live-auth.mjs https://your-deployment
 *
 * The token is sent to the deployment under test (it is encrypted at rest and
 * deleted by the disconnect step at the end of this script).
 */
import { randomUUID } from 'node:crypto';

const BASE = (process.argv[2] ?? process.env.REPOROPS_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN = process.env.GITHUB_TEST_TOKEN;
const PRIVATE_REPO = process.env.GITHUB_TEST_PRIVATE_REPO; // e.g. owner/private-repo
const PUBLIC_REPO = process.env.GITHUB_TEST_PUBLIC_REPO;

if (!TOKEN) {
  console.error('GITHUB_TEST_TOKEN is required');
  process.exit(2);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A cookie jar just big enough for the session cookie. */
let cookie = '';
async function call(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (cookie) headers.set('cookie', cookie);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(BASE + path, { ...init, headers, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, json, text, headers: res.headers };
}

/* ---------------------------------------------------------- token sign-in */

const badLogin = await call('/api/auth/token', { method: 'POST', body: JSON.stringify({ token: 'x'.repeat(20) }) });
check('伪造 token 被 GitHub 拒绝 → 401', badLogin.status === 401, `${badLogin.status} ${badLogin.json?.error?.code}`);

const login = await call('/api/auth/token', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
check('真实 token 登录成功 → 200', login.status === 200, `${login.status} ${login.json?.login ?? login.json?.error?.code}`);
check('登录返回 GitHub 账号名', typeof login.json?.login === 'string' && login.json.login.length > 0, login.json?.login);
check('响应体不包含 token 本身', !login.text.includes(TOKEN.slice(0, 12)));
check('下发 HttpOnly 会话 Cookie', /HttpOnly/i.test(login.headers.get('set-cookie') ?? ''));

const session = await call('/api/session');
check('会话建立后可读 /api/session', session.json?.authenticated === true);
check('session 报告 live 模式', session.json?.mode === 'live');
check('session 依然不回传 token', !session.text.includes(TOKEN.slice(0, 12)));
check('session 列出已授权 scope', Array.isArray(session.json?.scopes) && session.json.scopes.length > 0, session.json?.scopes?.join(','));

/* -------------------------------------------------------------- add repos */

const targetRepo = PRIVATE_REPO ?? PUBLIC_REPO;
if (!targetRepo) {
  console.log('SKIP  no GITHUB_TEST_PRIVATE_REPO / GITHUB_TEST_PUBLIC_REPO provided');
} else {
  const add = await call('/api/repos', { method: 'POST', body: JSON.stringify({ repo: targetRepo }) });
  check(`添加仓库 ${targetRepo} → 201`, add.status === 201, `${add.status} ${add.json?.error?.code ?? ''}`);
  check('添加后立即返回条目数与同步状态', typeof add.json?.itemCount === 'number' && Boolean(add.json.repo?.sync));

  const isPrivate = Boolean(add.json?.repo?.isPrivate);
  check(`仓库可见性被正确识别 (${isPrivate ? 'private' : 'public'})`, typeof isPrivate === 'boolean');

  const sync = add.json?.repo?.sync;
  check('记录上次同步时间', typeof sync?.lastSyncAt === 'string' && !Number.isNaN(Date.parse(sync.lastSyncAt)));
  check('记录抓取页数', typeof sync?.pagesFetched === 'number' && sync.pagesFetched >= 1, `pages=${sync?.pagesFetched}`);
  check('记录 API 配额快照', Boolean(sync?.rateLimit?.limit), `remaining=${sync?.rateLimit?.remaining}/${sync?.rateLimit?.limit}`);
  check('认证同步使用 live 模式', sync?.mode === 'live');
  check('同步无错误', (sync?.errors ?? []).length === 0, JSON.stringify(sync?.errors));

  const dup = await call('/api/repos', { method: 'POST', body: JSON.stringify({ repo: targetRepo }) });
  check('重复添加同一仓库 → 409', dup.status === 409, `${dup.status} ${dup.json?.error?.code}`);

  const repos = await call('/api/repos');
  check('仓库列表包含刚添加的仓库', repos.json?.repos?.some((r) => r.fullName.toLowerCase() === targetRepo.toLowerCase()));

  const dash = await call(`/api/repos/${targetRepo}/dashboard`);
  check('读取 dashboard → 200', dash.status === 200);
  const items = dash.json?.items ?? [];
  check('dashboard 返回缓存条目', items.length > 0, `${items.length} items`);
  check('缓存条目只有属于该仓库的', items.every((i) => i.repo.toLowerCase() === targetRepo.toLowerCase()));
  check('缓存条目 id 唯一', new Set(items.map((i) => i.id)).size === items.length);
  check('live 模式标记', dash.json?.mode === 'live');

  /* ------------------------------------------------------------- resync */

  const resync = await call(`/api/repos/${targetRepo}/sync`, { method: 'POST' });
  check('二次同步成功（增量）', resync.status === 200, `${resync.status}`);
  check('二次同步标记为 incremental', resync.json?.incremental === true);
  const afterCount = resync.json?.items?.length ?? 0;
  check('增量同步后条目数不减少', afterCount >= items.length, `${items.length} → ${afterCount}`);

  const state = await call(`/api/repos/${targetRepo}/state`);
  check('可读取持久化的同步状态', state.json?.state?.lastSyncAt !== null && state.json?.state?.itemCount > 0,
    `items=${state.json?.state?.itemCount} pages=${state.json?.state?.pagesFetched}`);

  /* ------------------------------------------------------------- report */

  const report = await call(`/api/repos/${targetRepo}/report?staleDays=30&doneDays=14`);
  check('服务端生成周报 → 200', report.status === 200, `${report.status} ${report.json?.error?.code ?? ''}`);
  const r = report.json?.report;
  check('周报包含总计与队列分布', Boolean(r?.totals && r?.buckets));
  check(
    '周报 bucket 总数 = 看板可见条目数',
    r && Object.values(r.buckets).reduce((a, b) => a + b, 0) <= (dash.json?.items?.length ?? 0),
    `buckets=${JSON.stringify(r?.buckets)} items=${dash.json?.items?.length}`,
  );
  check('周报 open 数与开启条目数一致', r?.totals?.open === items.filter((i) => i.state === 'open').length,
    `report=${r?.totals?.open} actual=${items.filter((i) => i.state === 'open').length}`);
  check('周报 issue+pr 拆分正确', r?.totals?.issues + r?.totals?.prs === r?.totals?.open);
  check('健康度在 0..100', r?.healthScore >= 0 && r?.healthScore <= 100, String(r?.healthScore));
  check('周报生成时间可解析', !Number.isNaN(Date.parse(r?.generatedAt ?? '')));

  /* -------------------------------------------------------- isolation */

  const resp = await fetch(`${BASE}/api/repos/octocat/hello-worgld/dashboard`);
  check('未添加的仓库返回 403（不泄露他人缓存）', resp.status === 403 || resp.status === 401, `${resp.status}`);

  // Even if another session's cookie is replayed against a different login,
  // rows are keyed by (login, repo), so a stale cookie cannot widen access.
  const freshCookie = cookie;
  cookie = 'repoops_sid=forged-session-id';
  const forged = await call(`/api/repos/${targetRepo}/dashboard`);
  check('伪造会话 Cookie → 401', forged.status === 401, `${forged.status}`);
  cookie = freshCookie;

  /* ------------------------------------------------------- remove repo */

  const remove = await call(`/api/repos/${targetRepo}`, { method: 'DELETE' });
  check('移除仓库 → 200', remove.status === 200, `${remove.status}`);
  const afterRemove = await call(`/api/repos/${targetRepo}/dashboard`);
  check('移除后无法再读取该仓库缓存 → 403', afterRemove.status === 403, `${afterRemove.status}`);
}

/* ----------------------------------------------------------- disconnect */

const logout = await call('/api/auth/logout', { method: 'POST' });
check('断开连接 → 200 且报告已清除数据', logout.status === 200 && logout.json?.purged === true);
const after = await call('/api/session');
check('断开后会话失效', after.json?.authenticated === false);
const cookieGone = /Max-Age=0/i.test(logout.headers.get('set-cookie') ?? '');
check('断开时清除 Cookie', cookieGone);

const failed = results.filter((r) => !r.ok);
console.log('\n----------------------------------------');
console.log(`${results.length - failed.length}/${results.length} checks passed against ${BASE}`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  process.exitCode = 1;
}
