'use strict';

/**
 * form16.routes.js — Feature 24 operator API. Mounted by payroll.routes.js at
 * /api/hr/payroll/form16 + /api/hr/payroll/form24q. India-gated in the service
 * (404 COUNTRY_NOT_SUPPORTED for NZ). `protect` is already applied by the parent
 * payroll router.
 *
 * RBAC (per spec §8 — no new permission):
 *   - create / compute / 24Q-persist     -> canRunPayroll      (maker)
 *   - approve (maker-checker SoD)         -> canApprovePayroll  (checker; SoD in service)
 *   - issue / regenerate                  -> canManageLetters   (the issue path IS the letters engine)
 *   - list / view / register / cert / pdf / 24Q-preview -> canViewPayrollReports (F1-scoped reads)
 * Mutations ride payrollMutationLimiter (reuse).
 */

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../../../core/middleware/auth.middleware');
const { payrollMutationLimiter } = require('../../../core/middleware/abuse.middleware');
const c = require('./form16.controller');

// ── Form 16 batches ──
router.post('/form16/batches', requirePermission('canRunPayroll'), c.createBatch);
router.get('/form16/batches', requirePermission('canViewPayrollReports'), c.listBatches);
router.get('/form16/batches/:id', requirePermission('canViewPayrollReports'), c.getBatch);
router.get('/form16/batches/:id/register', requirePermission('canViewPayrollReports'), c.getRegister);
router.post('/form16/batches/:id/compute', payrollMutationLimiter, requirePermission('canRunPayroll'), c.computeBatch);
router.post('/form16/batches/:id/approve', payrollMutationLimiter, requirePermission('canApprovePayroll'), c.approveBatch);
router.post('/form16/batches/:id/issue', payrollMutationLimiter, requirePermission('canManageLetters'), c.issueBatch);

// ── Form 16 certificates (F1-scoped reads; regenerate = letters engine) ──
router.get('/form16/certificates/:id', requirePermission('canViewPayrollReports'), c.getCertificate);
router.get('/form16/certificates/:id/pdf', requirePermission('canViewPayrollReports'), c.getCertificatePdf);
router.post('/form16/certificates/:id/regenerate', payrollMutationLimiter, requirePermission('canManageLetters'), c.regenerateCertificate);

// ── Form 24Q export ──
router.get('/form24q', requirePermission('canViewPayrollReports'), c.getForm24Q);
router.post('/form24q/persist', payrollMutationLimiter, requirePermission('canRunPayroll'), c.persistForm24Q);

module.exports = router;
