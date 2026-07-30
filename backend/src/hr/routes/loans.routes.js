'use strict';
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');
const c = require('../controllers/loans.controller');

// All loan routes require an authenticated operator. Reads are gated by
// canViewCompensation; creation, edits and every lifecycle transition require
// canManageCompensation (these are compensation/money operations).
router.use(protect);
// Feature 1 hierarchy anchor + reporting-sub-tree scoping on reads. Loans are
// sensitive financial PII; a non-ALL comp role (e.g. a TEAM-band manager granted
// canViewCompensation) must see only its sub-tree's loans — matching how
// compensation revisions and documents are already scoped. For the default
// ALL-band Finance/HR/Owner roles the scope resolves to ALL (a no-op filter).
router.use(attachSelfEmployee);

// Reads
router.get('/', requirePermission('canViewCompensation'), withEmployeeScope('compensation'), c.list);
router.get('/employee/:employeeId', requirePermission('canViewCompensation'), withEmployeeScope('compensation', { idParam: 'employeeId' }), c.listByEmployee);
router.get('/:id', requirePermission('canViewCompensation'), withEmployeeScope('compensation'), c.get);
router.get('/:id/installments', requirePermission('canViewCompensation'), withEmployeeScope('compensation'), c.listInstallments);

// Writes
router.post('/', requirePermission('canManageCompensation'), c.create);
router.patch('/:id', requirePermission('canManageCompensation'), c.update);
router.delete('/:id', requirePermission('canManageCompensation'), c.remove);

// Lifecycle transitions: DRAFT → PENDING → APPROVED → DISBURSED → CLOSED
router.post('/:id/submit', requirePermission('canManageCompensation'), c.submit);
router.post('/:id/approve', requirePermission('canManageCompensation'), c.approve);
router.post('/:id/reject', requirePermission('canManageCompensation'), c.reject);
router.post('/:id/disburse', requirePermission('canManageCompensation'), c.disburse);
router.post('/:id/close', requirePermission('canManageCompensation'), c.close);
router.post('/:id/cancel', requirePermission('canManageCompensation'), c.cancel);

module.exports = router;
