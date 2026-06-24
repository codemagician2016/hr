'use strict';

/**
 * imports.routes.js — Feature 18 Data Migration / Bulk Import API, mounted at
 * /api/hr/imports (see the FLAG in src/hr/routes/index.js).
 *
 * RBAC: every route is canManageImports-gated (admin-only, org-wide). The
 * payroll-autogen side-effect ADDITIONALLY requires canRunPayroll so SoD is not
 * weakened by going through import — the importer who can manage imports still
 * needs the payroll permission to materialise migrated payslips, and a migrated
 * run's approveRun keeps maker≠checker.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('./imports.controller');

router.use(protect);

// Templates + job CRUD + pipeline (all canManageImports).
router.get('/templates/:kind', requirePermission('canManageImports'), c.getTemplate);
router.post('/', requirePermission('canManageImports'), c.upload);
router.get('/', requirePermission('canManageImports'), c.list);
router.get('/:id', requirePermission('canManageImports'), c.get);
router.patch('/:id/mapping', requirePermission('canManageImports'), c.patchMapping);
router.post('/:id/validate', requirePermission('canManageImports'), c.validate);
router.post('/:id/dry-run', requirePermission('canManageImports'), c.dryRun);
router.post('/:id/commit', requirePermission('canManageImports'), c.commit);
// Autogen materialises real payslips through the engine → ALSO needs canRunPayroll.
router.post('/:id/autogen', requirePermission('canManageImports'), requirePermission('canRunPayroll'), c.runAutogen);
router.get('/:id/rows', requirePermission('canManageImports'), c.listRows);
router.get('/:id/report', requirePermission('canManageImports'), c.report);
router.post('/:id/cancel', requirePermission('canManageImports'), c.cancel);

module.exports = router;
