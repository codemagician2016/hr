'use strict';

/**
 * issuance.routes.js — Letters issuance routes (Feature 9 §4.5, slice 9E).
 * Mounted at /api/hr/letters by the HR route aggregator.
 *
 * RBAC (§4.4):
 *   - preview / issue / reissue / register / get / download → canGenerateLetters
 *     (the maker/issue key). Routes that name an employee additionally run
 *     withEmployeeScope so an out-of-band subject 404s (IDOR-safe, never 403).
 *   - revoke → canManageLetters (the config/checker key, distinct from issuer).
 *
 * NOTE on ordering: literal paths (/preview, /issue, /register) are declared
 * BEFORE the /:id family so Express never treats "register" as an :id.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../../middleware/scope.middleware');
const c = require('../controllers/issuance.controller');

router.use(protect);
router.use(attachSelfEmployee); // F1 hierarchy anchor (req.user.employeeId)

// ── issuance (maker key: canGenerateLetters) ──────────────────────────────────
// withEmployeeScope attaches req.scope; the controller 404s an out-of-scope
// subject employee named in the body (preview/issue) — IDOR-safe.
router.post('/preview',
  requirePermission('canGenerateLetters'),
  withEmployeeScope('canGenerateLetters'),
  c.preview);

router.post('/issue',
  requirePermission('canGenerateLetters'),
  withEmployeeScope('canGenerateLetters'),
  c.issue);

// ── register / read (maker key) ───────────────────────────────────────────────
router.get('/register',
  requirePermission('canGenerateLetters'),
  c.register);

// Per-employee history — scoped on the :employeeId path param (out-of-band ⇒ 404).
router.get('/employees/:employeeId/letters',
  requirePermission('canGenerateLetters'),
  withEmployeeScope('canGenerateLetters', { idParam: 'employeeId' }),
  c.employeeLetters);

// ── :id family ────────────────────────────────────────────────────────────────
router.post('/:id/reissue',
  requirePermission('canGenerateLetters'),
  withEmployeeScope('canGenerateLetters'),
  c.reissue);

// Revoke requires the CONFIG/checker key (SoD: distinct from the issuer).
router.post('/:id/revoke',
  requirePermission('canManageLetters'),
  c.revoke);

router.get('/:id/download',
  requirePermission('canGenerateLetters'),
  withEmployeeScope('canGenerateLetters'),
  c.download);

router.get('/:id',
  requirePermission('canGenerateLetters'),
  withEmployeeScope('canGenerateLetters'),
  c.getOne);

module.exports = router;
