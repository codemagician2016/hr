// Loads the static demo-shop catalog (built once via
// scripts/build-demo-catalog.js) into a tenant's product table. Used by
// both the admin "Load 500 sample products" button and the CLI script
// scripts/seed-demo-shop.js.
//
// Idempotent: skips categories/products whose slug already exists for
// the business. Pass { reset: true } to wipe the tenant's catalog
// before reseeding (destructive — call from a confirmed UI flow only).

const path = require('path');
const fs = require('fs');
const prisma = require('./prisma');
const { DEFAULT_CURRENCY } = require('./currency');

let _catalogCache = null;
function loadCatalog() {
  if (_catalogCache) return _catalogCache;
  const catalogPath = path.join(__dirname, '..', '..', '..', 'scripts', 'data', 'demo-shop-catalog.json');
  const raw = fs.readFileSync(catalogPath, 'utf-8');
  _catalogCache = JSON.parse(raw);
  return _catalogCache;
}

const { slugify } = require('./slugify');

async function primaryInventoryLocationId(businessId) {
  const location = await prisma.businessLocation.findFirst({
    where: { businessId, isActive: true },
    select: { id: true },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
  return location?.id || null;
}

async function seedOpeningInventory({ businessId, products }) {
  if (!products.length) return 0;
  const locationId = await primaryInventoryLocationId(businessId);
  if (!locationId) return 0;

  const productRows = await prisma.product.findMany({
    where: { businessId, slug: { in: products.map((p) => p.slug) } },
    select: { id: true, slug: true },
  });
  const stockBySlug = new Map(products.map((p) => [p.slug, Math.max(0, Number(p.stockQty) || 0)]));
  const stockRows = productRows.map((product) => ({
    businessId,
    productId: product.id,
    locationId,
    onHand: stockBySlug.get(product.slug) || 0,
    reserved: 0,
  }));
  if (stockRows.length === 0) return 0;
  await prisma.inventoryStock.createMany({ data: stockRows, skipDuplicates: true });

  const createdStocks = await prisma.inventoryStock.findMany({
    where: { businessId, locationId, productId: { in: productRows.map((product) => product.id) } },
    select: { id: true, onHand: true },
  });
  const adjustments = createdStocks
    .filter((stock) => stock.onHand > 0)
    .map((stock) => ({
      businessId,
      stockId: stock.id,
      delta: stock.onHand,
      reason: 'COUNT_ADJUSTMENT',
      note: 'Sample catalog opening stock',
      sourceType: 'SAMPLE_CATALOG',
      sourceId: stock.id,
      onHandAfter: stock.onHand,
    }));
  if (adjustments.length > 0) {
    await prisma.inventoryAdjustment.createMany({ data: adjustments });
  }
  return stockRows.length;
}

// Public — load demo products + categories into the given business.
// Returns { categoriesCreated, productsCreated, skipped }.
async function loadDemoShop({ businessId, reset = false } = {}) {
  if (!businessId) throw new Error('businessId is required');

  const catalog = loadCatalog();

  if (reset) {
    // Cascade-deletes products via the FK relation; categories follow.
    await prisma.product.deleteMany({ where: { businessId } });
    await prisma.productCategory.deleteMany({ where: { businessId } });
  }

  // Ensure all 15 categories exist (idempotent — upsert-like).
  const existingCategories = await prisma.productCategory.findMany({
    where: { businessId },
    select: { id: true, slug: true },
  });
  const catBySlug = new Map(existingCategories.map((c) => [c.slug, c.id]));

  let categoriesCreated = 0;
  for (const cat of catalog.categories) {
    if (catBySlug.has(cat.key)) continue;
    const created = await prisma.productCategory.create({
      data: {
        businessId,
        name: cat.label,
        slug: cat.key,
        sortOrder: cat.sortOrder || 0,
        isPublished: true,
      },
      select: { id: true, slug: true },
    });
    catBySlug.set(created.slug, created.id);
    categoriesCreated += 1;
  }

  // Ensure every product slug is unique per business — append a numeric
  // suffix on collision (rare; only when reseeding without --reset and
  // the catalog has new products with name-clashing slugs).
  const existingProducts = await prisma.product.findMany({
    where: { businessId },
    select: { slug: true },
  });
  const usedSlugs = new Set(existingProducts.map((p) => p.slug));

  function uniqueSlug(base) {
    let s = base;
    let i = 2;
    while (usedSlugs.has(s)) {
      s = `${base}-${i}`;
      i += 1;
    }
    usedSlugs.add(s);
    return s;
  }

  // Insert in chunks of 25 — keeps transaction size small + gives each
  // product its own row (so partial failures don't block the rest).
  let productsCreated = 0;
  let skipped = 0;
  const CHUNK = 25;
  for (let i = 0; i < catalog.products.length; i += CHUNK) {
    const batch = catalog.products.slice(i, i + CHUNK);
    const rows = [];
    const inventoryRows = [];
    for (const p of batch) {
      const categoryId = catBySlug.get(p.categoryKey);
      if (!categoryId) {
        skipped += 1;
        continue;
      }
      const slug = uniqueSlug(slugify(p.slug || p.name));
      rows.push({
        businessId,
        categoryId,
        name: p.name,
        slug,
        description: p.description ?? null,
        shortDescription: p.shortDescription ?? null,
        sku: p.sku ?? null,
        priceMinor: p.priceMinor,
        comparePriceMinor: p.comparePriceMinor ?? null,
        currency: p.currency || DEFAULT_CURRENCY,
        stockQty: null,
        weightGrams: p.weightGrams ?? null,
        weightDisplay: p.weightDisplay ?? null,
        imageUrls: p.imageUrls ?? [],
        isPublished: p.isPublished !== false,
        isFeatured: !!p.isFeatured,
        sortOrder: p.sortOrder || 0,
        metaTitle: p.metaTitle ?? null,
        metaDescription: p.metaDescription ?? null,
      });
      inventoryRows.push({ slug, stockQty: p.stockQty ?? 0 });
    }
    if (rows.length === 0) continue;
    const result = await prisma.product.createMany({ data: rows, skipDuplicates: true });
    await seedOpeningInventory({ businessId, products: inventoryRows });
    productsCreated += result.count;
  }

  // Set Business.defaultCurrency to USD so any new products the owner
  // adds afterwards default to the same currency as the seeded set.
  // Don't overwrite if a different currency is already set — owner
  // intent wins.
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { defaultCurrency: true },
  });
  if (!business?.defaultCurrency) {
    await prisma.business.update({
      where: { id: businessId },
      data: { defaultCurrency: 'USD' },
    });
  }

  return {
    categoriesTotal: catalog.categories.length,
    productsTotal: catalog.products.length,
    categoriesCreated,
    productsCreated,
    skipped,
  };
}

