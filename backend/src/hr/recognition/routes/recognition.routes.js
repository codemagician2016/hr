'use strict';

/**
 * recognition.routes.js — Feature 35 operator API, mounted at /api/hr/recognition.
 * OPERATOR session; gates per spec §5:
 *   canManageRecognition — values / badges / budgets / config / catalog /
 *                          award-cycles / points adjust / reports / seed
 *   canFulfilRedemptions — the redemption queue + fulfil console (separable so an
 *                          Office-Admin/Engagement role can hold ONLY fulfilment)
 * Approval acts (budget / committee / redemption decisions) ride the EXISTING F10
 * inbox (/api/hr/approvals + /api/hr/me/approvals) — no new approval endpoints.
 */

const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/recognitionAdmin.controller');

router.use(protect);

const manage = requirePermission('canManageRecognition');
const fulfil = requirePermission('canFulfilRedemptions');

// Config (program switches)
router.get('/config', manage, c.getConfig);
router.patch('/config', manage, c.patchConfig);

// Values & badges (retire via PATCH isActive:false — never hard-delete history)
router.get('/values', manage, c.listValues);
router.post('/values', manage, c.createValue);
router.patch('/values/:id', manage, c.updateValue);
router.get('/badges', manage, c.listBadges);
router.post('/badges', manage, c.createBadge);
router.patch('/badges/:id', manage, c.updateBadge);

// Budgets (consumed-vs-allocated derived live)
router.get('/budgets', manage, c.listBudgets);
router.post('/budgets', manage, c.createBudget);
router.patch('/budgets/:id', manage, c.updateBudget);

// Catalog
router.get('/catalog', manage, c.listCatalog);
router.post('/catalog', manage, c.createCatalogItem);
router.patch('/catalog/:id', manage, c.updateCatalogItem);

// Award cycles + committee decide (static sub-paths BEFORE the bare /:id)
router.get('/award-cycles', manage, c.listCycles);
router.post('/award-cycles', manage, c.createCycle);
router.post('/award-cycles/:id/close', manage, c.closeCycle);
router.post('/award-cycles/:id/nominations/:nominationId/shortlist', manage, c.shortlist);
router.post('/award-cycles/:id/decide', manage, c.decideCycle);
router.get('/award-cycles/:id', manage, c.getCycle);
router.patch('/award-cycles/:id', manage, c.updateCycle);

// Redemption fulfilment console
router.get('/redemptions', fulfil, c.redemptionQueue);
router.post('/redemptions/:id/fulfil', fulfil, c.fulfilRedemption);

// Manual grant/clawback (audited ADJUSTMENT ledger row)
router.post('/points/adjust', manage, c.adjustPoints);

// Reports
router.get('/reports/leaderboard', manage, c.reportLeaderboard);
router.get('/reports/taxable-perks', manage, c.reportTaxablePerks);

// Idempotent defaults seed (values / badges / catalog / award-cert template)
router.post('/seed-defaults', manage, c.seedDefaults);

module.exports = router;
