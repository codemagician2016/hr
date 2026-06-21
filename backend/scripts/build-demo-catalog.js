#!/usr/bin/env node
/* eslint-disable no-console */
//
// Build-time tool — fetches realistic product data from OpenFoodFacts +
// curated Unsplash photo IDs, normalises into a single JSON catalog used
// by `seed-demo-shop.js` at runtime.
//
// RUN ONCE during dev (or whenever you want to refresh the dataset):
//
//   node backend/scripts/build-demo-catalog.js
//
// Writes:  backend/scripts/data/demo-shop-catalog.json
// Commit the JSON. Production seed reads it — no API dependency at deploy
// time, no rate-limit risk on customers' EC2.
//
// API references:
//   - OpenFoodFacts: https://openfoodfacts.github.io/openfoodfacts-server/api/
//   - Unsplash: direct photo IDs (no API key needed for fixed CDN URLs)

const fs = require('fs');
const path = require('path');
const https = require('https');

// Per-category target counts. Reflects a real grocery's catalog density —
// Pantry/Snacks/Beverages dominate; specialty categories are lean.
// All grocery categories use the hybrid off-then-unsplash path. OFF's
// rate limiter is flaky enough that any single category occasionally
// returns 0 rows; the Unsplash filler ensures we always reach target.
const CATEGORY_TARGETS = [
  { key: 'produce',         label: 'Produce',                 target: 50, source: 'off-then-unsplash', offTag: 'fruits-and-vegetables-based-foods',
    queries: ['fresh apples', 'banana bunch', 'oranges fruit', 'tomatoes fresh', 'lettuce', 'spinach leaves', 'avocado'] },
  { key: 'dairy-eggs',      label: 'Dairy & Eggs',            target: 40, source: 'off-then-unsplash', offTag: 'dairies',
    queries: ['milk bottle', 'cheese block', 'butter pack', 'yogurt cup', 'eggs carton'] },
  { key: 'bakery',          label: 'Bakery',                  target: 35, source: 'off-then-unsplash', offTag: 'breads',
    queries: ['bread loaf', 'croissant', 'baguette', 'bagel', 'muffin'] },
  { key: 'meat-seafood',    label: 'Meat & Seafood',          target: 30, source: 'off-then-unsplash', offTag: 'meats',
    queries: ['chicken meat', 'beef cut', 'salmon fish', 'shrimp seafood', 'sausages'] },
  { key: 'beverages',       label: 'Beverages',               target: 50, source: 'off-then-unsplash', offTag: 'beverages',
    queries: ['orange juice bottle', 'sparkling water', 'cola can', 'iced tea bottle', 'energy drink'] },
  { key: 'snacks',          label: 'Snacks & Confectionery',  target: 60, source: 'off-then-unsplash', offTag: 'snacks',
    queries: ['chocolate bar', 'potato chips', 'cookies pack', 'candy bag', 'granola bar', 'pretzel'] },
  { key: 'pantry',          label: 'Pantry & Cooking',        target: 55, source: 'off-then-unsplash', offTag: 'condiments',
    queries: ['olive oil bottle', 'rice bag', 'pasta box', 'flour bag', 'sugar bag', 'spices jar', 'sauce jar', 'canned beans'] },
  { key: 'frozen',          label: 'Frozen Foods',            target: 30, source: 'off-then-unsplash', offTag: 'frozen-foods',
    queries: ['frozen pizza', 'ice cream tub', 'frozen vegetables', 'frozen waffles'] },
  { key: 'cereals',         label: 'Breakfast Cereals',       target: 25, source: 'off-then-unsplash', offTag: 'breakfast-cereals',
    queries: ['cereal box', 'oatmeal package', 'granola bag'] },
  { key: 'pet-food',        label: 'Pet Food',                target: 15, source: 'unsplash', queries: ['dog food', 'cat food', 'pet treats'] },
  { key: 'personal-care',   label: 'Personal Care',           target: 30, source: 'unsplash', queries: ['shampoo', 'soap bar', 'toothpaste', 'lotion', 'deodorant', 'razor'] },
  { key: 'household',       label: 'Household & Cleaning',    target: 25, source: 'unsplash', queries: ['detergent', 'cleaning spray', 'paper towels', 'trash bags', 'sponge'] },
  { key: 'baby-kids',       label: 'Baby & Kids',             target: 15, source: 'unsplash', queries: ['baby diapers', 'baby food', 'baby lotion'] },
  { key: 'health-wellness', label: 'Health & Wellness',       target: 20, source: 'unsplash', queries: ['vitamins', 'supplements', 'protein powder', 'hand sanitiser'] },
  { key: 'specialty',       label: 'Organic & Specialty',     target: 20, source: 'off-then-unsplash', offTag: 'organic',
    queries: ['organic produce', 'gluten free bread', 'vegan snacks'] },
];

