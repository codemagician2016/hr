#!/usr/bin/env node
// Multi-vendor marketplace demo catalog + theme flip — to look-and-feel the
// bespoke `marketplace` storefront theme (many independent sellers, diverse
// departments, options, sale prices). The theme renders the seller from
// product.brand and uses option1/option2 variants (it does not read specs).
//
// Usage:
//   node scripts/seed-marketplace-demo.js [slug]
//   node scripts/seed-marketplace-demo.js [slug] --create
//
// Idempotent. Sets subscription.theme = 'marketplace'. Each product's brand is
// its seller/shop name, so the storefront shows a varied multi-seller catalog.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'marketplace-demo').toLowerCase();
const CREATE = args.includes('--create');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent('mk-' + seed)}/700/700`;

const CATEGORIES = [
  { name: 'Handmade', slug: 'handmade', sort: 1 },
  { name: 'Home & Living', slug: 'home-living', sort: 2 },
  { name: 'Fashion', slug: 'fashion', sort: 3 },
  { name: 'Food & Pantry', slug: 'food-pantry', sort: 4 },
  { name: 'Beauty', slug: 'beauty', sort: 5 },
  { name: 'Kids', slug: 'kids', sort: 6 },
  { name: 'Digital Goods', slug: 'digital-goods', sort: 7 },
  { name: 'Local Picks', slug: 'local-picks', sort: 8 },
];

const SUBCATS = { handmade:[['Ceramics','mk-ceramics'],['Textiles','mk-textiles'],['Art','mk-art']], 'home-living':[['Decor','mk-decor'],['Kitchen','mk-kitchen']], fashion:[['Apparel','mk-apparel'],['Accessories','mk-accessories']], 'food-pantry':[['Snacks','mk-fp-snacks'],['Condiments','mk-condiments']], beauty:[['Skincare','mk-skincare'],['Makeup','mk-makeup']], kids:[['Toys','mk-toys'],['Clothing','mk-kids-clothing']], 'digital-goods':[['Printables','mk-printables'],['Templates','mk-templates']] };
const NAME_SUBCAT = { 'Hand-thrown Ceramic Mug':'mk-ceramics','Macramé Wall Hanging':'mk-textiles','Hand-poured Soy Candle':'mk-art','Block-print Cushion Cover':'mk-decor','Brass Table Lamp':'mk-decor','Woven Jute Rug':'mk-kitchen','Linen Wrap Dress':'mk-apparel','Recycled Tote Bag':'mk-accessories','Hand-knit Beanie':'mk-accessories','Artisan Coffee Beans':'mk-fp-snacks','Small-batch Hot Sauce':'mk-condiments','Raw Wildflower Honey':'mk-condiments','Cold-process Soap Bar':'mk-skincare','Beard Oil':'mk-skincare','Lip Balm Trio':'mk-makeup','Wooden Stacking Toy':'mk-toys','Organic Baby Onesie':'mk-kids-clothing','Felt Animal Mobile':'mk-toys','Printable Wall Art Pack':'mk-printables','Lightroom Preset Bundle':'mk-templates' };

const REVIEW_BODIES = [
  'Lovely handmade quality, arrived quickly from the seller.',
  'Exactly as described — supporting small makers feels great.',
  'Great communication from the shop. Will buy again.',
  'Unique find I couldn’t get anywhere else.',
  'Well packaged and beautifully crafted.',
  'Fair price and fast dispatch from the vendor.',
];

// name, category, seller(brand), ₹price, ₹mrp|null, opts[[name,[[label,hex]]]] ([] = none)
const PRODUCTS = [
  ['Hand-thrown Ceramic Mug', 'handmade', 'Clay & Co.', 699, 849, [['Colour', [['Sage', '#9CAF88'], ['Clay', '#B5651D'], ['Charcoal', '#36454F']]]]],
  ['Macramé Wall Hanging', 'handmade', 'KnotStudio', 1299, null, []],
  ['Hand-poured Soy Candle', 'handmade', 'Ember Goods', 549, 649, [['Scent', [['Vanilla', '#F3E5AB'], ['Cedar', '#7B5E3B'], ['Citrus', '#F4A300']]]]],
  ['Block-print Cushion Cover', 'home-living', 'Indigo Loom', 799, 999, [['Colour', [['Indigo', '#3F4C8C'], ['Rust', '#B7410E']]]]],
  ['Brass Table Lamp', 'home-living', 'Lumen Works', 2499, 2999, []],
  ['Woven Jute Rug', 'home-living', 'Indigo Loom', 1899, null, [['Size', [['Small', null], ['Medium', null], ['Large', null]]]]],
  ['Linen Wrap Dress', 'fashion', 'Saudade', 2299, 2799, [['Size', [['S', null], ['M', null], ['L', null]]]]],
  ['Recycled Tote Bag', 'fashion', 'GreenThread', 899, null, [['Colour', [['Natural', '#EFE9DD'], ['Black', '#1A1A1A']]]]],
  ['Hand-knit Beanie', 'fashion', 'WoollyMade', 749, 899, [['Colour', [['Mustard', '#E1AD01'], ['Forest', '#228B22'], ['Grey', '#808080']]]]],
  ['Artisan Coffee Beans', 'food-pantry', 'Daybreak Roasters', 599, null, [['Roast', [['Light', null], ['Medium', null], ['Dark', null]]]]],
  ['Small-batch Hot Sauce', 'food-pantry', 'Fuego Lab', 349, 399, [['Heat', [['Mild', null], ['Hot', null]]]]],
  ['Raw Wildflower Honey', 'food-pantry', 'Hive & Co.', 449, 549, []],
  ['Cold-process Soap Bar', 'beauty', 'Botanica', 299, null, [['Scent', [['Lavender', '#B57EDC'], ['Charcoal', '#36454F'], ['Rose', '#FF66B2']]]]],
  ['Beard Oil', 'beauty', 'NorthGrove', 649, 749, []],
  ['Lip Balm Trio', 'beauty', 'Botanica', 499, null, []],
  ['Wooden Stacking Toy', 'kids', 'TinyPine', 999, 1199, []],
  ['Organic Baby Onesie', 'kids', 'LittleSprout', 699, null, [['Size', [['0-3m', null], ['3-6m', null], ['6-12m', null]]]]],
  ['Felt Animal Mobile', 'kids', 'KnotStudio', 1299, 1499, []],
  ['Printable Wall Art Pack', 'digital-goods', 'PixelPress', 299, null, []],
  ['Lightroom Preset Bundle', 'digital-goods', 'Marco Vela', 799, 999, []],
  ['Local Pottery Set', 'local-picks', 'Clay & Co.', 1799, 2199, []],
  ['Regional Spice Box', 'local-picks', 'Hive & Co.', 899, null, []],
];

async function ensureBusiness() {
  let b = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (b) return b;
  if (!CREATE) { console.error(`\nBusiness "${SLUG}" not found. Use an existing ECOMMERCE slug or re-run with --create.\n`); process.exit(1); }
  b = await p.business.create({ data: { name: 'Bazaar — Marketplace Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
  console.log(`  created business: ${b.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) { await p.subscription.create({ data: { businessId: b.id, tierId: tier.id, theme: 'marketplace' } }); console.log('  created subscription (theme=marketplace)'); }
    else console.warn('  ⚠ no plan tier found — set theme=marketplace once the tenant has one');
  } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
  return b;
}

