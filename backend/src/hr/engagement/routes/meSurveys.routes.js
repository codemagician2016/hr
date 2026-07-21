'use strict';

/**
 * meSurveys.routes.js — Feature 33 ESS survey surface, mounted at
 * /api/hr/me/engagement/surveys (BEFORE the /me/engagement feed router in the
 * aggregator so its middleware never double-runs). CUSTOMER session; SELF-ONLY
 * (the subject is resolved from the session inside the controller, never from the
 * client). No permission key — answering your own in-audience surveys is a
 * self-scope right, exactly like reading the news feed.
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/meSurveys.controller');

router.use(requireCustomer);

router.get('/', c.list);
router.get('/:occurrenceId', c.detail);
router.post('/:occurrenceId/submit', c.submit);
router.post('/:occurrenceId/dismiss', c.dismiss);

module.exports = router;
