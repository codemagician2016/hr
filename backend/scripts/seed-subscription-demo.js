#!/usr/bin/env node
// Subscription / recurring-commerce demo catalog + theme flip — to look-and-feel
// the bespoke `subscription` storefront theme (one-time vs subscribe & save,
// delivery cadences, manage/skip/cancel framing).
//
// Usage:
//   node scripts/seed-subscription-demo.js [slug]
//   node scripts/seed-subscription-demo.js [slug] --create
//
// Idempotent. Populates an existing ECOMMERCE business (default slug:
// subscription-demo) with categories and products whose VARIANTS are delivery
// plans (option1Value = "One-time" | "Every 2 weeks" | "Monthly" | ...). The
// One-time variant holds the full price; recurring variants are genuinely
// cheaper (real subscribe & save). Sets subscription.theme = 'subscription'.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'subscription-demo').toLowerCase();
const CREATE = args.includes('--create');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent('sub-' + seed)}/700/700`;

const CATEGORIES = [
  { name: 'Coffee & Tea', slug: 'coffee-tea', sort: 1 },
  { name: 'Snacks', slug: 'snacks', sort: 2 },
  { name: 'Vitamins & Wellness', slug: 'vitamins-wellness', sort: 3 },
  { name: 'Home Essentials', slug: 'home-essentials', sort: 4 },
  { name: 'Pet', slug: 'pet', sort: 5 },
  { name: 'Personal Care', slug: 'personal-care', sort: 6 },
];

const SUBCATS = { 'coffee-tea':[['Coffee','sb-coffee'],['Tea','sb-tea']], snacks:[['Sweet','sb-sweet'],['Savoury','sb-savoury']], 'vitamins-wellness':[['Daily','sb-daily'],['Sport','sb-sport']], 'home-essentials':[['Cleaning','sb-cleaning'],['Paper','sb-paper']], pet:[['Dog','sb-dog'],['Cat','sb-cat']], 'personal-care':[['Bath','sb-bath'],['Oral','sb-oral']] };
const NAME_SUBCAT = { 'Signature Blend Coffee 500g':'sb-coffee','Single-Origin Espresso 250g':'sb-coffee','Loose-Leaf Green Tea 100g':'sb-tea','Protein Granola 1kg':'sb-savoury','Mixed Nut Butter Trio':'sb-savoury','Dark Chocolate Squares Box':'sb-sweet','Daily Multivitamin (30-day)':'sb-daily','Omega-3 Fish Oil (60ct)':'sb-daily','Magnesium Sleep Blend':'sb-daily','Plant Protein Powder 1kg':'sb-sport','Eco Dishwasher Tablets (60ct)':'sb-cleaning','Laundry Detergent Sheets':'sb-cleaning','Bamboo Paper Towels (6-pack)':'sb-paper','Grain-Free Dog Food 3kg':'sb-dog','Cat Litter Refill 10L':'sb-cat','Dental Dog Chews (30ct)':'sb-dog','Natural Shampoo Bar':'sb-bath','Refillable Deodorant':'sb-bath','Bamboo Toothbrush (4-pack)':'sb-oral','Vitamin C Serum 30ml':'sb-bath' };

const REVIEW_BODIES = [
  'Love that it just shows up when I need it. Set and forget.',
  'The subscribe & save discount makes it a no-brainer.',
  'Skipped a month easily when I was away — zero hassle.',
  'Quality is consistent every single delivery.',
  'Switched frequency in seconds from my account. Great UX.',
  'Cancelled and resubscribed with no friction. Recommend.',
];

// name, category, brand, ₹oneTime, benefits[], included[],
// cadences[[label, ₹price]] (must include a "One-time" at full price)
const PRODUCTS = [
  ['Signature Blend Coffee 500g', 'coffee-tea', 'Daybreak', 749, ['Freshly roasted to order', 'Whole bean or ground', 'Ethically sourced'], ['1× 500g bag', 'Roast & brew guide'],
    [['One-time', 749], ['Every 2 weeks', 599], ['Monthly', 649]]],
  ['Single-Origin Espresso 250g', 'coffee-tea', 'Daybreak', 549, ['Bright, balanced shots', 'Roasted weekly', 'Traceable single farm'], ['1× 250g bag'],
    [['One-time', 549], ['Every 2 weeks', 449], ['Monthly', 489]]],
  ['Loose-Leaf Green Tea 100g', 'coffee-tea', 'LeafCo', 399, ['Hand-picked leaves', 'High in antioxidants', 'Resealable pouch'], ['1× 100g tin'],
    [['One-time', 399], ['Monthly', 329]]],
  ['Protein Granola 1kg', 'snacks', 'CrunchLab', 599, ['18g protein per serving', 'No refined sugar', 'Baked in small batches'], ['1× 1kg pouch'],
    [['One-time', 599], ['Every 2 weeks', 479], ['Monthly', 519]]],
  ['Mixed Nut Butter Trio', 'snacks', 'CrunchLab', 699, ['Almond, cashew & peanut', 'Single-ingredient', 'No palm oil'], ['3× 200g jars'],
    [['One-time', 699], ['Monthly', 599]]],
  ['Dark Chocolate Squares Box', 'snacks', 'CocoaWorks', 499, ['70% cacao', 'Individually wrapped', 'Fairtrade'], ['Box of 24'],
    [['One-time', 499], ['Every 2 weeks', 399], ['Monthly', 429]]],
  ['Daily Multivitamin (30-day)', 'vitamins-wellness', 'VitalRoot', 899, ['Complete A–Z formula', 'Once-a-day capsule', 'Third-party tested'], ['30 capsules'],
    [['One-time', 899], ['Monthly', 719], ['Every 2 months', 769]]],
  ['Omega-3 Fish Oil (60ct)', 'vitamins-wellness', 'VitalRoot', 749, ['High EPA/DHA', 'No fishy aftertaste', 'Sustainably sourced'], ['60 softgels'],
    [['One-time', 749], ['Monthly', 599]]],
  ['Magnesium Sleep Blend', 'vitamins-wellness', 'VitalRoot', 649, ['Calming glycinate form', 'Supports rest', 'Vegan capsules'], ['60 capsules'],
    [['One-time', 649], ['Monthly', 519]]],
  ['Plant Protein Powder 1kg', 'vitamins-wellness', 'VitalRoot', 1299, ['24g protein/scoop', 'Pea + brown rice', 'Naturally sweetened'], ['1× 1kg tub', 'Scoop included'],
    [['One-time', 1299], ['Monthly', 1099], ['Every 2 months', 1149]]],
  ['Eco Dishwasher Tablets (60ct)', 'home-essentials', 'PureHome', 549, ['Plastic-free wrap', 'Plant-based formula', 'Sparkling clean'], ['60 tablets'],
    [['One-time', 549], ['Monthly', 449]]],
  ['Laundry Detergent Sheets', 'home-essentials', 'PureHome', 499, ['64 washes', 'Zero-plastic', 'Lightweight & mess-free'], ['64 sheets'],
    [['One-time', 499], ['Every 2 weeks', 399], ['Monthly', 429]]],
  ['Bamboo Paper Towels (6-pack)', 'home-essentials', 'PureHome', 399, ['Reusable & washable', 'Tree-free bamboo', 'Super absorbent'], ['6 rolls'],
    [['One-time', 399], ['Monthly', 339]]],
  ['Grain-Free Dog Food 3kg', 'pet', 'PawFuel', 1499, ['Real meat first', 'Grain-free recipe', 'Vet-formulated'], ['1× 3kg bag'],
    [['One-time', 1499], ['Every 2 weeks', 1249], ['Monthly', 1349]]],
  ['Cat Litter Refill 10L', 'pet', 'PawFuel', 699, ['Clumping & low-dust', 'Odour control', 'Natural minerals'], ['1× 10L bag'],
    [['One-time', 699], ['Monthly', 579]]],
  ['Dental Dog Chews (30ct)', 'pet', 'PawFuel', 599, ['Reduces plaque', 'Vet-recommended', 'Grain-free'], ['30 chews'],
    [['One-time', 599], ['Every 2 weeks', 489], ['Monthly', 519]]],
  ['Natural Shampoo Bar', 'personal-care', 'Everyday Co', 349, ['Sulfate-free', 'Lasts ~60 washes', 'Plastic-free'], ['1× 100g bar'],
    [['One-time', 349], ['Monthly', 289]]],
  ['Refillable Deodorant', 'personal-care', 'Everyday Co', 449, ['Aluminium-free', 'Refill pods', '24-hour protection'], ['Case + 1 refill'],
    [['One-time', 449], ['Monthly', 369], ['Every 2 months', 399]]],
  ['Bamboo Toothbrush (4-pack)', 'personal-care', 'Everyday Co', 299, ['Biodegradable handle', 'Soft BPA-free bristles', 'Family pack'], ['4 brushes'],
    [['One-time', 299], ['Every 3 months', 249]]],
  ['Vitamin C Serum 30ml', 'personal-care', 'GlowLab', 899, ['Brightening 15% vit C', 'Lightweight, fast-absorb', 'Cruelty-free'], ['1× 30ml bottle'],
    [['One-time', 899], ['Monthly', 749], ['Every 2 months', 799]]],
];

async function ensureBusiness() {
  let business = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (business) return business;
  if (!CREATE) { console.error(`\nBusiness "${SLUG}" not found. Point at an existing ECOMMERCE tenant slug, or re-run with --create.\n`); process.exit(1); }
  business = await p.business.create({ data: { name: 'Renew — Subscription Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
  console.log(`  created business: ${business.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) { await p.subscription.create({ data: { businessId: business.id, tierId: tier.id, theme: 'subscription' } }); console.log('  created subscription (theme=subscription)'); }
    else console.warn('  ⚠ no plan tier found — skipped subscription; set theme=subscription once the tenant has one');
  } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
  return business;
}

