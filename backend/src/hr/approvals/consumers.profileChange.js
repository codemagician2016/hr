'use strict';

/**
 * consumers.profileChange.js — Feature 13 §5.2. The PROFILE_CHANGE consumer bundle.
 *
 * The engine never knows profile semantics; it decides WHEN the chain completes. The
 * domain effect (apply newValue into the correct Prisma model + flip the
 * ProfileChangeRequest status + notify the employee) is carried HERE, in callbacks the
 * engine fires INSIDE its own transaction so the field write commits atomically with
 * the approval transition.
 *
 *   onApprove(req, tx) — chain APPROVED: re-validate statutory format, optimistic-
 *                        concurrency-check the target row's version, write the typed
 *                        value into employee | bankAccount | statutoryProfile, mark the
 *                        ProfileChangeRequest APPROVED, notify the employee.
 *   onReject(req, tx)  — mark the ProfileChangeRequest REJECTED; the real row is
 *                        untouched. Notify the employee.
 *   onCancel(req, tx)  — requester withdrew (or it was superseded): mark CANCELLED.
 *
 * SoD is enforced by the engine itself (recordDecision: actor ≠ requester's user); the
 * HR controller adds the extra "operator ≠ the request's own linked employee" guard.
 * Concurrency: a target-row version mismatch throws CONCURRENT_UPDATE (→409), so an
 * approval can never silently clobber a newer HR edit.
 */

const consumers = require('./consumers');
const v = require('../lifecycle/validators');

function err(code, message, status) {
  const e = new Error(message || code); e.code = code; if (status) e.statusCode = status; return e;
}

// Re-run the statutory format validator at COMMIT (twice-validated, §9). Returns the
// canonical value or throws BAD_REQUEST.
const COMMIT_VALIDATORS = {
  'statutory.pan': v.normalizePAN,
  'statutory.uan': v.normalizeUAN,
  'statutory.irdNumber': v.normalizeIRD,
  'bank.ifsc': v.normalizeIFSC,
  'bank.nzBankAccount': v.normalizeNZBank,
};
function canonicalize(field, value) {
  if (COMMIT_VALIDATORS[field]) {
    const canon = COMMIT_VALIDATORS[field](value);
    if (!canon) throw err('BAD_REQUEST', `Invalid ${field} at commit`, 400);
    return canon;
  }
  return value;
}

// Load the ProfileChangeRequest this ApprovalRequest is gating. Tolerant of an
// already-terminal row (a re-fired/duplicate hook then no-ops).
async function loadCr(tx, approvalRequest) {
  return tx.profileChangeRequest.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId },
  });
}

// Write the approved value into the correct model, version-locked. `field` is the
// fieldKey ("dateOfBirth", "bank.ifsc", "statutory.pan"…).
async function commitField(tx, businessId, employeeId, field, newValue) {
  const value = canonicalize(field, newValue);

  if (field.startsWith('bank.')) {
    const col = field.split('.')[1];
    const bank = await tx.bankAccount.findFirst({ where: { businessId, employeeId, isPrimary: true, deletedAt: null }, select: { id: true, version: true } });
    if (!bank) throw err('NOT_FOUND', 'No primary bank account to update', 404);
    const flip = await tx.bankAccount.updateMany({ where: { id: bank.id, version: bank.version }, data: { [col]: value, version: { increment: 1 } } });
    if (flip.count === 0) throw err('CONCURRENT_UPDATE', 'Bank account changed concurrently', 409);
    return;
  }
  if (field.startsWith('statutory.')) {
    const col = field.split('.')[1];
    const sp = await tx.statutoryProfile.findFirst({ where: { businessId, employeeId }, select: { id: true, version: true } });
    if (!sp) throw err('NOT_FOUND', 'No statutory profile to update', 404);
    const flip = await tx.statutoryProfile.updateMany({ where: { id: sp.id, version: sp.version }, data: { [col]: value, version: { increment: 1 } } });
    if (flip.count === 0) throw err('CONCURRENT_UPDATE', 'Statutory profile changed concurrently', 409);
    return;
  }
  // Employee column (firstName/lastName/dateOfBirth/gender/middleName).
  const emp = await tx.employee.findFirst({ where: { id: employeeId, businessId }, select: { id: true, version: true } });
  if (!emp) throw err('NOT_FOUND', 'Employee not found', 404);
  const data = field === 'dateOfBirth' ? { dateOfBirth: value ? new Date(value) : null } : { [field]: value };
  const flip = await tx.employee.updateMany({ where: { id: emp.id, version: emp.version }, data: { ...data, version: { increment: 1 } } });
  if (flip.count === 0) throw err('CONCURRENT_UPDATE', 'Employee changed concurrently', 409);
}

async function notifyEmployee(tx, businessId, employeeId, field, outcome) {
  try {
    const emp = await tx.employee.findFirst({ where: { id: employeeId, businessId }, select: { userId: true } });
    if (!emp || !emp.userId) return;
    await tx.notification.create({
      data: {
        businessId, recipientUserId: emp.userId, type: 'APPROVAL_PENDING', channel: 'IN_APP',
        title: outcome === 'APPROVED' ? 'Profile change approved' : 'Profile change declined',
        body: `Your requested change to "${field}" was ${outcome === 'APPROVED' ? 'approved and applied' : 'declined'}.`,
        entityType: 'ProfileChangeRequest', entityId: null,
        dataJson: { field, outcome },
      },
    });
  } catch (_e) { /* best-effort; a notification failure must not roll back the commit */ }
}

async function onApprove(approvalRequest, tx) {
  const cr = await loadCr(tx, approvalRequest);
  if (!cr || cr.status !== 'PENDING') return; // already decided/superseded → no-op
  await commitField(tx, cr.businessId, cr.employeeId, cr.field, cr.newValue);
  const flip = await tx.profileChangeRequest.updateMany({
    where: { id: cr.id, status: 'PENDING', version: cr.version },
    data: { status: 'APPROVED', decidedBy: approvalRequest.decidedBy || null, decidedAt: new Date(), version: { increment: 1 } },
  });
  if (flip.count === 0) throw err('CONCURRENT_UPDATE', 'Change request changed concurrently', 409);
  await notifyEmployee(tx, cr.businessId, cr.employeeId, cr.field, 'APPROVED');
}

async function onReject(approvalRequest, tx) {
  const cr = await loadCr(tx, approvalRequest);
  if (!cr || cr.status !== 'PENDING') return;
  await tx.profileChangeRequest.updateMany({
    where: { id: cr.id, status: 'PENDING' },
    data: { status: 'REJECTED', decidedBy: approvalRequest.decidedBy || null, decidedAt: new Date() },
  });
  await notifyEmployee(tx, cr.businessId, cr.employeeId, cr.field, 'REJECTED');
}

async function onCancel(approvalRequest, tx) {
  const cr = await loadCr(tx, approvalRequest);
  if (!cr || cr.status !== 'PENDING') return;
  await tx.profileChangeRequest.updateMany({
    where: { id: cr.id, status: 'PENDING' },
    data: { status: 'CANCELLED', decidedAt: new Date() },
  });
}

const bundle = { onApprove, onReject, onCancel };

function registerProfileChangeConsumer() {
  return consumers.register('PROFILE_CHANGE', bundle);
}

// Self-register on module load (idempotent), mirroring consumers.leave/expense so the
// callback fires for ANY entrypoint that loads this module (tests, scripts, the API).
registerProfileChangeConsumer();

module.exports = { registerProfileChangeConsumer, bundle, commitField, _internals: { canonicalize } };
