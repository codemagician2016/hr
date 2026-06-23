'use strict';
// Performance routes — mounted at /api/hr/performance (Feature 8).
//
// EVERY route now applies the F1 scope chokepoint (BUG #1 fix):
//   protect → requirePermission(key) → attachSelfEmployee → withEmployeeScope(action)
// and the controller ANDs scopeWhere/scopeAllows into the query. A Manager
// (TEAM band) sees/acts only on their reporting sub-tree; an out-of-scope subject
// 404s (the controller keys the :id guard on the SUBJECT employee, not the row id).
//
// Permission keys (Feature 8, rbac.js):
//   reads (cycles/reviews/goals)      → canViewTeamPerformance (Manager + HR-Admin)
//   cycle config / launch / release   → canManagePerformanceCycle (HR-Admin)
//   calibrate / sign-off              → canCalibrateRatings (HR-Admin)
//   close / reopen / create           → canManagePerformanceCycle (HR-Admin)
//   link-compensation                 → canManageCompensation (F5 hand-off, idempotent)
// Acting steps carry the SoD scope action (review.submitMgr/calibrate/signOff) so a
// reviewer can never act on their OWN instance (the resolver subtracts self).
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../../middleware/scope.middleware');
const c = require('../controllers/performance.controller');
const okr = require('../controllers/okr.controller');
const cal = require('../controllers/calibration.controller');
const cfg = require('../controllers/perfConfig.controller');

router.use(protect);
router.use(attachSelfEmployee);

const view = requirePermission('canViewTeamPerformance');
const config = requirePermission('canManagePerformanceCycle');
const calibrate = requirePermission('canCalibrateRatings');
const linkComp = requirePermission('canManageCompensation');

// req.scope is resolved for the controller's scopeWhere/scopeAllows. We attach the
// read scope here (no idParam — the :id is a review/cycle id, not an employee id);
// the controller maps :id → subject employeeId and 404s on a scope miss.
const scope = withEmployeeScope('canViewTeamPerformance');

// ── Review cycles (config — HR-Admin) ────────────────────────────────────────
router.get('/cycles', view, scope, c.listCycles);
router.get('/cycles/:id', view, scope, c.getCycle);
router.get('/cycles/:id/stats', view, scope, c.cycleStats);
router.post('/cycles', config, scope, c.createCycle);
router.patch('/cycles/:id', config, scope, c.updateCycle);
router.delete('/cycles/:id', config, scope, c.removeCycle);
router.post('/cycles/:id/launch', config, scope, c.launchCycle);
router.post('/cycles/:id/release', config, scope, c.releaseCycle);

// ── Performance reviews (scoped lifecycle) ───────────────────────────────────
router.get('/reviews', view, scope, c.listReviews);
router.get('/reviews/:id', view, scope, c.getReview);
router.post('/reviews', config, scope, c.createReview);
router.post('/reviews/:id/self', view, scope, c.submitSelfReview);
router.post('/reviews/:id/manager', view, scope, c.submitManagerReview);
router.post('/reviews/:id/calibrate', calibrate, scope, c.calibrateReview);
router.post('/reviews/:id/sign-off', calibrate, scope, c.signOffReview);
router.post('/reviews/:id/acknowledge', view, scope, c.acknowledgeReview);
router.post('/reviews/:id/close', config, scope, c.closeReview);
router.post('/reviews/:id/reopen', config, scope, c.reopenReview);
router.post('/reviews/:id/link-compensation', linkComp, scope, c.linkCompensation);

// ── Goals (flat path) ────────────────────────────────────────────────────────
router.get('/goals', view, scope, c.listGoals);
router.get('/goals/:id', view, scope, c.getGoal);
router.post('/goals', view, scope, c.createGoal);
router.patch('/goals/:id', view, scope, c.updateGoal);
router.delete('/goals/:id', view, scope, c.removeGoal);

// ── Objectives / OKRs ─────────────────────────────────────────────────────────
router.get('/objectives', view, scope, okr.listObjectives);
router.get('/objectives/:id', view, scope, okr.getObjective);
router.post('/objectives', view, scope, okr.createObjective);
router.patch('/objectives/:id', view, scope, okr.updateObjective);
router.get('/objectives/:id/validate-weights', view, scope, okr.validateObjectiveWeights);
router.post('/objectives/:id/key-results', view, scope, okr.createKeyResult);
router.post('/key-results/:id/check-ins', view, scope, okr.createCheckIn);

// ── Calibration (HR + skip-level) ─────────────────────────────────────────────
router.get('/calibration/sessions', calibrate, scope, cal.listSessions);
router.post('/calibration/sessions', calibrate, scope, cal.createSession);
router.get('/calibration/sessions/:id/roster', calibrate, scope, cal.sessionRoster);
router.patch('/calibration/sessions/:id', calibrate, scope, cal.updateSession);

// ── Config: review templates + rating scales (HR-Admin) ───────────────────────
router.get('/templates', view, scope, cfg.listTemplates);
router.post('/templates', config, scope, cfg.createTemplate);
router.patch('/templates/:id', config, scope, cfg.updateTemplate);
router.get('/scales', view, scope, cfg.listScales);
router.post('/scales', config, scope, cfg.createScale);
router.patch('/scales/:id', config, scope, cfg.updateScale);

// ── 1:1s (manager ↔ employee; privateNotes never leave this surface to ESS) ────
router.get('/one-on-ones', view, scope, cfg.listOneOnOnes);
router.post('/one-on-ones', view, scope, cfg.createOneOnOne);
router.patch('/one-on-ones/:id', view, scope, cfg.updateOneOnOne);

// ── Merit recommendations (read; Finance + HR). F5 owns apply/back-link. ───────
router.get('/merit-recommendations', view, scope, cfg.listMeritRecommendations);

module.exports = router;
