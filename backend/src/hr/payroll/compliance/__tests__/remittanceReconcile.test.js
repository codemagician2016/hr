'use strict';

/*
 * remittanceReconcile.test.js — Cycle-2b compliance fixes (fileRun ↔ compliance
 * generator agreement). Proves the FIVE confirmed findings are closed:
 *
 *   1. Generator vs fileRun KIND collision — fileRun resolves IN_FORM24Q → IN_FORM138
 *      via the SAME effective-dated resolver the generator uses, so ONE row per
 *      (entity, kind, taxPeriod) per quarter (no permanent duplicate / false-overdue).
 *   2. StatutoryRemittance natural-key UNIQUE — concurrent generate inserts ONCE
 *      (P2002 guard is now LIVE, not dead code). [LIVE hr_test sub-test]
 *   3. Q4 24Q due date — 31-MAY (was 1-May overflow → premature OVERDUE).
 *   4. Monthly IN_TDS reconcile — fileRun writes the monthly IN_TDS deposit on the
 *      generator's natural key so the stub is reconciled (DUE), not auto-OVERDUE.
 *   5. Per-state stateCode — fileRun stamps PT/LWF stateCode so the row shares the
 *      natural key with the generator's per-state stub (no duplicate).
 *
 * Pure assertions run with plain `node`; the concurrency proof needs a DB and only
 * runs when DATABASE_URL points at hr_test (skipped cleanly otherwise).
 *
 *   node src/hr/payroll/compliance/__tests__/remittanceReconcile.test.js
 *   DATABASE_URL="$HR_URL" node src/hr/payroll/compliance/__tests__/remittanceReconcile.test.js   (incl. live)
 */

const service = require('../../service');
const cal = require('../india.calendar');

const { remittanceKind, remittanceDueDate, remittanceTaxPeriod, remittanceStateCode, resolveFilingPlan } = service._internal;

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

// Helper to build a minimal payRun shape the remittance* helpers read.
const mkRun = ({ start, end, taxYear, stateCode = 'MH' }) => ({
  periodStart: start, periodEnd: end, payDate: end, taxYear, currencyCode: 'INR',
  entity: { stateCode, countryCode: 'IN' },
});

const planFor = (kind) => resolveFilingPlan('IN').find((p) => p.kind === kind);

console.log('Cycle-2b — fileRun ↔ generator remittance reconciliation:\n');

// ── FINDING #4: the IN plan now carries a monthly IN_TDS deposit ──────────────
eq('plan: IN has a monthly IN_TDS deposit entry', true, !!planFor('IN_TDS'));
eq('plan: IN_TDS granularity is month', 'month', planFor('IN_TDS').periodGranularity);
eq('plan: IN_FORM24Q quarterly entry still present', true, !!planFor('IN_FORM24Q'));

// ── FINDING #1: 24Q → 138 succession resolved IDENTICALLY to the generator ────
const q4Run = mkRun({ start: '2026-01-01', end: '2026-03-31', taxYear: '2025-26' }); // FY25-26 Q4 (ends 31-Mar-2026)
const q1Run = mkRun({ start: '2026-04-01', end: '2026-06-30', taxYear: '2026-27' }); // FY26-27 Q1 (ends 30-Jun-2026)
const mayRun = mkRun({ start: '2026-05-01', end: '2026-05-31', taxYear: '2026-27' }); // May-2026 (≥ boundary)
const f24qPlan = planFor('IN_FORM24Q');
eq('fileRun kind: Q4 period ENDS 31-Mar-2026 → IN_FORM24Q (pre-boundary)', 'IN_FORM24Q', remittanceKind(f24qPlan, q4Run));
eq('fileRun kind: Q1 period ENDS 30-Jun-2026 → IN_FORM138 (post-boundary)', 'IN_FORM138', remittanceKind(f24qPlan, q1Run));
eq('fileRun kind: May-2026 run → IN_FORM138 (matches generator, no 24Q dup)', 'IN_FORM138', remittanceKind(f24qPlan, mayRun));
// the resolved kind MUST equal what the generator's resolveKindForPeriod returns.
const genOb = { kind: 'IN_FORM24Q', specialRules: { successorKind: 'IN_FORM138', successorFrom: '2026-04-01' } };
eq('agreement: fileRun(Q1) === generator.resolveKindForPeriod(Q1-end)',
  cal.resolveKindForPeriod(genOb, new Date(Date.UTC(2026, 5, 30))), remittanceKind(f24qPlan, q1Run));
