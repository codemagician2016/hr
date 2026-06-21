'use strict';

const prismaDefault = require('./prisma');

const RIDER_SHIFT_STATUSES = Object.freeze(['OPEN', 'CLOSED', 'VOID']);
const NON_STARTABLE_RIDER_STATUSES = Object.freeze(['SUSPENDED', 'DEPARTED', 'ON_LEAVE']);

function cleanString(value, max = 500) {
  if (value === undefined || value === null) return null;
  const next = String(value).trim();
  return next ? next.slice(0, max) : null;
}

function cleanMinor(value, fallback = 0) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(0, Math.round(next));
}

function cleanInt(value, { min = 0, max = 100, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, Math.round(next)));
}

function cleanCoordinate(value, { min, max } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const next = Number(value);
  if (!Number.isFinite(next)) return null;
  if (next < min || next > max) return null;
  return next;
}

function emptyShiftCashSummary() {
  return {
    expectedCashInHandMinor: 0,
    cashCollectedMinor: 0,
    cashReceivedMinor: 0,
    cashChangeDueMinor: 0,
    directDeliveryCount: 0,
    routeStopCount: 0,
    deliveryCount: 0,
  };
}

function cashRowInHandMinor(row = {}) {
  const received = cleanMinor(row.cashReceivedMinor);
  const changeDue = cleanMinor(row.cashChangeDueMinor);
  if (received || changeDue) return Math.max(0, received - changeDue);
  return cleanMinor(row.cashCollectedMinor);
}

function completionWindow(startedAt, endedAt = null) {
  const start = new Date(startedAt);
  if (!startedAt || Number.isNaN(start.getTime())) return [];
  const end = endedAt ? new Date(endedAt) : null;
  const upper = end && !Number.isNaN(end.getTime()) ? { lte: end } : {};
  const range = { gte: start, ...upper };
  return [
    { deliveredAt: range },
    { deliveredAt: null, updatedAt: range },
  ];
}

async function calculateRiderShiftCashSummary({
  prisma = prismaDefault,
  businessId,
  riderId,
  startedAt,
  endedAt = null,
} = {}) {
  const window = completionWindow(startedAt, endedAt);
  if (!businessId || !riderId || window.length === 0) return emptyShiftCashSummary();

  const cashBearingRows = {
    OR: [
      { cashCollectedMinor: { gt: 0 } },
      { cashReceivedMinor: { gt: 0 } },
      { cashChangeDueMinor: { gt: 0 } },
    ],
  };
  const selectCashFields = {
    id: true,
    cashCollectedMinor: true,
    cashReceivedMinor: true,
    cashChangeDueMinor: true,
  };

  const [directDeliveries, routeStops] = await Promise.all([
    prisma.ecomDeliveryRequest.findMany({
      where: {
        businessId,
        riderId,
        status: 'DELIVERED',
        routeStops: { none: {} },
        AND: [{ OR: window }, cashBearingRows],
      },
      select: selectCashFields,
    }),
    prisma.ecomDeliveryRouteStop.findMany({
      where: {
        status: 'DELIVERED',
        route: { is: { businessId, riderId } },
        AND: [{ OR: window }, cashBearingRows],
      },
      select: selectCashFields,
    }),
  ]);

  const rows = [...directDeliveries, ...routeStops];
  return rows.reduce((summary, row) => {
    summary.expectedCashInHandMinor += cashRowInHandMinor(row);
    summary.cashCollectedMinor += cleanMinor(row.cashCollectedMinor);
    summary.cashReceivedMinor += cleanMinor(row.cashReceivedMinor);
    summary.cashChangeDueMinor += cleanMinor(row.cashChangeDueMinor);
    return summary;
  }, {
    ...emptyShiftCashSummary(),
    directDeliveryCount: directDeliveries.length,
    routeStopCount: routeStops.length,
    deliveryCount: rows.length,
  });
}

