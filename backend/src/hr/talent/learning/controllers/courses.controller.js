'use strict';

/**
 * courses.controller.js — Feature 37 operator course-builder surface, mounted at
 * /api/hr/learning. Author courses → modules → lessons → quizzes → questions; publish
 * gate; archive; media upload (reuses s3.uploadDataUrl). All routes are tenant-scoped
 * (businessId on every where) and gated by canManageLearning (the route layer).
 */

const prisma = require('../../../../core/lib/prisma');
const s3 = require('../../../../core/lib/s3');
const { writeAudit } = require('../../../../core/lib/audit');

const STALE_MSG = 'This record was updated elsewhere — reload and try again';

function biz(req) { return req.user.businessId; }
function actor(req) { return (req.user && (req.user.id || req.user.userId)) || 'system'; }
function pageParams(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

// ── Courses ───────────────────────────────────────────────────────────────────
async function listCourses(req, res, next) {
  try {
    const businessId = biz(req);
    const { page, pageSize, skip, take } = pageParams(req);
    const where = { businessId, deletedAt: null };
    if (req.query.status) where.status = req.query.status;
    if (req.query.category) where.category = req.query.category;
    if (req.query.q) where.title = { contains: String(req.query.q), mode: 'insensitive' };
    const [total, rows] = await Promise.all([
      prisma.course.count({ where }),
      prisma.course.findMany({
        where, skip, take, orderBy: { updatedAt: 'desc' },
        include: { _count: { select: { modules: true, enrollments: true } } },
      }),
    ]);
    // cheap completion stats per course (assigned/completed) — one grouped query.
    const ids = rows.map((r) => r.id);
    const grouped = ids.length
      ? await prisma.enrollment.groupBy({
        by: ['courseId', 'status'], where: { businessId, courseId: { in: ids } }, _count: true,
      })
      : [];
    const statByCourse = {};
    for (const g of grouped) {
      statByCourse[g.courseId] = statByCourse[g.courseId] || { assigned: 0, completed: 0 };
      statByCourse[g.courseId].assigned += g._count;
      if (g.status === 'COMPLETED') statByCourse[g.courseId].completed += g._count;
    }
    const items = rows.map((r) => ({
      ...r,
      lessonCount: undefined,
      moduleCount: r._count.modules,
      enrolledCount: r._count.enrollments,
      completedCount: (statByCourse[r.id] && statByCourse[r.id].completed) || 0,
      _count: undefined,
    }));
    res.json({ items, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } });
  } catch (e) { next(e); }
}

async function getCourse(req, res, next) {
  try {
    const businessId = biz(req);
    const course = await prisma.course.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: {
        modules: {
          where: { deletedAt: null }, orderBy: { orderIndex: 'asc' },
          include: {
            lessons: {
              where: { deletedAt: null }, orderBy: { orderIndex: 'asc' },
              include: { quiz: { include: { questions: { where: { deletedAt: null }, orderBy: { orderIndex: 'asc' } } } } },
            },
          },
        },
      },
    });
    if (!course) return res.status(404).json({ message: 'Not found' });
    return res.json(course);
  } catch (e) { return next(e); }
}

async function createCourse(req, res, next) {
  try {
    const businessId = biz(req);
    const { code, title } = req.body || {};
    if (!code || !title) return res.status(400).json({ message: 'code and title are required' });
    const dup = await prisma.course.findFirst({ where: { businessId, code, deletedAt: null }, select: { id: true } });
    if (dup) return res.status(409).json({ message: `A course with code "${code}" already exists` });
    const course = await prisma.course.create({
      data: {
        businessId, entityId: req.body.entityId || null, code, title,
        description: req.body.description || null,
        category: req.body.category || 'GENERAL',
        thumbnailUrl: req.body.thumbnailUrl || null,
        estMinutes: req.body.estMinutes != null ? Number(req.body.estMinutes) : null,
        passThreshold: req.body.passThreshold != null ? Number(req.body.passThreshold) : 70,
        completionRule: req.body.completionRule || 'ALL_LESSONS',
        certificateEnabled: req.body.certificateEnabled !== false,
        certificateTemplateId: req.body.certificateTemplateId || null,
        status: 'DRAFT',
      },
    });
    await writeAudit({ businessId, actorId: actor(req), action: 'learning.course.create', entityType: 'Course', entityId: course.id, meta: { code } });
    res.status(201).json(course);
  } catch (e) { next(e); }
}

