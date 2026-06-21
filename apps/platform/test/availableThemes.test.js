// Guards the onboarding industry picker against drift. Every entry in
// the catalogue must have label + icon + desc + category, and the
// vertical-readiness helpers must only return themes that are explicitly
// flagged available — flipping a single flag should be the only edit
// required to surface a new theme.

import { describe, expect, test } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import {
  THEME_CATALOG,
  getAvailableGroups,
  getAvailableFlat,
  hasAnyAvailable,
} from '../lib/availableThemes.js';
import { getThemeForCategory } from '../lib/categoryTheme.js';

const require = createRequire(import.meta.url);

const STATIC_CATEGORY_LABELS = [
  'Personal & Portfolio',
  'Health & Medical',
  'Beauty & Wellness',
  'Fitness & Coaching',
  'Legal & Finance',
  'Education & Training',
  'Food & Restaurant',
  'Retail & Ecommerce',
  'Home Services',
  'Real Estate & Construction',
  'Automotive & Transport',
  'Technology & SaaS',
  'Marketing & Creative',
  'Events & Wedding',
  'Travel & Hospitality',
  'Non-Profit & Community',
  'Pets & Animals',
  'Manufacturing & Wholesale',
  'Agriculture & Environment',
  'Blog, Media & Creator',
];

function slugSourceTheme(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === '3d artist') return 'three_d_artist';
  if (normalized === 'fashion') return 'fashion_static_site';
  if (normalized === 'grocery') return 'grocery_static_site';
  if (normalized === 'makeup') return 'makeup_artist';
  return normalized
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function listStaticSourceTaxonomyKeys() {
  const roadmapPath = path.resolve(process.cwd(), '../../docs/STATIC_WEB_THEME_PHASES.md');
  const roadmap = fs.readFileSync(roadmapPath, 'utf8');
  const snapshot = roadmap.split('### Full Source Taxonomy Snapshot')[1] || '';
  const keys = new Set();

  for (const line of snapshot.split('\n')) {
    if (!line.startsWith('- ') || !line.includes(': ')) continue;
    const items = line.split(': ').slice(1).join(': ').replace(/\.$/, '').split(',');
    for (const item of items) {
      const key = slugSourceTheme(item);
      if (key) keys.add(key);
    }
  }

  return keys;
}

