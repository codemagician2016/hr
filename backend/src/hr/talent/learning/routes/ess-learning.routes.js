'use strict';

/**
 * ess-learning.routes.js — EMPLOYEE self-service learning API, mounted at
 * /api/hr/ess/learning (Feature 37 §5.3).
 *
 * Uses the CUSTOMER-auth middleware (req.customer): the ESS runs on the customer
 * session, not an operator session. The subject employee is derived ENTIRELY from the
 * session — there is NO :employeeId in any path, so a cross-employee read/write is
 * structurally impossible (mirror of ess-performance.routes). Every enrollment in the
 * path is re-asserted to belong to the session employee in the controller (IDOR-safe).
 * No permission/scope middleware: the surface is self-only by construction; terminated-
 * employee write lockout is enforced in the controller (writeGuard). The quiz answer key
 * is stripped by the serializer; scoring is server-only on submit.
 */
const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../../../core/middleware/auth.middleware');
const c = require('../controllers/essLearning.controller');

router.use(requireCustomer);

// My Learning home + optional catalog
router.get('/overview', c.overview);
router.get('/catalog', c.catalog);
router.post('/catalog/:courseId/enroll', c.enroll);

// Course player (own enrollment only)
router.get('/enrollments/:id', c.getPlayer);
router.post('/enrollments/:id/lessons/:lessonId/progress', c.updateProgress);

// Quiz (answer key stripped; server-side scoring)
router.get('/enrollments/:id/quiz/:quizId', c.getQuiz);
router.post('/enrollments/:id/quiz/:quizId/attempt', c.submitQuiz);

// Certificate (vault document reference)
router.get('/enrollments/:id/certificate', c.getCertificate);

module.exports = router;
