'use strict';

/**
 * shiftSwap.engine.test.js — Feature 29 PROOF that a SHIFT_SWAP routes through the F10
 * engine and its consumer atomically swaps the two RosterDay cells + re-derives both
 * days. Same plain-node + LIVE hr_test harness as the other engine suites.
 *
 * Asserts:
 *   (1) On engine APPROVED, the two PUBLISHED roster cells are version-swapped (A↔B),
 *       source flips to SWAP, the ShiftSwapRequest → APPROVED. (atomicity, I3)
 *   (2) Both (employee,day) pairs are re-derived (Attendance rows written).
 *   (3) A locked-day swap is blocked (SWAP_LOCKED_DAY → engine tx rolls back, cells
 *       untouched, swap stays PENDING).
 *   (4) A night-consent violation is blocked (SWAP_NIGHT_CONSENT) when a non-consenting
 *       employee would land on an isNightShift pattern.
 *   (5) onReject leaves the cells untouched.
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/approvals/__tests__/shiftSwap.engine.test.js
 */

const prisma = require('../../../core/lib/prisma');
const engine = require('../engine');
require('../registerConsumers'); // wire SHIFT_SWAP (+ others)

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const PREFIX = 'SWAPENG-TEST';
function utcDay(s) { const d = new Date(s); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }

