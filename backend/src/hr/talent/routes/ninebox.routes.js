'use strict';
// ninebox.routes.js — Feature 34, mounted at /api/hr/ninebox.
//
// EVERY route applies the F1 scope chokepoint, identical to performance.routes.js:
//   protect → requirePermission(key) → attachSelfEmployee → withEmployeeScope(action)
// and the controller ANDs scopeWhere/scopeAllows into the query. A Manager (TEAM band)
// sees/acts only on their reporting sub-tree; an out-of-scope subject 404s. The move
// route's SoD (ninebox.calibrate drops self) lives in the controller's loadActable.
//
// Permission keys (reuse F8 + 1 new):
//   competency library / role-map config       → canManagePerformanceCycle (HR config)
//   board read + author potential on reports    → canViewTeamPerformance (Manager/HR)
//   open / move inside a 9-box session          → canCalibrateRatings (skip-level/HR)
//   finalize / reopen / talent-pool / succession→ canManageSuccession (HR talent)
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../../middleware/scope.middleware');
const comp = require('../controllers/competency.controller');
const nb = require('../controllers/nineBox.controller');

router.use(protect);
router.use(attachSelfEmployee);

const view = requirePermission('canViewTeamPerformance');
const config = requirePermission('canManagePerformanceCycle');
const calibrate = requirePermission('canCalibrateRatings');
const succession = requirePermission('canManageSuccession');

// Read scope for the controller (the :id is a placement/tag id, not an employee id;
// the controller maps it → subject employeeId and 404s on a scope miss).
const scope = withEmployeeScope('canViewTeamPerformance');

// ── Competency framework config (HR-Admin) ────────────────────────────────────
router.get('/competencies', view, scope, comp.listCompetencies);
router.post('/competencies', config, scope, comp.createCompetency);
router.patch('/competencies/:id', config, scope, comp.updateCompetency);
router.get('/role-competencies', view, scope, comp.listRoleCompetencies);
router.post('/role-competencies', config, scope, comp.createRoleCompetency);
router.patch('/role-competencies/:id', config, scope, comp.updateRoleCompetency);
router.delete('/role-competencies/:id', config, scope, comp.removeRoleCompetency);

// ── 9-box placements + board ──────────────────────────────────────────────────
router.post('/cycles/:cycleId/seed', config, scope, nb.seedPlacements);
router.get('/board', view, scope, nb.board);
router.get('/placements/:id', view, scope, nb.getPlacement);
router.post('/placements/:id/author-potential', view, scope, nb.authorPotential);
router.post('/placements/:id/recompute-performance', config, scope, nb.recomputePerformance);
// Move carries its own SoD scope (ninebox.calibrate) re-resolved in the controller.
router.post('/placements/:id/move', calibrate, scope, nb.movePlacement);
router.post('/placements/:id/finalize', succession, scope, nb.finalizePlacement);
router.post('/placements/:id/reopen', succession, scope, nb.reopenPlacement);

// ── Calibration mode (reuse CalibrationSession, kind=NINE_BOX) ─────────────────
router.post('/sessions', calibrate, scope, nb.createSession);
router.get('/sessions/:id/grid', calibrate, scope, nb.sessionGrid);

// ── Talent pool / succession (HR talent) ──────────────────────────────────────
router.get('/talent-tags', view, scope, nb.listTalentTags);
router.post('/talent-tags', succession, scope, nb.createTalentTag);
router.patch('/talent-tags/:id', succession, scope, nb.updateTalentTag);
router.get('/succession', view, scope, nb.successionView);

module.exports = router;
