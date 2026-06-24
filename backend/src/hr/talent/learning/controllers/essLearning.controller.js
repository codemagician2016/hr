'use strict';

/**
 * essLearning.controller.js — Feature 37 EMPLOYEE self-service learning, mounted at
 * /api/hr/ess/learning. SELF-ONLY by construction (mirror of essPerformance): NO
 * `:employeeId` in any path — the subject is resolved entirely from the CUSTOMER session
 * (workEmail/personalEmail/linked User). Every enrollment in the path is re-asserted to
 * belong to the session employee (404 otherwise → IDOR-safe, §9 edge case 2). The quiz
 * answer key (correctOptionIds) NEVER leaves the server (serializers strip it; scoring is
 * server-only on submit, §9 edge case 1). Terminated employees are read-only (writeGuard).
 */

const prisma = require('../../../../core/lib/prisma');
const { publicLesson, publicQuiz } = require('../serializers');
const quizScoring = require('../quizScoring');
const { recomputeEnrollment } = require('../enrollmentService');
const { resolveEmployeeSegment, audienceMatchesEmployee } = require('../../../engagement/audience');
const learnNotify = require('../notify');

const SEPARATED = new Set(['TERMINATED', 'RETIRED']);
function isSeparated(emp) {
  if (!emp) return false;
  if (emp.isActive === false) return true;
  return SEPARATED.has(emp.status);
}

async function resolveSelf(businessId, customer) {
  if (!customer || !customer.email) return null;
  const select = { id: true, code: true, firstName: true, lastName: true, status: true, isActive: true, userId: true, workEmail: true, personalEmail: true, phone: true, countryCode: true };
  const byEmail = await prisma.employee.findFirst({ where: { businessId, deletedAt: null, OR: [{ workEmail: customer.email }, { personalEmail: customer.email }] }, select });
  if (byEmail) return byEmail;
  return prisma.employee.findFirst({ where: { businessId, deletedAt: null, user: { is: { email: customer.email } } }, select });
}

async function withSelf(req, res, { writeGuard = false } = {}) {
  const { businessId } = req.customer;
  const employee = await resolveSelf(businessId, req.customer);
  if (!employee) { res.status(404).json({ message: 'No employee record is linked to your account' }); return null; }
  if (writeGuard && isSeparated(employee)) { res.status(403).json({ message: 'Your account is no longer active; this action is unavailable', reason: 'separated' }); return null; }
  return { businessId, employee };
}

// Re-assert an enrollment belongs to the session employee (IDOR guard → 404).
async function loadOwnEnrollment(businessId, employeeId, enrollmentId, extraInclude) {
  return prisma.enrollment.findFirst({
    where: { id: enrollmentId, businessId, employeeId },
    ...(extraInclude ? { include: extraInclude } : {}),
  });
}

// GET /overview — My Learning home (required-due, in-progress, completed + cert links).
async function overview(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const now = new Date();
    const enrollments = await prisma.enrollment.findMany({
      where: { businessId, employeeId: employee.id, status: { not: 'EXPIRED' } },
      include: { course: { select: { id: true, code: true, title: true, category: true, estMinutes: true } }, certificate: { select: { referenceNo: true, employeeDocumentId: true } } },
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
    });
    const required = []; const inProgress = []; const completed = [];
    for (const en of enrollments) {
      const view = {
        enrollmentId: en.id, course: en.course, status: en.status,
        dueAt: en.dueAt, progressPct: en.progressPct, isMandatory: en.isMandatory,
        overdue: !!(en.dueAt && new Date(en.dueAt) < now && en.status !== 'COMPLETED'),
        certificate: en.certificate ? { referenceNo: en.certificate.referenceNo, documentId: en.certificate.employeeDocumentId } : null,
      };
      if (en.status === 'COMPLETED') completed.push(view);
      else if (en.status === 'IN_PROGRESS') inProgress.push(view);
      else if (en.isMandatory) required.push(view);
      else inProgress.push(view); // optional, not yet started
    }
    return res.json({ required, inProgress, completed });
  } catch (e) { return next(e); }
}

