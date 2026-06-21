#!/usr/bin/env node
// Food/restaurant demo menu + theme flip — to look-and-feel the bespoke `food`
// storefront theme (menu layout, veg toggle, customise modal, floating cart).
//
// Usage:
//   node scripts/seed-food-demo.js [slug]
//   node scripts/seed-food-demo.js [slug] --create
//
// Idempotent. Populates an existing ECOMMERCE business (default slug:
// food-demo) with menu categories, dishes (portion × add-on variants + veg /
// spicy / bestseller specs), and reviews; sets subscription.theme = 'food'.
//
// Veg / spice / bestseller are stored in the existing Product.specs JSON
// (no new migration). Images default to picsum placeholders.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'food-demo').toLowerCase();
const CREATE = args.includes('--create');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent('food-' + seed)}/600/600`;

const CATEGORIES = [
  { name: 'Starters', slug: 'starters', sort: 1 },
  { name: 'Main Course', slug: 'main-course', sort: 2 },
  { name: 'Biryani & Rice', slug: 'biryani-rice', sort: 3 },
  { name: 'Breads', slug: 'breads', sort: 4 },
  { name: 'Desserts', slug: 'desserts', sort: 5 },
  { name: 'Beverages', slug: 'beverages', sort: 6 },
];

const REVIEW_BODIES = [
  'Absolutely delicious and piping hot on arrival. Will order again!',
  'Great portion size and full of flavour. Packaging was neat too.',
  'Tasted fresh and authentic. Delivery was quick.',
  'One of the best in the area — the spices are spot on.',
  'Loved it. Generous portion and reasonable price.',
  'Consistently good. A family favourite now.',
  'Rich and well-cooked. Highly recommend.',
];

// name, category, ₹price, ₹MRP|null, veg, spicy(0-3), bestseller, portions[[label,add]], addons|null, desc
const PRODUCTS = [
  ['Paneer Tikka', 'starters', 289, 329, true, 2, true, [['6 pcs', 0], ['12 pcs', 220]], null, 'Char-grilled cottage cheese marinated in spiced yoghurt with peppers and onion.'],
  ['Crispy Chilli Potato', 'starters', 199, null, true, 2, false, [['Regular', 0]], null, 'Crunchy potato tossed in a sweet-spicy chilli glaze with spring onion.'],
  ['Chicken 65', 'starters', 269, 299, false, 3, true, [['Regular', 0], ['Large', 120]], null, 'South-Indian style fiery fried chicken with curry leaves and chilli.'],
  ['Veg Spring Rolls', 'starters', 179, null, true, 1, false, [['6 pcs', 0]], null, 'Golden rolls stuffed with stir-fried vegetables and noodles.'],
  ['Tandoori Chicken', 'starters', 349, 399, false, 2, false, [['Half', 0], ['Full', 280]], null, 'Clay-oven roasted chicken in a smoky tandoori marinade.'],
  ['Paneer Butter Masala', 'main-course', 319, 359, true, 1, true, [['Regular', 0], ['Family', 200]], [['No add-on', 0], ['Extra gravy', 40], ['Extra paneer', 90]], 'Cottage cheese simmered in a silky tomato-butter gravy with cream.'],
  ['Butter Chicken', 'main-course', 369, 419, false, 1, true, [['Regular', 0], ['Family', 240]], [['No add-on', 0], ['Extra gravy', 40]], 'Tandoori chicken in a rich makhani gravy of tomato, butter and cream.'],
  ['Dal Makhani', 'main-course', 259, null, true, 1, false, [['Regular', 0], ['Family', 160]], null, 'Black lentils slow-cooked overnight with butter and cream.'],
  ['Kadai Mushroom', 'main-course', 279, 309, true, 2, false, [['Regular', 0]], null, 'Mushrooms tossed with bell peppers in a freshly ground kadai masala.'],
  ['Mutton Rogan Josh', 'main-course', 429, 479, false, 2, false, [['Regular', 0], ['Family', 280]], null, 'Tender mutton braised in aromatic Kashmiri spices.'],
  ['Chicken Biryani', 'biryani-rice', 299, 349, false, 2, true, [['Single', 0], ['Family pack', 320]], [['No add-on', 0], ['Extra raita', 30], ['Boiled egg', 25]], 'Fragrant long-grain rice layered with marinated chicken and saffron.'],
  ['Veg Biryani', 'biryani-rice', 249, 289, true, 1, false, [['Single', 0], ['Family pack', 260]], [['No add-on', 0], ['Extra raita', 30]], 'Dum-cooked basmati with garden vegetables and whole spices.'],
  ['Hyderabadi Mutton Biryani', 'biryani-rice', 399, 449, false, 3, true, [['Single', 0], ['Family pack', 380]], null, 'Classic dum biryani with succulent mutton and fried onions.'],
  ['Jeera Rice', 'biryani-rice', 159, null, true, 0, false, [['Regular', 0]], null, 'Basmati rice tempered with cumin and ghee.'],
  ['Butter Naan', 'breads', 49, null, true, 0, true, [['1 pc', 0], ['2 pcs', 45]], null, 'Soft leavened flatbread brushed with butter.'],
  ['Garlic Naan', 'breads', 59, null, true, 0, false, [['1 pc', 0], ['2 pcs', 55]], null, 'Naan topped with garlic and coriander.'],
  ['Tandoori Roti', 'breads', 29, null, true, 0, false, [['1 pc', 0], ['2 pcs', 25]], null, 'Whole-wheat flatbread from the clay oven.'],
  ['Laccha Paratha', 'breads', 55, null, true, 0, false, [['1 pc', 0]], null, 'Flaky multi-layered whole-wheat paratha.'],
  ['Gulab Jamun', 'desserts', 99, null, true, 0, true, [['2 pcs', 0], ['4 pcs', 90]], null, 'Warm milk-solid dumplings soaked in rose-cardamom syrup.'],
  ['Choco Lava Cake', 'desserts', 129, 149, true, 0, false, [['1 pc', 0], ['2 pcs', 120]], null, 'Molten chocolate cake with a gooey centre.'],
  ['Rasmalai', 'desserts', 119, null, true, 0, false, [['2 pcs', 0]], null, 'Soft paneer discs in saffron-pistachio thickened milk.'],
  ['Masala Chai', 'beverages', 49, null, true, 0, false, [['Regular', 0], ['Large', 20]], null, 'Spiced milk tea brewed with ginger and cardamom.'],
  ['Fresh Lime Soda', 'beverages', 69, null, true, 0, false, [['Sweet', 0], ['Salted', 0], ['Mixed', 0]], null, 'Refreshing lime soda, your way.'],
  ['Mango Lassi', 'beverages', 99, 119, true, 0, true, [['Regular', 0], ['Large', 30]], null, 'Thick yoghurt smoothie blended with sweet mango.'],
];

async function ensureBusiness() {
  let business = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (business) return business;
  if (!CREATE) { console.error(`\nBusiness "${SLUG}" not found. Point at an existing ECOMMERCE tenant slug, or re-run with --create.\n`); process.exit(1); }
  business = await p.business.create({ data: { name: 'The Kitchen — Food Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
  console.log(`  created business: ${business.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) { await p.subscription.create({ data: { businessId: business.id, tierId: tier.id, theme: 'food' } }); console.log('  created subscription (theme=food)'); }
    else console.warn('  ⚠ no plan tier found — skipped subscription; set theme=food once the tenant has one');
  } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
  return business;
}

