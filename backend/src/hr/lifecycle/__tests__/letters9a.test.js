'use strict';

/**
 * letters9a.test.js — Feature 9 (Letters & Communication) Slice 9A proof.
 *
 * Plain-node runner (no jest), mirroring the F4 lifecycle test harness.
 *   PART A (DB-FREE) — RBAC: effectivePermissions for an HR-Admin role shows
 *     canManageLetters:true; a Manager shows it absent. PERMISSIONS registry +
 *     SYSTEM_ROLES grant wiring.
 *   PART B (LIVE hr_test) — the schema + ref-no plumbing:
 *     B1  allocateCode LETTER scope → LTR-0001, increments atomically on repeat,
 *         a different periodKey resets to LTR-0001 (yearly reset via periodKey).
 *     B2  the lifecycle scopes (ONBOARD/OFFBOARD/SEP) that pass NO periodKey still
 *         allocate against the single (…, periodKey:null) row — no regression.
 *     B3  partial-unique uniq_letterhead_default rejects a 2nd isDefault letterhead
 *         for the same (businessId, entityId).
 *     B4  partial-unique uniq_letterhead_category rejects a 2nd letterhead for the
 *         same (businessId, entityId, letterCategory).
 *
 * Run (PART B needs the live schema):
 *   DATABASE_URL="$HR_URL" node src/hr/lifecycle/__tests__/letters9a.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

const { allocateCode, SCOPE_DEFAULTS } = require('../lib/codes');
const {
  PERMISSIONS, PERMISSION_KEYS, SYSTEM_ROLES, effectivePermissions,
} = require('../../../core/lib/rbac');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}

// ═══════════════════════════════════════════════════════════════════════════
// PART A — RBAC (pure, no DB)
// ═══════════════════════════════════════════════════════════════════════════
function partA() {
  log('\n=== PART A — RBAC canManageLetters (pure, DB-free) ===\n');

  // A1: the key is registered + the maker key still present alongside it.
  assert('canManageLetters' in PERMISSIONS, 'canManageLetters registered in PERMISSIONS');
  assert(PERMISSION_KEYS.includes('canManageLetters'), 'canManageLetters in PERMISSION_KEYS (validatePermissions accepts it)');
  assert('canGenerateLetters' in PERMISSIONS, 'canGenerateLetters (maker key) still present');

  // A2: HR-Admin gets both the maker (canGenerateLetters) + checker (canManageLetters).
  assert(SYSTEM_ROLES['HR-Admin'].canManageLetters === true, 'SYSTEM_ROLES[HR-Admin].canManageLetters = true');
  assert(SYSTEM_ROLES['HR-Admin'].canGenerateLetters === true, 'SYSTEM_ROLES[HR-Admin].canGenerateLetters = true (unchanged)');

  // A3: Owner inherits (all-true). Finance/Manager get neither.
  assert(SYSTEM_ROLES.Owner.canManageLetters === true, 'Owner inherits canManageLetters (all-true)');
  assert(SYSTEM_ROLES.Manager.canManageLetters === undefined, 'Manager: canManageLetters absent');
  assert(SYSTEM_ROLES.Finance.canManageLetters === undefined, 'Finance: canManageLetters absent');

  // A4: effectivePermissions for an assigned BusinessRole resolves the grant.
  const hrAdminUser = { role: 'STAFF', businessRole: { name: 'HR-Admin', permissions: SYSTEM_ROLES['HR-Admin'] } };
  const managerUser = { role: 'STAFF', businessRole: { name: 'Manager', permissions: SYSTEM_ROLES.Manager } };
  assert(effectivePermissions(hrAdminUser).canManageLetters === true,
    'effectivePermissions(HR-Admin role) → canManageLetters:true');
  assert(!effectivePermissions(managerUser).canManageLetters,
    'effectivePermissions(Manager role) → canManageLetters absent/falsey');

  // A5: SCOPE_DEFAULTS carries LETTER (prefix LTR-, padding 4); lifecycle scopes intact.
  assert(SCOPE_DEFAULTS.LETTER && SCOPE_DEFAULTS.LETTER.prefix === 'LTR-' && SCOPE_DEFAULTS.LETTER.padding === 4,
    'SCOPE_DEFAULTS.LETTER = { prefix:"LTR-", padding:4 }');
  assert(SCOPE_DEFAULTS.ONBOARD.prefix === 'ONB-' && SCOPE_DEFAULTS.OFFBOARD.prefix === 'OFB-' && SCOPE_DEFAULTS.SEP.prefix === 'SEP-',
    'lifecycle scopes (ONBOARD/OFFBOARD/SEP) unchanged in SCOPE_DEFAULTS');
}

// ═══════════════════════════════════════════════════════════════════════════
// PART B — LIVE hr_test (ref-no plumbing + partial-unique invariants)
// ═══════════════════════════════════════════════════════════════════════════
async function partB() {
  log('\n=== PART B — LIVE hr_test (allocateCode LETTER + partial uniques) ===\n');

  const prisma = require('../../../core/lib/prisma');

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  const entity = await prisma.entity.findFirst({ where: { businessId } });
  const entityId = entity ? entity.id : null;

  const PK_A = '2026-27';
  const PK_B = '2027-28';
  const LH_PREFIX = 'LTRTEST9A';

  async function cleanup() {
    // NumberSequence rows minted by this test (LETTER scope, our test periodKeys,
    // plus the no-periodKey regression scope).
    await prisma.numberSequence.deleteMany({
      where: { businessId, scope: 'LETTER', periodKey: { in: [PK_A, PK_B] } },
    });
    await prisma.numberSequence.deleteMany({
      where: { businessId, scope: `${LH_PREFIX}-LIFECYCLE`, periodKey: null },
    });
    // Letterhead fixtures.
    await prisma.companyLetterhead.deleteMany({ where: { businessId, code: { startsWith: LH_PREFIX } } });
  }

  await cleanup();

  try {
    // ── B1: allocateCode LETTER scope — format, atomic increment, yearly reset ──
    log('B1) allocateCode LETTER: LTR-0001 → increments → resets across periodKey:');
    {
      const c1 = await prisma.$transaction((tx) =>
        allocateCode(tx, { businessId, entityId, scope: 'LETTER', periodKey: PK_A }));
      assert(c1 === 'LTR-0001', `first LETTER code is LTR-0001 (got ${c1})`);

      const c2 = await prisma.$transaction((tx) =>
        allocateCode(tx, { businessId, entityId, scope: 'LETTER', periodKey: PK_A }));
      assert(c2 === 'LTR-0002', `second LETTER code increments atomically to LTR-0002 (got ${c2})`);

      const c3 = await prisma.$transaction((tx) =>
        allocateCode(tx, { businessId, entityId, scope: 'LETTER', periodKey: PK_A }));
      assert(c3 === 'LTR-0003', `third LETTER code → LTR-0003 (got ${c3})`);

      // A DIFFERENT periodKey resets the count → LTR-0001 (yearly reset).
      const reset = await prisma.$transaction((tx) =>
        allocateCode(tx, { businessId, entityId, scope: 'LETTER', periodKey: PK_B }));
      assert(reset === 'LTR-0001', `a different periodKey resets to LTR-0001 (got ${reset})`);

      // Exactly two distinct NumberSequence rows exist (one per periodKey); the
      // PK_A row's nextValue advanced to 4, PK_B's to 2.
      const rows = await prisma.numberSequence.findMany({
        where: { businessId, scope: 'LETTER', periodKey: { in: [PK_A, PK_B] } },
        orderBy: { periodKey: 'asc' },
      });
      assert(rows.length === 2, `two LETTER NumberSequence rows (one per periodKey) (got ${rows.length})`);
      const byPk = Object.fromEntries(rows.map((r) => [r.periodKey, r]));
      assert(byPk[PK_A].nextValue === 4, `PK_A row nextValue advanced to 4 after 3 allocations (got ${byPk[PK_A].nextValue})`);
      assert(byPk[PK_B].nextValue === 2, `PK_B row nextValue advanced to 2 after 1 allocation (got ${byPk[PK_B].nextValue})`);
      assert(byPk[PK_A].prefix === 'LTR-' && byPk[PK_A].padding === 4, 'row persisted prefix LTR- + padding 4 from SCOPE_DEFAULTS');
    }

    // ── B2: lifecycle no-periodKey regression — still uses the periodKey:null row ──
    log('B2) no-periodKey allocations target the single (…, periodKey:null) row (lifecycle behaviour):');
    {
      const scope = `${LH_PREFIX}-LIFECYCLE`; // an isolated test scope so we never touch real ONB/OFB/SEP rows
      const r1 = await prisma.$transaction((tx) =>
        allocateCode(tx, { businessId, entityId, scope, prefix: 'XX-', padding: 6 }));
      const r2 = await prisma.$transaction((tx) =>
        allocateCode(tx, { businessId, entityId, scope, prefix: 'XX-', padding: 6 }));
      assert(r1 === 'XX-000001' && r2 === 'XX-000002', `no-periodKey scope increments 000001→000002 (got ${r1}, ${r2})`);

      const rows = await prisma.numberSequence.findMany({ where: { businessId, scope } });
      assert(rows.length === 1, `exactly ONE row created for the no-periodKey scope (got ${rows.length})`);
      assert(rows[0].periodKey === null, 'that row has periodKey = null (lifecycle-compatible)');
    }

    // ── B3: partial-unique uniq_letterhead_default — one default per (tenant, entity) ──
    log('B3) uniq_letterhead_default rejects a 2nd isDefault letterhead for same (businessId, entityId):');
    {
      const base = (suffix, extra) => ({
        businessId, entityId, code: `${LH_PREFIX}-${suffix}`, name: `LH ${suffix}`,
        fileUrl: 'inline://test', layoutJson: {}, ...extra,
      });
      const lh1 = await prisma.companyLetterhead.create({ data: base('DEF1', { isDefault: true }) });
      assert(!!lh1.id, 'first isDefault letterhead created');

      let rejected = false;
      try {
        await prisma.companyLetterhead.create({ data: base('DEF2', { isDefault: true }) });
      } catch (e) {
        rejected = (e && (e.code === 'P2002' || /uniq_letterhead_default|unique/i.test(e.message)));
      }
      assert(rejected, 'a 2nd isDefault letterhead (same businessId, entityId) is rejected by uniq_letterhead_default');

      // A non-default second letterhead is fine (the partial filter only bites isDefault).
      const lh3 = await prisma.companyLetterhead.create({ data: base('NONDEF', { isDefault: false }) });
      assert(!!lh3.id, 'a non-default 2nd letterhead is allowed (partial filter scoped to isDefault)');

      // Soft-deleting the first default frees the slot (the WHERE deletedAt IS NULL clause).
      await prisma.companyLetterhead.update({ where: { id: lh1.id }, data: { deletedAt: new Date() } });
      const lh4 = await prisma.companyLetterhead.create({ data: base('DEF3', { isDefault: true }) });
      assert(!!lh4.id, 'after soft-deleting the prior default, a new default is allowed (deletedAt IS NULL partial)');
    }

    // ── B4: partial-unique uniq_letterhead_category — one per category per (tenant, entity) ──
    log('B4) uniq_letterhead_category rejects a 2nd letterhead for same letterCategory:');
    {
      const base = (suffix, extra) => ({
        businessId, entityId, code: `${LH_PREFIX}-${suffix}`, name: `LH ${suffix}`,
        fileUrl: 'inline://test', layoutJson: {}, ...extra,
      });
      const cat1 = await prisma.companyLetterhead.create({ data: base('CATEXP1', { letterCategory: 'EXPERIENCE' }) });
      assert(!!cat1.id, 'first EXPERIENCE-bound letterhead created');

      let rejected = false;
      try {
        await prisma.companyLetterhead.create({ data: base('CATEXP2', { letterCategory: 'EXPERIENCE' }) });
      } catch (e) {
        rejected = (e && (e.code === 'P2002' || /uniq_letterhead_category|unique/i.test(e.message)));
      }
      assert(rejected, 'a 2nd letterhead bound to EXPERIENCE (same businessId, entityId) is rejected');

      // A DIFFERENT category is fine.
      const cat2 = await prisma.companyLetterhead.create({ data: base('CATBONA', { letterCategory: 'BONAFIDE' }) });
      assert(!!cat2.id, 'a different category (BONAFIDE) is allowed');

      // NULL category rows are NOT constrained (the WHERE letterCategory IS NOT NULL clause).
      const nullCatA = await prisma.companyLetterhead.create({ data: base('NULLCATA', { letterCategory: null }) });
      const nullCatB = await prisma.companyLetterhead.create({ data: base('NULLCATB', { letterCategory: null }) });
      assert(!!nullCatA.id && !!nullCatB.id, 'multiple NULL-category letterheads allowed (partial filter excludes NULL)');
    }
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

// ── runner ──
async function main() {
  partA();
  if (!process.env.DATABASE_URL) {
    log('\n[skip] PART B — DATABASE_URL not set (pure RBAC PART A ran DB-free).\n');
  } else {
    try {
      await partB();
    } catch (e) {
      failures += 1;
      log(`  FAIL  PART B threw: ${e && e.stack ? e.stack : e}`);
    }
  }
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
