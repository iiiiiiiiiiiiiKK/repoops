import { chromium } from 'playwright-core';

const BASE = 'https://repoops.852367856.dpdns.org';
const browser = await chromium.launch({
  executablePath: 'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium-1248\\chrome-win64\\chrome.exe',
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const p = await ctx.newPage();
await p.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForSelector('[data-testid="item-card"]');
await p.waitForTimeout(500);

await p.getByRole('button', { name: '设置与连接' }).click();
await p.waitForSelector('[data-testid="settings-modal"]');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const hrefDefault = await p.getByTestId('oauth-login').getAttribute('href');
check('默认登录链接使用最小 scope', hrefDefault === '/api/auth/login', hrefDefault);

await p.getByTestId('oauth-private').check();
const hrefPrivate = await p.getByTestId('oauth-login').getAttribute('href');
check('勾选「包含私有仓库」后升级为 ?private=1', hrefPrivate === '/api/auth/login?private=1', hrefPrivate);
await p.getByTestId('oauth-private').uncheck();

await p.getByRole('button', { name: '改用 Token 登录' }).click();
await p.waitForTimeout(300);
const focused = await p.evaluate(() => document.activeElement?.id);
check('「改用 Token 登录」把焦点送到 Token 输入框', focused === 'token-input', focused);

const hint = await p.evaluate(() => {
  const t = document.querySelector('[data-testid="settings-modal"]')?.textContent ?? '';
  return { gh: t.includes('github.com'), api: t.includes('api.github.com'), blank: t.includes('空白') };
});
check('提示说明 github.com 打不开时改用 Token', hint.gh && hint.api && hint.blank, JSON.stringify(hint));

await p.screenshot({ path: 'tests/e2e/screenshots/settings-oauth.png' });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} OAuth UI checks passed`);
if (failed.length) process.exitCode = 1;
