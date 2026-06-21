#!/usr/bin/env node
//
// Browser-level smoke test. Loads a small set of staging URLs in headless
// Chromium and asserts no console errors / no uncaught page exceptions.
// Catches the bug class that the curl-based smoke test cannot:
// render-time React crashes (destructure-on-undefined, missing optional
// chain, hydration mismatch, etc.) — the same class that produced the
// 2026-04-29 dashboard outage.
//
// The pre-commit hook's ESLint rule covers the simplest sub-class
// (undefined JSX components). This script catches everything that
// actually requires a browser.
//
// Usage:
//   npm run smoke:browser
//   npm run smoke:browser -- --local
//   npm run smoke:browser -- --base=https://aapkatech.com
//   npm run smoke:browser -- --local --only=platform,web
//
// Default mode keeps the historical staging tenant smoke. `--local`
// switches to the seeded local vertical tenants behind the host-aware router.
//
// Designed to be runnable on demand, not on every commit (Playwright
// downloads ~200 MB of browser binaries the first time). Add to CI later
// once the deploy gate moves off cron.

/* eslint-disable no-console */

const path = require('path');
const repoRoot = path.resolve(__dirname, '..');

function resolvePlaywright() {
  const candidates = [
    repoRoot,
    path.join(repoRoot, 'business'),
    path.join(repoRoot, 'apps', 'booking'),
  ];
  for (const candidate of candidates) {
    try {
      return require.resolve('playwright', { paths: [candidate] });
    } catch {
      // Try the next install location.
    }
  }
  throw new Error('Playwright is not installed. Run npm install, then retry smoke:browser.');
}

const playwrightPath = resolvePlaywright();
const { chromium } = require(playwrightPath);

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const LOCAL_MODE = Boolean(args.local);
const BASE = args.base || process.env.BROWSER_SMOKE_BASE || (LOCAL_MODE ? 'http://localhost:3099' : 'https://aapkatech.com');
const DEFAULT_TENANT = args.tenant || process.env.BROWSER_SMOKE_TENANT || 'https://shreya.aapkatech.com';
const TIMEOUT_MS = Number(args.timeout || process.env.BROWSER_SMOKE_TIMEOUT_MS || 12000);
const HYDRATE_WAIT_MS = Number(args.wait || process.env.BROWSER_SMOKE_WAIT_MS || 1500);
const ONLY = new Set(
  String(args.only || process.env.BROWSER_SMOKE_ONLY || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function withPath(origin, pathname = '/') {
  const url = new URL(origin);
  url.pathname = pathname;
  return url.toString();
}

function localTenant(slug) {
  const url = new URL(BASE);
  const port = url.port ? `:${url.port}` : '';
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
    return `${url.protocol}//${slug}.localhost${port}`;
  }
  return `${url.protocol}//${slug}.${url.host}`;
}

const BOOKING = args.booking || process.env.BROWSER_SMOKE_BOOKING || (LOCAL_MODE ? localTenant('legal-demo') : DEFAULT_TENANT);
const SHOP = args.shop || process.env.BROWSER_SMOKE_SHOP || (LOCAL_MODE ? localTenant('grocery-demo') : localTenant('ecom'));
const WEB = args.web || process.env.BROWSER_SMOKE_WEB || (LOCAL_MODE ? localTenant('corp-demo') : localTenant('corp-demo'));

function historicalPages() {
  const tenant = trimSlash(DEFAULT_TENANT);
  return [
    { group: 'platform', name: 'Platform marketing home', url: withPath(BASE, '/') },
    { group: 'platform', name: 'Platform login (apex)', url: withPath(BASE, '/login') },
    { group: 'tenant', name: 'Tenant storefront', url: withPath(tenant, '/') },
    { group: 'tenant', name: 'Tenant /book', url: withPath(tenant, '/book') },
    { group: 'tenant', name: 'Tenant /blog', url: withPath(tenant, '/blog') },
    {
      group: 'tenant',
      name: 'Tenant /blog/<unknown>',
      url: withPath(tenant, '/blog/__smoke_unknown__'),
      allowMain4xx: true,
    },
    { group: 'tenant', name: 'Tenant /shop', url: withPath(tenant, '/shop') },
  ];
}

function verticalPages() {
  return [
    { group: 'platform', name: 'Platform marketing home', url: withPath(BASE, '/') },
    { group: 'platform', name: 'Platform login', url: withPath(BASE, '/login') },
    { group: 'booking', name: 'Booking storefront', url: withPath(BOOKING, '/') },
    { group: 'booking', name: 'Booking flow', url: withPath(BOOKING, '/book') },
    { group: 'shop', name: 'Shop storefront', url: withPath(SHOP, '/shop') },
    { group: 'web', name: 'Static website storefront', url: withPath(WEB, '/') },
  ];
}

const requestedVerticalMode = LOCAL_MODE || args.booking || args.shop || args.web;
const PAGES = (requestedVerticalMode ? verticalPages() : historicalPages())
  .filter((page) => ONLY.size === 0 || ONLY.has(page.group));

const BODY_ERROR_PATTERNS = [
  /500 Internal Server Error/i,
  /Server Error/i,
  /Application error/i,
  /Unhandled Runtime Error/i,
  /Cannot find module/i,
  /Business not found/i,
];

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    if (!/Executable doesn't exist|browserType\.launch/i.test(err.message || '')) throw err;
    console.log('  Bundled Chromium missing; retrying with installed Chrome channel.');
    return chromium.launch({ headless: true, channel: 'chrome' });
  }
}

