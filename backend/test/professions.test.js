// Sanity tests for the profession taxonomy. The data file is the source
// of truth for both onboarding's recommended-vertical badge and the
// server's setup-payload validator, so a typo would silently mis-route
// new signups. These tests catch the obvious foot-guns.

const {
  SECTORS,
  getProfession,
  getRecommendedVertical,
  allProfessionKeys,
  isValidProfession,
} = require('../src/core/lib/professions');

describe('professions taxonomy', () => {
  test('every sector has at least one profession', () => {
    for (const sector of SECTORS) {
      expect(Array.isArray(sector.professions)).toBe(true);
      expect(sector.professions.length).toBeGreaterThan(0);
    }
  });

  test('every profession key is unique across sectors', () => {
    const seen = new Set();
    for (const sector of SECTORS) {
      for (const p of sector.professions) {
        expect(seen.has(p.key)).toBe(false);
        seen.add(p.key);
      }
    }
  });

  test('every profession maps to one of the three valid verticals', () => {
    const valid = new Set(['STATIC', 'APPOINTMENT', 'ECOMMERCE']);
    for (const sector of SECTORS) {
      for (const p of sector.professions) {
        expect(valid.has(p.vertical)).toBe(true);
      }
    }
  });

  test('every profession has a non-empty label', () => {
    for (const sector of SECTORS) {
      for (const p of sector.professions) {
        expect(typeof p.label).toBe('string');
        expect(p.label.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('sector keys are unique', () => {
    const keys = SECTORS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('getProfession', () => {
  test('returns the profession + sector context for a known key', () => {
    const p = getProfession('bakery');
    expect(p).not.toBeNull();
    expect(p.label).toBe('Bakery');
    expect(p.vertical).toBe('ECOMMERCE');
    expect(p.sectorKey).toBe('food-beverage');
    expect(p.sectorLabel).toBe('Food & Beverage');
  });

  test('returns null for unknown key', () => {
    expect(getProfession('made-up-thing')).toBeNull();
  });

  test('returns null for empty / null input', () => {
    expect(getProfession('')).toBeNull();
    expect(getProfession(null)).toBeNull();
    expect(getProfession(undefined)).toBeNull();
  });
});

describe('getRecommendedVertical', () => {
  test('routes appointment-style professions to APPOINTMENT', () => {
    expect(getRecommendedVertical('doctor-clinic')).toBe('APPOINTMENT');
    expect(getRecommendedVertical('salon-hair')).toBe('APPOINTMENT');
    expect(getRecommendedVertical('fitness-trainer')).toBe('APPOINTMENT');
  });

  test('routes shop-style professions to ECOMMERCE', () => {
    expect(getRecommendedVertical('grocery')).toBe('ECOMMERCE');
    expect(getRecommendedVertical('boutique-apparel')).toBe('ECOMMERCE');
    expect(getRecommendedVertical('pharmacy')).toBe('ECOMMERCE');
  });

  test('routes marketing-site professions to STATIC', () => {
    expect(getRecommendedVertical('lawyer')).toBe('STATIC');
    expect(getRecommendedVertical('architect')).toBe('STATIC');
  });

  test('falls back to APPOINTMENT for unknown professions', () => {
    expect(getRecommendedVertical('not-real')).toBe('APPOINTMENT');
    expect(getRecommendedVertical(null)).toBe('APPOINTMENT');
  });
});

describe('allProfessionKeys + isValidProfession', () => {
  test('allProfessionKeys returns at least 50 entries', () => {
    expect(allProfessionKeys().length).toBeGreaterThanOrEqual(50);
  });

  test('isValidProfession recognises every taxonomy entry', () => {
    for (const key of allProfessionKeys()) {
      expect(isValidProfession(key)).toBe(true);
    }
  });

  test('isValidProfession rejects unknowns', () => {
    expect(isValidProfession('whatever')).toBe(false);
    expect(isValidProfession('')).toBe(false);
    expect(isValidProfession(null)).toBe(false);
  });
});
