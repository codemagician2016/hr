'use strict';

// Feature 17 — CTC Policy builder routes. Mounted at /api/hr/ctc-policies. A CTC
// policy is a reusable, CTC-AGNOSTIC salary template (rules only, no person money),
// so READS need canViewCompensation and WRITES need canManageCompensation — but NO
// per-employee scope/masking applies (a sample CTC is not anyone's pay). countryCode
// is server-stamped from the tenant in the controller (single-country invariant).
const express = require('express');

const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const { attachSelfEmployee } = require('../middleware/scope.middleware');
const c = require('../controllers/ctcPolicy.controller');

router.use(protect);
router.use(attachSelfEmployee);

// Reads (list/get/defaults/preview/statement) — canViewCompensation. The starter
// India template + the pure preview/statement carry no person money.
router.get('/', requirePermission('canViewCompensation'), c.list);
router.get('/defaults', requirePermission('canViewCompensation'), c.defaults);
// Ad-hoc preview of an UNSAVED builder draft (body.lines) — keep it BEFORE /:id so
// the literal path is not swallowed by the :id param.
router.post('/preview', requirePermission('canViewCompensation'), c.preview);
router.get('/:id', requirePermission('canViewCompensation'), c.get);
router.post('/:id/preview', requirePermission('canViewCompensation'), c.preview);
router.post('/:id/statement.pdf', requirePermission('canViewCompensation'), c.statementPdf);

// Writes — canManageCompensation. No maker-checker (policies are templates, not pay).
router.post('/', requirePermission('canManageCompensation'), c.create);
router.patch('/:id', requirePermission('canManageCompensation'), c.update);
router.delete('/:id', requirePermission('canManageCompensation'), c.remove);
// Feature 42 — CTC lock: maker may freeze; only the comp APPROVER may unfreeze
// (SoD: the maker who locked an agreed structure can't silently unlock it).
router.post('/:id/lock', requirePermission('canManageCompensation'), c.lock);
router.post('/:id/unlock', requirePermission('canApproveCompensation'), c.unlock);

module.exports = router;
