#!/usr/bin/env node
// Beauty / cosmetics demo — theme beauty_shop. node scripts/seed-beauty_shop-demo.js [slug] [--create]
const seed = require('./lib/seedThemeDemo');
const SHADE = (label, hex) => [label, hex];
seed({
  theme: 'beauty_shop', defaultSlug: 'beauty-demo', bizName: 'Lumière — Beauty Demo', imgPrefix: 'bty',
  descTail: 'Dermatologically tested, cruelty-free.',
  categories: ['Skincare', 'Makeup', 'Hair Care', 'Body Care', 'Fragrance', 'Tools & Brushes', 'Wellness', 'Offers'],
  subcategories: {
    'Skincare': [['Cleansers', 'skincare-cleansers'], ['Serums', 'skincare-serums'], ['Moisturisers', 'skincare-moisturisers'], ['Masks & Treatments', 'skincare-masks']],
    'Makeup': [['Face', 'makeup-face'], ['Lips', 'makeup-lips'], ['Eyes', 'makeup-eyes']],
    'Hair Care': [['Shampoo & Conditioner', 'hair-wash'], ['Treatments & Masks', 'hair-treatments']],
    'Body Care': [['Moisturisers', 'body-moisturisers'], ['Bath & Scrub', 'body-bath']],
    'Fragrance': [["Women's", 'fragrance-women'], ["Men's", 'fragrance-men'], ['Unisex', 'fragrance-unisex']],
    'Tools & Brushes': [['Brushes', 'brushes'], ['Sponges & Accessories', 'tools-sponges']],
    'Wellness': [['Supplements', 'wellness-supplements'], ['Beauty Drinks', 'wellness-drinks']],
  },
  reviewBodies: ['Glides on beautifully and lasts all day.', 'My skin feels amazing — gentle and effective.', 'Lovely scent, not overpowering.', 'Great pigment and blendability.', 'Holy grail product, repurchasing.', 'Packaging is gorgeous and feels premium.'],
  reviewers: ['Aisha', 'Riya', 'Naomi', 'Sana', 'Priya', 'Zoya', 'Ila', 'Maya'],
  products: [
    { name: 'Vitamin C Brightening Serum', cat: 'Skincare', subcat: 'skincare-serums', brand: 'GlowLab', price: 899, mrp: 1099, o1: { name: 'Size', values: ['30 ml', { label: '50 ml', add: 400 }] } },
    { name: 'Hyaluronic Hydra Moisturiser', cat: 'Skincare', subcat: 'skincare-moisturisers', brand: 'PureSkin', price: 749, mrp: null, o1: { name: 'Size', values: ['50 ml', { label: '100 ml', add: 500 }] } },
    { name: 'Gentle Foaming Cleanser', cat: 'Skincare', subcat: 'skincare-cleansers', brand: 'PureSkin', price: 549, mrp: 649 },
    { name: 'Retinol Night Cream', cat: 'Skincare', subcat: 'skincare-masks', brand: 'GlowLab', price: 1199, mrp: 1499 },
    { name: 'Matte Liquid Lipstick', cat: 'Makeup', subcat: 'makeup-lips', brand: 'Velvet', price: 599, mrp: 699, o1: { name: 'Shade', values: [] }, o2: { name: 'Colour', values: [SHADE('Rosewood', '#A45A52'), SHADE('Brick', '#9B2D20'), SHADE('Nude', '#C9A57B'), SHADE('Berry', '#7B2D43')] } },
    { name: 'Silk Foundation', cat: 'Makeup', subcat: 'makeup-face', brand: 'Velvet', price: 999, mrp: null, o1: { name: 'Shade', values: [] }, o2: { name: 'Tone', values: [SHADE('Porcelain', '#F2D7C2'), SHADE('Beige', '#E3B690'), SHADE('Honey', '#C68A5E'), SHADE('Cocoa', '#7A4B30')] } },
    { name: 'Volumising Mascara', cat: 'Makeup', subcat: 'makeup-eyes', brand: 'Velvet', price: 499, mrp: 599 },
    { name: 'Eyeshadow Palette — Sunset', cat: 'Makeup', subcat: 'makeup-eyes', brand: 'Velvet', price: 1299, mrp: 1599 },
    { name: 'Argan Repair Shampoo', cat: 'Hair Care', subcat: 'hair-wash', brand: 'Botaniq', price: 449, mrp: null, o1: { name: 'Size', values: ['250 ml', { label: '500 ml', add: 300 }] } },
    { name: 'Nourishing Hair Mask', cat: 'Hair Care', subcat: 'hair-treatments', brand: 'Botaniq', price: 599, mrp: 699 },
    { name: 'Shea Body Butter', cat: 'Body Care', subcat: 'body-moisturisers', brand: 'Botaniq', price: 499, mrp: null, o1: { name: 'Scent', values: ['Vanilla', 'Coconut', 'Unscented'] } },
    { name: 'Exfoliating Body Scrub', cat: 'Body Care', subcat: 'body-bath', brand: 'PureSkin', price: 449, mrp: 549 },
    { name: 'Eau de Parfum — Bloom', cat: 'Fragrance', subcat: 'fragrance-women', brand: 'Lumière', price: 1899, mrp: 2299, o1: { name: 'Size', values: ['50 ml', { label: '100 ml', add: 900 }] } },
    { name: 'Eau de Parfum — Noir', cat: 'Fragrance', subcat: 'fragrance-unisex', brand: 'Lumière', price: 1999, mrp: null, o1: { name: 'Size', values: ['50 ml', { label: '100 ml', add: 900 }] } },
    { name: 'Makeup Brush Set (12 pc)', cat: 'Tools & Brushes', subcat: 'brushes', brand: 'Velvet', price: 1099, mrp: 1399 },
    { name: 'Konjac Cleansing Sponge', cat: 'Tools & Brushes', subcat: 'tools-sponges', brand: 'PureSkin', price: 299, mrp: null },
    { name: 'Collagen Beauty Drink', cat: 'Wellness', subcat: 'wellness-drinks', brand: 'GlowLab', price: 1299, mrp: 1499 },
    { name: 'Gift Set — Glow Essentials', cat: 'Offers', brand: 'Lumière', price: 1999, mrp: 2799 },
  ],
}).catch((e) => { console.error(e); process.exit(1); });