async function updateCourse(req, res, next) {
  try {
    const businessId = biz(req);
    const existing = await prisma.course.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    const data = {};
    for (const k of ['title', 'description', 'category', 'thumbnailUrl', 'completionRule', 'certificateTemplateId']) {
      if (req.body[k] !== undefined) data[k] = req.body[k];
    }
    if (req.body.estMinutes !== undefined) data.estMinutes = req.body.estMinutes == null ? null : Number(req.body.estMinutes);
    if (req.body.passThreshold !== undefined) data.passThreshold = Number(req.body.passThreshold);
    if (req.body.certificateEnabled !== undefined) data.certificateEnabled = !!req.body.certificateEnabled;
    data.version = { increment: 1 };
    const updated = await prisma.course.update({ where: { id: existing.id }, data });
    return res.json(updated);
  } catch (e) { return next(e); }
}

async function deleteCourse(req, res, next) {
  try {
    const businessId = biz(req);
    const existing = await prisma.course.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    // Soft-block: a published course with active enrollments can't be deleted (record of fact).
    const active = await prisma.enrollment.count({ where: { businessId, courseId: existing.id, status: { not: 'EXPIRED' } } });
    if (active > 0) return res.status(409).json({ message: 'Course has active enrollments — archive it instead', activeEnrollments: active });
    await prisma.course.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
    await writeAudit({ businessId, actorId: actor(req), action: 'learning.course.delete', entityType: 'Course', entityId: existing.id });
    return res.json({ ok: true });
  } catch (e) { return next(e); }
}

// ── Modules ─────────────────────────────────────────────────────────────────
async function createModule(req, res, next) {
  try {
    const businessId = biz(req);
    const course = await prisma.course.findFirst({ where: { id: req.params.id, businessId, deletedAt: null }, select: { id: true } });
    if (!course) return res.status(404).json({ message: 'Course not found' });
    if (!req.body.title) return res.status(400).json({ message: 'title is required' });
    const max = await prisma.courseModule.aggregate({ where: { businessId, courseId: course.id, deletedAt: null }, _max: { orderIndex: true } });
    const mod = await prisma.courseModule.create({
      data: { businessId, courseId: course.id, title: req.body.title, orderIndex: req.body.orderIndex != null ? Number(req.body.orderIndex) : (max._max.orderIndex == null ? 0 : max._max.orderIndex + 1) },
    });
    return res.status(201).json(mod);
  } catch (e) { return next(e); }
}

async function updateModule(req, res, next) {
  try {
    const businessId = biz(req);
    const mod = await prisma.courseModule.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!mod) return res.status(404).json({ message: 'Not found' });
    const data = { version: { increment: 1 } };
    if (req.body.title !== undefined) data.title = req.body.title;
    if (req.body.orderIndex !== undefined) data.orderIndex = Number(req.body.orderIndex);
    return res.json(await prisma.courseModule.update({ where: { id: mod.id }, data }));
  } catch (e) { return next(e); }
}

async function deleteModule(req, res, next) {
  try {
    const businessId = biz(req);
    const mod = await prisma.courseModule.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!mod) return res.status(404).json({ message: 'Not found' });
    await prisma.courseModule.update({ where: { id: mod.id }, data: { deletedAt: new Date() } });
    return res.json({ ok: true });
  } catch (e) { return next(e); }
}

