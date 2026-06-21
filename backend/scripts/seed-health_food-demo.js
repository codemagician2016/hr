#!/usr/bin/env node
// Health food / supplements demo catalog + theme flip — to look-and-feel the
// bespoke `health_food` storefront theme (pack sizes, flavours, brands, sale
// prices). The theme renders from standard product fields + option1/option2
// variants + brand (it does not read Product.specs).
//
// Usage:
//   node scripts/seed-health_food-demo.js [slug]
//   node scripts/seed-health_food-demo.js [slug] --create
//
// Idempotent. Sets subscription.theme = 'health_food'.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'healthfood-demo').toLowerCase();
const CREATE = args.includes('--create');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent('hf-' + seed)}/700/700`;

const CATEGORIES = [
  { name: 'Protein', slug: 'protein', sort: 1 },
  { name: 'Vitamins', slug: 'vitamins', sort: 2 },
  { name: 'Healthy Snacks', slug: 'healthy-snacks', sort: 3 },
  { name: 'Organic Pantry', slug: 'organic-pantry', sort: 4 },
  { name: 'Superfoods', slug: 'superfoods', sort: 5 },
  { name: 'Digestive Health', slug: 'digestive-health', sort: 6 },
  { name: 'Sports Nutrition', slug: 'sports-nutrition', sort: 7 },
  { name: 'Bundles', slug: 'bundles', sort: 8 },
];

const SUBCATS = {
  protein: [['Whey', 'protein-whey'], ['Plant', 'protein-plant'], ['Collagen', 'protein-collagen']],
  vitamins: [['Daily', 'vit-daily'], ['Minerals', 'vit-minerals'], ['Omega', 'vit-omega']],
  'healthy-snacks': [['Bars', 'snack-bars'], ['Mixes', 'snack-mixes']],
  'organic-pantry': [['Oils', 'pantry-oils'], ['Sweeteners', 'pantry-sweeteners'], ['Grains', 'pantry-grains']],
  superfoods: [['Greens', 'super-greens'], ['Seeds', 'super-seeds']],
  'digestive-health': [['Probiotics', 'digest-probiotics'], ['Fibre', 'digest-fibre']],
  'sports-nutrition': [['Pre-Workout', 'sports-preworkout'], ['Recovery', 'sports-recovery'], ['Creatine', 'sports-creatine']],
};
const NAME_SUBCAT = {
  'Whey Protein Isolate': 'protein-whey', 'Plant Protein Blend': 'protein-plant', 'Casein Protein': 'protein-whey', 'Collagen Peptides': 'protein-collagen',
  'Daily Multivitamin': 'vit-daily', 'Vitamin D3 + K2': 'vit-daily', 'Magnesium Glycinate': 'vit-minerals', 'Omega-3 Fish Oil': 'vit-omega',
  'Protein Bars (Box of 12)': 'snack-bars', 'Trail Mix': 'snack-mixes', 'Roasted Seed Mix': 'snack-mixes',
  'Cold-Pressed Coconut Oil': 'pantry-oils', 'Raw Forest Honey': 'pantry-sweeteners', 'Organic Rolled Oats': 'pantry-grains',
  'Spirulina Powder': 'super-greens', 'Moringa Powder': 'super-greens', 'Chia Seeds': 'super-seeds',
  'Probiotic Capsules': 'digest-probiotics', 'Psyllium Husk Fibre': 'digest-fibre',
  'Pre-Workout': 'sports-preworkout', 'BCAA Recovery': 'sports-recovery', 'Creatine Monohydrate': 'sports-creatine',
};

const REVIEW_BODIES = [
  'Clean ingredients and it actually tastes good.',
  'Mixes smoothly, no chalky aftertaste.',
  'Great value for the quality. Reordering.',
  'Noticeable difference in my energy levels.',
  'Love that it is third-party tested.',
  'Perfect addition to my morning routine.',
];

// name, category, brand, ₹price, ₹mrp|null, sizeOpts[label], flavourOpts[[label,hex]] ([] = no 2nd axis)
const PRODUCTS = [
  ['Whey Protein Isolate', 'protein', 'PureFuel', 2499, 2999, ['1 kg', '2 kg'], [['Chocolate', '#6F4E37'], ['Vanilla', '#F3E5AB'], ['Unflavoured', '#EFE9DD']]],
  ['Plant Protein Blend', 'protein', 'GreenForm', 1999, 2399, ['500 g', '1 kg'], [['Chocolate', '#6F4E37'], ['Berry', '#9B2D5B']]],
  ['Casein Protein', 'protein', 'PureFuel', 2299, null, ['1 kg'], [['Chocolate', '#6F4E37'], ['Vanilla', '#F3E5AB']]],
  ['Collagen Peptides', 'protein', 'GlowWell', 1799, 2099, ['300 g', '600 g'], []],
  ['Daily Multivitamin', 'vitamins', 'VitaCore', 899, 1099, ['60 caps', '120 caps'], []],
  ['Vitamin D3 + K2', 'vitamins', 'VitaCore', 649, null, ['60 caps'], []],
  ['Magnesium Glycinate', 'vitamins', 'CalmRoot', 749, 899, ['60 caps', '120 caps'], []],
  ['Omega-3 Fish Oil', 'vitamins', 'VitaCore', 799, 999, ['60 softgels', '120 softgels'], []],
  ['Protein Bars (Box of 12)', 'healthy-snacks', 'SnackLab', 999, 1199, ['Box of 12'], [['Peanut', '#C68958'], ['Cocoa', '#6F4E37'], ['Almond', '#EFD9A6']]],
  ['Trail Mix', 'healthy-snacks', 'SnackLab', 349, 399, ['250 g', '500 g'], []],
  ['Roasted Seed Mix', 'healthy-snacks', 'SnackLab', 299, null, ['200 g'], []],
  ['Cold-Pressed Coconut Oil', 'organic-pantry', 'EarthPantry', 549, 649, ['500 ml', '1 L'], []],
  ['Raw Forest Honey', 'organic-pantry', 'EarthPantry', 449, 549, ['500 g', '1 kg'], []],
  ['Organic Rolled Oats', 'organic-pantry', 'EarthPantry', 249, null, ['1 kg'], []],
  ['Spirulina Powder', 'superfoods', 'GreenForm', 699, 849, ['200 g'], []],
  ['Moringa Powder', 'superfoods', 'GreenForm', 599, null, ['200 g'], []],
  ['Chia Seeds', 'superfoods', 'EarthPantry', 349, 399, ['250 g', '500 g'], []],
  ['Probiotic Capsules', 'digestive-health', 'BioFlora', 999, 1199, ['30 caps', '60 caps'], []],
  ['Psyllium Husk Fibre', 'digestive-health', 'BioFlora', 399, null, ['250 g'], []],
  ['Pre-Workout', 'sports-nutrition', 'PureFuel', 1499, 1799, ['300 g'], [['Fruit Punch', '#E23B58'], ['Blue Raspberry', '#2E78C7']]],
  ['BCAA Recovery', 'sports-nutrition', 'PureFuel', 1299, null, ['250 g', '500 g'], [['Lemon', '#E6D72A'], ['Watermelon', '#E23B58']]],
  ['Creatine Monohydrate', 'sports-nutrition', 'PureFuel', 899, 1099, ['250 g', '500 g'], []],
  ['Wellness Starter Bundle', 'bundles', 'PureFuel', 3499, 4299, ['1 bundle'], []],
  ['Daily Greens Bundle', 'bundles', 'GreenForm', 2799, 3299, ['1 bundle'], []],
];

async function ensureBusiness() {
  let b = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (b) return b;
  if (!CREATE) { console.error(`\nBusiness "${SLUG}" not found. Use an existing ECOMMERCE slug or re-run with --create.\n`); process.exit(1); }
  b = await p.business.create({ data: { name: 'VitalRoot — Health Food Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
  console.log(`  created business: ${b.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) { await p.subscription.create({ data: { businessId: b.id, tierId: tier.id, theme: 'health_food' } }); console.log('  created subscription (theme=health_food)'); }
    else console.warn('  ⚠ no plan tier found — set theme=health_food once the tenant has one');
  } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
  return b;
}

