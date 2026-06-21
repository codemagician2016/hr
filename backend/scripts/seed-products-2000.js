#!/usr/bin/env node
/**
 * Seeds ~2000 products across a 3-level category tree (parent → sub → leaf)
 * with the full brand catalog (ProductBrandFamily → ProductBrand → Product).
 *
 * Usage:
 *   node backend/scripts/seed-products-2000.js [slug] [country]
 *
 * Examples:
 *   node backend/scripts/seed-products-2000.js               # default: ecom / IN
 *   node backend/scripts/seed-products-2000.js ecom IN
 *   node backend/scripts/seed-products-2000.js mystore NZ
 *
 * What it does:
 *   1. Finds (or creates) the target business by slug.
 *   2. Sets categoryMaxDepth = 3 so leaf categories work.
 *   3. Seeds the country brand catalog (idempotent).
 *   4. Creates 3-level category tree if not already present.
 *   5. Generates ~2048 products distributed across leaf categories,
 *      most assigned to a real brand from the catalog.
 *
 * Idempotent on a per-slug basis — skips products whose slug already exists.
 */

'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const path = require('path');

const TARGET_SLUG = process.argv[2] || 'ecom';
const COUNTRY = (process.argv[3] || 'IN').toUpperCase();

// Lazy-load brand catalog from the canonical lib.
const { seedBrandsForBusiness } = require(path.join(__dirname, '..', 'src', 'core', 'lib', 'brandCatalog'));

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// ─── 3-level category tree ────────────────────────────────────────────────
// 8 parents × 4 subs × 4 leafs = 128 leaf categories.
// Parent maps to broad price range + realistic product-name templates
// (defined later in PRODUCT_TEMPLATES).

