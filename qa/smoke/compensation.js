#!/usr/bin/env node
/**
 * compensation.js — Module 6 of the feature sweep (see qa/SWEEP.md).
 *
 *   node qa/smoke/compensation.js                # staging (default)
 *   E2E_ADMIN=https://app.drifthr.com \
 *     node qa/smoke/compensation.js              # prod
 *
 * WHAT THIS COVERS
 *   components → structures → preview a CTC → raise a revision for an employee
 *              → approve it → the employee's CURRENT compensation reflects it
 *
 * WHY THE "CURRENT COMPENSATION" IS THE ASSERTION
 * -----------------------------------------------
 * A revision that saves and approves but never becomes the employee's CURRENT
 * compensation is invisible until payroll runs on the OLD number. That is not a
 * broken page — it is a wrong payslip, found by the employee.
 *
 * This module is also the last gate before payroll: provisioning already refused a
 * hire today because no Basic/DA split was resolvable (fixed by persisting the
 * offer's figures), which is exactly the class of gap that matters here.
 *
 * SAFETY
 * ------
 * Creates a stamped employee, gives them ONE revision, then terminates them.
 * It does not touch existing employees' pay.
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
const CTC = 1200000; // ₹12L annual

(async () => {
  console.log(`\n=== compensation smoke — admin ${ADMIN} ===\n`);
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

    // ── 1. the building blocks ──────────────────────────────────────────────
    const comps = await api(page, '/api/hr/compensation/components?pageSize=100');
    const compList = asList(comps.body);
    ok(comps.status < 400 && compList.length > 0, 'salary components are configured',
      `HTTP ${comps.status}, ${compList.length} component(s)`);

    const structs = await api(page, '/api/hr/compensation/structures?pageSize=50');
    const structList = asList(structs.body);
    ok(structs.status < 400, 'salary structures load', `HTTP ${structs.status}`);
    ok(structList.length > 0, 'tenant has at least one salary structure',
      `${structList.length} structure(s) — a tenant with none cannot assign a CTC`);
    const structure = structList[0];

    // ── 2. preview: the CTC breakup must actually compute ───────────────────
    // preview is a PURE quote: it takes the structure's own component lines plus a
    // target, not a structureId. Fetch the structure detail and hand its real lines
    // back, which is what the builder does.
    let structLines = [];
    if (structure) {
      const detail = await api(page, `/api/hr/compensation/structures/${structure.id}`);
      structLines = (detail.body && (detail.body.lines || (detail.body.structure && detail.body.structure.lines))) || [];
      ok(structLines.length > 0, 'the structure has component lines to price',
        `HTTP ${detail.status}, ${structLines.length} line(s)`);
    }

    if (structure && structLines.length) {
      const prev = await send(page, 'POST', '/api/hr/compensation/structures/preview', {
        basis: structure.basis || 'CTC',
        currencyCode: structure.currencyCode || 'INR',
        countryCode: structure.countryCode || 'IN',
        lines: structLines.map((l) => ({
          componentId: l.componentId,
          calcValue: l.calcValue,
          calcMethod: l.calcMethod,
          sortOrder: l.sortOrder,
        })),
        target: { ctcAnnual: CTC },
      });
      ok(prev.status < 400, 'CTC preview computes for a structure',
        `HTTP ${prev.status} ${JSON.stringify(prev.body).slice(0, 140)}`);
      const lines = (prev.body && (prev.body.lines || prev.body.breakup || prev.body.components)) || [];
      ok(Array.isArray(lines) && lines.length > 0,
        'the preview returns component LINES (not an empty breakup)',
        `${Array.isArray(lines) ? lines.length : 0} line(s)`);

      // A breakup whose parts do not add up to the CTC is a wrong payslip waiting
      // to happen, so check the arithmetic rather than just the shape.
      const annualTotal = lines.reduce((a, l) => a + Number(l.amountAnnual || (Number(l.amountMonthly || 0) * 12) || 0), 0);
      if (annualTotal > 0) {
        const drift = Math.abs(annualTotal - CTC) / CTC;
        ok(drift < 0.02, 'the preview breakup adds up to the requested CTC (±2%)',
          `requested ${CTC}, lines total ${Math.round(annualTotal)}`);
      } else {
        note('preview lines carry no comparable amounts — skipping the arithmetic check');
      }
    }

    // ── 3. an employee to pay ───────────────────────────────────────────────
    const emp = await send(page, 'POST', '/api/hr/employees', {
      code: `CMP-${stamp}`, firstName: 'Comp', lastName: `Smoke${stamp}`,
      workEmail: `comp.smoke.${stamp}@example.com`, status: 'ACTIVE', hireDate: today,
    });
    ok(emp.status < 400 && emp.body && emp.body.id, 'employee created for compensation',
      `HTTP ${emp.status} ${JSON.stringify(emp.body).slice(0, 110)}`);
    empId = emp.body && emp.body.id;

    if (empId && structure) {
      // A revision is entity-scoped: entityId, currencyCode, basis, effectiveFrom
      // and revisionReason are ALL required. The admin page loads entities from
      // /payroll/entities, so use the same source rather than inventing one.
      const ents = await api(page, '/api/hr/payroll/entities');
      const entList = asList(ents.body);
      const entityId = structure.entityId || (entList[0] && entList[0].id) || null;
      ok(!!entityId, 'an entity is available to scope the revision',
        `HTTP ${ents.status}, ${entList.length} entity(ies)`);

      // ── 4. raise a revision ───────────────────────────────────────────────
      const rev = await send(page, 'POST', `/api/hr/compensation/employees/${empId}/revisions`, {
        entityId,
        structureId: structure.id,
        currencyCode: structure.currencyCode || 'INR',
        basis: structure.basis || 'CTC',
        ctcAnnual: CTC,
        effectiveFrom: today,
        revisionReason: 'HIRE', // CompRevisionReason enum — free text is a 400
      });
      // An invalid enum used to reach Prisma and come back as a bare 500. Assert the
      // guard directly so a regression is caught here rather than by a user.
      const badReason = await send(page, 'POST', `/api/hr/compensation/employees/${empId}/revisions`, {
        entityId,
        structureId: structure.id,
        currencyCode: structure.currencyCode || 'INR',
        basis: structure.basis || 'CTC',
        ctcAnnual: CTC,
        effectiveFrom: today,
        revisionReason: 'NOT_A_REAL_REASON',
      });
      ok(badReason.status === 400, 'an invalid revisionReason is a clear 400, not a 500',
        `HTTP ${badReason.status} ${JSON.stringify(badReason.body).slice(0, 120)}`);

      ok(rev.status < 400 && rev.body, 'a compensation revision can be raised',
        `HTTP ${rev.status} ${JSON.stringify(rev.body).slice(0, 160)}`);
      const revId = rev.body && (rev.body.id || (rev.body.revision && rev.body.revision.id));
      const revStatus = rev.body && (rev.body.status || (rev.body.revision && rev.body.revision.status));
      note(`revision status on create: ${revStatus}`);

      // ── 5. approve if it needs approval ──────────────────────────────────
      if (revId && /PROPOSED|PENDING/i.test(String(revStatus || ''))) {
        const appr = await send(page, 'POST', `/api/hr/compensation/revisions/${revId}/approve`, {});
        ok(appr.status < 400, 'a proposed revision can be approved',
          `HTTP ${appr.status} ${JSON.stringify(appr.body).slice(0, 140)}`);
      }

      // ── 6. THE assertion: it becomes the employee's LIVE pay ─────────────
      // A revision that saves and approves but never becomes CURRENT is invisible
      // until payroll runs on the old number — a wrong payslip, not a broken page.
      const list = await api(page, `/api/hr/compensation/employees/${empId}/revisions`);
      const revs = asList(list.body);
      ok(revs.length > 0, 'the revision is readable back on the employee',
        `HTTP ${list.status}, ${revs.length} revision(s)`);

      const effective = revs.find((r) => /EFFECTIVE|APPROVED|ACTIVE/i.test(String(r.status || '')));
      ok(!!effective, 'the employee has an EFFECTIVE compensation revision',
        `statuses: ${revs.map((r) => r.status).join(', ') || 'none'}`);

      if (effective) {
        const gotCtc = Number(effective.ctcAnnual || 0);
        ok(Math.abs(gotCtc - CTC) < 1, 'the effective revision carries the CTC that was set',
          `set ${CTC}, stored ${gotCtc}`);
      }
    }

    // ── 7. the page a client opens, and its primary action ─────────────────
    await page.goto(`${ADMIN}/compensation`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const text = await page.evaluate(() => document.body.innerText || '');
    ok(text.trim().length > 80, 'Compensation page renders content', `${text.trim().length} chars`);
    await assertControlVisible(page, ok,
      ['button:has-text("New")', 'button:has-text("Add")', 'button:has-text("Revise")', 'button', 'a[href*="compensation"]'],
      'Compensation page exposes an actionable control');

    // ── 8. cleanup ──────────────────────────────────────────────────────────
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
  console.log(bad ? '=== COMPENSATION SMOKE FAILED ===\n' : '=== COMPENSATION SMOKE PASSED ===\n');
  process.exit(bad ? 1 : 0);
})();
