// Tests for the storefront-side layout-preset registry. Pure data +
// pure resolver functions, no DOM, no network. The same code is
// shared through packages/theme-engine so every app and backend validation
// reads the same preset registry.

import { describe, test, expect } from 'vitest';
import {
  LAYOUT_PRESETS,
  DEFAULT_PRESET_KEY,
  AVAILABLE_VARIANTS,
  VARIANT_LABELS,
  SECTION_LABELS,
  resolvePreset,
  resolveVariant,
  resolveAllVariants,
} from '../lib/layoutPresets.js';

describe('LAYOUT_PRESETS', () => {
  test('has exactly 100 presets', () => {
    expect(LAYOUT_PRESETS).toHaveLength(100);
  });

  test('every preset has key, name, aesthetic, description, variants', () => {
    for (const p of LAYOUT_PRESETS) {
      expect(p.key).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(p.name).toBeTruthy();
      expect(p.aesthetic).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.variants).toBeTypeOf('object');
    }
  });

  test('keys are unique', () => {
    const set = new Set(LAYOUT_PRESETS.map((p) => p.key));
    expect(set.size).toBe(LAYOUT_PRESETS.length);
  });

  test('"classic" is the first / default preset', () => {
    expect(LAYOUT_PRESETS[0].key).toBe('classic');
    expect(DEFAULT_PRESET_KEY).toBe('classic');
  });

  test('every variant referenced by a preset is implemented', () => {
    // Catches typos in the registry — the storefront falls back to v1
    // for unknown variants, which would silently make a preset feel
    // identical to Classic. This test forces every key to be one we
    // actually know how to render.
    for (const p of LAYOUT_PRESETS) {
      for (const [section, variant] of Object.entries(p.variants)) {
        const valid = AVAILABLE_VARIANTS[section] || ['v1'];
        expect(valid).toContain(variant);
      }
    }
  });

  test('restaurant-menu is a bespoke restaurant layout, not a generic variant mix', () => {
    const preset = LAYOUT_PRESETS.find((p) => p.key === 'restaurant-menu');
    expect(preset?.sectionOrder).toEqual(['services', 'pricing', 'gallery', 'testimonials', 'about', 'team', 'faq', 'contact']);
    expect(preset?.variants).toMatchObject({
      hero: 'restaurant-cover',
      services: 'menu-board',
      pricing: 'dining-packages',
      gallery: 'dining-strip',
      testimonials: 'dining-reviews',
      contact: 'reservation-panel',
    });
  });

  test('medical-trust is a bespoke clinic layout, not a generic variant mix', () => {
    const preset = LAYOUT_PRESETS.find((p) => p.key === 'medical-trust');
    expect(preset?.sectionOrder).toEqual(['services', 'team', 'testimonials', 'pricing', 'about', 'gallery', 'faq', 'contact']);
    expect(preset?.variants).toMatchObject({
      hero: 'clinic-intake',
      services: 'care-pathways',
      testimonials: 'patient-proof',
      pricing: 'visit-options',
      gallery: 'clinic-tour',
      contact: 'appointment-panel',
    });
  });

  test('law-prestige is a bespoke legal layout, not a generic variant mix', () => {
    const preset = LAYOUT_PRESETS.find((p) => p.key === 'law-prestige');
    expect(preset?.sectionOrder).toEqual(['services', 'testimonials', 'pricing', 'team', 'about', 'gallery', 'faq', 'contact']);
    expect(preset?.variants).toMatchObject({
      hero: 'legal-brief',
      services: 'practice-dossier',
      testimonials: 'client-evidence',
      pricing: 'engagement-scope',
      gallery: 'firm-library',
      contact: 'confidential-intake',
    });
  });

  test('fitness-energy is a bespoke fitness layout, not a generic variant mix', () => {
    const preset = LAYOUT_PRESETS.find((p) => p.key === 'fitness-energy');
    expect(preset?.sectionOrder).toEqual(['services', 'pricing', 'testimonials', 'gallery', 'team', 'about', 'faq', 'contact']);
    expect(preset?.variants).toMatchObject({
      hero: 'training-sprint',
      services: 'program-stack',
      testimonials: 'progress-proof',
      pricing: 'coaching-plans',
      gallery: 'training-floor',
      contact: 'goal-check',
    });
  });

  test('barber-shop is a bespoke grooming layout, not a generic variant mix', () => {
    const preset = LAYOUT_PRESETS.find((p) => p.key === 'barber-shop');
    expect(preset?.sectionOrder).toEqual(['services', 'pricing', 'gallery', 'testimonials', 'team', 'about', 'faq', 'contact']);
    expect(preset?.variants).toMatchObject({
      hero: 'barber-chair',
      services: 'grooming-menu',
      testimonials: 'chair-proof',
      pricing: 'grooming-packages',
      gallery: 'barber-lookbook',
      contact: 'chair-booking',
    });
  });

  test('dental-clinic is a bespoke dental layout, not a generic clinic mix', () => {
    const preset = LAYOUT_PRESETS.find((p) => p.key === 'dental-clinic');
    expect(preset?.sectionOrder).toEqual(['services', 'team', 'pricing', 'testimonials', 'gallery', 'about', 'faq', 'contact']);
    expect(preset?.variants).toMatchObject({
      hero: 'dental-visit',
      services: 'treatment-grid',
      testimonials: 'patient-reassurance',
      pricing: 'treatment-fees',
      gallery: 'dental-suite',
      contact: 'appointment-request',
    });
  });

  test('phase 3C property/trades/retail/portfolio layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'real-estate-showcase')?.variants).toMatchObject({
      hero: 'property-showcase',
      services: 'property-pathways',
      testimonials: 'seller-buyer-proof',
      pricing: 'property-options',
      gallery: 'property-tour',
      contact: 'appraisal-request',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'trades-quote')?.variants).toMatchObject({
      hero: 'trade-dispatch',
      services: 'trade-quote-board',
      testimonials: 'local-job-proof',
      pricing: 'service-plans',
      gallery: 'before-after',
      contact: 'quote-dispatch',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'fashion-drop')?.variants).toMatchObject({
      hero: 'retail-drop',
      services: 'collection-shelf',
      testimonials: 'buyer-notes',
      pricing: 'collection-offers',
      gallery: 'commerce-lookbook',
      contact: 'shop-support',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'photographer-gallery')?.variants).toMatchObject({
      hero: 'portfolio-wall',
      services: 'case-study-grid',
      testimonials: 'project-proof',
      pricing: 'creative-packages',
      gallery: 'portfolio-wall',
      contact: 'project-brief',
    });
  });

  test('phase 3D finance/wellness/hospitality/industrial layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'accounting-trust')?.variants).toMatchObject({
      hero: 'finance-ledger',
      services: 'ledger-services',
      testimonials: 'finance-confidence',
      pricing: 'advisory-retainers',
      gallery: 'document-stack',
      contact: 'document-intake',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'spa-retreat')?.variants).toMatchObject({
      hero: 'spa-ritual',
      services: 'treatment-grid',
      testimonials: 'guest-calm-proof',
      pricing: 'treatment-fees',
      gallery: 'calm-space',
      contact: 'ritual-booking',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'hotel-resort')?.variants).toMatchObject({
      hero: 'hotel-stay',
      services: 'stay-amenities',
      testimonials: 'stay-reviews',
      pricing: 'room-offers',
      gallery: 'stay-gallery',
      contact: 'stay-enquiry',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'industrial-capability')?.variants).toMatchObject({
      hero: 'industrial-capability',
      services: 'capability-matrix',
      testimonials: 'operations-proof',
      pricing: 'capacity-options',
      gallery: 'factory-floor',
      contact: 'sales-brief',
    });
  });

  test('phase 3E education/recruitment/logistics layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'tutor-conversion')?.variants).toMatchObject({
      hero: 'tutor-plan',
      services: 'subject-pathways',
      testimonials: 'learning-outcomes',
      pricing: 'tutoring-packages',
      gallery: 'learning-space',
      contact: 'assessment-enquiry',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'course-launch')?.variants).toMatchObject({
      hero: 'course-launchpad',
      services: 'module-stack',
      testimonials: 'cohort-proof',
      pricing: 'cohort-options',
      gallery: 'course-assets',
      contact: 'cohort-enquiry',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'recruitment-board')?.variants).toMatchObject({
      hero: 'recruitment-desk',
      services: 'hiring-board',
      testimonials: 'hiring-proof',
      pricing: 'hiring-retainers',
      gallery: 'pipeline-board',
      contact: 'hiring-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'logistics-network')?.variants).toMatchObject({
      hero: 'logistics-network',
      services: 'lane-network',
      testimonials: 'delivery-proof',
      pricing: 'freight-options',
      gallery: 'network-map',
      contact: 'freight-quote',
    });
  });

  test('phase 3F advisory document layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'finance-advisor')?.variants).toMatchObject({
      hero: 'advisor-plan',
      services: 'planning-pathways',
      testimonials: 'advisor-confidence',
      pricing: 'planning-retainers',
      gallery: 'planning-desk',
      contact: 'planning-intake',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'immigration-pathway')?.variants).toMatchObject({
      hero: 'visa-pathway',
      services: 'visa-stages',
      testimonials: 'visa-confidence',
      pricing: 'visa-options',
      gallery: 'visa-documents',
      contact: 'visa-assessment',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'consultant-diagnostic')?.variants).toMatchObject({
      hero: 'diagnostic-room',
      services: 'diagnostic-offers',
      testimonials: 'diagnostic-proof',
      pricing: 'diagnostic-packages',
      gallery: 'diagnostic-workshop',
      contact: 'diagnostic-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'notary-simple')?.variants).toMatchObject({
      hero: 'notary-counter',
      services: 'document-tasks',
      testimonials: 'document-proof',
      pricing: 'notary-fees',
      gallery: 'notary-documents',
      contact: 'document-appointment',
    });
  });

  test('phase 3G built environment layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'corporate-boardroom')?.variants).toMatchObject({
      hero: 'boardroom-brief',
      services: 'boardroom-services',
      testimonials: 'executive-proof',
      pricing: 'executive-retainers',
      gallery: 'boardroom-table',
      contact: 'boardroom-intake',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'architect-portfolio')?.variants).toMatchObject({
      hero: 'architecture-studio',
      services: 'studio-commissions',
      testimonials: 'commission-proof',
      pricing: 'commission-options',
      gallery: 'architecture-projects',
      contact: 'commission-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'builder-projects')?.variants).toMatchObject({
      hero: 'builder-site',
      services: 'build-capabilities',
      testimonials: 'build-proof',
      pricing: 'build-packages',
      gallery: 'site-progress',
      contact: 'project-quote',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'interior-lookbook')?.variants).toMatchObject({
      hero: 'interior-lookbook',
      services: 'room-schemes',
      testimonials: 'room-proof',
      pricing: 'design-packages',
      gallery: 'interior-rooms',
      contact: 'room-brief',
    });
  });

  test('phase 3H service and editorial layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'landscaping-before-after')?.variants).toMatchObject({
      hero: 'landscape-plan',
      services: 'outdoor-projects',
      testimonials: 'yard-proof',
      pricing: 'landscape-packages',
      gallery: 'outdoor-before-after',
      contact: 'landscape-quote',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'cleaning-service')?.variants).toMatchObject({
      hero: 'cleaning-route',
      services: 'cleaning-plans',
      testimonials: 'clean-proof',
      pricing: 'cleaning-packages',
      gallery: 'cleaning-results',
      contact: 'cleaning-quote',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'home-maintenance')?.variants).toMatchObject({
      hero: 'maintenance-log',
      services: 'repair-checklist',
      testimonials: 'home-proof',
      pricing: 'maintenance-plans',
      gallery: 'repair-log',
      contact: 'maintenance-request',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'writer-editorial')?.variants).toMatchObject({
      hero: 'editorial-desk',
      services: 'editorial-services',
      testimonials: 'publication-proof',
      pricing: 'editorial-packages',
      gallery: 'editorial-clips',
      contact: 'editorial-brief',
    });
  });

  test('phase 3I creator portfolio layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'developer-systems')?.variants).toMatchObject({
      hero: 'industrial-capability',
      services: 'capability-matrix',
      testimonials: 'operations-proof',
      pricing: 'engagement-scope',
      gallery: 'pipeline-board',
      contact: 'technical-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'designer-case-study')?.variants).toMatchObject({
      hero: 'design-casefile',
      services: 'design-process',
      testimonials: 'design-proof',
      pricing: 'design-engagements',
      gallery: 'case-study-wall',
      contact: 'design-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'creator-channel')?.variants).toMatchObject({
      hero: 'creator-studio',
      services: 'creator-offers',
      testimonials: 'audience-proof',
      pricing: 'creator-packages',
      gallery: 'channel-assets',
      contact: 'collaboration-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'podcast-studio')?.variants).toMatchObject({
      hero: 'podcast-studio',
      services: 'show-production',
      testimonials: 'listener-proof',
      pricing: 'production-packages',
      gallery: 'episode-library',
      contact: 'episode-brief',
    });
  });

  test('phase 3J authority and casebook layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'speaker-stage')?.variants).toMatchObject({
      hero: 'speaker-stage',
      services: 'talk-topics',
      testimonials: 'stage-proof',
      pricing: 'speaking-packages',
      gallery: 'stage-reel',
      contact: 'speaking-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'coach-authority')?.variants).toMatchObject({
      hero: 'speaker-stage',
      services: 'talk-topics',
      testimonials: 'stage-proof',
      pricing: 'speaking-packages',
      gallery: 'stage-reel',
      contact: 'speaking-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'artist-collection')?.variants).toMatchObject({
      hero: 'artist-collection',
      services: 'collection-works',
      testimonials: 'collector-proof',
      pricing: 'art-offers',
      gallery: 'art-collection',
      contact: 'collector-enquiry',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'agency-casebook')?.variants).toMatchObject({
      hero: 'agency-casebook',
      services: 'agency-method',
      testimonials: 'casebook-proof',
      pricing: 'agency-retainers',
      gallery: 'agency-casebook',
      contact: 'agency-brief',
    });
  });

  test('phase 3K retail product layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'grocery-market')?.variants).toMatchObject({
      hero: 'market-stall',
      services: 'market-groups',
      testimonials: 'fresh-proof',
      pricing: 'market-boxes',
      gallery: 'market-shelves',
      contact: 'market-order',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'electronics-catalog')?.variants).toMatchObject({
      hero: 'spec-catalog',
      services: 'spec-categories',
      testimonials: 'buyer-support-proof',
      pricing: 'product-bundles',
      gallery: 'product-specs',
      contact: 'product-advice',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'furniture-showroom')?.variants).toMatchObject({
      hero: 'showroom-floor',
      services: 'room-collections',
      testimonials: 'showroom-proof',
      pricing: 'showroom-packages',
      gallery: 'showroom-rooms',
      contact: 'showroom-visit',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'beauty-brand-store')?.variants).toMatchObject({
      hero: 'beauty-routine',
      services: 'routine-sets',
      testimonials: 'routine-proof',
      pricing: 'routine-kits',
      gallery: 'routine-shelf',
      contact: 'routine-advice',
    });
  });

  test('phase 3L subscription wholesale maker and venue layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'subscription-box')?.variants).toMatchObject({
      hero: 'subscription-unbox',
      services: 'box-plans',
      testimonials: 'subscriber-proof',
      pricing: 'box-subscriptions',
      gallery: 'box-unboxing',
      contact: 'subscription-help',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'wholesale-catalog')?.variants).toMatchObject({
      hero: 'wholesale-desk',
      services: 'trade-ranges',
      testimonials: 'trade-proof',
      pricing: 'trade-terms',
      gallery: 'trade-catalog',
      contact: 'trade-account',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'handmade-boutique')?.variants).toMatchObject({
      hero: 'maker-boutique',
      services: 'maker-ranges',
      testimonials: 'maker-proof',
      pricing: 'maker-offers',
      gallery: 'maker-studio',
      contact: 'custom-order',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'wedding-venue')?.variants).toMatchObject({
      hero: 'venue-celebration',
      services: 'venue-packages',
      testimonials: 'celebration-proof',
      pricing: 'venue-packages',
      gallery: 'venue-spaces',
      contact: 'venue-date-check',
    });
  });

  test('phase 3M event travel nonprofit community and ministry layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'event-planner')?.variants).toMatchObject({
      hero: 'event-command',
      services: 'event-blueprint',
      testimonials: 'event-proof',
      pricing: 'event-packages',
      gallery: 'event-production',
      contact: 'event-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'travel-experiences')?.variants).toMatchObject({
      hero: 'journey-map',
      services: 'itinerary-paths',
      testimonials: 'traveller-proof',
      pricing: 'trip-options',
      gallery: 'travel-scenes',
      contact: 'trip-enquiry',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'nonprofit-cause')?.variants).toMatchObject({
      hero: 'cause-impact',
      services: 'impact-programs',
      testimonials: 'impact-proof',
      pricing: 'donation-paths',
      gallery: 'cause-stories',
      contact: 'supporter-action',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'community-hub')?.variants).toMatchObject({
      hero: 'community-welcome',
      services: 'community-programs',
      testimonials: 'member-proof',
      pricing: 'membership-options',
      gallery: 'community-moments',
      contact: 'participation-enquiry',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'church-ministry')?.variants).toMatchObject({
      hero: 'ministry-gathering',
      services: 'ministry-pathways',
      testimonials: 'ministry-proof',
      pricing: 'ministry-giving',
      gallery: 'ministry-life',
      contact: 'visit-ministry',
    });
  });

  test('phase 3N food hospitality layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'chef-tasting-room')?.variants).toMatchObject({
      hero: 'chef-table',
      services: 'tasting-menu',
      testimonials: 'chef-proof',
      pricing: 'tasting-offers',
      gallery: 'chef-pass',
      contact: 'tasting-reservation',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'cafe-counter')?.variants).toMatchObject({
      hero: 'cafe-counter-hero',
      services: 'cafe-shelf',
      testimonials: 'cafe-regulars',
      pricing: 'cafe-specials',
      gallery: 'cafe-display',
      contact: 'cafe-order',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'bar-nightlife')?.variants).toMatchObject({
      hero: 'nightlife-stage',
      services: 'bar-programs',
      testimonials: 'nightlife-proof',
      pricing: 'bar-packages',
      gallery: 'nightlife-room',
      contact: 'bar-booking',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'food-truck')?.variants).toMatchObject({
      hero: 'truck-route',
      services: 'truck-menu',
      testimonials: 'street-food-proof',
      pricing: 'truck-catering',
      gallery: 'truck-route-gallery',
      contact: 'truck-location',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'private-dining')?.variants).toMatchObject({
      hero: 'private-room',
      services: 'private-dining-packages',
      testimonials: 'private-event-proof',
      pricing: 'private-room-offers',
      gallery: 'private-room-gallery',
      contact: 'private-dining-enquiry',
    });
  });

  test('phase 3O bakery catering cellar therapy and specialist layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'bakery-display')?.variants).toMatchObject({
      hero: 'bakery-window',
      services: 'bakery-trays',
      testimonials: 'bakery-proof',
      pricing: 'bakery-offers',
      gallery: 'bakery-case',
      contact: 'bakery-order',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'catering-events')?.variants).toMatchObject({
      hero: 'catering-brief',
      services: 'catering-packages',
      testimonials: 'catering-proof',
      pricing: 'catering-menus',
      gallery: 'catering-spread',
      contact: 'catering-quote',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'wine-cellar')?.variants).toMatchObject({
      hero: 'cellar-door',
      services: 'cellar-tastings',
      testimonials: 'cellar-proof',
      pricing: 'cellar-memberships',
      gallery: 'cellar-gallery',
      contact: 'cellar-booking',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'therapy-calm')?.variants).toMatchObject({
      hero: 'therapy-room',
      services: 'therapy-pathways',
      testimonials: 'therapy-proof',
      pricing: 'therapy-fees',
      gallery: 'calm-space',
      contact: 'therapy-enquiry',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'specialist-practice')?.variants).toMatchObject({
      hero: 'specialist-desk',
      services: 'specialist-care',
      testimonials: 'specialist-proof',
      pricing: 'specialist-options',
      gallery: 'specialist-suite',
      contact: 'specialist-referral',
    });
  });

  test('phase 3P health and wellness layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'diagnostic-lab')?.variants).toMatchObject({
      hero: 'specialist-desk',
      services: 'specialist-care',
      testimonials: 'specialist-proof',
      pricing: 'specialist-options',
      gallery: 'specialist-suite',
      contact: 'specialist-referral',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'veterinary-care')?.variants).toMatchObject({
      hero: 'vet-visit',
      services: 'pet-care-pathways',
      testimonials: 'pet-family-proof',
      pricing: 'pet-care-plans',
      gallery: 'pet-clinic-tour',
      contact: 'pet-visit-request',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'skincare-clinic')?.variants).toMatchObject({
      hero: 'beauty-routine',
      services: 'routine-sets',
      testimonials: 'routine-proof',
      pricing: 'routine-kits',
      gallery: 'routine-shelf',
      contact: 'routine-advice',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'yoga-studio')?.variants).toMatchObject({
      hero: 'coach-authority',
      services: 'coaching-paths',
      testimonials: 'coaching-proof',
      pricing: 'coaching-programs',
      gallery: 'coaching-board',
      contact: 'coaching-fit',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'wellness-coach')?.variants).toMatchObject({
      hero: 'coach-authority',
      services: 'coaching-paths',
      testimonials: 'coaching-proof',
      pricing: 'coaching-programs',
      gallery: 'coaching-board',
      contact: 'coaching-fit',
    });
  });

  test('phase 3Q education fitness and family layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'fitness-program')?.variants).toMatchObject({
      hero: 'training-sprint',
      services: 'program-stack',
      testimonials: 'progress-proof',
      pricing: 'coaching-plans',
      gallery: 'training-floor',
      contact: 'goal-check',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'maternity-care')?.variants).toMatchObject({
      hero: 'clinic-intake',
      services: 'care-pathways',
      testimonials: 'patient-proof',
      pricing: 'visit-options',
      gallery: 'clinic-tour',
      contact: 'appointment-panel',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'cohort-academy')?.variants).toMatchObject({
      hero: 'course-launchpad',
      services: 'module-stack',
      testimonials: 'cohort-proof',
      pricing: 'cohort-options',
      gallery: 'course-assets',
      contact: 'cohort-enquiry',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'preschool-warm')?.variants).toMatchObject({
      hero: 'school-open-day',
      services: 'learning-pathways',
      testimonials: 'family-outcomes',
      pricing: 'enrolment-options',
      gallery: 'campus-tour',
      contact: 'admissions-enquiry',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'language-institute')?.variants).toMatchObject({
      hero: 'tutor-plan',
      services: 'subject-pathways',
      testimonials: 'learning-outcomes',
      pricing: 'tutoring-packages',
      gallery: 'learning-space',
      contact: 'assessment-enquiry',
    });
  });

  test('phase 3R foundation layouts use bespoke non-generic variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'classic')?.variants).toMatchObject({
      hero: 'service-front',
      services: 'service-pathways',
      testimonials: 'service-proof',
      pricing: 'service-options',
      gallery: 'service-gallery',
      contact: 'service-enquiry',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'magazine')?.variants).toMatchObject({
      hero: 'editorial-desk',
      services: 'editorial-services',
      testimonials: 'publication-proof',
      pricing: 'editorial-packages',
      gallery: 'editorial-clips',
      contact: 'editorial-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'minimal-mono')?.variants).toMatchObject({
      hero: 'service-front',
      services: 'service-pathways',
      testimonials: 'service-proof',
      pricing: 'service-options',
      gallery: 'service-gallery',
      contact: 'service-enquiry',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'bold-split')?.variants).toMatchObject({
      hero: 'agency-casebook',
      services: 'agency-method',
      testimonials: 'casebook-proof',
      pricing: 'agency-retainers',
      gallery: 'agency-casebook',
      contact: 'agency-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'wellness-warm')?.variants).toMatchObject({
      hero: 'spa-ritual',
      services: 'ritual-menu',
      testimonials: 'guest-calm-proof',
      pricing: 'treatment-rituals',
      gallery: 'ritual-atmosphere',
      contact: 'ritual-booking',
    });
  });

  test('phase 3S technology luxury studio consultancy and agency layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'tech-grid')?.variants).toMatchObject({
      hero: 'developer-console',
      services: 'system-builds',
      testimonials: 'technical-proof',
      pricing: 'technical-retainers',
      gallery: 'system-screens',
      contact: 'technical-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'luxury-serif')?.variants).toMatchObject({
      hero: 'artist-collection',
      services: 'collection-works',
      testimonials: 'collector-proof',
      pricing: 'art-offers',
      gallery: 'art-collection',
      contact: 'collector-enquiry',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'studio-portfolio')?.variants).toMatchObject({
      hero: 'portfolio-wall',
      services: 'case-study-grid',
      testimonials: 'project-proof',
      pricing: 'creative-packages',
      gallery: 'portfolio-wall',
      contact: 'project-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'consultancy')?.variants).toMatchObject({
      hero: 'diagnostic-room',
      services: 'diagnostic-offers',
      testimonials: 'diagnostic-proof',
      pricing: 'diagnostic-packages',
      gallery: 'diagnostic-workshop',
      contact: 'diagnostic-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'agency-bold')?.variants).toMatchObject({
      hero: 'agency-casebook',
      services: 'agency-method',
      testimonials: 'casebook-proof',
      pricing: 'agency-retainers',
      gallery: 'agency-casebook',
      contact: 'agency-brief',
    });
  });

  test('phase 3T salon creative healthcare academy and commerce layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'salon-soft')?.variants).toMatchObject({
      hero: 'beauty-routine',
      services: 'routine-sets',
      testimonials: 'routine-proof',
      pricing: 'routine-kits',
      gallery: 'routine-shelf',
      contact: 'routine-advice',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'creative-mosaic')?.variants).toMatchObject({
      hero: 'design-casefile',
      services: 'design-process',
      testimonials: 'design-proof',
      pricing: 'design-engagements',
      gallery: 'case-study-wall',
      contact: 'design-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'healthcare')?.variants).toMatchObject({
      hero: 'specialist-desk',
      services: 'specialist-care',
      testimonials: 'patient-reassurance',
      pricing: 'specialist-options',
      gallery: 'specialist-suite',
      contact: 'appointment-request',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'academy')?.variants).toMatchObject({
      hero: 'school-open-day',
      services: 'learning-pathways',
      testimonials: 'family-outcomes',
      pricing: 'enrolment-options',
      gallery: 'campus-tour',
      contact: 'admissions-enquiry',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'commerce')?.variants).toMatchObject({
      hero: 'retail-drop',
      services: 'collection-shelf',
      testimonials: 'buyer-notes',
      pricing: 'collection-offers',
      gallery: 'commerce-lookbook',
      contact: 'shop-support',
    });
  });

  test('phase 3U startup personal editorial bento and boutique layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'startup')?.variants).toMatchObject({
      hero: 'developer-console',
      services: 'system-builds',
      testimonials: 'technical-proof',
      pricing: 'technical-retainers',
      gallery: 'system-screens',
      contact: 'technical-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'personal-brand')?.variants).toMatchObject({
      hero: 'coach-authority',
      services: 'coaching-paths',
      testimonials: 'coaching-proof',
      pricing: 'coaching-programs',
      gallery: 'coaching-board',
      contact: 'coaching-fit',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'editorial-feature')?.variants).toMatchObject({
      hero: 'editorial-desk',
      services: 'editorial-services',
      testimonials: 'publication-proof',
      pricing: 'editorial-packages',
      gallery: 'editorial-clips',
      contact: 'editorial-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'bento-modern')?.variants).toMatchObject({
      hero: 'service-front',
      services: 'service-pathways',
      testimonials: 'service-proof',
      pricing: 'service-options',
      gallery: 'service-gallery',
      contact: 'service-enquiry',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'boutique-card')?.variants).toMatchObject({
      hero: 'maker-boutique',
      services: 'maker-ranges',
      testimonials: 'maker-proof',
      pricing: 'maker-offers',
      gallery: 'maker-studio',
      contact: 'custom-order',
    });
  });

  test('phase 3V final premium layouts use bespoke variants', () => {
    expect(LAYOUT_PRESETS.find((p) => p.key === 'saas-launch')?.variants).toMatchObject({
      hero: 'developer-console',
      services: 'system-builds',
      testimonials: 'technical-proof',
      pricing: 'technical-retainers',
      gallery: 'system-screens',
      contact: 'technical-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'studio-feature')?.variants).toMatchObject({
      hero: 'design-casefile',
      services: 'design-process',
      testimonials: 'design-proof',
      pricing: 'design-engagements',
      gallery: 'case-study-wall',
      contact: 'design-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'retail-bento')?.variants).toMatchObject({
      hero: 'retail-drop',
      services: 'collection-shelf',
      testimonials: 'buyer-notes',
      pricing: 'collection-offers',
      gallery: 'commerce-lookbook',
      contact: 'shop-support',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'clinic-timeline')?.variants).toMatchObject({
      hero: 'clinic-intake',
      services: 'care-pathways',
      testimonials: 'family-outcomes',
      pricing: 'treatment-fees',
      gallery: 'dental-suite',
      contact: 'appointment-request',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'editorial-mono')?.variants).toMatchObject({
      hero: 'editorial-desk',
      services: 'editorial-services',
      testimonials: 'publication-proof',
      pricing: 'editorial-packages',
      gallery: 'editorial-clips',
      contact: 'editorial-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'agency-feature')?.variants).toMatchObject({
      hero: 'agency-casebook',
      services: 'agency-method',
      testimonials: 'casebook-proof',
      pricing: 'agency-retainers',
      gallery: 'agency-casebook',
      contact: 'agency-brief',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'boutique-bento')?.variants).toMatchObject({
      hero: 'beauty-routine',
      services: 'routine-sets',
      testimonials: 'routine-proof',
      pricing: 'routine-kits',
      gallery: 'routine-shelf',
      contact: 'routine-advice',
    });
    expect(LAYOUT_PRESETS.find((p) => p.key === 'training-enterprise')?.variants).toMatchObject({
      hero: 'course-launchpad',
      services: 'module-stack',
      testimonials: 'cohort-proof',
      pricing: 'cohort-options',
      gallery: 'course-assets',
      contact: 'cohort-enquiry',
    });
  });
});

