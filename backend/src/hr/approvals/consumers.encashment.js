'use strict';

/**
 * consumers.encashment.js — Feature 31. The LEAVE_ENCASHMENT consumer bundle.
 *
 * Mirrors consumers.leave.js: the engine decides WHEN a terminal transition happens;
 * the domain effect (flip the LeaveEncashmentRequest status + move the LeaveBalance +
 * post the ENCASHMENT ledger row + snapshot the money) is carried HERE, in callbacks
 * the engine fires INSIDE its own transaction so the balance debit commits atomically
 * with the approval transition.
 *
 *   onApprove(req, tx) — PENDING → APPROVED: the REAL debit. Release the soft-hold,
 *                        post ONE ENCASHMENT LeaveTransaction, bump `encashed += days`
 *                        and `closing -= days` (version-locked), and SNAPSHOT the
 *                        last-drawn Basic+DA + the computed amount onto the request
 *                        (so a later comp revision never re-values a surrendered day).
 *                        The cash is now OWED and queued for the next pay run.
 *   onReject(req, tx)  — PENDING → REJECTED: release the hold; NO debit.
 *   onCancel(req, tx)  — requester cancel/withdraw while PENDING: release the hold; NO debit.
 *
 * Idempotency / concurrency mirror the leave consumer exactly: every status flip is a
 * conditional updateMany(where status='PENDING') (a lost race → DECISION_RACE 409), the
 * balance move is version-optimistic-locked (P2025 → 409), and `encashmentTxnId` being
 * set is the secondary guard so the ENCASHMENT row is posted EXACTLY once.
 *
 * The §10(10AA) exit exemption is NEVER touched here — in-service encashment is fully
 * taxable under §17; the taxable earning is emitted later by the pay pass.
 */

const consumers = require('./consumers');
const { computeEncashAmount } = require('../leave/encashment/encashment');
// The last-drawn Basic+DA resolver F&F uses (sums current CompensationRevision BASIC +
// DEARNESS_ALLOWANCE lines → integer paise). Reused so in-service == exit to the paise.
const { resolveLastDrawnPay } = require('../lifecycle/controllers/offboarding.controller')._internals;
// Fire-and-forget decision notify, OUTSIDE the engine tx (default prisma), so a notify
// failure can never roll back the balance debit. Mirrors consumers.leave.js.
const notify = require('./notify');

// pendingApproval can never go below zero — floor the release (mirror consumers.leave).
function flooredRelease(current, qty) {
  return Math.min(qty, Math.max(0, Number(current || 0)));
}

// Load the LeaveEncashmentRequest this ApprovalRequest gates. Tolerant of an
// already-terminal row (a re-fired/duplicate hook is then a no-op).
async function loadReq(tx, approvalRequest) {
  return tx.leaveEncashmentRequest.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId },
    include: { leaveType: { select: { id: true } } },
  });
}

