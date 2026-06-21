#!/usr/bin/env node
// Hardware / auto-parts demo catalog + theme flip — to look-and-feel the
// bespoke `hardware` storefront theme (part numbers, fitment checker, specs,
// compare).
//
// Usage:
//   node scripts/seed-hardware-demo.js [slug]
//   node scripts/seed-hardware-demo.js [slug] --create
//
// Idempotent. Populates an existing ECOMMERCE business (default slug:
// hardware-demo) with categories, products (part number on Product.sku +
// fitment/specs in Product.specs + option variants), and reviews; sets
// subscription.theme = 'hardware'. Images default to picsum placeholders.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'hardware-demo').toLowerCase();
const CREATE = args.includes('--create');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent('hw-' + seed)}/700/700`;

const CATEGORIES = [
  { name: 'Engine Parts', slug: 'engine-parts', sort: 1 },
  { name: 'Brakes', slug: 'brakes', sort: 2 },
  { name: 'Filters', slug: 'filters', sort: 3 },
  { name: 'Electrical & Lighting', slug: 'electrical', sort: 4 },
  { name: 'Suspension & Steering', slug: 'suspension', sort: 5 },
  { name: 'Tools', slug: 'tools', sort: 6 },
  { name: 'Fasteners', slug: 'fasteners', sort: 7 },
  { name: 'Lubricants & Fluids', slug: 'lubricants', sort: 8 },
  { name: 'Tyres & Wheels', slug: 'tyres', sort: 9 },
];

// Sub-categories; products are round-robined onto leaves within their parent.
const SUBCATS = {
  'engine-parts': [['Pistons & Rings', 'engine-pistons'], ['Belts & Chains', 'engine-belts'], ['Gaskets', 'engine-gaskets']],
  brakes: [['Pads', 'brake-pads'], ['Discs', 'brake-discs'], ['Calipers', 'brake-calipers']],
  filters: [['Air', 'filter-air'], ['Oil', 'filter-oil'], ['Fuel', 'filter-fuel']],
  electrical: [['Batteries', 'elec-batteries'], ['Bulbs', 'elec-bulbs'], ['Sensors', 'elec-sensors']],
  suspension: [['Shocks', 'susp-shocks'], ['Bushings', 'susp-bushings'], ['Arms', 'susp-arms']],
  tools: [['Hand Tools', 'tools-hand'], ['Power Tools', 'tools-power']],
  fasteners: [['Bolts', 'fast-bolts'], ['Clips', 'fast-clips']],
  lubricants: [['Engine Oil', 'lub-oil'], ['Coolant', 'lub-coolant']],
  tyres: [['Tyres', 'tyres-tyres'], ['Wheels', 'tyres-wheels']],
};
const NAME_SUBCAT = {
  'Front Brake Pad Set': 'brake-pads', 'Rear Brake Shoe Set': 'brake-pads', 'Brake Disc Rotor (Vented)': 'brake-discs',
  'Spark Plug (Iridium)': 'engine-pistons', 'Timing Belt Kit': 'engine-belts', 'Clutch Plate': 'engine-pistons', 'Radiator Assembly': 'engine-gaskets',
  'Engine Oil Filter': 'filter-oil', 'Air Filter Element': 'filter-air', 'Cabin AC Filter': 'filter-air',
  'LED Headlight Bulb H4': 'elec-bulbs', 'Wiper Blade Set 22"+16"': 'elec-sensors', 'Car Battery 35Ah': 'elec-batteries',
  'Front Shock Absorber': 'susp-shocks', 'Control Arm (Lower)': 'susp-arms',
  'Socket Wrench Set 40pc': 'tools-hand', 'Cordless Drill 18V': 'tools-power', 'Digital Tyre Inflator': 'tools-power',
  'Hex Bolt M8 (Pack of 50)': 'fast-bolts',
  'Engine Oil 5W-30 Synthetic': 'lub-oil', 'Coolant Concentrate': 'lub-coolant', 'Multi-purpose Grease 500g': 'lub-oil',
};

const REVIEW_BODIES = [
  'Exact fit, genuine part. Fitted in minutes.',
  'Good quality and matched the part number perfectly.',
  'Fast dispatch, well packaged. Works great.',
  'OEM quality at a better price. Recommended.',
  'Correct fitment for my vehicle. No issues.',
  'Solid build. Has held up well so far.',
];

// name, category, brand, ₹price, ₹MRP|null, sku, fitment[], highlights[], groupDefs[[title,[[k,v]]]], options[[label,add]]
const PRODUCTS = [
  ['Front Brake Pad Set', 'brakes', 'StopTech', 1299, 1699, 'BRK-FP-1042', ['Maruti Swift 2011–2018', 'Maruti Baleno 2015–2023', 'Maruti Dzire 2012–2020'],
    ['Low-dust ceramic compound', 'Includes wear-indicator', 'Position: Front axle'],
    [['Specifications', [['Position', 'Front'], ['Material', 'Ceramic'], ['Pads per set', '4']]], ['Fitment', [['Axle', 'Front'], ['Type', 'Disc brake']]]], [['Standard', 0]]],
  ['Rear Brake Shoe Set', 'brakes', 'StopTech', 899, 1199, 'BRK-BS-2030', ['Maruti Alto 2012–2022', 'Maruti WagonR 2010–2019'],
    ['Bonded lining', 'Position: Rear drum', 'OE-spec friction'],
    [['Specifications', [['Position', 'Rear'], ['Type', 'Drum'], ['Shoes per set', '2']]]], [['Standard', 0]]],
  ['Brake Disc Rotor (Vented)', 'brakes', 'StopTech', 2199, 2799, 'BRK-DR-3310', ['Hyundai i20 2014–2023', 'Hyundai Verna 2017–2023'],
    ['Vented for cooler running', 'Anti-corrosion coating', 'Sold individually'],
    [['Specifications', [['Diameter', '256 mm'], ['Type', 'Vented'], ['Sold as', 'Each']]]], [['Standard', 0]]],
  ['Spark Plug (Iridium)', 'engine-parts', 'IgniteMax', 349, 499, 'ENG-SP-7781', ['Honda City 2014–2023', 'Honda Amaze 2013–2022'],
    ['Iridium tip for long life', 'Improved cold start', 'Pre-gapped'],
    [['Specifications', [['Electrode', 'Iridium'], ['Gap', '1.0 mm'], ['Thread', 'M14']]]], [['Single', 0], ['Set of 4', 1050]]],
  ['Timing Belt Kit', 'engine-parts', 'DriveLine', 3499, 4299, 'ENG-TB-5520', ['Maruti Swift 2011–2017', 'Maruti Ertiga 2012–2018'],
    ['Belt + tensioner + idler', 'OE rubber compound', 'Complete kit'],
    [['Kit contents', [['Belt', '1'], ['Tensioner', '1'], ['Idler pulley', '1']]]], [['Standard', 0]]],
  ['Clutch Plate', 'engine-parts', 'DriveLine', 2899, 3599, 'ENG-CP-4410', ['Maruti Alto 2012–2022', 'Maruti Celerio 2014–2021'],
    ['Organic friction facing', 'Balanced for smooth take-up'],
    [['Specifications', [['Diameter', '190 mm'], ['Splines', '21']]]], [['Standard', 0]]],
  ['Radiator Assembly', 'engine-parts', 'CoolFlow', 4299, 5499, 'ENG-RAD-9001', ['Hyundai i10 2010–2019'],
    ['Aluminium core', 'Direct-fit replacement', 'Leak-tested'],
    [['Specifications', [['Core', 'Aluminium'], ['Rows', '1'], ['Fit', 'Direct']]]], [['Standard', 0]]],
  ['Engine Oil Filter', 'filters', 'PureFlow', 199, 279, 'FLT-OF-1120', ['Maruti Swift 2011–2023', 'Maruti Baleno 2015–2023', 'Maruti Dzire 2012–2023'],
    ['High dirt-holding media', 'Anti-drainback valve'],
    [['Specifications', [['Type', 'Spin-on'], ['Thread', 'M20']]]], [['Standard', 0]]],
  ['Air Filter Element', 'filters', 'PureFlow', 349, 449, 'FLT-AF-2240', ['Honda City 2014–2023', 'Honda Jazz 2015–2022'],
    ['Pleated paper media', 'Improves airflow', 'Direct fit'],
    [['Specifications', [['Type', 'Panel'], ['Media', 'Paper']]]], [['Standard', 0]]],
  ['Cabin AC Filter', 'filters', 'PureFlow', 299, 399, 'FLT-CF-3360', ['Hyundai Creta 2015–2023', 'Hyundai Venue 2019–2023'],
    ['Activated-carbon layer', 'Traps dust & pollen'],
    [['Specifications', [['Type', 'Carbon'], ['Fit', 'Direct']]]], [['Standard', 0]]],
  ['LED Headlight Bulb H4', 'electrical', 'BrightBeam', 1199, 1599, 'ELE-HL-6620', ['Universal H4 fitment'],
    ['6000K cool white', 'Plug-and-play', 'Sold as pair'],
    [['Specifications', [['Base', 'H4'], ['Colour temp', '6000K'], ['Sold as', 'Pair']]]], [['Standard', 0]]],
  ['Wiper Blade Set 22"+16"', 'electrical', 'ClearView', 699, 899, 'ELE-WB-7710', ['Maruti Swift 2011–2023', 'Hyundai i20 2014–2023'],
    ['All-weather rubber', 'Aero design', 'Multi-adapter'],
    [['Specifications', [['Sizes', '22" + 16"'], ['Type', 'Flat']]]], [['Standard', 0]]],
  ['Car Battery 35Ah', 'electrical', 'VoltCell', 4499, 5499, 'ELE-BAT-8800', ['Maruti Swift', 'Hyundai i10', 'Honda Amaze'],
    ['Maintenance-free', '48-month warranty', 'High cranking amps'],
    [['Specifications', [['Capacity', '35 Ah'], ['CCA', '320'], ['Warranty', '48 months']]]], [['Standard', 0]]],
  ['Front Shock Absorber', 'suspension', 'RideSmooth', 1899, 2399, 'SUS-SA-1190', ['Maruti WagonR 2010–2019', 'Maruti Alto 2012–2022'],
    ['Twin-tube gas-charged', 'Position: Front', 'Sold individually'],
    [['Specifications', [['Position', 'Front'], ['Type', 'Gas'], ['Sold as', 'Each']]]], [['Standard', 0]]],
  ['Control Arm (Lower)', 'suspension', 'RideSmooth', 2299, 2899, 'SUS-CA-2280', ['Hyundai i20 2014–2023'],
    ['Pressed-steel arm', 'Bush + ball joint included', 'Position: Front lower'],
    [['Specifications', [['Position', 'Front lower'], ['Includes', 'Bush + ball joint']]]], [['Left', 0], ['Right', 0]]],
  ['Socket Wrench Set 40pc', 'tools', 'GripPro', 1499, 1999, 'TLS-SS-4001', [],
    ['Chrome-vanadium steel', '1/4" & 3/8" drive', 'Blow-moulded case'],
    [['Specifications', [['Pieces', '40'], ['Material', 'Cr-V'], ['Drive', '1/4" + 3/8"']]]], [['Standard', 0]]],
  ['Cordless Drill 18V', 'tools', 'GripPro', 3499, 4499, 'TLS-CD-5002', [],
    ['18V Li-ion', '2-speed gearbox', 'Includes battery + charger'],
    [['Specifications', [['Voltage', '18V'], ['Chuck', '13 mm'], ['Battery', '2.0 Ah Li-ion']]]], [['Standard', 0]]],
  ['Digital Tyre Inflator', 'tools', 'GripPro', 1799, 2299, 'TLS-TI-6003', [],
    ['Auto cut-off', 'Digital gauge', '12V plug'],
    [['Specifications', [['Max pressure', '120 psi'], ['Power', '12V DC']]]], [['Standard', 0]]],
  ['Hex Bolt M8 (Pack of 50)', 'fasteners', 'FastenIt', 299, 399, 'FST-HB-7050', [],
    ['Grade 8.8 zinc-plated', 'M8 × 25 mm', 'Pack of 50'],
    [['Specifications', [['Size', 'M8 × 25'], ['Grade', '8.8'], ['Qty', '50']]]], [['M8×25', 0], ['M8×40', 60]]],
  ['Engine Oil 5W-30 Synthetic', 'lubricants', 'LubeMax', 1899, 2399, 'LUB-EO-9030', ['Petrol & diesel engines (check manual)'],
    ['Fully synthetic', 'API SP / ACEA', 'Extended drain'],
    [['Specifications', [['Grade', '5W-30'], ['Spec', 'API SP'], ['Type', 'Fully synthetic']]]], [['1 L', 0], ['4 L', 1400]]],
  ['Coolant Concentrate', 'lubricants', 'LubeMax', 349, 449, 'LUB-CO-9110', [],
    ['Ethylene-glycol based', 'Corrosion inhibitors', 'Dilute before use'],
    [['Specifications', [['Type', 'Concentrate'], ['Colour', 'Green']]]], [['1 L', 0], ['5 L', 1300]]],
  ['Multi-purpose Grease 500g', 'lubricants', 'LubeMax', 249, 329, 'LUB-GR-9220', [],
    ['Lithium-based', 'High drop point', 'Water resistant'],
    [['Specifications', [['Base', 'Lithium'], ['NLGI', '2']]]], [['Standard', 0]]],
];

async function ensureBusiness() {
  let business = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (business) return business;
  if (!CREATE) { console.error(`\nBusiness "${SLUG}" not found. Point at an existing ECOMMERCE tenant slug, or re-run with --create.\n`); process.exit(1); }
  business = await p.business.create({ data: { name: 'PartWorks — Hardware Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
  console.log(`  created business: ${business.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) { await p.subscription.create({ data: { businessId: business.id, tierId: tier.id, theme: 'hardware' } }); console.log('  created subscription (theme=hardware)'); }
    else console.warn('  ⚠ no plan tier found — skipped subscription; set theme=hardware once the tenant has one');
  } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
  return business;
}

