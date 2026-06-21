// Order status state-machine + checkout payload validator tests.
// Pure functions — no Prisma, no DB.

const {
  VALID_STATUS_TRANSITIONS,
  canTransition,
  validateCheckoutPayload,
  deliveryFeeForZone,
  selectDeliveryCandidate,
  deliveryAreaFailure,
  resolvedCheckoutLocationId,
  computePickedQuantities,
  buildPicklistPayload,
  isOrderFullyPicked,
  isClosedRouteStopStatus,
  pickupCodeMatches,
  routeOpenStops,
} = require('../src/shop/controllers/order.controller');

describe('Order status state machine', () => {
  test('PENDING → PAID is allowed', () => {
    expect(canTransition('PENDING', 'PAID')).toBe(true);
  });
  test('PENDING → CANCELLED is allowed', () => {
    expect(canTransition('PENDING', 'CANCELLED')).toBe(true);
  });
  test('PAID → PACKING is allowed', () => {
    expect(canTransition('PAID', 'PACKING')).toBe(true);
  });
  test('PACKING → OUT_FOR_DELIVERY is allowed', () => {
    expect(canTransition('PACKING', 'OUT_FOR_DELIVERY')).toBe(true);
  });
  test('OUT_FOR_DELIVERY → DELIVERED is allowed', () => {
    expect(canTransition('OUT_FOR_DELIVERY', 'DELIVERED')).toBe(true);
  });
  test('DELIVERED → REFUNDED is allowed', () => {
    expect(canTransition('DELIVERED', 'REFUNDED')).toBe(true);
  });
  test('FAILED → PENDING is allowed (retry)', () => {
    expect(canTransition('FAILED', 'PENDING')).toBe(true);
  });

  test('CANCELLED is terminal', () => {
    expect(VALID_STATUS_TRANSITIONS.CANCELLED).toEqual([]);
    expect(canTransition('CANCELLED', 'PAID')).toBe(false);
    expect(canTransition('CANCELLED', 'PACKING')).toBe(false);
  });
  test('REFUNDED is terminal', () => {
    expect(VALID_STATUS_TRANSITIONS.REFUNDED).toEqual([]);
    expect(canTransition('REFUNDED', 'PAID')).toBe(false);
  });

  test('cannot skip steps (PENDING → PACKING)', () => {
    expect(canTransition('PENDING', 'PACKING')).toBe(false);
  });
  test('COD orders can start fulfillment before payment is collected', () => {
    expect(canTransition('PENDING', 'PACKING', 'cod')).toBe(true);
    expect(canTransition('PACKING', 'OUT_FOR_DELIVERY', 'cod')).toBe(true);
    expect(canTransition('DELIVERED', 'PAID', 'cod')).toBe(true);
  });
  test('pickup orders can move through ready and picked-up states', () => {
    expect(canTransition('PACKING', 'READY_FOR_PICKUP', 'online')).toBe(true);
    expect(canTransition('READY_FOR_PICKUP', 'PICKED_UP', 'online')).toBe(true);
    expect(canTransition('PICKED_UP', 'PAID', 'cod')).toBe(true);
  });
  test('pickup code comparison is case-insensitive and trims spaces', () => {
    expect(pickupCodeMatches('AB23XZ', ' ab23xz ')).toBe(true);
    expect(pickupCodeMatches('AB23XZ', 'AB 23 XZ')).toBe(true);
    expect(pickupCodeMatches('AB23XZ', 'AB23XY')).toBe(false);
    expect(pickupCodeMatches('', 'AB23XZ')).toBe(false);
  });
  test('cannot reverse a successful PAID → PENDING', () => {
    expect(canTransition('PAID', 'PENDING')).toBe(false);
  });
  test('null / unknown source returns false', () => {
    expect(canTransition(null, 'PAID')).toBe(false);
    expect(canTransition(undefined, 'PAID')).toBe(false);
    expect(canTransition('NOT_A_STATUS', 'PAID')).toBe(false);
  });
});

describe('delivery route completion guards', () => {
  test('only final route stop statuses are considered closed', () => {
    expect(isClosedRouteStopStatus('DELIVERED')).toBe(true);
    expect(isClosedRouteStopStatus('ATTEMPTED_FAILED')).toBe(true);
    expect(isClosedRouteStopStatus('SKIPPED')).toBe(true);
    expect(isClosedRouteStopStatus('PENDING')).toBe(false);
    expect(isClosedRouteStopStatus('ARRIVED')).toBe(false);
  });

  test('routeOpenStops returns stops that still need rider or dispatcher action', () => {
    const open = routeOpenStops([
      { id: 'stop-1', status: 'DELIVERED' },
      { id: 'stop-2', status: 'PENDING' },
      { id: 'stop-3', status: 'ATTEMPTED_FAILED' },
      { id: 'stop-4', status: 'ARRIVED' },
      { id: 'stop-5', status: 'SKIPPED' },
    ]);

    expect(open.map((stop) => stop.id)).toEqual(['stop-2', 'stop-4']);
  });
});

