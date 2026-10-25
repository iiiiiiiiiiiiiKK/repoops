/**
 * Responsive audit: measures real geometry at several viewports instead of
 * eyeballing screenshots. Fails on horizontal overflow, undersized tap targets,
 * unreadable font sizes, and elements escaping the viewport.
 *
 * Usage: node tests/e2e/responsive-audit.mjs [baseUrl]
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? process.env.REPOROPS_URL ?? 'http://127.0.0.1:8787';

const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium-1248\\chrome-win64\\chrome.exe',
].filter(Boolean).find((p) => existsSync(p));

const VIEWPORTS = [
  { name: 'iPhone SE (1st) 320x568', width: 320, height: 568, mobile: true },
  { name: 'iPhone SE (2nd) 375x667', width: 375, height: 667, mobile: true },
  { name: 'iPhone 14 390x844', width: 390, height: 844, mobile: true },
  { name: 'iPhone 14 Pro Max 430x932', width: 430, height: 932, mobile: true },
  // Landscape is its own challenge: only ~320-390px of height for header + banner
  // + filter bar + board.
  { name: 'iPhone SE landscape 568x320', width: 568, height: 320, mobile: true },
  { name: 'iPhone 14 landscape 844x390', width: 844, height: 390, mobile: true },
  { name: 'iPad mini 768x1024', width: 768, height: 1024, mobile: true },
  { name: 'iPad Pro 1024x1366', width: 1024, height: 1366, mobile: true },
  { name: 'Laptop 1280x800', width: 1280, height: 800, mobile: false },
  { name: 'Desktop 1440x900', width: 1440, height: 900, mobile: false },
  { name: 'Wide 1920x1080', width: 1920, height: 1080, mobile: false },
];

const results = [];
const record = (vp, name, ok, detail = '') => {
  results.push({ vp, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${vp}] ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

try {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
      deviceScaleFactor: vp.mobile ? 2 : 1,
      locale: 'zh-CN',
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('[data-testid="board"]', { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="item-card"]').length > 0, null, {
      timeout: 30_000,
    });

    const m = await page.evaluate(() => {
      const doc = document.documentElement;
      // Elements inside a deliberate horizontal scroller (the toolbar strip) are
      // not overflow bugs — the strip itself stays inside the viewport and the
      // content is reachable by scrolling it. Everything else must fit.
      const inScroller = (el) => {
        let cur = el.parentElement;
        while (cur) {
          const ox = getComputedStyle(cur).overflowX;
          if (ox === 'auto' || ox === 'scroll') return true;
          cur = cur.parentElement;
        }
        return false;
      };

      const overflowing = [...document.querySelectorAll('body *')]
        .filter((el) => {
          if (inScroller(el)) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > window.innerWidth + 1.5;
        })
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`);

      const scrollerFits = [...document.querySelectorAll('.toolbar')].every((el) => {
        const r = el.getBoundingClientRect();
        return r.right <= window.innerWidth + 1.5 && r.left >= -1;
      });

      const tapTargets = [...document.querySelectorAll('button, a.btn, .tab, input[type=checkbox]')]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24), h: Math.round(r.height), w: Math.round(r.width) };
        });

      const cardTitle = document.querySelector('.card__title');
      const topbar = document.querySelector('.topbar');
      const searchInput = document.querySelector('#repoops-search');
      const columns = [...document.querySelectorAll('.column')].map((c) => c.getBoundingClientRect());

      return {
        scrollWidth: doc.scrollWidth,
        innerWidth: window.innerWidth,
        overflowing,
        scrollerFits,
        tapTargets,
        cardFontPx: cardTitle ? parseFloat(getComputedStyle(cardTitle).fontSize) : 0,
        searchHeight: searchInput ? Math.round(searchInput.getBoundingClientRect().height) : 0,
        topbarHeight: topbar ? Math.round(topbar.getBoundingClientRect().height) : 0,
        columnLayout: {
          count: columns.length,
          stacked: columns.every((r, i) => i === 0 || Math.abs(r.left - columns[0].left) < 2),
          allInView: columns.every((r) => r.left >= -1 && r.right <= window.innerWidth + 1.5),
        },
        xLinkVisible: (() => {
          const a = document.querySelector('header.topbar a[aria-label*="作者 X"]');
          if (!a) return false;
          const r = a.getBoundingClientRect();
          return r.width > 0 && r.right <= window.innerWidth + 1;
        })(),
        // Header geometry: the header must not eat the screen, must not have
        // colliding controls, and the repo name must not be cut off.
        header: (() => {
          const bar = document.querySelector('.topbar');
          const area = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return r.width > 0 ? { right: r.right, bottom: r.bottom, left: r.left, top: r.top } : null;
          };
          const boxes = bar
            ? [...bar.querySelectorAll('*')]
                .map((el) => ({ el, r: el.getBoundingClientRect() }))
                // icon glyphs inside one svg and the overlaid search icon are
                // single visual units, not layout collisions
                .filter((x) => x.r.width > 0 && x.r.height > 0 && !x.el.closest('svg') && !x.el.closest('.search'))
            : [];
          let collisions = 0;
          for (let i = 0; i < boxes.length; i += 1) {
            for (let j = i + 1; j < boxes.length; j += 1) {
              const a = boxes[i];
              const b = boxes[j];
              if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
              const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
              const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
              if (ox > 2 && oy > 2) collisions += 1;
            }
          }
          const repo = document.querySelector('.topbar__repo');
          const srch = document.querySelector('#repoops-search');
          return {
            height: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
            vh: window.innerHeight,
            collisions,
            repoTruncated: repo ? repo.scrollWidth > repo.clientWidth + 1 : false,
            searchWidth: srch ? Math.round(srch.getBoundingClientRect().width) : 0,
            xRight: area('header.topbar a[aria-label*="作者 X"]')?.right ?? null,
          };
        })(),
      };
    });

    record(vp.name, '无横向溢出', m.scrollWidth <= m.innerWidth + 1, `${m.scrollWidth} / ${m.innerWidth}`);
    // Header budget: ≤120px, and either ≤25% of the viewport or a hard cap on
    // very short (landscape phone) viewports where any header is a large share.
    const headerBudgetOk =
      m.header.height <= 120 && (m.header.height / m.header.vh <= 0.25 || m.header.vh < 420);
    record(
      vp.name,
      '顶栏高度 ≤120px 且 ≤25% 视口（矮横屏按绝对像素）',
      headerBudgetOk,
      `${m.header.height}px / ${m.header.vh}px (${Math.round((m.header.height / m.header.vh) * 100)}%)`,
    );
    record(vp.name, '顶栏内控件互不重叠', m.header.collisions === 0, `${m.header.collisions} collisions`);
    record(vp.name, '顶栏仓库名未被截断', !m.header.repoTruncated);
    record(vp.name, '顶栏搜索框宽度 ≥120px', m.header.searchWidth >= 120, `${m.header.searchWidth}px`);
    record(
      vp.name,
      '作者 𝕏 位于顶栏右侧且不出屏',
      m.header.xRight !== null && m.header.xRight > m.innerWidth * 0.6 && m.header.xRight <= m.innerWidth + 1,
      `right=${m.header.xRight}`,
    );
    if (m.overflowing.length) {
      record(vp.name, '没有元素超出右边界', false, m.overflowing.join(', '));
    } else {
      record(vp.name, '没有元素超出右边界', true);
    }
    record(vp.name, '卡片标题字号 ≥ 12px', m.cardFontPx >= 12, `${m.cardFontPx}px`);
    record(vp.name, '搜索框高度 ≥ 30px', m.searchHeight >= 30, `${m.searchHeight}px`);
    record(vp.name, '筛选条本身不超出视口（内容可横滑）', m.scrollerFits);
    record(vp.name, '五列全部渲染且不出屏', m.columnLayout.count === 5 && m.columnLayout.allInView, JSON.stringify(m.columnLayout));
    record(vp.name, '作者 X 入口可见且在屏内', m.xLinkVisible);

    if (vp.mobile) {
      const small = m.tapTargets.filter((t) => t.h > 0 && t.h < 28);
      record(vp.name, '可点击元素高度 ≥ 28px', small.length === 0, small.map((t) => `${t.label}(${t.h}px)`).join(', '));
      record(vp.name, '看板为单列堆叠', m.columnLayout.stacked, `stacked=${m.columnLayout.stacked}`);
    }

    // Open the detail panel and make sure it fits.
    await page.locator('[data-testid="item-card"]').first().click();
    await page.waitForSelector('[data-testid="detail-panel"]', { timeout: 15_000 });
    const detail = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="detail-panel"]');
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), vw: window.innerWidth };
    });
    record(vp.name, '详情面板完整落在视口内', detail.left >= -1 && detail.right <= detail.vw + 1, JSON.stringify(detail));

    await ctx.close();
  }
} catch (err) {
  record('runner', '响应式审计无异常', false, err.message);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log('\n----------------------------------------');
console.log(`${results.length - failed.length}/${results.length} responsive checks passed`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - [${f.vp}] ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  process.exitCode = 1;
}
