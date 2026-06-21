'use strict';

const crypto = require('crypto');
const prismaDefault = require('./prisma');
const { safeEmit } = require('./webhookDispatcher');
const { sendNotification } = require('./notifications/router');
const { resolveByCoordinates, resolveByPostalCode } = require('./locationResolve');

const DELIVERY_SOURCES = Object.freeze(['SITEPRESSO', 'API', 'MANUAL']);
const DELIVERY_STATUSES = Object.freeze([
  'PENDING',
  'READY_FOR_DISPATCH',
  'ASSIGNED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'ARRIVED',
  'DELIVERED',
  'ATTEMPTED_FAILED',
  'CANCELLED',
  'RETURNED',
]);

const STATUS_EVENTS = Object.freeze({
  READY_FOR_DISPATCH: 'delivery.ready_for_dispatch',
  ASSIGNED: 'delivery.assigned',
  PICKED_UP: 'delivery.picked_up',
  OUT_FOR_DELIVERY: 'delivery.out_for_delivery',
  ARRIVED: 'delivery.arrived',
  DELIVERED: 'delivery.delivered',
  ATTEMPTED_FAILED: 'delivery.attempted_failed',
  CANCELLED: 'delivery.cancelled',
  RETURNED: 'delivery.returned',
});

const ORDER_STATUS_FOR_DELIVERY = Object.freeze({
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  ATTEMPTED_FAILED: 'PACKING',
  RETURNED: 'PACKING',
});

const NOTIFICATION_TEMPLATES = Object.freeze({
  ASSIGNED: 'DELIVERY_ASSIGNED',
  OUT_FOR_DELIVERY: 'DELIVERY_OUT_FOR_DELIVERY',
  ARRIVED: 'DELIVERY_ARRIVED',
  DELIVERED: 'DELIVERY_DELIVERED',
  ATTEMPTED_FAILED: 'DELIVERY_ATTEMPT_FAILED',
});

const DELIVERY_STATUS_LABELS = Object.freeze({
  PENDING: 'Delivery request received',
  READY_FOR_DISPATCH: 'Ready for dispatch',
  ASSIGNED: 'Rider assigned',
  PICKED_UP: 'Picked up',
  OUT_FOR_DELIVERY: 'Out for delivery',
  ARRIVED: 'Rider arrived',
  DELIVERED: 'Delivered',
  ATTEMPTED_FAILED: 'Delivery attempt failed',
  CANCELLED: 'Cancelled',
  RETURNED: 'Returned',
});

const DELIVERY_ACTOR_SOURCES = Object.freeze([
  'ADMIN',
  'API',
  'RIDER',
  'CUSTOMER',
  'WEBHOOK',
  'CRON',
  'SYSTEM',
]);

const DELIVERY_TERMINAL_STATUSES = Object.freeze(['DELIVERED', 'ATTEMPTED_FAILED', 'CANCELLED', 'RETURNED']);
const DELIVERY_STATUS_TRANSITIONS = Object.freeze({
  PENDING: Object.freeze(['READY_FOR_DISPATCH', 'ASSIGNED', 'CANCELLED']),
  READY_FOR_DISPATCH: Object.freeze(['ASSIGNED', 'PICKED_UP', 'CANCELLED']),
  ASSIGNED: Object.freeze(['PICKED_UP', 'OUT_FOR_DELIVERY', 'ATTEMPTED_FAILED', 'CANCELLED', 'RETURNED']),
  PICKED_UP: Object.freeze(['OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED', 'ATTEMPTED_FAILED', 'CANCELLED', 'RETURNED']),
  OUT_FOR_DELIVERY: Object.freeze(['ARRIVED', 'DELIVERED', 'ATTEMPTED_FAILED', 'CANCELLED', 'RETURNED']),
  ARRIVED: Object.freeze(['DELIVERED', 'ATTEMPTED_FAILED', 'CANCELLED', 'RETURNED']),
  ATTEMPTED_FAILED: Object.freeze(['READY_FOR_DISPATCH', 'ASSIGNED', 'CANCELLED', 'RETURNED']),
  DELIVERED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
  RETURNED: Object.freeze([]),
});
const DELIVERY_EXCEPTION_CODES = Object.freeze([
  'CUSTOMER_UNREACHABLE',
  'ADDRESS_ISSUE',
  'CUSTOMER_REFUSED',
  'PAYMENT_ISSUE',
  'RIDER_DELAY',
  'VEHICLE_ISSUE',
  'WEATHER_DELAY',
  'DAMAGED_PACKAGE',
  'OTHER',
]);
const DELIVERY_EXCEPTION_STATUSES = Object.freeze(['OPEN', 'ESCALATED', 'RESOLVED']);

function cleanString(value, max = 500) {
  if (value === undefined || value === null) return null;
  const next = String(value).trim();
  return next ? next.slice(0, max) : null;
}

function cleanEnum(value, allowed, fallback) {
  const next = String(value || '').trim().toUpperCase();
  return allowed.includes(next) ? next : fallback;
}

