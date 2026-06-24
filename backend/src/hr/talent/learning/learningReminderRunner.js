'use strict';

/**
 * learningReminderRunner.js — Feature 37 §6.4. The LMS training-calendar runtime: a
 * near-clone of payroll/compliance/calendarRunner.js + tax/investmentProof/
 * proofWindowRunner.js (tenant-safe, idempotent, version-guarded, --dry-run,
 * CLI-runnable), hosted by ONE scheduler.js cron block (daily 08:00, in-process guard).
 *
 *   runNewJoinerAutoAssign({ businessId?, asOf, dryRun })
 *     For each ACTIVE CourseAssignment with newJoinerRule, auto-enrol in-audience
 *     ACTIVE employees hired within newJoinerWithinDays who have no enrollment for the
 *     current cycle (POSH 30-day onboarding rule). Idempotent via the cycle unique.
 *
 *   runRecurrenceReassign({ businessId?, asOf, dryRun })
 *     For ANNUAL/HALF_YEARLY/QUARTERLY assignments, when the cycle boundary is crossed
 *     and an in-audience employee has no enrollment for the NEW cycle → fan out a fresh
 *     enrollment with the new cycleKey (the prior one stays COMPLETED for the audit trail).
 *
 *   runReminders({ businessId?, asOf, dryRun })
 *     For mandatory, not-yet-complete enrollments: learning.due-soon at T-7/T-1 and
 *     learning.overdue past dueAt. Deduped via the enrollment lastReminderStage cursor
 *     (mirrors the proof-window/compliance reminderStage dedup) — never a daily storm.
 *
 *   runSweep({ businessId?, asOf, dryRun })  — orchestrates all three; returns a summary.
 *
 * CLI: node src/hr/talent/learning/learningReminderRunner.js [--dry-run] [--business=<id>]
 */

const prisma = require('../../../core/lib/prisma');
const { fanOut, cycleKeyFor } = require('./assignmentService');
const learnNotify = require('./notify');

const SYSTEM_ACTOR = 'system';
const DAY_MS = 24 * 60 * 60 * 1000;

async function resolveBizName(businessId, cache) {
  if (cache && cache.has(businessId)) return cache.get(businessId);
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } });
  const name = (b && b.name) || 'HR';
  if (cache) cache.set(businessId, name);
  return name;
}

async function courseById(courseId, cache) {
  if (cache && cache.has(courseId)) return cache.get(courseId);
  const c = await prisma.course.findUnique({ where: { id: courseId } });
  if (cache) cache.set(courseId, c);
  return c;
}

// ── 1) New-joiner auto-assign (POSH 30-day) ───────────────────────────────────
async function runNewJoinerAutoAssign({ businessId = null, asOf = new Date(), dryRun = false } = {}) {
  const summary = { scanned: 0, created: 0, errors: 0 };
  const where = { newJoinerRule: true, active: true, deletedAt: null, ...(businessId ? { businessId } : {}) };
  const assignments = await prisma.courseAssignment.findMany({ where, take: 5000 });
  const bizCache = new Map();
  const courseCache = new Map();

  for (const a of assignments) {
    summary.scanned += 1;
    try {
      const windowDays = a.newJoinerWithinDays || 30;
      const cutoff = new Date(asOf.getTime() - windowDays * DAY_MS);
      // Recent ACTIVE hires in this tenant; fanOut intersects them with the audience.
      const recentHires = await prisma.employee.findMany({
        where: {
          businessId: a.businessId, deletedAt: null, isActive: true, status: 'ACTIVE',
          hireDate: { gte: cutoff, lte: asOf },
        },
        select: { id: true },
        take: 2000,
      });
      if (!recentHires.length) continue;
      if (dryRun) continue;
      const course = await courseById(a.courseId, courseCache);
      const bizName = await resolveBizName(a.businessId, bizCache);
      const res = await fanOut(a, {
        asOf,
        cycleKey: cycleKeyFor(a, asOf),
        onlyEmployeeIds: recentHires.map((e) => e.id),
        actorUserId: SYSTEM_ACTOR,
        notify: course
          ? (employee, enrollment) => learnNotify.assigned({ businessId: a.businessId, employee, course, enrollment, bizName })
          : undefined,
      });
      summary.created += res.created;
    } catch (e) {
      summary.errors += 1;
      // eslint-disable-next-line no-console
      console.error('[learning.newjoiner] assignment', a.id, e.message);
    }
  }
  return summary;
}

