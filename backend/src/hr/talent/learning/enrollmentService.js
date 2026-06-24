'use strict';

/**
 * enrollmentService.js — progress + completion detection for an Enrollment (Feature 37
 * §6.2). recomputeEnrollment() runs after every lesson-progress / quiz write:
 *
 *   - mark each REQUIRED lesson COMPLETED per its rule (VIDEO watchedPct ≥ minWatchPct;
 *     DOCUMENT/LINK/SCORM explicit acknowledge; QUIZ a passing attempt exists),
 *   - recompute progressPct = round(100 * completedRequired / totalRequired),
 *   - flip the enrollment COMPLETED when the course completionRule is satisfied
 *     (ALL_LESSONS | QUIZ_PASS | BOTH); on the COMPLETED transition (version-guarded,
 *     idempotent) set completedAt, then issue the F9 certificate + fan out
 *     learning.completed / learning.cert-ready.
 *
 * OVERDUE is NOT stored — it is derived (dueAt < now AND status != COMPLETED) so a clock
 * tick never needs a write (§9 edge case 6).
 */

const prisma = require('../../../core/lib/prisma');
const cert = require('./certificate');

/** A required-lesson completion test against its progress row + kind rule. */
function lessonIsComplete(lesson, progressByLesson, passedQuizLessonIds) {
  const p = progressByLesson.get(lesson.id);
  if (lesson.kind === 'QUIZ') return passedQuizLessonIds.has(lesson.id);
  if (!p) return false;
  if (p.status === 'COMPLETED') return true;
  if (lesson.kind === 'VIDEO') {
    const gate = lesson.minWatchPct == null ? 90 : lesson.minWatchPct;
    return (p.watchedPct || 0) >= gate;
  }
  // DOCUMENT / LINK / SCORM complete only on an explicit COMPLETED status (handled above).
  return false;
}

/**
 * Recompute an enrollment's progress + completion. Returns the (possibly updated)
 * enrollment plus a `justCompleted` flag and the certificate result (if minted).
 *
 * @param {string} enrollmentId
 * @param {Object} [opts]
 * @param {Function} [opts.onCompleted]  async (enrollment, { course, scorePct, certificate }) => void
 * @param {string}   [opts.actorUserId]
 * @returns {{ enrollment, justCompleted:boolean, certificate:Object|null, progressPct:number }}
 */
async function recomputeEnrollment(enrollmentId, opts = {}) {
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId } });
  if (!enrollment) return { enrollment: null, justCompleted: false, certificate: null, progressPct: 0 };

  const course = await prisma.course.findUnique({ where: { id: enrollment.courseId } });
  if (!course) return { enrollment, justCompleted: false, certificate: null, progressPct: enrollment.progressPct };

  // Load the live (non-deleted) lessons + this enrollment's progress + quiz attempts.
  const lessons = await prisma.lesson.findMany({
    where: { businessId: enrollment.businessId, courseId: enrollment.courseId, deletedAt: null },
    select: { id: true, kind: true, isRequired: true, minWatchPct: true },
  });
  const progressRows = await prisma.lessonProgress.findMany({
    where: { businessId: enrollment.businessId, enrollmentId },
  });
  const progressByLesson = new Map(progressRows.map((r) => [r.lessonId, r]));

  // Quiz lessons + the set of quiz lessons with a passing attempt.
  const quizzes = await prisma.quiz.findMany({
    where: { businessId: enrollment.businessId, lesson: { is: { courseId: enrollment.courseId } }, deletedAt: null },
    select: { id: true, lessonId: true },
  });
  const quizIdToLesson = new Map(quizzes.map((q) => [q.id, q.lessonId]));
  const attempts = await prisma.quizAttempt.findMany({
    where: { businessId: enrollment.businessId, enrollmentId },
    select: { quizId: true, passed: true, scorePct: true },
  });
  const passedQuizLessonIds = new Set();
  let bestScore = null;
  for (const a of attempts) {
    if (a.passed && quizIdToLesson.has(a.quizId)) passedQuizLessonIds.add(quizIdToLesson.get(a.quizId));
    if (a.scorePct != null) bestScore = bestScore == null ? a.scorePct : Math.max(bestScore, a.scorePct);
  }

  const requiredLessons = lessons.filter((l) => l.isRequired);
  const requiredQuizLessons = requiredLessons.filter((l) => l.kind === 'QUIZ');

  let completedRequired = 0;
  for (const l of requiredLessons) {
    if (lessonIsComplete(l, progressByLesson, passedQuizLessonIds)) completedRequired += 1;
  }
  const totalRequired = requiredLessons.length;
  const progressPct = totalRequired > 0 ? Math.round((100 * completedRequired) / totalRequired) : 0;

  // Completion rule.
  const allLessonsDone = totalRequired > 0 && completedRequired === totalRequired;
  const allQuizzesPassed = requiredQuizLessons.length > 0
    && requiredQuizLessons.every((l) => passedQuizLessonIds.has(l.id));
  let satisfied;
  if (course.completionRule === 'QUIZ_PASS') satisfied = allQuizzesPassed;
  else if (course.completionRule === 'BOTH') satisfied = allLessonsDone && allQuizzesPassed;
  else satisfied = allLessonsDone; // ALL_LESSONS (default)

  const wasCompleted = enrollment.status === 'COMPLETED';
  const nowComplete = satisfied && !wasCompleted;

  // Derive the next status (never downgrade a WAIVED/EXPIRED record here).
  let nextStatus = enrollment.status;
  if (enrollment.status === 'ASSIGNED' && (progressPct > 0 || attempts.length > 0)) nextStatus = 'IN_PROGRESS';
  if (satisfied && enrollment.status !== 'WAIVED' && enrollment.status !== 'EXPIRED') nextStatus = 'COMPLETED';

  // Version-guarded update so a concurrent recompute can't double-issue the cert.
  const data = {
    progressPct,
    status: nextStatus,
    version: { increment: 1 },
  };
  if (nextStatus === 'IN_PROGRESS' && !enrollment.startedAt) data.startedAt = new Date();
  if (nowComplete) data.completedAt = new Date();

  const upd = await prisma.enrollment.updateMany({
    where: { id: enrollmentId, version: enrollment.version },
    data,
  });
  if (upd.count === 0) {
    // Lost the race — re-read and return without re-issuing (the winner handled it).
    const fresh = await prisma.enrollment.findUnique({ where: { id: enrollmentId } });
    return { enrollment: fresh, justCompleted: false, certificate: null, progressPct: fresh ? fresh.progressPct : progressPct };
  }

  const updated = await prisma.enrollment.findUnique({ where: { id: enrollmentId } });

  let certificate = null;
  if (nowComplete && course.certificateEnabled) {
    try {
      certificate = await cert.issueForEnrollment({
        businessId: enrollment.businessId,
        enrollment: updated,
        course,
        scorePct: bestScore,
        actorUserId: opts.actorUserId || 'system',
      });
    } catch (e) {
      // Cert failure must not roll back the COMPLETED state — log + continue (the
      // course IS complete; HR can reissue). Mirrors the "course still COMPLETED" rule.
      // eslint-disable-next-line no-console
      console.error('[learning.cert] enrollment', enrollmentId, e.message);
    }
  }

  if (nowComplete && typeof opts.onCompleted === 'function') {
    try { await opts.onCompleted(updated, { course, scorePct: bestScore, certificate }); } catch (_) { /* best-effort */ }
  }

  return { enrollment: updated, justCompleted: nowComplete, certificate, progressPct };
}

module.exports = { recomputeEnrollment, _internals: { lessonIsComplete } };
