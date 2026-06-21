'use strict';

// Starter catalog — one-click realistic sample data per e-commerce theme:
// a 3-level category tree, country-aware brands, and dummy products. Everything
// it creates is tagged isSample=true so "Remove samples" can wipe exactly what
// was seeded, leaving the merchant's own catalog untouched. The merchant can
// freely edit/keep/delete any of it — it's normal data, just flagged.
//
// Per-theme content lives in scripts/data/starter-catalogs/<theme>.json. A theme
// with no file simply has nothing to load (the endpoint reports that).

const fs = require('fs');
const path = require('path');
const prisma = require('./prisma');

const CATALOG_DIR = path.join(__dirname, '..', '..', '..', 'scripts', 'data', 'starter-catalogs');

// USD → currency, hand-maintained (sample prices are editable, so approximate is
// fine). Lets one base price render at a realistic magnitude in every currency.
const FX_FROM_USD = { USD: 1, INR: 83, NZD: 1.66, GBP: 0.79, EUR: 0.92, AUD: 1.52, CAD: 1.37, SGD: 1.35 };
const ZERO_DEC = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'IDR']);

function minorFactor(cur) { return ZERO_DEC.has(cur) ? 1 : 100; }

// Convert a USD base price to the tenant currency, rounded to a sellable number.
function priceMinorFromUsd(usd, currency) {
  const fx = FX_FROM_USD[currency] || 1;
  const major = Number(usd) * fx;
  let nice;
  if (currency === 'INR') nice = Math.max(9, Math.round(major / 10) * 10 - 1);       // ₹…9
  else if (major < 100) nice = Math.max(1, Math.round(major) - (major >= 10 ? 1 : 0)); // …9
  else nice = Math.round(major / 10) * 10 - 1;
  return Math.round(nice * minorFactor(currency));
}

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
}

