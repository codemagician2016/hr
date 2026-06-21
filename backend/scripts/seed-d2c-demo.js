#!/usr/bin/env node
// Single-product / D2C demo + theme flip — to look-and-feel the bespoke `d2c`
// storefront theme (long-form landing, bundles, subscribe & save, social proof).
//
// Usage:
//   node scripts/seed-d2c-demo.js [slug]
//   node scripts/seed-d2c-demo.js [slug] --create
//
// Idempotent. Seeds a hero product (rich storytelling in Product.specs + bundle
// variants) + a couple of add-ons, plenty of reviews; sets subscription.theme =
// 'd2c'. Images default to picsum placeholders.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'd2c-demo').toLowerCase();
const CREATE = args.includes('--create');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent('d2c-' + seed)}/900/900`;

const REVIEW_BODIES = [
  'Genuinely changed my morning routine. I feel sharper by 10am.',
  'Tastes way better than I expected and mixes clean — no clumps.',
  'On my third pouch now. The subscription makes it effortless.',
  'Was sceptical about the hype but it’s legit. Energy is steadier.',
  'Beautiful packaging and the product delivers. Highly recommend.',
  'Bloating is way down and I’m actually craving it now.',
  'Bought the 3-pack and shared with my partner — both hooked.',
  'Fast shipping, great taste, no jitters. Exactly as described.',
];

// The hero product.
const HERO = {
  name: 'Daily Greens Superfood Blend',
  brand: 'Lumo',
  basePrice: 1999, // ₹ per pouch (30 days)
  short: '55 greens, adaptogens & probiotics in one daily scoop. Gut, energy and immunity — sorted.',
  tagline: 'One scoop. 55 greens. Zero fuss.',
  guarantee: 'Vegan & cruelty-free',
  story: [
    ['The problem', 'Most of us don’t get enough greens — and the “healthy” fixes are either bland, complicated or full of fillers. We wanted one simple habit that actually fits into a busy morning.'],
    ['The blend', '55 carefully chosen ingredients: leafy greens, adaptogens like ashwagandha, digestive enzymes and a billion-CFU probiotic — all in a scoop that mixes clean in water in seconds.'],
    ['The ritual', 'Add one scoop to cold water, shake, and go. No blender, no mess. Most people feel the difference within the first two weeks of a daily habit.'],
    ['Made right', 'Third-party tested, sugar-free, vegan and cruelty-free. Made in small batches so every pouch is fresh.'],
  ],
  features: [
    ['Gut-loving', 'Probiotics + digestive enzymes to support a calmer, happier gut.'],
    ['Steady energy', 'Greens and adaptogens for focus without the caffeine crash.'],
    ['Actually tasty', 'A light, refreshing apple-mint flavour that mixes clean.'],
  ],
  faq: [
    ['When will I feel a difference?', 'Most people notice steadier energy and less bloating within the first 1–2 weeks of daily use. It’s a habit, not a magic pill.'],
    ['How does it taste?', 'Light and refreshing — apple-mint. It mixes clean in cold water with no clumps.'],
    ['Is it vegan?', 'Yes — 100% vegan, sugar-free and cruelty-free, third-party tested.'],
    ['Can I pause my subscription?', 'Absolutely. Skip, pause or cancel anytime from your account — no emails, no hassle.'],
  ],
  // bundles: [label, ₹price]
  bundles: [['1 pouch · 30 days', 1999], ['2 pouches · save 10%', 3599], ['3 pouches · best value', 4899]],
};

const ADDONS = [
  { name: 'Lumo Shaker Bottle', brand: 'Lumo', price: 499, short: 'Leak-proof 600ml shaker with a stainless mixing ball.', bundles: [['Standard', 499]] },
  { name: 'Daily Greens Travel Sachets (7-pack)', brand: 'Lumo', price: 699, short: 'Single-serve sachets for travel and on-the-go.', bundles: [['7-pack', 699], ['14-pack', 1299]] },
];

async function ensureBusiness() {
  let business = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (business) return business;
  if (!CREATE) { console.error(`\nBusiness "${SLUG}" not found. Point at an existing ECOMMERCE tenant slug, or re-run with --create.\n`); process.exit(1); }
  business = await p.business.create({ data: { name: 'Lumo — D2C Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
  console.log(`  created business: ${business.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) { await p.subscription.create({ data: { businessId: business.id, tierId: tier.id, theme: 'd2c' } }); console.log('  created subscription (theme=d2c)'); }
    else console.warn('  ⚠ no plan tier found — skipped subscription; set theme=d2c once the tenant has one');
  } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
  return business;
}

