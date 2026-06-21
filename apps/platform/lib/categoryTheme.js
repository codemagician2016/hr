// Single source of truth for "given a profession key, which theme should
// the storefront use?". Used by:
//   - backend/src/controllers/business.controller.js — when auto-creating
//     a Subscription on signup, derive the theme from the picked
//     profession (was hardcoded to 'default' before 2026-04-30, which
//     fell through to general_practice for every tenant)
//   - platform/components/admin-tabs/SettingsTab.js — when an admin
//     changes their business category from Settings, suggest the
//     matching theme (admin can decline to keep their existing content)
//
// IMPORTANT: there is a mirror copy of this file at
//   backend/src/lib/categoryTheme.js
// because verticals don't share modules. When you update one, update
// the other. The mapping must stay in lockstep — a backend assignment
// the admin UI doesn't know about is worse than no mapping at all.

// Map profession-key  →  theme-key (must exist in platform/lib/themes.js).
// Keep alphabetised by profession key for easy diff review.
export const CATEGORY_TO_THEME = {
  // Healthcare
  'doctor-clinic':     'doctor_clinic',
  'dentist':           'dental',
  'physiotherapy':     'physio',
  'mental-health':     'psychology',
  'veterinary':        'veterinary',
  'optometrist':       'optometry',
  'chiropractor':      'chiropractic',
  'astrology':         'astrology',

  // Beauty & personal care
  'salon-hair':        'hair_salon',
  'barber':            'barbershop',
  'spa-massage':       'day_spa',
  'nail-studio':       'nail_salon',
  'tattoo-studio':     'tattoo_studio',
  'makeup-artist':     'makeup_artist',

  // Professional services
  'lawyer':            'legal',
  'law-firm':          'law_firm',
  'accountant':        'accountant',
  'architect':         'architect',
  'ca-tax-consultant': 'ca_tax_consultant',
  'consultant':        'consultant',
  'it-services':       'it_services',
  'marketing-agency':  'marketing_agency',
  'real-estate':       'real_estate',
  'tax-advisor':       'financial_advisor',
  'business-coach':    'consultant',

  // Education & coaching
  'english-tutor':     'english_tutor',
  'english_tutor':     'english_tutor',
  'fitness-trainer':   'fitness_coach',
  'home-tutor':        'home_tutor',
  'home_tutor':        'home_tutor',
  'math-tuition':      'math_tuition',
  'math_tuition':      'math_tuition',
  'math-tutor':        'math_tutor',
  'math_tutor':        'math_tutor',
  'music-teacher':     'music_teacher',
  'online-courses':    'online_courses',
  'online-tutor':      'online_tutor',
  'online_tutor':      'online_tutor',
  'science-tutor':     'science_tutor',
  'science_tutor':     'science_tutor',
  'tutoring':          'tutor',
  // 'language-school', 'dance-studio', 'martial-arts'
  // intentionally fall back to 'other' — no specific themes shipped yet

  // Creative & media
  'photographer':      'photographer',
  'designer':          'designer',
  'dj':                'dj',
  'artist':            'artist',
  'writer-content':    'writer_content',
  // 'videographer', 'art-gallery' fall back to 'other' until specific themes ship

  // Hospitality & events
  'bar-pub':           'bar_pub',
  'restaurant':        'restaurant_reservations',
  'restaurant-bookings': 'restaurant_reservations',
  'restaurant_bookings': 'restaurant_reservations',
  'restaurant-reservations': 'restaurant_reservations',
  'restaurant_reservations': 'restaurant_reservations',

  // Auto & home services
  'mechanic':          'mechanic',
  'electrician':       'electrician',
  'plumber':           'plumber',
  'cleaning-service':  'cleaner',
  // 'pest-control' falls back to 'other'

  // ECOMMERCE professions — most don't have a dedicated theme yet, so
  // they fall back to 'other'. Add specific shop themes here as they
  // land.
  'bakery':           'bakery_sweets',
  'bakery-shop':      'bakery_sweets',
  'bookshop':          'books_stationery',
  'boutique-apparel':  'fashion',
  'cafe':             'food',
  'cafe-bakery':      'bakery_sweets',
  'cake-shop':        'bakery_sweets',
  'cosmetics-shop':    'beauty_shop',
  'dessert-shop':     'bakery_sweets',
  'electronics':       'electronics',
  'electronics-store': 'electronics',
  'florist':           'florist_gifts',
  'flowers':           'florist_gifts',
  'gift-shop':         'florist_gifts',
  'grocery':           'grocery',
  'hampers':           'florist_gifts',
  'health-food':       'health_food',
  'health-food-shop':  'health_food',
  'home-decor':        'home_furniture',
  'home-goods':        'home_furniture',
  'jewelry':           'jewelry_shop',
  'mithai-shop':      'bakery_sweets',
  'personalized-gifts': 'florist_gifts',
  'pet-shop':          'pet_supplies',
  'toy-store':         'toys_games',
  'sports-equipment':  'sports_fitness',
  'gym-gear':          'sports_fitness',
  'outdoor-gear':      'sports_fitness',
  'cloud-kitchen':     'food',
  'restaurant-takeaway': 'food',
  'pharmacy':          'pharmacy',
  'medical-store':     'pharmacy',
  'organic-food-store': 'health_food',
  'auto-parts':        'hardware',
  'auto-spares':       'hardware',
  'art-gallery':       'art_print',
  'art_gallery':       'art_print',
  'art-print-shop':    'art_print',
  'hardware-store':    'hardware',
  'gallery-shop':      'art_print',
  'print-shop':        'art_print',
  'print_shop':        'art_print',
  'craft-marketplace': 'marketplace',
  'local-marketplace': 'marketplace',
  'marketplace':       'marketplace',
  'multi-vendor-marketplace': 'marketplace',
  'online-marketplace': 'marketplace',
  'vendor-marketplace': 'marketplace',
  'camera-rental':     'rental',
  'equipment-rental':  'rental',
  'furniture-rental':  'rental',
  'party-rental':      'rental',
  'rental':            'rental',
  'rental-store':      'rental',
  'tool-rental':       'rental',
  'baby':              'baby_nursery',
  'baby-nursery':      'baby_nursery',
  'baby-products':     'baby_nursery',
  'baby-store':        'baby_nursery',
  'kids-baby':         'baby_nursery',
  'nursery':           'baby_nursery',
  'nursery-store':     'baby_nursery',
  'footwear':          'footwear',
  'footwear-store':    'footwear',
  'running-shoes':     'footwear',
  'shoe-store':        'footwear',
  'shoes':             'footwear',
  'sneaker-store':     'footwear',
  'supplement-store':  'health_food',
  'sweet-shop':       'bakery_sweets',
  'wall-art':          'art_print',
  'single-product':    'd2c',
  'd2c-brand':         'd2c',
  'digital-products':  'digital',
  'online-store-courses': 'digital',
  'office-supplies':  'b2b',
  'office-supply-store': 'b2b',
  'wholesale':         'b2b',
  'b2b-wholesale':     'b2b',
  'distributor':       'b2b',
  'cash-and-carry':    'b2b',
  'trade-supplies':    'b2b',
};

// Returns the theme key for a profession key, or 'other' if the
// profession is unknown/unmapped. Always returns a valid theme key
// guaranteed to exist in the THEMES registry.
export function getThemeForCategory(profession) {
  if (!profession) return 'other';
  const key = String(profession).trim().toLowerCase();
  return CATEGORY_TO_THEME[key]
    || CATEGORY_TO_THEME[key.replace(/_/g, '-')]
    || CATEGORY_TO_THEME[key.replace(/-/g, '_')]
    || 'other';
}

// Same data the other direction — useful for the admin UI's "themes
// recommended for your category" hint.
export function getCategoriesForTheme(themeKey) {
  return Object.entries(CATEGORY_TO_THEME)
    .filter(([, t]) => t === themeKey)
    .map(([category]) => category);
}