const CATEGORY_TREE = [
  { name: 'Fresh Produce', emoji: '🥬', priceRange: [2000, 30000], brandHint: 'unbranded',
    children: [
      { name: 'Fruits', children: ['Apples & Pears', 'Tropical Fruits', 'Berries', 'Citrus'] },
      { name: 'Vegetables', children: ['Leafy Greens', 'Root Vegetables', 'Tomatoes & Peppers', 'Onions & Garlic'] },
      { name: 'Herbs & Sprouts', children: ['Fresh Herbs', 'Microgreens', 'Sprouts', 'Edible Flowers'] },
      { name: 'Organic Range', children: ['Organic Fruits', 'Organic Vegetables', 'Organic Herbs', 'Organic Salads'] },
    ]},
  { name: 'Dairy, Bakery & Eggs', emoji: '🥛', priceRange: [3000, 40000], brandHint: 'dairy',
    children: [
      { name: 'Milk & Cream', children: ['Cow Milk', 'Buffalo Milk', 'Plant Milk', 'Cream & Butter'] },
      { name: 'Cheese & Curd', children: ['Hard Cheese', 'Soft Cheese', 'Paneer', 'Yogurt & Curd'] },
      { name: 'Eggs', children: ['Hen Eggs', 'Duck Eggs', 'Quail Eggs', 'Liquid Eggs'] },
      { name: 'Bakery', children: ['Bread & Buns', 'Cakes & Pastries', 'Cookies', 'Indian Sweets'] },
    ]},
  { name: 'Meat & Seafood', emoji: '🥩', priceRange: [10000, 80000], brandHint: 'meat',
    children: [
      { name: 'Chicken', children: ['Whole Chicken', 'Boneless', 'Drumsticks', 'Wings'] },
      { name: 'Mutton & Lamb', children: ['Mutton Curry Cut', 'Mutton Chops', 'Mutton Mince', 'Lamb Special'] },
      { name: 'Seafood', children: ['Prawns', 'Fish Fillet', 'Whole Fish', 'Crab & Squid'] },
      { name: 'Plant-Based', children: ['Soya Chunks', 'Mock Meat', 'Tofu', 'Tempeh'] },
    ]},
  { name: 'Beverages', emoji: '🧃', priceRange: [2000, 30000], brandHint: 'beverage',
    children: [
      { name: 'Soft Drinks', children: ['Cola', 'Lemon-Lime', 'Orange', 'Energy Drinks'] },
      { name: 'Juices', children: ['Fruit Juice', 'Vegetable Juice', 'Coconut Water', 'Smoothies'] },
      { name: 'Tea & Coffee', children: ['Black Tea', 'Green Tea', 'Instant Coffee', 'Filter Coffee'] },
      { name: 'Water', children: ['Mineral Water', 'Sparkling Water', 'Flavored Water', 'Bulk Cans'] },
    ]},
  { name: 'Snacks & Confectionery', emoji: '🍪', priceRange: [1000, 30000], brandHint: 'snack',
    children: [
      { name: 'Chips & Crisps', children: ['Potato Chips', 'Corn Chips', 'Banana Chips', 'Veggie Chips'] },
      { name: 'Biscuits & Cookies', children: ['Cream Biscuits', 'Glucose Biscuits', 'Cookies', 'Wafers'] },
      { name: 'Chocolates', children: ['Milk Chocolate', 'Dark Chocolate', 'White Chocolate', 'Filled Bars'] },
      { name: 'Nuts & Seeds', children: ['Almonds', 'Cashews', 'Mixed Nuts', 'Seeds Mix'] },
    ]},
  { name: 'Pantry & Cooking', emoji: '🫙', priceRange: [3000, 80000], brandHint: 'pantry',
    children: [
      { name: 'Rice & Grains', children: ['Basmati Rice', 'Brown Rice', 'Quinoa', 'Millets'] },
      { name: 'Atta, Flour & Dals', children: ['Wheat Atta', 'Multigrain Atta', 'Toor Dal', 'Moong Dal'] },
      { name: 'Oils & Ghee', children: ['Sunflower Oil', 'Mustard Oil', 'Olive Oil', 'Pure Ghee'] },
      { name: 'Spices & Masalas', children: ['Whole Spices', 'Ground Spices', 'Masala Mixes', 'Pickles'] },
    ]},
  { name: 'Frozen & Ready Meals', emoji: '🧊', priceRange: [8000, 50000], brandHint: 'frozen',
    children: [
      { name: 'Frozen Vegetables', children: ['Peas & Corn', 'Mixed Veg', 'French Fries', 'Veg Patty'] },
      { name: 'Frozen Snacks', children: ['Spring Rolls', 'Samosas', 'Cutlets', 'Tikka Bites'] },
      { name: 'Ice Cream', children: ['Tubs', 'Cones', 'Sticks', 'Sundae Cups'] },
      { name: 'Ready Meals', children: ['Indian Curries', 'Pasta Meals', 'Pizza', 'Wraps'] },
    ]},
  { name: 'Personal Care', emoji: '🧴', priceRange: [5000, 60000], brandHint: 'personal',
    children: [
      { name: 'Hair Care', children: ['Shampoo', 'Conditioner', 'Hair Oil', 'Hair Color'] },
      { name: 'Skin Care', children: ['Face Wash', 'Moisturizer', 'Sunscreen', 'Body Lotion'] },
      { name: 'Oral Care', children: ['Toothpaste', 'Toothbrush', 'Mouthwash', 'Floss'] },
      { name: 'Bath & Body', children: ['Soap Bars', 'Shower Gel', 'Talcum Powder', 'Deodorant'] },
    ]},
];

// ─── Variant + size word banks for synthetic but realistic names ──────────

