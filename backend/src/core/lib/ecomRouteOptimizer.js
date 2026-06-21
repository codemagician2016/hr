'use strict';

function cleanString(value, max = 200) {
  if (value === undefined || value === null) return null;
  const next = String(value).trim();
  return next ? next.slice(0, max) : null;
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validPoint(lat, lng) {
  if (lat === undefined || lat === null || lat === '' || lng === undefined || lng === null || lng === '') return null;
  const nextLat = Number(lat);
  const nextLng = Number(lng);
  if (!Number.isFinite(nextLat) || !Number.isFinite(nextLng)) return null;
  if (nextLat < -90 || nextLat > 90 || nextLng < -180 || nextLng > 180) return null;
  return { lat: nextLat, lng: nextLng };
}

function pointFromAddress(address = {}) {
  const a = address && typeof address === 'object' ? address : {};
  return validPoint(a.lat ?? a.latitude, a.lng ?? a.lon ?? a.longitude);
}

function distanceMeters(a, b) {
  if (!a || !b) return null;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthMeters = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * earthMeters * Math.asin(Math.sqrt(h)));
}

function orderDueAt(order) {
  return toDate(order?.promisedAt) || toDate(order?.deliveryDate);
}

function orderAddress(order) {
  return order?.shippingAddress && typeof order.shippingAddress === 'object' ? order.shippingAddress : {};
}

function normalizeOrder(order) {
  const address = orderAddress(order);
  const city = cleanString(address.city, 80)?.toLowerCase() || '';
  const postalCode = cleanString(address.postalCode || address.postcode || address.zip, 40) || '';
  const postalPrefix = postalCode.replace(/\s+/g, '').slice(0, 4).toUpperCase();
  const dueAt = orderDueAt(order);
  const totalMinor = Number(order?.adjustedTotalMinor ?? order?.totalMinor ?? 0) || 0;
  const cashToCollectMinor = order?.paymentMethod === 'cod' && !order?.paidAt ? totalMinor : 0;
  return {
    order,
    id: order.id,
    locationId: order.locationId || null,
    point: pointFromAddress(address),
    city,
    postalCode,
    postalPrefix,
    dueAt,
    placedAt: toDate(order.placedAt) || new Date(0),
    cashToCollectMinor,
    quantity: Array.isArray(order.items)
      ? order.items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
      : 0,
  };
}

function timeWindowMinutes(a, b) {
  if (!a?.dueAt || !b?.dueAt) return 0;
  return Math.abs(Math.round((a.dueAt.getTime() - b.dueAt.getTime()) / 60000));
}

function localityMatch(a, b) {
  if (a.locationId && b.locationId && a.locationId !== b.locationId) return false;
  if (a.point && b.point) return (distanceMeters(a.point, b.point) || 0) <= 6000;
  if (a.postalPrefix && b.postalPrefix && a.postalPrefix === b.postalPrefix) return true;
  return Boolean(a.city && b.city && a.city === b.city);
}

function candidateScore(seed, candidate) {
  if (!localityMatch(seed, candidate)) return -Infinity;
  const dueGap = timeWindowMinutes(seed, candidate);
  if (seed.dueAt && candidate.dueAt && dueGap > 150) return -Infinity;
  const distance = seed.point && candidate.point ? distanceMeters(seed.point, candidate.point) || 0 : 3000;
  const localityBonus = seed.postalPrefix && seed.postalPrefix === candidate.postalPrefix ? 35 : seed.city && seed.city === candidate.city ? 20 : 0;
  const dueBonus = Math.max(0, 60 - Math.min(60, dueGap));
  return localityBonus + dueBonus - Math.round(distance / 250);
}

function riderWorkloads(routes = [], activeDeliveries = []) {
  const map = new Map();
  for (const route of routes || []) {
    if (!route?.riderId) continue;
    const current = map.get(route.riderId) || { activeRoutes: 0, activeStops: 0, activeDeliveries: 0 };
    current.activeRoutes += ['PENDING', 'DISPATCHED'].includes(route.status) ? 1 : 0;
    current.activeStops += (route.stops || []).filter((stop) => !['DELIVERED', 'ATTEMPTED_FAILED', 'SKIPPED'].includes(stop.status)).length;
    map.set(route.riderId, current);
  }
  for (const delivery of activeDeliveries || []) {
    if (!delivery?.riderId) continue;
    const current = map.get(delivery.riderId) || { activeRoutes: 0, activeStops: 0, activeDeliveries: 0 };
    if (['ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED'].includes(String(delivery.status || '').toUpperCase())) {
      current.activeDeliveries += 1;
    }
    map.set(delivery.riderId, current);
  }
  return map;
}

function activeShiftForRider(rider = {}) {
  if (Array.isArray(rider.shifts)) {
    return rider.shifts.find((shift) => String(shift?.status || '').toUpperCase() === 'OPEN') || null;
  }
  if (rider.activeShift) return rider.activeShift;
  if (rider.shift) return rider.shift;
  if (rider.onShift === true) return { status: 'OPEN' };
  if (rider.onShift === false) return null;
  return undefined;
}

