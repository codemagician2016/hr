'use strict';

/**
 * statutoryRegistrations.routes.js — Entity → Registrations, mounted at
 * /api/hr/statutory-registrations.
 *
 * RBAC reuses the existing catalog — no new permission key:
 *   read   → canViewPayrollReports OR canManageStatutory (Finance reads the numbers
 *            it files against; HR-Admin maintains them)
 *   write  → canManageStatutory
 *
 * `protect` runs first so req.user.businessId is populated for tenant scoping; every
 * handler re-verifies the entity against it and :id lookups 404 across tenants.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission, requireAnyPermission } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/statutoryRegistrations.controller');

router.use(protect);

router.get('/', requireAnyPermission(['canViewPayrollReports', 'canManageStatutory']), c.list);

router.post('/', requirePermission('canManageStatutory'), c.create);
router.patch('/:id', requirePermission('canManageStatutory'), c.update);
// Soft-delete: the row is the applicability record behind already-generated
// obligations and filed registers.
router.delete('/:id', requirePermission('canManageStatutory'), c.remove);

module.exports = router;
