'use strict';

/**
 * consumers.compOff.js — Feature 30. The COMP_OFF (comp-off EARN) consumer bundle.
 *
 * Comp-off EARN approval routes through the F10 engine under its own WorkflowModule
 * (COMP_OFF) so it never collides with the LEAVE consumer's APPLICATION handler. The
 * engine decides WHEN the credit is approved/rejected (manager green-lights via the
 * generic BUILT_IN_DEFAULT chain); these callbacks carry the domain effect INSIDE the
 * engine transaction:
 *
 *   onApprove(req, tx) — PENDING → ACTIVE: finalizeCredit (post the ACCRUAL ledger
 *                        row + bump the aggregate COMP_OFF LeaveBalance). Notify employee.
 *   onReject(req, tx)  — PENDING → VOIDED: no balance effect. Notify employee.
 *   onCancel(req, tx)  — requester withdrew → VOIDED (no balance effect).
 *
 * finalizeCredit is conditional-flip guarded (PENDING-only), so a duplicate/re-fired
 * hook is a safe no-op. Self-registers like consumers.leave.js.
 */

const consumers = require('./consumers');
const { finalizeCredit, voidCredit } = require('../leave/compoff/finalizeCredit');
const { resolveCompOffType } = require('../leave/compoff/compOffConfig');
const { notifyHrEvent } = require('../integrations/notifications');

function isoDay(d) {
  const x = d instanceof Date ? d : new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())).toISOString().slice(0, 10);
}
function emailOf(emp) { return emp ? (emp.workEmail || emp.personalEmail || null) : null; }

async function loadCredit(tx, approvalRequest) {
  return tx.compOffCredit.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId },
  });
}

// Resolve the COMP_OFF leaveTypeId + the employee's tax-year start (for the period).
async function resolveFinalizeCtx(tx, businessId, employeeId) {
  const typeCtx = await resolveCompOffType(businessId, { tx });
  const employment = await tx.employmentRecord.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    select: { entity: { select: { taxYearStartMonth: true } } },
  });
  return {
    leaveTypeId: typeCtx && typeCtx.leaveType ? typeCtx.leaveType.id : null,
    taxYearStartMonth: (employment && employment.entity && employment.entity.taxYearStartMonth) || 4,
  };
}

// onApprove — PENDING → ACTIVE via finalizeCredit (atomic with the approval).
async function onApprove(approvalRequest, tx) {
  const credit = await loadCredit(tx, approvalRequest);
  if (!credit || credit.status !== 'PENDING') return; // already decided / voided → no-op
  const { leaveTypeId, taxYearStartMonth } = await resolveFinalizeCtx(tx, credit.businessId, credit.employeeId);
  if (!leaveTypeId) {
    // No COMP_OFF type seeded — cannot bridge to a balance. Leave PENDING; an ops
    // re-run after seeding the type will finalize it. (Don't silently lose the credit.)
    console.error('[comp-off approve] no COMP_OFF leave type for business', credit.businessId);
    return;
  }
  await finalizeCredit(tx, { credit, leaveTypeId, taxYearStartMonth, decidedBy: approvalRequest.decidedBy || null });

  // Notify the employee (fire-and-forget, outside-effect; the helper uses default prisma).
  const emp = await tx.employee.findFirst({
    where: { id: credit.employeeId, businessId: credit.businessId },
    select: { firstName: true, workEmail: true, personalEmail: true },
  });
  const email = emailOf(emp);
  if (email) {
    notifyHrEvent({
      businessId: credit.businessId, event: 'comp-off.earned', recipientEmail: email,
      variables: {
        NAME: (emp && emp.firstName) || 'there', DAYS: String(Number(credit.quantity)),
        SOURCE: String(credit.sourceKind).replace('_', ' ').toLowerCase(),
        DATE: isoDay(credit.sourceDate), EXPIRES: isoDay(credit.expiresOn), BIZ: '',
      },
      triggeredBy: 'COMP_OFF_EARNED',
    }).catch(() => {});
  }
}

// onReject — PENDING → VOIDED. No balance was ever bumped.
async function onReject(approvalRequest, tx) {
  const credit = await loadCredit(tx, approvalRequest);
  if (!credit || credit.status !== 'PENDING') return;
  const reason = (approvalRequest.payloadJson && approvalRequest.payloadJson.rejectReason) || 'Comp-off earn rejected';
  await voidCredit(tx, { credit, decidedBy: approvalRequest.decidedBy || null, reason });
}

// onCancel — requester withdrew the earn → VOIDED.
async function onCancel(approvalRequest, tx) {
  const credit = await loadCredit(tx, approvalRequest);
  if (!credit || credit.status !== 'PENDING') return;
  await voidCredit(tx, { credit, decidedBy: approvalRequest.decidedBy || null, reason: 'Comp-off earn withdrawn' });
}

const bundle = { onApprove, onReject, onCancel };

function registerCompOffConsumer() {
  return consumers.register('COMP_OFF', bundle);
}

// Self-register on module load (idempotent), mirroring consumers.leave.js.
registerCompOffConsumer();

module.exports = { registerCompOffConsumer, bundle };
