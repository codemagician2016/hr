'use strict';

/**
 * meExpenses.routes.js — Feature 11 Employee Self-Service (ESS) for reimbursement
 * claims + travel/outdoor-duty, mounted at /api/hr/me/expenses on the CUSTOMER session.
 *
 * SELF_ONLY by construction: the subject employee is resolved from the session in the
 * controller; there is NO employeeId in any path or accepted from a body, so applying /
 * listing / submitting / cancelling can only ever touch the caller's own claims + trips.
 * Terminated/inactive employees are locked out (404).
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const c = require('../expenses/meExpenses.controller');

router.use(requireCustomer);

// Reference data the forms need (categories + active policy summary).
router.get('/reference', c.reference);

// Live policy verdict for a draft line (the "within / over budget" badge).
router.post('/policy/preview', c.previewPolicy);

// Claims
router.get('/claims', c.listClaims);
router.post('/claims', c.createClaim);
router.get('/claims/:id', c.getClaim);
router.patch('/claims/:id', c.updateClaim);
router.post('/claims/:id/lines', c.addLine);
router.delete('/claims/:id/lines/:lineId', c.removeLine);
router.post('/claims/:id/submit', c.submitClaim);
router.post('/claims/:id/cancel', c.cancelClaim);

// Trips (outdoor duty / travel)
router.get('/trips', c.listTrips);
router.post('/trips', c.createTrip);
router.get('/trips/:id', c.getTrip);
router.post('/trips/:id/submit', c.submitTrip);
router.post('/trips/:id/cancel', c.cancelTrip);

module.exports = router;
