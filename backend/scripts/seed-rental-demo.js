#!/usr/bin/env node
// Rental / hire demo catalog + theme flip — to look-and-feel the bespoke
// `rental` storefront theme (rental periods as variants, deposits, providers).
// The theme renders from standard product fields + option1 variants + brand
// (it does not read Product.specs).
//
// Usage:
//   node scripts/seed-rental-demo.js [slug]
//   node scripts/seed-rental-demo.js [slug] --create
//
// Idempotent. Sets subscription.theme = 'rental'. Variants are rental periods
// (Per day / weekend / week / month); the price is the hire rate for that
// period, and the refundable deposit is noted in the description.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'rental-demo').toLowerCase();
const CREATE = args.includes('--create');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent('rt-' + seed)}/700/700`;

const CATEGORIES = [
  { name: 'Party Rentals', slug: 'party-rentals', sort: 1 },
  { name: 'Equipment', slug: 'equipment', sort: 2 },
  { name: 'Furniture', slug: 'furniture', sort: 3 },
  { name: 'Tools', slug: 'tools', sort: 4 },
  { name: 'Cameras', slug: 'cameras', sort: 5 },
  { name: 'Baby Gear', slug: 'baby-gear', sort: 6 },
  { name: 'Outdoor', slug: 'outdoor', sort: 7 },
  { name: 'Event Kits', slug: 'event-kits', sort: 8 },
];

const SUBCATS = {
  'party-rentals': [['Tables & Chairs', 'party-tables'], ['Tents', 'party-tents'], ['Lighting', 'party-lighting']],
  equipment: [['Audio', 'equip-audio'], ['Visual', 'equip-visual'], ['Heating', 'equip-heating']],
  furniture: [['Seating', 'furn-seating'], ['Tables', 'furn-tables'], ['Desks', 'furn-desks']],
  tools: [['Power Tools', 'tools-power'], ['Cleaning', 'tools-cleaning']],
  cameras: [['Bodies', 'cam-bodies'], ['Lenses', 'cam-lenses'], ['Accessories', 'cam-accessories']],
  'baby-gear': [['Strollers', 'baby-strollers'], ['Car Seats', 'baby-carseats'], ['Travel', 'baby-travel']],
  outdoor: [['Camping', 'outdoor-camping'], ['Water', 'outdoor-water']],
};
const NAME_SUBCAT = {
  'Round Banquet Table': 'party-tables', 'Chiavari Chair (set of 10)': 'party-tables', 'Marquee Tent 3×6m': 'party-tents', 'LED Uplighter (set of 8)': 'party-lighting',
  'PA Speaker System': 'equip-audio', 'Wireless Mic Pair': 'equip-audio', 'Projector 4K': 'equip-visual', 'Patio Heater': 'equip-heating',
  'Sofa — 3 Seater': 'furn-seating', 'Coffee Table': 'furn-tables', 'Office Desk': 'furn-desks',
  'Cordless Drill Kit': 'tools-power', 'Pressure Washer': 'tools-cleaning', 'Tile Cutter': 'tools-power',
  'Mirrorless Camera Body': 'cam-bodies', '24-70mm f/2.8 Lens': 'cam-lenses', 'Gimbal Stabiliser': 'cam-accessories',
  'Travel Stroller': 'baby-strollers', 'Convertible Car Seat': 'baby-carseats', 'Travel Cot': 'baby-travel',
  '4-Person Tent': 'outdoor-camping', 'Camping Stove Set': 'outdoor-camping', 'Kayak (single)': 'outdoor-water',
};

// period → [label, multiplier on the per-day rate]
const PERIODS = [['Per day', 1], ['Per weekend', 1.8], ['Per week', 4.5], ['Per month', 14]];

const REVIEW_BODIES = [
  'Spotless gear, smooth pickup and return.',
  'Saved us buying outright — perfect for a one-off event.',
  'Great condition and the deposit was refunded fast.',
  'Booking and availability check were super easy.',
  'Delivered on time and worked flawlessly.',
  'Friendly provider, well-maintained equipment.',
];

// name, category, provider(brand), ₹perDay, ₹deposit
const PRODUCTS = [
  ['Round Banquet Table', 'party-rentals', 'EventHire Co.', 199, 1000],
  ['Chiavari Chair (set of 10)', 'party-rentals', 'EventHire Co.', 499, 2000],
  ['Marquee Tent 3×6m', 'party-rentals', 'EventHire Co.', 1499, 5000],
  ['LED Uplighter (set of 8)', 'party-rentals', 'GlowEvents', 899, 3000],
  ['PA Speaker System', 'equipment', 'SoundWorks', 999, 5000],
  ['Wireless Mic Pair', 'equipment', 'SoundWorks', 399, 2000],
  ['Projector 4K', 'equipment', 'SoundWorks', 799, 6000],
  ['Patio Heater', 'equipment', 'GlowEvents', 349, 1500],
  ['Sofa — 3 Seater', 'furniture', 'StagePad', 599, 4000],
  ['Coffee Table', 'furniture', 'StagePad', 199, 1000],
  ['Office Desk', 'furniture', 'StagePad', 299, 1500],
  ['Cordless Drill Kit', 'tools', 'ToolShed', 249, 1500],
  ['Pressure Washer', 'tools', 'ToolShed', 399, 3000],
  ['Tile Cutter', 'tools', 'ToolShed', 299, 2000],
  ['Mirrorless Camera Body', 'cameras', 'LensLoop', 899, 25000],
  ['24-70mm f/2.8 Lens', 'cameras', 'LensLoop', 699, 20000],
  ['Gimbal Stabiliser', 'cameras', 'LensLoop', 499, 8000],
  ['Travel Stroller', 'baby-gear', 'TinyTrips', 199, 2000],
  ['Convertible Car Seat', 'baby-gear', 'TinyTrips', 249, 3000],
  ['Travel Cot', 'baby-gear', 'TinyTrips', 179, 1500],
  ['4-Person Tent', 'outdoor', 'TrailGear', 349, 2000],
  ['Camping Stove Set', 'outdoor', 'TrailGear', 199, 1000],
  ['Kayak (single)', 'outdoor', 'TrailGear', 599, 6000],
  ['Birthday Party Kit', 'event-kits', 'EventHire Co.', 1299, 4000],
  ['Wedding Décor Kit', 'event-kits', 'GlowEvents', 2499, 8000],
];

async function ensureBusiness() {
  let b = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (b) return b;
  if (!CREATE) { console.error(`\nBusiness "${SLUG}" not found. Use an existing ECOMMERCE slug or re-run with --create.\n`); process.exit(1); }
  b = await p.business.create({ data: { name: 'RentEase — Rental Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
  console.log(`  created business: ${b.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) { await p.subscription.create({ data: { businessId: b.id, tierId: tier.id, theme: 'rental' } }); console.log('  created subscription (theme=rental)'); }
    else console.warn('  ⚠ no plan tier found — set theme=rental once the tenant has one');
  } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
  return b;
}

