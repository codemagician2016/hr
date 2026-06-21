#!/usr/bin/env node
// Baby & nursery demo catalog + theme flip — to look-and-feel the bespoke
// `baby_nursery` storefront theme (age-stage filters, size guidance, safety
// cues, registry/gift framing, nursery bundles).
//
// Usage:
//   node scripts/seed-baby-nursery-demo.js [slug]
//   node scripts/seed-baby-nursery-demo.js [slug] --create
//
// Idempotent. Populates an existing ECOMMERCE business (default slug:
// baby-nursery-demo) with age/stage categories, size/material variants and
// reviews; sets subscription.theme = 'baby_nursery'. Images default to picsum
// placeholders.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'baby-nursery-demo').toLowerCase();
const CREATE = args.includes('--create');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent('baby-' + seed)}/700/700`;

const CATEGORIES = [
  { name: 'Newborn Essentials', slug: 'newborn-essentials', sort: 1 },
  { name: 'Diapers & Wipes', slug: 'diapers-wipes', sort: 2 },
  { name: 'Feeding', slug: 'feeding', sort: 3 },
  { name: 'Nursery Furniture', slug: 'nursery-furniture', sort: 4 },
  { name: 'Bath & Care', slug: 'bath-care', sort: 5 },
  { name: 'Toys & Gifts', slug: 'toys-gifts', sort: 6 },
];

const SUBCATS = {
  'newborn-essentials': [['Bodysuits', 'nb-bodysuits'], ['Swaddles', 'nb-swaddles'], ['Sleep', 'nb-sleep']],
  'diapers-wipes': [['Diapers', 'diapers'], ['Wipes', 'wipes'], ['Organisers', 'diaper-organisers']],
  feeding: [['Bottles', 'feed-bottles'], ['Bibs', 'feed-bibs'], ['Highchair', 'feed-highchair']],
  'nursery-furniture': [['Cots', 'furniture-cots'], ['Dressers', 'furniture-dressers'], ['Lighting', 'furniture-lighting']],
  'bath-care': [['Wash', 'bath-wash'], ['Towels', 'bath-towels'], ['Grooming', 'bath-grooming']],
  'toys-gifts': [['Toys', 'toys-play'], ['Gift Sets', 'toys-gifts-sets']],
};
const NAME_SUBCAT = {
  'Organic Cotton Newborn Bodysuit Set': 'nb-bodysuits', 'Muslin Swaddle Pack': 'nb-swaddles', 'Baby Sleep Sack': 'nb-sleep',
  'Sensitive Skin Diapers': 'diapers', 'Plant-Based Baby Wipes': 'wipes', 'Diaper Change Caddy': 'diaper-organisers',
  'Anti-Colic Feeding Bottle Set': 'feed-bottles', 'Silicone Bib Trio': 'feed-bibs', 'High Chair Cushion': 'feed-highchair',
  'Convertible Cot Bed': 'furniture-cots', 'Nursery Dresser with Changer': 'furniture-dressers', 'Cloud Night Light': 'furniture-lighting',
  'Gentle Baby Wash': 'bath-wash', 'Hooded Bath Towel': 'bath-towels', 'Baby Grooming Kit': 'bath-grooming',
  'Wooden Stacking Rings': 'toys-play', 'Soft Sensory Book': 'toys-play', 'Welcome Baby Gift Hamper': 'toys-gifts-sets',
};

const REVIEW_BODIES = [
  'Soft materials and very parent-friendly packaging.',
  'Exactly what we needed for our newborn setup.',
  'The size guidance was helpful and accurate.',
  'Beautiful gift-ready presentation.',
  'Good quality and gentle on sensitive skin.',
  'The bundle made shopping for essentials much easier.',
];

// name, category, brand, ₹price, ₹mrp|null, ageStage, materials[], notes[], variants[]
const PRODUCTS = [
  ['Organic Cotton Newborn Bodysuit Set', 'newborn-essentials', 'Little Nest', 899, 1299, '0-3 months', ['GOTS cotton', 'Nickel-free snaps'], ['Machine washable', 'Envelope neckline'], [['0-3M / Cloud', 0, '#F5F3EF'], ['3-6M / Sage', 50, '#B8CBB8'], ['6-9M / Blush', 80, '#E7B7C1']]],
  ['Muslin Swaddle Pack', 'newborn-essentials', 'Little Nest', 749, 999, 'Newborn', ['4-layer cotton muslin', 'Breathable weave'], ['Pre-washed softness', 'Gift-ready'], [['Pack of 2', 0, '#F0D6C8'], ['Pack of 4', 650, '#D9E2E7']]],
  ['Baby Sleep Sack', 'newborn-essentials', 'DreamPod', 1299, 1699, '0-12 months', ['Organic cotton outer', 'Light quilting'], ['TOG 1.0', 'No loose blankets'], [['0-6M / Ivory', 0, '#EFE7D8'], ['6-12M / Sky', 100, '#B7CEDD']]],
  ['Sensitive Skin Diapers', 'diapers-wipes', 'PureBaby', 499, 599, 'Newborn to toddler', ['Dermatologically tested', 'Wetness indicator'], ['12-hour absorbency', 'Fragrance-free'], [['NB / 24 pcs', 0, null], ['S / 42 pcs', 280, null], ['M / 38 pcs', 300, null], ['L / 34 pcs', 320, null]]],
  ['Plant-Based Baby Wipes', 'diapers-wipes', 'PureBaby', 299, 399, 'All ages', ['99% water', 'Compostable cloth'], ['Unscented', 'Travel lid pack'], [['Single pack', 0, null], ['Pack of 3', 520, null], ['Pack of 6', 1050, null]]],
  ['Diaper Change Caddy', 'diapers-wipes', 'NestMate', 999, 1399, 'All ages', ['Felt organizer', 'Removable dividers'], ['Fits creams and wipes', 'Portable handle'], [['Grey', 0, '#9CA3AF'], ['Oat', 0, '#D9CBB8']]],
  ['Anti-Colic Feeding Bottle Set', 'feeding', 'Nourish', 1199, 1599, '0+ months', ['BPA-free PPSU', 'Anti-colic valve'], ['Wide-neck design', 'Sterilizer safe'], [['150 ml pair', 0, null], ['250 ml pair', 350, null]]],
  ['Silicone Bib Trio', 'feeding', 'Nourish', 649, 899, '6+ months', ['Food-grade silicone', 'Adjustable neck'], ['Dishwasher safe', 'Deep crumb pocket'], [['Sage / Sand / Blush', 0, '#B8CBB8'], ['Blue / Oat / Grey', 0, '#AFC3D0']]],
  ['High Chair Cushion', 'feeding', 'NestMate', 1499, 1999, '6+ months', ['Water-resistant cotton', 'Padded support'], ['Wipe-clean', 'Universal straps'], [['Cream meadow', 0, '#EFE7D8'], ['Ocean dots', 150, '#9DBBD0']]],
  ['Convertible Cot Bed', 'nursery-furniture', 'NestMate', 15999, 19999, 'Newborn to 4 years', ['Solid beech wood', 'Non-toxic finish'], ['Converts to toddler bed', '3 mattress heights'], [['Natural wood', 0, '#C8A978'], ['White', 500, '#F8F8F2']]],
  ['Nursery Dresser with Changer', 'nursery-furniture', 'NestMate', 12999, 16999, 'All ages', ['Engineered wood', 'Soft-close runners'], ['Removable changing topper', 'Anti-tip kit'], [['White oak', 0, '#D7C7AC'], ['Warm grey', 500, '#A9A7A0']]],
  ['Cloud Night Light', 'nursery-furniture', 'DreamPod', 1299, 1599, 'All ages', ['Soft silicone', 'Rechargeable battery'], ['Tap control', 'Warm dimmable glow'], [['Cloud white', 0, '#F4F3EE'], ['Blush', 50, '#E8B8C2']]],
  ['Gentle Baby Wash', 'bath-care', 'PureBaby', 399, 499, 'Newborn+', ['Tear-free formula', 'pH balanced'], ['Dermatologist tested', 'No sulfates'], [['250 ml', 0, null], ['500 ml', 300, null]]],
  ['Hooded Bath Towel', 'bath-care', 'Little Nest', 799, 1099, '0-24 months', ['Bamboo cotton blend', 'Soft hood'], ['Quick dry', 'Gift-friendly'], [['Bear / Cream', 0, '#F3E6D3'], ['Duck / Yellow', 100, '#F2D46B']]],
  ['Baby Grooming Kit', 'bath-care', 'PureBaby', 699, 899, 'All ages', ['Rounded scissors', 'Soft brush'], ['Travel case', 'Parent checklist'], [['6-piece kit', 0, null], ['10-piece kit', 350, null]]],
  ['Wooden Stacking Rings', 'toys-gifts', 'PlaySprout', 599, 799, '12+ months', ['FSC wood', 'Water-based paint'], ['Motor skills', 'Safety tested'], [['Pastel', 0, '#D7AFC0'], ['Primary', 50, '#D9A441']]],
  ['Soft Sensory Book', 'toys-gifts', 'PlaySprout', 499, 699, '0+ months', ['Crinkle pages', 'Textured tabs'], ['High-contrast panels', 'Clip-on loop'], [['Animals', 0, null], ['Ocean', 0, null]]],
  ['Welcome Baby Gift Hamper', 'toys-gifts', 'Little Nest', 2499, 3299, 'Newborn gift', ['Cotton bodysuit', 'Swaddle', 'Soft toy'], ['Gift box included', 'Message card supported'], [['Neutral', 0, '#E8DDCE'], ['Blush', 150, '#E8B8C2'], ['Sage', 150, '#B8CBB8']]],
];

async function ensureBusiness() {
  let business = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (business) return business;
  if (!CREATE) {
    console.error(`\nBusiness "${SLUG}" not found. Point at an existing ECOMMERCE tenant slug, or re-run with --create.\n`);
    process.exit(1);
  }
  business = await p.business.create({ data: { name: 'Little Nest — Baby Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
  console.log(`  created business: ${business.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) { await p.subscription.create({ data: { businessId: business.id, tierId: tier.id, theme: 'baby_nursery' } }); console.log('  created subscription (theme=baby_nursery)'); }
    else console.warn('  ⚠ no plan tier found — skipped subscription; set theme=baby_nursery once the tenant has one');
  } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
  return business;
}

