'use strict';
// Public careers routes — Feature 12. Mounted at /api/public/careers (UNAUTH).
// No `protect`: the tenant is resolved from :businessSlug and every read/write is
// hard-scoped to it. Screening points/knockout values are never serialised; the
// apply endpoint is rate-limited (per IP+email), enforces resume upload caps, and
// requires consent. Returns a thank-you only — never the candidate's score.
const express = require('express');
const router = express.Router();
const pc = require('../recruitment/publicCareers.controller');

router.get('/:businessSlug', pc.publicBoard);
router.get('/:businessSlug/jobs/:publicSlug', pc.publicJobDetail);
router.post('/:businessSlug/jobs/:publicSlug/apply', express.json({ limit: '15mb' }), pc.publicApply);

module.exports = router;
