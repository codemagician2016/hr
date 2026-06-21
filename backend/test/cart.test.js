// Unit tests for backend/src/core/lib/cart.js — pure-function helpers powering
// the e-commerce cart. The Prisma-touching functions get a mock client
// passed in directly, so no DB needed.

const cartLib = require('../src/core/lib/cart');
const { DEFAULT_CURRENCY } = require('../src/core/lib/currency');

describe('isValidSessionId', () => {
  test('accepts UUID-style identifiers', () => {
    expect(cartLib.isValidSessionId('abcd1234-ef56-7890-abcd-ef1234567890')).toBe(true);
  });
  test('accepts short alphanumeric tokens', () => {
    expect(cartLib.isValidSessionId('cart-abcdef12')).toBe(true);
  });
  test('rejects empty / null / too-short', () => {
    expect(cartLib.isValidSessionId('')).toBe(false);
    expect(cartLib.isValidSessionId(null)).toBe(false);
    expect(cartLib.isValidSessionId('abc')).toBe(false);
  });
  test('rejects payloads containing whitespace or special chars', () => {
    expect(cartLib.isValidSessionId('abc def123')).toBe(false);
    expect(cartLib.isValidSessionId('abc/def/123')).toBe(false);
    expect(cartLib.isValidSessionId('abc;def;123')).toBe(false);
  });
  test('rejects > 64 chars', () => {
    expect(cartLib.isValidSessionId('a'.repeat(65))).toBe(false);
  });
});

describe('lineTotal', () => {
  test('multiplies quantity by priceMinor', () => {
    expect(cartLib.lineTotal({ quantity: 3, priceMinor: 4500 })).toBe(13500);
  });
  test('returns 0 when quantity or price is missing', () => {
    expect(cartLib.lineTotal({})).toBe(0);
    expect(cartLib.lineTotal({ quantity: 5 })).toBe(0);
    expect(cartLib.lineTotal({ priceMinor: 100 })).toBe(0);
  });
  test('clamps negative inputs to 0', () => {
    expect(cartLib.lineTotal({ quantity: -2, priceMinor: 100 })).toBe(0);
    expect(cartLib.lineTotal({ quantity: 2, priceMinor: -100 })).toBe(0);
  });
});

describe('subtotal', () => {
  test('sums every line', () => {
    const items = [
      { quantity: 1, priceMinor: 1000 },
      { quantity: 3, priceMinor: 250 },
      { quantity: 2, priceMinor: 5000 },
    ];
    expect(cartLib.subtotal(items)).toBe(1000 + 750 + 10000);
  });
  test('returns 0 for empty / non-array', () => {
    expect(cartLib.subtotal([])).toBe(0);
    expect(cartLib.subtotal(null)).toBe(0);
    expect(cartLib.subtotal(undefined)).toBe(0);
  });
});

describe('clampQuantity', () => {
  test('returns the requested qty when no stock limit', () => {
    expect(cartLib.clampQuantity(5, null)).toBe(5);
    expect(cartLib.clampQuantity(5, undefined)).toBe(5);
  });
  test('floors fractional inputs', () => {
    expect(cartLib.clampQuantity(2.7, null)).toBe(2);
  });
  test('caps at 999 even with unlimited stock', () => {
    expect(cartLib.clampQuantity(50000, null)).toBe(999);
  });
  test('caps at stock limit when stock is the smaller bound', () => {
    expect(cartLib.clampQuantity(10, 3)).toBe(3);
  });
  test('returns 0 (out-of-stock signal) when stockQty is 0', () => {
    expect(cartLib.clampQuantity(2, 0)).toBe(0);
  });
  test('returns null for invalid inputs', () => {
    expect(cartLib.clampQuantity(0, null)).toBe(null);
    expect(cartLib.clampQuantity(-3, null)).toBe(null);
    expect(cartLib.clampQuantity('xyz', null)).toBe(null);
    expect(cartLib.clampQuantity(NaN, null)).toBe(null);
  });
});

