#!/usr/bin/env node
// Sports & fitness demo — theme sports_fitness. node scripts/seed-sports_fitness-demo.js [slug] [--create]
const seed = require('./lib/seedThemeDemo');
const APP_SIZE = { name: 'Size', values: ['S', 'M', 'L', 'XL'] };
const COLOURS = { name: 'Colour', values: [['Black', '#1A1A1A'], ['Navy', '#1F2A44'], ['Red', '#C0392B'], ['Grey', '#808080']] };
const SHOE = { name: 'UK Size', values: ['6', '7', '8', '9', '10', '11'] };
seed({
  theme: 'sports_fitness', defaultSlug: 'sports-demo', bizName: 'Apex — Sports & Fitness Demo', imgPrefix: 'spt',
  descTail: 'Performance-grade, moisture-wicking. Free returns within 30 days.',
  categories: ['Training', 'Running', 'Team Sports', 'Outdoor', 'Yoga & Recovery', 'Footwear', 'Equipment', 'Nutrition'],
  subcategories: {
    'Training': [['Tops', 'training-tops'], ['Bottoms', 'training-bottoms'], ['Weights', 'training-weights']],
    'Running': [['Apparel', 'running-apparel'], ['Accessories', 'running-accessories']],
    'Team Sports': [['Football', 'team-football'], ['Basketball', 'team-basketball'], ['Cricket', 'team-cricket']],
    'Outdoor': [['Backpacks', 'outdoor-backpacks'], ['Hydration', 'outdoor-hydration']],
    'Yoga & Recovery': [['Mats', 'yoga-mats'], ['Recovery Tools', 'yoga-recovery-tools']],
    'Footwear': [['Running Shoes', 'shoes-running'], ['Training Shoes', 'shoes-training']],
    'Equipment': [['Weights', 'equipment-weights'], ['Cardio', 'equipment-cardio']],
  },
  reviewBodies: ['Great fit and super comfortable for workouts.', 'Quality is excellent, holds up to heavy use.', 'Exactly as described, fast shipping.', 'Lightweight and breathable — love it.', 'Perfect for my training, great value.', 'Durable and looks great too.'],
  reviewers: ['Arjun', 'Kate', 'Vihaan', 'Mia', 'Rahul', 'Zoe', 'Sid', 'Lena'],
  products: [
    { name: 'Dri-Fit Training Tee', cat: 'Training', subcat: 'training-tops', brand: 'Apex', price: 999, mrp: 1299, o1: APP_SIZE, o2: COLOURS },
    { name: 'Compression Leggings', cat: 'Training', subcat: 'training-bottoms', brand: 'Apex', price: 1499, mrp: null, o1: APP_SIZE, o2: COLOURS },
    { name: 'Training Shorts', cat: 'Training', subcat: 'training-bottoms', brand: 'Apex', price: 899, mrp: 1099, o1: APP_SIZE },
    { name: 'Adjustable Dumbbell (Pair)', cat: 'Training', subcat: 'training-weights', brand: 'IronCore', price: 4999, mrp: 5999 },
    { name: 'Lightweight Running Tee', cat: 'Running', subcat: 'running-apparel', brand: 'Striderr', price: 1099, mrp: null, o1: APP_SIZE, o2: COLOURS },
    { name: 'Running Jacket', cat: 'Running', subcat: 'running-apparel', brand: 'Striderr', price: 2499, mrp: 2999, o1: APP_SIZE },
    { name: 'Hydration Belt', cat: 'Running', subcat: 'running-accessories', brand: 'Striderr', price: 899, mrp: null },
    { name: 'Football (Size 5)', cat: 'Team Sports', subcat: 'team-football', brand: 'KickPro', price: 1299, mrp: 1599 },
    { name: 'Basketball', cat: 'Team Sports', subcat: 'team-basketball', brand: 'KickPro', price: 1499, mrp: null },
    { name: 'Cricket Bat — English Willow', cat: 'Team Sports', subcat: 'team-cricket', brand: 'Willowed', price: 4999, mrp: 5999 },
    { name: 'Trekking Backpack 45L', cat: 'Outdoor', subcat: 'outdoor-backpacks', brand: 'TrailGear', price: 3499, mrp: 4199, o1: { name: 'Colour', values: [] }, o2: COLOURS },
    { name: 'Insulated Water Bottle', cat: 'Outdoor', subcat: 'outdoor-hydration', brand: 'TrailGear', price: 799, mrp: null },
    { name: 'Yoga Mat (6mm)', cat: 'Yoga & Recovery', subcat: 'yoga-mats', brand: 'ZenFlow', price: 1199, mrp: 1499, o1: { name: 'Colour', values: [] }, o2: { name: 'Colour', values: [['Teal', '#0D9488'], ['Purple', '#7C3AED'], ['Grey', '#808080']] } },
    { name: 'Foam Roller', cat: 'Yoga & Recovery', subcat: 'yoga-recovery-tools', brand: 'ZenFlow', price: 899, mrp: null },
    { name: 'Resistance Bands Set', cat: 'Yoga & Recovery', subcat: 'yoga-recovery-tools', brand: 'ZenFlow', price: 699, mrp: 899 },
    { name: 'Road Running Shoes', cat: 'Footwear', subcat: 'shoes-running', brand: 'Striderr', price: 4499, mrp: 5499, o1: SHOE, o2: COLOURS },
    { name: 'Training Shoes', cat: 'Footwear', subcat: 'shoes-training', brand: 'Apex', price: 3999, mrp: null, o1: SHOE },
    { name: 'Skipping Rope', cat: 'Equipment', subcat: 'equipment-cardio', brand: 'IronCore', price: 399, mrp: 499 },
    { name: 'Kettlebell 12kg', cat: 'Equipment', subcat: 'equipment-weights', brand: 'IronCore', price: 2299, mrp: null },
    { name: 'Whey Protein 1kg', cat: 'Nutrition', brand: 'FuelUp', price: 2299, mrp: 2799, o1: { name: 'Flavour', values: ['Chocolate', 'Vanilla'] } },
  ],
}).catch((e) => { console.error(e); process.exit(1); });
