#!/usr/bin/env node
// Jewellery demo — theme jewelry_shop. node scripts/seed-jewelry_shop-demo.js [slug] [--create]
const seed = require('./lib/seedThemeDemo');
const METALS = [['Yellow Gold', '#D4AF37'], ['White Gold', '#E8E8E8'], ['Rose Gold', '#B76E79']];
seed({
  theme: 'jewelry_shop', defaultSlug: 'jewelry-demo', bizName: 'Aurelia — Jewellery Demo', imgPrefix: 'jwl',
  descTail: 'Hallmarked, conflict-free, with certificate of authenticity.',
  categories: ['Rings', 'Earrings', 'Necklaces', 'Bracelets', 'Gold', 'Silver', 'Gifts', 'New In'],
  subcategories: {
    'Rings': [['Engagement', 'ring-engagement'], ['Bands', 'ring-bands'], ['Stackable', 'ring-stackable']],
    'Earrings': [['Studs', 'earring-studs'], ['Hoops', 'earring-hoops'], ['Drops', 'earring-drops']],
    'Necklaces': [['Pendants', 'necklace-pendants'], ['Chains', 'necklace-chains'], ['Statement', 'necklace-statement']],
    'Bracelets': [['Tennis', 'bracelet-tennis'], ['Bangles', 'bracelet-bangles'], ['Charm', 'bracelet-charm']],
    'Gold': [['Coins & Bars', 'gold-coins'], ['Gold Chains', 'gold-chains']],
    'Silver': [['Silver Rings', 'silver-rings'], ['Anklets', 'silver-anklets']],
  },
  reviewBodies: ['Even more beautiful in person — exquisite finish.', 'Arrived in lovely packaging with the certificate.', 'Perfect gift, she absolutely loved it.', 'Delicate and elegant, exactly as pictured.', 'Excellent craftsmanship and quality.', 'Sparkles beautifully, great value.'],
  reviewers: ['Isha', 'Aarav', 'Diya', 'Karan', 'Sneha', 'Rohit', 'Anika', 'Vivaan'],
  products: [
    { name: 'Solitaire Diamond Ring', cat: 'Rings', subcat: 'ring-engagement', brand: 'Aurelia', price: 38999, mrp: 44999, o1: { name: 'Metal', values: [] }, o2: { name: 'Finish', values: METALS } },
    { name: 'Eternity Band', cat: 'Rings', subcat: 'ring-bands', brand: 'Aurelia', price: 24999, mrp: null, o1: { name: 'Size', values: ['6', '7', '8', '9'] }, o2: { name: 'Metal', values: METALS } },
    { name: 'Stackable Ring Set', cat: 'Rings', subcat: 'ring-stackable', brand: 'Lustre', price: 8999, mrp: 10999, o1: { name: 'Metal', values: [] }, o2: { name: 'Finish', values: METALS } },
    { name: 'Diamond Stud Earrings', cat: 'Earrings', subcat: 'earring-studs', brand: 'Aurelia', price: 18999, mrp: 21999, o1: { name: 'Metal', values: [] }, o2: { name: 'Finish', values: METALS } },
    { name: 'Pearl Drop Earrings', cat: 'Earrings', subcat: 'earring-drops', brand: 'Lustre', price: 7999, mrp: null },
    { name: 'Hoop Earrings', cat: 'Earrings', subcat: 'earring-hoops', brand: 'Lustre', price: 5999, mrp: 7499, o1: { name: 'Metal', values: [] }, o2: { name: 'Finish', values: METALS } },
    { name: 'Tennis Necklace', cat: 'Necklaces', subcat: 'necklace-statement', brand: 'Aurelia', price: 49999, mrp: 58999 },
    { name: 'Pendant Necklace — Heart', cat: 'Necklaces', subcat: 'necklace-pendants', brand: 'Lustre', price: 9999, mrp: 11999, o1: { name: 'Length', values: ['16"', '18"', '20"'] }, o2: { name: 'Metal', values: METALS } },
    { name: 'Layered Chain Necklace', cat: 'Necklaces', subcat: 'necklace-chains', brand: 'Lustre', price: 6999, mrp: null },
    { name: 'Tennis Bracelet', cat: 'Bracelets', subcat: 'bracelet-tennis', brand: 'Aurelia', price: 27999, mrp: 32999 },
    { name: 'Bangle — Classic', cat: 'Bracelets', subcat: 'bracelet-bangles', brand: 'Maison Or', price: 15999, mrp: null, o1: { name: 'Metal', values: [] }, o2: { name: 'Finish', values: METALS } },
    { name: 'Charm Bracelet', cat: 'Bracelets', subcat: 'bracelet-charm', brand: 'Lustre', price: 4999, mrp: 6499 },
    { name: '22K Gold Coin (5g)', cat: 'Gold', subcat: 'gold-coins', brand: 'Maison Or', price: 32999, mrp: null },
    { name: 'Gold Chain', cat: 'Gold', subcat: 'gold-chains', brand: 'Maison Or', price: 44999, mrp: 49999 },
    { name: 'Sterling Silver Ring', cat: 'Silver', subcat: 'silver-rings', brand: 'Lustre', price: 2999, mrp: 3499, o1: { name: 'Size', values: ['6', '7', '8'] } },
    { name: 'Silver Anklet', cat: 'Silver', subcat: 'silver-anklets', brand: 'Lustre', price: 1999, mrp: null },
    { name: 'Gift Box — Her Sparkle', cat: 'Gifts', brand: 'Aurelia', price: 12999, mrp: 15999 },
    { name: 'Birthstone Pendant', cat: 'New In', brand: 'Lustre', price: 8499, mrp: null, o1: { name: 'Metal', values: [] }, o2: { name: 'Finish', values: METALS } },
  ],
}).catch((e) => { console.error(e); process.exit(1); });