// Curated price ranges per category (USD minor, i.e. cents).
const PRICE_RANGES_CENTS = {
  produce:         [ 99,   899],   // bananas to fancy berries
  'dairy-eggs':    [199,   899],   // milk to imported cheese
  bakery:          [199,  1499],   // bread to artisan cakes
  'meat-seafood':  [499,  3999],   // chicken to ribeye
  beverages:       [149,   799],
  snacks:          [149,   899],
  pantry:          [199,  1499],
  frozen:          [299,  1499],
  cereals:         [299,   899],
  'pet-food':      [499,  4999],
  'personal-care': [299,  1999],
  household:       [299,  1999],
  'baby-kids':     [499,  2499],
  'health-wellness': [499, 3999],
  specialty:       [299,  2499],
};

// Curated brand list per non-grocery category — used to invent plausible
// product names from Unsplash photos (which don't carry brand metadata).
const BRAND_PROMPTS = {
  'pet-food':       ['HappyTails', 'PawPrime', 'NaturePet', 'WildBounty', 'Pawsome', 'TopPaw', 'BoneAppetit'],
  'personal-care':  ['LuxeBath', 'PureBloom', 'EcoSkin', 'FreshDaily', 'GentleCare', 'BloomEssentials', 'BareNatural'],
  household:        ['SparkleHome', 'PureClean', 'EcoNest', 'FreshHome', 'HomeBright', 'CleanCo', 'SwiftClean'],
  'baby-kids':      ['LittleSprout', 'TinyDream', 'BabyBloom', 'GentleStart', 'SweetTouch'],
  'health-wellness':['VitaPure', 'WellSource', 'NaturePath', 'PrimeHealth', 'EverWell', 'PureBoost'],
  // Grocery brands used when OFF rows fall short and we top up via Unsplash.
  produce:          ['FarmFresh', 'GreenAcres', 'OrchardPick', 'GardenSelect'],
  'dairy-eggs':     ['Dairyland', 'MorningPour', 'PureMilk', 'GoldenChurn'],
  bakery:           ['HearthBaked', 'Crustino', 'GoldenLoaf', 'Artisan&Co'],
  'meat-seafood':   ['ButcherCraft', 'PrimeSelect', 'OceanFresh', 'FieldMaster'],
  beverages:        ['Quench', 'Sipster', 'PureFlow', 'OrchardBlend'],
  snacks:           ['SnackJoy', 'Crunchy', 'BiteMore', 'PocketTreat'],
  pantry:           ['Hometaste', 'Larder', 'GoodMorning', 'KitchenStaple'],
  frozen:           ['FrostFresh', 'IcyHarvest', 'ColdRoom', 'EverFresh'],
  cereals:          ['MorningCrunch', 'GoldGrain', 'DayBowl', 'OatNation'],
  specialty:        ['PureRoots', 'WholeNature', 'GreenLife', 'CleanCraft'],
};