// ── Lessons ─────────────────────────────────────────────────────────────────
const LESSON_KINDS = new Set(['VIDEO', 'DOCUMENT', 'LINK', 'QUIZ', 'SCORM']);

async function createLesson(req, res, next) {
  try {
    const businessId = biz(req);
    const mod = await prisma.courseModule.findFirst({ where: { id: req.params.id, businessId, deletedAt: null }, select: { id: true, courseId: true } });
    if (!mod) return res.status(404).json({ message: 'Module not found' });
    const { title, kind } = req.body || {};
    if (!title || !kind) return res.status(400).json({ message: 'title and kind are required' });
    if (!LESSON_KINDS.has(kind)) return res.status(400).json({ message: 'invalid lesson kind' });
    const max = await prisma.lesson.aggregate({ where: { businessId, moduleId: mod.id, deletedAt: null }, _max: { orderIndex: true } });
    const lesson = await prisma.lesson.create({
      data: {
        businessId, moduleId: mod.id, courseId: mod.courseId, title, kind,
        orderIndex: req.body.orderIndex != null ? Number(req.body.orderIndex) : (max._max.orderIndex == null ? 0 : max._max.orderIndex + 1),
        isRequired: req.body.isRequired !== false,
        contentUrl: req.body.contentUrl || null,
        contentText: req.body.contentText || null,
        durationSec: req.body.durationSec != null ? Number(req.body.durationSec) : null,
        minWatchPct: req.body.minWatchPct != null ? Number(req.body.minWatchPct) : 90,
        estMinutes: req.body.estMinutes != null ? Number(req.body.estMinutes) : null,
      },
    });
    return res.status(201).json(lesson);
  } catch (e) { return next(e); }
}

async function updateLesson(req, res, next) {
  try {
    const businessId = biz(req);
    const lesson = await prisma.lesson.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!lesson) return res.status(404).json({ message: 'Not found' });
    const data = { version: { increment: 1 } };
    for (const k of ['title', 'contentUrl', 'contentText']) if (req.body[k] !== undefined) data[k] = req.body[k];
    if (req.body.orderIndex !== undefined) data.orderIndex = Number(req.body.orderIndex);
    if (req.body.isRequired !== undefined) data.isRequired = !!req.body.isRequired;
    if (req.body.durationSec !== undefined) data.durationSec = req.body.durationSec == null ? null : Number(req.body.durationSec);
    if (req.body.minWatchPct !== undefined) data.minWatchPct = Number(req.body.minWatchPct);
    if (req.body.estMinutes !== undefined) data.estMinutes = req.body.estMinutes == null ? null : Number(req.body.estMinutes);
    return res.json(await prisma.lesson.update({ where: { id: lesson.id }, data }));
  } catch (e) { return next(e); }
}

async function deleteLesson(req, res, next) {
  try {
    const businessId = biz(req);
    const lesson = await prisma.lesson.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!lesson) return res.status(404).json({ message: 'Not found' });
    await prisma.lesson.update({ where: { id: lesson.id }, data: { deletedAt: new Date() } });
    return res.json({ ok: true });
  } catch (e) { return next(e); }
}

async function uploadLessonMedia(req, res, next) {
  try {
    const businessId = biz(req);
    const lesson = await prisma.lesson.findFirst({ where: { id: req.params.id, businessId, deletedAt: null }, select: { id: true } });
    if (!lesson) return res.status(404).json({ message: 'Lesson not found' });
    const { dataUrl } = req.body || {};
    if (!dataUrl) return res.status(400).json({ message: 'dataUrl is required' });
    let stored;
    if (s3.isConfigured()) {
      stored = await s3.uploadDataUrl({ dataUrl, businessId, scope: 'learning' });
    } else {
      stored = { url: dataUrl }; // inline fallback (same convention as letters/letterheads)
    }
    const url = stored.url || stored;
    await prisma.lesson.update({ where: { id: lesson.id }, data: { contentUrl: url, version: { increment: 1 } } });
    return res.json({ contentUrl: url });
  } catch (e) { return next(e); }
}

