// ECOMMERCE multi-store (2026-05-11) — cart reconciliation on store switch.
//
// When the shopper switches the cart's serving location, each item must be
// re-evaluated against the new location's catalog:
//
//   PRICE:    ProductLocationOverride.priceMinor ?? variant.priceMinor ?? Product.priceMinor
//   AVAILABLE: ProductLocationOverride.isAvailable (default true) AND
//              the product is still published AND
//              InventoryStock at the new location has onHand > reserved
//              (or no stock row exists AND the product has no global stock
//              cap — i.e. unlimited).
//
// Three terminal statuses per item:
//   kept     — same product, same price, available at the new store
//   repriced — same product, available, price differs from the cart snapshot
//   removed  — not available at the new store (override flag, missing stock,
//              unpublished, or product no longer exists)
//
// The caller (cart.controller.setLocation) uses the report to apply the
// changes atomically: update CartItem.priceMinor for repriced rows,
// delete CartItem rows for removed ones, then update Cart.locationId.

'use strict';

// Read-only: produce the reconciliation report without writing anything.
// Used by /cart/location/preview to power the confirmation modal.
async function previewReconcile({ prisma, cart, newLocationId }) {
  if (!cart || !Array.isArray(cart.items)) {
    return { items: [], summary: { kept: 0, repriced: 0, removed: 0 } };
  }
  if (cart.items.length === 0) {
    return { items: [], summary: { kept: 0, repriced: 0, removed: 0 } };
  }
  if (!newLocationId) {
    // Clearing the location — all items kept (no per-location pricing applies).
    return {
      items: cart.items.map((it) => ({
        itemId: it.id,
        productId: it.productId,
        variantId: it.variantId || null,
        quantity: it.quantity,
        oldPriceMinor: it.priceMinor,
        newPriceMinor: it.priceMinor,
        status: 'kept',
      })),
      summary: { kept: cart.items.length, repriced: 0, removed: 0 },
    };
  }

  const productIds = Array.from(new Set(cart.items.map((i) => i.productId)));
  const variantIds = Array.from(new Set(cart.items.map((i) => i.variantId).filter(Boolean)));

  const [products, variants, overrides, stocks] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, priceMinor: true, currency: true, isPublished: true, stockQty: true, businessId: true },
    }),
    variantIds.length > 0
      ? prisma.productVariant.findMany({
        where: { id: { in: variantIds } },
        select: { id: true, productId: true, label: true, priceMinor: true, stockQty: true, isActive: true },
      })
      : Promise.resolve([]),
    prisma.productLocationOverride.findMany({
      where: { locationId: newLocationId, productId: { in: productIds } },
      select: { productId: true, priceMinor: true, comparePriceMinor: true, isAvailable: true },
    }),
    prisma.inventoryStock.findMany({
      where: { locationId: newLocationId, productId: { in: productIds } },
      select: { productId: true, onHand: true, reserved: true },
    }),
  ]);

  const productById = new Map(products.map((p) => [p.id, p]));
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const overrideByPid = new Map(overrides.map((o) => [o.productId, o]));
  const stockByPid = new Map(stocks.map((s) => [s.productId, s]));

  const items = cart.items.map((it) => {
    const product = productById.get(it.productId);
    const variant = it.variantId ? variantById.get(it.variantId) : null;
    const override = overrideByPid.get(it.productId);
    const stock = stockByPid.get(it.productId);

    if (!product || !product.isPublished) {
      return mk(it, it.priceMinor, 'removed', 'unavailable_at_location', product?.name);
    }
    if (it.variantId && (!variant || !variant.isActive)) {
      return mk(it, it.priceMinor, 'removed', 'variant_unavailable', product.name);
    }
    if (override && override.isAvailable === false) {
      return mk(it, it.priceMinor, 'removed', 'unavailable_at_location', product.name);
    }

    // Stock check at new location.
    if (stock) {
      const available = (stock.onHand || 0) - (stock.reserved || 0);
      if (available <= 0) {
        return mk(it, it.priceMinor, 'removed', 'out_of_stock_at_location', product.name);
      }
      if (available < it.quantity) {
        const newPrice = effectivePrice({ override, variant, product });
        return mk(it, newPrice, newPrice === it.priceMinor ? 'quantity_changed' : 'repriced', 'quantity_reduced_at_location', product.name, available);
      }
    } else if (typeof product.stockQty === 'number' && product.stockQty <= 0) {
      // No per-location stock row AND the product's global cap is empty —
      // treat as out of stock at this store.
      return mk(it, it.priceMinor, 'removed', 'out_of_stock_at_location', product.name);
    }

    // Effective price at new location:
    //   override.priceMinor (if set) → variant.priceMinor → product.priceMinor
    const newPrice = effectivePrice({ override, variant, product });

    const status = newPrice === it.priceMinor ? 'kept' : 'repriced';
    return mk(it, newPrice, status, undefined, product.name);
  });

  const quantityChanged = items.filter((i) => i.status === 'quantity_changed').length;
  const summary = {
    kept: items.filter((i) => i.status === 'kept').length,
    repriced: items.filter((i) => i.status === 'repriced').length,
    removed: items.filter((i) => i.status === 'removed').length,
  };
  if (quantityChanged > 0) summary.quantityChanged = quantityChanged;
  return { items, summary };
}

function effectivePrice({ override, variant, product }) {
  if (override && typeof override.priceMinor === 'number' && !variant) return override.priceMinor;
  if (variant) return variant.priceMinor;
  return product.priceMinor;
}

function mk(cartItem, newPriceMinor, status, reason, productName, newQuantity) {
  return {
    itemId: cartItem.id,
    productId: cartItem.productId,
    variantId: cartItem.variantId || null,
    productName: productName || null,
    quantity: cartItem.quantity,
    newQuantity: typeof newQuantity === 'number' ? newQuantity : cartItem.quantity,
    oldPriceMinor: cartItem.priceMinor,
    newPriceMinor,
    status,
    ...(reason ? { reason } : {}),
  };
}

// Apply the reconciliation report inside a transaction. Repriced items get
// their priceMinor snapshot updated; removed items are deleted.
async function applyReconcile({ prisma, cartId, report }) {
  if (!report || !Array.isArray(report.items)) return;
  const repriced = report.items.filter((i) => i.status === 'repriced' || i.status === 'quantity_changed');
  const removed = report.items.filter((i) => i.status === 'removed');
  if (repriced.length === 0 && removed.length === 0) return;

  await prisma.$transaction(async (tx) => {
    for (const item of repriced) {
      await tx.cartItem.update({
        where: { id: item.itemId },
        data: {
          priceMinor: item.newPriceMinor,
          quantity: item.newQuantity || undefined,
        },
      });
    }
    if (removed.length > 0) {
      await tx.cartItem.deleteMany({
        where: { id: { in: removed.map((i) => i.itemId) } },
      });
    }
  });
}

module.exports = { previewReconcile, applyReconcile };