function riderIsAvailable(rider = {}) {
  if (String(rider.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') return false;
  const shift = activeShiftForRider(rider);
  return shift === undefined ? true : !!shift;
}

function recommendRider({ group, riders = [], routes = [], activeDeliveries = [] }) {
  const workloads = riderWorkloads(routes, activeDeliveries);
  const candidates = (riders || []).filter(riderIsAvailable);
  if (!candidates.length) return null;
  const ranked = candidates.map((rider) => {
    const workload = workloads.get(rider.id) || { activeRoutes: 0, activeStops: 0, activeDeliveries: 0 };
    const shift = activeShiftForRider(rider);
    const activeLoad = workload.activeStops + workload.activeDeliveries;
    const capacityAfter = activeLoad + Number(group?.stopCount || 0);
    const locationBonus = rider.homeLocationId && group.locationId && rider.homeLocationId === group.locationId ? 25 : 0;
    const shiftLocationBonus = shift?.locationId && group.locationId && shift.locationId === group.locationId ? 20 : 0;
    const overloadPenalty = capacityAfter > 8 ? 50 + ((capacityAfter - 8) * 8) : 0;
    const score = 100
      + locationBonus
      + shiftLocationBonus
      - (workload.activeStops * 8)
      - (workload.activeDeliveries * 6)
      - (workload.activeRoutes * 12)
      - overloadPenalty;
    return {
      id: rider.id,
      fullName: rider.fullName,
      vehicleType: rider.vehicleType,
      homeLocationId: rider.homeLocationId || null,
      onShift: true,
      shiftId: shift?.id || null,
      shiftStartedAt: shift?.startedAt || null,
      shiftLocationId: shift?.locationId || null,
      activeRoutes: workload.activeRoutes,
      activeStops: workload.activeStops,
      activeDeliveries: workload.activeDeliveries,
      activeLoad,
      capacityAfter,
      capacityStatus: capacityAfter > 8 ? 'OVER_CAPACITY' : capacityAfter >= 6 ? 'NEAR_CAPACITY' : 'AVAILABLE',
      score,
    };
  }).sort((a, b) => b.score - a.score || a.activeLoad - b.activeLoad || String(a.fullName || '').localeCompare(String(b.fullName || '')));
  return ranked[0] || null;
}

function summarizeGroup(items, index, { riders = [], routes = [], activeDeliveries = [] } = {}) {
  const dueDates = items.map((item) => item.dueAt).filter(Boolean).sort((a, b) => a - b);
  const points = items.map((item) => item.point).filter(Boolean);
  const distances = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) distances.push(distanceMeters(points[i], points[j]) || 0);
  }
  const maxDistanceMeters = distances.length ? Math.max(...distances) : null;
  const cashToCollectMinor = items.reduce((sum, item) => sum + item.cashToCollectMinor, 0);
  const group = {
    id: `dispatch-rec-${index + 1}`,
    orderIds: items.map((item) => item.id),
    stopCount: items.length,
    locationId: items[0]?.locationId || null,
    city: items.find((item) => item.city)?.city || null,
    postalCode: items.find((item) => item.postalCode)?.postalCode || null,
    dueAt: dueDates[0] || null,
    latestDueAt: dueDates[dueDates.length - 1] || null,
    cashToCollectMinor,
    itemQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
    metrics: {
      maxDistanceMeters,
      dueWindowMinutes: dueDates.length > 1 ? Math.round((dueDates[dueDates.length - 1].getTime() - dueDates[0].getTime()) / 60000) : 0,
      codOrders: items.filter((item) => item.cashToCollectMinor > 0).length,
    },
  };
  const compactness = maxDistanceMeters == null ? 20 : Math.max(0, 45 - Math.round(maxDistanceMeters / 250));
  const dueUrgency = group.dueAt ? Math.max(0, 60 - Math.max(0, Math.round((group.dueAt.getTime() - Date.now()) / 60000))) : 10;
  group.score = Math.max(0, Math.round(items.length * 15 + compactness + dueUrgency + (cashToCollectMinor > 0 ? 8 : 0)));
  group.reason = items.length === 1
    ? 'Single ready stop'
    : `${items.length} nearby stops${group.city ? ` around ${group.city}` : ''}`;
  group.rider = recommendRider({ group, riders, routes, activeDeliveries });
  return group;
}

function buildDispatchRecommendations({ orders = [], riders = [], routes = [], activeDeliveries = [], maxStops = 8 } = {}) {
  const decorated = orders.map(normalizeOrder).sort((a, b) => {
    const dueA = a.dueAt ? a.dueAt.getTime() : Number.MAX_SAFE_INTEGER;
    const dueB = b.dueAt ? b.dueAt.getTime() : Number.MAX_SAFE_INTEGER;
    if (dueA !== dueB) return dueA - dueB;
    return a.placedAt - b.placedAt;
  });
  const remaining = new Map(decorated.map((item) => [item.id, item]));
  const groups = [];

  for (const seed of decorated) {
    if (!remaining.has(seed.id)) continue;
    const group = [seed];
    remaining.delete(seed.id);
    const candidates = Array.from(remaining.values())
      .map((item) => ({ item, score: candidateScore(seed, item) }))
      .filter((entry) => Number.isFinite(entry.score) && entry.score > -Infinity)
      .sort((a, b) => b.score - a.score);
    for (const { item } of candidates) {
      if (group.length >= maxStops) break;
      if (!remaining.has(item.id)) continue;
      group.push(item);
      remaining.delete(item.id);
    }
    groups.push(group);
  }

  const recommendations = groups
    .map((group, index) => summarizeGroup(group, index, { riders, routes, activeDeliveries }))
    .sort((a, b) => b.score - a.score || a.stopCount - b.stopCount);

  return {
    generatedAt: new Date(),
    groups: recommendations,
  };
}

module.exports = {
  buildDispatchRecommendations,
  distanceMeters,
  normalizeOrder,
  recommendRider,
  riderIsAvailable,
};
