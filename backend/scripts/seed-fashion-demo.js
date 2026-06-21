#!/usr/bin/env node
// Fashion/apparel demo catalog + theme flip — so you can look-and-feel the
// bespoke `fashion` storefront theme with real-looking data.
//
// Usage:
//   node scripts/seed-fashion-demo.js [slug]
//   node scripts/seed-fashion-demo.js [slug] --create     # create the tenant if missing
//
// What it does (idempotent — skips rows that already exist):
//   1. Finds the business by slug (default: fashion-demo). With --create it
//      creates a minimal ECOMMERCE business (and attaches a subscription if a
//      plan tier exists). Otherwise create the tenant via onboarding first.
//   2. Sets that business's subscription.theme = 'fashion'.
//   3. Seeds fashion categories.
//   4. Seeds ~30 products with Size × Colour variants, images, sale prices.
//   5. Seeds PUBLISHED reviews so the ★ rating pills render.
//
// Images default to picsum.photos placeholders (guaranteed to load). Swap the
// `img()` base for your CDN / Unsplash product shots for a production catalog.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'fashion-demo').toLowerCase();
const CREATE = args.includes('--create');

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
// Portrait placeholder images — deterministic per seed so a product keeps the
// same shots across runs and the hover-swap shows a *different* second image.
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent(seed)}/800/1000`;

const CATEGORIES = [
  { name: 'Ethnic Tops', slug: 'ethnic-tops', sort: 1 },
  { name: 'Kurtas & Suits', slug: 'kurtas-suits', sort: 2 },
  { name: 'Dresses', slug: 'dresses', sort: 3 },
  { name: 'Sarees', slug: 'sarees', sort: 4 },
  { name: 'Lehengas', slug: 'lehengas', sort: 5 },
  { name: 'Co-ord Sets', slug: 'co-ord-sets', sort: 6 },
  { name: 'Jackets & Shrugs', slug: 'jackets-shrugs', sort: 7 },
  { name: 'Bottoms', slug: 'bottoms', sort: 8 },
];

// Sub-categories per parent → a real two-level category tree. Products are
// assigned to a leaf sub-category (round-robin within their parent); the
// storefront expands a parent to all descendants, so the parent page still
// shows everything while the sub-category sidebar lets you drill in.
const SUBCATS = {
  'ethnic-tops': [['A-Line & Tunics', 'tops-aline'], ['Peplum & Flared', 'tops-peplum'], ['Kaftan & Boxy', 'tops-kaftan']],
  'kurtas-suits': [['Anarkali', 'kurtas-anarkali'], ['Straight Kurtas', 'kurtas-straight'], ['Kurta Sets', 'kurtas-sets']],
  dresses: [['Midi Dresses', 'dresses-midi'], ['Maxi Dresses', 'dresses-maxi'], ['Shift & A-Line', 'dresses-shift']],
  sarees: [['Silk Sarees', 'sarees-silk'], ['Cotton & Linen', 'sarees-cotton'], ['Organza & Sheer', 'sarees-organza']],
  lehengas: [['Bridal', 'lehengas-bridal'], ['Party & Festive', 'lehengas-party']],
  'co-ord-sets': [['Kurta Sets', 'coord-kurta'], ['Crop & Skirt', 'coord-crop'], ['Lounge', 'coord-lounge']],
  'jackets-shrugs': [['Jackets', 'js-jackets'], ['Shrugs & Capes', 'js-shrugs']],
  bottoms: [['Palazzos & Pants', 'bottoms-palazzo'], ['Shararas & Salwars', 'bottoms-sharara']],
};

const COLOURS = [
  { name: 'Black', hex: '#1c1c1c' },
  { name: 'Ivory', hex: '#efe7d6' },
  { name: 'Maroon', hex: '#6b1f2a' },
  { name: 'Indigo', hex: '#34406b' },
  { name: 'Mustard', hex: '#c99a2e' },
  { name: 'Emerald', hex: '#1f6b53' },
  { name: 'Blush', hex: '#d6a7a0' },
  { name: 'Teal', hex: '#1f6b6b' },
  { name: 'Rust', hex: '#9c4a2b' },
];
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const BRANDS = ['Aara', 'Indya', 'Libas', 'Biba', 'Janasya', 'Sangria', 'Kalini', 'W'];

// Fabric + fit power the new faceted filters and the PDP "Product details" block.
// Assigned per category so the facet values feel believable for the garment.
const FABRIC_BY_CAT = {
  'ethnic-tops': ['Cotton', 'Cotton Blend', 'Schiffli Cotton', 'Rayon'],
  'kurtas-suits': ['Cotton', 'Silk Blend', 'Chanderi', 'Rayon'],
  dresses: ['Cotton', 'Viscose', 'Crepe', 'Linen Blend'],
  sarees: ['Silk', 'Organza', 'Linen', 'Georgette'],
  lehengas: ['Silk', 'Georgette', 'Velvet', 'Organza'],
  'co-ord-sets': ['Cotton', 'Crepe', 'Schiffli Cotton', 'Rayon'],
  'jackets-shrugs': ['Cotton', 'Velvet', 'Cotton Blend', 'Silk Blend'],
  bottoms: ['Cotton', 'Rayon', 'Crepe', 'Cotton Blend'],
};
const FABRIC_COMPOSITION = {
  Cotton: '100% Cotton', 'Cotton Blend': '70% Cotton, 30% Polyester', 'Schiffli Cotton': '100% Schiffli Cotton',
  Rayon: '100% Rayon', 'Silk Blend': '60% Silk, 40% Viscose', Chanderi: 'Chanderi Silk-Cotton',
  Viscose: '100% Viscose', Crepe: '100% Polyester Crepe', 'Linen Blend': '55% Linen, 45% Cotton',
  Silk: '100% Art Silk', Organza: '100% Organza', Linen: '100% Handloom Linen', Georgette: '100% Georgette',
  Velvet: '100% Velvet',
};
const FITS = [
  { fit: 'Relaxed Fit', sizing: 'true' },
  { fit: 'Regular Fit', sizing: 'true' },
  { fit: 'Slim Fit', sizing: 'small' },
  { fit: 'Flared', sizing: 'true' },
  { fit: 'Boxy', sizing: 'large' },
];
const CARE = ['Hand wash cold', 'Do not bleach', 'Dry in shade', 'Warm iron'];
const SIZING_NOTE = { small: 'Runs small — we suggest sizing up', true: 'True to size — take your usual size', large: 'Runs large — we suggest sizing down' };

const REVIEW_BODIES = [
  'Beautiful fabric and the fit is spot on. Got so many compliments!',
  'Colour is exactly like the picture. Stitching quality is lovely.',
  'Comfortable and looks premium for the price. Will buy more.',
  'Material is soft and breathable — perfect for all-day wear.',
  'Runs slightly large, so size down. Otherwise gorgeous.',
  'Loved it. Delivery was quick and packaging was neat.',
  'Elegant and well-tailored. A new favourite in my wardrobe.',
  'Great value. The print is even prettier in person.',
];

// name, category slug, ₹price, ₹MRP (compare)
const PRODUCTS = [
  ['Chikankari Embroidered A-Line Top', 'ethnic-tops', 899, 1799],
  ['Floral Print Mandarin-Collar Top', 'ethnic-tops', 749, 1499],
  ['Bandhani Flared Peplum Top', 'ethnic-tops', 999, 1899],
  ['Schiffli Cotton Boxy Top', 'ethnic-tops', 1099, 1999],
  ['Mirror-Work Kaftan Top', 'ethnic-tops', 1299, 2599],
  ['Block-Print Tunic Top', 'ethnic-tops', 699, 1399],
  ['Anarkali Kurta with Dupatta', 'kurtas-suits', 1999, 3999],
  ['Straight Cotton Kurta Set', 'kurtas-suits', 1499, 2999],
  ['Embroidered Silk-Blend Kurta', 'kurtas-suits', 1799, 3299],
  ['Printed Palazzo Kurta Set', 'kurtas-suits', 1699, 3199],
  ['Bandhgala Cotton Kurta', 'kurtas-suits', 1299, 2499],
  ['Ikat Wrap Midi Dress', 'dresses', 1599, 2999],
  ['Tiered Cotton Maxi Dress', 'dresses', 1799, 3499],
  ['Ruffle-Sleeve Shift Dress', 'dresses', 1299, 2599],
  ['Floral Fit-and-Flare Dress', 'dresses', 1399, 2799],
  ['Hand-Block Kalidar Dress', 'dresses', 1899, 3599],
  ['Banarasi Silk Saree', 'sarees', 3499, 6999],
  ['Organza Floral Saree', 'sarees', 2799, 5599],
  ['Linen Handloom Saree', 'sarees', 2299, 4499],
  ['Georgette Sequin Saree', 'sarees', 2999, 5999],
  ['Cotton Jamdani Saree', 'sarees', 1999, 3999],
  ['Printed Kurta & Pant Co-ord', 'co-ord-sets', 1899, 3599],
  ['Embroidered Crop & Skirt Set', 'co-ord-sets', 2199, 4299],
  ['Co-ord Shirt & Trouser Set', 'co-ord-sets', 1699, 3299],
  ['Schiffli Co-ord Lounge Set', 'co-ord-sets', 1499, 2899],
  ['High-Waist Palazzo Trousers', 'bottoms', 899, 1699],
  ['Printed Cotton Pants', 'bottoms', 799, 1499],
  ['Pleated Sharara Pants', 'bottoms', 1099, 2099],
  ['Tulip Cotton Salwar', 'bottoms', 749, 1399],
  ['Flared Dhoti Pants', 'bottoms', 999, 1899],
  // Premium pieces — populate the ₹3,500+ price bucket + richer faceting.
  ['Hand-Embroidered Bridal Lehenga', 'lehengas', 12999, 24999],
  ['Sequin Party Lehenga Set', 'lehengas', 7499, 13999],
  ['Velvet Festive Lehenga', 'lehengas', 8999, 16999],
  ['Mirror-Work Lehenga Choli', 'lehengas', 6499, 11999],
  ['Zari Kanjeevaram Silk Saree', 'sarees', 5999, 10999],
  ['Designer Net Embroidered Saree', 'sarees', 4499, 8499],
  ['Pure Tussar Silk Saree', 'sarees', 3999, 6999],
  ['Embroidered Velvet Shrug', 'jackets-shrugs', 1899, 3499],
  ['Quilted Cotton Jacket', 'jackets-shrugs', 2299, 3999],
  ['Sheer Organza Cape', 'jackets-shrugs', 1599, 2999],
  ['Block-Print Cotton Shrug', 'jackets-shrugs', 999, 1899],
  ['Hand-Painted Silk Anarkali', 'kurtas-suits', 4299, 7999],
  ['Wedding Co-ord Sharara Set', 'co-ord-sets', 4999, 8999],
  ['Floral Maxi Gown', 'dresses', 3299, 5999],
];

async function ensureBusiness() {
  let business = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (business) return business;
  if (!CREATE) {
    console.error(`\nBusiness "${SLUG}" not found.`);
    console.error('Point this at an existing ECOMMERCE tenant slug, or re-run with --create.\n');
    process.exit(1);
  }
  // Minimal create. Subscription needs a tierId, so attach one if a plan tier
  // exists; otherwise the catalog still seeds and you can set the theme later.
  business = await p.business.create({
    data: { name: 'Maison — Fashion Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' },
    select: { id: true, name: true, vertical: true },
  });
  console.log(`  created business: ${business.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) {
      await p.subscription.create({ data: { businessId: business.id, tierId: tier.id, theme: 'fashion' } });
      console.log('  created subscription (theme=fashion)');
    } else {
      console.warn('  ⚠ no plan tier found — skipped subscription; set theme=fashion once the tenant has one');
    }
  } catch (e) {
    console.warn('  ⚠ could not auto-create subscription:', e.message);
  }
  return business;
}