async function makeProduct(BID, catId, def, { hero = false } = {}) {
  const slug = slugify(def.name);
  if (await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true } })) return null;
  const specs = hero
    ? { tagline: def.tagline, guarantee: def.guarantee, story: def.story.map(([title, body]) => ({ title, body })), features: def.features.map(([title, body]) => ({ title, body })), faq: def.faq.map(([q, a]) => ({ q, a })) }
    : { tagline: def.short };
  const product = await p.product.create({
    data: {
      businessId: BID, categoryId: catId, name: def.name, slug, brand: def.brand,
      shortDescription: def.short,
      description: def.short,
      priceMinor: def.price ? def.price * 100 : def.basePrice * 100,
      currency: 'INR',
      imageUrls: [img(`${slug}-1`), img(`${slug}-2`)],
      specs,
      isPublished: true, isFeatured: hero, sortOrder: hero ? 0 : 10, stockQty: null,
      createdAt: daysAgo(randInt(10, 120)),
    },
    select: { id: true },
  });
  let sortOrder = 0; let first = true;
  for (const [label, price] of def.bundles) {
    await p.productVariant.create({ data: { productId: product.id, label, priceMinor: price * 100, stockQty: randInt(20, 200), option1Name: 'Bundle', option1Value: label, sortOrder: sortOrder++, isDefault: first, isActive: true } });
    first = false;
  }
  return product.id;
}

async function main() {
  console.log(`\nSeeding D2C demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ business vertical is ${business.vertical}, not ECOMMERCE.`);

  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) { if (sub.theme !== 'd2c') { await p.subscription.update({ where: { businessId: BID }, data: { theme: 'd2c' } }); console.log('  set subscription.theme = d2c'); } else console.log('  skip  theme (already d2c)'); }
  else console.warn('  ⚠ no subscription — cannot set theme=d2c.');

  let cat = await p.productCategory.findFirst({ where: { businessId: BID, slug: 'shop' }, select: { id: true } });
  if (!cat) cat = await p.productCategory.create({ data: { businessId: BID, name: 'Shop', slug: 'shop', sortOrder: 1, isPublished: true }, select: { id: true } });

  const heroId = await makeProduct(BID, cat.id, HERO, { hero: true });
  if (heroId) console.log(`  created hero product: ${HERO.name} (${HERO.bundles.length} bundles)`);
  for (const a of ADDONS) { const id = await makeProduct(BID, cat.id, a); if (id) console.log(`  created add-on: ${a.name}`); }

  // Lots of reviews on the hero for social proof.
  const allProducts = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true, isFeatured: true } });
  let createdReviews = 0;
  for (const pr of allProducts) {
    if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
    const n = pr.isFeatured ? randInt(14, 22) : randInt(2, 6);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.85 ? 5 : randInt(3, 4);
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(['Aisha', 'Rohan', 'Maya', 'Dev', 'Sara', 'Kabir', 'Tara', 'Arjun', 'Nina', 'Veer']) + ' ' + rand(['S.', 'K.', 'M.', 'R.', 'P.']), rating, title: rating >= 5 ? 'Obsessed' : rating >= 4 ? 'Really good' : 'Decent', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.9 } });
      createdReviews++;
    }
  }

  console.log(`\n✅ D2C demo seeded — hero + ${ADDONS.length} add-ons, ${createdReviews} reviews.`);
  console.log(`   Open the storefront for "${SLUG}" (theme: d2c) to view it.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