// GET /catalog — optional/self-enrollable published courses in the employee's audience,
// not already mandatorily assigned (§9 edge case 15).
async function catalog(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const segment = await resolveEmployeeSegment(businessId, employee.id);

    const published = await prisma.course.findMany({
      where: { businessId, deletedAt: null, status: 'PUBLISHED' },
      select: { id: true, code: true, title: true, category: true, description: true, estMinutes: true },
    });
    // Courses the employee already has an enrollment in (any cycle) — exclude from catalog.
    const mine = await prisma.enrollment.findMany({ where: { businessId, employeeId: employee.id }, select: { courseId: true } });
    const mineSet = new Set(mine.map((m) => m.courseId));

    // Courses with an OPTIONAL (non-mandatory) active assignment matching this employee.
    const assignments = await prisma.courseAssignment.findMany({
      where: { businessId, active: true, deletedAt: null, isMandatory: false },
    });
    const optionalCourseIds = new Set();
    for (const a of assignments) {
      // The course-assignment audience mirrors the announcement audience for ALL/ENTITY/
      // DEPARTMENT/SPECIFIC; ROLE is opt-in (we keep catalog conservative — only the four
      // segment-derivable scopes self-enrol, ROLE/SPECIFIC are HR-driven pushes).
      if (audienceMatchesEmployee(a, segment, employee.id)) optionalCourseIds.add(a.courseId);
    }
    const items = published.filter((c) => !mineSet.has(c.id) && optionalCourseIds.has(c.id));
    return res.json({ items });
  } catch (e) { return next(e); }
}

// POST /catalog/:courseId/enroll — self-enroll in an optional course (cycleKey='once').
async function enroll(req, res, next) {
  try {
    const ctx = await withSelf(req, res, { writeGuard: true }); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const segment = await resolveEmployeeSegment(businessId, employee.id);
    const course = await prisma.course.findFirst({ where: { id: req.params.courseId, businessId, deletedAt: null, status: 'PUBLISHED' }, select: { id: true } });
    if (!course) return res.status(404).json({ message: 'Course not found' });
    // Must be in the audience of an OPTIONAL active assignment.
    const assignments = await prisma.courseAssignment.findMany({ where: { businessId, courseId: course.id, active: true, deletedAt: null, isMandatory: false } });
    const eligible = assignments.some((a) => audienceMatchesEmployee(a, segment, employee.id));
    if (!eligible) return res.status(403).json({ message: 'This course is not available for self-enrolment' });
    const enrollment = await prisma.enrollment.upsert({
      where: { businessId_employeeId_courseId_cycleKey: { businessId, employeeId: employee.id, courseId: course.id, cycleKey: 'once' } },
      create: { businessId, courseId: course.id, employeeId: employee.id, isMandatory: false, status: 'ASSIGNED', cycleKey: 'once' },
      update: {},
    });
    return res.status(201).json({ enrollmentId: enrollment.id });
  } catch (e) { return next(e); }
}

// GET /enrollments/:id — course player payload (answer keys stripped + my progress).
async function getPlayer(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const en = await loadOwnEnrollment(businessId, employee.id, req.params.id);
    if (!en) return res.status(404).json({ message: 'Not found' });
    const course = await prisma.course.findFirst({
      where: { id: en.courseId, businessId, deletedAt: null },
      include: {
        modules: {
          where: { deletedAt: null }, orderBy: { orderIndex: 'asc' },
          include: { lessons: { where: { deletedAt: null }, orderBy: { orderIndex: 'asc' }, include: { quiz: { include: { questions: { where: { deletedAt: null }, orderBy: { orderIndex: 'asc' } } } } } } },
        },
      },
    });
    if (!course) return res.status(404).json({ message: 'Not found' });
    const progressRows = await prisma.lessonProgress.findMany({ where: { businessId, enrollmentId: en.id } });
    const progressByLesson = {};
    for (const p of progressRows) progressByLesson[p.lessonId] = { status: p.status, lastPositionSec: p.lastPositionSec, watchedPct: p.watchedPct, completedAt: p.completedAt };
    const attempts = await prisma.quizAttempt.findMany({ where: { businessId, enrollmentId: en.id }, select: { quizId: true, attemptNo: true, scorePct: true, passed: true } });

    const modules = course.modules.map((m) => ({
      id: m.id, title: m.title, orderIndex: m.orderIndex,
      lessons: m.lessons.map((l) => publicLesson(l)), // answer keys stripped here
    }));
    return res.json({
      enrollment: { id: en.id, status: en.status, dueAt: en.dueAt, progressPct: en.progressPct, completedAt: en.completedAt },
      course: { id: course.id, code: course.code, title: course.title, completionRule: course.completionRule, certificateEnabled: course.certificateEnabled },
      modules, progressByLesson, attempts,
    });
  } catch (e) { return next(e); }
}

