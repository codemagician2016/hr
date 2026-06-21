import { describe, expect, test } from 'vitest';
import BUILDER_PROFILES, { resolveBuilderProfile } from '../lib/builderProfiles.js';
import { LAYOUT_PRESETS } from '../lib/layoutPresets.js';

describe('resolveBuilderProfile', () => {
  test('restaurant themes get the menu-first builder profile', () => {
    const profile = resolveBuilderProfile({
      themeKey: 'restaurant_reservations',
      theme: { name: 'Restaurant Reservations', category: 'Hospitality & Venues', tags: ['restaurant', 'dining'] },
      vertical: 'APPOINTMENT',
    });

    expect(profile.id).toBe('restaurant');
    expect(profile.sections.services.label).toBe('Menu');
    expect(profile.sections.pricing.label).toBe('Dining packages');
    expect(profile.copy.serviceCardNamePlaceholder).toMatch(/Dish|dining/i);
    expect(profile.copy.restaurantReadinessBody).toMatch(/Capacity|service periods|waitlist|deposits/i);
    expect(profile.recommendedLayoutKeys).toContain('chef-tasting-room');
  });

  test('static food themes also use the restaurant builder', () => {
    const profile = resolveBuilderProfile({
      themeKey: 'fine_dining',
      theme: { name: 'Fine Dining', category: 'Food & Restaurant', tags: ['menu'] },
      vertical: 'STATIC',
    });

    expect(profile.id).toBe('restaurant');
    expect(profile.sections.gallery.defaultOn).toBe(true);
  });

  test('healthcare themes get treatment and clinician wording', () => {
    const profile = resolveBuilderProfile({
      themeKey: 'doctor_clinic',
      theme: { name: 'Doctor Clinic', category: 'Healthcare', tags: ['doctor', 'clinic'] },
      vertical: 'APPOINTMENT',
    });

    expect(profile.id).toBe('healthcare');
    expect(profile.sections.services.label).toBe('Treatments');
    expect(profile.sections.team.label).toBe('Clinicians');
    expect(profile.recommendedLayoutKeys).toContain('dental-clinic');
  });

  test('barbershop matches beauty, not restaurant bar', () => {
    const profile = resolveBuilderProfile({
      themeKey: 'barbershop',
      theme: { name: 'Barbershop', category: 'Beauty & Wellness', tags: ['barber', 'grooming'] },
      vertical: 'STATIC',
    });

    expect(profile.id).toBe('beauty');
    expect(profile.sections.gallery.label).toBe('Lookbook');
  });

  test('education categories get course-first wording', () => {
    const profile = resolveBuilderProfile({
      themeKey: 'math_tuition',
      theme: { name: 'Math Tuition', category: 'Education & Training', tags: ['tuition'] },
      vertical: 'STATIC',
    });

    expect(profile.id).toBe('education');
    expect(profile.sections.services.label).toBe('Courses');
    expect(profile.copy.ctaLabel).toBe('Enquire now');
  });

  test('education profile can resolve from business category signals', () => {
    const profile = resolveBuilderProfile({
      themeKey: 'other',
      theme: { name: 'Other', category: 'General', tags: [] },
      business: { name: 'math10', category: 'math_tutor', vertical: 'STATIC' },
      vertical: 'STATIC',
    });

    expect(profile.id).toBe('education');
    expect(profile.sections.team.label).toBe('Tutors');
  });

  test('personal coaches get personal brand wording instead of education defaults', () => {
    const profile = resolveBuilderProfile({
      themeKey: 'life_coach',
      theme: { name: 'Life Coach', category: 'Personal Brand', tags: ['coach'] },
      vertical: 'STATIC',
    });

    expect(profile.id).toBe('personal');
    expect(profile.sections.services.label).toBe('Offers');
    expect(profile.recommendedLayoutKeys).toContain('coach-authority');
  });

  test('static shops get retail catalog wording', () => {
    const profile = resolveBuilderProfile({
      themeKey: 'handmade_boutique',
      theme: { name: 'Handmade Boutique', category: 'Retail', tags: ['shop', 'catalog'] },
      vertical: 'STATIC',
    });

    expect(profile.id).toBe('retail');
    expect(profile.sections.services.label).toBe('Collections');
    expect(profile.recommendedLayoutKeys).toContain('handmade-boutique');
  });

  test('event themes get event brief wording', () => {
    const profile = resolveBuilderProfile({
      themeKey: 'event_planner',
      theme: { name: 'Event Planner', category: 'Events', tags: ['event', 'planner'] },
      vertical: 'STATIC',
    });

    expect(profile.id).toBe('events');
    expect(profile.sections.contact.label).toBe('Brief');
    expect(profile.recommendedLayoutKeys).toContain('event-planner');
  });

  test('nonprofit themes get program and mission wording', () => {
    const profile = resolveBuilderProfile({
      themeKey: 'community_foundation',
      theme: { name: 'Community Foundation', category: 'Nonprofit', tags: ['charity', 'volunteer'] },
      vertical: 'STATIC',
    });

    expect(profile.id).toBe('nonprofit');
    expect(profile.sections.services.label).toBe('Programs');
    expect(profile.recommendedLayoutKeys).toContain('nonprofit-cause');
  });

  test('industrial themes get capability wording', () => {
    const profile = resolveBuilderProfile({
      themeKey: 'logistics_company',
      theme: { name: 'Logistics Company', category: 'Industrial', tags: ['logistics', 'fleet'] },
      vertical: 'STATIC',
    });

    expect(profile.id).toBe('industrial');
    expect(profile.sections.services.label).toBe('Capabilities');
    expect(profile.recommendedLayoutKeys).toContain('industrial-capability');
  });

  test('ecommerce vertical wins over generic retail signals', () => {
    const profile = resolveBuilderProfile({
      themeKey: 'grocery',
      theme: { name: 'Grocery Store', category: 'Retail & Ecommerce', tags: ['grocery'] },
      vertical: 'ECOMMERCE',
    });

    expect(profile.id).toBe('ecommerce');
    expect(profile.copy.ctaLabel).toBe('Shop now');
    expect(profile.sections.faq.defaultOn).toBe(true);
  });

  test('unknown themes fall back to the general builder', () => {
    const profile = resolveBuilderProfile({
      themeKey: 'custom_theme',
      theme: { name: 'Custom Theme', category: 'Other' },
      vertical: 'STATIC',
    });

    expect(profile.id).toBe('general');
    expect(profile.sections.services.defaultOn).toBe(true);
  });

  test('every profile recommends existing layout presets', () => {
    const validLayoutKeys = new Set(LAYOUT_PRESETS.map((preset) => preset.key));

    for (const [id, profile] of Object.entries(BUILDER_PROFILES)) {
      expect(profile.recommendedLayoutKeys.length, id).toBeGreaterThan(0);
      for (const key of profile.recommendedLayoutKeys) {
        expect(validLayoutKeys.has(key), `${id}:${key}`).toBe(true);
      }
    }
  });
});
