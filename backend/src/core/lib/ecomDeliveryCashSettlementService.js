'use strict';

const prismaDefault = require('./prisma');

const SETTLEMENT_STATUSES = Object.freeze(['DRAFT', 'SETTLED', 'VOID']);

function cleanString(value, max = 500) {
  if (value === undefined || value === null) return null;
  const next = String(value).trim();
  return next ? next.slice(0, max) : null;
}

function cleanDate(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function cleanMinor(value, fallback = 0) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(0, Math.round(next));
}

function uniqueStrings(values = [], max = 500) {
  return Array.from(new Set((values || [])
    .map((value) => cleanString(value, 120))
    .filter(Boolean)))
    .slice(0, max);
}

function settlementDTO(row) {
  if (!row) return null;
  return {
    id: row.id,
    businessId: row.businessId,
    riderId: row.riderId || null,
    rider: row.rider ? {
      id: row.rider.id,
      fullName: row.rider.fullName,
      phone: row.rider.phone || null,
      vehicleType: row.rider.vehicleType || null,
      status: row.rider.status || null,
    } : null,
    locationId: row.locationId || null,
    location: row.location ? {
      id: row.location.id,
      name: row.location.name,
      city: row.location.city || null,
    } : null,
    status: row.status,
    settlementDate: row.settlementDate,
    fromAt: row.fromAt,
    toAt: row.toAt,
    currency: row.currency,
    expectedCashMinor: row.expectedCashMinor || 0,
    countedCashMinor: row.countedCashMinor || 0,
    varianceMinor: row.varianceMinor || 0,
    deliveryCount: row.deliveryCount || 0,
    deliveryIds: row.deliveryIds || [],
    reference: row.reference || null,
    notes: row.notes || null,
    settledByUserId: row.settledByUserId || null,
    voidedAt: row.voidedAt || null,
    voidedByUserId: row.voidedByUserId || null,
    voidReason: row.voidReason || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function settledDeliveryIdSet(settlements = []) {
  const ids = new Set();
  for (const settlement of settlements) {
    if (settlement.status === 'VOID') continue;
    for (const id of settlement.deliveryIds || []) ids.add(id);
  }
  return ids;
}

function buildPendingLedger({ deliveries = [], settlements = [] } = {}) {
  const settledIds = settledDeliveryIdSet(settlements);
  const byRider = new Map();

  for (const delivery of deliveries) {
    if (!delivery?.id || settledIds.has(delivery.id)) continue;
    const riderId = delivery.riderId || delivery.rider?.id || null;
    const key = riderId || 'UNASSIGNED';
    if (!byRider.has(key)) {
      byRider.set(key, {
        riderId,
        rider: delivery.rider ? {
          id: delivery.rider.id,
          fullName: delivery.rider.fullName,
          phone: delivery.rider.phone || null,
          vehicleType: delivery.rider.vehicleType || null,
          status: delivery.rider.status || null,
        } : null,
        locationId: delivery.locationId || null,
        currency: delivery.currency || 'INR',
        deliveryCount: 0,
        expectedCashMinor: 0,
        deliveryIds: [],
        deliveries: [],
        firstDeliveredAt: null,
        lastDeliveredAt: null,
      });
    }
    const group = byRider.get(key);
    const amount = cleanMinor(delivery.cashCollectedMinor || delivery.cashToCollectMinor);
    const deliveredAt = cleanDate(delivery.deliveredAt || delivery.updatedAt || delivery.createdAt, null);

    group.deliveryCount += 1;
    group.expectedCashMinor += amount;
    group.deliveryIds.push(delivery.id);
    group.deliveries.push({
      id: delivery.id,
      source: delivery.source || null,
      sourceRef: delivery.sourceRef || null,
      customerName: delivery.customerName || null,
      currency: delivery.currency || group.currency,
      cashToCollectMinor: cleanMinor(delivery.cashToCollectMinor),
      cashCollectedMinor: amount,
      cashReceivedMinor: cleanMinor(delivery.cashReceivedMinor),
      cashChangeDueMinor: cleanMinor(delivery.cashChangeDueMinor),
      deliveredAt: deliveredAt ? deliveredAt.toISOString() : null,
    });
    if (delivery.locationId && !group.locationId) group.locationId = delivery.locationId;
    if (delivery.currency && !group.currency) group.currency = delivery.currency;
    if (deliveredAt) {
      if (!group.firstDeliveredAt || deliveredAt.getTime() < new Date(group.firstDeliveredAt).getTime()) {
        group.firstDeliveredAt = deliveredAt.toISOString();
      }
      if (!group.lastDeliveredAt || deliveredAt.getTime() > new Date(group.lastDeliveredAt).getTime()) {
        group.lastDeliveredAt = deliveredAt.toISOString();
      }
    }
  }

  return Array.from(byRider.values())
    .filter((group) => group.expectedCashMinor > 0 || group.deliveryCount > 0)
    .sort((a, b) => {
      if (b.expectedCashMinor !== a.expectedCashMinor) return b.expectedCashMinor - a.expectedCashMinor;
      return String(a.rider?.fullName || '').localeCompare(String(b.rider?.fullName || ''));
    });
}

async function listCashSettlementLedger({
  prisma = prismaDefault,
  businessId,
  locationId = null,
  days = 30,
  now = new Date(),
} = {}) {
  if (!businessId) {
    const err = new Error('No business in scope');
    err.status = 403;
    throw err;
  }

  const windowDays = Math.min(365, Math.max(1, Number(days) || 30));
  const current = cleanDate(now, new Date());
  const since = new Date(current.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const deliveryWhere = {
    businessId,
    status: 'DELIVERED',
    deliveredAt: { gte: since },
    cashCollectedMinor: { gt: 0 },
  };
  if (locationId) deliveryWhere.locationId = locationId;

  const deliveries = await prisma.ecomDeliveryRequest.findMany({
    where: deliveryWhere,
    orderBy: [{ deliveredAt: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      businessId: true,
      locationId: true,
      riderId: true,
      rider: { select: { id: true, fullName: true, phone: true, vehicleType: true, status: true } },
      status: true,
      source: true,
      sourceRef: true,
      customerName: true,
      currency: true,
      cashToCollectMinor: true,
      cashCollectedMinor: true,
      cashReceivedMinor: true,
      cashChangeDueMinor: true,
      deliveredAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const deliveryIds = deliveries.map((delivery) => delivery.id);
  const recentSettlementWhere = { businessId, settlementDate: { gte: since } };
  if (locationId) recentSettlementWhere.locationId = locationId;
  const matchedSettlementWhere = {
    businessId,
    status: { not: 'VOID' },
    ...(deliveryIds.length ? { deliveryIds: { hasSome: deliveryIds } } : { settlementDate: { gte: since } }),
  };
  if (locationId) matchedSettlementWhere.locationId = locationId;

  const [matchedSettlements, settlements] = await Promise.all([
    prisma.ecomDeliveryCashSettlement.findMany({
      where: matchedSettlementWhere,
      select: { status: true, deliveryIds: true },
    }),
    prisma.ecomDeliveryCashSettlement.findMany({
      where: recentSettlementWhere,
      orderBy: [{ settlementDate: 'desc' }, { createdAt: 'desc' }],
      include: {
        rider: { select: { id: true, fullName: true, phone: true, vehicleType: true, status: true } },
        location: { select: { id: true, name: true, city: true } },
      },
    }),
  ]);

  const pending = buildPendingLedger({ deliveries, settlements: matchedSettlements });
  const pendingCashMinor = pending.reduce((sum, group) => sum + group.expectedCashMinor, 0);
  const pendingDeliveryCount = pending.reduce((sum, group) => sum + group.deliveryCount, 0);

  return {
    window: {
      days: windowDays,
      since: since.toISOString(),
      until: current.toISOString(),
    },
    totals: {
      pendingCashMinor,
      pendingDeliveryCount,
      pendingRiderCount: pending.length,
      settledCashMinor: settlements
        .filter((row) => row.status === 'SETTLED')
        .reduce((sum, row) => sum + cleanMinor(row.countedCashMinor), 0),
      varianceMinor: settlements
        .filter((row) => row.status === 'SETTLED')
        .reduce((sum, row) => sum + Number(row.varianceMinor || 0), 0),
    },
    pending,
    settlements: settlements.map(settlementDTO),
  };
}

async function createCashSettlement({
  prisma = prismaDefault,
  businessId,
  actorUserId = null,
  input = {},
} = {}) {
  if (!businessId) {
    const err = new Error('No business in scope');
    err.status = 403;
    throw err;
  }
  const riderId = cleanString(input.riderId, 80);
  if (!riderId) {
    const err = new Error('riderId is required');
    err.status = 400;
    throw err;
  }

  const rider = await prisma.ecomRider.findFirst({
    where: { id: riderId, businessId },
    select: { id: true, fullName: true },
  });
  if (!rider) {
    const err = new Error('Rider not found');
    err.status = 404;
    throw err;
  }

  const now = cleanDate(input.settlementDate, new Date());
  const toAt = cleanDate(input.toAt, now);
  const fromAt = cleanDate(input.fromAt, new Date(toAt.getTime() - 24 * 60 * 60 * 1000));
  const deliveryIds = uniqueStrings(input.deliveryIds);
  const where = {
    businessId,
    riderId,
    status: 'DELIVERED',
    cashCollectedMinor: { gt: 0 },
  };
  if (deliveryIds.length) where.id = { in: deliveryIds };
  else where.deliveredAt = { gte: fromAt, lte: toAt };
  if (input.locationId) where.locationId = cleanString(input.locationId, 80);

  const deliveries = await prisma.ecomDeliveryRequest.findMany({
    where,
    orderBy: [{ deliveredAt: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      locationId: true,
      currency: true,
      cashCollectedMinor: true,
      cashToCollectMinor: true,
      deliveredAt: true,
    },
  });

  if (!deliveries.length) {
    const err = new Error('No unsettled delivered cash deliveries found for this rider');
    err.status = 400;
    err.reason = 'NO_DELIVERIES';
    throw err;
  }

  const existingSettlements = await prisma.ecomDeliveryCashSettlement.findMany({
    where: {
      businessId,
      status: { not: 'VOID' },
      deliveryIds: { hasSome: deliveries.map((delivery) => delivery.id) },
    },
    select: { deliveryIds: true, status: true },
  });
  const settledIds = settledDeliveryIdSet(existingSettlements);
  const unsettled = deliveries.filter((delivery) => !settledIds.has(delivery.id));

  if (!unsettled.length) {
    const err = new Error('Selected deliveries are already settled');
    err.status = 409;
    err.reason = 'ALREADY_SETTLED';
    throw err;
  }

  const expectedCashMinor = unsettled.reduce((sum, delivery) => (
    sum + cleanMinor(delivery.cashCollectedMinor || delivery.cashToCollectMinor)
  ), 0);
  const countedCashMinor = input.countedCashMinor === undefined
    ? expectedCashMinor
    : cleanMinor(input.countedCashMinor);
  const varianceMinor = countedCashMinor - expectedCashMinor;
  const locationIds = Array.from(new Set(unsettled.map((delivery) => delivery.locationId).filter(Boolean)));
  const deliveredTimes = unsettled
    .map((delivery) => cleanDate(delivery.deliveredAt, null))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());

  const currency = (cleanString(input.currency, 3) || unsettled[0]?.currency || 'INR').toUpperCase();

  const row = await prisma.ecomDeliveryCashSettlement.create({
    data: {
      businessId,
      riderId,
      locationId: input.locationId ? cleanString(input.locationId, 80) : (locationIds.length === 1 ? locationIds[0] : null),
      status: 'SETTLED',
      settlementDate: now,
      fromAt: deliveredTimes[0] || fromAt,
      toAt: deliveredTimes[deliveredTimes.length - 1] || toAt,
      currency,
      expectedCashMinor,
      countedCashMinor,
      varianceMinor,
      deliveryCount: unsettled.length,
      deliveryIds: unsettled.map((delivery) => delivery.id),
      reference: cleanString(input.reference, 160),
      notes: cleanString(input.notes, 2000),
      settledByUserId: cleanString(actorUserId, 80),
    },
    include: {
      rider: { select: { id: true, fullName: true, phone: true, vehicleType: true, status: true } },
      location: { select: { id: true, name: true, city: true } },
    },
  });

  return settlementDTO(row);
}

async function voidCashSettlement({
  prisma = prismaDefault,
  businessId,
  id,
  actorUserId = null,
  reason = null,
} = {}) {
  if (!businessId) {
    const err = new Error('No business in scope');
    err.status = 403;
    throw err;
  }
  const settlement = await prisma.ecomDeliveryCashSettlement.findFirst({
    where: { id, businessId },
    select: { id: true, status: true },
  });
  if (!settlement) {
    const err = new Error('Settlement not found');
    err.status = 404;
    throw err;
  }
  if (settlement.status === 'VOID') {
    const err = new Error('Settlement is already void');
    err.status = 409;
    throw err;
  }

  const row = await prisma.ecomDeliveryCashSettlement.update({
    where: { id: settlement.id },
    data: {
      status: 'VOID',
      voidedAt: new Date(),
      voidedByUserId: cleanString(actorUserId, 80),
      voidReason: cleanString(reason, 2000),
    },
    include: {
      rider: { select: { id: true, fullName: true, phone: true, vehicleType: true, status: true } },
      location: { select: { id: true, name: true, city: true } },
    },
  });
  return settlementDTO(row);
}

module.exports = {
  SETTLEMENT_STATUSES,
  buildPendingLedger,
  createCashSettlement,
  listCashSettlementLedger,
  settlementDTO,
  voidCashSettlement,
};
