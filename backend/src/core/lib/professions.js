// Server-side mirror of platform/lib/professions.js.
//
// Used to validate the (profession, vertical) pair on /api/business/setup
// — a malicious client could otherwise smuggle a vertical that doesn't
// match the picked profession. Server treats the profession's
// recommended vertical as the SOURCE OF TRUTH unless the client
// explicitly overrode it (any of the 3 valid verticals is fine).
//
// Keep this in sync with platform/lib/professions.js. When adding a
// new profession, mirror it here.

const { resolveVertical } = require('./vertical');

const SECTORS = [
  {
    key: 'health-wellness',
    label: 'Health & Wellness',
    professions: [
      { key: 'doctor-clinic',     label: 'Doctor / Clinic',            vertical: 'APPOINTMENT' },
      { key: 'dentist',           label: 'Dentist',                    vertical: 'APPOINTMENT' },
      { key: 'physiotherapy',     label: 'Physiotherapy',              vertical: 'APPOINTMENT' },
      { key: 'mental-health',     label: 'Mental health / Therapist',  vertical: 'APPOINTMENT' },
      { key: 'veterinary',        label: 'Veterinary clinic',          vertical: 'APPOINTMENT' },
      { key: 'optometrist',       label: 'Optometrist',                vertical: 'APPOINTMENT' },
      { key: 'chiropractor',      label: 'Chiropractor',               vertical: 'APPOINTMENT' },
      { key: 'astrology',         label: 'Astrology consultant',        vertical: 'STATIC' },
      { key: 'pharmacy',          label: 'Pharmacy',                   vertical: 'ECOMMERCE' },
      { key: 'health-food-shop',  label: 'Health-food shop',           vertical: 'ECOMMERCE' },
    ],
  },
  {
    key: 'beauty-personal-care',
    label: 'Beauty & Personal Care',
    professions: [
      { key: 'salon-hair',     label: 'Salon / Hair',                  vertical: 'APPOINTMENT' },
      { key: 'barber',         label: 'Barber',                         vertical: 'APPOINTMENT' },
      { key: 'spa-massage',    label: 'Spa / Massage',                  vertical: 'APPOINTMENT' },
      { key: 'nail-studio',    label: 'Nail studio',                    vertical: 'APPOINTMENT' },
      { key: 'tattoo-studio',  label: 'Tattoo studio',                  vertical: 'APPOINTMENT' },
      { key: 'makeup-artist',  label: 'Makeup artist',                  vertical: 'APPOINTMENT' },
      { key: 'cosmetics-shop', label: 'Cosmetics shop',                 vertical: 'ECOMMERCE' },
    ],
  },
  {
    key: 'food-beverage',
    label: 'Food & Beverage',
    professions: [
      { key: 'restaurant-bookings', label: 'Restaurant (table bookings)', vertical: 'APPOINTMENT' },
      { key: 'cafe',                label: 'Cafe',                         vertical: 'ECOMMERCE' },
      { key: 'bakery',              label: 'Bakery',                       vertical: 'ECOMMERCE' },
      { key: 'cloud-kitchen',       label: 'Cloud kitchen',                vertical: 'ECOMMERCE' },
      { key: 'grocery',             label: 'Grocery / Kirana',             vertical: 'ECOMMERCE' },
      { key: 'sweet-shop',          label: 'Sweet shop',                   vertical: 'ECOMMERCE' },
      { key: 'catering',            label: 'Catering',                     vertical: 'APPOINTMENT' },
      { key: 'bar-pub',             label: 'Bar / Pub',                    vertical: 'STATIC' },
    ],
  },
  {
    key: 'retail-shopping',
    label: 'Retail & Shopping',
    professions: [
      { key: 'boutique-apparel', label: 'Boutique / Apparel',  vertical: 'ECOMMERCE' },
      { key: 'bookshop',         label: 'Bookshop',             vertical: 'ECOMMERCE' },
      { key: 'toy-store',        label: 'Toy store',            vertical: 'ECOMMERCE' },
      { key: 'electronics',      label: 'Electronics shop',     vertical: 'ECOMMERCE' },
      { key: 'jewelry',          label: 'Jewelry',              vertical: 'ECOMMERCE' },
      { key: 'florist',          label: 'Florist',              vertical: 'ECOMMERCE' },
      { key: 'pet-shop',         label: 'Pet shop',             vertical: 'ECOMMERCE' },
      { key: 'home-goods',       label: 'Home goods',           vertical: 'ECOMMERCE' },
      { key: 'gift-shop',        label: 'Gift shop',            vertical: 'ECOMMERCE' },
      { key: 'office-supplies',  label: 'Office / B2B supplies', vertical: 'ECOMMERCE' },
    ],
  },
  {
    key: 'professional-services',
    label: 'Professional Services',
    professions: [
      { key: 'lawyer',           label: 'Lawyer',                vertical: 'STATIC' },
      { key: 'law-firm',         label: 'Law Firm (bookings)',   vertical: 'APPOINTMENT' },
      { key: 'ca-tax-consultant', label: 'CA / Tax consultant',   vertical: 'STATIC' },
      { key: 'accountant',       label: 'Accountant',            vertical: 'APPOINTMENT' },
      { key: 'architect',        label: 'Architect',             vertical: 'STATIC' },
      { key: 'consultant',       label: 'Consultant',            vertical: 'APPOINTMENT' },
      { key: 'business-coach',   label: 'Business / Life coach', vertical: 'APPOINTMENT' },
      { key: 'real-estate',      label: 'Real estate agent',     vertical: 'STATIC' },
      { key: 'tax-advisor',      label: 'Tax advisor',           vertical: 'APPOINTMENT' },
      { key: 'marketing-agency', label: 'Marketing agency',      vertical: 'STATIC' },
      { key: 'it-services',      label: 'IT / Tech services',    vertical: 'STATIC' },
    ],
  },
  {
    key: 'education-coaching',
    label: 'Education & Coaching',
    professions: [
      { key: 'tutoring',          label: 'Tutoring',                vertical: 'APPOINTMENT' },
      { key: 'music-teacher',     label: 'Music teacher',           vertical: 'APPOINTMENT' },
      { key: 'sports-coach',      label: 'Sports coach',            vertical: 'APPOINTMENT' },
      { key: 'driving-school',    label: 'Driving school',          vertical: 'APPOINTMENT' },
      { key: 'language-school',   label: 'Language school',         vertical: 'APPOINTMENT' },
      { key: 'fitness-trainer',   label: 'Fitness trainer / Yoga',  vertical: 'APPOINTMENT' },
      { key: 'dance-studio',      label: 'Dance studio',            vertical: 'APPOINTMENT' },
      { key: 'martial-arts',      label: 'Martial arts dojo',       vertical: 'APPOINTMENT' },
      { key: 'online-courses',    label: 'Online courses',          vertical: 'STATIC' },
    ],
  },
  {
    key: 'creative-media',
    label: 'Creative & Media',
    professions: [
      { key: 'photographer',     label: 'Photographer',             vertical: 'APPOINTMENT' },
      { key: 'designer',         label: 'Designer',                 vertical: 'STATIC' },
      { key: 'videographer',     label: 'Videographer',             vertical: 'APPOINTMENT' },
      { key: 'dj',               label: 'DJ',                       vertical: 'STATIC' },
      { key: 'artist',           label: 'Artist',                   vertical: 'STATIC' },
      { key: 'writer-content',   label: 'Writer / Content creator', vertical: 'STATIC' },
      { key: 'art-gallery',      label: 'Art gallery / Print shop', vertical: 'ECOMMERCE' },
    ],
  },
  {
    key: 'hospitality-events',
    label: 'Hospitality & Events',
    professions: [
      { key: 'event-planner',    label: 'Event planner',         vertical: 'APPOINTMENT' },
      { key: 'wedding-planner',  label: 'Wedding planner',       vertical: 'APPOINTMENT' },
      { key: 'banquet-hall',     label: 'Banquet hall',          vertical: 'APPOINTMENT' },
      { key: 'hotel-bnb',        label: 'Hotel / B&B',           vertical: 'APPOINTMENT' },
      { key: 'tour-guide',       label: 'Tour guide / Travel',   vertical: 'APPOINTMENT' },
    ],
  },
  {
    key: 'auto-home-services',
    label: 'Auto & Home Services',
    professions: [
      { key: 'mechanic',         label: 'Mechanic / Auto repair', vertical: 'APPOINTMENT' },
      { key: 'electrician',      label: 'Electrician',            vertical: 'APPOINTMENT' },
      { key: 'plumber',          label: 'Plumber',                vertical: 'APPOINTMENT' },
      { key: 'cleaning-service', label: 'Cleaning service',       vertical: 'APPOINTMENT' },
      { key: 'pest-control',     label: 'Pest control',           vertical: 'APPOINTMENT' },
      { key: 'auto-spares',      label: 'Auto spare parts shop',  vertical: 'ECOMMERCE' },
      { key: 'home-decor',       label: 'Home decor shop',        vertical: 'ECOMMERCE' },
    ],
  },
  {
    key: 'other',
    label: 'Other',
    professions: [
      { key: 'other-appointment', label: 'Other — book time slots', vertical: 'APPOINTMENT' },
      { key: 'other-shop',        label: 'Other — sell products',   vertical: 'ECOMMERCE' },
      { key: 'other-static',      label: 'Other — marketing site',  vertical: 'STATIC' },
    ],
  },
];

function getProfession(key) {
  if (!key) return null;
  for (const sector of SECTORS) {
    const profession = sector.professions.find((p) => p.key === key);
    if (profession) {
      return { ...profession, sectorKey: sector.key, sectorLabel: sector.label };
    }
  }
  return null;
}

function getRecommendedVertical(professionKey) {
  return resolveVertical(getProfession(professionKey)?.vertical);
}

function allProfessionKeys() {
  const keys = [];
  for (const sector of SECTORS) {
    for (const p of sector.professions) keys.push(p.key);
  }
  return keys;
}

function isValidProfession(key) {
  return getProfession(key) !== null;
}

module.exports = {
  SECTORS,
  getProfession,
  getRecommendedVertical,
  allProfessionKeys,
  isValidProfession,
};
