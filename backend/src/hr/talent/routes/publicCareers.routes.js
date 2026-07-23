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

// Feature 36 — tokenised candidate status/timeline + interview slot confirm.
// UNAUTH, rate-limited; the tenant resolves from :businessSlug and the candidate
// from :token (never a client id). No score / internal note / other candidate is
// ever serialised (§4.6, §6).
router.get('/:businessSlug/c/:token', pc.candidateTimeline);
router.get('/:businessSlug/c/:token/slots/:proposalId', pc.candidateSlotProposal);
router.post('/:businessSlug/c/:token/slots/:proposalId/confirm', express.json(), pc.candidateConfirmSlot);

module.exports = router;