describe('serialiseCart', () => {
  test('returns empty cart structure for null', () => {
    const out = cartLib.serialiseCart(null);
    expect(out).toEqual({
      id: null,
      items: [],
      subtotalMinor: 0,
      currency: DEFAULT_CURRENCY,
      itemCount: 0,
      locationId: null,
      location: null,
    });
  });

  test('hydrates items + flags drifted prices', () => {
    const cart = {
      id: 'cart-1',
      currency: 'INR',
      items: [
        { id: 'i1', productId: 'p1', quantity: 2, priceMinor: 100 },
        { id: 'i2', productId: 'p2', quantity: 1, priceMinor: 500 },
      ],
    };
    const productMap = new Map([
      ['p1', { id: 'p1', name: 'Apple', slug: 'apple', priceMinor: 100, imageUrls: [], stockQty: 50, isPublished: true }],
      ['p2', { id: 'p2', name: 'Bread', slug: 'bread', priceMinor: 600, imageUrls: ['/x.jpg'], stockQty: null, isPublished: true }],
    ]);
    const out = cartLib.serialiseCart(cart, productMap);
    expect(out.id).toBe('cart-1');
    expect(out.itemCount).toBe(3);
    expect(out.subtotalMinor).toBe(700); // 2*100 + 1*500 (snapshots, not current price)
    const apple = out.items.find((i) => i.productId === 'p1');
    const bread = out.items.find((i) => i.productId === 'p2');
    expect(apple.priceDrifted).toBe(false);
    expect(bread.priceDrifted).toBe(true);
    expect(bread.currentPriceMinor).toBe(600);
    expect(bread.product.name).toBe('Bread');
  });

  test('handles items whose product was deleted (productMap miss)', () => {
    const cart = {
      id: 'cart-2',
      currency: 'INR',
      items: [{ id: 'i1', productId: 'gone', quantity: 1, priceMinor: 200 }],
    };
    const out = cartLib.serialiseCart(cart, new Map());
    expect(out.items[0].product).toBe(null);
    expect(out.items[0].priceDrifted).toBe(false);
    expect(out.subtotalMinor).toBe(200);
  });
});

describe('resolveCart (with mock Prisma)', () => {
  function mockPrisma() {
    return {
      cart: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findUnique: jest.fn(),
      },
      cartItem: { update: jest.fn(), create: jest.fn() },
    };
  }

  test('looks up by customerId when customer is logged in', async () => {
    const prisma = mockPrisma();
    prisma.cart.findFirst.mockResolvedValueOnce({ id: 'c1', items: [] });
    const out = await cartLib.resolveCart({
      prisma, businessId: 'biz', customerId: 'cust', sessionId: 'sess-1234',
    });
    expect(out).toEqual({ id: 'c1', items: [] });
    expect(prisma.cart.findFirst).toHaveBeenCalledWith({
      where: { businessId: 'biz', customerId: 'cust' },
      include: { items: true },
    });
  });

  test('falls back to sessionId for guest', async () => {
    const prisma = mockPrisma();
    prisma.cart.findFirst.mockResolvedValueOnce({ id: 'g1', items: [] });
    const out = await cartLib.resolveCart({
      prisma, businessId: 'biz', customerId: null, sessionId: 'guest-sess-12345',
    });
    expect(out).toEqual({ id: 'g1', items: [] });
    expect(prisma.cart.findFirst).toHaveBeenCalledWith({
      where: { businessId: 'biz', sessionId: 'guest-sess-12345' },
      include: { items: true },
    });
  });

  test('returns null when neither identity is present', async () => {
    const prisma = mockPrisma();
    const out = await cartLib.resolveCart({
      prisma, businessId: 'biz', customerId: null, sessionId: null,
    });
    expect(out).toBe(null);
    expect(prisma.cart.findFirst).not.toHaveBeenCalled();
  });

  test('rejects malformed sessionId', async () => {
    const prisma = mockPrisma();
    const out = await cartLib.resolveCart({
      prisma, businessId: 'biz', customerId: null, sessionId: 'has space',
    });
    expect(out).toBe(null);
    expect(prisma.cart.findFirst).not.toHaveBeenCalled();
  });
});

