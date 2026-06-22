'use strict';
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/compensation.controller');

// All compensation routes require an authenticated operator. Reads are gated by
// canViewCompensation; writes by canManageCompensation (comp is sensitive PII).
router.use(protect);

// ── Pay components (SalaryComponent) ──
router.get('/components', requirePermission('canViewCompensation'), c.components.list);
router.get('/components/:id', requirePermission('canViewCompensation'), c.components.get);
router.post('/components', requirePermission('canManageCompensation'), c.components.create);
router.patch('/components/:id', requirePermission('canManageCompensation'), c.components.update);
router.delete('/components/:id', requirePermission('canManageCompensation'), c.components.remove);

// ── Salary structures (templates) ──
router.get('/structures', requirePermission('canViewCompensation'), c.structures.list);
router.get('/structures/:id', requirePermission('canViewCompensation'), c.structures.get);
router.post('/structures', requirePermission('canManageCompensation'), c.structures.create);
router.patch('/structures/:id', requirePermission('canManageCompensation'), c.structures.update);
router.delete('/structures/:id', requirePermission('canManageCompensation'), c.structures.remove);

// ── Effective-dated compensation revisions, scoped to one employee ──
router.get('/employees/:employeeId/revisions', requirePermission('canViewCompensation'), c.revisions.list);
router.post('/employees/:employeeId/revisions', requirePermission('canManageCompensation'), c.revisions.create);

module.exports = router;