// ── Quiz authoring ──────────────────────────────────────────────────────────
async function upsertQuiz(req, res, next) {
  try {
    const businessId = biz(req);
    const lesson = await prisma.lesson.findFirst({ where: { id: req.params.id, businessId, deletedAt: null }, include: { quiz: true } });
    if (!lesson) return res.status(404).json({ message: 'Lesson not found' });
    if (lesson.kind !== 'QUIZ') return res.status(400).json({ message: 'Lesson is not a QUIZ lesson' });
    const fields = {
      passThreshold: req.body.passThreshold != null ? Number(req.body.passThreshold) : 70,
      maxAttempts: req.body.maxAttempts === null ? null : (req.body.maxAttempts != null ? Number(req.body.maxAttempts) : 3),
      shuffle: req.body.shuffle !== false,
    };
    let quiz;
    if (lesson.quiz) {
      quiz = await prisma.quiz.update({ where: { id: lesson.quiz.id }, data: { ...fields, version: { increment: 1 } } });
    } else {
      quiz = await prisma.quiz.create({ data: { businessId, lessonId: lesson.id, ...fields } });
    }
    return res.status(lesson.quiz ? 200 : 201).json(quiz);
  } catch (e) { return next(e); }
}

const QUESTION_KINDS = new Set(['SINGLE', 'MULTI', 'TRUE_FALSE']);

async function createQuestion(req, res, next) {
  try {
    const businessId = biz(req);
    const quiz = await prisma.quiz.findFirst({ where: { id: req.params.id, businessId, deletedAt: null }, select: { id: true } });
    if (!quiz) return res.status(404).json({ message: 'Quiz not found' });
    const { prompt, optionsJson, correctOptionIds } = req.body || {};
    const kind = req.body.kind || 'SINGLE';
    if (!prompt) return res.status(400).json({ message: 'prompt is required' });
    if (!QUESTION_KINDS.has(kind)) return res.status(400).json({ message: 'invalid question kind' });
    if (!Array.isArray(optionsJson) || optionsJson.length < 2) return res.status(400).json({ message: 'at least 2 options are required' });
    if (!Array.isArray(correctOptionIds) || correctOptionIds.length < 1) return res.status(400).json({ message: 'at least one correct option must be marked' });
    const optIds = new Set(optionsJson.map((o) => String(o.id)));
    for (const c of correctOptionIds) if (!optIds.has(String(c))) return res.status(400).json({ message: 'correctOptionIds must reference option ids' });
    if (kind !== 'MULTI' && correctOptionIds.length !== 1) return res.status(400).json({ message: 'SINGLE/TRUE_FALSE need exactly one correct option' });
    const max = await prisma.quizQuestion.aggregate({ where: { businessId, quizId: quiz.id, deletedAt: null }, _max: { orderIndex: true } });
    const q = await prisma.quizQuestion.create({
      data: {
        businessId, quizId: quiz.id, prompt, kind,
        optionsJson: optionsJson.map((o) => ({ id: String(o.id), text: String(o.text == null ? '' : o.text) })),
        correctOptionIds: correctOptionIds.map(String),
        points: req.body.points != null ? Number(req.body.points) : 1,
        orderIndex: req.body.orderIndex != null ? Number(req.body.orderIndex) : (max._max.orderIndex == null ? 0 : max._max.orderIndex + 1),
      },
    });
    return res.status(201).json(q);
  } catch (e) { return next(e); }
}

