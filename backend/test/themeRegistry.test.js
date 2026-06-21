const {
  getAdminVocab,
  getThemeVertical,
  listThemeKeys,
} = require('../src/core/lib/themeRegistry');

describe('themeRegistry vertical mapping', () => {
  test('classifies appointment, ecommerce, and static themes', () => {
    expect(getThemeVertical('law_firm')).toBe('APPOINTMENT');
    expect(getThemeVertical('grocery')).toBe('ECOMMERCE');
    expect(getThemeVertical('nail_salon')).toBe('STATIC');
  });

  test('includes static web themes in the backend theme allow-list source', () => {
    const keys = listThemeKeys();
    expect(keys).toContain('corporate');
    expect(keys).toContain('nail_salon');
    expect(keys).toContain('it_services');
  });

  test('unknown themes are not assigned a vertical', () => {
    expect(getThemeVertical('not_a_theme')).toBeNull();
    expect(getThemeVertical('')).toBeNull();
  });

  test('restaurant admin vocabulary stays hospitality-specific', () => {
    expect(getAdminVocab('restaurant_reservations')).toEqual(expect.objectContaining({
      appointments: 'Reservations',
      services: 'Dining Sessions',
      team: 'Hosts',
      customers: 'Guests',
      bookCta: 'Reserve a Table',
    }));
  });
});
