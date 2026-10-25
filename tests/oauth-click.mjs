/**
 * The exact user path: open the app, open settings, click the real
 * "用 GitHub 登录" button, and confirm the browser leaves for github.com.
 *
 * Deliberately tolerant: if github.com is unreachable from the machine running
 * this check the result is SKIP, not FAIL — that says nothing about the app.
 * The hard regression guard for this bug is tests/navigation-routing.mjs.
 *
 * Usage: node tests/oauth-click.mjs <baseUrl>
 */
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] ?? 'https://repoops.852367856.dpdns.org').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: 'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium-1248\\chrome-win64\\chrome.exe',
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();

const chain = [];
page.on('response', (r) => {
  if (!r.frame()) return;
  const u = r.url();
  if (u.includes('/api/auth') || u.includes('github.com/login')) chain.push(`${r.status()} ${u.slice(0, 78)}`);
});

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-testid="item-card"]');
await page.getByRole('button', { name: '设置与连接' }).click();
await page.waitForSelector('[data-testid="settings-modal"]');

await Promise.all([
  page.waitForURL(/github\.com/, { timeout: 45000 }).catch(() => null),
  page.getByTestId('oauth-login').click(),
]);
await page.waitForTimeout(2000);

const url = page.url();
const onGithub = /(^|\.)github\.com$/.test(new URL(url).hostname);
const leftOrigin = !url.startsWith(BASE);

console.log('最终 URL:', url.slice(0, 110));
console.log('跳转链路:');
for (const c of chain) console.log('  ' + c);

if (!leftOrigin) {
  console.log('FAIL  点击后没有离开本站（OAuth 入口被吞）');
  process.exitCode = 1;
} else if (onGithub) {
  console.log('PASS  点按钮后到达 GitHub（' + new URL(url).host + '）');
} else {
  console.log('SKIP  已离开本站但未到达 github.com（本机网络可能拦截），判定不了对错');
}

await browser.close();
