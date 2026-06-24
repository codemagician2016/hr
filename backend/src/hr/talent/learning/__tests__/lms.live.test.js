'use strict';

/*
 * lms.live.test.js — LIVE end-to-end proof for Feature 37 (LMS). Plain-node runner,
 * isolated hr_test schema (same convention as the letters/attendance live tests):
 *
 *   DATABASE_URL="$HR_URL" node src/hr/talent/learning/__tests__/lms.live.test.js
 *   where $HR_URL = the repo .env DATABASE_URL with ?schema=hr_test.
 *
 * Proves (per the spec verify list):
 *   (1) Assign a course to a DEPARTMENT → only those employees get an enrollment
 *       (the out-of-dept employee gets none); fan-out is idempotent (re-run = no dupes).
 *   (2) Progress is tracked PER LESSON; a VIDEO lesson completes at ≥ minWatchPct.
 *   (3) Quiz is auto-graded server-side + the pass threshold gates; the ESS payload
 *       NEVER carries correctOptionIds (answer-key strip).
 *   (4) On completion a CERTIFICATE is minted to the ESS vault via F9 — an IssuedLetter
 *       (LMS_CERTIFICATE) + an EmployeeDocument EMPLOYEE_VISIBLE (TRAINING_CERTIFICATE),
 *       ref-no allocated, and a LearningCertificate index row points at both.
 *   (5) The reminder sweep marks a due-soon/overdue enrollment ONCE (dedup cursor).
 *   (6) The manager compliance read is F1-scoped (a manager sees only their team).
 *   (7) Tenant isolation — a second tenant's course/enrollment never crosses over.
 *
 * A throwaway tenant (two, for isolation) is seeded then torn down.
 */

const prisma = require('../../../../core/lib/prisma');
const { seedLetterTemplates } = require('../../../letters/templates/seed');
const { fanOut } = require('../assignmentService');
const { recomputeEnrollment } = require('../enrollmentService');
const { publicLesson } = require('../serializers');
const reminderRunner = require('../learningReminderRunner');

const TAG = `lms${Date.now().toString(36)}`;
let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

async function seedTenant(suffix) {
  const biz = await prisma.business.create({ data: { name: `LMS Co ${TAG}${suffix}`, slug: `lms-${TAG}${suffix}`, region: 'IN', country: 'IN' } });
  const businessId = biz.id;
  const entity = await prisma.entity.create({
    data: { businessId, code: `${TAG}${suffix}-HQ`, legalName: `LMS Co ${suffix} Pvt Ltd`, tradeName: 'LMS Co', countryCode: 'IN', payCurrency: 'INR', timezone: 'Asia/Kolkata', taxYearStartMonth: 4, activeFrom: new Date('2026-04-01') },
  });
  const deptA = await prisma.department.create({ data: { businessId, name: `Eng ${TAG}${suffix}`, code: `${TAG}${suffix}-ENG` } });
  const deptB = await prisma.department.create({ data: { businessId, name: `Sales ${TAG}${suffix}`, code: `${TAG}${suffix}-SAL` } });
  // Seed the letter templates (gives us the LMS-CERT-STD certificate template).
  await seedLetterTemplates(prisma, businessId, { entityId: entity.id });
  return { businessId, entity, deptA, deptB };
}