const VARIANTS = {
  'Apples & Pears': ['Royal Gala', 'Granny Smith', 'Fuji', 'Red Delicious', 'Honeycrisp', 'Bartlett Pear', 'Asian Pear'],
  'Tropical Fruits': ['Alphonso Mango', 'Banana', 'Pineapple', 'Papaya', 'Dragon Fruit', 'Coconut', 'Lychee'],
  'Berries': ['Strawberry', 'Blueberry', 'Raspberry', 'Blackberry', 'Cranberry', 'Mixed Berries'],
  'Citrus': ['Orange', 'Mosambi', 'Lemon', 'Lime', 'Grapefruit', 'Tangerine'],
  'Leafy Greens': ['Spinach', 'Methi', 'Kale', 'Lettuce', 'Coriander', 'Mint', 'Mustard Greens'],
  'Root Vegetables': ['Potato', 'Sweet Potato', 'Carrot', 'Beetroot', 'Radish', 'Turnip', 'Yam'],
  'Tomatoes & Peppers': ['Hybrid Tomato', 'Cherry Tomato', 'Capsicum', 'Bell Pepper', 'Green Chilli'],
  'Onions & Garlic': ['Red Onion', 'White Onion', 'Spring Onion', 'Garlic', 'Shallot', 'Ginger'],
  'Fresh Herbs': ['Coriander', 'Mint', 'Parsley', 'Basil', 'Curry Leaves', 'Dill', 'Thyme'],
  'Microgreens': ['Pea Shoots', 'Radish Microgreens', 'Sunflower', 'Broccoli', 'Mustard'],
  'Sprouts': ['Moong Sprouts', 'Chickpea Sprouts', 'Alfalfa', 'Wheat Grass', 'Mixed Sprouts'],
  'Edible Flowers': ['Marigold', 'Nasturtium', 'Pansy', 'Rose Petal', 'Calendula'],
  'Organic Fruits': ['Organic Apple', 'Organic Banana', 'Organic Mango', 'Organic Berries'],
  'Organic Vegetables': ['Organic Tomato', 'Organic Spinach', 'Organic Carrot', 'Organic Beetroot'],
  'Organic Herbs': ['Organic Basil', 'Organic Coriander', 'Organic Mint', 'Organic Parsley'],
  'Organic Salads': ['Organic Salad Mix', 'Organic Rocket', 'Organic Spinach Mix'],

  'Cow Milk': ['Full Cream', 'Toned', 'Double Toned', 'Skim', 'A2'],
  'Buffalo Milk': ['Premium', 'Standardized', 'Full Cream', 'Pure'],
  'Plant Milk': ['Almond Milk', 'Oat Milk', 'Soy Milk', 'Coconut Milk', 'Cashew Milk'],
  'Cream & Butter': ['Salted Butter', 'Unsalted Butter', 'Cooking Cream', 'Whipping Cream', 'Sour Cream'],
  'Hard Cheese': ['Cheddar', 'Parmesan', 'Gouda', 'Edam', 'Pepper Jack'],
  'Soft Cheese': ['Mozzarella', 'Cottage Cheese', 'Feta', 'Brie', 'Cream Cheese'],
  'Paneer': ['Fresh Paneer', 'Smoked Paneer', 'Low-fat Paneer', 'Paneer Tikka'],
  'Yogurt & Curd': ['Plain Curd', 'Greek Yogurt', 'Fruit Yogurt', 'Lassi', 'Buttermilk'],
  'Hen Eggs': ['Brown Eggs', 'White Eggs', 'Free Range', 'Omega-3', 'Cage Free'],
  'Duck Eggs': ['Free Range Duck Eggs', 'Premium Duck Eggs'],
  'Quail Eggs': ['Pickled Quail Eggs', 'Fresh Quail Eggs'],
  'Liquid Eggs': ['Egg Whites', 'Whole Egg Liquid', 'Yolk Pack'],
  'Bread & Buns': ['White Bread', 'Whole Wheat Bread', 'Multigrain', 'Sourdough', 'Brioche Buns', 'Burger Buns'],
  'Cakes & Pastries': ['Chocolate Cake', 'Vanilla Cake', 'Black Forest', 'Croissant', 'Danish'],
  'Cookies': ['Butter Cookies', 'Chocolate Chip', 'Oatmeal', 'Almond', 'Coconut'],
  'Indian Sweets': ['Gulab Jamun', 'Kaju Katli', 'Rasgulla', 'Soan Papdi', 'Mysore Pak'],

  'Whole Chicken': ['Whole Chicken', 'Free Range Chicken', 'Country Chicken', 'Broiler'],
  'Boneless': ['Chicken Breast', 'Chicken Thigh Fillet', 'Chicken Mince', 'Tenderloin'],
  'Drumsticks': ['Chicken Drumsticks', 'Skinless Drumsticks', 'Marinated Drumsticks'],
  'Wings': ['Chicken Wings', 'Buffalo Wings', 'Hot Wings'],
  'Mutton Curry Cut': ['Mutton Curry Cut', 'Mutton Bone-in', 'Mutton Boneless'],
  'Mutton Chops': ['Mutton Chops', 'Lamb Chops', 'French Cut Chops'],
  'Mutton Mince': ['Mutton Keema', 'Mutton Mince Premium'],
  'Lamb Special': ['Lamb Leg', 'Lamb Shoulder', 'Lamb Rack'],
  'Prawns': ['Tiger Prawns', 'Jumbo Prawns', 'Peeled Prawns', 'Wild Prawns'],
  'Fish Fillet': ['Salmon Fillet', 'Tuna Steak', 'Basa Fillet', 'Pomfret Fillet'],
  'Whole Fish': ['Whole Pomfret', 'Whole Rohu', 'Whole Mackerel', 'Whole Sardine'],
  'Crab & Squid': ['Mud Crab', 'Soft Shell Crab', 'Squid Rings', 'Calamari Tubes'],
  'Soya Chunks': ['Soya Chunks', 'Soya Granules', 'Soya Mince'],
  'Mock Meat': ['Plant Chicken', 'Plant Mutton', 'Plant Mince'],
  'Tofu': ['Firm Tofu', 'Silken Tofu', 'Smoked Tofu', 'Marinated Tofu'],
  'Tempeh': ['Plain Tempeh', 'Smoky Tempeh'],

  'Cola': ['Cola', 'Diet Cola', 'Cherry Cola', 'Vanilla Cola'],
  'Lemon-Lime': ['Lemon Soda', 'Lime Soda', 'Lime Cordial', 'Citrus Twist'],
  'Orange': ['Orange Soda', 'Sparkling Orange', 'Orange Squash'],
  'Energy Drinks': ['Energy Drink', 'Caffeine Burst', 'Berry Energy', 'Sugar-free Energy'],
  'Fruit Juice': ['Apple Juice', 'Orange Juice', 'Mango Juice', 'Mixed Fruit'],
  'Vegetable Juice': ['Beetroot Juice', 'Wheatgrass', 'Celery Juice', 'Carrot Juice'],
  'Coconut Water': ['Tender Coconut Water', 'Coconut Water', 'Flavored Coconut'],
  'Smoothies': ['Banana Smoothie', 'Berry Smoothie', 'Mango Smoothie', 'Green Smoothie'],
  'Black Tea': ['Premium Black Tea', 'Earl Grey', 'English Breakfast', 'Masala Chai'],
  'Green Tea': ['Pure Green Tea', 'Lemon Green Tea', 'Mint Green Tea', 'Matcha'],
  'Instant Coffee': ['Classic Coffee', 'Premium Roast', 'Decaf', 'Mocha Mix'],
  'Filter Coffee': ['South Indian Filter', 'French Roast', 'Italian Roast', 'Espresso Powder'],
  'Mineral Water': ['Mineral Water', 'Spring Water', 'Alkaline Water'],
  'Sparkling Water': ['Plain Sparkling', 'Lemon Sparkling', 'Lime Sparkling'],
  'Flavored Water': ['Lemon Water', 'Cucumber Water', 'Berry Water'],
  'Bulk Cans': ['20L Water Can', '5L Water Can', 'Office Pack'],

  'Potato Chips': ['Salted', 'Cream & Onion', 'Masala', 'Cheese & Onion', 'Tomato'],
  'Corn Chips': ['Original', 'Cheese', 'Sour Cream', 'Hot & Spicy'],
  'Banana Chips': ['Salted', 'Pepper', 'Sweet'],
  'Veggie Chips': ['Beetroot Chips', 'Sweet Potato', 'Mixed Veg'],
  'Cream Biscuits': ['Bourbon', 'Strawberry Cream', 'Chocolate Cream', 'Orange Cream'],
  'Glucose Biscuits': ['Plain', 'Milk', 'Honey'],
  'Cookies': ['Choco Chip', 'Butter', 'Oatmeal', 'Almond'],
  'Wafers': ['Chocolate Wafer', 'Vanilla Wafer', 'Strawberry Wafer'],
  'Milk Chocolate': ['Plain Milk', 'Almond Milk', 'Hazelnut Milk'],
  'Dark Chocolate': ['70% Dark', '85% Dark', 'Sea Salt Dark', 'Orange Dark'],
  'White Chocolate': ['Plain White', 'Strawberry White', 'Cranberry White'],
  'Filled Bars': ['Caramel Bar', 'Wafer Bar', 'Crispy Bar', 'Fruit & Nut'],
  'Almonds': ['Whole Almonds', 'Salted Almonds', 'Smoked Almonds', 'Roasted'],
  'Cashews': ['W320 Cashews', 'Salted Cashews', 'Roasted Cashews', 'Honey Cashews'],
  'Mixed Nuts': ['Premium Mix', 'Energy Mix', 'Trail Mix', 'Berry Nut Mix'],
  'Seeds Mix': ['Pumpkin Seeds', 'Sunflower Seeds', 'Chia Seeds', 'Flax Seeds'],

  'Basmati Rice': ['Premium Basmati', 'Aged Basmati', 'Brown Basmati', 'Long Grain'],
  'Brown Rice': ['Brown Basmati', 'Brown Sona Masuri', 'Whole Grain Brown'],
  'Quinoa': ['White Quinoa', 'Red Quinoa', 'Tri-Color Quinoa'],
  'Millets': ['Foxtail Millet', 'Pearl Millet', 'Finger Millet', 'Little Millet'],
  'Wheat Atta': ['Whole Wheat Atta', 'Sharbati Atta', 'Stone Ground Atta'],
  'Multigrain Atta': ['7-Grain Atta', '5-Grain Atta', 'Multigrain Plus'],
  'Toor Dal': ['Premium Toor', 'Polished Toor', 'Organic Toor'],
  'Moong Dal': ['Yellow Moong', 'Whole Moong', 'Split Moong'],
  'Sunflower Oil': ['Refined Sunflower', 'Cold Pressed', 'Premium'],
  'Mustard Oil': ['Kachi Ghani', 'Pungent Mustard', 'Premium Mustard'],
  'Olive Oil': ['Extra Virgin', 'Pomace', 'Light Olive'],
  'Pure Ghee': ['Cow Ghee', 'Buffalo Ghee', 'Desi Ghee', 'Bilona Ghee'],
  'Whole Spices': ['Black Pepper', 'Cumin', 'Cardamom', 'Cloves', 'Cinnamon'],
  'Ground Spices': ['Turmeric Powder', 'Red Chilli', 'Coriander Powder', 'Garam Masala'],
  'Masala Mixes': ['Chicken Masala', 'Biryani Masala', 'Pav Bhaji', 'Sambar Masala'],
  'Pickles': ['Mango Pickle', 'Lime Pickle', 'Mixed Pickle', 'Garlic Pickle'],

  'Peas & Corn': ['Frozen Peas', 'Sweet Corn', 'Mixed Peas & Corn'],
  'Mixed Veg': ['Frozen Mixed Veg', 'Stir-fry Mix', 'Curry Mix'],
  'French Fries': ['Crinkle Fries', 'Straight Cut', 'Wedges', 'Smileys'],
  'Veg Patty': ['Aloo Tikki', 'Veg Burger Patty', 'Spinach Patty'],
  'Spring Rolls': ['Veg Spring Roll', 'Chicken Spring Roll', 'Mini Rolls'],
  'Samosas': ['Aloo Samosa', 'Cocktail Samosa', 'Mini Samosa', 'Punjabi Samosa'],
  'Cutlets': ['Veg Cutlet', 'Chicken Cutlet', 'Fish Cutlet', 'Cheese Cutlet'],
  'Tikka Bites': ['Paneer Tikka', 'Chicken Tikka', 'Veg Tikka'],
  'Tubs': ['Vanilla Tub', 'Chocolate Tub', 'Mango Tub', 'Butterscotch Tub'],
  'Cones': ['Cone Vanilla', 'Cone Chocolate', 'Cone Strawberry'],
  'Sticks': ['Choco Bar', 'Orange Bar', 'Kulfi Stick'],
  'Sundae Cups': ['Brownie Sundae', 'Caramel Sundae', 'Berry Sundae'],
  'Indian Curries': ['Paneer Butter Masala', 'Dal Makhani', 'Chicken Curry', 'Rajma'],
  'Pasta Meals': ['Mac & Cheese', 'Pasta Alfredo', 'Pasta Arrabiata', 'Pesto Pasta'],
  'Pizza': ['Margherita', 'Pepperoni', 'Veg Supreme', 'BBQ Chicken'],
  'Wraps': ['Veg Wrap', 'Chicken Wrap', 'Paneer Wrap'],

  'Shampoo': ['Anti-Dandruff', 'Smooth & Silky', 'Volume', 'Color Protect'],
  'Conditioner': ['Daily Care', 'Repair Conditioner', 'Volume Boost'],
  'Hair Oil': ['Coconut Oil', 'Almond Oil', 'Argan Oil', 'Bhringraj Oil'],
  'Hair Color': ['Black', 'Brown', 'Burgundy', 'Henna'],
  'Face Wash': ['Foaming Face Wash', 'Charcoal Face Wash', 'Brightening', 'Anti-acne'],
  'Moisturizer': ['Daily Moisturizer', 'Night Cream', 'Light Moisturizer'],
  'Sunscreen': ['SPF 30', 'SPF 50', 'Tinted SPF', 'Mineral SPF'],
  'Body Lotion': ['Cocoa Butter', 'Almond Lotion', 'Aloe Vera', 'Vitamin E'],
  'Toothpaste': ['Mint Fresh', 'Whitening', 'Sensitive', 'Herbal'],
  'Toothbrush': ['Soft Brush', 'Medium Brush', 'Charcoal Brush', 'Kids Brush'],
  'Mouthwash': ['Mint Mouthwash', 'Whitening Mouthwash', 'Sensitive Mouthwash'],
  'Floss': ['Mint Floss', 'Plain Floss', 'Wax Floss'],
  'Soap Bars': ['Sandalwood', 'Rose', 'Lemon', 'Charcoal', 'Aloe'],
  'Shower Gel': ['Fresh Shower Gel', 'Floral Gel', 'Mint Gel', 'Berry Gel'],
  'Talcum Powder': ['Cool Talc', 'Floral Talc', 'Sandal Talc'],
  'Deodorant': ['Original Spray', 'Sport Spray', 'Cool Burst', 'Floral Spray'],
};

