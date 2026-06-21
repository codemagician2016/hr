// Order-coupon helper. Resolves a Coupon by code + applies discount to
// an order's subtotal, with all the same constraints as appointment coupons:
//   - validFrom / validUntil window
//   - maxUses + maxUsesPerCustomer
//   - minOrderAmount threshold
//   - PERCENTAGE with maxDiscount cap
//   - applicableServiceIds list (treated as productIds for ECOMMERCE)
//
// Pure function callable from order.controller.js + a /validate endpoint.
'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function toMinor(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function normaliseEmail(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || !raw.includes('@')) return null;
  const [localRaw, domainRaw] = raw.split('@');
  if (!localRaw || !domainRaw) return raw;
  const domain = domainRaw === 'googlemail.com' ? 'gmail.com' : domainRaw;
  const localWithoutTag = localRaw.split('+')[0];
  const local = domain === 'gmail.com' ? localWithoutTag.replace(/\./g, '') : localWithoutTag;
  return `${local}@${domain}`;
}

function normalisePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits;
}

function normaliseSessionId(value) {
  const sessionId = String(value || '').trim();
  return /^[a-z0-9-]{8,64}$/i.test(sessionId) ? sessionId : null;
}

function normaliseItems(items = [], productIds = []) {
  if (Array.isArray(items) && items.length > 0) {
    return items.map((item) => {
      const quantity = Math.max(0, Number(item.quantity || 0));
      const lineTotalMinor = item.lineTotalMinor != null
        ? toMinor(item.lineTotalMinor)
        : toMinor(item.priceMinor) * quantity;
      return {
        productId: item.productId ? String(item.productId) : null,
        categoryId: item.categoryId ? String(item.categoryId) : null,
        quantity,
        lineTotalMinor,
      };
    }).filter((item) => item.productId && item.quantity > 0 && item.lineTotalMinor > 0);
  }
  return (Array.isArray(productIds) ? productIds : [])
    .filter(Boolean)
    .map((productId) => ({ productId: String(productId), categoryId: null, quantity: 1, lineTotalMinor: 0 }));
}

function resolveEligibleSubtotal({ coupon, subtotalMinor, items }) {
  const applicableProductIds = Array.isArray(coupon.applicableServiceIds) ? coupon.applicableServiceIds : [];
  const applicableCategoryIds = Array.isArray(coupon.applicableCategoryIds) ? coupon.applicableCategoryIds : [];
  const hasProductScope = applicableProductIds.length > 0;
  const hasCategoryScope = applicableCategoryIds.length > 0;
  const hasItemScope = hasProductScope || hasCategoryScope;

  if (!hasItemScope) {
    return { ok: true, hasItemScope: false, eligibleSubtotalMinor: subtotalMinor };
  }

  const eligibleSubtotalMinor = items.reduce((sum, item) => {
    const productMatches = hasProductScope && applicableProductIds.includes(item.productId);
    const categoryMatches = hasCategoryScope && item.categoryId && applicableCategoryIds.includes(item.categoryId);
    return (productMatches || categoryMatches) ? sum + item.lineTotalMinor : sum;
  }, 0);

  if (eligibleSubtotalMinor <= 0) {
    return { ok: false, hasItemScope: true, eligibleSubtotalMinor: 0 };
  }
  return { ok: true, hasItemScope: true, eligibleSubtotalMinor };
}

