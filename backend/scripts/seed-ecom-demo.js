#!/usr/bin/env node
// Comprehensive ECOMMERCE demo data seeder.
// Usage: node scripts/seed-ecom-demo.js [slug]   (default slug: ecom)
// Idempotent — skips rows that already exist.

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const p = new PrismaClient();
const TARGET_SLUG = process.argv[2] || 'ecom';

// ── helpers ──────────────────────────────────────────────────────────────────
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const daysFromNow = (n) => new Date(Date.now() + n * 86400000);
async function skip(label, check) {
  const exists = await check();
  if (exists) { console.log(`  skip  ${label}`); return true; }
  return false;
}

// ── category tree ─────────────────────────────────────────────────────────────
const CATEGORY_TREE = [
  { name: 'Produce',       slug: 'produce',     sort: 1, emoji: '🥬',
    children: [
      { name: 'Fresh Fruits',     slug: 'fresh-fruits',     sort: 1 },
      { name: 'Fresh Vegetables', slug: 'fresh-vegetables', sort: 2 },
      { name: 'Herbs & Seasonings', slug: 'herbs',          sort: 3 },
      { name: 'Organic Range',    slug: 'organic',          sort: 4 },
    ]},
  { name: 'Dairy & Eggs',  slug: 'dairy-eggs',  sort: 2, emoji: '🥛',
    children: [
      { name: 'Milk & Cream', slug: 'milk-cream', sort: 1 },
      { name: 'Cheese',       slug: 'cheese',     sort: 2 },
      { name: 'Yogurt',       slug: 'yogurt',     sort: 3 },
      { name: 'Eggs',         slug: 'eggs',       sort: 4 },
    ]},
  { name: 'Bakery',        slug: 'bakery',      sort: 3, emoji: '🍞',
    children: [
      { name: 'Bread & Rolls',   slug: 'bread',         sort: 1 },
      { name: 'Cakes & Pastries', slug: 'cakes',        sort: 2 },
      { name: 'Gluten Free',     slug: 'gluten-free',   sort: 3 },
    ]},
  { name: 'Meat & Fish',   slug: 'meat-fish',   sort: 4, emoji: '🥩',
    children: [
      { name: 'Chicken',     slug: 'chicken',      sort: 1 },
      { name: 'Beef & Lamb', slug: 'beef-lamb',    sort: 2 },
      { name: 'Fish',        slug: 'fish',         sort: 3 },
      { name: 'Plant-based', slug: 'plant-based',  sort: 4 },
    ]},
  { name: 'Beverages',     slug: 'beverages',   sort: 5, emoji: '🧃',
    children: [
      { name: 'Water & Soft Drinks', slug: 'soft-drinks', sort: 1 },
      { name: 'Juices',              slug: 'juices',      sort: 2 },
      { name: 'Tea & Coffee',        slug: 'tea-coffee',  sort: 3 },
    ]},
  { name: 'Snacks',        slug: 'snacks',      sort: 6, emoji: '🍪',
    children: [
      { name: 'Crisps & Chips',  slug: 'crisps',     sort: 1 },
      { name: 'Nuts & Seeds',    slug: 'nuts',       sort: 2 },
      { name: 'Chocolate',       slug: 'chocolate',  sort: 3 },
    ]},
  { name: 'Frozen',        slug: 'frozen',      sort: 7, emoji: '🧊',
    children: [
      { name: 'Frozen Vegetables', slug: 'frozen-veg',   sort: 1 },
      { name: 'Frozen Meals',      slug: 'frozen-meals', sort: 2 },
      { name: 'Ice Cream',         slug: 'ice-cream',    sort: 3 },
    ]},
  { name: 'Pantry',        slug: 'pantry',      sort: 8, emoji: '🫙',
    children: [
      { name: 'Rice & Pasta',   slug: 'rice-pasta',  sort: 1 },
      { name: 'Oils & Sauces', slug: 'oils-sauces', sort: 2 },
      { name: 'Canned Goods',  slug: 'canned',      sort: 3 },
      { name: 'Spices',        slug: 'spices',      sort: 4 },
    ]},
];