function cleanDateOrNull(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanExceptionCode(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const next = String(value || '').trim().toUpperCase();
  return DELIVERY_EXCEPTION_CODES.includes(next) ? next : fallback;
}

function cleanExceptionStatus(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const next = String(value || '').trim().toUpperCase();
  return DELIVERY_EXCEPTION_STATUSES.includes(next) ? next : fallback;
}

function deliveryExceptionLabel(code) {
  const labels = {
    CUSTOMER_UNREACHABLE: 'Customer unreachable',
    ADDRESS_ISSUE: 'Address issue',
    CUSTOMER_REFUSED: 'Customer refused',
    PAYMENT_ISSUE: 'Payment issue',
    RIDER_DELAY: 'Rider delayed',
    VEHICLE_ISSUE: 'Vehicle issue',
    WEATHER_DELAY: 'Weather delay',
    DAMAGED_PACKAGE: 'Damaged package',
    OTHER: 'Other issue',
  };
  const key = cleanExceptionCode(code, null);
  return key ? labels[key] || key.replace(/_/g, ' ').toLowerCase() : null;
}

function trackingToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function deliveryProofOtp() {
  return String(crypto.randomInt(1000, 10000));
}

function cleanOtp(value) {
  const next = cleanString(value, 20);
  return next ? next.replace(/\D/g, '').slice(0, 8) : null;
}

function configuredPlatformDomain() {
  return String(process.env.PLATFORM_DOMAIN || process.env.NEXT_PUBLIC_PLATFORM_DOMAIN || 'sitepresso.com')
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function deliveryTrackingPath(row) {
  const token = cleanString(row?.trackingToken || row?.token, 240);
  return token ? `/delivery/${encodeURIComponent(token)}` : null;
}

function deliveryTrackingUrl(row, businessSlug = null) {
  const path = deliveryTrackingPath(row);
  const slug = cleanString(businessSlug || row?.business?.slug || row?.businessSlug, 120);
  if (!path || !slug) return null;

  const domain = configuredPlatformDomain();
  if (domain && !domain.startsWith('localhost') && domain !== '127.0.0.1') {
    return `https://${slug}.${domain}${path}`;
  }

  const explicit = String(process.env.NEXT_PUBLIC_PLATFORM_URL || process.env.FRONTEND_URL || '').replace(/\/+$/, '');
  const base = explicit || `http://${domain || 'localhost:3000'}`;
  return `${base}/${encodeURIComponent(slug)}${path}`;
}

function deliveryPublicCode(row) {
  return cleanString(row?.sourceRef, 40) || String(row?.id || '').slice(0, 8).toUpperCase() || 'delivery';
}

function cleanActorSource(value, fallback = 'SYSTEM') {
  const next = String(value || '').trim().toUpperCase();
  return DELIVERY_ACTOR_SOURCES.includes(next) ? next : fallback;
}

function deliveryStatusLabel(status) {
  const key = String(status || '').trim().toUpperCase();
  return DELIVERY_STATUS_LABELS[key] || key.replace(/_/g, ' ').toLowerCase();
}

function allowedDeliveryStatusTransitions(status) {
  const current = cleanEnum(status, DELIVERY_STATUSES, null);
  return current ? [...(DELIVERY_STATUS_TRANSITIONS[current] || [])] : [];
}

function canTransitionDeliveryStatus(fromStatus, toStatus) {
  const from = cleanEnum(fromStatus, DELIVERY_STATUSES, null);
  const to = cleanEnum(toStatus, DELIVERY_STATUSES, null);
  if (!from || !to) return false;
  if (from === to) return true;
  return allowedDeliveryStatusTransitions(from).includes(to);
}

function deliveryStatusMessage(status) {
  const label = deliveryStatusLabel(status);
  return label ? `Delivery ${label.toLowerCase()}` : 'Delivery updated';
}

function deliveryEventLabel(event = {}) {
  const kind = String(event.kind || '').toUpperCase();
  if (kind === 'CREATED') return 'Delivery request created';
  if (kind === 'RIDER_ASSIGNED') return 'Rider assigned';
  if (kind === 'PROOF_UPLOADED') return 'Proof of delivery uploaded';
  if (kind === 'PAYMENT_CAPTURED') return 'Delivery payment captured';
  if (kind === 'NOTE_ADDED') return 'Delivery note added';
  if (kind === 'STATUS_CHANGED') return deliveryStatusLabel(event.toStatus || event.payload?.toStatus);
  return cleanString(event.message, 300) || 'Delivery updated';
}

function deliveryEventDTO(event, { publicView = false } = {}) {
  if (!event) return null;
  const base = {
    id: event.id,
    kind: event.kind,
    fromStatus: event.fromStatus || null,
    toStatus: event.toStatus || null,
    status: event.toStatus || null,
    message: event.message || deliveryEventLabel(event),
    label: deliveryEventLabel(event),
    at: event.createdAt,
    createdAt: event.createdAt,
  };
  if (publicView) return base;
  return {
    ...base,
    actorUserId: event.actorUserId || null,
    actorSource: event.actorSource || 'SYSTEM',
    payload: event.payload || null,
  };
}

function deliveryLocationDTO(ping) {
  if (!ping) return null;
  return {
    lat: ping.lat,
    lng: ping.lng,
    accuracyMeters: ping.accuracyMeters ?? null,
    headingDegrees: ping.headingDegrees ?? null,
    speedMetersPerSecond: ping.speedMetersPerSecond ?? null,
    at: ping.createdAt,
    createdAt: ping.createdAt,
  };
}

function latestDeliveryLocation(rowOrPings) {
  const pings = Array.isArray(rowOrPings) ? rowOrPings : rowOrPings?.locationPings;
  return deliveryLocationDTO(Array.isArray(pings) && pings.length ? pings[0] : null);
}

function validPoint(lat, lng) {
  if (lat === undefined || lat === null || lat === '' || lng === undefined || lng === null || lng === '') return null;
  const nextLat = Number(lat);
  const nextLng = Number(lng);
  if (!Number.isFinite(nextLat) || !Number.isFinite(nextLng)) return null;
  if (nextLat < -90 || nextLat > 90 || nextLng < -180 || nextLng > 180) return null;
  return { lat: nextLat, lng: nextLng };
}

function pointFromRow(row, prefix) {
  if (!row) return null;
  return validPoint(row[`${prefix}Lat`], row[`${prefix}Lng`]);
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

function activeReferencePoint(row) {
  const latest = latestDeliveryLocation(row);
  if (latest) return { point: validPoint(latest.lat, latest.lng), basedOn: 'RIDER_LOCATION' };
  const pickup = pointFromRow(row, 'pickup');
  if (pickup) return { point: pickup, basedOn: 'PICKUP_DROPOFF' };
  return { point: null, basedOn: 'STATUS_DEFAULT' };
}

function estimateDeliveryMinutes(row, meters = null) {
  const status = String(row?.status || 'PENDING').toUpperCase();
  const baseByStatus = {
    PENDING: 45,
    READY_FOR_DISPATCH: 35,
    ASSIGNED: 30,
    PICKED_UP: 22,
    OUT_FOR_DELIVERY: 18,
    ARRIVED: 5,
  };
  if (status === 'ARRIVED') return 5;
  if (Number.isFinite(meters) && meters >= 0) {
    const cityMetersPerMinute = 250; // 15 km/h plus stop/start traffic.
    const buffer = ['PENDING', 'READY_FOR_DISPATCH', 'ASSIGNED'].includes(status) ? 12 : 5;
    return Math.max(6, Math.min(180, Math.ceil(meters / cityMetersPerMinute) + buffer));
  }
  return baseByStatus[status] || 30;
}

function chooseDueAt(row) {
  return row?.promisedAt || row?.requestedDropoffAt || null;
}

function computeDeliveryDispatchMeta(row, { now = new Date() } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  const status = String(row?.status || 'PENDING').toUpperCase();
  const terminal = DELIVERY_TERMINAL_STATUSES.includes(status);
  const dueAtRaw = chooseDueAt(row);
  const dueAt = dueAtRaw ? new Date(dueAtRaw) : null;
  const retryAtRaw = row?.nextAttemptAt || null;
  const retryAt = retryAtRaw ? new Date(retryAtRaw) : null;
  const hasRetryAt = retryAt && !Number.isNaN(retryAt.getTime());
  const minutesUntilRetry = hasRetryAt ? Math.round((retryAt.getTime() - current.getTime()) / 60000) : null;
  const dropoff = pointFromRow(row, 'dropoff');
  const ref = activeReferencePoint(row);
  const meters = dropoff && ref.point ? distanceMeters(ref.point, dropoff) : null;
  const estimateMinutes = terminal ? null : estimateDeliveryMinutes(row, meters);
  const estimatedArrivalAt = estimateMinutes != null
    ? new Date(current.getTime() + estimateMinutes * 60 * 1000)
    : null;
  const minutesUntilDue = dueAt ? Math.round((dueAt.getTime() - current.getTime()) / 60000) : null;
  const etaDeltaMinutes = dueAt && estimatedArrivalAt
    ? Math.round((estimatedArrivalAt.getTime() - dueAt.getTime()) / 60000)
    : null;

  let slaStatus = 'UNCOMMITTED';
  if (status === 'DELIVERED') slaStatus = 'COMPLETE';
  else if (['CANCELLED', 'RETURNED'].includes(status)) slaStatus = 'CLOSED';
  else if (status === 'ATTEMPTED_FAILED' && hasRetryAt && minutesUntilRetry > 15) slaStatus = 'ON_TRACK';
  else if (status === 'ATTEMPTED_FAILED' && hasRetryAt && minutesUntilRetry >= 0) slaStatus = 'DUE_SOON';
  else if (row?.exceptionStatus === 'ESCALATED') slaStatus = 'EXCEPTION';
  else if (status === 'ATTEMPTED_FAILED' || row?.exceptionStatus === 'OPEN') slaStatus = 'EXCEPTION';
  else if (dueAt) {
    if (minutesUntilDue < 0) slaStatus = 'BREACHED';
    else if (etaDeltaMinutes != null && etaDeltaMinutes > 0) slaStatus = 'AT_RISK';
    else if (minutesUntilDue <= 15) slaStatus = 'DUE_SOON';
    else slaStatus = 'ON_TRACK';
  }

  const priorityBoost = String(row?.priority || '').toUpperCase() === 'URGENT' ? 25 : 0;
  const statusBoost = {
    PENDING: 20,
    READY_FOR_DISPATCH: 35,
    ASSIGNED: 25,
    PICKED_UP: 20,
    OUT_FOR_DELIVERY: 18,
    ARRIVED: 15,
    ATTEMPTED_FAILED: 80,
  }[status] || 0;
  const slaBoost = {
    BREACHED: 100,
    AT_RISK: 75,
    DUE_SOON: 55,
    EXCEPTION: 90,
    UNCOMMITTED: 15,
    ON_TRACK: 25,
    COMPLETE: -50,
    CLOSED: -40,
  }[slaStatus] || 0;
  const dueBoost = minutesUntilDue == null ? 0 : Math.max(0, 60 - Math.min(60, minutesUntilDue));
  const retryBoost = minutesUntilRetry == null ? null : Math.max(20, 80 - Math.max(0, Math.min(80, minutesUntilRetry)));
  const urgencyScore = terminal
    ? Math.max(0, status === 'ATTEMPTED_FAILED' ? (retryBoost ?? 50) : 0)
    : Math.max(0, Math.round(priorityBoost + statusBoost + slaBoost + dueBoost));

  let recommendedAction = 'Monitor delivery';
  if (status === 'PENDING' || status === 'READY_FOR_DISPATCH') recommendedAction = row?.riderId ? 'Dispatch rider' : 'Assign rider';
  else if (status === 'ASSIGNED') recommendedAction = 'Confirm pickup';
  else if (status === 'PICKED_UP' || status === 'OUT_FOR_DELIVERY') recommendedAction = slaStatus === 'AT_RISK' || slaStatus === 'BREACHED' ? 'Contact rider' : 'Monitor ETA';
  else if (status === 'ARRIVED') recommendedAction = 'Complete handoff';
  else if (status === 'ATTEMPTED_FAILED' && hasRetryAt && minutesUntilRetry > 0) recommendedAction = 'Retry scheduled';
  else if (status === 'ATTEMPTED_FAILED' && hasRetryAt) recommendedAction = 'Retry due';
  else if (status === 'ATTEMPTED_FAILED' || row?.exceptionStatus === 'OPEN' || row?.exceptionStatus === 'ESCALATED') recommendedAction = row?.exceptionStatus === 'ESCALATED' ? 'Escalate with manager' : 'Resolve exception';
  else if (terminal) recommendedAction = 'No action needed';
  if (slaStatus === 'BREACHED' && !terminal) recommendedAction = 'Escalate late delivery';

  return {
    dueAt,
    dueSource: row?.promisedAt ? 'PROMISED_AT' : row?.requestedDropoffAt ? 'REQUESTED_DROPOFF_AT' : null,
    minutesUntilDue,
    slaStatus,
    urgencyScore,
    recommendedAction,
    eta: {
      estimatedArrivalAt,
      estimateMinutes,
      distanceMeters: meters,
      basedOn: ref.basedOn,
      etaDeltaMinutes,
    },
    retry: {
      nextAttemptAt: hasRetryAt ? retryAt : null,
      minutesUntilRetry,
      isDue: hasRetryAt ? minutesUntilRetry <= 0 : false,
    },
  };
}

async function recordDeliveryEvent({
  prisma = prismaDefault,
  businessId,
  deliveryRequestId,
  kind,
  fromStatus = null,
  toStatus = null,
  message = null,
  actorUserId = null,
  actorSource = 'SYSTEM',
  payload = null,
} = {}) {
  if (!businessId || !deliveryRequestId || !kind || !prisma?.ecomDeliveryRequestEvent?.create) {
    return null;
  }
  return prisma.ecomDeliveryRequestEvent.create({
    data: {
      businessId,
      deliveryRequestId,
      kind: cleanString(kind, 80) || 'EVENT',
      fromStatus: cleanString(fromStatus, 80),
      toStatus: cleanString(toStatus, 80),
      message: cleanString(message, 1000),
      actorUserId: cleanString(actorUserId, 80),
      actorSource: cleanActorSource(actorSource),
      payload: payload && typeof payload === 'object' ? payload : null,
    },
  });
}

async function notifyDeliveryCustomer({
  prisma = prismaDefault,
  businessId,
  delivery,
  status,
} = {}) {
  const templateKey = NOTIFICATION_TEMPLATES[status];
  if (!templateKey || !businessId || !delivery) return null;
  if (!delivery.customerPhone && !delivery.customerEmail) return null;

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { name: true, slug: true, country: true },
  });
  const trackingUrl = deliveryTrackingUrl({ ...delivery, business }, business?.slug);
  if (!trackingUrl) return null;

  return sendNotification({
    businessId,
    recipientPhone: delivery.customerPhone || undefined,
    recipientEmail: delivery.customerEmail || undefined,
    recipientCountry: delivery.dropoffCountry || business?.country || undefined,
    templateKey,
    variables: {
      BIZ: business?.name || 'Store',
      ID: deliveryPublicCode(delivery),
      LINK: trackingUrl,
      OTP: cleanOtp(delivery.proofOtp) || 'on tracking page',
      REASON: cleanString(delivery.failureReason || delivery.notes, 120) || 'delivery could not be completed',
    },
    triggeredBy: `DELIVERY_${status}`,
    orderId: delivery.orderId || undefined,
  });
}

function statusTimestampPatch(status, now = new Date()) {
  if (status === 'ASSIGNED') return { assignedAt: now };
  if (status === 'PICKED_UP') return { pickedUpAt: now };
  if (status === 'ARRIVED') return { arrivedAt: now };
  if (status === 'DELIVERED') return { deliveredAt: now };
  if (status === 'ATTEMPTED_FAILED') return { failedAt: now };
  if (status === 'CANCELLED') return { cancelledAt: now };
  if (status === 'RETURNED') return { returnedAt: now };
  return {};
}

function deliveryWebhookPayload(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    sourceRef: row.sourceRef || null,
    channel: row.channel || null,
    status: row.status,
    priority: row.priority,
    businessId: row.businessId,
    locationId: row.locationId || null,
    orderId: row.orderId || null,
    riderId: row.riderId || null,
    customerName: row.customerName,
    customerPhone: row.customerPhone || null,
    customerEmail: row.customerEmail || null,
    currency: row.currency,
    paymentMethod: row.paymentMethod || null,
    cashToCollectMinor: row.cashToCollectMinor,
    cashCollectedMinor: row.cashCollectedMinor,
    attemptCount: row.attemptCount || 0,
    nextAttemptAt: row.nextAttemptAt || null,
    trackingToken: row.trackingToken,
    trackingPath: deliveryTrackingPath(row),
    trackingUrl: deliveryTrackingUrl(row),
    promisedAt: row.promisedAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deliveredAt: row.deliveredAt || null,
    failureReason: row.failureReason || null,
    exceptionCode: row.exceptionCode || null,
    exceptionStatus: row.exceptionStatus || null,
    exceptionLabel: deliveryExceptionLabel(row.exceptionCode),
  };
}