let seq = 0;
async function mkUserEmp(businessId, name, managerEmployeeId = null, nightShiftEligible = false) {
  seq += 1;
  const user = await prisma.user.create({
    data: { businessId, email: `${PREFIX.toLowerCase()}-${seq}-${Date.now()}@t.test`, password: 'x', name, role: 'USER', isActive: true },
  });
  const emp = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-${seq}`, firstName: name, lastName: 'T', status: 'ACTIVE', userId: user.id, managerEmployeeId, hireDate: new Date('2020-01-01'), nightShiftEligible },
  });
  return { user, emp };
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

async function mkCell(businessId, employeeId, date, shiftPatternId) {
  return prisma.rosterDay.create({
    data: { businessId, employeeId, date: utcDay(date), dayType: 'WORK', shiftPatternId, status: 'PUBLISHED', source: 'MANUAL' },
  });
}

// Open a SHIFT_SWAP approval, mark consent ACCEPTED, decide via the engine.
async function openSwapAndDecide(businessId, swap, decision, mgrUserId) {
  await prisma.shiftSwapRequest.update({ where: { id: swap.id }, data: { counterpartyConsent: 'ACCEPTED' } });
  const opened = await engine.openRequest({
    businessId, module: 'SHIFT_SWAP', entityType: 'ShiftSwapRequest', entityId: swap.id,
    requesterEmployeeId: swap.requesterEmployeeId, payload: {}, ctx: { entityId: swap.id },
  });
  const reqId = opened.approvalRequest.id;
  await prisma.shiftSwapRequest.update({ where: { id: swap.id }, data: { approvalRequestId: reqId } });
  if (opened.terminal === 'APPROVED' && decision === 'APPROVED') return { reqId, terminal: 'APPROVED' };
  await engine.recordDecision({ approvalRequestId: reqId, actorUserId: mgrUserId, decision, comment: null, systemActor: true });
  return { reqId };
}

async function main() {
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) { log('SKIP — no demo business in hr_test'); return; }
  const businessId = demo.id;
  await cleanup(businessId);

  const D = '2026-09-10';
  try {
    const mgr = await mkUserEmp(businessId, 'Mgr');
    const a = await mkUserEmp(businessId, 'Alice', mgr.emp.id, true);
    const b = await mkUserEmp(businessId, 'Bob', mgr.emp.id, true);

    const dayShift = await prisma.shiftPattern.create({ data: { businessId, code: `${PREFIX}-DAY`, name: 'Day', startTime: '09:00', endTime: '18:00', fullDayMinutes: 480 } });
    const nightShift = await prisma.shiftPattern.create({ data: { businessId, code: `${PREFIX}-NIGHT`, name: 'Night', startTime: '22:00', endTime: '06:00', fullDayMinutes: 420, isNightShift: true } });

    // ── 1+2: a clean approved swap (A:Day ↔ B:Night on the same day) ───────────
    {
      const cellA = await mkCell(businessId, a.emp.id, D, dayShift.id);
      const cellB = await mkCell(businessId, b.emp.id, D, nightShift.id);
      const swap = await prisma.shiftSwapRequest.create({
        data: { businessId, requesterEmployeeId: a.emp.id, counterpartyEmployeeId: b.emp.id, requesterDate: utcDay(D), counterpartyDate: utcDay(D), reason: 'cover', counterpartyConsent: 'PENDING', status: 'PENDING' },
      });
      await openSwapAndDecide(businessId, swap, 'APPROVED', mgr.user.id);

      const freshA = await prisma.rosterDay.findUnique({ where: { id: cellA.id } });
      const freshB = await prisma.rosterDay.findUnique({ where: { id: cellB.id } });
      const freshSwap = await prisma.shiftSwapRequest.findUnique({ where: { id: swap.id } });
      assert(freshA.shiftPatternId === nightShift.id, 'A now holds B\'s NIGHT shift (swapped)');
      assert(freshB.shiftPatternId === dayShift.id, 'B now holds A\'s DAY shift (swapped)');
      assert(freshA.source === 'SWAP' && freshB.source === 'SWAP', 'both cells source=SWAP');
      assert(freshA.swapRequestId === swap.id && freshB.swapRequestId === swap.id, 'both cells stamped swapRequestId');
      assert(freshSwap.status === 'APPROVED', 'swap request → APPROVED');

      const attA = await prisma.attendance.findFirst({ where: { businessId, employeeId: a.emp.id, date: utcDay(D) } });
      const attB = await prisma.attendance.findFirst({ where: { businessId, employeeId: b.emp.id, date: utcDay(D) } });
      assert(!!attA && attA.shiftPatternId === nightShift.id, 'A re-derived against the NIGHT shift');
      assert(!!attB && attB.shiftPatternId === dayShift.id, 'B re-derived against the DAY shift');
    }

    // ── 3: locked-day swap is blocked ─────────────────────────────────────────
    {
      const D2 = '2026-09-12';
      const cellA = await mkCell(businessId, a.emp.id, D2, dayShift.id);
      const cellB = await mkCell(businessId, b.emp.id, D2, dayShift.id);
      // Lock A's day.
      await prisma.attendance.create({ data: { businessId, employeeId: a.emp.id, date: utcDay(D2), status: 'PRESENT', isLocked: true } });
      const swap = await prisma.shiftSwapRequest.create({
        data: { businessId, requesterEmployeeId: a.emp.id, counterpartyEmployeeId: b.emp.id, requesterDate: utcDay(D2), counterpartyDate: utcDay(D2), reason: 'x', counterpartyConsent: 'PENDING', status: 'PENDING' },
      });
      let threw = false;
      try { await openSwapAndDecide(businessId, swap, 'APPROVED', mgr.user.id); } catch (e) { threw = true; }
      const freshA = await prisma.rosterDay.findUnique({ where: { id: cellA.id } });
      const freshSwap = await prisma.shiftSwapRequest.findUnique({ where: { id: swap.id } });
      assert(threw, 'locked-day swap throws (engine tx rolls back)');
      assert(freshA.shiftPatternId === dayShift.id && freshA.source === 'MANUAL', 'locked-day: cell untouched');
      assert(freshSwap.status === 'PENDING', 'locked-day: swap stays PENDING');
    }

    // ── 4: night-consent block (non-consenting employee → isNightShift) ────────
    {
      const D3 = '2026-09-14';
      const noConsent = await mkUserEmp(businessId, 'Carol', mgr.emp.id, false); // nightShiftEligible=false
      const cellC = await mkCell(businessId, noConsent.emp.id, D3, dayShift.id); // Carol: Day
      const cellB = await mkCell(businessId, b.emp.id, D3, nightShift.id);       // Bob: Night
      // Carol asks to take Bob's NIGHT — she has no consent → block.
      const swap = await prisma.shiftSwapRequest.create({
        data: { businessId, requesterEmployeeId: noConsent.emp.id, counterpartyEmployeeId: b.emp.id, requesterDate: utcDay(D3), counterpartyDate: utcDay(D3), reason: 'x', counterpartyConsent: 'PENDING', status: 'PENDING' },
      });
      let threw = false;
      try { await openSwapAndDecide(businessId, swap, 'APPROVED', mgr.user.id); } catch (e) { threw = true; }
      const freshC = await prisma.rosterDay.findUnique({ where: { id: cellC.id } });
      const freshSwap = await prisma.shiftSwapRequest.findUnique({ where: { id: swap.id } });
      assert(threw, 'night-consent swap throws (blocked)');
      assert(freshC.shiftPatternId === dayShift.id, 'night-consent: cell untouched');
      assert(freshSwap.status === 'PENDING', 'night-consent: swap stays PENDING');
    }

    // ── 5: onReject leaves cells untouched ────────────────────────────────────
    {
      const D4 = '2026-09-16';
      const cellA = await mkCell(businessId, a.emp.id, D4, dayShift.id);
      const cellB = await mkCell(businessId, b.emp.id, D4, nightShift.id);
      const swap = await prisma.shiftSwapRequest.create({
        data: { businessId, requesterEmployeeId: a.emp.id, counterpartyEmployeeId: b.emp.id, requesterDate: utcDay(D4), counterpartyDate: utcDay(D4), reason: 'x', counterpartyConsent: 'PENDING', status: 'PENDING' },
      });
      await openSwapAndDecide(businessId, swap, 'REJECTED', mgr.user.id);
      const freshA = await prisma.rosterDay.findUnique({ where: { id: cellA.id } });
      const freshB = await prisma.rosterDay.findUnique({ where: { id: cellB.id } });
      const freshSwap = await prisma.shiftSwapRequest.findUnique({ where: { id: swap.id } });
      assert(freshA.shiftPatternId === dayShift.id && freshB.shiftPatternId === nightShift.id, 'reject: cells untouched');
      assert(freshSwap.status === 'REJECTED', 'reject: swap → REJECTED');
    }
  } finally {
    await cleanup(businessId);
    await prisma.$disconnect();
  }

  log(`\nshiftSwap engine: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