// Returns { ok: true, discountMinor, coupon } or
// { ok: false, code: 'INVALID'|'INACTIVE'|'EXPIRED'|'BELOW_MIN'|'EXHAUSTED'|'CUSTOMER_REQUIRED'|'NOT_APPLICABLE', message }
async function validateAndComputeDiscount({
  businessId,
  code,
  subtotalMinor,
  productIds = [],
  items = [],
  customerId = null,
  customerEmail = null,
  customerPhone = null,
  sessionId = null,
}) {
  if (!code) return { ok: false, code: 'INVALID', message: 'Code is required' };
  const cartItems = normaliseItems(items, productIds);
  const resolvedSubtotalMinor = subtotalMinor != null
    ? toMinor(subtotalMinor)
    : cartItems.reduce((sum, item) => sum + item.lineTotalMinor, 0);
  if (resolvedSubtotalMinor <= 0) {
    return { ok: false, code: 'BELOW_MIN', message: 'Cart is empty' };
  }

  const coupon = await prisma.coupon.findFirst({
    where: { businessId, code: { equals: code, mode: 'insensitive' } },
  });
  if (!coupon) return { ok: false, code: 'INVALID', message: 'Coupon not found' };
  if (!coupon.isActive) return { ok: false, code: 'INACTIVE', message: 'Coupon is not active' };

  const now = new Date();
  if (coupon.validFrom && now < coupon.validFrom) return { ok: false, code: 'EXPIRED', message: 'Coupon not yet active' };
  if (coupon.validUntil && now > coupon.validUntil) return { ok: false, code: 'EXPIRED', message: 'Coupon expired' };

  // Min-order check (treats minOrderAmount in major units; subtotalMinor is minor)
  if (coupon.minOrderAmount && resolvedSubtotalMinor < Math.round(coupon.minOrderAmount * 100)) {
    return { ok: false, code: 'BELOW_MIN', message: `Minimum order ${coupon.minOrderAmount} required` };
  }

  // Total-uses cap
  if (coupon.maxUses != null && coupon.usedCount >= coupon.maxUses) {
    return { ok: false, code: 'EXHAUSTED', message: 'Coupon usage limit reached' };
  }

  // Per-customer cap. Guests are identified by canonical email + phone +
  // cart session; logged-in buyers are identified by customerId too. This is
  // intentionally broader than email-only because guest checkout can otherwise
  // bypass limits with aliases or by reusing the same browser anonymously.
  if (coupon.maxUsesPerCustomer != null) {
    const canonicalEmail = normaliseEmail(customerEmail);
    const canonicalPhone = normalisePhone(customerPhone);
    const canonicalSessionId = normaliseSessionId(sessionId);
    const identityConditions = [
      ...(customerId ? [{ customerId }] : []),
      ...(canonicalEmail ? [{ customerEmail: canonicalEmail }] : []),
      ...(canonicalPhone ? [{ customerPhone: canonicalPhone }] : []),
      ...(canonicalSessionId ? [{ sessionId: canonicalSessionId }] : []),
    ];

    if (identityConditions.length === 0) {
      return {
        ok: false,
        code: 'CUSTOMER_REQUIRED',
        message: 'Please enter your contact details before using this coupon',
      };
    }

    const used = await prisma.couponRedemption.count({
      where: {
        couponId: coupon.id,
        OR: identityConditions,
      },
    });
    if (used >= coupon.maxUsesPerCustomer) {
      return { ok: false, code: 'EXHAUSTED', message: 'You have reached the per-user limit for this coupon' };
    }
  }

  // Applicable products / categories. `applicableServiceIds` is the legacy
  // field; for ECOMMERCE it scopes to product IDs. The discount is calculated
  // only on eligible lines, so "10% off bakery" never discounts the whole cart.
  const eligibility = resolveEligibleSubtotal({ coupon, subtotalMinor: resolvedSubtotalMinor, items: cartItems });
  if (!eligibility.ok) {
    return { ok: false, code: 'NOT_APPLICABLE', message: 'Coupon doesn\'t apply to these items' };
  }
  const discountBaseMinor = eligibility.eligibleSubtotalMinor;

  // Compute discount
  let discountMinor;
  if (coupon.discountType === 'FIXED') {
    discountMinor = Math.min(discountBaseMinor, Math.round(coupon.discountValue * 100));
  } else { // PERCENTAGE
    discountMinor = Math.round(discountBaseMinor * coupon.discountValue / 100);
    if (coupon.maxDiscount != null) {
      discountMinor = Math.min(discountMinor, Math.round(coupon.maxDiscount * 100));
    }
  }
  if (discountMinor < 0) discountMinor = 0;
  if (discountMinor > discountBaseMinor) discountMinor = discountBaseMinor;

  return {
    ok: true,
    discountMinor,
    eligibleSubtotalMinor: discountBaseMinor,
    coupon: {
      id: coupon.id,
      code: coupon.code,
      description: coupon.description,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      applicableProductIds: coupon.applicableServiceIds || [],
      applicableCategoryIds: coupon.applicableCategoryIds || [],
    },
  };
}

module.exports = {
  validateAndComputeDiscount,
  normaliseItems,
  resolveEligibleSubtotal,
  normaliseEmail,
  normalisePhone,
  normaliseSessionId,
};