async function main() {
  console.log(`\nSeeding HEALTH_FOOD demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ vertical is ${business.vertical}, not ECOMMERCE.`);

  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) { if (sub.theme !== 'health_food') { await p.subscription.update({ where: { businessId: BID }, data: { theme: 'health_food' } }); console.log('  set subscription.theme = health_food'); } else console.log('  skip  theme (already health_food)'); }
  else console.warn('  ⚠ no subscription — cannot set theme=health_food.');

  const catBySlug = new Map();
  for (const c of CATEGORIES) {
    let row = await p.productCategory.findFirst({ where: { businessId: BID, slug: c.slug }, select: { id: true } });
    if (!row) { row = await p.productCategory.create({ data: { businessId: BID, name: c.name, slug: c.slug, sortOrder: c.sort, isPublished: true, imageUrl: img(`cat-${c.slug}`) }, select: { id: true } }); console.log(`  created category: ${c.name}`); }
    catBySlug.set(c.slug, row.id);
  }

  for (const [parentSlug, subs] of Object.entries(SUBCATS)) {
    const parentId = catBySlug.get(parentSlug);
    if (!parentId) continue;
    let s = 1;
    for (const [name, sslug] of subs) {
      let row = await p.productCategory.findFirst({ where: { businessId: BID, slug: sslug }, select: { id: true, parentId: true } });
      if (!row) { row = await p.productCategory.create({ data: { businessId: BID, name, slug: sslug, parentId, sortOrder: s, isPublished: true, imageUrl: img(`cat-${sslug}`) }, select: { id: true, parentId: true } }); console.log(`    created sub-category: ${parentSlug} › ${name}`); }
      else if (row.id !== parentId && row.parentId !== parentId) { await p.productCategory.update({ where: { id: row.id }, data: { parentId } }); }
      catBySlug.set(sslug, row.id);
      s++;
    }
  }

  let created = 0;
  for (let i = 0; i < PRODUCTS.length; i++) {
    const [name, catSlug, brand, price, mrp, sizes, flavours] = PRODUCTS[i];
    const slug = slugify(name);
    const leafId = catBySlug.get(NAME_SUBCAT[name]) || catBySlug.get(catSlug);
    const existing = await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true, categoryId: true } });
    if (existing) { if (existing.categoryId !== leafId) { await p.product.update({ where: { id: existing.id }, data: { categoryId: leafId } }); console.log(`  re-homed: ${name}`); } continue; }
    const priceMinor = price * 100;
    const compareMinor = mrp ? mrp * 100 : null;
    const images = [img(`${slug}-1`), img(`${slug}-2`)];
    const product = await p.product.create({
      data: {
        businessId: BID, categoryId: leafId, name, slug, brand,
        shortDescription: `${brand} · ${sizes[0]}`,
        description: `${name} by ${brand}. Clean, third-party-tested nutrition to support your wellness routine.`,
        priceMinor, comparePriceMinor: compareMinor, currency: 'INR',
        imageUrls: images, isPublished: true, isFeatured: i % 5 === 0, sortOrder: i, stockQty: null,
        createdAt: daysAgo(randInt(0, 50)),
      }, select: { id: true },
    });
    // Cartesian size × flavour (flavour carries a swatchHex). Single axis if no flavours.
    let sortOrder = 0; let first = true;
    const flavourList = flavours.length ? flavours : [[null, null]];
    for (const size of sizes) {
      for (const [flav, hex] of flavourList) {
        await p.productVariant.create({
          data: {
            productId: product.id, label: [size, flav].filter(Boolean).join(' · '),
            priceMinor, comparePriceMinor: compareMinor,
            stockQty: Math.random() < 0.1 ? 0 : randInt(5, 80),
            option1Name: 'Size', option1Value: size,
            option2Name: flav ? 'Flavour' : null, option2Value: flav, swatchHex: hex,
            sortOrder: sortOrder++, isDefault: first, isActive: true,
          },
        });
        first = false;
      }
    }
    created++;
    console.log(`  created product: ${name}`);
  }

  const all = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true } });
  let reviews = 0;
  for (const pr of all) {
    if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
    const n = randInt(2, 8);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.85 ? randInt(4, 5) : randInt(3, 4);
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(['Ananya', 'Rahul', 'Meera', 'Kabir', 'Sneha', 'Arjun', 'Tara', 'Dev']) + ' ' + rand(['S.', 'K.', 'M.', 'R.']), rating, title: rating >= 5 ? 'Excellent' : rating >= 4 ? 'Good quality' : 'Decent', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.85 } });
      reviews++;
    }
  }

  console.log(`\n✅ Health food demo seeded — ${created} products, ${reviews} reviews. Theme: health_food.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
