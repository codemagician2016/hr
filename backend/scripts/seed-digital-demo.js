#!/usr/bin/env node
// Digital products / courses demo + theme flip — to look-and-feel the bespoke
// `digital` storefront theme (instant access, curriculum, licenses, creators).
//
// Usage:
//   node scripts/seed-digital-demo.js [slug]
//   node scripts/seed-digital-demo.js [slug] --create
//
// Idempotent. Seeds courses / eBooks / templates / software (rich specs incl.
// curriculum + creator + includes + license variants) and reviews; sets
// subscription.theme = 'digital'. Images default to picsum placeholders.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const args = process.argv.slice(2);
const SLUG = (args.find((a) => !a.startsWith('--')) || 'digital-demo').toLowerCase();
const CREATE = args.includes('--create');

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const img = (seed) => `https://picsum.photos/seed/${encodeURIComponent('dig-' + seed)}/1000/640`;

const CATEGORIES = [
  { name: 'Courses', slug: 'courses', sort: 1, format: 'Course' },
  { name: 'eBooks', slug: 'ebooks', sort: 2, format: 'eBook' },
  { name: 'Templates', slug: 'templates', sort: 3, format: 'Template' },
  { name: 'Software', slug: 'software', sort: 4, format: 'Software' },
  { name: 'Bundles', slug: 'bundles', sort: 5, format: 'Bundle' },
];

const SUBCATS = { courses:[['Beginner','dg-beginner'],['Advanced','dg-advanced']], ebooks:[['Fiction','dg-fiction'],['Non-fiction','dg-nonfic']], templates:[['Design','dg-design'],['Docs','dg-docs']], software:[['Apps','dg-apps'],['Plugins','dg-plugins']] };
const catByFormat = (formats) => CATEGORIES.find((c) => c.format === formats);

const REVIEW_BODIES = [
  'Best money I’ve spent on my skills this year. Clear, practical, no fluff.',
  'Instant access worked perfectly and the content is genuinely high quality.',
  'The creator really knows their stuff. Followed along and shipped a project.',
  'Loved the bite-sized lessons. Easy to follow even as a beginner.',
  'Great templates — saved me hours. Worth every rupee.',
  'Downloaded and started in minutes. Exactly what I needed.',
  'Lifetime updates are a huge plus. Already got a free new module.',
];

function course(name, creator, price, mrp, level, tagline, includes, modules, faq) {
  return { name, format: 'Course', price, mrp, specs: { format: 'Course', level, tagline, access: 'Lifetime access & updates', creator, description: tagline, includes, curriculum: modules, faq }, licenses: null };
}
function digital(name, format, creator, price, mrp, tagline, includes, faq, licenses) {
  return { name, format, price, mrp, specs: { format, tagline, access: 'Lifetime access & updates', creator, description: tagline, includes, faq }, licenses };
}

const C1 = { name: 'Aarav Mehta', role: 'Senior Engineer & Educator', bio: 'Ex-FAANG engineer who has taught 40,000+ students online.' };
const C2 = { name: 'Sara Kapoor', role: 'Product Designer', bio: 'Design lead turned creator, obsessed with simple, usable design.' };
const C3 = { name: 'Studio Nine', role: 'Creative Studio', bio: 'A small studio making tools and templates for makers.' };

