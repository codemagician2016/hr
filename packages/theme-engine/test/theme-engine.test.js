const assert = require('node:assert/strict');
const {
  THEME_MODES,
  THEME_INHERITANCE_MODES,
  HR_VERTICAL,
  DEFAULT_STYLE_KEY,
  FIXED_STYLE_KEYS,
  FIXED_STYLE_SEEDS,
  hrStyleRegistry,
  createHrStyleRegistry,
  normalizeStyleKey,
  resolveTenantTheme,
  resolveColor,
  DEFAULT_COLOR_KEY,
  COLOR_KEYS,
  buildThemeManifest,
  buildBackendThemeManifest,
  composeTheme,
  createLazySlotResolver,
  createThemeRegistry,
  normalizeThemeConfig,
  normalizeVertical,
  resolveThemeSlot,
  resolveThemeSlots,
  validateThemeContract,
} = require('../index');

// ── Engine: every theme collapses to the single HR vertical ─────────────────
assert.equal(normalizeVertical('booking'), HR_VERTICAL);
assert.equal(normalizeVertical('anything'), HR_VERTICAL);
assert.equal(normalizeVertical(), HR_VERTICAL);

// ── Engine: vocab + palette + panels normalization still works ──────────────
const sample = {
  key: 'sample',
  label: 'Sample',
  primaryColor: '#1E3A5F',
  vocab: {
    noun: { singular: 'Consultation', plural: 'Consultations' },
    staffNoun: { singular: 'Lawyer', plural: 'Lawyers' },
  },
  features: { someFlag: true },
  admin: { panels: ['overview', 'reports'] },
};
const normalized = normalizeThemeConfig(sample);
assert.equal(normalized.vertical, HR_VERTICAL);
assert.equal(normalized.palette.primary, '#1E3A5F');
assert.equal(normalized.vocab.appointments, 'Consultations');
assert.equal(normalized.vocab.team, 'Lawyers');
assert.deepEqual(normalized.panels, ['overview', 'reports']);
// panels present → MIXED is inferred (engine retained)
assert.equal(normalized.mode, THEME_MODES.MIXED);

// ── Engine: a plain config with no slots/panels infers GENERIC ──────────────
const plain = normalizeThemeConfig({ key: 'plain', primaryColor: '#ffffff' });
assert.equal(plain.mode, THEME_MODES.GENERIC);

// ── Engine: generic registry, compose, slots, lazy resolver ─────────────────
const registry = createThemeRegistry({ a: { key: 'a' }, b: { key: 'b' } });
assert.equal(registry.get('a').key, 'a');
assert.equal(registry.size(), 2);
// all entries share the HR vertical now
assert.equal(registry.byVertical('HR').length, 2);

const slots = resolveThemeSlots(
  { key: 'custom', slots: { admin: { Overview: 'theme' } } },
  { admin: { Overview: 'default', Settings: 'default' } }
);
assert.deepEqual(slots.admin, { Overview: 'theme', Settings: 'default' });
assert.equal(
  resolveThemeSlot({ key: 'custom', slots: { admin: { Overview: 'theme' } } }, 'admin', 'Overview'),
  'theme'
);

const mixed = composeTheme(
  { key: 'base', features: { blog: true }, slots: { storefront: { home: 'base/Home' } } },
  { key: 'child', extends: 'base', features: { booking: true }, slots: { storefront: { contact: 'child/Contact' } } }
);
assert.equal(mixed.extends, 'base');
assert.equal(mixed.inheritance, 'merge');
assert.deepEqual(mixed.features, { blog: true, booking: true });
assert.equal(mixed.slots.storefront.home, 'base/Home');
assert.equal(mixed.slots.storefront.contact, 'child/Contact');

const lazySlot = createLazySlotResolver({
  importers: { 'base/Home': () => Promise.resolve('home') },
});
assert.equal(typeof lazySlot(mixed, 'storefront', 'home'), 'function');

// ── Engine: REPLACE inheritance drops the base ──────────────────────────────
const replaced = composeTheme(
  { key: 'base', features: { blog: true } },
  { key: 'child', inheritance: 'replace', features: { booking: true } }
);
assert.equal(replaced.inheritance, 'replace');
assert.deepEqual(replaced.features, { booking: true });

