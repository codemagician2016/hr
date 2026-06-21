'use strict';

// Country-specific brand catalog. Auto-seeded into ProductBrandFamily +
// ProductBrand at business-setup time so a fresh seller doesn't have to
// type the FMCG roster from scratch. The seller can edit / hide / add to
// these like any other admin-managed brand row — the seed is just the
// starting point, not a frozen catalogue.
//
// Curation principles:
//   • Only well-known mass-market FMCG families relevant to a grocery /
//     general-store storefront (we'll add other verticals later).
//   • A "family" is a corporate parent the seller would think of as one
//     supplier; a "brand" is what the buyer reads on the shelf.
//   • Independent brands (no family) live in a synthetic "Independent
//     brands" family per country so the picker stays two-level.
//
// To extend a country, append families to its array. To add a country,
// add a new top-level key keyed by ISO-3166-1 alpha-2 and wire it into
// SUPPORTED_COUNTRIES below.

const b = (name) => ({ name });

const IN_FAMILIES = [
  { name: 'Hindustan Unilever', brands: [
    "Surf Excel", "Rin", "Wheel", "Comfort", "Vim",
    "Lux", "Lifebuoy", "Pears", "Dove", "Sunsilk",
    "Clinic Plus", "Ponds", "Lakme", "Vaseline", "Fair & Lovely",
    "Brooke Bond Red Label", "Taj Mahal Tea", "Lipton", "Bru",
    "Knorr", "Kissan", "Hellmanns",
    "Kwality Walls", "Cornetto", "Magnum",
    "Horlicks", "Boost", "Pureit",
  ].map(b) },
  { name: 'ITC', brands: [
    "Aashirvaad", "Sunfeast", "Bingo!", "YiPPee!", "B Natural",
    "Classmate", "Paperkraft", "Fiama", "Vivel", "Engage",
    "Mangaldeep", "Savlon", "Charmis", "Gold Flake",
  ].map(b) },
  { name: 'Procter & Gamble', brands: [
    "Tide", "Ariel", "Pampers", "Whisper", "Gillette",
    "Vicks", "Old Spice", "Pantene", "Head & Shoulders",
    "Olay", "Oral-B", "Ambi Pur", "Duracell",
  ].map(b) },
  { name: 'Nestle India', brands: [
    "Maggi", "Nescafe", "KitKat", "Munch", "Milkybar",
    "Polo", "Cerelac", "Lactogen", "Everyday Dairy Whitener", "Nestea",
  ].map(b) },
  { name: 'Britannia', brands: [
    "Good Day", "Marie Gold", "NutriChoice", "Tiger", "Bourbon",
    "50-50", "Treat", "Milk Bikis", "Britannia Cheese",
  ].map(b) },
  { name: 'Parle Products', brands: [
    "Parle-G", "Hide & Seek", "Krackjack", "Monaco",
    "Melody", "Mango Bite", "Kismi", "Frooti", "Bailley",
  ].map(b) },
  { name: 'Dabur', brands: [
    "Dabur Honey", "Dabur Chyawanprash", "Vatika", "Real",
    "Hajmola", "Pudin Hara", "Odonil", "Odomos", "Dabur Amla",
  ].map(b) },
  { name: 'Marico', brands: [
    "Parachute", "Saffola", "Hair & Care", "Livon", "Set Wet",
    "Mediker", "Nihar Naturals",
  ].map(b) },
  { name: 'Patanjali', brands: [
    "Dant Kanti", "Kesh Kanti", "Aloe Vera Gel", "Patanjali Atta Noodles",
    "Patanjali Ghee", "Patanjali Honey",
  ].map(b) },
  { name: 'Amul (GCMMF)', brands: [
    "Amul Butter", "Amul Cheese", "Amul Ice Cream", "Amul Milk",
    "Amul Dairy Whitener", "Amul Lassi", "Amul Kool", "Amul Ghee",
  ].map(b) },
  { name: 'Colgate-Palmolive', brands: [
    "Colgate", "Palmolive", "Axion",
  ].map(b) },
  { name: 'Mondelez India', brands: [
    "Cadbury Dairy Milk", "Cadbury 5 Star", "Gems", "Bournvita",
    "Oreo", "Halls", "Tang",
  ].map(b) },
  { name: 'Coca-Cola India', brands: [
    "Coca-Cola", "Thums Up", "Sprite", "Limca", "Maaza",
    "Minute Maid", "Kinley",
  ].map(b) },
  { name: 'PepsiCo India', brands: [
    "Pepsi", "7UP", "Mirinda", "Mountain Dew", "Slice",
    "Tropicana", "Lays", "Kurkure", "Doritos", "Quaker", "Aquafina",
  ].map(b) },
  { name: 'Tata Consumer Products', brands: [
    "Tata Tea", "Tata Salt", "Tata Sampann", "Tetley",
    "Eight OClock", "Himalayan",
  ].map(b) },
  { name: 'Adani Wilmar', brands: [
    "Fortune",
  ].map(b) },
  { name: 'Godrej Consumer', brands: [
    "Cinthol", "Godrej No.1", "Good Knight", "HIT", "Ezee", "Aer",
  ].map(b) },
];