// Default-categories helper — called from business.controller.setup
// when a fresh ECOMMERCE business is created. Seeds 8 starter categories
// (subset of the demo catalog) so the new admin lands with somewhere to
// put their first product. Does NOT seed products. Idempotent.
const DEFAULT_ECOMMERCE_CATEGORIES = [
  { slug: 'produce',     name: 'Produce',     sortOrder: 1 },
  { slug: 'dairy-eggs',  name: 'Dairy & Eggs', sortOrder: 2 },
  { slug: 'bakery',      name: 'Bakery',      sortOrder: 3 },
  { slug: 'beverages',   name: 'Beverages',   sortOrder: 4 },
  { slug: 'snacks',      name: 'Snacks',      sortOrder: 5 },
  { slug: 'pantry',      name: 'Pantry',      sortOrder: 6 },
  { slug: 'frozen',      name: 'Frozen',      sortOrder: 7 },
  { slug: 'personal-care', name: 'Personal Care', sortOrder: 8 },
];

async function seedDefaultEcommerceCategories(businessId) {
  if (!businessId) return { created: 0 };
  const existing = await prisma.productCategory.findMany({
    where: { businessId },
    select: { slug: true },
  });
  const existingSlugs = new Set(existing.map((c) => c.slug));
  let created = 0;
  for (const cat of DEFAULT_ECOMMERCE_CATEGORIES) {
    if (existingSlugs.has(cat.slug)) continue;
    await prisma.productCategory.create({
      data: {
        businessId,
        name: cat.name,
        slug: cat.slug,
        sortOrder: cat.sortOrder,
        isPublished: true,
      },
    });
    created += 1;
  }
  return { created };
}

module.exports = {
  loadDemoShop,
  seedDefaultEcommerceCategories,
  DEFAULT_ECOMMERCE_CATEGORIES,
};
