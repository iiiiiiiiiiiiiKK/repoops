/**
 * Verify the GitHub OAuth App wiring without needing a human to click Authorize:
 *
 *  1. /api/auth/login must 302 to github.com with the right params.
 *  2. GitHub's authorize page must load the app (not "Application not found") and
 *     must not complain about redirect_uri.
 *  3. A bogus authorization code must come back from the token endpoint as
 *     `bad_verification_code`. If the client secret were wrong GitHub would say
 *     `incorrect_client_credentials` instead — so this distinguishes the two
 *     without ever handling a real user's code.
 */
const BASE = process.argv[2] ?? 'https://repoops.852367856.dpdns.org';

const out = { ok: true, steps: [] };
const step = (name, ok, detail = '') => {
  out.steps.push({ name, ok, detail });
  if (!ok) out.ok = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/* 1. login redirect */
const login = await fetch(BASE + '/api/auth/login', { redirect: 'manual' });
const loc = login.headers.get('location') ?? '';
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
const authorize = new URL(loc);
const params = Object.fromEntries(authorize.searchParams);

step('GET /api/auth/login → 302', login.status === 302, `status ${login.status}`);
step('跳转目标为 github.com/login/oauth/authorize', authorize.host === 'github.com' && authorize.pathname === '/login/oauth/authorize', authorize.host + authorize.pathname);
step('携带 client_id', Boolean(params.client_id), params.client_id);
step('redirect_uri 与部署回调一致', params.redirect_uri === BASE + '/api/auth/callback', params.redirect_uri);
step('申请最小 scope（不含 repo）', params.scope === 'read:user public_repo', params.scope);
step('state 足够随机（≥32 字符）', (params.state ?? '').length >= 32, `${(params.state ?? '').length} chars`);
step('下发 HttpOnly state cookie', /repoops_oauth_state=/.test(cookie), cookie.split('=')[0]);

/* 2. GitHub's authorize page — INFORMATIONAL ONLY.
      Whether github.com is reachable from the machine running this script says
      nothing about the app, so it must not turn the suite red. What it does give
      us is a precise diagnosis when someone reports "clicking login does
      nothing". */
try {
  const gh = await fetch(authorize.toString(), {
    redirect: 'manual',
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  const html = await gh.text();
  const notFound = html.includes('Application not found');
  const uriMismatch = html.includes('redirect_uri MUST match') || html.includes('The redirect_uri');
  const hasLoginForm = /input[^>]+type="password"|Sign in to GitHub/i.test(html);
  console.log(
    `INFO  GitHub 授权页：status=${gh.status} 应用已注册=${!notFound} redirect_uri 被接受=${!uriMismatch} 需要先登录=${hasLoginForm}`,
  );
  if (notFound) console.log('      → client_id 未注册，检查 OAuth App 是否创建成功');
  if (uriMismatch) console.log('      → redirect_uri 与 OAuth App 里登记的不一致');
  if (hasLoginForm && !notFound && !uriMismatch) {
    console.log('      → 一切正常：GitHub 只是要求先登录（浏览器里没有 GitHub 会话时会看到这个）');
  }
} catch {
  console.log('INFO  GitHub 授权页不可达（本机到 github.com 超时）——不影响下面的硬断言');
}

/* 3. token exchange accepts our client credentials */
const cb = await fetch(`${BASE}/api/auth/callback?code=repoops_verify_bogus_code&state=${params.state}`, {
  redirect: 'manual',
  headers: { cookie },
});
const cbLoc = cb.headers.get('location') ?? '';
const reason = new URL(cbLoc).searchParams.get('reason') ?? '';
step('回调拒绝伪造 code', cb.status === 302 && cbLoc.includes('auth=error'), cbLoc.replace(BASE, ''));
step(
  'client_id + secret 被 GitHub 接受（返回 bad_verification_code 而非 incorrect_client_credentials）',
  reason === 'bad_verification_code',
  reason || '(no reason)',
);
step('失败后清除 state cookie', /Max-Age=0/.test(cb.headers.get('set-cookie') ?? ''));

const failed = out.steps.filter((s) => !s.ok);
console.log('\n----------------------------------------');
console.log(`${out.steps.length - failed.length}/${out.steps.length} OAuth wiring checks passed`);
if (failed.length) process.exitCode = 1;
