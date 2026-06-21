const { catalogForVertical, effectiveEnabled, featureAppliesToVertical } = require('../src/core/lib/featuresCatalog');

describe('features catalog gates', () => {
  test('plan gate blocks paid features even when admin override is true', () => {
    expect(effectiveEnabled({
      catalogDefault: true,
      tierOverride: true,
      adminOverride: true,
      planAllowed: false,
    })).toBe(false);
  });

  test('admin override can enable live features when the plan allows them', () => {
    expect(effectiveEnabled({
      catalogDefault: false,
      tierOverride: false,
      adminOverride: true,
      planAllowed: true,
      rolloutStatus: 'LIVE',
    })).toBe(true);
  });

  test('non-live rollout blocks a feature even when defaults and admin override are true', () => {
    expect(effectiveEnabled({
      catalogDefault: true,
      tierOverride: true,
      adminOverride: true,
      planAllowed: true,
      rolloutStatus: 'FOUNDATION',
    })).toBe(false);
  });

  test('grocery feature panel excludes generic blog toggles', () => {
    const catalog = catalogForVertical('ECOMMERCE');
    expect(catalog.blogEnabled).toBeUndefined();
    expect(catalog.blogCommentsEnabled).toBeUndefined();
    expect(catalog.buyAgain).toBeTruthy();
  });

  test('blog features still apply outside ecommerce', () => {
    expect(featureAppliesToVertical({ vertical: 'ALL', excludeVerticals: ['ECOMMERCE'] }, 'APPOINTMENT')).toBe(true);
    expect(featureAppliesToVertical({ vertical: 'ALL', excludeVerticals: ['ECOMMERCE'] }, 'ECOMMERCE')).toBe(false);
  });
});
