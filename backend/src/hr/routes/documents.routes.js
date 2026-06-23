'use strict';

/**
 * documents.routes.js — Employee documents + document requests. Mounted at
 * /api/hr/documents.
 *
 * Rewritten for Feature 4 slice 4d: the controller now targets the REAL
 * EmployeeDocument / DocumentRequest models (schema L8467 / L8584), and every
 * per-employee route is FEATURE-1 SCOPED via `attachSelfEmployee` +
 * `withEmployeeScope(action, { idParam:'employeeId' })`, so a manager hitting an
 * out-of-team employee resolves to 404 (IDOR-safe), matching the F1 chokepoint.
 *
 * RBAC: reading requires canViewEmployees; uploading/verifying/editing/deleting
 * requires canManageEmployees. The visibility filter (HR_ONLY excluded from the
 * manager view) is applied in the controller off req.scope.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee, withEmployeeScope } = require('../middleware/scope.middleware');
const c = require('../controllers/documents.controller');

// All document routes require an authenticated operator + the F1 hierarchy anchor.
router.use(protect);
router.use(attachSelfEmployee);

// Tenant-wide "documents needing attention" report (expired / expiring soon). HR.
router.get('/expiring', requirePermission('canViewEmployees'), c.expiringDocuments);

// ---- EmployeeDocument (per employee, F1-scoped on :employeeId) -------------
router.get('/employees/:employeeId/documents',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees', { idParam: 'employeeId' }),
  c.listDocuments);

router.get('/employees/:employeeId/documents/:id',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees', { idParam: 'employeeId' }),
  c.getDocument);

router.post('/employees/:employeeId/documents',
  requirePermission('canManageEmployees'),
  withEmployeeScope('canManageEmployees', { idParam: 'employeeId' }),
  c.createDocument);

router.post('/employees/:employeeId/documents/:id/verify',
  requirePermission('canManageEmployees'),
  withEmployeeScope('canManageEmployees', { idParam: 'employeeId' }),
  c.verifyDocument);

router.patch('/employees/:employeeId/documents/:id',
  requirePermission('canManageEmployees'),
  withEmployeeScope('canManageEmployees', { idParam: 'employeeId' }),
  c.updateDocument);

router.delete('/employees/:employeeId/documents/:id',
  requirePermission('canManageEmployees'),
  withEmployeeScope('canManageEmployees', { idParam: 'employeeId' }),
  c.removeDocument);

// ---- DocumentRequest (per employee, F1-scoped) ----------------------------
router.get('/employees/:employeeId/requests',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees', { idParam: 'employeeId' }),
  c.listRequests);

router.get('/employees/:employeeId/requests/:id',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees', { idParam: 'employeeId' }),
  c.getRequest);

router.post('/employees/:employeeId/requests',
  requirePermission('canViewEmployees'),
  withEmployeeScope('canViewEmployees', { idParam: 'employeeId' }),
  c.createRequest);

router.post('/employees/:employeeId/requests/:id/cancel',
  requirePermission('canManageEmployees'),
  withEmployeeScope('canManageEmployees', { idParam: 'employeeId' }),
  c.cancelRequest);

module.exports = router;