// assertCapsWithinTx — re-validate the per-year request-count + days caps INSIDE the
// approval tx, race-safe (finding #3). reqRow is THIS request (already flipped APPROVED).
//
// The cap is enforced over COMMITTED requests (APPROVED/PAID) — the same buckets that
// actually debit the balance — plus THIS one. We FOR UPDATE-lock the period's COMMITTED
// sibling rows so two concurrent approvals serialise on the same key: the first commits,
// the second then SEES that committed row in its locked re-count and is rejected. Two
// requests that are both still PENDING do NOT block each other at this gate (only one of
// them wins the approval; the other then trips the re-check) — so the legitimate first
// approval is never spuriously refused.
//   • request count: locked APPROVED/PAID siblings + this one ≤ maxRequests
//   • days/year:     Σ days on locked APPROVED/PAID siblings + this one ≤ encashMaxDaysPerYear
// The policy is the snapshot the request carries (leavePolicyId); NULL ⇒ default 1/yr, no
// day cap (matches the create-time gate's defaults). Fail closed: a busted cap throws.
async function assertCapsWithinTx(tx, reqRow, days) {
  // Serialise concurrent approvals on the SAME (employee, leaveType, period): take a FOR
  // UPDATE lock on the shared LeaveBalance row FIRST. Two approvals that both see zero
  // committed siblings would otherwise both pass — locking the one balance row they both
  // debit forces them to run one-at-a-time, so the second re-counts AFTER the first's
  // APPROVED row is visible and is correctly rejected. (If no balance row exists there is
  // nothing to debit; the caps then reduce to the committed-sibling count below.)
  await tx.$queryRaw`
    SELECT b."id"
    FROM "LeaveBalance" b
    WHERE b."businessId" = ${reqRow.businessId}
      AND b."employeeId" = ${reqRow.employeeId}
      AND b."leaveTypeId" = ${reqRow.leaveTypeId}
      AND b."periodCode" = ${reqRow.periodCode}
    FOR UPDATE`;

  // Lock the COMMITTED sibling rows for this employee/leaveType/period (the ones that count
  // toward the caps). The lock serialises a concurrent approval of another sibling: it must
  // wait for our commit, then re-counts and sees us.
  const siblings = await tx.$queryRaw`
    SELECT r."id", r."status", r."days"
    FROM "LeaveEncashmentRequest" r
    WHERE r."businessId" = ${reqRow.businessId}
      AND r."employeeId" = ${reqRow.employeeId}
      AND r."leaveTypeId" = ${reqRow.leaveTypeId}
      AND r."periodCode" = ${reqRow.periodCode}
      AND r."id" <> ${reqRow.id}
      AND r."status" IN ('APPROVED', 'PAID')
    FOR UPDATE`;

  const policy = reqRow.leavePolicyId
    ? await tx.leavePolicy.findFirst({
        where: { id: reqRow.leavePolicyId, businessId: reqRow.businessId },
        select: { encashMaxRequestsPerYear: true, encashMaxDaysPerYear: true },
      })
    : null;

  // Request-count cap (default 1/yr when the policy is silent — mirror the pure validator).
  const maxRequests = (policy && policy.encashMaxRequestsPerYear != null)
    ? Number(policy.encashMaxRequestsPerYear)
    : 1;
  // Committed siblings + this one.
  const requestsThisYear = siblings.length + 1;
  if (requestsThisYear > maxRequests) {
    const err = new Error(`Encashment request cap of ${maxRequests}/year exceeded (concurrent request race)`);
    err.code = 'DECISION_RACE';
    throw err;
  }

  // Days/year cap (only when the policy sets one). Σ committed sibling days + this one.
  if (policy && policy.encashMaxDaysPerYear != null) {
    const cap = Number(policy.encashMaxDaysPerYear);
    let committedDays = 0;
    for (const s of siblings) committedDays += Math.abs(Number(s.days));
    if (committedDays + days > cap + 1e-9) {
      const err = new Error(`Encashment yearly day cap of ${cap} exceeded (concurrent request race)`);
      err.code = 'DECISION_RACE';
      throw err;
    }
  }
}

