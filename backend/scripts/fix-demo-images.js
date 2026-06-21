#!/usr/bin/env node
'use strict';
// Replace the random picsum placeholders on *-demo stores with keyword-relevant
// photos (loremflickr), derived from each product's own name (+ category as a
// fallback). Idempotent — safe to re-run after any re-seed.
//   node -r dotenv/config scripts/fix-demo-images.js [slug|--all] [--dry]
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const STOP = new Set(['the', 'and', 'with', 'for', 'of', 'a', 'an', 'pack', 'set', 'combo', 'pcs', 'pc', 'x', 'plus', 'pro', 'kit']);
const UNIT = /\b\d+(\.\d+)?\s?(kg|kgs|g|gm|gms|ml|l|ltr|litre|liter|pcs|pc|pack|packs|cm|mm|inch|in|gb|tb|mah|w|k|ct|carat|oz|lb|lbs|count)\b/gi;

function keyword(name, categoryName) {
  let s = String(name || '').toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ');     // drop "(6)" etc.
  s = s.replace(UNIT, ' ');             // drop sizes / units
  s = s.replace(/\b\d+(\.\d+)?\b/g, ' '); // stray numbers
  s = s.replace(/[^a-z\s&-]/g, ' ');
  let words = s.split(/[\s-]+/).filter((w) => w.length >= 3 && !STOP.has(w));
  if (words.length === 0 && categoryName) {
    words = String(categoryName).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
  }
  // The head noun in an English product name is usually LAST ("Linen Wrap
  // Dress" → dress), so keep the last two words (adjective + noun) for the
  // most product-relevant photo match.
  words = words.slice(-2);
  if (words.length === 0) words = ['product'];
  return words.join(',');
}

const photo = (kw, lock, w = 600, h = 600) => `https://loremflickr.com/${w}/${h}/${encodeURIComponent(kw)}?lock=${lock}`;

async function run() {
  const arg = process.argv[2];
  const dry = process.argv.includes('--dry');
  const where = (!arg || arg === '--all' || arg.startsWith('--'))
    ? { slug: { endsWith: '-demo' } }
    : { slug: arg };
  const businesses = await prisma.business.findMany({ where, select: { id: true, slug: true } });
  if (businesses.length === 0) { console.log('No matching businesses.'); return; }

  let totalP = 0, totalC = 0;
  for (const b of businesses) {
    let lock = 1;
    // Categories — keyword from the category name.
    const cats = await prisma.productCategory.findMany({ where: { businessId: b.id }, select: { id: true, name: true } });
    for (const c of cats) {
      const url = photo(keyword(c.name), lock++);
      if (!dry) await prisma.productCategory.update({ where: { id: c.id }, data: { imageUrl: url } });
      totalC++;
    }
    // Products — keyword from product name (+ its category as fallback). Two
    // images (main + hover) sharing the keyword but different locks.
    const prods = await prisma.product.findMany({ where: { businessId: b.id }, select: { id: true, name: true, category: { select: { name: true } } } });
    let sample = [];
    for (const p of prods) {
      const kw = keyword(p.name, p.category?.name);
      const urls = [photo(kw, lock), photo(kw, lock + 1)];
      lock += 2;
      if (sample.length < 4) sample.push(`${p.name} → ${kw}`);
      if (!dry) await prisma.product.update({ where: { id: p.id }, data: { imageUrls: urls } });
      totalP++;
    }
    console.log(`${b.slug.padEnd(20)} cats=${cats.length} products=${prods.length}  e.g. ${sample.join(' | ')}`);
  }
  console.log(`\n${dry ? '[dry] ' : ''}done — ${businesses.length} stores, ${totalP} products, ${totalC} categories.`);
}

run().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