async function main() {
  console.log(`\nSeeding FOOD demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ business vertical is ${business.vertical}, not ECOMMERCE.`);

  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) { if (sub.theme !== 'food') { await p.subscription.update({ where: { businessId: BID }, data: { theme: 'food' } }); console.log('  set subscription.theme = food'); } else console.log('  skip  theme (already food)'); }
  else console.warn('  ⚠ no subscription — cannot set theme=food.');

  const catBySlug = new Map();
  for (const c of CATEGORIES) {
    let row = await p.productCategory.findFirst({ where: { businessId: BID, slug: c.slug }, select: { id: true } });
    if (!row) { row = await p.productCategory.create({ data: { businessId: BID, name: c.name, slug: c.slug, sortOrder: c.sort, isPublished: true, imageUrl: img(`cat-${c.slug}`) }, select: { id: true } }); console.log(`  created category: ${c.name}`); }
    catBySlug.set(c.slug, row.id);
  }

  let createdProducts = 0;
  for (let i = 0; i < PRODUCTS.length; i++) {
    const [name, catSlug, price, mrp, veg, spicy, bestseller, portions, addons, desc] = PRODUCTS[i];
    const slug = slugify(name);
    if (await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true } })) continue;

    const priceMinor = price * 100;
    const compareMinor = mrp ? mrp * 100 : null;
    const specs = { veg, spicy, bestseller };
    const images = [img(`${slug}-1`), img(`${slug}-2`)];

    const product = await p.product.create({
      data: {
        businessId: BID, categoryId: catBySlug.get(catSlug), name, slug,
        shortDescription: desc,
        description: `${desc}${bestseller ? ' A house bestseller.' : ''}`,
        priceMinor, comparePriceMinor: compareMinor, currency: 'INR',
        imageUrls: images, specs,
        isPublished: true, isFeatured: bestseller, sortOrder: i, stockQty: null,
        createdAt: daysAgo(randInt(0, 40)),
      },
      select: { id: true },
    });

    let sortOrder = 0; let first = true;
    const addonList = addons || [[null, 0]];
    for (const [portionLabel, portionAdd] of portions) {
      for (const [addonLabel, addonAdd] of addonList) {
        const add = ((portionAdd || 0) + (addonAdd || 0)) * 100;
        await p.productVariant.create({
          data: {
            productId: product.id,
            label: addonLabel ? `${portionLabel} / ${addonLabel}` : portionLabel,
            priceMinor: priceMinor + add,
            comparePriceMinor: compareMinor != null ? compareMinor + add : null,
            stockQty: Math.random() < 0.08 ? 0 : randInt(5, 50),
            option1Name: 'Portion', option1Value: portionLabel,
            option2Name: addonLabel ? 'Add-on' : null, option2Value: addonLabel,
            sortOrder: sortOrder++, isDefault: first, isActive: true,
          },
        });
        first = false;
      }
    }
    createdProducts++;
    console.log(`  created dish: ${name}`);
  }

  const allProducts = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true } });
  let createdReviews = 0;
  for (const pr of allProducts) {
    if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
    const n = randInt(2, 9);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.8 ? randInt(4, 5) : randInt(3, 4);
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(['Aman', 'Neha', 'Vivek', 'Priya', 'Sahil', 'Divya', 'Raj', 'Anu']) + ' ' + rand(['S.', 'K.', 'M.', 'R.']), rating, title: rating >= 5 ? 'Delicious' : rating >= 4 ? 'Tasty' : 'Good', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.8 } });
      createdReviews++;
    }
  }

  console.log(`\n✅ Food demo seeded — ${createdProducts} new dishes, ${createdReviews} reviews.`);
  console.log(`   Open the storefront for "${SLUG}" (theme: food) to view it.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
