'use strict';

/*
 * calendar.golden.test.js — Feature 23 golden due-date tables for the PURE
 * compliance calendar engine (../india.calendar.js) + the default IN obligation
 * set (../india.calendar.seed.js).
 *
 * Plain-node (built-in assert, NO jest):
 *   node src/hr/payroll/compliance/__tests__/calendar.golden.test.js
 *
 * Every expected date is derived BY HAND from docs/features/23-compliance-calendar.md
 * §2 (the statutory rules) — including the TDS-March-30-Apr special, the 24Q→138 and
 * 16→130 effective-date flips, the ESI fiscal-half return, and per-state PT/LWF.
 */

const assert = require('assert');
const cal = require('../india.calendar');
const seed = require('../india.calendar.seed');

let passed = 0;
let failed = 0;
const fails = [];
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));
function eq(label, expected, actual) {
  const a = actual instanceof Date ? iso(actual) : actual;
  const e = expected instanceof Date ? iso(expected) : expected;
  if (a === e) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(`${label} — expected ${e}, got ${a}`); console.log(`  FAIL  ${label} — expected ${e}, got ${a}`); }
}

// Obligation shapes from the seed (single source of truth for the defaults).
const obs = seed.buildObligationsForRegistrations([
  { kind: 'TAN', effectiveFrom: '2024-01-01' },
  { kind: 'EPF', effectiveFrom: '2024-01-01' },
  { kind: 'ESI', effectiveFrom: '2024-01-01' },
  { kind: 'PT_STATE', stateCode: 'MH', effectiveFrom: '2024-01-01' },
  { kind: 'PT_STATE', stateCode: 'KA', effectiveFrom: '2024-01-01' },
  { kind: 'PT_STATE', stateCode: 'TN', effectiveFrom: '2024-01-01' }, // half-yearly PT
  { kind: 'LWF', stateCode: 'MH', effectiveFrom: '2024-01-01' }, // half-yearly LWF
  { kind: 'LWF', stateCode: 'KA', effectiveFrom: '2024-01-01' }, // annual LWF
]);
const find = (kind, state) => obs.find((o) => o.kind === kind && (o.stateCode || null) === (state || null));

console.log('Feature 23 — compliance calendar golden due dates:\n');

// ── §2.1 Monthly ───────────────────────────────────────────────────────────
const tds = find('IN_TDS');
eq('TDS deposit, wage May-2026 → 7 Jun 2026', '2026-06-07', cal.nextDueDate(tds, '2026-05'));
eq('TDS deposit, wage Mar-2026 → 30 Apr 2026 (March special)', '2026-04-30', cal.nextDueDate(tds, '2026-03'));
eq('TDS deposit, wage Feb-2026 → 7 Mar 2026', '2026-03-07', cal.nextDueDate(tds, '2026-02'));

const pf = find('IN_PF');
eq('EPF ECR, wage May-2026 → 15 Jun 2026', '2026-06-15', cal.nextDueDate(pf, '2026-05'));
const esi = find('IN_ESI');
eq('ESI contribution, wage May-2026 → 15 Jun 2026', '2026-06-15', cal.nextDueDate(esi, '2026-05'));

const ptMh = find('IN_PT', 'MH');
eq('PT-MH, wage May-2026 → 21 Jun 2026', '2026-06-21', cal.nextDueDate(ptMh, '2026-05'));
const ptKa = find('IN_PT', 'KA');
eq('PT-KA, wage May-2026 → 20 Jun 2026', '2026-06-20', cal.nextDueDate(ptKa, '2026-05'));

// ── §2.2 Quarterly — 24Q → 138 effective-dated succession ────────────────────
const f24q = find('IN_FORM24Q');
eq('24Q FY25-26 Q4 → 31 May 2026', '2026-05-31', cal.nextDueDate(f24q, '2025-26-Q4'));
eq('24Q FY25-26 Q1 → 31 Jul 2025', '2025-07-31', cal.nextDueDate(f24q, '2025-26-Q1'));
eq('Form138 FY26-27 Q1 → 31 Jul 2026', '2026-07-31', cal.nextDueDate(f24q, '2026-27-Q1'));
// kind succession: period end ≤ 2026-03-31 → 24Q ; ≥ 2026-04-01 → 138
eq('kind: FY25-26 Q4 period (ends 31-Mar-2026) → IN_FORM24Q', 'IN_FORM24Q',
  cal.resolveKindForPeriod(f24q, new Date(Date.UTC(2026, 2, 31))));
eq('kind: FY26-27 Q1 period (ends 30-Jun-2026) → IN_FORM138', 'IN_FORM138',
  cal.resolveKindForPeriod(f24q, new Date(Date.UTC(2026, 5, 30))));

