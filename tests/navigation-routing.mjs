/**
 * Navigation routing regression test.
 *
 * Why this exists: every API assertion in this repo used `fetch()`, which is a
 * subresource request (Sec-Fetch-Mode: cors). Browsers navigate with
 * Sec-Fetch-Mode: navigate, and Cloudflare Workers Static Assets answers
 * *navigation* requests for unknown paths with index.html when
 * `not_found_handling: single-page-application` is set.
 *
 * The result was a production bug nobody's tests caught: clicking "用 GitHub 登录"
 * loaded the SPA again instead of the OAuth redirect, so the button looked dead.
 * `/api/*` must therefore be listed in `run_worker_first`.
 *
 * Every check below drives a REAL top-level navigation in Chromium.
 *
 * Usage: node tests/navigation-routing.mjs <baseUrl>
 */
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] ?? 'https://repoops.852367856.dpdns.org').replace(/\/$/, '');
const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium-1248\\chrome-win64\\chrome.exe',
].filter(Boolean).find((p) => p);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();

/** Navigate like a user and report what the server actually returned. */
async function navigate(path) {
  const seen = [];
  const onResponse = (r) => {
    if (!r.frame()) return;
    seen.push({
      status: r.status(),
      url: r.url(),
      ct: (r.headers()['content-type'] ?? '').split(';')[0],
    });
  };
  page.on('response', onResponse);
  let error = null;
  try {
    await page.goto(BASE + path, { waitUntil: 'commit', timeout: 30000 });
  } catch (e) {
    error = e.message.split('\n')[0];
  }
  await page.waitForTimeout(400);
  page.off('response', onResponse);
  return { seen, finalUrl: page.url(), error };
}

/* 1. A JSON API endpoint must not be swallowed by the SPA shell. */
{
  const { seen, error } = await navigate('/api/health');
  const doc = seen.find((s) => s.url.endsWith('/api/health'));
  check(
    '浏览器直接访问 /api/health 得到 JSON（不是首页）',
    !error && doc?.status === 200 && doc.ct === 'application/json',
    `${doc?.status} ${doc?.ct}${error ? ` (${error})` : ''}`,
  );
}

/* 2. The OAuth entry point must redirect away, not render the app. */
{
  const { seen, finalUrl, error } = await navigate('/api/auth/login');
  const doc = seen.find((s) => s.url.includes('/api/auth/login'));
  const wentToGithub = /(^|\.)github\.com$/.test(new URL(finalUrl).hostname);
  check('浏览器导航 /api/auth/login 返回 302（不是 200 HTML）', !error && doc?.status === 302, `${doc?.status ?? 'no response'}${error ? ` (${error})` : ''}`);
  check('最终跳离本站（进入 github.com 登录/授权页）', wentToGithub, new URL(finalUrl).host);
}

/* 3. The callback must also be routed to the Worker (invalid state -> error page). */
{
  const { seen, finalUrl, error } = await navigate('/api/auth/callback?code=bogus&state=bogus');
  const doc = seen.find((s) => s.url.includes('/api/auth/callback'));
  const backHome = finalUrl.startsWith(BASE) && /auth=error/.test(finalUrl);
  check('浏览器导航 /api/auth/callback 命中 Worker（302 回站内）', !error && doc?.status === 302, `${doc?.status ?? 'no response'}`);
  check('无效 state 被拒绝并回到站内错误页', backHome, finalUrl.replace(BASE, '') || finalUrl.slice(0, 60));
}

/* 4. Unknown API paths must still 404 instead of silently serving the SPA. */
{
  const { seen } = await navigate('/api/this-route-does-not-exist');
  const doc = seen.find((s) => s.url.includes('/api/this-route-does-not-exist'));
  check('未知 /api 路径返回 404 JSON（不是首页）', doc?.status === 404 && doc.ct === 'application/json', `${doc?.status} ${doc.ct}`);
}

/* 5. SPA deep links must still fall back to index.html. */
{
  const { seen, error } = await navigate('/some/deep/link');
  const doc = seen.find((s) => s.url.endsWith('/some/deep/link'));
  check('非 /api 深链接仍回落到 SPA 首页', !error && doc?.status === 200 && doc.ct === 'text/html', `${doc?.status} ${doc?.ct}`);
}

/* 6. The root and the static bundle still load. */
{
  const { seen } = await navigate('/');
  const doc = seen.find((s) => s.url === BASE + '/' || s.url === BASE);
  check('根路径返回 SPA HTML', doc?.status === 200 && doc.ct === 'text/html', `${doc?.status} ${doc?.ct}`);
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log('\n----------------------------------------');
console.log(`${results.length - failed.length}/${results.length} navigation routing checks passed`);
if (failed.length) process.exitCode = 1;
