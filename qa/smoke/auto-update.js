#!/usr/bin/env node
/**
 * auto-update.js — the "a new version is available" prompt.
 *
 *   node qa/smoke/auto-update.js                  # staging (default)
 *   E2E_ADMIN=https://app.drifthr.com \
 *     node qa/smoke/auto-update.js                # prod
 *
 * WHAT IT PROVES
 * --------------
 * Two directions, and the NEGATIVE one matters more:
 *
 *   1. A normally-loaded page must show NO banner. If the id baked into the
 *      served bundle ever disagrees with the id the server reports, every user
 *      gets a permanent un-dismissable "update available" nag. That failure is
 *      worse than the stale-cache problem this feature exists to fix.
 *
 *   2. When the server DOES report a different build, the banner must appear.
 *      Simulated by intercepting /app-version and answering with a foreign id —
 *      which is exactly what a real deploy looks like to an open tab.
 *
 * SAFETY: read-only. Loads pages and intercepts one response in-browser.
 */

'use strict';

const path = require('path');
function resolvePlaywright() {
  for (const c of ['/Users/kp/sitepresso', path.resolve(__dirname, '..', '..')]) {
    try { return require(require.resolve('playwright', { paths: [c] })); } catch { /* next */ }
  }
  throw new Error('Playwright not installed. Run npm i -D playwright, then retry.');
}
const { chromium } = resolvePlaywright();
const { waitForHealthy } = require('./ui-lib');

const ADMIN = process.env.E2E_ADMIN || 'https://app-staging.drifthr.com';
// ESS is served on the TENANT host (demo-staging.drifthr.com), not an "my-" host —
// same convention qa/smoke/ess.js uses.
const ESS = process.env.E2E_ESS || process.env.E2E_TENANT
  || (ADMIN.includes('-staging') ? 'https://demo-staging.drifthr.com' : 'https://demo.drifthr.com');
const PLATFORM = process.env.E2E_PLATFORM
  || (ADMIN.includes('-staging') ? 'https://staging.drifthr.com' : 'https://drifthr.com');

let pass = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  return !!cond;
}
const note = (m) => console.log(`  ..    ${m}`);

const BANNER = 'text=/A new version is available|This page is out of date/i';

(async () => {
  console.log(`\n=== auto-update prompt ===\n`);
  const browser = await chromium.launch();

  try {
    for (const [name, origin] of [['hr-admin', ADMIN], ['ess', ESS], ['platform', PLATFORM]]) {
      console.log(`\n  ── ${name} — ${origin}`);
      const ctx = await browser.newContext();
      const page = await ctx.newPage();

      // ── the endpoint itself ──────────────────────────────────────────────
      let ver;
      try {
        ver = await page.evaluate(async (o) => {
          const r = await fetch(`${o}/app-version`, { cache: 'no-store' });
          return { status: r.status, cc: r.headers.get('cache-control'), body: await r.text() };
        }, origin).catch(() => null);
      } catch { ver = null; }

      if (!ver) {
        // evaluate before any navigation has no origin — go to the page first.
        await page.goto(origin, { waitUntil: 'domcontentloaded' }).catch(() => {});
        ver = await page.evaluate(async () => {
          const r = await fetch('/app-version', { cache: 'no-store' });
          return { status: r.status, cc: r.headers.get('cache-control'), body: await r.text() };
        }).catch(() => null);
      }

      if (!ok(ver && ver.status === 200, `${name}: /app-version answers 200`, ver && `HTTP ${ver.status}`)) {
        await ctx.close(); continue;
      }
      let buildId = null;
      try { buildId = JSON.parse(ver.body).buildId; } catch { /* not json */ }
      ok(!!buildId && buildId !== 'unknown', `${name}: reports a real build id`, String(buildId));
      // A cached answer would report the OLD build forever and the prompt would
      // never fire — the precise bug this feature exists to prevent.
      ok(/no-store/i.test(ver.cc || ''), `${name}: /app-version is uncacheable`, ver.cc);
      note(`build id: ${buildId}`);

      // ── 1. NEGATIVE: a normal load must not nag ──────────────────────────
      await page.goto(origin, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(2500);
      const nagged = await page.locator(BANNER).first().isVisible().catch(() => false);
      ok(!nagged, `${name}: a normally-loaded page shows NO update banner`,
        nagged ? 'false positive — every user would see this' : '');

      // ── 2. POSITIVE: a changed build id must raise the banner ────────────
      const ctx2 = await browser.newContext();
      const page2 = await ctx2.newPage();
      // Answer /app-version as if a deploy had just replaced this app.
      await page2.route('**/app-version', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: JSON.stringify({ buildId: 'a-different-build' }),
      }));
      await page2.goto(origin, { waitUntil: 'networkidle' }).catch(() => {});
      // the component checks on mount; give it room plus a focus nudge
      await page2.waitForTimeout(1500);
      await page2.evaluate(() => window.dispatchEvent(new Event('focus'))).catch(() => {});
      const appeared = await page2.locator(BANNER).first()
        .waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
      ok(appeared, `${name}: banner APPEARS when the server reports a new build`);

      if (appeared) {
        const hasReload = await page2.locator('button:has-text("Reload")').first().isVisible().catch(() => false);
        ok(hasReload, `${name}: the banner offers a Reload action`);
      }
      await ctx2.close();
      await ctx.close();
    }
  } catch (e) {
    console.log(`\nsmoke crashed: ${e.message}\n`);
    failures.push(`crash: ${e.message}`);
  } finally {
    await browser.close();
  }

  console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
  console.log(failures.length ? '=== AUTO-UPDATE SMOKE FAILED ===\n' : '=== AUTO-UPDATE SMOKE PASSED ===\n');
  process.exit(failures.length ? 1 : 0);
})();
