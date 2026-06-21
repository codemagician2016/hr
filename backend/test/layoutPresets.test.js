// Unit tests for the layout-preset registry that backs the
// PUT /api/subscription/theme endpoint's designPreset / sectionVariants
// validation. Pure data, no DB.
const {
  LAYOUT_PRESETS,
  VALID_LAYOUT_PRESETS,
  SECTION_KEYS,
  sanitizeSectionVariants,
} = require('../src/core/lib/layoutPresets');

describe('LAYOUT_PRESETS', () => {
  test('exposes exactly 100 preset keys', () => {
    expect(LAYOUT_PRESETS).toHaveLength(100);
  });

  test('"classic" is the first entry — the default for null designPreset', () => {
    expect(LAYOUT_PRESETS[0]).toBe('classic');
  });

  test('all keys are unique, lowercase, hyphenated', () => {
    const set = new Set(LAYOUT_PRESETS);
    expect(set.size).toBe(LAYOUT_PRESETS.length);
    for (const k of LAYOUT_PRESETS) {
      expect(k).toMatch(/^[a-z][a-z0-9-]+$/);
    }
  });

  test('VALID_LAYOUT_PRESETS rejects unknown values', () => {
    expect(VALID_LAYOUT_PRESETS.has('classic')).toBe(true);
    expect(VALID_LAYOUT_PRESETS.has('not-a-real-preset')).toBe(false);
    expect(VALID_LAYOUT_PRESETS.has('')).toBe(false);
  });
});

describe('SECTION_KEYS', () => {
  test('covers every section the storefront renders', () => {
    const expected = ['hero', 'services', 'about', 'team', 'gallery', 'testimonials', 'pricing', 'faq', 'contact'];
    for (const k of expected) expect(SECTION_KEYS.has(k)).toBe(true);
  });
});

describe('sanitizeSectionVariants', () => {
  test('drops unknown section keys silently', () => {
    const out = sanitizeSectionVariants({ hero: 'split-image', notASection: 'whatever' });
    expect(out).toEqual({ hero: 'split-image' });
  });

  test('coerces non-string variant values away', () => {
    const out = sanitizeSectionVariants({ hero: 42, services: 'cards' });
    expect(out).toEqual({ services: 'cards' });
  });

  test('drops empty / whitespace-only variants', () => {
    const out = sanitizeSectionVariants({ hero: '   ', services: 'cards' });
    expect(out).toEqual({ services: 'cards' });
  });

  test('caps variant key length so a malicious payload can not balloon the JSON column', () => {
    const longKey = 'x'.repeat(500);
    const out = sanitizeSectionVariants({ hero: longKey });
    expect(out.hero.length).toBeLessThanOrEqual(64);
  });

  test('returns an empty object for null / non-object input', () => {
    expect(sanitizeSectionVariants(null)).toEqual({});
    expect(sanitizeSectionVariants(undefined)).toEqual({});
    expect(sanitizeSectionVariants('not an object')).toEqual({});
    expect(sanitizeSectionVariants(42)).toEqual({});
  });
});