async function main() {
  console.log(`\nSeeding BABY & NURSERY demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ business vertical is ${business.vertical}, not ECOMMERCE.`);

  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) { if (sub.theme !== 'baby_nursery') { await p.subscription.update({ where: { businessId: BID }, data: { theme: 'baby_nursery' } }); console.log('  set subscription.theme = baby_nursery'); } else console.log('  skip  theme (already baby_nursery)'); }
  else console.warn('  ⚠ no subscription — cannot set theme=baby_nursery.');

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
    const [name, catSlug, brand, price, mrp, ageStage, materials, notes, variants] = PRODUCTS[i];
    const slug = slugify(name);
    const leafId = catBySlug.get(NAME_SUBCAT[name]) || catBySlug.get(catSlug);
    const existing = await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true, categoryId: true } });
    if (existing) { if (existing.categoryId !== leafId) { await p.product.update({ where: { id: existing.id }, data: { categoryId: leafId } }); console.log(`  re-homed: ${name}`); } continue; }

    const priceMinor = price * 100;
    const compareMinor = mrp ? mrp * 100 : null;
    const specs = { ageStage, materials, safety: notes };
    const product = await p.product.create({
      data: {
        businessId: BID, categoryId: leafId, name, slug, brand,
        shortDescription: `${ageStage} · ${materials[0]}`,
        description: `${name} by ${brand}. ${materials.join('. ')}. ${notes.join('. ')}. Built for parent-friendly nursery shopping with clear age-stage and safety notes.`,
        priceMinor, comparePriceMinor: compareMinor, currency: 'INR',
        imageUrls: [img(`${slug}-1`), img(`${slug}-2`)], specs,
        isPublished: true, isFeatured: i % 4 === 0, sortOrder: i, stockQty: null,
        createdAt: daysAgo(randInt(0, 45)),
      },
      select: { id: true },
    });

    let sortOrder = 0; let first = true;
    for (const [label, addRupees, hex] of variants) {
      await p.productVariant.create({
        data: {
          productId: product.id, label,
          priceMinor: priceMinor + addRupees * 100, comparePriceMinor: compareMinor ? compareMinor + addRupees * 100 : null,
          stockQty: Math.random() < 0.1 ? 0 : randInt(3, 45),
          option1Name: 'Age / pack', option1Value: label,
          option2Name: hex ? 'Colour' : null, option2Value: hex ? label.split('/').pop().trim() : null,
          swatchHex: hex || null, imageUrl: img(`${slug}-${sortOrder + 1}`),
          sortOrder: sortOrder++, isDefault: first, isActive: true,
        },
      });
      first = false;
    }
    createdProducts++;
    console.log(`  created nursery item: ${name} [${variants.length} variants]`);
  }

  const allProducts = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true } });
  let createdReviews = 0;
  for (const pr of allProducts) {
    if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
    const n = randInt(2, 7);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.88 ? randInt(4, 5) : 3;
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(['Anika', 'Riya', 'Meera', 'Kabir', 'Aarav', 'Nisha', 'Diya', 'Rehan']) + ' ' + rand(['P.', 'S.', 'M.', 'K.', 'R.']), rating, title: rating >= 5 ? 'Perfect for baby' : rating >= 4 ? 'Really useful' : 'Good', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.9 } });
      createdReviews++;
    }
  }

  console.log(`\n✅ Baby & nursery demo seeded — ${createdProducts} new products, ${createdReviews} reviews.`);
  console.log(`   Open the storefront for "${SLUG}" (theme: baby_nursery) to view it.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
