'use strict';

/**
 * expenses.hardening.live.test.js — Feature 11 review fixes (LIVE hr_test).
 *
 * Proves the two CONFIRMED findings are closed:
 *
 *  (1) HIGH — HARD caps were bypassable via attacker-controlled nights / distanceKm /
 *      durationBand. The cap-driving dimensions are now derived/bounded SERVER-SIDE from
 *      the trip, so a crafted over-hard-cap bill can NEVER be pushed into the chain:
 *        • inflated `nights` (>> trip duration) → REJECTED on add (400)
 *        • inflated `distanceKm` (> sane max) → REJECTED on add (400)
 *        • a `durationBand` more generous than the trip's real duration → REJECTED on add
 *        • the SERVER-derived band wins (a HALF_DAY trip can never claim a FULL_24H per-diem)
 *        • submit RE-DERIVES (never re-trusts) the persisted dims → a line that slipped past
 *          (forced into the DB) is treated as a HARD blocker and BLOCKS submit
 *
 *  (2) MEDIUM — claimNumber had no DB unique. A unique index on (businessId, claimNumber)
 *      now backstops both minters and a row-locked (FOR UPDATE) minter serializes
 *      concurrent ESS creates; concurrent creates can no longer persist a duplicate EXP-####.
 *
 * Plain-node + fake-res harness (same as expenses.flow.live.test.js).
 * Run: DATABASE_URL="$HR_URL" node src/hr/expenses/__tests__/expenses.hardening.live.test.js
 */

