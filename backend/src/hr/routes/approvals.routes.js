'use strict';

/**
 * approvals.routes.js — Feature 10 §7.1/§7.2/§7.3 engine HTTP surface. Mounted at
 * /api/hr/approvals (see routes/index.js). All routes require an authenticated
 * operator (`protect`). Workflow CONFIG is gated by canManageApprovalWorkflows; the
 * INBOX + DECIDE are open to any authenticated operator (the engine's resolved
 * approver set is the real gate — a non-approver gets 403 from recordDecision);
 * reassign + the admin delegation view are gated by canManageApprovalWorkflows.
 *
 * Literal paths (/workflows, /inbox, /delegations) are registered BEFORE the
 * `/:id` param routes so they are not captured by them.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/approvals.controller');

router.use(protect);

const WF = requirePermission('canManageApprovalWorkflows');

// ── §7.1 Workflow config (canManageApprovalWorkflows) ──
router.get('/workflows', WF, c.listWorkflows);
router.post('/workflows', WF, c.createWorkflow);
router.get('/workflows/:id', WF, c.getWorkflow);
router.put('/workflows/:id', WF, c.updateWorkflow);
router.put('/workflows/:id/steps', WF, c.replaceSteps);
router.post('/workflows/:id/publish', WF, c.publishWorkflow);
router.post('/workflows/:id/preview', WF, c.previewWorkflow);
router.delete('/workflows/:id', WF, c.deleteWorkflow);

// ── §7.3 Delegation (admin tenant-wide view) ──
router.get('/delegations', WF, c.listAllDelegations);

// ── §7.2 Inbox + act (any authenticated approver) ──
router.get('/inbox', c.inbox);
router.get('/:id', c.getRequest);
router.post('/:id/decide', c.decide);
router.post('/:id/reassign', WF, c.reassign);

module.exports = router;
