// Public API helpers — key generation, hashing, signature verification.
'use strict';

const crypto = require('crypto');

const KEY_PREFIX = 'sp_live_';
const KEY_BYTES = 32;
const PUBLIC_API_SCOPE_RESOURCES = Object.freeze([
  'appointments',
  'customers',
  'products',
  'orders',
  'services',
  'deliveries',
  'riders',
]);

// Generate a fresh API key (raw + hash). Raw is shown to admin once.
function generateApiKey() {
  const raw = KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString('hex');
  const hash = hashKey(raw);
  return { raw, hash, last4: raw.slice(-4) };
}

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Verify a raw key against a stored hash.
function verifyKey(raw, storedHash) {
  if (!raw || !storedHash) return false;
  const computed = hashKey(raw);
  // Timing-safe compare
  if (computed.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(storedHash));
}

// HMAC sign a webhook payload. Receivers verify by computing the same
// signature with their stored secret.
function signWebhookPayload(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function signWebhookEnvelope(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const ts = String(timestamp);
  const signature = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return {
    timestamp: ts,
    signature,
    header: `t=${ts},v1=${signature}`,
  };
}

// Generate a fresh webhook signing secret.
function generateWebhookSecret() {
  return 'whsec_' + crypto.randomBytes(24).toString('hex');
}

// Supported event names that publishers can emit + subscribers can subscribe to.
const EVENTS = Object.freeze([
  'appointment.created', 'appointment.updated', 'appointment.cancelled', 'appointment.completed',
  'customer.created', 'customer.updated',
  'order.created', 'order.paid', 'order.shipped', 'order.delivered', 'order.cancelled',
  'delivery.created', 'delivery.ready_for_dispatch', 'delivery.assigned', 'delivery.picked_up',
  'delivery.out_for_delivery', 'delivery.arrived', 'delivery.delivered',
  'delivery.attempted_failed', 'delivery.cancelled', 'delivery.returned',
  'delivery.exception_opened', 'delivery.exception_escalated', 'delivery.exception_resolved',
  'enquiry.received',
  'review.received',
]);

const DELIVERY_API_STATUS_FLOW = Object.freeze({
  PENDING: ['READY_FOR_DISPATCH', 'ASSIGNED', 'CANCELLED'],
  READY_FOR_DISPATCH: ['ASSIGNED', 'PICKED_UP', 'CANCELLED'],
  ASSIGNED: ['PICKED_UP', 'OUT_FOR_DELIVERY', 'ATTEMPTED_FAILED', 'CANCELLED', 'RETURNED'],
  PICKED_UP: ['OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED', 'ATTEMPTED_FAILED', 'CANCELLED', 'RETURNED'],
  OUT_FOR_DELIVERY: ['ARRIVED', 'DELIVERED', 'ATTEMPTED_FAILED', 'CANCELLED', 'RETURNED'],
  ARRIVED: ['DELIVERED', 'ATTEMPTED_FAILED', 'CANCELLED', 'RETURNED'],
  ATTEMPTED_FAILED: ['READY_FOR_DISPATCH', 'ASSIGNED', 'CANCELLED', 'RETURNED'],
  DELIVERED: [],
  CANCELLED: [],
  RETURNED: [],
});

function buildDeliveryApiCapabilities({
  business = {},
  apiKey = {},
  deliveryStatuses = [],
  exceptionCodes = [],
  exceptionStatuses = [],
} = {}) {
  return {
    version: 'v1',
    business: {
      id: business.id || null,
      slug: business.slug || null,
      name: business.name || null,
      vertical: business.vertical || null,
    },
    apiKey: {
      id: apiKey.id || null,
      name: apiKey.name || null,
      scopes: apiKey.scopes || { read: [], write: [] },
    },
    deliveries: {
      source: 'API',
      idempotency: {
        field: 'externalRef',
        uniqueness: 'business + source + externalRef',
        duplicateCreateBehavior: 'Returns the existing delivery with idempotent=true',
      },
      supportedStatuses: deliveryStatuses,
      statusFlow: DELIVERY_API_STATUS_FLOW,
      filters: {
        status: 'single status or comma-separated statuses, e.g. ASSIGNED,OUT_FOR_DELIVERY',
        source: 'API, SITEPRESSO, or MANUAL',
        externalRef: 'exact external reference/sourceRef match',
        locationId: 'branch/location id',
        riderId: 'registered rider id',
        createdSince: 'ISO date/time lower bound on createdAt',
        updatedSince: 'ISO date/time lower bound on updatedAt',
        sort: 'createdAt desc by default; use dispatch for urgency/due-time ordering',
      },
      exceptionCodes,
      exceptionStatuses,
      webhookEvents: EVENTS.filter((event) => event.startsWith('delivery.')),
      tracking: {
        responseFields: ['trackingToken', 'trackingPath', 'trackingUrl'],
        publicTrackingUrlIncluded: true,
      },
      assignment: {
        riderReferenceFields: ['riderId', 'riderPhone', 'riderEmail'],
        riderReferenceBehavior: 'riderPhone or riderEmail resolves a registered, available rider in this business',
      },
      proofOfDelivery: {
        riderOtpRequiredWhenAvailable: true,
        otpReturnedByApi: false,
        responseFields: ['proofPhotoUrl', 'proofSignatureUrl', 'customerRating', 'customerFeedback'],
      },
      retryScheduling: {
        requestField: 'nextAttemptAt',
        responseFields: ['attemptCount', 'nextAttemptAt'],
        failedStatus: 'ATTEMPTED_FAILED',
        retryStatus: 'READY_FOR_DISPATCH',
      },
      reconciliation: {
        cashFields: ['cashToCollectMinor', 'cashReceivedMinor', 'cashChangeDueMinor', 'cashCollectedMinor'],
        paymentFields: ['paymentReference', 'paymentNote'],
      },
      lifecycleTimestamps: [
        'assignedAt',
        'pickedUpAt',
        'arrivedAt',
        'deliveredAt',
        'failedAt',
        'cancelledAt',
        'returnedAt',
      ],
      webhooks: {
        legacySignatureHeader: 'X-Sitepresso-Signature: sha256=<hmac_sha256(raw_body)>',
        signatureHeader: 'X-Sitepresso-Signature-V2: t=<unix_seconds>,v1=<hmac_sha256(t.raw_body)>',
        timestampHeader: 'X-Sitepresso-Timestamp',
        deliveryIdHeader: 'X-Sitepresso-Delivery-Id',
        webhookIdHeader: 'X-Sitepresso-Webhook-Id',
        eventHeader: 'X-Sitepresso-Event',
      },
      endpoints: {
        create: 'POST /api/v1/deliveries',
        bulkCreate: 'POST /api/v1/deliveries/bulk',
        list: 'GET /api/v1/deliveries',
        openApi: 'GET /api/v1/deliveries/openapi.json',
        lookupByExternalRef: 'GET /api/v1/deliveries/lookup?externalRef=ORDER-10042&source=API',
        get: 'GET /api/v1/deliveries/:id',
        status: 'POST /api/v1/deliveries/:id/status',
        exception: 'POST /api/v1/deliveries/:id/exception',
        cancel: 'POST /api/v1/deliveries/:id/cancel',
      },
    },
    riders: {
      endpoints: {
        list: 'GET /api/v1/riders',
        create: 'POST /api/v1/riders',
        get: 'GET /api/v1/riders/:id',
        update: 'PATCH /api/v1/riders/:id',
        status: 'POST /api/v1/riders/:id/status',
      },
    },
  };
}

function schemaRef(name) {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonResponse(description, schema) {
  return {
    description,
    content: {
      'application/json': { schema },
    },
  };
}

function buildDeliveryOpenApiSpec({
  business = {},
  deliveryStatuses = [],
  exceptionCodes = [],
  exceptionStatuses = [],
} = {}) {
  const statuses = deliveryStatuses.length ? deliveryStatuses : Object.keys(DELIVERY_API_STATUS_FLOW);
  const exceptions = exceptionCodes.length ? exceptionCodes : ['CUSTOMER_UNREACHABLE', 'ADDRESS_ISSUE', 'OTHER'];
  const exceptionStates = exceptionStatuses.length ? exceptionStatuses : ['OPEN', 'ESCALATED', 'RESOLVED'];

  return {
    openapi: '3.1.0',
    info: {
      title: 'Sitepresso AapkaRider Delivery API',
      version: '1.0.0',
      summary: 'In-house delivery API for ecommerce, restaurant, POS, and manual operations.',
    },
    servers: [
      { url: '/api/v1', description: 'Current tenant API host' },
    ],
    security: [{ bearerApiKey: [] }],
    tags: [
      { name: 'Deliveries' },
      { name: 'Riders' },
    ],
    'x-sitepresso-business': {
      id: business.id || null,
      slug: business.slug || null,
      name: business.name || null,
    },
    'x-sitepresso-delivery-status-flow': DELIVERY_API_STATUS_FLOW,
    'x-sitepresso-webhook-headers': {
      signature: 'X-Sitepresso-Signature-V2',
      timestamp: 'X-Sitepresso-Timestamp',
      deliveryId: 'X-Sitepresso-Delivery-Id',
      webhookId: 'X-Sitepresso-Webhook-Id',
      event: 'X-Sitepresso-Event',
    },
    paths: {
      '/deliveries': {
        get: {
          tags: ['Deliveries'],
          summary: 'List delivery requests',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'perPage', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
            { name: 'status', in: 'query', description: 'Single status or comma-separated statuses', schema: { type: 'string', examples: ['ASSIGNED,OUT_FOR_DELIVERY'] } },
            { name: 'source', in: 'query', schema: { type: 'string', enum: ['API', 'SITEPRESSO', 'MANUAL'] } },
            { name: 'externalRef', in: 'query', schema: { type: 'string' } },
            { name: 'locationId', in: 'query', schema: { type: 'string' } },
            { name: 'riderId', in: 'query', schema: { type: 'string' } },
            { name: 'createdSince', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'updatedSince', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'sort', in: 'query', schema: { type: 'string', enum: ['dispatch'] } },
          ],
          responses: {
            200: jsonResponse('Delivery list', schemaRef('DeliveryListResponse')),
            400: jsonResponse('Invalid request', schemaRef('ErrorResponse')),
          },
        },
        post: {
          tags: ['Deliveries'],
          summary: 'Create an idempotent API delivery request',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: schemaRef('DeliveryCreateRequest') } },
          },
          responses: {
            201: jsonResponse('Delivery created', schemaRef('DeliveryResponse')),
            200: jsonResponse('Existing idempotent delivery returned', schemaRef('DeliveryResponse')),
            400: jsonResponse('Invalid request', schemaRef('ErrorResponse')),
          },
        },
      },
      '/deliveries/bulk': {
        post: {
          tags: ['Deliveries'],
          summary: 'Create up to 50 delivery requests',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: schemaRef('DeliveryBulkCreateRequest') } },
          },
          responses: {
            201: jsonResponse('All deliveries created', schemaRef('DeliveryBulkCreateResponse')),
            207: jsonResponse('Some deliveries failed', schemaRef('DeliveryBulkCreateResponse')),
            400: jsonResponse('Invalid request', schemaRef('ErrorResponse')),
          },
        },
      },
      '/deliveries/capabilities': {
        get: {
          tags: ['Deliveries'],
          summary: 'Read delivery API capabilities and status flow',
          responses: {
            200: jsonResponse('Capabilities', schemaRef('CapabilitiesResponse')),
          },
        },
      },
      '/deliveries/openapi.json': {
        get: {
          tags: ['Deliveries'],
          summary: 'Download this OpenAPI document',
          responses: {
            200: jsonResponse('OpenAPI document', { type: 'object' }),
          },
        },
      },
      '/deliveries/lookup': {
        get: {
          tags: ['Deliveries'],
          summary: 'Find a delivery by external reference',
          parameters: [
            { name: 'externalRef', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'source', in: 'query', schema: { type: 'string', enum: ['API', 'SITEPRESSO', 'MANUAL'], default: 'API' } },
          ],
          responses: {
            200: jsonResponse('Delivery found', schemaRef('DeliveryResponse')),
            404: jsonResponse('Not found', schemaRef('ErrorResponse')),
          },
        },
      },
      '/deliveries/{id}': {
        get: {
          tags: ['Deliveries'],
          summary: 'Get a delivery request',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: jsonResponse('Delivery found', schemaRef('DeliveryResponse')),
            404: jsonResponse('Not found', schemaRef('ErrorResponse')),
          },
        },
      },
      '/deliveries/{id}/status': {
        post: {
          tags: ['Deliveries'],
          summary: 'Update delivery lifecycle status',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: schemaRef('DeliveryStatusUpdateRequest') } },
          },
          responses: {
            200: jsonResponse('Delivery updated', schemaRef('DeliveryResponse')),
            400: jsonResponse('Invalid payload', schemaRef('ErrorResponse')),
            409: jsonResponse('Invalid lifecycle transition', schemaRef('ErrorResponse')),
          },
        },
      },
      '/deliveries/{id}/exception': {
        post: {
          tags: ['Deliveries'],
          summary: 'Classify, escalate, resolve, or schedule a retry after a delivery exception',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: schemaRef('DeliveryExceptionUpdateRequest') } },
          },
          responses: {
            200: jsonResponse('Delivery updated', schemaRef('DeliveryResponse')),
            400: jsonResponse('Invalid payload', schemaRef('ErrorResponse')),
          },
        },
      },
      '/deliveries/{id}/cancel': {
        post: {
          tags: ['Deliveries'],
          summary: 'Cancel a delivery request',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: false,
            content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' } } } } },
          },
          responses: {
            200: jsonResponse('Delivery cancelled', schemaRef('DeliveryResponse')),
            409: jsonResponse('Invalid lifecycle transition', schemaRef('ErrorResponse')),
          },
        },
      },
      '/riders': {
        get: {
          tags: ['Riders'],
          summary: 'List registered in-house riders',
          responses: { 200: jsonResponse('Rider list', schemaRef('RiderListResponse')) },
        },
        post: {
          tags: ['Riders'],
          summary: 'Register an in-house rider',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: schemaRef('RiderCreateRequest') } },
          },
          responses: { 201: jsonResponse('Rider created', schemaRef('RiderResponse')) },
        },
      },
      '/riders/{id}': {
        get: {
          tags: ['Riders'],
          summary: 'Get rider profile',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: jsonResponse('Rider found', schemaRef('RiderResponse')) },
        },
        patch: {
          tags: ['Riders'],
          summary: 'Update rider profile',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: schemaRef('RiderUpdateRequest') } },
          },
          responses: { 200: jsonResponse('Rider updated', schemaRef('RiderResponse')) },
        },
      },
      '/riders/{id}/status': {
        post: {
          tags: ['Riders'],
          summary: 'Update rider availability status',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['ACTIVE', 'OFF_SHIFT', 'ON_LEAVE', 'SUSPENDED', 'DEPARTED'] } } } } },
          },
          responses: { 200: jsonResponse('Rider status updated', schemaRef('RiderResponse')) },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerApiKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Sitepresso API key',
          description: 'Use Authorization: Bearer sp_live_...',
        },
      },
      schemas: {
        Address: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            line1: { type: 'string' },
            line2: { type: 'string' },
            city: { type: 'string' },
            state: { type: 'string' },
            postalCode: { type: 'string' },
            country: { type: 'string' },
            lat: { type: 'number' },
            lng: { type: 'number' },
          },
        },
        Delivery: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            source: { type: 'string', enum: ['API', 'SITEPRESSO', 'MANUAL'] },
            externalRef: { type: 'string' },
            channel: { type: 'string' },
            status: { type: 'string', enum: statuses },
            priority: { type: 'string' },
            locationId: { type: 'string' },
            orderId: { type: 'string' },
            riderId: { type: 'string' },
            customerName: { type: 'string' },
            customerPhone: { type: 'string' },
            customerEmail: { type: 'string', format: 'email' },
            pickup: schemaRef('Address'),
            dropoff: schemaRef('Address'),
            items: { type: 'array', items: {} },
            packageNote: { type: 'string' },
            deliverySlotLabel: { type: 'string' },
            promisedAt: { type: 'string', format: 'date-time' },
            currency: { type: 'string' },
            paymentMethod: { type: 'string' },
            cashToCollectMinor: { type: 'integer', minimum: 0 },
            cashCollectedMinor: { type: 'integer', minimum: 0 },
            cashReceivedMinor: { type: 'integer', minimum: 0 },
            cashChangeDueMinor: { type: 'integer', minimum: 0 },
            paymentReference: { type: 'string' },
            paymentNote: { type: 'string' },
            trackingToken: { type: 'string' },
            trackingPath: { type: 'string' },
            trackingUrl: { type: 'string' },
            proofPhotoUrl: { type: 'string' },
            proofSignatureUrl: { type: 'string' },
            failureReason: { type: 'string' },
            attemptCount: { type: 'integer', minimum: 0 },
            nextAttemptAt: { type: 'string', format: 'date-time' },
            exceptionCode: { type: 'string', enum: exceptions },
            exceptionStatus: { type: 'string', enum: exceptionStates },
            dispatch: { type: 'object' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            assignedAt: { type: 'string', format: 'date-time' },
            pickedUpAt: { type: 'string', format: 'date-time' },
            arrivedAt: { type: 'string', format: 'date-time' },
            deliveredAt: { type: 'string', format: 'date-time' },
            failedAt: { type: 'string', format: 'date-time' },
            cancelledAt: { type: 'string', format: 'date-time' },
            returnedAt: { type: 'string', format: 'date-time' },
          },
        },
        DeliveryCreateRequest: {
          type: 'object',
          required: ['externalRef', 'customerName', 'dropoff'],
          properties: {
            externalRef: { type: 'string' },
            channel: { type: 'string' },
            locationId: { type: 'string' },
            riderId: { type: 'string' },
            riderPhone: { type: 'string' },
            riderEmail: { type: 'string', format: 'email' },
            customerName: { type: 'string' },
            customerPhone: { type: 'string' },
            customerEmail: { type: 'string', format: 'email' },
            pickup: schemaRef('Address'),
            dropoff: schemaRef('Address'),
            items: { type: 'array', items: {} },
            packageNote: { type: 'string' },
            deliverySlotLabel: { type: 'string' },
            requestedPickupAt: { type: 'string', format: 'date-time' },
            requestedDropoffAt: { type: 'string', format: 'date-time' },
            promisedAt: { type: 'string', format: 'date-time' },
            priority: { type: 'string' },
            currency: { type: 'string' },
            paymentMethod: { type: 'string' },
            cashToCollectMinor: { type: 'integer', minimum: 0 },
            notes: { type: 'string' },
          },
        },
        DeliveryStatusUpdateRequest: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: statuses },
            riderId: { type: ['string', 'null'] },
            riderPhone: { type: 'string' },
            riderEmail: { type: 'string', format: 'email' },
            proofPhotoUrl: { type: 'string', format: 'uri' },
            proofSignatureUrl: { type: 'string', format: 'uri' },
            customerRating: { type: 'integer', minimum: 1, maximum: 5 },
            customerFeedback: { type: 'string' },
            failureReason: { type: 'string' },
            nextAttemptAt: { type: ['string', 'null'], format: 'date-time' },
            exceptionCode: { type: 'string', enum: exceptions },
            exceptionStatus: { type: 'string', enum: exceptionStates },
            cashCollectedMinor: { type: 'integer', minimum: 0 },
            cashReceivedMinor: { type: 'integer', minimum: 0 },
            cashChangeDueMinor: { type: 'integer', minimum: 0 },
            paymentReference: { type: 'string' },
            paymentNote: { type: 'string' },
            notes: { type: 'string' },
          },
        },
        DeliveryExceptionUpdateRequest: {
          type: 'object',
          properties: {
            exceptionCode: { type: 'string', enum: exceptions },
            exceptionStatus: { type: 'string', enum: exceptionStates },
            exceptionNote: { type: 'string' },
            exceptionResolutionNote: { type: 'string' },
            nextAttemptAt: { type: ['string', 'null'], format: 'date-time' },
          },
        },
        DeliveryResponse: {
          type: 'object',
          properties: {
            data: schemaRef('Delivery'),
            idempotent: { type: 'boolean' },
          },
        },
        DeliveryListResponse: {
          type: 'object',
          properties: {
            data: { type: 'array', items: schemaRef('Delivery') },
            page: { type: 'integer' },
            perPage: { type: 'integer' },
            total: { type: 'integer' },
          },
        },
        DeliveryBulkCreateRequest: {
          type: 'object',
          required: ['deliveries'],
          properties: {
            deliveries: { type: 'array', minItems: 1, maxItems: 50, items: schemaRef('DeliveryCreateRequest') },
          },
        },
        DeliveryBulkCreateResponse: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object' } },
            summary: { type: 'object' },
          },
        },
        Rider: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            fullName: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string', format: 'email' },
            vehicleType: { type: 'string', enum: ['BIKE', 'EBIKE', 'VAN', 'CYCLE', 'WALKING'] },
            status: { type: 'string', enum: ['ACTIVE', 'OFF_SHIFT', 'ON_LEAVE', 'SUSPENDED', 'DEPARTED'] },
          },
        },
        RiderCreateRequest: {
          type: 'object',
          required: ['fullName', 'phone'],
          properties: {
            fullName: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string', format: 'email' },
            vehicleType: { type: 'string', enum: ['BIKE', 'EBIKE', 'VAN', 'CYCLE', 'WALKING'] },
            status: { type: 'string', enum: ['ACTIVE', 'OFF_SHIFT', 'ON_LEAVE', 'SUSPENDED', 'DEPARTED'] },
            homeLocationId: { type: 'string' },
          },
        },
        RiderUpdateRequest: {
          type: 'object',
          properties: {
            fullName: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string', format: 'email' },
            vehicleType: { type: 'string', enum: ['BIKE', 'EBIKE', 'VAN', 'CYCLE', 'WALKING'] },
            homeLocationId: { type: 'string' },
          },
        },
        RiderResponse: {
          type: 'object',
          properties: { data: schemaRef('Rider') },
        },
        RiderListResponse: {
          type: 'object',
          properties: {
            data: { type: 'array', items: schemaRef('Rider') },
            page: { type: 'integer' },
            perPage: { type: 'integer' },
            total: { type: 'integer' },
          },
        },
        CapabilitiesResponse: {
          type: 'object',
          properties: { data: { type: 'object' } },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
            allowedTransitions: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  };
}

module.exports = {
  KEY_PREFIX,
  PUBLIC_API_SCOPE_RESOURCES,
  generateApiKey,
  hashKey,
  verifyKey,
  signWebhookPayload,
  signWebhookEnvelope,
  generateWebhookSecret,
  EVENTS,
  DELIVERY_API_STATUS_FLOW,
  buildDeliveryApiCapabilities,
  buildDeliveryOpenApiSpec,
};