function addressFromJson(address = {}) {
  const a = address && typeof address === 'object' ? address : {};
  return {
    name: cleanString(a.name || a.fullName || a.recipientName, 160),
    address1: cleanString(a.line1 || a.address1 || a.addressLine1 || a.street, 500),
    address2: cleanString(a.line2 || a.address2 || a.addressLine2, 500),
    city: cleanString(a.city, 160),
    state: cleanString(a.state || a.region, 160),
    postalCode: cleanString(a.postalCode || a.postcode || a.zip, 40),
    country: cleanString(a.country || a.countryCode, 4)?.toUpperCase() || null,
    lat: Number.isFinite(Number(a.lat ?? a.latitude)) ? Number(a.lat ?? a.latitude) : null,
    lng: Number.isFinite(Number(a.lng ?? a.lon ?? a.longitude)) ? Number(a.lng ?? a.lon ?? a.longitude) : null,
  };
}

function itemSnapshots(order) {
  return (order?.items || []).map((item) => ({
    id: item.id,
    productId: item.productId || null,
    name: item.productName,
    quantity: item.quantity,
    priceMinor: item.priceMinor,
    lineTotalMinor: item.lineTotalMinor,
  }));
}

async function defaultPickupForBusiness({ prisma, businessId, locationId }) {
  const location = locationId
    ? await prisma.businessLocation.findFirst({ where: { id: locationId, businessId } })
    : await prisma.businessLocation.findFirst({
        where: { businessId, isActive: true },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      });
  if (location) {
    return {
      name: location.name,
      address1: location.addressLine1,
      address2: location.addressLine2,
      city: location.city,
      state: location.state,
      postalCode: location.postalCode,
      country: location.country,
      lat: null,
      lng: null,
    };
  }
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { name: true, address: true, state: true, country: true },
  });
  return {
    name: business?.name || null,
    address1: business?.address || null,
    address2: null,
    city: null,
    state: business?.state || null,
    postalCode: null,
    country: business?.country || null,
    lat: null,
    lng: null,
  };
}

