'use strict';

/**
 * helpdesk.routes.js — HR Helpdesk OPERATOR console (Cycle 1), mounted at
 * /api/hr/helpdesk on the operator session. Every route is gated by canManageHelpdesk
 * (seeded for Owner + HR-Admin); controllers are tenant-walled on req.user.businessId.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../helpdesk/tickets.controller');

router.use(protect);
router.use(requirePermission('canManageHelpdesk'));

// Categories (SLA buckets + default assignee).
router.get('/categories', c.listCategories);
router.post('/categories', c.createCategory);
router.patch('/categories/:id', c.updateCategory);

// Ticket queue + console.
router.get('/tickets', c.listTickets);
router.get('/tickets/stats', c.queueStats);
router.get('/tickets/:id', c.getTicket);
router.post('/tickets/:id/assign', c.assignTicket);
router.post('/tickets/:id/status', c.changeStatus);
router.post('/tickets/:id/reply', c.replyTicket); // employee-visible reply OR internal note (isInternal)

module.exports = router;
