'use strict';

/**
 * taxWindow.routes.js — Feature 20 slice 20a. InvestmentDeclarationWindow admin,
 * mounted at /api/hr/tax-windows. Operator session + RBAC:
 *   read  → canViewPayrollReports
 *   write → canManageStatutory (the window moves TDS money — a statutory-config gate)
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../tax/investmentProof/taxWindow.controller');

router.use(protect);

router.get('/', requirePermission('canViewPayrollReports'), c.listWindows);
router.get('/:id', requirePermission('canViewPayrollReports'), c.getWindow);
router.post('/', requirePermission('canManageStatutory'), c.createWindow);
router.post('/:id/open', requirePermission('canManageStatutory'), c.openWindow);
router.post('/:id/close', requirePermission('canManageStatutory'), c.closeWindow);
router.post('/:id/lock', requirePermission('canManageStatutory'), c.lockWindow);

module.exports = router;
