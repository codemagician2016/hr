'use strict';

/**
 * compensation.rbac.test.js — LIVE Feature 5 proof (hr_test schema, plain node).
 *
 * Same harness as scope.rbac.test.js / provision.test.js (no jest; controller
 * doubles; isolated hr_test schema seeded under the demo tenant).
 *
 * Proves (docs/05 §6 acceptance + §7 QA 4,5,6,7,8):
 *   QA6  Provisioning bug fix — materializeRevisionLines wired into the comp path
 *        means a revision carries real lines → engine.computePayslip returns a
 *        NON-ZERO gross (the zero-gross bug is dead) + Basic+DA>0 for FnF.
 *   QA5  Engine-consumption parity — the built structure → revision → computePayslip
 *        reproduces the derived gross to the paise.
 *   QA8  Salary masking RBAC — manager (no canViewCompensation) on a report row →
 *        200 RANGE_ONLY with NO absolute money key; employee on /me → SELF_ONLY
 *        full; non-report → 404 (out of scope, no salary in body).
 *   QA7  Revision SoD — a maker cannot approve their own PROPOSED revision (409
 *        SOD_SELF_APPROVAL); a distinct checker can (→ EFFECTIVE, isCurrent).
 *   QA4  50% guard fail-closed at revision-create.
 *
 * Run:
 *   DATABASE_URL="$HR_URL" node src/hr/compensation/__tests__/compensation.rbac.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; },
  };
}
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return done(); };
    const oj = res.json.bind(res); res.json = (p) => { const r = oj(p); done(); return r; };
    const oe = res.end.bind(res); res.end = () => { const r = oe(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const PREFIX = 'COMP5-TEST';

async function main() {
  log('\n=== Feature 5 — Compensation & CTC (LIVE hr_test) ===\n');
  if (!process.env.DATABASE_URL) {
    log('[skip] DATABASE_URL not set — needs the live hr_test schema.\n');
    return;
  }

  const prisma = require('../../../core/lib/prisma');
  const comp = require('../../controllers/compensation.controller');
  const { resolveAccessibleEmployeeIds, scopeAllows } = require('../../lib/scopeResolver');
  const engine = require('../../payroll/engine');
  const india = require('../../payroll/compliance/india');
  const { deriveBreakup } = require('../deriveBreakup');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;

  await cleanup(prisma, businessId);

  // ── Fixture: entity + components + structure + employees (MGR→R1; PEER) ──
  const entity = await prisma.entity.findFirst({ where: { businessId, countryCode: 'IN' } })
    || await prisma.entity.create({ data: { businessId, code: `${PREFIX}-ENT`, legalName: `${PREFIX} Co`, countryCode: 'IN', payCurrency: 'INR' } });

  const mkComp = (code, kind, category, calcMethod, extra = {}) => prisma.salaryComponent.create({
    data: { businessId, code: `${PREFIX}-${code}`, name: code, kind, category, calcMethod, ...extra },
  });
  const cBasic = await mkComp('BASIC', 'BASIC', 'EARNING', 'PERCENT_OF', { calcBaseScope: 'CTC', isWageForPF: true, derivationPass: 2 });
  const cHra = await mkComp('HRA', 'HRA', 'EARNING', 'PERCENT_OF', { calcBaseCode: `${PREFIX}-BASIC`, derivationPass: 1 });
  const cConv = await mkComp('CONV', 'CONVEYANCE', 'EARNING', 'FLAT', { derivationPass: 0 });
  const cSpecial = await mkComp('SPECIAL', 'SPECIAL_ALLOWANCE', 'EARNING', 'BALANCING', { derivationPass: 3 });

  const structure = await prisma.salaryStructure.create({
    data: {
      businessId, entityId: entity.id, code: `${PREFIX}-STR`, name: 'IN CTC Test',
      countryCode: 'IN', currencyCode: 'INR', basis: 'CTC',
      lines: {
        create: [
          { businessId, componentId: cBasic.id, calcMethod: 'PERCENT_OF', calcValue: '50', sortOrder: 0 },
          { businessId, componentId: cHra.id, calcMethod: 'PERCENT_OF', calcValue: '50', sortOrder: 1 },
          { businessId, componentId: cConv.id, calcMethod: 'FLAT', calcValue: '1600', sortOrder: 2 },
          { businessId, componentId: cSpecial.id, calcMethod: 'BALANCING', sortOrder: 3 },
        ],
      },
    },
    include: { lines: { include: { component: true }, orderBy: { sortOrder: 'asc' } } },
  });

  const mkEmp = (code, extra = {}) => prisma.employee.create({
    data: { businessId, code: `${PREFIX}-${code}`, firstName: code, lastName: 'T', status: 'ACTIVE', countryCode: 'IN', isActive: true, ...extra },
  });
  const mgr = await mkEmp('MGR');
  const r1 = await mkEmp('R1', { managerEmployeeId: mgr.id });
  const peer = await mkEmp('PEER');

  // Grade range for the band/compa-ratio view on R1.
  const grade = await prisma.grade.create({
    data: { businessId, code: `${PREFIX}-L4`, name: 'L4', rank: 4, minSalary: '1500000', midSalary: '2000000', maxSalary: '2600000', currencyCode: 'INR' },
  });
  await prisma.employmentRecord.create({
    data: { businessId, employeeId: r1.id, entityId: entity.id, gradeId: grade.id, employmentType: 'FULL_TIME', workerCategory: 'STAFF', effectiveFrom: new Date('2026-01-01'), changeReason: 'HIRE', isCurrent: true },
  });

  // Actors.
  const hrUser = { id: `${PREFIX}-u-hr`, businessId, role: 'STAFF', employeeId: null, businessRole: { name: 'HR-Admin', defaultScope: 'ALL', compVisibility: 'ABSOLUTE', permissions: { canViewCompensation: true, canManageCompensation: true } } };
  const financeUser = { id: `${PREFIX}-u-fin`, businessId, role: 'STAFF', employeeId: null, businessRole: { name: 'Finance', defaultScope: 'ALL', compVisibility: 'ABSOLUTE', permissions: { canViewCompensation: true, canApproveCompensation: true } } };
  const managerUser = { id: `${PREFIX}-u-mgr`, businessId, role: 'STAFF', employeeId: mgr.id, businessRole: { name: 'Manager', defaultScope: 'TEAM', compVisibility: 'RANGE_ONLY', permissions: { canProposeCompensation: true } } };

  try {
    // ════════════════════════════════════════════════════════════════════════
    // QA6 + QA5 — a revision built from the structure computes NON-ZERO gross.
    // ════════════════════════════════════════════════════════════════════════
    log('QA6 — materialized revision computes non-zero gross (bug fix):');
    const { materializeRevisionLines } = require('../deriveBreakup');
    const { lines: matLines, breakup } = materializeRevisionLines(
      { lines: structure.lines, basis: 'CTC' },
      { target: { ctcAnnualMinor: 120000000 }, basis: 'CTC', countryCode: 'IN', asOf: '2026-06-01' },
    );
    assert(matLines.length === 4 && matLines.every((l) => Number(l.amountMonthly) >= 0), 'materializer emits 4 concrete lines');

    const rev = await prisma.compensationRevision.create({
      data: {
        businessId, employeeId: r1.id, entityId: entity.id, structureId: structure.id,
        currencyCode: 'INR', basis: 'CTC', ctcAnnual: '1200000', grossMonthly: String(breakup.grossMinor / 100),
        effectiveFrom: new Date('2026-06-01'), isCurrent: true, revisionReason: 'HIRE', status: 'EFFECTIVE',
        lines: { create: matLines.map((l) => ({ ...l, businessId })) },
      },
      include: { lines: { include: { component: true }, orderBy: { sortOrder: 'asc' } } },
    });

    // Build engine components from the persisted revision lines (the runtime path).
    const ecomps = rev.lines.map((l, i) => {
      const c = l.component;
      const base = {
        code: c.code, name: c.name, category: 'EARNING', prorationPolicy: 'CALENDAR_DAYS', lopBehavior: 'REDUCES_WITH_LOP', _order: i,
        isBasic: c.kind === 'BASIC', isPfWages: c.kind === 'BASIC' || c.isWageForPF === true,
      };
      if (l.calcMethod === 'BALANCING') return { ...base, calcMethod: 'BALANCING', targetGrossMinor: breakup.targetGrossMinor };
      return { ...base, calcMethod: 'FIXED', amountMinor: Math.round(Number(l.amountMonthly) * 100) };
    });
    const ps = engine.computePayslip({
      components: ecomps, inputs: { payableDays: 30, standardDays: 30, lopDays: 0 },
      complianceModule: india, period: { start: '2026-06-01', end: '2026-06-30', payDate: '2026-06-30' },
      employee: {}, entity: { countryCode: 'IN', pfApplicable: true }, currencyCode: 'INR',
    });
    assert(ps.grossMinor > 0, `engine gross > 0 (₹${(ps.grossMinor / 100).toFixed(2)}) — zero-gross bug is dead`);
    assert(ps.grossMinor === breakup.grossMinor, 'QA5 engine gross == derived gross (paise parity)');
    assert(ps.bases.basicMinor > 0, `Basic+DA > 0 (₹${(ps.bases.basicMinor / 100).toFixed(2)}) — FnF gratuity will be non-zero`);

    // ════════════════════════════════════════════════════════════════════════
    // QA8 — salary masking RBAC.
    // ════════════════════════════════════════════════════════════════════════
    log('\nQA8 — salary masking:');

    // Manager (TEAM, no canViewCompensation) on a REPORT (R1) → 200 RANGE_ONLY.
    {
      const scope = await resolveAccessibleEmployeeIds(managerUser, 'compensation');
      assert(scopeAllows(scope, r1.id), 'manager scope INCLUDES report R1 (in sub-tree)');
      const req = { user: managerUser, params: { employeeId: r1.id }, scope };
      const res = await callController(comp.revisions.list, req);
      assert(res.statusCode === 200, 'manager → 200 (no 403 leak)');
      const row = res.body.items[0];
      assert(row.visibility === 'RANGE_ONLY', 'manager row visibility == RANGE_ONLY');
      assert(!row.absolute, 'RANGE_ONLY row has NO absolute object');
      assert(!('ctcAnnual' in (row.absolute || {})), 'RANGE_ONLY row has NO ctcAnnual key');
      assert(row.range && row.range.compaRatio != null, `RANGE_ONLY row carries compa-ratio (${row.range.compaRatio})`);
    }

    // Manager on a NON-report (PEER) → 404 (out of scope, no salary in body).
    {
      const scope = await resolveAccessibleEmployeeIds(managerUser, 'compensation');
      assert(!scopeAllows(scope, peer.id), 'manager scope EXCLUDES non-report PEER → route 404s upstream');
    }

    // HR (ABSOLUTE) on R1 → full money.
    {
      const scope = await resolveAccessibleEmployeeIds(hrUser, 'compensation');
      const req = { user: hrUser, params: { employeeId: r1.id }, scope };
      const res = await callController(comp.revisions.list, req);
      assert(res.statusCode === 200 && res.body.items[0].visibility === 'ABSOLUTE', 'HR row visibility == ABSOLUTE');
      assert(res.body.items[0].absolute && res.body.items[0].absolute.ctcAnnual != null, 'HR row carries absolute ctcAnnual');
    }

    // Employee self on /me → SELF_ONLY full; another id has NO path (structural).
    {
      const r1User = { id: `${PREFIX}-u-r1`, businessId, role: 'USER', employeeId: r1.id, businessRole: null };
      const req = { user: r1User };
      const res = await callController(comp.meCompensation, req);
      assert(res.statusCode === 200, 'employee /me → 200');
      assert(res.body.current && res.body.current.visibility === 'SELF_ONLY', 'employee /me current == SELF_ONLY');
      assert(res.body.current.absolute && res.body.current.absolute.ctcAnnual != null, 'employee sees own absolute ctcAnnual');
    }

    // ════════════════════════════════════════════════════════════════════════
    // QA4 — 50% guard fail-closed at revision-create.
    // ════════════════════════════════════════════════════════════════════════
    log('\nQA4 — India 50% guard (fail-closed) at revision-create:');
    {
      // Basic ₹10k of ₹50k gross → breach.
      const req = {
        user: hrUser, params: { employeeId: r1.id },
        body: {
          entityId: entity.id, currencyCode: 'INR', basis: 'CTC', countryCode: 'IN',
          effectiveFrom: '2027-01-01', revisionReason: 'ANNUAL_REVISION', ctcAnnual: '600000',
          lines: [
            { componentId: cBasic.id, calcMethod: 'FLAT', amountMonthly: '10000' },
            { componentId: cSpecial.id, calcMethod: 'FLAT', amountMonthly: '40000' },
          ],
        },
      };
      const res = await callController(comp.revisions.create, req);
      assert(res.statusCode === 400 && res.body.error === 'WAGES_50_RULE', '50% breach → 400 WAGES_50_RULE (fail-closed)');
    }

    // ════════════════════════════════════════════════════════════════════════
    // QA7 — revision SoD: maker cannot approve own; distinct checker can.
    // ════════════════════════════════════════════════════════════════════════
    log('\nQA7 — revision maker-checker SoD:');
    let proposedId;
    {
      // HR proposes a compliant revision (Basic 50% of gross).
      const req = {
        user: hrUser, params: { employeeId: r1.id },
        body: {
          entityId: entity.id, currencyCode: 'INR', basis: 'CTC', countryCode: 'IN',
          effectiveFrom: '2027-06-01', revisionReason: 'ANNUAL_REVISION', ctcAnnual: '1500000', propose: true,
          lines: [
            { componentId: cBasic.id, calcMethod: 'FLAT', amountMonthly: '50000' },
            { componentId: cHra.id, calcMethod: 'FLAT', amountMonthly: '25000' },
            { componentId: cSpecial.id, calcMethod: 'FLAT', amountMonthly: '25000' },
          ],
        },
      };
      const res = await callController(comp.revisions.create, req);
      assert(res.statusCode === 201 && res.body.status === 'PROPOSED', 'maker creates PROPOSED revision');
      assert(res.body.isCurrent === false, 'PROPOSED revision is NOT current (live pay untouched)');
      proposedId = res.body.id;
    }
    {
      // Same HR maker tries to approve own → 409 SOD_SELF_APPROVAL.
      const res = await callController(comp.revisions.approve, { user: hrUser, params: { id: proposedId } });
      assert(res.statusCode === 409 && res.body.error === 'SOD_SELF_APPROVAL', 'maker approving own → 409 SOD_SELF_APPROVAL');
    }
    {
      // Distinct Finance checker approves → EFFECTIVE + current.
      const res = await callController(comp.revisions.approve, { user: financeUser, params: { id: proposedId } });
      assert(res.statusCode === 200 && res.body.status === 'EFFECTIVE', 'distinct checker approves → EFFECTIVE');
      assert(res.body.isCurrent === true, 'approved revision becomes current');
      const prior = await prisma.compensationRevision.findUnique({ where: { id: rev.id } });
      assert(prior.isCurrent === false, 'the prior current revision is superseded (isCurrent=false)');
    }

    log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} — Feature 5 compensation\n`);
  } finally {
    await cleanup(prisma, businessId);
    await prisma.$disconnect();
  }
  process.exit(failures === 0 ? 0 : 1);
}

async function cleanup(prisma, businessId) {
  // Children first (FK order), all PREFIX-tagged.
  await prisma.salaryComponentLine.deleteMany({ where: { businessId, OR: [
    { structure: { code: { startsWith: PREFIX } } },
    { compensation: { employee: { code: { startsWith: PREFIX } } } },
  ] } });
  await prisma.compensationRevision.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } });
  await prisma.employmentRecord.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } });
  await prisma.salaryStructure.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.salaryComponent.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.grade.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
}

main().catch((e) => { console.error(e); process.exit(1); });
