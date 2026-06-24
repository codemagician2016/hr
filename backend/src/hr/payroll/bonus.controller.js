'use strict';

/**
 * bonus.controller.js — thin HTTP layer over bonus.service.js (Feature 22).
 * Operator handlers are tenant-scoped by req.user.businessId; the ESS handler is
 * scoped by the self-employee. Controllers carry NO bonus logic — they validate
 * the request shape, call the service, and translate a BonusError into a status.
 */

const prisma = require('../../core/lib/prisma');
const svc = require('./bonus.service');
const service = require('./service'); // ESS self-employee resolution (reused)

function handleError(res, err) {
  const status = err && (err.status || err.statusCode) ? (err.status || err.statusCode) : 500;
  const body = { message: err && err.message ? err.message : 'Internal error' };
  if (err && err.code) body.code = err.code;
  if (status === 500) {
    // eslint-disable-next-line no-console
    console.error('[bonus.controller]', err && err.stack ? err.stack : err);
  }
  return res.status(status).json(body);
}

async function createBonusCycle(req, res) {
  try {
    const { entityId, accountingYear, rateBasisPoints, minWageMonthlyMinor, allocableSurplusMinor, priorSetOnMinor, notes } = req.body || {};
    const out = await svc.createBonusCycle({ businessId: req.user.businessId, actorId: req.user.id, entityId, accountingYear, rateBasisPoints, minWageMonthlyMinor, allocableSurplusMinor, priorSetOnMinor, notes });
    res.status(201).json(out);
  } catch (err) { handleError(res, err); }
}

async function listBonusCycles(req, res) {
  try {
    const { entityId, status, page, pageSize } = req.query || {};
    const out = await svc.listBonusCycles({ businessId: req.user.businessId, entityId, status, page, pageSize });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function getBonusCycle(req, res) {
  try {
    const out = await svc.getBonusCycle({ businessId: req.user.businessId, bonusCycleId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function updateBonusCycle(req, res) {
  try {
    const out = await svc.updateBonusCycle({ businessId: req.user.businessId, actorId: req.user.id, bonusCycleId: req.params.id, ...(req.body || {}) });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function computeBonusCycle(req, res) {
  try {
    const { advances, disqualified } = req.body || {};
    const out = await svc.computeBonusCycle({ businessId: req.user.businessId, actorId: req.user.id, bonusCycleId: req.params.id, advances, disqualified });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function approveBonusCycle(req, res) {
  try {
    const out = await svc.approveBonusCycle({ businessId: req.user.businessId, actorId: req.user.id, bonusCycleId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function publishBonusSlips(req, res) {
  try {
    const out = await svc.publishBonusSlips({ businessId: req.user.businessId, actorId: req.user.id, bonusCycleId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function getFormCRegister(req, res) {
  try {
    const out = await svc.getFormCRegister({ businessId: req.user.businessId, bonusCycleId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

// ESS — the self-employee's bonus awards (PUBLISHED-gated: only APPROVED+ cycles).
async function getMyBonus(req, res) {
  try {
    const { businessId } = req.customer;
    const employeeId = await service.resolveSelfEmployee(businessId, req.customer);
    if (!employeeId) return res.status(404).json({ message: 'No employee profile for this account' });
    const awards = await prisma.bonusAward.findMany({
      where: { businessId, employeeId, bonusCycle: { status: { in: ['APPROVED', 'PAID', 'FILED'] }, deletedAt: null } },
      include: { bonusCycle: { select: { accountingYear: true, rateBasisPoints: true, status: true, dueDate: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const out = awards.map((a) => ({
      accountingYear: a.bonusCycle.accountingYear,
      eligible: a.eligible,
      ineligibleReason: a.ineligibleReason,
      cappedBaseMinor: Number(a.cappedBaseMinor),
      eligibleMonths: Number(a.eligibleMonths),
      rate: `${(a.rateBasisPoints / 100).toFixed(2)}%`,
      grossBonusMinor: Number(a.grossBonusMinor),
      advancePaidMinor: Number(a.advancePaidMinor),
      netBonusMinor: Number(a.netBonusMinor),
      trace: a.computeTrace || null,
    }));
    res.json({ items: out });
  } catch (err) { handleError(res, err); }
}

module.exports = {
  createBonusCycle,
  listBonusCycles,
  getBonusCycle,
  updateBonusCycle,
  computeBonusCycle,
  approveBonusCycle,
  publishBonusSlips,
  getFormCRegister,
  getMyBonus,
};
