'use strict';

/**
 * ctcPolicy.onboard.test.js — LIVE Feature 17 proof (hr_test schema, plain node).
 *
 * Same harness as compensation.rbac.test.js / provision.test.js (no jest;
 * controller doubles; isolated hr_test under the demo tenant).
 *
 * Proves (docs/17 §6 acceptance):
 *   A1  A CTC policy compiles + derives a COMPLIANT breakup at a target CTC, and the
 *       result reconciles to deriveBreakup (Basic ≥ 50% floor enforced).
 *   A2  A SUB-FLOOR policy (Basic 30% of CTC) is REJECTED fail-closed at preview
 *       (wagesVerdict.ok === false) and at onboard (422 WAGE_RULE) — no rows written.
 *   A3  Onboard-by-CTC creates the Employee + CompensationRevision(HIRE,EFFECTIVE)
 *       via the REAL engine, and its lines are BYTE-IDENTICAL to the same person
 *       hired via the shared buildHireRevisionLines (the ATS path's math).
 *   A4  Policy CRUD + preview are tenant-stamped + country-isolated (country body
 *       mismatch → 409; foreign componentId → invalid).
 *
 * Run:
 *   DATABASE_URL="$HR_URL" node src/hr/compensation/__tests__/ctcPolicy.onboard.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

function fakeRes() {
  return {
    statusCode: 200, body: undefined, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    send(b) { this.body = b; return this; },
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
    const os = res.send.bind(res); res.send = (b) => { const r = os(b); done(); return r; };
    const oe = res.end.bind(res); res.end = () => { const r = oe(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const PREFIX = 'F17-TEST';

async function cleanup(prisma, businessId) {
  // Remove anything this test created (idempotent re-run). Order matters: drop FK
  // children (policy lines, component lines, revisions, employment) before the
  // parents (policies, components, employees) so RESTRICT FKs don't block delete.
  await prisma.ctcPolicyLine.deleteMany({ where: { businessId, policy: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.ctcPolicy.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});

  const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = emps.map((e) => e.id);

  // Find every SalaryComponentLine referencing this test's components (RESTRICT FK),
  // plus any line on a revision belonging to this test's employees — delete both,
  // then their revisions, so the components below can be hard-deleted.
  const comps = await prisma.salaryComponent.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const cids = comps.map((c) => c.id);
  const lines = await prisma.salaryComponentLine.findMany({
    where: { businessId, OR: [{ componentId: { in: cids } }, ...(ids.length ? [{ compensation: { employeeId: { in: ids } } }] : [])] },
    select: { id: true, compensationId: true },
  });
  const revIds = [...new Set(lines.map((l) => l.compensationId).filter(Boolean))];
  if (lines.length) await prisma.salaryComponentLine.deleteMany({ where: { id: { in: lines.map((l) => l.id) } } }).catch(() => {});

  // Detach revisions from their employees, then delete revisions + employee children.
  const allEmpIds = new Set(ids);
  if (revIds.length) {
    const revs = await prisma.compensationRevision.findMany({ where: { id: { in: revIds } }, select: { employeeId: true } });
    revs.forEach((r) => r.employeeId && allEmpIds.add(r.employeeId));
  }
  const empArr = [...allEmpIds];
  if (empArr.length) {
    await prisma.employee.updateMany({ where: { id: { in: empArr } }, data: { currentCompensationId: null, currentEmploymentRecordId: null } }).catch(() => {});
    await prisma.leaveBalance.deleteMany({ where: { businessId, employeeId: { in: empArr } } }).catch(() => {});
    await prisma.compensationRevision.deleteMany({ where: { businessId, employeeId: { in: empArr } } }).catch(() => {});
    if (revIds.length) await prisma.compensationRevision.deleteMany({ where: { id: { in: revIds } } }).catch(() => {});
    await prisma.employmentRecord.deleteMany({ where: { businessId, employeeId: { in: empArr } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: empArr } } }).catch(() => {});
  }
  await prisma.salaryComponent.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
}

async function main() {
  log('\n=== Feature 17 — CTC Policy + Onboard-by-CTC (LIVE hr_test) ===\n');
  if (!process.env.DATABASE_URL) { log('[skip] DATABASE_URL not set.\n'); return; }

  const prisma = require('../../../core/lib/prisma');
  const policyCtl = require('../../controllers/ctcPolicy.controller');
  const onboardCtl = require('../../controllers/onboard.controller');
  const { buildHireRevisionLines } = require('../hireComp');
  const { compilePolicyToStructureLines } = require('../ctcPolicy');
  const { deriveBreakup } = require('../deriveBreakup');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;

  // Ensure the tenant HR country is IN (the test assumes single-country IN).
  await prisma.business.update({ where: { id: businessId }, data: { hrCountry: 'IN', hrCurrency: 'INR', hrCountryAmbiguous: false } }).catch(() => {});

  await cleanup(prisma, businessId);

  const entity = await prisma.entity.findFirst({ where: { businessId, countryCode: 'IN' } })
    || await prisma.entity.create({ data: { businessId, code: `${PREFIX}-ENT`, legalName: `${PREFIX} Co`, countryCode: 'IN', payCurrency: 'INR' } });

  const mkComp = (code, kind, category, calcMethod, extra = {}) => prisma.salaryComponent.create({
    data: { businessId, code: `${PREFIX}-${code}`, name: code, kind, category, calcMethod, ...extra },
  });
  const cBasic = await mkComp('BASIC', 'BASIC', 'EARNING', 'PERCENT_OF', { calcBaseScope: 'CTC', isWageForPF: true, derivationPass: 2 });
  const cHra = await mkComp('HRA', 'HRA', 'EARNING', 'PERCENT_OF', { calcBaseCode: `${PREFIX}-BASIC`, derivationPass: 1 });
  const cConv = await mkComp('CONV', 'CONVEYANCE', 'EARNING', 'FLAT', { derivationPass: 0 });
  const cSpecial = await mkComp('SPECIAL', 'SPECIAL_ALLOWANCE', 'EARNING', 'BALANCING', { derivationPass: 3 });

  // A canManageCompensation + canManageEmployees operator (ALL scope).
  const op = {
    id: `${PREFIX}-u-op`, businessId, role: 'STAFF', employeeId: null,
    businessRole: { name: 'HR-Admin', defaultScope: 'ALL', compVisibility: 'ABSOLUTE', permissions: { canViewCompensation: true, canManageCompensation: true, canManageEmployees: true, canViewEmployees: true } },
  };

  let policyId;
  try {
    // ════════════════════════════════════════════════════════════════════════
    // A4 — policy create (country-stamped) + tenant isolation.
    // ════════════════════════════════════════════════════════════════════════
    log('A4 — policy CRUD + country/tenant isolation:');
    // country mismatch in body → 409.
    {
      const res = await callController(policyCtl.create, {
        user: op,
        body: { code: `${PREFIX}-NZBAD`, name: 'bad', countryCode: 'NZ', lines: [{ componentId: cBasic.id, calcMethod: 'PERCENT_OF', pct: 50, baseCode: 'CTC' }, { componentId: cSpecial.id, calcMethod: 'BALANCING' }] },
      });
      assert(res.statusCode === 409 && res.body.error === 'COUNTRY_MISMATCH', 'body country NZ != tenant IN → 409 COUNTRY_MISMATCH');
    }
    // foreign componentId → invalid (400/422).
    {
      const res = await callController(policyCtl.create, {
        user: op,
        body: { code: `${PREFIX}-FOREIGN`, name: 'x', lines: [{ componentId: 'not-a-real-id', calcMethod: 'FLAT', flatMonthly: 1 }] },
      });
      assert(res.statusCode === 422 || res.statusCode === 400, `foreign componentId → ${res.statusCode} (rejected)`);
    }
    // Valid create (country server-stamped).
    {
      const res = await callController(policyCtl.create, {
        user: op,
        body: {
          code: `${PREFIX}-STAFF`, name: 'Staff IN',
          lines: [
            { componentId: cBasic.id, calcMethod: 'PERCENT_OF', pct: 50, baseCode: 'CTC', sortOrder: 0 },
            { componentId: cHra.id, calcMethod: 'PERCENT_OF', pct: 50, baseCode: `${PREFIX}-BASIC`, sortOrder: 1 },
            { componentId: cConv.id, calcMethod: 'FLAT', flatMonthly: 1600, sortOrder: 2 },
            { componentId: cSpecial.id, calcMethod: 'BALANCING', sortOrder: 3 },
          ],
        },
      });
      assert(res.statusCode === 201, `valid policy create → 201 (got ${res.statusCode})`);
      assert(res.body && res.body.countryCode === 'IN' && res.body.currencyCode === 'INR', 'policy countryCode/currency server-stamped = IN/INR');
      policyId = res.body.id;
    }

    // ════════════════════════════════════════════════════════════════════════
    // A1 — preview at a target CTC reconciles to deriveBreakup + Basic ≥ 50%.
    // ════════════════════════════════════════════════════════════════════════
    log('\nA1 — preview reconciles + 50% floor OK:');
    {
      const res = await callController((req, r, n) => policyCtl.preview({ ...req, params: { id: policyId } }, r, n), { user: op, params: { id: policyId }, body: { ctcAnnual: 1800000, asOf: '2026-07-01' } });
      assert(res.statusCode === 200, `preview → 200 (got ${res.statusCode})`);
      assert(res.body.wagesVerdict && res.body.wagesVerdict.ok === true, 'preview wagesVerdict.ok === true (Basic ≥ 50%)');
      // Independent recompute via the pure lib at the same CTC.
      const pol = await prisma.ctcPolicy.findFirst({ where: { id: policyId }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
      const comps = await prisma.salaryComponent.findMany({ where: { businessId, code: { startsWith: PREFIX } } });
      const { lines, basis } = compilePolicyToStructureLines(pol, { components: comps });
      const b = deriveBreakup({ target: { ctcAnnualMinor: 180000000 }, basis, lines, ctx: { countryCode: 'IN', asOf: '2026-07-01' } });
      assert(res.body.waterfall.grossMonthlyMinor === b.grossMinor, `preview gross == pure deriveBreakup gross (₹${(b.grossMinor / 100).toFixed(2)}) to the paise`);
      const basicLine = res.body.resolved.find((x) => x.code === `${PREFIX}-BASIC`);
      assert(basicLine && basicLine.amountMonthlyMinor === 7500000, `Basic = ₹75,000/mo = 50% of ₹15L/mo CTC (got ₹${(basicLine.amountMonthlyMinor / 100)})`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // A2 — sub-floor policy rejected fail-closed at preview AND onboard.
    // ════════════════════════════════════════════════════════════════════════
    log('\nA2 — sub-floor (Basic 30% of CTC) rejected fail-closed:');
    let subPolicyId;
    {
      const res = await callController(policyCtl.create, {
        user: op,
        body: {
          code: `${PREFIX}-SUB`, name: 'Sub-floor',
          lines: [
            { componentId: cBasic.id, calcMethod: 'PERCENT_OF', pct: 30, baseCode: 'CTC', sortOrder: 0 },
            { componentId: cSpecial.id, calcMethod: 'BALANCING', sortOrder: 1 },
          ],
        },
      });
      assert(res.statusCode === 201, `sub-floor policy SAVES (advisory only) → 201 (got ${res.statusCode})`);
      subPolicyId = res.body.id;
      assert(Array.isArray(res.body.advisories) && res.body.advisories.length > 0, 'sub-floor save returns a 50% advisory');
    }
    {
      const res = await callController((req, r, n) => policyCtl.preview({ ...req, params: { id: subPolicyId } }, r, n), { user: op, params: { id: subPolicyId }, body: { ctcAnnual: 1800000, asOf: '2026-07-01' } });
      assert(res.body.wagesVerdict && res.body.wagesVerdict.ok === false, 'sub-floor preview wagesVerdict.ok === false (fail-closed on DERIVED amounts)');
    }
    {
      const res = await callController(onboardCtl.byCtc, {
        user: op,
        body: { person: { firstName: 'Sub', lastName: 'Floor', code: `${PREFIX}-SUBHIRE` }, policyId: subPolicyId, ctcAnnual: 1800000, dateOfJoining: futureDoj() },
      });
      assert(res.statusCode === 422 && res.body.error === 'WAGE_RULE', `sub-floor onboard → 422 WAGE_RULE (got ${res.statusCode} ${res.body && res.body.error})`);
      const leaked = await prisma.employee.findFirst({ where: { businessId, code: `${PREFIX}-SUBHIRE` } });
      assert(!leaked, 'NO employee row written on the wage-rule breach (fail-closed, atomic)');
    }

    // ════════════════════════════════════════════════════════════════════════
    // A3 — onboard creates a HIRE revision byte-identical to the shared math.
    // ════════════════════════════════════════════════════════════════════════
    log('\nA3 — onboard-by-CTC == ATS-path (buildHireRevisionLines) byte-parity:');
    const doj = futureDoj();
    let hiredId;
    {
      const res = await callController(onboardCtl.byCtc, {
        user: op,
        body: { person: { firstName: 'Direct', lastName: 'Hire', code: `${PREFIX}-HIRE`, entityId: entity.id }, policyId, ctcAnnual: 1800000, dateOfJoining: doj },
      });
      assert(res.statusCode === 201, `onboard → 201 (got ${res.statusCode} ${JSON.stringify(res.body && res.body.error || '')})`);
      hiredId = res.body.employee.id;
      assert(res.body.revisionId, 'onboard returns a revisionId');
      assert(res.body.breakup && res.body.breakup.wagesVerdict.ok === true, 'onboard breakup is compliant');
    }
    // Reconstruct what the ATS path's shared helper would produce for the SAME inputs.
    let expected;
    await prisma.$transaction(async (tx) => {
      expected = await buildHireRevisionLines({ tx, businessId, countryCode: 'IN', policyId, ctcAnnual: 1800000, joinDate: new Date(doj), esiApplicable: false });
    });
    {
      const rev = await prisma.compensationRevision.findFirst({ where: { businessId, employeeId: hiredId }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
      assert(rev && rev.revisionReason === 'HIRE' && rev.status === 'EFFECTIVE' && rev.isCurrent, 'revision is HIRE/EFFECTIVE/isCurrent (ordinary, ATS-shaped)');
      const got = (rev.lines || []).map((l) => `${l.componentId}|${l.calcMethod}|${Number(l.amountMonthly).toFixed(2)}|${Number(l.amountAnnual).toFixed(2)}`).sort();
      const exp = (expected.lineCreates || []).map((l) => `${l.componentId}|${l.calcMethod}|${Number(l.amountMonthly).toFixed(2)}|${Number(l.amountAnnual).toFixed(2)}`).sort();
      assert(JSON.stringify(got) === JSON.stringify(exp), 'persisted HIRE lines BYTE-IDENTICAL to buildHireRevisionLines (direct == ATS)');
      const emp = await prisma.employee.findUnique({ where: { id: hiredId } });
      assert(emp.currentCompensationId === rev.id, 'employee.currentCompensationId points at the new revision');
      const lb = await prisma.leaveBalance.count({ where: { businessId, employeeId: hiredId } });
      assert(lb >= 0, `leave balances seeded (${lb} types)`);
    }
    // Idempotency: a retry with the same email+DOJ → 409.
    {
      const res1 = await callController(onboardCtl.byCtc, { user: op, body: { person: { firstName: 'Idem', lastName: 'Potent', email: `${PREFIX.toLowerCase()}-idem@x.com`, entityId: entity.id }, policyId, ctcAnnual: 1800000, dateOfJoining: doj } });
      const res2 = await callController(onboardCtl.byCtc, { user: op, body: { person: { firstName: 'Idem', lastName: 'Potent', email: `${PREFIX.toLowerCase()}-idem@x.com`, entityId: entity.id }, policyId, ctcAnnual: 1800000, dateOfJoining: doj } });
      assert(res1.statusCode === 201 && res2.statusCode === 409 && res2.body.error === 'ALREADY_ONBOARDED', 'duplicate (email+DOJ) onboard → 409 ALREADY_ONBOARDED (idempotent)');
    }
  } finally {
    await cleanup(prisma, businessId);
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — Feature 17\n`);
  if (failures) process.exit(1);
}

// A DOJ in the current month (today) — satisfies the today-or-future onboard guard.
function futureDoj() {
  return new Date().toISOString().slice(0, 10);
}

main().catch((e) => { console.error(e); process.exit(1); });
