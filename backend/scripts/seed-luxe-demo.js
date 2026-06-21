#!/usr/bin/env node
// Luxury editorial boutique demo catalog + theme flip — to look-and-feel the
// bespoke `luxe` storefront theme (editorial imagery, serif, materials &
// craftsmanship, enquire / private appointment, some pieces by enquiry only).
//
// Usage:
//   node scripts/seed-luxe-demo.js [slug]
//   node scripts/seed-luxe-demo.js [slug] --create
//
// Idempotent. Populates an existing ECOMMERCE business (default slug: luxe-demo)
// with categories, pieces (materials/care in Product.specs; some flagged
// specs.enquiryOnly to be sold by enquiry), size/material variants and reviews;
// sets subscription.theme = 'luxe'.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'luxe-demo').toLowerCase();
const CREATE = args.includes('--create');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent('luxe-' + seed)}/900/1200`;

const CATEGORIES = [
  { name: 'Ready-to-Wear', slug: 'ready-to-wear', sort: 1 },
  { name: 'Fine Jewellery', slug: 'fine-jewellery', sort: 2 },
  { name: 'Leather Goods', slug: 'leather-goods', sort: 3 },
  { name: 'Timepieces', slug: 'timepieces', sort: 4 },
  { name: 'Fragrance', slug: 'fragrance', sort: 5 },
  { name: 'Home & Objet', slug: 'home-objet', sort: 6 },
];

const SUBCATS = { 'ready-to-wear':[['Women','lx-women'],['Men','lx-men']], 'fine-jewellery':[['Rings','lx-rings'],['Necklaces','lx-necklaces']], 'leather-goods':[['Bags','lx-bags'],['Wallets','lx-wallets']], timepieces:[['Watches','lx-watches'],['Accessories','lx-watch-acc']], fragrance:[['Eau de Parfum','lx-edp'],['Candles','lx-candles']], 'home-objet':[['Decor','lx-decor'],['Tableware','lx-tableware']] };
const NAME_SUBCAT = { 'Cashmere Tailored Coat':'lx-women','Silk Evening Gown':'lx-women','Wool Tuxedo Jacket':'lx-men','Solitaire Diamond Ring':'lx-rings','Pearl Drop Earrings':'lx-necklaces','Emerald Tennis Bracelet':'lx-necklaces','Gold Chain Necklace':'lx-necklaces','Top-Handle Leather Bag':'lx-bags','Quilted Shoulder Bag':'lx-bags','Leather Card Holder':'lx-wallets','Automatic Dress Watch':'lx-watches','Slim Quartz Watch':'lx-watches','Eau de Parfum — Oud Noir':'lx-edp','Eau de Parfum — Fleur Blanche':'lx-edp','Scented Candle — Cèdre':'lx-candles','Crystal Decanter':'lx-tableware','Marble & Brass Tray':'lx-tableware','Cashmere Throw':'lx-decor','Silk Pocket Square':'lx-men','Monogrammed Travel Wallet':'lx-wallets' };

const REVIEW_BODIES = [
  'Exquisite craftsmanship — even more beautiful in person.',
  'The materials and finish are exceptional. Worth every rupee.',
  'A timeless piece I will keep for years. Impeccable.',
  'The private appointment was a wonderful experience.',
  'Beautifully packaged, with a handwritten note. A joy.',
  'Understated luxury done right. Faultless.',
];

// name, category, brand, ₹price (0 = enquiry only), materials[], care[],
// options[[label, add₹]] ([] = single), enquiryOnly
const PRODUCTS = [
  ['Cashmere Tailored Coat', 'ready-to-wear', 'Atelier', 89000, ['100% Mongolian cashmere', 'Hand-finished horn buttons', 'Half-canvas construction'], ['Dry clean only', 'Store on a wide hanger'], [['UK 8', 0], ['UK 10', 0], ['UK 12', 0], ['UK 14', 0]], false],
  ['Silk Evening Gown', 'ready-to-wear', 'Atelier', 124000, ['Mulberry silk charmeuse', 'Hand-rolled hems', 'Made in our atelier'], ['Specialist dry clean'], [['UK 8', 0], ['UK 10', 0], ['UK 12', 0]], false],
  ['Wool Tuxedo Jacket', 'ready-to-wear', 'Atelier', 76000, ['Super 150s wool', 'Grosgrain lapel', 'Functional buttonholes'], ['Dry clean only'], [['UK 38', 0], ['UK 40', 0], ['UK 42', 0]], false],
  ['Solitaire Diamond Ring', 'fine-jewellery', 'Maison', 0, ['1.2ct brilliant-cut diamond', 'Platinum band', 'GIA certified'], ['Professional cleaning recommended'], [], true],
  ['Pearl Drop Earrings', 'fine-jewellery', 'Maison', 58000, ['South Sea pearls', '18k yellow gold', 'Hand-set'], ['Wipe with a soft cloth', 'Keep from perfume'], [], false],
  ['Emerald Tennis Bracelet', 'fine-jewellery', 'Maison', 0, ['Colombian emeralds', '18k white gold', 'Secure box clasp'], ['Professional servicing'], [], true],
  ['Gold Chain Necklace', 'fine-jewellery', 'Maison', 42000, ['18k gold', 'Lobster clasp', 'Adjustable length'], ['Store flat in pouch'], [['40 cm', 0], ['45 cm', 0], ['50 cm', 0]], false],
  ['Top-Handle Leather Bag', 'leather-goods', 'Maison', 96000, ['Full-grain calf leather', 'Hand-painted edges', 'Suede lining'], ['Avoid moisture', 'Store with dust bag'], [['Noir', 0], ['Tan', 0], ['Bordeaux', 0]], false],
  ['Quilted Shoulder Bag', 'leather-goods', 'Maison', 84000, ['Lambskin leather', 'Antique-gold hardware', 'Chain strap'], ['Keep dry', 'Use dust bag'], [['Noir', 0], ['Ivory', 0]], false],
  ['Leather Card Holder', 'leather-goods', 'Maison', 18000, ['Full-grain leather', 'Hand-stitched', 'Six card slots'], ['Wipe clean'], [['Noir', 0], ['Cognac', 0]], false],
  ['Automatic Dress Watch', 'timepieces', 'Horloger', 0, ['Swiss automatic movement', 'Sapphire crystal', 'Alligator strap'], ['Service every 4–5 years'], [], true],
  ['Slim Quartz Watch', 'timepieces', 'Horloger', 68000, ['Swiss quartz', 'Stainless steel case', 'Mesh bracelet'], ['Keep from magnets'], [['36 mm', 0], ['40 mm', 0]], false],
  ['Eau de Parfum — Oud Noir', 'fragrance', 'Maison', 22000, ['Oud, rose & amber', '100 ml', 'Crafted in Grasse'], ['Store away from light'], [['50 ml', -8000], ['100 ml', 0]], false],
  ['Eau de Parfum — Fleur Blanche', 'fragrance', 'Maison', 19000, ['Jasmine, tuberose & musk', '100 ml', 'Crafted in Grasse'], ['Store cool & dark'], [['50 ml', -7000], ['100 ml', 0]], false],
  ['Scented Candle — Cèdre', 'fragrance', 'Maison', 9500, ['Cedarwood & vetiver', '60-hour burn', 'Hand-poured wax'], ['Trim wick before lighting'], [], false],
  ['Crystal Decanter', 'home-objet', 'Maison', 38000, ['Hand-blown crystal', 'Faceted stopper', 'Presentation box'], ['Hand wash only'], [], false],
  ['Marble & Brass Tray', 'home-objet', 'Maison', 24000, ['Carrara marble', 'Polished brass handles', 'Felt base'], ['Wipe with damp cloth'], [], false],
  ['Cashmere Throw', 'home-objet', 'Atelier', 32000, ['Pure cashmere', 'Hand-finished fringe', 'Woven in Scotland'], ['Dry clean or hand wash cold'], [['Ivory', 0], ['Charcoal', 0], ['Camel', 0]], false],
  ['Silk Pocket Square', 'ready-to-wear', 'Atelier', 7500, ['Printed silk twill', 'Hand-rolled edges', '42 × 42 cm'], ['Dry clean'], [], false],
  ['Monogrammed Travel Wallet', 'leather-goods', 'Maison', 0, ['Full-grain leather', 'Bespoke monogram', 'Passport & card slots'], ['Wipe clean'], [], true],
];

async function ensureBusiness() {
  let business = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (business) return business;
  if (!CREATE) { console.error(`\nBusiness "${SLUG}" not found. Point at an existing ECOMMERCE tenant slug, or re-run with --create.\n`); process.exit(1); }
  business = await p.business.create({ data: { name: 'Maison — Luxury Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
  console.log(`  created business: ${business.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) { await p.subscription.create({ data: { businessId: business.id, tierId: tier.id, theme: 'luxe' } }); console.log('  created subscription (theme=luxe)'); }
    else console.warn('  ⚠ no plan tier found — skipped subscription; set theme=luxe once the tenant has one');
  } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
  return business;
}