const SHIPPED_STATIC_THEMES = [
  { key: 'barbershop', category: 'Beauty & Wellness', contact: /cut|beard|barber/i },
  { key: 'hair_salon', category: 'Beauty & Wellness', contact: /hair|salon/i },
  { key: 'mens_grooming', category: 'Beauty & Wellness', contact: /grooming/i },
  { key: 'mobile_barber', category: 'Beauty & Wellness', contact: /location|headcount/i },
  { key: 'kids_haircut_salon', category: 'Beauty & Wellness', contact: /child|age/i },
  { key: 'beauty_parlour', category: 'Beauty & Wellness', contact: /skin|services|event/i },
  { key: 'bridal_salon', category: 'Beauty & Wellness', contact: /date|venue|headcount/i },
  { key: 'nail_salon', category: 'Beauty & Wellness', contact: /service|current nails|design/i },
  { key: 'lash_studio', category: 'Beauty & Wellness', contact: /lash|current set|sensitivity/i },
  { key: 'brow_studio', category: 'Beauty & Wellness', contact: /brow|sensitivity|photos/i },
  { key: 'day_spa', category: 'Beauty & Wellness', contact: /treatment|guest count|spa/i },
  { key: 'massage_therapist', category: 'Beauty & Wellness', contact: /bodywork|pressure|health/i },
  { key: 'thai_massage', category: 'Beauty & Wellness', contact: /thai|pressure|stretch/i },
  { key: 'deep_tissue_massage', category: 'Beauty & Wellness', contact: /tension|pressure|health/i },
  { key: 'luxury_spa', category: 'Beauty & Wellness', contact: /occasion|guest count|wellness/i },
  { key: 'skin_clinic', category: 'Beauty & Wellness', contact: /skin|routine|downtime/i },
  { key: 'facial_studio', category: 'Beauty & Wellness', contact: /facial|routine|timing/i },
  { key: 'laser_treatment', category: 'Beauty & Wellness', contact: /laser|skin tone|sun exposure/i },
  { key: 'cosmetic_clinic', category: 'Beauty & Wellness', contact: /aesthetic|treatment history|event timeline/i },
  { key: 'anti_aging_clinic', category: 'Beauty & Wellness', contact: /ageing|timeline|treatment history/i },
  { key: 'makeup_artist', category: 'Beauty & Wellness', contact: /event date|look direction|skin notes/i },
  { key: 'bridal_makeup', category: 'Beauty & Wellness', contact: /wedding date|venue|headcount/i },
  { key: 'event_makeup', category: 'Beauty & Wellness', contact: /event type|call time|glam level/i },
  { key: 'beauty_academy', category: 'Beauty & Wellness', contact: /career goal|program interest|schedule/i },
  { key: 'tattoo_studio', category: 'Beauty & Wellness', contact: /tattoo concept|placement|references/i },
  { key: 'piercing_studio', category: 'Beauty & Wellness', contact: /piercing placement|age\/ID|jewelry/i },
  { key: 'tattoo_artist_portfolio', category: 'Beauty & Wellness', contact: /tattoo idea|artist-fit|placement/i },
  { key: 'meditation_coach', category: 'Beauty & Wellness', contact: /meditation goal|experience level|format/i },
  { key: 'reiki_healer', category: 'Beauty & Wellness', contact: /reiki intention|session format|touch comfort/i },
  { key: 'wellness_centre', category: 'Beauty & Wellness', contact: /wellness goal|preferred format|practitioner/i },
  { key: 'holistic_therapist', category: 'Beauty & Wellness', contact: /support goal|modality|consent/i },
  { key: 'skincare_store', category: 'Beauty & Wellness', contact: /skin type|routine|product goal/i },
  { key: 'haircare_brand', category: 'Beauty & Wellness', contact: /hair texture|scalp concern|styling goal/i },
  { key: 'organic_beauty_brand', category: 'Beauty & Wellness', contact: /beauty goal|sensitivity|sourcing/i },
  { key: 'student_portfolio', category: 'Personal & Portfolio', contact: /opportunity type|timeline|portfolio focus/i },
  { key: 'professional_portfolio', category: 'Personal & Portfolio', contact: /opportunity type|scope|decision timeline/i },
  { key: 'developer_portfolio', category: 'Personal & Portfolio', contact: /developer role|stack needs|review timeline/i },
  { key: 'designer_portfolio', category: 'Personal & Portfolio', contact: /design opportunity|scope|style direction/i },
  { key: 'writer_portfolio', category: 'Personal & Portfolio', contact: /writing brief|audience|deadline/i },
  { key: 'photographer_portfolio', category: 'Personal & Portfolio', contact: /photography genre|usage|production details/i },
  { key: 'job_seeker_cv', category: 'Personal & Portfolio', contact: /target role|timeline|recruiter details/i },
  { key: 'executive_profile', category: 'Personal & Portfolio', contact: /executive opportunity|audience|timeline/i },
  { key: 'freelancer_cv', category: 'Personal & Portfolio', contact: /project brief|budget|timeline/i },
  { key: 'academic_cv', category: 'Personal & Portfolio', contact: /academic enquiry|research area|timeline/i },
  { key: 'creative_cv', category: 'Personal & Portfolio', contact: /creative role|style direction|deadline/i },
  { key: 'life_coach', category: 'Fitness & Coaching', contact: /coaching goal|context|preferred support/i },
  { key: 'business_coach', category: 'Fitness & Coaching', contact: /business challenge|growth goal|current metrics/i },
  { key: 'career_coach', category: 'Fitness & Coaching', contact: /career stage|target roles|biggest blocker/i },
  { key: 'executive_coach', category: 'Fitness & Coaching', contact: /leadership challenge|stakes|confidentiality needs/i },
  { key: 'mindset_coach', category: 'Fitness & Coaching', contact: /mindset goal|current pattern|support style/i },
  { key: 'leadership_coach', category: 'Fitness & Coaching', contact: /leadership challenge|team context|desired outcome/i },
  { key: 'fitness_coach_personal_brand', category: 'Fitness & Coaching', contact: /fitness goal|training history|support needs/i },
];

