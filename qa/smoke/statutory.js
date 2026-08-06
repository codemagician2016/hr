#!/usr/bin/env node
/**
 * statutory.js — Module 8 of the feature sweep (see qa/SWEEP.md).
 *
 *   node qa/smoke/statutory.js                   # staging (default)
 *   E2E_ADMIN=https://app.drifthr.com \
 *     node qa/smoke/statutory.js                 # prod
 *
 * WHAT THIS COVERS
 *   statutory registrations → compliance calendar + obligations → register
 *   definitions → bonus cycles → AND the statutory deductions on a REAL payslip.
 *
 * WHY IT ENDS ON A PAYSLIP
 * ------------------------
 * Every statutory surface here can answer 200 with a beautifully empty list. The
 * question that actually matters to a client is narrower and harder: when payroll
 * ran, did PF / ESI / PT actually come off the payslip?
 *
 * Payroll's own engine was proved correct in module 7 (net = gross − deductions on
 * real data). The risk in THIS module is the same one that produced every serious
 * defect today — not a wrong formula, but a handoff that silently produces
 * nothing: an employee missing from a return, a register with no rows, an
 * obligation nobody generated.
 *
 * SAFETY
 * ------
 * Read-only apart from seeding register definitions / obligations when a tenant
 * has NONE (both endpoints are explicitly idempotent seeds). It never marks a
 * remittance filed, never waives one, and never approves or publishes a bonus
 * cycle — those are statutory filings and real money.
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
const today = new Date().toISOString().slice(0, 10);
const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);

(async () => {
  console.log(`\n=== statutory smoke — admin ${ADMIN} ===\n`);
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

    // ── 1. statutory registrations (PF / ESI / PT numbers) ──────────────────
    const regs = await api(page, '/api/hr/statutory-registrations');
    ok(regs.status < 400, 'statutory registrations load', `HTTP ${regs.status}`);
    note(`${asList(regs.body).length} registration(s) on file`);

    // Both seeds are ENTITY-scoped (obligations derive from that entity's
    // registrations; register definitions from the same). Resolve one first.
    const ents = await api(page, '/api/hr/payroll/entities');
    const entity = asList(ents.body)[0];
    ok(!!entity, 'an entity is available to scope statutory setup',
      `HTTP ${ents.status}, ${asList(ents.body).length} entity(ies)`);
    const entityId = entity && entity.id;

    // ── 2. compliance obligations + calendar ────────────────────────────────
    let obs = await api(page, '/api/hr/compliance/obligations');
    let obList = asList(obs.body);
    ok(obs.status < 400, 'compliance obligations load', `HTTP ${obs.status}`);
    if (!obList.length) {
      // A tenant with no obligations has an empty compliance calendar — nothing
      // ever falls due, so nothing is ever chased. Seed is idempotent.
      note('no obligations configured — seeding the defaults');
      const seeded = await send(page, 'POST', '/api/hr/compliance/obligations/seed', { entityId });
      ok(seeded.status < 400, 'compliance obligations can be seeded', `HTTP ${seeded.status}`);
      obs = await api(page, '/api/hr/compliance/obligations');
      obList = asList(obs.body);
    }
    ok(obList.length > 0, 'the tenant has compliance obligations configured',
      `${obList.length} obligation(s) — with none, nothing ever falls due`);

    const cal = await api(page, `/api/hr/compliance/calendar?from=${yearAgo}&to=${today}`);
    ok(cal.status < 400, 'the compliance calendar answers', `HTTP ${cal.status}`);

    // ── 3. statutory register definitions ───────────────────────────────────
    let defs = await api(page, '/api/hr/registers/definitions');
    let defList = asList(defs.body);
    ok(defs.status < 400, 'register definitions load', `HTTP ${defs.status}`);
    if (!defList.length) {
      note('no register definitions — seeding the statutory set');
      const seeded = await send(page, 'POST', '/api/hr/registers/definitions/seed', { entityId });
      ok(seeded.status < 400, 'register definitions can be seeded', `HTTP ${seeded.status}`);
      defs = await api(page, '/api/hr/registers/definitions');
      defList = asList(defs.body);
    }
    ok(defList.length > 0, 'the tenant has statutory register definitions',
      `${defList.length} definition(s)`);

    // ── 4. bonus cycles ─────────────────────────────────────────────────────
    const cycles = await api(page, '/api/hr/bonus/cycles');
    ok(cycles.status < 400, 'statutory bonus cycles load', `HTTP ${cycles.status}`);
    note(`${asList(cycles.body).length} bonus cycle(s)`);

    // ── 5. THE ONE THAT MATTERS: statutory deductions on a REAL payslip ─────
    // Everything above can answer 200 with an empty list. What a client actually
    // needs is that PF / ESI / PT came off when payroll ran.
    const runs = await api(page, '/api/hr/payroll/runs?pageSize=20');
    const computed = asList(runs.body).find((r) => /COMPUTED|FROZEN|APPROVED|PAID/i.test(String(r.status || '')));
    if (!computed) {
      note('no computed payroll run on this tenant — skipping the payslip statutory check');
    } else {
      const slips = await api(page, `/api/hr/payroll/runs/${computed.id}/payslips?pageSize=50`);
      const slipList = asList(slips.body);
      ok(slipList.length > 0, 'the computed run has payslips to inspect',
        `${slipList.length} payslip(s)`);

      if (slipList.length) {
        // Look across the run, not one row: a single employee may legitimately be
        // below the PF/ESI threshold, but a whole run with no statutory line at
        // all means the deductions never ran.
        const blob = JSON.stringify(slipList).toUpperCase();
        const found = ['PF', 'EPF', 'ESI', 'PT', 'PROFESSIONAL TAX', 'TDS']
          .filter((k) => blob.includes(`"${k}"`) || blob.includes(k));
        ok(found.length > 0,
          'statutory components appear on the computed payslips (PF/ESI/PT/TDS)',
          found.length ? `found: ${[...new Set(found)].join(', ')}` : 'NO statutory component found anywhere in the run');

        // Deductions must be non-zero somewhere in the run — an all-zero deduction
        // column is what "the statutory step never ran" looks like.
        const anyDeduction = slipList.some((s) => {
          const d = s.totalDeductionsMinor != null ? Number(s.totalDeductionsMinor) : Number(s.totalDeductions || 0);
          return d > 0;
        });
        ok(anyDeduction, 'at least one payslip carries a non-zero deduction',
          'an all-zero deduction column is how a skipped statutory step looks');
      }
    }

    // ── 6. the pages a client opens ─────────────────────────────────────────
    for (const [url, label] of [
      ['/payroll/registers', 'Statutory registers'],
      ['/payroll/compliance', 'Compliance calendar'],
    ]) {
      const resp = await page.goto(`${ADMIN}${url}`, { waitUntil: 'networkidle' }).catch(() => null);
      const st = resp ? resp.status() : 0;
      if (st === 404) { note(`skip: ${label} is not mounted at ${url}`); continue; }
      await page.waitForTimeout(1200);
      const text = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      ok(text.trim().length > 60, `${label} page renders content`, `HTTP ${st}, ${text.trim().length} chars`);
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
  console.log(bad ? '=== STATUTORY SMOKE FAILED ===\n' : '=== STATUTORY SMOKE PASSED ===\n');
  process.exit(bad ? 1 : 0);
})();