async function ensureLocationBelongsToBusiness({ prisma, businessId, locationId }) {
  if (!locationId) return null;
  const location = await prisma.businessLocation.findFirst({
    where: { id: locationId, businessId },
    select: { id: true },
  });
  if (!location) {
    const err = new Error('Location not found');
    err.status = 404;
    throw err;
  }
  return location;
}

async function ensureRiderBelongsToBusiness({ prisma, businessId, riderId }) {
  if (!riderId) return null;
  const rider = await prisma.ecomRider.findFirst({
    where: { id: riderId, businessId, status: { in: ['ACTIVE', 'OFF_SHIFT'] } },
    select: { id: true, fullName: true, status: true },
  });
  if (!rider) {
    const err = new Error('Rider not found or not available');
    err.status = 404;
    throw err;
  }
  return rider;
}

async function resolveDeliveryServiceArea({ prisma, businessId, data, now = new Date() }) {
  if (!businessId || !data || data.locationId) return null;

  const point = validPoint(data.dropoff?.lat, data.dropoff?.lng);
  const postalCode = cleanString(data.dropoff?.postalCode, 40);
  if (!point && !postalCode) return null;

  const result = point
    ? await resolveByCoordinates({ prisma, businessId, lat: point.lat, lng: point.lng })
    : await resolveByPostalCode({ prisma, businessId, postalCode });
  const candidate = result.candidates?.[0] || null;
  if (candidate?.location?.id) {
    data.locationId = candidate.location.id;
    if (!data.promisedAt && !data.requestedDropoffAt && Number(candidate.zone?.promiseMinutes) > 0) {
      data.promisedAt = new Date(now.getTime() + Number(candidate.zone.promiseMinutes) * 60 * 1000);
    }
    return {
      mode: point ? 'coordinates' : 'postalCode',
      locationId: candidate.location.id,
      locationName: candidate.location.name || null,
      zoneId: candidate.zone?.id || null,
      zoneName: candidate.zone?.name || null,
      promiseMinutes: candidate.zone?.promiseMinutes || null,
      deliveryFeeMinor: candidate.zone?.deliveryFeeMinor || 0,
    };
  }

  const activeZoneCount = await prisma.ecomDeliveryZone.count({ where: { businessId, isActive: true } });
  if (activeZoneCount > 0) {
    const err = new Error('Dropoff is outside configured delivery areas');
    err.status = 422;
    err.reason = 'SERVICE_AREA_UNAVAILABLE';
    throw err;
  }
  return null;
}

function normalizeDeliveryInput(input = {}) {
  const pickup = addressFromJson(input.pickup || {});
  const dropoff = addressFromJson(input.dropoff || input.shippingAddress || {});
  const source = cleanEnum(input.source, DELIVERY_SOURCES, 'MANUAL');
  const status = cleanEnum(input.status, DELIVERY_STATUSES, 'PENDING');
  return {
    source,
    sourceRef: cleanString(input.sourceRef || input.externalRef || input.externalOrderId, 180),
    channel: cleanString(input.channel, 80),
    status,
    priority: cleanString(input.priority, 40) || 'NORMAL',
    locationId: cleanString(input.locationId, 80),
    orderId: cleanString(input.orderId, 80),
    riderId: cleanString(input.riderId, 80),
    customerName: cleanString(input.customerName, 160) || dropoff.name || 'Customer',
    customerPhone: cleanString(input.customerPhone || input.phone, 60),
    customerEmail: cleanString(input.customerEmail || input.email, 200),
    pickup,
    dropoff,
    items: Array.isArray(input.items) ? input.items : [],
    packageNote: cleanString(input.packageNote || input.packageDescription, 1000),
    deliverySlotLabel: cleanString(input.deliverySlotLabel, 160),
    requestedPickupAt: input.requestedPickupAt ? new Date(input.requestedPickupAt) : null,
    requestedDropoffAt: input.requestedDropoffAt ? new Date(input.requestedDropoffAt) : null,
    promisedAt: input.promisedAt ? new Date(input.promisedAt) : null,
    currency: cleanString(input.currency, 3)?.toUpperCase() || 'INR',
    paymentMethod: cleanString(input.paymentMethod, 40)?.toLowerCase() || null,
    cashToCollectMinor: Math.max(0, Number.parseInt(input.cashToCollectMinor || 0, 10) || 0),
    proofOtp: cleanOtp(input.proofOtp) || deliveryProofOtp(),
    notes: cleanString(input.notes, 2000),
  };
}