async function main() {
  console.log(`\nSeeding SUBSCRIPTION demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ business vertical is ${business.vertical}, not ECOMMERCE.`);

  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) { if (sub.theme !== 'subscription') { await p.subscription.update({ where: { businessId: BID }, data: { theme: 'subscription' } }); console.log('  set subscription.theme = subscription'); } else console.log('  skip  theme (already subscription)'); }
  else console.warn('  ⚠ no subscription — cannot set theme=subscription.');

  const catBySlug = new Map();
  for (const c of CATEGORIES) {
    let row = await p.productCategory.findFirst({ where: { businessId: BID, slug: c.slug }, select: { id: true } });
    if (!row) { row = await p.productCategory.create({ data: { businessId: BID, name: c.name, slug: c.slug, sortOrder: c.sort, isPublished: true, imageUrl: img(`cat-${c.slug}`) }, select: { id: true } }); console.log(`  created category: ${c.name}`); }
    catBySlug.set(c.slug, row.id);
  }

  let createdProducts = 0;
  const subsByParent = {};
  for (const [parentSlug, subs] of Object.entries(SUBCATS)) {
    const parentId = catBySlug.get(parentSlug);
    if (!parentId) continue;
    const leaves = []; let s2 = 1;
    for (const [nm, sslug] of subs) {
      let row = await p.productCategory.findFirst({ where: { businessId: BID, slug: sslug }, select: { id: true, parentId: true } });
      if (!row) { row = await p.productCategory.create({ data: { businessId: BID, name: nm, slug: sslug, parentId, sortOrder: s2, isPublished: true, imageUrl: img('cat-' + sslug) }, select: { id: true, parentId: true } }); console.log('    created sub-category: ' + parentSlug + ' > ' + nm); }
      else if (row.id !== parentId && row.parentId !== parentId) { await p.productCategory.update({ where: { id: row.id }, data: { parentId } }); }
      catBySlug.set(sslug, row.id); leaves.push(row.id); s2++;
    }
    subsByParent[parentSlug] = leaves;
  }
  const rr = {};

  for (let i = 0; i < PRODUCTS.length; i++) {
    const [name, catSlug, brand, oneTime, benefits, included, cadences] = PRODUCTS[i];
    const slug = slugify(name);
    const _leaves = subsByParent[catSlug] || []; let leafId = catBySlug.get(catSlug); const _m = NAME_SUBCAT[name]; if (_m && catBySlug.get(_m)) { leafId = catBySlug.get(_m); } else if (_leaves.length) { const _n = (rr[catSlug] = (rr[catSlug] ?? -1) + 1); leafId = _leaves[_n % _leaves.length]; } const _ex = await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true, categoryId: true } }); if (_ex) { if (_ex.categoryId !== leafId) { await p.product.update({ where: { id: _ex.id }, data: { categoryId: leafId } }); } continue; }

    // Headline price = cheapest recurring plan (subscribe price); compare-at = one-time.
    const prices = cadences.map(([, pr]) => pr);
    const minPrice = Math.min(...prices);
    const priceMinor = minPrice * 100;
    const compareMinor = oneTime * 100;
    const specs = { benefits, included };
    const images = [img(`${slug}-1`), img(`${slug}-2`)];

    const product = await p.product.create({
      data: {
        businessId: BID, categoryId: leafId, name, slug, brand,
        shortDescription: benefits.slice(0, 2).join(' · '),
        description: `${name} by ${brand}. ${benefits.join('. ')}. Subscribe & save vs one-time — change frequency, skip, pause or cancel anytime.`,
        priceMinor, comparePriceMinor: compareMinor, currency: 'INR',
        imageUrls: images, specs,
        isPublished: true, isFeatured: i % 4 === 0, sortOrder: i, stockQty: null,
        createdAt: daysAgo(randInt(0, 50)),
      },
      select: { id: true },
    });

    // Variants = delivery plans. "One-time" is the default; recurring plans are
    // the real subscribe-and-save options (lower priceMinor).
    let sortOrder = 0;
    for (const [label, pr] of cadences) {
      await p.productVariant.create({
        data: {
          productId: product.id, label,
          priceMinor: pr * 100, comparePriceMinor: label === 'One-time' ? null : oneTime * 100,
          stockQty: Math.random() < 0.08 ? 0 : randInt(20, 300),
          option1Name: 'Plan', option1Value: label,
          sortOrder: sortOrder++, isDefault: label === 'One-time', isActive: true,
        },
      });
    }
    createdProducts++;
    console.log(`  created product: ${name} [${cadences.length} plans]`);
  }

  const allProducts = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true } });
  let createdReviews = 0;
  for (const pr of allProducts) {
    if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
    const n = randInt(2, 8);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.85 ? randInt(4, 5) : randInt(3, 4);
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(['Aisha', 'Rohan', 'Maya', 'Dev', 'Sara', 'Karan', 'Nina', 'Arjun', 'Lily', 'Sam']) + ' ' + rand(['B.', 'K.', 'M.', 'R.', 'S.']), rating, title: rating >= 5 ? 'Set and forget' : rating >= 4 ? 'Really convenient' : 'Good', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.85 } });
      createdReviews++;
    }
  }

  console.log(`\n✅ Subscription demo seeded — ${createdProducts} new products, ${createdReviews} reviews.`);
  console.log(`   Open the storefront for "${SLUG}" (theme: subscription) to view it.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
