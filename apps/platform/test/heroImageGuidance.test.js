import { describe, expect, test } from 'vitest';
import { getHeroImageGuidance, resolveHeroVariantForGuidance } from '../lib/heroImageGuidance.js';

describe('hero image guidance', () => {
  test('classic/service layouts guide owners toward the tall live hero card', () => {
    const guidance = getHeroImageGuidance({ designPreset: 'classic' });

    expect(guidance.heroVariant).toBe('service-front');
    expect(guidance.usesImage).toBe(true);
    expect(guidance.key).toBe('tall');
    expect(guidance.recommendedSize).toBe('1200x1600px');
    expect(guidance.uploadHint).toContain('Portrait-style website card');
  });

  test('hero section overrides are reflected in the guidance', () => {
    const guidance = getHeroImageGuidance({
      designPreset: 'classic',
      sectionVariants: { hero: 'card-stack' },
    });

    expect(guidance.heroVariant).toBe('card-stack');
    expect(guidance.key).toBe('panoramic');
    expect(guidance.recommendedSize).toBe('1920x720px');
  });

  test('text-only hero variants do not ask for an image upload', () => {
    const guidance = getHeroImageGuidance({
      designPreset: 'classic',
      sectionVariants: JSON.stringify({ hero: 'minimal-centered' }),
    });

    expect(guidance.heroVariant).toBe('minimal-centered');
    expect(guidance.usesImage).toBe(false);
    expect(guidance.stockImages).toEqual([]);
    expect(guidance.uploadHint).toContain('does not display a hero image');
  });

  test('explicit variants can be resolved without a preset lookup', () => {
    expect(resolveHeroVariantForGuidance({ heroVariant: 'v1' })).toBe('v1');
    expect(getHeroImageGuidance({ heroVariant: 'v1' }).key).toBe('wide');
  });
});