describe('getOrCreateCart', () => {
  function mockPrisma() {
    return {
      cart: { findFirst: jest.fn(), create: jest.fn() },
    };
  }
  test('reuses existing cart', async () => {
    const prisma = mockPrisma();
    prisma.cart.findFirst.mockResolvedValueOnce({ id: 'have-it', items: [] });
    const out = await cartLib.getOrCreateCart({
      prisma, businessId: 'biz', customerId: 'cust',
    });
    expect(out.id).toBe('have-it');
    expect(prisma.cart.create).not.toHaveBeenCalled();
  });
  test('creates new with customerId when logged in', async () => {
    const prisma = mockPrisma();
    prisma.cart.findFirst.mockResolvedValueOnce(null);
    prisma.cart.create.mockResolvedValueOnce({ id: 'new', items: [] });
    await cartLib.getOrCreateCart({
      prisma, businessId: 'biz', customerId: 'cust', sessionId: 'sess-12345', currency: 'USD',
    });
    expect(prisma.cart.create).toHaveBeenCalledWith({
      data: { businessId: 'biz', customerId: 'cust', sessionId: null, currency: 'USD' },
      include: { items: true },
    });
  });
  test('creates new with sessionId for guest', async () => {
    const prisma = mockPrisma();
    prisma.cart.findFirst.mockResolvedValueOnce(null);
    prisma.cart.create.mockResolvedValueOnce({ id: 'new', items: [] });
    await cartLib.getOrCreateCart({
      prisma, businessId: 'biz', customerId: null, sessionId: 'sess-12345',
    });
    expect(prisma.cart.create).toHaveBeenCalledWith({
      data: { businessId: 'biz', customerId: null, sessionId: 'sess-12345', currency: 'USD' },
      include: { items: true },
    });
  });
  test('throws when no identity is provided', async () => {
    const prisma = mockPrisma();
    prisma.cart.findFirst.mockResolvedValueOnce(null);
    await expect(cartLib.getOrCreateCart({
      prisma, businessId: 'biz', customerId: null, sessionId: null,
    })).rejects.toThrow(/customerId or valid sessionId/);
  });
});

describe('mergeGuestCartIntoCustomer', () => {
  function mockPrisma() {
    return {
      cart: {
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findUnique: jest.fn(),
      },
      cartItem: { update: jest.fn(), create: jest.fn() },
    };
  }

  test('returns null without customerId', async () => {
    const prisma = mockPrisma();
    const out = await cartLib.mergeGuestCartIntoCustomer({
      prisma, businessId: 'biz', customerId: null, sessionId: 'sess-12345',
    });
    expect(out).toBe(null);
  });

  test('promotes the guest cart to customer cart when no customer cart exists', async () => {
    const prisma = mockPrisma();
    prisma.cart.findFirst
      .mockResolvedValueOnce({ id: 'guest', items: [{ id: 'i1', productId: 'p1', quantity: 1, priceMinor: 100 }] })
      .mockResolvedValueOnce(null);
    prisma.cart.update.mockResolvedValueOnce({ id: 'guest', customerId: 'cust', sessionId: null, items: [] });
    const out = await cartLib.mergeGuestCartIntoCustomer({
      prisma, businessId: 'biz', customerId: 'cust', sessionId: 'sess-12345',
    });
    expect(out.customerId).toBe('cust');
    expect(prisma.cart.update).toHaveBeenCalledWith({
      where: { id: 'guest' },
      data: { customerId: 'cust', sessionId: null },
      include: { items: true },
    });
  });

  test('sums quantities for products present in both carts', async () => {
    const prisma = mockPrisma();
    prisma.cart.findFirst
      .mockResolvedValueOnce({ id: 'guest', items: [{ id: 'g1', productId: 'p1', quantity: 2, priceMinor: 100 }] })
      .mockResolvedValueOnce({ id: 'cust', items: [{ id: 'c1', productId: 'p1', quantity: 1, priceMinor: 100 }] });
    prisma.cart.findUnique.mockResolvedValueOnce({ id: 'cust', items: [] });

    await cartLib.mergeGuestCartIntoCustomer({
      prisma, businessId: 'biz', customerId: 'cust', sessionId: 'sess-12345',
    });
    expect(prisma.cartItem.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { quantity: 3 },
    });
    expect(prisma.cart.delete).toHaveBeenCalledWith({ where: { id: 'guest' } });
  });

  test('copies non-overlapping guest items into customer cart', async () => {
    const prisma = mockPrisma();
    prisma.cart.findFirst
      .mockResolvedValueOnce({ id: 'guest', items: [{ id: 'g1', productId: 'p2', quantity: 4, priceMinor: 200 }] })
      .mockResolvedValueOnce({ id: 'cust', items: [{ id: 'c1', productId: 'p1', quantity: 1, priceMinor: 100 }] });
    prisma.cart.findUnique.mockResolvedValueOnce({ id: 'cust', items: [] });

    await cartLib.mergeGuestCartIntoCustomer({
      prisma, businessId: 'biz', customerId: 'cust', sessionId: 'sess-12345',
    });
    expect(prisma.cartItem.create).toHaveBeenCalledWith({
      data: { cartId: 'cust', productId: 'p2', quantity: 4, priceMinor: 200 },
    });
  });
});