const SIZES = {
  produce: ['250 g', '500 g', '1 kg', '2 kg', 'Per piece', 'Bunch'],
  dairy: ['200 ml', '500 ml', '1 L', '200 g', '500 g', '1 kg'],
  meat: ['250 g', '500 g', '1 kg', '2 kg'],
  beverage: ['250 ml', '500 ml', '1 L', '1.25 L', '2 L', '6 x 330 ml'],
  snack: ['50 g', '100 g', '200 g', '500 g', 'Family pack'],
  pantry: ['500 g', '1 kg', '2 kg', '5 kg', '10 kg', '500 ml', '1 L'],
  frozen: ['200 g', '400 g', '500 g', '1 kg'],
  personal: ['100 ml', '200 ml', '400 ml', '100 g', '200 g'],
  unbranded: ['250 g', '500 g', '1 kg', 'Per piece'],
};

// Map parent → bucket key in SIZES + brand-suitability hint
const PARENT_BRAND_HINT = {
  'Fresh Produce': 'unbranded',
  'Dairy, Bakery & Eggs': 'dairy',
  'Meat & Seafood': 'meat',
  'Beverages': 'beverage',
  'Snacks & Confectionery': 'snack',
  'Pantry & Cooking': 'pantry',
  'Frozen & Ready Meals': 'frozen',
  'Personal Care': 'personal',
};

