#!/usr/bin/env node
// Florist & gifts demo — theme florist_gifts. node scripts/seed-florist_gifts-demo.js [slug] [--create]
const seed = require('./lib/seedThemeDemo');
const BOUQUET = { name: 'Size', values: ['Classic', { label: 'Deluxe', add: 500 }, { label: 'Grand', add: 1200 }] };
seed({
  theme: 'florist_gifts', defaultSlug: 'florist-demo', bizName: 'Bloom & Co. — Florist Demo', imgPrefix: 'flr',
  descTail: 'Hand-tied by our florists with same-day delivery available.',
  categories: ['Bouquets', 'Roses', 'Seasonal Flowers', 'Plants', 'Hampers', 'Personalized Gifts', 'Same-day Delivery', 'Occasions'],
  subcategories: {
    'Bouquets': [['Hand-tied', 'bouquet-handtied'], ['Mixed', 'bouquet-mixed'], ['Bright', 'bouquet-bright']],
    'Roses': [['Red Roses', 'roses-red'], ['Pink Roses', 'roses-pink'], ['White Roses', 'roses-white']],
    'Seasonal Flowers': [['Spring', 'seasonal-spring'], ['Luxe Blooms', 'seasonal-luxe']],
    'Plants': [['Flowering', 'plants-flowering'], ['Indoor', 'plants-indoor']],
    'Hampers': [['Sweet', 'hampers-sweet'], ['Spa', 'hampers-spa']],
    'Personalized Gifts': [['Vases', 'gifts-vases'], ['Flower Boxes', 'gifts-boxes']],
    'Occasions': [['Birthday', 'occasion-birthday'], ['Anniversary', 'occasion-anniversary'], ['Get Well', 'occasion-getwell']],
  },
  reviewBodies: ['Absolutely stunning, lasted over a week!', 'Delivered on time and looked even better than the photo.', 'My mum was thrilled — beautiful arrangement.', 'Fresh, fragrant and gorgeously wrapped.', 'Great service, will order again.', 'Perfect gift, highly recommend.'],
  reviewers: ['Priya', 'Jack', 'Aisha', 'Tom', 'Neha', 'Liam', 'Sara', 'Dev'],
  products: [
    { name: 'Seasonal Hand-tied Bouquet', cat: 'Bouquets', subcat: 'bouquet-handtied', brand: 'Bloom & Co.', price: 1299, mrp: 1599, o1: BOUQUET },
    { name: 'Pastel Mixed Bouquet', cat: 'Bouquets', subcat: 'bouquet-mixed', brand: 'Bloom & Co.', price: 1499, mrp: null, o1: BOUQUET },
    { name: 'Sunflower Sunshine Bunch', cat: 'Bouquets', subcat: 'bouquet-bright', brand: 'Bloom & Co.', price: 1199, mrp: 1399, o1: BOUQUET },
    { name: 'Dozen Red Roses', cat: 'Roses', subcat: 'roses-red', brand: 'Bloom & Co.', price: 1999, mrp: 2399, o1: { name: 'Quantity', values: ['12 stems', { label: '24 stems', add: 1500 }, { label: '50 stems', add: 4500 }] } },
    { name: 'Pink Rose Bouquet', cat: 'Roses', subcat: 'roses-pink', brand: 'Bloom & Co.', price: 1799, mrp: null, o1: BOUQUET },
    { name: 'White Rose Arrangement', cat: 'Roses', subcat: 'roses-white', brand: 'Bloom & Co.', price: 2199, mrp: 2599 },
    { name: 'Tulip Spring Bunch', cat: 'Seasonal Flowers', subcat: 'seasonal-spring', brand: 'Bloom & Co.', price: 1399, mrp: 1699, o1: BOUQUET },
    { name: 'Peony Luxe Bouquet', cat: 'Seasonal Flowers', subcat: 'seasonal-luxe', brand: 'Bloom & Co.', price: 2499, mrp: null },
    { name: 'Orchid Plant in Pot', cat: 'Plants', subcat: 'plants-flowering', brand: 'GreenLeaf', price: 1599, mrp: 1899 },
    { name: 'Succulent Trio', cat: 'Plants', subcat: 'plants-indoor', brand: 'GreenLeaf', price: 899, mrp: null },
    { name: 'Peace Lily', cat: 'Plants', subcat: 'plants-flowering', brand: 'GreenLeaf', price: 1199, mrp: 1399 },
    { name: 'Chocolate & Flowers Hamper', cat: 'Hampers', subcat: 'hampers-sweet', brand: 'Bloom & Co.', price: 2299, mrp: 2799 },
    { name: 'Spa & Bloom Gift Hamper', cat: 'Hampers', subcat: 'hampers-spa', brand: 'Bloom & Co.', price: 2999, mrp: null },
    { name: 'Personalised Vase Bouquet', cat: 'Personalized Gifts', subcat: 'gifts-vases', brand: 'Bloom & Co.', price: 2499, mrp: 2899 },
    { name: 'Message Card Flower Box', cat: 'Personalized Gifts', subcat: 'gifts-boxes', brand: 'Bloom & Co.', price: 1699, mrp: null },
    { name: 'Same-day Florist Choice', cat: 'Same-day Delivery', brand: 'Bloom & Co.', price: 1499, mrp: 1799, o1: BOUQUET },
    { name: 'Express Rose Bunch', cat: 'Same-day Delivery', brand: 'Bloom & Co.', price: 1599, mrp: null },
    { name: 'Birthday Celebration Bouquet', cat: 'Occasions', subcat: 'occasion-birthday', brand: 'Bloom & Co.', price: 1799, mrp: 2199, o1: BOUQUET },
    { name: 'Anniversary Romance Set', cat: 'Occasions', subcat: 'occasion-anniversary', brand: 'Bloom & Co.', price: 2699, mrp: null },
    { name: 'Get Well Soon Posy', cat: 'Occasions', subcat: 'occasion-getwell', brand: 'Bloom & Co.', price: 1299, mrp: 1499 },
  ],
}).catch((e) => { console.error(e); process.exit(1); });
