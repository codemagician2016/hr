#!/usr/bin/env node
/**
 * every-screen.js — walk EVERY admin screen in a real browser, one by one.
 *
 *   node qa/smoke/every-screen.js                # staging (default)
 *   E2E_ADMIN=https://app.drifthr.com \
 *     node qa/smoke/every-screen.js              # prod
 *
 * WHY THIS EXISTS
 * ───────────────────────────────────────────────────────────────────────────
 * The module smokes each drive one JOURNEY and touch only the handful of screens
 * that journey needs. Between them they cover maybe fifteen pages out of seventy-
 * two. A screen nobody's journey happens to visit can be completely broken —
 * blank, throwing on mount, 404 behind a nav link that is right there in the
 * sidebar — and every module smoke stays green.
 *
 * That is not hypothetical. Every UI-level defect reported by a real person on
 * this product was of exactly that kind: a button that renders but is invisible,
 * a field that discards keystrokes, a nav link to a page that does not exist.
 * None of them break an API call.
 *
 * So this crawls all 72 routes from the admin nav and, for each, asserts:
 *
 *   • the route ANSWERS (not 404/5xx — a nav link to nowhere is a dead end)
 *   • it renders REAL content, not a blank shell
 *   • the browser logged no pageerror / console error while it mounted
 *   • the page is not showing an error state to the user ("something went
 *     wrong", "failed to load", a raw stack)
 *
 * It deliberately does NOT assert business outcomes — that is each module
 * smoke's job. This answers the narrower question those cannot: does every screen
 * a client can click to actually work?
 *
 * SAFETY: read-only. It navigates and looks. It clicks nothing.
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
const { signIn, waitForHealthy } = require('./ui-lib');

const ADMIN = process.env.E2E_ADMIN || 'https://app-staging.drifthr.com';
const EMAIL = process.env.E2E_EMAIL || 'operator@demo.test';
const PASSWORD = process.env.E2E_PASSWORD || 'Demo@12345';
const ONLY = process.env.E2E_ONLY || ''; // substring filter, for re-testing one screen

// Routes are READ FROM THE APP'S OWN NAV at runtime, never transcribed. The first
// version of this file hand-copied them and got five wrong — /tax/declaration
// instead of /tax/declaration-window, /profile-changes instead of
// /profile/change-requests, and so on — which reported five healthy screens as
// 404s. A crawler whose route list can drift from the nav is worse than none: it
// manufactures failures and hides real ones behind them.
//
// Reading nav.js also means a NEW nav entry is covered the moment it is added,
// with nothing to remember.
const fs = require('fs');
const NAV_FILE = path.resolve(__dirname, '..', '..', 'apps', 'hr-admin', 'lib', 'nav.js');

function loadRoutes() {
  const src = fs.readFileSync(NAV_FILE, 'utf8');
  const found = [...src.matchAll(/href:\s*'(\/[^']*)'/g)].map((m) => m[1]);
  // Drop dynamic segments — they need a real id and belong to the module smokes.
  // Nav is the SPINE, but it is not the whole app: 18 admin routes exist on disk
  // that no nav entry points at — /org/chart, /org/registrations,
  // /learning/compliance, /people/new and others. A screen with no nav link is
  // still reachable (deep link, redirect, a button elsewhere) and is MORE likely
  // to rot precisely because nobody clicks past it.
  //
  // So: take every static page.js on disk, not just the linked ones. Dynamic
  // segments are excluded — they need a real id and belong to the module smokes,
  // which drive them with records they created.
  const fromNav = [...new Set(found)].filter((r) => !r.includes('[') && !r.includes(':'));
  const appDir = path.resolve(__dirname, '..', '..', 'apps', 'hr-admin', 'app');
  const onDisk = [];
  (function walk(dir, prefix) {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) walk(full, `${prefix}/${f}`);
      else if (f === 'page.js') onDisk.push(prefix || '/');
    }
  }(appDir, ''));
  const routes = [...new Set([...fromNav, ...onDisk])]
    .filter((r) => !r.includes('[') && !r.includes(':'))
    // /login is the unauthenticated surface; the platform smoke owns it.
    .filter((r) => r !== '/login');
  routes.sort();
  return routes;
}

// Noise that is not a defect (same list the module smokes use, plus Next.js
// prefetch races which say in their own message that they fall back).
const BENIGN = [
  'tenant/resolve',
  'Failed to fetch RSC payload',
  'ResizeObserver loop',
  'Download the React DevTools',
];
const isBenign = (s) => BENIGN.some((b) => s.includes(b));

// Phrases a user would read as "this page is broken".
const ERROR_TEXT = /something went wrong|failed to load|unexpected error|application error|500 internal|cannot read propert|is not a function|unhandled/i;

let pass = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass += 1; }
  else { failures.push({ label, detail }); }
  return !!cond;
}

(async () => {
  const all = loadRoutes();
  const routes = ONLY ? all.filter((r) => r.includes(ONLY)) : all;
  console.log(`\n=== every-screen crawl — ${ADMIN} ===`);
  console.log(`  ${routes.length} screen(s), read-only\n`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();

  // Per-route sinks, reset before each navigation so a fault is attributed to the
  // screen that produced it rather than smearing across the whole crawl.
  let sink = [];
  page.on('pageerror', (e) => { const t = String(e); if (!isBenign(t)) sink.push(`pageerror: ${t.slice(0, 120)}`); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (isBenign(t) || t.startsWith('Failed to load resource')) return;
    sink.push(`console: ${t.slice(0, 120)}`);
  });
  page.on('response', (r) => {
    if (r.status() < 500) return;               // 4xx is often a legitimate empty state
    if (isBenign(r.url())) return;
    sink.push(`HTTP ${r.status()} ${r.url().replace(ADMIN, '').slice(0, 90)}`);
  });

  try {
    await waitForHealthy(page, ADMIN);
    const login = await signIn(page, { admin: ADMIN, email: EMAIL, password: PASSWORD });
    if (login.notUp) {
      console.log(`\n  APP NOT UP — login returned ${login.status}. Wait for the deploy to settle.\n`);
      await browser.close(); process.exit(2);
    }
    if (login.throttled) {
      console.log('\n  THROTTLED — auth rate limiter returned 429 (correct behaviour). Re-run shortly.\n');
      await browser.close(); process.exit(2);
    }
    if (!login.ok) { console.log('  could not sign in — aborting\n'); await browser.close(); process.exit(1); }

    for (const route of routes) {
      sink = [];
      let status = 0;
      let text = '';
      try {
        const resp = await page.goto(`${ADMIN}${route}`, { waitUntil: 'networkidle', timeout: 30000 });
        status = resp ? resp.status() : 0;
        await page.waitForTimeout(700); // let client-side mount settle
        text = await page.evaluate(() => document.body.innerText || '');
      } catch (e) {
        sink.push(`navigation: ${e.message.slice(0, 90)}`);
      }

      const problems = [...new Set(sink)];
      const body = text.trim();
      const shownError = ERROR_TEXT.test(body);

      const routeOk = status > 0 && status < 400;
      const hasContent = body.length > 40;
      const clean = problems.length === 0;
      const good = routeOk && hasContent && clean && !shownError;

      if (good) {
        pass += 1;
        console.log(`  PASS  ${route.padEnd(34)} ${status} · ${body.length} chars`);
      } else {
        const why = [];
        if (!routeOk) why.push(`HTTP ${status}`);
        if (!hasContent) why.push(`blank (${body.length} chars)`);
        if (shownError) why.push(`error text: "${(body.match(ERROR_TEXT) || [''])[0]}"`);
        if (problems.length) why.push(problems.slice(0, 2).join(' | '));
        failures.push({ label: route, detail: why.join(' · ') });
        console.log(`  FAIL  ${route.padEnd(34)} ${why.join(' · ')}`);
      }
    }
  } catch (e) {
    console.log(`\ncrawl crashed: ${e.message}\n`);
    failures.push({ label: 'crawl', detail: e.message });
  } finally {
    await browser.close();
  }

  console.log(`\n  ${pass} screen(s) clean, ${failures.length} with problems\n`);
  if (failures.length) {
    console.log('  screens needing attention:');
    for (const f of failures) console.log(`    • ${f.label} — ${f.detail}`);
    console.log('');
  }
  console.log(failures.length ? '=== EVERY-SCREEN CRAWL FAILED ===\n' : '=== EVERY-SCREEN CRAWL PASSED ===\n');
  process.exit(failures.length ? 1 : 0);
})();
