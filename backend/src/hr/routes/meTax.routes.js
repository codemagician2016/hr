'use strict';

/**
 * meTax.routes.js — Employee Self-Service (ESS) tax declaration, mounted at
 * /api/hr/me/tax-declaration. CUSTOMER session (req.customer); SELF_ONLY — the
 * subject employee is resolved from the session inside the controller, never from
 * the client, so a cross-employee write is structurally impossible.
 *
 * GET  → country + saved declaration (page prefill).
 * POST/PUT → persist the declaration onto the employee's StatutoryProfile.
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/meTax.controller');

router.use(requireCustomer);

router.get('/', c.getDeclaration);
router.post('/', c.saveDeclaration);
router.put('/', c.saveDeclaration);

module.exports = router;
