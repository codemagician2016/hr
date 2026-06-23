'use strict';

/*
 * letterheads.controller.test.js — Letters slice 9C controller test against a
 * REAL Postgres (hr_test schema). No jest: a plain-node harness matching the
 * other letters tests. Run from the backend dir with the test DB URL:
 *
 *   DATABASE_URL="<base>?schema=hr_test" \
 *     node src/hr/letters/__tests__/letterheads.controller.test.js
 *
 * Proves the §8 slice-9C acceptance criteria end-to-end through the controller
 * against the live CompanyLetterhead table + its raw-SQL partial-unique indexes:
 *   - upload rejects a non-PDF (422) and an oversize >10MB payload (413)
 *   - a valid A4 PDF upload stores the MEASURED page size + server fileHash
 *   - PUT /:id/layout persists normalized [0,1] rects; out-of-range rects ⇒ 422
 *   - a 2nd default (and a 2nd per-category binding) ⇒ 409 (partial-unique)
 *   - a cross-tenant id ⇒ 404 (tenant isolation)
 *   - the route middleware denies a non-canManageLetters actor ⇒ 403
 *
 * The controller is called directly with mock req/res objects (the routes just
 * wire protect + requirePermission, exercised separately for the 403 case).
 */

const { PDFDocument } = require('pdf-lib');
const prisma = require('../../../core/lib/prisma');
const c = require('../controllers/letterheads.controller');
const { requirePermission } = require('../../../core/middleware/auth.middleware');

let passed = 0;
let failed = 0;
const discrepancies = [];

function check(scenario, cond, detail) {
  if (cond) { passed += 1; return; }
  failed += 1;
  discrepancies.push(`✗ ${scenario}${detail ? ` — ${detail}` : ''}`);
}

// Minimal mock res that captures status + json payload.
function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

// A controller `next(err)` should not happen on the happy paths we test; record it.
function makeNext(label) {
  return (err) => { discrepancies.push(`✗ ${label}: unexpected next(err) — ${err && err.message}`); failed += 1; };
}

// Build a valid single-page A4 PDF as a base64 data-URL.
async function makeA4DataUrl() {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  const bytes = await doc.save();
  return `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`;
}

