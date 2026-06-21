// Shared ecommerce location/catalog rules.
//
// Modes intentionally split shopper UX from fulfillment scoping:
//   FULFILLMENT — Shopify-style. One storefront; backend scopes catalog,
//                 cart, and orders to the primary active location.
//   CHAIN/BOTH  — Pak'nSave-style. Shopper picks the active store; cart,
//                 pricing, stock, slots, riders, and orders follow it.

function availableFromStock(stock) {
  if (!stock) return null;
  return Math.max(0, Number(stock.onHand || 0) - Number(stock.reserved || 0));
}

function normaliseMultiStoreMode(mode) {
  return String(mode || 'OFF').toUpperCase();
}

function isStorePickerMode(mode) {
  const m = normaliseMultiStoreMode(mode);
  return m === 'CHAIN' || m === 'BOTH';
}

function isFulfillmentLocationMode(mode) {
  const m = normaliseMultiStoreMode(mode);
  return m === 'FULFILLMENT' || m === 'CHAIN' || m === 'BOTH';
}

function isLocationMode(mode) {
  return isStorePickerMode(mode);
}

function requiresShopperLocation(mode) {
  return isStorePickerMode(mode);
}

function requiresLocationContext(business) {
  return requiresShopperLocation(business?.multiStoreMode) || !!business?.hasDeliveryAreas;
}

async function defaultFulfillmentLocation({ prisma, businessId }) {
  if (!businessId) return null;
  return prisma.businessLocation.findFirst({
    where: { businessId, isActive: true },
    orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true },
  });
}

async function ensureCartFulfillmentLocation({ prisma, cart, business }) {
  if (!cart || cart.locationId) return cart;
  const mode = normaliseMultiStoreMode(business?.multiStoreMode);
  // Store-picker modes (CHAIN/BOTH) must NOT auto-default — the shopper picks
  // a branch, and that choice is the only thing that sets the location.
  // Auto-defaulting there snapped the cart back to the primary store ("becomes
  // default" on reload) and meant CHAIN shoppers were never properly prompted.
  const shouldDefaultLocation = !isStorePickerMode(mode)
    && !business?.hasDeliveryAreas
    && (mode === 'FULFILLMENT' || String(business?.vertical || '').toUpperCase() === 'ECOMMERCE');
  if (!shouldDefaultLocation) return cart;
  const location = await defaultFulfillmentLocation({ prisma, businessId: business.id });
  if (!location?.id) return cart;
  return prisma.cart.update({
    where: { id: cart.id },
    data: { locationId: location.id },
    include: { items: true },
  });
}

function storefrontNeedsStorePicker(mode) {
  return ['CHAIN', 'BOTH'].includes(String(mode || '').toUpperCase());
}

async function validateActiveLocation({ prisma, businessId, locationId }) {
  if (!locationId) return null;
  const location = await prisma.businessLocation.findUnique({
    where: { id: locationId },
    select: { id: true, businessId: true, isActive: true, name: true },
  });
  if (!location || location.businessId !== businessId) {
    const err = new Error('Location not found for this business');
    err.code = 'LOCATION_NOT_FOUND';
    throw err;
  }
  if (!location.isActive) {
    const err = new Error('Location is not active');
    err.code = 'LOCATION_INACTIVE';
    throw err;
  }
  return location;
}

async function loadLocationScopes({ prisma, businessId, locationId, productIds }) {
  const ids = Array.from(new Set((productIds || []).filter(Boolean)));
  if (!locationId || ids.length === 0) {
    return { overrides: new Map(), stocks: new Map() };
  }
  const [overrides, stocks] = await Promise.all([
    prisma.productLocationOverride.findMany({
      where: { businessId, locationId, productId: { in: ids } },
      select: { productId: true, priceMinor: true, comparePriceMinor: true, isAvailable: true },
    }),
    prisma.inventoryStock.findMany({
      where: { businessId, locationId, productId: { in: ids } },
      select: { productId: true, onHand: true, reserved: true },
    }),
  ]);
  return {
    overrides: new Map(overrides.map((row) => [row.productId, row])),
    stocks: new Map(stocks.map((row) => [row.productId, row])),
  };
}

function applyLocationScope(product, { override, stock, variantId = null, stockRequired = false } = {}) {
  if (!product) return null;
  if (override?.isAvailable === false) return null;

  const variant = variantId
    ? (product.variants || []).find((v) => v.id === variantId)
    : null;
  if (variantId && (!variant || variant.isActive === false)) return null;

  const basePrice = variant ? variant.priceMinor : product.priceMinor;
  const baseComparePrice = variant ? variant.comparePriceMinor : product.comparePriceMinor;
  const overridePrice = !variant && typeof override?.priceMinor === 'number' ? override.priceMinor : null;
  const overrideComparePrice = !variant && typeof override?.comparePriceMinor === 'number' ? override.comparePriceMinor : null;
  const locationAvailable = availableFromStock(stock);

  let stockQty = product.stockQty;
  if (variant && typeof variant.stockQty === 'number') stockQty = variant.stockQty;
  if (typeof locationAvailable === 'number') {
    // In a location-scoped grocery catalog, InventoryStock is authoritative.
    // Product.stockQty is legacy / global fallback and must not cap a store's
    // real shelf quantity after GRNs or inventory adjustments.
    stockQty = locationAvailable;
  } else if (stockRequired) {
    stockQty = 0;
  }

  return {
    ...product,
    priceMinor: overridePrice ?? basePrice,
    comparePriceMinor: overrideComparePrice ?? baseComparePrice,
    stockQty,
    locationStockQty: locationAvailable,
    locationScoped: !!(override || stock || stockRequired),
  };
}

async function scopeProducts({ prisma, businessId, locationId, products }) {
  if (!locationId || !products?.length) return products || [];
  const { overrides, stocks } = await loadLocationScopes({
    prisma,
    businessId,
    locationId,
    productIds: products.map((p) => p.id),
  });
  return products
    .map((product) => applyLocationScope(product, {
      override: overrides.get(product.id),
      stock: stocks.get(product.id),
      stockRequired: true,
    }))
    .filter(Boolean);
}

module.exports = {
  availableFromStock,
  defaultFulfillmentLocation,
  ensureCartFulfillmentLocation,
  isFulfillmentLocationMode,
  isLocationMode,
  isStorePickerMode,
  normaliseMultiStoreMode,
  requiresLocationContext,
  requiresShopperLocation,
  validateActiveLocation,
  loadLocationScopes,
  applyLocationScope,
  scopeProducts,
  storefrontNeedsStorePicker,
};
