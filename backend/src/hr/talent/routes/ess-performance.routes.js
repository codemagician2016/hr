'use strict';

/**
 * ess-performance.routes.js — EMPLOYEE self-service performance API, mounted at
 * /api/hr/ess/performance (Feature 8 §6.3, slice 8f).
 *
 * Uses the CUSTOMER-auth middleware (req.customer): the ESS runs on the customer
 * session, not an operator session. The subject employee is derived ENTIRELY from
 * the session — there is NO :employeeId in any path, so a cross-employee read/write
 * is structurally impossible (mirror of meSeparation.routes). No permission/scope
 * middleware: the surface is self-only by construction; terminated-employee write
 * lockout is enforced in the controller (writeGuard).
 */
const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/essPerformance.controller');

router.use(requireCustomer);

router.get('/overview', c.overview);

// Goals / OKRs (own only)
router.get('/goals', c.listGoals);
router.post('/goals', c.createGoal);
router.post('/goals/:id/key-results', c.createKeyResult);
router.post('/key-results/:id/check-ins', c.createCheckIn);

// Review (release-gated) + self-review + acknowledge
router.get('/review', c.getReview);
router.post('/review/self', c.submitSelf);
router.post('/review/acknowledge', c.acknowledge);

// Feature 34 — read-only development surface: own competency gaps + shared IDP only.
// The box / potential / talent tags are NEVER served here (self-only by construction
// + the §5.8 serializer); release-gated like the rating screen.
router.get('/development', c.development);

// Peer feedback (give / request; requester sees status only)
router.get('/feedback/requests', c.listFeedbackRequests);
router.post('/feedback/requests', c.requestFeedback);
router.post('/feedback/requests/:id/respond', c.respondFeedback);

// 1:1s (privateNotes stripped)
router.get('/one-on-ones', c.listOneOnOnes);

module.exports = router;