// ── 2) Recurrence re-assign (annual POSH etc.) ────────────────────────────────
async function runRecurrenceReassign({ businessId = null, asOf = new Date(), dryRun = false } = {}) {
  const summary = { scanned: 0, created: 0, errors: 0 };
  const where = {
    recurrence: { not: 'NONE' }, active: true, deletedAt: null, ...(businessId ? { businessId } : {}),
  };
  const assignments = await prisma.courseAssignment.findMany({ where, take: 5000 });
  const bizCache = new Map();
  const courseCache = new Map();

  for (const a of assignments) {
    summary.scanned += 1;
    try {
      if (dryRun) continue;
      // The fan-out with the CURRENT cycle key is idempotent: anyone already enrolled in
      // this cycle is skipped; anyone in-audience without a current-cycle enrollment gets
      // a fresh one. The prior cycle's COMPLETED enrollment is untouched (audit trail).
      const course = await courseById(a.courseId, courseCache);
      const bizName = await resolveBizName(a.businessId, bizCache);
      const res = await fanOut(a, {
        asOf,
        cycleKey: cycleKeyFor(a, asOf),
        actorUserId: SYSTEM_ACTOR,
        notify: course
          ? (employee, enrollment) => learnNotify.assigned({ businessId: a.businessId, employee, course, enrollment, bizName })
          : undefined,
      });
      summary.created += res.created;
    } catch (e) {
      summary.errors += 1;
      // eslint-disable-next-line no-console
      console.error('[learning.recurrence] assignment', a.id, e.message);
    }
  }
  return summary;
}

// ── 3) Due-soon / overdue reminders (deduped) ─────────────────────────────────
// Stage from dueAt vs asOf: OVERDUE (past due) > DUE_T1 (≤1d) > DUE_T7 (≤7d) > null.
function reminderStageFor(dueAt, asOf) {
  if (!dueAt) return null;
  const due = dueAt instanceof Date ? dueAt : new Date(dueAt);
  const diffDays = Math.floor((due.getTime() - asOf.getTime()) / DAY_MS);
  if (diffDays < 0) return 'OVERDUE';
  if (diffDays <= 1) return 'DUE_T1';
  if (diffDays <= 7) return 'DUE_T7';
  return null;
}

async function runReminders({ businessId = null, asOf = new Date(), dryRun = false } = {}) {
  const summary = { scanned: 0, sent: 0, errors: 0 };
  const where = {
    isMandatory: true,
    status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
    dueAt: { not: null },
    ...(businessId ? { businessId } : {}),
  };
  const enrollments = await prisma.enrollment.findMany({ where, take: 5000 });
  const bizCache = new Map();
  const courseCache = new Map();
  const empCache = new Map();

  for (const en of enrollments) {
    summary.scanned += 1;
    try {
      const stage = reminderStageFor(en.dueAt, asOf);
      if (!stage) continue;
      // Dedup: already sent this exact stage → skip (no spam). Stages only escalate, so a
      // T-7 already sent won't re-fire, but the later T-1 / OVERDUE stage still will.
      if (en.lastReminderStage === stage) continue;
      if (dryRun) { summary.sent += 1; continue; }

      let emp = empCache.get(en.employeeId);
      if (emp === undefined) {
        emp = await prisma.employee.findFirst({
          where: { id: en.employeeId, businessId: en.businessId, deletedAt: null, isActive: true, status: 'ACTIVE' },
          select: { id: true, firstName: true, lastName: true, code: true, workEmail: true, personalEmail: true, phone: true, countryCode: true },
        });
        empCache.set(en.employeeId, emp);
      }
      if (!emp) continue; // non-active employee — skip (terminated learners aren't nudged)
      const course = await courseById(en.courseId, courseCache);
      if (!course) continue;
      const bizName = await resolveBizName(en.businessId, bizCache);

      if (stage === 'OVERDUE') {
        await learnNotify.overdue({ businessId: en.businessId, employee: emp, course, enrollment: en, bizName });
      } else {
        await learnNotify.dueSoon({ businessId: en.businessId, employee: emp, course, enrollment: en, bizName });
      }
      // Version-guarded cursor advance (dedup).
      await prisma.enrollment.updateMany({
        where: { id: en.id, version: en.version },
        data: { lastReminderStage: stage, lastReminderAt: asOf, version: { increment: 1 } },
      });
      summary.sent += 1;
    } catch (e) {
      summary.errors += 1;
      // eslint-disable-next-line no-console
      console.error('[learning.reminder] enrollment', en.id, e.message);
    }
  }
  return summary;
}

// ── orchestrator ──────────────────────────────────────────────────────────────
async function runSweep({ businessId = null, asOf = new Date(), dryRun = false } = {}) {
  const nj = await runNewJoinerAutoAssign({ businessId, asOf, dryRun });
  const rc = await runRecurrenceReassign({ businessId, asOf, dryRun });
  const rm = await runReminders({ businessId, asOf, dryRun });
  return { newJoiner: nj, recurrence: rc, reminders: rm };
}

module.exports = {
  runSweep,
  runNewJoinerAutoAssign,
  runRecurrenceReassign,
  runReminders,
  _internals: { reminderStageFor },
};

// CLI entry — `node src/hr/talent/learning/learningReminderRunner.js [--dry-run] [--business=<id>]`
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const bizArg = args.find((a) => a.startsWith('--business='));
  const businessId = bizArg ? bizArg.split('=')[1] : null;
  runSweep({ businessId, asOf: new Date(), dryRun })
    .then((r) => { console.log('[learning.sweep]', JSON.stringify(r)); return prisma.$disconnect(); })
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
