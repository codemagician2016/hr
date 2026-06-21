const mockPrisma = {
  businessLocation: { findUnique: jest.fn(), findFirst: jest.fn() },
  ecomSupplier: { findFirst: jest.fn() },
  product: { findMany: jest.fn() },
  ecomGoodsReceiptNote: {
    findFirst: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn(),
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

jest.mock('../src/core/lib/ecomActivityLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve()),
}));

const grn = require('../src/shop/controllers/ecomGRN.controller');

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status: jest.fn(function status(code) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn(function json(body) {
      this.body = body;
      return this;
    }),
  };
}

function req(body = {}, params = {}) {
  return {
    body,
    params,
    query: {},
    user: { id: 'user-1', businessId: 'biz-1' },
  };
}

describe('ecomGRN controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.businessLocation.findUnique.mockResolvedValue({ businessId: 'biz-1' });
    mockPrisma.businessLocation.findFirst.mockResolvedValue({ id: 'loc-1' });
    mockPrisma.ecomSupplier.findFirst.mockResolvedValue(null);
    mockPrisma.ecomGoodsReceiptNote.findFirst.mockResolvedValue(null);
  });

  test('creates a draft GRN only for products in the current business', async () => {
    mockPrisma.product.findMany.mockResolvedValue([{ id: '11111111-1111-4111-8111-111111111111', name: 'Rice 5kg', sku: 'RICE-5' }]);
    mockPrisma.ecomGoodsReceiptNote.create.mockImplementation(({ data }) => Promise.resolve({ id: 'grn-1', ...data }));
    const res = makeRes();

    await grn.create(req({
      locationId: '22222222-2222-4222-8222-222222222222',
      receivedAt: new Date('2026-05-21T00:00:00.000Z').toISOString(),
      items: [{
        productId: '11111111-1111-4111-8111-111111111111',
        productName: 'Old rice name',
        quantityReceived: 10,
        unitCostMinor: 1200,
      }],
    }), res);

    expect(res.statusCode).toBe(201);
    expect(mockPrisma.ecomGoodsReceiptNote.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        code: expect.stringMatching(/^GRN-\d{8}-001$/),
        items: {
          create: [expect.objectContaining({
            productName: 'Rice 5kg',
            productSku: 'RICE-5',
            quantityReceived: 10,
          })],
        },
      }),
      include: { items: true },
    }));
  });

  test('uses the next global daily GRN code when another business already has today number one', async () => {
    mockPrisma.ecomGoodsReceiptNote.findFirst.mockResolvedValue({ code: 'GRN-20260521-001' });
    mockPrisma.product.findMany.mockResolvedValue([{ id: '11111111-1111-4111-8111-111111111111', name: 'Rice 5kg', sku: 'RICE-5' }]);
    mockPrisma.ecomGoodsReceiptNote.create.mockImplementation(({ data }) => Promise.resolve({ id: 'grn-2', ...data }));
    const res = makeRes();

    await grn.create(req({
      locationId: '22222222-2222-4222-8222-222222222222',
      receivedAt: new Date('2026-05-21T00:00:00.000Z').toISOString(),
      items: [{
        productId: '11111111-1111-4111-8111-111111111111',
        productName: 'Rice 5kg',
        quantityReceived: 5,
      }],
    }), res);

    expect(res.statusCode).toBe(201);
    expect(mockPrisma.ecomGoodsReceiptNote.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { code: { startsWith: expect.stringMatching(/^GRN-\d{8}-$/) } },
    }));
    expect(mockPrisma.ecomGoodsReceiptNote.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ code: expect.stringMatching(/^GRN-\d{8}-002$/) }),
    }));
  });

  test('rejects stale or cross-tenant products before posting stock', async () => {
    mockPrisma.product.findMany.mockResolvedValue([]);
    const res = makeRes();

    await grn.create(req({
      locationId: '22222222-2222-4222-8222-222222222222',
      receivedAt: new Date('2026-05-21T00:00:00.000Z').toISOString(),
      items: [{
        productId: '11111111-1111-4111-8111-111111111111',
        productName: 'Rice 5kg',
        quantityReceived: 10,
      }],
    }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body.message).toMatch(/Product not found/);
    expect(mockPrisma.ecomGoodsReceiptNote.create).not.toHaveBeenCalled();
  });

  test('posts a GRN into stock and ledger in one transaction', async () => {
    const productId = '11111111-1111-4111-8111-111111111111';
    mockPrisma.ecomGoodsReceiptNote.findUnique.mockResolvedValue({
      id: 'grn-1',
      businessId: 'biz-1',
      code: 'GRN-20260521-001',
      locationId: 'loc-1',
      status: 'DRAFT',
      items: [{ id: 'item-1', productId, quantityReceived: 4, unitCostMinor: 250, expiresAt: null }],
    });
    mockPrisma.product.findMany.mockResolvedValue([{ id: productId, name: 'Rice 5kg', sku: 'RICE-5' }]);

    const tx = {
      inventoryStock: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'stock-1', onHand: 0, unitCostMinor: null, expiresAt: null }),
        update: jest.fn().mockResolvedValue({ id: 'stock-1', onHand: 4 }),
      },
      inventoryAdjustment: { create: jest.fn().mockResolvedValue({ id: 'adj-1' }) },
      ecomGoodsReceiptItem: { update: jest.fn().mockResolvedValue({}) },
      ecomGoodsReceiptNote: { update: jest.fn().mockResolvedValue({ id: 'grn-1', status: 'POSTED' }) },
    };
    mockPrisma.$transaction.mockImplementation((cb) => cb(tx));
    const res = makeRes();

    await grn.post(req({ locationId: 'loc-1' }, { id: 'grn-1' }), res);

    expect(res.statusCode).toBe(200);
    expect(tx.inventoryStock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ businessId: 'biz-1', productId, locationId: 'loc-1' }) });
    expect(tx.inventoryStock.update).toHaveBeenCalledWith({
      where: { id: 'stock-1' },
      data: expect.objectContaining({ onHand: 4, unitCostMinor: 250 }),
    });
    expect(tx.inventoryAdjustment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ reason: 'GRN_RECEIPT', delta: 4, onHandAfter: 4 }) });
  });

  test('returns JSON validation errors instead of leaking Prisma FK failures', async () => {
    const productId = '11111111-1111-4111-8111-111111111111';
    mockPrisma.ecomGoodsReceiptNote.findUnique.mockResolvedValue({
      id: 'grn-1',
      businessId: 'biz-1',
      code: 'GRN-20260521-001',
      locationId: 'loc-1',
      status: 'DRAFT',
      items: [{ id: 'item-1', productId, quantityReceived: 4 }],
    });
    mockPrisma.product.findMany.mockResolvedValue([{ id: productId, name: 'Rice 5kg', sku: 'RICE-5' }]);
    mockPrisma.$transaction.mockRejectedValue({ code: 'P2003', message: 'Foreign key constraint failed' });
    const res = makeRes();

    await grn.post(req({ locationId: 'loc-1' }, { id: 'grn-1' }), res);

    expect(res.statusCode).toBe(422);
    expect(res.body.message).toMatch(/linked product, location, or supplier/);
  });
});