describe('AVAILABLE_VARIANTS', () => {
  test('every section has v1 as a fallback', () => {
    for (const variants of Object.values(AVAILABLE_VARIANTS)) {
      expect(variants).toContain('v1');
    }
  });

  test('SECTION_LABELS covers every section in AVAILABLE_VARIANTS', () => {
    for (const section of Object.keys(AVAILABLE_VARIANTS)) {
      expect(SECTION_LABELS[section]).toBeTruthy();
    }
  });

  test('VARIANT_LABELS provides labels for every available variant', () => {
    for (const [section, variants] of Object.entries(AVAILABLE_VARIANTS)) {
      for (const v of variants) {
        const labels = VARIANT_LABELS[section] || {};
        expect(labels[v]).toBeTruthy();
      }
    }
  });
});

describe('resolvePreset', () => {
  test('null subscription → classic', () => {
    expect(resolvePreset(null).key).toBe('classic');
    expect(resolvePreset(undefined).key).toBe('classic');
  });

  test('null designPreset → classic', () => {
    expect(resolvePreset({ designPreset: null }).key).toBe('classic');
  });

  test('unknown designPreset → classic (no crash)', () => {
    expect(resolvePreset({ designPreset: 'not-a-real-preset' }).key).toBe('classic');
  });

  test('known designPreset → that preset', () => {
    expect(resolvePreset({ designPreset: 'magazine' }).key).toBe('magazine');
    expect(resolvePreset({ designPreset: 'minimal-mono' }).key).toBe('minimal-mono');
  });
});