const CUSTOMERS = [
  { name: 'Sarah Thompson', email: 'sarah.thompson@example.com', phone: '+441234567801' },
  { name: 'James Patel',    email: 'james.patel@example.com',    phone: '+441234567802' },
  { name: 'Priya Sharma',   email: 'priya.sharma@example.com',   phone: '+441234567803' },
  { name: 'Oliver Chen',    email: 'oliver.chen@example.com',    phone: '+441234567804' },
  { name: 'Emma Wilson',    email: 'emma.wilson@example.com',    phone: '+441234567805' },
  { name: 'Liam Murphy',    email: 'liam.murphy@example.com',    phone: '+441234567806' },
  { name: 'Aisha Rahman',   email: 'aisha.rahman@example.com',   phone: '+441234567807' },
  { name: 'Noah Williams',  email: 'noah.williams@example.com',  phone: '+441234567808' },
];

const COUPONS = [
  { code: 'WELCOME10', description: '10% off your first order', discountType: 'PERCENTAGE', discountValue: 10, maxUsesPerCustomer: 1, usedCount: 12 },
  { code: 'SAVE20',    description: '£5 off orders over £25',   discountType: 'FIXED',      discountValue: 500, minOrderAmount: 2500, usedCount: 34 },
  { code: 'FRESH30',   description: '30% off organic range',    discountType: 'PERCENTAGE', discountValue: 30, maxDiscount: 1000, usedCount: 8 },
];

const BANNERS = [
  { placement: 'HOMEPAGE_HERO', headline: 'Farm-fresh groceries, delivered today', subheadline: 'Hand-picked produce from local farms. Free delivery over £40.', ctaLabel: 'Shop now', linkType: 'NONE', sortOrder: 1, audience: 'ALL' },
  { placement: 'HOMEPAGE_STRIP', headline: '🌿 Organic week — 20% off all organic produce', subheadline: null, ctaLabel: 'Shop organic', linkType: 'NONE', sortOrder: 1, audience: 'ALL' },
  { placement: 'CART_UPSELL', headline: 'Add £10 more for free delivery!', subheadline: 'You\'re so close — top up your cart.', ctaLabel: 'Keep shopping', linkType: 'NONE', sortOrder: 1, audience: 'ALL' },
];

const REVIEW_BODIES = [
  'Absolutely fresh and arrived well-packaged. Will definitely order again!',
  'Great quality, exactly as described. Fast delivery too.',
  'Good product but the packaging could be better. Otherwise satisfied.',
  'This is now a weekly staple in our house. Kids love it!',
  'Delivered on time and everything was in perfect condition.',
  'Slightly smaller than expected but great taste. 4 stars.',
  'Top quality. The freshness is unbeatable compared to the supermarket.',
  'Very happy with the purchase. Prompt delivery and great value.',
  'Lovely product, great for meal prep. Highly recommend.',
  'The organic range is exceptional. Worth every penny.',
];