// ─── Description templates ────────────────────────────────────────────────

const DESC_TEMPLATES = [
  '{name} — sourced from trusted suppliers and packaged with care.',
  'Premium quality {name}. {brand_phrase}A pantry essential for every household.',
  '{name} that meets our strict quality standards. {brand_phrase}',
  'Daily-use {name}. {brand_phrase}Stocked fresh, dispatched fast.',
  'Carefully selected {name}. {brand_phrase}Great value for everyday cooking.',
  'Top-rated {name} chosen by our team. {brand_phrase}',
];

const SHORT_DESC_TEMPLATES = [
  'Quality {name} at the right price.',
  'Fresh {name} delivered to your door.',
  'Premium {name}. Stock up today.',
  '{name} — a customer favourite.',
  'Reliable {name} for everyday use.',
];

// ─── Helpers ───────────────────────────────────────────────────────────────

async function findBusinessOrFail(slug) {
  const biz = await prisma.business.findUnique({ where: { slug } });
  if (!biz) {
    console.error(`✗ Business with slug "${slug}" not found.`);
    console.error('  Create one first via the admin signup flow, or pass an existing slug.');
    console.error('  Available slugs:');
    const list = await prisma.business.findMany({ select: { slug: true, name: true }, take: 20 });
    list.forEach(b => console.error(`    - ${b.slug} (${b.name})`));
    process.exit(1);
  }
  return biz;
}

