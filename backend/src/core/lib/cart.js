// E-commerce Phase 2 — cart helpers.
//
// Pure functions for cart math + identity resolution. Kept side-effect
// free so the controller layer can compose them and so unit tests don't
// need a database. The few functions that DO touch Prisma (resolve, merge)
// take the prisma client as an argument — also so tests can inject a mock.

const { DEFAULT_CURRENCY } = require('./currency');

const SESSION_ID_RE = /^[a-z0-9-]{8,64}$/i;

// Validate a sessionId from the storefront. UUID-like format; keep this
// permissive (8-64 chars of [a-z0-9-]) so the storefront can pick its own
// scheme (uuid, nanoid, etc.) without us re-deploying.
function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

// Compute a single line's total in minor units. Multiplication can't
// overflow at JS Number precision until ~9e15 — products are capped at
// ~₹100cr (9_999_999_999) and qty caps at 999, so we're nowhere near it.
function lineTotal(item) {
  const qty = Math.max(0, Number(item?.quantity || 0));
  const price = Math.max(0, Number(item?.priceMinor || 0));
  return qty * price;
}

// Sum all line totals. Always returns a non-negative integer.
function subtotal(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

// Quantity rules:
//  * Must be a positive integer
//  * Capped at 999 per line — sanity bound to stop a typo from charging
//    a customer for 99,999,999 loaves of bread.
//  * If product.stockQty is set (non-null), can't exceed available stock.
function clampQuantity(requested, stockQty) {
  const n = Math.floor(Number(requested));
  if (!Number.isFinite(n) || n < 1) return null;
  let max = 999;
  if (typeof stockQty === 'number' && stockQty >= 0) {
    max = Math.min(max, stockQty);
  }
  if (max < 1) return 0; // out of stock — caller should reject
  return Math.min(n, max);
}

// Decide which Cart row belongs to this shopper. Customer first (logged-in
// always wins so the cart follows the account); fall back to sessionId for
// guests; null if neither.
async function resolveCart({ prisma, businessId, customerId, sessionId }) {
  if (!businessId) return null;
  if (customerId) {
    return prisma.cart.findFirst({
      where: { businessId, customerId },
      include: { items: true },
    });
  }
  if (isValidSessionId(sessionId)) {
    return prisma.cart.findFirst({
      where: { businessId, sessionId },
      include: { items: true },
    });
  }
  return null;
}

// Same as resolveCart but creates an empty Cart if none exists. Used by
// add-to-cart so the first add creates the cart. customerId takes priority
// over sessionId if both are set (logged-in shopper).
async function getOrCreateCart({ prisma, businessId, customerId, sessionId, currency = DEFAULT_CURRENCY }) {
  const existing = await resolveCart({ prisma, businessId, customerId, sessionId });
  if (existing) return existing;
  if (!customerId && !isValidSessionId(sessionId)) {
    throw new Error('A customerId or valid sessionId is required to create a cart');
  }
  return prisma.cart.create({
    data: {
      businessId,
      customerId: customerId || null,
      sessionId: customerId ? null : sessionId,
      currency,
    },
    include: { items: true },
  });
}

// When a guest logs in mid-shopping, their guest cart (sessionId-keyed)
// needs to merge into their customer cart. Same product across both =
// quantities sum (but still clamped). Returns the surviving Cart.
async function mergeGuestCartIntoCustomer({ prisma, businessId, customerId, sessionId }) {
  if (!customerId || !isValidSessionId(sessionId)) return null;

  const guestCart = await prisma.cart.findFirst({
    where: { businessId, sessionId },
    include: { items: true },
  });
  if (!guestCart) return resolveCart({ prisma, businessId, customerId });

  const customerCart = await prisma.cart.findFirst({
    where: { businessId, customerId },
    include: { items: true },
  });

  if (!customerCart) {
    // Promote the guest cart to a customer cart in place — cheaper than
    // recreating + copying items.
    const updated = await prisma.cart.update({
      where: { id: guestCart.id },
      data: { customerId, sessionId: null },
      include: { items: true },
    });
    return updated;
  }

  // Merge guest items into customer cart, summing quantities for dupes.
  for (const guestItem of guestCart.items) {
    const dupe = customerCart.items.find((i) => i.productId === guestItem.productId);
    if (dupe) {
      const merged = clampQuantity(dupe.quantity + guestItem.quantity, null);
      await prisma.cartItem.update({
        where: { id: dupe.id },
        data: { quantity: merged ?? dupe.quantity },
      });
    } else {
      await prisma.cartItem.create({
        data: {
          cartId: customerCart.id,
          productId: guestItem.productId,
          quantity: guestItem.quantity,
          priceMinor: guestItem.priceMinor,
        },
      });
    }
  }
  await prisma.cart.delete({ where: { id: guestCart.id } });

  return prisma.cart.findUnique({
    where: { id: customerCart.id },
    include: { items: true },
  });
}

// ECOMMERCE multi-store (2026-05-11) — set / change which physical store
// fulfils this cart. Validates the location belongs to the same business
// and is active. Returns the updated Cart. Reconciliation of cart items
// against the new location's catalog (price + availability) is layered
// on top by Phase 3 — this fn is intentionally minimal so it can be
// called from any flow (pincode resolve, geo pin, manual picker).
async function setCartLocation({ prisma, cart, locationId }) {
  if (!cart) throw new Error('cart is required');
  if (!locationId) {
    return prisma.cart.update({
      where: { id: cart.id },
      data: { locationId: null },
      include: { items: true },
    });
  }
  const location = await prisma.businessLocation.findUnique({
    where: { id: locationId },
    select: { id: true, businessId: true, isActive: true },
  });
  if (!location || location.businessId !== cart.businessId) {
    const err = new Error('Location not found for this business');
    err.code = 'LOCATION_NOT_FOUND';
    throw err;
  }
  if (!location.isActive) {
    const err = new Error('Location is not active');
    err.code = 'LOCATION_INACTIVE';
    throw err;
  }
  return prisma.cart.update({
    where: { id: cart.id },
    data: { locationId: location.id },
    include: { items: true },
  });
}

// Format a cart row for API response. Hydrates each line item with the
// current product info AND keeps the price snapshot, so the storefront
// can highlight items where the price has drifted since add-time.
function serialiseCart(cart, productLookup, context = {}) {
  const selectedLocation = context.location || cart?.location || null;
  const location = selectedLocation ? {
    id: selectedLocation.id,
    name: selectedLocation.name,
    addressLine1: selectedLocation.addressLine1 || null,
    addressLine2: selectedLocation.addressLine2 || null,
    city: selectedLocation.city || null,
    state: selectedLocation.state || null,
    postalCode: selectedLocation.postalCode || null,
    country: selectedLocation.country || null,
    phone: selectedLocation.phone || null,
    isPrimary: !!selectedLocation.isPrimary,
    isActive: selectedLocation.isActive !== false,
  } : null;
  if (!cart) {
    return { id: null, items: [], subtotalMinor: 0, currency: DEFAULT_CURRENCY, itemCount: 0, locationId: null, location: null };
  }
  const items = (cart.items || []).map((item) => {
    const product = productLookup?.get(item.productId) || null;
    const variant = item.variantId && product?.variants
      ? product.variants.find((v) => v.id === item.variantId)
      : null;
    const currentPrice = variant?.priceMinor ?? product?.priceMinor ?? null;
    const priceDrifted = currentPrice !== null && currentPrice !== item.priceMinor;
    return {
      id: item.id,
      productId: item.productId,
      variantId: item.variantId || null,
      quantity: item.quantity,
      priceMinor: item.priceMinor,
      currentPriceMinor: currentPrice,
      priceDrifted,
      lineTotalMinor: lineTotal(item),
      // P2 — per-item substitution preference (null = inherit order-level
      // substitutionPolicy at pick time).
      substitutionPref: item.substitutionPref || null,
      product: product
        ? {
          id: product.id,
          name: product.name,
          slug: product.slug,
          brand: product.brand || null,
          imageUrls: product.imageUrls || [],
          stockQty: product.stockQty,
          isPublished: product.isPublished,
          // MRP / compare-at so the cart can show a strikethrough + savings.
          // Prefer the variant's compare price when a variant is selected.
          comparePriceMinor: variant?.comparePriceMinor ?? product.comparePriceMinor ?? null,
          variant: variant ? {
            id: variant.id,
            label: variant.label,
            priceMinor: variant.priceMinor ?? null,
            comparePriceMinor: variant.comparePriceMinor ?? null,
            stockQty: variant.stockQty,
          } : null,
        }
        : null,
    };
  });
  return {
    id: cart.id,
    currency: cart.currency || DEFAULT_CURRENCY,
    locationId: cart.locationId || null,
    location,
    items,
    itemCount: items.reduce((n, i) => n + i.quantity, 0),
    subtotalMinor: items.reduce((s, i) => s + i.lineTotalMinor, 0),
  };
}

module.exports = {
  SESSION_ID_RE,
  isValidSessionId,
  lineTotal,
  subtotal,
  clampQuantity,
  resolveCart,
  getOrCreateCart,
  mergeGuestCartIntoCustomer,
  setCartLocation,
  serialiseCart,
};
