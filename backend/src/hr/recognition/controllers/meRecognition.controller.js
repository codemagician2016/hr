'use strict';

/**
 * meRecognition.controller.js — Feature 35 EMPLOYEE (ESS) surface, mounted under
 * /api/hr/me (recognitions / wallet / award-cycles / award-nominations / catalog /
 * redemptions / recognition/leaderboard). CUSTOMER session (req.customer);
 * SELF-ONLY by construction — the subject employee is resolved ENTIRELY from the
 * session (workEmail/personalEmail/linked User); a body/query employeeId is
 * structurally ignored. Cross-tenant is blocked by businessId on every where.
 * NO permission key — giving/receiving kudos, the wallet, nominating and redeeming
 * are self-scope rights (spec §5), exactly like the news feed. The ESS
 * ACTIVE-STATUS LOCKOUT (same gate as meEngagement/meSurveys) keeps leavers out.
 */

const prisma = require('../../../core/lib/prisma');
const { isEssVisibleStatus, essOrgPolicy } = require('../../lib/orgVisibility');
const recognitionSvc = require('../recognition.service');
const awards = require('../awards.service');
const redemptionSvc = require('../redemption.service');
const leaderboard = require('../leaderboard');
const configLib = require('../config');

// Resolve the session customer's own Employee (mirror of meSurveys.resolveSelf).
async function resolveSelf(businessId, customer) {
  if (!customer || !customer.email) return null;
  const select = { id: true, code: true, firstName: true, lastName: true, status: true, isActive: true, userId: true };
  const byEmail = await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, OR: [{ workEmail: customer.email }, { personalEmail: customer.email }] },
    select,
  });
  if (byEmail) return byEmail;
  return prisma.employee.findFirst({
    where: { businessId, deletedAt: null, user: { is: { email: customer.email } } },
    select,
  });
}

async function withSelf(req, res) {
  const { businessId } = req.customer;
  const employee = await resolveSelf(businessId, req.customer);
  if (!employee) { res.status(404).json({ message: 'No employee record is linked to your account' }); return null; }
  // ESS ACTIVE-STATUS LOCKOUT — an inactive employee can't give/redeem (spec §8).
  if (employee.isActive === false || !isEssVisibleStatus(employee.status, essOrgPolicy(businessId))) {
    res.status(403).json({ message: 'Your account is not active' });
    return null;
  }
  return { businessId, employee };
}

function sendConflict(res, out) {
  return res.status(409).json({ code: out.conflict, message: out.message || 'Conflict' });
}

// ── recognitions ─────────────────────────────────────────────────────────────
// POST /me/recognitions { recipientEmployeeIds[], valueId?, badgeId?, message,
//                         pointsEach?, visibility? }
async function giveRecognition(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const out = await recognitionSvc.give({ businessId: ctx.businessId, giver: ctx.employee, input: req.body || {} });
    if (out.error) return res.status(400).json({ message: out.error });
    if (out.conflict) return sendConflict(res, out);
    return res.status(201).json({
      recognition: out.recognition,
      needsApproval: out.needsApproval,
      ...(out.needsApproval ? { message: 'Your manager will approve the points first' } : {}),
    });
  } catch (e) { return next(e); }
}

// GET /me/recognitions?direction=given|received|all
async function listRecognitions(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { direction, page, pageSize } = req.query || {};
    const out = await recognitionSvc.listForEmployee({
      businessId: ctx.businessId, employeeId: ctx.employee.id, direction: direction || 'all', page, pageSize,
    });
    return res.json(out);
  } catch (e) { return next(e); }
}

// ── wallet ───────────────────────────────────────────────────────────────────
// GET /me/wallet — balance + lifetime + the ₹ shadow when configured.
async function wallet(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const [w, config] = await Promise.all([
      prisma.pointsWallet.findFirst({ where: { businessId: ctx.businessId, employeeId: ctx.employee.id } }),
      configLib.getConfig(ctx.businessId),
    ]);
    const balance = w ? w.balance : 0;
    return res.json({
      pointsEnabled: config.pointsEnabled,
      balance,
      lifetimeEarned: w ? w.lifetimeEarned : 0,
      inrPerPoint: config.inrPerPoint,
      inrValue: config.pointsEnabled && config.inrPerPoint > 0 ? Math.round(balance * config.inrPerPoint) : null,
    });
  } catch (e) { return next(e); }
}

// GET /me/wallet/ledger — the earned/spent timeline (paginated).
async function walletLedger(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const take = Math.max(1, Math.min(100, Number(req.query.pageSize) || 25));
    const page = Math.max(1, Number(req.query.page) || 1);
    const where = { businessId: ctx.businessId, employeeId: ctx.employee.id };
    const [items, total] = await Promise.all([
      prisma.pointsLedgerEntry.findMany({
        where,
        select: { id: true, points: true, reason: true, refType: true, refId: true, note: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * take,
        take,
      }),
      prisma.pointsLedgerEntry.count({ where }),
    ]);
    return res.json({ items, total, page, pageSize: take });
  } catch (e) { return next(e); }
}

