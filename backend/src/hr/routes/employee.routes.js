'use strict';
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/employee.controller');

// All employee routes require an authenticated operator (tenant admin/HR/etc.).
router.use(protect);

router.get('/', requirePermission('canViewEmployees'), c.list);
router.get('/:id', requirePermission('canViewEmployees'), c.get);
router.post('/', requirePermission('canManageEmployees'), c.create);
router.patch('/:id', requirePermission('canManageEmployees'), c.update);
router.post('/:id/terminate', requirePermission('canManageEmployees'), c.terminate);

module.exports = router;