// Resolve an image reference into a usable URL: full URL → as-is; bare Unsplash
// photo id ("photo-…") → CDN url; otherwise a deterministic Lorem Picsum image
// keyed by slug so every product renders something (real content overrides this).
function imageUrl(ref, seed) {
  const r = String(ref || '').trim();
  if (/^https?:\/\//.test(r)) return r;
  if (/^photo-/.test(r)) return `https://images.unsplash.com/${r}?w=700&h=700&fit=crop&q=80`;
  return `https://picsum.photos/seed/${encodeURIComponent(seed || r || 'product')}/700/700`;
}

function readCatalog(theme) {
  const file = path.join(CATALOG_DIR, `${String(theme || '').toLowerCase()}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function listThemesWithCatalog() {
  try { return fs.readdirSync(CATALOG_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')); }
  catch { return []; }
}

// Deepest level in a category tree (1-based), to bump Business.categoryMaxDepth.
function treeDepth(cats, level = 1) {
  let max = level;
  for (const c of cats || []) {
    if (Array.isArray(c.children) && c.children.length) max = Math.max(max, treeDepth(c.children, level + 1));
  }
  return max;
}

async function ensureCategory(businessId, node, parentId, sortOrder, slugMap) {
  const slug = slugify(node.slug || node.name);
  let cat = await prisma.productCategory.findFirst({ where: { businessId, slug } });
  if (!cat) {
    cat = await prisma.productCategory.create({
      data: {
        businessId, name: node.name, slug, parentId: parentId || null,
        imageUrl: node.image ? imageUrl(node.image, slug) : null,
        sortOrder, isPublished: true, isSample: true,
      },
    });
  }
  slugMap.set(slug, cat.id);
  return cat;
}

async function seedCategoryTree(businessId, cats, parentId, slugMap) {
  let order = 0;
  for (const node of cats || []) {
    const cat = await ensureCategory(businessId, node, parentId, order++, slugMap);
    if (Array.isArray(node.children) && node.children.length) {
      await seedCategoryTree(businessId, node.children, cat.id, slugMap);
    }
  }
}

async function seedBrands(businessId, brandsByCountry, countryCode) {
  const list = (brandsByCountry && (brandsByCountry[countryCode] || brandsByCountry.default)) || [];
  const brandMap = new Map();   // lowercased name -> id
  let order = 0;
  for (const b of list) {
    const name = typeof b === 'string' ? b : b.name;
    if (!name) continue;
    const slug = slugify((typeof b === 'object' && b.slug) || name);
    let brand = await prisma.productBrand.findFirst({ where: { businessId, slug } });
    if (!brand) {
      brand = await prisma.productBrand.create({
        data: { businessId, name, slug, countryCode: countryCode || null, isActive: true, sortOrder: order++, isSample: true },
      });
    }
    brandMap.set(name.toLowerCase(), brand.id);
  }
  return brandMap;
}

// Load the starter catalog for a tenant's theme. Idempotent by slug.
async function loadStarterCatalog({ businessId, theme, countryCode, currency }) {
  const catalog = readCatalog(theme);
  if (!catalog) return { ok: false, reason: 'no_catalog_for_theme', theme };

  const cur = String(currency || 'USD').toUpperCase();
  const cc = countryCode ? String(countryCode).toUpperCase().slice(0, 2) : null;

  // 3-level catalogs need categoryMaxDepth ≥ depth; bump it if the tenant is lower.
  const depth = treeDepth(catalog.categories);
  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { categoryMaxDepth: true } });
  if (biz && Number(biz.categoryMaxDepth || 2) < depth) {
    await prisma.business.update({ where: { id: businessId }, data: { categoryMaxDepth: depth } });
  }

  const slugMap = new Map();
  await seedCategoryTree(businessId, catalog.categories, null, slugMap);
  const brandMap = await seedBrands(businessId, catalog.brandsByCountry, cc);

  let productsCreated = 0;
  const products = catalog.products || [];
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const slug = slugify(p.slug || p.name);
    const exists = await prisma.product.findFirst({ where: { businessId, slug }, select: { id: true } });
    if (exists) continue;
    const categoryId = p.categorySlug ? (slugMap.get(slugify(p.categorySlug)) || null) : null;
    const brandName = p.brand || '';
    const brandId = brandMap.get(String(brandName).toLowerCase()) || null;
    await prisma.product.create({
      data: {
        businessId, name: p.name, slug, categoryId, brandId,
        brand: brandName || null,
        description: p.description || null,
        shortDescription: p.shortDescription || null,
        priceMinor: priceMinorFromUsd(p.priceUsd ?? 0, cur),
        comparePriceMinor: p.compareUsd ? priceMinorFromUsd(p.compareUsd, cur) : null,
        currency: cur,
        stockQty: p.stock == null ? null : Number(p.stock),
        imageUrls: JSON.stringify([imageUrl(p.image, slug)]),
        isPublished: true, sortOrder: i, isSample: true,
        ...(p.specs ? { specs: JSON.stringify(p.specs) } : {}),
      },
    });
    productsCreated++;
  }

  const counts = {
    categories: await prisma.productCategory.count({ where: { businessId, isSample: true } }),
    brands: await prisma.productBrand.count({ where: { businessId, isSample: true } }),
    products: await prisma.product.count({ where: { businessId, isSample: true } }),
  };
  return { ok: true, theme, currency: cur, productsCreated, counts };
}

// Delete everything the starter loader created for a tenant (isSample=true).
async function removeSampleCatalog({ businessId }) {
  const [products, brands, families, categories] = await prisma.$transaction([
    prisma.product.deleteMany({ where: { businessId, isSample: true } }),
    prisma.productBrand.deleteMany({ where: { businessId, isSample: true } }),
    prisma.productBrandFamily.deleteMany({ where: { businessId, isSample: true } }),
    prisma.productCategory.deleteMany({ where: { businessId, isSample: true } }),
  ]);
  return { ok: true, removed: { products: products.count, brands: brands.count, families: families.count, categories: categories.count } };
}

module.exports = { loadStarterCatalog, removeSampleCatalog, readCatalog, listThemesWithCatalog };
