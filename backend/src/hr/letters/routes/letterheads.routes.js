'use strict';

/**
 * letterheads.routes.js — Letters slice 9C. Mounted at
 * /api/hr/letters/letterheads by the HR route aggregator.
 *
 * These are TENANT-level letters-config endpoints: every route is `protect` +
 * `requirePermission('canManageLetters')` (the config/checker key, §4.4). There
 * is no per-employee F1 scope here — a letterhead belongs to the tenant, not to
 * an employee — but the controller scopes every query by `req.user.businessId`,
 * so a cross-tenant id resolves to 404.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/letterheads.controller');

router.use(protect);
router.use(requirePermission('canManageLetters'));

router.get('/', c.listLetterheads);
router.post('/', c.createLetterhead);
router.get('/:id', c.getLetterhead);
router.put('/:id/layout', c.saveLayout);
router.put('/:id', c.updateLetterhead);
router.delete('/:id', c.deleteLetterhead);

module.exports = router;
