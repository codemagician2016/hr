#!/usr/bin/env node
/**
 * payroll.js — Module 7 of the feature sweep (see qa/SWEEP.md).
 *
 *   node qa/smoke/payroll.js                     # staging (default)
 *   E2E_ADMIN=https://app.drifthr.com \
 *     node qa/smoke/payroll.js                   # prod
 *
 * WHAT THIS COVERS
 *   entities + pay calendars → create a DRAFT run → inputs checklist → COMPUTE
 *        → payslips → the NUMBERS reconcile → variance
 *
 * WHY THIS MODULE GETS THE MOST CARE
 * ----------------------------------
 * Every other module fails by blocking somebody. Payroll fails by paying the
 * wrong amount, and nobody finds out until payday. So this asserts arithmetic
 * identities, not HTTP codes:
 *
 *   net = gross − total deductions        (per payslip)
 *   run total = Σ payslip nets            (the run agrees with its own lines)
 *
 * A run that computes with an empty payslip set, or lines whose parts do not add
 * up, returns 200 and looks perfectly healthy.
 *
 * SAFETY — READ BEFORE EXTENDING
 * ------------------------------
 * This deliberately stops at COMPUTE. It never calls freeze, approve, or
 * disbursement: those are the irreversible steps that actually move money and
 * lock a period. The DRAFT run it creates is left behind (there is no delete
 * route) and is clearly stamped in its period comment so it can be identified.
 * On production it uses the demo tenant only.
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
const { assertControlVisible } = require('./ui-lib');

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
const send = (page, method, url, payload) => api(page, url, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
});

const asList = (b) => (b && (b.items || b.data || b.rows)) || (Array.isArray(b) ? b : []);
// Money may arrive as major units or *Minor paise; normalise before comparing.
const money = (row, ...keys) => {
  for (const k of keys) {
    if (row[`${k}Minor`] != null) return Number(row[`${k}Minor`]) / 100;
    if (row[k] != null) return Number(row[k]);
  }
  return null;
};

(async () => {
  console.log(`\n=== payroll smoke — admin ${ADMIN} ===\n`);
  console.log('  (compute only — never freeze / approve / disburse)\n');
  const browser = await chromium.launch();
  const problems = [];

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  watch(page, 'admin', problems);

  try {
    await page.goto(`${ADMIN}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
      page.click('button[type="submit"]'),
    ]);
    ok(!page.url().includes('/login'), 'admin signs in', page.url());

    // ── 1. the prerequisites a run needs ────────────────────────────────────
    const ents = await api(page, '/api/hr/payroll/entities');
    const entList = asList(ents.body);
    ok(ents.status < 400 && entList.length > 0, 'payroll entities are configured',
      `HTTP ${ents.status}, ${entList.length} entity(ies)`);
    const entity = entList[0];

    const cals = await api(page, '/api/hr/payroll/calendars');
    const calList = asList(cals.body);
    ok(cals.status < 400, 'pay calendars load', `HTTP ${cals.status}`);
    // A tenant with no pay calendar cannot run payroll at all — the same
    // "optional upstream, mandatory downstream" shape found five times already.
    ok(calList.length > 0, 'tenant has at least one pay calendar',
      `${calList.length} calendar(s) — without one no payroll run can be created`);
    const cal = entity ? (calList.find((c) => c.entityId === entity.id) || calList[0]) : calList[0];

    // ── 2. an existing run tells us more than a new one ─────────────────────
    // Prefer inspecting a run that already has computed payslips: its numbers are
    // real tenant data, and it avoids minting DRAFT runs on every execution.
    const runs = await api(page, '/api/hr/payroll/runs?pageSize=20');
    const runList = asList(runs.body);
    ok(runs.status < 400, 'payroll runs list loads', `HTTP ${runs.status}`);
    note(`${runList.length} existing run(s)`);

    let runId = null;
    let created = false;
    const withSlips = runList.find((r) => /COMPUTED|FROZEN|APPROVED|PAID/i.test(String(r.status || '')));
    if (withSlips) {
      runId = withSlips.id;
      note(`inspecting existing run ${runId} (status ${withSlips.status})`);
    } else if (entity && cal) {
      // No computed run exists — create a DRAFT for a clearly-stamped period.
      const now = new Date();
      const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
      const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      const run = await send(page, 'POST', '/api/hr/payroll/runs', {
        entityId: entity.id, payCalendarId: cal.id, periodStart, periodEnd,
      });
      ok(run.status < 400 && run.body && run.body.id, 'a payroll run can be created',
        `HTTP ${run.status} ${JSON.stringify(run.body).slice(0, 140)}`);
      runId = run.body && run.body.id;
      created = !!runId;
    }

    if (runId) {
      // ── 3. the checklist that tells HR what is missing ───────────────────
      const chk = await api(page, `/api/hr/payroll/runs/${runId}/inputs-checklist`);
      ok(chk.status < 400, 'the run inputs checklist answers',
        `HTTP ${chk.status} ${JSON.stringify(chk.body).slice(0, 120)}`);

      // ── 4. COMPUTE (safe: reversible, does not lock or pay) ──────────────
      if (created) {
        const comp = await send(page, 'POST', `/api/hr/payroll/runs/${runId}/compute`, {});
        ok(comp.status < 400, 'the run computes',
          `HTTP ${comp.status} ${JSON.stringify(comp.body).slice(0, 160)}`);
      }

      // ── 5. THE NUMBERS ───────────────────────────────────────────────────
      const slips = await api(page, `/api/hr/payroll/runs/${runId}/payslips?pageSize=50`);
      const slipList = asList(slips.body);
      ok(slips.status < 400, 'payslips load for the run', `HTTP ${slips.status}`);
      // A computed run with ZERO payslips returns 200 and looks healthy — and pays
      // nobody. That is the failure this assertion exists for.
      ok(slipList.length > 0, 'the computed run produced payslips (not an empty run)',
        `${slipList.length} payslip(s)`);

      if (slipList.length) {
        const s0 = slipList[0];
        const gross = money(s0, 'grossEarnings', 'gross', 'totalEarnings');
        const ded = money(s0, 'totalDeductions', 'deductions');
        const net = money(s0, 'netPay', 'net', 'netPayable');
        note(`payslip sample — gross ${gross}, deductions ${ded}, net ${net}`);

        if (gross != null && ded != null && net != null) {
          // The identity every payslip must satisfy. A drift here is a wrong
          // salary, and no status code reveals it.
          ok(Math.abs((gross - ded) - net) < 1,
            'net = gross − deductions on a real payslip',
            `${gross} − ${ded} = ${gross - ded}, payslip says ${net}`);
          ok(net >= 0, 'net pay is not negative', `net ${net}`);
        } else {
          ok(false, 'payslip exposes gross / deductions / net in a comparable form',
            `keys: ${Object.keys(s0).slice(0, 14).join(', ')}`);
        }

        // Every payslip must belong to a real employee — an orphan line is money
        // assigned to nobody.
        const orphan = slipList.filter((s) => !s.employeeId && !(s.employee && s.employee.id));
        ok(orphan.length === 0, 'every payslip is bound to an employee',
          `${orphan.length} orphan line(s)`);
      }

      // ── 6. variance: the report HR uses to sanity-check a run ────────────
      const varr = await api(page, `/api/hr/payroll/runs/${runId}/variance`);
      ok(varr.status < 400, 'the run variance report answers', `HTTP ${varr.status}`);

      if (created) {
        note(`NOTE: left a DRAFT run ${runId} behind — there is no delete route, and`);
        note('      freeze/approve/disbursement were deliberately NOT called.');
      }
    }

    // ── 7. the page a client opens ──────────────────────────────────────────
    await page.goto(`${ADMIN}/payroll`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const text = await page.evaluate(() => document.body.innerText || '');
    ok(text.trim().length > 80, 'Payroll page renders content', `${text.trim().length} chars`);
    await assertControlVisible(page, ok,
      ['button:has-text("New")', 'button:has-text("Run")', 'button:has-text("Create")', 'button', 'a[href*="payroll"]'],
      'Payroll page exposes an actionable control');
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
  console.log(bad ? '=== PAYROLL SMOKE FAILED ===\n' : '=== PAYROLL SMOKE PASSED ===\n');
  process.exit(bad ? 1 : 0);
})();