// Curated Unsplash photo IDs by query (10-15 each). Direct CDN URLs, no
// API key required, stable across deploys. Generated by hand-picking from
// unsplash.com search results — all under Unsplash License (free for
// commercial + non-commercial use).
const UNSPLASH_PHOTO_IDS = {
  'shampoo':           ['photo-1556228720-195a672e8a03', 'photo-1571781926291-c477ebfd024b', 'photo-1626808642875-0aa545482dfb', 'photo-1535585209827-a15fcdbc4c2d'],
  'soap bar':          ['photo-1600857544200-b2f666a9a2ec', 'photo-1556228578-8c89e6adf883', 'photo-1571875257727-256c39da42af', 'photo-1607006677937-5e88da9e0b6e'],
  'toothpaste':        ['photo-1607613009820-a29f7bb81c04', 'photo-1559591935-c6c92c6cb2d8', 'photo-1556228852-80b6e5eeff06'],
  'lotion':            ['photo-1571781565097-bc0f2a02db18', 'photo-1556228841-a73a9a1f06ae', 'photo-1556228720-da4ed1c4e3a4'],
  'deodorant':         ['photo-1631730486572-226d1f595b68', 'photo-1556228852-80b6e5eeff06'],
  'razor':             ['photo-1621607512214-68297480165e', 'photo-1521335751770-3ce5cf2f3e2f'],
  'dog food':          ['photo-1589924691995-400dc9ecc119', 'photo-1623387641168-d9803ddd3f35', 'photo-1560743173-567a3b5658b1'],
  'cat food':          ['photo-1556909114-f6e7ad7d3136', 'photo-1574144611937-0df059b5ef3e', 'photo-1592194996308-7b43878e84a6'],
  'pet treats':        ['photo-1601758228041-f3b2795255f1', 'photo-1611250282006-4484dd3fba6b'],
  'detergent':         ['photo-1583947581924-860bda3eea53', 'photo-1610557892470-55d9e80c0bce'],
  'cleaning spray':    ['photo-1583947215259-38e31be8751f', 'photo-1582735689369-4fe89db7114c', 'photo-1585670210693-e2929e9bf2d5'],
  'paper towels':      ['photo-1605600659908-0ef719419d41', 'photo-1583947581924-860bda3eea53'],
  'trash bags':        ['photo-1604187351574-c75ca79f5807', 'photo-1582735689369-4fe89db7114c'],
  'sponge':            ['photo-1607344645866-009c320b63e0', 'photo-1583947215259-38e31be8751f'],
  'baby diapers':      ['photo-1555252333-9f8e92e65df9', 'photo-1581952976147-5a2d15560349'],
  'baby food':         ['photo-1587735243615-c03f25aaff15', 'photo-1591216105690-cb1d6e62054a'],
  'baby lotion':       ['photo-1556228720-195a672e8a03', 'photo-1581952976147-5a2d15560349'],
  'vitamins':          ['photo-1584308666744-24d5c474f2ae', 'photo-1550572017-edd951b55104', 'photo-1626202373052-9cf6ad53dde9'],
  'supplements':       ['photo-1607619056574-7b8d3ee536b2', 'photo-1559757175-5700dde675bc', 'photo-1543362906-acfc16c67564'],
  'protein powder':    ['photo-1593095948071-474c5cc2989d', 'photo-1579722820308-d74e571900a9'],
  'hand sanitiser':    ['photo-1584474893540-bd23bf30ce6b', 'photo-1583947215259-38e31be8751f'],
  'olive oil bottle':  ['photo-1474979266404-7eaacbcd87c5', 'photo-1543158266-0066955047b0', 'photo-1599490659213-e2b9527bd087'],
  'rice bag':          ['photo-1586201375761-83865001e31c', 'photo-1536304993881-ff6e9eefa2a6'],
  'pasta box':         ['photo-1551892589-865f69869476', 'photo-1612874742237-6526221588e3', 'photo-1551183053-bf91a1d81141'],
  'flour bag':         ['photo-1574323347407-f5e1ad6d020b', 'photo-1518779578993-ec3579fee39f'],
  'sugar bag':         ['photo-1581798459219-318e76aecc7b', 'photo-1518779578993-ec3579fee39f'],
  'spices jar':        ['photo-1532336414038-cf19250c5757', 'photo-1505253716362-afaea1d3d1af', 'photo-1596040033229-a9821ebd058d'],
  'sauce jar':         ['photo-1607635476569-78891ab5acce', 'photo-1556909114-f6e7ad7d3136'],
  'canned beans':      ['photo-1604848698030-c434ba08ece1', 'photo-1542838132-92c53300491e'],
  // Produce
  'fresh apples':      ['photo-1568702846914-96b305d2aaeb', 'photo-1567306226416-28f0efdc88ce', 'photo-1570913149827-d2ac84ab3f9a'],
  'banana bunch':      ['photo-1571771894821-ce9b6c11b08e', 'photo-1603833665858-e61d17a86224'],
  'oranges fruit':     ['photo-1547514701-42782101795e', 'photo-1611080626919-7cf5a9dbab5b'],
  'tomatoes fresh':    ['photo-1592924357228-91a4daadcfea', 'photo-1582284540020-8acbe03f4924'],
  'lettuce':           ['photo-1622206151226-18ca2c9ab4a1', 'photo-1556801712-76c8eb07bbc9'],
  'spinach leaves':    ['photo-1576045057995-568f588f82fb', 'photo-1515872474884-c6dc9f8e9b6f'],
  'avocado':           ['photo-1588386655958-2d6f5dec3a96', 'photo-1601039641847-7857b994d704'],
  // Dairy
  'milk bottle':       ['photo-1550583724-b2692b85b150', 'photo-1563636619-e9143da7973b'],
  'cheese block':      ['photo-1486297678162-eb2a19b0a32d', 'photo-1626957341926-98752fc2ba90'],
  'butter pack':       ['photo-1589985270826-4b7bb135bc9d', 'photo-1604908176997-125f25cc6f3d'],
  'yogurt cup':        ['photo-1488477181946-6428a0291777', 'photo-1571212515416-fef01fc43637'],
  'eggs carton':       ['photo-1582722872445-44dc5f7e3c8f', 'photo-1569288063643-5d29ad6ac6d0'],
  // Bakery
  'bread loaf':        ['photo-1509440159596-0249088772ff', 'photo-1568254183919-78a4f43a2877'],
  'croissant':         ['photo-1555507036-ab1f4038808a', 'photo-1612203985729-70726954388c'],
  'baguette':          ['photo-1623334044303-241021148842', 'photo-1571115177098-24ec42ed204d'],
  'bagel':             ['photo-1592151450707-c1faabc2eea3', 'photo-1612203985729-70726954388c'],
  'muffin':            ['photo-1607958996333-41aef7caefaa', 'photo-1604152135912-04a022e23696'],
  // Meat & Seafood
  'chicken meat':      ['photo-1604503468506-a8da13d82791', 'photo-1606728035253-49e8a23146de'],
  'beef cut':          ['photo-1588347818111-8f3a73f7d2d3', 'photo-1607623814075-e51df1bdc82f'],
  'salmon fish':       ['photo-1599084993091-1cb5c0721cc6', 'photo-1535007813616-79dc02ba4021'],
  'shrimp seafood':    ['photo-1565680018434-b513d5e5fd47', 'photo-1565680018160-d349fe53de21'],
  'sausages':          ['photo-1551892374-ecf8754cf8b0', 'photo-1607013251379-e6eecfffe234'],
  // Beverages
  'orange juice bottle': ['photo-1600271886742-f049cd451bba', 'photo-1497534446932-c925b458314e'],
  'sparkling water':   ['photo-1546173159-315724a31696', 'photo-1564725073220-a59cdca2e745'],
  'cola can':          ['photo-1554866585-cd94860890b7', 'photo-1517959105821-eaf2591984ca'],
  'iced tea bottle':   ['photo-1556679343-c7306c1976bc', 'photo-1571805341302-f857fbc2b933'],
  'energy drink':      ['photo-1622543925917-66b15dac5d3a', 'photo-1622543925921-31bb89b94f5f'],
  // Snacks
  'chocolate bar':     ['photo-1582058091505-f87a2e55a40f', 'photo-1623660053975-e89c8c6e93f4'],
  'potato chips':      ['photo-1566478989037-eec170784d0b', 'photo-1599490659213-e2b9527bd087'],
  'cookies pack':      ['photo-1499636136210-6f4ee915583e', 'photo-1568051243858-533a607809a5'],
  'candy bag':         ['photo-1582058091505-f87a2e55a40f', 'photo-1581798459219-318e76aecc7b'],
  'granola bar':       ['photo-1606312619070-d48b4c652e6c', 'photo-1571212515416-fef01fc43637'],
  'pretzel':           ['photo-1607920591413-4ec007e70023', 'photo-1599627446385-5cba1d4be77a'],
  // Frozen
  'frozen pizza':      ['photo-1565299624946-b28f40a0ae38', 'photo-1574071318508-1cdbab80d002'],
  'ice cream tub':     ['photo-1576506295286-5cda18df43e7', 'photo-1497034825429-c343d7c6a68f'],
  'frozen vegetables': ['photo-1583258292688-d0213dc5a3a8', 'photo-1567394445833-be35bbc25f59'],
  'frozen waffles':    ['photo-1562376552-0d160a2f238d', 'photo-1568051243858-533a607809a5'],
  // Cereals
  'cereal box':        ['photo-1564506474-c3acab30f24a', 'photo-1571781565097-bc0f2a02db18'],
  'oatmeal package':   ['photo-1517673400267-0251440c45dc', 'photo-1571212515416-fef01fc43637'],
  'granola bag':       ['photo-1606312619070-d48b4c652e6c', 'photo-1571212515416-fef01fc43637'],
  // Specialty
  'organic produce':   ['photo-1574226516831-e1dff420e562', 'photo-1542838132-92c53300491e'],
  'gluten free bread': ['photo-1509440159596-0249088772ff', 'photo-1565299624946-b28f40a0ae38'],
  'vegan snacks':      ['photo-1606312619070-d48b4c652e6c', 'photo-1582058091505-f87a2e55a40f'],
};