// non-succession kinds pass through unchanged.
eq('fileRun kind: IN_PF passes through', 'IN_PF', remittanceKind(planFor('IN_PF'), mayRun));

// ── FINDING #3: Q4 24Q due date is 31-MAY (not 1-May overflow) ────────────────
eq('Q4 24Q due date → 31-May-2026 (was 1-May overflow)', '2026-05-31', remittanceDueDate(f24qPlan, q4Run));
eq('Q1 24Q/138 due date → 31-Jul-2026 (+1 month, unchanged)', '2026-07-31', remittanceDueDate(f24qPlan, q1Run));
// matches the generator's nextDueDate for the SAME quarter taxPeriod.
const f24qOb = (function () { // seed shape
  const seed = require('../india.calendar.seed');
  return seed.buildObligationsForRegistrations([{ kind: 'TAN', effectiveFrom: '2024-01-01' }]).find((o) => o.kind === 'IN_FORM24Q');
}());
eq('agreement: Q4 fileRun due === generator nextDueDate("2025-26-Q4")',
  iso(cal.nextDueDate(f24qOb, '2025-26-Q4')), iso(remittanceDueDate(f24qPlan, q4Run)));

// ── FINDING #4: monthly IN_TDS due date + reconciliation key ──────────────────
const tdsPlan = planFor('IN_TDS');
eq('monthly TDS, May-2026 run → due 7-Jun-2026', '2026-06-07', remittanceDueDate(tdsPlan, mayRun));
eq('monthly TDS, May-2026 → taxPeriod "2026-05" (matches generated stub)', '2026-05', remittanceTaxPeriod(tdsPlan, mayRun));
const marRun = mkRun({ start: '2026-03-01', end: '2026-03-31', taxYear: '2025-26' });
eq('monthly TDS, March-2026 run → due 30-Apr-2026 (March special)', '2026-04-30', remittanceDueDate(tdsPlan, marRun));
// the (kind, taxPeriod) fileRun writes for May == the generator's monthly stub key.
const tdsOb = (function () {
  const seed = require('../india.calendar.seed');
  return seed.buildObligationsForRegistrations([{ kind: 'TAN', effectiveFrom: '2024-01-01' }]).find((o) => o.kind === 'IN_TDS');
}());
eq('agreement: monthly TDS fileRun due === generator nextDueDate("2026-05")',
  iso(cal.nextDueDate(tdsOb, '2026-05')), iso(remittanceDueDate(tdsPlan, mayRun)));

// ── FINDING #5: per-state stateCode keying ────────────────────────────────────
eq('PT row carries the entity stateCode (MH)', 'MH', remittanceStateCode(planFor('IN_PT'), mayRun));
eq('LWF row carries the entity stateCode (MH)', 'MH', remittanceStateCode(planFor('IN_LWF'), mayRun));
eq('entity-wide TDS row has NO stateCode', null, remittanceStateCode(tdsPlan, mayRun));
eq('entity-wide PF row has NO stateCode', null, remittanceStateCode(planFor('IN_PF'), mayRun));

