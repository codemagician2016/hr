#!/usr/bin/env node
// Footwear demo catalog + theme flip — to look-and-feel the bespoke `footwear`
// storefront theme (size guides, width/colour variants, fit notes, activity
// filters, care and exchange-friendly buying).
//
// Usage:
//   node scripts/seed-footwear-demo.js [slug]
//   node scripts/seed-footwear-demo.js [slug] --create
//
// Idempotent. Populates an existing ECOMMERCE business (default slug:
// footwear-demo) with footwear categories, size × colour/width variants and
// reviews; sets subscription.theme = 'footwear'. Images default to picsum
// placeholders.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'footwear-demo').toLowerCase();
const CREATE = args.includes('--create');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent('foot-' + seed)}/800/900`;

const CATEGORIES = [
  { name: 'Sneakers', slug: 'sneakers', sort: 1 },
  { name: 'Running', slug: 'running', sort: 2 },
  { name: 'Formal', slug: 'formal', sort: 3 },
  { name: 'Sandals', slug: 'sandals', sort: 4 },
  { name: 'Boots', slug: 'boots', sort: 5 },
  { name: 'Kids', slug: 'kids', sort: 6 },
];

const SUBCATS = {
  sneakers: [['Casual', 'sneak-casual'], ['Street', 'sneak-street'], ['Canvas', 'sneak-canvas']],
  running: [['Road', 'run-road'], ['Trail', 'run-trail'], ['Gym', 'run-gym']],
  formal: [['Oxfords', 'formal-oxfords'], ['Derby', 'formal-derby'], ['Loafers', 'formal-loafers']],
  sandals: [['Slides', 'sandal-slides'], ['Trek', 'sandal-trek'], ['Strappy', 'sandal-strappy']],
  boots: [['Chelsea', 'boot-chelsea'], ['Work', 'boot-work']],
  kids: [['Kids Sneakers', 'kids-sneakers'], ['Kids Boots', 'kids-boots']],
};
const NAME_SUBCAT = {
  'Court Classic Leather Sneaker': 'sneak-casual', 'Canvas Low-Top Sneaker': 'sneak-canvas', 'Chunky Retro Trainer': 'sneak-street',
  'RoadRun Cushioned Runner': 'run-road', 'Tempo Knit Running Shoe': 'run-gym', 'TrailGrip Outdoor Shoe': 'run-trail',
  'Oxford Cap-Toe Formal Shoe': 'formal-oxfords', 'Derby Comfort Formal Shoe': 'formal-derby', 'Penny Loafer': 'formal-loafers',
  'CloudStep Slide Sandal': 'sandal-slides', 'Adjustable Trek Sandal': 'sandal-trek', 'Leather Cross Strap Sandal': 'sandal-strappy',
  'Weatherproof Chelsea Boot': 'boot-chelsea', 'Workwear Lace-Up Boot': 'boot-work',
  'Kids Light-Up Sneaker': 'kids-sneakers', 'Kids Velcro Sport Shoe': 'kids-sneakers', 'Kids Rain Boot': 'kids-boots',
};

const REVIEW_BODIES = [
  'Fit was accurate and exchange guidance was clear.',
  'Comfortable all day and the material feels premium.',
  'True to size. The width option helped a lot.',
  'Looks sharp and arrived well packed.',
  'Good cushioning and grip for daily wear.',
  'Size chart matched my usual pair perfectly.',
];

const COLOURS = [
  { name: 'Black', hex: '#1F2933' },
  { name: 'White', hex: '#F7F4ED' },
  { name: 'Tan', hex: '#B9855B' },
  { name: 'Navy', hex: '#223A5E' },
  { name: 'Olive', hex: '#64745D' },
  { name: 'Rust', hex: '#B85C38' },
];
const SIZES = ['UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10', 'UK 11'];
const KIDS_SIZES = ['UK 10C', 'UK 11C', 'UK 12C', 'UK 13C', 'UK 1Y', 'UK 2Y'];
const WIDTHS = ['Regular', 'Wide'];

// name, category, brand, ₹price, ₹mrp, fit, material, activity
const PRODUCTS = [
  ['Court Classic Leather Sneaker', 'sneakers', 'Sole Studio', 2499, 3999, 'True to size', 'Full-grain leather upper', 'Everyday casual'],
  ['Canvas Low-Top Sneaker', 'sneakers', 'Sole Studio', 1499, 2499, 'Slightly roomy', 'Washed canvas upper', 'Daily wear'],
  ['Chunky Retro Trainer', 'sneakers', 'StrideLab', 3299, 4999, 'Size down if between sizes', 'Mixed mesh and suede', 'Streetwear'],
  ['RoadRun Cushioned Runner', 'running', 'StrideLab', 3999, 5999, 'True to size', 'Engineered mesh upper', 'Road running'],
  ['Tempo Knit Running Shoe', 'running', 'StrideLab', 2999, 4499, 'Sock-like fit', 'Breathable knit upper', 'Gym and short runs'],
  ['TrailGrip Outdoor Shoe', 'running', 'StrideLab', 4599, 6999, 'Snug heel lock', 'Ripstop mesh and rubber mudguard', 'Trail walking'],
  ['Oxford Cap-Toe Formal Shoe', 'formal', 'Brogue & Co', 3499, 5499, 'Regular fit', 'Polished leather upper', 'Office and events'],
  ['Derby Comfort Formal Shoe', 'formal', 'Brogue & Co', 2999, 4499, 'Wide-friendly', 'Soft leather upper', 'Workday comfort'],
  ['Penny Loafer', 'formal', 'Brogue & Co', 2799, 4299, 'Break-in expected', 'Milled leather upper', 'Smart casual'],
  ['CloudStep Slide Sandal', 'sandals', 'AeroWalk', 1299, 1999, 'Relaxed fit', 'EVA footbed', 'Home and errands'],
  ['Adjustable Trek Sandal', 'sandals', 'AeroWalk', 1899, 2999, 'Adjustable straps', 'Webbing straps and rubber sole', 'Travel'],
  ['Leather Cross Strap Sandal', 'sandals', 'AeroWalk', 2199, 3499, 'True to size', 'Leather straps', 'Weekend casual'],
  ['Weatherproof Chelsea Boot', 'boots', 'NorthEdge', 4499, 6999, 'Regular fit', 'Water-resistant leather', 'Rainy commute'],
  ['Workwear Lace-Up Boot', 'boots', 'NorthEdge', 4999, 7499, 'Roomy toe box', 'Oiled leather upper', 'Rugged daily wear'],
  ['Kids Light-Up Sneaker', 'kids', 'TinySteps', 1599, 2499, 'True to kids size', 'PU and mesh upper', 'School and play'],
  ['Kids Velcro Sport Shoe', 'kids', 'TinySteps', 1399, 2199, 'Easy-on fit', 'Breathable mesh upper', 'Playground'],
  ['Kids Rain Boot', 'kids', 'TinySteps', 1199, 1899, 'Room for socks', 'Waterproof rubber', 'Rainy days'],
];

async function ensureBusiness() {
  let business = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (business) return business;
  if (!CREATE) {
    console.error(`\nBusiness "${SLUG}" not found. Point at an existing ECOMMERCE tenant slug, or re-run with --create.\n`);
    process.exit(1);
  }
  business = await p.business.create({ data: { name: 'Sole Studio — Footwear Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
  console.log(`  created business: ${business.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) { await p.subscription.create({ data: { businessId: business.id, tierId: tier.id, theme: 'footwear' } }); console.log('  created subscription (theme=footwear)'); }
    else console.warn('  ⚠ no plan tier found — skipped subscription; set theme=footwear once the tenant has one');
  } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
  return business;
}

