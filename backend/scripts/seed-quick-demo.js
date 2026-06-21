#!/usr/bin/env node
// Quick-commerce (10-min delivery) demo catalog + theme flip — to look-and-feel
// the bespoke `quick` storefront theme (dense grid, instant-add steppers, ETA +
// location bar, sticky cart bar).
//
// Usage:
//   node scripts/seed-quick-demo.js [slug]
//   node scripts/seed-quick-demo.js [slug] --create
//
// Idempotent. Populates an existing ECOMMERCE business (default slug: quick-demo)
// with grocery/daily-essentials categories and simple (variant-less) products —
// each with a pack size in Product.specs.unit — plus reviews; sets
// subscription.theme = 'quick'. Images default to picsum placeholders.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'quick-demo').toLowerCase();
const CREATE = args.includes('--create');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent('quick-' + seed)}/500/500`;

const CATEGORIES = [
  { name: 'Fruits & Vegetables', slug: 'fruits-vegetables', sort: 1 },
  { name: 'Dairy & Bread', slug: 'dairy-bread', sort: 2 },
  { name: 'Snacks & Munchies', slug: 'snacks-munchies', sort: 3 },
  { name: 'Cold Drinks & Juices', slug: 'cold-drinks-juices', sort: 4 },
  { name: 'Instant & Frozen', slug: 'instant-frozen', sort: 5 },
  { name: 'Personal Care', slug: 'personal-care', sort: 6 },
];

const SUBCATS = { 'fruits-vegetables':[['Fruits','qk-fruits'],['Vegetables','qk-veg']], 'dairy-bread':[['Dairy','qk-dairy'],['Bread & Eggs','qk-bread']], 'snacks-munchies':[['Chips','qk-chips'],['Biscuits','qk-biscuits']], 'cold-drinks-juices':[['Soft Drinks','qk-soft'],['Juices','qk-juices']], 'instant-frozen':[['Instant','qk-instant'],['Frozen','qk-frozen']], 'personal-care':[['Bath','qk-bath'],['Oral','qk-oral']] };
const NAME_SUBCAT = { 'Bananas (Robusta)':'qk-fruits','Tomatoes':'qk-veg','Onions':'qk-veg','Baby Spinach':'qk-veg','Apples (Shimla)':'qk-fruits','Toned Milk':'qk-dairy','Brown Bread':'qk-bread','Farm Eggs':'qk-bread','Paneer':'qk-dairy','Salted Butter':'qk-dairy','Potato Chips (Salted)':'qk-chips','Roasted Almonds':'qk-biscuits','Dark Chocolate Bar':'qk-biscuits','Masala Peanuts':'qk-chips','Instant Noodles (Pack of 4)':'qk-chips','Cola':'qk-soft','Orange Juice':'qk-juices','Sparkling Water':'qk-soft','Cold Brew Coffee':'qk-juices','Frozen Green Peas':'qk-frozen','Veg Spring Rolls':'qk-frozen','Frozen Paratha (Pack of 5)':'qk-instant','Vanilla Ice Cream Tub':'qk-frozen','Hand Wash Refill':'qk-bath' };

const REVIEW_BODIES = [
  'Arrived in literally 9 minutes. Unreal.',
  'Fresh and exactly as described. Will reorder.',
  'Lifesaver for last-minute groceries.',
  'Great price and super fast delivery.',
  'Packed well, everything intact.',
  'Faster than I could walk to the shop!',
];

// name, category, ₹price, ₹mrp|null, unit/pack, highlights[]
const PRODUCTS = [
  ['Bananas (Robusta)', 'fruits-vegetables', 39, 49, '6 pcs (approx 1 kg)', ['Naturally ripened', 'Rich in potassium']],
  ['Tomatoes', 'fruits-vegetables', 29, 39, '500 g', ['Fresh & firm', 'Locally sourced']],
  ['Onions', 'fruits-vegetables', 35, 45, '1 kg', ['Everyday essential', 'Hand-picked']],
  ['Baby Spinach', 'fruits-vegetables', 25, null, '250 g', ['Washed & ready', 'Iron-rich']],
  ['Apples (Shimla)', 'fruits-vegetables', 129, 159, '4 pcs (approx 700 g)', ['Crisp & sweet', 'Hand-graded']],
  ['Toned Milk', 'dairy-bread', 27, null, '500 ml pouch', ['Fresh daily', '3% fat']],
  ['Brown Bread', 'dairy-bread', 45, 50, '400 g loaf', ['Whole wheat', 'Soft & fresh']],
  ['Farm Eggs', 'dairy-bread', 84, 99, '6 pcs', ['Protein-rich', 'Quality-checked']],
  ['Paneer', 'dairy-bread', 89, 99, '200 g', ['Fresh & soft', 'High protein']],
  ['Salted Butter', 'dairy-bread', 56, 62, '100 g', ['Creamy', 'Table-spreadable']],
  ['Potato Chips (Salted)', 'snacks-munchies', 20, null, '52 g', ['Crunchy', 'Lightly salted']],
  ['Roasted Almonds', 'snacks-munchies', 199, 249, '200 g', ['Dry-roasted', 'No added oil']],
  ['Dark Chocolate Bar', 'snacks-munchies', 99, 120, '80 g', ['55% cocoa', 'Rich & smooth']],
  ['Masala Peanuts', 'snacks-munchies', 49, 59, '150 g', ['Spicy & crunchy', 'Perfect tea-time']],
  ['Instant Noodles (Pack of 4)', 'snacks-munchies', 56, 60, '4 × 70 g', ['Ready in 2 mins', 'Masala flavour']],
  ['Cola', 'cold-drinks-juices', 40, null, '750 ml', ['Chilled', 'Classic taste']],
  ['Orange Juice', 'cold-drinks-juices', 99, 110, '1 L', ['No added sugar', 'From concentrate']],
  ['Sparkling Water', 'cold-drinks-juices', 35, null, '500 ml', ['Zero calories', 'Refreshing']],
  ['Cold Brew Coffee', 'cold-drinks-juices', 129, 149, '200 ml', ['Smooth & strong', 'Ready to drink']],
  ['Frozen Green Peas', 'instant-frozen', 89, 99, '500 g', ['Flash-frozen', 'Farm fresh']],
  ['Veg Spring Rolls', 'instant-frozen', 149, 175, '10 pcs', ['Heat & serve', 'Crispy']],
  ['Frozen Paratha (Pack of 5)', 'instant-frozen', 99, 115, '5 pcs', ['Tawa-ready', 'Flaky layers']],
  ['Vanilla Ice Cream Tub', 'instant-frozen', 175, 199, '500 ml', ['Real vanilla', 'Creamy']],
  ['Hand Wash Refill', 'personal-care', 99, 120, '750 ml', ['Kills 99.9% germs', 'Moisturising']],
  ['Toothpaste', 'personal-care', 95, 110, '150 g', ['Cavity protection', 'Fresh mint']],
  ['Shampoo', 'personal-care', 175, 210, '340 ml', ['Anti-dandruff', 'Gentle daily care']],
  ['Tissue Box', 'personal-care', 65, 75, '100 pulls', ['2-ply soft', 'Everyday use']],
  ['Deodorant Spray', 'personal-care', 199, 230, '150 ml', ['Long-lasting', 'No white marks']],
];

async function ensureBusiness() {
  let business = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (business) return business;
  if (!CREATE) { console.error(`\nBusiness "${SLUG}" not found. Point at an existing ECOMMERCE tenant slug, or re-run with --create.\n`); process.exit(1); }
  business = await p.business.create({ data: { name: 'Bolt — Quick Commerce Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
  console.log(`  created business: ${business.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) { await p.subscription.create({ data: { businessId: business.id, tierId: tier.id, theme: 'quick' } }); console.log('  created subscription (theme=quick)'); }
    else console.warn('  ⚠ no plan tier found — skipped subscription; set theme=quick once the tenant has one');
  } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
  return business;
}

