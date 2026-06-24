'use strict';

/**
 * dashboard.controller.js — Feature 37 compliance dashboards (/api/hr/learning).
 * The tenant compliance matrix (per-course coverage %, overdue, not-started), the
 * overdue learner list, and the POSH audit CSV export. F1-scoped: the team reads run
 * withEmployeeScope('canViewTeamLearning') so a Manager (TEAM band) sees only their
 * sub-tree's enrollments while HR-Admin (ALL band) sees the tenant — for free from F1.
 * OVERDUE is DERIVED (dueAt < now AND status not COMPLETED/WAIVED), never stored.
 */

const prisma = require('../../../../core/lib/prisma');
const { scopeWhere } = require('../../../lib/scopeResolver');

function biz(req) { return req.user.businessId; }

// Compliance matrix — for each mandatory/published course: assigned / completed /
// in-progress / overdue / not-started, scoped to the actor's band.
async function compliance(req, res, next) {
  try {
    const businessId = biz(req);
    const now = new Date();
    const empScope = scopeWhere(req.scope, 'employeeId'); // {} for ALL, { employeeId: { in } } for TEAM

    const courses = await prisma.course.findMany({
      where: { businessId, deletedAt: null, status: { in: ['PUBLISHED', 'ARCHIVED'] } },
      select: { id: true, code: true, title: true, category: true, status: true },
      orderBy: { title: 'asc' },
    });
    const courseIds = courses.map((c) => c.id);
    if (!courseIds.length) return res.json({ items: [] });

    const enrollments = await prisma.enrollment.findMany({
      where: { businessId, courseId: { in: courseIds }, ...empScope },
      select: { courseId: true, status: true, dueAt: true, progressPct: true },
    });

    const stat = {};
    for (const c of courses) stat[c.id] = { assigned: 0, completed: 0, inProgress: 0, notStarted: 0, overdue: 0 };
    for (const en of enrollments) {
      const s = stat[en.courseId];
      if (!s) continue;
      s.assigned += 1;
      if (en.status === 'COMPLETED') s.completed += 1;
      else if (en.status === 'IN_PROGRESS') s.inProgress += 1;
      else if (en.status === 'ASSIGNED') s.notStarted += 1;
      // OVERDUE derived: a non-completed, non-waived enrollment past its due date.
      if (en.dueAt && new Date(en.dueAt) < now && en.status !== 'COMPLETED' && en.status !== 'WAIVED' && en.status !== 'EXPIRED') {
        s.overdue += 1;
      }
    }
    const items = courses.map((c) => {
      const s = stat[c.id];
      const coveragePct = s.assigned > 0 ? Math.round((100 * s.completed) / s.assigned) : 0;
      return { course: c, ...s, coveragePct };
    });
    return res.json({ items });
  } catch (e) { return next(e); }
}

// Overdue learner list (paginated, F1-scoped).
async function overdue(req, res, next) {
  try {
    const businessId = biz(req);
    const now = new Date();
    const empScope = scopeWhere(req.scope, 'employeeId');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const where = {
      businessId,
      status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
      dueAt: { not: null, lt: now },
      ...empScope,
    };
    if (req.query.courseId) where.courseId = req.query.courseId;
    const [total, rows] = await Promise.all([
      prisma.enrollment.count({ where }),
      prisma.enrollment.findMany({
        where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { dueAt: 'asc' },
        include: {
          course: { select: { id: true, code: true, title: true } },
          employee: { select: { id: true, code: true, firstName: true, lastName: true } },
        },
      }),
    ]);
    const items = rows.map((r) => ({
      enrollmentId: r.id,
      employee: r.employee, course: r.course,
      dueAt: r.dueAt, progressPct: r.progressPct, status: r.status,
      daysOverdue: Math.floor((now - new Date(r.dueAt)) / (24 * 60 * 60 * 1000)),
    }));
    return res.json({ items, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } });
  } catch (e) { return next(e); }
}

// POST /dashboard/overdue/:enrollmentId/nudge — re-fire the overdue reminder.
async function nudge(req, res, next) {
  try {
    const businessId = biz(req);
    const empScope = scopeWhere(req.scope, 'employeeId');
    const en = await prisma.enrollment.findFirst({
      where: { id: req.params.enrollmentId, businessId, ...empScope },
    });
    if (!en) return res.status(404).json({ message: 'Not found' });
    const [emp, course, b] = await Promise.all([
      prisma.employee.findFirst({ where: { id: en.employeeId, businessId, deletedAt: null }, select: { id: true, firstName: true, lastName: true, code: true, workEmail: true, personalEmail: true, phone: true, countryCode: true } }),
      prisma.course.findUnique({ where: { id: en.courseId } }),
      prisma.business.findUnique({ where: { id: businessId }, select: { name: true } }),
    ]);
    if (emp && course) {
      const learnNotify = require('../notify');
      await learnNotify.overdue({ businessId, employee: emp, course, enrollment: en, bizName: (b && b.name) || 'HR' });
    }
    return res.json({ ok: true });
  } catch (e) { return next(e); }
}

// CSV audit export (POSH audit pack): employee, course, assigned, completed, score, cert ref.
async function exportCsv(req, res, next) {
  try {
    const businessId = biz(req);
    const empScope = scopeWhere(req.scope, 'employeeId');
    const where = { businessId, ...empScope };
    if (req.query.courseId) where.courseId = req.query.courseId;
    const rows = await prisma.enrollment.findMany({
      where, take: 50000, orderBy: { assignedAt: 'desc' },
      include: {
        course: { select: { code: true, title: true } },
        employee: { select: { code: true, firstName: true, lastName: true } },
        certificate: { select: { referenceNo: true } },
        quizAttempts: { select: { scorePct: true, passed: true } },
      },
    });
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = ['EmployeeCode', 'EmployeeName', 'CourseCode', 'CourseTitle', 'Status', 'AssignedAt', 'CompletedAt', 'DueAt', 'BestScorePct', 'CertificateRefNo'];
    const lines = [header.join(',')];
    for (const r of rows) {
      const best = r.quizAttempts.reduce((m, a) => (a.scorePct != null ? Math.max(m, a.scorePct) : m), 0);
      lines.push([
        esc(r.employee.code),
        esc([r.employee.firstName, r.employee.lastName].filter(Boolean).join(' ')),
        esc(r.course.code), esc(r.course.title), esc(r.status),
        esc(r.assignedAt ? r.assignedAt.toISOString().slice(0, 10) : ''),
        esc(r.completedAt ? r.completedAt.toISOString().slice(0, 10) : ''),
        esc(r.dueAt ? r.dueAt.toISOString().slice(0, 10) : ''),
        esc(r.quizAttempts.length ? best : ''),
        esc(r.certificate ? r.certificate.referenceNo : ''),
      ].join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="training-compliance.csv"');
    return res.send(lines.join('\n'));
  } catch (e) { return next(e); }
}

module.exports = { compliance, overdue, nudge, exportCsv };
