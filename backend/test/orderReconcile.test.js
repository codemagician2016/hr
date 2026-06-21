// Grocery pick-exception reconciliation math.
// Pure functions — no Prisma, no DB.

const {
  weightLineMinor,
  effectiveLineTotal,
  reconcileTotals,
  isLineResolved,
  computeFulfillmentRates,
} = require('../src/core/lib/orderReconcile');

describe('weightLineMinor', () => {
  test('prices grams at a per-kg rate', () => {
    // 1.08 kg of tomatoes @ ₹120/kg (12000 minor/kg) = ₹129.60
    expect(weightLineMinor(12000, 1080)).toBe(12960);
  });
  test('guards missing inputs', () => {
    expect(weightLineMinor(0, 1080)).toBe(0);
    expect(weightLineMinor(12000, 0)).toBe(0);
  });
});

describe('effectiveLineTotal', () => {
  test('picked-as-ordered keeps the original line total', () => {
    expect(effectiveLineTotal({ fulfillmentStatus: 'PICKED', lineTotalMinor: 5000 })).toBe(5000);
  });
  test('sold-by-weight line reprices from the weighed amount', () => {
    expect(effectiveLineTotal({
      soldByWeight: true, pricePerKgMinor: 12000, pickedWeightGrams: 1080, lineTotalMinor: 12000,
    })).toBe(12960);
  });
  test('accepted substitution bills the replacement', () => {
    expect(effectiveLineTotal({
      fulfillmentStatus: 'SUBSTITUTED', substitutionStatus: 'AUTO_ACCEPTED',
      substitutePriceMinor: 3000, substituteQuantity: 2, lineTotalMinor: 5000,
    })).toBe(6000);
  });
  test('proposed substitution still bills the original until resolved', () => {
    expect(effectiveLineTotal({
      fulfillmentStatus: 'SUBSTITUTED', substitutionStatus: 'PROPOSED',
      substitutePriceMinor: 9999, substituteQuantity: 2, lineTotalMinor: 5000,
    })).toBe(5000);
  });
  test('shorted line bills only the fulfilled remainder', () => {
    expect(effectiveLineTotal({
      fulfillmentStatus: 'SHORTED', quantity: 3, shortedQuantity: 1, priceMinor: 2500, lineTotalMinor: 7500,
    })).toBe(5000);
  });
});

describe('reconcileTotals', () => {
  test('a fully-shorted line lowers the total and owes a refund', () => {
    const order = {
      totalMinor: 20000, shippingMinor: 0, taxMinor: 0, discountMinor: 0,
      items: [
        { fulfillmentStatus: 'PICKED', lineTotalMinor: 15000 },
        { fulfillmentStatus: 'SHORTED', quantity: 1, shortedQuantity: 1, priceMinor: 5000, lineTotalMinor: 5000 },
      ],
    };
    const rec = reconcileTotals(order);
    expect(rec.adjustedTotalMinor).toBe(15000);
    expect(rec.deltaMinor).toBe(5000); // positive = customer owed a refund
  });
  test('keeps shipping/tax and never goes negative', () => {
    const order = {
      totalMinor: 11000, shippingMinor: 1000, taxMinor: 0, discountMinor: 0,
      items: [{ fulfillmentStatus: 'SHORTED', quantity: 1, shortedQuantity: 1, priceMinor: 10000, lineTotalMinor: 10000 }],
    };
    const rec = reconcileTotals(order);
    expect(rec.adjustedTotalMinor).toBe(1000); // only shipping remains
    expect(rec.deltaMinor).toBe(10000);
  });
});

describe('isLineResolved', () => {
  test('a proposed substitution blocks completion', () => {
    expect(isLineResolved({ fulfillmentStatus: 'SUBSTITUTED', substitutionStatus: 'PROPOSED' }, 0)).toBe(false);
  });
  test('an accepted substitution is resolved', () => {
    expect(isLineResolved({ fulfillmentStatus: 'SUBSTITUTED', substitutionStatus: 'ACCEPTED' }, 0)).toBe(true);
  });
  test('a sold-by-weight line must be weighed', () => {
    expect(isLineResolved({ soldByWeight: true, quantity: 1, pickedWeightGrams: null }, 1)).toBe(false);
    expect(isLineResolved({ soldByWeight: true, quantity: 1, pickedWeightGrams: 900 }, 0)).toBe(true);
  });
  test('a normal line needs every unit picked', () => {
    expect(isLineResolved({ quantity: 2 }, 1)).toBe(false);
    expect(isLineResolved({ quantity: 2 }, 2)).toBe(true);
  });
});

describe('computeFulfillmentRates', () => {
  test('on-time, fill, and substitution rates over a set of orders', () => {
    const orders = [
      // delivered on time, all picked
      { promisedAt: '2026-06-01T14:00:00Z', deliveredAt: '2026-06-01T13:30:00Z',
        items: [{ quantity: 2, fulfillmentStatus: 'PICKED' }] },
      // delivered late, one unit shorted, one substituted
      { promisedAt: '2026-06-01T14:00:00Z', deliveredAt: '2026-06-01T15:10:00Z',
        items: [
          { quantity: 3, fulfillmentStatus: 'SHORTED', shortedQuantity: 1 },
          { quantity: 1, fulfillmentStatus: 'SUBSTITUTED' },
        ] },
      // pickup completed on time, all picked (no promise mismatch)
      { promisedAt: '2026-06-02T10:00:00Z', pickedUpAt: '2026-06-02T09:50:00Z',
        items: [{ quantity: 4, fulfillmentStatus: 'PICKED' }] },
      // not yet delivered → excluded from on-time denominator
      { promisedAt: '2026-06-03T10:00:00Z', items: [{ quantity: 1, fulfillmentStatus: 'PENDING' }] },
    ];
    const r = computeFulfillmentRates(orders);
    expect(r.totalOrders).toBe(4);
    expect(r.promisedOrders).toBe(3);      // 3 completed with a promise
    expect(r.onTimeOrders).toBe(2);        // first + third
    expect(r.onTimeRate).toBe(66.7);
    expect(r.orderedUnits).toBe(11);       // 2+3+1+4+1
    expect(r.fulfilledUnits).toBe(10);     // one unit shorted
    expect(r.fillRate).toBe(90.9);
    expect(r.ordersWithSubstitution).toBe(1);
    expect(r.substitutionRate).toBe(25);
    expect(r.ordersWithShort).toBe(1);
  });
  test('null rates when there is no denominator', () => {
    const r = computeFulfillmentRates([]);
    expect(r.onTimeRate).toBeNull();
    expect(r.fillRate).toBeNull();
    expect(r.substitutionRate).toBeNull();
  });
});
