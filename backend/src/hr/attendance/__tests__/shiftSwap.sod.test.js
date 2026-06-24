'use strict';

/**
 * shiftSwap.sod.test.js — Feature 29 review-cycle-4 regression proof (plain-node,
 * LIVE hr_test). Sibling to attendance.rbac.test.js; same fakeRes/callController
 * doubles, same prefix-tagged fixtures + teardown.
 *
 * Proves the THREE confirmed shift-management findings are fixed:
 *
 *   (1) HIGH — swap-decision Separation of Duties (roster.controller.decideSwap):
 *       a manager who is a PARTY to the swap (requester OR counterparty) CANNOT
 *       approve/reject it → 404 (IDOR-safe), even with consent ACCEPTED and an open
 *       approval present (so it is the self-block, not a missing-approval 409). A
 *       NEUTRAL third-party manager CAN decide it → swap APPROVED.
 *
 *   (2) LOW — consentMySwap stale-read (meAttendance.controller.consentMySwap):
 *       the ACCEPT path re-validates PUBLISHED + unlocked for BOTH cells INSIDE the
 *       transaction before opening the chain. A cell reverted to DRAFT after FILE
 *       time → 409 at ACCEPT (no doomed chain opened); the consent read is consistent
 *       with the cell state.
 *
 *   (3) LOW — publish recompute atomicity (roster.controller.publish): the DRAFT→
 *       PUBLISHED flip and the re-derive run in ONE transaction. If a recompute
 *       throws, the whole publish rolls back — cells stay DRAFT (never PUBLISHED-but-
 *       stale). The happy path publishes + re-derives atomically.
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/attendance/__tests__/shiftSwap.sod.test.js
 */

const prisma = require('../../../core/lib/prisma');
const roster = require('../../controllers/roster.controller');
const meAttendance = require('../../controllers/meAttendance.controller');
const { resolveAccessibleEmployeeIds } = require('../../lib/scopeResolver');
require('../../approvals/registerConsumers'); // wire SHIFT_SWAP consumer

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); } }

