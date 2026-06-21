#!/usr/bin/env node
// Pharmacy/health demo catalog + theme flip — to look-and-feel the bespoke
// `pharmacy` storefront theme (Rx gating, drug-info sections, pack variants).
//
// Usage:
//   node scripts/seed-pharmacy-demo.js [slug]
//   node scripts/seed-pharmacy-demo.js [slug] --create
//
// Idempotent. Populates an existing ECOMMERCE business (default slug:
// pharmacy-demo) with categories, products (pack-size variants + rx /
// composition / info sections stored in Product.specs), and reviews; sets
// subscription.theme = 'pharmacy'. Info copy is generic/illustrative — not
// medical advice. Images default to picsum placeholders.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'pharmacy-demo').toLowerCase();
const CREATE = args.includes('--create');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent('rx-' + seed)}/700/700`;

const CATEGORIES = [
  { name: 'Medicines', slug: 'medicines', sort: 1 },
  { name: 'Wellness', slug: 'wellness', sort: 2 },
  { name: 'Vitamins & Supplements', slug: 'vitamins', sort: 3 },
  { name: 'Personal Care', slug: 'personal-care', sort: 4 },
  { name: 'Baby Care', slug: 'baby-care', sort: 5 },
  { name: 'Medical Devices', slug: 'devices', sort: 6 },
  { name: 'Health Foods', slug: 'health-foods', sort: 7 },
];

const SUBCATS = { medicines:[['Pain Relief','ph-pain'],['Cold & Flu','ph-cold'],['Digestive','ph-digestive']], wellness:[['Immunity','ph-immunity'],['Sleep & Calm','ph-sleep']], vitamins:[['Daily','ph-daily'],['Minerals','ph-minerals']], 'personal-care':[['Skin','ph-skin'],['Oral','ph-oral']], 'baby-care':[['Feeding','ph-feeding'],['Hygiene','ph-baby-hygiene']], devices:[['Monitors','ph-monitors'],['Supports','ph-supports']], 'health-foods':[['Protein','ph-protein'],['Superfoods','ph-superfoods']] };
const NAME_SUBCAT = { 'Paracetamol 500mg Tablets':'ph-pain','Cetirizine 10mg Tablets':'ph-cold','Antacid Suspension 170ml':'ph-digestive','Cough Syrup 100ml':'ph-cold','Amoxicillin 500mg Capsules':'ph-cold','Azithromycin 500mg Tablets':'ph-cold','Pantoprazole 40mg Tablets':'ph-digestive','ORS Electrolyte Powder':'ph-digestive','Antiseptic Liquid 100ml':'ph-immunity','Hand Sanitizer 500ml':'ph-immunity','Vitamin C 1000mg Tablets':'ph-daily','Vitamin D3 60K Capsules':'ph-daily','Daily Multivitamin Tablets':'ph-daily','Calcium + D3 Tablets':'ph-minerals','Omega-3 Fish Oil Capsules':'ph-minerals','Moisturising Lotion 200ml':'ph-skin','Sunscreen SPF 50 PA+++':'ph-skin','Baby Diapers (Medium)':'ph-feeding','Gentle Baby Lotion 200ml':'ph-baby-hygiene','Digital Thermometer':'ph-monitors','Pulse Oximeter':'ph-monitors','Crepe Bandage 10cm':'ph-supports','Whey Protein 1kg (Chocolate)':'ph-protein','Plant Protein 1kg':'ph-protein' };

const REVIEW_BODIES = [
  'Genuine product, well packaged and delivered on time.',
  'Exactly as described. The pharmacist even called to confirm my order.',
  'Good price and quick delivery. Will reorder.',
  'Authentic and sealed. Reliable service.',
  'Easy to order and prescription verification was smooth.',
  'Reasonably priced and arrived quickly. Recommended.',
];

function sections(uses, directions, extra) {
  const list = [
    { title: 'Uses', body: uses },
    { title: 'How to use', body: directions || 'Use as directed by your physician or as per the label. Do not exceed the recommended dose.' },
    { title: 'Safety information', body: 'Inform your doctor about any allergies or other medicines you are taking. Consult a doctor if symptoms persist or worsen. Keep out of reach of children.' },
    { title: 'Storage', body: 'Store in a cool, dry place away from direct sunlight, unless the label states otherwise.' },
  ];
  if (extra) list.splice(1, 0, extra);
  return list;
}

// name, category, brand, ₹price, ₹MRP|null, rx, composition|null, packs[[label,add]], uses, directions
const PRODUCTS = [
  ['Paracetamol 500mg Tablets', 'medicines', 'Medico', 35, 45, false, 'Paracetamol 500 mg', [['Strip of 10', 0], ['Strip of 15', 12]], 'Helps relieve mild to moderate pain and reduce fever.', 'Take with water as needed, as per the label. Do not exceed the maximum daily dose.'],
  ['Cetirizine 10mg Tablets', 'medicines', 'Medico', 29, 39, false, 'Cetirizine 10 mg', [['Strip of 10', 0]], 'An antihistamine used to relieve allergy symptoms such as sneezing and a runny nose.', 'Usually taken once daily or as advised. May cause drowsiness.'],
  ['Antacid Suspension 170ml', 'medicines', 'ReliefCo', 89, 110, false, 'Magnesium & Aluminium Hydroxide', [['Bottle 170ml', 0]], 'Provides relief from acidity, heartburn and indigestion.', 'Shake well before use. Take as directed on the label.'],
  ['Cough Syrup 100ml', 'medicines', 'ReliefCo', 95, 120, false, 'Dextromethorphan-based syrup', [['Bottle 100ml', 0]], 'Helps soothe dry, irritating cough.', 'Use the measuring cap provided. Follow the directions on the label.'],
  ['Amoxicillin 500mg Capsules', 'medicines', 'CureLab', 119, 145, true, 'Amoxicillin 500 mg', [['Strip of 10', 0]], 'An antibiotic used to treat certain bacterial infections.', 'Take exactly as prescribed by your doctor. Complete the full course.'],
  ['Azithromycin 500mg Tablets', 'medicines', 'CureLab', 99, 129, true, 'Azithromycin 500 mg', [['Strip of 3', 0]], 'An antibiotic used to treat a range of bacterial infections.', 'Take exactly as prescribed by your doctor.'],
  ['Pantoprazole 40mg Tablets', 'medicines', 'CureLab', 79, 99, true, 'Pantoprazole 40 mg', [['Strip of 15', 0]], 'Reduces stomach acid; used for acidity-related conditions.', 'Usually taken before a meal, as prescribed by your doctor.'],
  ['ORS Electrolyte Powder', 'wellness', 'HydraPlus', 25, 30, false, 'Oral Rehydration Salts', [['Pack of 5 sachets', 0], ['Pack of 10 sachets', 22]], 'Helps replace fluids and electrolytes lost during dehydration.', 'Dissolve one sachet in the stated amount of clean drinking water.'],
  ['Antiseptic Liquid 100ml', 'wellness', 'HydraPlus', 65, 80, false, 'Antiseptic solution', [['Bottle 100ml', 0], ['Bottle 250ml', 70]], 'For first-aid cleansing of minor cuts and grazes.', 'For external use only. Dilute as directed on the label.'],
  ['Hand Sanitizer 500ml', 'wellness', 'HydraPlus', 99, 149, false, 'Ethyl alcohol 70%', [['Bottle 500ml', 0]], 'Kills germs without water; for hand hygiene on the go.', 'Apply enough to cover hands and rub until dry. For external use only.'],
  ['Vitamin C 1000mg Tablets', 'vitamins', 'NutraWell', 159, 199, false, 'Ascorbic Acid 1000 mg', [['Bottle of 30', 0], ['Bottle of 60', 130]], 'Supports immunity and helps reduce tiredness and fatigue.', 'Take one tablet daily with water, or as advised.'],
  ['Vitamin D3 60K Capsules', 'vitamins', 'NutraWell', 129, 165, false, 'Cholecalciferol 60000 IU', [['Strip of 4', 0]], 'Supports bone health and helps maintain vitamin D levels.', 'Take as advised by your doctor.'],
  ['Daily Multivitamin Tablets', 'vitamins', 'NutraWell', 249, 320, false, 'Multivitamins & Minerals', [['Bottle of 30', 0], ['Bottle of 60', 200]], 'A daily blend of essential vitamins and minerals.', 'Take one tablet daily after a meal.'],
  ['Calcium + D3 Tablets', 'vitamins', 'NutraWell', 179, 220, false, 'Calcium Carbonate + Vitamin D3', [['Bottle of 30', 0]], 'Supports bone and muscle health.', 'Take one tablet daily or as advised.'],
  ['Omega-3 Fish Oil Capsules', 'vitamins', 'NutraWell', 399, 499, false, 'Omega-3 (EPA + DHA)', [['Bottle of 60', 0]], 'Supports heart and brain health.', 'Take one to two capsules daily with food.'],
  ['Moisturising Lotion 200ml', 'personal-care', 'DermaSoft', 175, 220, false, null, [['Bottle 200ml', 0], ['Bottle 400ml', 140]], 'Daily moisturiser for soft, hydrated skin.', 'Apply to clean skin as needed. For external use only.'],
  ['Sunscreen SPF 50 PA+++', 'personal-care', 'DermaSoft', 299, 399, false, null, [['Tube 50ml', 0]], 'Broad-spectrum sun protection for daily use.', 'Apply generously 15 minutes before sun exposure; reapply as needed.'],
  ['Baby Diapers (Medium)', 'baby-care', 'TinyCare', 449, 599, false, null, [['Pack of 30', 0], ['Pack of 60', 380]], 'Soft, absorbent diapers with a comfortable fit.', 'Change regularly to keep your baby dry and comfortable.'],
  ['Gentle Baby Lotion 200ml', 'baby-care', 'TinyCare', 159, 199, false, null, [['Bottle 200ml', 0]], 'Mild, moisturising lotion for delicate baby skin.', 'Apply gently to clean skin. For external use only.'],
  ['Digital Thermometer', 'devices', 'MediTech', 199, 299, false, null, [['1 unit', 0]], 'Fast, accurate body-temperature measurement.', 'Follow the device manual for correct use and cleaning.'],
  ['Pulse Oximeter', 'devices', 'MediTech', 899, 1299, false, null, [['1 unit', 0]], 'Measures blood-oxygen saturation (SpO2) and pulse rate at home.', 'Place on a fingertip and read as per the device manual.'],
  ['Crepe Bandage 10cm', 'devices', 'MediTech', 99, 129, false, null, [['1 roll', 0], ['Pack of 3', 180]], 'Provides support and compression for sprains and strains.', 'Wrap firmly but not too tight, as directed.'],
  ['Whey Protein 1kg (Chocolate)', 'health-foods', 'FitFuel', 1799, 2199, false, 'Whey protein concentrate', [['1 kg', 0], ['2 kg', 1500]], 'High-protein supplement to support muscle recovery and fitness.', 'Mix one scoop with water or milk, once or twice daily.'],
  ['Plant Protein 1kg', 'health-foods', 'FitFuel', 1599, 1999, false, 'Pea & rice protein blend', [['1 kg', 0]], 'Vegan protein blend for everyday nutrition.', 'Mix one scoop with water or a beverage of choice.'],
];

async function ensureBusiness() {
  let business = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (business) return business;
  if (!CREATE) { console.error(`\nBusiness "${SLUG}" not found. Point at an existing ECOMMERCE tenant slug, or re-run with --create.\n`); process.exit(1); }
  business = await p.business.create({ data: { name: 'CarePlus — Pharmacy Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
  console.log(`  created business: ${business.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) { await p.subscription.create({ data: { businessId: business.id, tierId: tier.id, theme: 'pharmacy' } }); console.log('  created subscription (theme=pharmacy)'); }
    else console.warn('  ⚠ no plan tier found — skipped subscription; set theme=pharmacy once the tenant has one');
  } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
  return business;
}