async function createDeliveryRequest({
  prisma = prismaDefault,
  businessId,
  input,
  actorUserId = null,
  actorSource = null,
  emitEvents = true,
} = {}) {
  if (!businessId) {
    const err = new Error('No business in scope');
    err.status = 403;
    throw err;
  }

  const data = normalizeDeliveryInput(input);
  const now = new Date();
  const serviceArea = await resolveDeliveryServiceArea({ prisma, businessId, data, now });
  await ensureLocationBelongsToBusiness({ prisma, businessId, locationId: data.locationId });
  await ensureRiderBelongsToBusiness({ prisma, businessId, riderId: data.riderId });

  if (data.sourceRef) {
    const existing = await prisma.ecomDeliveryRequest.findFirst({
      where: { businessId, source: data.source, sourceRef: data.sourceRef },
    });
    if (existing) return { delivery: existing, created: false };
  }

  const status = data.riderId && data.status === 'PENDING' ? 'ASSIGNED' : data.status;
  const delivery = await prisma.ecomDeliveryRequest.create({
    data: {
      businessId,
      locationId: data.locationId || null,
      orderId: data.orderId || null,
      source: data.source,
      sourceRef: data.sourceRef,
      channel: data.channel,
      status,
      priority: data.priority,
      riderId: data.riderId || null,
      customerName: data.customerName,
      customerPhone: data.customerPhone,
      customerEmail: data.customerEmail,
      pickupName: data.pickup.name,
      pickupAddress1: data.pickup.address1,
      pickupAddress2: data.pickup.address2,
      pickupCity: data.pickup.city,
      pickupState: data.pickup.state,
      pickupPostalCode: data.pickup.postalCode,
      pickupCountry: data.pickup.country,
      pickupLat: data.pickup.lat,
      pickupLng: data.pickup.lng,
      dropoffName: data.dropoff.name,
      dropoffAddress1: data.dropoff.address1,
      dropoffAddress2: data.dropoff.address2,
      dropoffCity: data.dropoff.city,
      dropoffState: data.dropoff.state,
      dropoffPostalCode: data.dropoff.postalCode,
      dropoffCountry: data.dropoff.country,
      dropoffLat: data.dropoff.lat,
      dropoffLng: data.dropoff.lng,
      items: data.items,
      packageNote: data.packageNote,
      deliverySlotLabel: data.deliverySlotLabel,
      requestedPickupAt: data.requestedPickupAt,
      requestedDropoffAt: data.requestedDropoffAt,
      promisedAt: data.promisedAt,
      currency: data.currency,
      paymentMethod: data.paymentMethod,
      cashToCollectMinor: data.cashToCollectMinor,
      proofOtp: data.proofOtp,
      trackingToken: trackingToken(),
      notes: data.notes,
      ...(status === 'ASSIGNED' ? { assignedAt: now } : {}),
    },
  });
  const eventActorSource = cleanActorSource(actorSource || (data.source === 'API' ? 'API' : actorUserId ? 'ADMIN' : 'SYSTEM'));
  await recordDeliveryEvent({
    prisma,
    businessId,
    deliveryRequestId: delivery.id,
    kind: 'CREATED',
    toStatus: delivery.status,
    message: `Delivery request created from ${delivery.source.toLowerCase()}`,
    actorUserId,
    actorSource: eventActorSource,
    payload: {
      source: delivery.source,
      sourceRef: delivery.sourceRef || null,
      channel: delivery.channel || null,
      orderId: delivery.orderId || null,
      locationId: delivery.locationId || null,
      riderId: delivery.riderId || null,
      trackingToken: delivery.trackingToken,
      serviceArea,
    },
  });
  if (delivery.riderId) {
    await recordDeliveryEvent({
      prisma,
      businessId,
      deliveryRequestId: delivery.id,
      kind: 'RIDER_ASSIGNED',
      fromStatus: 'PENDING',
      toStatus: delivery.status,
      message: 'Rider assigned',
      actorUserId,
      actorSource: eventActorSource,
      payload: { riderId: delivery.riderId },
    });
  }
  if (delivery.status !== 'PENDING') {
    await recordDeliveryEvent({
      prisma,
      businessId,
      deliveryRequestId: delivery.id,
      kind: 'STATUS_CHANGED',
      fromStatus: 'PENDING',
      toStatus: delivery.status,
      message: deliveryStatusMessage(delivery.status),
      actorUserId,
      actorSource: eventActorSource,
      payload: { source: delivery.source, sourceRef: delivery.sourceRef || null },
    });
  }

  if (emitEvents) {
    safeEmit('delivery.created', deliveryWebhookPayload(delivery), businessId);
    if (delivery.status !== 'PENDING' && STATUS_EVENTS[delivery.status]) {
      safeEmit(STATUS_EVENTS[delivery.status], deliveryWebhookPayload(delivery), businessId);
      notifyDeliveryCustomer({ prisma, businessId, delivery, status: delivery.status }).catch(() => {});
    }
  }

  if (actorUserId && delivery.orderId) {
    await prisma.ecomOrderEvent.create({
      data: {
        businessId,
        orderId: delivery.orderId,
        kind: 'DELIVERY_REQUEST_CREATED',
        message: `Delivery request created from ${delivery.source.toLowerCase()}`,
        actorUserId,
        actorSource: 'ADMIN',
        payload: { deliveryRequestId: delivery.id, source: delivery.source },
      },
    }).catch(() => {});
  }

  return { delivery, created: true };
}