async function main() {
  const stamp = Date.now();
  const businessAId = null; // set below
  let bizA;
  let bizB;
  try {
    bizA = await prisma.business.create({ data: { name: `LH Test A ${stamp}`, slug: `lh-test-a-${stamp}` } });
    bizB = await prisma.business.create({ data: { name: `LH Test B ${stamp}`, slug: `lh-test-b-${stamp}` } });

    const userA = { businessId: bizA.id, id: `user-a-${stamp}`, role: 'STAFF' };
    const a4DataUrl = await makeA4DataUrl();

    // ── 1) non-PDF upload ⇒ 422 ───────────────────────────────────────────────
    {
      const pngDataUrl = 'data:image/png;base64,' + Buffer.from('not-a-real-png').toString('base64');
      const res = mockRes();
      await c.createLetterhead(
        { user: userA, body: { code: `C1-${stamp}`, name: 'Reject PNG', fileBase64: pngDataUrl } },
        res, makeNext('non-pdf'));
      check('upload rejects non-PDF with 422', res.statusCode === 422, `got ${res.statusCode}: ${res.body && res.body.message}`);
    }

    // ── 2) oversize >10MB ⇒ 413 ───────────────────────────────────────────────
    {
      // 11MB of base64 'A' decodes to ~8.25MB; build > 10MB decoded.
      const bigBytes = Buffer.alloc(11 * 1024 * 1024, 0x41);
      const bigDataUrl = `data:application/pdf;base64,${bigBytes.toString('base64')}`;
      const res = mockRes();
      await c.createLetterhead(
        { user: userA, body: { code: `C2-${stamp}`, name: 'Too big', fileBase64: bigDataUrl } },
        res, makeNext('oversize'));
      check('upload rejects >10MB with 413', res.statusCode === 413, `got ${res.statusCode}: ${res.body && res.body.message}`);
    }

    // ── 3) valid A4 upload stores measured page size + fileHash ────────────────
    let createdId;
    {
      const res = mockRes();
      await c.createLetterhead(
        { user: userA, body: { code: `DEFAULT-${stamp}`, name: 'Acme Default', fileBase64: a4DataUrl, isDefault: true } },
        res, makeNext('valid-upload'));
      const r = res.body || {};
      createdId = r.id;
      check('valid A4 upload ⇒ 201', res.statusCode === 201, `got ${res.statusCode}: ${r.message}`);
      check('stores measured pageWidthPt ≈ 595', Math.abs((r.pageWidthPt || 0) - 595.28) < 1, `pageWidthPt=${r.pageWidthPt}`);
      check('stores measured pageHeightPt ≈ 842', Math.abs((r.pageHeightPt || 0) - 841.89) < 1, `pageHeightPt=${r.pageHeightPt}`);
      check('stores server-computed fileHash (64-hex sha256)', typeof r.fileHash === 'string' && /^[0-9a-f]{64}$/.test(r.fileHash), `fileHash=${r.fileHash}`);
      check('stores mimeType application/pdf', r.mimeType === 'application/pdf', `mimeType=${r.mimeType}`);
      check('isDefault persisted true', r.isDefault === true, `isDefault=${r.isDefault}`);
    }

    // ── 4) layout save persists normalized rects; out-of-range ⇒ 422 ───────────
    {
      const badRes = mockRes();
      await c.saveLayout(
        { user: userA, params: { id: createdId }, body: { layoutJson: { writingArea: { x: 0.1, y: 0.2, w: 0.8, h: 1.5 } } } },
        badRes, makeNext('bad-layout'));
      check('out-of-range rect ⇒ 422', badRes.statusCode === 422, `got ${badRes.statusCode}`);

      const goodLayout = {
        writingArea: { x: 0.1, y: 0.28, w: 0.8, h: 0.5, align: 'left', fontSize: 11, lineGap: 4 },
        fields: {
          date: { x: 0.65, y: 0.12, w: 0.25, h: 0.03 },
          refNo: { x: 0.1, y: 0.12, w: 0.3, h: 0.03 },
          authority: { x: 0.1, y: 0.85, w: 0.4, h: 0.04 },
          signature: { x: 0.1, y: 0.78, w: 0.25, h: 0.06 },
        },
        overflowPolicy: 'repeat-letterhead',
        signatureOnLastPage: true,
      };
      const okRes = mockRes();
      await c.saveLayout(
        { user: userA, params: { id: createdId }, body: { layoutJson: goodLayout } },
        okRes, makeNext('good-layout'));
      check('valid layout save ⇒ 200', okRes.statusCode === 200, `got ${okRes.statusCode}`);
      const persisted = okRes.body && okRes.body.layoutJson;
      check('persists normalized writingArea rect', persisted && persisted.writingArea && persisted.writingArea.w === 0.8);
      check('persists all 4 field zones', persisted && persisted.fields && persisted.fields.date && persisted.fields.signature);
      // Re-read from DB to confirm it round-trips through Postgres jsonb.
      const dbRow = await prisma.companyLetterhead.findUnique({ where: { id: createdId } });
      check('layout round-trips through DB jsonb',
        dbRow && dbRow.layoutJson && dbRow.layoutJson.fields && dbRow.layoutJson.fields.refNo.x === 0.1);
    }

    // ── 5) 2nd default ⇒ 409 (partial-unique uniq_letterhead_default) ──────────
    {
      const res = mockRes();
      await c.createLetterhead(
        { user: userA, body: { code: `DEFAULT2-${stamp}`, name: 'Second default', fileBase64: a4DataUrl, isDefault: true } },
        res, makeNext('2nd-default'));
      check('2nd default ⇒ 409', res.statusCode === 409, `got ${res.statusCode}: ${res.body && res.body.message}`);
    }

    // ── 5b) 2nd per-category ⇒ 409 (partial-unique uniq_letterhead_category) ───
    {
      const r1 = mockRes();
      await c.createLetterhead(
        { user: userA, body: { code: `EXP1-${stamp}`, name: 'Experience LH', fileBase64: a4DataUrl, letterCategory: 'EXPERIENCE' } },
        r1, makeNext('cat-1'));
      check('1st per-category bind ⇒ 201', r1.statusCode === 201, `got ${r1.statusCode}`);
      const r2 = mockRes();
      await c.createLetterhead(
        { user: userA, body: { code: `EXP2-${stamp}`, name: 'Experience LH 2', fileBase64: a4DataUrl, letterCategory: 'EXPERIENCE' } },
        r2, makeNext('cat-2'));
      check('2nd per-category bind ⇒ 409', r2.statusCode === 409, `got ${r2.statusCode}: ${r2.body && r2.body.message}`);
    }

    // ── 6) cross-tenant id ⇒ 404 ──────────────────────────────────────────────
    {
      const userB = { businessId: bizB.id, id: `user-b-${stamp}`, role: 'STAFF' };
      const res = mockRes();
      await c.getLetterhead({ user: userB, params: { id: createdId } }, res, makeNext('cross-tenant'));
      check('cross-tenant GET ⇒ 404', res.statusCode === 404, `got ${res.statusCode}`);

      const resL = mockRes();
      await c.saveLayout(
        { user: userB, params: { id: createdId }, body: { layoutJson: { writingArea: { x: 0, y: 0, w: 1, h: 1 } } } },
        resL, makeNext('cross-tenant-layout'));
      check('cross-tenant layout save ⇒ 404', resL.statusCode === 404, `got ${resL.statusCode}`);

      const resD = mockRes();
      await c.deleteLetterhead({ user: userB, params: { id: createdId } }, resD, makeNext('cross-tenant-del'));
      check('cross-tenant DELETE ⇒ 404', resD.statusCode === 404, `got ${resD.statusCode}`);
    }

    // ── 7) non-canManageLetters ⇒ 403 (route middleware) ──────────────────────
    {
      const mw = requirePermission('canManageLetters');
      // effectivePermissions reads user.businessRole.permissions (else legacy
      // role map). A STAFF operator with an empty custom-role grant is denied.
      const denyReq = { user: { businessId: bizA.id, id: 'u', role: 'STAFF', businessRole: { permissions: {} } } };
      let nextCalled = false;
      const denyRes = mockRes();
      mw(denyReq, denyRes, () => { nextCalled = true; });
      check('non-canManageLetters ⇒ 403', denyRes.statusCode === 403 && !nextCalled, `status=${denyRes.statusCode} next=${nextCalled}`);

      // An operator WITH the permission passes the gate.
      const okReq = { user: { businessId: bizA.id, id: 'u2', role: 'STAFF', businessRole: { permissions: { canManageLetters: true } } } };
      let okNext = false;
      const okRes2 = mockRes();
      mw(okReq, okRes2, () => { okNext = true; });
      check('canManageLetters holder passes the gate', okNext === true, `next=${okNext}`);
    }

    // ── 8) soft-delete frees the partial-unique slot ──────────────────────────
    {
      const del = mockRes();
      await c.deleteLetterhead({ user: userA, params: { id: createdId } }, del, makeNext('soft-delete'));
      check('soft-delete ⇒ ok', del.body && del.body.ok === true, `body=${JSON.stringify(del.body)}`);
      const gone = mockRes();
      await c.getLetterhead({ user: userA, params: { id: createdId } }, gone, makeNext('get-after-del'));
      check('soft-deleted row is 404 on GET', gone.statusCode === 404, `got ${gone.statusCode}`);
      // Now a new default for the same (tenant, null-entity) must succeed.
      const reDefault = mockRes();
      await c.createLetterhead(
        { user: userA, body: { code: `DEFAULT3-${stamp}`, name: 'Replacement default', fileBase64: a4DataUrl, isDefault: true } },
        reDefault, makeNext('replacement-default'));
      check('new default after delete ⇒ 201 (slot freed)', reDefault.statusCode === 201, `got ${reDefault.statusCode}: ${reDefault.body && reDefault.body.message}`);
    }
  } finally {
    // Clean up: delete letterheads then the throwaway tenants (cascade covers it,
    // but be explicit so a partial run leaves nothing behind).
    try {
      if (bizA) await prisma.companyLetterhead.deleteMany({ where: { businessId: bizA.id } });
      if (bizB) await prisma.companyLetterhead.deleteMany({ where: { businessId: bizB.id } });
      if (bizA) await prisma.business.delete({ where: { id: bizA.id } });
      if (bizB) await prisma.business.delete({ where: { id: bizB.id } });
    } catch (e) {
      discrepancies.push(`(cleanup warning: ${e.message})`);
    }
    await prisma.$disconnect();
  }

  console.log(`\nletterheads.controller.test: ${passed} passed, ${failed} failed`);
  if (discrepancies.length) {
    console.log('Discrepancies:');
    for (const d of discrepancies) console.log('  ' + d);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
