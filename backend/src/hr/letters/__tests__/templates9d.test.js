'use strict';

/**
 * templates9d.test.js — Feature 9 (Letters) Slice 9D proof: template library
 * controller + IN/NZ system seeds.
 *
 * Plain-node runner (no jest), mirroring letters9a.test.js / the F4 harness.
 *   PART A (DB-FREE) — pure descriptor + merge-field-palette checks:
 *     A1 systemTemplateDescriptors → 6 IN + 6 NZ + 1 CUSTOM, stable codes.
 *     A2 every seed body token is a real catalog token; statutory wording present
 *        (IN "TO WHOMSOEVER IT MAY CONCERN" + CTC/PF/UAN/PAN; NZ IRD/KiwiSaver/
 *        Holidays Act / NZBN).
 *     A3 listMergeFields palette is grouped + country-filtered (IN drops NZ-only,
 *        NZ drops IN-only); unknown country/category → 422.
 *   PART B (LIVE hr_test) — the controller against the real schema, tenant-scoped:
 *     B1 create (DRAFT) → get → list (tenant-scoped) under canManageLetters.
 *     B2 update bumps version.
 *     B3 publish (isActive=true) / archive (isActive=false).
 *     B4 cross-tenant id → 404 (tenant isolation).
 *     B5 isSystem row is NON-deletable (seed first) → 409; a custom row deletes (soft).
 *     B6 seedLetterTemplates is idempotent (re-run → same row ids, count stable)
 *        and creates IN+NZ variants.
 *
 * Run (PART B needs the live schema):
 *   DATABASE_URL="$HR_URL" node src/hr/letters/__tests__/templates9d.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

const ctrl = require('../controllers/templates.controller');
const seed = require('../templates/seed');
const { CATALOG } = require('../mergeFields');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}

// ── tiny mock req/res so we can drive the controller without an HTTP server ───
function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
async function call(handler, { user, params, query, body } = {}) {
  const req = { user: user || {}, params: params || {}, query: query || {}, body: body || {} };
  const res = mockRes();
  await handler(req, res);
  return res;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART A — pure (no DB): seed descriptors + merge-field palette
// ═══════════════════════════════════════════════════════════════════════════
async function partA() {
  log('\n=== PART A — seed descriptors + merge-field palette (DB-free) ===\n');

  const ds = seed.systemTemplateDescriptors();
  // A1: counts + stable codes.
  const inV = ds.filter((d) => d.countryCode === 'IN');
  const nzV = ds.filter((d) => d.countryCode === 'NZ');
  const custom = ds.filter((d) => d.category === 'CUSTOM');
  assert(inV.length === 6, `6 IN system variants (got ${inV.length})`);
  assert(nzV.length === 6, `6 NZ system variants (got ${nzV.length})`);
  assert(custom.length === 1 && custom[0].countryCode === null, '1 market-agnostic CUSTOM scaffold');
  const cats = new Set(['EXPERIENCE', 'BONAFIDE', 'EMPLOYMENT_PROOF', 'SALARY_PROOF', 'BANK', 'CONTRACT']);
  assert([...cats].every((c) => inV.some((d) => d.category === c)), 'IN covers all 6 categories');
  assert([...cats].every((c) => nzV.some((d) => d.category === c)), 'NZ covers all 6 categories');
  assert(ds.every((d) => d.isSystem === true), 'every seed descriptor is isSystem:true');
  assert(ds.filter((d) => d.category === 'CONTRACT').every((d) => d.requiresSignature === true),
    'CONTRACT templates requiresSignature:true (e-sign route)');

  // A2: every body token is a real catalog token; statutory wording present.
  let unknown = [];
  for (const d of ds) for (const k of Object.keys(d.mergeFieldsJson || {})) if (!(k in CATALOG)) unknown.push(`${d.code}:${k}`);
  assert(unknown.length === 0, `all seed merge tokens are real catalog tokens (unknown: ${unknown.join(',') || 'none'})`);

  const inExp = inV.find((d) => d.category === 'EXPERIENCE');
  const inSal = inV.find((d) => d.category === 'SALARY_PROOF');
  const inContract = inV.find((d) => d.category === 'CONTRACT');
  assert(/TO WHOMSOEVER IT MAY CONCERN/.test(inExp.bodyMarkdown), 'IN experience uses "To Whomsoever It May Concern"');
  assert(/CTC|cost-to-company/i.test(inSal.bodyMarkdown) && /\{\{comp\.ctcAnnual\}\}/.test(inSal.bodyMarkdown),
    'IN salary proof references CTC + {{comp.ctcAnnual}}');
  assert(/\{\{employee\.uan\}\}/.test(inSal.bodyMarkdown), 'IN salary proof references UAN token');
  assert(/Provident Fund|PF\b/.test(inContract.bodyMarkdown) && /\{\{employee\.uan\}\}|UAN/.test(inContract.bodyMarkdown),
    'IN contract references PF + UAN');

  const nzExp = nzV.find((d) => d.category === 'EXPERIENCE');
  const nzEmp = nzV.find((d) => d.category === 'EMPLOYMENT_PROOF');
  const nzSal = nzV.find((d) => d.category === 'SALARY_PROOF');
  assert(/Holidays Act/.test(nzExp.bodyMarkdown), 'NZ statement of service references the Holidays Act');
  assert(/\{\{employee\.irdNumber\}\}/.test(nzEmp.bodyMarkdown) && /KiwiSaver/i.test(nzEmp.bodyMarkdown),
    'NZ employment proof references IRD number + KiwiSaver');
  assert(/\{\{company\.nzbn\}\}/.test(nzSal.bodyMarkdown), 'NZ salary proof references NZBN');
  // IN templates must NOT carry NZ-only statutory tokens (and vice versa).
  assert(!inV.some((d) => /\{\{employee\.irdNumber\}\}/.test(d.bodyMarkdown)), 'no IN template uses irdNumber (NZ-only)');
  assert(!nzV.some((d) => /\{\{employee\.uan\}\}/.test(d.bodyMarkdown)), 'no NZ template uses UAN (IN-only)');

  // A3: listMergeFields palette — grouped + country-filtered + bad-input guards.
  const all = await call(ctrl.listMergeFields, { user: {}, query: {} });
  assert(all.statusCode === 200 && Array.isArray(all.body.palette), 'GET /merge-fields returns a grouped palette');
  const namespaces = all.body.palette.map((g) => g.namespace).sort();
  assert(['authority', 'comp', 'company', 'date', 'employee', 'letter'].every((n) => namespaces.includes(n)),
    'palette covers employee/comp/company/date/letter/authority namespaces');
  const compGroup = all.body.palette.find((g) => g.namespace === 'comp');
  assert(compGroup.fields.every((f) => f.gatedBy === 'canViewCompensation'),
    'comp.* palette fields are gatedBy canViewCompensation');
  const inPal = await call(ctrl.listMergeFields, { query: { country: 'IN' } });
  const nzPal = await call(ctrl.listMergeFields, { query: { country: 'NZ' } });
  const inTokens = new Set(Object.keys(inPal.body.fields));
  const nzTokens = new Set(Object.keys(nzPal.body.fields));
  assert(!inTokens.has('employee.irdNumber') && inTokens.has('employee.pan'), 'IN palette drops NZ-only, keeps PAN');
  assert(!nzTokens.has('employee.pan') && nzTokens.has('employee.irdNumber'), 'NZ palette drops IN-only, keeps IRD');
  const badCountry = await call(ctrl.listMergeFields, { query: { country: 'XX' } });
  assert(badCountry.statusCode === 422, 'GET /merge-fields?country=XX → 422');
  const badCat = await call(ctrl.listMergeFields, { query: { category: 'NOPE' } });
  assert(badCat.statusCode === 422, 'GET /merge-fields?category=NOPE → 422');
}

// ═══════════════════════════════════════════════════════════════════════════
// PART B — LIVE hr_test (controller CRUD + publish/archive + isolation + seed)
// ═══════════════════════════════════════════════════════════════════════════
async function partB() {
  log('\n=== PART B — LIVE hr_test (controller CRUD + seed idempotency) ===\n');

  const prisma = require('../../../core/lib/prisma');
  // NOTE: hr_test's Business table predates `Business.shortId` (unrelated schema
  // drift in this throwaway schema). We never touch Business in the controller;
  // here we `select:{id:true}` so the test harness doesn't trip the missing column.
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' }, select: { id: true } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  // a 2nd tenant for the isolation check (any other business; create a throwaway).
  const TEST_TAG = 'TPL9DTEST';
  const user = { id: 'tester-9d', businessId };

  // throwaway 2nd tenant
  let other = await prisma.business.findFirst({ where: { slug: 'tpl9d-other' }, select: { id: true } });
  if (!other) {
    other = await prisma.business.create({ data: { name: 'TPL9D Other', slug: 'tpl9d-other' }, select: { id: true } });
  }
  const otherUser = { id: 'tester-9d-other', businessId: other.id };

  async function cleanup() {
    await prisma.letterTemplate.deleteMany({ where: { businessId, code: { startsWith: TEST_TAG } } });
    await prisma.letterTemplate.deleteMany({ where: { businessId: other.id, code: { startsWith: TEST_TAG } } });
  }
  await cleanup();

  try {
    // ── B1: create (DRAFT) → get → list ──
    log('B1) create (DRAFT) → get → list (tenant-scoped):');
    const created = await call(ctrl.createTemplate, {
      user,
      body: {
        code: `${TEST_TAG}-A`, name: 'Test Custom A', category: 'CUSTOM',
        countryCode: 'IN', bodyMarkdown: 'Hello {{employee.name}}, your CTC is {{comp.ctcAnnual}}.',
        mergeFieldsJson: { 'employee.name': { type: 'string' }, 'comp.ctcAnnual': { type: 'money' } },
      },
    });
    assert(created.statusCode === 201 && created.body.id, `created (201) id=${created.body && created.body.id}`);
    assert(created.body.version === 0, 'new template starts at version 0');
    assert(created.body.isActive === false && created.body.status === 'DRAFT', 'new template is DRAFT (not auto-published)');
    const id = created.body.id;

    const got = await call(ctrl.getTemplate, { user, params: { id } });
    assert(got.statusCode === 200 && got.body.id === id, 'GET /:id returns the row');

    const listed = await call(ctrl.listTemplates, { user, query: {} });
    assert(listed.statusCode === 200 && listed.body.items.some((t) => t.id === id), 'list includes the created row');

    // bad create → 422 (invalid category, bad merge token)
    const badCat = await call(ctrl.createTemplate, { user, body: { name: 'X', category: 'NOPE', bodyMarkdown: 'x' } });
    assert(badCat.statusCode === 422, 'create with invalid category → 422');
    const badTok = await call(ctrl.createTemplate, {
      user, body: { name: 'X', category: 'CUSTOM', bodyMarkdown: 'x', code: `${TEST_TAG}-BAD`, mergeFieldsJson: { 'bogus.field': {} } },
    });
    assert(badTok.statusCode === 422, 'create referencing an unknown merge field → 422');

    // ── B2: update bumps version ──
    log('B2) update bumps version:');
    const updated = await call(ctrl.updateTemplate, {
      user, params: { id }, body: { name: 'Test Custom A (edited)', bodyMarkdown: 'Hi {{employee.firstName}}.' },
    });
    assert(updated.statusCode === 200 && updated.body.version === 1, `edit bumps version 0→1 (got ${updated.body && updated.body.version})`);
    const updated2 = await call(ctrl.updateTemplate, { user, params: { id }, body: { subject: 'New subject' } });
    assert(updated2.body.version === 2, `2nd edit → version 2 (got ${updated2.body && updated2.body.version})`);

    // ── B3: publish / archive ──
    log('B3) publish (isActive=true) / archive (isActive=false):');
    const pub = await call(ctrl.publishTemplate, { user, params: { id } });
    assert(pub.statusCode === 200 && pub.body.isActive === true && pub.body.status === 'PUBLISHED', 'publish → isActive=true / PUBLISHED');
    const arch = await call(ctrl.archiveTemplate, { user, params: { id } });
    assert(arch.statusCode === 200 && arch.body.isActive === false && arch.body.status === 'DRAFT', 'archive → isActive=false');

    // ── B4: cross-tenant id → 404 ──
    log('B4) cross-tenant isolation (other tenant cannot see this id):');
    const xt = await call(ctrl.getTemplate, { user: otherUser, params: { id } });
    assert(xt.statusCode === 404, "other tenant's GET /:id → 404 (tenant isolation)");
    const xtUpd = await call(ctrl.updateTemplate, { user: otherUser, params: { id }, body: { name: 'hax' } });
    assert(xtUpd.statusCode === 404, "other tenant's PUT /:id → 404");
    const xtDel = await call(ctrl.deleteTemplate, { user: otherUser, params: { id } });
    assert(xtDel.statusCode === 404, "other tenant's DELETE /:id → 404");

    // ── B6 (run before B5 so a system row exists): seed idempotency ──
    log('B6) seedLetterTemplates idempotent + IN/NZ variants:');
    const r1 = await seed.seedLetterTemplates(prisma, businessId);
    assert(r1.length === 13, `first seed creates/upserts 13 system templates (got ${r1.length})`);
    const inSeeded = r1.filter((t) => t.countryCode === 'IN').length;
    const nzSeeded = r1.filter((t) => t.countryCode === 'NZ').length;
    assert(inSeeded === 6 && nzSeeded === 6, `seed has 6 IN + 6 NZ variants (got ${inSeeded}/${nzSeeded})`);
    assert(r1.every((t) => t.isSystem === true), 'all seeded rows are isSystem:true');
    const idsBefore = r1.map((t) => t.id).sort();
    const countBefore = await prisma.letterTemplate.count({ where: { businessId, isSystem: true } });
    const r2 = await seed.seedLetterTemplates(prisma, businessId);
    const idsAfter = r2.map((t) => t.id).sort();
    const countAfter = await prisma.letterTemplate.count({ where: { businessId, isSystem: true } });
    assert(JSON.stringify(idsBefore) === JSON.stringify(idsAfter), 're-seed returns the SAME row ids (idempotent upsert)');
    assert(countBefore === countAfter, `re-seed does not duplicate (${countBefore} → ${countAfter})`);

    // ── B5: isSystem row is NON-deletable; custom row deletes ──
    log('B5) isSystem non-deletable (409); custom soft-deletes:');
    const sysRow = r1.find((t) => t.code === 'EXP-STD-IN');
    const delSys = await call(ctrl.deleteTemplate, { user, params: { id: sysRow.id } });
    assert(delSys.statusCode === 409, 'DELETE on an isSystem template → 409 (non-deletable)');
    // confirm still present
    const stillThere = await prisma.letterTemplate.findFirst({ where: { id: sysRow.id, deletedAt: null } });
    assert(!!stillThere, 'the system row survives the refused delete');

    const delCustom = await call(ctrl.deleteTemplate, { user, params: { id } });
    assert(delCustom.statusCode === 200 && delCustom.body.ok, 'DELETE on a custom template → soft-deleted (ok:true)');
    const goneFromList = await call(ctrl.listTemplates, { user, query: {} });
    assert(!goneFromList.body.items.some((t) => t.id === id), 'soft-deleted custom row no longer lists');

    // cleanup the seeded system rows + throwaway tenant rows so reruns stay clean
    await prisma.letterTemplate.deleteMany({ where: { businessId, isSystem: true } });
  } finally {
    await cleanup();
    // remove throwaway tenant (and any of its templates) — best-effort
    try {
      await prisma.letterTemplate.deleteMany({ where: { businessId: other.id } });
      await prisma.business.delete({ where: { id: other.id } });
    } catch (_e) { /* leave it if FK-locked by unrelated rows */ }
    await prisma.$disconnect();
  }
}

// ── runner ──
async function main() {
  await partA();
  if (!process.env.DATABASE_URL) {
    log('\n[skip] PART B — DATABASE_URL not set (pure PART A ran DB-free).\n');
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