// onApprove — PENDING → APPROVED. The real debit: release the hold, post the ENCASHMENT
// ledger row, bump encashed+/closing−, snapshot Basic+DA + amount. Version-locked.
async function onApprove(approvalRequest, tx) {
  const reqRow = await loadReq(tx, approvalRequest);
  if (!reqRow || reqRow.status !== 'PENDING') return; // already decided → no-op
  const days = Math.abs(Number(reqRow.days));
  const decidedBy = approvalRequest.decidedBy || null;
  const now = new Date();

  // (1) CONDITIONAL status flip — exactly-once. A lost race → DECISION_RACE (409).
  const flip = await tx.leaveEncashmentRequest.updateMany({
    where: { id: reqRow.id, status: 'PENDING' },
    data: { status: 'APPROVED', decidedAt: now, decidedBy },
  });
  if (flip.count === 0) {
    const err = new Error('Encashment request already decided concurrently');
    err.code = 'DECISION_RACE';
    throw err;
  }

  // (1b) RE-VALIDATE the per-year caps INSIDE the tx (finding #3). The create-time gate
  //      (validateEncashRequest) reads a NON-tx ytd count, so two requests raised when the
  //      count was 0 both pass it — then both reach here and would both debit, busting the
  //      once/year and days/year caps. We re-count the SIBLING committed requests UNDER A
  //      ROW LOCK (FOR UPDATE) so concurrent approvals serialise: the first commits, the
  //      second sees it and is rejected. We lock the sibling rows (excluding this one, now
  //      APPROVED) to pin the count, then re-apply the policy caps with THIS request added.
  await assertCapsWithinTx(tx, reqRow, days);

  // (2) Resolve the snapshot money (last-drawn Basic-only / Basic+DA / gross) and compute
  //     the amount. Valued at APPROVE because the days are debited at APPROVE (spec §10.1)
  //     — a later comp revision must never re-value a surrendered day.
  //
  //     The per-day BASE differs by basis (finding #2):
  //       BASIC_DA_26 → Basic+DA  (basicDaMonthlyMinor)
  //       BASIC_30    → Basic ONLY (basicMonthlyMinor) — NOT Basic+DA (no DA over-pay)
  //       GROSS_30    → gross     (grossMonthlyMinor)
  //     computeEncashAmount takes the "basic-ish" figure in basicDaMonthlyMinor, so we
  //     pass the correct base for the request's basis. We snapshot that SAME base onto the
  //     request so the audit row reflects what was actually paid per day.
  const pay = await resolveLastDrawnPay(approvalRequest.businessId, reqRow.employeeId, tx);
  const basicIshMinor = reqRow.basis === 'BASIC_30'
    ? Number(pay.basicMonthlyMinor || 0)
    : Number(pay.basicDaMonthlyMinor || 0);
  const money = computeEncashAmount({
    basis: reqRow.basis,
    basicDaMonthlyMinor: basicIshMinor,
    grossMonthlyMinor: pay.grossMonthlyMinor,
    days,
  });

  // (3) Resolve the LeaveBalance for this request's period and DEBIT it: post ONE
  //     ENCASHMENT LeaveTransaction (the append-only ledger row that ledger.js scores
  //     as −|q|), bump encashed += days, closing -= days. Version-locked (P2025 on race).
  //     The balance/ledger reconcile invariant (§4.2) holds with ZERO ledger changes.
  const balance = await tx.leaveBalance.findFirst({
    where: { businessId: approvalRequest.businessId, employeeId: reqRow.employeeId, leaveTypeId: reqRow.leaveTypeId, periodCode: reqRow.periodCode },
    select: { id: true, version: true, pendingApproval: true, unit: true },
  });

  let encashmentTxnId = null;
  if (balance) {
    const txn = await tx.leaveTransaction.create({
      data: {
        businessId: approvalRequest.businessId,
        employeeId: reqRow.employeeId,
        leaveTypeId: reqRow.leaveTypeId,
        leaveBalanceId: balance.id,
        txnType: 'ENCASHMENT',
        unit: balance.unit,
        quantity: days, // ledger scores ENCASHMENT as −|q|; stored magnitude
        reason: `In-service leave encashment (${days} day(s))`,
        status: 'APPROVED',
        appliedAt: now,
        decidedAt: now,
        decidedBy,
      },
    });
    encashmentTxnId = txn.id;
    // Release the soft-hold and apply the debit under the version lock.
    await tx.leaveBalance.update({
      where: { id: balance.id, version: balance.version },
      data: {
        pendingApproval: { decrement: flooredRelease(balance.pendingApproval, days) },
        encashed: { increment: days },
        closing: { decrement: days },
        version: { increment: 1 },
      },
    });
  }

  // (4) Stamp the snapshot + the ledger-row link on the request (the secondary
  //     exactly-once guard + the figure the pay pass pays).
  // Snapshot the per-day BASE actually used (finding #2): basic-only for BASIC_30, Basic+DA
  // for BASIC_DA_26 — so perDayMinor reconciles with the stored base for the audit drill-down.
  await tx.leaveEncashmentRequest.update({
    where: { id: reqRow.id },
    data: {
      basicDaMonthlyMinor: BigInt(basicIshMinor || 0),
      perDayMinor: BigInt(money.perDayMinor || 0),
      amountMinor: BigInt(money.amountMinor || 0),
      encashmentTxnId,
    },
  });

  notify.fanOutApprovalDecided({ businessId: approvalRequest.businessId, request: approvalRequest, outcome: 'APPROVED' }).catch(() => {});
}