async function ensureCategoryDepth(businessId) {
  await prisma.business.update({
    where: { id: businessId },
    data: { categoryMaxDepth: 3 },
  });
  console.log('  ✓ Set categoryMaxDepth = 3');
}

async function seedCategories(businessId) {
  const created = { parents: 0, subs: 0, leaves: 0 };
  const leafCategoryIds = [];

  for (const parent of CATEGORY_TREE) {
    const parentSlug = slugify(parent.name);
    let parentRow = await prisma.productCategory.findFirst({
      where: { businessId, slug: parentSlug, parentId: null },
    });
    if (!parentRow) {
      parentRow = await prisma.productCategory.create({
        data: {
          businessId, name: parent.name, slug: parentSlug,
          description: `${parent.emoji} ${parent.name}`,
          parentId: null, isPublished: true, sortOrder: 0,
        },
      });
      created.parents++;
    }

    for (const sub of parent.children) {
      const subSlug = `${parentSlug}-${slugify(sub.name)}`;
      let subRow = await prisma.productCategory.findFirst({
        where: { businessId, slug: subSlug, parentId: parentRow.id },
      });
      if (!subRow) {
        subRow = await prisma.productCategory.create({
          data: {
            businessId, name: sub.name, slug: subSlug,
            parentId: parentRow.id, isPublished: true, sortOrder: 0,
          },
        });
        created.subs++;
      }

      for (const leafName of sub.children) {
        const leafSlug = `${subSlug}-${slugify(leafName)}`;
        let leafRow = await prisma.productCategory.findFirst({
          where: { businessId, slug: leafSlug, parentId: subRow.id },
        });
        if (!leafRow) {
          leafRow = await prisma.productCategory.create({
            data: {
              businessId, name: leafName, slug: leafSlug,
              parentId: subRow.id, isPublished: true, sortOrder: 0,
            },
          });
          created.leaves++;
        }
        leafCategoryIds.push({
          id: leafRow.id, name: leafName,
          parentName: parent.name,
          brandHint: PARENT_BRAND_HINT[parent.name],
          priceRange: parent.priceRange,
        });
      }
    }
  }

  console.log(`  ✓ Categories: +${created.parents} parents, +${created.subs} subs, +${created.leaves} leaves (${leafCategoryIds.length} leaf total)`);
  return leafCategoryIds;
}

