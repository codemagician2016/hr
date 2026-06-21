// Public API v1 — read-only endpoints exposed under /api/v1/*.
// Every handler relies on requireApiKey + requireScope middleware to
// authenticate and scope-check; here we just shape responses.
//
// Response envelope (consistent across all endpoints):
//   list:    { data: [...], page, perPage, total }
//   single:  { data: {...} }
//
// Pagination defaults: page=1, perPage=50, max perPage=200.
'use strict';

const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');
const {
  DELIVERY_SOURCES,
  DELIVERY_EXCEPTION_CODES,
  DELIVERY_EXCEPTION_STATUSES,
  DELIVERY_STATUSES,
  computeDeliveryDispatchMeta,
  createDeliveryRequest,
  deliveryEventDTO,
  deliveryTrackingPath,
  deliveryTrackingUrl,
  latestDeliveryLocation,
  updateDeliveryException,
  updateDeliveryRequestStatus,
} = require('../lib/ecomDeliveryRequestService');
const { buildDeliveryApiCapabilities, buildDeliveryOpenApiSpec } = require('../lib/publicApi');
const prisma = new PrismaClient();

function paginate(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(200, Math.max(1, parseInt(req.query.perPage, 10) || 50));
  return { page, perPage, skip: (page - 1) * perPage, take: perPage };
}

function notFound(res) {
  return res.status(404).json({ error: 'not_found', message: 'Resource not found' });
}

const RIDER_STATUSES = ['ACTIVE', 'OFF_SHIFT', 'ON_LEAVE', 'SUSPENDED', 'DEPARTED'];
const VEHICLE_TYPES = ['BIKE', 'EBIKE', 'VAN', 'CYCLE', 'WALKING'];

