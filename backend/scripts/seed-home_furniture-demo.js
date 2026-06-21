#!/usr/bin/env node
// Home & furniture demo — theme home_furniture. node scripts/seed-home_furniture-demo.js [slug] [--create]
const seed = require('./lib/seedThemeDemo');
const WOOD = [['Oak', '#C9A66B'], ['Walnut', '#5C4033'], ['White', '#F5F5F0']];
const FABRIC = [['Charcoal', '#36454F'], ['Sage', '#9CAF88'], ['Camel', '#C19A6B']];
seed({
  theme: 'home_furniture', defaultSlug: 'furniture-demo', bizName: 'Oakhaus — Furniture Demo', imgPrefix: 'hf',
  descTail: 'Solid-wood construction with a 5-year warranty. Free assembly available.',
  categories: ['Living Room', 'Bedroom', 'Dining', 'Storage', 'Lighting', 'Decor', 'Office', 'Outdoor'],
  subcategories: {
    'Living Room': [['Sofas', 'sofas'], ['Armchairs', 'armchairs'], ['Coffee Tables', 'coffee-tables'], ['TV Units', 'tv-units']],
    'Bedroom': [['Beds', 'beds'], ['Wardrobes', 'wardrobes'], ['Nightstands', 'nightstands']],
    'Dining': [['Dining Tables', 'dining-tables'], ['Chairs', 'dining-chairs'], ['Sideboards', 'sideboards']],
    'Storage': [['Bookshelves', 'bookshelves'], ['Cabinets', 'cabinets']],
    'Lighting': [['Lamps', 'lamps'], ['Ceiling', 'ceiling-lights']],
    'Decor': [['Rugs', 'rugs'], ['Wall Decor', 'wall-decor']],
    'Office': [['Desks', 'desks'], ['Office Chairs', 'office-chairs']],
  },
  reviewBodies: ['Beautifully made and sturdy — looks high-end.', 'Assembly was straightforward, great instructions.', 'The finish is gorgeous and exactly as shown.', 'Comfortable and well worth the price.', 'Delivery team were careful and on time.', 'Transformed our space, very happy.'],
  reviewers: ['Neha', 'Sam', 'Priya', 'Tom', 'Aditi', 'Liam', 'Kavya', 'Noah'],
  products: [
    { name: 'Linen 3-Seater Sofa', cat: 'Living Room', subcat: 'sofas', brand: 'Nordix', price: 42999, mrp: 49999, o1: { name: 'Fabric', values: [] }, o2: { name: 'Colour', values: FABRIC } },
    { name: 'Accent Armchair', cat: 'Living Room', subcat: 'armchairs', brand: 'Nordix', price: 18999, mrp: null, o1: { name: 'Fabric', values: [] }, o2: { name: 'Colour', values: FABRIC } },
    { name: 'Coffee Table', cat: 'Living Room', subcat: 'coffee-tables', brand: 'Oakhaus', price: 12999, mrp: 14999, o1: { name: 'Finish', values: [] }, o2: { name: 'Wood', values: WOOD } },
    { name: 'TV Console', cat: 'Living Room', subcat: 'tv-units', brand: 'Oakhaus', price: 16999, mrp: null, o1: { name: 'Finish', values: [] }, o2: { name: 'Wood', values: WOOD } },
    { name: 'Upholstered Bed Frame', cat: 'Bedroom', subcat: 'beds', brand: 'Casa', price: 32999, mrp: 38999, o1: { name: 'Size', values: ['Queen', { label: 'King', add: 4000 }] }, o2: { name: 'Colour', values: FABRIC } },
    { name: 'Bedside Table', cat: 'Bedroom', subcat: 'nightstands', brand: 'Oakhaus', price: 6999, mrp: null, o1: { name: 'Finish', values: [] }, o2: { name: 'Wood', values: WOOD } },
    { name: 'Wardrobe — 3 Door', cat: 'Bedroom', subcat: 'wardrobes', brand: 'Oakhaus', price: 27999, mrp: 31999 },
    { name: 'Dining Table (6-seater)', cat: 'Dining', subcat: 'dining-tables', brand: 'Oakhaus', price: 28999, mrp: 33999, o1: { name: 'Finish', values: [] }, o2: { name: 'Wood', values: WOOD } },
    { name: 'Dining Chair (set of 2)', cat: 'Dining', subcat: 'dining-chairs', brand: 'Nordix', price: 8999, mrp: null, o1: { name: 'Colour', values: [] }, o2: { name: 'Fabric', values: FABRIC } },
    { name: 'Sideboard Buffet', cat: 'Dining', subcat: 'sideboards', brand: 'Oakhaus', price: 21999, mrp: 25999 },
    { name: 'Bookshelf — 5 Tier', cat: 'Storage', subcat: 'bookshelves', brand: 'Oakhaus', price: 11999, mrp: null, o1: { name: 'Finish', values: [] }, o2: { name: 'Wood', values: WOOD } },
    { name: 'Shoe Cabinet', cat: 'Storage', subcat: 'cabinets', brand: 'Nordix', price: 8499, mrp: 9999 },
    { name: 'Arc Floor Lamp', cat: 'Lighting', subcat: 'lamps', brand: 'Lumen Works', price: 7999, mrp: 9499 },
    { name: 'Pendant Light', cat: 'Lighting', subcat: 'ceiling-lights', brand: 'Lumen Works', price: 4999, mrp: null },
    { name: 'Woven Area Rug', cat: 'Decor', subcat: 'rugs', brand: 'Casa', price: 6999, mrp: 8499, o1: { name: 'Size', values: ['5×7 ft', { label: '6×9 ft', add: 2000 }] } },
    { name: 'Framed Wall Mirror', cat: 'Decor', subcat: 'wall-decor', brand: 'Casa', price: 5499, mrp: null },
    { name: 'Ergonomic Office Chair', cat: 'Office', subcat: 'office-chairs', brand: 'Nordix', price: 13999, mrp: 16999 },
    { name: 'Writing Desk', cat: 'Office', subcat: 'desks', brand: 'Oakhaus', price: 14999, mrp: null, o1: { name: 'Finish', values: [] }, o2: { name: 'Wood', values: WOOD } },
    { name: 'Outdoor Lounge Set', cat: 'Outdoor', brand: 'Casa', price: 36999, mrp: 42999 },
  ],
}).catch((e) => { console.error(e); process.exit(1); });