// ─────────────────────────────────────────────────────────────────────────────
// FINDING #2 (LIVE): natural-key UNIQUE makes concurrent generate insert ONCE.
// ─────────────────────────────────────────────────────────────────────────────
async function liveUniqueProof() {
  const prisma = require('../../../../core/lib/prisma');
  const PFX = 'C2BUNIQ';
  const BIZ = `${PFX}-biz`;
  const ENT = `${PFX}-ent`;
  const cleanup = async () => {
    await prisma.statutoryRemittance.deleteMany({ where: { businessId: BIZ } });
    await prisma.entity.deleteMany({ where: { id: ENT } });
    await prisma.business.deleteMany({ where: { id: BIZ } });
  };
  try {
    await cleanup();
    await prisma.business.create({ data: { id: BIZ, name: 'C2B Uniq', slug: `${PFX.toLowerCase()}` } });
    await prisma.entity.create({ data: { id: ENT, businessId: BIZ, code: `${PFX}-HQ`, legalName: 'C2B', countryCode: 'IN', payCurrency: 'INR', stateCode: 'MH', timezone: 'Asia/Kolkata', activeFrom: new Date(Date.UTC(2020, 3, 1)) } });

    const baseRow = (over = {}) => ({
      businessId: BIZ, entityId: ENT, kind: 'IN_TDS', taxPeriod: '2026-05',
      amount: 0, currencyCode: 'INR', dueDate: new Date(Date.UTC(2026, 5, 7)),
      status: 'PENDING', stateCode: null, ...over,
    });

    // Two concurrent inserts of the SAME natural key → exactly ONE survives.
    const results = await Promise.allSettled([
      prisma.statutoryRemittance.create({ data: baseRow() }),
      prisma.statutoryRemittance.create({ data: baseRow() }),
    ]);
    const okCount = results.filter((r) => r.status === 'fulfilled').length;
    const rejCount = results.filter((r) => r.status === 'rejected').length;
    const rejP2002 = results.some((r) => r.status === 'rejected' && (r.reason.code === 'P2002' || /unique|P2002/i.test(r.reason.message || '')));
    eq('LIVE unique: concurrent inserts on the natural key → exactly 1 succeeds', 1, okCount);
    eq('LIVE unique: the loser is rejected (1)', 1, rejCount);
    eq('LIVE unique: the loser fails with a P2002/unique violation (guard is LIVE)', true, rejP2002);
    const cnt = await prisma.statutoryRemittance.count({ where: { businessId: BIZ, kind: 'IN_TDS', taxPeriod: '2026-05' } });
    eq('LIVE unique: exactly ONE IN_TDS 2026-05 row persisted (no dup)', 1, cnt);

    // NULL-safe: a SECOND entity-wide (NULL stateCode) row is ALSO blocked.
    let nullDupBlocked = false;
    try { await prisma.statutoryRemittance.create({ data: baseRow() }); }
    catch (e) { nullDupBlocked = e.code === 'P2002' || /unique|P2002/i.test(e.message || ''); }
    eq('LIVE unique: a duplicate NULL-stateCode row is blocked (COALESCE index)', true, nullDupBlocked);

    // A per-state row with the SAME (kind, taxPeriod) but a DISTINCT stateCode is allowed.
    const perState = await prisma.statutoryRemittance.create({ data: baseRow({ kind: 'IN_PT', stateCode: 'MH' }) }).then(() => true).catch(() => false);
    eq('LIVE unique: a distinct per-state (IN_PT, MH) row IS allowed', true, perState);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

(async () => {
  if (process.env.DATABASE_URL && /hr_test/.test(process.env.DATABASE_URL)) {
    try { await liveUniqueProof(); } catch (e) { failed += 1; fails.push(`LIVE unique proof threw: ${e.message}`); console.log('  FAIL  LIVE unique proof threw:', e.message); }
  } else {
    console.log('  SKIP  LIVE unique proof (set DATABASE_URL to hr_test to run it)');
  }
  console.log('');
  console.log(`Cycle-2b remittance reconcile: ${passed} passed, ${failed} failed of ${passed + failed} assertions.`);
  if (failed > 0) { console.log('Discrepancies:'); for (const d of fails) console.log('  - ' + d); process.exit(1); }
  process.exit(0);
})();