async function ensureBusinessLocation(businessId, locationId) {
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

function cleanApiString(value, max = 180) {
  if (value === undefined || value === null) return null;
  const next = String(value).trim();
  return next ? next.slice(0, max) : null;
}

async function resolveApiRiderId({
  businessId,
  riderId,
  riderPhone,
  riderEmail,
} = {}) {
  if (riderId === null) return null;
  const phone = cleanApiString(riderPhone, 60);
  const email = cleanApiString(riderEmail, 180)?.toLowerCase() || null;
  if (!riderId && !phone && !email) return undefined;

  const where = {
    businessId,
    status: { in: ['ACTIVE', 'OFF_SHIFT'] },
    ...(riderId ? { id: riderId } : {}),
  };
  const or = [];
  if (phone) or.push({ phone });
  if (email) or.push({ email: { equals: email, mode: 'insensitive' } });
  if (or.length) where.OR = or;

  const rider = await prisma.ecomRider.findFirst({
    where,
    select: { id: true },
  });
  if (!rider) {
    const err = new Error('Rider reference did not match an active or off-shift rider');
    err.status = 404;
    err.reason = 'RIDER_NOT_FOUND';
    throw err;
  }
  return rider.id;
}

// ─── APPOINTMENTS ──────────────────────────────────────────────────────────
function appointmentDTO(a) {
  return {
    id: a.id,
    serviceId: a.serviceId,
    staffId: a.staffId,
    customerId: a.customerId,
    customerEmail: a.customer?.email || null,
    customerName: a.customer?.name || null,
    date: a.date,
    startTime: a.startTime,
    endTime: a.endTime,
    status: a.status,
    notes: a.notes,
    finalPrice: a.finalPrice,
    couponCode: a.couponCode,
    meetingUrl: a.meetingUrl,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

async function listAppointments(req, res) {
  const { page, perPage, skip, take } = paginate(req);
  const where = { businessId: req.business.id };
  if (req.query.status) where.status = String(req.query.status).toUpperCase();
  if (req.query.from || req.query.to) {
    where.date = {};
    if (req.query.from) where.date.gte = new Date(String(req.query.from));
    if (req.query.to) where.date.lte = new Date(String(req.query.to));
  }
  if (req.query.customerId) where.customerId = String(req.query.customerId);
  const [rows, total] = await Promise.all([
    prisma.appointment.findMany({ where, orderBy: { date: 'desc' }, take, skip,
      include: { customer: { select: { email: true, name: true } } } }),
    prisma.appointment.count({ where }),
  ]);
  res.json({ data: rows.map(appointmentDTO), page, perPage, total });
}

async function getAppointment(req, res) {
  const a = await prisma.appointment.findUnique({
    where: { id: req.params.id },
    include: { customer: { select: { email: true, name: true } } },
  });
  if (!a || a.businessId !== req.business.id) return notFound(res);
  res.json({ data: appointmentDTO(a) });
}

// ─── CUSTOMERS ─────────────────────────────────────────────────────────────
function customerDTO(c) {
  return {
    id: c.id,
    email: c.email,
    name: c.name,
    phone: c.phone,
    dateOfBirth: c.dateOfBirth,
    emailVerified: c.emailVerified,
    isActive: c.isActive,
    preferredLanguage: c.preferredLanguage,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

async function listCustomers(req, res) {
  const { page, perPage, skip, take } = paginate(req);
  const where = { businessId: req.business.id };
  if (req.query.q) {
    const term = String(req.query.q).trim();
    where.OR = [
      { email: { contains: term, mode: 'insensitive' } },
      { name:  { contains: term, mode: 'insensitive' } },
      { phone: { contains: term, mode: 'insensitive' } },
    ];
  }
  const [rows, total] = await Promise.all([
    prisma.customer.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
    prisma.customer.count({ where }),
  ]);
  res.json({ data: rows.map(customerDTO), page, perPage, total });
}

async function getCustomer(req, res) {
  const c = await prisma.customer.findUnique({ where: { id: req.params.id } });
  if (!c || c.businessId !== req.business.id) return notFound(res);
  res.json({ data: customerDTO(c) });
}

// ─── PRODUCTS ──────────────────────────────────────────────────────────────
function productDTO(p) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    sku: p.sku,
    barcode: p.barcode,
    qrCode: p.qrCode,
    priceMinor: p.priceMinor,
    comparePriceMinor: p.comparePriceMinor,
    currency: p.currency,
    stockQty: p.stockQty,
    imageUrls: p.imageUrls,
    isPublished: p.isPublished,
    isFeatured: p.isFeatured,
    categoryId: p.categoryId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

async function listProducts(req, res) {
  const { page, perPage, skip, take } = paginate(req);
  const where = { businessId: req.business.id };
  if (req.query.published === 'true') where.isPublished = true;
  if (req.query.published === 'false') where.isPublished = false;
  if (req.query.categoryId) where.categoryId = String(req.query.categoryId);
  if (req.query.q) where.name = { contains: String(req.query.q).trim(), mode: 'insensitive' };
  const [rows, total] = await Promise.all([
    prisma.product.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }], take, skip }),
    prisma.product.count({ where }),
  ]);
  res.json({ data: rows.map(productDTO), page, perPage, total });
}

async function getProduct(req, res) {
  const p = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!p || p.businessId !== req.business.id) return notFound(res);
  res.json({ data: productDTO(p) });
}

// ─── ORDERS ────────────────────────────────────────────────────────────────
function orderDTO(o) {
  return {
    id: o.id,
    customerEmail: o.customerEmail,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    status: o.status,
    currency: o.currency,
    subtotalMinor: o.subtotalMinor,
    shippingMinor: o.shippingMinor,
    taxMinor: o.taxMinor,
    discountMinor: o.discountMinor,
    totalMinor: o.totalMinor,
    paymentProvider: o.paymentProvider,
    paymentRef: o.paymentRef,
    couponCode: o.couponCode,
    shippingAddress: o.shippingAddress,
    placedAt: o.placedAt,
    paidAt: o.paidAt,
    cancelledAt: o.cancelledAt,
    items: (o.items || []).map((it) => ({
      id: it.id,
      productId: it.productId,
      productName: it.productName,
      productSlug: it.productSlug,
      quantity: it.quantity,
      priceMinor: it.priceMinor,
      lineTotalMinor: it.lineTotalMinor,
    })),
  };
}