async function main() {
  console.log(`\nSeeding FASHION demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') {
    console.warn(`  ⚠ business vertical is ${business.vertical}, not ECOMMERCE — storefront may not render the shop.`);
  }

  // 1. Flip theme → fashion
  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) {
    if (sub.theme !== 'fashion') {
      await p.subscription.update({ where: { businessId: BID }, data: { theme: 'fashion' } });
      console.log('  set subscription.theme = fashion');
    } else console.log('  skip  theme (already fashion)');
  } else {
    console.warn('  ⚠ no subscription on this business — cannot set theme=fashion (storefront will use the default theme).');
  }

  // 2. Categories
  const catBySlug = new Map();
  for (const c of CATEGORIES) {
    let row = await p.productCategory.findFirst({ where: { businessId: BID, slug: c.slug }, select: { id: true } });
    if (!row) {
      row = await p.productCategory.create({ data: { businessId: BID, name: c.name, slug: c.slug, sortOrder: c.sort, isPublished: true, imageUrl: img(`cat-${c.slug}`) }, select: { id: true } });
      console.log(`  created category: ${c.name}`);
    }
    catBySlug.set(c.slug, row.id);
  }

  // 2b. Sub-categories → a real two-level tree. Products are re-homed onto a
  // leaf below (round-robin), but the parent page still shows everything because
  // getPublicProducts expands a category to all of its descendants.
  const subsByParent = new Map();
  for (const [parentSlug, subs] of Object.entries(SUBCATS)) {
    const parentId = catBySlug.get(parentSlug);
    if (!parentId) continue;
    const leafSlugs = [];
    for (let s = 0; s < subs.length; s++) {
      const [name, slug] = subs[s];
      let row = await p.productCategory.findFirst({ where: { businessId: BID, slug }, select: { id: true, parentId: true } });
      if (!row) {
        row = await p.productCategory.create({ data: { businessId: BID, name, slug, parentId, sortOrder: s + 1, isPublished: true, imageUrl: img(`cat-${slug}`) }, select: { id: true, parentId: true } });
        console.log(`    created sub-category: ${parentSlug} › ${name}`);
      } else if (row.parentId !== parentId) {
        await p.productCategory.update({ where: { id: row.id }, data: { parentId } });
        console.log(`    linked sub-category: ${parentSlug} › ${name}`);
      }
      catBySlug.set(slug, row.id);
      leafSlugs.push(slug);
    }
    subsByParent.set(parentSlug, leafSlugs);
  }

  // 3. Products + Size × Colour variants
  const rrCounter = {}; // per-parent round-robin index into its leaf sub-cats
  let createdProducts = 0;
  for (let i = 0; i < PRODUCTS.length; i++) {
    const [name, catSlug, price, mrp] = PRODUCTS[i];
    const slug = slugify(name);

    // Pick a leaf sub-category (round-robin within the parent) so the PLP
    // sidebar can drill in; fall back to the parent if it has no sub-cats.
    const leafSlugs = subsByParent.get(catSlug) || [];
    let leafSlug = catSlug;
    if (leafSlugs.length) {
      const n = (rrCounter[catSlug] = (rrCounter[catSlug] ?? -1) + 1);
      leafSlug = leafSlugs[n % leafSlugs.length];
    }
    const leafCatId = catBySlug.get(leafSlug) || catBySlug.get(catSlug);

    // Garment metadata that powers the faceted PLP filters (fabric) and the
    // PDP "Product details" + fit-guidance + size-guidance blocks. Computed
    // up-front so we can also BACKFILL it onto products seeded before specs
    // existed (otherwise the new fabric facet / fit / details render empty).
    const fabric = rand(FABRIC_BY_CAT[catSlug] || ['Cotton']);
    const fitRow = rand(FITS);
    const specs = {
      fabric,
      fabricComposition: FABRIC_COMPOSITION[fabric] || fabric,
      fit: fitRow.fit,
      sizing: fitRow.sizing, // 'small' | 'true' | 'large'
      sizingNote: SIZING_NOTE[fitRow.sizing],
      model: `Model is 5'8" and wears a size M`,
      care: CARE,
      details: [
        `${fitRow.fit} silhouette`,
        `${FABRIC_COMPOSITION[fabric] || fabric}`,
        catSlug === 'sarees' ? 'Comes with unstitched blouse piece' : 'Concealed side zip',
        'Designed and crafted in India',
      ],
    };

    const exists = await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true, specs: true, categoryId: true } });
    if (exists) {
      const patch = {};
      if (!exists.specs) { patch.specs = specs; patch.shortDescription = `${fabric} · ${fitRow.fit}`; }
      if (exists.categoryId !== leafCatId) patch.categoryId = leafCatId; // re-home onto the leaf sub-cat
      if (Object.keys(patch).length) {
        await p.product.update({ where: { id: exists.id }, data: patch });
        console.log(`  updated: ${name}${patch.categoryId ? ` → ${leafSlug}` : ''}${patch.specs ? ' (+specs)' : ''}`);
      }
      continue;
    }

    const brand = BRANDS[i % BRANDS.length];
    const priceMinor = price * 100;
    const compareMinor = mrp * 100;
    // 2–3 colourways, 4–6 sizes.
    const colours = [...COLOURS].sort(() => Math.random() - 0.5).slice(0, randInt(2, 3));
    const sizes = SIZES.slice(0, randInt(4, 6));
    const images = [img(`${slug}-1`), img(`${slug}-2`), img(`${slug}-3`)];

    const product = await p.product.create({
      data: {
        businessId: BID,
        categoryId: leafCatId,
        name,
        slug,
        brand,
        shortDescription: `${fabric} · ${fitRow.fit}`,
        description: `${name} by ${brand}. Cut from ${fabric.toLowerCase()} with a ${fitRow.fit.toLowerCase()} silhouette for all-day ease. Style it with ${catSlug === 'bottoms' ? 'your favourite kurta' : 'minimal gold accessories'} for an effortless look. Model is 5'8" and wears size M.`,
        priceMinor,
        comparePriceMinor: compareMinor,
        currency: 'INR',
        imageUrls: images,
        specs,
        isPublished: true,
        isFeatured: i % 4 === 0,
        sortOrder: i,
        stockQty: null,
        createdAt: daysAgo(randInt(0, 60)),
      },
      select: { id: true },
    });

    let sortOrder = 0;
    let first = true;
    for (const colour of colours) {
      for (const size of sizes) {
        await p.productVariant.create({
          data: {
            productId: product.id,
            label: `${size} / ${colour.name}`,
            priceMinor,
            comparePriceMinor: compareMinor,
            stockQty: Math.random() < 0.12 ? 0 : randInt(2, 40), // a few sold-out combos
            option1Name: 'Size', option1Value: size,
            option2Name: 'Colour', option2Value: colour.name,
            swatchHex: colour.hex,
            imageUrl: img(`${slug}-${colour.name.toLowerCase()}`),
            sortOrder: sortOrder++,
            isDefault: first,
            isActive: true,
          },
        });
        first = false;
      }
    }
    createdProducts++;
    console.log(`  created product: ${name} (${colours.length}×${sizes.length} variants)`);
  }

  // 4. Reviews (PUBLISHED) so rating pills show
  const allProducts = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true } });
  let createdReviews = 0;
  for (const pr of allProducts) {
    const count = await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } });
    if (count > 0) continue;
    const n = randInt(0, 6);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.75 ? randInt(4, 5) : randInt(3, 4);
      await p.ecomReview.create({
        data: {
          businessId: BID, productId: pr.id,
          customerName: rand(['Aanya', 'Diya', 'Meera', 'Riya', 'Sara', 'Ananya', 'Ishita', 'Nisha']) + ' ' + rand(['S.', 'K.', 'M.', 'R.']),
          rating,
          title: rating >= 5 ? 'Loved it' : rating >= 4 ? 'Really good' : 'Nice',
          body: rand(REVIEW_BODIES),
          status: 'PUBLISHED',
          verifiedBuyer: Math.random() < 0.7,
        },
      });
      createdReviews++;
    }
  }

  console.log(`\n✅ Fashion demo seeded — ${createdProducts} new products, ${createdReviews} reviews.`);
  console.log(`   Open the storefront for "${SLUG}" (theme: fashion) to view it.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