async function createDeliveryRequestFromOrder({
  prisma = prismaDefault,
  order,
  orderId,
  businessId,
  status = 'READY_FOR_DISPATCH',
  actorUserId = null,
  emitEvents = true,
} = {}) {
  const fullOrder = order || await prisma.order.findFirst({
    where: { id: orderId, ...(businessId ? { businessId } : {}) },
    include: { items: true, business: true, location: true },
  });
  if (!fullOrder) {
    const err = new Error('Order not found');
    err.status = 404;
    throw err;
  }
  if (fullOrder.fulfillmentType !== 'DELIVERY') {
    const err = new Error('Only delivery orders can create delivery requests');
    err.status = 409;
    throw err;
  }
  const pickup = await defaultPickupForBusiness({
    prisma,
    businessId: fullOrder.businessId,
    locationId: fullOrder.locationId,
  });
  const dropoff = addressFromJson(fullOrder.shippingAddress || {});
  const cashDue = fullOrder.paymentMethod === 'cod' && !fullOrder.paidAt
    ? Number(fullOrder.adjustedTotalMinor || fullOrder.totalMinor || 0)
    : 0;

  return createDeliveryRequest({
    prisma,
    businessId: fullOrder.businessId,
    actorUserId,
    emitEvents,
    input: {
      source: 'SITEPRESSO',
      sourceRef: fullOrder.id,
      channel: 'sitepresso',
      status,
      locationId: fullOrder.locationId,
      orderId: fullOrder.id,
      customerName: fullOrder.customerName,
      customerPhone: fullOrder.customerPhone,
      customerEmail: fullOrder.customerEmail,
      pickup,
      dropoff,
      items: itemSnapshots(fullOrder),
      packageNote: fullOrder.notes,
      deliverySlotLabel: fullOrder.deliverySlotLabel,
      promisedAt: fullOrder.promisedAt,
      currency: fullOrder.currency,
      paymentMethod: fullOrder.paymentMethod,
      cashToCollectMinor: cashDue,
    },
  });
}

function exceptionPatchForStatusChange({ existing, next, patch = {}, now = new Date() }) {
  const data = {};
  const explicitCode = patch.exceptionCode !== undefined;
  const explicitStatus = patch.exceptionStatus !== undefined;
  const explicitNote = patch.exceptionNote !== undefined;
  const explicitResolution = patch.exceptionResolutionNote !== undefined;

  const nextCode = explicitCode ? cleanExceptionCode(patch.exceptionCode, existing.exceptionCode || 'OTHER') : existing.exceptionCode;
  const nextStatus = explicitStatus ? cleanExceptionStatus(patch.exceptionStatus, existing.exceptionStatus) : existing.exceptionStatus;

  if (next === 'ATTEMPTED_FAILED') {
    data.exceptionCode = nextCode || 'OTHER';
    data.exceptionStatus = nextStatus || 'OPEN';
    data.exceptionOpenedAt = existing.exceptionOpenedAt || now;
    data.exceptionResolvedAt = data.exceptionStatus === 'RESOLVED' ? (existing.exceptionResolvedAt || now) : null;
    data.exceptionEscalatedAt = data.exceptionStatus === 'ESCALATED' ? (existing.exceptionEscalatedAt || now) : existing.exceptionEscalatedAt;
  } else if (existing.exceptionStatus && existing.exceptionStatus !== 'RESOLVED' && next !== existing.status) {
    data.exceptionStatus = nextStatus || 'RESOLVED';
    data.exceptionResolvedAt = now;
  } else if (explicitStatus) {
    data.exceptionStatus = nextStatus;
    if (nextStatus === 'ESCALATED') data.exceptionEscalatedAt = existing.exceptionEscalatedAt || now;
    if (nextStatus === 'RESOLVED') data.exceptionResolvedAt = existing.exceptionResolvedAt || now;
  }

  if (explicitCode) data.exceptionCode = nextCode;
  if (explicitNote) data.exceptionNote = cleanString(patch.exceptionNote, 1000);
  if (explicitResolution) data.exceptionResolutionNote = cleanString(patch.exceptionResolutionNote, 1000);

  return data;
}

