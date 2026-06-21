#!/usr/bin/env node
// Electronics/gadgets demo catalog + theme flip — to look-and-feel the bespoke
// `electronics` storefront theme (specs, compare, variants, EMI) with realistic
// data.
//
// Usage:
//   node scripts/seed-electronics-demo.js [slug]
//   node scripts/seed-electronics-demo.js [slug] --create     # create tenant if missing
//
// Idempotent. Populates an existing ECOMMERCE business (default slug:
// electronics-demo) with categories, products (config × colour variants +
// structured specs), and published reviews, and sets subscription.theme =
// 'electronics'. With --create it creates a minimal tenant (needs a plan tier).
//
// Images default to picsum placeholders (guaranteed to load); swap img() for
// real product shots in production.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'electronics-demo').toLowerCase();
const CREATE = args.includes('--create');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent('el-' + seed)}/900/900`;

const CATEGORIES = [
  { name: 'Mobiles', slug: 'mobiles', sort: 1 },
  { name: 'Laptops', slug: 'laptops', sort: 2 },
  { name: 'Audio', slug: 'audio', sort: 3 },
  { name: 'Televisions', slug: 'televisions', sort: 4 },
  { name: 'Wearables', slug: 'wearables', sort: 5 },
  { name: 'Cameras', slug: 'cameras', sort: 6 },
  { name: 'Gaming', slug: 'gaming', sort: 7 },
  { name: 'Accessories', slug: 'accessories', sort: 8 },
];

// Sub-categories (parent slug → [[name, slug]]) + per-product placement.
const SUBCATS = {
  mobiles: [['Flagship', 'mob-flagship'], ['Mid-range', 'mob-midrange'], ['Budget', 'mob-budget']],
  laptops: [['Ultrabooks', 'lap-ultrabooks'], ['Creator', 'lap-creator']],
  audio: [['Earbuds', 'audio-earbuds'], ['Headphones', 'audio-headphones'], ['Speakers', 'audio-speakers']],
  televisions: [['QLED', 'tv-qled'], ['LED', 'tv-led']],
  wearables: [['Smartwatches', 'wear-smartwatches'], ['Fitness Bands', 'wear-bands'], ['Earbuds', 'wear-earbuds']],
  cameras: [['Mirrorless', 'cam-mirrorless'], ['Vlogging', 'cam-vlogging']],
  gaming: [['Consoles', 'game-consoles'], ['Controllers', 'game-controllers'], ['Keyboards', 'game-keyboards']],
  accessories: [['Chargers', 'acc-chargers'], ['Cables', 'acc-cables'], ['Power Banks', 'acc-powerbanks']],
};
const NAME_SUBCAT = {
  'Aurora X5 5G Smartphone': 'mob-midrange', 'Pulse Lite 5G': 'mob-budget', 'Titan Pro Max': 'mob-flagship',
  'Edge 14 Ultrabook': 'lap-ultrabooks', 'ProBook 15 Creator': 'lap-creator', 'AirBook 13': 'lap-ultrabooks',
  'BassBuds Pro ANC': 'audio-earbuds', 'Studio Over-Ear 700': 'audio-headphones', 'SoundBar 3.1 Cinema': 'audio-speakers',
  'Vivid 55" 4K QLED TV': 'tv-qled', 'Vivid 43" 4K LED TV': 'tv-led',
  'Pulse Watch 2': 'wear-smartwatches', 'FitBand Active': 'wear-bands', 'Orbit Buds 3': 'wear-earbuds',
  'Capture R7 Mirrorless': 'cam-mirrorless', 'Capture M50 Vlogger': 'cam-vlogging',
  'Nova Console X': 'game-consoles', 'Glide Pro Controller': 'game-controllers', 'Mecha TKL Keyboard': 'game-keyboards',
  '65W GaN Charger': 'acc-chargers', 'Braided USB-C Cable 2m': 'acc-cables', 'PowerCore 20000 PD': 'acc-powerbanks',
};

const C = {
  black: { name: 'Black', hex: '#1c1c1e' }, silver: { name: 'Silver', hex: '#c7ccd1' },
  blue: { name: 'Blue', hex: '#2b59c3' }, white: { name: 'White', hex: '#f2f2f2' },
  graphite: { name: 'Graphite', hex: '#3a3a3c' }, gold: { name: 'Gold', hex: '#d4b483' },
  green: { name: 'Green', hex: '#1f6b53' }, red: { name: 'Red', hex: '#b3261e' },
};

const REVIEW_BODIES = [
  'Excellent performance and the build quality feels premium. Worth every rupee.',
  'Battery easily lasts a full day. Setup was quick and delivery was fast.',
  'Display is gorgeous and the speakers are surprisingly loud. Happy with it.',
  'Genuine sealed product with full warranty. Exactly as described.',
  'Great value for the specs. The No-Cost EMI made it easy to buy.',
  'Fast, reliable and looks great. Would recommend to anyone.',
  'Camera/sound quality is fantastic for the price point.',
];

// name, category, brand, ₹price, ₹MRP, configs[{label,add}], colourKeys[], highlights[], groups[{title,rows:[[label,value]]}]
const PRODUCTS = [
  ['Aurora X5 5G Smartphone', 'mobiles', 'Nexa', 38999, 49999,
    [['128GB', 0], ['256GB', 3000]], ['black', 'blue', 'silver'],
    ['6.7" 120Hz AMOLED', '50MP triple camera', '5000mAh · 67W fast charge', '5G · Dual SIM'],
    [['Display', [['Size', '6.7 inch'], ['Type', 'AMOLED, 120Hz'], ['Resolution', '2412 × 1080']]],
     ['Performance', [['Chipset', 'Octa-core 4nm'], ['RAM', '8 GB'], ['OS', 'Android 14']]],
     ['Camera', [['Rear', '50MP + 12MP + 8MP'], ['Front', '32MP']]],
     ['Battery', [['Capacity', '5000 mAh'], ['Charging', '67W wired']]]]],
  ['Pulse Lite 5G', 'mobiles', 'Nexa', 17999, 21999,
    [['128GB', 0], ['256GB', 2000]], ['green', 'black'],
    ['6.6" 90Hz display', '108MP camera', '5000mAh · 33W', '5G'],
    [['Display', [['Size', '6.6 inch'], ['Type', 'IPS LCD, 90Hz']]],
     ['Performance', [['Chipset', 'Octa-core 6nm'], ['RAM', '6 GB']]],
     ['Camera', [['Rear', '108MP dual'], ['Front', '16MP']]],
     ['Battery', [['Capacity', '5000 mAh'], ['Charging', '33W']]]]],
  ['Titan Pro Max', 'mobiles', 'Orbit', 129900, 139900,
    [['256GB', 0], ['512GB', 12000], ['1TB', 30000]], ['graphite', 'silver', 'gold'],
    ['6.7" ProMotion OLED', 'A-class chip', 'Pro camera system', 'Titanium build'],
    [['Display', [['Size', '6.7 inch'], ['Type', 'OLED, 120Hz'], ['Brightness', '2000 nits']]],
     ['Performance', [['Chipset', 'Flagship 3nm'], ['Storage', 'up to 1TB']]],
     ['Camera', [['Rear', '48MP + 12MP + 12MP'], ['Zoom', '5× optical']]],
     ['Build', [['Frame', 'Titanium'], ['Water resistance', 'IP68']]]]],
  ['Edge 14 Ultrabook', 'laptops', 'Volt', 84990, 99990,
    [['16GB/512GB', 0], ['16GB/1TB', 8000], ['32GB/1TB', 18000]], ['silver', 'graphite'],
    ['14" 2.8K OLED', 'Core Ultra 7', '16GB RAM', '70Wh · 12h battery'],
    [['Display', [['Size', '14 inch'], ['Type', 'OLED 2.8K'], ['Refresh', '120Hz']]],
     ['Performance', [['CPU', 'Core Ultra 7'], ['RAM', '16–32 GB'], ['SSD', '512GB–1TB']]],
     ['Battery', [['Capacity', '70 Wh'], ['Life', 'up to 12 hrs']]],
     ['Ports', [['USB-C', '2 × Thunderbolt'], ['Other', 'HDMI, USB-A']]]]],
  ['ProBook 15 Creator', 'laptops', 'Volt', 119990, 134990,
    [['16GB/1TB', 0], ['32GB/1TB', 15000]], ['graphite'],
    ['15.6" 4K display', 'RTX graphics', '32GB RAM option', 'Studio-grade colour'],
    [['Display', [['Size', '15.6 inch'], ['Type', 'IPS 4K'], ['Colour', '100% DCI-P3']]],
     ['Performance', [['CPU', '8-core'], ['GPU', 'RTX laptop GPU'], ['RAM', '16–32 GB']]],
     ['Storage', [['SSD', '1 TB NVMe']]]]],
  ['AirBook 13', 'laptops', 'Orbit', 99900, 109900,
    [['8GB/256GB', 0], ['16GB/512GB', 20000]], ['silver', 'graphite', 'gold'],
    ['13.6" Liquid Retina', 'M-series chip', 'Fanless', '18h battery'],
    [['Display', [['Size', '13.6 inch'], ['Type', 'Liquid Retina']]],
     ['Performance', [['Chip', 'M-series 8-core'], ['RAM', '8–16 GB']]],
     ['Battery', [['Life', 'up to 18 hrs']]]]],
  ['BassBuds Pro ANC', 'audio', 'Thump', 4999, 8999,
    [['Standard', 0]], ['black', 'white', 'blue'],
    ['Active noise cancellation', '40h total playback', 'Low-latency game mode', 'IPX5'],
    [['Audio', [['Drivers', '11mm dynamic'], ['ANC', 'Up to 45dB'], ['Codec', 'AAC, SBC']]],
     ['Battery', [['Buds', '8 hrs'], ['With case', '40 hrs']]],
     ['Other', [['Water resistance', 'IPX5'], ['Bluetooth', '5.3']]]]],
  ['Studio Over-Ear 700', 'audio', 'Sonance', 24990, 29990,
    [['Standard', 0]], ['black', 'silver'],
    ['Adaptive ANC', '30h battery', 'Hi-Res certified', 'Multipoint'],
    [['Audio', [['Drivers', '40mm'], ['ANC', 'Adaptive'], ['Hi-Res', 'Yes']]],
     ['Battery', [['Life', '30 hrs'], ['Charge', 'USB-C fast']]]]],
  ['SoundBar 3.1 Cinema', 'audio', 'Sonance', 18990, 24990,
    [['Standard', 0]], ['black'],
    ['3.1 channel', 'Wireless subwoofer', 'Dolby Atmos', 'HDMI eARC'],
    [['Audio', [['Channels', '3.1'], ['Power', '400W'], ['Atmos', 'Yes']]],
     ['Connectivity', [['HDMI', 'eARC'], ['Bluetooth', '5.0']]]]],
  ['Vivid 55" 4K QLED TV', 'televisions', 'Lumea', 49990, 69990,
    [['55"', 0], ['65"', 18000]], ['black'],
    ['4K QLED', 'Dolby Vision', '120Hz game mode', 'Smart OS'],
    [['Display', [['Size', '55"/65"'], ['Panel', 'QLED'], ['Refresh', '120Hz']]],
     ['Smart', [['OS', 'Smart TV'], ['Assistants', 'Built-in']]],
     ['Audio', [['Output', '40W'], ['Dolby', 'Atmos']]]]],
  ['Vivid 43" 4K LED TV', 'televisions', 'Lumea', 27990, 39990,
    [['43"', 0]], ['black'],
    ['4K UHD', 'HDR10', 'Smart apps', 'Bezel-less'],
    [['Display', [['Size', '43"'], ['Panel', 'LED'], ['HDR', 'HDR10']]],
     ['Smart', [['OS', 'Smart TV']]]]],
  ['Pulse Watch 2', 'wearables', 'Nexa', 12999, 16999,
    [['Standard', 0]], ['black', 'silver', 'blue'],
    ['1.9" AMOLED', 'AOD', 'SpO2 · ECG', '7-day battery'],
    [['Display', [['Size', '1.9 inch'], ['Type', 'AMOLED'], ['AOD', 'Yes']]],
     ['Health', [['Sensors', 'HR, SpO2, ECG'], ['GPS', 'Dual-band']]],
     ['Battery', [['Life', 'up to 7 days']]]]],
  ['FitBand Active', 'wearables', 'Thump', 2499, 3999,
    [['Standard', 0]], ['black', 'red', 'green'],
    ['1.47" colour display', '14-day battery', '5ATM water resistant', '100+ sport modes'],
    [['Display', [['Size', '1.47 inch'], ['Type', 'TFT colour']]],
     ['Battery', [['Life', '14 days']]],
     ['Durability', [['Water', '5 ATM']]]]],
  ['Orbit Buds 3', 'wearables', 'Orbit', 19900, 21900,
    [['Standard', 0]], ['white'],
    ['Adaptive ANC', 'Spatial audio', '6h + 24h case', 'USB-C'],
    [['Audio', [['ANC', 'Adaptive'], ['Spatial', 'Yes']]],
     ['Battery', [['Buds', '6 hrs'], ['Case', '24 hrs']]]]],
  ['Capture R7 Mirrorless', 'cameras', 'Optica', 154990, 169990,
    [['Body only', 0], ['With 28-70 kit', 22000]], ['black'],
    ['33MP full-frame', '4K 60p video', 'In-body stabilisation', 'Dual card slots'],
    [['Sensor', [['Type', 'Full-frame CMOS'], ['Resolution', '33 MP']]],
     ['Video', [['Max', '4K 60p'], ['Profiles', '10-bit log']]],
     ['Body', [['Stabilisation', '5-axis IBIS'], ['Slots', 'Dual SD']]]]],
  ['Capture M50 Vlogger', 'cameras', 'Optica', 54990, 64990,
    [['With 15-45 kit', 0]], ['black', 'white'],
    ['24MP APS-C', '4K video', 'Flip screen', 'Lightweight'],
    [['Sensor', [['Type', 'APS-C'], ['Resolution', '24 MP']]],
     ['Video', [['Max', '4K 24p']]],
     ['Body', [['Screen', 'Vari-angle touch']]]]],
  ['Nova Console X', 'gaming', 'Volt', 49990, 54990,
    [['1TB', 0]], ['white', 'black'],
    ['4K 120fps', '1TB SSD', 'Ray tracing', 'Includes controller'],
    [['Performance', [['Resolution', 'up to 4K'], ['Frame rate', '120 fps'], ['Storage', '1TB SSD']]],
     ['Box', [['Includes', '1 wireless controller']]]]],
  ['Glide Pro Controller', 'gaming', 'Thump', 5999, 7999,
    [['Standard', 0]], ['black', 'blue', 'white'],
    ['Hall-effect sticks', 'Back paddles', '40h battery', 'PC & console'],
    [['Features', [['Sticks', 'Hall-effect'], ['Buttons', 'Mappable paddles']]],
     ['Battery', [['Life', '40 hrs']]]]],
  ['Mecha TKL Keyboard', 'gaming', 'Volt', 6499, 8499,
    [['Standard', 0]], ['black', 'white'],
    ['Hot-swap switches', 'RGB per-key', 'Wireless tri-mode', 'Aluminium frame'],
    [['Build', [['Layout', 'TKL'], ['Frame', 'Aluminium']]],
     ['Features', [['Switches', 'Hot-swappable'], ['Lighting', 'Per-key RGB'], ['Connectivity', 'BT/2.4G/USB-C']]]]],
  ['65W GaN Charger', 'accessories', 'Voltline', 1799, 2999,
    [['Standard', 0]], ['black', 'white'],
    ['65W USB-C PD', 'GaN tech', 'Compact', 'Multi-device'],
    [['Output', [['Power', '65W'], ['Ports', '2× USB-C, 1× USB-A']]],
     ['Tech', [['Type', 'GaN III']]]]],
  ['Braided USB-C Cable 2m', 'accessories', 'Voltline', 699, 1299,
    [['Standard', 0]], ['black', 'red'],
    ['100W PD', '2 metre', 'Braided nylon', 'E-marker chip'],
    [['Spec', [['Length', '2 m'], ['Power', '100W'], ['Data', 'USB 2.0']]]]],
  ['PowerCore 20000 PD', 'accessories', 'Thump', 2999, 4499,
    [['Standard', 0]], ['black'],
    ['20000mAh', '30W PD', 'Charges laptop & phone', 'USB-C in/out'],
    [['Capacity', [['mAh', '20000'], ['Output', '30W PD']]],
     ['Ports', [['USB-C', 'In/Out'], ['USB-A', '×1']]]]],
];

async function ensureBusiness() {
  let business = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (business) return business;
  if (!CREATE) {
    console.error(`\nBusiness "${SLUG}" not found. Point at an existing ECOMMERCE tenant slug, or re-run with --create.\n`);
    process.exit(1);
  }
  business = await p.business.create({ data: { name: 'Voltline — Electronics Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
  console.log(`  created business: ${business.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) { await p.subscription.create({ data: { businessId: business.id, tierId: tier.id, theme: 'electronics' } }); console.log('  created subscription (theme=electronics)'); }
    else console.warn('  ⚠ no plan tier found — skipped subscription; set theme=electronics once the tenant has one');
  } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
  return business;
}

