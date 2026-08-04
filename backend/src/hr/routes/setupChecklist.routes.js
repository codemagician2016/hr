'use strict';

/**
 * setupChecklist.routes.js — the Setup Guide API, mounted at /api/hr/setup-checklist.
 *
 * The CORE guide is gated on canManageCompanyProfile (Owner + HR-Admin), matching the
 * existing nav gate on the "Setup guide" item — the guide is a settings surface, and
 * anyone who cannot see the nav entry has no use for the payload. Reads and writes
 * share the gate: the only writes are per-tenant dismissals and per-operator UI
 * bookkeeping.
 *
 * The HIRING track (/talent) carries its OWN gate. A recruiter frequently lacks
 * canManageCompanyProfile — they would be locked out of their own track if it
 * inherited the core one — so it opens to canManageHiring OR canManageEmployees.
 * It is deliberately NOT wrapped in requireEntitlement: an unentitled tenant must
 * get a 200 carrying the upsell, because a 403 would put an offer behind an error
 * page. The controller short-circuits before any probe runs.
 *
 * Tenant scoping lives in the controller (req.user.businessId, never the client's).
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission, requireAnyPermission } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/setupChecklist.controller');
const { TRACKS } = require('../setup/tracks');

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

// ── The Hiring setup track ───────────────────────────────────────────────────
// Same four shapes, same controller, a different registry + a different slice of
// Business.setupState. Recruitment steps never touch the core percentage above.
const talent = c.makeHandlers('talent');
// The gate comes off the track descriptor, which is also what the core payload
// serialises on its pointer to this track — so the card that offers the link and the
// middleware that answers it are one list, and the card can never point an operator
// at a 403.
const talentGate = requireAnyPermission(TRACKS.talent.anyPermission);

router.get('/talent', talentGate, talent.getChecklist);
router.post('/talent/dismiss', talentGate, talent.dismissStep);
router.post('/talent/restore', talentGate, talent.restoreStep);
router.post('/talent/ui', talentGate, talent.setUiState);

module.exports = router;