async function updateDeliveryRequestStatus({
  prisma = prismaDefault,
  businessId,
  id,
  status,
  patch = {},
  actorUserId = null,
  actorSource = 'ADMIN',
  emitEvents = true,
} = {}) {
  const next = cleanEnum(status, DELIVERY_STATUSES, null);
  if (!next) {
    const err = new Error('Invalid delivery status');
    err.status = 400;
    throw err;
  }
  const existing = await prisma.ecomDeliveryRequest.findFirst({
    where: { id, businessId },
  });
  if (!existing) {
    const err = new Error('Delivery request not found');
    err.status = 404;
    throw err;
  }
  if (!canTransitionDeliveryStatus(existing.status, next)) {
    const err = new Error(`Cannot transition delivery from ${existing.status} to ${next}`);
    err.status = 409;
    err.reason = 'INVALID_STATUS_TRANSITION';
    err.allowedTransitions = allowedDeliveryStatusTransitions(existing.status);
    throw err;
  }
  if (patch.riderId !== undefined && patch.riderId) {
    await ensureRiderBelongsToBusiness({ prisma, businessId, riderId: patch.riderId });
  }

  const isCodDue = existing.paymentMethod === 'cod' && existing.cashToCollectMinor > 0;
  const cashReceivedMinor = patch.cashReceivedMinor !== undefined
    ? Math.max(0, Number.parseInt(patch.cashReceivedMinor, 10) || 0)
    : existing.cashReceivedMinor;
  const cashChangeDueMinor = patch.cashChangeDueMinor !== undefined
    ? Math.max(0, Number.parseInt(patch.cashChangeDueMinor, 10) || 0)
    : existing.cashChangeDueMinor;
  const cashCollectedMinor = patch.cashCollectedMinor !== undefined
    ? Math.max(0, Number.parseInt(patch.cashCollectedMinor, 10) || 0)
    : Math.max(0, cashReceivedMinor - cashChangeDueMinor);

  if (next === 'DELIVERED' && isCodDue && cashCollectedMinor < existing.cashToCollectMinor) {
    const err = new Error('Cash collected is less than the COD amount due');
    err.status = 400;
    err.reason = 'CASH_SHORT';
    throw err;
  }

  if (next === 'DELIVERED' && actorSource === 'RIDER' && existing.proofOtp) {
    const providedOtp = cleanOtp(patch.proofOtp || patch.deliveryOtp || patch.otp);
    if (providedOtp !== cleanOtp(existing.proofOtp)) {
      const err = new Error('Delivery OTP does not match');
      err.status = 400;
      err.reason = 'OTP_MISMATCH';
      throw err;
    }
  }

  const now = new Date();
  const explicitNextAttemptAt = patch.nextAttemptAt !== undefined;
  const scheduledNextAttemptAt = explicitNextAttemptAt
    ? cleanDateOrNull(patch.nextAttemptAt)
    : (existing.status === 'ATTEMPTED_FAILED' && next !== 'ATTEMPTED_FAILED' ? null : existing.nextAttemptAt);
  const attemptCount = next === 'ATTEMPTED_FAILED' && existing.status !== 'ATTEMPTED_FAILED'
    ? Number(existing.attemptCount || 0) + 1
    : Number(existing.attemptCount || 0);
  const exceptionState = exceptionPatchForStatusChange({ existing, next, patch, now });
  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.ecomDeliveryRequest.update({
      where: { id: existing.id },
      data: {
        status: next,
        riderId: patch.riderId !== undefined ? patch.riderId || null : existing.riderId,
        proofPhotoUrl: cleanString(patch.proofPhotoUrl, 2048) || existing.proofPhotoUrl,
        proofSignatureUrl: cleanString(patch.proofSignatureUrl, 2048) || existing.proofSignatureUrl,
        customerRating: patch.customerRating !== undefined ? Number.parseInt(patch.customerRating, 10) || null : existing.customerRating,
        customerFeedback: cleanString(patch.customerFeedback, 1000) || existing.customerFeedback,
        failureReason: cleanString(patch.failureReason, 500) || existing.failureReason,
        notes: patch.notes !== undefined ? cleanString(patch.notes, 2000) : existing.notes,
        cashCollectedMinor,
        cashReceivedMinor,
        cashChangeDueMinor,
        paymentReference: cleanString(patch.paymentReference, 160) || existing.paymentReference,
        paymentNote: cleanString(patch.paymentNote, 1000) || existing.paymentNote,
        attemptCount,
        nextAttemptAt: scheduledNextAttemptAt,
        ...exceptionState,
        ...(next === 'ASSIGNED' && !existing.assignedAt ? { assignedAt: now } : {}),
        ...statusTimestampPatch(next, now),
      },
    });

    const orderStatus = ORDER_STATUS_FOR_DELIVERY[next];
    if (existing.orderId && orderStatus) {
      await tx.order.updateMany({
        where: { id: existing.orderId, businessId },
        data: {
          status: orderStatus,
          ...(orderStatus === 'DELIVERED' ? { deliveredAt: now } : {}),
          ...(orderStatus === 'DELIVERED' && isCodDue ? { paidAt: now } : {}),
        },
      });
      await tx.ecomOrderEvent.create({
        data: {
          businessId,
          orderId: existing.orderId,
          kind: 'DELIVERY_STATUS_CHANGED',
          fromStatus: existing.status,
          toStatus: next,
          message: `Delivery ${next.replace(/_/g, ' ').toLowerCase()}`,
          actorUserId,
          actorSource,
          payload: { deliveryRequestId: existing.id, deliveryStatus: next },
        },
      });
    }

    if (existing.orderId && ['DELIVERED', 'ATTEMPTED_FAILED', 'RETURNED'].includes(next)) {
      await tx.ecomDeliveryRouteStop.updateMany({
        where: { orderId: existing.orderId },
        data: {
          deliveryRequestId: existing.id,
          ...(next === 'DELIVERED' ? {
            status: 'DELIVERED',
            deliveredAt: now,
            proofPhotoUrl: saved.proofPhotoUrl,
            proofSignatureUrl: saved.proofSignatureUrl,
            cashCollectedMinor: saved.cashCollectedMinor,
            cashReceivedMinor: saved.cashReceivedMinor,
            cashChangeDueMinor: saved.cashChangeDueMinor,
            paymentReference: saved.paymentReference,
            paymentNote: saved.paymentNote,
          } : {}),
          ...(next === 'ATTEMPTED_FAILED' ? { status: 'ATTEMPTED_FAILED', notes: saved.failureReason || saved.notes } : {}),
          ...(next === 'RETURNED' ? { status: 'SKIPPED', notes: saved.failureReason || saved.notes } : {}),
        },
      });
    }

    const eventPayload = {
      source: saved.source,
      sourceRef: saved.sourceRef || null,
      orderId: saved.orderId || null,
      riderId: saved.riderId || null,
      proofPhotoUrl: saved.proofPhotoUrl || null,
      proofSignatureUrl: saved.proofSignatureUrl || null,
      proofOtpVerified: next === 'DELIVERED' && actorSource === 'RIDER' && Boolean(existing.proofOtp),
      cashToCollectMinor: saved.cashToCollectMinor,
      cashCollectedMinor: saved.cashCollectedMinor,
      cashReceivedMinor: saved.cashReceivedMinor,
      cashChangeDueMinor: saved.cashChangeDueMinor,
      paymentReference: saved.paymentReference || null,
      failureReason: saved.failureReason || null,
      attemptCount: saved.attemptCount || 0,
      nextAttemptAt: saved.nextAttemptAt || null,
      exceptionCode: saved.exceptionCode || null,
      exceptionStatus: saved.exceptionStatus || null,
      exceptionNote: saved.exceptionNote || null,
      exceptionResolutionNote: saved.exceptionResolutionNote || null,
      notes: saved.notes || null,
    };
    if (existing.status !== next) {
      await recordDeliveryEvent({
        prisma: tx,
        businessId,
        deliveryRequestId: existing.id,
        kind: 'STATUS_CHANGED',
        fromStatus: existing.status,
        toStatus: next,
        message: deliveryStatusMessage(next),
        actorUserId,
        actorSource,
        payload: eventPayload,
      });
    }
    const exceptionChanged = saved.exceptionCode !== existing.exceptionCode
      || saved.exceptionStatus !== existing.exceptionStatus
      || saved.exceptionNote !== existing.exceptionNote
      || saved.exceptionResolutionNote !== existing.exceptionResolutionNote;
    if (exceptionChanged && (saved.exceptionCode || saved.exceptionStatus)) {
      const kind = saved.exceptionStatus === 'RESOLVED'
        ? 'EXCEPTION_RESOLVED'
        : saved.exceptionStatus === 'ESCALATED'
          ? 'EXCEPTION_ESCALATED'
          : 'EXCEPTION_OPENED';
      await recordDeliveryEvent({
        prisma: tx,
        businessId,
        deliveryRequestId: existing.id,
        kind,
        fromStatus: existing.status,
        toStatus: next,
        message: deliveryExceptionLabel(saved.exceptionCode) || 'Delivery exception updated',
        actorUserId,
        actorSource,
        payload: {
          ...eventPayload,
          exceptionLabel: deliveryExceptionLabel(saved.exceptionCode),
        },
      });
    }
    if (saved.riderId && saved.riderId !== existing.riderId) {
      await recordDeliveryEvent({
        prisma: tx,
        businessId,
        deliveryRequestId: existing.id,
        kind: 'RIDER_ASSIGNED',
        fromStatus: existing.status,
        toStatus: next,
        message: 'Rider assigned',
        actorUserId,
        actorSource,
        payload: { riderId: saved.riderId },
      });
    }
    if (patch.proofPhotoUrl || patch.proofSignatureUrl) {
      await recordDeliveryEvent({
        prisma: tx,
        businessId,
        deliveryRequestId: existing.id,
        kind: 'PROOF_UPLOADED',
        fromStatus: existing.status,
        toStatus: next,
        message: 'Proof of delivery uploaded',
        actorUserId,
        actorSource,
        payload: {
          proofPhotoUrl: saved.proofPhotoUrl || null,
          proofSignatureUrl: saved.proofSignatureUrl || null,
        },
      });
    }
    const paymentTouched = patch.cashCollectedMinor !== undefined
      || patch.cashReceivedMinor !== undefined
      || patch.cashChangeDueMinor !== undefined
      || patch.paymentReference !== undefined
      || patch.paymentNote !== undefined;
    if (paymentTouched && (saved.cashCollectedMinor > 0 || saved.cashReceivedMinor > 0 || saved.paymentReference || saved.paymentNote)) {
      await recordDeliveryEvent({
        prisma: tx,
        businessId,
        deliveryRequestId: existing.id,
        kind: 'PAYMENT_CAPTURED',
        fromStatus: existing.status,
        toStatus: next,
        message: 'Delivery payment captured',
        actorUserId,
        actorSource,
        payload: {
          cashToCollectMinor: saved.cashToCollectMinor,
          cashCollectedMinor: saved.cashCollectedMinor,
          cashReceivedMinor: saved.cashReceivedMinor,
          cashChangeDueMinor: saved.cashChangeDueMinor,
          paymentReference: saved.paymentReference || null,
          paymentNote: saved.paymentNote || null,
        },
      });
    }

    return saved;
  });

  if (emitEvents && STATUS_EVENTS[next]) {
    safeEmit(STATUS_EVENTS[next], deliveryWebhookPayload(updated), businessId);
    notifyDeliveryCustomer({
      prisma,
      businessId,
      delivery: { ...existing, ...updated, proofOtp: updated.proofOtp || existing.proofOtp },
      status: next,
    }).catch(() => {});
  }

  return updated;
}

