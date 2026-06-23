'use strict';
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');
const c = require('../controllers/compensation.controller');
// FLAG (Feature 14 — shared edit): comp currency must equal the tenant currency
// (off-currency → 422), and a structure's country must match the tenant. Kills the
// off-currency leak path at the WRITE side (the read side is already guarded).
const {
  assertTenantCountryWrite,
  assertTenantCurrencyWrite,
} = require('../tenant/assertTenantCountry.middleware');

// All compensation routes require an authenticated operator. Reads are gated by
// canViewCompensation; writes by canManageCompensation (comp is sensitive PII).
// Self-employee anchor is attached up front so per-employee routes can resolve
// the F1 scope band and /me can resolve the operator's own employeeId.
router.use(protect);
router.use(attachSelfEmployee);

// ── Pay components (SalaryComponent) ──
router.get('/components', requirePermission('canViewCompensation'), c.components.list);
router.get('/components/:id', requirePermission('canViewCompensation'), c.components.get);
router.post('/components', requirePermission('canManageCompensation'), c.components.create);
router.patch('/components/:id', requirePermission('canManageCompensation'), c.components.update);
router.delete('/components/:id', requirePermission('canManageCompensation'), c.components.remove);

// ── Salary structures (templates) ──
router.get('/structures', requirePermission('canViewCompensation'), c.structures.list);
// PURE preview (no persistence) — backs the live builder waterfall + 50% chip.
router.post('/structures/preview', requirePermission('canViewCompensation'), c.preview);
router.get('/structures/:id', requirePermission('canViewCompensation'), c.structures.get);
router.post(
  '/structures',
  requirePermission('canManageCompensation'),
  assertTenantCountryWrite('body.countryCode'),
  assertTenantCurrencyWrite('body.currencyCode'),
  c.structures.create,
);
router.patch('/structures/:id', requirePermission('canManageCompensation'), c.structures.update);
router.delete('/structures/:id', requirePermission('canManageCompensation'), c.structures.remove);

// ── Self compensation (operator session viewing their own pay) ──
// SELF_ONLY; bypasses canViewCompensation (you can always see your own pay). The
// ESS customer-session equivalent is mounted separately at /api/hr/me/compensation.
router.get('/me', c.meCompensation);

// ── Effective-dated compensation revisions, scoped to one employee ──
// withEmployeeScope adds the IDOR-safe 404 for an out-of-subtree employeeId; the
// masking shaper then returns 200 RANGE_ONLY (never 403) for in-scope reads
// without the absolute-money grant.
router.get(
  '/employees/:employeeId/revisions',
  requirePermission('canViewCompensation'),
  withEmployeeScope('compensation', { idParam: 'employeeId' }),
  c.revisions.list,
);
router.post(
  '/employees/:employeeId/revisions',
  requirePermission('canManageCompensation'),
  withEmployeeScope('compensation', { idParam: 'employeeId' }),
  assertTenantCurrencyWrite('body.currencyCode'),
  c.revisions.create,
);

// ── Branded Compensation Statement / CTC Breakup PDF for one revision. ──
// canViewCompensation gates the route; the controller applies the F5 masking
// shaper + the SAME scope band as the JSON read (out-of-subtree → 404). A
// RANGE_ONLY viewer gets a BANDED statement (compa-ratio, no absolute pay), a
// NONE viewer is refused (403, zero salary in body), an ABSOLUTE viewer gets the
// full waterfall. Defined before the parameterised POSTs to keep the GET literal
// `/revisions/:id/pdf` unambiguous.
router.get('/revisions/:id/pdf', requirePermission('canViewCompensation'), c.getRevisionPdf);

// ── Maker-checker: the proposals queue + approve/reject (SoD fail-closed). ──
// The queue is checker-facing (canApproveCompensation); each row is masked.
router.get('/revisions/proposed', requirePermission('canApproveCompensation'), c.revisions.listProposed);
router.post('/revisions/:id/approve', requirePermission('canApproveCompensation'), c.revisions.approve);
router.post('/revisions/:id/reject', requirePermission('canApproveCompensation'), c.revisions.reject);

module.exports = router;