describe('validateCheckoutPayload', () => {
  const goodAddress = {
    line1: '12 Test Lane',
    city: 'Mumbai',
    postalCode: '400001',
    country: 'IN',
  };

  test('returns no errors for a complete payload', () => {
    expect(validateCheckoutPayload({
      customerEmail: 'shopper@example.com',
      customerName: 'Anjali',
      shippingAddress: goodAddress,
    })).toEqual([]);
  });

  test('rejects missing email', () => {
    const errors = validateCheckoutPayload({
      customerName: 'Anjali',
      shippingAddress: goodAddress,
    });
    expect(errors.some((e) => e.includes('customerEmail'))).toBe(true);
  });

  test('rejects malformed email', () => {
    const errors = validateCheckoutPayload({
      customerEmail: 'not-an-email',
      customerName: 'Anjali',
      shippingAddress: goodAddress,
    });
    expect(errors.some((e) => e.includes('customerEmail'))).toBe(true);
  });

  test('rejects missing customerName', () => {
    const errors = validateCheckoutPayload({
      customerEmail: 'a@b.com',
      shippingAddress: goodAddress,
    });
    expect(errors.some((e) => e.includes('customerName'))).toBe(true);
  });

  test('rejects empty customerName', () => {
    const errors = validateCheckoutPayload({
      customerEmail: 'a@b.com',
      customerName: '   ',
      shippingAddress: goodAddress,
    });
    expect(errors.some((e) => e.includes('customerName'))).toBe(true);
  });

  test('rejects missing shippingAddress entirely', () => {
    const errors = validateCheckoutPayload({
      customerEmail: 'a@b.com',
      customerName: 'X',
    });
    expect(errors.some((e) => e.includes('shippingAddress'))).toBe(true);
  });

  test('rejects shippingAddress missing required fields', () => {
    const errors = validateCheckoutPayload({
      customerEmail: 'a@b.com',
      customerName: 'X',
      shippingAddress: { line1: '12 X', city: 'Mum' }, // missing postalCode, country
    });
    expect(errors.some((e) => e.includes('postalCode'))).toBe(true);
    expect(errors.some((e) => e.includes('country'))).toBe(true);
  });

  test('rejects non-ISO country code', () => {
    const errors = validateCheckoutPayload({
      customerEmail: 'a@b.com',
      customerName: 'X',
      shippingAddress: { ...goodAddress, country: 'India' },
    });
    expect(errors.some((e) => e.includes('country'))).toBe(true);
  });

  test('rejects missing body altogether', () => {
    const errors = validateCheckoutPayload(null);
    expect(errors.length).toBeGreaterThan(0);
  });

  test('accepts a valid delivery slot payload', () => {
    const errors = validateCheckoutPayload({
      customerEmail: 'a@b.com',
      customerName: 'X',
      shippingAddress: goodAddress,
      deliverySlotId: 'slot-uuid',
      deliveryDate: '2026-05-08',
    });
    expect(errors).toEqual([]);
  });

  test('rejects deliverySlotId without deliveryDate', () => {
    const errors = validateCheckoutPayload({
      customerEmail: 'a@b.com',
      customerName: 'X',
      shippingAddress: goodAddress,
      deliverySlotId: 'slot-uuid',
    });
    expect(errors.some((e) => e.includes('deliveryDate'))).toBe(true);
  });

  test('rejects malformed deliveryDate', () => {
    const errors = validateCheckoutPayload({
      customerEmail: 'a@b.com',
      customerName: 'X',
      shippingAddress: goodAddress,
      deliverySlotId: 'slot-uuid',
      deliveryDate: 'May 8 2026',
    });
    expect(errors.some((e) => e.includes('YYYY-MM-DD'))).toBe(true);
  });

  test('omitting both slot fields is valid (slot is optional)', () => {
    const errors = validateCheckoutPayload({
      customerEmail: 'a@b.com',
      customerName: 'X',
      shippingAddress: goodAddress,
    });
    expect(errors).toEqual([]);
  });

  test('accepts pickup payload without shipping address', () => {
    const errors = validateCheckoutPayload({
      customerEmail: 'a@b.com',
      customerName: 'X',
      fulfillmentType: 'PICKUP',
      pickupLocationId: 'pickup-1',
      paymentMethod: 'cod',
    });
    expect(errors).toEqual([]);
  });

  test('rejects pickup payload without pickup location', () => {
    const errors = validateCheckoutPayload({
      customerEmail: 'a@b.com',
      customerName: 'X',
      fulfillmentType: 'PICKUP',
    });
    expect(errors.some((e) => e.includes('pickupLocationId'))).toBe(true);
  });
});

