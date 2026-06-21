const {
  inferStaticThemeFromBusinessSignals,
  resolveStaticThemeFromBusinessSignals,
} = require('../src/core/lib/staticThemeInference');

describe('static theme inference', () => {
  test('infers math tutor for math-branded draft static sites', () => {
    expect(inferStaticThemeFromBusinessSignals({
      name: 'math10',
      slug: 'math10',
      vertical: 'STATIC',
    })).toBe('math_tutor');
  });

  test('allows math signals to replace accidental placeholder static themes', () => {
    expect(resolveStaticThemeFromBusinessSignals({
      theme: 'barber',
      business: {
        name: 'math10',
        slug: 'math10',
        vertical: 'STATIC',
      },
    })).toBe('math_tutor');
  });

  test('does not override an intentional non-placeholder static theme', () => {
    expect(resolveStaticThemeFromBusinessSignals({
      theme: 'restaurant',
      business: {
        name: 'Maths Cafe',
        slug: 'maths-cafe',
        vertical: 'STATIC',
      },
    })).toBe('restaurant');
  });

  test('does not infer from non-static verticals', () => {
    expect(inferStaticThemeFromBusinessSignals({
      name: 'math10',
      slug: 'math10',
      vertical: 'APPOINTMENT',
    })).toBeNull();
  });
});
