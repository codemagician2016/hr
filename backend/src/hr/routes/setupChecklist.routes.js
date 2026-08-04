'use strict';

/**
 * setupChecklist.routes.js — the Setup Guide API, mounted at /api/hr/setup-checklist.
 *
 * Gated on canManageCompanyProfile (Owner + HR-Admin), matching the existing nav gate
 * on the "Setup guide" item — the guide is a settings surface, and anyone who cannot
 * see the nav entry has no use for the payload. Reads and writes share the gate: the
 * only writes are per-tenant dismissals and per-operator UI bookkeeping.
 *
 * Tenant scoping lives in the controller (req.user.businessId, never the client's).
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/setupChecklist.controller');

router.use(protect);
const gate = requirePermission('canManageCompanyProfile');

router.get('/', gate, c.getChecklist);

// "Not needed for us" / undo. Both return the freshly-recomputed payload so the
// page can swap without a second round-trip. A required step 422s.
router.post('/dismiss', gate, c.dismissStep);
router.post('/restore', gate, c.restoreStep);

// Per-operator UI bookkeeping (widget hidden-until, nudge caps, confetti-fired).
// 204 — the client already knows what it just asked for.
router.post('/ui', gate, c.setUiState);

module.exports = router;