async function main() {
  console.log(`\nSeeding RENTAL demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ vertical is ${business.vertical}, not ECOMMERCE.`);

  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) { if (sub.theme !== 'rental') { await p.subscription.update({ where: { businessId: BID }, data: { theme: 'rental' } }); console.log('  set subscription.theme = rental'); } else console.log('  skip  theme (already rental)'); }
  else console.warn('  ⚠ no subscription — cannot set theme=rental.');

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
    const [name, catSlug, provider, perDay, deposit] = PRODUCTS[i];
    const slug = slugify(name);
    const leafId = catBySlug.get(NAME_SUBCAT[name]) || catBySlug.get(catSlug);
    const existing = await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true, categoryId: true } });
    if (existing) { if (existing.categoryId !== leafId) { await p.product.update({ where: { id: existing.id }, data: { categoryId: leafId } }); console.log(`  re-homed: ${name}`); } continue; }
    const dayMinor = perDay * 100;
    const images = [img(`${slug}-1`), img(`${slug}-2`)];
    const product = await p.product.create({
      data: {
        businessId: BID, categoryId: leafId, name, slug, brand: provider,
        shortDescription: `From ₹${perDay}/day · ${provider}`,
        description: `${name} available to hire from ${provider}. Refundable security deposit ₹${deposit.toLocaleString('en-IN')}, returned after a return inspection. Choose your rental period at checkout; pickup and return slots are arranged on booking.`,
        priceMinor: dayMinor, comparePriceMinor: null, currency: 'INR',
        imageUrls: images, isPublished: true, isFeatured: i % 5 === 0, sortOrder: i, stockQty: null,
        createdAt: daysAgo(randInt(0, 40)),
      }, select: { id: true },
    });
    // Variants = rental periods; price = per-day rate × period multiplier.
    let sortOrder = 0; let first = true;
    for (const [label, mult] of PERIODS) {
      await p.productVariant.create({
        data: {
          productId: product.id, label,
          priceMinor: Math.round(dayMinor * mult), comparePriceMinor: null,
          stockQty: Math.random() < 0.12 ? 0 : randInt(1, 8),
          option1Name: 'Rental period', option1Value: label,
          sortOrder: sortOrder++, isDefault: first, isActive: true,
        },
      });
      first = false;
    }
    created++;
    console.log(`  created rental: ${name} — ${provider}`);
  }

  const all = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true } });
  let reviews = 0;
  for (const pr of all) {
    if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
    const n = randInt(2, 7);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.85 ? randInt(4, 5) : randInt(3, 4);
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(['Priya', 'Jack', 'Aisha', 'Tom', 'Neha', 'Liam', 'Sara', 'Karan']) + ' ' + rand(['B.', 'D.', 'K.', 'M.', 'R.']), rating, title: rating >= 5 ? 'Perfect for our event' : rating >= 4 ? 'Smooth hire' : 'Good', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.85 } });
      reviews++;
    }
  }

  console.log(`\n✅ Rental demo seeded — ${created} items, ${reviews} reviews. Theme: rental.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
