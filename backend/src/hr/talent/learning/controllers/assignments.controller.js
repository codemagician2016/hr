'use strict';

/**
 * assignments.controller.js — Feature 37 operator assignment surface (/api/hr/learning).
 * Create an assignment (audience + mandatory + due + recurrence + newJoinerRule) → fan
 * out NOW via assignmentService.fanOut (reuses engagement audience targeting). Manage,
 * sync (idempotent re-fan), waive an enrollment, reissue a certificate (F9 reuse).
 */

const prisma = require('../../../../core/lib/prisma');
const { writeAudit } = require('../../../../core/lib/audit');
const { fanOut, cycleKeyFor } = require('../assignmentService');
const certificate = require('../certificate');
const learnNotify = require('../notify');

function biz(req) { return req.user.businessId; }
function actor(req) { return (req.user && (req.user.id || req.user.userId)) || 'system'; }

const SCOPES = new Set(['ALL', 'ENTITY', 'DEPARTMENT', 'ROLE', 'SPECIFIC']);

async function loadCourse(businessId, courseId) {
  return prisma.course.findFirst({ where: { id: courseId, businessId, deletedAt: null } });
}

async function bizName(businessId) {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } });
  return (b && b.name) || 'HR';
}

// POST /courses/:id/assignments
async function createAssignment(req, res, next) {
  try {
    const businessId = biz(req);
    const course = await loadCourse(businessId, req.params.id);
    if (!course) return res.status(404).json({ message: 'Course not found' });
    if (course.status !== 'PUBLISHED') return res.status(422).json({ message: 'Publish the course before assigning it' });

    const scope = req.body.audienceScope || 'ALL';
    if (!SCOPES.has(scope)) return res.status(400).json({ message: 'invalid audienceScope' });

    const assignment = await prisma.courseAssignment.create({
      data: {
        businessId, courseId: course.id,
        audienceScope: scope,
        audienceEntityIds: Array.isArray(req.body.audienceEntityIds) ? req.body.audienceEntityIds : [],
        audienceDeptIds: Array.isArray(req.body.audienceDeptIds) ? req.body.audienceDeptIds : [],
        audienceRoleIds: Array.isArray(req.body.audienceRoleIds) ? req.body.audienceRoleIds : [],
        audienceEmployeeIds: Array.isArray(req.body.audienceEmployeeIds) ? req.body.audienceEmployeeIds : [],
        isMandatory: req.body.isMandatory !== false,
        dueInDays: req.body.dueInDays != null ? Number(req.body.dueInDays) : null,
        dueOn: req.body.dueOn ? new Date(req.body.dueOn) : null,
        recurrence: req.body.recurrence || 'NONE',
        newJoinerRule: !!req.body.newJoinerRule,
        newJoinerWithinDays: req.body.newJoinerWithinDays != null ? Number(req.body.newJoinerWithinDays) : 30,
        active: true,
        createdBy: actor(req),
      },
    });

    const name = await bizName(businessId);
    const result = await fanOut(assignment, {
      asOf: new Date(),
      actorUserId: actor(req),
      notify: (employee, enrollment) => learnNotify.assigned({ businessId, employee, course, enrollment, bizName: name }),
    });
    return res.status(201).json({ assignment, fanOut: result });
  } catch (e) { return next(e); }
}

// GET /courses/:id/assignments — with coverage counts
async function listAssignments(req, res, next) {
  try {
    const businessId = biz(req);
    const course = await loadCourse(businessId, req.params.id);
    if (!course) return res.status(404).json({ message: 'Course not found' });
    const assignments = await prisma.courseAssignment.findMany({
      where: { businessId, courseId: course.id, deletedAt: null }, orderBy: { createdAt: 'desc' },
      include: { _count: { select: { enrollments: true } } },
    });
    const ids = assignments.map((a) => a.id);
    const grouped = ids.length
      ? await prisma.enrollment.groupBy({ by: ['assignmentId', 'status'], where: { businessId, assignmentId: { in: ids } }, _count: true })
      : [];
    const byAssignment = {};
    for (const g of grouped) {
      if (!g.assignmentId) continue;
      byAssignment[g.assignmentId] = byAssignment[g.assignmentId] || { assigned: 0, completed: 0 };
      byAssignment[g.assignmentId].assigned += g._count;
      if (g.status === 'COMPLETED') byAssignment[g.assignmentId].completed += g._count;
    }
    const items = assignments.map((a) => ({
      ...a, enrolledCount: a._count.enrollments,
      completedCount: (byAssignment[a.id] && byAssignment[a.id].completed) || 0, _count: undefined,
    }));
    return res.json({ items });
  } catch (e) { return next(e); }
}

// DELETE /assignments/:id — soft delete + deactivate (existing enrollments kept)
async function deleteAssignment(req, res, next) {
  try {
    const businessId = biz(req);
    const a = await prisma.courseAssignment.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!a) return res.status(404).json({ message: 'Not found' });
    await prisma.courseAssignment.update({ where: { id: a.id }, data: { active: false, deletedAt: new Date() } });
    return res.json({ ok: true });
  } catch (e) { return next(e); }
}

// POST /assignments/:id/sync — idempotent re-fan (picks up new in-audience employees)
async function syncAssignment(req, res, next) {
  try {
    const businessId = biz(req);
    const a = await prisma.courseAssignment.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!a) return res.status(404).json({ message: 'Not found' });
    const course = await loadCourse(businessId, a.courseId);
    const name = await bizName(businessId);
    const result = await fanOut(a, {
      asOf: new Date(), cycleKey: cycleKeyFor(a, new Date()), actorUserId: actor(req),
      notify: course ? (employee, enrollment) => learnNotify.assigned({ businessId, employee, course, enrollment, bizName: name }) : undefined,
    });
    return res.json({ ok: true, fanOut: result });
  } catch (e) { return next(e); }
}

// POST /enrollments/:id/waive — exempt with a reason (audit)
async function waiveEnrollment(req, res, next) {
  try {
    const businessId = biz(req);
    const reason = req.body && req.body.reason;
    if (!reason) return res.status(400).json({ message: 'reason is required' });
    const en = await prisma.enrollment.findFirst({ where: { id: req.params.id, businessId } });
    if (!en) return res.status(404).json({ message: 'Not found' });
    const updated = await prisma.enrollment.update({
      where: { id: en.id }, data: { status: 'WAIVED', waivedReason: reason, waivedBy: actor(req), version: { increment: 1 } },
    });
    await writeAudit({ businessId, actorId: actor(req), action: 'learning.enrollment.waive', entityType: 'Enrollment', entityId: en.id, meta: { reason } });
    return res.json(updated);
  } catch (e) { return next(e); }
}

// POST /enrollments/:id/reissue-cert — re-mint via F9 reissueLetter
async function reissueCert(req, res, next) {
  try {
    const businessId = biz(req);
    const en = await prisma.enrollment.findFirst({ where: { id: req.params.id, businessId } });
    if (!en) return res.status(404).json({ message: 'Not found' });
    if (!en.certificateLetterId) return res.status(409).json({ message: 'No certificate has been issued for this enrollment' });
    const result = await certificate.reissueForEnrollment({ businessId, enrollment: en, actorUserId: actor(req), reason: (req.body && req.body.reason) || undefined });
    await writeAudit({ businessId, actorId: actor(req), action: 'learning.cert.reissue', entityType: 'Enrollment', entityId: en.id });
    return res.json({ ok: true, referenceNo: result && result.referenceNo });
  } catch (e) { return next(e); }
}

module.exports = { createAssignment, listAssignments, deleteAssignment, syncAssignment, waiveEnrollment, reissueCert };
