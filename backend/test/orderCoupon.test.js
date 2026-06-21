const mockPrisma = {
  coupon: { findFirst: jest.fn() },
  couponRedemption: { count: jest.fn() },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

const { validateAndComputeDiscount, normaliseEmail, normalisePhone } = require('../src/core/lib/orderCoupon');

function coupon(overrides = {}) {
  return {
    id: 'coupon-1',
    code: 'SAVE',
    description: null,
    discountType: 'PERCENTAGE',
    discountValue: 10,
    minOrderAmount: null,
    maxDiscount: null,
    maxUses: null,
    maxUsesPerCustomer: null,
    usedCount: 0,
    validFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
    validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    applicableServiceIds: [],
    applicableCategoryIds: [],
    isActive: true,
    ...overrides,
  };
}

describe('orderCoupon ecommerce validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.couponRedemption.count.mockResolvedValue(0);
  });

  test('rejects a coupon when the current cart drops below the minimum', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValueOnce(coupon({ minOrderAmount: 50 }));

    const result = await validateAndComputeDiscount({
      businessId: 'biz',
      code: 'SAVE',
      subtotalMinor: 2500,
      items: [{ productId: 'p1', categoryId: 'c1', quantity: 1, lineTotalMinor: 2500 }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('BELOW_MIN');
  });

  test('product-scoped percentage coupons discount only eligible lines', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValueOnce(coupon({
      discountType: 'PERCENTAGE',
      discountValue: 20,
      applicableServiceIds: ['p-eligible'],
    }));

    const result = await validateAndComputeDiscount({
      businessId: 'biz',
      code: 'SAVE',
      subtotalMinor: 5000,
      items: [
        { productId: 'p-eligible', categoryId: 'fruit', quantity: 1, lineTotalMinor: 2000 },
        { productId: 'p-other', categoryId: 'bakery', quantity: 1, lineTotalMinor: 3000 },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.eligibleSubtotalMinor).toBe(2000);
    expect(result.discountMinor).toBe(400);
  });

  test('category-scoped fixed coupons cap at the eligible category subtotal', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValueOnce(coupon({
      discountType: 'FIXED',
      discountValue: 30,
      applicableCategoryIds: ['bakery'],
    }));

    const result = await validateAndComputeDiscount({
      businessId: 'biz',
      code: 'SAVE',
      subtotalMinor: 5000,
      items: [
        { productId: 'p-fruit', categoryId: 'fruit', quantity: 1, lineTotalMinor: 3500 },
        { productId: 'p-bread', categoryId: 'bakery', quantity: 1, lineTotalMinor: 1500 },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.eligibleSubtotalMinor).toBe(1500);
    expect(result.discountMinor).toBe(1500);
  });

  test('scoped coupons fail when no cart item is eligible', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValueOnce(coupon({
      applicableServiceIds: ['p-eligible'],
    }));

    const result = await validateAndComputeDiscount({
      businessId: 'biz',
      code: 'SAVE',
      subtotalMinor: 5000,
      items: [{ productId: 'p-other', categoryId: 'fruit', quantity: 1, lineTotalMinor: 5000 }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('NOT_APPLICABLE');
  });

  test('per-customer limit counts canonical email, phone, and cart session identities', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValueOnce(coupon({ maxUsesPerCustomer: 2 }));
    mockPrisma.couponRedemption.count.mockResolvedValueOnce(2);

    const result = await validateAndComputeDiscount({
      businessId: 'biz',
      code: 'SAVE',
      subtotalMinor: 5000,
      items: [{ productId: 'p1', categoryId: 'fruit', quantity: 1, lineTotalMinor: 5000 }],
      customerEmail: 'Buyer.Name+promo@googlemail.com',
      customerPhone: '+91 98765 43210',
      sessionId: 'cart-session-12345',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('EXHAUSTED');
    expect(mockPrisma.couponRedemption.count).toHaveBeenCalledWith({
      where: {
        couponId: 'coupon-1',
        OR: [
          { customerEmail: 'buyername@gmail.com' },
          { customerPhone: '919876543210' },
          { sessionId: 'cart-session-12345' },
        ],
      },
    });
  });

  test('per-customer coupons require an identity before validation', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValueOnce(coupon({ maxUsesPerCustomer: 1 }));

    const result = await validateAndComputeDiscount({
      businessId: 'biz',
      code: 'SAVE',
      subtotalMinor: 5000,
      items: [{ productId: 'p1', categoryId: 'fruit', quantity: 1, lineTotalMinor: 5000 }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('CUSTOMER_REQUIRED');
    expect(mockPrisma.couponRedemption.count).not.toHaveBeenCalled();
  });

  test('normalises common guest checkout identity variants', () => {
    expect(normaliseEmail('Buyer.Name+promo@googlemail.com')).toBe('buyername@gmail.com');
    expect(normaliseEmail('shopper+sale@example.com')).toBe('shopper@example.com');
    expect(normalisePhone('+91 98765 43210')).toBe('919876543210');
  });
});