async function main() {
  console.log(`\nSeeding FOOTWEAR demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ business vertical is ${business.vertical}, not ECOMMERCE.`);

  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) { if (sub.theme !== 'footwear') { await p.subscription.update({ where: { businessId: BID }, data: { theme: 'footwear' } }); console.log('  set subscription.theme = footwear'); } else console.log('  skip  theme (already footwear)'); }
  else console.warn('  ⚠ no subscription — cannot set theme=footwear.');

  const catBySlug = new Map();
  for (const c of CATEGORIES) {
    let row = await p.productCategory.findFirst({ where: { businessId: BID, slug: c.slug }, select: { id: true } });
    if (!row) {
      row = await p.productCategory.create({ data: { businessId: BID, name: c.name, slug: c.slug, sortOrder: c.sort, isPublished: true, imageUrl: img(`cat-${c.slug}`) }, select: { id: true } });
      console.log(`  created category: ${c.name}`);
    }
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

  let createdProducts = 0;
  for (let i = 0; i < PRODUCTS.length; i++) {
    const [name, catSlug, brand, price, mrp, fit, material, activity] = PRODUCTS[i];
    const slug = slugify(name);
    const leafId = catBySlug.get(NAME_SUBCAT[name]) || catBySlug.get(catSlug);
    const existing = await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true, categoryId: true } });
    if (existing) { if (existing.categoryId !== leafId) { await p.product.update({ where: { id: existing.id }, data: { categoryId: leafId } }); console.log(`  re-homed: ${name}`); } continue; }

    const priceMinor = price * 100;
    const compareMinor = mrp * 100;
    const colours = [...COLOURS].sort(() => Math.random() - 0.5).slice(0, randInt(2, 3));
    const sizes = catSlug === 'kids' ? KIDS_SIZES : SIZES;
    const selectedSizes = sizes.slice(0, randInt(4, sizes.length));
    const specs = { fit, material, activity, care: ['Brush clean after wear', 'Dry away from direct heat', 'Use shoe trees for leather pairs'] };

    const product = await p.product.create({
      data: {
        businessId: BID, categoryId: leafId, name, slug, brand,
        shortDescription: `${fit} · ${material}`,
        description: `${name} by ${brand}. ${material}. Best for ${activity.toLowerCase()}. Fit note: ${fit}. Exchange-friendly size guidance included.`,
        priceMinor, comparePriceMinor: compareMinor, currency: 'INR',
        imageUrls: [img(`${slug}-1`), img(`${slug}-2`), img(`${slug}-3`)], specs,
        isPublished: true, isFeatured: i % 4 === 0, sortOrder: i, stockQty: null,
        createdAt: daysAgo(randInt(0, 60)),
      },
      select: { id: true },
    });

    let sortOrder = 0; let first = true;
    for (const colour of colours) {
      for (const size of selectedSizes) {
        const width = catSlug === 'kids' ? 'Regular' : rand(WIDTHS);
        await p.productVariant.create({
          data: {
            productId: product.id,
            label: `${size} / ${colour.name} / ${width}`,
            priceMinor, comparePriceMinor: compareMinor,
            stockQty: Math.random() < 0.14 ? 0 : randInt(1, 28),
            option1Name: 'Size', option1Value: size,
            option2Name: 'Colour / width', option2Value: `${colour.name} / ${width}`,
            swatchHex: colour.hex, imageUrl: img(`${slug}-${colour.name.toLowerCase()}`),
            sortOrder: sortOrder++, isDefault: first, isActive: true,
          },
        });
        first = false;
      }
    }
    createdProducts++;
    console.log(`  created pair: ${name} [${colours.length} colours × ${selectedSizes.length} sizes]`);
  }

  const allProducts = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true } });
  let createdReviews = 0;
  for (const pr of allProducts) {
    if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
    const n = randInt(2, 8);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.86 ? randInt(4, 5) : 3;
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(['Arjun', 'Riya', 'Kabir', 'Tara', 'Maya', 'Dev', 'Sana', 'Yash']) + ' ' + rand(['S.', 'K.', 'M.', 'P.', 'R.']), rating, title: rating >= 5 ? 'Great fit' : rating >= 4 ? 'Comfortable pair' : 'Good', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.88 } });
      createdReviews++;
    }
  }

  console.log(`\n✅ Footwear demo seeded — ${createdProducts} new products, ${createdReviews} reviews.`);
  console.log(`   Open the storefront for "${SLUG}" (theme: footwear) to view it.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