describe('resolveVariant', () => {
  const sub = { designPreset: 'magazine' };

  test('uses preset default when no override', () => {
    expect(resolveVariant(sub, 'hero')).toBe('editorial-desk');
  });

  test('falls back to v1 for unknown section keys', () => {
    expect(resolveVariant(sub, 'no-such-section')).toBe('v1');
  });

  test('per-tenant override beats preset default (object form)', () => {
    const withOverride = { designPreset: 'magazine', sectionVariants: { hero: 'gradient-mesh' } };
    expect(resolveVariant(withOverride, 'hero')).toBe('gradient-mesh');
    // Sections without override still come from preset
    expect(resolveVariant(withOverride, 'services')).toBe('editorial-services');
  });

  test('per-tenant override beats preset default (JSON-string form)', () => {
    const withOverride = { designPreset: 'magazine', sectionVariants: '{"hero":"v1"}' };
    expect(resolveVariant(withOverride, 'hero')).toBe('v1');
  });

  test('malformed JSON in sectionVariants is ignored', () => {
    const withOverride = { designPreset: 'magazine', sectionVariants: '{not-valid-json' };
    expect(resolveVariant(withOverride, 'hero')).toBe('editorial-desk');
  });
});

describe('resolveAllVariants', () => {
  test('returns the full preset variant map for null subscription', () => {
    const out = resolveAllVariants(null);
    expect(out.hero).toBe('service-front');
    expect(out.services).toBe('service-pathways');
  });

  test('merges overrides on top of preset defaults', () => {
    const sub = { designPreset: 'magazine', sectionVariants: { hero: 'gradient-mesh' } };
    const out = resolveAllVariants(sub);
    expect(out.hero).toBe('gradient-mesh');
    expect(out.services).toBe('editorial-services'); // preset default
    expect(out.about).toBe('timeline');
  });

  test('sectionVariants JSON string parsed correctly', () => {
    const sub = { designPreset: 'classic', sectionVariants: '{"team":"carousel"}' };
    const out = resolveAllVariants(sub);
    expect(out.team).toBe('carousel');
    expect(out.hero).toBe('service-front');
  });
});
