'use strict';

/**
 * policy.controller.js — Feature 11. The admin's Travel & Expense Policy builder
 * (canManageExpensePolicy). CRUD a versioned TravelPolicy + bulk-replace its three
 * rule grids (per-diem / hotel-by-level×tier / transport), a CityTier map editor, and
 * a live "what would this trip cost vs policy" preview that runs the PURE policyEngine.
 *
 * Every query is tenant-scoped by req.user.businessId; reads filter deletedAt:null;
 * money stays Prisma Decimal and is passed through untouched (never parsed).
 */

const prisma = require('../../core/lib/prisma');
const service = require('./expenses.service');
const { evaluateLine } = require('./policyEngine');

// ── helpers ──────────────────────────────────────────────────────────────────
function paginate(q) {
  const take = Math.min(Math.max(parseInt(q.pageSize, 10) || 25, 1), 100);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  return { take, skip: (page - 1) * take, page };
}

const POLICY_FIELDS = ['name', 'countryCode', 'currencyCode', 'isActive', 'effectiveFrom', 'defaultTier', 'enforcement', 'entityId'];
function pickPolicy(body) {
  const out = {};
  for (const f of POLICY_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  if (out.effectiveFrom != null) out.effectiveFrom = new Date(out.effectiveFrom);
  return out;
}

async function withRules(policy) {
  return prisma.travelPolicy.findFirst({
    where: { id: policy.id },
    include: { perDiemRules: true, hotelRules: true, transportRules: true },
  });
}

// ── TravelPolicy CRUD ─────────────────────────────────────────────────────────
async function listPolicies(req, res, next) {
  try {
    const { businessId } = req.user;
    const { take, skip, page } = paginate(req.query);
    const where = { businessId, deletedAt: null };
    if (req.query.isActive != null) where.isActive = req.query.isActive === 'true';
    const [items, total] = await Promise.all([
      prisma.travelPolicy.findMany({
        where, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }], skip, take,
        include: { _count: { select: { perDiemRules: true, hotelRules: true, transportRules: true } } },
      }),
      prisma.travelPolicy.count({ where }),
    ]);
    res.json({ items, total, page, pageSize: take });
  } catch (e) { next(e); }
}

async function getPolicy(req, res, next) {
  try {
    const { businessId } = req.user;
    const policy = await prisma.travelPolicy.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: { perDiemRules: true, hotelRules: true, transportRules: true },
    });
    if (!policy) return res.status(404).json({ message: 'Policy not found' });
    res.json(policy);
  } catch (e) { next(e); }
}

async function createPolicy(req, res, next) {
  try {
    const { businessId } = req.user;
    const { name, countryCode, currencyCode } = req.body;
    if (!name || !countryCode || !currencyCode) {
      return res.status(400).json({ message: 'name, countryCode and currencyCode are required' });
    }
    const data = { ...pickPolicy(req.body), businessId };
    if (!data.effectiveFrom) data.effectiveFrom = new Date();
    const policy = await prisma.travelPolicy.create({ data });
    res.status(201).json(await withRules(policy));
  } catch (e) { next(e); }
}

async function updatePolicy(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.travelPolicy.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Policy not found' });
    const policy = await prisma.travelPolicy.update({
      where: { id: req.params.id },
      data: { ...pickPolicy(req.body), version: { increment: 1 } },
    });
    res.json(await withRules(policy));
  } catch (e) { next(e); }
}

async function removePolicy(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.travelPolicy.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Policy not found' });
    await prisma.travelPolicy.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), isActive: false } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// ── bulk-replace a rule grid (the matrix editors save the whole table) ─────────
async function replacePerDiem(req, res, next) {
  try {
    const { businessId } = req.user;
    const policy = await prisma.travelPolicy.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!policy) return res.status(404).json({ message: 'Policy not found' });
    const rows = Array.isArray(req.body.rules) ? req.body.rules : [];
    const data = rows.map((r) => ({
      businessId, policyId: policy.id,
      durationBand: r.durationBand,
      gradeRank: r.gradeRank != null ? Number(r.gradeRank) : null,
      cityTier: r.cityTier || null,
      foodCap: String(r.foodCap ?? 0),
      incidentalCap: String(r.incidentalCap ?? 0),
    }));
    await prisma.$transaction([
      prisma.travelPerDiemRule.deleteMany({ where: { businessId, policyId: policy.id } }),
      ...(data.length ? [prisma.travelPerDiemRule.createMany({ data })] : []),
      prisma.travelPolicy.update({ where: { id: policy.id }, data: { version: { increment: 1 } } }),
    ]);
    res.json(await withRules(policy));
  } catch (e) { next(e); }
}

async function replaceHotel(req, res, next) {
  try {
    const { businessId } = req.user;
    const policy = await prisma.travelPolicy.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!policy) return res.status(404).json({ message: 'Policy not found' });
    const rows = Array.isArray(req.body.rules) ? req.body.rules : [];
    const data = rows
      .filter((r) => r.gradeRank != null && r.cityTier && r.nightlyCap != null && r.nightlyCap !== '')
      .map((r) => ({ businessId, policyId: policy.id, gradeRank: Number(r.gradeRank), cityTier: r.cityTier, nightlyCap: String(r.nightlyCap) }));
    await prisma.$transaction([
      prisma.travelHotelRule.deleteMany({ where: { businessId, policyId: policy.id } }),
      ...(data.length ? [prisma.travelHotelRule.createMany({ data })] : []),
      prisma.travelPolicy.update({ where: { id: policy.id }, data: { version: { increment: 1 } } }),
    ]);
    res.json(await withRules(policy));
  } catch (e) { next(e); }
}

