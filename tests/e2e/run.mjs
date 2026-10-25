/**
 * End-to-end smoke test against a running deployment.
 *
 * Uses playwright-core with the Chromium already present on this machine
 * (no browser download), drives real user journeys, and asserts on rendered
 * DOM state — not on the implementation.
 *
 * Usage:  node tests/e2e/run.mjs [baseUrl]
 * Default baseUrl: http://127.0.0.1:8787 (wrangler dev) or $REPOROPS_URL
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? process.env.REPOROPS_URL ?? 'http://127.0.0.1:8787';
const SHOTS = 'tests/e2e/screenshots';
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium-1248\\chrome-win64\\chrome.exe',
    'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1248\\chrome-headless-shell-win64\\chrome-headless-shell.exe',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('No Chromium binary found. Set CHROME_PATH.');
}

if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: chromePath(), args: ['--no-sandbox'] });

const consoleErrors = [];

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  locale: 'zh-CN',
});
const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

try {
  /* ---------------------------------------------------------------- load */
  const resp = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  record('页面可访问 (HTTP 200)', resp?.status() === 200, `status ${resp?.status()}`);

  await page.waitForSelector('[data-testid="board"]', { timeout: 30_000 });
  record('看板渲染完成', true);

  const columns = await page.locator('.column').count();
  record('五个队列列都存在', columns === 5, `${columns} columns`);

  // The board shell renders before the demo payload arrives, so wait for the
  // first card instead of assuming data is already on screen.
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="item-card"]').length > 0, null, {
    timeout: 30_000,
  });
  const cards = await page.locator('[data-testid="item-card"]').count();
  record('演示数据渲染为卡片', cards > 0, `${cards} cards`);

  /* ------------------------------------------------------------ demo tag */
  const demoBadge = await page.locator('.chip--demo').first().textContent();
  record('演示数据带明确标识', /演示数据/.test(demoBadge ?? ''), demoBadge?.trim());

  /* -------------------------------------------------------------- search */
  await page.fill('#repoops-search', 'fix');
  await page.waitForTimeout(500);
  const afterSearch = await page.locator('[data-testid="item-card"]').count();
  record('搜索会改变结果集', afterSearch !== cards, `${cards} → ${afterSearch}`);
  const searchOk = await page
    .locator('.toolbar')
    .getByText(/\/ \d+ 项/)
    .textContent()
    .catch(() => '');
  record('结果计数显示在工具栏', Boolean(searchOk), searchOk?.trim());

  await page.fill('#repoops-search', 'zzzz-no-such-thing-zzzz');
  await page.waitForTimeout(400);
  const zeroCards = await page.locator('[data-testid="item-card"]').count();
  record('无结果时显示空状态而不是旧数据', zeroCards === 0, `${zeroCards} cards`);
  await page.fill('#repoops-search', '');
  await page.waitForTimeout(400);

  /* ------------------------------------------------------------- filters */
  await page.getByRole('button', { name: '仅停滞' }).click();
  await page.waitForTimeout(400);
  const stalledOnly = await page.locator('[data-testid="column-review"] [data-testid="item-card"]').count();
  const nonStalledTotal =
    (await page.locator('[data-testid="column-triage"] [data-testid="item-card"]').count()) + stalledOnly;
  record('「仅停滞」过滤生效', nonStalledTotal === 0, `triage+review = ${nonStalledTotal}`);
  await page.getByRole('button', { name: '仅停滞' }).click();
  await page.waitForTimeout(300);

  /* ------------------------------------------------------------ threshold */
  const beforeStalled = await page.locator('[data-testid="column-stalled"] [data-testid="item-card"]').count();
  await page.locator('input[aria-label="停滞阈值（天）"]').fill('180');
  await page.waitForTimeout(500);
  const afterStalled = await page.locator('[data-testid="column-stalled"] [data-testid="item-card"]').count();
  record('停滞阈值滑块实时重算队列', afterStalled <= beforeStalled, `${beforeStalled} → ${afterStalled} (阈值 180)`);
  await page.locator('input[aria-label="停滞阈值（天）"]').fill('30');
  await page.waitForTimeout(300);

  /* --------------------------------------------------------------- detail */
  await page.locator('[data-testid="item-card"]').first().click();
  await page.waitForSelector('[data-testid="detail-panel"]', { timeout: 10_000 });
  record('点击卡片打开右侧详情面板', true);

  await page.getByRole('tab', { name: '评论草稿' }).click();
  const draft = await page.locator('[data-testid="comment-draft"]').textContent();
  record('评论草稿可生成', Boolean(draft && draft.length > 40), `${draft?.length ?? 0} chars`);

  await page.getByRole('tab', { name: '任务清单' }).click();
  const checklist = await page.locator('[data-testid="checklist-draft"]').textContent();
  record('任务清单可生成', Boolean(checklist?.includes('- [ ]')));

  const githubLink = await page
    .locator('[data-testid="detail-panel"] a[href*="github.com"]')
    .first()
    .getAttribute('href');
  record(
    '详情里有真实 GitHub 链接',
    /^https:\/\/github\.com\/.+\/(issues|pull)\/\d+$/.test(githubLink ?? ''),
    githubLink ?? '',
  );

  await page.screenshot({ path: join(SHOTS, 'desktop-detail.png'), fullPage: false });

  await page.locator('[data-testid="detail-panel"] button[aria-label="关闭详情面板"]').click();
  await page.waitForTimeout(300);
  record('详情面板可关闭', (await page.locator('[data-testid="detail-panel"]').count()) === 0);

  /* --------------------------------------------------------------- report */
  await page.getByRole('button', { name: /周报/ }).click();
  await page.waitForSelector('[data-testid="report-modal"]', { timeout: 10_000 });
  const reportMd = await page.locator('[data-testid="report-markdown"]').textContent();
  record('周报生成并含 Markdown 导出', Boolean(reportMd?.includes('维护周报')), `${reportMd?.length ?? 0} chars`);

  const boardCounts = await page.evaluate(() => {
    const read = (b) => document.querySelectorAll(`[data-testid="column-${b}"] [data-testid="item-card"]`).length;
    return {
      triage: read('triage'),
      review: read('review'),
      author: read('author'),
      stalled: read('stalled'),
      done: read('done'),
    };
  });
  const parseRow = (md, label) => {
    const m = md.match(new RegExp(`\\| ${label}[^|]*\\| (\\d+) \\|`));
    return m ? Number(m[1]) : -1;
  };
  const reportCounts = {
    triage: parseRow(reportMd ?? '', '待处理'),
    review: parseRow(reportMd ?? '', '等待审查'),
    author: parseRow(reportMd ?? '', '等待作者'),
    stalled: parseRow(reportMd ?? '', '已停滞'),
    done: parseRow(reportMd ?? '', '近期完成'),
  };
  const matches = Object.keys(boardCounts).every((k) => boardCounts[k] === reportCounts[k]);
  record(
    '周报数字与看板实际卡片数一致',
    matches,
    `board=${JSON.stringify(boardCounts)} report=${JSON.stringify(reportCounts)}`,
  );

  await page.screenshot({ path: join(SHOTS, 'desktop-report.png') });
  await page.getByTestId('report-close').click();
  await page.waitForTimeout(300);

  /* ------------------------------------------------------------- settings */
  await page.getByRole('button', { name: '设置与连接' }).click();
  await page.waitForSelector('[data-testid="settings-modal"]');
  record('设置弹窗可打开', true);
  // The connect tab must reflect the deployment's real OAuth state instead of
  // always promising a working button: with secrets configured it offers GitHub
  // login, without them it explains why and points at the token fallback.
  const oauthState = await page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    const modal = document.querySelector('[data-testid="settings-modal"]');
    const login = [...modal.querySelectorAll('a')].find((a) =>
      (a.getAttribute('href') ?? '').startsWith('/api/auth/login'),
    );
    return {
      configured: Boolean(session.oauthConfigured),
      hasLoginButton: Boolean(login),
      text: modal.textContent ?? '',
    };
  });
  record(
    '连接入口与部署的 OAuth 配置一致（不假装可用）',
    oauthState.configured ? oauthState.hasLoginButton : /GITHUB_CLIENT_ID|OAuth 不可用/.test(oauthState.text),
    `oauthConfigured=${oauthState.configured} loginButton=${oauthState.hasLoginButton}`,
  );
  record('保留了只读 Token 备用入口', /Token/.test(oauthState.text));

  await page.getByRole('tab', { name: '关于' }).click();
  const aboutText = await page.locator('[data-testid="settings-modal"]').textContent();
  record('关于页含作者 X 链接', /0xkillcoin/.test(aboutText ?? ''));
  await page.locator('[data-testid="settings-modal"]').getByRole('button', { name: '完成' }).click();
  await page.waitForTimeout(300);

  /* ---------------------------------------------------- author X (top-right) */
  const xLink = await page.locator('header.topbar a[aria-label*="作者 X"]').first().getAttribute('href');
  record(
    '顶栏右上角有作者 X 链接且指向 https://x.com/0xkillcoin',
    xLink === 'https://x.com/0xkillcoin',
    xLink ?? 'missing',
  );

  const xBox = await page.locator('header.topbar a[aria-label*="作者 X"]').first().boundingBox();
  record('作者 X 位于顶栏右半部分', Boolean(xBox && xBox.x > 900), `x=${xBox?.x}`);

  const sidebarX = await page.locator('.sidebar .author-card').getAttribute('href');
  record('侧栏也有作者 X 入口', sidebarX === 'https://x.com/0xkillcoin', sidebarX ?? '');

  /* -------------------------------------------------------------- keyboard */
  await page.keyboard.press('Escape');
  await page.keyboard.press('/');
  const focused = await page.evaluate(() => document.activeElement?.id);
  record('按 / 聚焦搜索框', focused === 'repoops-search', focused ?? '');

  await page.locator('[data-testid="item-card"]').first().click();
  await page.waitForSelector('[data-testid="detail-panel"]');
  await page.keyboard.press('j');
  await page.waitForTimeout(200);
  const afterJ = await page.locator('.card--selected').getAttribute('data-item-id');
  record('键盘 j 切换选中卡片', Boolean(afterJ));
  await page.keyboard.press('Escape');

  /* ---------------------------------------------------------------- theme */
  const themeBefore = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.getByRole('button', { name: /切换到(浅色|深色)模式/ }).click();
  await page.waitForTimeout(250);
  const themeAfter = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  record('深色/浅色模式可切换', themeBefore !== themeAfter, `${themeBefore} → ${themeAfter}`);
  await page.getByRole('button', { name: /切换到(浅色|深色)模式/ }).click();
  await page.waitForTimeout(250);

  /* --------------------------------------------------------------- batch */
  const checkboxes = page.locator('.card__check');
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  await page.waitForTimeout(300);
  const batchVisible = await page.locator('[data-testid="batch-bar"]').count();
  record('批量选择后出现批量操作条', batchVisible === 1);
  const batchText = await page.locator('[data-testid="batch-bar"]').textContent();
  record('批量操作只提供复制，不提供写操作', /只复制文本/.test(batchText ?? ''));
  await page.locator('[data-testid="batch-bar"]').getByRole('button', { name: /取消选择/ }).click();
  await page.waitForTimeout(200);

  await page.screenshot({ path: join(SHOTS, 'desktop-board.png'), fullPage: false });

  /* ============================ mobile ============================ */
  const iphone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    locale: 'zh-CN',
  });
  const m = await iphone.newPage();
  m.on('pageerror', (err) => consoleErrors.push(`mobile pageerror: ${err.message}`));
  await m.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await m.waitForSelector('[data-testid="board"]', { timeout: 30_000 });
  await m.waitForFunction(() => document.querySelectorAll('[data-testid="item-card"]').length > 0, null, {
    timeout: 30_000,
  });
  record('iPhone 390x844 可正常加载', true);

  const overflowInfo = await m.evaluate(
    () => `${document.documentElement.scrollWidth} vs ${window.innerWidth}`,
  );
  const hasOverflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  record('移动端无横向溢出（无横向滚动条）', !hasOverflow, overflowInfo);

  const sidebarHidden = await m.evaluate(() => {
    const el = document.querySelector('.sidebar');
    if (!el) return false;
    return !el.classList.contains('sidebar--open');
  });
  record('移动端侧栏默认收起（不挤占内容）', sidebarHidden);

  const columnCount = await m.locator('.column').count();
  record('移动端看板仍渲染 5 列', columnCount === 5, `${columnCount}`);

  const boardStacked = await m.evaluate(() => {
    const cols = [...document.querySelectorAll('.column')].map((c) => c.getBoundingClientRect());
    const sameLeft = cols.every((r) => Math.abs(r.left - cols[0].left) < 2);
    const increasing = cols.every((r, i) => i === 0 || r.top >= cols[i - 1].top);
    return sameLeft && increasing;
  });
  record('移动端看板为单列纵向堆叠', boardStacked);

  const xMobile = await m.locator('header.topbar a[aria-label*="作者 X"]').first().isVisible();
  record('iPhone 上作者 X 依然可见', xMobile);

  await m.screenshot({ path: join(SHOTS, 'mobile-board.png'), fullPage: false });

  // Mobile navigation drawer
  await m.getByRole('button', { name: '打开仓库导航' }).click();
  await m.waitForTimeout(400);
  const drawerOpen = await m.evaluate(() => document.querySelector('.sidebar')?.classList.contains('sidebar--open'));
  record('移动端可打开仓库导航抽屉', Boolean(drawerOpen));
  await m.screenshot({ path: join(SHOTS, 'mobile-drawer.png') });
  await m.locator('.sidebar .repo-item').first().click();
  await m.waitForTimeout(800);

  // Mobile detail panel becomes full-screen
  await m.locator('[data-testid="item-card"]').first().click();
  await m.waitForSelector('[data-testid="detail-panel"]', { timeout: 10_000 });
  const detailRect = await m.evaluate(() => {
    const el = document.querySelector('[data-testid="detail-panel"]');
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), vw: window.innerWidth };
  });
  record('移动端详情面板全屏显示', detailRect.w >= detailRect.vw - 2, JSON.stringify(detailRect));
  await m.screenshot({ path: join(SHOTS, 'mobile-detail.png') });
  await m.locator('[data-testid="detail-panel"] button[aria-label="关闭详情面板"]').click();
  await m.waitForTimeout(300);

  // Mobile report modal fits
  await m.getByRole('button', { name: /周报/ }).click();
  await m.waitForSelector('[data-testid="report-modal"]', { timeout: 10_000 });
  const modalFits = await m.evaluate(() => {
    const el = document.querySelector('[data-testid="report-modal"]');
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), vw: window.innerWidth, h: Math.round(r.height), vh: window.innerHeight };
  });
  record(
    '移动端周报弹窗不超出视口',
    modalFits.w <= modalFits.vw && modalFits.h <= modalFits.vh,
    JSON.stringify(modalFits),
  );
  await m.screenshot({ path: join(SHOTS, 'mobile-report.png') });
  await m.getByTestId('report-close').click();

  /* --------------------------------------------------------------- tablet */
  const ipad = await browser.newContext({
    viewport: { width: 820, height: 1180 },
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
  });
  const t = await ipad.newPage();
  await t.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await t.waitForSelector('[data-testid="board"]');
  const tabletOverflow = await t.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  record('iPad 820x1180 无横向溢出', !tabletOverflow);
  await t.screenshot({ path: join(SHOTS, 'tablet-board.png') });
  await ipad.close();

  /* --------------------------------------------------------- 375px iPhone SE */
  const se = await browser.newContext({
    viewport: { width: 375, height: 667 },
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
  });
  const sePage = await se.newPage();
  await sePage.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sePage.waitForSelector('[data-testid="board"]');
  const seOverflow = await sePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  record('iPhone SE 375x667 无横向溢出', !seOverflow);
  await sePage.screenshot({ path: join(SHOTS, 'mobile-se.png') });
  await se.close();

  await iphone.close();

  /* -------------------------------------------------------- console errors */
  const realErrors = consoleErrors.filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
  record('浏览器控制台无报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} catch (err) {
  record('E2E 运行时异常', false, err.message);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log('\n----------------------------------------');
console.log(`${results.length - failed.length}/${results.length} checks passed against ${BASE}`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  process.exitCode = 1;
}