const PRODUCTS = [
  course('The Complete Web Developer Bootcamp', C1, 1499, 4999, 'Beginner → Job-ready',
    'Go from zero to a hireable full-stack developer with project-based lessons.',
    [{ title: '40+ hours of video', body: 'lifetime access' }, { title: '12 real projects', body: 'build a portfolio' }, { title: 'Certificate', body: 'on completion' }, { title: 'Community access', body: 'ask questions anytime' }],
    [{ title: 'Getting started', lessons: ['How the web works', 'Setting up your tools', 'Your first webpage'] }, { title: 'JavaScript deep dive', lessons: ['Variables & types', 'Functions & scope', 'Async & APIs', 'Project: weather app'] }, { title: 'Backend & databases', lessons: ['Node & Express', 'REST APIs', 'Databases 101', 'Project: blog API'] }, { title: 'Ship it', lessons: ['Deploying', 'Custom domains', 'Career & interviews'] }],
    [['Do I need prior experience?', 'None at all — we start from absolute basics.'], ['How long do I have access?', 'Forever, including all future updates.']]),
  course('Master Modern UI/UX Design', C2, 1299, 3999, 'All levels',
    'Design beautiful, usable products and a portfolio that gets you hired.',
    [{ title: '28 lessons', body: 'practical, project-led' }, { title: 'Figma files', body: 'download & remix' }, { title: 'Portfolio review', body: 'community feedback' }],
    [{ title: 'Foundations', lessons: ['Design principles', 'Colour & type', 'Layout & spacing'] }, { title: 'Figma mastery', lessons: ['Components', 'Auto-layout', 'Prototyping'] }, { title: 'Real projects', lessons: ['Mobile app', 'Landing page', 'Design system'] }],
    [['Which tools do I need?', 'Just Figma — the free plan works.']]),
  course('Personal Finance & Investing 101', C1, 999, 2499, 'Beginner',
    'Take control of your money: budgeting, investing and building wealth simply.',
    [{ title: '18 lessons', body: 'jargon-free' }, { title: 'Spreadsheets', body: 'budget & tracker' }, { title: 'Worksheets', body: 'put it into practice' }],
    [{ title: 'Money basics', lessons: ['Budgeting that sticks', 'Emergency funds', 'Good vs bad debt'] }, { title: 'Investing', lessons: ['Index funds explained', 'Risk & time horizon', 'Building a portfolio'] }],
    [['Is this financial advice?', 'No — it’s education to help you make your own informed decisions.']]),
  digital('The Indie Maker’s Playbook', 'eBook', C1, 499, 999,
    'A practical guide to building and launching profitable products solo.',
    [{ title: '220-page PDF', body: 'instant download' }, { title: 'Checklists', body: 'launch faster' }, { title: 'Free updates', body: 'forever' }],
    [['What format is it?', 'A downloadable PDF (and ePub).']], null),
  digital('100 AI Prompts for Marketers', 'eBook', C2, 0, null,
    'A free, copy-paste prompt pack to speed up your marketing workflow.',
    [{ title: '100 prompts', body: 'organised by use case' }, { title: 'Copy-paste ready', body: 'no setup' }],
    [['Is it really free?', 'Yes — grab it and start using it today.']], null),
  digital('Notion Second Brain Template', 'Template', C3, 699, 1299,
    'An all-in-one Notion system for notes, tasks, projects and goals.',
    [{ title: 'Notion template', body: 'one-click duplicate' }, { title: 'Setup guide', body: 'video walkthrough' }, { title: 'Lifetime updates', body: 'free' }],
    [['How do I use it?', 'Duplicate it into your Notion workspace in one click.']],
    [['Personal', 0], ['Team (up to 10)', 700]]),
  digital('Resume & Portfolio Kit', 'Template', C3, 399, 799,
    'Beautiful, ATS-friendly resume and portfolio templates that get noticed.',
    [{ title: '8 templates', body: 'Word, Pages, Figma' }, { title: 'Cover letters', body: 'matching designs' }],
    [['Are they editable?', 'Yes — fully editable in the included formats.']],
    [['Personal', 0], ['Commercial', 600]]),
  digital('Pitch Deck Template Pack', 'Template', C3, 899, 1799,
    'Investor-ready pitch deck templates used by funded startups.',
    [{ title: '4 deck templates', body: 'Keynote, PPT, Google Slides' }, { title: '60+ slides', body: 'mix & match' }],
    [['What’s included?', 'Editable decks in three formats plus a guide.']],
    [['Personal', 0], ['Commercial', 1100]]),
  digital('IconForge — 5,000 SVG Icons', 'Software', C3, 1199, 2999,
    'A massive, consistent SVG icon library for designers and developers.',
    [{ title: '5,000 icons', body: 'SVG + icon font' }, { title: 'Figma & Sketch', body: 'plugins included' }, { title: 'Lifetime updates', body: 'new icons monthly' }],
    [['What license do I get?', 'Personal by default; commercial available at checkout.']],
    [['Personal', 0], ['Commercial', 2000]]),
  digital('Cinematic Lightroom Presets', 'Software', C2, 799, 1499,
    'A pack of 30 cinematic presets to give your photos a filmic look in one click.',
    [{ title: '30 presets', body: 'desktop & mobile' }, { title: 'Install guide', body: 'video' }],
    [['Will they work on mobile?', 'Yes — both desktop and the free Lightroom mobile app.']],
    [['Personal', 0], ['Commercial', 900]]),
  digital('Creator Starter Bundle', 'Bundle', C3, 1999, 4999,
    'Everything you need to launch: templates, presets and an eBook — bundled.',
    [{ title: '6 products', body: 'one low price' }, { title: 'Save 60%', body: 'vs buying separately' }, { title: 'Lifetime access', body: 'all included' }],
    [['What’s in the bundle?', 'A curated set of our bestselling templates, presets and the eBook.']], null),
];