const ADDRESS = { line1: '21 Borough Market', city: 'London', state: 'England', postalCode: 'SE1 9AB', country: 'GB' };

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nSeeding ECOMMERCE demo data for slug: ${TARGET_SLUG}\n`);

  const business = await p.business.findUnique({ where: { slug: TARGET_SLUG }, select: { id: true, name: true } });
  if (!business) { console.error(`Business "${TARGET_SLUG}" not found`); process.exit(1); }
  const BID = business.id;
  console.log(`Business: ${business.name} (${BID})\n`);

  // ── 1. Location ────────────────────────────────────────────────────────────
  let location = await p.businessLocation.findFirst({ where: { businessId: BID } });
  if (!location) {
    location = await p.businessLocation.create({ data: { businessId: BID, name: 'Main Store — Borough Market', addressLine1: '21 Borough Market', city: 'London', state: 'England', postalCode: 'SE1 9AB', country: 'GB', phone: '+442071234567', isPrimary: true, isActive: true } });
    console.log('  created location:', location.name);
  } else { console.log('  skip  location'); }

  // ── 2. Categories with parent/child ────────────────────────────────────────
  const catBySlug = new Map();
  const existing = await p.productCategory.findMany({ where: { businessId: BID }, select: { id: true, slug: true } });
  existing.forEach(c => catBySlug.set(c.slug, c.id));

  for (const parent of CATEGORY_TREE) {
    if (!catBySlug.has(parent.slug)) {
      const c = await p.productCategory.create({ data: { businessId: BID, name: parent.name, slug: parent.slug, description: `${parent.emoji || ''} ${parent.name} — fresh daily from trusted suppliers`.trim(), sortOrder: parent.sort, isPublished: true } });
      catBySlug.set(c.slug, c.id); console.log(`  created parent category: ${parent.name}`);
    }
    for (const child of (parent.children || [])) {
      if (!catBySlug.has(child.slug)) {
        const c = await p.productCategory.create({ data: { businessId: BID, name: child.name, slug: child.slug, sortOrder: child.sort, isPublished: true, parentId: catBySlug.get(parent.slug) } });
        catBySlug.set(c.slug, c.id); console.log(`    created subcategory: ${child.name}`);
      }
    }
  }

  // ── 3. Customers ───────────────────────────────────────────────────────────
  const hash = await bcrypt.hash('Demo1234!', 10);
  const customerIds = [];
  for (const c of CUSTOMERS) {
    let cust = await p.customer.findFirst({ where: { businessId: BID, email: c.email } });
    if (!cust) {
      cust = await p.customer.create({ data: { businessId: BID, email: c.email, password: hash, name: c.name, phone: c.phone, emailVerified: true } });
      console.log(`  created customer: ${c.name}`);
    }
    customerIds.push(cust.id);
  }

  // ── 4. Orders ─────────────────────────────────────────────────────────────
  const products = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true, name: true, priceMinor: true }, take: 50 });
  if (products.length === 0) { console.log('  no products found — skipping orders'); }
  else {
    const ORDER_SPECS = [
      { status: 'PAID',      daysAgo: 1,  customer: 0, paidAt: true },
      { status: 'PAID',      daysAgo: 2,  customer: 1, paidAt: true },
      { status: 'DELIVERED', daysAgo: 5,  customer: 2, paidAt: true },
      { status: 'DELIVERED', daysAgo: 8,  customer: 3, paidAt: true },
      { status: 'DELIVERED', daysAgo: 12, customer: 4, paidAt: true },
      { status: 'DELIVERED', daysAgo: 15, customer: 5, paidAt: true },
      { status: 'PAID',      daysAgo: 0,  customer: 6, paidAt: true },
      { status: 'PENDING',   daysAgo: 0,  customer: 7, paidAt: false },
      { status: 'PENDING',   daysAgo: 1,  customer: null, paidAt: false },
      { status: 'PENDING',   daysAgo: 1,  customer: null, paidAt: false },
      { status: 'CANCELLED', daysAgo: 3,  customer: 1, paidAt: false },
      { status: 'CANCELLED', daysAgo: 6,  customer: null, paidAt: false },
      { status: 'DELIVERED', daysAgo: 20, customer: 0, paidAt: true },
      { status: 'DELIVERED', daysAgo: 25, customer: 2, paidAt: true },
      { status: 'DELIVERED', daysAgo: 30, customer: 3, paidAt: true },
    ];
    const existingOrderCount = await p.order.count({ where: { businessId: BID } });
    const toCreate = Math.max(0, ORDER_SPECS.length - existingOrderCount);
    const specs = ORDER_SPECS.slice(existingOrderCount, existingOrderCount + toCreate);
    for (const spec of specs) {
      const custIdx = spec.customer;
      const cEmail = custIdx !== null ? CUSTOMERS[custIdx].email : `guest${Math.floor(Math.random()*9000)+1000}@example.com`;
      const cName  = custIdx !== null ? CUSTOMERS[custIdx].name  : 'Guest Customer';
      const items  = [rand(products), rand(products), rand(products)].filter((v,i,a)=>a.findIndex(x=>x.id===v.id)===i).slice(0, 2 + Math.floor(Math.random()*3));
      const subtotal = items.reduce((s, p) => s + p.priceMinor * (1 + Math.floor(Math.random()*2)), 0);
      const shipping = subtotal > 4000 ? 0 : 299;
      const placed = daysAgo(spec.daysAgo);
      const order = await p.order.create({ data: {
        businessId: BID,
        customerId: custIdx !== null ? customerIds[custIdx] : null,
        customerEmail: cEmail, customerName: cName,
        shippingAddress: ADDRESS,
        status: spec.status,
        currency: 'GBP',
        subtotalMinor: subtotal, shippingMinor: shipping, taxMinor: Math.round(subtotal * 0.05), totalMinor: subtotal + shipping + Math.round(subtotal * 0.05),
        paymentProvider: spec.paidAt ? 'STRIPE' : null,
        paymentRef: spec.paidAt ? `pi_demo_${Math.random().toString(36).slice(2,12)}` : null,
        placedAt: placed,
        paidAt: spec.paidAt ? placed : null,
      }});
      const qty = (pr) => 1 + Math.floor(Math.random()*2);
      await p.orderItem.createMany({ data: items.map(pr => { const q = qty(pr); return { orderId: order.id, productId: pr.id, productName: pr.name, quantity: q, priceMinor: pr.priceMinor, lineTotalMinor: pr.priceMinor * q }; }) });
      console.log(`  created order: ${spec.status} (${cName})`);
    }
  }

  // ── 5. Riders ─────────────────────────────────────────────────────────────
  const RIDER_DATA = [
    { fullName: 'Raj Patel',   phone: '+441111111001', vehicleType: 'BIKE',  vehicleReg: 'LN21 ABC', totalDeliveries: 248, onTimeRate: 0.97, avgRating: 4.8 },
    { fullName: 'Sara Jones',  phone: '+441111111002', vehicleType: 'EBIKE', vehicleReg: null,       totalDeliveries: 134, onTimeRate: 0.94, avgRating: 4.6 },
    { fullName: 'Mike Okafor', phone: '+441111111003', vehicleType: 'VAN',   vehicleReg: 'LN71 XYZ', totalDeliveries: 512, onTimeRate: 0.99, avgRating: 4.9 },
  ];
  for (const r of RIDER_DATA) {
    const exists = await p.ecomRider.findFirst({ where: { businessId: BID, phone: r.phone } });
    if (!exists) {
      await p.ecomRider.create({ data: { businessId: BID, ...r, homeLocationId: location.id, status: 'ACTIVE', serviceZones: [] } });
      console.log(`  created rider: ${r.fullName}`);
    }
  }

  // ── 6. Delivery slots (Mon–Sun, 4 per day) ─────────────────────────────────
  const existingSlots = await p.ecomDeliverySlot.count({ where: { businessId: BID } });
  if (existingSlots === 0) {
    const slotDefs = [
      { startTime: '08:00', endTime: '11:00', slotType: 'STANDARD',  surchargeMinor: 0 },
      { startTime: '11:00', endTime: '14:00', slotType: 'STANDARD',  surchargeMinor: 0 },
      { startTime: '14:00', endTime: '18:00', slotType: 'EXPRESS',   surchargeMinor: 199 },
      { startTime: '18:00', endTime: '21:00', slotType: 'SAME_DAY',  surchargeMinor: 299 },
    ];
    for (let dow = 0; dow <= 6; dow++) {
      for (const slot of slotDefs) {
        await p.ecomDeliverySlot.create({ data: { businessId: BID, locationId: location.id, dayOfWeek: dow, ...slot, capacity: 20, isActive: true } });
      }
    }
    console.log('  created 28 delivery slots (4/day × 7 days)');
  } else { console.log('  skip  delivery slots'); }

  // ── 7. Coupons ────────────────────────────────────────────────────────────
  for (const c of COUPONS) {
    const exists = await p.coupon.findFirst({ where: { businessId: BID, code: c.code } });
    if (!exists) {
      await p.coupon.create({ data: { businessId: BID, code: c.code, description: c.description, discountType: c.discountType, discountValue: c.discountValue, minOrderAmount: c.minOrderAmount ?? null, maxDiscount: c.maxDiscount ?? null, maxUsesPerCustomer: c.maxUsesPerCustomer ?? null, usedCount: c.usedCount, validFrom: daysAgo(30), validUntil: daysFromNow(60), applicableServiceIds: [], isActive: true } });
      console.log(`  created coupon: ${c.code}`);
    }
  }

  // ── 8. Banners ────────────────────────────────────────────────────────────
  for (const b of BANNERS) {
    const exists = await p.ecomBanner.findFirst({ where: { businessId: BID, placement: b.placement } });
    if (!exists) {
      await p.ecomBanner.create({ data: { businessId: BID, placement: b.placement, headline: b.headline, subheadline: b.subheadline, ctaLabel: b.ctaLabel, linkType: b.linkType, sortOrder: b.sortOrder, audience: b.audience, startsAt: daysAgo(10), endsAt: daysFromNow(30) } });
      console.log(`  created banner: ${b.placement}`);
    }
  }

  // ── 9. Reviews ────────────────────────────────────────────────────────────
  const existingReviews = await p.ecomReview.count({ where: { businessId: BID } });
  if (existingReviews < 30 && products.length > 0) {
    const orders = await p.order.findMany({ where: { businessId: BID, status: { in: ['PAID','DELIVERED'] } }, select: { id: true, customerId: true, customerName: true, customerEmail: true, items: { select: { productId: true } } }, take: 15 });
    let created = 0;
    for (const order of orders) {
      for (const item of order.items.slice(0, 1)) {
        const already = await p.ecomReview.findFirst({ where: { businessId: BID, productId: item.productId, orderId: order.id } });
        if (!already && created < (30 - existingReviews)) {
          const rating = 3 + Math.floor(Math.random() * 3); // 3-5
          await p.ecomReview.create({ data: { businessId: BID, productId: item.productId, orderId: order.id, customerId: order.customerId, customerName: order.customerName, customerEmail: order.customerEmail, rating, title: rating >= 5 ? 'Excellent!' : rating >= 4 ? 'Really good' : 'Decent product', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: true, helpfulCount: Math.floor(Math.random() * 20) } });
          created++;
        }
      }
    }
    // Extra standalone reviews
    const prodSample = products.slice(0, 10);
    const customerNames = CUSTOMERS.map(c => c.name);
    for (let i = created; i < (30 - existingReviews) && i < 30; i++) {
      const pr = prodSample[i % prodSample.length];
      const rating = 2 + Math.floor(Math.random() * 4);
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: customerNames[i % customerNames.length], rating, body: rand(REVIEW_BODIES), status: i % 5 === 0 ? 'PENDING' : 'PUBLISHED', verifiedBuyer: false, helpfulCount: Math.floor(Math.random() * 10) } });
    }
    console.log(`  created reviews (target: 30)`);
  } else { console.log('  skip  reviews'); }

  // ── 10. Inventory stock + adjustments ────────────────────────────────────
  const existingStocks = await p.inventoryStock.count({ where: { businessId: BID } });
  if (existingStocks === 0 && products.length > 0) {
    const sample = products.slice(0, 20);
    for (const pr of sample) {
      const onHand = 50 + Math.floor(Math.random() * 150);
      const stock = await p.inventoryStock.upsert({
        where: { productId_locationId: { productId: pr.id, locationId: location.id } },
        create: { businessId: BID, productId: pr.id, locationId: location.id, onHand, reorderPoint: 10, reorderQty: 50 },
        update: {},
      });
      await p.inventoryAdjustment.create({ data: { businessId: BID, stockId: stock.id, delta: onHand, reason: 'GRN_RECEIPT', note: 'Initial stock load — demo data', onHandAfter: onHand } });
    }
    console.log('  created inventory stock + adjustments for 20 products');
  } else { console.log('  skip  inventory'); }

  console.log('\n✅ Seeding complete.\n');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
