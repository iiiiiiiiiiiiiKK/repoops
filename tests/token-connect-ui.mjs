/**
 * End-to-end check of the token (non-OAuth) connect flow through the real UI.
 *
 * This path only needs api.github.com, so it is the fallback when github.com
 * cannot be opened in the browser. It connects, verifies the live session, then
 * disconnects again so no test session is left in the database.
 *
 * Usage: GITHUB_TEST_TOKEN=ghp_... node tests/token-connect-ui.mjs <baseUrl>
 */
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'https://repoops.852367856.dpdns.org';
const TOKEN = process.env.GITHUB_TEST_TOKEN;
if (!TOKEN) {
  console.error('GITHUB_TEST_TOKEN required');
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath: 'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium-1248\\chrome-win64\\chrome.exe',
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-testid="item-card"]');

await page.getByRole('button', { name: '设置与连接' }).click();
await page.waitForSelector('[data-testid="settings-modal"]');
await page.getByTestId('token-input').fill(TOKEN);
await page.getByTestId('settings-modal').getByRole('button', { name: '连接', exact: true }).click();

// Wait for the modal to close (the app closes it on a successful connect).
await page.waitForSelector('[data-testid="settings-modal"]', { state: 'detached', timeout: 30000 }).catch(() => {});
const session = await page.evaluate(async () => (await fetch('/api/session')).json());
check('UI 里粘贴 Token 后成功建立会话', session.authenticated === true, `login=${session.login ?? '-'} mode=${session.mode}`);
check('会话中不含 token 字段', !('token' in session) && !JSON.stringify(session).includes(TOKEN.slice(0, 10)));

// Reload to prove the session cookie survives a full page load.
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
// A freshly connected account has no tracked repos yet, so the app shows the
// empty state instead of the board — wait for the shell, not the board.
await page.waitForSelector('.topbar', { timeout: 30000 });
await page.waitForTimeout(1500);
const afterReload = await page.evaluate(async () => (await fetch('/api/session')).json());
check('刷新后仍保持登录', afterReload.authenticated === true, `login=${afterReload.login ?? '-'}`);
const shell = await page.evaluate(() => ({
  hasTopbar: Boolean(document.querySelector('.topbar')),
  emptyStateText: document.querySelector('.empty-state')?.textContent?.slice(0, 40) ?? '',
}));
check('刷新后界面正常渲染（无仓库时给出空状态）', shell.hasTopbar, shell.emptyStateText);

// Clean up: disconnect must purge the session and all derived data.
await page.getByRole('button', { name: '设置与连接' }).click();
await page.waitForSelector('[data-testid="settings-modal"]');
await page.getByRole('button', { name: '断开 GitHub 连接' }).click();
await page.getByRole('button', { name: '确认断开并删除本地数据' }).click();
await page.waitForTimeout(1200);
const afterLogout = await page.evaluate(async () => (await fetch('/api/session')).json());
check('断开后会话已清除', afterLogout.authenticated === false);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} token-connect checks passed`);
if (failed.length) process.exitCode = 1;