function eachEntry(cb) {
  for (const [vertical, cats] of Object.entries(THEME_CATALOG)) {
    for (const [category, themes] of Object.entries(cats)) {
      for (const t of themes) cb({ vertical, category, theme: t });
    }
  }
}

describe('THEME_CATALOG schema', () => {
  test('every entry has key + label + icon + desc + boolean available', () => {
    eachEntry(({ theme }) => {
      expect(theme.key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(theme.label).toMatch(/\S/);
      expect(theme.icon).toMatch(/\S/);
      expect(theme.desc).toMatch(/\S/);
      expect(typeof theme.available).toBe('boolean');
    });
  });

  test('all three verticals are present', () => {
    expect(Object.keys(THEME_CATALOG).sort()).toEqual(['APPOINTMENT', 'ECOMMERCE', 'STATIC']);
  });
});

describe('getAvailableGroups', () => {
  test('APPOINTMENT surfaces water_purifier under Home & Local Services', () => {
    const groups = getAvailableGroups('APPOINTMENT');
    const homeServices = groups.find((g) => g.label === 'Home & Local Services');
    expect(homeServices).toBeDefined();
    expect(homeServices.themes.map((t) => t.key)).toContain('water_purifier');
  });

  test('APPOINTMENT surfaces doctor_clinic under Healthcare', () => {
    const groups = getAvailableGroups('APPOINTMENT');
    const healthcare = groups.find((g) => g.label === 'Healthcare');
    expect(healthcare).toBeDefined();
    expect(healthcare.themes.map((t) => t.key)).toContain('doctor_clinic');
  });

  test('ECOMMERCE surfaces shipped shop themes', () => {
    const groups = getAvailableGroups('ECOMMERCE');
    const flat = groups.flatMap((g) => g.themes.map((t) => t.key));
    expect(flat).toEqual(['grocery', 'fashion', 'beauty_shop', 'jewelry_shop', 'home_furniture', 'pet_supplies', 'books_stationery', 'toys_games', 'sports_fitness', 'florist_gifts', 'bakery_sweets', 'health_food', 'electronics', 'food', 'pharmacy', 'hardware', 'd2c', 'digital', 'art_print', 'marketplace', 'rental', 'baby_nursery', 'footwear', 'b2b']);
  });

  test('STATIC categories match the documented marketplace menu', () => {
    const groups = getAvailableGroups('STATIC');
    expect(groups.map((g) => g.label)).toEqual(STATIC_CATEGORY_LABELS);
  });

  test('STATIC surfaces math_tuition under Education & Training', () => {
    const groups = getAvailableGroups('STATIC');
    const edu = groups.find((g) => g.label === 'Education & Training');
    expect(edu).toBeDefined();
    expect(edu.themes.map((t) => t.key)).toContain('math_tuition');
  });

  test('STATIC keeps barber in Beauty & Wellness, not the generic portfolio group', () => {
    const groups = getAvailableGroups('STATIC');
    const personal = groups.find((g) => g.label === 'Personal & Portfolio');
    const beauty = groups.find((g) => g.label === 'Beauty & Wellness');
    expect(personal.themes.map((t) => t.key)).not.toContain('barber');
    expect(beauty.themes.map((t) => t.key)).toContain('barber');
  });

  test('STATIC surfaces each shipped static theme in its configured category', () => {
    const groups = getAvailableGroups('STATIC');
    for (const shipped of SHIPPED_STATIC_THEMES) {
      const category = groups.find((g) => g.label === shipped.category);
      expect(category, shipped.category).toBeDefined();
      expect(category.themes.map((t) => t.key)).toContain(shipped.key);
    }
  });

  test('every returned theme is flagged available', () => {
    for (const vertical of Object.keys(THEME_CATALOG)) {
      for (const group of getAvailableGroups(vertical)) {
        for (const t of group.themes) expect(t.available).toBe(true);
      }
    }
  });
});

describe('hasAnyAvailable', () => {
  test('matches whether the vertical has any available theme', () => {
    expect(hasAnyAvailable('APPOINTMENT')).toBe(true);
    expect(hasAnyAvailable('ECOMMERCE')).toBe(true);
    expect(hasAnyAvailable('STATIC')).toBe(true);
  });
});

describe('getAvailableFlat', () => {
  test('returns the same themes the picker would render', () => {
    expect(getAvailableFlat('APPOINTMENT').map((t) => t.key)).toContain('doctor_clinic');
    expect(getAvailableFlat('APPOINTMENT').map((t) => t.key)).toContain('water_purifier');
    expect(getAvailableFlat('ECOMMERCE').map((t) => t.key)).toEqual(['grocery', 'fashion', 'beauty_shop', 'jewelry_shop', 'home_furniture', 'pet_supplies', 'books_stationery', 'toys_games', 'sports_fitness', 'florist_gifts', 'bakery_sweets', 'health_food', 'electronics', 'food', 'pharmacy', 'hardware', 'd2c', 'digital', 'art_print', 'marketplace', 'rental', 'baby_nursery', 'footwear', 'b2b']);
    expect(getAvailableFlat('STATIC').map((t) => t.key)).toContain('math_tuition');
  });
});

describe('appointment category theme mapping', () => {
  test('restaurant onboarding category resolves to restaurant reservations theme', () => {
    expect(getThemeForCategory('Restaurant')).toBe('restaurant_reservations');
    expect(getThemeForCategory('restaurant')).toBe('restaurant_reservations');
    expect(getThemeForCategory('restaurant-bookings')).toBe('restaurant_reservations');
    expect(getThemeForCategory('restaurant_bookings')).toBe('restaurant_reservations');
    expect(getThemeForCategory('restaurant-reservations')).toBe('restaurant_reservations');
    expect(getThemeForCategory('restaurant_reservations')).toBe('restaurant_reservations');
  });

  test('static education category keys resolve to education themes', () => {
    expect(getThemeForCategory('math_tutor')).toBe('math_tutor');
    expect(getThemeForCategory('math-tuition')).toBe('math_tuition');
    expect(getThemeForCategory('science_tutor')).toBe('science_tutor');
    expect(getThemeForCategory('english-tutor')).toBe('english_tutor');
  });

  test('ecommerce category keys resolve to shipped shop themes', () => {
    expect(getThemeForCategory('boutique-apparel')).toBe('fashion');
    expect(getThemeForCategory('bookshop')).toBe('books_stationery');
    expect(getThemeForCategory('cosmetics-shop')).toBe('beauty_shop');
    expect(getThemeForCategory('home-decor')).toBe('home_furniture');
    expect(getThemeForCategory('home-goods')).toBe('home_furniture');
    expect(getThemeForCategory('jewelry')).toBe('jewelry_shop');
    expect(getThemeForCategory('pet-shop')).toBe('pet_supplies');
    expect(getThemeForCategory('toy-store')).toBe('toys_games');
    expect(getThemeForCategory('sports-equipment')).toBe('sports_fitness');
    expect(getThemeForCategory('florist')).toBe('florist_gifts');
    expect(getThemeForCategory('gift-shop')).toBe('florist_gifts');
    expect(getThemeForCategory('bakery')).toBe('bakery_sweets');
    expect(getThemeForCategory('sweet-shop')).toBe('bakery_sweets');
    expect(getThemeForCategory('cake-shop')).toBe('bakery_sweets');
    expect(getThemeForCategory('health-food-shop')).toBe('health_food');
    expect(getThemeForCategory('supplement-store')).toBe('health_food');
    expect(getThemeForCategory('grocery')).toBe('grocery');
    expect(getThemeForCategory('electronics')).toBe('electronics');
    expect(getThemeForCategory('electronics-store')).toBe('electronics');
    expect(getThemeForCategory('cafe')).toBe('food');
    expect(getThemeForCategory('cloud-kitchen')).toBe('food');
    expect(getThemeForCategory('pharmacy')).toBe('pharmacy');
    expect(getThemeForCategory('auto-spares')).toBe('hardware');
    expect(getThemeForCategory('hardware-store')).toBe('hardware');
    expect(getThemeForCategory('digital-products')).toBe('digital');
    expect(getThemeForCategory('office-supplies')).toBe('b2b');
    expect(getThemeForCategory('wholesale')).toBe('b2b');
    expect(getThemeForCategory('trade-supplies')).toBe('b2b');
  });
});

describe('shipped STATIC theme registry', () => {
  test('full source taxonomy snapshot is covered by available STATIC themes', () => {
    const sourceKeys = listStaticSourceTaxonomyKeys();
    const availableKeys = new Set(getAvailableFlat('STATIC').map((theme) => theme.key));
    const missing = Array.from(sourceKeys).filter((key) => !availableKeys.has(key));

    expect(sourceKeys.size).toBeGreaterThanOrEqual(709);
    expect(missing).toEqual([]);
  });

  test('static theme content does not expose generator or cross-vertical artefacts', () => {
    const frontendConfigs = require('../../web/lib/themeConfigs.js');
    const forbidden = [
      /An strong/,
      /Men'S/,
      /Women'S/,
      /generic template with the business name swapped in/i,
      /cross-vertical leakage/i,
      /reusing another vertical/i,
      /premium static web theme/i,
      /website shaped for qualified enquiries/i,
      /website built for trust, clarity and qualified enquiries/i,
      /without borrowing language from another vertical/i,
      /content that feels purpose-built/i,
      /This .+ theme gives visitors/i,
      /This theme keeps vocabulary/i,
      /Registered for onboarding/i,
      /Visitor objections handled/i,
      /Specific proof for .+ visitors/i,
      /positioning with specific proof/i,
      /clear offers and enquiry-ready/i,
      /enquiry-ready content/i,
      /Trust-building proof/i,
      /turns first impressions into useful conversations/i,
      /sharp positioning/i,
      /Mapped from /i,
    ];

    for (const [key, config] of Object.entries(frontendConfigs)) {
      if (key === 'default') continue;
      const searchable = JSON.stringify({
        label: config.label,
        website: config.website?.defaultContent,
        vocab: config.vocab,
      });
      for (const pattern of forbidden) {
        expect(searchable, key).not.toMatch(pattern);
      }
    }

    expect(frontendConfigs.men_s_fashion?.label).toBe("Men's Fashion");
    expect(frontendConfigs.women_s_fashion?.label).toBe("Women's Fashion");
    expect(frontendConfigs.it_consultant?.label).toBe('IT Consultant');
    expect(frontendConfigs.dairy_farm?.website?.defaultContent?.heroHeadline).toMatch(/dairy|milk|herd/i);
    expect(frontendConfigs.dairy_farm?.website?.defaultContent?.tagline).toMatch(/milk|herd|supply/i);
    expect(frontendConfigs.dog_grooming?.website?.defaultContent?.heroSubheading).toMatch(/pet|owner|temperament|vaccination/i);
    expect(frontendConfigs.marketing_consultant?.vocab?.services).toBe('growth programs');
    expect(frontendConfigs.marketing_consultant?.website?.defaultContent?.heroHeadline).toMatch(/marketing|pipeline/i);
    expect(frontendConfigs.marketing_consultant?.website?.defaultContent?.services?.map((s) => s.name).join(' ')).toMatch(/Funnel|Positioning|Channel|Reporting/i);
    expect(frontendConfigs.marketing_consultant?.website?.defaultContent?.servicesEyebrow).not.toMatch(/Advisory/i);
    expect(frontendConfigs.barber?.vocab?.services).toBe('service menu');
    expect(frontendConfigs.barber?.website?.defaultContent?.heroHeadline).toMatch(/cuts|beard|bookings/i);
    expect(frontendConfigs.barber?.website?.defaultContent?.aboutBody).toMatch(/barber|chair|walk-in|reference photos/i);
    expect(frontendConfigs.barber?.website?.defaultContent?.aboutBody).not.toMatch(/product positioning|technical proof/i);
    expect(frontendConfigs.barber?.website?.defaultContent?.pricing?.map((p) => p.title).join(' ')).toMatch(/Signature Cut|Fade|Beard/i);
    expect(frontendConfigs.barber?.website?.defaultContent?.showGallery).toBe(true);
    expect(frontendConfigs.barber?.website?.defaultContent?.galleryImageKeywords?.join(' ')).toMatch(/barber|fade|grooming/i);
    expect(frontendConfigs.doctor?.vocab?.customers).toBe('patients');
    expect(frontendConfigs.doctor?.website?.defaultContent?.heroHeadline).toMatch(/patient|appointments|follow-up/i);
    expect(frontendConfigs.doctor?.website?.defaultContent?.faqItems?.map((item) => item.a).join(' ')).toMatch(/emergencies|diagnose|clinic/i);
    expect(frontendConfigs.doctor?.website?.defaultContent?.pricing?.map((p) => p.title).join(' ')).toMatch(/Consultation|Preventive|Reports/i);
    expect(frontendConfigs.doctor?.website?.defaultContent?.showGallery).toBe(true);
    expect(frontendConfigs.doctor?.website?.defaultContent?.galleryImageKeywords?.join(' ')).toMatch(/clinic|doctor|medical/i);
    expect(frontendConfigs.dentist?.vocab?.services).toBe('treatments');
    expect(frontendConfigs.dentist?.website?.defaultContent?.heroHeadline).toMatch(/dental|treatment/i);
    expect(frontendConfigs.dentist?.website?.defaultContent?.services?.map((s) => s.name).join(' ')).toMatch(/Exam|Hygiene|Fillings|Whitening/i);
    expect(frontendConfigs.dentist?.website?.defaultContent?.showGallery).toBe(true);
    expect(frontendConfigs.dentist?.website?.defaultContent?.galleryImageKeywords?.join(' ')).toMatch(/dental|dentist/i);
    expect(frontendConfigs.dental_clinic?.website?.defaultContent?.heroHeadline).toMatch(/Family dental|fees|follow-up/i);
    expect(frontendConfigs.dental_clinic?.website?.defaultContent?.faqItems?.map((item) => item.a).join(' ')).toMatch(/urgent|emergencies|guide prices/i);
    expect(frontendConfigs.lawyer?.vocab?.services).toBe('practice areas');
    expect(frontendConfigs.lawyer?.website?.defaultContent?.heroHeadline).toMatch(/legal|deadlines/i);
    expect(frontendConfigs.lawyer?.website?.defaultContent?.faqItems?.map((item) => item.a).join(' ')).toMatch(/lawyer-client|jurisdiction|sensitive/i);
    expect(frontendConfigs.lawyer?.website?.defaultContent?.pricing?.map((p) => p.title).join(' ')).toMatch(/Matter Review|Document Review|Counsel/i);
    expect(JSON.stringify(frontendConfigs.lawyer?.website?.defaultContent?.pricing)).not.toMatch(/Free during launch|staff members|Sitepresso/i);
    expect(frontendConfigs.lawyer?.website?.defaultContent?.showGallery).toBe(true);
    expect(frontendConfigs.lawyer?.website?.defaultContent?.galleryImageKeywords?.join(' ')).toMatch(/law|legal|documents/i);
    expect(frontendConfigs.restaurant?.vocab?.customers).toBe('guests');
    expect(frontendConfigs.restaurant?.website?.defaultContent?.heroHeadline).toMatch(/menus|bookings|private dining/i);
    expect(frontendConfigs.restaurant?.website?.defaultContent?.services?.map((s) => s.name).join(' ')).toMatch(/Menu|Reservations|Private Dining|Catering/i);
    expect(frontendConfigs.restaurant?.website?.defaultContent?.pricing?.map((p) => p.title).join(' ')).toMatch(/A La Carte|Set Menu|Private Dining/i);
    expect(frontendConfigs.restaurant?.website?.defaultContent?.showGallery).toBe(true);
    expect(frontendConfigs.restaurant?.website?.defaultContent?.gallery?.join(' ')).toMatch(/Signature dish|Dining room|Private table/i);
    expect(frontendConfigs.restaurant?.website?.defaultContent?.galleryImageKeywords?.join(' ')).toMatch(/restaurant|dining|chef|dish/i);
    expect(JSON.stringify(frontendConfigs.restaurant?.website?.defaultContent?.galleryImageKeywords)).not.toMatch(/office|workplace|construction|model/i);
    expect(frontendConfigs.fitness_program?.vocab?.services).toBe('programs');
    expect(frontendConfigs.fitness_program?.website?.defaultContent?.heroHeadline).toMatch(/Training plans|weekly action/i);
    expect(frontendConfigs.fitness_program?.website?.defaultContent?.faqItems?.map((item) => item.a).join(' ')).toMatch(/medical clearance|injuries|results/i);
    expect(frontendConfigs.fitness_program?.website?.defaultContent?.pricing?.map((p) => p.title).join(' ')).toMatch(/Assessment|Coaching|Hybrid/i);
    expect(frontendConfigs.fitness_program?.website?.defaultContent?.showGallery).toBe(true);
    expect(frontendConfigs.fitness_program?.website?.defaultContent?.galleryImageKeywords?.join(' ')).toMatch(/fitness|gym|training|coach/i);
  });

  test('each shipped static theme has frontend and backend registry coverage', () => {
    const frontendConfigs = require('../../web/lib/themeConfigs.js');
    const backendRegistry = require('../../../backend/src/core/lib/themeRegistry.js');

    for (const shipped of SHIPPED_STATIC_THEMES) {
      expect(frontendConfigs[shipped.key]?.vertical).toBe('web');
      expect(frontendConfigs[shipped.key]?.website?.defaultContent?.contactTitle).toMatch(shipped.contact);
      expect(backendRegistry.getThemeConfig(shipped.key)?.website?.defaultContent?.services).toHaveLength(4);
    }
  });

  test('available STATIC themes resolve in the root web storefront registry', async () => {
    const { getTheme, resolveThemeKey } = await import('../../web/core/lib/themes.js');
    const staticKeys = Array.from(new Set(getAvailableFlat('STATIC').map((theme) => theme.key)));

    for (const key of staticKeys) {
      expect(resolveThemeKey(key), key).toBe(key);
      expect(getTheme(key)?.key, key).toBe(key);
    }

    expect(getTheme('nail_salon')?.defaultContent?.heroHeadline).toMatch(/nail/i);
    expect(getTheme('nail_salon')?.defaultContent?.heroHeadline).not.toMatch(/doctor|medical|gp/i);
    expect(getTheme('nail_tech')?.defaultContent?.heroHeadline).toMatch(/nail/i);
  });

  test('available STATIC themes resolve in the platform admin runtime registry', async () => {
    const { getTheme, resolveThemeKey } = await import('../lib/themes.js');
    const staticKeys = Array.from(new Set(getAvailableFlat('STATIC').map((theme) => theme.key)));

    for (const key of staticKeys) {
      expect(resolveThemeKey(key), key).toBe(key);
      expect(getTheme(key)?.key, key).toBe(key);
    }

    expect(getTheme('nail_salon')?.defaultContent?.heroHeadline).toMatch(/nail/i);
    expect(getTheme('nail_salon')?.defaultContent?.heroHeadline).not.toMatch(/doctor|medical|gp/i);
    expect(getTheme('astrology')?.defaultContent?.services).toHaveLength(5);
  });
});
