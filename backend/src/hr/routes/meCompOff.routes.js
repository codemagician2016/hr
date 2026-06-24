'use strict';

/**
 * meCompOff.routes.js — Employee Self-Service (ESS) comp-off API, mounted at
 * /api/hr/me/comp-off. CUSTOMER session (req.customer); the subject employee is
 * resolved ENTIRELY from the session — SELF_ONLY by construction (no employeeId in
 * any path or body). AVAIL reuses the existing Apply-Leave form (POST /me/leave/
 * requests with the COMP_OFF leave type) — there is no avail endpoint here.
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/compOff.controller');

router.use(requireCustomer);

router.get('/credits', c.listMyCredits);
router.get('/balance', c.myBalance);

module.exports = router;
