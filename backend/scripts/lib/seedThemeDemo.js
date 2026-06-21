// Shared demo-seeder for the browse-style shop themes (beauty_shop, jewelry_shop,
// home_furniture, pet_supplies, books_stationery, toys_games, sports_fitness,
// florist_gifts, bakery_sweets, grocery). These themes render from standard
// product fields + option1/option2 variants (+ swatchHex) + brand (none read
// Product.specs), so the seed populates exactly those.
//
// Each seed-<theme>-demo.js is a thin data file that calls this with its theme
// key, categories and products. Idempotent; `--create` makes the tenant.
//
// product shape:
//   { name, cat, brand, price, mrp,                        // ₹ price / MRP (mrp null = no sale)
//     o1: { name, values: ['M' | { label, add }] },        // optional axis 1 (size etc.); add = ₹ surcharge
//     o2: { name, values: [['Red', '#f00']] } }            // optional axis 2 (colour/finish) with swatch hex
// No o1/o2 → a single simple line (no variants).

const { PrismaClient } = require('@prisma/client');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

module.exports = async function seedThemeDemo(cfg) {
  const { theme, defaultSlug, bizName, imgPrefix, categories, products, reviewBodies, reviewers, reviewTitles } = cfg;
  const args = process.argv.slice(2);
  const SLUG = (args.find((a) => !a.startsWith('--')) || defaultSlug).toLowerCase();
  const CREATE = args.includes('--create');
  const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent(imgPrefix + '-' + seed)}/700/700`;
  const p = new PrismaClient();

  try {
    console.log(`\nSeeding ${theme.toUpperCase()} demo for slug: ${SLUG}\n`);

    // ensure business
    let business = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
    if (!business) {
      if (!CREATE) { console.error(`\nBusiness "${SLUG}" not found. Use an existing ECOMMERCE slug or re-run with --create.\n`); process.exit(1); }
      business = await p.business.create({ data: { name: bizName, slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
      console.log(`  created business: ${business.name}`);
      try {
        const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
        if (tier) { await p.subscription.create({ data: { businessId: business.id, tierId: tier.id, theme } }); console.log(`  created subscription (theme=${theme})`); }
        else console.warn(`  ⚠ no plan tier found — set theme=${theme} once the tenant has one`);
      } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
    }
    const BID = business.id;
    if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ vertical is ${business.vertical}, not ECOMMERCE.`);

    const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
    if (sub) { if (sub.theme !== theme) { await p.subscription.update({ where: { businessId: BID }, data: { theme } }); console.log(`  set subscription.theme = ${theme}`); } else console.log(`  skip  theme (already ${theme})`); }
    else console.warn(`  ⚠ no subscription — cannot set theme=${theme}.`);

    // categories (top-level)
    const catBySlug = new Map();
    let csort = 1;
    for (const name of categories) {
      const cslug = slugify(name);
      let row = await p.productCategory.findFirst({ where: { businessId: BID, slug: cslug }, select: { id: true } });
      if (!row) { row = await p.productCategory.create({ data: { businessId: BID, name, slug: cslug, sortOrder: csort, isPublished: true, imageUrl: img(`cat-${cslug}`) }, select: { id: true } }); console.log(`  created category: ${name}`); }
      catBySlug.set(cslug, row.id);
      csort++;
    }

    // sub-categories → a real two-level tree. cfg.subcategories maps a PARENT
    // category name to [[subName, subSlug], …]. Products are re-homed onto a leaf
    // (explicit prod.subcat, else round-robin within the parent); the parent page
    // still shows everything because getPublicProducts expands to descendants.
    const subsByParent = new Map(); // parentSlug → [{ slug, id }]
    if (cfg.subcategories) {
      for (const [parentName, subs] of Object.entries(cfg.subcategories)) {
        const parentSlug = slugify(parentName);
        const parentId = catBySlug.get(parentSlug);
        if (!parentId) { console.warn(`  ⚠ sub-cats: unknown parent "${parentName}"`); continue; }
        const leaves = [];
        for (let s = 0; s < subs.length; s++) {
          const [subName, subSlug0] = subs[s];
          const subSlug = slugify(subSlug0 || subName);
          if (subSlug === parentSlug) { console.warn(`  ⚠ sub-cat slug "${subSlug}" collides with its parent — skipping (give it a distinct slug)`); continue; }
          let row = await p.productCategory.findFirst({ where: { businessId: BID, slug: subSlug }, select: { id: true, parentId: true } });
          if (!row) { row = await p.productCategory.create({ data: { businessId: BID, name: subName, slug: subSlug, parentId, sortOrder: s + 1, isPublished: true, imageUrl: img(`cat-${subSlug}`) }, select: { id: true, parentId: true } }); console.log(`    created sub-category: ${parentName} › ${subName}`); }
          else if (row.id === parentId) { console.warn(`  ⚠ sub-cat "${subName}" resolves to its own parent — skipping`); continue; }
          else if (row.parentId !== parentId) { await p.productCategory.update({ where: { id: row.id }, data: { parentId } }); }
          catBySlug.set(subSlug, row.id);
          leaves.push({ slug: subSlug, id: row.id });
        }
        subsByParent.set(parentSlug, leaves);
      }
    }
    const rr = {}; // per-parent round-robin index into its leaves

    // products + variants
    let created = 0;
    for (let i = 0; i < products.length; i++) {
      const prod = products[i];
      const slug = slugify(prod.name);
      const parentSlug = slugify(prod.cat);
      const parentId = catBySlug.get(parentSlug);
      if (!parentId) { console.warn(`  ⚠ skip ${prod.name}: unknown category "${prod.cat}"`); continue; }
      // Resolve the leaf category: explicit prod.subcat, else round-robin within
      // the parent's leaves, else the parent itself (no sub-cats).
      let catId = parentId;
      const leaves = subsByParent.get(parentSlug) || [];
      if (leaves.length) {
        let hit = prod.subcat ? leaves.find((l) => l.slug === slugify(prod.subcat)) : null;
        if (!hit) hit = leaves[(rr[parentSlug] = (rr[parentSlug] ?? -1) + 1) % leaves.length];
        catId = hit.id;
      }
      // Re-home an already-seeded product onto its leaf (idempotent re-runs).
      const existing = await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true, categoryId: true } });
      if (existing) {
        if (existing.categoryId !== catId) { await p.product.update({ where: { id: existing.id }, data: { categoryId: catId } }); console.log(`  re-homed: ${prod.name}`); }
        continue;
      }
      const priceMinor = prod.price * 100;
      const compareMinor = prod.mrp ? prod.mrp * 100 : null;
      const images = [img(`${slug}-1`), img(`${slug}-2`)];
      const product = await p.product.create({
        data: {
          businessId: BID, categoryId: catId, name: prod.name, slug, brand: prod.brand || null, sku: prod.sku || null,
          shortDescription: prod.brand ? `${prod.brand}` : prod.cat,
          description: prod.desc || `${prod.name}${prod.brand ? ` by ${prod.brand}` : ''}. ${cfg.descTail || ''}`.trim(),
          priceMinor, comparePriceMinor: compareMinor, currency: 'INR',
          imageUrls: images, isPublished: true, isFeatured: i % 5 === 0, sortOrder: i, stockQty: null,
          createdAt: daysAgo(randInt(0, 50)),
        }, select: { id: true },
      });

      // Normalise axes: keep only axes that actually have values. If only the
      // second axis has values (e.g. a colour-only product authored as o2), promote
      // it to the sole primary axis so a selector renders (its values become plain
      // labels — the swatch chip only shows when colour is genuinely the 2nd axis).
      let o1 = prod.o1 && prod.o1.values && prod.o1.values.length ? prod.o1 : null;
      let o2 = prod.o2 && prod.o2.values && prod.o2.values.length ? prod.o2 : null;
      if (!o1 && o2) { o1 = { name: o2.name, values: o2.values.map((v) => (Array.isArray(v) ? v[0] : v)) }; o2 = null; }
      let sortOrder = 0; let first = true;
      if (o1) {
        const v1s = o1.values;
        const v2s = o2 ? o2.values : [null];
        for (const v1 of v1s) {
          const l1 = typeof v1 === 'string' ? v1 : v1.label;
          const add1 = typeof v1 === 'string' ? 0 : (v1.add || 0);
          for (const v2 of v2s) {
            const l2 = v2 ? (Array.isArray(v2) ? v2[0] : v2) : null;
            const hex = v2 && Array.isArray(v2) ? v2[1] : null;
            await p.productVariant.create({
              data: {
                productId: product.id, label: [l1, l2].filter(Boolean).join(' · '),
                priceMinor: priceMinor + add1 * 100, comparePriceMinor: compareMinor != null ? compareMinor + add1 * 100 : null,
                stockQty: Math.random() < 0.1 ? 0 : randInt(4, 60),
                option1Name: o1.name, option1Value: l1,
                option2Name: o2 ? o2.name : null, option2Value: l2, swatchHex: hex,
                sortOrder: sortOrder++, isDefault: first, isActive: true,
              },
            });
            first = false;
          }
        }
      }
      created++;
      console.log(`  created product: ${prod.name}`);
    }

    // reviews
    const all = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true } });
    let reviews = 0;
    const bodies = reviewBodies || ['Great quality, exactly as described.', 'Fast delivery and well packaged.', 'Lovely product — would buy again.', 'Excellent value for money.', 'Really happy with this purchase.'];
    const names = reviewers || ['Aanya', 'Rohan', 'Meera', 'Kabir', 'Sara', 'Arjun', 'Tara', 'Dev', 'Nina', 'Vikram'];
    const titles = reviewTitles || ['Love it', 'Great buy', 'Recommended', 'Very good', 'Excellent'];
    for (const pr of all) {
      if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
      const n = randInt(2, 7);
      for (let r = 0; r < n; r++) {
        const rating = Math.random() < 0.85 ? randInt(4, 5) : randInt(3, 4);
        await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(names) + ' ' + rand(['B.', 'K.', 'M.', 'R.', 'S.', 'P.']), rating, title: rating >= 4 ? rand(titles) : 'Decent', body: rand(bodies), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.85 } });
        reviews++;
      }
    }

    console.log(`\n✅ ${theme} demo seeded — ${created} products, ${reviews} reviews. Theme: ${theme}.\n`);
  } finally {
    await p.$disconnect();
  }
};
