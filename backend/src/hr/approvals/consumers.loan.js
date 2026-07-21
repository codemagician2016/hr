'use strict';

/**
 * consumers.loan.js — Program Phase 2: the LOAN consumer bundle.
 *
 * The engine decides WHEN; the domain effect (status flip + EMI schedule build)
 * lives HERE, fired inside the engine tx. Bodies mirror loans.controller
 * approve/reject exactly (ZERO behaviour change): approve regenerates the
 * installment schedule cleanly and stamps totalPayable/outstanding; reject is a
 * pure flip. Both are guarded conditional flips (a lost race → no-op re-fire,
 * matching the controller's DRAFT/PENDING state guard).
 *
 * Requests are keyed entityType 'Loan' / entityId = Loan.id, opened at submit
 * (loans.controller.submit) and decided either from the approvals inbox or via
 * the legacy direct routes (which drive engine.recordDecision systemActor).
 */

const consumers = require('./consumers');

async function loadLoan(tx, approvalRequest) {
  return tx.loan.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId, deletedAt: null },
  });
}

async function onApprove(approvalRequest, tx) {
  const loan = await loadLoan(tx, approvalRequest);
  if (!loan || !['DRAFT', 'PENDING'].includes(loan.status)) return; // already decided → no-op re-fire
  // Schedule math is the controller's buildSchedule — required lazily to avoid
  // a module cycle (controller requires the engine which fires this consumer).
  const { _buildSchedule, _fromCents } = require('../controllers/loans.controller');
  const { rows, totalPayableC } = _buildSchedule(loan);
  const totalPayable = _fromCents(totalPayableC);
  // Regenerate cleanly in case of a prior partial attempt (controller idiom).
  await tx.loanInstallment.deleteMany({ where: { businessId: loan.businessId, loanId: loan.id } });
  await tx.loanInstallment.createMany({
    data: rows.map((r) => ({ ...r, businessId: loan.businessId, loanId: loan.id })),
  });
  await tx.loan.update({
    where: { id: loan.id },
    data: {
      status: 'APPROVED',
      approvedAt: new Date(),
      approvedBy: approvalRequest.decidedBy || null,
      totalPayable,
      outstanding: totalPayable,
      amountRepaid: '0',
    },
  });
}

async function onReject(approvalRequest, tx) {
  const loan = await loadLoan(tx, approvalRequest);
  if (!loan || !['DRAFT', 'PENDING'].includes(loan.status)) return;
  // The reject reason lives on the terminal ApprovalAction row.
  const lastAction = await tx.approvalAction.findFirst({
    where: { approvalRequestId: approvalRequest.id, decision: 'REJECTED' },
    orderBy: { createdAt: 'desc' },
    select: { comment: true },
  });
  await tx.loan.update({
    where: { id: loan.id },
    data: { status: 'REJECTED', rejectedAt: new Date(), rejectReason: (lastAction && lastAction.comment) || null },
  });
}

async function onCancel(approvalRequest, tx) {
  const loan = await loadLoan(tx, approvalRequest);
  if (!loan || !['DRAFT', 'PENDING'].includes(loan.status)) return;
  await tx.loanInstallment.deleteMany({ where: { businessId: loan.businessId, loanId: loan.id } });
  await tx.loan.update({ where: { id: loan.id }, data: { status: 'CANCELLED' } });
}

function registerLoanConsumer() {
  consumers.register('LOAN', { onApprove, onReject, onCancel });
}

registerLoanConsumer();

module.exports = { registerLoanConsumer, _internal: { onApprove, onReject, onCancel } };
