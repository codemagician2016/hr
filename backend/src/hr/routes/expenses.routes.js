'use strict';
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/expenses.controller');

// All expense routes require an authenticated operator. Viewing employees/claims
// needs canViewEmployees; raising/editing/submitting a claim and the
// approve/reject/reimburse workflow actions need canManageEmployees.
router.use(protect);

// ── Expense categories (reference data) ──────────────────────────────────────
router.get('/categories', requirePermission('canViewEmployees'), c.listCategories);
router.post('/categories', requirePermission('canManageEmployees'), c.createCategory);
router.patch('/categories/:id', requirePermission('canManageEmployees'), c.updateCategory);
router.delete('/categories/:id', requirePermission('canManageEmployees'), c.removeCategory);

// ── Claims ───────────────────────────────────────────────────────────────────
router.get('/claims', requirePermission('canViewEmployees'), c.list);
router.get('/claims/:id', requirePermission('canViewEmployees'), c.get);
router.post('/claims', requirePermission('canManageEmployees'), c.create);
router.patch('/claims/:id', requirePermission('canManageEmployees'), c.update);

// Workflow actions (DRAFT → SUBMITTED → APPROVED/REJECTED → REIMBURSED).
router.post('/claims/:id/submit', requirePermission('canManageEmployees'), c.submit);
router.post('/claims/:id/approve', requirePermission('canManageEmployees'), c.approve);
router.post('/claims/:id/reject', requirePermission('canManageEmployees'), c.reject);
router.post('/claims/:id/reimburse', requirePermission('canManageEmployees'), c.reimburse);
router.post('/claims/:id/cancel', requirePermission('canManageEmployees'), c.cancel);

module.exports = router;