const NZ_FAMILIES = [
  { name: 'Fonterra', brands: [
    "Anchor", "Mainland", "Anlene", "Fernleaf", "Tip Top",
    "Kapiti", "Kapiti Cheese",
  ].map(b) },
  { name: "Goodman Fielder NZ", brands: [
    "Vogels", "Meadow Fresh", "Molenberg", "Quality Bakers",
    "Ernest Adams", "ETA", "Edmonds", "Praise", "Puhoi Valley",
  ].map(b) },
  { name: "Heinz Watties", brands: [
    "Watties", "Heinz", "Greggs", "Hubbards",
  ].map(b) },
  { name: 'Bluebird Foods', brands: [
    "Bluebird Originals", "Twisties NZ", "Pixie Caramel", "Rashuns",
  ].map(b) },
  { name: 'Sanitarium NZ', brands: [
    "Weet-Bix NZ", "Marmite", "So Good NZ", "Up&Go NZ",
  ].map(b) },
  { name: 'Frucor Suntory NZ', brands: [
    "V Energy", "Just Juice", "Mizone", "OVI",
  ].map(b) },
  { name: 'Lion NZ', brands: [
    "Steinlager", "Speights", "Macs", "Lion Red",
  ].map(b) },
  { name: 'DB Breweries', brands: [
    "DB Draught", "Tui", "Export Gold", "Monteiths",
  ].map(b) },
  { name: 'Sealord', brands: [
    "Sealord",
  ].map(b) },
  { name: 'Tatua', brands: [
    "Tatua",
  ].map(b) },
  { name: 'Independent NZ brands', brands: [
    "Whittakers", "Pics Peanut Butter", "Cookie Time",
    "Karma Cola", "Lewis Road Creamery", "Westgold", "Zealong",
    "Charlies", "L&P",
  ].map(b) },
];

const AU_FAMILIES = [
  { name: 'Bega Group', brands: [
    "Bega", "Vegemite", "Dairy Farmers", "Yoplait", "Zoosh",
    "Big M", "Farmers Union",
  ].map(b) },
  { name: 'Saputo Dairy Australia', brands: [
    "Devondale", "Liddells", "South Cape", "Tasmanian Heritage",
    "Murray Goulburn",
  ].map(b) },
  { name: 'Goodman Fielder Australia', brands: [
    "Helgas", "Wonder White", "Praise AU", "MeadowLea",
    "White Wings", "Olive Grove",
  ].map(b) },
  { name: 'Sanitarium Australia', brands: [
    "Weet-Bix AU", "Up&Go", "So Good",
  ].map(b) },
  { name: "Arnotts", brands: [
    "Tim Tam", "Mint Slice", "Shapes", "Tiny Teddy",
    "Jatz", "Vita-Weat", "Iced VoVo",
  ].map(b) },
  { name: "Kelloggs Australia", brands: [
    "Nutri-Grain", "Kelloggs Cornflakes", "Coco Pops",
    "Sultana Bran", "Special K", "Pringles",
  ].map(b) },
  { name: 'Mondelez Australia', brands: [
    "Cadbury", "Pascall", "Jaffas", "Picnic", "Cherry Ripe",
    "Belvita", "Oreo AU",
  ].map(b) },
  { name: 'Nestle Australia', brands: [
    "Milo", "Nescafe AU", "KitKat AU", "Smarties", "Maggi AU", "Allens",
  ].map(b) },
  { name: 'Heinz Australia', brands: [
    "Heinz AU", "Greenseas", "Watties AU",
  ].map(b) },
  { name: 'Coca-Cola Europacific Partners', brands: [
    "Coca-Cola AU", "Sprite AU", "Fanta", "Mount Franklin",
    "Powerade", "Lift",
  ].map(b) },
  { name: 'Asahi Beverages', brands: [
    "Schweppes", "Solo", "Cottees", "Cool Ridge",
    "Pepsi AU",
  ].map(b) },
  { name: 'Lion Australia', brands: [
    "XXXX", "Tooheys", "Hahn", "James Squire", "Furphy",
    "Yoplait Australia",
  ].map(b) },
  { name: 'Carlton & United Breweries', brands: [
    "Victoria Bitter", "Carlton Draught", "Crown Lager",
    "Cascade", "Pure Blonde",
  ].map(b) },
  { name: 'PepsiCo Australia', brands: [
    "Smiths", "Doritos AU", "Cheetos", "Twisties",
    "Red Rock Deli", "Quaker AU",
  ].map(b) },
  { name: 'Independent AU brands', brands: [
    "Capilano", "SPC", "Goulburn Valley", "Ardmona",
    "Yowie", "Bundaberg",
  ].map(b) },
];

