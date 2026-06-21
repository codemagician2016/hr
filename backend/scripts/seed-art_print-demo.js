#!/usr/bin/env node
// Art prints / wall-art demo catalog + theme flip — to look-and-feel the bespoke
// `art_print` storefront theme (print sizes × frame options with swatches, artist
// = brand, limited editions, sale prices). The theme renders from standard
// product fields + option1/option2 variants + brand (it does not read specs).
//
// Usage:
//   node scripts/seed-art_print-demo.js [slug]
//   node scripts/seed-art_print-demo.js [slug] --create
//
// Idempotent. Sets subscription.theme = 'art_print'. Variants are the cartesian
// product of size × frame; size scales the base price, frame adds a surcharge.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'artprint-demo').toLowerCase();
const CREATE = args.includes('--create');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent('ap-' + seed)}/800/1000`;

const CATEGORIES = [
  { name: 'Originals', slug: 'originals', sort: 1 },
  { name: 'Fine Art Prints', slug: 'fine-art-prints', sort: 2 },
  { name: 'Photography', slug: 'photography', sort: 3 },
  { name: 'Illustration', slug: 'illustration', sort: 4 },
  { name: 'Framed Prints', slug: 'framed-prints', sort: 5 },
  { name: 'Limited Editions', slug: 'limited-editions', sort: 6 },
  { name: 'Wall Sets', slug: 'wall-sets', sort: 7 },
  { name: 'New In', slug: 'new-in', sort: 8 },
];

const SUBCATS = {
  photography: [['Landscape', 'photo-landscape'], ['Coastal', 'photo-coastal'], ['City', 'photo-city']],
  'fine-art-prints': [['Abstract', 'fineart-abstract'], ['Geometric', 'fineart-geometric'], ['Colour', 'fineart-colour']],
  illustration: [['Botanical', 'illus-botanical'], ['Line Art', 'illus-line']],
};
const NAME_SUBCAT = {
  'Coastal Morning': 'photo-coastal', 'Desert Dunes': 'photo-landscape', 'City in Rain': 'photo-city',
  'Abstract No. 7': 'fineart-abstract', 'Colour Field Study': 'fineart-colour', 'Golden Hour': 'fineart-colour', 'Ocean Geometry': 'fineart-geometric',
  'Botanical Ink I': 'illus-botanical', 'Botanical Ink II': 'illus-botanical', 'Mountain Line Art': 'illus-line',
};

// size → ₹ surcharge added to base; frame → [label, ₹ surcharge, swatchHex]
const SIZES = [['A4', 0], ['A3', 600], ['A2', 1400], ['A1', 2800]];
const FRAMES = [['Unframed', 0, '#EFE9DD'], ['Black frame', 1200, '#1A1A1A'], ['Oak frame', 1500, '#B8895A'], ['White frame', 1200, '#FFFFFF']];

const REVIEW_BODIES = [
  'Beautiful print quality, colours are rich and true.',
  'The framing is superb — looks gallery-grade.',
  'Arrived well-protected and exactly as pictured.',
  'Stunning piece, transformed our living room.',
  'Lovely paper stock and crisp detail.',
  'Signed and numbered — a real collector’s piece.',
];

// name, category, artist(brand), ₹baseA4Unframed, ₹mrp|null, frames(bool — include frame axis)
const PRODUCTS = [
  ['Coastal Morning', 'photography', 'Lena Hart', 1499, 1899, true],
  ['Desert Dunes', 'photography', 'Lena Hart', 1499, null, true],
  ['City in Rain', 'photography', 'Marco Vela', 1699, 1999, true],
  ['Abstract No. 7', 'fine-art-prints', 'R. Okonkwo', 1899, 2299, true],
  ['Colour Field Study', 'fine-art-prints', 'R. Okonkwo', 1899, null, true],
  ['Botanical Ink I', 'illustration', 'Yui Tanaka', 1299, 1599, true],
  ['Botanical Ink II', 'illustration', 'Yui Tanaka', 1299, 1599, true],
  ['Mountain Line Art', 'illustration', 'Sam Cole', 1199, null, true],
  ['Golden Hour', 'fine-art-prints', 'Marco Vela', 1799, 2099, true],
  ['Ocean Geometry', 'fine-art-prints', 'R. Okonkwo', 1999, null, true],
  ['Original — Aurora (1/1)', 'originals', 'Lena Hart', 24999, null, false],
  ['Original — Still Life (1/1)', 'originals', 'Yui Tanaka', 18999, null, false],
  ['Limited Edition — Tidewater', 'limited-editions', 'Marco Vela', 4999, 5999, true],
  ['Limited Edition — Nocturne', 'limited-editions', 'R. Okonkwo', 5499, null, true],
  ['Framed — Meadow Light', 'framed-prints', 'Sam Cole', 2999, 3499, true],
  ['Framed — Quiet Harbour', 'framed-prints', 'Lena Hart', 3299, null, true],
  ['Gallery Wall Set of 3', 'wall-sets', 'Studio Mixed', 3999, 4799, false],
  ['Gallery Wall Set of 6', 'wall-sets', 'Studio Mixed', 6999, 8499, false],
  ['Fresh Bloom', 'new-in', 'Yui Tanaka', 1399, null, true],
  ['Skyline Dusk', 'new-in', 'Marco Vela', 1599, 1899, true],
];

async function ensureBusiness() {
  let b = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (b) return b;
  if (!CREATE) { console.error(`\nBusiness "${SLUG}" not found. Use an existing ECOMMERCE slug or re-run with --create.\n`); process.exit(1); }
  b = await p.business.create({ data: { name: 'Atelier Wall — Art Print Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
  console.log(`  created business: ${b.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) { await p.subscription.create({ data: { businessId: b.id, tierId: tier.id, theme: 'art_print' } }); console.log('  created subscription (theme=art_print)'); }
    else console.warn('  ⚠ no plan tier found — set theme=art_print once the tenant has one');
  } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
  return b;
}