// ─── DELIVERIES ────────────────────────────────────────────────────────────
function deliveryDTO(d, business = null) {
  return {
    id: d.id,
    source: d.source,
    externalRef: d.sourceRef,
    channel: d.channel,
    status: d.status,
    priority: d.priority,
    locationId: d.locationId,
    orderId: d.orderId,
    riderId: d.riderId,
    customerName: d.customerName,
    customerPhone: d.customerPhone,
    customerEmail: d.customerEmail,
    pickup: {
      name: d.pickupName,
      line1: d.pickupAddress1,
      line2: d.pickupAddress2,
      city: d.pickupCity,
      state: d.pickupState,
      postalCode: d.pickupPostalCode,
      country: d.pickupCountry,
      lat: d.pickupLat,
      lng: d.pickupLng,
    },
    dropoff: {
      name: d.dropoffName,
      line1: d.dropoffAddress1,
      line2: d.dropoffAddress2,
      city: d.dropoffCity,
      state: d.dropoffState,
      postalCode: d.dropoffPostalCode,
      country: d.dropoffCountry,
      lat: d.dropoffLat,
      lng: d.dropoffLng,
    },
    items: d.items,
    packageNote: d.packageNote,
    deliverySlotLabel: d.deliverySlotLabel,
    requestedPickupAt: d.requestedPickupAt,
    requestedDropoffAt: d.requestedDropoffAt,
    promisedAt: d.promisedAt,
    currency: d.currency,
    paymentMethod: d.paymentMethod,
    cashToCollectMinor: d.cashToCollectMinor,
    cashCollectedMinor: d.cashCollectedMinor,
    cashReceivedMinor: d.cashReceivedMinor,
    cashChangeDueMinor: d.cashChangeDueMinor,
    paymentReference: d.paymentReference || null,
    paymentNote: d.paymentNote || null,
    trackingToken: d.trackingToken,
    trackingPath: deliveryTrackingPath(d),
    trackingUrl: deliveryTrackingUrl(d, business?.slug),
    proofPhotoUrl: d.proofPhotoUrl,
    proofSignatureUrl: d.proofSignatureUrl,
    customerRating: d.customerRating,
    customerFeedback: d.customerFeedback,
    failureReason: d.failureReason,
    attemptCount: d.attemptCount || 0,
    nextAttemptAt: d.nextAttemptAt || null,
    exceptionCode: d.exceptionCode || null,
    exceptionStatus: d.exceptionStatus || null,
    exceptionNote: d.exceptionNote || null,
    exceptionOpenedAt: d.exceptionOpenedAt || null,
    exceptionEscalatedAt: d.exceptionEscalatedAt || null,
    exceptionResolvedAt: d.exceptionResolvedAt || null,
    exceptionResolutionNote: d.exceptionResolutionNote || null,
    latestLocation: latestDeliveryLocation(d.locationPings),
    dispatch: computeDeliveryDispatchMeta(d),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    assignedAt: d.assignedAt,
    pickedUpAt: d.pickedUpAt,
    arrivedAt: d.arrivedAt,
    deliveredAt: d.deliveredAt,
    failedAt: d.failedAt,
    cancelledAt: d.cancelledAt,
    returnedAt: d.returnedAt,
    events: Array.isArray(d.events) ? d.events.map((event) => deliveryEventDTO(event)) : undefined,
  };
}

function compareDeliveryDispatch(a, b) {
  const aDispatch = computeDeliveryDispatchMeta(a);
  const bDispatch = computeDeliveryDispatchMeta(b);
  if (aDispatch.urgencyScore !== bDispatch.urgencyScore) return bDispatch.urgencyScore - aDispatch.urgencyScore;
  const aDue = aDispatch.dueAt ? new Date(aDispatch.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  const bDue = bDispatch.dueAt ? new Date(bDispatch.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (aDue !== bDue) return aDue - bDue;
  return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
}

function deliveryDetailInclude() {
  return {
    events: {
      orderBy: { createdAt: 'asc' },
      take: 200,
    },
    locationPings: {
      orderBy: { createdAt: 'desc' },
      take: 1,
    },
  };
}

function cleanDeliverySource(value, fallback = 'API') {
  const next = String(value || fallback || '').trim().toUpperCase();
  return DELIVERY_SOURCES.includes(next) ? next : null;
}

function parseDeliveryStatusFilter(value) {
  if (!value) return null;
  const statuses = Array.from(new Set(String(value)
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)));
  if (!statuses.length) return null;
  const invalid = statuses.filter((status) => !DELIVERY_STATUSES.includes(status));
  if (invalid.length) {
    const err = new Error(`Invalid delivery status: ${invalid.join(', ')}`);
    err.status = 400;
    err.reason = 'invalid_request';
    throw err;
  }
  return statuses.length === 1 ? statuses[0] : { in: statuses };
}

function parseDateQuery(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    const err = new Error(`${fieldName} must be a valid ISO date/time`);
    err.status = 400;
    err.reason = 'invalid_request';
    throw err;
  }
  return date;
}

