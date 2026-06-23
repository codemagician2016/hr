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
router.get('/org', c.org); // legacy whole-tree (kept for small tenants / fallback)

// Feature 19 — employee-centric lazy org chart. Self-rooted landing (self + path to
// top), drill-down (own sub-tree), go-to-top (card-only roots), search-to-locate.
// All on the customer session; scope = resolveCustomerScope + the §3.3 policy. No
// :id ever names the SUBJECT — only a tree node to expand, gated to the actor's own
// sub-tree (or a policy-allowed ancestor) else 404. No compensation on any node.
router.get('/org/self', c.orgSelf);
router.get('/org/top', c.orgTop);
router.get('/org/search', c.orgSearch);
router.get('/org/nodes/:id/children', c.orgChildren);
router.get('/org/nodes/:id/ancestors', c.orgAncestors);

module.exports = router;