// POST /enrollments/:id/lessons/:lessonId/progress — update lesson progress (may flip COMPLETED).
async function updateProgress(req, res, next) {
  try {
    const ctx = await withSelf(req, res, { writeGuard: true }); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const en = await loadOwnEnrollment(businessId, employee.id, req.params.id);
    if (!en) return res.status(404).json({ message: 'Not found' });
    if (en.status === 'WAIVED' || en.status === 'EXPIRED') return res.status(409).json({ message: 'This enrollment is closed' });
    const lesson = await prisma.lesson.findFirst({ where: { id: req.params.lessonId, businessId, courseId: en.courseId, deletedAt: null } });
    if (!lesson) return res.status(404).json({ message: 'Lesson not found' });

    const body = req.body || {};
    // Derive the lesson status from the kind + payload.
    const watchedPct = body.watchedPct != null ? Math.max(0, Math.min(100, Number(body.watchedPct))) : null;
    const lastPositionSec = body.lastPositionSec != null ? Math.max(0, Number(body.lastPositionSec)) : null;
    const explicitDone = body.markComplete === true || body.acknowledge === true || body.markRead === true;

    let status = 'IN_PROGRESS';
    if (lesson.kind === 'VIDEO') {
      const gate = lesson.minWatchPct == null ? 90 : lesson.minWatchPct;
      if ((watchedPct || 0) >= gate || explicitDone) status = 'COMPLETED';
    } else if (explicitDone) {
      status = 'COMPLETED'; // DOCUMENT mark-read / LINK + SCORM acknowledge
    }

    const existing = await prisma.lessonProgress.findUnique({ where: { businessId_enrollmentId_lessonId: { businessId, enrollmentId: en.id, lessonId: lesson.id } } });
    const data = {
      status: existing && existing.status === 'COMPLETED' ? 'COMPLETED' : status, // never downgrade a completed lesson
      ...(watchedPct != null ? { watchedPct } : {}),
      ...(lastPositionSec != null ? { lastPositionSec } : {}),
    };
    if (data.status === 'COMPLETED' && !(existing && existing.completedAt)) data.completedAt = new Date();
    await prisma.lessonProgress.upsert({
      where: { businessId_enrollmentId_lessonId: { businessId, enrollmentId: en.id, lessonId: lesson.id } },
      create: { businessId, enrollmentId: en.id, lessonId: lesson.id, status: data.status, watchedPct: watchedPct || 0, lastPositionSec: lastPositionSec || 0, completedAt: data.completedAt || null },
      update: { ...data, version: { increment: 1 } },
    });

    const result = await recomputeEnrollment(en.id, {
      onCompleted: completionNotifier(businessId, employee),
    });
    return res.json({
      ok: true,
      progressPct: result.progressPct,
      enrollmentStatus: result.enrollment ? result.enrollment.status : en.status,
      justCompleted: result.justCompleted,
      certificate: result.certificate || null,
    });
  } catch (e) { return next(e); }
}

// GET /enrollments/:id/quiz/:quizId — quiz questions WITHOUT correctOptionIds.
async function getQuiz(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const en = await loadOwnEnrollment(businessId, employee.id, req.params.id);
    if (!en) return res.status(404).json({ message: 'Not found' });
    const quiz = await prisma.quiz.findFirst({
      where: { id: req.params.quizId, businessId, deletedAt: null, lesson: { is: { courseId: en.courseId } } },
      include: { questions: { where: { deletedAt: null }, orderBy: { orderIndex: 'asc' } } },
    });
    if (!quiz) return res.status(404).json({ message: 'Quiz not found' });
    const attempts = await prisma.quizAttempt.count({ where: { businessId, enrollmentId: en.id, quizId: quiz.id } });
    const passed = await prisma.quizAttempt.findFirst({ where: { businessId, enrollmentId: en.id, quizId: quiz.id, passed: true }, select: { id: true } });
    return res.json({ quiz: publicQuiz(quiz), attemptsUsed: attempts, maxAttempts: quiz.maxAttempts, alreadyPassed: !!passed });
  } catch (e) { return next(e); }
}