function shiftDTO(row, extras = {}) {
  if (!row) return null;
  const dto = {
    id: row.id,
    businessId: row.businessId,
    riderId: row.riderId,
    locationId: row.locationId || null,
    location: row.location ? {
      id: row.location.id,
      name: row.location.name,
      city: row.location.city || null,
    } : null,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt || null,
    startLocation: row.startLat != null && row.startLng != null ? { lat: row.startLat, lng: row.startLng } : null,
    endLocation: row.endLat != null && row.endLng != null ? { lat: row.endLat, lng: row.endLng } : null,
    cashFloatMinor: row.cashFloatMinor || 0,
    cashInHandMinor: row.cashInHandMinor || 0,
    startBatteryPct: row.startBatteryPct ?? null,
    endBatteryPct: row.endBatteryPct ?? null,
    startNote: row.startNote || null,
    endNote: row.endNote || null,
    startedByUserId: row.startedByUserId || null,
    endedByUserId: row.endedByUserId || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (extras.cashSummary) {
    dto.cashSummary = extras.cashSummary;
    dto.expectedCashInHandMinor = extras.cashSummary.expectedCashInHandMinor || 0;
  }
  return dto;
}

async function shiftDTOWithCashSummary({ prisma = prismaDefault, shift } = {}) {
  if (!shift) return null;
  const cashSummary = await calculateRiderShiftCashSummary({
    prisma,
    businessId: shift.businessId,
    riderId: shift.riderId,
    startedAt: shift.startedAt,
    endedAt: shift.endedAt,
  });
  return shiftDTO(shift, { cashSummary });
}

async function ensureLocation({ prisma, businessId, locationId }) {
  if (!locationId) return null;
  const location = await prisma.businessLocation.findFirst({
    where: { id: locationId, businessId, isActive: true },
    select: { id: true },
  });
  if (!location) {
    const err = new Error('Location not found');
    err.status = 404;
    throw err;
  }
  return location;
}

function shiftInclude() {
  return {
    location: { select: { id: true, name: true, city: true } },
  };
}

async function findActiveRiderShift({ prisma = prismaDefault, businessId, riderId } = {}) {
  if (!businessId || !riderId) return null;
  return prisma.ecomRiderShift.findFirst({
    where: { businessId, riderId, status: 'OPEN' },
    orderBy: { startedAt: 'desc' },
    include: shiftInclude(),
  });
}

async function assertRiderOnShift({ prisma = prismaDefault, businessId, riderId } = {}) {
  const shift = await findActiveRiderShift({ prisma, businessId, riderId });
  if (!shift) {
    const err = new Error('Start your rider shift before updating deliveries');
    err.status = 409;
    err.reason = 'SHIFT_REQUIRED';
    throw err;
  }
  return shift;
}

async function startRiderShift({
  prisma = prismaDefault,
  businessId,
  riderId,
  actorUserId = null,
  input = {},
} = {}) {
  if (!businessId || !riderId) {
    const err = new Error('No rider in scope');
    err.status = 403;
    throw err;
  }

  const rider = await prisma.ecomRider.findFirst({
    where: { id: riderId, businessId },
    select: { id: true, status: true, homeLocationId: true },
  });
  if (!rider) {
    const err = new Error('Rider not found');
    err.status = 404;
    throw err;
  }
  if (NON_STARTABLE_RIDER_STATUSES.includes(rider.status)) {
    const err = new Error(`Cannot start a shift while rider is ${String(rider.status).toLowerCase().replace(/_/g, ' ')}`);
    err.status = 409;
    err.reason = 'RIDER_NOT_AVAILABLE';
    throw err;
  }

  const existing = await findActiveRiderShift({ prisma, businessId, riderId });
  if (existing) return { shift: shiftDTO(existing), created: false };

  const locationId = cleanString(input.locationId, 80) || rider.homeLocationId || null;
  await ensureLocation({ prisma, businessId, locationId });

  const startLat = cleanCoordinate(input.lat ?? input.startLat, { min: -90, max: 90 });
  const startLng = cleanCoordinate(input.lng ?? input.startLng, { min: -180, max: 180 });
  const cashFloatMinor = cleanMinor(input.cashFloatMinor ?? input.cashFloat);
  const startBatteryPct = cleanInt(input.batteryPct ?? input.startBatteryPct, { fallback: null });

  const row = await prisma.$transaction(async (tx) => {
    const shift = await tx.ecomRiderShift.create({
      data: {
        businessId,
        riderId,
        locationId,
        status: 'OPEN',
        startedAt: new Date(),
        startLat,
        startLng,
        cashFloatMinor,
        startBatteryPct,
        startNote: cleanString(input.note || input.startNote, 1000),
        startedByUserId: cleanString(actorUserId, 80),
      },
      include: shiftInclude(),
    });
    await tx.ecomRider.update({
      where: { id: riderId },
      data: { status: 'ACTIVE', cashFloatMinor },
    });
    return shift;
  });

  return { shift: shiftDTO(row), created: true };
}

async function endRiderShift({
  prisma = prismaDefault,
  businessId,
  riderId,
  actorUserId = null,
  input = {},
} = {}) {
  const active = await findActiveRiderShift({ prisma, businessId, riderId });
  if (!active) {
    const err = new Error('No active rider shift to end');
    err.status = 409;
    err.reason = 'NO_ACTIVE_SHIFT';
    throw err;
  }

  const endLat = cleanCoordinate(input.lat ?? input.endLat, { min: -90, max: 90 });
  const endLng = cleanCoordinate(input.lng ?? input.endLng, { min: -180, max: 180 });
  const cashInHandMinor = cleanMinor(input.cashInHandMinor ?? input.cashInHand);
  const endBatteryPct = cleanInt(input.batteryPct ?? input.endBatteryPct, { fallback: null });

  const row = await prisma.$transaction(async (tx) => {
    const shift = await tx.ecomRiderShift.update({
      where: { id: active.id },
      data: {
        status: 'CLOSED',
        endedAt: new Date(),
        endLat,
        endLng,
        cashInHandMinor,
        endBatteryPct,
        endNote: cleanString(input.note || input.endNote, 1000),
        endedByUserId: cleanString(actorUserId, 80),
      },
      include: shiftInclude(),
    });
    await tx.ecomRider.update({
      where: { id: riderId },
      data: { status: 'OFF_SHIFT' },
    });
    return shift;
  });

  return shiftDTO(row);
}

module.exports = {
  RIDER_SHIFT_STATUSES,
  assertRiderOnShift,
  calculateRiderShiftCashSummary,
  endRiderShift,
  findActiveRiderShift,
  shiftDTO,
  shiftDTOWithCashSummary,
  startRiderShift,
};