async function main() {
  console.log(`\nSeeding PHARMACY demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ business vertical is ${business.vertical}, not ECOMMERCE.`);

  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) { if (sub.theme !== 'pharmacy') { await p.subscription.update({ where: { businessId: BID }, data: { theme: 'pharmacy' } }); console.log('  set subscription.theme = pharmacy'); } else console.log('  skip  theme (already pharmacy)'); }
  else console.warn('  ⚠ no subscription — cannot set theme=pharmacy.');

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
    const [name, catSlug, brand, price, mrp, rx, composition, packs, uses, directions] = PRODUCTS[i];
    const slug = slugify(name);
    const _leaves = subsByParent[catSlug] || []; let leafId = catBySlug.get(catSlug); const _m = NAME_SUBCAT[name]; if (_m && catBySlug.get(_m)) { leafId = catBySlug.get(_m); } else if (_leaves.length) { const _n = (rr[catSlug] = (rr[catSlug] ?? -1) + 1); leafId = _leaves[_n % _leaves.length]; } const _ex = await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true, categoryId: true } }); if (_ex) { if (_ex.categoryId !== leafId) { await p.product.update({ where: { id: _ex.id }, data: { categoryId: leafId } }); } continue; }

    const priceMinor = price * 100;
    const compareMinor = mrp ? mrp * 100 : null;
    const specs = { rx, saltComposition: composition || null, sections: sections(uses, directions) };
    const images = [img(`${slug}-1`), img(`${slug}-2`)];

    const product = await p.product.create({
      data: {
        businessId: BID, categoryId: leafId, name, slug, brand,
        shortDescription: composition || uses,
        description: uses,
        priceMinor, comparePriceMinor: compareMinor, currency: 'INR',
        imageUrls: images, specs,
        isPublished: true, isFeatured: i % 5 === 0, sortOrder: i, stockQty: null,
        createdAt: daysAgo(randInt(0, 50)),
      },
      select: { id: true },
    });

    let sortOrder = 0; let first = true;
    for (const [packLabel, addRupees] of packs) {
      const add = (addRupees || 0) * 100;
      await p.productVariant.create({
        data: {
          productId: product.id, label: packLabel,
          priceMinor: priceMinor + add, comparePriceMinor: compareMinor != null ? compareMinor + add : null,
          stockQty: Math.random() < 0.08 ? 0 : randInt(10, 80),
          option1Name: 'Pack', option1Value: packLabel,
          sortOrder: sortOrder++, isDefault: first, isActive: true,
        },
      });
      first = false;
    }
    createdProducts++;
    console.log(`  created product: ${name}${rx ? ' (℞)' : ''}`);
  }

  const allProducts = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true } });
  let createdReviews = 0;
  for (const pr of allProducts) {
    if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
    const n = randInt(1, 7);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.8 ? randInt(4, 5) : randInt(3, 4);
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(['Suresh', 'Anita', 'Mohan', 'Kavya', 'Deepak', 'Lata', 'Imran', 'Geeta']) + ' ' + rand(['S.', 'K.', 'M.', 'R.']), rating, title: rating >= 5 ? 'Excellent' : rating >= 4 ? 'Good' : 'Okay', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.8 } });
      createdReviews++;
    }
  }

  console.log(`\n✅ Pharmacy demo seeded — ${createdProducts} new products, ${createdReviews} reviews.`);
  console.log(`   Open the storefront for "${SLUG}" (theme: pharmacy) to view it.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
