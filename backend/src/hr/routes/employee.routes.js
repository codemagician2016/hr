'use strict';
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');
const c = require('../controllers/employee.controller');
// Phase 5b — per-employee custom-field values. Reuses the employee router's
// protect + withEmployeeScope(idParam) so a manager only touches their sub-tree.
const cf = require('../customfields/customFields.controller');
// FLAG (Feature 14 — shared edit): when a countryCode IS supplied on employee
// create it must match the tenant (off-country → 422). Employee.countryCode is
// nullable, so absent is allowed (no stamp) and reads fall through to tenantCountry.
const { assertTenantCountryWrite } = require('../tenant/assertTenantCountry.middleware');

// All employee routes require an authenticated operator (tenant admin/HR/etc.).
router.use(protect);
router.use(attachSelfEmployee); // Feature 1: hierarchy anchor (req.user.employeeId)

router.get('/', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.list);
// Feature 4 — bulk portal invite. Registered BEFORE '/:id/*' so the literal
// '/invite/bulk' path is not captured by the ':id' param. Scope is applied as a
// non-row guard (req.scope) so the controller intersects the requested IDs.
router.post('/invite/bulk', requirePermission('canManageEmployees'), withEmployeeScope('canManageEmployees'), c.inviteBulk);
router.get('/:id', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees', { idParam: 'id' }), c.get);
router.post('/', requirePermission('canManageEmployees'), assertTenantCountryWrite('body.countryCode', { stampWhenAbsent: false }), c.create);
router.patch('/:id', requirePermission('canManageEmployees'), withEmployeeScope('canManageEmployees', { idParam: 'id' }), c.update);
router.post('/:id/terminate', requirePermission('canManageEmployees'), withEmployeeScope('canManageEmployees', { idParam: 'id' }), c.terminate);
// Feature 4 — single portal invite / resend (resend re-mints, invalidating the
// prior token). Row-scoped: a manager can only invite within their sub-tree.
router.post('/:id/invite', requirePermission('canManageEmployees'), withEmployeeScope('canManageEmployees', { idParam: 'id' }), c.invite);

// Phase 5b — per-employee custom-field values (admin). Row-scoped: out-of-tree :id 404s.
router.get('/:id/custom-fields', requirePermission('canManageEmployees'), withEmployeeScope('canManageEmployees', { idParam: 'id' }), cf.getEmployeeValues);
router.patch('/:id/custom-fields', requirePermission('canManageEmployees'), withEmployeeScope('canManageEmployees', { idParam: 'id' }), cf.patchEmployeeValues);

module.exports = router;
