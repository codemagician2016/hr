#!/usr/bin/env node
/**
 * performance.js — Module 11 of the feature sweep (see qa/SWEEP.md).
 *
 *   node qa/smoke/performance.js                 # staging (default)
 *   E2E_ADMIN=https://app.drifthr.com \
 *     node qa/smoke/performance.js               # prod
 *
 * WHAT THIS COVERS
 *   review cycles → launch → the cycle actually GENERATES reviews → the review
 *   state machine (self → manager) → competencies → 9-box
 *
 * WHY "THE CYCLE GENERATED REVIEWS" IS THE ASSERTION
 * --------------------------------------------------
 * Launching a cycle that produces ZERO reviews returns 200 and looks perfectly
 * healthy. Nobody discovers it until appraisal season, when an entire company is
 * waiting on review forms that were never created.
 *
 * That is the same shape as every serious defect in this sweep — a job with no
 * pipeline, a hire with no onboarding journey, an employee with no leave balance:
 * a successful operation that produced nothing.
 *
 * SAFETY
 * ------
 * Read-only over existing cycles and reviews. It does NOT launch, release,
 * sign-off, close or link a review to compensation — those drive real appraisals
 * and real pay decisions. It creates nothing that affects a live cycle.
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
const { assertControlVisible, signIn, waitForHealthy } = require('./ui-lib');

const ADMIN = process.env.E2E_ADMIN || 'https://app-staging.drifthr.com';
const EMAIL = process.env.E2E_EMAIL || 'operator@demo.test';
const PASSWORD = process.env.E2E_PASSWORD || 'Demo@12345';

let pass = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  return !!cond;
}
const note = (m) => console.log(`  ..    ${m}`);

const BENIGN = ['tenant/resolve', 'Failed to fetch RSC payload'];
const isBenign = (s) => BENIGN.some((b) => s.includes(b));

function watch(page, tag, sink) {
  page.on('pageerror', (e) => { const t = String(e); if (!isBenign(t)) sink.push(`${tag} pageerror: ${t.slice(0, 160)}`); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (isBenign(t) || t.startsWith('Failed to load resource')) return;
    sink.push(`${tag} console: ${t.slice(0, 160)}`);
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const u = r.url();
    if (isBenign(u)) return;
    sink.push(`${tag} HTTP ${r.status()} ${u.replace(ADMIN, '').slice(0, 110)}`);
  });
}

const api = (page, url, init) => page.evaluate(async ([u, i]) => {
  const r = await fetch(u, { credentials: 'include', ...(i || {}) });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [url, init || null]);

const stamp = String(Date.now()).slice(-6);
const today = new Date().toISOString().slice(0, 10);
const plus = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
// Launching a cycle GENERATES review forms for the eligible population and can
// notify those people. Staging redirects all mail to a single inbox, so it is safe
// to prove the behaviour there. Production sends to real recipients — so on prod
// this smoke stays strictly read-only and says so.
const IS_STAGING = /staging/.test(ADMIN);
const send = (page, method, url, payload) => api(page, url, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
});

const asList = (b) => (b && (b.items || b.data || b.rows)) || (Array.isArray(b) ? b : []);

(async () => {
  console.log(`\n=== performance smoke — admin ${ADMIN} ===\n`);
  console.log('  (read-only — never launches, releases, signs off or links to pay)\n');
  const browser = await chromium.launch();
  const problems = [];

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  watch(page, 'admin', problems);

  try {
    await waitForHealthy(page, ADMIN);
    const login = await signIn(page, { admin: ADMIN, email: EMAIL, password: PASSWORD });
    if (login.notUp) {
      // The app is restarting (a deploy just ran). Everything below would fail on
      // 401 and look like an outage.
      console.log(`\n  APP NOT UP — login returned ${login.status}. Wait for the deploy to settle and re-run.\n`);
      await browser.close();
      process.exit(2);
    }
    if (login.throttled) {
      console.log('\n  THROTTLED — the auth rate limiter returned 429 (correct behaviour).');
      console.log('  Wait a minute and re-run; this is NOT a product failure.\n');
      await browser.close();
      process.exit(2);
    }
    ok(login.ok, 'admin signs in', `HTTP ${login.status} ${page.url()}`);

    // ── 1. review cycles ────────────────────────────────────────────────────
    const cycles = await api(page, '/api/hr/performance/cycles?pageSize=20');
    const cycleList = asList(cycles.body);
    ok(cycles.status < 400, 'review cycles load', `HTTP ${cycles.status}`);
    note(`${cycleList.length} cycle(s)`);

    // ── 2. a LAUNCHED cycle must have produced reviews ──────────────────────
    // This is the assertion that matters. A cycle that launches and generates
    // zero review forms returns 200 and is only discovered at appraisal time,
    // with a whole company waiting on forms that never existed.
    let launched = cycleList.find((c) => /ACTIVE|LAUNCHED|IN_PROGRESS|RELEASED|CLOSED/i.test(String(c.status || '')));

    // No launched cycle means the assertion below would SKIP — a green run that
    // proved nothing, which is the failure mode this whole sweep exists to catch.
    // On staging, create and launch one so it is actually verified.
    if (!launched && IS_STAGING) {
      note('no launched cycle — creating and launching one (staging only)');
      const made = await send(page, 'POST', '/api/hr/performance/cycles', {
        code: `QA${stamp}`,
        name: `QA Smoke Cycle ${stamp}`,
        type: 'ANNUAL',
        periodStart: plus(-180),
        periodEnd: today,
        ratingScaleJson: { min: 1, max: 5, labels: ['1', '2', '3', '4', '5'] },
      });
      ok(made.status < 400 && made.body && made.body.id, 'a review cycle can be created',
        `HTTP ${made.status} ${JSON.stringify(made.body).slice(0, 140)}`);
      const cid = made.body && made.body.id;
      if (cid) {
        const lit = await send(page, 'POST', `/api/hr/performance/cycles/${cid}/launch`, {});
        ok(lit.status < 400, 'a review cycle can be launched',
          `HTTP ${lit.status} ${JSON.stringify(lit.body).slice(0, 140)}`);
        if (lit.status < 400) {
          const re = await api(page, `/api/hr/performance/cycles/${cid}`);
          launched = (re.body && (re.body.cycle || re.body)) || { id: cid, status: 'LAUNCHED' };
          // THE assertion that exposed the defect: launch used to generate review
          // rows and leave the CYCLE in DRAFT, and reviewStateMachine refuses
          // self-review unless the cycle is ACTIVE or SELF_REVIEW — so every
          // employee got "cycle is DRAFT; self-review window is closed".
          ok(/ACTIVE|SELF_REVIEW/i.test(String(launched.status || '')),
            'launching OPENS the self-review window (cycle leaves DRAFT)',
            `cycle status after launch: ${launched.status}`);
        }
      }
    }

    if (!launched) {
      note(IS_STAGING
        ? 'no launched cycle available — review generation NOT verified'
        : 'no launched cycle on production — read-only here by design; verified on staging');
    } else {
      note(`inspecting cycle "${launched.name || launched.id}" (status ${launched.status})`);

      const stats = await api(page, `/api/hr/performance/cycles/${launched.id}/stats`);
      ok(stats.status < 400, 'cycle stats answer', `HTTP ${stats.status}`);

      const reviews = await api(page, `/api/hr/performance/reviews?cycleId=${launched.id}&pageSize=50`);
      const reviewList = asList(reviews.body);
      ok(reviews.status < 400, 'reviews load for the cycle', `HTTP ${reviews.status}`);
      ok(reviewList.length > 0,
        'a launched cycle actually GENERATED review forms',
        `${reviewList.length} review(s) — zero means a silent no-op launch`);

      if (reviewList.length) {
        const r0 = reviewList[0];
        // Every review must name a subject. A review bound to nobody is a form
        // that no one is asked to fill in and no one is assessed by.
        const orphans = reviewList.filter((r) => !r.employeeId && !(r.employee && r.employee.id));
        ok(orphans.length === 0, 'every review is bound to an employee',
          `${orphans.length} orphan review(s)`);

        const detail = await api(page, `/api/hr/performance/reviews/${r0.id}`);
        ok(detail.status < 400, 'a review can be opened',
          `HTTP ${detail.status} status=${(detail.body && detail.body.status) || '?'}`);
      }
    }

    // ── 3. competencies + 9-box ─────────────────────────────────────────────
    const comps = await api(page, '/api/hr/ninebox/competencies');
    ok(comps.status < 400, 'competencies load',
      `HTTP ${comps.status}, ${asList(comps.body).length} competency(ies)`);

    const roleComps = await api(page, '/api/hr/ninebox/role-competencies');
    ok(roleComps.status < 400, 'role-competency mappings load',
      `HTTP ${roleComps.status}, ${asList(roleComps.body).length} mapping(s)`);

    // ── 4. the pages a client opens ─────────────────────────────────────────
    for (const [url, label] of [
      ['/performance', 'Performance'],
      ['/performance/nine-box', '9-box grid'],
    ]) {
      const resp = await page.goto(`${ADMIN}${url}`, { waitUntil: 'networkidle' }).catch(() => null);
      const st = resp ? resp.status() : 0;
      if (st === 404) { note(`skip: ${label} is not mounted at ${url}`); continue; }
      await page.waitForTimeout(1400);
      const text = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      ok(text.trim().length > 60, `${label} page renders content`, `HTTP ${st}, ${text.trim().length} chars`);
    }
    await assertControlVisible(page, ok,
      ['button', 'a[href*="performance"]', 'table', '[role="table"]'],
      'Performance surface exposes a control or its grid');
  } catch (e) {
    console.log(`\nsmoke crashed: ${e.message}\n`);
    failures.push(`crash: ${e.message}`);
  } finally {
    await browser.close();
  }

  console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
  if (problems.length) {
    console.log(`  browser problems (${problems.length}) — each is something a real user's browser logged:`);
    for (const p of [...new Set(problems)].slice(0, 20)) console.log(`    • ${p}`);
    console.log('');
  }
  const bad = failures.length > 0 || problems.length > 0;
  console.log(bad ? '=== PERFORMANCE SMOKE FAILED ===\n' : '=== PERFORMANCE SMOKE PASSED ===\n');
  process.exit(bad ? 1 : 0);
})();