// ── §2.3 Annual — Form 16 → 130 succession ──────────────────────────────────
const f16 = find('IN_FORM16');
eq('Form 16 FY25-26 → 15 Jun 2026', '2026-06-15', cal.nextDueDate(f16, '2025-26'));
eq('Form 130 FY26-27 → 15 Jun 2027', '2027-06-15', cal.nextDueDate(f16, '2026-27'));
eq('kind: FY25-26 (ends 31-Mar-2026) → IN_FORM16', 'IN_FORM16',
  cal.resolveKindForPeriod(f16, new Date(Date.UTC(2026, 2, 31))));
eq('kind: FY26-27 (ends 31-Mar-2027) → IN_FORM130', 'IN_FORM130',
  cal.resolveKindForPeriod(f16, new Date(Date.UTC(2027, 2, 31))));

// ── §2.3 ESI half-yearly return (FISCAL halves) ──────────────────────────────
const esiR = find('IN_ESI_RETURN');
eq('ESI return Apr-Sep 2026 (H1) → 11 Oct 2026', '2026-10-11', cal.nextDueDate(esiR, '2026-H1'));
eq('ESI return Oct-Mar 2025-26 (H2) → 11 Apr 2026', '2026-04-11', cal.nextDueDate(esiR, '2026-H2'));

// ── §2.3 LWF state matrix ────────────────────────────────────────────────────
const lwfMh = find('IN_LWF', 'MH');
eq('LWF-MH H1 (Jan-Jun) → 15 Jul', '2026-07-15', cal.nextDueDate(lwfMh, '2026-H1'));
eq('LWF-MH H2 (Jul-Dec) → 15 Jan next yr', '2027-01-15', cal.nextDueDate(lwfMh, '2026-H2'));
const lwfKa = find('IN_LWF', 'KA');
// LWF-KA is annual, Indian-FY keyed; FY26-27 (period ends 31-Mar-2027) → next Jan slot = 15 Jan 2028.
eq('LWF-KA annual FY26-27 → 15 Jan 2028', '2028-01-15', cal.nextDueDate(lwfKa, '2026-27'));

// PT-TN half-yearly (TN is a half-yearly PT state)
const ptTn = find('IN_PT', 'TN');
eq('PT-TN is HALF_YEARLY', 'HALF_YEARLY', ptTn.cadence);

// ── §9 periodsBetween: monthly enumeration is dense + in-range ───────────────
const win = cal.periodsBetween(pf, new Date(Date.UTC(2026, 5, 1)), new Date(Date.UTC(2026, 8, 30)));
eq('PF periodsBetween Jun-Sep 2026 → 4 instances', 4, win.length);
eq('PF first instance taxPeriod', '2026-05', win[0].taxPeriod);
eq('PF first instance due', '2026-06-15', iso(win[0].dueDate));

// ── §9 effective-dating: mid-year EPF registration (Aug) → no Apr-Jul ────────
const pfMid = seed.buildObligationsForRegistrations([{ kind: 'EPF', effectiveFrom: '2026-08-01' }]).find((o) => o.kind === 'IN_PF');
const midWin = cal.periodsBetween(pfMid, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 11, 31)));
const periods = midWin.map((r) => r.taxPeriod);
eq('mid-year EPF (eff 1-Aug): no Apr wage period materialised', false, periods.includes('2026-04'));
eq('mid-year EPF (eff 1-Aug): Aug wage period present', true, periods.includes('2026-08'));

// ── §9 de-registration: effectiveTo stops future periods ─────────────────────
const pfClosed = seed.buildObligationsForRegistrations([{ kind: 'EPF', effectiveFrom: '2024-01-01', effectiveTo: '2026-06-30' }]).find((o) => o.kind === 'IN_PF');
const closedWin = cal.periodsBetween(pfClosed, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 11, 31)));
const cp = closedWin.map((r) => r.taxPeriod);
eq('de-registered EPF (effTo 30-Jun): no Aug wage period', false, cp.includes('2026-08'));
eq('de-registered EPF (effTo 30-Jun): Jun wage period present', true, cp.includes('2026-06'));

// ── per-state fan-out: MH + KA → two distinct PT obligations ─────────────────
const ptCount = obs.filter((o) => o.kind === 'IN_PT').length;
eq('PT per-state fan-out (MH/KA/TN) → 3 obligations', 3, ptCount);

// ── applicability: no PT_STATE registration ⇒ no PT obligation ───────────────
const noPt = seed.buildObligationsForRegistrations([{ kind: 'EPF', effectiveFrom: '2024-01-01' }]);
eq('no PT_STATE reg → no IN_PT obligation', 0, noPt.filter((o) => o.kind === 'IN_PT').length);

console.log('');
console.log(`Feature 23 calendar golden: ${passed} passed, ${failed} failed of ${passed + failed} assertions.`);
if (failed > 0) {
  console.log('Discrepancies:');
  for (const d of fails) console.log('  - ' + d);
  process.exitCode = 1;
}
