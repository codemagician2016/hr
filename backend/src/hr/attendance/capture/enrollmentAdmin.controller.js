'use strict';

/**
 * enrollmentAdmin.controller.js — HR-admin surface for face registrations
 * (Feature 39). Operator session; tenant-scoped; mutations canManageAttendance-gated
 * at the route. Covers the enrolment register (PENDING queue + ACTIVE roster),
 * approve/reject (driving the F10 engine so the approvals inbox stays consistent),
 * revoke, and HR direct-enrolment on behalf of an employee (immediately ACTIVE —
 * HR is the approver, so a separate approval round-trip would be theatre).
 */

const prisma = require('../../../core/lib/prisma');
const { Prisma } = require('@prisma/client');
const s3 = require('../../../core/lib/s3');
const { writeAudit } = require('../../../core/lib/audit');
const engine = require('../../approvals/engine');
const faceMatcher = require('./faceMatcher');

// Selfie data-URL validation — mirrors meAttendance.validateSelfieDataUrl (the ESS
// punch path keeps its own copy; both enforce the same MIME + size cap).
const MAX_SELFIE_BYTES = 6 * 1024 * 1024;
function validateSelfieDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return { ok: false, status: 400, message: 'selfieDataUrl is required' };
  const m = /^data:(image\/(?:png|jpe?g|webp))(;base64)?,(.*)$/i.exec(dataUrl);
  if (!m || !m[2]) return { ok: false, status: 422, message: 'selfieDataUrl must be a base64 image data URL (png/jpeg/webp)' };
  const approxBytes = Math.floor(((m[3] || '').length * 3) / 4);
  if (approxBytes > MAX_SELFIE_BYTES) return { ok: false, status: 413, message: `Selfie exceeds the ${MAX_SELFIE_BYTES / (1024 * 1024)} MB limit` };
  return { ok: true, dataUrl };
}

async function storeSelfie(businessId, dataUrl) {
  if (s3.isConfigured()) {
    try {
      const up = await s3.uploadDataUrl({ dataUrl, businessId, scope: 'attendance-selfie' });
      return up.url;
    } catch (_e) { return dataUrl; }
  }
  return dataUrl;
}

function clampPage(query) {
  const take = Math.min(Math.max(parseInt(query.pageSize, 10) || 25, 1), 100);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { take, skip: (page - 1) * take, page };
}

const STATUSES = ['PENDING', 'ACTIVE', 'REJECTED', 'REVOKED'];

// ── GET /attendance/capture/enrollments?status=PENDING ────────────────────────
async function listEnrollments(req, res, next) {
  try {
    const { businessId } = req.user;
    const { take, skip, page } = clampPage(req.query);
    const status = STATUSES.includes(req.query.status) ? req.query.status : 'PENDING';
    const where = { businessId, status };
    const [items, total] = await Promise.all([
      prisma.faceEnrollment.findMany({
        where,
        orderBy: { enrolledAt: 'desc' },
        skip,
        take,
        select: {
          id: true, employeeId: true, imageUrl: true, matcher: true, detScore: true,
          status: true, enrolledAt: true, enrolledBy: true,
          approvalRequestId: true, decidedBy: true, decidedAt: true, decisionNote: true,
        },
      }),
      prisma.faceEnrollment.count({ where }),
    ]);
    const empIds = [...new Set(items.map((r) => r.employeeId))];
    let empById = {};
    if (empIds.length) {
      const emps = await prisma.employee.findMany({
        where: { businessId, id: { in: empIds } },
        select: { id: true, code: true, firstName: true, lastName: true },
      });
      empById = Object.fromEntries(emps.map((e) => [e.id, e]));
    }
    res.json({ items: items.map((r) => ({ ...r, employee: empById[r.employeeId] || null })), total, page, pageSize: take });
  } catch (e) { next(e); }
}

// ── POST /attendance/capture/enrollments/:id/decide { decision, note? } ────────
// decision 'APPROVE' | 'REJECT'. Drives the F10 engine (recordDecision) so the same
// request is equally decidable from the approvals inbox — the consumer flips the
// enrolment row inside the engine transaction. Rows with no approvalRequestId
// (legacy/edge) are flipped directly, audited.
async function decideEnrollment(req, res, next) {
  try {
    const { businessId } = req.user;
    const row = await prisma.faceEnrollment.findFirst({
      where: { id: req.params.id, businessId },
      select: { id: true, status: true, approvalRequestId: true, employeeId: true },
    });
    if (!row) return res.status(404).json({ message: 'enrollment not found' });
    if (row.status !== 'PENDING') return res.status(409).json({ message: `Enrollment is ${row.status}, not decidable` });
    const decision = String((req.body && req.body.decision) || '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(decision)) return res.status(400).json({ message: "decision must be 'APPROVE' or 'REJECT'" });
    const note = (req.body && req.body.note) || null;
    if (decision === 'REJECT' && !note) return res.status(400).json({ message: 'A reason (note) is required to reject' });

    if (row.approvalRequestId) {
      try {
        await engine.recordDecision({
          approvalRequestId: row.approvalRequestId,
          actorUserId: req.user.id,
          decision: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          comment: note,
        });
      } catch (ee) {
        const status = ee.statusCode || 500;
        if (ee.code === 'NOT_AN_APPROVER') {
          return res.status(403).json({ message: 'You are not in the approver chain for this request — decide it from the Approvals inbox, or have an HR approver act.' });
        }
        if (ee.code === 'NOT_PENDING' || ee.code === 'NO_ACTIVE_LEVEL') {
          // Engine request already closed but the row is still PENDING (edge) —
          // fall through to the direct flip below rather than stranding the row.
        } else {
          return res.status(status).json({ message: ee.message || 'Decision failed' });
        }
      }
    }

    // Direct flip when there is no (usable) engine request. The consumer's own flip
    // is idempotent-guarded, so at most one of the two paths mutates the row.
    await prisma.faceEnrollment.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: decision === 'APPROVE'
        ? { status: 'ACTIVE', isActive: true, decidedBy: req.user.id || null, decidedAt: new Date(), decisionNote: null, version: { increment: 1 } }
        : { status: 'REJECTED', decidedBy: req.user.id || null, decidedAt: new Date(), decisionNote: note, version: { increment: 1 } },
    });
    const fresh = await prisma.faceEnrollment.findUnique({ where: { id: row.id } });
    await writeAudit({ businessId, actorId: req.user.id, action: `attendance.face.${decision.toLowerCase()}`, entityType: 'FaceEnrollment', entityId: row.id, meta: { employeeId: row.employeeId } }).catch(() => {});
    res.json(fresh);
  } catch (e) { next(e); }
}