async function main() {
  console.log(`\nSeeding LUXE demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ business vertical is ${business.vertical}, not ECOMMERCE.`);

  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) { if (sub.theme !== 'luxe') { await p.subscription.update({ where: { businessId: BID }, data: { theme: 'luxe' } }); console.log('  set subscription.theme = luxe'); } else console.log('  skip  theme (already luxe)'); }
  else console.warn('  ⚠ no subscription — cannot set theme=luxe.');

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
    const [name, catSlug, brand, price, materials, care, options, enquiryOnly] = PRODUCTS[i];
    const slug = slugify(name);
    const _leaves = subsByParent[catSlug] || []; let leafId = catBySlug.get(catSlug); const _m = NAME_SUBCAT[name]; if (_m && catBySlug.get(_m)) { leafId = catBySlug.get(_m); } else if (_leaves.length) { const _n = (rr[catSlug] = (rr[catSlug] ?? -1) + 1); leafId = _leaves[_n % _leaves.length]; } const _ex = await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true, categoryId: true } }); if (_ex) { if (_ex.categoryId !== leafId) { await p.product.update({ where: { id: _ex.id }, data: { categoryId: leafId } }); } continue; }

    // Enquiry-only pieces still need a non-null price column; use a nominal base
    // and flag specs.enquiryOnly so the storefront shows "Price on request".
    const basePrice = price > 0 ? price : 1;
    const priceMinor = basePrice * 100;
    const specs = { materials, care, enquiryOnly: !!enquiryOnly };
    const images = [img(`${slug}-1`), img(`${slug}-2`), img(`${slug}-3`)];

    const product = await p.product.create({
      data: {
        businessId: BID, categoryId: leafId, name, slug, brand,
        shortDescription: materials.slice(0, 2).join(' · '),
        description: `${name} by ${brand}. ${materials.join('. ')}.${enquiryOnly ? ' Available by private enquiry — contact a client advisor for availability and personalisation.' : ''}`,
        priceMinor, comparePriceMinor: null, currency: 'INR',
        imageUrls: images, specs,
        isPublished: true, isFeatured: i % 4 === 0, sortOrder: i, stockQty: enquiryOnly ? 0 : null,
        createdAt: daysAgo(randInt(0, 60)),
      },
      select: { id: true },
    });

    let sortOrder = 0; let first = true;
    for (const [optLabel, addRupees] of options) {
      const add = (addRupees || 0) * 100;
      await p.productVariant.create({
        data: {
          productId: product.id, label: optLabel,
          priceMinor: priceMinor + add, comparePriceMinor: null,
          stockQty: enquiryOnly ? 0 : (Math.random() < 0.15 ? 0 : randInt(1, 12)),
          option1Name: catSlug === 'fragrance' ? 'Size' : (catSlug === 'ready-to-wear' ? 'Size' : (catSlug === 'leather-goods' || catSlug === 'home-objet' ? 'Colour' : 'Option')),
          option1Value: optLabel,
          sortOrder: sortOrder++, isDefault: first, isActive: true,
        },
      });
      first = false;
    }
    createdProducts++;
    console.log(`  created piece: ${name}${enquiryOnly ? ' [by enquiry]' : ''}`);
  }

  const allProducts = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true } });
  let createdReviews = 0;
  for (const pr of allProducts) {
    if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
    const n = randInt(1, 5);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.9 ? 5 : 4;
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(['Isabelle', 'Alexander', 'Priya', 'Vikram', 'Charlotte', 'Aarav', 'Sophia', 'Rohan', 'Anaïs', 'Kabir']) + ' ' + rand(['L.', 'M.', 'V.', 'R.', 'S.']), rating, title: rating === 5 ? 'Exquisite' : 'Beautiful', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.9 } });
      createdReviews++;
    }
  }

  console.log(`\n✅ Luxe demo seeded — ${createdProducts} new pieces, ${createdReviews} reviews.`);
  console.log(`   Open the storefront for "${SLUG}" (theme: luxe) to view it.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