async function updateQuestion(req, res, next) {
  try {
    const businessId = biz(req);
    const q = await prisma.quizQuestion.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!q) return res.status(404).json({ message: 'Not found' });
    const data = { version: { increment: 1 } };
    if (req.body.prompt !== undefined) data.prompt = req.body.prompt;
    if (req.body.kind !== undefined) { if (!QUESTION_KINDS.has(req.body.kind)) return res.status(400).json({ message: 'invalid kind' }); data.kind = req.body.kind; }
    if (req.body.points !== undefined) data.points = Number(req.body.points);
    if (req.body.orderIndex !== undefined) data.orderIndex = Number(req.body.orderIndex);
    if (req.body.optionsJson !== undefined) data.optionsJson = req.body.optionsJson.map((o) => ({ id: String(o.id), text: String(o.text == null ? '' : o.text) }));
    if (req.body.correctOptionIds !== undefined) data.correctOptionIds = req.body.correctOptionIds.map(String);
    return res.json(await prisma.quizQuestion.update({ where: { id: q.id }, data }));
  } catch (e) { return next(e); }
}

async function deleteQuestion(req, res, next) {
  try {
    const businessId = biz(req);
    const q = await prisma.quizQuestion.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!q) return res.status(404).json({ message: 'Not found' });
    await prisma.quizQuestion.update({ where: { id: q.id }, data: { deletedAt: new Date() } });
    return res.json({ ok: true });
  } catch (e) { return next(e); }
}

// ── Publish gate + archive ────────────────────────────────────────────────────
async function publishGateErrors(businessId, courseId) {
  const errors = [];
  const modules = await prisma.courseModule.findMany({
    where: { businessId, courseId, deletedAt: null },
    include: { lessons: { where: { deletedAt: null }, include: { quiz: { include: { questions: { where: { deletedAt: null } } } } } } },
  });
  if (!modules.length) errors.push('A course needs at least one module.');
  let lessonCount = 0;
  for (const m of modules) {
    for (const l of m.lessons) {
      lessonCount += 1;
      if (l.kind === 'QUIZ') {
        const qs = (l.quiz && l.quiz.questions) || [];
        if (!l.quiz || qs.length === 0) { errors.push(`Quiz in "${m.title}" has no questions.`); continue; }
        for (const q of qs) {
          if (!Array.isArray(q.correctOptionIds) || q.correctOptionIds.length === 0) {
            errors.push(`Quiz in "${m.title}" has a question with no correct answer marked.`);
            break;
          }
        }
      }
    }
  }
  if (lessonCount === 0) errors.push('A course needs at least one lesson.');
  return errors;
}

async function publishCourse(req, res, next) {
  try {
    const businessId = biz(req);
    const course = await prisma.course.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!course) return res.status(404).json({ message: 'Not found' });
    const errors = await publishGateErrors(businessId, course.id);
    if (errors.length) return res.status(422).json({ message: 'Course is not ready to publish', errors });
    const updated = await prisma.course.update({
      where: { id: course.id },
      data: { status: 'PUBLISHED', publishedAt: new Date(), publishedBy: actor(req), version: { increment: 1 } },
    });
    await writeAudit({ businessId, actorId: actor(req), action: 'learning.course.publish', entityType: 'Course', entityId: course.id });
    return res.json(updated);
  } catch (e) { return next(e); }
}

async function archiveCourse(req, res, next) {
  try {
    const businessId = biz(req);
    const course = await prisma.course.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!course) return res.status(404).json({ message: 'Not found' });
    const updated = await prisma.course.update({ where: { id: course.id }, data: { status: 'ARCHIVED', version: { increment: 1 } } });
    await writeAudit({ businessId, actorId: actor(req), action: 'learning.course.archive', entityType: 'Course', entityId: course.id });
    return res.json(updated);
  } catch (e) { return next(e); }
}

module.exports = {
  listCourses, getCourse, createCourse, updateCourse, deleteCourse,
  createModule, updateModule, deleteModule,
  createLesson, updateLesson, deleteLesson, uploadLessonMedia,
  upsertQuiz, createQuestion, updateQuestion, deleteQuestion,
  publishCourse, archiveCourse,
  _internals: { publishGateErrors, STALE_MSG },
};
