'use strict';

const { computeDeliveryDispatchMeta } = require('./ecomDeliveryRequestService');

const FINAL_STATUSES = Object.freeze(['DELIVERED', 'CANCELLED', 'RETURNED']);
const ACTIVE_STATUSES = Object.freeze([
  'PENDING',
  'READY_FOR_DISPATCH',
  'ASSIGNED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'ARRIVED',
  'ATTEMPTED_FAILED',
]);

function number(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function dateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDate(value) {
  const date = dateOrNull(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

function ratio(part, total) {
  return total > 0 ? Number((part / total).toFixed(4)) : null;
}

function percent(value) {
  return value == null ? null : Math.round(value * 1000) / 10;
}

function average(values) {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (!clean.length) return null;
  return Math.round(clean.reduce((sum, value) => sum + value, 0) / clean.length);
}

function averageDecimal(values, digits = 1) {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (!clean.length) return null;
  const factor = 10 ** digits;
  return Math.round((clean.reduce((sum, value) => sum + value, 0) / clean.length) * factor) / factor;
}

function minutesBetween(start, end) {
  const a = dateOrNull(start);
  const b = dateOrNull(end);
  if (!a || !b || b.getTime() < a.getTime()) return null;
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

function increment(map, key, by = 1) {
  const safeKey = key || 'UNKNOWN';
  map[safeKey] = (map[safeKey] || 0) + by;
}

function makeRiderSeed(rider = {}) {
  return {
    id: rider.id || null,
    fullName: rider.fullName || 'Unassigned',
    phone: rider.phone || null,
    vehicleType: rider.vehicleType || null,
    status: rider.status || null,
    assigned: 0,
    active: 0,
    delivered: 0,
    failed: 0,
    cancelled: 0,
    returned: 0,
    onTime: 0,
    late: 0,
    measuredForSla: 0,
    onTimeRate: null,
    onTimePercent: null,
    avgDeliveryMinutes: null,
    cashToCollectMinor: 0,
    cashCollectedMinor: 0,
    cashOutstandingMinor: 0,
    openExceptions: 0,
    escalatedExceptions: 0,
    lastActivityAt: null,
  };
}

function buildDailyBuckets({ deliveries, days, now }) {
  const byDate = {};
  const start = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

  for (let i = 0; i < days; i += 1) {
    const date = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    const key = date.toISOString().slice(0, 10);
    byDate[key] = { date: key, created: 0, delivered: 0, failed: 0, late: 0 };
  }

  for (const delivery of deliveries) {
    const createdKey = isoDate(delivery.createdAt);
    if (createdKey && byDate[createdKey]) byDate[createdKey].created += 1;

    if (delivery.status === 'DELIVERED') {
      const deliveredKey = isoDate(delivery.deliveredAt);
      if (deliveredKey && byDate[deliveredKey]) {
        byDate[deliveredKey].delivered += 1;
        const promisedAt = dateOrNull(delivery.promisedAt);
        const deliveredAt = dateOrNull(delivery.deliveredAt);
        if (promisedAt && deliveredAt && deliveredAt.getTime() > promisedAt.getTime()) {
          byDate[deliveredKey].late += 1;
        }
      }
    }

    if (delivery.status === 'ATTEMPTED_FAILED') {
      const failedKey = isoDate(delivery.failedAt || delivery.updatedAt || delivery.createdAt);
      if (failedKey && byDate[failedKey]) byDate[failedKey].failed += 1;
    }
  }

  return Object.values(byDate);
}

function buildDeliveryAnalytics({ deliveries = [], riders = [], now = new Date(), since = null, days = 30 } = {}) {
  const current = dateOrNull(now) || new Date();
  const windowDays = Math.min(365, Math.max(1, number(days, 30)));
  const statusCounts = {};
  const sourceCounts = {};
  const slaCounts = {
    ON_TRACK: 0,
    DUE_SOON: 0,
    AT_RISK: 0,
    BREACHED: 0,
    EXCEPTION: 0,
    UNCOMMITTED: 0,
    COMPLETE: 0,
    CLOSED: 0,
  };
  const exceptionBreakdown = {};
  const exceptionStatuses = { OPEN: 0, ESCALATED: 0, RESOLVED: 0 };
  const durations = [];
  const pickupDurations = [];
  const customerRatings = [];
  const ridersById = new Map();

  for (const rider of riders) {
    if (rider?.id) ridersById.set(rider.id, makeRiderSeed(rider));
  }

  const totals = {
    total: deliveries.length,
    active: 0,
    delivered: 0,
    failed: 0,
    cancelled: 0,
    returned: 0,
    completed: 0,
    unassigned: 0,
    withPromisedAt: 0,
    onTime: 0,
    late: 0,
    openExceptions: 0,
    escalatedExceptions: 0,
    resolvedExceptions: 0,
  };

  const cash = {
    toCollectMinor: 0,
    collectedMinor: 0,
    outstandingMinor: 0,
    outstandingFromCustomersMinor: 0,
    collectedByRidersMinor: 0,
    codDeliveries: 0,
  };

  for (const delivery of deliveries) {
    const status = String(delivery.status || 'PENDING').toUpperCase();
    const source = String(delivery.source || 'MANUAL').toUpperCase();
    const riderId = delivery.riderId || delivery.rider?.id || null;
    const finalStatus = FINAL_STATUSES.includes(status);
    const active = !finalStatus;
    const cashToCollect = Math.max(0, number(delivery.cashToCollectMinor));
    const cashCollected = Math.max(0, number(delivery.cashCollectedMinor));
    const outstanding = Math.max(0, cashToCollect - cashCollected);
    const isCashDelivery = cashToCollect > 0 || String(delivery.paymentMethod || '').toLowerCase() === 'cod';
    const deliveryMinutes = minutesBetween(
      delivery.pickedUpAt || delivery.assignedAt || delivery.createdAt,
      delivery.deliveredAt,
    );
    const pickupMinutes = minutesBetween(delivery.assignedAt || delivery.createdAt, delivery.pickedUpAt);
    const customerRating = Number(delivery.customerRating);

    increment(statusCounts, status);
    increment(sourceCounts, source);

    const dispatch = computeDeliveryDispatchMeta(delivery, { now: current });
    increment(slaCounts, dispatch.slaStatus || 'UNCOMMITTED');

    if (ACTIVE_STATUSES.includes(status)) totals.active += 1;
    if (status === 'DELIVERED') totals.delivered += 1;
    if (status === 'ATTEMPTED_FAILED') totals.failed += 1;
    if (status === 'CANCELLED') totals.cancelled += 1;
    if (status === 'RETURNED') totals.returned += 1;
    if (finalStatus) totals.completed += 1;
    if (!riderId && active) totals.unassigned += 1;

    if (status === 'DELIVERED' && deliveryMinutes != null) durations.push(deliveryMinutes);
    if (pickupMinutes != null) pickupDurations.push(pickupMinutes);
    if (Number.isFinite(customerRating) && customerRating >= 1 && customerRating <= 5) {
      customerRatings.push(customerRating);
    }

    const promisedAt = dateOrNull(delivery.promisedAt);
    const deliveredAt = dateOrNull(delivery.deliveredAt);
    const hasDeliveredSla = status === 'DELIVERED' && promisedAt && deliveredAt;
    if (hasDeliveredSla) {
      totals.withPromisedAt += 1;
      if (deliveredAt.getTime() <= promisedAt.getTime()) totals.onTime += 1;
      else totals.late += 1;
    }

    if (isCashDelivery) cash.codDeliveries += 1;
    cash.toCollectMinor += cashToCollect;
    cash.collectedMinor += cashCollected;
    cash.collectedByRidersMinor += cashCollected;
    if (!['CANCELLED', 'RETURNED'].includes(status)) cash.outstandingMinor += outstanding;
    if (active) cash.outstandingFromCustomersMinor += outstanding;

    const exceptionStatus = String(delivery.exceptionStatus || '').toUpperCase();
    const exceptionCode = String(delivery.exceptionCode || 'OTHER').toUpperCase();
    if (exceptionStatus) {
      increment(exceptionStatuses, exceptionStatus);
      increment(exceptionBreakdown, exceptionCode);
    }
    if (exceptionStatus === 'OPEN') totals.openExceptions += 1;
    if (exceptionStatus === 'ESCALATED') totals.escalatedExceptions += 1;
    if (exceptionStatus === 'RESOLVED') totals.resolvedExceptions += 1;

    let riderStats = null;
    if (riderId) {
      if (!ridersById.has(riderId)) {
        ridersById.set(riderId, makeRiderSeed({
          id: riderId,
          fullName: delivery.rider?.fullName || 'Assigned rider',
          phone: delivery.rider?.phone || null,
          vehicleType: delivery.rider?.vehicleType || null,
          status: delivery.rider?.status || null,
        }));
      }
      riderStats = ridersById.get(riderId);
      riderStats.assigned += 1;
      if (active) riderStats.active += 1;
      if (status === 'DELIVERED') riderStats.delivered += 1;
      if (status === 'ATTEMPTED_FAILED') riderStats.failed += 1;
      if (status === 'CANCELLED') riderStats.cancelled += 1;
      if (status === 'RETURNED') riderStats.returned += 1;
      if (hasDeliveredSla) {
        riderStats.measuredForSla += 1;
        if (deliveredAt.getTime() <= promisedAt.getTime()) riderStats.onTime += 1;
        else riderStats.late += 1;
      }
      if (deliveryMinutes != null) {
        if (!Array.isArray(riderStats._durations)) riderStats._durations = [];
        riderStats._durations.push(deliveryMinutes);
      }
      riderStats.cashToCollectMinor += cashToCollect;
      riderStats.cashCollectedMinor += cashCollected;
      if (!['CANCELLED', 'RETURNED'].includes(status)) riderStats.cashOutstandingMinor += outstanding;
      if (exceptionStatus === 'OPEN') riderStats.openExceptions += 1;
      if (exceptionStatus === 'ESCALATED') riderStats.escalatedExceptions += 1;
      const lastActivityAt = dateOrNull(delivery.deliveredAt || delivery.updatedAt || delivery.createdAt);
      if (lastActivityAt && (!riderStats.lastActivityAt || lastActivityAt.getTime() > new Date(riderStats.lastActivityAt).getTime())) {
        riderStats.lastActivityAt = lastActivityAt.toISOString();
      }
    }
  }

  const onTimeRate = ratio(totals.onTime, totals.withPromisedAt);
  const riderPerformance = Array.from(ridersById.values())
    .map((rider) => {
      const riderOnTimeRate = ratio(rider.onTime, rider.measuredForSla);
      const { _durations, ...clean } = rider;
      return {
        ...clean,
        onTimeRate: riderOnTimeRate,
        onTimePercent: percent(riderOnTimeRate),
        avgDeliveryMinutes: average(_durations || []),
      };
    })
    .sort((a, b) => {
      if (b.delivered !== a.delivered) return b.delivered - a.delivered;
      if (b.active !== a.active) return b.active - a.active;
      return String(a.fullName || '').localeCompare(String(b.fullName || ''));
    });

  return {
    window: {
      days: windowDays,
      since: dateOrNull(since)?.toISOString() || null,
      until: current.toISOString(),
    },
    totals: {
      ...totals,
      onTimeRate,
      onTimePercent: percent(onTimeRate),
      completionRate: ratio(totals.delivered, Math.max(1, totals.total - totals.cancelled)),
      completionPercent: percent(ratio(totals.delivered, Math.max(1, totals.total - totals.cancelled))),
      avgDeliveryMinutes: average(durations),
      avgPickupMinutes: average(pickupDurations),
      ratedDeliveries: customerRatings.length,
      avgCustomerRating: averageDecimal(customerRatings, 1),
    },
    cash,
    sla: slaCounts,
    statusCounts,
    sourceCounts,
    exceptions: {
      statuses: exceptionStatuses,
      breakdown: exceptionBreakdown,
    },
    riderPerformance,
    daily: buildDailyBuckets({ deliveries, days: windowDays, now: current }),
  };
}

module.exports = {
  ACTIVE_STATUSES,
  FINAL_STATUSES,
  buildDeliveryAnalytics,
};