// ── POST /attendance/capture/enrollments/:id/revoke { note? } ─────────────────
// Pull an ACTIVE reference (compromise / exit / bad enrolment discovered late).
// Face punching for the employee stops matching until a new enrolment is approved.
async function revokeEnrollment(req, res, next) {
  try {
    const { businessId } = req.user;
    const row = await prisma.faceEnrollment.findFirst({
      where: { id: req.params.id, businessId },
      select: { id: true, status: true, employeeId: true },
    });
    if (!row) return res.status(404).json({ message: 'enrollment not found' });
    if (row.status !== 'ACTIVE') return res.status(409).json({ message: `Enrollment is ${row.status}, only ACTIVE can be revoked` });
    const updated = await prisma.faceEnrollment.update({
      where: { id: row.id },
      data: {
        status: 'REVOKED',
        isActive: false,
        decidedBy: req.user.id || null,
        decidedAt: new Date(),
        decisionNote: (req.body && req.body.note) || null,
        version: { increment: 1 },
      },
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'attendance.face.revoke', entityType: 'FaceEnrollment', entityId: row.id, meta: { employeeId: row.employeeId } }).catch(() => {});
    res.json(updated);
  } catch (e) { next(e); }
}

// ── POST /attendance/capture/enrollments { employeeId, selfieDataUrl } ────────
// HR enrols ON BEHALF (onboarding desk / kiosk). Immediately ACTIVE — the acting HR
// operator IS the approver (recorded as decidedBy). Supersedes any open request.
async function hrEnroll(req, res, next) {
  try {
    const { businessId } = req.user;
    const employeeId = req.body && req.body.employeeId;
    if (!employeeId) return res.status(400).json({ message: 'employeeId is required' });
    const emp = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null }, select: { id: true } });
    if (!emp) return res.status(404).json({ message: 'employee not found' });
    const check = validateSelfieDataUrl(req.body && req.body.selfieDataUrl);
    if (!check.ok) return res.status(check.status).json({ message: check.message });

    let embedded;
    try {
      embedded = await faceMatcher.getMatcher().embed(check.dataUrl, { purpose: 'enroll' });
    } catch (fe) {
      if (fe && fe.statusCode === 422 && fe.code) return res.status(422).json({ message: fe.message, reason: fe.code });
      throw fe;
    }
    const imageUrl = await storeSelfie(businessId, check.dataUrl);

    const prev = await prisma.faceEnrollment.findFirst({
      where: { businessId, employeeId: emp.id },
      select: { approvalRequestId: true, status: true },
    });
    if (prev && prev.approvalRequestId && prev.status === 'PENDING') {
      try {
        await engine.cancel({ approvalRequestId: prev.approvalRequestId, actorUserId: req.user.id || 'SYSTEM', comment: 'Superseded by an HR direct enrolment' });
      } catch (_e) { /* already closed */ }
    }

    const row = await prisma.faceEnrollment.upsert({
      where: { businessId_employeeId: { businessId, employeeId: emp.id } },
      create: {
        businessId, employeeId: emp.id, imageUrl,
        embedding: embedded.embedding || undefined,
        matcher: embedded.matcher || null,
        enrolledBy: req.user.id || null,
        status: 'ACTIVE',
        decidedBy: req.user.id || null,
        decidedAt: new Date(),
        detScore: embedded.detScore != null ? embedded.detScore : null,
      },
      update: {
        imageUrl,
        // Explicitly CLEAR a stale embedding when this capture produced none (stub).
        embedding: embedded.embedding == null ? Prisma.DbNull : embedded.embedding,
        matcher: embedded.matcher || null,
        isActive: true,
        enrolledAt: new Date(),
        enrolledBy: req.user.id || null,
        status: 'ACTIVE',
        approvalRequestId: null,
        decidedBy: req.user.id || null,
        decidedAt: new Date(),
        decisionNote: null,
        detScore: embedded.detScore != null ? embedded.detScore : null,
        version: { increment: 1 },
      },
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'attendance.face.hr_enroll', entityType: 'FaceEnrollment', entityId: row.id, meta: { employeeId: emp.id } }).catch(() => {});
    res.status(201).json(row);
  } catch (e) { next(e); }
}

module.exports = {
  listEnrollments,
  decideEnrollment,
  revokeEnrollment,
  hrEnroll,
};
