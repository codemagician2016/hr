'use strict';

/**
 * meTeam.routes.js — Feature 13 Manager Self-Service, mounted at /api/hr/me/team
 * (CUSTOMER session). SELF_ONLY subject: the manager is the session employee; the F1
 * TEAM band is resolved ON THE CUSTOMER SESSION (resolveCustomerScope) inside each
 * controller. No `:id` ever names the subject — only the row-id of a leave/expense
 * being decided, which is re-scoped to the manager's sub-tree (out-of-scope → 404).
 *
 * A non-manager (SELF band) hitting these endpoints gets [] (their sub-tree minus
 * self), never an error and never another person's data.
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('./meTeam.controller');

router.use(requireCustomer);

router.get('/roster', c.roster);
router.get('/attendance', c.attendance);
router.get('/directory', c.directory);
router.get('/leave/pending', c.leavePending);
router.post('/leave/:id/decide', c.leaveDecide);
router.get('/reimbursements/pending', c.reimbursementsPending);
router.post('/reimbursements/:id/decide', c.reimbursementDecide);
router.get('/approvals', c.approvalsInbox);
router.get('/org', c.org);

module.exports = router;
