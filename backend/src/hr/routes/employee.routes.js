'use strict';
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');
const c = require('../controllers/employee.controller');
// FLAG (Feature 14 — shared edit): when a countryCode IS supplied on employee
// create it must match the tenant (off-country → 422). Employee.countryCode is
// nullable, so absent is allowed (no stamp) and reads fall through to tenantCountry.
const { assertTenantCountryWrite } = require('../tenant/assertTenantCountry.middleware');

// All employee routes require an authenticated operator (tenant admin/HR/etc.).
router.use(protect);
router.use(attachSelfEmployee); // Feature 1: hierarchy anchor (req.user.employeeId)

router.get('/', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees'), c.list);
router.get('/:id', requirePermission('canViewEmployees'), withEmployeeScope('canViewEmployees', { idParam: 'id' }), c.get);
router.post('/', requirePermission('canManageEmployees'), assertTenantCountryWrite('body.countryCode', { stampWhenAbsent: false }), c.create);
router.patch('/:id', requirePermission('canManageEmployees'), withEmployeeScope('canManageEmployees', { idParam: 'id' }), c.update);
router.post('/:id/terminate', requirePermission('canManageEmployees'), withEmployeeScope('canManageEmployees', { idParam: 'id' }), c.terminate);

module.exports = router;
