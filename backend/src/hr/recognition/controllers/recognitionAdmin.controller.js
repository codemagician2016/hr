'use strict';

/**
 * recognitionAdmin.controller.js — Feature 35 OPERATOR surface, mounted at
 * /api/hr/recognition. OPERATOR session (req.user); route gates (spec §5):
 *   canManageRecognition — values/badges/budgets/config/catalog/award-cycles/
 *                          points-adjust/reports/seed
 *   canFulfilRedemptions — the redemption queue + fulfil console
 * Tenant isolation: businessId from req.user on every query. Approval ACTS are NOT
 * here — committee/budget/redemption decisions ride the existing F10 inbox.
 */

const prisma = require('../../../core/lib/prisma');
const configLib = require('../config');
const pointsLedger = require('../pointsLedger');
const budgetLib = require('../budget');
const leaderboard = require('../leaderboard');
const awards = require('../awards.service');
const redemption = require('../redemption.service');
const { seedRecognitionDefaults, ensureSeeded } = require('../seeds');
const { notifyHrEvent } = require('../../integrations/notifications');

function bad(res, message) { return res.status(400).json({ message }); }
function conflict(res, out) { return res.status(409).json({ code: out.conflict, message: out.message || 'Conflict' }); }

// ── config ───────────────────────────────────────────────────────────────────
async function getConfig(req, res, next) {
  try {
    const config = await configLib.getConfig(req.user.businessId);
    return res.json({ config });
  } catch (e) { return next(e); }
}

async function patchConfig(req, res, next) {
  try {
    const out = await configLib.updateConfig(req.user.businessId, req.body || {});
    if (out.error) return bad(res, out.error);
    if (out.notFound) return res.status(404).json({ message: 'Business not found' });
    return res.json({ config: out.config });
  } catch (e) { return next(e); }
}

