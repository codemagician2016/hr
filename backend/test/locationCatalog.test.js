const {
  defaultFulfillmentLocation,
  ensureCartFulfillmentLocation,
  isFulfillmentLocationMode,
  isLocationMode,
  isStorePickerMode,
  normaliseMultiStoreMode,
  requiresLocationContext,
  requiresShopperLocation,
  storefrontNeedsStorePicker,
} = require('../src/core/lib/locationCatalog');

describe('multi-store mode helpers', () => {
  test('normalises blank and lowercase values', () => {
    expect(normaliseMultiStoreMode()).toBe('OFF');
    expect(normaliseMultiStoreMode('fulfillment')).toBe('FULFILLMENT');
  });

  test('Shopify-style fulfillment is location-scoped but does not require shopper store selection', () => {
    expect(isFulfillmentLocationMode('FULFILLMENT')).toBe(true);
    expect(isStorePickerMode('FULFILLMENT')).toBe(false);
    expect(isLocationMode('FULFILLMENT')).toBe(false);
    expect(requiresShopperLocation('FULFILLMENT')).toBe(false);
    expect(storefrontNeedsStorePicker('FULFILLMENT')).toBe(false);
  });

  test('PaknSave-style chain modes require a shopper-selected store', () => {
    for (const mode of ['CHAIN', 'BOTH']) {
      expect(isFulfillmentLocationMode(mode)).toBe(true);
      expect(isStorePickerMode(mode)).toBe(true);
      expect(isLocationMode(mode)).toBe(true);
      expect(requiresShopperLocation(mode)).toBe(true);
      expect(storefrontNeedsStorePicker(mode)).toBe(true);
    }
  });

  test('single shop and reserved regional mode do not open the store picker', () => {
    for (const mode of ['OFF', 'REGIONAL']) {
      expect(isFulfillmentLocationMode(mode)).toBe(false);
      expect(isStorePickerMode(mode)).toBe(false);
      expect(requiresShopperLocation(mode)).toBe(false);
      expect(storefrontNeedsStorePicker(mode)).toBe(false);
    }
  });

  test('delivery-area stores require location context even outside chain mode', () => {
    expect(requiresLocationContext({ multiStoreMode: 'OFF', hasDeliveryAreas: true })).toBe(true);
    expect(requiresLocationContext({ multiStoreMode: 'CHAIN', hasDeliveryAreas: false })).toBe(true);
    expect(requiresLocationContext({ multiStoreMode: 'OFF', hasDeliveryAreas: false })).toBe(false);
  });
});

describe('defaultFulfillmentLocation', () => {
  test('uses the primary active location first', async () => {
    const prisma = {
      businessLocation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'loc-primary', name: 'Primary' }),
      },
    };
    const location = await defaultFulfillmentLocation({ prisma, businessId: 'biz' });
    expect(location.id).toBe('loc-primary');
    expect(prisma.businessLocation.findFirst).toHaveBeenCalledWith({
      where: { businessId: 'biz', isActive: true },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true },
    });
  });
});

describe('ensureCartFulfillmentLocation', () => {
  test('assigns a primary location for Shopify-style fulfillment carts', async () => {
    const prisma = {
      businessLocation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'loc-primary', name: 'Primary' }),
      },
      cart: {
        update: jest.fn().mockResolvedValue({ id: 'cart-1', locationId: 'loc-primary', items: [] }),
      },
    };
    const cart = await ensureCartFulfillmentLocation({
      prisma,
      cart: { id: 'cart-1', locationId: null, items: [] },
      business: { id: 'biz', multiStoreMode: 'FULFILLMENT' },
    });
    expect(cart.locationId).toBe('loc-primary');
    expect(prisma.cart.update).toHaveBeenCalledWith({
      where: { id: 'cart-1' },
      data: { locationId: 'loc-primary' },
      include: { items: true },
    });
  });

  test('does not auto-assign shopper-selected chain carts', async () => {
    const prisma = {
      businessLocation: { findFirst: jest.fn() },
      cart: { update: jest.fn() },
    };
    const original = { id: 'cart-1', locationId: null, items: [] };
    const cart = await ensureCartFulfillmentLocation({
      prisma,
      cart: original,
      business: { id: 'biz', multiStoreMode: 'CHAIN' },
    });
    expect(cart).toBe(original);
    expect(prisma.businessLocation.findFirst).not.toHaveBeenCalled();
    expect(prisma.cart.update).not.toHaveBeenCalled();
  });

  test('does not auto-assign delivery-area carts before pincode resolution', async () => {
    const prisma = {
      businessLocation: { findFirst: jest.fn() },
      cart: { update: jest.fn() },
    };
    const original = { id: 'cart-1', locationId: null, items: [] };
    const cart = await ensureCartFulfillmentLocation({
      prisma,
      cart: original,
      business: { id: 'biz', vertical: 'ECOMMERCE', multiStoreMode: 'OFF', hasDeliveryAreas: true },
    });
    expect(cart).toBe(original);
    expect(prisma.businessLocation.findFirst).not.toHaveBeenCalled();
    expect(prisma.cart.update).not.toHaveBeenCalled();
  });
});
