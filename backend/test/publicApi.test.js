// Public API helpers — pure-function tests for key generation, hashing,
// and the requireScope middleware. Database-touching tests live in the
// integration suite (not run in pre-commit).

const {
  DELIVERY_API_STATUS_FLOW,
  PUBLIC_API_SCOPE_RESOURCES,
  buildDeliveryApiCapabilities,
  buildDeliveryOpenApiSpec,
  generateApiKey,
  hashKey,
  signWebhookEnvelope,
  verifyKey,
  EVENTS,
} = require('../src/core/lib/publicApi');
const { requireScope } = require('../src/core/middleware/apiKey.middleware');

describe('generateApiKey', () => {
  test('emits prefixed raw key + matching hash + last4', () => {
    const { raw, hash, last4 } = generateApiKey();
    expect(raw).toMatch(/^sp_live_[a-f0-9]{64}$/);
    expect(hashKey(raw)).toBe(hash);
    expect(raw.endsWith(last4)).toBe(true);
    expect(last4).toHaveLength(4);
  });

  test('two keys are different + their hashes are different', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('verifyKey', () => {
  test('accepts the raw key against its own hash', () => {
    const { raw, hash } = generateApiKey();
    expect(verifyKey(raw, hash)).toBe(true);
  });

  test('rejects a different raw key', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(verifyKey(b.raw, a.hash)).toBe(false);
  });

  test('rejects null / undefined inputs', () => {
    const { hash } = generateApiKey();
    expect(verifyKey(null, hash)).toBe(false);
    expect(verifyKey('whatever', null)).toBe(false);
  });
});

describe('signWebhookEnvelope', () => {
  test('signs timestamp + raw body and returns a Stripe-style header', () => {
    const body = JSON.stringify({ event: 'delivery.delivered', payload: { id: 'delivery-1' } });
    const signed = signWebhookEnvelope('whsec_test', body, 1781085968);

    expect(signed.timestamp).toBe('1781085968');
    expect(signed.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(signed.header).toBe(`t=1781085968,v1=${signed.signature}`);
    expect(signWebhookEnvelope('whsec_test', `${body}x`, 1781085968).signature).not.toBe(signed.signature);
    expect(signWebhookEnvelope('whsec_test', body, 1781085969).signature).not.toBe(signed.signature);
  });
});

describe('EVENTS', () => {
  test('frozen list includes the canonical events used by webhooks', () => {
    expect(EVENTS).toContain('appointment.created');
    expect(EVENTS).toContain('order.paid');
    expect(EVENTS).toContain('customer.created');
    expect(EVENTS).toContain('delivery.exception_opened');
    expect(EVENTS).toContain('delivery.exception_escalated');
    expect(EVENTS).toContain('delivery.exception_resolved');
    expect(() => EVENTS.push('not.allowed')).toThrow();
  });
});

describe('PUBLIC_API_SCOPE_RESOURCES', () => {
  test('lists the stable resources API keys can grant', () => {
    expect(PUBLIC_API_SCOPE_RESOURCES).toEqual(expect.arrayContaining([
      'deliveries',
      'riders',
      'orders',
      'customers',
    ]));
    expect(PUBLIC_API_SCOPE_RESOURCES).not.toContain('billing-secrets');
    expect(() => PUBLIC_API_SCOPE_RESOURCES.push('not.allowed')).toThrow();
  });
});

describe('buildDeliveryApiCapabilities', () => {
  test('describes delivery API idempotency, lookup, and delivery webhooks', () => {
    const capabilities = buildDeliveryApiCapabilities({
      business: { id: 'biz-1', slug: 'pizza-house', name: 'Pizza House', vertical: 'ECOMMERCE' },
      apiKey: { id: 'key-1', name: 'Delivery key', scopes: { read: ['deliveries'], write: ['deliveries'] } },
      deliveryStatuses: ['PENDING', 'ASSIGNED', 'DELIVERED'],
      exceptionCodes: ['ADDRESS_ISSUE'],
      exceptionStatuses: ['OPEN', 'RESOLVED'],
    });

    expect(capabilities.business.slug).toBe('pizza-house');
    expect(capabilities.deliveries.idempotency.field).toBe('externalRef');
    expect(capabilities.deliveries.statusFlow).toBe(DELIVERY_API_STATUS_FLOW);
    expect(capabilities.deliveries.filters).toMatchObject({
      status: expect.stringContaining('comma-separated'),
      riderId: 'registered rider id',
      updatedSince: 'ISO date/time lower bound on updatedAt',
      createdSince: 'ISO date/time lower bound on createdAt',
    });
    expect(capabilities.deliveries.endpoints.bulkCreate).toBe('POST /api/v1/deliveries/bulk');
    expect(capabilities.deliveries.endpoints.openApi).toBe('GET /api/v1/deliveries/openapi.json');
    expect(capabilities.deliveries.endpoints.lookupByExternalRef).toContain('/api/v1/deliveries/lookup');
    expect(capabilities.deliveries.webhookEvents).toEqual(expect.arrayContaining([
      'delivery.created',
      'delivery.delivered',
      'delivery.exception_opened',
    ]));
    expect(capabilities.deliveries.webhookEvents.every((event) => event.startsWith('delivery.'))).toBe(true);
    expect(capabilities.deliveries.webhooks.signatureHeader).toContain('X-Sitepresso-Signature-V2');
    expect(capabilities.deliveries.webhooks.deliveryIdHeader).toBe('X-Sitepresso-Delivery-Id');
    expect(capabilities.deliveries.webhooks.webhookIdHeader).toBe('X-Sitepresso-Webhook-Id');
    expect(capabilities.deliveries.webhooks.eventHeader).toBe('X-Sitepresso-Event');
    expect(capabilities.deliveries.assignment.riderReferenceFields).toEqual(expect.arrayContaining([
      'riderId',
      'riderPhone',
      'riderEmail',
    ]));
    expect(capabilities.deliveries.retryScheduling).toMatchObject({
      requestField: 'nextAttemptAt',
      failedStatus: 'ATTEMPTED_FAILED',
      retryStatus: 'READY_FOR_DISPATCH',
    });
    expect(capabilities.deliveries.retryScheduling.responseFields).toEqual(expect.arrayContaining(['attemptCount', 'nextAttemptAt']));
    expect(capabilities.deliveries.reconciliation.cashFields).toEqual(expect.arrayContaining([
      'cashReceivedMinor',
      'cashChangeDueMinor',
      'cashCollectedMinor',
    ]));
    expect(capabilities.deliveries.lifecycleTimestamps).toEqual(expect.arrayContaining([
      'assignedAt',
      'arrivedAt',
      'returnedAt',
    ]));
    expect(capabilities.deliveries.proofOfDelivery.responseFields).toContain('proofSignatureUrl');
    expect(capabilities.deliveries.proofOfDelivery.otpReturnedByApi).toBe(false);
  });
});

describe('buildDeliveryOpenApiSpec', () => {
  test('generates a machine-readable delivery and rider API contract', () => {
    const spec = buildDeliveryOpenApiSpec({
      business: { id: 'biz-1', slug: 'pizza-house', name: 'Pizza House' },
      deliveryStatuses: ['PENDING', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED'],
      exceptionCodes: ['ADDRESS_ISSUE', 'OTHER'],
      exceptionStatuses: ['OPEN', 'RESOLVED'],
    });

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toContain('AapkaRider');
    expect(spec.security).toEqual([{ bearerApiKey: [] }]);
    expect(spec['x-sitepresso-business']).toMatchObject({ slug: 'pizza-house' });
    expect(spec['x-sitepresso-delivery-status-flow']).toBe(DELIVERY_API_STATUS_FLOW);
    expect(spec['x-sitepresso-webhook-headers']).toMatchObject({
      signature: 'X-Sitepresso-Signature-V2',
      deliveryId: 'X-Sitepresso-Delivery-Id',
    });
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([
      '/deliveries',
      '/deliveries/bulk',
      '/deliveries/capabilities',
      '/deliveries/openapi.json',
      '/deliveries/{id}/status',
      '/riders',
      '/riders/{id}/status',
    ]));
    expect(spec.paths['/deliveries'].get.parameters.map((param) => param.name)).toEqual(expect.arrayContaining([
      'status',
      'riderId',
      'createdSince',
      'updatedSince',
    ]));
    expect(spec.components.securitySchemes.bearerApiKey).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(spec.components.schemas.Delivery.properties.status.enum).toEqual([
      'PENDING',
      'ASSIGNED',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
    ]);
    expect(spec.components.schemas.DeliveryCreateRequest.required).toEqual(['externalRef', 'customerName', 'dropoff']);
    expect(spec.components.schemas.DeliveryStatusUpdateRequest.properties.riderPhone.type).toBe('string');
  });
});

describe('requireScope middleware', () => {
  function fakeReq(scopes) {
    return { apiKey: { scopes } };
  }
  function fakeRes() {
    return {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
  }

  test('allows when the exact scope is present', () => {
    const mw = requireScope('read', 'appointments');
    const req = fakeReq({ read: ['appointments'], write: [] });
    const res = fakeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  test('allows delivery rider scopes independently', () => {
    const mw = requireScope('write', 'riders');
    const req = fakeReq({ read: ['deliveries'], write: ['riders'] });
    const res = fakeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  test("allows when wildcard '*' is present", () => {
    const mw = requireScope('read', 'orders');
    const req = fakeReq({ read: ['*'], write: [] });
    const res = fakeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  test('forbids when scope is missing', () => {
    const mw = requireScope('read', 'orders');
    const req = fakeReq({ read: ['customers'], write: [] });
    const res = fakeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  test("write actions don't satisfy read requirements (and vice versa)", () => {
    const mw = requireScope('read', 'orders');
    const req = fakeReq({ read: [], write: ['orders'] });
    const res = fakeRes();
    mw(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  test('handles missing scopes object gracefully', () => {
    const mw = requireScope('read', 'orders');
    const req = { apiKey: {} };
    const res = fakeRes();
    mw(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });
});
