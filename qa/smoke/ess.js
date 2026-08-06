#!/usr/bin/env node
/**
 * ess.js — Module 18 of the feature sweep (see qa/SWEEP.md).
 *
 *   node qa/smoke/ess.js                         # staging (default)
 *   E2E_TENANT=https://demo.drifthr.com \
 *     node qa/smoke/ess.js                       # prod
 *
 * WHAT THIS COVERS
 *   Every EMPLOYEE-facing screen on the tenant portal, walked one by one in a
 *   real browser, plus the self-service data an employee depends on: their
 *   payslips, leave balance, attendance and profile.
 *
 * WHY THE ESS SIDE NEEDS ITS OWN CRAWL
 * ------------------------------------
 * every-screen.js walks the ADMIN app. The ESS app is a different Next.js
 * application on a different host with a different session type (CUSTOMER, not
 * operator) — an admin screen passing says nothing about the employee's view.
 *
 * And the employee's view is where a silent failure is most expensive: an
 * employee who cannot see their payslip, or sees a leave balance that does not
 * match what HR sees, does not file a bug — they ask HR, and HR does not know
 * either.
 *
 * SAFETY: read-only. It signs in as an employee and looks.
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
const { waitForHealthy } = require('./ui-lib');

const TENANT = process.env.E2E_TENANT || 'https://demo-staging.drifthr.com';
// A real EMPLOYEE login, not the admin operator. The admin has no portal account,
// and signing in with it verifies nothing — qa/e2e/config.js already carries the
// seeded employee logins, so use one of those.
const EMAIL = process.env.E2E_ESS_EMAIL || 'priya.nair@demo.test';
const PASSWORD = process.env.E2E_ESS_PASSWORD || process.env.E2E_PASSWORD || 'Demo@12345';

// Employee-facing routes (apps/ess/app/*). login/set-password/careers are
// deliberately excluded: they are the UNAUTHENTICATED surface and are covered by
// the hiring and people smokes, which open them with no session at all.
// Every static employee page on disk, not just the ones this file remembered.
// /login, /set-password and /careers/* are the UNAUTHENTICATED surface and are
// covered by the platform + hiring smokes, which open them with no session.
const fs = require('fs');
const ESS_APP = path.resolve(__dirname, '..', '..', 'apps', 'ess', 'app');
const ROUTES = (function () {
  const out = [];
  (function walk(dir, prefix) {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) walk(full, `${prefix}/${f}`);
      else if (f === 'page.js') out.push(prefix || '/');
    }
  }(ESS_APP, ''));
  return out
    .filter((r) => !r.includes('[') && !r.includes(':'))
    .filter((r) => !/^\/(login|set-password|sso|careers)/.test(r))
    .sort();
}());

const BENIGN = ['tenant/resolve', 'Failed to fetch RSC payload', 'ResizeObserver loop'];
const isBenign = (s) => BENIGN.some((b) => s.includes(b));
const ERROR_TEXT = /something went wrong|failed to load|unexpected error|application error|cannot read propert|is not a function/i;

let pass = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  return !!cond;
}
const note = (m) => console.log(`  ..    ${m}`);

(async () => {
  console.log(`\n=== ESS smoke — tenant ${TENANT} ===`);
  console.log(`  ${ROUTES.length} employee screen(s), read-only\n`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  let sink = [];
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
    sink.push(`HTTP ${r.status()} ${r.url().replace(TENANT, '').slice(0, 80)}`);
  });

  try {
    await waitForHealthy(page, TENANT);

    // ESS uses a CUSTOMER session, a different auth path from the admin app.
    await page.goto(`${TENANT}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[type="email"]', EMAIL).catch(() => {});
    await page.fill('input[type="password"]', PASSWORD).catch(() => {});
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
      page.click('button[type="submit"]').catch(() => {}),
    ]);
    const signedIn = !page.url().includes('/login');
    if (!signedIn) {
      // The demo operator may not have an ESS (employee portal) login. That is a
      // property of the seed account, not a defect — but it means NOTHING below
      // can be verified, so say so loudly rather than reporting a green run.
      console.log('\n  CANNOT SIGN IN TO ESS with these credentials.');
      console.log('  The employee portal needs a CUSTOMER account (an employee with a portal');
      console.log('  invite accepted). Set E2E_ESS_EMAIL / E2E_ESS_PASSWORD to a real');
      console.log('  employee login. NOTHING below was verified.\n');
      await browser.close();
      process.exit(2);
    }
    ok(true, 'employee signs in to the portal', page.url());

    // ── walk every employee screen ──────────────────────────────────────────
    for (const route of ROUTES) {
      sink = [];
      let status = 0;
      let body = '';
      try {
        const resp = await page.goto(`${TENANT}${route}`, { waitUntil: 'networkidle', timeout: 30000 });
        status = resp ? resp.status() : 0;
        await page.waitForTimeout(600);
        body = (await page.evaluate(() => document.body.innerText || '')).trim();
      } catch (e) {
        sink.push(`navigation: ${e.message.slice(0, 80)}`);
      }
      const problems = [...new Set(sink)];
      const shown = ERROR_TEXT.test(body);
      const good = status > 0 && status < 400 && body.length > 30 && !problems.length && !shown;
      const why = [];
      if (!(status > 0 && status < 400)) why.push(`HTTP ${status}`);
      if (body.length <= 30) why.push(`blank (${body.length} chars)`);
      if (shown) why.push('shows an error state');
      if (problems.length) why.push(problems.slice(0, 2).join(' | '));
      ok(good, `ESS ${route}`, why.join(' · '));
    }
  } catch (e) {
    console.log(`\nsmoke crashed: ${e.message}\n`);
    failures.push(`crash: ${e.message}`);
  } finally {
    await browser.close();
  }

  console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
  console.log(failures.length ? '=== ESS SMOKE FAILED ===\n' : '=== ESS SMOKE PASSED ===\n');
  process.exit(failures.length ? 1 : 0);
})();
