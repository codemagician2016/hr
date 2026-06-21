const {
  buildDispatchRecommendations,
  distanceMeters,
  normalizeOrder,
} = require('../src/core/lib/ecomRouteOptimizer');

function order(overrides = {}) {
  return {
    id: overrides.id || 'order-1',
    locationId: overrides.locationId || 'loc-1',
    shippingAddress: overrides.shippingAddress || {
      line1: '1 Main St',
      city: 'Delhi',
      postalCode: '110001',
      lat: 28.6139,
      lng: 77.2090,
    },
    promisedAt: overrides.promisedAt || new Date('2026-06-10T10:00:00.000Z'),
    placedAt: overrides.placedAt || new Date('2026-06-10T08:00:00.000Z'),
    paymentMethod: overrides.paymentMethod || 'online',
    paidAt: overrides.paidAt || new Date('2026-06-10T08:01:00.000Z'),
    totalMinor: overrides.totalMinor ?? 1000,
    adjustedTotalMinor: overrides.adjustedTotalMinor,
    items: overrides.items || [{ quantity: 2 }],
    ...overrides,
  };
}

describe('ecomRouteOptimizer', () => {
  test('clusters nearby ready orders into one recommended route', () => {
    const recommendations = buildDispatchRecommendations({
      orders: [
        order({ id: 'near-1', shippingAddress: { city: 'Delhi', postalCode: '110001', lat: 28.6139, lng: 77.2090 } }),
        order({ id: 'near-2', shippingAddress: { city: 'Delhi', postalCode: '110001', lat: 28.6143, lng: 77.2101 } }),
        order({ id: 'far-1', shippingAddress: { city: 'Gurugram', postalCode: '122001', lat: 28.4595, lng: 77.0266 } }),
      ],
      riders: [{
        id: 'rider-1',
        fullName: 'Rider One',
        vehicleType: 'BIKE',
        status: 'ACTIVE',
        homeLocationId: 'loc-1',
        shifts: [{ id: 'shift-1', status: 'OPEN', locationId: 'loc-1', startedAt: new Date('2026-06-10T08:00:00.000Z') }],
      }],
      routes: [],
    });

    const grouped = recommendations.groups.find((group) => group.orderIds.includes('near-1'));
    expect(grouped.orderIds).toEqual(expect.arrayContaining(['near-1', 'near-2']));
    expect(grouped.orderIds).not.toContain('far-1');
    expect(grouped.stopCount).toBe(2);
    expect(grouped.locationId).toBe('loc-1');
    expect(grouped.rider.id).toBe('rider-1');
    expect(grouped.rider.capacityStatus).toBe('AVAILABLE');
  });

  test('prefers the active rider with less current route load', () => {
    const recommendations = buildDispatchRecommendations({
      orders: [
        order({ id: 'near-1' }),
        order({ id: 'near-2', shippingAddress: { city: 'Delhi', postalCode: '110001', lat: 28.6141, lng: 77.2095 } }),
      ],
      riders: [
        { id: 'busy-rider', fullName: 'Busy Rider', vehicleType: 'BIKE', status: 'ACTIVE', homeLocationId: 'loc-1', shifts: [{ id: 'shift-busy', status: 'OPEN', locationId: 'loc-1' }] },
        { id: 'free-rider', fullName: 'Free Rider', vehicleType: 'BIKE', status: 'ACTIVE', homeLocationId: 'loc-1', shifts: [{ id: 'shift-free', status: 'OPEN', locationId: 'loc-1' }] },
      ],
      routes: [{
        id: 'route-1',
        riderId: 'busy-rider',
        locationId: 'loc-1',
        status: 'DISPATCHED',
        stops: [{ status: 'EN_ROUTE' }, { status: 'ARRIVED' }, { status: 'PENDING' }],
      }],
    });

    expect(recommendations.groups[0].rider.id).toBe('free-rider');
    expect(recommendations.groups[0].rider.activeStops).toBe(0);
    expect(recommendations.groups[0].rider.capacityAfter).toBe(2);
  });

  test('falls back to postal and city grouping when coordinates are missing', () => {
    const recommendations = buildDispatchRecommendations({
      orders: [
        order({ id: 'postal-1', shippingAddress: { city: 'Auckland', postalCode: '1010' } }),
        order({ id: 'postal-2', shippingAddress: { city: 'Auckland', postalCode: '1010' } }),
        order({ id: 'other-city', shippingAddress: { city: 'Wellington', postalCode: '6011' } }),
      ],
      riders: [],
      routes: [],
    });

    const grouped = recommendations.groups.find((group) => group.orderIds.includes('postal-1'));
    expect(grouped.orderIds).toEqual(expect.arrayContaining(['postal-1', 'postal-2']));
    expect(grouped.orderIds).not.toContain('other-city');
  });

  test('normalizes COD cash and address coordinates', () => {
    const normalized = normalizeOrder(order({
      paymentMethod: 'cod',
      paidAt: null,
      adjustedTotalMinor: 1250,
      shippingAddress: { city: 'Delhi', postalCode: '110001', latitude: 28.6139, longitude: 77.2090 },
    }));

    expect(normalized.cashToCollectMinor).toBe(1250);
    expect(normalized.point).toEqual({ lat: 28.6139, lng: 77.2090 });
    expect(distanceMeters(normalized.point, { lat: 28.6139, lng: 77.2090 })).toBe(0);
  });

  test('recommends only checked-in riders when shift data is present', () => {
    const recommendations = buildDispatchRecommendations({
      orders: [order({ id: 'near-1' })],
      riders: [
        { id: 'off-shift', fullName: 'Off Shift', vehicleType: 'BIKE', status: 'ACTIVE', homeLocationId: 'loc-1', shifts: [] },
        { id: 'checked-in', fullName: 'Checked In', vehicleType: 'BIKE', status: 'ACTIVE', homeLocationId: 'loc-1', shifts: [{ id: 'shift-1', status: 'OPEN', locationId: 'loc-1' }] },
      ],
      routes: [],
    });

    expect(recommendations.groups[0].rider.id).toBe('checked-in');
    expect(recommendations.groups[0].rider.onShift).toBe(true);
  });

  test('counts direct delivery load when ranking checked-in riders', () => {
    const recommendations = buildDispatchRecommendations({
      orders: [order({ id: 'near-1' }), order({ id: 'near-2', shippingAddress: { city: 'Delhi', postalCode: '110001', lat: 28.6141, lng: 77.2095 } })],
      riders: [
        { id: 'direct-busy', fullName: 'Direct Busy', vehicleType: 'BIKE', status: 'ACTIVE', homeLocationId: 'loc-1', shifts: [{ id: 'shift-busy', status: 'OPEN', locationId: 'loc-1' }] },
        { id: 'free-rider', fullName: 'Free Rider', vehicleType: 'BIKE', status: 'ACTIVE', homeLocationId: 'loc-1', shifts: [{ id: 'shift-free', status: 'OPEN', locationId: 'loc-1' }] },
      ],
      routes: [],
      activeDeliveries: [
        { id: 'del-1', riderId: 'direct-busy', status: 'OUT_FOR_DELIVERY' },
        { id: 'del-2', riderId: 'direct-busy', status: 'ARRIVED' },
      ],
    });

    expect(recommendations.groups[0].rider.id).toBe('free-rider');
    expect(recommendations.groups[0].rider.activeDeliveries).toBe(0);
  });

  test('does not treat missing coordinates as zero-zero', () => {
    const normalized = normalizeOrder(order({
      shippingAddress: { city: 'Delhi', postalCode: '110001', lat: null, lng: null },
    }));

    expect(normalized.point).toBeNull();
  });
});