// Adjective pool to vary Unsplash-derived product names so 30 personal-care
// items don't all read "Shampoo · 250ml". Combined as `${adj} ${kind}`.
const QUALITY_ADJ = ['Premium', 'Daily', 'Gentle', 'Pure', 'Natural', 'Eco', 'Family', 'Travel-size', 'Classic', 'Active', 'Sensitive', 'Refreshing', 'Soothing', 'Original'];
const VARIANT_ADJ = ['Lavender', 'Citrus', 'Mint', 'Fresh Linen', 'Coconut', 'Aloe', 'Vanilla', 'Unscented', 'Tropical', 'Forest', 'Ocean'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Deterministic PRNG so re-running build-demo-catalog produces identical
// JSON (no diff churn in commits unless TARGETS / sources actually change).
let _seed = 42;
function rand() {
  _seed = (_seed * 1664525 + 1013904223) % 4294967296;
  return _seed / 4294967296;
}
function pickSeeded(arr) { return arr[Math.floor(rand() * arr.length)]; }
function randint(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }

function fetchJsonOnce(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'SitepressoDemoSeed/1.0 (admin@sitepresso.com)' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Bad JSON: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// OFF returns HTML error pages under load. Retry with exponential backoff
// up to 4 times so a transient 503 / WAF challenge doesn't kill a category.
async function fetchJson(url, attempt = 1) {
  try {
    return await fetchJsonOnce(url);
  } catch (e) {
    if (attempt >= 4) throw e;
    const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
    await new Promise((r) => setTimeout(r, delay));
    return fetchJson(url, attempt + 1);
  }
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function cleanName(raw) {
  if (!raw) return '';
  // Strip leading/trailing punctuation, normalize whitespace, drop weird
  // OFF artefacts like ",,," or repeated brand suffixes.
  return String(raw)
    .replace(/[,;|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// Crude English-readability filter — enough to keep the worst offenders
// (mostly French/German OFF rows) out of the catalog without losing too
// many real entries.
function looksEnglishish(name) {
  if (!name) return false;
  if (/[éèêëàâîïôûùüÿñç]/i.test(name)) return false; // diacritics
  if (/^[A-Z]{4,}/.test(name) && !/\s/.test(name)) return false; // SHOUTY single word
  if (name.length < 4 || name.length > 80) return false;
  return true;
}

async function fetchOffCategory({ key, target, offTag }) {
  console.log(`  → OFF: ${offTag} (target ${target})`);
  const products = [];
  let page = 1;
  // Pull up to 5 pages of 50 products each (max 250) until we have enough
  // English-readable rows with photos.
  while (products.length < target * 3 && page <= 5) {
    const url = `https://world.openfoodfacts.org/api/v2/search?categories_tags=${encodeURIComponent(offTag)}&fields=product_name,product_name_en,brands,image_url,quantity&page_size=50&page=${page}`;
    let data;
    try { data = await fetchJson(url); }
    catch (e) {
      console.log(`    ⚠ page ${page} failed: ${e.message} — skipping`);
      break;
    }
    if (!data?.products?.length) break;
    for (const p of data.products) {
      const name = cleanName(p.product_name_en || p.product_name || '');
      if (!looksEnglishish(name)) continue;
      if (!p.image_url) continue;
      const brand = cleanName((p.brands || '').split(',')[0]);
      products.push({
        rawName: name,
        brand: brand || pickSeeded(['Pantry', 'Hometaste', 'Larder', 'GoodMorning']),
        imageUrls: [p.image_url],
        weightDisplay: cleanName(p.quantity || '') || null,
      });
    }
    page += 1;
    // Polite pacing — OFF rate-limits aggressively otherwise.
    await new Promise((r) => setTimeout(r, 1200));
  }
  // Prefer products with both brand + quantity, but keep partials so the
  // final count still reaches target.
  const ranked = products.sort((a, b) => {
    const sa = (a.brand ? 2 : 0) + (a.weightDisplay ? 1 : 0);
    const sb = (b.brand ? 2 : 0) + (b.weightDisplay ? 1 : 0);
    return sb - sa;
  });
  return ranked.slice(0, target);
}

// Categories where a scent/flavor variant suffix makes sense in product
// names. Doesn't apply to produce/bakery/meat etc. (no one buys
// "Citrus apples").
const CATEGORIES_WITH_VARIANTS = new Set(['personal-care', 'household', 'baby-kids']);

function buildUnsplashCategory({ key, target, queries }) {
  console.log(`  → Unsplash: ${queries.join(', ')} (target ${target})`);
  const products = [];
  let i = 0;
  while (products.length < target) {
    const query = queries[i % queries.length];
    const ids = UNSPLASH_PHOTO_IDS[query] || [];
    if (ids.length === 0) {
      console.log(`    ⚠ no curated photos for "${query}" — using a stock placeholder`);
      products.push({
        rawName: `${pick(QUALITY_ADJ)} ${query}`,
        brand: pick(BRAND_PROMPTS[key] || ['Sample']),
        imageUrls: ['https://images.unsplash.com/photo-1556228852-80b6e5eeff06?w=600&h=600&fit=crop'],
        weightDisplay: null,
      });
    } else {
      const photoId = ids[(i * 7) % ids.length]; // stable cycle
      const adj = pickSeeded(QUALITY_ADJ);
      const useVariant = CATEGORIES_WITH_VARIANTS.has(key) && rand() > 0.5;
      const productName = useVariant
        ? `${adj} ${query} — ${pickSeeded(VARIANT_ADJ)}`
        : `${adj} ${query}`;
      products.push({
        rawName: productName,
        brand: pickSeeded(BRAND_PROMPTS[key] || ['Sample']),
        imageUrls: [`https://images.unsplash.com/${photoId}?w=600&h=600&fit=crop&q=80`],
        weightDisplay: pickSeeded(['250ml bottle', '500ml bottle', '100g bar', '6-pack', 'family size', '500g pack']),
      });
    }
    i += 1;
  }
  return products;
}

function priceFor(categoryKey) {
  const [min, max] = PRICE_RANGES_CENTS[categoryKey] || [299, 1999];
  // Round to nearest 10 cents so prices feel curated, not random.
  const raw = randint(min, max);
  return Math.round(raw / 10) * 10;
}

function buildOneProduct(category, raw, idx) {
  const baseName = raw.brand ? `${raw.brand} ${raw.rawName}` : raw.rawName;
  const name = cleanName(baseName);
  const slug = slugify(`${name}-${idx}`);
  const priceMinor = priceFor(category.key);
  // ~15% on sale; compare-price is 20-50% above current.
  const onSale = rand() < 0.15;
  const comparePriceMinor = onSale ? Math.round(priceMinor * (1.2 + rand() * 0.3) / 10) * 10 : null;
  // Stock: ~5% out, ~10% low (1-4), rest 5-100. Some unlimited (null).
  let stockQty;
  const r = rand();
  if (r < 0.05)        stockQty = 0;
  else if (r < 0.15)   stockQty = randint(1, 4);
  else if (r < 0.85)   stockQty = randint(5, 100);
  else                 stockQty = null; // unlimited
  // ~5% featured.
  const isFeatured = rand() < 0.05;
  const description = `${name}. ${pickSeeded([
    'Carefully sourced and packed for daily use.',
    'A staple item every household reaches for.',
    'Trusted quality at a fair price.',
    'Made for everyday cooking and snacking.',
    'Stocked fresh from our local suppliers.',
  ])}`;

  return {
    name,
    slug,
    description,
    shortDescription: name,
    sku: null,
    priceMinor,
    comparePriceMinor,
    currency: 'USD',
    stockQty,
    weightGrams: null,
    weightDisplay: raw.weightDisplay || null,
    imageUrls: raw.imageUrls.slice(0, 3),
    isPublished: true,
    isFeatured,
    sortOrder: idx,
    metaTitle: null,
    metaDescription: null,
    categoryKey: category.key,
  };
}

async function main() {
  console.log('Building demo-shop catalog…');
  const catalog = { categories: [], products: [] };

  for (const cat of CATEGORY_TARGETS) {
    catalog.categories.push({
      key: cat.key,
      label: cat.label,
      sortOrder: catalog.categories.length + 1,
    });
    let raws;
    if (cat.source === 'off') {
      raws = await fetchOffCategory(cat);
    } else if (cat.source === 'unsplash') {
      raws = buildUnsplashCategory(cat);
    } else if (cat.source === 'off-then-unsplash') {
      raws = await fetchOffCategory(cat);
      if (raws.length < cat.target) {
        const remaining = cat.target - raws.length;
        const filler = buildUnsplashCategory({ ...cat, target: remaining });
        raws = raws.concat(filler);
      }
    } else {
      raws = [];
    }
    raws.forEach((raw, i) => {
      const product = buildOneProduct(cat, raw, catalog.products.length + i);
      catalog.products.push(product);
    });
    console.log(`    ✓ ${cat.label}: ${raws.length}/${cat.target}`);
  }

  const outDir = path.join(__dirname, 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'demo-shop-catalog.json');
  fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2));
  console.log(`\nWrote ${catalog.products.length} products across ${catalog.categories.length} categories → ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