async function main() {
  console.log(`\nSeeding ELECTRONICS demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ business vertical is ${business.vertical}, not ECOMMERCE.`);

  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) {
    if (sub.theme !== 'electronics') { await p.subscription.update({ where: { businessId: BID }, data: { theme: 'electronics' } }); console.log('  set subscription.theme = electronics'); }
    else console.log('  skip  theme (already electronics)');
  } else console.warn('  ⚠ no subscription — cannot set theme=electronics.');

  const catBySlug = new Map();
  for (const c of CATEGORIES) {
    let row = await p.productCategory.findFirst({ where: { businessId: BID, slug: c.slug }, select: { id: true } });
    if (!row) { row = await p.productCategory.create({ data: { businessId: BID, name: c.name, slug: c.slug, sortOrder: c.sort, isPublished: true, imageUrl: img(`cat-${c.slug}`) }, select: { id: true } }); console.log(`  created category: ${c.name}`); }
    catBySlug.set(c.slug, row.id);
  }

  // Sub-categories → two-level tree (products re-homed onto a leaf via NAME_SUBCAT).
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
    const [name, catSlug, brand, price, mrp, configs, colourKeys, highlights, groupDefs] = PRODUCTS[i];
    const slug = slugify(name);
    const leafId = catBySlug.get(NAME_SUBCAT[name]) || catBySlug.get(catSlug);
    const existing = await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true, categoryId: true } });
    if (existing) { if (existing.categoryId !== leafId) { await p.product.update({ where: { id: existing.id }, data: { categoryId: leafId } }); console.log(`  re-homed: ${name}`); } continue; }

    const priceMinor = price * 100;
    const compareMinor = mrp * 100;
    const colours = colourKeys.map((k) => C[k]).filter(Boolean);
    const specs = { highlights, groups: groupDefs.map(([title, rows]) => ({ title, rows: rows.map(([label, value]) => ({ label, value })) })) };
    const images = [img(`${slug}-1`), img(`${slug}-2`), img(`${slug}-3`)];

    const product = await p.product.create({
      data: {
        businessId: BID, categoryId: leafId, name, slug, brand,
        shortDescription: highlights.slice(0, 2).join(' · '),
        description: `${name} by ${brand}. ${highlights.join('. ')}. Genuine, sealed-box product with full manufacturer warranty and No-Cost EMI on eligible plans.`,
        priceMinor, comparePriceMinor: compareMinor, currency: 'INR',
        imageUrls: images, specs,
        isPublished: true, isFeatured: i % 4 === 0, sortOrder: i, stockQty: null,
        createdAt: daysAgo(randInt(0, 60)),
      },
      select: { id: true },
    });

    let sortOrder = 0; let first = true;
    for (const cfg of configs) {
      const [cfgLabel, addRupees] = cfg;
      const add = (addRupees || 0) * 100;
      for (const col of colours) {
        await p.productVariant.create({
          data: {
            productId: product.id, label: `${cfgLabel} / ${col.name}`,
            priceMinor: priceMinor + add, comparePriceMinor: compareMinor + add,
            stockQty: Math.random() < 0.1 ? 0 : randInt(3, 40),
            option1Name: 'Configuration', option1Value: cfgLabel,
            option2Name: 'Colour', option2Value: col.name, swatchHex: col.hex,
            imageUrl: img(`${slug}-${col.name.toLowerCase()}`),
            sortOrder: sortOrder++, isDefault: first, isActive: true,
          },
        });
        first = false;
      }
    }
    createdProducts++;
    console.log(`  created product: ${name} (${configs.length}×${colours.length} variants)`);
  }

  const allProducts = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true } });
  let createdReviews = 0;
  for (const pr of allProducts) {
    if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
    const n = randInt(1, 8);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.78 ? randInt(4, 5) : randInt(3, 4);
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(['Rahul', 'Arjun', 'Vikram', 'Karan', 'Sneha', 'Pooja', 'Aditya', 'Rohan']) + ' ' + rand(['S.', 'K.', 'M.', 'R.']), rating, title: rating >= 5 ? 'Excellent' : rating >= 4 ? 'Very good' : 'Good', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.75 } });
      createdReviews++;
    }
  }

  console.log(`\n✅ Electronics demo seeded — ${createdProducts} new products, ${createdReviews} reviews.`);
  console.log(`   Open the storefront for "${SLUG}" (theme: electronics) to view it.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
