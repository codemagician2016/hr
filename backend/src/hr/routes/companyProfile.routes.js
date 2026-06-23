'use strict';

// Company Profile settings (HR) — mounted at /api/hr/company-profile.
// Tenant-scoped (req.user.businessId) + gated on canManageCompanyProfile. The
// business profile, the OPTIONAL company-document vault, and the auto employee-
// number scheme all live here. Every route is protect + requirePermission; the
// controller never accepts a businessId from the client (tenant is the session's).

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/companyProfile.controller');

router.use(protect);
const gate = requirePermission('canManageCompanyProfile');

// Business profile (India-first legal/registration fields).
router.get('/', gate, c.getCompanyProfile);
router.patch('/', gate, c.updateCompanyProfile);

// Company document vault (optional) — list is paginated; upload validates MIME +
// 10 MB; download/delete are tenant-scoped (foreign-tenant id → 404).
router.get('/documents', gate, c.listDocuments);
router.post('/documents', gate, c.createDocument);
router.get('/documents/:id/download', gate, c.downloadDocument);
router.delete('/documents/:id', gate, c.deleteDocument);

// Auto employee-number scheme (prefix / padding / next-start) + live preview.
router.get('/employee-number', gate, c.getEmployeeNumberScheme);
router.patch('/employee-number', gate, c.updateEmployeeNumberScheme);

module.exports = router;