const prisma = require('../../../core/lib/prisma');
const me = require('../meExpenses.controller');
const service = require('../expenses.service');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { this.body = this.body || {}; return this; },
  };
}
function call(handler, req) {
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

const PREFIX = 'F11HARD';

async function cleanup(businessId) {
  await prisma.approvalAction.deleteMany({ where: { businessId, approvalRequest: { entityType: { in: ['ExpenseClaim', 'TravelRequest'] }, requester: { code: { startsWith: PREFIX } } } } }).catch(() => {});
  await prisma.approvalRequest.deleteMany({ where: { businessId, requester: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.expenseClaimLine.deleteMany({ where: { businessId, claim: { employee: { code: { startsWith: PREFIX } } } } }).catch(() => {});
  await prisma.expenseClaim.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.travelRequest.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.travelTransportRule.deleteMany({ where: { businessId, policy: { name: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.travelHotelRule.deleteMany({ where: { businessId, policy: { name: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.travelPerDiemRule.deleteMany({ where: { businessId, policy: { name: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.travelPolicy.deleteMany({ where: { businessId, name: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.expenseCategory.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.grade.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.employmentRecord.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null, currentEmploymentRecordId: null } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { businessId, email: { startsWith: PREFIX.toLowerCase() } } });
}

let seq = 0;
let ENTITY_ID = null;
async function mkUserEmp(businessId, name, { gradeId = null } = {}) {
  seq += 1;
  const email = `${PREFIX.toLowerCase()}-${seq}-${Date.now()}@t.test`;
  const user = await prisma.user.create({ data: { businessId, email, password: 'x', name, role: 'USER', isActive: true } });
  const emp = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-${seq}`, firstName: name, lastName: 'T', status: 'ACTIVE', isActive: true, userId: user.id, workEmail: email, hireDate: new Date('2020-01-01') },
  });
  if (gradeId) {
    await prisma.employmentRecord.create({
      data: {
        business: { connect: { id: businessId } },
        entity: { connect: { id: ENTITY_ID } },
        employee: { connect: { id: emp.id } },
        gradeId,
        isCurrent: true, employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE', effectiveFrom: new Date('2020-01-01'),
      },
    });
  }
  return { user, emp, email };
}

async function main() {
  log('\n=== Feature 11 hardening proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const ent = await prisma.entity.findFirst({ where: { businessId }, select: { id: true } });
  ENTITY_ID = ent ? ent.id : null;
  await cleanup(businessId);

  try {
    const grade = await prisma.grade.create({ data: { businessId, code: `${PREFIX}-G3`, name: 'L3', rank: 3 } });
    const ic = await mkUserEmp(businessId, 'Ic', { gradeId: grade.id });
    const cat = await prisma.expenseCategory.create({ data: { businessId, code: `${PREFIX}-TRV`, name: 'Travel' } });
    const icCustomer = { customer: { businessId, email: ic.email }, body: {}, query: {}, params: {} };

    // A HARD policy: hotel L3 TIER_1 cap 5000/night; per-diem FULL_24H food+incidentals 2000
    // (so a single-day trip can't sneak a FULL_24H per-diem). Self-car perKmRate 10/km.
    const policy = await prisma.travelPolicy.create({
      data: {
        businessId, name: `${PREFIX} IN policy`, countryCode: 'IN', currencyCode: 'INR', isActive: true,
        effectiveFrom: new Date('2026-01-01'), defaultTier: 'TIER_3', enforcement: 'HARD',
        hotelRules: { create: [{ businessId, gradeRank: 3, cityTier: 'TIER_1', nightlyCap: '5000' }] },
        perDiemRules: { create: [
          { businessId, durationBand: 'FULL_24H', gradeRank: 3, cityTier: 'TIER_1', foodCap: '1500', incidentalCap: '500' }, // cap 2000
          { businessId, durationBand: 'HALF_DAY', gradeRank: 3, cityTier: 'TIER_1', foodCap: '600', incidentalCap: '200' },   // cap 800
        ] },
        transportRules: { create: [{ businessId, mode: 'SELF_CAR', gradeRank: 3, allowed: true, perKmRate: '10' }] },
      },
    });
    await prisma.cityTier.upsert({ where: { businessId_countryCode_city: { businessId, countryCode: 'IN', city: 'mumbai' } }, update: { tier: 'TIER_1' }, create: { businessId, countryCode: 'IN', city: 'mumbai', tier: 'TIER_1' } });

    // A SHORT trip: 4 hours (HALF_DAY band, max 1 night).
    const trip = await call(me.createTrip, { ...icCustomer, body: { purpose: 'Mumbai day', destCity: 'Mumbai', startAt: '2026-09-01T09:00:00Z', endAt: '2026-09-01T13:00:00Z' } });
    const tripId = trip.body.id;
    assert(trip.statusCode === 201 && trip.body.durationHours === 4, `short trip created (4h, got ${trip.body && trip.body.durationHours}h)`);

    // ── (1a) INFLATED nights → REJECTED on add (cannot make a huge hotel bill "within policy") ──
    log('(1a) inflated nights over a 4h trip → REJECTED at add:');
    {
      const billClaim = await call(me.createClaim, { ...icCustomer, body: { travelRequestId: tripId } });
      const claimId = billClaim.body.id;
      // ATTACK: 100000 hotel with nights:1000 → cap would be 5000*1000 = 5,000,000 >> amount.
      const line = await call(me.addLine, { ...icCustomer, body: { amount: 100000, nights: 1000, description: 'Hotel inflated' }, params: { id: claimId } });
      assert(line.statusCode === 400 && line.body.reason === 'POLICY_DIMENSION_INVALID', `inflated nights REJECTED on add (got ${line.statusCode}/${line.body && line.body.reason})`);
      const persisted = await prisma.expenseClaimLine.count({ where: { claimId } });
      assert(persisted === 0, `the over-cap line was NOT persisted (lines=${persisted})`);
    }

    // ── (1b) INFLATED distanceKm → REJECTED on add (mileage cap = perKmRate × distanceKm) ──
    log('(1b) inflated distanceKm → REJECTED at add:');
    {
      const billClaim = await call(me.createClaim, { ...icCustomer, body: { travelRequestId: tripId } });
      const claimId = billClaim.body.id;
      // ATTACK: 100000 self-drive with distanceKm:99999 → cap 10*99999 = 999,990 >> amount.
      const line = await call(me.addLine, { ...icCustomer, body: { amount: 100000, transportMode: 'SELF_CAR', distanceKm: 99999, description: 'Mileage inflated' }, params: { id: claimId } });
      assert(line.statusCode === 400 && line.body.reason === 'POLICY_DIMENSION_INVALID', `inflated distanceKm REJECTED on add (got ${line.statusCode}/${line.body && line.body.reason})`);
    }

    // ── (1c) durationBand more generous than the trip → REJECTED; SERVER-derived band wins ──
    log('(1c) FULL_24H per-diem on a 4h trip → REJECTED (server-derived band wins):');
    {
      const billClaim = await call(me.createClaim, { ...icCustomer, body: { travelRequestId: tripId } });
      const claimId = billClaim.body.id;
      // ATTACK: pick FULL_24H (cap 2000) on a 4h trip to bill 1800 food that would BUST the
      // real HALF_DAY cap (800). The band is rejected outright (more generous than the trip).
      const line = await call(me.addLine, { ...icCustomer, body: { amount: 1800, durationBand: 'FULL_24H', description: 'Per-diem inflated band' }, params: { id: claimId } });
      assert(line.statusCode === 400 && line.body.reason === 'POLICY_DIMENSION_INVALID', `FULL_24H band over a 4h trip REJECTED (got ${line.statusCode}/${line.body && line.body.reason})`);

      // And the LEGITIMATE band (HALF_DAY) over its real cap is correctly AUTO_REJECTED under HARD.
      const legit = await call(me.addLine, { ...icCustomer, body: { amount: 1800, durationBand: 'HALF_DAY', description: 'Per-diem over real cap' }, params: { id: claimId } });
      assert(legit.statusCode === 201 && legit.body.verdict.verdict === 'AUTO_REJECTED', `HALF_DAY per-diem 1800 > real cap 800 → AUTO_REJECTED (got ${legit.statusCode}/${legit.body && legit.body.verdict && legit.body.verdict.verdict})`);
    }

    // ── (1d) submit RE-DERIVES persisted dims → a force-persisted over-cap line BLOCKS submit ──
    log('(1d) a force-persisted inflated line is RE-DERIVED at submit and BLOCKS it:');
    {
      const billClaim = await call(me.createClaim, { ...icCustomer, body: { travelRequestId: tripId } });
      const claimId = billClaim.body.id;
      // Simulate a line that bypassed add (e.g. legacy data / trip shortened after add):
      // write a hotel line with nights:50 + a tiny appliedCap so it reads "within policy".
      await prisma.expenseClaimLine.create({
        data: {
          businessId, claimId, description: 'Smuggled hotel', amount: '100000', nights: 50,
          policyStatus: 'OK', policyReason: 'forced OK', appliedCap: '250000',
        },
      });
      const sub = await call(me.submitClaim, { ...icCustomer, params: { id: claimId } });
      assert(sub.statusCode === 400 && sub.body.reason === 'POLICY_HARD_BLOCK', `submit re-derives and BLOCKS the smuggled over-cap line (got ${sub.statusCode}/${sub.body && sub.body.reason})`);
      const claimRow = await prisma.expenseClaim.findUnique({ where: { id: claimId } });
      assert(claimRow.status === 'DRAFT', `claim stays DRAFT (never entered the chain; got ${claimRow.status})`);
    }

    // ── (1e) a WITHIN-policy line still flows (no false positives) ──
    log('(1e) a within-policy hotel (1 night, under cap) still submits:');
    {
      const billClaim = await call(me.createClaim, { ...icCustomer, body: { travelRequestId: tripId } });
      const claimId = billClaim.body.id;
      const line = await call(me.addLine, { ...icCustomer, body: { amount: 4000, nights: 1, description: 'Hotel ok' }, params: { id: claimId } });
      assert(line.statusCode === 201 && line.body.verdict.verdict === 'OK', `4000/night hotel under 5000 cap → OK (got ${line.statusCode}/${line.body && line.body.verdict && line.body.verdict.verdict})`);
      const sub = await call(me.submitClaim, { ...icCustomer, params: { id: claimId } });
      assert(sub.statusCode === 200 && sub.body.status === 'SUBMITTED', `within-policy claim submits (got ${sub.statusCode}/${sub.body && sub.body.status})`);
    }

    // ── (2) claimNumber uniqueness: DB partial-unique rejects a duplicate; minter is collision-safe ──
    log('(2) claimNumber partial-unique backstop + collision-safe minter:');
    {
      // a) the per-tenant unique index on (businessId, claimNumber) exists (matches Prisma's
      //    @@unique; non-partial — Postgres treats NULLs as distinct so NULL rows coexist).
      const [{ indexdef }] = await prisma.$queryRawUnsafe(
        "SELECT indexdef FROM pg_indexes WHERE schemaname='hr_test' AND tablename='ExpenseClaim' AND indexname='ExpenseClaim_businessId_claimNumber_key'",
      );
      assert(/UNIQUE/i.test(indexdef) && /businessId/i.test(indexdef) && /claimNumber/i.test(indexdef), `UNIQUE (businessId, claimNumber) index present (${indexdef ? 'ok' : 'missing'})`);

      // b) a direct duplicate insert is rejected by the DB (P2002)
      const first = await prisma.expenseClaim.findFirst({ where: { businessId, employee: { code: { startsWith: PREFIX } } }, select: { claimNumber: true, employeeId: true } });
      let dupRejected = false;
      try {
        await prisma.expenseClaim.create({ data: { businessId, employeeId: first.employeeId, status: 'DRAFT', claimNumber: first.claimNumber, amount: '0', currencyCode: 'INR' } });
      } catch (e) { dupRejected = e.code === 'P2002'; }
      assert(dupRejected, `direct duplicate (businessId, claimNumber) rejected by DB P2002 (got rejected=${dupRejected})`);

      // c) many NULL claimNumbers coexist (Postgres treats NULLs as distinct in the unique)
      await prisma.expenseClaim.create({ data: { businessId, employeeId: first.employeeId, status: 'DRAFT', claimNumber: null, amount: '0', currencyCode: 'INR' } });
      await prisma.expenseClaim.create({ data: { businessId, employeeId: first.employeeId, status: 'DRAFT', claimNumber: null, amount: '0', currencyCode: 'INR' } });
      assert(true, 'multiple NULL claimNumbers coexist under the unique index');

      // d) concurrent createClaim calls mint DISTINCT EXP-#### (no collision under race)
      const N = 12;
      const results = await Promise.all(Array.from({ length: N }, () => call(me.createClaim, { ...icCustomer, body: {} })));
      const created = results.filter((r) => r.statusCode === 201).map((r) => r.body.claimNumber);
      const uniq = new Set(created);
      assert(created.length === N, `all ${N} concurrent creates succeeded (got ${created.length})`);
      assert(uniq.size === created.length, `every concurrently-minted claimNumber is UNIQUE (got ${uniq.size} distinct of ${created.length})`);
      assert(created.every((c) => /^EXP-\d{4,}$/.test(c)), 'all minted ids are EXP-#### formatted');
    }

  } finally {
    await cleanup(businessId);
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? '=== ALL FEATURE-11 HARDENING CHECKS PASSED ===' : `=== ${failures} CHECK(S) FAILED ===`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
