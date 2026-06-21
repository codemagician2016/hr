jest.mock('../src/core/lib/prisma', () => ({
  business: { findUnique: jest.fn() },
  ecomDeliveryZone: { count: jest.fn() },
  product: { findUnique: jest.fn(), findMany: jest.fn() },
  cart: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  cartItem: { create: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  businessLocation: { findFirst: jest.fn(), findUnique: jest.fn() },
  productLocationOverride: { findMany: jest.fn() },
  inventoryItem: { findMany: jest.fn() },
}));

const prisma = require('../src/core/lib/prisma');
const cartController = require('../src/shop/controllers/cart.controller');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  return res;
}

describe('cart controller location enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('requires a delivery location before adding items for delivery-area stores', async () => {
    prisma.business.findUnique.mockResolvedValue({
      id: 'biz-1',
      isActive: true,
      slug: 'demo',
      vertical: 'ECOMMERCE',
      multiStoreMode: 'OFF',
      country: 'NZ',
      defaultCurrency: 'NZD',
    });
    prisma.ecomDeliveryZone.count.mockResolvedValue(1);
    prisma.product.findUnique.mockResolvedValue({
      id: 'prod-1',
      businessId: 'biz-1',
      isPublished: true,
      priceMinor: 599,
      stockQty: 10,
      variants: [],
    });
    prisma.cart.findFirst.mockResolvedValue({
      id: 'cart-1',
      businessId: 'biz-1',
      customerId: null,
      sessionId: 'session-12345',
      currency: 'NZD',
      locationId: null,
      items: [],
    });

    const req = {
      params: { slug: 'demo' },
      headers: { 'x-cart-session': 'session-12345' },
      body: { productId: 'prod-1', quantity: 1 },
    };
    const res = mockRes();

    await cartController.addItem(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body).toEqual({
      message: 'Please choose your delivery location before adding products',
      reason: 'LOCATION_REQUIRED',
    });
    expect(prisma.businessLocation.findFirst).not.toHaveBeenCalled();
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
    expect(prisma.cartItem.update).not.toHaveBeenCalled();
  });
});
