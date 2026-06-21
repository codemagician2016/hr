// Unit tests for backend/src/core/lib/cartReconcile.js
// (Multi-store Phase 3 — cart reconciliation on store switch.)
// Prisma calls are mocked.

const { previewReconcile, applyReconcile } = require('../src/core/lib/cartReconcile');

function makePrisma({ products = [], variants = [], overrides = [], stocks = [] } = {}) {
  return {
    product: { findMany: jest.fn().mockResolvedValue(products) },
    productVariant: { findMany: jest.fn().mockResolvedValue(variants) },
    productLocationOverride: { findMany: jest.fn().mockResolvedValue(overrides) },
    inventoryStock: { findMany: jest.fn().mockResolvedValue(stocks) },
    cartItem: {
      update: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockImplementation(async (cb) => cb({
      cartItem: {
        update: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({}),
      },
    })),
  };
}

const emptyCart = { items: [] };
const singleItemCart = {
  items: [{ id: 'ci1', productId: 'p1', variantId: null, quantity: 2, priceMinor: 1000 }],
};

describe('previewReconcile', () => {
  test('empty cart returns empty report', async () => {
    const prisma = makePrisma();
    const out = await previewReconcile({ prisma, cart: emptyCart, newLocationId: 'loc-a' });
    expect(out.items).toEqual([]);
    expect(out.summary).toEqual({ kept: 0, repriced: 0, removed: 0 });
  });

  test('null locationId keeps everything', async () => {
    const prisma = makePrisma();
    const out = await previewReconcile({ prisma, cart: singleItemCart, newLocationId: null });
    expect(out.items[0].status).toBe('kept');
    expect(out.summary.kept).toBe(1);
  });

  test('kept when price + availability + stock are unchanged', async () => {
    const prisma = makePrisma({
      products: [{ id: 'p1', name: 'Apple', priceMinor: 1000, isPublished: true, stockQty: 100 }],
      stocks: [{ productId: 'p1', onHand: 10, reserved: 2 }],
    });
    const out = await previewReconcile({ prisma, cart: singleItemCart, newLocationId: 'loc-a' });
    expect(out.items[0].status).toBe('kept');
    expect(out.items[0].newPriceMinor).toBe(1000);
  });

  test('repriced when override.priceMinor differs', async () => {
    const prisma = makePrisma({
      products: [{ id: 'p1', name: 'Apple', priceMinor: 1000, isPublished: true, stockQty: 100 }],
      overrides: [{ productId: 'p1', priceMinor: 1200, isAvailable: true }],
      stocks: [{ productId: 'p1', onHand: 10, reserved: 0 }],
    });
    const out = await previewReconcile({ prisma, cart: singleItemCart, newLocationId: 'loc-a' });
    expect(out.items[0].status).toBe('repriced');
    expect(out.items[0].oldPriceMinor).toBe(1000);
    expect(out.items[0].newPriceMinor).toBe(1200);
  });

  test('removed when override.isAvailable=false', async () => {
    const prisma = makePrisma({
      products: [{ id: 'p1', name: 'Apple', priceMinor: 1000, isPublished: true, stockQty: 100 }],
      overrides: [{ productId: 'p1', priceMinor: null, isAvailable: false }],
      stocks: [{ productId: 'p1', onHand: 10, reserved: 0 }],
    });
    const out = await previewReconcile({ prisma, cart: singleItemCart, newLocationId: 'loc-a' });
    expect(out.items[0].status).toBe('removed');
    expect(out.items[0].reason).toBe('unavailable_at_location');
  });

  test('removed when product is unpublished', async () => {
    const prisma = makePrisma({
      products: [{ id: 'p1', name: 'Apple', priceMinor: 1000, isPublished: false, stockQty: 100 }],
    });
    const out = await previewReconcile({ prisma, cart: singleItemCart, newLocationId: 'loc-a' });
    expect(out.items[0].status).toBe('removed');
  });

  test('removed when stock available = onHand - reserved is 0 or negative', async () => {
    const prisma = makePrisma({
      products: [{ id: 'p1', name: 'Apple', priceMinor: 1000, isPublished: true, stockQty: 100 }],
      stocks: [{ productId: 'p1', onHand: 3, reserved: 3 }],
    });
    const out = await previewReconcile({ prisma, cart: singleItemCart, newLocationId: 'loc-a' });
    expect(out.items[0].status).toBe('removed');
    expect(out.items[0].reason).toBe('out_of_stock_at_location');
  });

  test('removed when product missing globally too (no stock row + stockQty 0)', async () => {
    const prisma = makePrisma({
      products: [{ id: 'p1', name: 'Apple', priceMinor: 1000, isPublished: true, stockQty: 0 }],
      stocks: [],
    });
    const out = await previewReconcile({ prisma, cart: singleItemCart, newLocationId: 'loc-a' });
    expect(out.items[0].status).toBe('removed');
  });

  test('uses variant price when variantId is set', async () => {
    const cart = { items: [{ id: 'ci1', productId: 'p1', variantId: 'v1', quantity: 1, priceMinor: 500 }] };
    const prisma = makePrisma({
      products: [{ id: 'p1', name: 'Apple', priceMinor: 1000, isPublished: true, stockQty: 100 }],
      variants: [{ id: 'v1', productId: 'p1', label: '500g', priceMinor: 700, isActive: true }],
      stocks: [{ productId: 'p1', onHand: 10, reserved: 0 }],
    });
    const out = await previewReconcile({ prisma, cart, newLocationId: 'loc-a' });
    expect(out.items[0].status).toBe('repriced');
    expect(out.items[0].newPriceMinor).toBe(700);
  });

  test('summary counts each status correctly', async () => {
    const cart = {
      items: [
        { id: 'a', productId: 'p1', variantId: null, quantity: 1, priceMinor: 1000 },
        { id: 'b', productId: 'p2', variantId: null, quantity: 1, priceMinor: 500 },
        { id: 'c', productId: 'p3', variantId: null, quantity: 1, priceMinor: 200 },
      ],
    };
    const prisma = makePrisma({
      products: [
        { id: 'p1', name: 'A', priceMinor: 1000, isPublished: true, stockQty: 100 },
        { id: 'p2', name: 'B', priceMinor: 600, isPublished: true, stockQty: 100 },
        { id: 'p3', name: 'C', priceMinor: 200, isPublished: false, stockQty: 100 },
      ],
      stocks: [
        { productId: 'p1', onHand: 5, reserved: 0 },
        { productId: 'p2', onHand: 5, reserved: 0 },
      ],
    });
    const out = await previewReconcile({ prisma, cart, newLocationId: 'loc-a' });
    expect(out.summary).toEqual({ kept: 1, repriced: 1, removed: 1 });
  });
});

describe('applyReconcile', () => {
  test('no-op for empty report', async () => {
    const prisma = makePrisma();
    await applyReconcile({ prisma, cartId: 'c1', report: { items: [] } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('opens a transaction when there are changes', async () => {
    const prisma = makePrisma();
    const report = {
      items: [
        { itemId: 'i1', status: 'repriced', newPriceMinor: 1200 },
        { itemId: 'i2', status: 'removed' },
        { itemId: 'i3', status: 'kept' },
      ],
    };
    await applyReconcile({ prisma, cartId: 'c1', report });
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