async function deliveryCapabilities(req, res) {
  res.json({
    data: buildDeliveryApiCapabilities({
      business: req.business,
      apiKey: req.apiKey,
      deliveryStatuses: DELIVERY_STATUSES,
      exceptionCodes: DELIVERY_EXCEPTION_CODES,
      exceptionStatuses: DELIVERY_EXCEPTION_STATUSES,
    }),
  });
}

async function deliveryOpenApi(req, res) {
  res.json(buildDeliveryOpenApiSpec({
    business: req.business,
    deliveryStatuses: DELIVERY_STATUSES,
    exceptionCodes: DELIVERY_EXCEPTION_CODES,
    exceptionStatuses: DELIVERY_EXCEPTION_STATUSES,
  }));
}

async function listDeliveries(req, res) {
  const { page, perPage, skip, take } = paginate(req);
  const where = { businessId: req.business.id };
  try {
    const statusFilter = parseDeliveryStatusFilter(req.query.status);
    if (statusFilter) where.status = statusFilter;
    const updatedSince = parseDateQuery(req.query.updatedSince || req.query.updatedAfter, 'updatedSince');
    if (updatedSince) where.updatedAt = { gte: updatedSince };
    const createdSince = parseDateQuery(req.query.createdSince || req.query.createdAfter, 'createdSince');
    if (createdSince) where.createdAt = { gte: createdSince };
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.reason || 'invalid_request', message: err.message });
  }
  if (req.query.source) {
    const source = cleanDeliverySource(req.query.source, null);
    if (!source) return res.status(400).json({ error: 'invalid_request', message: 'Invalid delivery source' });
    where.source = source;
  }
  if (req.query.externalRef) where.sourceRef = String(req.query.externalRef);
  if (req.query.locationId) where.locationId = String(req.query.locationId);
  if (req.query.riderId) where.riderId = String(req.query.riderId);
  const dispatchSort = String(req.query.sort || '').toLowerCase() === 'dispatch';
  const [rows, total] = await Promise.all([
    prisma.ecomDeliveryRequest.findMany({
      where,
      orderBy: dispatchSort ? [{ promisedAt: 'asc' }, { requestedDropoffAt: 'asc' }, { createdAt: 'asc' }] : { createdAt: 'desc' },
      take: dispatchSort ? Math.min(1000, Math.max(take, page * perPage)) : take,
      skip: dispatchSort ? 0 : skip,
      include: {
        locationPings: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    }),
    prisma.ecomDeliveryRequest.count({ where }),
  ]);
  const sortedRows = dispatchSort ? [...rows].sort(compareDeliveryDispatch).slice(skip, skip + take) : rows;
  res.json({ data: sortedRows.map((row) => deliveryDTO(row, req.business)), page, perPage, total });
}

async function getDelivery(req, res) {
  const row = await prisma.ecomDeliveryRequest.findFirst({
    where: { id: req.params.id, businessId: req.business.id },
    include: deliveryDetailInclude(),
  });
  if (!row) return notFound(res);
  res.json({ data: deliveryDTO(row, req.business) });
}

async function lookupDelivery(req, res) {
  const externalRef = String(req.query.externalRef || '').trim();
  if (!externalRef) {
    return res.status(400).json({ error: 'invalid_request', message: 'externalRef is required' });
  }
  const source = cleanDeliverySource(req.query.source, 'API');
  if (!source) return res.status(400).json({ error: 'invalid_request', message: 'Invalid delivery source' });

  const row = await prisma.ecomDeliveryRequest.findFirst({
    where: { businessId: req.business.id, source, sourceRef: externalRef },
    include: deliveryDetailInclude(),
  });
  if (!row) return notFound(res);
  res.json({ data: deliveryDTO(row, req.business), lookup: { externalRef, source } });
}

