#!/usr/bin/env node
/**
 * leave.js — Module 5 of the feature sweep (see qa/SWEEP.md).
 *
 *   node qa/smoke/leave.js                       # staging (default)
 *   E2E_ADMIN=https://app.drifthr.com \
 *     node qa/smoke/leave.js                     # prod
 *
 * WHAT THIS COVERS
 *   leave types → employee balance BEFORE → raise a request → approve
 *              → balance AFTER (must have moved) → calendar → reports
 *
 * WHY THE BALANCE IS THE ASSERTION
 * --------------------------------
 * "Approve returned 200" proves nothing. Leave is a ledger: the only thing that
 * matters is that approving a request actually DEBITS the balance. A request that
 * approves without moving the ledger gives an employee unlimited leave and shows
 * up months later as an encashment or full-and-final that cannot be reconciled.
 *
 * This is the same lesson as every other module today — assert the OUTCOME, not
 * the absence of a crash. Five assertions have already been tightened for exactly
 * this reason, one of which reported healthy attendance for a day on which every
 * punch had failed.
 *
 * SAFETY
 * ------
 * Creates a stamped employee, raises and approves ONE short request, then
 * terminates the employee. It never runs carry-forward or balance repair — those
 * are org-wide and destructive.
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
const d = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const asList = (b) => (b && (b.items || b.data || b.rows)) || (Array.isArray(b) ? b : []);
const num = (v) => (v == null ? null : Number(v));

// Pull a comparable "available" figure out of whatever shape a balance row uses.
function availableOf(row) {
  if (!row || typeof row !== 'object') return null;
  for (const k of ['available', 'availableDays', 'balance', 'closingBalance', 'currentBalance']) {
    if (row[k] != null && !Number.isNaN(Number(row[k]))) return Number(row[k]);
  }
  return null;
}

(async () => {
  console.log(`\n=== leave smoke — admin ${ADMIN} ===\n`);
  const browser = await chromium.launch();
  const problems = [];
  let empId = null;

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

    // ── 1. leave types must exist ───────────────────────────────────────────
    // A tenant with no leave types cannot record a single day off. Same
    // "optional upstream, mandatory downstream" shape as the pipeline/scorecard/
    // onboarding-template gaps found earlier today.
    const types = await api(page, '/api/hr/leave/types');
    const typeList = asList(types.body);
    ok(types.status < 400 && typeList.length > 0, 'tenant has leave types configured',
      `HTTP ${types.status}, ${typeList.length} type(s)`);
    const leaveType = typeList[0];

    // ── 2. an employee to take leave ────────────────────────────────────────
    const emp = await send(page, 'POST', '/api/hr/employees', {
      code: `LV-${stamp}`, firstName: 'Leave', lastName: `Smoke${stamp}`,
      workEmail: `leave.smoke.${stamp}@example.com`, status: 'ACTIVE',
      hireDate: d(-400),
    });
    ok(emp.status < 400 && emp.body && emp.body.id, 'employee created for leave',
      `HTTP ${emp.status} ${JSON.stringify(emp.body).slice(0, 110)}`);
    empId = emp.body && emp.body.id;

    if (empId && leaveType) {
      // ── 3. balance BEFORE ────────────────────────────────────────────────
      const before = await api(page, `/api/hr/leave/employees/${empId}/balances`);
      ok(before.status < 400, 'employee leave balances load', `HTTP ${before.status}`);
      const beforeRows = asList(before.body);
      const beforeRow = beforeRows.find((r) => r.leaveTypeId === leaveType.id) || beforeRows[0];
      const beforeAvail = availableOf(beforeRow);
      note(`balance before: ${beforeAvail == null ? 'n/a' : beforeAvail} (${beforeRows.length} row(s))`);

      // ── 4. raise a request ───────────────────────────────────────────────
      const start = d(7);
      const req = await send(page, 'POST', '/api/hr/leave/requests', {
        employeeId: empId, leaveTypeId: leaveType.id,
        startDate: start, endDate: start, reason: 'QA smoke — single day',
      });
      ok(req.status < 400 && req.body, 'a leave request can be raised',
        `HTTP ${req.status} ${JSON.stringify(req.body).slice(0, 140)}`);
      const reqId = req.body && (req.body.id || (req.body.request && req.body.request.id));

      if (reqId) {
        // it must be visible to an approver, not just created
        const list = await api(page, `/api/hr/leave/requests?employeeId=${empId}`);
        ok(asList(list.body).some((r) => r.id === reqId),
          'the request appears in the approver list',
          `HTTP ${list.status}, ${asList(list.body).length} row(s)`);

        // ── 5. approve ─────────────────────────────────────────────────────
        const appr = await send(page, 'POST', `/api/hr/leave/requests/${reqId}/approve`, {});
        ok(appr.status < 400, 'a leave request can be approved',
          `HTTP ${appr.status} ${JSON.stringify(appr.body).slice(0, 140)}`);

        const after1 = await api(page, `/api/hr/leave/requests/${reqId}`);
        const st = (after1.body && (after1.body.status || (after1.body.request && after1.body.request.status))) || '';
        ok(/APPROVED/i.test(String(st)), 'the request is APPROVED after a re-read', `status ${st}`);

        // ── 6. THE assertion: the ledger actually moved ────────────────────
        // Approving without debiting the balance hands an employee unlimited
        // leave, and only surfaces at encashment or full-and-final.
        const after = await api(page, `/api/hr/leave/employees/${empId}/balances`);
        const afterRows = asList(after.body);
        const afterRow = afterRows.find((r) => r.leaveTypeId === leaveType.id) || afterRows[0];
        const afterAvail = availableOf(afterRow);
        note(`balance after: ${afterAvail == null ? 'n/a' : afterAvail}`);

        if (beforeAvail == null || afterAvail == null) {
          ok(false, 'leave balance is reported in a comparable form',
            `before=${JSON.stringify(beforeRow).slice(0, 100)} after=${JSON.stringify(afterRow).slice(0, 100)}`);
        } else {
          ok(afterAvail < beforeAvail,
            'approving leave DEBITS the balance (the ledger actually moved)',
            `before ${beforeAvail} → after ${afterAvail}`);
        }

        // ── 7. it shows up where people look for it ────────────────────────
        const cal = await api(page, `/api/hr/leave/calendar?from=${start}&to=${start}`);
        ok(cal.status < 400, 'leave calendar loads', `HTTP ${cal.status}`);
        const rep = await api(page, `/api/hr/leave/reports/summary?from=${today}&to=${d(30)}`);
        ok(rep.status < 400, 'leave summary report loads', `HTTP ${rep.status}`);
      }
    }

    // ── 8. the page a client opens ──────────────────────────────────────────
    await page.goto(`${ADMIN}/leave`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const text = await page.evaluate(() => document.body.innerText || '');
    ok(text.trim().length > 80, 'Leave page renders content', `${text.trim().length} chars`);

    // ── 9. cleanup ──────────────────────────────────────────────────────────
    if (empId && !KEEP) {
      const t = await send(page, 'POST', `/api/hr/employees/${empId}/terminate`, {
        terminationDate: today, reason: 'QA smoke cleanup',
      });
      note(`cleanup: terminated smoke employee (HTTP ${t.status})`);
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
  console.log(bad ? '=== LEAVE SMOKE FAILED ===\n' : '=== LEAVE SMOKE PASSED ===\n');
  process.exit(bad ? 1 : 0);
})();
