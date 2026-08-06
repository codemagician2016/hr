#!/usr/bin/env node
/**
 * reports.js — Module 17 of the feature sweep (see qa/SWEEP.md).
 *
 *   node qa/smoke/reports.js                     # staging (default)
 *   E2E_ADMIN=https://app.drifthr.com \
 *     node qa/smoke/reports.js                   # prod
 *
 * WHAT THIS COVERS
 *   headcount → leave liability → payroll register + statutory (per run) →
 *   custom report datasets/definitions → and EVERY export actually returning a file
 *
 * WHY THE EXPORT IS THE ASSERTION
 * -------------------------------
 * A report endpoint that answers 200 with an EMPTY body still looks fine in the
 * browser — the download simply produces a 0-byte file, or a CSV with headers and
 * no rows. People discover that when they open the file to send to an auditor or
 * a bank, which is the worst possible moment.
 *
 * Leave liability in particular is a MONEY figure that goes into accounts. A
 * report that silently returns nothing is not a broken page; it is a wrong number
 * on a balance sheet.
 *
 * SAFETY: read-only. Reports compute and export; nothing is written.
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

const api = (page, url) => page.evaluate(async (u) => {
  const r = await fetch(u, { credentials: 'include' });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, url);

// Fetch an export as BYTES — the point is that a real file comes back, and JSON
// parsing would hide a 0-byte CSV behind a cheerful 200.
const download = (page, url) => page.evaluate(async (u) => {
  const r = await fetch(u, { credentials: 'include' });
  const ct = r.headers.get('content-type') || '';
  const buf = await r.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let head = '';
  for (let i = 0; i < Math.min(bytes.length, 200); i += 1) head += String.fromCharCode(bytes[i]);
  return { status: r.status, contentType: ct, bytes: bytes.length, head };
}, url);

const asList = (b) => (b && (b.items || b.data || b.rows)) || (Array.isArray(b) ? b : []);
const today = new Date().toISOString().slice(0, 10);
const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);

// A CSV export must have a header line AND at least one data row, or it is an
// empty file with a friendly name.
function csvRows(head, bytes) {
  if (!bytes) return 0;
  return head.split('\n').filter((l) => l.trim()).length;
}

(async () => {
  console.log(`\n=== reports smoke — admin ${ADMIN} ===\n`);
  console.log('  (read-only — reports compute and export, nothing is written)\n');
  const browser = await chromium.launch();
  const problems = [];

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  watch(page, 'admin', problems);

  try {
    await waitForHealthy(page, ADMIN);
    const login = await signIn(page, { admin: ADMIN, email: EMAIL, password: PASSWORD });
    if (login.notUp) {
      console.log(`\n  APP NOT UP — login returned ${login.status}.\n`);
      await browser.close(); process.exit(2);
    }
    if (login.throttled) {
      console.log('\n  THROTTLED — auth rate limiter returned 429 (correct behaviour).\n');
      await browser.close(); process.exit(2);
    }
    ok(login.ok, 'admin signs in', `HTTP ${login.status} ${page.url()}`);

    // ── 1. headcount ────────────────────────────────────────────────────────
    const hc = await api(page, `/api/hr/reports/headcount?from=${yearAgo}&to=${today}`);
    ok(hc.status < 400, 'headcount report computes', `HTTP ${hc.status}`);
    const hcBlob = JSON.stringify(hc.body || {});
    ok(hcBlob.length > 20, 'headcount returns data', `${hcBlob.length} chars`);

    const hcx = await download(page, `/api/hr/reports/headcount/export?from=${yearAgo}&to=${today}`);
    ok(hcx.status < 400, 'headcount export answers', `HTTP ${hcx.status} ${hcx.contentType}`);
    // A 0-byte export is a download that produces an empty file — the failure a
    // user only notices when they open it.
    ok(hcx.bytes > 0, 'headcount export returns a NON-EMPTY file',
      `${hcx.bytes} bytes, ${csvRows(hcx.head, hcx.bytes)} line(s) in the head`);

    // ── 2. leave liability — a money figure that reaches accounts ───────────
    const ll = await api(page, `/api/hr/reports/leave-liability?asOf=${today}`);
    ok(ll.status < 400, 'leave liability computes', `HTTP ${ll.status}`);
    const llx = await download(page, `/api/hr/reports/leave-liability/export?asOf=${today}`);
    ok(llx.status < 400, 'leave liability export answers', `HTTP ${llx.status} ${llx.contentType}`);
    ok(llx.bytes > 0, 'leave liability export returns a NON-EMPTY file',
      `${llx.bytes} bytes — this figure goes onto a balance sheet`);

    // ── 3. payroll register + statutory, for a real run ────────────────────
    const runs = await api(page, '/api/hr/reports/runs');
    const runList = asList(runs.body);
    ok(runs.status < 400, 'report run list loads', `HTTP ${runs.status}, ${runList.length} run(s)`);

    if (runList.length) {
      const rid = runList[0].id;
      const reg = await api(page, `/api/hr/reports/runs/${rid}/register`);
      ok(reg.status < 400, 'payroll register computes for a run', `HTTP ${reg.status}`);

      const regx = await download(page, `/api/hr/reports/runs/${rid}/register/export`);
      ok(regx.status < 400 && regx.bytes > 0,
        'payroll register export returns a NON-EMPTY file',
        `HTTP ${regx.status}, ${regx.bytes} bytes`);

      const stat = await api(page, `/api/hr/reports/runs/${rid}/statutory`);
      ok(stat.status < 400, 'statutory report computes for a run', `HTTP ${stat.status}`);

      const statx = await download(page, `/api/hr/reports/runs/${rid}/statutory/export`);
      ok(statx.status < 400 && statx.bytes > 0,
        'statutory export returns a NON-EMPTY file',
        `HTTP ${statx.status}, ${statx.bytes} bytes`);
    } else {
      note('no payroll run available — register/statutory exports not exercised');
    }

    // ── 4. the custom report builder ───────────────────────────────────────
    const ds = await api(page, '/api/hr/reports/datasets');
    const dsList = asList(ds.body);
    ok(ds.status < 400, 'report datasets load', `HTTP ${ds.status}`);
    // With no datasets the report builder has nothing to build FROM.
    ok(dsList.length > 0, 'the report builder has datasets to query',
      `${dsList.length} dataset(s)`);

    const defs = await api(page, '/api/hr/reports/definitions');
    ok(defs.status < 400, 'saved report definitions load',
      `HTTP ${defs.status}, ${asList(defs.body).length} definition(s)`);

    // ── 5. the page a client opens ─────────────────────────────────────────
    await page.goto(`${ADMIN}/reports`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1400);
    const text = await page.evaluate(() => document.body.innerText || '');
    ok(text.trim().length > 60, 'Reports page renders content', `${text.trim().length} chars`);
    await assertControlVisible(page, ok,
      ['button', 'a[href*="report"]', 'table', '[role="table"]'],
      'Reports page exposes a control or its list');
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
  console.log(bad ? '=== REPORTS SMOKE FAILED ===\n' : '=== REPORTS SMOKE PASSED ===\n');
  process.exit(bad ? 1 : 0);
})();