// ── controller doubles (copied from attendance.rbac harness) ──────────────────
function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return done(); };
    const origJson = res.json.bind(res);
    res.json = (p) => { const r = origJson(p); done(); return r; };
    const origEnd = res.end.bind(res);
    res.end = () => { const r = origEnd(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

// hr-admin operator actor (roster.controller reads req.user + req.scope).
function actor({ businessId, id, employeeId = null, band, role = 'STAFF' }) {
  return { id: id || `actor-${band}-${employeeId || 'noemp'}`, businessId, role, employeeId, businessRoleId: null, businessRole: { defaultScope: band } };
}
async function withScope(user, action, extra = {}) {
  const scope = await resolveAccessibleEmployeeIds(user, action);
  return { user, scope, query: {}, params: {}, body: {}, ...extra };
}
// ESS/customer request (meAttendance reads req.customer; resolveSelfEmployee
// matches Employee.workEmail to customer.email).
function essReq(businessId, email, extra = {}) {
  return { customer: { businessId, email }, query: {}, params: {}, body: {}, ...extra };
}

const PREFIX = 'SWAPSOD-TEST';
const day = (s) => new Date(`${s}T00:00:00Z`);
function utcDay(s) { const d = new Date(s); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }

let seq = 0;
async function mkUserEmp(businessId, name, managerEmployeeId = null, nightShiftEligible = true) {
  seq += 1;
  const email = `${PREFIX.toLowerCase()}-${seq}-${Date.now()}@t.test`;
  const user = await prisma.user.create({ data: { businessId, email, password: 'x', name, role: 'USER', isActive: true } });
  const emp = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-${seq}-${name}`, firstName: name, lastName: 'T', status: 'ACTIVE', isActive: true, userId: user.id, workEmail: email, managerEmployeeId, hireDate: new Date('2020-01-01'), nightShiftEligible },
  });
  return { user, emp, email };
}

async function cleanup(businessId) {
  await prisma.approvalAction.deleteMany({ where: { businessId, approvalRequest: { module: 'SHIFT_SWAP', requester: { code: { startsWith: PREFIX } } } } }).catch(() => {});
  await prisma.approvalRequest.deleteMany({ where: { businessId, module: 'SHIFT_SWAP', requester: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.shiftSwapRequest.deleteMany({ where: { businessId, requester: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.rosterDay.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.attendance.deleteMany({ where: { businessId, employee: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.shiftPattern.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { businessId, email: { startsWith: PREFIX.toLowerCase() } } });
}

async function mkPublishedCell(businessId, employeeId, date, shiftPatternId, status = 'PUBLISHED') {
  return prisma.rosterDay.create({ data: { businessId, employeeId, date: utcDay(date), dayType: 'WORK', shiftPatternId, status, source: 'MANUAL' } });
}

async function main() {
  log('\n=== Feature 29 shift-swap SoD + atomicity regression (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  await cleanup(businessId);

  try {
    // Fixture chain: GM (grand-manager) → M (manager) → S (subordinate).
    // GM gives the SHIFT_SWAP chain a CONCRETE routed approver for swaps M files (the
    // built-in default routes to the requester's REPORTING_MANAGER), so the request
    // stays PENDING instead of SoD-collapsing to auto-approve. M and S are the swap
    // PARTIES under test; NEUTRAL is an ALL-band hr-admin (sees both parties, is
    // NEITHER) — the legitimate decider that proves the block is party-specific.
    const gm = await mkUserEmp(businessId, 'Gm');              // GM — M's manager (routed approver)
    const mgr = await mkUserEmp(businessId, 'Mgr', gm.emp.id); // M  — a party + a manager (TEAM scope over S)
    const sub = await mkUserEmp(businessId, 'Sub', mgr.emp.id);// S  — M's subordinate
    const dayShift = await prisma.shiftPattern.create({ data: { businessId, code: `${PREFIX}-DAY`, name: 'Day', startTime: '09:00', endTime: '18:00', fullDayMinutes: 480 } });

    // Actors. M acts as a TEAM-band manager (its own sub-tree includes S). NEUTRAL =
    // ALL-band hr-admin operator (sees both parties, is neither).
    const mgrApprover = actor({ businessId, id: mgr.user.id, employeeId: mgr.emp.id, band: 'TEAM' });
    const neutralApprover = actor({ businessId, id: 'op-admin-neutral', employeeId: null, band: 'ALL', role: 'BUSINESS_ADMIN' });

    /* ── (1) HIGH — swap-decision SoD ───────────────────────────────────────── */
    log('(1) swap-decision Separation of Duties:');
    {
      const D = '2026-09-10';
      // M files a swap (M requester) with S (counterparty). M dumps its Day onto S's Day.
      await mkPublishedCell(businessId, mgr.emp.id, D, dayShift.id);
      await mkPublishedCell(businessId, sub.emp.id, D, dayShift.id);
      const fileRes = await callController(meAttendance.createMySwap, essReq(businessId, mgr.email, {
        body: { counterpartyEmployeeId: sub.emp.id, requesterDate: D, counterpartyDate: D, reason: `${PREFIX} dump` },
      }));
      assert(fileRes.statusCode === 201, 'M files swap (M requester, S counterparty) → 201');
      const swapId = fileRes.body.id;

      // S accepts → opens the F10 chain (consent ACCEPTED + open ApprovalRequest).
      const consentRes = await callController(meAttendance.consentMySwap, essReq(businessId, sub.email, { params: { id: swapId }, body: { decision: 'ACCEPT' } }));
      assert(consentRes.statusCode === 200 && consentRes.body.counterpartyConsent === 'ACCEPTED', 'S accepts → consent ACCEPTED, chain opened');
      const open = await prisma.approvalRequest.findFirst({ where: { businessId, module: 'SHIFT_SWAP', entityId: swapId, status: { in: ['PENDING', 'ESCALATED'] } } });
      assert(!!open, 'an OPEN ApprovalRequest exists for the swap (so a 404 below is the SoD block, not a missing approval)');

      // M (the REQUESTER party) attempts to approve their own swap → 404 (SoD).
      const selfReq = await withScope(mgrApprover, 'canApproveRegularization', { params: { id: swapId }, body: {} });
      const selfRes = await callController(roster.approveSwap, selfReq);
      assert(selfRes.statusCode === 404, 'M (requester party) approve own swap → 404 (self/party SoD block)');
      let fresh = await prisma.shiftSwapRequest.findUnique({ where: { id: swapId } });
      assert(fresh.status === 'PENDING', 'swap still PENDING after blocked self-approval');

      // M attempts to REJECT their own swap too → also 404 (both decisions blocked).
      const selfRejRes = await callController(roster.rejectSwap, await withScope(mgrApprover, 'canApproveRegularization', { params: { id: swapId }, body: {} }));
      assert(selfRejRes.statusCode === 404, 'M (party) reject own swap → 404 (block covers reject too)');

      // A NEUTRAL approver (neither party) → swap APPROVED (the real decision flows).
      const neutralReq = await withScope(neutralApprover, 'canApproveRegularization', { params: { id: swapId }, body: {} });
      const neutralRes = await callController(roster.approveSwap, neutralReq);
      assert(neutralRes.statusCode === 200 && neutralRes.body.status === 'APPROVED', 'NEUTRAL approver (neither party) → 200 APPROVED');
      fresh = await prisma.shiftSwapRequest.findUnique({ where: { id: swapId } });
      assert(fresh.status === 'APPROVED', 'swap → APPROVED after neutral decision');
    }

    /* ── (1b) the SYMMETRIC case: M is the COUNTERPARTY of a subordinate-filed swap */
    log('(1b) SoD blocks the COUNTERPARTY party too:');
    {
      const D = '2026-09-11';
      await mkPublishedCell(businessId, sub.emp.id, D, dayShift.id);
      await mkPublishedCell(businessId, mgr.emp.id, D, dayShift.id);
      // S files; M is the counterparty.
      const fileRes = await callController(meAttendance.createMySwap, essReq(businessId, sub.email, {
        body: { counterpartyEmployeeId: mgr.emp.id, requesterDate: D, counterpartyDate: D, reason: `${PREFIX} sym` },
      }));
      assert(fileRes.statusCode === 201, 'S files swap with M as counterparty → 201');
      const swapId = fileRes.body.id;
      // M (the counterparty) accepts consent (it is M's role as counterparty).
      const consentRes = await callController(meAttendance.consentMySwap, essReq(businessId, mgr.email, { params: { id: swapId }, body: { decision: 'ACCEPT' } }));
      assert(consentRes.statusCode === 200, 'M (counterparty) accepts → chain opened');
      // M tries to approve a swap they are the COUNTERPARTY of → 404 (SoD).
      const selfRes = await callController(roster.approveSwap, await withScope(mgrApprover, 'canApproveRegularization', { params: { id: swapId }, body: {} }));
      assert(selfRes.statusCode === 404, 'M (counterparty party) approve own swap → 404 (SoD)');
      const fresh = await prisma.shiftSwapRequest.findUnique({ where: { id: swapId } });
      assert(fresh.status === 'PENDING', 'symmetric: swap still PENDING (not self-approved)');
      // Neutral cleans it up.
      await callController(roster.approveSwap, await withScope(neutralApprover, 'canApproveRegularization', { params: { id: swapId }, body: {} }));
    }

    /* ── (2) LOW — consentMySwap stale-read re-check IN-TX ───────────────────── */
    log('(2) consentMySwap re-validates PUBLISHED state in-tx (no stale-read):');
    {
      const D = '2026-09-13';
      // Two unrelated peers so the SoD block doesn't interfere.
      const p1 = await mkUserEmp(businessId, 'P1');
      const p2 = await mkUserEmp(businessId, 'P2');
      const cellA = await mkPublishedCell(businessId, p1.emp.id, D, dayShift.id);
      await mkPublishedCell(businessId, p2.emp.id, D, dayShift.id);
      // P1 files a swap on two PUBLISHED cells (file-time invariant holds).
      const fileRes = await callController(meAttendance.createMySwap, essReq(businessId, p1.email, {
        body: { counterpartyEmployeeId: p2.emp.id, requesterDate: D, counterpartyDate: D, reason: `${PREFIX} stale` },
      }));
      assert(fileRes.statusCode === 201, 'P1 files swap on two PUBLISHED cells → 201');
      const swapId = fileRes.body.id;

      // Admin reverts P1's cell to DRAFT AFTER file time (the stale-read scenario).
      await prisma.rosterDay.update({ where: { id: cellA.id }, data: { status: 'DRAFT' } });

      // P2 tries to ACCEPT → the in-tx re-check sees a non-PUBLISHED cell → 409, and
      // NO approval chain is opened (the consent read is consistent with cell state).
      const consentRes = await callController(meAttendance.consentMySwap, essReq(businessId, p2.email, { params: { id: swapId }, body: { decision: 'ACCEPT' } }));
      assert(consentRes.statusCode === 409 && consentRes.body.reason === 'SWAP_NOT_PUBLISHED', 'ACCEPT on a since-DRAFTed cell → 409 SWAP_NOT_PUBLISHED');
      const swapAfter = await prisma.shiftSwapRequest.findUnique({ where: { id: swapId } });
      assert(swapAfter.counterpartyConsent === 'PENDING' && !swapAfter.approvalRequestId, 'consent NOT marked + NO chain opened (atomic rollback)');
      const noChain = await prisma.approvalRequest.findFirst({ where: { businessId, module: 'SHIFT_SWAP', entityId: swapId } });
      assert(!noChain, 'no doomed ApprovalRequest left behind');

      // Re-publish the cell → ACCEPT now succeeds and opens the chain (consistency proven).
      await prisma.rosterDay.update({ where: { id: cellA.id }, data: { status: 'PUBLISHED' } });
      const ok = await callController(meAttendance.consentMySwap, essReq(businessId, p2.email, { params: { id: swapId }, body: { decision: 'ACCEPT' } }));
      assert(ok.statusCode === 200 && ok.body.counterpartyConsent === 'ACCEPTED', 're-published cell → ACCEPT succeeds, chain opens');
    }

    /* ── (3) LOW — publish recompute atomicity ───────────────────────────────── */
    log('(3) publish re-derive is atomic (rollback leaves cells DRAFT):');
    {
      const D = '2026-09-20';
      const p3 = await mkUserEmp(businessId, 'P3');
      const cellD = await mkPublishedCell(businessId, p3.emp.id, D, dayShift.id, 'DRAFT');

      // Happy path: publish + re-derive atomically.
      const opAdmin = actor({ businessId, id: 'op-admin-pub', employeeId: null, band: 'ALL', role: 'BUSINESS_ADMIN' });
      const pubReq = await withScope(opAdmin, 'canManageAttendance', { query: { from: D, to: D }, body: { employeeIds: [p3.emp.id] } });
      const pubRes = await callController(roster.publish, pubReq);
      assert(pubRes.statusCode === 200 && pubRes.body.published === 1, 'publish → 200, published=1');
      const flipped = await prisma.rosterDay.findUnique({ where: { id: cellD.id } });
      assert(flipped.status === 'PUBLISHED', 'cell flipped DRAFT → PUBLISHED');
      const att = await prisma.attendance.findFirst({ where: { businessId, employeeId: p3.emp.id, date: utcDay(D) } });
      assert(!!att, 'attendance row re-derived inside the publish tx');

      // Atomicity: a recompute failure must roll the publish back (cells stay DRAFT).
      // roster.controller DESTRUCTURES recompute at module load, so we stub the service
      // export FIRST, then re-require a fresh roster.controller (cache-busted) that
      // re-captures the stub. The stub throws on the SECOND employee, proving the FIRST
      // employee's flip also rolls back (one shared $transaction, not per-row commits).
      const D2 = '2026-09-21';
      const p4 = await mkUserEmp(businessId, 'P4'); // recompute throws for this one
      const p5 = await mkUserEmp(businessId, 'P5'); // its flip must ALSO roll back
      const cellE = await mkPublishedCell(businessId, p4.emp.id, D2, dayShift.id, 'DRAFT');
      const cellF = await mkPublishedCell(businessId, p5.emp.id, D2, dayShift.id, 'DRAFT');

      const svcPath = require.resolve('../service');
      const ctrlPath = require.resolve('../../controllers/roster.controller');
      const svc = require('../service');
      const realRecompute = svc.recompute;
      let calls = 0;
      svc.recompute = async (...args) => {
        calls += 1;
        if (calls >= 2) { const e = new Error('boom (simulated transient recompute failure)'); e.code = 'TEST_BOOM'; throw e; }
        return realRecompute(...args);
      };
      delete require.cache[ctrlPath];           // force re-destructure of the stub
      const rosterStubbed = require('../../controllers/roster.controller');

      let threw = false;
      try {
        const pr = await withScope(opAdmin, 'canManageAttendance', { query: { from: D2, to: D2 }, body: { employeeIds: [p4.emp.id, p5.emp.id] } });
        const r = await callController(rosterStubbed.publish, pr);
        threw = r.statusCode >= 500; // the controller's next(err) → harness reject (caught below) is the usual path
      } catch (e) { threw = true; }

      // Restore the real recompute + the unstubbed controller for any later use.
      svc.recompute = realRecompute;
      delete require.cache[ctrlPath];
      require('../../controllers/roster.controller');
      void svcPath;

      const staleE = await prisma.rosterDay.findUnique({ where: { id: cellE.id } });
      const staleF = await prisma.rosterDay.findUnique({ where: { id: cellF.id } });
      assert(threw, 'publish surfaces the recompute failure (not a silent 200)');
      assert(staleE.status === 'DRAFT' && staleF.status === 'DRAFT',
        'recompute failure ROLLS BACK the whole publish — BOTH cells stay DRAFT (never PUBLISHED-but-stale)');
      const noAtt = await prisma.attendance.findFirst({ where: { businessId, employeeId: { in: [p4.emp.id, p5.emp.id] }, date: utcDay(D2) } });
      assert(!noAtt, 'no Attendance row persisted from the rolled-back publish');
    }
  } finally {
    await cleanup(businessId);
  }

  log(`\n=== ${failures === 0 ? 'ALL SHIFT-SWAP SoD/ATOMICITY CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ===\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('shiftSwap SoD test crashed:', err);
  try { await prisma.$disconnect(); } catch (_e) { /* ignore */ }
  process.exit(2);
});