// ── awards ───────────────────────────────────────────────────────────────────
// GET /me/award-cycles — cycles currently open for nominations.
async function openAwardCycles(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const items = await awards.listOpenCycles({ businessId: ctx.businessId });
    return res.json({ items });
  } catch (e) { return next(e); }
}

// POST /me/award-nominations { cycleId, nomineeEmployeeId, citation, valueId? }
async function nominate(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const out = await awards.nominate({ businessId: ctx.businessId, nominator: ctx.employee, input: req.body || {} });
    if (out.error) return res.status(400).json({ message: out.error });
    if (out.notFound) return res.status(404).json({ message: 'Award cycle not found' });
    if (out.conflict) return sendConflict(res, out);
    return res.status(201).json({ nomination: out.nomination });
  } catch (e) { return next(e); }
}

// GET /me/award-nominations — nominations I made + awards I won.
async function myNominations(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const out = await awards.listMyNominations({ businessId: ctx.businessId, employeeId: ctx.employee.id });
    return res.json(out);
  } catch (e) { return next(e); }
}

// GET /me/recognition/values — the ACTIVE values + badges for the Give picker.
// (UI-gap fix: the Give modal previously had to harvest options from wall
// items; a fresh tenant with an empty wall got no picker.) Lazy-seeds like the
// admin reads so first use always has the India-first defaults.
async function giveOptions(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { ensureSeeded } = require('../seeds');
    await ensureSeeded(ctx.businessId);
    const [values, badges] = await Promise.all([
      prisma.recognitionValue.findMany({
        where: { businessId: ctx.businessId, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, description: true, icon: true, colorHex: true },
      }),
      prisma.recognitionBadge.findMany({
        where: { businessId: ctx.businessId, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, icon: true, defaultPoints: true, valueId: true },
      }),
    ]);
    return res.json({ values, badges });
  } catch (e) { return next(e); }
}

// ── catalog + redemptions ────────────────────────────────────────────────────
// GET /me/catalog — browse (with affordability against my balance).
async function catalog(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const out = await redemptionSvc.listCatalog({ businessId: ctx.businessId, employeeId: ctx.employee.id });
    return res.json(out);
  } catch (e) { return next(e); }
}

// POST /me/redemptions { catalogItemId }
async function redeem(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const out = await redemptionSvc.redeem({
      businessId: ctx.businessId,
      employee: ctx.employee,
      catalogItemId: (req.body && req.body.catalogItemId) || '',
    });
    if (out.notFound) return res.status(404).json({ message: 'Catalog item not found' });
    if (out.conflict) return sendConflict(res, out);
    return res.status(201).json({ redemption: out.redemption });
  } catch (e) { return next(e); }
}

// GET /me/redemptions — my redemption tracker.
async function myRedemptions(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { page, pageSize } = req.query || {};
    const out = await redemptionSvc.listMine({ businessId: ctx.businessId, employeeId: ctx.employee.id, page, pageSize });
    return res.json(out);
  } catch (e) { return next(e); }
}

// POST /me/redemptions/:id/cancel — own + PENDING only.
async function cancelRedemption(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const out = await redemptionSvc.cancel({ businessId: ctx.businessId, employee: ctx.employee, redemptionId: req.params.id });
    if (out.notFound) return res.status(404).json({ message: 'Redemption not found' });
    if (out.conflict) return sendConflict(res, out);
    return res.json({ ok: true, cancelled: true });
  } catch (e) { return next(e); }
}

// ── leaderboard ──────────────────────────────────────────────────────────────
// GET /me/recognition/leaderboard?period=month|quarter|allTime&board=earners|givers
//   &departmentId=… — the wall leaderboard with the caller's own rank highlighted.
async function essLeaderboard(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { period = 'month', board = 'earners', departmentId } = req.query || {};
    const opts = { businessId: ctx.businessId, period, departmentId: departmentId || null, take: 1000 };
    const rows = board === 'givers'
      ? await leaderboard.giversBoard(prisma, opts)
      : await leaderboard.earnersBoard(prisma, opts);
    const me = rows.find((r) => r.employeeId === ctx.employee.id) || null;
    return res.json({ board: board === 'givers' ? 'givers' : 'earners', period, rows: rows.slice(0, 50), me });
  } catch (e) { return next(e); }
}

module.exports = {
  giveOptions,
  giveRecognition, listRecognitions,
  wallet, walletLedger,
  openAwardCycles, nominate, myNominations,
  catalog, redeem, myRedemptions, cancelRedemption,
  essLeaderboard,
};