async function main() {
  console.log(`\nSeeding HARDWARE demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ business vertical is ${business.vertical}, not ECOMMERCE.`);

  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) { if (sub.theme !== 'hardware') { await p.subscription.update({ where: { businessId: BID }, data: { theme: 'hardware' } }); console.log('  set subscription.theme = hardware'); } else console.log('  skip  theme (already hardware)'); }
  else console.warn('  ⚠ no subscription — cannot set theme=hardware.');

  const catBySlug = new Map();
  for (const c of CATEGORIES) {
    let row = await p.productCategory.findFirst({ where: { businessId: BID, slug: c.slug }, select: { id: true } });
    if (!row) { row = await p.productCategory.create({ data: { businessId: BID, name: c.name, slug: c.slug, sortOrder: c.sort, isPublished: true, imageUrl: img(`cat-${c.slug}`) }, select: { id: true } }); console.log(`  created category: ${c.name}`); }
    catBySlug.set(c.slug, row.id);
  }

  const subsByParent = {};
  for (const [parentSlug, subs] of Object.entries(SUBCATS)) {
    const parentId = catBySlug.get(parentSlug);
    if (!parentId) continue;
    const leaves = []; let s = 1;
    for (const [name, sslug] of subs) {
      let row = await p.productCategory.findFirst({ where: { businessId: BID, slug: sslug }, select: { id: true, parentId: true } });
      if (!row) { row = await p.productCategory.create({ data: { businessId: BID, name, slug: sslug, parentId, sortOrder: s, isPublished: true, imageUrl: img(`cat-${sslug}`) }, select: { id: true, parentId: true } }); console.log(`    created sub-category: ${parentSlug} › ${name}`); }
      else if (row.id !== parentId && row.parentId !== parentId) { await p.productCategory.update({ where: { id: row.id }, data: { parentId } }); }
      catBySlug.set(sslug, row.id); leaves.push(row.id); s++;
    }
    subsByParent[parentSlug] = leaves;
  }
  const rr = {};

  let createdProducts = 0;
  for (let i = 0; i < PRODUCTS.length; i++) {
    const [name, catSlug, brand, price, mrp, sku, fitment, highlights, groupDefs, options] = PRODUCTS[i];
    const slug = slugify(name);
    const leaves = subsByParent[catSlug] || [];
    let leafId = catBySlug.get(catSlug);
    const _m = NAME_SUBCAT[name];
    if (_m && catBySlug.get(_m)) { leafId = catBySlug.get(_m); }
    else if (leaves.length) { const n = (rr[catSlug] = (rr[catSlug] ?? -1) + 1); leafId = leaves[n % leaves.length]; }
    const existing = await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true, categoryId: true } });
    if (existing) { if (existing.categoryId !== leafId) { await p.product.update({ where: { id: existing.id }, data: { categoryId: leafId } }); } continue; }

    const priceMinor = price * 100;
    const compareMinor = mrp ? mrp * 100 : null;
    const specs = { highlights, fitment, groups: groupDefs.map(([title, rows]) => ({ title, rows: rows.map(([label, value]) => ({ label, value })) })) };
    const images = [img(`${slug}-1`), img(`${slug}-2`)];

    const product = await p.product.create({
      data: {
        businessId: BID, categoryId: leafId, name, slug, brand, sku,
        shortDescription: highlights.slice(0, 2).join(' · '),
        description: `${name} by ${brand} (Part #${sku}). ${highlights.join('. ')}.${fitment.length ? ' Always confirm fitment for your exact vehicle/model.' : ''}`,
        priceMinor, comparePriceMinor: compareMinor, currency: 'INR',
        imageUrls: images, specs,
        isPublished: true, isFeatured: i % 5 === 0, sortOrder: i, stockQty: null,
        createdAt: daysAgo(randInt(0, 50)),
      },
      select: { id: true },
    });

    let sortOrder = 0; let first = true;
    for (const [optLabel, addRupees] of options) {
      const add = (addRupees || 0) * 100;
      await p.productVariant.create({
        data: {
          productId: product.id, label: optLabel,
          priceMinor: priceMinor + add, comparePriceMinor: compareMinor != null ? compareMinor + add : null,
          stockQty: Math.random() < 0.12 ? 0 : randInt(3, 60),
          option1Name: 'Option', option1Value: optLabel,
          sortOrder: sortOrder++, isDefault: first, isActive: true,
        },
      });
      first = false;
    }
    createdProducts++;
    console.log(`  created part: ${name} [#${sku}]`);
  }

  const allProducts = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true } });
  let createdReviews = 0;
  for (const pr of allProducts) {
    if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
    const n = randInt(1, 7);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.8 ? randInt(4, 5) : randInt(3, 4);
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(['Ramesh', 'Arvind', 'Sunil', 'Manoj', 'Naveen', 'Faisal', 'Joseph', 'Harpreet']) + ' ' + rand(['S.', 'K.', 'M.', 'R.']), rating, title: rating >= 5 ? 'Perfect fit' : rating >= 4 ? 'Good part' : 'Okay', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.8 } });
      createdReviews++;
    }
  }

  console.log(`\n✅ Hardware demo seeded — ${createdProducts} new parts, ${createdReviews} reviews.`);
  console.log(`   Open the storefront for "${SLUG}" (theme: hardware) to view it.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