// onReject — PENDING → REJECTED. Release the hold (floored); NO debit.
async function onReject(approvalRequest, tx) {
  const reqRow = await loadReq(tx, approvalRequest);
  if (!reqRow || reqRow.status !== 'PENDING') return;
  const days = Math.abs(Number(reqRow.days));
  const decidedBy = approvalRequest.decidedBy || null;
  const flip = await tx.leaveEncashmentRequest.updateMany({
    where: { id: reqRow.id, status: 'PENDING' },
    data: { status: 'REJECTED', decidedAt: new Date(), decidedBy },
  });
  if (flip.count === 0) {
    const err = new Error('Encashment request already decided concurrently');
    err.code = 'DECISION_RACE';
    throw err;
  }
  await releaseHold(tx, approvalRequest.businessId, reqRow, days);
  notify.fanOutApprovalDecided({ businessId: approvalRequest.businessId, request: approvalRequest, outcome: 'REJECTED' }).catch(() => {});
}

// onCancel — requester cancel/withdraw while PENDING. Release the hold; NO debit.
async function onCancel(approvalRequest, tx) {
  const reqRow = await loadReq(tx, approvalRequest);
  if (!reqRow || reqRow.status !== 'PENDING') return;
  const days = Math.abs(Number(reqRow.days));
  const decidedBy = approvalRequest.decidedBy || null;
  const flip = await tx.leaveEncashmentRequest.updateMany({
    where: { id: reqRow.id, status: 'PENDING' },
    data: { status: 'CANCELLED', decidedAt: new Date(), decidedBy },
  });
  if (flip.count === 0) {
    const err = new Error('Encashment request already decided concurrently');
    err.code = 'DECISION_RACE';
    throw err;
  }
  await releaseHold(tx, approvalRequest.businessId, reqRow, days);
}

// Release the soft-hold placed at request time (no units consumed). Version-locked.
async function releaseHold(tx, businessId, reqRow, days) {
  const balance = await tx.leaveBalance.findFirst({
    where: { businessId, employeeId: reqRow.employeeId, leaveTypeId: reqRow.leaveTypeId, periodCode: reqRow.periodCode },
    select: { id: true, version: true, pendingApproval: true },
  });
  if (balance) {
    await tx.leaveBalance.update({
      where: { id: balance.id, version: balance.version },
      data: { pendingApproval: { decrement: flooredRelease(balance.pendingApproval, days) }, version: { increment: 1 } },
    });
  }
}

const bundle = { onApprove, onReject, onCancel };

function registerEncashmentConsumer() {
  return consumers.register('LEAVE_ENCASHMENT', bundle);
}

// Self-register on module load (idempotent — the registry overwrites the same bundle),
// like consumers.leave.js, so the callback fires for ANY entrypoint that loads the
// encashment controller. registerConsumers.js is still the explicit boot wiring point.
registerEncashmentConsumer();

module.exports = {
  registerEncashmentConsumer,
  bundle,
  flooredRelease,
  // exported for the unit/live tests + the controller's direct fallback.
  _internals: { onApprove, onReject, onCancel, releaseHold, assertCapsWithinTx },
};
