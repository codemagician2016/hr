'use strict';

/**
 * meHelpdesk.routes.js — HR Helpdesk EMPLOYEE self-service, mounted at
 * /api/hr/me/helpdesk on the CUSTOMER session. SELF_ONLY by construction (the subject
 * employee is resolved from the session; no employeeId is accepted from any path/body),
 * so a cross-employee read/write is structurally impossible. No permission key is
 * needed — the SELF scope band carries it (same as ESS leave/expenses).
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('../helpdesk/meHelpdesk.controller');

router.use(requireCustomer);

router.get('/reference', c.reference);          // categories + priorities for the raise form
router.get('/tickets', c.listMyTickets);        // "My tickets"
router.post('/tickets', c.createTicket);        // raise a ticket
router.get('/tickets/:id', c.getMyTicket);      // detail + public thread
router.post('/tickets/:id/reply', c.replyMyTicket);
router.post('/tickets/:id/reopen', c.reopenMyTicket);
router.post('/tickets/:id/rate', c.rateMyTicket);

module.exports = router;
