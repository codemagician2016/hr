'use strict';

/**
 * meDocuments.routes.js — Employee Self-Service (ESS) documents API, mounted at
 * /api/hr/me/documents (Feature 4 §4.4, §5.2, slice 4d).
 *
 * Uses the CUSTOMER-auth middleware (req.customer): the ESS runs on the customer
 * session, not an operator session. The subject employee is derived ENTIRELY from
 * the session (workEmail/personalEmail/linked User) — there is NO :employeeId in
 * the path, so a cross-employee read is structurally impossible. The controller
 * returns ONLY the caller's EMPLOYEE_VISIBLE rows plus anything they signed;
 * HR_ONLY documents are never exposed here (§7 QA20).
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/documents.controller');

router.use(requireCustomer);

router.get('/', c.listMyDocuments);
router.post('/', c.createMyDocument);
router.get('/:id', c.getMyDocument);

module.exports = router;
