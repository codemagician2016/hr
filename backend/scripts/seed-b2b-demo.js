#!/usr/bin/env node
// B2B wholesale / distribution demo catalog + theme flip — to look-and-feel the
// bespoke `b2b` storefront theme (volume price-break tiers, MOQ, SKU, specs,
// packaging/logistics, request-a-quote, GST/PO checkout).
//
// Usage:
//   node scripts/seed-b2b-demo.js [slug]
//   node scripts/seed-b2b-demo.js [slug] --create
//
// Idempotent. Populates an existing ECOMMERCE business (default slug: b2b-demo)
// with categories and products whose VARIANTS are order-quantity tiers
// (option1Value = "50 units"; variant.priceMinor = total for that pack, so the
// per-unit price drops with volume). MOQ = smallest tier. Sets
// subscription.theme = 'b2b'. Images default to picsum placeholders.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'b2b-demo').toLowerCase();
const CREATE = args.includes('--create');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent('b2b-' + seed)}/700/700`;

const CATEGORIES = [
  { name: 'Packaging', slug: 'packaging', sort: 1 },
  { name: 'Office Supplies', slug: 'office-supplies', sort: 2 },
  { name: 'Industrial', slug: 'industrial', sort: 3 },
  { name: 'Cleaning & Hygiene', slug: 'cleaning-hygiene', sort: 4 },
  { name: 'Food Service', slug: 'food-service', sort: 5 },
  { name: 'Safety & PPE', slug: 'safety-ppe', sort: 6 },
];

const SUBCATS = { packaging:[['Boxes','b2-boxes'],['Tapes','b2-tapes'],['Wraps','b2-wraps']], 'office-supplies':[['Stationery','b2-stationery'],['Paper','b2-paper']], industrial:[['Tools','b2-tools'],['Fixings','b2-fixings']], 'cleaning-hygiene':[['Cleaners','b2-cleaners'],['Wipes','b2-wipes']], 'food-service':[['Disposables','b2-disposables'],['Containers','b2-containers']], 'safety-ppe':[['Gloves','b2-gloves'],['Masks','b2-masks']] };
const NAME_SUBCAT = { 'Corrugated Shipping Box (Medium)':'b2-boxes','Packing Tape Clear 48mm':'b2-tapes','Bubble Wrap Roll 500mm':'b2-wraps','Stretch Wrap Pallet Film':'b2-wraps','A4 Copier Paper 80gsm':'b2-paper','Ballpoint Pen Blue (Box)':'b2-stationery','Sticky Notes 76mm (Pack)':'b2-stationery','Box File Foolscap (Carton)':'b2-stationery','Industrial Nitrile Gloves (Box)':'b2-fixings','Cable Ties 200mm (Pack of 100)':'b2-fixings','Heavy-Duty Bin Bags (Roll)':'b2-tools','Multi-surface Disinfectant 5L':'b2-cleaners','Hand Soap Refill 5L':'b2-cleaners','Paper Towel Rolls (Case)':'b2-wipes','Microfibre Cloth (Pack of 10)':'b2-wipes','Kraft Food Containers (Case)':'b2-containers','Disposable Cutlery Set (Case)':'b2-disposables','Paper Carry Bags Medium (Bundle)':'b2-disposables','Hi-Vis Safety Vest (Pack)':'b2-gloves','Safety Goggles Clear (Box)':'b2-masks','Disposable Face Mask 3-Ply (Case)':'b2-masks' };

const REVIEW_BODIES = [
  'Consistent quality across every batch. Reordering monthly.',
  'Great trade pricing at volume — beat our previous supplier.',
  'Palletised neatly, dispatched next day as promised.',
  'GST invoice and PO handling were spot on.',
  'Bulk discount kicked in nicely at the higher tier.',
  'Reliable stock and quick reordering. Recommended for trade.',
];

// name, category, brand, sku, highlights[], packaging[[label,value]],
// specGroups[[title,[[k,v]]]], tiers[[units, ₹perUnit]] (ascending units, falling per-unit)
const PRODUCTS = [
  ['Corrugated Shipping Box (Medium)', 'packaging', 'PackPro', 'PKG-CB-3030', ['3-ply kraft board', '305 × 229 × 229 mm', 'FEFCO 0201 style'],
    [['Pack', '25 boxes / bundle'], ['Carton', '100 boxes'], ['Pallet', '1,600 boxes'], ['Weight', '180 g each']],
    [['Specifications', [['Board', '3-ply kraft'], ['Burst strength', '125 psi'], ['Style', 'RSC']]]],
    [[50, 24], [100, 21], [500, 18], [1000, 15]]],
  ['Packing Tape Clear 48mm', 'packaging', 'PackPro', 'PKG-TP-4801', ['Acrylic adhesive', '48 mm × 75 m', 'Low-noise unwind'],
    [['Pack', '6 rolls / sleeve'], ['Carton', '36 rolls'], ['Pallet', '1,440 rolls']],
    [['Specifications', [['Width', '48 mm'], ['Length', '75 m'], ['Thickness', '45 micron']]]],
    [[36, 38], [144, 33], [720, 28], [1440, 24]]],
  ['Bubble Wrap Roll 500mm', 'packaging', 'PackPro', 'PKG-BW-5001', ['10 mm bubbles', '500 mm × 100 m', 'Protective cushioning'],
    [['Pack', '1 roll'], ['Carton', '4 rolls'], ['Pallet', '120 rolls']],
    [['Specifications', [['Width', '500 mm'], ['Length', '100 m'], ['Bubble', '10 mm']]]],
    [[10, 320], [50, 285], [120, 245]]],
  ['Stretch Wrap Pallet Film', 'packaging', 'PackPro', 'PKG-SW-2503', ['23 micron cast film', '500 mm × 300 m', 'High puncture resistance'],
    [['Pack', '6 rolls'], ['Carton', '6 rolls'], ['Pallet', '600 rolls']],
    [['Specifications', [['Width', '500 mm'], ['Length', '300 m'], ['Gauge', '23 micron']]]],
    [[6, 260], [60, 230], [600, 195]]],
  ['A4 Copier Paper 80gsm', 'office-supplies', 'ClearWrite', 'OFF-CP-8001', ['80 gsm bright white', '500 sheets / ream', 'Jam-free guarantee'],
    [['Pack', '1 ream (500 sheets)'], ['Carton', '5 reams'], ['Pallet', '200 reams']],
    [['Specifications', [['Weight', '80 gsm'], ['Brightness', '161 CIE'], ['Size', 'A4']]]],
    [[20, 290], [50, 269], [200, 245], [500, 225]]],
  ['Ballpoint Pen Blue (Box)', 'office-supplies', 'ClearWrite', 'OFF-BP-1002', ['1.0 mm medium tip', 'Smooth oil-based ink', '50 pens / box'],
    [['Pack', '1 box (50 pens)'], ['Carton', '20 boxes'], ['Pallet', '480 boxes']],
    [['Specifications', [['Tip', '1.0 mm'], ['Ink', 'Blue oil-based'], ['Per box', '50']]]],
    [[10, 220], [50, 195], [200, 170]]],
  ['Sticky Notes 76mm (Pack)', 'office-supplies', 'ClearWrite', 'OFF-SN-7603', ['76 × 76 mm', '100 sheets / pad', 'Strong re-stick adhesive'],
    [['Pack', '12 pads'], ['Carton', '48 pads'], ['Pallet', '1,200 pads']],
    [['Specifications', [['Size', '76 × 76 mm'], ['Sheets', '100 / pad'], ['Colour', 'Assorted']]]],
    [[24, 35], [120, 30], [600, 25]]],
  ['Box File Foolscap (Carton)', 'office-supplies', 'ClearWrite', 'OFF-BF-2204', ['Laminated board', '70 mm spine', 'Lever-arch mechanism'],
    [['Pack', '1 file'], ['Carton', '10 files'], ['Pallet', '240 files']],
    [['Specifications', [['Size', 'Foolscap'], ['Spine', '70 mm'], ['Capacity', '500 sheets']]]],
    [[20, 145], [100, 128], [240, 110]]],
  ['Industrial Nitrile Gloves (Box)', 'industrial', 'GripGuard', 'IND-NG-9001', ['5 mil thickness', 'Powder-free', '100 gloves / box'],
    [['Pack', '1 box (100)'], ['Carton', '10 boxes'], ['Pallet', '720 boxes']],
    [['Specifications', [['Material', 'Nitrile'], ['Thickness', '5 mil'], ['Per box', '100']]]],
    [[10, 480], [50, 430], [200, 385], [720, 340]]],
  ['Cable Ties 200mm (Pack of 100)', 'industrial', 'GripGuard', 'IND-CT-2002', ['Nylon 6.6', '200 × 4.8 mm', 'UV stabilised'],
    [['Pack', '100 ties'], ['Carton', '50 packs'], ['Pallet', '2,000 packs']],
    [['Specifications', [['Length', '200 mm'], ['Width', '4.8 mm'], ['Tensile', '22 kg']]]],
    [[20, 95], [100, 82], [500, 68]]],
  ['Heavy-Duty Bin Bags (Roll)', 'industrial', 'GripGuard', 'IND-BB-1203', ['120 L capacity', '100 micron LDPE', '20 bags / roll'],
    [['Pack', '1 roll (20 bags)'], ['Carton', '10 rolls'], ['Pallet', '400 rolls']],
    [['Specifications', [['Capacity', '120 L'], ['Thickness', '100 micron'], ['Per roll', '20']]]],
    [[20, 160], [100, 142], [400, 120]]],
  ['Multi-surface Disinfectant 5L', 'cleaning-hygiene', 'PureClean', 'CLN-DS-5004', ['Kills 99.9% germs', 'Concentrate (1:40)', '5 L jerry can'],
    [['Pack', '1 × 5 L'], ['Carton', '4 × 5 L'], ['Pallet', '180 × 5 L']],
    [['Specifications', [['Volume', '5 L'], ['Dilution', '1:40'], ['Type', 'Concentrate']]]],
    [[4, 540], [40, 485], [180, 425]]],
  ['Hand Soap Refill 5L', 'cleaning-hygiene', 'PureClean', 'CLN-HS-5005', ['Mild pH-balanced', 'Anti-bacterial', '5 L refill'],
    [['Pack', '1 × 5 L'], ['Carton', '2 × 5 L'], ['Pallet', '96 × 5 L']],
    [['Specifications', [['Volume', '5 L'], ['pH', '5.5'], ['Type', 'Anti-bacterial']]]],
    [[2, 620], [20, 560], [96, 495]]],
  ['Paper Towel Rolls (Case)', 'cleaning-hygiene', 'PureClean', 'CLN-PT-2006', ['2-ply absorbent', '100 m / roll', '6 rolls / case'],
    [['Pack', '1 case (6 rolls)'], ['Carton', '6 rolls'], ['Pallet', '240 cases']],
    [['Specifications', [['Ply', '2'], ['Length', '100 m'], ['Per case', '6']]]],
    [[6, 410], [60, 365], [240, 320]]],
  ['Microfibre Cloth (Pack of 10)', 'cleaning-hygiene', 'PureClean', 'CLN-MC-1007', ['300 gsm', 'Lint-free', '40 × 40 cm'],
    [['Pack', '10 cloths'], ['Carton', '20 packs'], ['Pallet', '600 packs']],
    [['Specifications', [['Weight', '300 gsm'], ['Size', '40 × 40 cm'], ['Per pack', '10']]]],
    [[20, 240], [100, 210], [600, 175]]],
  ['Kraft Food Containers (Case)', 'food-service', 'ServeWell', 'FSV-FC-7508', ['Compostable kraft', '750 ml + lid', '300 / case'],
    [['Pack', '1 case (300)'], ['Carton', '300 units'], ['Pallet', '48 cases']],
    [['Specifications', [['Volume', '750 ml'], ['Material', 'Kraft + PLA'], ['Per case', '300']]]],
    [[5, 2400], [20, 2150], [48, 1850]]],
  ['Disposable Cutlery Set (Case)', 'food-service', 'ServeWell', 'FSV-CS-1009', ['CPLA heat-resistant', 'Fork + knife + spoon', '250 sets / case'],
    [['Pack', '1 case (250)'], ['Carton', '250 sets'], ['Pallet', '60 cases']],
    [['Specifications', [['Material', 'CPLA'], ['Heat', 'To 85°C'], ['Per case', '250']]]],
    [[5, 1750], [25, 1550], [60, 1320]]],
  ['Paper Carry Bags Medium (Bundle)', 'food-service', 'ServeWell', 'FSV-CB-2010', ['90 gsm twisted handle', '260 × 350 mm', '250 / bundle'],
    [['Pack', '1 bundle (250)'], ['Carton', '500 bags'], ['Pallet', '8,000 bags']],
    [['Specifications', [['Weight', '90 gsm'], ['Size', '260 × 350 mm'], ['Per bundle', '250']]]],
    [[4, 1100], [20, 980], [80, 840]]],
  ['Hi-Vis Safety Vest (Pack)', 'safety-ppe', 'SafeLine', 'PPE-HV-3011', ['Class 2 retroreflective', 'Hook-and-loop closure', '10 vests / pack'],
    [['Pack', '10 vests'], ['Carton', '50 vests'], ['Pallet', '1,000 vests']],
    [['Specifications', [['Class', 'EN 20471 Cl.2'], ['Tape', 'Retroreflective'], ['Per pack', '10']]]],
    [[10, 185], [50, 165], [200, 140], [1000, 120]]],
  ['Safety Goggles Clear (Box)', 'safety-ppe', 'SafeLine', 'PPE-SG-1012', ['Anti-fog polycarbonate', 'UV protection', '12 / box'],
    [['Pack', '1 box (12)'], ['Carton', '120 units'], ['Pallet', '60 boxes']],
    [['Specifications', [['Lens', 'Polycarbonate'], ['Coating', 'Anti-fog'], ['Per box', '12']]]],
    [[12, 95], [120, 82], [600, 68]]],
  ['Disposable Face Mask 3-Ply (Case)', 'safety-ppe', 'SafeLine', 'PPE-FM-5013', ['3-ply meltblown', 'Earloop, BFE ≥ 95%', '50 / box, 40 boxes / case'],
    [['Pack', '1 box (50)'], ['Carton', '40 boxes'], ['Pallet', '40 cartons']],
    [['Specifications', [['Layers', '3-ply'], ['BFE', '≥ 95%'], ['Per box', '50']]]],
    [[40, 85], [200, 72], [800, 58]]],
];

async function ensureBusiness() {
  let business = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (business) return business;
  if (!CREATE) { console.error(`\nBusiness "${SLUG}" not found. Point at an existing ECOMMERCE tenant slug, or re-run with --create.\n`); process.exit(1); }
  business = await p.business.create({ data: { name: 'TradeHub — Wholesale Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
  console.log(`  created business: ${business.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) { await p.subscription.create({ data: { businessId: business.id, tierId: tier.id, theme: 'b2b' } }); console.log('  created subscription (theme=b2b)'); }
    else console.warn('  ⚠ no plan tier found — skipped subscription; set theme=b2b once the tenant has one');
  } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
  return business;
}