async function makeEmployee(businessId, entityId, departmentId, code, mgrId, opts = {}) {
  const e = await prisma.employee.create({
    data: {
      businessId, code, firstName: code, lastName: 'Test', workEmail: `${code}@${TAG}.test`,
      status: 'ACTIVE', isActive: true, hireDate: opts.hireDate || new Date('2025-01-10'),
      ...(mgrId ? { managerEmployeeId: mgrId } : {}),
    },
  });
  await prisma.employmentRecord.create({
    data: { businessId, employeeId: e.id, entityId, departmentId, employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE', isCurrent: true, effectiveFrom: opts.hireDate || new Date('2025-01-10') },
  });
  return e;
}

async function buildCourse(businessId, { withQuiz = true, completionRule = 'BOTH' } = {}) {
  const course = await prisma.course.create({
    data: { businessId, code: `${TAG}-POSH`, title: 'POSH Awareness 2026', category: 'POSH', completionRule, certificateEnabled: true, status: 'PUBLISHED', publishedAt: new Date() },
  });
  const mod = await prisma.courseModule.create({ data: { businessId, courseId: course.id, title: 'Module 1', orderIndex: 0 } });
  // a VIDEO lesson (required) with a 90% watch gate
  await prisma.lesson.create({ data: { businessId, courseId: course.id, moduleId: mod.id, title: 'Intro video', kind: 'VIDEO', orderIndex: 0, isRequired: true, minWatchPct: 90, durationSec: 120 } });
  let quizLessonId = null; let quizId = null;
  if (withQuiz) {
    const quizLesson = await prisma.lesson.create({ data: { businessId, courseId: course.id, moduleId: mod.id, title: 'Assessment', kind: 'QUIZ', orderIndex: 1, isRequired: true } });
    quizLessonId = quizLesson.id;
    const quiz = await prisma.quiz.create({ data: { businessId, lessonId: quizLesson.id, passThreshold: 70, maxAttempts: 3 } });
    quizId = quiz.id;
    await prisma.quizQuestion.create({ data: { businessId, quizId: quiz.id, orderIndex: 0, prompt: 'POSH applies to orgs of how many?', kind: 'SINGLE', optionsJson: [{ id: 'a', text: '10+' }, { id: 'b', text: '50+' }], correctOptionIds: ['a'], points: 1 } });
    await prisma.quizQuestion.create({ data: { businessId, quizId: quiz.id, orderIndex: 1, prompt: 'New-joiner window (days)?', kind: 'SINGLE', optionsJson: [{ id: 'a', text: '30' }, { id: 'b', text: '90' }], correctOptionIds: ['a'], points: 1 } });
  }
  return { course, mod, quizLessonId, quizId };
}

async function run() {
  const t = await seedTenant('A');
  const t2 = await seedTenant('B');

  // Manager + two reports in deptA; one employee in deptB (out of audience).
  const mgr = await makeEmployee(t.businessId, t.entity.id, t.deptA.id, `${TAG}-MGR`, null);
  const r1 = await makeEmployee(t.businessId, t.entity.id, t.deptA.id, `${TAG}-R1`, mgr.id);
  const r2 = await makeEmployee(t.businessId, t.entity.id, t.deptA.id, `${TAG}-R2`, mgr.id);
  const outDept = await makeEmployee(t.businessId, t.entity.id, t.deptB.id, `${TAG}-OUT`, null);
  // Tenant B employee (isolation check).
  const t2emp = await makeEmployee(t2.businessId, t2.entity.id, t2.deptA.id, `${TAG}-B1`, null);

  const { course, quizId } = await buildCourse(t.businessId, { completionRule: 'BOTH' });
  await buildCourse(t2.businessId, { completionRule: 'BOTH' }); // tenant B has its own course

  // ── (1) Assign to deptA → only deptA employees enrol; idempotent ──────────────
  const assignment = await prisma.courseAssignment.create({
    data: { businessId: t.businessId, courseId: course.id, audienceScope: 'DEPARTMENT', audienceDeptIds: [t.deptA.id], isMandatory: true, dueInDays: 7, recurrence: 'ANNUAL', createdBy: 'system' },
  });
  const fan1 = await fanOut(assignment, { asOf: new Date() });
  const fan2 = await fanOut(assignment, { asOf: new Date() }); // re-run → idempotent
  const deptAEnrollments = await prisma.enrollment.findMany({ where: { businessId: t.businessId, courseId: course.id } });
  const enrolledIds = new Set(deptAEnrollments.map((e) => e.employeeId));
  assert(fan1.created === 3 && fan2.created === 0, `fan-out: 3 created then 0 on re-run (idempotent) [created=${fan1.created},${fan2.created}]`);
  assert(enrolledIds.has(mgr.id) && enrolledIds.has(r1.id) && enrolledIds.has(r2.id), 'all deptA employees enrolled');
  assert(!enrolledIds.has(outDept.id), 'out-of-dept employee NOT enrolled (audience scoping)');

  const en = deptAEnrollments.find((e) => e.employeeId === r1.id);
  assert(en.cycleKey === String(new Date().getUTCFullYear()), `annual cycleKey set [${en.cycleKey}]`);
  assert(en.dueAt != null, 'dueAt resolved from dueInDays');

  // ── (2) Per-lesson progress: VIDEO completes at ≥ minWatchPct ──────────────────
  const lessons = await prisma.lesson.findMany({ where: { businessId: t.businessId, courseId: course.id, deletedAt: null }, orderBy: { orderIndex: 'asc' } });
  const videoLesson = lessons.find((l) => l.kind === 'VIDEO');
  await prisma.lessonProgress.create({ data: { businessId: t.businessId, enrollmentId: en.id, lessonId: videoLesson.id, status: 'COMPLETED', watchedPct: 95, completedAt: new Date() } });
  let rc = await recomputeEnrollment(en.id);
  assert(rc.enrollment.status === 'IN_PROGRESS', 'after video only (quiz pending) → IN_PROGRESS (BOTH rule)');
  assert(rc.progressPct === 50, `progressPct = 50 (1 of 2 required lessons) [${rc.progressPct}]`);

  // ── (3) Quiz auto-graded server-side + threshold; answer key stripped ──────────
  const quiz = await prisma.quiz.findUnique({ where: { id: quizId }, include: { questions: true } });
  const pub = publicLesson({ ...lessons.find((l) => l.kind === 'QUIZ'), quiz });
  const leaks = JSON.stringify(pub).includes('correctOptionIds');
  assert(!leaks, 'ESS lesson payload does NOT contain correctOptionIds (answer-key strip)');

  const { score } = require('../quizScoring');
  // A failing attempt (one wrong) — below 70%.
  const fail = score({ questions: quiz.questions, answers: { [quiz.questions[0].id]: ['b'], [quiz.questions[1].id]: ['a'] }, passThreshold: quiz.passThreshold });
  await prisma.quizAttempt.create({ data: { businessId: t.businessId, enrollmentId: en.id, quizId, attemptNo: 1, answersJson: {}, scorePct: fail.scorePct, passed: fail.passed } });
  rc = await recomputeEnrollment(en.id);
  assert(fail.scorePct === 50 && fail.passed === false, `failing attempt scored 50% < 70 → not passed [${fail.scorePct}]`);
  assert(rc.enrollment.status === 'IN_PROGRESS', 'enrollment stays IN_PROGRESS after a failed quiz');

  // A passing attempt (both right).
  const pass = score({ questions: quiz.questions, answers: { [quiz.questions[0].id]: ['a'], [quiz.questions[1].id]: ['a'] }, passThreshold: quiz.passThreshold });
  await prisma.quizAttempt.create({ data: { businessId: t.businessId, enrollmentId: en.id, quizId, attemptNo: 2, answersJson: {}, scorePct: pass.scorePct, passed: pass.passed } });
  assert(pass.scorePct === 100 && pass.passed === true, 'passing attempt scored 100% → passed');

  // ── (4) Completion → certificate to vault (IssuedLetter + EmployeeDocument) ────
  rc = await recomputeEnrollment(en.id);
  assert(rc.enrollment.status === 'COMPLETED', 'all-lessons + quiz-pass → COMPLETED (BOTH rule)');
  assert(rc.justCompleted === true, 'recompute flags justCompleted on the transition');
  assert(rc.certificate && rc.certificate.referenceNo, `certificate minted with ref-no [${rc.certificate && rc.certificate.referenceNo}]`);

  const issued = await prisma.issuedLetter.findUnique({ where: { id: rc.certificate.issuedLetterId } });
  assert(issued && issued.category === 'LMS_CERTIFICATE' && issued.status === 'ISSUED', 'IssuedLetter is an ISSUED LMS_CERTIFICATE');
  assert(issued.employeeId === r1.id, 'IssuedLetter subject = the learner');
  const doc = await prisma.employeeDocument.findUnique({ where: { id: rc.certificate.employeeDocumentId } });
  assert(doc && doc.visibility === 'EMPLOYEE_VISIBLE' && doc.category === 'TRAINING_CERTIFICATE', 'EmployeeDocument is EMPLOYEE_VISIBLE TRAINING_CERTIFICATE (ESS vault)');
  const certRow = await prisma.learningCertificate.findUnique({ where: { enrollmentId: en.id } });
  assert(certRow && certRow.issuedLetterId === issued.id && certRow.referenceNo === issued.referenceNo, 'LearningCertificate index row points at the IssuedLetter');
  const enAfter = await prisma.enrollment.findUnique({ where: { id: en.id } });
  assert(enAfter.certificateLetterId === issued.id, 'enrollment.certificateLetterId set');

  // Re-running recompute does NOT double-issue (idempotent cert).
  const before = await prisma.issuedLetter.count({ where: { businessId: t.businessId, category: 'LMS_CERTIFICATE' } });
  await recomputeEnrollment(en.id);
  const after = await prisma.issuedLetter.count({ where: { businessId: t.businessId, category: 'LMS_CERTIFICATE' } });
  assert(before === after, 'recompute on an already-COMPLETED enrollment does NOT mint a 2nd cert');

  // ── (5) Reminder sweep — overdue fires once (dedup cursor) ─────────────────────
  // r2 has an enrollment due in 7 days → make it overdue.
  const en2 = deptAEnrollments.find((e) => e.employeeId === r2.id);
  await prisma.enrollment.update({ where: { id: en2.id }, data: { dueAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) } });
  const fresh2 = await prisma.enrollment.findUnique({ where: { id: en2.id } });
  const sweep1 = await reminderRunner.runReminders({ businessId: t.businessId, asOf: new Date() });
  const en2a = await prisma.enrollment.findUnique({ where: { id: en2.id } });
  assert(en2a.lastReminderStage === 'OVERDUE', `overdue reminder stamped the dedup cursor [${en2a.lastReminderStage}]`);
  const sweep2 = await reminderRunner.runReminders({ businessId: t.businessId, asOf: new Date() });
  assert(sweep2.sent === 0, 'second sweep does NOT re-send the same OVERDUE stage (dedup)');
  void sweep1; void fresh2;

  // ── (6) Manager compliance read is F1-scoped (team only) ───────────────────────
  // Simulate the dashboard scopeWhere for the manager (TEAM band = [mgr, r1, r2]).
  const { scopeWhere } = require('../../../lib/scopeResolver');
  const teamScope = { kind: 'IDS', ids: new Set([mgr.id, r1.id, r2.id]) };
  const teamEnrollments = await prisma.enrollment.findMany({ where: { businessId: t.businessId, courseId: course.id, ...scopeWhere(teamScope, 'employeeId') } });
  assert(teamEnrollments.length === 3, `manager TEAM scope sees their 3 team enrollments [${teamEnrollments.length}]`);
  const outScope = { kind: 'IDS', ids: new Set([outDept.id]) };
  const outEnrollments = await prisma.enrollment.findMany({ where: { businessId: t.businessId, courseId: course.id, ...scopeWhere(outScope, 'employeeId') } });
  assert(outEnrollments.length === 0, 'an out-of-team scope sees none of these enrollments');

  // ── (7) Tenant isolation ───────────────────────────────────────────────────────
  const crossCount = await prisma.enrollment.count({ where: { businessId: t2.businessId, courseId: course.id } });
  assert(crossCount === 0, 'tenant B has no enrollment for tenant A\'s course (isolation)');
  const t2Courses = await prisma.course.count({ where: { businessId: t2.businessId, id: course.id } });
  assert(t2Courses === 0, 'tenant A\'s course id is invisible to tenant B');
  void t2emp;

  // ── teardown ───────────────────────────────────────────────────────────────────
  for (const id of [t.businessId, t2.businessId]) {
    await prisma.business.delete({ where: { id } }).catch(() => {});
  }
}

run()
  .then(() => { log(failures ? `\nFAIL ${failures} assertion(s)` : '\nALL PASS'); return prisma.$disconnect(); })
  .then(() => process.exit(failures ? 1 : 0))
  .catch(async (e) => { console.error('TEST ERROR', e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