async function loadBrands(businessId) {
  const brands = await prisma.productBrand.findMany({
    where: { businessId, isActive: true },
    select: { id: true, name: true, brandFamilyId: true },
  });
  return brands;
}

// 80% of products get a real brand from the catalog. 20% are unbranded
// (typical for fresh produce + house-brand staples).
function pickBrand(brands, brandHint) {
  // For 'unbranded' parents (e.g. Fresh Produce), 70% are unbranded.
  if (brandHint === 'unbranded') {
    return Math.random() < 0.7 ? null : rand(brands);
  }
  // Most other categories: 85% branded.
  return Math.random() < 0.85 ? rand(brands) : null;
}

function genProductName(leafName, variant, size, brand) {
  // Examples of what this produces:
  //  "Royal Gala Apples 1 kg"
  //  "Surf Excel Detergent Powder 500 g"
  //  "Amul Cheddar Cheese 200 g"
  if (brand) {
    return `${brand} ${variant} ${size}`;
  }
  return `${variant} ${size}`;
}

function genDescription(name, brand) {
  const tpl = rand(DESC_TEMPLATES);
  const phrase = brand ? `From ${brand}. ` : '';
  return tpl.replace('{name}', name).replace('{brand_phrase}', phrase);
}

function genShortDescription(name) {
  return rand(SHORT_DESC_TEMPLATES).replace('{name}', name);
}

