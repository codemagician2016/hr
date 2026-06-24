'use strict';

// learning.routes.js — operator LMS API, mounted at /api/hr/learning (Feature 37 §5.2).
//
//   protect → requirePermission(key) → [attachSelfEmployee → withEmployeeScope] for
//   the team-scoped dashboard reads. Authoring/assigning is gated by canManageLearning;
//   the compliance dashboard + overdue list accept canViewTeamLearning (Manager TEAM
//   band) OR canManageLearning (HR-Admin ALL band). The dashboard controller ANDs
//   scopeWhere(req.scope) into every enrollment query so a Manager sees only their
//   reporting sub-tree — for free from F1.
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../../../middleware/scope.middleware');
const courses = require('../controllers/courses.controller');
const assignments = require('../controllers/assignments.controller');
const dashboard = require('../controllers/dashboard.controller');

router.use(protect);
router.use(attachSelfEmployee);

const manage = requirePermission('canManageLearning');

// A read gate that admits EITHER canManageLearning (ALL band) OR canViewTeamLearning
// (TEAM band). We can't OR two requirePermission middlewares, so inline the check.
const { effectivePermissions } = require('../../../../core/lib/rbac');
const { ROLES } = require('../../../../core/lib/roles');
function viewGate(req, res, next) {
  if (req.user && req.user.role === ROLES.SUPER_ADMIN) return next();
  const perms = effectivePermissions(req.user) || {};
  if (perms.canManageLearning || perms.canViewTeamLearning) return next();
  return res.status(403).json({ message: 'Forbidden: missing permission "canViewTeamLearning"', missingPermission: 'canViewTeamLearning' });
}
const teamScope = withEmployeeScope('canViewTeamLearning');

// ── Courses (builder) ─────────────────────────────────────────────────────────
router.get('/courses', viewGate, courses.listCourses);
router.post('/courses', manage, courses.createCourse);
// Course-detail READ uses the same viewGate as the list so a canViewTeamLearning
// Manager (TEAM band, no canManageLearning) can open the read-only builder after
// clicking 'View' — it previously 403'd on `manage` and dead-ended. All writes
// below stay on canManageLearning.
router.get('/courses/:id', viewGate, courses.getCourse);
router.put('/courses/:id', manage, courses.updateCourse);
router.delete('/courses/:id', manage, courses.deleteCourse);

// ── Modules ─────────────────────────────────────────────────────────────────
router.post('/courses/:id/modules', manage, courses.createModule);
router.put('/modules/:id', manage, courses.updateModule);
router.delete('/modules/:id', manage, courses.deleteModule);

// ── Lessons ─────────────────────────────────────────────────────────────────
router.post('/modules/:id/lessons', manage, courses.createLesson);
router.put('/lessons/:id', manage, courses.updateLesson);
router.delete('/lessons/:id', manage, courses.deleteLesson);
router.post('/lessons/:id/upload', manage, courses.uploadLessonMedia);

// ── Quiz authoring ──────────────────────────────────────────────────────────
router.post('/lessons/:id/quiz', manage, courses.upsertQuiz);
router.post('/quiz/:id/questions', manage, courses.createQuestion);
router.put('/questions/:id', manage, courses.updateQuestion);
router.delete('/questions/:id', manage, courses.deleteQuestion);

// ── Publish / archive ─────────────────────────────────────────────────────────
router.post('/courses/:id/publish', manage, courses.publishCourse);
router.post('/courses/:id/archive', manage, courses.archiveCourse);

// ── Assignments + enrollment overrides ────────────────────────────────────────
router.post('/courses/:id/assignments', manage, assignments.createAssignment);
router.get('/courses/:id/assignments', manage, assignments.listAssignments);
router.delete('/assignments/:id', manage, assignments.deleteAssignment);
router.post('/assignments/:id/sync', manage, assignments.syncAssignment);
router.post('/enrollments/:id/waive', manage, assignments.waiveEnrollment);
router.post('/enrollments/:id/reissue-cert', manage, assignments.reissueCert);

// ── Dashboards (F1-scoped) ────────────────────────────────────────────────────
router.get('/dashboard/compliance', viewGate, teamScope, dashboard.compliance);
router.get('/dashboard/overdue', viewGate, teamScope, dashboard.overdue);
router.post('/dashboard/overdue/:enrollmentId/nudge', viewGate, teamScope, dashboard.nudge);
router.get('/reports/export.csv', viewGate, teamScope, dashboard.exportCsv);

module.exports = router;