async function main() {
  console.log(`\nSeeding QUICK-COMMERCE demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ business vertical is ${business.vertical}, not ECOMMERCE.`);

  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) { if (sub.theme !== 'quick') { await p.subscription.update({ where: { businessId: BID }, data: { theme: 'quick' } }); console.log('  set subscription.theme = quick'); } else console.log('  skip  theme (already quick)'); }
  else console.warn('  ⚠ no subscription — cannot set theme=quick.');

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
    const [name, catSlug, price, mrp, unit, highlights] = PRODUCTS[i];
    const slug = slugify(name);
    const _leaves = subsByParent[catSlug] || []; let leafId = catBySlug.get(catSlug); const _m = NAME_SUBCAT[name]; if (_m && catBySlug.get(_m)) { leafId = catBySlug.get(_m); } else if (_leaves.length) { const _n = (rr[catSlug] = (rr[catSlug] ?? -1) + 1); leafId = _leaves[_n % _leaves.length]; } const _ex = await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true, categoryId: true } }); if (_ex) { if (_ex.categoryId !== leafId) { await p.product.update({ where: { id: _ex.id }, data: { categoryId: leafId } }); } continue; }

    const priceMinor = price * 100;
    const compareMinor = mrp ? mrp * 100 : null;
    const specs = { unit, highlights };
    const images = [img(`${slug}-1`)];

    await p.product.create({
      data: {
        businessId: BID, categoryId: leafId, name, slug,
        shortDescription: unit,
        description: `${name} — ${unit}. ${highlights.join('. ')}. Delivered in minutes.`,
        priceMinor, comparePriceMinor: compareMinor, currency: 'INR',
        imageUrls: images, specs,
        isPublished: true, isFeatured: i % 4 === 0, sortOrder: i,
        stockQty: Math.random() < 0.05 ? 0 : randInt(15, 120),
        createdAt: daysAgo(randInt(0, 30)),
      },
    });
    createdProducts++;
    console.log(`  created product: ${name} [${unit}]`);
  }

  const allProducts = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true } });
  let createdReviews = 0;
  for (const pr of allProducts) {
    if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
    const n = randInt(2, 9);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.85 ? randInt(4, 5) : randInt(3, 4);
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(['Aman', 'Riya', 'Sahil', 'Pooja', 'Vivek', 'Neha', 'Imran', 'Tara', 'Yash', 'Diya']) + ' ' + rand(['G.', 'K.', 'M.', 'S.', 'P.']), rating, title: rating >= 5 ? 'Super fast!' : rating >= 4 ? 'Great' : 'Okay', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.9 } });
      createdReviews++;
    }
  }

  console.log(`\n✅ Quick-commerce demo seeded — ${createdProducts} new products, ${createdReviews} reviews.`);
  console.log(`   Open the storefront for "${SLUG}" (theme: quick) to view it.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
