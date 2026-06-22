'use strict';
// Performance routes — mounted at /api/hr/performance.
// Reads require canViewEmployees; writes (cycle/review/goal mutations + review
// lifecycle transitions) require canManageEmployees. Tenant scope is enforced
// in the controller via req.user.businessId.
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/performance.controller');

router.use(protect);
const canView = requirePermission('canViewEmployees');
const canManage = requirePermission('canManageEmployees');

// ── Review cycles ────────────────────────────────────────────────────────────
router.get('/cycles', canView, c.listCycles);
router.get('/cycles/:id', canView, c.getCycle);
router.post('/cycles', canManage, c.createCycle);
router.patch('/cycles/:id', canManage, c.updateCycle);
router.delete('/cycles/:id', canManage, c.removeCycle);

// ── Performance reviews (self/manager lifecycle) ─────────────────────────────
router.get('/reviews', canView, c.listReviews);
router.get('/reviews/:id', canView, c.getReview);
router.post('/reviews', canManage, c.createReview);
router.post('/reviews/:id/self', canManage, c.submitSelfReview);
router.post('/reviews/:id/manager', canManage, c.submitManagerReview);
router.post('/reviews/:id/calibrate', canManage, c.calibrateReview);
router.post('/reviews/:id/acknowledge', canManage, c.acknowledgeReview);

// ── Goals ────────────────────────────────────────────────────────────────────
router.get('/goals', canView, c.listGoals);
router.get('/goals/:id', canView, c.getGoal);
router.post('/goals', canManage, c.createGoal);
router.patch('/goals/:id', canManage, c.updateGoal);
router.delete('/goals/:id', canManage, c.removeGoal);

module.exports = router;