async function main() {
  console.log(`\nSeeding B2B WHOLESALE demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ business vertical is ${business.vertical}, not ECOMMERCE.`);

  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) { if (sub.theme !== 'b2b') { await p.subscription.update({ where: { businessId: BID }, data: { theme: 'b2b' } }); console.log('  set subscription.theme = b2b'); } else console.log('  skip  theme (already b2b)'); }
  else console.warn('  ⚠ no subscription — cannot set theme=b2b.');

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
    const [name, catSlug, brand, sku, highlights, packaging, groupDefs, tiers] = PRODUCTS[i];
    const slug = slugify(name);
    const _leaves = subsByParent[catSlug] || []; let leafId = catBySlug.get(catSlug); const _m = NAME_SUBCAT[name]; if (_m && catBySlug.get(_m)) { leafId = catBySlug.get(_m); } else if (_leaves.length) { const _n = (rr[catSlug] = (rr[catSlug] ?? -1) + 1); leafId = _leaves[_n % _leaves.length]; } const _ex = await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true, categoryId: true } }); if (_ex) { if (_ex.categoryId !== leafId) { await p.product.update({ where: { id: _ex.id }, data: { categoryId: leafId } }); } continue; }

    // Base (product-level) price = top-tier per-unit price, so the headline reads as the best unit rate.
    const minPerUnit = Math.min(...tiers.map(([, per]) => per));
    const maxPerUnit = Math.max(...tiers.map(([, per]) => per));
    const priceMinor = minPerUnit * 100;
    const compareMinor = maxPerUnit * 100;
    const specs = {
      highlights,
      packaging: packaging.map(([label, value]) => ({ label, value })),
      groups: groupDefs.map(([title, rows]) => ({ title, rows: rows.map(([label, value]) => ({ label, value })) })),
    };
    const images = [img(`${slug}-1`), img(`${slug}-2`)];

    const product = await p.product.create({
      data: {
        businessId: BID, categoryId: leafId, name, slug, brand, sku,
        shortDescription: highlights.slice(0, 2).join(' · '),
        description: `${name} by ${brand} (SKU ${sku}). ${highlights.join('. ')}. Volume pricing applies — the more you order, the lower the per-unit price. Minimum order ${tiers[0][0]} units.`,
        priceMinor, comparePriceMinor: compareMinor, currency: 'INR',
        imageUrls: images, specs,
        isPublished: true, isFeatured: i % 5 === 0, sortOrder: i, stockQty: null,
        createdAt: daysAgo(randInt(0, 50)),
      },
      select: { id: true },
    });

    // Each variant is an order-quantity tier: option1Value = "<units> units",
    // priceMinor = total for that pack (units × per-unit). The storefront parses
    // the unit count from option1Value and derives per-unit + MOQ.
    let sortOrder = 0; let first = true;
    for (const [units, perUnit] of tiers) {
      const packTotalMinor = units * perUnit * 100;
      await p.productVariant.create({
        data: {
          productId: product.id, label: `${units} units`,
          priceMinor: packTotalMinor, comparePriceMinor: units * maxPerUnit * 100,
          stockQty: Math.random() < 0.1 ? 0 : randInt(20, 400),
          option1Name: 'Order quantity', option1Value: `${units} units`,
          sortOrder: sortOrder++, isDefault: first, isActive: true,
        },
      });
      first = false;
    }
    createdProducts++;
    console.log(`  created line: ${name} [${sku}] · ${tiers.length} tiers, MOQ ${tiers[0][0]}`);
  }

  const allProducts = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true } });
  let createdReviews = 0;
  for (const pr of allProducts) {
    if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
    const n = randInt(1, 6);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.8 ? randInt(4, 5) : randInt(3, 4);
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(['Procurement', 'Stores', 'Operations', 'Facilities', 'Purchasing']) + ' — ' + rand(['Apex Traders', 'Metro Supplies', 'Unity Foods', 'Crown Retail', 'Delta Works', 'Summit Cafe']), rating, title: rating >= 5 ? 'Great trade supplier' : rating >= 4 ? 'Good value at volume' : 'Decent', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.85 } });
      createdReviews++;
    }
  }

  console.log(`\n✅ B2B wholesale demo seeded — ${createdProducts} new lines, ${createdReviews} reviews.`);
  console.log(`   Open the storefront for "${SLUG}" (theme: b2b) to view it.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
