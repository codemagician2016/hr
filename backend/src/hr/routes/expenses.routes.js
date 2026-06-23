'use strict';

/**
 * expenses.routes.js — Feature 11 operator surface for Reimbursement/Claims + Travel.
 *
 * Promoted from the single legacy controller to the backend/src/hr/expenses/ module.
 * The big RBAC fix: approve/reject/return/reimburse move OFF the bare
 * `canManageEmployees` gate onto the scoped `canApproveExpense` key (Finance + Manager,
 * TEAM-scoped + SoD via the F1 chokepoint); the policy builder + category CRUD move onto
 * `canManageExpensePolicy`. Every claim/trip read is F1-scoped inside the controller.
 *
 * The legacy operator-side create/update/submit/cancel of a claim (canManageEmployees,
 * via controllers/expenses.controller — already engine-wired in F10 slice 10c) is kept
 * for back-compat; the new module owns the scoped reads + the configurable approve chain
 * + the policy builder + the travel surface.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');

const legacy = require('../controllers/expenses.controller');   // create/update/submit/cancel (engine-wired)
const claims = require('../expenses/claims.controller');        // scoped reads + decide + reimburse + inbox
const trips = require('../expenses/trips.controller');          // travel reads + pre-trip approve/reject
const policy = require('../expenses/policy.controller');        // policy builder + city tiers + preview
const categories = require('../expenses/categories.controller'); // category + per-category policy CRUD

router.use(protect);

// ── Travel & Expense Policy builder (canManageExpensePolicy) ─────────────────────
router.get('/policies', requirePermission('canManageExpensePolicy'), policy.listPolicies);
router.post('/policies', requirePermission('canManageExpensePolicy'), policy.createPolicy);
router.post('/policies/preview', requirePermission('canManageExpensePolicy'), policy.preview);
router.get('/policies/:id', requirePermission('canManageExpensePolicy'), policy.getPolicy);
router.patch('/policies/:id', requirePermission('canManageExpensePolicy'), policy.updatePolicy);
router.delete('/policies/:id', requirePermission('canManageExpensePolicy'), policy.removePolicy);
router.put('/policies/:id/perdiem', requirePermission('canManageExpensePolicy'), policy.replacePerDiem);
router.put('/policies/:id/hotel', requirePermission('canManageExpensePolicy'), policy.replaceHotel);
router.put('/policies/:id/transport', requirePermission('canManageExpensePolicy'), policy.replaceTransport);

// ── City tiers (canManageExpensePolicy) ──────────────────────────────────────────
router.get('/city-tiers', requirePermission('canManageExpensePolicy'), policy.listCityTiers);
router.post('/city-tiers', requirePermission('canManageExpensePolicy'), policy.upsertCityTier);
router.post('/city-tiers/bulk', requirePermission('canManageExpensePolicy'), policy.bulkUpsertCityTiers);
router.delete('/city-tiers/:id', requirePermission('canManageExpensePolicy'), policy.removeCityTier);

// ── Categories + per-category policy (canManageExpensePolicy) ─────────────────────
router.get('/categories', requirePermission('canViewEmployees'), categories.listCategories);
router.post('/categories', requirePermission('canManageExpensePolicy'), categories.createCategory);
router.patch('/categories/:id', requirePermission('canManageExpensePolicy'), categories.updateCategory);
router.delete('/categories/:id', requirePermission('canManageExpensePolicy'), categories.removeCategory);
router.put('/categories/:id/policy', requirePermission('canManageExpensePolicy'), categories.upsertCategoryPolicy);

// ── Approver inbox (canApproveExpense — scoped) ──────────────────────────────────
router.get('/inbox', requirePermission('canApproveExpense'), claims.inbox);

// ── Claims (scoped reads + the configurable approval chain) ───────────────────────
router.get('/claims', requirePermission('canViewEmployees'), claims.list);
router.get('/claims/:id', requirePermission('canViewEmployees'), claims.get);
// Operator create/update/submit/cancel stay on the legacy (engine-wired) controller.
router.post('/claims', requirePermission('canManageEmployees'), legacy.create);
router.patch('/claims/:id', requirePermission('canManageEmployees'), legacy.update);
router.post('/claims/:id/submit', requirePermission('canManageEmployees'), legacy.submit);
router.post('/claims/:id/cancel', requirePermission('canManageEmployees'), legacy.cancel);
// Decisions move onto the scoped canApproveExpense key (Finance + Manager, SoD).
router.post('/claims/:id/approve', requirePermission('canApproveExpense'), claims.approve);
router.post('/claims/:id/reject', requirePermission('canApproveExpense'), claims.reject);
router.post('/claims/:id/return', requirePermission('canApproveExpense'), claims.returnForChanges);
router.post('/claims/:id/reimburse', requirePermission('canApproveExpense'), claims.reimburse);

// ── Trips / travel requests (scoped reads + pre-trip approval) ────────────────────
router.get('/trips', requirePermission('canViewEmployees'), trips.list);
router.get('/trips/:id', requirePermission('canViewEmployees'), trips.get);
router.post('/trips/:id/approve', requirePermission('canApproveExpense'), trips.approve);
router.post('/trips/:id/reject', requirePermission('canApproveExpense'), trips.reject);

module.exports = router;
