'use strict';

/**
 * meProfile.routes.js — ESS profile surface, mounted at /api/hr/me/profile. CUSTOMER
 * session (req.customer); SELF_ONLY by construction (no `:id` for the subject — the
 * subject employee is resolved from the session, so cross-employee read/write is
 * structurally impossible).
 *
 *   GET / — the original country/currency gate + sparse profile (back-compat,
 *           unchanged keys — useCountry / fail-closed gating still works).
 *
 * FLAG (Feature 13 — shared edit): the rich, sectioned profile + per-field governance
 * is added below. Reads carry a `policy` per field (self-edit / hr-approval /
 * read-only); writes go through ONE policy-split resolver so a gated field can never
 * be smuggled through a self-edit endpoint. Section CRUD (addresses, emergency ≤2,
 * education, family/nominee ≤100%) and gated change-requests (→ F10 PROFILE_CHANGE
 * engine) live here too. The original GET / handler + meProfile.controller are intact.
 */

const express = require('express');
const router = express.Router();
const { requireCustomer } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/meProfile.controller');
const rich = require('../../profile/meProfileRich.controller');
const sec = require('../../profile/meProfileSections.controller');

router.use(requireCustomer);

// ── country/currency gate + sparse profile (original, back-compat) ──
router.get('/', c.getMyProfile);

// ── Feature 13: rich sectioned read with per-field policy ──
router.get('/full', rich.getFull);

// ── self-edit writes (policy-split: gated fields auto-route to change requests) ──
router.patch('/personal', rich.patchPersonal);
router.patch('/contact', rich.patchContact);

// ── typed addresses (correspondence/permanent/office + "same as") ──
router.put('/addresses/:type', sec.upsertAddress);

// ── emergency contacts (≤2) ──
router.post('/emergency', sec.createEmergency);
router.patch('/emergency/:id', sec.updateEmergency);
router.delete('/emergency/:id', sec.deleteEmergency);

// ── education ──
router.post('/education', sec.createEducation);
router.patch('/education/:id', sec.updateEducation);
router.delete('/education/:id', sec.deleteEducation);

// ── family / dependants (incl. nominee %, sum ≤100) ──
router.post('/family', sec.createFamily);
router.patch('/family/:id', sec.updateFamily);
router.delete('/family/:id', sec.deleteFamily);

// ── photo ID ──
router.post('/photo', sec.setPhoto);

// ── gated change requests (the hr-approval path) ──
router.get('/change-requests', rich.listChangeRequests);
router.post('/change-requests', rich.submitChangeRequests);

module.exports = router;