// ── Engine: validation ──────────────────────────────────────────────────────
assert.equal(validateThemeContract(sample).valid, true);
const selfExtend = validateThemeContract({ key: 'loop', extends: 'loop' });
assert.equal(selfExtend.valid, false);
assert.ok(selfExtend.errors.some((e) => /extend itself/.test(e)));

// ── Engine: manifests ───────────────────────────────────────────────────────
const manifest = buildThemeManifest({ sample });
assert.equal(manifest[0].key, 'sample');
assert.equal(manifest[0].features.someFlag, true);
assert.equal(Object.prototype.hasOwnProperty.call(manifest[0], 'slots'), false);
assert.equal(buildBackendThemeManifest({ sample })[0].vertical, HR_VERTICAL);

// ── HR fixed styles: exactly 5 ──────────────────────────────────────────────
assert.deepEqual([...FIXED_STYLE_KEYS], ['slate', 'indigo', 'emerald', 'rose', 'mono']);
assert.equal(Object.keys(FIXED_STYLE_SEEDS).length, 5);
assert.equal(hrStyleRegistry.size(), 5);
assert.equal(createHrStyleRegistry().size(), 5);
assert.equal(DEFAULT_STYLE_KEY, 'slate');
for (const key of FIXED_STYLE_KEYS) {
  const theme = hrStyleRegistry.get(key);
  assert.equal(theme.key, key);
  assert.equal(theme.vertical, HR_VERTICAL);
  assert.equal(theme.mode, THEME_MODES.GENERIC);
  assert.ok(theme.palette.primary, `${key} has a base primary`);
  assert.equal(validateThemeContract(FIXED_STYLE_SEEDS[key]).valid, true);
}

// ── HR fixed styles: style-key coercion ─────────────────────────────────────
assert.equal(normalizeStyleKey('indigo'), 'indigo');
assert.equal(normalizeStyleKey('Indigo'), 'indigo');
assert.equal(normalizeStyleKey('does-not-exist'), DEFAULT_STYLE_KEY);
assert.equal(normalizeStyleKey(undefined), DEFAULT_STYLE_KEY);

// ── HR tenant resolution: style + brand color + logo ────────────────────────
const tenant = resolveTenantTheme({ styleKey: 'emerald', primary: '#FF6600', logoUrl: 'https://cdn/acme.png' });
assert.equal(tenant.styleKey, 'emerald');
assert.equal(tenant.key, 'emerald');
assert.equal(tenant.vertical, HR_VERTICAL);
assert.equal(tenant.palette.primary, '#FF6600'); // brand color overrides the base
assert.equal(tenant.logoUrl, 'https://cdn/acme.png');

// brand color via palette.primary alias also works
const aliased = resolveTenantTheme({ styleKey: 'rose', palette: { primary: '#123456' } });
assert.equal(aliased.palette.primary, '#123456');

// no brand color → falls back to the DEFAULT_COLOR_KEY brand color
// (white-label model: tenant always has a brand color; default is 'indigo').
const bare = resolveTenantTheme({ styleKey: 'mono' });
assert.equal(bare.palette.primary, resolveColor(DEFAULT_COLOR_KEY));
assert.equal(bare.colorKey, DEFAULT_COLOR_KEY);
assert.equal(bare.logoUrl, null);

// curated colorKey resolves via COLORS and takes precedence over raw primary
const branded = resolveTenantTheme({ styleKey: 'slate', colorKey: 'teal', primary: '#000000' });
assert.equal(branded.palette.primary, resolveColor('teal'));
assert.equal(branded.colorKey, 'teal');
assert.equal(COLOR_KEYS.length, 12);

// unknown style → default
const fallback = resolveTenantTheme({ styleKey: 'nope', primary: '#000000' });
assert.equal(fallback.styleKey, DEFAULT_STYLE_KEY);

// empty input → fully defaulted theme
const empty = resolveTenantTheme();
assert.equal(empty.styleKey, DEFAULT_STYLE_KEY);
assert.equal(empty.vertical, HR_VERTICAL);

// keep an explicit reference to the inheritance enum (used above implicitly)
assert.ok(THEME_INHERITANCE_MODES.MERGE);

console.log('theme-engine tests passed');
