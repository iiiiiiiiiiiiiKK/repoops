/**
 * Diagnose what GitHub actually renders for our authorize URL, in a real browser.
 *
 * This distinguishes the realistic failure modes:
 *   - "Application not found"      -> wrong client_id
 *   - redirect_uri mismatch page   -> callback URL registered differently
 *   - GitHub login form            -> everything is fine, the user just was not
 *                                     signed in / the request was blocked locally
 *   - network error / blank page   -> github.com unreachable from this network
 */
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'https://repoops.852367856.dpdns.org';
const browser = await chromium.launch({
  executablePath: 'C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium-1248\\chrome-win64\\chrome.exe',
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();

// Get the authorize URL exactly as the app builds it.
const login = await fetch(BASE + '/api/auth/login', { redirect: 'manual' });
const authorize = login.headers.get('location');
console.log('authorize url:', authorize);

const hops = [];
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('github.com') || u.includes('repoops')) hops.push(`${r.status()} ${u.slice(0, 110)}`);
});

let navError = null;
try {
  await page.goto(authorize, { waitUntil: 'domcontentloaded', timeout: 45000 });
} catch (e) {
  navError = e.message.split('\n')[0];
}

console.log('\n--- navigation ---');
console.log(navError ? `NAV ERROR: ${navError}` : 'ok');
console.log('final url:', page.url());
console.log('title:', await page.title().catch(() => '(none)'));

const info = await page.evaluate(() => {
  const body = document.body?.innerText ?? '';
  return {
    hasPasswordField: Boolean(document.querySelector('input[type=password], input[name=password]')),
    hasLoginField: Boolean(document.querySelector('input[name=login]')),
    bodyText: body.replace(/\s+/g, ' ').slice(0, 600),
  };
});
console.log('\n--- page ---');
console.log('login input:', info.hasLoginField, '| password input:', info.hasPasswordField);
console.log('text:', info.bodyText);

console.log('\n--- hops ---');
for (const h of hops.slice(0, 12)) console.log('  ' + h);

await page.screenshot({ path: 'tests/e2e/screenshots/github-authorize.png' });
await browser.close();
