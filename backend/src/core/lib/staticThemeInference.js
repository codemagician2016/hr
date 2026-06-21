const STATIC_SIGNAL_OVERRIDE_THEMES = new Set([
  'barber',
  'barber_shop',
  'barbershop',
  'default',
  'general_practice',
  'other',
]);

function normalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasWord(signals, word) {
  const normalized = normalize(word);
  if (!normalized) return false;
  if (!normalized.includes(' ')) {
    return new RegExp(`(^| )${normalized}( |$)`).test(signals);
  }
  return signals === normalized || signals.includes(normalized);
}

function hasAnyWord(signals, words) {
  return words.some((word) => hasWord(signals, word));
}

function inferStaticThemeFromBusinessSignals(business = {}) {
  const vertical = String(business.vertical || '').toUpperCase();
  if (vertical && vertical !== 'STATIC') return null;

  const signals = normalize([
    business.name,
    business.slug,
    business.category,
    business.profession,
    business.description,
  ].filter(Boolean).join(' '));
  if (!signals) return null;

  if (
    hasAnyWord(signals, ['math', 'maths', 'mathematics', 'algebra', 'geometry', 'calculus'])
    || /(^| )math[0-9]+( |$)/.test(signals)
  ) {
    return 'math_tutor';
  }
  if (hasAnyWord(signals, ['science', 'physics', 'chemistry', 'biology'])) return 'science_tutor';
  if (hasAnyWord(signals, ['ielts', 'pte'])) return 'ielts_pte_training';
  if (hasWord(signals, 'english')) return 'english_tutor';
  if (hasAnyWord(signals, ['online tutor', 'online tuition'])) return 'online_tutor';
  if (hasAnyWord(signals, ['tuition', 'tutor'])) return 'tutor';

  return null;
}

function canStaticSignalOverride(theme) {
  if (!theme) return true;
  return STATIC_SIGNAL_OVERRIDE_THEMES.has(String(theme).toLowerCase());
}

function resolveStaticThemeFromBusinessSignals({ theme, fallbackTheme, business } = {}) {
  const inferredTheme = inferStaticThemeFromBusinessSignals(business);
  if (inferredTheme && canStaticSignalOverride(theme)) return inferredTheme;
  return theme || fallbackTheme || inferredTheme || 'other';
}

module.exports = {
  STATIC_SIGNAL_OVERRIDE_THEMES,
  inferStaticThemeFromBusinessSignals,
  resolveStaticThemeFromBusinessSignals,
};