async function seedProducts(businessId, leafCategories, brands) {
  const target = 2000;
  const perLeaf = Math.ceil(target / leafCategories.length); // ~16 per leaf
  let created = 0, skipped = 0;

  console.log(`  Generating ~${perLeaf} products per leaf category × ${leafCategories.length} leaves = ~${perLeaf * leafCategories.length} products`);

  for (const leaf of leafCategories) {
    const variants = VARIANTS[leaf.name] || [leaf.name];
    const sizeBucket = SIZES[leaf.brandHint] || SIZES.unbranded;

    for (let i = 0; i < perLeaf; i++) {
      const variant = variants[i % variants.length];
      const size = rand(sizeBucket);
      const brand = pickBrand(brands, leaf.brandHint);
      const brandLabel = brand ? brand.name : null;

      const name = genProductName(leaf.name, variant, size, brandLabel);
      const slug = slugify(`${leaf.name}-${variant}-${size}-${i}`);

      // Skip if a product with the same slug already exists in this business.
      const exists = await prisma.product.findFirst({
        where: { businessId, slug },
        select: { id: true },
      });
      if (exists) { skipped++; continue; }

      const [minPrice, maxPrice] = leaf.priceRange;
      const priceMinor = randInt(minPrice, maxPrice);
      // 30% of products have a strikethrough price (10–25% above current)
      const hasCompare = Math.random() < 0.3;
      const comparePriceMinor = hasCompare ? Math.round(priceMinor * (1 + (Math.random() * 0.15 + 0.10))) : null;
      // 15% out of stock; 25% unlimited (NULL); rest have qty 5–200
      const stockRoll = Math.random();
      const stockQty = stockRoll < 0.15 ? 0 : stockRoll < 0.40 ? null : randInt(5, 200);
      // 5% featured on homepage
      const isFeatured = Math.random() < 0.05;

      await prisma.product.create({
        data: {
          businessId,
          categoryId: leaf.id,
          name,
          slug,
          brand: brandLabel,
          brandId: brand ? brand.id : null,
          description: genDescription(name, brandLabel),
          shortDescription: genShortDescription(name),
          priceMinor,
          comparePriceMinor,
          currency: 'INR',
          discountDisplayMode: 'PERCENTAGE',
          stockQty,
          imageUrls: [], // empty — admin can upload later
          isPublished: true,
          isFeatured,
          sortOrder: i,
        },
      });
      created++;
      if (created % 200 === 0) console.log(`    ... ${created} products created`);
    }
  }

  console.log(`  ✓ Products: +${created} created, ${skipped} skipped (already existed)`);
  return { created, skipped };
}

// ─── main ──────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n=== Seeding ~2000 products for "${TARGET_SLUG}" (country=${COUNTRY}) ===\n`);

  const biz = await findBusinessOrFail(TARGET_SLUG);
  console.log(`✓ Business: ${biz.name} (id=${biz.id.slice(0, 8)}...)\n`);

  console.log('1. Setting category depth to 3...');
  await ensureCategoryDepth(biz.id);

  console.log('\n2. Seeding brand catalog (idempotent)...');
  const brandStats = await seedBrandsForBusiness(prisma, { businessId: biz.id, countryCode: COUNTRY });
  console.log(`  ✓ Brand catalog: +${brandStats.familiesAdded || 0} families, +${brandStats.brandsAdded || 0} brands`);

  console.log('\n3. Building 3-level category tree...');
  const leafCategories = await seedCategories(biz.id);

  console.log('\n4. Loading active brands...');
  const brands = await loadBrands(biz.id);
  console.log(`  ✓ ${brands.length} brands available for assignment`);

  console.log('\n5. Generating products...');
  const productStats = await seedProducts(biz.id, leafCategories, brands);

  console.log('\n=== Summary ===');
  const counts = await Promise.all([
    prisma.productCategory.count({ where: { businessId: biz.id, parentId: null } }),
    prisma.productCategory.count({ where: { businessId: biz.id, parent: { parentId: null }, NOT: { parentId: null } } }),
    prisma.productCategory.count({ where: { businessId: biz.id, parent: { NOT: { parentId: null } } } }),
    prisma.productBrandFamily.count({ where: { businessId: biz.id } }),
    prisma.productBrand.count({ where: { businessId: biz.id } }),
    prisma.product.count({ where: { businessId: biz.id } }),
  ]);
  console.log(`  Parent categories : ${counts[0]}`);
  console.log(`  Sub-categories    : ${counts[1]}`);
  console.log(`  Leaf categories   : ${counts[2]}`);
  console.log(`  Brand families    : ${counts[3]}`);
  console.log(`  Brands            : ${counts[4]}`);
  console.log(`  Products          : ${counts[5]}`);
  console.log('\n✓ Done.\n');
  await prisma.$disconnect();
})().catch((err) => {
  console.error('✗ Seed failed:', err);
  prisma.$disconnect().finally(() => process.exit(1));
});