// ── values ───────────────────────────────────────────────────────────────────
async function listValues(req, res, next) {
  try {
    const { businessId } = req.user;
    await ensureSeeded(businessId); // lazy first-use seeding (documented in seeds.js)
    const items = await prisma.recognitionValue.findMany({
      where: { businessId, ...(req.query.includeInactive === 'true' ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return res.json({ items });
  } catch (e) { return next(e); }
}

async function createValue(req, res, next) {
  try {
    const { businessId } = req.user;
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return bad(res, 'name is required');
    try {
      const value = await prisma.recognitionValue.create({
        data: {
          businessId,
          name: String(b.name).trim().slice(0, 120),
          description: b.description ? String(b.description).slice(0, 500) : null,
          icon: b.icon ? String(b.icon).slice(0, 40) : null,
          colorHex: b.colorHex ? String(b.colorHex).slice(0, 12) : null,
          sortOrder: Number.isInteger(b.sortOrder) ? b.sortOrder : 0,
        },
      });
      return res.status(201).json({ value });
    } catch (e) {
      if (e && e.code === 'P2002') return res.status(409).json({ code: 'DUPLICATE', message: 'A value with this name already exists' });
      throw e;
    }
  } catch (e) { return next(e); }
}

async function updateValue(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.recognitionValue.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Value not found' });
    const b = req.body || {};
    const data = {};
    if (b.name != null) data.name = String(b.name).trim().slice(0, 120);
    if (b.description !== undefined) data.description = b.description ? String(b.description).slice(0, 500) : null;
    if (b.icon !== undefined) data.icon = b.icon ? String(b.icon).slice(0, 40) : null;
    if (b.colorHex !== undefined) data.colorHex = b.colorHex ? String(b.colorHex).slice(0, 12) : null;
    if (b.sortOrder != null && Number.isInteger(b.sortOrder)) data.sortOrder = b.sortOrder;
    if (b.isActive != null) data.isActive = !!b.isActive; // retire (not delete) — history intact
    try {
      const value = await prisma.recognitionValue.update({ where: { id: existing.id }, data });
      return res.json({ value });
    } catch (e) {
      if (e && e.code === 'P2002') return res.status(409).json({ code: 'DUPLICATE', message: 'A value with this name already exists' });
      throw e;
    }
  } catch (e) { return next(e); }
}

// ── badges ───────────────────────────────────────────────────────────────────
async function listBadges(req, res, next) {
  try {
    const { businessId } = req.user;
    const items = await prisma.recognitionBadge.findMany({
      where: { businessId, ...(req.query.includeInactive === 'true' ? {} : { isActive: true }) },
      include: { value: { select: { id: true, name: true } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return res.json({ items });
  } catch (e) { return next(e); }
}

async function createBadge(req, res, next) {
  try {
    const { businessId } = req.user;
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return bad(res, 'name is required');
    if (b.defaultPoints != null && (!Number.isInteger(b.defaultPoints) || b.defaultPoints < 0)) {
      return bad(res, 'defaultPoints must be a non-negative integer');
    }
    let valueId = null;
    if (b.valueId) {
      const v = await prisma.recognitionValue.findFirst({ where: { id: String(b.valueId), businessId }, select: { id: true } });
      if (!v) return bad(res, 'Unknown valueId');
      valueId = v.id;
    }
    try {
      const badge = await prisma.recognitionBadge.create({
        data: {
          businessId,
          name: String(b.name).trim().slice(0, 120),
          icon: b.icon ? String(b.icon).slice(0, 40) : null,
          defaultPoints: Number.isInteger(b.defaultPoints) ? b.defaultPoints : 0,
          valueId,
          sortOrder: Number.isInteger(b.sortOrder) ? b.sortOrder : 0,
        },
      });
      return res.status(201).json({ badge });
    } catch (e) {
      if (e && e.code === 'P2002') return res.status(409).json({ code: 'DUPLICATE', message: 'A badge with this name already exists' });
      throw e;
    }
  } catch (e) { return next(e); }
}

async function updateBadge(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.recognitionBadge.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Badge not found' });
    const b = req.body || {};
    const data = {};
    if (b.name != null) data.name = String(b.name).trim().slice(0, 120);
    if (b.icon !== undefined) data.icon = b.icon ? String(b.icon).slice(0, 40) : null;
    if (b.defaultPoints != null) {
      if (!Number.isInteger(b.defaultPoints) || b.defaultPoints < 0) return bad(res, 'defaultPoints must be a non-negative integer');
      data.defaultPoints = b.defaultPoints;
    }
    if (b.valueId !== undefined) {
      if (b.valueId) {
        const v = await prisma.recognitionValue.findFirst({ where: { id: String(b.valueId), businessId }, select: { id: true } });
        if (!v) return bad(res, 'Unknown valueId');
        data.valueId = v.id;
      } else data.valueId = null;
    }
    if (b.sortOrder != null && Number.isInteger(b.sortOrder)) data.sortOrder = b.sortOrder;
    if (b.isActive != null) data.isActive = !!b.isActive;
    try {
      const badge = await prisma.recognitionBadge.update({ where: { id: existing.id }, data });
      return res.json({ badge });
    } catch (e) {
      if (e && e.code === 'P2002') return res.status(409).json({ code: 'DUPLICATE', message: 'A badge with this name already exists' });
      throw e;
    }
  } catch (e) { return next(e); }
}

// ── budgets ──────────────────────────────────────────────────────────────────
const BUDGET_SCOPES = new Set(['GIVER', 'DEPARTMENT', 'ENTITY', 'TENANT']);
const BUDGET_PERIODS = new Set(['MONTHLY', 'QUARTERLY', 'YEARLY']);

async function listBudgets(req, res, next) {
  try {
    const { businessId } = req.user;
    const items = await prisma.recognitionBudget.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
    });
    // Live "consumed vs allocated" per budget (derived — spec §3.4).
    const withUsage = [];
    for (const b of items) {
      let consumed = 0;
      try {
        consumed = await budgetLib.consumedPoints(prisma, {
          businessId,
          budget: b,
          departmentEmployeeIds: undefined,
          entityEmployeeIds: undefined,
        });
        if (b.scope === 'DEPARTMENT' || b.scope === 'ENTITY') {
          const recs = await prisma.employmentRecord.findMany({
            where: {
              businessId, isCurrent: true,
              ...(b.scope === 'DEPARTMENT' ? { departmentId: b.scopeRefId } : { entityId: b.scopeRefId }),
            },
            select: { employeeId: true },
          });
          const ids = [...new Set(recs.map((r) => r.employeeId))];
          consumed = await budgetLib.consumedPoints(prisma, {
            businessId, budget: b,
            departmentEmployeeIds: b.scope === 'DEPARTMENT' ? ids : undefined,
            entityEmployeeIds: b.scope === 'ENTITY' ? ids : undefined,
          });
        }
      } catch (_e) { /* usage is decorative — keep the row */ }
      withUsage.push({ ...b, consumedPoints: consumed, remainingPoints: Math.max(0, b.allocatedPoints - consumed) });
    }
    return res.json({ items: withUsage });
  } catch (e) { return next(e); }
}

async function createBudget(req, res, next) {
  try {
    const { businessId } = req.user;
    const b = req.body || {};
    const scope = BUDGET_SCOPES.has(b.scope) ? b.scope : 'GIVER';
    if (scope !== 'TENANT' && !(b.scopeRefId && typeof b.scopeRefId === 'string')) {
      return bad(res, `${scope} budgets require scopeRefId`);
    }
    if (!Number.isInteger(b.allocatedPoints) || b.allocatedPoints < 0) {
      return bad(res, 'allocatedPoints must be a non-negative integer');
    }
    const budget = await prisma.recognitionBudget.create({
      data: {
        businessId,
        scope,
        scopeRefId: scope === 'TENANT' ? null : b.scopeRefId,
        periodType: BUDGET_PERIODS.has(b.periodType) ? b.periodType : 'MONTHLY',
        allocatedPoints: b.allocatedPoints,
      },
    });
    return res.status(201).json({ budget });
  } catch (e) { return next(e); }
}

async function updateBudget(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.recognitionBudget.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Budget not found' });
    const b = req.body || {};
    const data = {};
    if (b.allocatedPoints != null) {
      if (!Number.isInteger(b.allocatedPoints) || b.allocatedPoints < 0) return bad(res, 'allocatedPoints must be a non-negative integer');
      data.allocatedPoints = b.allocatedPoints;
    }
    if (b.periodType != null) {
      if (!BUDGET_PERIODS.has(b.periodType)) return bad(res, 'Unknown periodType');
      data.periodType = b.periodType;
    }
    if (b.isActive != null) data.isActive = !!b.isActive;
    const budget = await prisma.recognitionBudget.update({ where: { id: existing.id }, data });
    return res.json({ budget });
  } catch (e) { return next(e); }
}

// ── catalog ──────────────────────────────────────────────────────────────────
const CATALOG_CATEGORIES = new Set(['VOUCHER', 'PERK', 'SWAG', 'COMP_OFF', 'WFH', 'CHARITY', 'DONATION']);
const FULFILMENT_TYPES = new Set(['MANUAL', 'VOUCHER_CODE', 'COMP_OFF_GRANT']);

async function listCatalog(req, res, next) {
  try {
    const { businessId } = req.user;
    await ensureSeeded(businessId);
    const items = await prisma.catalogItem.findMany({
      where: { businessId, ...(req.query.includeInactive === 'true' ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return res.json({ items });
  } catch (e) { return next(e); }
}

function catalogData(b, { partial = false } = {}) {
  if (!partial) {
    if (!b.name || !String(b.name).trim()) return { error: 'name is required' };
    if (!Number.isInteger(b.pointsCost) || b.pointsCost < 1) return { error: 'pointsCost must be a positive integer' };
  }
  const data = {};
  if (b.name != null) data.name = String(b.name).trim().slice(0, 200);
  if (b.description !== undefined) data.description = b.description ? String(b.description).slice(0, 1000) : null;
  if (b.category != null) {
    if (!CATALOG_CATEGORIES.has(b.category)) return { error: 'Unknown category' };
    data.category = b.category;
  }
  if (b.pointsCost != null) {
    if (!Number.isInteger(b.pointsCost) || b.pointsCost < 1) return { error: 'pointsCost must be a positive integer' };
    data.pointsCost = b.pointsCost;
  }
  if (b.inrValue !== undefined) {
    if (b.inrValue != null && (!Number.isInteger(b.inrValue) || b.inrValue < 0)) return { error: 'inrValue must be a non-negative integer or null' };
    data.inrValue = b.inrValue == null ? null : b.inrValue;
  }
  if (b.stock !== undefined) {
    if (b.stock != null && (!Number.isInteger(b.stock) || b.stock < 0)) return { error: 'stock must be a non-negative integer or null (unlimited)' };
    data.stock = b.stock == null ? null : b.stock;
  }
  if (b.fulfilmentType != null) {
    if (!FULFILMENT_TYPES.has(b.fulfilmentType)) return { error: 'Unknown fulfilmentType' };
    data.fulfilmentType = b.fulfilmentType;
  }
  if (b.isTaxablePerk != null) data.isTaxablePerk = !!b.isTaxablePerk;
  if (b.isActive != null) data.isActive = !!b.isActive;
  if (b.imageUrl !== undefined) data.imageUrl = b.imageUrl ? String(b.imageUrl).slice(0, 1000) : null;
  if (b.sortOrder != null && Number.isInteger(b.sortOrder)) data.sortOrder = b.sortOrder;
  return { data };
}

async function createCatalogItem(req, res, next) {
  try {
    const { businessId } = req.user;
    const out = catalogData(req.body || {});
    if (out.error) return bad(res, out.error);
    const item = await prisma.catalogItem.create({ data: { businessId, ...out.data } });
    return res.status(201).json({ item });
  } catch (e) { return next(e); }
}

async function updateCatalogItem(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.catalogItem.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Catalog item not found' });
    const out = catalogData(req.body || {}, { partial: true });
    if (out.error) return bad(res, out.error);
    const item = await prisma.catalogItem.update({ where: { id: existing.id }, data: out.data });
    return res.json({ item });
  } catch (e) { return next(e); }
}

// ── award cycles ─────────────────────────────────────────────────────────────
async function listCycles(req, res, next) {
  try {
    const out = await awards.adminListCycles({ businessId: req.user.businessId, ...req.query });
    return res.json(out);
  } catch (e) { return next(e); }
}

async function getCycle(req, res, next) {
  try {
    const out = await awards.getCycle({ businessId: req.user.businessId, id: req.params.id });
    if (out.notFound) return res.status(404).json({ message: 'Award cycle not found' });
    return res.json({ cycle: out.cycle });
  } catch (e) { return next(e); }
}

async function createCycle(req, res, next) {
  try {
    const out = await awards.createCycle({ businessId: req.user.businessId, actorUserId: req.user.id, input: req.body || {} });
    if (out.error) return bad(res, out.error);
    return res.status(201).json({ cycle: out.cycle });
  } catch (e) { return next(e); }
}

async function updateCycle(req, res, next) {
  try {
    const out = await awards.updateCycle({ businessId: req.user.businessId, id: req.params.id, input: req.body || {} });
    if (out.notFound) return res.status(404).json({ message: 'Award cycle not found' });
    if (out.conflict) return conflict(res, out);
    if (out.error) return bad(res, out.error);
    return res.json({ cycle: out.cycle });
  } catch (e) { return next(e); }
}

async function closeCycle(req, res, next) {
  try {
    const out = await awards.closeCycle({ businessId: req.user.businessId, id: req.params.id });
    if (out.notFound) return res.status(404).json({ message: 'Award cycle not found' });
    if (out.conflict) return conflict(res, out);
    return res.json({ ok: true, closed: true });
  } catch (e) { return next(e); }
}

async function shortlist(req, res, next) {
  try {
    const on = !(req.body && req.body.shortlisted === false);
    const out = await awards.shortlistNomination({
      businessId: req.user.businessId,
      cycleId: req.params.id,
      nominationId: req.params.nominationId,
      on,
    });
    if (out.notFound) return res.status(404).json({ message: 'Nomination not found' });
    if (out.conflict) return conflict(res, out);
    return res.json({ ok: true, shortlisted: out.shortlisted });
  } catch (e) { return next(e); }
}

async function decideCycle(req, res, next) {
  try {
    const out = await awards.decideCycle({
      businessId: req.user.businessId,
      actorUserId: req.user.id,
      id: req.params.id,
      nominationIds: (req.body && req.body.nominationIds) || undefined,
    });
    if (out.notFound) return res.status(404).json({ message: 'Award cycle not found' });
    if (out.conflict) return conflict(res, out);
    if (out.error) return bad(res, out.error);
    return res.json({ ok: true, opened: out.opened });
  } catch (e) { return next(e); }
}

// ── redemption queue + fulfil (canFulfilRedemptions) ─────────────────────────
async function redemptionQueue(req, res, next) {
  try {
    const out = await redemption.adminQueue({ businessId: req.user.businessId, ...req.query });
    return res.json(out);
  } catch (e) { return next(e); }
}

async function fulfilRedemption(req, res, next) {
  try {
    const out = await redemption.fulfil({
      businessId: req.user.businessId,
      actorUserId: req.user.id,
      redemptionId: req.params.id,
      fulfilmentRef: (req.body && req.body.fulfilmentRef) || null,
    });
    if (out.notFound) return res.status(404).json({ message: 'Redemption not found' });
    if (out.conflict) return conflict(res, out);
    if (out.error) return bad(res, out.error);
    return res.json({ redemption: out.redemption });
  } catch (e) { return next(e); }
}

// ── manual points adjust (audited ADJUSTMENT ledger row) ─────────────────────
async function adjustPoints(req, res, next) {
  try {
    const { businessId } = req.user;
    const b = req.body || {};
    const points = Number(b.points);
    if (!b.employeeId || typeof b.employeeId !== 'string') return bad(res, 'employeeId is required');
    if (!Number.isInteger(points) || points === 0) return bad(res, 'points must be a non-zero integer (+grant / -clawback)');
    const employee = await prisma.employee.findFirst({
      where: { id: b.employeeId, businessId, deletedAt: null },
      select: { id: true, firstName: true, workEmail: true, personalEmail: true },
    });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });
    try {
      const result = await prisma.$transaction(async (tx) => {
        const args = {
          businessId,
          employeeId: employee.id,
          points: Math.abs(points),
          reason: 'ADJUSTMENT',
          note: b.note ? String(b.note).slice(0, 500) : null,
          createdByUserId: req.user.id,
        };
        return points > 0 ? pointsLedger.credit(tx, args) : pointsLedger.debit(tx, args);
      });
      if (points > 0) {
        const email = employee.workEmail || employee.personalEmail || null;
        if (email) {
          notifyHrEvent({
            businessId,
            event: 'recognition.points-posted',
            recipientEmail: email,
            variables: {
              NAME: employee.firstName || 'there',
              POINTS: String(points),
              REASON: 'HR adjustment',
              BALANCE: String(result.wallet.balance),
              LINK: '/wallet',
              BIZ: '',
            },
            triggeredBy: `HR_RNR_ADJUST:${result.entry.id}`,
          }).catch(() => {});
        }
      }
      return res.json({ entry: result.entry, balance: result.wallet.balance });
    } catch (e) {
      if (e && e.code === 'INSUFFICIENT_POINTS') return res.status(409).json({ code: e.code, message: e.message });
      throw e;
    }
  } catch (e) { return next(e); }
}

// ── reports ──────────────────────────────────────────────────────────────────
async function reportLeaderboard(req, res, next) {
  try {
    const { businessId } = req.user;
    const { board = 'earners', period = 'month', departmentId, take } = req.query || {};
    const opts = { businessId, period, departmentId: departmentId || null, take: Math.min(100, Number(take) || 50) };
    let rows;
    if (board === 'givers') rows = await leaderboard.giversBoard(prisma, opts);
    else if (board === 'values') rows = await leaderboard.valuesBoard(prisma, { businessId, period, take: opts.take });
    else rows = await leaderboard.earnersBoard(prisma, opts);
    return res.json({ board, period, rows });
  } catch (e) { return next(e); }
}

async function reportTaxablePerks(req, res, next) {
  try {
    const out = await redemption.taxablePerksReport({ businessId: req.user.businessId });
    return res.json(out);
  } catch (e) { return next(e); }
}

// ── seed defaults (explicit; also runs lazily on first values/catalog read) ──
async function seedDefaults(req, res, next) {
  try {
    const out = await seedRecognitionDefaults(req.user.businessId);
    return res.json({ ok: true, seeded: out });
  } catch (e) { return next(e); }
}

module.exports = {
  getConfig, patchConfig,
  listValues, createValue, updateValue,
  listBadges, createBadge, updateBadge,
  listBudgets, createBudget, updateBudget,
  listCatalog, createCatalogItem, updateCatalogItem,
  listCycles, getCycle, createCycle, updateCycle, closeCycle, shortlist, decideCycle,
  redemptionQueue, fulfilRedemption,
  adjustPoints,
  reportLeaderboard, reportTaxablePerks,
  seedDefaults,
};
