'use strict';

/**
 * esign.routes.js — built-in e-sign routes (Feature 4 §4.4, §4.6, slice 4d).
 * Mounted at /api/hr/esign by the HR route aggregator.
 *
 * Two route families:
 *   - HR operator (create / read an envelope) → protect + requirePermission +
 *     withEmployeeScope; the controller 404s an out-of-team subject (IDOR-safe).
 *     Per §4.5, envelope creation is an HR action gated on
 *     canManageOnboarding OR canGenerateLetters (offer/contract vs letters).
 *   - PUBLIC token routes (GET/POST /sign/:token) → NO auth/scope middleware: the
 *     hashed magic-link TOKEN is the auth. The controller derives businessId from
 *     the envelope the token resolves to (tenant-correct), and rejects an
 *     expired/invalid token with a 401 (no signature recorded).
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../../middleware/scope.middleware');
const { effectivePermissions } = require('../../../core/lib/rbac');
const { ROLES } = require('../../../core/lib/roles');
const c = require('../controllers/esign.controller');

// Passes when the actor has EITHER of two permission keys (offer/contract
// envelopes use canManageOnboarding; letters use canGenerateLetters). A single
// check (not chained requirePermission calls — those send a 403 directly rather
// than calling next, so they cannot be composed).
function requireEitherPermission(keyA, keyB) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
    if (req.user.role === ROLES.SUPER_ADMIN) return next();
    const perms = effectivePermissions(req.user) || {};
    if (perms[keyA] || perms[keyB]) return next();
    return res.status(403).json({
      message: `Forbidden: missing permission "${keyA}" or "${keyB}"`,
      missingPermission: keyA,
    });
  };
}

// ── PUBLIC token routes (token is the auth — no session) ─────────────────────
// Declared BEFORE the protected sub-router so they are never gated by `protect`.
router.get('/sign/:token', c.getSignPayload);
router.post('/sign/:token', c.submitSignature);

// ── HR operator routes ───────────────────────────────────────────────────────
const hr = express.Router();
hr.use(protect);
hr.use(attachSelfEmployee); // F1 hierarchy anchor (req.user.employeeId)

hr.post('/envelopes',
  requireEitherPermission('canManageOnboarding', 'canGenerateLetters'),
  withEmployeeScope('canManageOnboarding'),
  c.createEnvelope);

hr.get('/envelopes/:id',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees'),
  c.getEnvelope);

router.use(hr);

module.exports = router;
