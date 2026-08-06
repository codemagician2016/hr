#!/usr/bin/env node
/**
 * platform.js — Module 20 of the feature sweep (see qa/SWEEP.md).
 *
 *   node qa/smoke/platform.js                    # staging (default)
 *   E2E_PLATFORM=https://drifthr.com \
 *     node qa/smoke/platform.js                  # prod
 *
 * WHAT THIS COVERS
 *   The surface a PROSPECT and a new tenant hit before they are a customer:
 *   the marketing/signup host, the signup form, login, password reset, and the
 *   set-password page an invited employee lands on.
 *
 * WHY THESE SCREENS ARE DIFFERENT
 * -------------------------------
 * Everything else in this sweep runs with a session. These pages are reached with
 * NO session at all, from a cold browser, often from an email link. That is
 * exactly where this product's real failures have happened:
 *
 *   • an invite link pointing at a tenant subdomain that had never been
 *     provisioned — DNS_PROBE_FINISHED_NXDOMAIN for the invited employee,
 *   • a careers link built against the wrong host,
 *   • a set-password page that reported "link not valid".
 *
 * All three were invisible to any authenticated check. So every page here is
 * opened in a CLEAN context — no cookies, no storage, no cached permissions.
 *
 * SAFETY: read-only. It fills nothing in and submits nothing — signing up would
 * create a real tenant, and a password reset would email a real person.
 */

'use strict';

const path = require('path');

function resolvePlaywright() {
  const candidates = ['/Users/kp/sitepresso', path.resolve(__dirname, '..', '..')];
  for (const c of candidates) {
    try { return require(require.resolve('playwright', { paths: [c] })); } catch { /* next */ }
  }
  throw new Error('Playwright not installed. Run npm i -D playwright, then retry.');
}
const { chromium } = resolvePlaywright();

const PLATFORM = process.env.E2E_PLATFORM
  || (/staging/.test(process.env.E2E_ADMIN || '') ? 'https://staging.drifthr.com' : 'https://staging.drifthr.com');

// Public routes on apps/platform. superadmin/admin/billing are deliberately
// excluded: they require a session and belong to their own surface.
// /legal is a layout-only directory — its real pages are the two below. Guessing
// the parent path reported a healthy app as a 404.
// Every PUBLIC page on disk. The four extra legal pages (cookies, dpa, refund,
// sub-processors) are linked from real contracts and were never being checked —
// a 404 on a DPA page is the kind of thing a prospect's legal team finds.
//
// /superadmin, /admin, /billing/checkout, /business and /onboarding need a
// session and are deliberately NOT crawled here: they are an authenticated
// surface with real consequences (billing!), and belong in a session-bearing
// smoke rather than a cold-browser public crawl. They remain UNTESTED — recorded
// in qa/SWEEP.md rather than quietly skipped.
const PUBLIC_ROUTES = [
  '/', '/login', '/signup', '/forgot-password',
  '/legal/terms', '/legal/privacy', '/legal/cookies', '/legal/dpa',
  '/legal/refund', '/legal/sub-processors',
];

const BENIGN = ['tenant/resolve', 'Failed to fetch RSC payload', 'ResizeObserver loop'];
const isBenign = (s) => BENIGN.some((b) => s.includes(b));
const ERROR_TEXT = /something went wrong|unexpected error|application error|cannot read propert|is not a function/i;

let pass = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  return !!cond;
}
const note = (m) => console.log(`  ..    ${m}`);

(async () => {
  console.log(`\n=== platform smoke — ${PLATFORM} ===`);
  console.log('  (no session, cold browser — read-only, submits nothing)\n');

  const browser = await chromium.launch();
  const failuresBefore = failures.length;

  try {
    for (const route of PUBLIC_ROUTES) {
      // A FRESH context per route: no cookies, no storage, nothing cached. This is
      // the only way to see what a stranger arriving from an email link sees.
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const sink = [];
      page.on('pageerror', (e) => { const t = String(e); if (!isBenign(t)) sink.push(`pageerror: ${t.slice(0, 110)}`); });
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (isBenign(t) || t.startsWith('Failed to load resource')) return;
        sink.push(`console: ${t.slice(0, 110)}`);
      });
      page.on('response', (r) => {
        if (r.status() < 500) return;
        if (isBenign(r.url())) return;
        sink.push(`HTTP ${r.status()} ${r.url().replace(PLATFORM, '').slice(0, 80)}`);
      });

      let status = 0;
      let body = '';
      try {
        const resp = await page.goto(`${PLATFORM}${route}`, { waitUntil: 'networkidle', timeout: 30000 });
        status = resp ? resp.status() : 0;
        await page.waitForTimeout(600);
        body = (await page.evaluate(() => document.body.innerText || '')).trim();
      } catch (e) {
        sink.push(`navigation: ${e.message.slice(0, 80)}`);
      }

      const problems = [...new Set(sink)];
      const good = status > 0 && status < 400 && body.length > 30 && !problems.length && !ERROR_TEXT.test(body);
      const why = [];
      if (!(status > 0 && status < 400)) why.push(`HTTP ${status}`);
      if (body.length <= 30) why.push(`blank (${body.length} chars)`);
      if (ERROR_TEXT.test(body)) why.push('shows an error state');
      if (problems.length) why.push(problems.slice(0, 2).join(' | '));
      ok(good, `public ${route}`, why.join(' · '));

      // The two forms a stranger must be able to USE. A signup or login page that
      // renders but has no usable field is the "Create job invisible" failure on
      // the most valuable page in the product.
      if (route === '/signup' || route === '/login') {
        const emails = await page.locator('input[type="email"]').count().catch(() => 0);
        const pwds = await page.locator('input[type="password"]').count().catch(() => 0);
        const submits = await page.locator('button[type="submit"], button:has-text("Sign")').count().catch(() => 0);
        ok(emails > 0 && submits > 0, `${route} form has an email field and a submit control`,
          `${emails} email, ${pwds} password, ${submits} submit`);
      }

      await ctx.close();
    }

    // ── the set-password page an invited employee lands on ─────────────────
    // Reached from an email, with no session, and with a token this smoke does not
    // have. The page must still LOAD and ask for a password rather than crashing
    // or showing a raw error — "link not valid" on a blank page is what a real
    // invited employee reported.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let st = 0;
    let text = '';
    try {
      const r = await page.goto(`${PLATFORM}/set-password?token=smoke-not-a-real-token`, { waitUntil: 'networkidle', timeout: 30000 });
      st = r ? r.status() : 0;
      await page.waitForTimeout(800);
      text = (await page.evaluate(() => document.body.innerText || '')).trim();
    } catch (e) {
      text = `navigation failed: ${e.message}`;
    }
    ok(st > 0 && st < 400, 'set-password page loads with no session', `HTTP ${st}`);
    // An invalid token SHOULD be refused — but as a readable message on a rendered
    // page, not a crash or a blank screen.
    ok(text.length > 30, 'set-password renders a readable page for a bad token',
      text.slice(0, 120).replace(/\s+/g, ' '));
    await ctx.close();
  } catch (e) {
    console.log(`\nsmoke crashed: ${e.message}\n`);
    failures.push(`crash: ${e.message}`);
  } finally {
    await browser.close();
  }

  console.log(`\n  ${pass} passed, ${failures.length - failuresBefore} failed\n`);
  console.log(failures.length ? '=== PLATFORM SMOKE FAILED ===\n' : '=== PLATFORM SMOKE PASSED ===\n');
  process.exit(failures.length ? 1 : 0);
})();