async function main() {
  console.log(`\nSeeding MARKETPLACE demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ vertical is ${business.vertical}, not ECOMMERCE.`);

  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) { if (sub.theme !== 'marketplace') { await p.subscription.update({ where: { businessId: BID }, data: { theme: 'marketplace' } }); console.log('  set subscription.theme = marketplace'); } else console.log('  skip  theme (already marketplace)'); }
  else console.warn('  ⚠ no subscription — cannot set theme=marketplace.');

  const catBySlug = new Map();
  for (const c of CATEGORIES) {
    let row = await p.productCategory.findFirst({ where: { businessId: BID, slug: c.slug }, select: { id: true } });
    if (!row) { row = await p.productCategory.create({ data: { businessId: BID, name: c.name, slug: c.slug, sortOrder: c.sort, isPublished: true, imageUrl: img(`cat-${c.slug}`) }, select: { id: true } }); console.log(`  created category: ${c.name}`); }
    catBySlug.set(c.slug, row.id);
  }

  let created = 0;
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
    const [name, catSlug, seller, price, mrp, opts] = PRODUCTS[i];
    const slug = slugify(name);
    const _leaves = subsByParent[catSlug] || []; let leafId = catBySlug.get(catSlug); const _m = NAME_SUBCAT[name]; if (_m && catBySlug.get(_m)) { leafId = catBySlug.get(_m); } else if (_leaves.length) { const _n = (rr[catSlug] = (rr[catSlug] ?? -1) + 1); leafId = _leaves[_n % _leaves.length]; } const _ex = await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true, categoryId: true } }); if (_ex) { if (_ex.categoryId !== leafId) { await p.product.update({ where: { id: _ex.id }, data: { categoryId: leafId } }); } continue; }
    const priceMinor = price * 100;
    const compareMinor = mrp ? mrp * 100 : null;
    const images = [img(`${slug}-1`), img(`${slug}-2`)];
    const product = await p.product.create({
      data: {
        businessId: BID, categoryId: leafId, name, slug, brand: seller,
        shortDescription: `Sold by ${seller}`,
        description: `${name} — handpicked from ${seller}, an independent seller on our marketplace. Each order supports a small maker.`,
        priceMinor, comparePriceMinor: compareMinor, currency: 'INR',
        imageUrls: images, isPublished: true, isFeatured: i % 5 === 0, sortOrder: i, stockQty: null,
        createdAt: daysAgo(randInt(0, 45)),
      }, select: { id: true },
    });
    // Single-axis variants (the seller's chosen option). None → one default line.
    let sortOrder = 0; let first = true;
    if (opts.length) {
      const [optName, values] = opts[0];
      for (const [label, hex] of values) {
        await p.productVariant.create({
          data: {
            productId: product.id, label,
            priceMinor, comparePriceMinor: compareMinor,
            stockQty: Math.random() < 0.1 ? 0 : randInt(3, 40),
            option1Name: optName, option1Value: label, swatchHex: hex,
            sortOrder: sortOrder++, isDefault: first, isActive: true,
          },
        });
        first = false;
      }
    }
    created++;
    console.log(`  created listing: ${name} — ${seller}`);
  }

  const all = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true } });
  let reviews = 0;
  for (const pr of all) {
    if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
    const n = randInt(2, 7);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.85 ? randInt(4, 5) : randInt(3, 4);
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(['Zoe', 'Aman', 'Lucia', 'Ravi', 'Hana', 'Owen', 'Diya', 'Felix']) + ' ' + rand(['A.', 'K.', 'L.', 'P.', 'T.']), rating, title: rating >= 5 ? 'Love it' : rating >= 4 ? 'Really nice' : 'Good', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.8 } });
      reviews++;
    }
  }

  console.log(`\n✅ Marketplace demo seeded — ${created} listings across many sellers, ${reviews} reviews. Theme: marketplace.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
