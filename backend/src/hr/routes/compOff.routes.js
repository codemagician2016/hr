'use strict';

/**
 * compOff.routes.js — Feature 30 operator comp-off admin API, mounted at
 * /api/hr/comp-off. RBAC reuses F1 verbs verbatim:
 *   - reads (credits/queue/config): withEmployeeScope('canViewEmployees')
 *   - grant / void / runs / config writes: requirePermission('canManageOrg')
 *   - approve / reject: requirePermission('canApproveLeave') + withEmployeeScope
 *
 * AVAIL is NOT here — availing a comp-off is an ordinary leave application on the
 * COMP_OFF type via POST /leave/requests (the existing, engine-routed path).
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');
const c = require('../controllers/compOff.controller');

router.use(protect);
router.use(attachSelfEmployee);

// Config (admin UI) — read open to operators; writes need canManageOrg.
router.get('/config', requirePermission('canManageOrg'), c.getConfig);
router.put('/config', requirePermission('canManageOrg'), c.updateConfig);

// Ledger / queue — scoped to the actor's sub-tree (F1 scopeWhere).
router.get('/credits', withEmployeeScope('canViewEmployees'), c.listCredits);
router.get('/queue', withEmployeeScope('canApproveLeave'), c.listQueue);

// Earn lifecycle.
router.post('/credits', requirePermission('canManageOrg'), c.grantCredit);
router.post('/credits/:id/approve', requirePermission('canApproveLeave'), withEmployeeScope('canApproveLeave'), c.approveCredit);
router.post('/credits/:id/reject', requirePermission('canApproveLeave'), withEmployeeScope('canApproveLeave'), c.rejectCredit);
router.post('/credits/:id/void', requirePermission('canManageOrg'), c.voidActiveCredit);

// Ops run triggers.
router.post('/runs/earn', requirePermission('canManageOrg'), c.runEarn);
router.post('/runs/expiry', requirePermission('canManageOrg'), c.runExpiry);

module.exports = router;
