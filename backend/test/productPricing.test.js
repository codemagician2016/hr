// Per-currency price resolution. Pure functions — no DB.

const { resolvePrice, convertMinor } = require('../src/core/lib/productPricing');

describe('convertMinor', () => {
  test('same currency is identity', () => {
    expect(convertMinor(99900, 'INR', 'INR')).toBe(99900);
  });
  test('INR → USD round-trip is sane', () => {
    expect(convertMinor(99900, 'INR', 'USD')).toBeGreaterThan(1000);
    expect(convertMinor(99900, 'INR', 'USD')).toBeLessThan(2000);
  });
  test('returns null for unknown currency', () => {
    expect(convertMinor(1000, 'XYZ', 'USD')).toBeNull();
    expect(convertMinor(1000, 'INR', 'XYZ')).toBeNull();
  });
});

describe('resolvePrice', () => {
  const product = {
    currency: 'INR',
    priceMinor: 99900,        // ₹999
    comparePriceMinor: 129900, // ₹1299
    prices: [
      { currencyCode: 'USD', priceMinor: 1499 },     // explicit override $14.99
      { currencyCode: 'GBP', priceMinor: 1199, comparePriceMinor: 1499 },
    ],
  };

  test('same currency returns default price', () => {
    const r = resolvePrice(product, 'INR');
    expect(r.priceMinor).toBe(99900);
    expect(r.source).toBe('default');
  });

  test('override beats FX conversion', () => {
    const r = resolvePrice(product, 'USD');
    expect(r.priceMinor).toBe(1499);
    expect(r.source).toBe('override');
  });

  test('override compare price preserved', () => {
    const r = resolvePrice(product, 'GBP');
    expect(r.priceMinor).toBe(1199);
    expect(r.comparePriceMinor).toBe(1499);
    expect(r.source).toBe('override');
  });

  test('no override → FX-convert', () => {
    const r = resolvePrice(product, 'EUR');
    expect(r.source).toBe('fx-converted');
    expect(r.priceMinor).toBeGreaterThan(0);
    expect(r.currencyCode).toBe('EUR');
  });

  test('unknown currency falls back to default', () => {
    const r = resolvePrice(product, 'XYZ');
    expect(r.source).toBe('default');
    expect(r.priceMinor).toBe(99900);
  });

  test('null product returns null', () => {
    expect(resolvePrice(null, 'USD')).toBeNull();
  });

  test('product with no prices array works', () => {
    const minimal = { currency: 'INR', priceMinor: 50000, comparePriceMinor: null };
    expect(resolvePrice(minimal, 'INR').priceMinor).toBe(50000);
    expect(resolvePrice(minimal, 'USD').source).toBe('fx-converted');
  });
});
