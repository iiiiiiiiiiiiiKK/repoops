/**
 * UI behaviour when the session store is unavailable (D1 quota exhausted).
 *
 * Stubs /api/session in the browser so the degraded branch can be exercised
 * deterministically: the app must say "cannot determine" and explicitly state
 * that OAuth *is* configured — never the old "OAuth 未配置" lie.
 */
import { chromium } from 'playwright-core';

const BASE = 'https://repoops.852367856.dpdns.org';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: 'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium-1248\\chrome-win64\\chrome.exe',
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();

await page.route('**/api/session', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      authenticated: false,
      login: null,
      avatarUrl: null,
      scopes: [],
      tokenExpiresAt: null,
      mode: 'demo',
      appName: 'RepoOps',
      oauthConfigured: true,
      demoRepo: 'honojs/hono',
      degraded: true,
      degradedReason: "D1_ERROR: Your account has exceeded D1's free tier daily row read limit.",
    }),
  }),
);

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3500);

const banners = await page.evaluate(() =>
  [...document.querySelectorAll('.notice')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
);
check(
  '顶栏出现「登录态读取失败 / 配额」提示',
  banners.some((b) => /配额已用尽|登录态读取失败/.test(b)),
  banners.find((b) => /配额/.test(b))?.slice(0, 90),
);
check(
  '提示明确说明「GitHub 登录配置是正常的」',
  banners.some((b) => /登录配置是正常的/.test(b)),
);

await page.getByRole('button', { name: '设置与连接' }).click().catch(() => {});
await page.waitForTimeout(600);
const modal = await page.evaluate(() => {
  const t = (document.querySelector('[data-testid="settings-modal"]')?.textContent ?? '').replace(/\s+/g, ' ');
  return {
    claimsNotConfigured: /没有配置\s*GITHUB_CLIENT_ID/.test(t),
    saysNotOauthIssue: /这不代表 OAuth 未配置/.test(t),
    keepsTokenFallback: Boolean(document.querySelector('[data-testid="token-input"]')),
    offersLoginRetry: Boolean(document.querySelector('[data-testid="settings-modal"] a[href="/api/auth/login"]')),
  };
});
check('连接面板不再谎称「OAuth 未配置」', modal.claimsNotConfigured === false);
check('连接面板说明「这不代表 OAuth 未配置」', modal.saysNotOauthIssue);
check('仍保留只读 Token 入口', modal.keepsTokenFallback);
check('仍提供重试登录入口', modal.offersLoginRetry);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} degraded-mode UI checks passed`);
if (failed.length) process.exitCode = 1;
