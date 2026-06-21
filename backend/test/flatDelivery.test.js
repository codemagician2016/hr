const { describe, it, expect } = require('@jest/globals');
const { deliveryFeeForZone, flatDeliveryFee } = require('../src/shop/controllers/order.controller');

// Store-level FLAT delivery — the deliver-anywhere baseline used when no zone
// matches. Always server-computed; the buyer can never pay ₹0 by tampering with
// a client-sent shippingMinor.
describe('flatDeliveryFee', () => {
  it('returns the flat fee when below the free-over threshold', () => {
    const biz = { flatDeliveryFeeMinor: 4000, flatFreeDeliveryThresholdMinor: 50000 };
    expect(flatDeliveryFee(biz, 30000)).toBe(4000);
  });

  it('is free at or above the free-over threshold', () => {
    const biz = { flatDeliveryFeeMinor: 4000, flatFreeDeliveryThresholdMinor: 50000 };
    expect(flatDeliveryFee(biz, 50000)).toBe(0);
    expect(flatDeliveryFee(biz, 60000)).toBe(0);
  });

  it('charges the fee on every order when no free threshold is set', () => {
    const biz = { flatDeliveryFeeMinor: 4000, flatFreeDeliveryThresholdMinor: 0 };
    expect(flatDeliveryFee(biz, 999999)).toBe(4000);
  });

  it('treats a 0 fee as free delivery', () => {
    expect(flatDeliveryFee({ flatDeliveryFeeMinor: 0 }, 12345)).toBe(0);
  });

  it('never returns negative or NaN from missing/garbage config', () => {
    expect(flatDeliveryFee(null, 100)).toBe(0);
    expect(flatDeliveryFee({}, 100)).toBe(0);
    expect(flatDeliveryFee({ flatDeliveryFeeMinor: -50 }, 100)).toBe(0);
  });
});

// The checkout rule: a matching zone overrides; otherwise the store flat rate is
// the fallback (NEVER the client-sent value). This mirrors the shippingMinor line
// `deliveryFeeForZone(zone, subtotal) ?? flatDeliveryFee(business, subtotal)`.
describe('checkout delivery-fee resolution (zone override else flat)', () => {
  const resolve = (zone, business, subtotal) =>
    deliveryFeeForZone(zone, subtotal) ?? flatDeliveryFee(business, subtotal);

  it('uses the zone fee when a zone matches', () => {
    const zone = { deliveryFeeMinor: 9000, freeDeliveryThresholdMinor: 0 };
    const business = { flatDeliveryFeeMinor: 4000 };
    expect(resolve(zone, business, 10000)).toBe(9000);
  });

  it('falls back to the store flat rate when no zone matches', () => {
    const business = { flatDeliveryFeeMinor: 4000, flatFreeDeliveryThresholdMinor: 0 };
    expect(resolve(null, business, 10000)).toBe(4000);
  });

  it('zone free-over still wins over flat when the zone matches', () => {
    const zone = { deliveryFeeMinor: 9000, freeDeliveryThresholdMinor: 5000 };
    const business = { flatDeliveryFeeMinor: 4000 };
    expect(resolve(zone, business, 6000)).toBe(0); // zone free-over → 0, not flat 4000
  });

  it('no zone + no flat config = free (0), not undefined/NaN', () => {
    expect(resolve(null, {}, 10000)).toBe(0);
  });
});