const apiAddressSchema = z.object({
  name: z.string().max(160).optional(),
  line1: z.string().max(500).optional(),
  line2: z.string().max(500).optional(),
  city: z.string().max(160).optional(),
  state: z.string().max(160).optional(),
  postalCode: z.string().max(40).optional(),
  country: z.string().max(4).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
}).passthrough();

const createDeliverySchema = z.object({
  externalRef: z.string().min(1).max(180),
  channel: z.string().max(80).optional(),
  locationId: z.string().uuid().optional(),
  riderId: z.string().uuid().optional(),
  riderPhone: z.string().max(60).optional(),
  riderEmail: z.string().email().optional(),
  customerName: z.string().min(1).max(160),
  customerPhone: z.string().max(60).optional(),
  customerEmail: z.string().email().optional(),
  pickup: apiAddressSchema.optional(),
  dropoff: apiAddressSchema,
  items: z.array(z.unknown()).optional(),
  packageNote: z.string().max(1000).optional(),
  deliverySlotLabel: z.string().max(160).optional(),
  requestedPickupAt: z.string().datetime().optional(),
  requestedDropoffAt: z.string().datetime().optional(),
  promisedAt: z.string().datetime().optional(),
  priority: z.string().max(40).optional(),
  currency: z.string().min(3).max(3).optional(),
  paymentMethod: z.string().max(40).optional(),
  cashToCollectMinor: z.coerce.number().int().min(0).optional(),
  notes: z.string().max(2000).optional(),
});

async function createDelivery(req, res) {
  const parsed = createDeliverySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', message: 'Invalid delivery payload', issues: parsed.error.issues });
  try {
    const result = await createDeliveryFromApiPayload({ business: req.business, payload: parsed.data });
    res.status(result.created ? 201 : 200).json({ data: deliveryDTO(result.delivery, req.business), idempotent: !result.created });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.reason || 'delivery_error', message: err.message || 'Could not create delivery' });
  }
}

async function createDeliveryFromApiPayload({ business, payload } = {}) {
  const { riderPhone, riderEmail, ...deliveryInput } = payload;
  const riderId = await resolveApiRiderId({
    businessId: business.id,
    riderId: payload.riderId,
    riderPhone,
    riderEmail,
  });
  return createDeliveryRequest({
    businessId: business.id,
    input: {
      ...deliveryInput,
      ...(riderId !== undefined ? { riderId } : {}),
      source: 'API',
      sourceRef: payload.externalRef,
      status: riderId ? 'ASSIGNED' : 'PENDING',
    },
  });
}

const bulkCreateDeliverySchema = z.object({
  deliveries: z.array(createDeliverySchema).min(1).max(50),
});

async function createDeliveriesBulk(req, res) {
  const parsed = bulkCreateDeliverySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', message: 'Invalid bulk delivery payload', issues: parsed.error.issues });
  }

  const results = [];
  for (const [index, payload] of parsed.data.deliveries.entries()) {
    try {
      const result = await createDeliveryFromApiPayload({ business: req.business, payload });
      results.push({
        index,
        externalRef: payload.externalRef,
        ok: true,
        idempotent: !result.created,
        data: deliveryDTO(result.delivery, req.business),
      });
    } catch (err) {
      results.push({
        index,
        externalRef: payload.externalRef,
        ok: false,
        error: err.reason || 'delivery_error',
        message: err.message || 'Could not create delivery',
      });
    }
  }

  const failed = results.filter((item) => !item.ok).length;
  const created = results.filter((item) => item.ok && !item.idempotent).length;
  res.status(failed ? 207 : created ? 201 : 200).json({
    data: results,
    summary: {
      total: results.length,
      created,
      idempotent: results.filter((item) => item.ok && item.idempotent).length,
      failed,
    },
  });
}