async function ensureBusiness() {
  let business = await p.business.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, vertical: true } });
  if (business) return business;
  if (!CREATE) { console.error(`\nBusiness "${SLUG}" not found. Point at an existing ECOMMERCE tenant slug, or re-run with --create.\n`); process.exit(1); }
  business = await p.business.create({ data: { name: 'Craftly — Digital Demo', slug: SLUG, vertical: 'ECOMMERCE', defaultCurrency: 'INR' }, select: { id: true, name: true, vertical: true } });
  console.log(`  created business: ${business.name}`);
  try {
    const tier = await p.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
    if (tier) { await p.subscription.create({ data: { businessId: business.id, tierId: tier.id, theme: 'digital' } }); console.log('  created subscription (theme=digital)'); }
    else console.warn('  ⚠ no plan tier found — skipped subscription; set theme=digital once the tenant has one');
  } catch (e) { console.warn('  ⚠ could not auto-create subscription:', e.message); }
  return business;
}

async function main() {
  console.log(`\nSeeding DIGITAL demo for slug: ${SLUG}\n`);
  const business = await ensureBusiness();
  const BID = business.id;
  if (business.vertical && business.vertical !== 'ECOMMERCE') console.warn(`  ⚠ business vertical is ${business.vertical}, not ECOMMERCE.`);

  const sub = await p.subscription.findUnique({ where: { businessId: BID }, select: { theme: true } });
  if (sub) { if (sub.theme !== 'digital') { await p.subscription.update({ where: { businessId: BID }, data: { theme: 'digital' } }); console.log('  set subscription.theme = digital'); } else console.log('  skip  theme (already digital)'); }
  else console.warn('  ⚠ no subscription — cannot set theme=digital.');

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
    const def = PRODUCTS[i];
    const slug = slugify(def.name);
    const cat = catByFormat(def.format);
    const _leaves = subsByParent[cat.slug] || []; let leafId = catBySlug.get(cat.slug); if (_leaves.length) { const _n = (rr[cat.slug] = (rr[cat.slug] ?? -1) + 1); leafId = _leaves[_n % _leaves.length]; } const _ex = await p.product.findFirst({ where: { businessId: BID, slug }, select: { id: true, categoryId: true } }); if (_ex) { if (_ex.categoryId !== leafId) { await p.product.update({ where: { id: _ex.id }, data: { categoryId: leafId } }); } continue; }
    const priceMinor = def.price * 100;
    const compareMinor = def.mrp ? def.mrp * 100 : null;
    const product = await p.product.create({
      data: {
        businessId: BID, categoryId: leafId, name: def.name, slug,
        brand: def.specs.creator?.name || null,
        shortDescription: def.specs.tagline,
        description: def.specs.tagline,
        priceMinor, comparePriceMinor: compareMinor, currency: 'INR',
        imageUrls: [img(`${slug}-1`)], specs: def.specs,
        isPublished: true, isFeatured: i < 3, sortOrder: i, stockQty: null,
        createdAt: daysAgo(randInt(5, 120)),
      },
      select: { id: true },
    });
    if (def.licenses) {
      let sortOrder = 0; let first = true;
      for (const [label, add] of def.licenses) {
        await p.productVariant.create({ data: { productId: product.id, label, priceMinor: priceMinor + add * 100, comparePriceMinor: compareMinor != null ? compareMinor + add * 100 : null, stockQty: null, option1Name: 'License', option1Value: label, sortOrder: sortOrder++, isDefault: first, isActive: true } });
        first = false;
      }
    }
    createdProducts++;
    console.log(`  created ${def.format}: ${def.name}${def.price === 0 ? ' (free)' : ''}`);
  }

  const allProducts = await p.product.findMany({ where: { businessId: BID, isPublished: true }, select: { id: true, isFeatured: true } });
  let createdReviews = 0;
  for (const pr of allProducts) {
    if (await p.ecomReview.count({ where: { businessId: BID, productId: pr.id } })) continue;
    const n = pr.isFeatured ? randInt(12, 20) : randInt(3, 9);
    for (let r = 0; r < n; r++) {
      const rating = Math.random() < 0.85 ? 5 : randInt(3, 4);
      await p.ecomReview.create({ data: { businessId: BID, productId: pr.id, customerName: rand(['Ishaan', 'Ananya', 'Rohit', 'Meher', 'Kabir', 'Zoya', 'Aditya', 'Diya', 'Vikram', 'Nisha']) + ' ' + rand(['S.', 'K.', 'M.', 'R.', 'B.']), rating, title: rating >= 5 ? 'Brilliant' : rating >= 4 ? 'Very good' : 'Good', body: rand(REVIEW_BODIES), status: 'PUBLISHED', verifiedBuyer: Math.random() < 0.92 } });
      createdReviews++;
    }
  }

  console.log(`\n✅ Digital demo seeded — ${createdProducts} new products, ${createdReviews} reviews.`);
  console.log(`   Open the storefront for "${SLUG}" (theme: digital) to view it.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
