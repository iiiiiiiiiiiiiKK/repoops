/**
 * First-run experience after connecting GitHub.
 *
 * Covers the bug reported from production: right after a successful
 * authorization the app claimed "演示数据 / 只读维护工作台" and showed a demo banner
 * with an empty repo name, because the display mode was a state that only
 * flipped once a dashboard had loaded — and a brand-new account has zero
 * tracked repos, so nothing ever loaded.
 *
 * Asserts the honest post-login state and that the inline "add first repo"
 * form actually works, then cleans up.
 *
 * Usage: GITHUB_TEST_TOKEN=ghp_... node tests/first-run.mjs <baseUrl> [owner/name]
 */
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] ?? 'https://repoops.852367856.dpdns.org').replace(/\/$/, '');
const REPO = process.argv[3] ?? process.env.FIRST_RUN_REPO ?? 'iiiiiiiiiiiiiKK/0xKill';
const TOKEN = process.env.GITHUB_TEST_TOKEN;
if (!TOKEN) {
  console.error('GITHUB_TEST_TOKEN required');
  process.exit(2);
}

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

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-testid="item-card"]');

/* Connect, then reload exactly the way the OAuth callback does. */
const status = await page.evaluate(async (token) => {
  const r = await fetch('/api/auth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  return r.status;
}, TOKEN);
check('建立会话', status === 200, `status ${status}`);

await page.goto(BASE + '/?auth=ok', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);

const state = await page.evaluate(async () => {
  const session = await (await fetch('/api/session')).json();
  const q = (s) => document.querySelector(s);
  return {
    authenticated: session.authenticated,
    login: session.login,
    demoChip: Boolean(q('.chip--demo')),
    liveChip: Boolean(q('.chip--live')),
    demoBanner: Boolean(q('.demo-banner')),
    subtitle: q('.topbar__sub')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    emptyTitle: q('.empty-state__title')?.textContent?.trim() ?? '',
    hasInlineForm: Boolean(q('[data-testid="first-repo-input"]')),
    bannerText: [...document.querySelectorAll('.notice')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
  };
});

check('会话已认证', state.authenticated === true, `@${state.login}`);
check('不再显示「演示数据」角标', state.demoChip === false, `demoChip=${state.demoChip}`);
check('显示「已连接」角标', state.liveChip === true);
check('不再渲染演示数据横幅', state.demoBanner === false);
check('顶栏副标题不再是「只读维护工作台」', !state.subtitle.includes('只读维护工作台'), state.subtitle);
check('空状态说明已连接的是谁', /已连接\s*@/.test(state.emptyTitle), state.emptyTitle);
check('提供就地添加仓库的输入框', state.hasInlineForm);
check('授权横幅不再声称「正在同步仓库列表」', !/正在同步你的仓库列表/.test(state.bannerText), state.bannerText.slice(0, 80));

/* The inline form must actually add and sync. */
await page.getByTestId('first-repo-input').fill(REPO);
await page.getByRole('button', { name: '添加并同步' }).click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="item-card"]').length > 0, null, {
  timeout: 45000,
});
const board = await page.evaluate(() => ({
  cards: document.querySelectorAll('[data-testid="item-card"]').length,
  columns: document.querySelectorAll('.column').length,
  demoChip: Boolean(document.querySelector('.chip--demo')),
  repoTitle: document.querySelector('.topbar__repo')?.textContent,
}));
check('就地添加后看板渲染出真实数据', board.cards > 0 && board.columns === 5, `${board.cards} 张卡片 / ${board.columns} 列`);
check('看板不是演示态', board.demoChip === false);
check('顶栏显示所选仓库', (board.repoTitle ?? '').toLowerCase() === REPO.toLowerCase(), board.repoTitle ?? '');

/* Cleanup: disconnect purges the session and every derived row. */
await page.getByRole('button', { name: '设置与连接' }).click();
await page.waitForSelector('[data-testid="settings-modal"]');
await page.getByRole('button', { name: '断开 GitHub 连接' }).click();
await page.getByRole('button', { name: '确认断开并删除本地数据' }).click();
await page.waitForTimeout(1500);
const after = await page.evaluate(async () => (await fetch('/api/session')).json());
check('断开后会话已清除（测试不留数据）', after.authenticated === false);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} first-run checks passed`);
if (failed.length) process.exitCode = 1;
