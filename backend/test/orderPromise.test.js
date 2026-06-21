// SLA promise-time computation + substitution-policy normalisation.
// Pure functions exported from the order controller — no DB.

const {
  computePromisedAt,
  normaliseSubstitutionPolicy,
} = require('../src/shop/controllers/order.controller');

describe('computePromisedAt', () => {
  test('delivery with a slot → slot end time on the delivery date', () => {
    const at = computePromisedAt({
      fulfillmentType: 'DELIVERY',
      resolvedSlot: { slot: { endTime: '14:00' }, deliveryDateUTC: new Date('2026-06-01T00:00:00Z') },
    });
    expect(at.toISOString()).toBe('2026-06-01T14:00:00.000Z');
  });
  test('delivery without a slot → null (no promise made)', () => {
    expect(computePromisedAt({ fulfillmentType: 'DELIVERY', resolvedSlot: null })).toBeNull();
  });
  test('pickup → now + prep time', () => {
    const at = computePromisedAt({ fulfillmentType: 'PICKUP', pickupLocation: { prepTimeMinutes: 30 } });
    const delta = at.getTime() - Date.now();
    expect(delta).toBeGreaterThan(29 * 60000);
    expect(delta).toBeLessThanOrEqual(30 * 60000);
  });
  test('pickup without a prep time → null', () => {
    expect(computePromisedAt({ fulfillmentType: 'PICKUP', pickupLocation: {} })).toBeNull();
  });
});

describe('normaliseSubstitutionPolicy', () => {
  test('defaults to APPROVE', () => {
    expect(normaliseSubstitutionPolicy(undefined)).toBe('APPROVE');
    expect(normaliseSubstitutionPolicy('')).toBe('APPROVE');
  });
  test('passes through canonical values', () => {
    expect(normaliseSubstitutionPolicy('AUTO')).toBe('AUTO');
    expect(normaliseSubstitutionPolicy('refund')).toBe('REFUND');
  });
  test('maps storefront synonyms', () => {
    expect(normaliseSubstitutionPolicy('best_match')).toBe('AUTO');
    expect(normaliseSubstitutionPolicy('none')).toBe('REFUND');
  });
});
