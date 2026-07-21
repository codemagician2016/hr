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
// Feature 45 — per-JOB-LEVEL cap overrides (replace-all, mirrors travel rule PUTs).
router.put('/categories/:id/policy/grade-rules', requirePermission('canManageExpensePolicy'), categories.replaceGradeRules);

// Feature 45 — tenant expense settings: the built-in "HR above threshold"
// escalation amount (was the hard-coded ₹50,000).
router.get('/settings', requirePermission('canManageExpensePolicy'), async (req, res, next) => {
  try {
    const prisma = require('../../core/lib/prisma');
    const { EXPENSE_HR_THRESHOLD } = require('../approvals/workflowResolver');
    const biz = await prisma.business.findUnique({ where: { id: req.user.businessId }, select: { featureFlags: true } });
    const exp = biz && biz.featureFlags && typeof biz.featureFlags === 'object' ? biz.featureFlags.expense : null;
    res.json({
      hrThresholdRupees: exp && Number.isFinite(Number(exp.hrThresholdRupees)) ? Number(exp.hrThresholdRupees) : EXPENSE_HR_THRESHOLD,
      defaultHrThresholdRupees: EXPENSE_HR_THRESHOLD,
    });
  } catch (e) { next(e); }
});
router.patch('/settings', requirePermission('canManageExpensePolicy'), async (req, res, next) => {
  try {
    const prisma = require('../../core/lib/prisma');
    const { writeAudit } = require('../../core/lib/audit');
    const businessId = req.user.businessId;
    const raw = req.body && req.body.hrThresholdRupees;
    const threshold = raw == null || raw === '' ? null : Number(raw);
    if (threshold != null && (!Number.isFinite(threshold) || threshold <= 0)) {
      return res.status(400).json({ message: 'hrThresholdRupees must be a positive number (or null to reset to default)' });
    }
    const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { featureFlags: true } });
    const flags = biz && biz.featureFlags && typeof biz.featureFlags === 'object' ? biz.featureFlags : {};
    const exp = flags.expense && typeof flags.expense === 'object' ? flags.expense : {};
    if (threshold == null) delete exp.hrThresholdRupees; else exp.hrThresholdRupees = threshold;
    await prisma.business.update({ where: { id: businessId }, data: { featureFlags: { ...flags, expense: exp } } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'expense.settings.hrThreshold', entityType: 'Business', entityId: businessId, meta: { hrThresholdRupees: threshold } }).catch(() => {});
    res.json({ hrThresholdRupees: threshold });
  } catch (e) { next(e); }
});

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
// Feature 26 — set/flip the per-claim reimbursement payout channel (PAY_VIA_PAYROLL ↔
// PAY_SEPARATELY). Finance decides the channel (canApproveExpense); 409 once a run has
// stamped the claim or it is in a terminal state (controller guards).
router.patch('/claims/:id/payout-channel', requirePermission('canApproveExpense'), legacy.setPayoutChannel);

// ── Trips / travel requests (scoped reads + pre-trip approval) ────────────────────
router.get('/trips', requirePermission('canViewEmployees'), trips.list);
router.get('/trips/:id', requirePermission('canViewEmployees'), trips.get);
router.post('/trips/:id/approve', requirePermission('canApproveExpense'), trips.approve);
router.post('/trips/:id/reject', requirePermission('canApproveExpense'), trips.reject);

module.exports = router;