const COUNTRY_CATALOG = {
  IN: IN_FAMILIES,
  NZ: NZ_FAMILIES,
  AU: AU_FAMILIES,
};

// ISO-3166-1 alpha-2 codes for which we have a curated catalog. The
// admin "Pre-populate" button reads this to decide whether to render.
const SUPPORTED_COUNTRIES = Object.keys(COUNTRY_CATALOG);

// Diacritics-light slugify — good enough for the FMCG names we're seeding.
// Matches slug rules used by ProductCategory etc. (lowercase, hyphenated).
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[‘’']/g, '') // strip curly + straight apostrophes
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getCountryCatalog(countryCode) {
  if (!countryCode) return null;
  return COUNTRY_CATALOG[String(countryCode).toUpperCase()] || null;
}

// Idempotently insert the catalog for `countryCode` into a tenant's
// ProductBrandFamily + ProductBrand tables. Existing slugs are skipped so
// repeated runs don't duplicate. Returns { familiesAdded, brandsAdded }.
//
// Designed to be called from:
//   • business setup when the seller picks a country
//   • the admin "Pre-populate" button on the Brands panel
//
// Uses the prisma client passed in (prefer the request-scoped one) so it
// composes cleanly inside a $transaction if the caller wraps it.
async function seedBrandsForBusiness(prisma, { businessId, countryCode }) {
  const cat = getCountryCatalog(countryCode);
  if (!cat || !businessId) return { familiesAdded: 0, brandsAdded: 0 };

  const country = String(countryCode).toUpperCase();
  let familiesAdded = 0;
  let brandsAdded = 0;

  for (let i = 0; i < cat.length; i++) {
    const fam = cat[i];
    const familySlug = slugify(fam.name);
    if (!familySlug) continue;

    let familyRow = await prisma.productBrandFamily.findUnique({
      where: { businessId_slug: { businessId, slug: familySlug } },
    });
    if (!familyRow) {
      familyRow = await prisma.productBrandFamily.create({
        data: {
          businessId,
          name: fam.name,
          slug: familySlug,
          countryCode: country,
          sortOrder: i * 10,
        },
      });
      familiesAdded++;
    }

    for (let j = 0; j < (fam.brands || []).length; j++) {
      const brand = fam.brands[j];
      const brandSlug = slugify(brand.name);
      if (!brandSlug) continue;
      const exists = await prisma.productBrand.findUnique({
        where: { businessId_slug: { businessId, slug: brandSlug } },
      });
      if (exists) continue;
      await prisma.productBrand.create({
        data: {
          businessId,
          brandFamilyId: familyRow.id,
          name: brand.name,
          slug: brandSlug,
          countryCode: country,
          sortOrder: j * 10,
        },
      });
      brandsAdded++;
    }
  }

  return { familiesAdded, brandsAdded };
}

module.exports = {
  COUNTRY_CATALOG,
  SUPPORTED_COUNTRIES,
  getCountryCatalog,
  seedBrandsForBusiness,
  slugify,
};
