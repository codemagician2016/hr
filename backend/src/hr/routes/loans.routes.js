'use strict';
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/loans.controller');

// All loan routes require an authenticated operator. Reads are gated by
// canViewCompensation; creation, edits and every lifecycle transition require
// canManageCompensation (these are compensation/money operations).
router.use(protect);

// Reads
router.get('/', requirePermission('canViewCompensation'), c.list);
router.get('/employee/:employeeId', requirePermission('canViewCompensation'), c.listByEmployee);
router.get('/:id', requirePermission('canViewCompensation'), c.get);
router.get('/:id/installments', requirePermission('canViewCompensation'), c.listInstallments);

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