async function replaceTransport(req, res, next) {
  try {
    const { businessId } = req.user;
    const policy = await prisma.travelPolicy.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!policy) return res.status(404).json({ message: 'Policy not found' });
    const rows = Array.isArray(req.body.rules) ? req.body.rules : [];
    const data = rows.map((r) => ({
      businessId, policyId: policy.id,
      mode: r.mode,
      gradeRank: r.gradeRank != null && r.gradeRank !== '' ? Number(r.gradeRank) : null,
      allowed: r.allowed !== false,
      perKmRate: r.perKmRate != null && r.perKmRate !== '' ? String(r.perKmRate) : null,
      fareCap: r.fareCap != null && r.fareCap !== '' ? String(r.fareCap) : null,
      travelClass: r.travelClass || null,
      minJourneyHrs: r.minJourneyHrs != null && r.minJourneyHrs !== '' ? Number(r.minJourneyHrs) : null,
      conditionJson: r.conditionJson || null,
    }));
    await prisma.$transaction([
      prisma.travelTransportRule.deleteMany({ where: { businessId, policyId: policy.id } }),
      ...(data.length ? [prisma.travelTransportRule.createMany({ data })] : []),
      prisma.travelPolicy.update({ where: { id: policy.id }, data: { version: { increment: 1 } } }),
    ]);
    res.json(await withRules(policy));
  } catch (e) { next(e); }
}

// ── CityTier map ───────────────────────────────────────────────────────────────
async function listCityTiers(req, res, next) {
  try {
    const { businessId } = req.user;
    const { take, skip, page } = paginate(req.query);
    const where = { businessId, deletedAt: null };
    if (req.query.tier) where.tier = req.query.tier;
    if (req.query.q) where.city = { contains: String(req.query.q).toLowerCase() };
    const [items, total] = await Promise.all([
      prisma.cityTier.findMany({ where, orderBy: [{ tier: 'asc' }, { city: 'asc' }], skip, take }),
      prisma.cityTier.count({ where }),
    ]);
    res.json({ items, total, page, pageSize: take });
  } catch (e) { next(e); }
}

async function upsertCityTier(req, res, next) {
  try {
    const { businessId } = req.user;
    const { city, tier, countryCode } = req.body;
    if (!city || !tier || !countryCode) return res.status(400).json({ message: 'city, tier and countryCode are required' });
    const key = service.cityKey(city);
    const item = await prisma.cityTier.upsert({
      where: { businessId_countryCode_city: { businessId, countryCode, city: key } },
      update: { tier, stateCode: req.body.stateCode || null, deletedAt: null },
      create: { businessId, city: key, tier, countryCode, stateCode: req.body.stateCode || null },
    });
    res.status(201).json(item);
  } catch (e) { next(e); }
}

async function bulkUpsertCityTiers(req, res, next) {
  try {
    const { businessId } = req.user;
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    let count = 0;
    for (const r of rows) {
      if (!r.city || !r.tier || !r.countryCode) continue;
      const key = service.cityKey(r.city);
      await prisma.cityTier.upsert({
        where: { businessId_countryCode_city: { businessId, countryCode: r.countryCode, city: key } },
        update: { tier: r.tier, stateCode: r.stateCode || null, deletedAt: null },
        create: { businessId, city: key, tier: r.tier, countryCode: r.countryCode, stateCode: r.stateCode || null },
      });
      count += 1;
    }
    res.json({ upserted: count });
  } catch (e) { next(e); }
}

async function removeCityTier(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.cityTier.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'City tier not found' });
    await prisma.cityTier.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// ── live preview: dry-run the engine for a sample trip/line ────────────────────
// POST /policies/preview  body: { policyId?, gradeRank?, destCity?, countryCode?,
//   journeyHours?, lines:[{ amount, transportMode?, nights?, durationBand?, distanceKm? }] }
async function preview(req, res, next) {
  try {
    const { businessId } = req.user;
    const b = req.body || {};
    let policy = null;
    if (b.policyId) {
      policy = await prisma.travelPolicy.findFirst({ where: { id: b.policyId, businessId, deletedAt: null }, include: { perDiemRules: true, hotelRules: true, transportRules: true } });
    } else {
      policy = await service.loadActivePolicy(businessId, { countryCode: b.countryCode || null });
    }
    const gradeRank = b.gradeRank != null ? Number(b.gradeRank) : null;
    const cityTier = b.destTier || await service.resolveCityTier(businessId, b.destCity, b.countryCode, policy ? policy.defaultTier : 'TIER_3');
    const currencyCode = (policy && policy.currencyCode) || b.currencyCode || 'INR';
    const lines = Array.isArray(b.lines) ? b.lines : [];
    const results = lines.map((line) => {
      const ctx = { policy, gradeRank, cityTier, currencyCode, journeyHours: b.journeyHours != null ? Number(b.journeyHours) : null };
      const v = evaluateLine(line, ctx);
      return { ...v, line };
    });
    res.json({ policyId: policy ? policy.id : null, cityTier, gradeRank, currencyCode, lines: results });
  } catch (e) { next(e); }
}

module.exports = {
  listPolicies, getPolicy, createPolicy, updatePolicy, removePolicy,
  replacePerDiem, replaceHotel, replaceTransport,
  listCityTiers, upsertCityTier, bulkUpsertCityTiers, removeCityTier,
  preview,
};