// POST /enrollments/:id/quiz/:quizId/attempt — submit answers → server scores → pass/fail.
async function submitQuiz(req, res, next) {
  try {
    const ctx = await withSelf(req, res, { writeGuard: true }); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const en = await loadOwnEnrollment(businessId, employee.id, req.params.id);
    if (!en) return res.status(404).json({ message: 'Not found' });
    if (en.status === 'WAIVED' || en.status === 'EXPIRED') return res.status(409).json({ message: 'This enrollment is closed' });
    const quiz = await prisma.quiz.findFirst({
      where: { id: req.params.quizId, businessId, deletedAt: null, lesson: { is: { courseId: en.courseId } } },
      include: { questions: { where: { deletedAt: null } }, lesson: { select: { id: true } } },
    });
    if (!quiz) return res.status(404).json({ message: 'Quiz not found' });

    // Attempt-cap: count prior attempts; if a passing attempt exists, short-circuit.
    const prior = await prisma.quizAttempt.findMany({ where: { businessId, enrollmentId: en.id, quizId: quiz.id }, select: { attemptNo: true, passed: true } });
    if (prior.some((a) => a.passed)) return res.status(409).json({ message: 'You have already passed this quiz' });
    if (quiz.maxAttempts != null && prior.length >= quiz.maxAttempts) {
      return res.status(409).json({ message: 'You have used all attempts for this quiz — contact HR', attemptsExhausted: true });
    }
    const attemptNo = (prior.reduce((m, a) => Math.max(m, a.attemptNo), 0)) + 1;

    const answers = (req.body && req.body.answers) || {};
    const scored = quizScoring.score({ questions: quiz.questions, answers, passThreshold: quiz.passThreshold });

    let attempt;
    try {
      attempt = await prisma.quizAttempt.create({
        data: { businessId, enrollmentId: en.id, quizId: quiz.id, attemptNo, answersJson: answers, scorePct: scored.scorePct, passed: scored.passed },
      });
    } catch (e) {
      // Race on the (enrollmentId, quizId, attemptNo) unique → another submit won; reject.
      if (e && e.code === 'P2002') return res.status(409).json({ message: 'Concurrent submission — please retry' });
      throw e;
    }

    let completion = null;
    if (scored.passed) {
      const result = await recomputeEnrollment(en.id, { onCompleted: completionNotifier(businessId, employee) });
      completion = { enrollmentStatus: result.enrollment ? result.enrollment.status : en.status, justCompleted: result.justCompleted, certificate: result.certificate || null };
    }
    // Note: per-question correctness is returned (so the learner sees what they missed)
    // but the answer KEY (which option was correct) is never returned.
    return res.json({
      attemptNo: attempt.attemptNo,
      scorePct: scored.scorePct,
      passed: scored.passed,
      perQuestion: scored.perQuestion.map((p) => ({ questionId: p.questionId, correct: p.correct })),
      attemptsUsed: attemptNo,
      maxAttempts: quiz.maxAttempts,
      completion,
    });
  } catch (e) { return next(e); }
}

// GET /enrollments/:id/certificate — return the vault document reference (the PDF already
// lives in the ESS document vault EMPLOYEE_VISIBLE; ESS ▸ Documents serves the bytes).
async function getCertificate(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const en = await loadOwnEnrollment(businessId, employee.id, req.params.id);
    if (!en) return res.status(404).json({ message: 'Not found' });
    const cert = await prisma.learningCertificate.findUnique({ where: { enrollmentId: en.id } });
    if (!cert) return res.status(404).json({ message: 'No certificate available yet' });
    return res.json({ referenceNo: cert.referenceNo, documentId: cert.employeeDocumentId, issuedLetterId: cert.issuedLetterId, issuedAt: cert.issuedAt });
  } catch (e) { return next(e); }
}

// On COMPLETED: fan out learning.completed + (if a cert minted) learning.cert-ready.
function completionNotifier(businessId, employee) {
  return async (enrollment, { course, certificate }) => {
    const b = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } });
    const bizName = (b && b.name) || 'HR';
    await learnNotify.completed({ businessId, employee, course, bizName });
    if (certificate && certificate.referenceNo) {
      await learnNotify.certReady({ businessId, employee, course, referenceNo: certificate.referenceNo, bizName });
    }
  };
}

module.exports = { overview, catalog, enroll, getPlayer, updateProgress, getQuiz, submitQuiz, getCertificate };
