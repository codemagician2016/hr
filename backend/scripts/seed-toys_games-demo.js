#!/usr/bin/env node
// Toys & games demo — theme toys_games. node scripts/seed-toys_games-demo.js [slug] [--create]
const seed = require('./lib/seedThemeDemo');
const AGE = { name: 'Age', values: ['3-5 yrs', '6-8 yrs', '9-12 yrs'] };
seed({
  theme: 'toys_games', defaultSlug: 'toys-demo', bizName: 'Playbox — Toys & Games Demo', imgPrefix: 'toy',
  descTail: 'Safety-tested and age-graded. Batteries included where needed.',
  categories: ['Building Sets', 'Learning Toys', 'Board Games', 'Outdoor Play', 'Plush', 'Art & Craft', 'Baby & Toddler', 'Gifts'],
  subcategories: {
    'Building Sets': [['Bricks', 'build-bricks'], ['Magnetic', 'build-magnetic'], ['Marble Runs', 'build-marble']],
    'Learning Toys': [['STEM', 'learn-stem'], ['Puzzles', 'learn-puzzles'], ['Early Learning', 'learn-early']],
    'Board Games': [['Strategy', 'games-strategy'], ['Family', 'games-family'], ['Classics', 'games-classics']],
    'Outdoor Play': [['Ride-ons', 'outdoor-rideons'], ['Blasters', 'outdoor-blasters'], ['Garden', 'outdoor-garden']],
    'Plush': [['Teddies', 'plush-teddies'], ['Animals', 'plush-animals']],
    'Art & Craft': [['Art Sets', 'craft-art'], ['Clay & Dough', 'craft-clay']],
    'Baby & Toddler': [['First Toys', 'baby-first'], ['Activity', 'baby-activity']],
  },
  reviewBodies: ['Kept the kids busy for hours — fantastic.', 'Great quality, sturdy pieces.', 'Educational and fun, a win-win.', 'Perfect birthday gift, loved it.', 'Well made and great value.', 'Bright, engaging and safe.'],
  reviewers: ['Mom of 2', 'Raj', 'Emily', 'Sahil', 'Grandma J', 'Nadia', 'Tom', 'Pia'],
  products: [
    { name: 'Classic Brick Building Set (500 pc)', cat: 'Building Sets', subcat: 'build-bricks', brand: 'BrickWorks', price: 1499, mrp: 1899, o1: AGE },
    { name: 'Marble Run Deluxe', cat: 'Building Sets', subcat: 'build-marble', brand: 'BrickWorks', price: 1299, mrp: null },
    { name: 'Magnetic Tiles (100 pc)', cat: 'Building Sets', subcat: 'build-magnetic', brand: 'MagPlay', price: 1999, mrp: 2499 },
    { name: 'STEM Robotics Kit', cat: 'Learning Toys', subcat: 'learn-stem', brand: 'BrightMinds', price: 2499, mrp: 2999, o1: AGE },
    { name: 'Counting Abacus', cat: 'Learning Toys', subcat: 'learn-early', brand: 'BrightMinds', price: 499, mrp: null },
    { name: 'Alphabet Puzzle', cat: 'Learning Toys', subcat: 'learn-puzzles', brand: 'BrightMinds', price: 399, mrp: 499 },
    { name: 'Settlers Strategy Board Game', cat: 'Board Games', subcat: 'games-strategy', brand: 'TableTop', price: 1799, mrp: 2199 },
    { name: 'Family Trivia Night', cat: 'Board Games', subcat: 'games-family', brand: 'TableTop', price: 999, mrp: null },
    { name: 'Classic Chess Set', cat: 'Board Games', subcat: 'games-classics', brand: 'TableTop', price: 799, mrp: 999 },
    { name: 'Foam Dart Blaster', cat: 'Outdoor Play', subcat: 'outdoor-blasters', brand: 'PlayMax', price: 1299, mrp: 1599 },
    { name: 'Kids Scooter', cat: 'Outdoor Play', subcat: 'outdoor-rideons', brand: 'PlayMax', price: 2299, mrp: null, o1: { name: 'Colour', values: [] }, o2: { name: 'Colour', values: [['Blue', '#2E78C7'], ['Pink', '#E84393'], ['Green', '#27AE60']] } },
    { name: 'Bubble Machine', cat: 'Outdoor Play', subcat: 'outdoor-garden', brand: 'PlayMax', price: 699, mrp: 849 },
    { name: 'Teddy Bear — 40 cm', cat: 'Plush', subcat: 'plush-teddies', brand: 'CuddleCo', price: 899, mrp: 1099 },
    { name: 'Plush Dinosaur', cat: 'Plush', subcat: 'plush-animals', brand: 'CuddleCo', price: 649, mrp: null },
    { name: 'Deluxe Art Set (150 pc)', cat: 'Art & Craft', subcat: 'craft-art', brand: 'CraftLab', price: 1199, mrp: 1499 },
    { name: 'Air-Dry Clay Kit', cat: 'Art & Craft', subcat: 'craft-clay', brand: 'CraftLab', price: 549, mrp: null },
    { name: 'Stacking Rings', cat: 'Baby & Toddler', subcat: 'baby-first', brand: 'TinyTots', price: 399, mrp: 499 },
    { name: 'Soft Activity Cube', cat: 'Baby & Toddler', subcat: 'baby-activity', brand: 'TinyTots', price: 899, mrp: null },
    { name: 'Birthday Surprise Gift Box', cat: 'Gifts', brand: 'Playbox', price: 1499, mrp: 1899 },
    { name: 'Wooden Toy Gift Set', cat: 'Gifts', brand: 'TinyTots', price: 1299, mrp: null },
  ],
}).catch((e) => { console.error(e); process.exit(1); });
