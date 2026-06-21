// Unit tests for the default-service pricing calculator that runs at
// business signup. Pure math, no DB.
const {
  computeLocalPrice,
  roundToNice,
  DEFAULT_SERVICE_TEMPLATES,
  DEFAULT_CMS_SERVICES,
  DEFAULT_CMS_TEAM,
} = require('../src/core/lib/defaultServices');

describe('roundToNice', () => {
  test('rounds dollars/euros to whole units', () => {
    expect(roundToNice(40.37, 'USD')).toBe(40);
    expect(roundToNice(14.8, 'EUR')).toBe(15);
  });

  test('rounds INR to nearest 50 for mid-range', () => {
    expect(roundToNice(1487, 'INR')).toBe(1500);
    expect(roundToNice(1700, 'INR')).toBe(1700);
  });

  test('rounds JPY to nearest 100 for small amounts', () => {
    expect(roundToNice(4987, 'JPY')).toBe(5000);
  });

  test('rounds KWD (3-decimal) to 0.5', () => {
    expect(roundToNice(12.34, 'KWD')).toBe(12.5);
  });

  test('returns 0 for zero amount', () => {
    expect(roundToNice(0, 'USD')).toBe(0);
  });
});

describe('computeLocalPrice', () => {
  test('USD at Zone 1 = base', () => {
    expect(computeLocalPrice(40, 1.0, 'USD')).toBe(40);
  });

  test('INR at Zone 4 (0.5x) gives sensible rupee amount', () => {
    const price = computeLocalPrice(40, 0.5, 'INR');
    expect(price).toBeGreaterThan(500);
    expect(price).toBeLessThan(2500);
  });

  test('unknown currency returns null', () => {
    expect(computeLocalPrice(40, 1, 'XYZ')).toBeNull();
  });

  test('Zone 2 EUR is cheaper than Zone 1 EUR', () => {
    const z1 = computeLocalPrice(40, 1.0, 'EUR');
    const z2 = computeLocalPrice(40, 0.85, 'EUR');
    expect(z2).toBeLessThan(z1);
  });
});

describe('DEFAULT_SERVICE_TEMPLATES', () => {
  test('includes three starter services', () => {
    expect(DEFAULT_SERVICE_TEMPLATES).toHaveLength(3);
  });

  test('each has a name, duration, and base price', () => {
    for (const t of DEFAULT_SERVICE_TEMPLATES) {
      expect(t.name).toBeTruthy();
      expect(t.duration).toBeGreaterThan(0);
      expect(t.basePriceUsd).toBeGreaterThan(0);
    }
  });

  test('exactly one is highlighted as the popular pick', () => {
    const highlighted = DEFAULT_SERVICE_TEMPLATES.filter((t) => t.highlighted);
    expect(highlighted).toHaveLength(1);
  });
});

describe('DEFAULT_CMS_SERVICES', () => {
  test('includes three starter cards for the homepage', () => {
    expect(DEFAULT_CMS_SERVICES).toHaveLength(3);
  });

  test('each has the storefront-required display fields', () => {
    for (const s of DEFAULT_CMS_SERVICES) {
      expect(s.name).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(s.duration).toBeTruthy();
      expect(s.priceCaption).toBeTruthy();
      expect(Array.isArray(s.features)).toBe(true);
      expect(typeof s.highlighted).toBe('boolean');
    }
  });

  test('aligns 1:1 with DEFAULT_SERVICE_TEMPLATES so seed prices map correctly', () => {
    expect(DEFAULT_CMS_SERVICES.length).toBe(DEFAULT_SERVICE_TEMPLATES.length);
    DEFAULT_CMS_SERVICES.forEach((cms, i) => {
      expect(cms.name).toBe(DEFAULT_SERVICE_TEMPLATES[i].name);
    });
  });
});

describe('DEFAULT_CMS_TEAM', () => {
  test('includes three placeholder team members', () => {
    expect(DEFAULT_CMS_TEAM).toHaveLength(3);
  });

  test('each has name, role, bio, and showOnWebsite', () => {
    for (const m of DEFAULT_CMS_TEAM) {
      expect(m.name).toBeTruthy();
      expect(m.role).toBeTruthy();
      expect(m.bio).toBeTruthy();
      expect(m.showOnWebsite).toBe(true);
    }
  });
});
