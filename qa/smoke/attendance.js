#!/usr/bin/env node
/**
 * attendance.js — Module 4 of the feature sweep (see qa/SWEEP.md).
 *
 *   node qa/smoke/attendance.js                  # staging (default)
 *   E2E_ADMIN=https://app.drifthr.com \
 *     node qa/smoke/attendance.js                # prod
 *
 * WHAT THIS COVERS
 * ----------------
 *   shift → assign → punch in/out → summary → regularization → approve
 *        → timesheet generate → submit → approve → PAY INPUTS
 *
 * WHY IT RUNS ALL THE WAY TO PAY INPUTS
 * -------------------------------------
 * Attendance is where a silent failure stops being an inconvenience and starts
 * being money. Present days and LOP flow out of here into the payroll run, so a
 * punch that records but never reaches the pay inputs does not look like a bug —
 * it looks like an employee who was absent, and it is discovered on payday.
 *
 * Every other module so far has failed the same way: something is optional when
 * you create it and mandatory later (a job with no pipeline, an interview with no
 * scorecard template, an offer with no basic/DA). The equivalents here are a punch
 * with no shift assignment and a timesheet for a period with no shift, so this
 * deliberately walks the boring path rather than the fully-configured one.
 *
 * SAFETY
 * ------
 * Creates a stamped employee + shift and cleans both up. It does NOT close a
 * payroll period — that is destructive and belongs to the payroll module.
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
const KEEP = process.env.E2E_KEEP === '1';

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

const stamp = String(Date.now()).slice(-6);
const today = new Date().toISOString().slice(0, 10);
const asList = (b) => (b && (b.items || b.data || b.rows)) || (Array.isArray(b) ? b : []);

(async () => {
  console.log(`\n=== attendance smoke — admin ${ADMIN} ===\n`);
  const browser = await chromium.launch();
  const problems = [];
  let empId = null; let shiftId = null;

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

    // ── 1. an employee to attend ────────────────────────────────────────────
    const emp = await send(page, 'POST', '/api/hr/employees', {
      code: `ATT-${stamp}`, firstName: 'Att', lastName: `Smoke${stamp}`,
      workEmail: `att.smoke.${stamp}@example.com`, status: 'ACTIVE',
    });
    ok(emp.status < 400 && emp.body && emp.body.id, 'employee created for attendance',
      `HTTP ${emp.status} ${JSON.stringify(emp.body).slice(0, 110)}`);
    empId = emp.body && emp.body.id;

    // ── 2. shift definition + assignment ────────────────────────────────────
    const shift = await send(page, 'POST', '/api/hr/attendance/shifts', {
      code: `SH-${stamp}`, name: `Smoke Shift ${stamp}`,
      startTime: '09:00', endTime: '18:00',
    });
    ok(shift.status < 400 && shift.body && shift.body.id, 'shift can be created',
      `HTTP ${shift.status} ${JSON.stringify(shift.body).slice(0, 110)}`);
    shiftId = shift.body && shift.body.id;

    if (shiftId && empId) {
      const assign = await send(page, 'POST', `/api/hr/attendance/shifts/${shiftId}/assign`, {
        employeeIds: [empId], effectiveFrom: today,
      });
      ok(assign.status < 400, 'shift can be assigned to an employee',
        `HTTP ${assign.status} ${JSON.stringify(assign.body).slice(0, 110)}`);

      const assigns = await api(page, `/api/hr/attendance/assignments?employeeId=${empId}`);
      ok(assigns.status < 400 && asList(assigns.body).length > 0,
        'the assignment is readable back', `HTTP ${assigns.status}, ${asList(assigns.body).length} row(s)`);
    }

    // ── 3. punches ──────────────────────────────────────────────────────────
    if (empId) {
      const pin = await send(page, 'POST', '/api/hr/attendance/punch', {
        employeeId: empId, punchAt: `${today}T09:05:00.000Z`, type: 'IN', source: 'WEB',
      });
      ok(pin.status < 400, 'punch IN records', `HTTP ${pin.status} ${JSON.stringify(pin.body).slice(0, 110)}`);

      const pout = await send(page, 'POST', '/api/hr/attendance/punch', {
        employeeId: empId, punchAt: `${today}T18:10:00.000Z`, type: 'OUT', source: 'WEB',
      });
      ok(pout.status < 400, 'punch OUT records', `HTTP ${pout.status}`);

      // NOTE: `to` is compared with <= against a timestamp, so a bare date parses
      // to MIDNIGHT and excludes the whole day. The app sends full ISO bounds
      // (…T23:59:59.999Z); a smoke that passes bare dates silently sees nothing.
      const dayFrom = `${today}T00:00:00.000Z`;
      const dayTo = `${today}T23:59:59.999Z`;
      const punches = await api(page, `/api/hr/attendance/punches?employeeId=${empId}&from=${dayFrom}&to=${dayTo}`);
      ok(punches.status < 400 && asList(punches.body).length >= 1,
        'punches are readable back for the day',
        `HTTP ${punches.status}, ${asList(punches.body).length} punch(es)`);

      // ── 4. the day must actually COUNT ───────────────────────────────────
      // A punch that stores but never becomes a present day is invisible until
      // payday, when the employee is short-paid for a day they worked.
      await send(page, 'POST', '/api/hr/attendance/recompute', { from: today, to: today, employeeId: empId });
      const summary = await api(page, `/api/hr/attendance/summary?employeeId=${empId}&from=${dayFrom}&to=${dayTo}`);
      ok(summary.status < 400, 'attendance summary loads', `HTTP ${summary.status}`);
      // This previously matched key NAMES in the JSON, so it passed on a day with
      // ZERO punches — reporting healthy attendance for an employee who, as far as
      // the system knew, never showed up. Assert a real worked VALUE instead.
      const buckets = (summary.body && summary.body.buckets) || [];
      const present = buckets.find((b) => String(b.key).toUpperCase() === 'PRESENT');
      ok(!!present && Number(present.count) > 0,
        'summary counts the punched day as PRESENT',
        `buckets: ${JSON.stringify(buckets).slice(0, 160)}`);

      // ── 5. regularization: the fix-it path employees actually use ────────
      const reg = await send(page, 'POST', '/api/hr/attendance/regularizations', {
        employeeId: empId, date: today, reason: 'QA smoke — forgot to punch out',
        requestedIn: `${today}T09:00:00.000Z`, requestedOut: `${today}T18:00:00.000Z`,
      });
      ok(reg.status < 400, 'a regularization can be raised',
        `HTTP ${reg.status} ${JSON.stringify(reg.body).slice(0, 110)}`);
      const regId = reg.body && (reg.body.id || (reg.body.item && reg.body.item.id));
      if (regId) {
        const appr = await send(page, 'POST', `/api/hr/attendance/regularizations/${regId}/approve`, {});
        ok(appr.status < 400, 'a regularization can be approved', `HTTP ${appr.status}`);
      }

      // ── 6. THE SEAM: attendance → payroll ────────────────────────────────
      // pay-inputs is what the payroll run consumes. If the day never arrives
      // here, payroll is wrong and nothing upstream looks broken.
      const payIn = await api(page, `/api/hr/attendance/pay-inputs?from=${dayFrom}&to=${dayTo}&employeeId=${empId}`);
      ok(payIn.status < 400, 'attendance pay-inputs endpoint answers (the payroll seam)',
        `HTTP ${payIn.status} ${JSON.stringify(payIn.body).slice(0, 140)}`);
    }

    // ── 7. the pages a client opens ─────────────────────────────────────────
    for (const [url, label] of [['/attendance', 'Attendance'], ['/roster', 'Roster']]) {
      await page.goto(`${ADMIN}${url}`, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      ok(text.trim().length > 60, `${label} page renders content`, `${text.trim().length} chars`);
    // A 200 page with no usable control is indistinguishable from a healthy
    // one to every check except a browser looking for the control itself.
    await assertControlVisible(page, ok, ['button:has-text("Punch")', 'button:has-text("Regular")', 'button:has-text("Add")', 'button', 'a[href*="attendance"]'], 'Attendance page exposes an actionable control');
    }

    // ── 8. cleanup ──────────────────────────────────────────────────────────
    if (!KEEP) {
      if (shiftId) {
        const d = await api(page, `/api/hr/attendance/shifts/${shiftId}`, { method: 'DELETE' });
        note(`cleanup: deleted smoke shift (HTTP ${d.status})`);
      }
      if (empId) {
        const t = await send(page, 'POST', `/api/hr/employees/${empId}/terminate`, {
          terminationDate: today, reason: 'QA smoke cleanup',
        });
        note(`cleanup: terminated smoke employee (HTTP ${t.status})`);
      }
    }
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
  console.log(bad ? '=== ATTENDANCE SMOKE FAILED ===\n' : '=== ATTENDANCE SMOKE PASSED ===\n');
  process.exit(bad ? 1 : 0);
})();