// Multi-store (2026-05-11) — Phase 1c
describe('setCartLocation', () => {
  function makePrisma(location) {
    return {
      businessLocation: {
        findUnique: jest.fn().mockResolvedValue(location),
      },
      cart: {
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({
          id: 'cart-1', businessId: 'biz', locationId: data.locationId, items: [],
        })),
      },
    };
  }

  test('clears the location when locationId is null', async () => {
    const prisma = makePrisma(null);
    const result = await cartLib.setCartLocation({
      prisma, cart: { id: 'cart-1', businessId: 'biz' }, locationId: null,
    });
    expect(prisma.businessLocation.findUnique).not.toHaveBeenCalled();
    expect(prisma.cart.update).toHaveBeenCalledWith({
      where: { id: 'cart-1' }, data: { locationId: null }, include: { items: true },
    });
    expect(result.locationId).toBeNull();
  });

  test('sets the location when it belongs to the same business and is active', async () => {
    const prisma = makePrisma({ id: 'loc-1', businessId: 'biz', isActive: true });
    const result = await cartLib.setCartLocation({
      prisma, cart: { id: 'cart-1', businessId: 'biz' }, locationId: 'loc-1',
    });
    expect(result.locationId).toBe('loc-1');
  });

  test('rejects a location belonging to a different business', async () => {
    const prisma = makePrisma({ id: 'loc-1', businessId: 'other', isActive: true });
    await expect(cartLib.setCartLocation({
      prisma, cart: { id: 'cart-1', businessId: 'biz' }, locationId: 'loc-1',
    })).rejects.toMatchObject({ code: 'LOCATION_NOT_FOUND' });
    expect(prisma.cart.update).not.toHaveBeenCalled();
  });

  test('rejects an inactive location', async () => {
    const prisma = makePrisma({ id: 'loc-1', businessId: 'biz', isActive: false });
    await expect(cartLib.setCartLocation({
      prisma, cart: { id: 'cart-1', businessId: 'biz' }, locationId: 'loc-1',
    })).rejects.toMatchObject({ code: 'LOCATION_INACTIVE' });
  });

  test('rejects when locationId is provided but row is missing', async () => {
    const prisma = makePrisma(null);
    await expect(cartLib.setCartLocation({
      prisma, cart: { id: 'cart-1', businessId: 'biz' }, locationId: 'ghost',
    })).rejects.toMatchObject({ code: 'LOCATION_NOT_FOUND' });
  });
});

describe('serialiseCart locationId surfacing', () => {
  test('exposes locationId on the response', () => {
    const out = cartLib.serialiseCart(
      { id: 'cart-1', currency: 'INR', locationId: 'loc-1', items: [] },
      new Map(),
    );
    expect(out.locationId).toBe('loc-1');
  });

  test('exposes a safe selected location summary when provided', () => {
    const out = cartLib.serialiseCart(
      { id: 'cart-1', currency: 'INR', locationId: 'loc-1', items: [] },
      new Map(),
      {
        location: {
          id: 'loc-1',
          businessId: 'biz-1',
          name: 'Indiranagar Branch',
          addressLine1: '12 Market Road',
          addressLine2: null,
          city: 'Bengaluru',
          state: 'KA',
          postalCode: '560038',
          country: 'IN',
          phone: '+919999999999',
          isPrimary: true,
          isActive: true,
        },
      },
    );
    expect(out.location).toEqual({
      id: 'loc-1',
      name: 'Indiranagar Branch',
      addressLine1: '12 Market Road',
      addressLine2: null,
      city: 'Bengaluru',
      state: 'KA',
      postalCode: '560038',
      country: 'IN',
      phone: '+919999999999',
      isPrimary: true,
      isActive: true,
    });
    expect(out.location.businessId).toBeUndefined();
  });

  test('returns locationId null when cart has none', () => {
    const out = cartLib.serialiseCart(
      { id: 'cart-1', currency: 'INR', items: [] },
      new Map(),
    );
    expect(out.locationId).toBeNull();
    expect(out.location).toBeNull();
  });

  test('null cart serialises with locationId null', () => {
    expect(cartLib.serialiseCart(null).locationId).toBeNull();
    expect(cartLib.serialiseCart(null).location).toBeNull();
  });
});