async function checkPage(browser, pageSpec) {
  const { name, url, allowMain4xx } = pageSpec;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  const consoleErrors = [];

  // Real JS exceptions surface as 'pageerror' — that's the bug class
  // we care about (the dashboard outage, hydration crashes, etc.).
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  // Console.error is noisier — anything fetch() returns non-2xx surfaces
  // here as "Failed to load resource". Public pages routinely 401 from
  // the customer-session probe and 404 from "post not found" lookups
  // — both are EXPECTED behaviour, not regressions. Skip:
  //   • "Failed to load resource: ... 4xx" — expected from unauth probes
  //   • Third-party noise (fonts CDN, Sentry DSN missing, favicon)
  // Anything else (a real Error("Cannot read 'foo' of undefined")) gets
  // counted as a failure.
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/Failed to load resource:.*status of 4\d\d/i.test(text)) return;
    if (/(?:fonts\.googleapis|sentry|favicon\.ico)/i.test(text)) return;
    consoleErrors.push(text);
  });

  let status;
  try {
    // `domcontentloaded` is enough — `networkidle` hangs on pages that
    // keep open WebSockets / long-poll connections (the admin shell
    // does this). 12s timeout is generous for staging.
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    status = res?.status() ?? 'no response';
    if (typeof status === 'number' && (status >= 500 || (!allowMain4xx && status >= 400))) {
      errors.push(`http status ${status}`);
    }
    // Give React effects a beat to fire (data fetching, hydration).
    // 1500 ms catches the typical "first useEffect → API call →
    // setState → re-render" cycle for our pages.
    await page.waitForTimeout(HYDRATE_WAIT_MS);
    const bodyText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
    const visibleError = BODY_ERROR_PATTERNS.find((pattern) => pattern.test(bodyText));
    if (visibleError) errors.push(`visible error text matched ${visibleError}`);
  } catch (e) {
    errors.push(`navigation: ${e.message}`);
  }

  await ctx.close();

  const ok = errors.length === 0 && consoleErrors.length === 0;
  return { name, url, status, ok, errors, consoleErrors };
}

async function main() {
  console.log(`▸ Browser smoke against:`);
  console.log(`  platform: ${BASE}`);
  if (requestedVerticalMode) {
    console.log(`  booking:  ${BOOKING}`);
    console.log(`  shop:     ${SHOP}`);
    console.log(`  web:      ${WEB}`);
  } else {
    console.log(`  tenant:   ${DEFAULT_TENANT}`);
  }
  if (ONLY.size > 0) console.log(`  only:     ${Array.from(ONLY).join(', ')}`);
  console.log();

  if (PAGES.length === 0) {
    throw new Error('No browser smoke pages selected.');
  }

  const browser = await launchBrowser();
  const results = [];
  for (const pageSpec of PAGES) {
    process.stdout.write(`  • ${pageSpec.name.padEnd(28)} `);
    const result = await checkPage(browser, pageSpec);
    results.push(result);
    if (result.ok) {
      console.log(`✓ HTTP ${result.status}`);
    } else {
      console.log(`✗ HTTP ${result.status}`);
      for (const e of result.errors) console.log(`      err:  ${e}`);
      for (const e of result.consoleErrors) console.log(`      console: ${e}`);
    }
  }
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log();
  if (failed.length === 0) {
    console.log(`✓ All ${results.length} pages mounted cleanly with no JS errors.`);
    process.exit(0);
  } else {
    console.log(`✗ ${failed.length} of ${results.length} pages had errors.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