async function updateDeliveryException({
  prisma = prismaDefault,
  businessId,
  id,
  exceptionCode,
  exceptionStatus = 'OPEN',
  exceptionNote,
  exceptionResolutionNote,
  nextAttemptAt,
  actorUserId = null,
  actorSource = 'ADMIN',
  emitEvents = true,
} = {}) {
  if (!businessId) {
    const err = new Error('No business in scope');
    err.status = 403;
    throw err;
  }
  const status = cleanExceptionStatus(exceptionStatus, null);
  if (!status) {
    const err = new Error('Invalid exception status');
    err.status = 400;
    throw err;
  }
  const existing = await prisma.ecomDeliveryRequest.findFirst({ where: { id, businessId } });
  if (!existing) {
    const err = new Error('Delivery request not found');
    err.status = 404;
    throw err;
  }

  const now = new Date();
  const code = cleanExceptionCode(exceptionCode, existing.exceptionCode || 'OTHER');
  const note = exceptionNote !== undefined ? cleanString(exceptionNote, 1000) : existing.exceptionNote;
  const resolutionNote = exceptionResolutionNote !== undefined
    ? cleanString(exceptionResolutionNote, 1000)
    : existing.exceptionResolutionNote;
  const scheduledNextAttemptAt = nextAttemptAt !== undefined ? cleanDateOrNull(nextAttemptAt) : existing.nextAttemptAt;

  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.ecomDeliveryRequest.update({
      where: { id: existing.id },
      data: {
        exceptionCode: code,
        exceptionStatus: status,
        exceptionNote: note,
        exceptionResolutionNote: resolutionNote,
        nextAttemptAt: scheduledNextAttemptAt,
        ...(status === 'OPEN' || status === 'ESCALATED' ? { exceptionOpenedAt: existing.exceptionOpenedAt || now } : {}),
        ...(status === 'ESCALATED' ? { exceptionEscalatedAt: existing.exceptionEscalatedAt || now } : {}),
        ...(status === 'RESOLVED' ? { exceptionResolvedAt: now } : { exceptionResolvedAt: null }),
        ...(note && status !== 'RESOLVED' ? { failureReason: note } : {}),
      },
    });
    const kind = status === 'RESOLVED'
      ? 'EXCEPTION_RESOLVED'
      : status === 'ESCALATED'
        ? 'EXCEPTION_ESCALATED'
        : 'EXCEPTION_OPENED';
    await recordDeliveryEvent({
      prisma: tx,
      businessId,
      deliveryRequestId: saved.id,
      kind,
      fromStatus: existing.status,
      toStatus: saved.status,
      message: deliveryExceptionLabel(code) || 'Delivery exception updated',
      actorUserId,
      actorSource,
      payload: {
        deliveryRequestId: saved.id,
        source: saved.source,
        sourceRef: saved.sourceRef || null,
        orderId: saved.orderId || null,
        riderId: saved.riderId || null,
        exceptionCode: saved.exceptionCode || null,
        exceptionStatus: saved.exceptionStatus || null,
        exceptionLabel: deliveryExceptionLabel(saved.exceptionCode),
        exceptionNote: saved.exceptionNote || null,
        exceptionResolutionNote: saved.exceptionResolutionNote || null,
        nextAttemptAt: saved.nextAttemptAt || null,
      },
    });
    return saved;
  });

  if (emitEvents) {
    const event = status === 'RESOLVED'
      ? 'delivery.exception_resolved'
      : status === 'ESCALATED'
        ? 'delivery.exception_escalated'
        : 'delivery.exception_opened';
    safeEmit(event, deliveryWebhookPayload(updated), businessId);
  }

  return updated;
}

async function submitDeliveryCustomerFeedback({
  prisma = prismaDefault,
  trackingToken,
  customerRating,
  customerFeedback,
} = {}) {
  const token = cleanString(trackingToken, 240);
  if (!token) {
    const err = new Error('Delivery not found');
    err.status = 404;
    throw err;
  }

  const rating = Number.parseInt(customerRating, 10);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    const err = new Error('Rating must be between 1 and 5');
    err.status = 400;
    err.reason = 'INVALID_RATING';
    throw err;
  }

  const existing = await prisma.ecomDeliveryRequest.findFirst({
    where: { trackingToken: token },
  });
  if (!existing) {
    const err = new Error('Delivery not found');
    err.status = 404;
    throw err;
  }
  if (existing.status !== 'DELIVERED') {
    const err = new Error('Feedback can be submitted after delivery is complete');
    err.status = 409;
    err.reason = 'DELIVERY_NOT_COMPLETED';
    throw err;
  }

  return prisma.$transaction(async (tx) => {
    const saved = await tx.ecomDeliveryRequest.update({
      where: { id: existing.id },
      data: {
        customerRating: rating,
        customerFeedback: cleanString(customerFeedback, 1000),
      },
    });
    await recordDeliveryEvent({
      prisma: tx,
      businessId: existing.businessId,
      deliveryRequestId: existing.id,
      kind: 'CUSTOMER_FEEDBACK',
      fromStatus: existing.status,
      toStatus: existing.status,
      message: 'Customer delivery feedback received',
      actorSource: 'CUSTOMER',
      payload: {
        customerRating: rating,
        customerFeedback: cleanString(customerFeedback, 1000),
      },
    });
    return saved;
  });
}

module.exports = {
  DELIVERY_SOURCES,
  DELIVERY_STATUSES,
  DELIVERY_STATUS_TRANSITIONS,
  DELIVERY_EXCEPTION_CODES,
  DELIVERY_EXCEPTION_STATUSES,
  STATUS_EVENTS,
  allowedDeliveryStatusTransitions,
  canTransitionDeliveryStatus,
  computeDeliveryDispatchMeta,
  deliveryExceptionLabel,
  deliveryEventDTO,
  deliveryLocationDTO,
  deliveryStatusLabel,
  latestDeliveryLocation,
  deliveryTrackingPath,
  deliveryTrackingUrl,
  notifyDeliveryCustomer,
  deliveryWebhookPayload,
  recordDeliveryEvent,
  createDeliveryRequest,
  createDeliveryRequestFromOrder,
  submitDeliveryCustomerFeedback,
  updateDeliveryException,
  updateDeliveryRequestStatus,
};