async function main() {
  console.log(`\nSeeding ART_PRINT demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ vertical is ${business.vertical}, not ECOMMERCE.`);

  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) { if (sub.theme !== 'art_print') { await p.subscription.update({ where: { businessId: BID }, data: { theme: 'art_print' } }); console.log('  set subscription.theme = art_print'); } else console.log('  skip  theme (already art_print)'); }
  else console.warn('  ⚠ no subscription — cannot set theme=art_print.');

  const catBySlug = new Map();
  for (const c of CATEGORIES) {
    let row = await p.productCategory.findFirst({ where: { businessId: BID, slug: c.slug }, select: { id: true } });
    if (!row) { row = await p.productCategory.create({ data: { businessId: BID, name: c.name, slug: c.slug, sortOrder: c.sort, isPublished: true, imageUrl: img(`cat-${c.slug}`) }, select: { id: true } }); console.log(`  created category: ${c.name}`); }
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

  let created = 0;
  for (let i = 0; i < PRODUCTS.length; i++) {
    const [name, catSlug, artist, base, mrp, withFrames] = PRODUCTS[i];
    const slug = slugify(name);
    const leafId = catBySlug.get(NAME_SUBCAT[name]) || catBySlug.get(catSlug);
    const existing = await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true, categoryId: true } });
    if (existing) { if (existing.categoryId !== leafId) { await p.product.update({ where: { id: existing.id }, data: { categoryId: leafId } }); console.log(`  re-homed: ${name}`); } continue; }
    const baseMinor = base * 100;
    const compareMinor = mrp ? mrp * 100 : null;
    const images = [img(`${slug}-1`), img(`${slug}-2`)];
    const product = await p.product.create({
      data: {
        businessId: BID, categoryId: leafId, name, slug, brand: artist,
        shortDescription: `By ${artist}`,
        description: `${name} by ${artist}. Museum-quality giclée on archival fine-art paper. Each piece is produced to order; framed options are hand-assembled.`,
        priceMinor: baseMinor, comparePriceMinor: compareMinor, currency: 'INR',
        imageUrls: images, isPublished: true, isFeatured: i % 5 === 0, sortOrder: i, stockQty: null,
        createdAt: daysAgo(randInt(0, 60)),
      }, select: { id: true },
    });
    // Cartesian size × frame; price = base + size surcharge + frame surcharge.
    let sortOrder = 0; let first = true;
    const isOriginal = catSlug === 'originals';
    const sizeList = isOriginal ? [['Original', 0]] : SIZES;
    const frameList = withFrames ? FRAMES : [['Unframed', 0, '#EFE9DD']];
    for (const [size, sAdd] of sizeList) {
      for (const [frame, fAdd, hex] of frameList) {
        const vPrice = baseMinor + sAdd * 100 + fAdd * 100;
        await p.productVariant.create({
          data: {
            productId: product.id, label: [size, frame].filter(Boolean).join(' · '),
            priceMinor: vPrice, comparePriceMinor: compareMinor != null ? compareMinor + sAdd * 100 + fAdd * 100 : null,
            stockQty: Math.random() < 0.08 ? 0 : randInt(1, 20),
            option1Name: isOriginal ? 'Format' : 'Print size', option1Value: size,
            option2Name: withFrames ? 'Frame' : null, option2Value: withFrames ? frame : null, swatchHex: withFrames ? hex : null,
            sortOrder: sortOrder++, isDefault: first, isActive: true,
          },
        });
        first = false;
      }
    }
    created++;
    console.log(`  created piece: ${name} [${artist}]`);
  }

  const all = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true } });
  let reviews = 0;
  for (const pr of all) {
    if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
    const n = randInt(1, 6);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.9 ? 5 : 4;
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(['Helena', 'Theo', 'Priya', 'Daniel', 'Mei', 'Aria', 'Noah', 'Ishaan']) + ' ' + rand(['B.', 'C.', 'M.', 'R.', 'S.']), rating, title: rating === 5 ? 'Gorgeous' : 'Lovely', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.85 } });
      reviews++;
    }
  }

  console.log(`\n✅ Art print demo seeded — ${created} pieces, ${reviews} reviews. Theme: art_print.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
