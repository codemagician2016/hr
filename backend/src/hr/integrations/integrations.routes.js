'use strict';

/**
 * integrations.routes.js — operator-facing HR integrations API.
 * Mounted by the HR aggregator at /api/hr/integrations.
 *
 * RBAC: GL export reuses the payroll reports permission (it exposes pay-run
 * money), so canViewPayrollReports gates the accounting endpoints.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('./integrations.controller');

router.use(protect);

// Accounting GL export for a pay run.
router.get('/runs/:id/gl', requirePermission('canViewPayrollReports'), c.exportGl);
router.get('/runs/:id/gl/preview', requirePermission('canViewPayrollReports'), c.previewGl);

module.exports = router;