async function cancelDelivery(req, res) {
  try {
    const row = await updateDeliveryRequestStatus({
      businessId: req.business.id,
      id: req.params.id,
      status: 'CANCELLED',
      patch: { failureReason: req.body?.reason || req.query?.reason || 'Cancelled by API' },
      actorSource: 'API',
    });
    res.json({ data: deliveryDTO(row, req.business) });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.reason || 'delivery_error',
      message: err.message || 'Could not cancel delivery',
      allowedTransitions: err.allowedTransitions || undefined,
    });
  }
}

const updateDeliveryStatusSchema = z.object({
  status: z.enum(DELIVERY_STATUSES),
  riderId: z.string().uuid().nullable().optional(),
  riderPhone: z.string().max(60).optional(),
  riderEmail: z.string().email().optional(),
  proofPhotoUrl: z.string().url().optional(),
  proofSignatureUrl: z.string().url().optional(),
  customerRating: z.coerce.number().int().min(1).max(5).optional(),
  customerFeedback: z.string().max(1000).optional(),
  failureReason: z.string().max(500).optional(),
  nextAttemptAt: z.string().datetime().nullable().optional(),
  exceptionCode: z.enum(DELIVERY_EXCEPTION_CODES).optional(),
  exceptionStatus: z.enum(DELIVERY_EXCEPTION_STATUSES).optional(),
  exceptionNote: z.string().max(1000).optional(),
  exceptionResolutionNote: z.string().max(1000).optional(),
  cashCollectedMinor: z.coerce.number().int().min(0).optional(),
  cashReceivedMinor: z.coerce.number().int().min(0).optional(),
  cashChangeDueMinor: z.coerce.number().int().min(0).optional(),
  paymentReference: z.string().max(160).optional(),
  paymentNote: z.string().max(1000).optional(),
  notes: z.string().max(2000).optional(),
});

async function updateDeliveryStatus(req, res) {
  const parsed = updateDeliveryStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', message: 'Invalid delivery status payload', issues: parsed.error.issues });
  try {
    const { riderPhone, riderEmail, ...statusInput } = parsed.data;
    if (statusInput.riderId === null && (riderPhone || riderEmail)) {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'Use riderId null to unassign, or riderPhone/riderEmail to assign; not both',
      });
    }
    const patch = { ...statusInput };
    if (statusInput.riderId !== undefined || riderPhone || riderEmail) {
      patch.riderId = statusInput.riderId === null
        ? null
        : await resolveApiRiderId({
            businessId: req.business.id,
            riderId: statusInput.riderId,
            riderPhone,
            riderEmail,
          });
    }
    const row = await updateDeliveryRequestStatus({
      businessId: req.business.id,
      id: req.params.id,
      status: statusInput.status,
      patch,
      actorSource: 'API',
    });
    res.json({ data: deliveryDTO(row, req.business) });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.reason || 'delivery_error',
      message: err.message || 'Could not update delivery status',
      allowedTransitions: err.allowedTransitions || undefined,
    });
  }
}

const updateDeliveryExceptionSchema = z.object({
  exceptionCode: z.enum(DELIVERY_EXCEPTION_CODES).optional(),
  exceptionStatus: z.enum(DELIVERY_EXCEPTION_STATUSES).optional(),
  exceptionNote: z.string().max(1000).optional(),
  exceptionResolutionNote: z.string().max(1000).optional(),
  nextAttemptAt: z.string().datetime().nullable().optional(),
});

async function updateDeliveryExceptionHandler(req, res) {
  const parsed = updateDeliveryExceptionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', message: 'Invalid delivery exception payload', issues: parsed.error.issues });
  try {
    const row = await updateDeliveryException({
      businessId: req.business.id,
      id: req.params.id,
      ...parsed.data,
      actorSource: 'API',
    });
    res.json({ data: deliveryDTO(row, req.business) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.reason || 'delivery_error', message: err.message || 'Could not update delivery exception' });
  }
}

