'use strict';

/**
 * assignmentService.js — the LMS assignment fan-out engine (Feature 37 §6.1).
 *
 * fanOut(assignment, { cycleKey }) resolves the target employees via the engagement
 * audience engine (resolveLearningAudienceEmployees — the announcement targeting plus
 * the ROLE branch; NO new scope engine) and upserts one Enrollment per employee on the
 * @@unique([businessId, employeeId, courseId, cycleKey]) guard → idempotent. A re-run
 * (sync / nightly cron) never double-enrolls within a cycle; it only ADDS newly-in-
 * audience employees. The assignment-notify fires only on a FIRST create (no storm).
 */

const prisma = require('../../../core/lib/prisma');
const { resolveLearningAudienceEmployees } = require('../../engagement/audience');
const { writeAudit } = require('../../../core/lib/audit');

/** Default recurrence cycle key for an assignment as-of a date. */
function cycleKeyFor(assignment, asOf = new Date()) {
  const rec = assignment.recurrence || 'NONE';
  if (rec === 'ANNUAL') return String(asOf.getUTCFullYear());
  if (rec === 'HALF_YEARLY') return `${asOf.getUTCFullYear()}H${asOf.getUTCMonth() < 6 ? 1 : 2}`;
  if (rec === 'QUARTERLY') return `${asOf.getUTCFullYear()}Q${Math.floor(asOf.getUTCMonth() / 3) + 1}`;
  return 'once'; // NONE — a single, stable cycle (sentinel keeps the unique meaningful)
}

/** Resolve the dueAt for an enrollment given the assignment + an assignedAt anchor. */
function resolveDueAt(assignment, assignedAt) {
  if (assignment.dueOn) return new Date(assignment.dueOn);
  if (assignment.dueInDays != null) {
    const d = new Date(assignedAt);
    d.setUTCDate(d.getUTCDate() + Number(assignment.dueInDays));
    return d;
  }
  return null;
}

/**
 * Fan an assignment out to its in-audience employees.
 * @param {Object} assignment  a CourseAssignment row (with audience* + course meta)
 * @param {Object} [opts]
 * @param {string} [opts.cycleKey]  override the cycle key (recurrence re-assign)
 * @param {Date}   [opts.asOf]
 * @param {Function} [opts.notify]  optional notify hook (employee, enrollment) => void; defaults to learning.assigned
 * @param {Array}  [opts.onlyEmployeeIds]  restrict the fan-out to this id set (new-joiner cron)
 * @returns {{ created:number, existing:number, total:number, cycleKey:string }}
 */
async function fanOut(assignment, opts = {}) {
  const asOf = opts.asOf || new Date();
  const cycleKey = opts.cycleKey || cycleKeyFor(assignment, asOf);
  const businessId = assignment.businessId;

  let employees = await resolveLearningAudienceEmployees(assignment, { cap: 2000 });
  if (opts.onlyEmployeeIds && Array.isArray(opts.onlyEmployeeIds)) {
    const allow = new Set(opts.onlyEmployeeIds);
    employees = employees.filter((e) => allow.has(e.id));
  }

  let created = 0;
  let existing = 0;
  const newlyCreated = [];

  for (const emp of employees) {
    try {
      // Idempotent: the @@unique on (businessId, employeeId, courseId, cycleKey) makes
      // a re-run a no-op for an already-enrolled employee. We detect "first create" by
      // a pre-check (read) so the notify fires once, never on re-runs.
      const prior = await prisma.enrollment.findUnique({
        where: {
          businessId_employeeId_courseId_cycleKey: {
            businessId, employeeId: emp.id, courseId: assignment.courseId, cycleKey,
          },
        },
        select: { id: true },
      });
      if (prior) { existing += 1; continue; }

      const dueAt = resolveDueAt(assignment, asOf);
      const enrollment = await prisma.enrollment.create({
        data: {
          businessId,
          courseId: assignment.courseId,
          assignmentId: assignment.id,
          employeeId: emp.id,
          isMandatory: !!assignment.isMandatory,
          status: 'ASSIGNED',
          assignedAt: asOf,
          dueAt,
          cycleKey,
          progressPct: 0,
        },
      });
      created += 1;
      newlyCreated.push({ employee: emp, enrollment });
    } catch (e) {
      // A concurrent create collides on the unique → treat as existing (idempotent).
      if (e && e.code === 'P2002') { existing += 1; continue; }
      // Per-row failure must not abort the whole fan-out (mirror the cron per-row guard).
      // eslint-disable-next-line no-console
      console.error('[learning.fanout] employee', emp.id, e.message);
    }
  }

  // Best-effort assignment-notify, only on first create (deduped).
  if (typeof opts.notify === 'function') {
    for (const { employee, enrollment } of newlyCreated) {
      try { await opts.notify(employee, enrollment); } catch (_) { /* best-effort */ }
    }
  }

  await writeAudit({
    businessId,
    actorId: opts.actorUserId || 'system',
    action: 'learning.assign',
    entityType: 'CourseAssignment',
    entityId: assignment.id,
    meta: {
      courseId: assignment.courseId, cycleKey,
      audienceScope: assignment.audienceScope, created, existing, total: employees.length,
    },
  });

  return { created, existing, total: employees.length, cycleKey };
}

module.exports = { fanOut, cycleKeyFor, resolveDueAt };
