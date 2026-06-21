#!/usr/bin/env node
// Books & stationery demo — theme books_stationery. node scripts/seed-books_stationery-demo.js [slug] [--create]
const seed = require('./lib/seedThemeDemo');
const FMT = { name: 'Format', values: ['Paperback', { label: 'Hardcover', add: 250 }] };
seed({
  theme: 'books_stationery', defaultSlug: 'books-demo', bizName: 'Margins — Books & Stationery Demo', imgPrefix: 'bk',
  descTail: 'In stock — ships next business day.',
  categories: ['Fiction', 'Non-fiction', 'Children', 'Exam Prep', 'Stationery', 'Office', 'School Lists', 'Gifts'],
  subcategories: {
    'Fiction': [['Literary', 'fiction-literary'], ['Fantasy & Sci-Fi', 'fiction-fantasy'], ['Romance', 'fiction-romance'], ['Thriller', 'fiction-thriller']],
    'Non-fiction': [['Self-help', 'nonfic-selfhelp'], ['History', 'nonfic-history'], ['Science', 'nonfic-science']],
    'Children': [['Picture Books', 'kids-picture'], ['Middle Grade', 'kids-middle'], ['Reference', 'kids-reference']],
    'Exam Prep': [['Entrance Exams', 'exam-entrance'], ['Workbooks', 'exam-workbooks']],
    'Stationery': [['Notebooks', 'stationery-notebooks'], ['Pens', 'stationery-pens'], ['Tapes & Deco', 'stationery-deco']],
    'Office': [['Supplies', 'office-supplies'], ['Paper', 'office-paper']],
  },
  reviewBodies: ['Gripping read, could not put it down.', 'Arrived in perfect condition, well packed.', 'My kids love this one — bright and engaging.', 'Clear, well-structured and helpful.', 'Lovely quality paper and binding.', 'Great value bundle, very useful.'],
  reviewers: ['Ananya', 'Ben', 'Saira', 'Dan', 'Ira', 'Omar', 'Lila', 'Ravi'],
  products: [
    { name: 'The Midnight Library', cat: 'Fiction', subcat: 'fiction-literary', brand: 'Canongate', price: 399, mrp: 499, o1: FMT },
    { name: 'Where the Crawdads Sing', cat: 'Fiction', subcat: 'fiction-thriller', brand: 'Corsair', price: 349, mrp: null, o1: FMT },
    { name: 'A Court of Thorns', cat: 'Fiction', subcat: 'fiction-romance', brand: 'Bloomsbury', price: 449, mrp: 549, o1: FMT },
    { name: 'Project Hail Mary', cat: 'Fiction', subcat: 'fiction-fantasy', brand: 'Del Rey', price: 499, mrp: null, o1: FMT },
    { name: 'Atomic Habits', cat: 'Non-fiction', subcat: 'nonfic-selfhelp', brand: 'Random House', price: 499, mrp: 650, o1: FMT },
    { name: 'Sapiens', cat: 'Non-fiction', subcat: 'nonfic-history', brand: 'Vintage', price: 599, mrp: null, o1: FMT },
    { name: 'Thinking, Fast and Slow', cat: 'Non-fiction', subcat: 'nonfic-science', brand: 'Penguin', price: 549, mrp: 699, o1: FMT },
    { name: 'The Very Hungry Caterpillar', cat: 'Children', subcat: 'kids-picture', brand: 'Puffin', price: 299, mrp: 399 },
    { name: 'Wonder', cat: 'Children', subcat: 'kids-middle', brand: 'Corgi', price: 349, mrp: null },
    { name: 'Illustrated Atlas for Kids', cat: 'Children', subcat: 'kids-reference', brand: 'DK', price: 599, mrp: 749 },
    { name: 'NEET Biology Guide', cat: 'Exam Prep', subcat: 'exam-entrance', brand: 'Arihant', price: 699, mrp: 899 },
    { name: 'CAT Quant Workbook', cat: 'Exam Prep', subcat: 'exam-workbooks', brand: 'Pearson', price: 549, mrp: null },
    { name: 'Hardcover Dotted Journal', cat: 'Stationery', subcat: 'stationery-notebooks', brand: 'Leuchtturm', price: 899, mrp: 1099, o1: { name: 'Colour', values: [] }, o2: { name: 'Cover', values: [['Navy', '#1F2A44'], ['Emerald', '#0B6E4F'], ['Blush', '#E6B7B0']] } },
    { name: 'Gel Pen Set (10 pc)', cat: 'Stationery', subcat: 'stationery-pens', brand: 'Pilot', price: 349, mrp: null },
    { name: 'Washi Tape Pack', cat: 'Stationery', subcat: 'stationery-deco', brand: 'Margins', price: 249, mrp: 299 },
    { name: 'Desk Organiser', cat: 'Office', subcat: 'office-supplies', brand: 'Margins', price: 699, mrp: 849 },
    { name: 'A4 Copier Paper (Ream)', cat: 'Office', subcat: 'office-paper', brand: 'JK', price: 299, mrp: null },
    { name: 'Grade 5 School Bundle', cat: 'School Lists', brand: 'Margins', price: 1499, mrp: 1899 },
    { name: 'Book Lover Gift Box', cat: 'Gifts', brand: 'Margins', price: 1199, mrp: 1499 },
    { name: 'Leather Bookmark Set', cat: 'Gifts', brand: 'Margins', price: 399, mrp: null },
  ],
}).catch((e) => { console.error(e); process.exit(1); });