// ─── RIDERS ───────────────────────────────────────────────────────────────
function riderDTO(r) {
  return {
    id: r.id,
    fullName: r.fullName,
    phone: r.phone,
    email: r.email,
    vehicleType: r.vehicleType,
    vehicleReg: r.vehicleReg,
    licenseNo: r.licenseNo,
    licenseExpiresAt: r.licenseExpiresAt,
    insuranceExpiresAt: r.insuranceExpiresAt,
    homeLocationId: r.homeLocationId,
    homeLocation: r.homeLocation || null,
    serviceZones: r.serviceZones || [],
    status: r.status,
    cashFloatMinor: r.cashFloatMinor,
    totalDeliveries: r.totalDeliveries,
    onTimeRate: r.onTimeRate,
    avgRating: r.avgRating,
    notes: r.notes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function listRiders(req, res) {
  const { page, perPage, skip, take } = paginate(req);
  const where = { businessId: req.business.id };
  if (req.query.status) where.status = String(req.query.status).toUpperCase();
  if (req.query.vehicleType) where.vehicleType = String(req.query.vehicleType).toUpperCase();
  if (req.query.locationId) where.homeLocationId = String(req.query.locationId);
  if (req.query.q) {
    const q = String(req.query.q).trim();
    where.OR = [
      { fullName: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { vehicleReg: { contains: q, mode: 'insensitive' } },
    ];
  }
  const [rows, total] = await Promise.all([
    prisma.ecomRider.findMany({
      where,
      orderBy: [{ status: 'asc' }, { fullName: 'asc' }],
      include: { homeLocation: { select: { id: true, name: true, city: true } } },
      take,
      skip,
    }),
    prisma.ecomRider.count({ where }),
  ]);
  res.json({ data: rows.map(riderDTO), page, perPage, total });
}

async function getRider(req, res) {
  const rider = await prisma.ecomRider.findFirst({
    where: { id: req.params.id, businessId: req.business.id },
    include: { homeLocation: { select: { id: true, name: true, city: true } } },
  });
  if (!rider) return notFound(res);
  res.json({ data: riderDTO(rider) });
}

const riderSchema = z.object({
  fullName: z.string().min(1).max(120),
  phone: z.string().min(5).max(40),
  email: z.string().email().optional(),
  vehicleType: z.enum(VEHICLE_TYPES),
  vehicleReg: z.string().max(40).optional(),
  licenseNo: z.string().max(60).optional(),
  licenseExpiresAt: z.string().datetime().nullable().optional(),
  insuranceExpiresAt: z.string().datetime().nullable().optional(),
  homeLocationId: z.string().uuid().nullable().optional(),
  serviceZones: z.array(z.string()).optional(),
  cashFloatMinor: z.coerce.number().int().min(0).optional(),
  status: z.enum(RIDER_STATUSES).optional(),
  notes: z.string().max(2000).optional(),
});

function riderWriteData(data) {
  return {
    fullName: data.fullName,
    phone: data.phone,
    email: data.email || null,
    vehicleType: data.vehicleType,
    vehicleReg: data.vehicleReg || null,
    licenseNo: data.licenseNo || null,
    licenseExpiresAt: data.licenseExpiresAt ? new Date(data.licenseExpiresAt) : null,
    insuranceExpiresAt: data.insuranceExpiresAt ? new Date(data.insuranceExpiresAt) : null,
    homeLocationId: data.homeLocationId || null,
    serviceZones: Array.isArray(data.serviceZones) ? data.serviceZones : [],
    cashFloatMinor: data.cashFloatMinor || 0,
    status: data.status || 'ACTIVE',
    notes: data.notes || null,
  };
}

async function createRider(req, res) {
  const parsed = riderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', message: 'Invalid rider payload', issues: parsed.error.issues });
  try {
    await ensureBusinessLocation(req.business.id, parsed.data.homeLocationId);
    const rider = await prisma.ecomRider.create({
      data: {
        businessId: req.business.id,
        ...riderWriteData(parsed.data),
      },
      include: { homeLocation: { select: { id: true, name: true, city: true } } },
    });
    res.status(201).json({ data: riderDTO(rider) });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'rider_error', message: err.message || 'Could not create rider' });
  }
}

async function updateRider(req, res) {
  const parsed = riderSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', message: 'Invalid rider payload', issues: parsed.error.issues });
  try {
    const existing = await prisma.ecomRider.findFirst({ where: { id: req.params.id, businessId: req.business.id } });
    if (!existing) return notFound(res);
    if (parsed.data.homeLocationId !== undefined) {
      await ensureBusinessLocation(req.business.id, parsed.data.homeLocationId);
    }
    const data = {};
    for (const key of Object.keys(parsed.data)) {
      const value = parsed.data[key];
      if (key === 'licenseExpiresAt' || key === 'insuranceExpiresAt') data[key] = value ? new Date(value) : null;
      else if (key === 'homeLocationId') data.homeLocationId = value || null;
      else if (key === 'email' || key === 'vehicleReg' || key === 'licenseNo' || key === 'notes') data[key] = value || null;
      else data[key] = value;
    }
    const rider = await prisma.ecomRider.update({
      where: { id: existing.id },
      data,
      include: { homeLocation: { select: { id: true, name: true, city: true } } },
    });
    res.json({ data: riderDTO(rider) });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'rider_error', message: err.message || 'Could not update rider' });
  }
}

