#!/usr/bin/env node
// Bakery & sweets demo — theme bakery_sweets. node scripts/seed-bakery_sweets-demo.js [slug] [--create]
const seed = require('./lib/seedThemeDemo');
const CAKE = { name: 'Size', values: ['500 g', { label: '1 kg', add: 500 }, { label: '2 kg', add: 1400 }] };
const WT = { name: 'Weight', values: ['250 g', { label: '500 g', add: 200 }, { label: '1 kg', add: 500 }] };
seed({
  theme: 'bakery_sweets', defaultSlug: 'bakery-demo', bizName: 'Sugar & Crumb — Bakery Demo', imgPrefix: 'bky',
  descTail: 'Baked fresh daily. Eggless options available on request.',
  categories: ['Cakes', 'Pastries', 'Cookies', 'Mithai', 'Breads', 'Desserts', 'Gift Boxes', 'Preorders'],
  subcategories: {
    'Cakes': [['Chocolate', 'cakes-chocolate'], ['Fruit & Fresh', 'cakes-fruit'], ['Classic', 'cakes-classic']],
    'Pastries': [['Croissants', 'pastries-croissants'], ['Éclairs', 'pastries-eclairs'], ['Danishes', 'pastries-danishes']],
    'Cookies': [['Choc-chip', 'cookies-chocchip'], ['Shortbread', 'cookies-shortbread']],
    'Mithai': [['Bengali', 'mithai-bengali'], ['Dry Fruit', 'mithai-dryfruit'], ['Ladoo', 'mithai-ladoo']],
    'Breads': [['Sourdough', 'breads-sourdough'], ['Multigrain', 'breads-multigrain']],
    'Desserts': [['Cups', 'desserts-cups'], ['Slices', 'desserts-slices'], ['Brownies', 'desserts-brownies']],
  },
  reviewBodies: ['So fresh and delicious — melted in the mouth.', 'Beautifully decorated and tasted amazing.', 'Arrived intact and perfectly fresh.', 'Not too sweet, just right. Loved it.', 'Great quality, will definitely reorder.', 'Perfect for our celebration, thank you!'],
  reviewers: ['Anita', 'Sameer', 'Pooja', 'Imran', 'Rhea', 'Gaurav', 'Tina', 'Aryan'],
  products: [
    { name: 'Classic Chocolate Truffle Cake', cat: 'Cakes', subcat: 'cakes-chocolate', brand: 'Sugar & Crumb', price: 699, mrp: 849, o1: CAKE },
    { name: 'Red Velvet Cake', cat: 'Cakes', subcat: 'cakes-classic', brand: 'Sugar & Crumb', price: 749, mrp: null, o1: CAKE },
    { name: 'Fresh Fruit Gateau', cat: 'Cakes', subcat: 'cakes-fruit', brand: 'Sugar & Crumb', price: 799, mrp: 949, o1: CAKE },
    { name: 'Pineapple Cake', cat: 'Cakes', subcat: 'cakes-fruit', brand: 'Sugar & Crumb', price: 599, mrp: null, o1: CAKE },
    { name: 'Butter Croissant (4 pack)', cat: 'Pastries', subcat: 'pastries-croissants', brand: 'Sugar & Crumb', price: 249, mrp: 299 },
    { name: 'Chocolate Éclair (6 pack)', cat: 'Pastries', subcat: 'pastries-eclairs', brand: 'Sugar & Crumb', price: 349, mrp: null },
    { name: 'Almond Danish (4 pack)', cat: 'Pastries', subcat: 'pastries-danishes', brand: 'Sugar & Crumb', price: 299, mrp: 349 },
    { name: 'Belgian Choc-chip Cookies', cat: 'Cookies', subcat: 'cookies-chocchip', brand: 'Sugar & Crumb', price: 299, mrp: 379, o1: WT },
    { name: 'Assorted Shortbread', cat: 'Cookies', subcat: 'cookies-shortbread', brand: 'Sugar & Crumb', price: 349, mrp: null, o1: WT },
    { name: 'Kaju Katli', cat: 'Mithai', subcat: 'mithai-dryfruit', brand: 'Sugar & Crumb', price: 549, mrp: 649, o1: WT },
    { name: 'Motichoor Ladoo', cat: 'Mithai', subcat: 'mithai-ladoo', brand: 'Sugar & Crumb', price: 399, mrp: null, o1: WT },
    { name: 'Assorted Bengali Sweets', cat: 'Mithai', subcat: 'mithai-bengali', brand: 'Sugar & Crumb', price: 499, mrp: 599, o1: WT },
    { name: 'Sourdough Loaf', cat: 'Breads', subcat: 'breads-sourdough', brand: 'Sugar & Crumb', price: 199, mrp: null },
    { name: 'Multigrain Bread', cat: 'Breads', subcat: 'breads-multigrain', brand: 'Sugar & Crumb', price: 149, mrp: 179 },
    { name: 'Tiramisu Cup', cat: 'Desserts', subcat: 'desserts-cups', brand: 'Sugar & Crumb', price: 249, mrp: null },
    { name: 'New York Cheesecake Slice', cat: 'Desserts', subcat: 'desserts-slices', brand: 'Sugar & Crumb', price: 279, mrp: 329 },
    { name: 'Brownie Box (6 pc)', cat: 'Desserts', subcat: 'desserts-brownies', brand: 'Sugar & Crumb', price: 399, mrp: 479 },
    { name: 'Festive Gift Hamper', cat: 'Gift Boxes', brand: 'Sugar & Crumb', price: 1299, mrp: 1599 },
    { name: 'Assorted Sweet Box', cat: 'Gift Boxes', brand: 'Sugar & Crumb', price: 899, mrp: null },
    { name: 'Custom Photo Cake (Preorder)', cat: 'Preorders', brand: 'Sugar & Crumb', price: 999, mrp: null, o1: CAKE },
  ],
}).catch((e) => { console.error(e); process.exit(1); });
