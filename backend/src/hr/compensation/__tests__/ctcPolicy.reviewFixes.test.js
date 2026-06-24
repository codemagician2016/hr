'use strict';

/**
 * ctcPolicy.reviewFixes.test.js — LIVE proof for the 4 confirmed F17 review findings
 * (hr_test schema, plain node; same harness as ctcPolicy.onboard.test.js).
 *
 * Proves:
 *   H1 (HIGH) — onboard-by-CTC is TOCTOU-safe: two CONCURRENT identical POSTs (same
 *               email+DOJ) → exactly ONE employee, the loser gets 409 ALREADY_ONBOARDED
 *               (the DB partial-unique enforces it; not the app pre-check).
 *   H2 (HIGH) — a null-email hire WITHOUT a stable key → 400 IDEMPOTENCY_KEY_REQUIRED;
 *               WITH a code (or idempotencyKey), a sequential retry → ONE employee (409).
 *   M1 (MED)  — a policy line whose component is SOFT-DELETED → compile ERROR (not a
 *               silent drop): onboard 422, preview 422 POLICY_UNRESOLVED, and the
 *               compile reconciles (compiled-line-count == policy-line-count).
 *   M2 (MED)  — preview === onboard: the persisted HIRE gross/Basic equals what preview
 *               showed for the SAME policy+CTC (preview forces basis from country, as
 *               onboard does).
 *   L1 (LOW)  — ESI parity: an ESI-less CTC policy hired via onboard produces lines
 *               BYTE-IDENTICAL to the ATS-path shared helper sourcing the SHARED ESI/PF
 *               defaults (HIRE_ESI_DEFAULT / HIRE_PF_CAP_DEFAULT).
 *
 * Run:
 *   DATABASE_URL="$HR_URL" node src/hr/compensation/__tests__/ctcPolicy.reviewFixes.test.js
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

const PREFIX = 'F17-RVW';

async function cleanup(prisma, businessId) {
  await prisma.ctcPolicyLine.deleteMany({ where: { businessId, policy: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.ctcPolicy.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});

  const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = emps.map((e) => e.id);
  const comps = await prisma.salaryComponent.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const cids = comps.map((c) => c.id);
  const lines = await prisma.salaryComponentLine.findMany({
    where: { businessId, OR: [{ componentId: { in: cids } }, ...(ids.length ? [{ compensation: { employeeId: { in: ids } } }] : [])] },
    select: { id: true, compensationId: true },
  });
  const revIds = [...new Set(lines.map((l) => l.compensationId).filter(Boolean))];
  if (lines.length) await prisma.salaryComponentLine.deleteMany({ where: { id: { in: lines.map((l) => l.id) } } }).catch(() => {});

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

// A DOJ in the current month (today) — satisfies the today-or-future onboard guard.
function futureDoj() { return new Date().toISOString().slice(0, 10); }

async function main() {
  log('\n=== Feature 17 — review fixes (LIVE hr_test) ===\n');
  if (!process.env.DATABASE_URL) { log('[skip] DATABASE_URL not set.\n'); return; }

  const prisma = require('../../../core/lib/prisma');
  const policyCtl = require('../../controllers/ctcPolicy.controller');
  const onboardCtl = require('../../controllers/onboard.controller');
  const { buildHireRevisionLines, HIRE_ESI_DEFAULT, HIRE_PF_CAP_DEFAULT } = require('../hireComp');
  const { compilePolicyToStructureLines, CompilePolicyError } = require('../ctcPolicy');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
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

  const op = {
    id: `${PREFIX}-u-op`, businessId, role: 'STAFF', employeeId: null,
    businessRole: { name: 'HR-Admin', defaultScope: 'ALL', compVisibility: 'ABSOLUTE', permissions: { canViewCompensation: true, canManageCompensation: true, canManageEmployees: true, canViewEmployees: true } },
  };

  let policyId;
  try {
    // Valid baseline policy (BASIC 50% CTC + HRA 50% BASIC + CONV flat + SPECIAL balancing).
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
      assert(res.statusCode === 201, `baseline policy create → 201 (got ${res.statusCode})`);
      policyId = res.body.id;
    }

    // ════════════════════════════════════════════════════════════════════════
    // M2 (MED) — preview === onboard (same gross/Basic; basis forced from country).
    // ════════════════════════════════════════════════════════════════════════
    log('M2 — preview numbers == onboard numbers:');
    const CTC = 1800000;
    let previewGross; let previewBasic;
    {
      const res = await callController((req, r, n) => policyCtl.preview({ ...req, params: { id: policyId } }, r, n), { user: op, params: { id: policyId }, body: { ctcAnnual: CTC, asOf: futureDoj() } });
      assert(res.statusCode === 200 && res.body.basis === 'CTC', `preview → 200 basis forced to CTC (got ${res.statusCode}/${res.body && res.body.basis})`);
      previewGross = res.body.waterfall.grossMonthlyMinor;
      previewBasic = res.body.basicDaMonthlyMinor;
    }
    {
      const res = await callController(onboardCtl.byCtc, {
        user: op,
        body: { person: { firstName: 'Pre', lastName: 'View', code: `${PREFIX}-M2`, entityId: entity.id }, policyId, ctcAnnual: CTC, dateOfJoining: futureDoj() },
      });
      assert(res.statusCode === 201, `onboard → 201 (got ${res.statusCode} ${JSON.stringify(res.body && res.body.error || '')})`);
      assert(res.body.breakup.grossMonthlyMinor === previewGross, `onboard gross == preview gross (₹${(previewGross / 100).toFixed(2)})`);
      assert(res.body.breakup.basicDaMonthlyMinor === previewBasic, `onboard Basic+DA == preview Basic+DA (₹${(previewBasic / 100).toFixed(2)})`);
    }

    // Preview must REFUSE a GROSS basis on an IN tenant being saved (single-source).
    {
      const res = await callController(policyCtl.create, {
        user: op,
        body: {
          code: `${PREFIX}-GROSSBAD`, name: 'Gross bad', basis: 'GROSS',
          lines: [
            { componentId: cBasic.id, calcMethod: 'PERCENT_OF', pct: 50, baseCode: 'CTC', sortOrder: 0 },
            { componentId: cSpecial.id, calcMethod: 'BALANCING', sortOrder: 1 },
          ],
        },
      });
      assert(res.statusCode === 422 && res.body.error === 'BASIS_NOT_ALLOWED', `IN policy with basis:GROSS rejected → 422 BASIS_NOT_ALLOWED (got ${res.statusCode}/${res.body && res.body.error})`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // L1 (LOW) — ESI parity: onboard (ESI-less policy) == ATS shared-default helper.
    // ════════════════════════════════════════════════════════════════════════
    log('\nL1 — ESI/PF parity (onboard == ATS shared defaults):');
    {
      assert(HIRE_ESI_DEFAULT === false && HIRE_PF_CAP_DEFAULT === true, 'shared hire defaults are esi=false / capPf=true');
      const doj = futureDoj();
      const res = await callController(onboardCtl.byCtc, {
        user: op,
        body: { person: { firstName: 'Esi', lastName: 'Parity', code: `${PREFIX}-L1`, entityId: entity.id }, policyId, ctcAnnual: CTC, dateOfJoining: doj },
      });
      assert(res.statusCode === 201, `onboard → 201 (got ${res.statusCode})`);
      const rev = await prisma.compensationRevision.findFirst({ where: { businessId, employeeId: res.body.employee.id }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
      const got = (rev.lines || []).map((l) => `${l.componentId}|${l.calcMethod}|${Number(l.amountMonthly).toFixed(2)}`).sort();
      // ATS path: same policy compiled via the shared helper sourcing the SHARED defaults.
      let expected;
      await prisma.$transaction(async (tx) => {
        expected = await buildHireRevisionLines({ tx, businessId, countryCode: 'IN', policyId, ctcAnnual: CTC, joinDate: new Date(doj) });
      });
      const exp = (expected.lineCreates || []).map((l) => `${l.componentId}|${l.calcMethod}|${Number(l.amountMonthly).toFixed(2)}`).sort();
      assert(JSON.stringify(got) === JSON.stringify(exp), 'onboard (policy esi-less) lines BYTE-IDENTICAL to ATS shared-default helper');
    }

    // ════════════════════════════════════════════════════════════════════════
    // M1 (MED) — soft-deleted component → compile ERROR (no silent drop / under-alloc).
    // ════════════════════════════════════════════════════════════════════════
    log('\nM1 — soft-deleted component → compile error (reconciles to full CTC):');
    {
      // Pure-lib: dropping the BALANCING (SPECIAL) component throws, not under-allocates.
      const pol = await prisma.ctcPolicy.findFirst({ where: { id: policyId }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
      const compsMinusSpecial = await prisma.salaryComponent.findMany({ where: { businessId, code: { startsWith: PREFIX }, NOT: { id: cSpecial.id } } });
      let threw = null;
      try { compilePolicyToStructureLines(pol, { components: compsMinusSpecial }); } catch (e) { threw = e; }
      assert(threw instanceof CompilePolicyError, 'compilePolicyToStructureLines THROWS CompilePolicyError on a missing component (no silent drop)');

      // Compiling WITH all components reconciles: compiled-line-count == policy-line-count.
      const compsAll = await prisma.salaryComponent.findMany({ where: { businessId, code: { startsWith: PREFIX } } });
      const compiled = compilePolicyToStructureLines(pol, { components: compsAll });
      assert(compiled.lines.length === pol.lines.length, `compiled line count (${compiled.lines.length}) == policy line count (${pol.lines.length})`);
    }
    // End-to-end: soft-delete SPECIAL, then onboard & preview must FAIL CLOSED.
    {
      await prisma.salaryComponent.update({ where: { id: cSpecial.id }, data: { deletedAt: new Date() } });
      const onb = await callController(onboardCtl.byCtc, {
        user: op,
        body: { person: { firstName: 'Soft', lastName: 'Deleted', code: `${PREFIX}-M1`, entityId: entity.id }, policyId, ctcAnnual: CTC, dateOfJoining: futureDoj() },
      });
      assert(onb.statusCode === 422, `onboard with soft-deleted SPECIAL → 422 (got ${onb.statusCode} ${onb.body && onb.body.error})`);
      const leaked = await prisma.employee.findFirst({ where: { businessId, code: `${PREFIX}-M1` } });
      assert(!leaked, 'NO employee written when a policy component is soft-deleted (fail-closed)');

      const prev = await callController((req, r, n) => policyCtl.preview({ ...req, params: { id: policyId } }, r, n), { user: op, params: { id: policyId }, body: { ctcAnnual: CTC, asOf: futureDoj() } });
      assert(prev.statusCode === 422 && prev.body.error === 'POLICY_UNRESOLVED', `preview with soft-deleted SPECIAL → 422 POLICY_UNRESOLVED (got ${prev.statusCode}/${prev.body && prev.body.error})`);
      // Restore SPECIAL for the remaining tests.
      await prisma.salaryComponent.update({ where: { id: cSpecial.id }, data: { deletedAt: null } });
    }

    // ════════════════════════════════════════════════════════════════════════
    // H2 (HIGH) — null-email idempotency: no key → 400; with code → sequential 409.
    // ════════════════════════════════════════════════════════════════════════
    log('\nH2 — null-email hire requires a stable key + sequential retry is idempotent:');
    {
      const res = await callController(onboardCtl.byCtc, {
        user: op,
        body: { person: { firstName: 'No', lastName: 'Key', entityId: entity.id }, policyId, ctcAnnual: CTC, dateOfJoining: futureDoj() },
      });
      assert(res.statusCode === 400 && res.body.error === 'IDEMPOTENCY_KEY_REQUIRED', `null-email + no code/key → 400 IDEMPOTENCY_KEY_REQUIRED (got ${res.statusCode}/${res.body && res.body.error})`);
    }
    {
      const body = { person: { firstName: 'Null', lastName: 'Email', code: `${PREFIX}-NULLEMAIL`, entityId: entity.id }, policyId, ctcAnnual: CTC, dateOfJoining: futureDoj() };
      const r1 = await callController(onboardCtl.byCtc, { user: op, body });
      const r2 = await callController(onboardCtl.byCtc, { user: op, body });
      assert(r1.statusCode === 201 && r2.statusCode === 409 && r2.body.error === 'ALREADY_ONBOARDED', `null-email + code: first 201, retry 409 ALREADY_ONBOARDED (got ${r1.statusCode}/${r2.statusCode})`);
      const cnt = await prisma.employee.count({ where: { businessId, code: `${PREFIX}-NULLEMAIL` } });
      assert(cnt === 1, `exactly ONE employee for the null-email+code retry (got ${cnt})`);
    }
    // idempotencyKey (no code) path also dedupes.
    {
      const body = { person: { firstName: 'Idem', lastName: 'Body', entityId: entity.id }, policyId, ctcAnnual: CTC, dateOfJoining: futureDoj(), idempotencyKey: `${PREFIX}-IDEMKEY` };
      const r1 = await callController(onboardCtl.byCtc, { user: op, body });
      const r2 = await callController(onboardCtl.byCtc, { user: op, body });
      assert(r1.statusCode === 201 && r2.statusCode === 409, `null-email + idempotencyKey: first 201, retry 409 (got ${r1.statusCode}/${r2.statusCode})`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // H1 (HIGH) — CONCURRENT identical onboards (same email+DOJ) → ONE employee.
    // ════════════════════════════════════════════════════════════════════════
    log('\nH1 — concurrent onboard (same email+DOJ) → exactly ONE employee:');
    {
      const sharedEmail = `${PREFIX.toLowerCase()}-race@x.com`;
      const doj = futureDoj();
      const mk = () => callController(onboardCtl.byCtc, {
        user: op,
        // Distinct codes so the ONLY collision is on the email+DOJ partial-unique.
        body: { person: { firstName: 'Race', lastName: 'Cond', email: sharedEmail, entityId: entity.id }, policyId, ctcAnnual: CTC, dateOfJoining: doj },
      });
      const [a, b] = await Promise.all([mk(), mk()]);
      const codes = [a.statusCode, b.statusCode].sort();
      assert(codes[0] === 201 && codes[1] === 409, `concurrent: one 201 + one 409 (got ${a.statusCode}/${b.statusCode})`);
      const loser = a.statusCode === 409 ? a : b;
      assert(loser.body && loser.body.error === 'ALREADY_ONBOARDED', `the losing concurrent request → ALREADY_ONBOARDED (got ${loser.body && loser.body.error})`);
      const cnt = await prisma.employee.count({ where: { businessId, deletedAt: null, workEmail: sharedEmail, hireDate: new Date(doj + 'T00:00:00.000Z') } });
      assert(cnt === 1, `exactly ONE employee for the concurrent email+DOJ (got ${cnt})`);
      const revCnt = await prisma.compensationRevision.count({ where: { businessId, employee: { workEmail: sharedEmail } } });
      assert(revCnt === 1, `exactly ONE HIRE revision (no duplicate pay) (got ${revCnt})`);
    }
  } finally {
    await cleanup(prisma, businessId);
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — Feature 17 review fixes\n`);
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