const riderStatusSchema = z.object({
  status: z.enum(RIDER_STATUSES),
  reason: z.string().max(500).optional(),
});

async function updateRiderStatus(req, res) {
  const parsed = riderStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', message: 'Invalid rider status payload', issues: parsed.error.issues });
  try {
    const existing = await prisma.ecomRider.findFirst({ where: { id: req.params.id, businessId: req.business.id } });
    if (!existing) return notFound(res);
    const rider = existing.status === parsed.data.status
      ? existing
      : await prisma.ecomRider.update({
          where: { id: existing.id },
          data: { status: parsed.data.status },
        });
    res.json({ data: riderDTO(rider) });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'rider_error', message: err.message || 'Could not update rider status' });
  }
}

async function listOrders(req, res) {
  const { page, perPage, skip, take } = paginate(req);
  const where = { businessId: req.business.id };
  if (req.query.status) where.status = String(req.query.status).toUpperCase();
  if (req.query.customerEmail) where.customerEmail = String(req.query.customerEmail).toLowerCase();
  const [rows, total] = await Promise.all([
    prisma.order.findMany({ where, orderBy: { placedAt: 'desc' }, take, skip, include: { items: true } }),
    prisma.order.count({ where }),
  ]);
  res.json({ data: rows.map(orderDTO), page, perPage, total });
}

async function getOrder(req, res) {
  const o = await prisma.order.findUnique({ where: { id: req.params.id }, include: { items: true } });
  if (!o || o.businessId !== req.business.id) return notFound(res);
  res.json({ data: orderDTO(o) });
}

// ─── SERVICES ──────────────────────────────────────────────────────────────
function serviceDTO(s) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    duration: s.duration,
    price: s.price,
    isActive: s.isActive,
    isVirtual: s.isVirtual,
    highlighted: s.highlighted,
  };
}

async function listServices(req, res) {
  const { page, perPage, skip, take } = paginate(req);
  const where = { businessId: req.business.id };
  if (req.query.active === 'true') where.isActive = true;
  if (req.query.active === 'false') where.isActive = false;
  const [rows, total] = await Promise.all([
    prisma.service.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
    prisma.service.count({ where }),
  ]);
  res.json({ data: rows.map(serviceDTO), page, perPage, total });
}

async function getService(req, res) {
  const s = await prisma.service.findUnique({ where: { id: req.params.id } });
  if (!s || s.businessId !== req.business.id) return notFound(res);
  res.json({ data: serviceDTO(s) });
}

// ─── INTROSPECTION (no scope required) ─────────────────────────────────────
async function whoami(req, res) {
  res.json({
    data: {
      business: {
        id: req.business.id,
        slug: req.business.slug,
        name: req.business.name,
        vertical: req.business.vertical,
      },
      apiKey: {
        id: req.apiKey.id,
        name: req.apiKey.name,
        scopes: req.apiKey.scopes,
      },
    },
  });
}

module.exports = {
  whoami,
  listAppointments, getAppointment,
  listCustomers, getCustomer,
  listProducts, getProduct,
  listOrders, getOrder,
  deliveryCapabilities, deliveryOpenApi, listDeliveries, lookupDelivery, getDelivery, createDelivery, createDeliveriesBulk, updateDeliveryStatus, updateDeliveryExceptionHandler, cancelDelivery,
  listRiders, getRider, createRider, updateRider, updateRiderStatus,
  listServices, getService,
};