describe('delivery zone helpers', () => {
  test('uses the zone delivery fee below the free-delivery threshold', () => {
    expect(deliveryFeeForZone({ deliveryFeeMinor: 499, freeDeliveryThresholdMinor: 5000 }, 2500)).toBe(499);
  });

  test('waives the zone delivery fee once the subtotal reaches the threshold', () => {
    expect(deliveryFeeForZone({ deliveryFeeMinor: 499, freeDeliveryThresholdMinor: 5000 }, 5000)).toBe(0);
  });

  test('returns null when no delivery zone matched', () => {
    expect(deliveryFeeForZone(null, 2500)).toBeNull();
  });

  test('selects the candidate for the cart store when a location is set', () => {
    const candidates = [
      { location: { id: 'loc-a' }, zone: { id: 'zone-a' } },
      { location: { id: 'loc-b' }, zone: { id: 'zone-b' } },
    ];
    expect(selectDeliveryCandidate(candidates, 'loc-b').zone.id).toBe('zone-b');
  });

  test('falls back to the first candidate when no store is set', () => {
    const candidates = [
      { location: { id: 'loc-a' }, zone: { id: 'zone-a' } },
      { location: { id: 'loc-b' }, zone: { id: 'zone-b' } },
    ];
    expect(selectDeliveryCandidate(candidates, null).zone.id).toBe('zone-a');
  });

  test('allows legacy delivery when no delivery areas are configured', () => {
    expect(deliveryAreaFailure({
      hasActiveDeliveryAreas: false,
      deliveryCandidate: null,
      shopperLocationRequired: false,
      cartLocationId: null,
    })).toBeNull();
  });

  test('blocks uncovered pincodes once delivery areas exist', () => {
    expect(deliveryAreaFailure({
      hasActiveDeliveryAreas: true,
      deliveryCandidate: null,
      shopperLocationRequired: false,
      cartLocationId: null,
    })).toMatchObject({ reason: 'DELIVERY_AREA_UNSERVICEABLE' });
  });

  test('keeps selected-store mismatch reason for chain stores', () => {
    expect(deliveryAreaFailure({
      hasActiveDeliveryAreas: true,
      deliveryCandidate: null,
      shopperLocationRequired: true,
      cartLocationId: 'loc-a',
    })).toMatchObject({ reason: 'DELIVERY_LOCATION_MISMATCH' });
  });

  test('uses the cart location when one is already selected', () => {
    expect(resolvedCheckoutLocationId({
      fulfillmentType: 'DELIVERY',
      cartLocationId: 'loc-cart',
      deliveryCandidate: { location: { id: 'loc-zone' } },
      pickupLocation: null,
    })).toBe('loc-cart');
  });

  test('falls back to the delivery-area branch when checkout resolves a pincode', () => {
    expect(resolvedCheckoutLocationId({
      fulfillmentType: 'DELIVERY',
      cartLocationId: null,
      deliveryCandidate: { location: { id: 'loc-zone' } },
      pickupLocation: null,
    })).toBe('loc-zone');
  });

  test('falls back to the pickup counter branch for pickup orders', () => {
    expect(resolvedCheckoutLocationId({
      fulfillmentType: 'PICKUP',
      cartLocationId: null,
      deliveryCandidate: null,
      pickupLocation: { locationId: 'loc-pickup' },
    })).toBe('loc-pickup');
  });

  test('returns null when no checkout branch can be resolved', () => {
    expect(resolvedCheckoutLocationId({
      fulfillmentType: 'DELIVERY',
      cartLocationId: null,
      deliveryCandidate: null,
      pickupLocation: null,
    })).toBeNull();
  });
});

describe('picklist helpers', () => {
  const order = {
    id: 'order-1',
    status: 'PACKING',
    fulfillmentType: 'DELIVERY',
    locationId: 'loc-1',
    items: [
      { id: 'line-1', productId: 'prod-1', productName: 'Milk', productSlug: 'milk', quantity: 2, priceMinor: 300, lineTotalMinor: 600, product: { sku: 'MILK-1L' } },
      { id: 'line-2', productId: 'prod-2', productName: 'Bread', productSlug: 'bread', quantity: 1, priceMinor: 250, lineTotalMinor: 250, product: { sku: 'BREAD' } },
    ],
  };

  test('aggregates picked quantities from order events', () => {
    expect(computePickedQuantities([
      { kind: 'ITEM_PICKED', payload: { orderItemId: 'line-1', delta: 1 } },
      { kind: 'ITEM_PICKED', payload: { orderItemId: 'line-1', delta: 1 } },
      { kind: 'STATUS_CHANGED', payload: { to: 'PACKING' } },
    ])).toEqual({ 'line-1': 2 });
  });

  test('builds remaining quantities and completion flag', () => {
    const picklist = buildPicklistPayload(order, [
      { kind: 'ITEM_PICKED', payload: { orderItemId: 'line-1', delta: 2 } },
    ]);
    expect(picklist.pickedQuantity).toBe(2);
    expect(picklist.remainingQuantity).toBe(1);
    expect(picklist.complete).toBe(false);
    expect(picklist.items[0].sku).toBe('MILK-1L');
  });

  test('marks an order fully picked only when every unit is picked', () => {
    const events = [
      { kind: 'ITEM_PICKED', payload: { orderItemId: 'line-1', delta: 2 } },
      { kind: 'ITEM_PICKED', payload: { orderItemId: 'line-2', delta: 1 } },
    ];
    expect(isOrderFullyPicked(order, events)).toBe(true);
  });
});
