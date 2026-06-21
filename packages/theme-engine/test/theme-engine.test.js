const assert = require('node:assert/strict');
const {
  THEME_MODES,
  VERTICALS,
  buildThemeManifest,
  buildBackendThemeManifest,
  composeTheme,
  createLazySlotResolver,
  createThemeRegistry,
  normalizeThemeConfig,
  resolveThemeSlot,
  resolveThemeSlots,
  validateThemeContract,
} = require('../index');
const grocery = require('../../../apps/shop/themes/grocery/config');

const lawFirm = {
  key: 'law_firm',
  label: 'Law Firm',
  vertical: 'booking',
  primaryColor: '#1E3A5F',
  vocab: {
    noun: { singular: 'Consultation', plural: 'Consultations' },
    serviceNoun: { singular: 'Practice Area', plural: 'Practice Areas' },
    staffNoun: { singular: 'Lawyer', plural: 'Lawyers' },
    customerNoun: { singular: 'Client', plural: 'Clients' },
  },
  features: { conflictCheck: true },
  admin: { panels: ['bookings', 'conflicts', 'documents'] },
};

const normalized = normalizeThemeConfig(lawFirm);
assert.equal(normalized.vertical, VERTICALS.APPOINTMENT);
assert.equal(normalized.mode, THEME_MODES.MIXED);
assert.equal(normalized.vocab.appointments, 'Consultations');
assert.equal(normalized.vocab.services, 'Practice Areas');
assert.equal(normalized.vocab.team, 'Lawyers');
assert.deepEqual(normalized.panels, ['bookings', 'conflicts', 'documents']);

const registry = createThemeRegistry({ law_firm: lawFirm, grocery: { key: 'grocery', vertical: 'shop' } });
assert.equal(registry.get('law firm').key, 'law_firm');
assert.equal(registry.byVertical('ecommerce')[0].key, 'grocery');

const slots = resolveThemeSlots({
  key: 'custom',
  vertical: 'web',
  slots: { admin: { Overview: 'theme' } },
}, {
  admin: { Overview: 'default', Settings: 'default' },
});
assert.deepEqual(slots.admin, { Overview: 'theme', Settings: 'default' });
assert.equal(resolveThemeSlot({ key: 'custom', vertical: 'web', slots: { admin: { Overview: 'theme' } } }, 'admin', 'Overview'), 'theme');

const mixed = composeTheme(
  { key: 'base', vertical: 'web', features: { blog: true }, slots: { storefront: { home: 'base/Home' } } },
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

const manifest = buildThemeManifest({ law_firm: lawFirm });
assert.equal(manifest[0].key, 'law_firm');
assert.equal(manifest[0].features.conflictCheck, true);
assert.equal(Object.prototype.hasOwnProperty.call(manifest[0], 'slots'), false);
assert.equal(buildThemeManifest({ grocery }, { includeSlots: true })[0].slots.storefront.checkout, 'themes/grocery/public/CheckoutPage');
assert.equal(buildBackendThemeManifest({ law_firm: lawFirm })[0].vertical, VERTICALS.APPOINTMENT);

assert.equal(validateThemeContract(lawFirm).valid, true);

const normalizedGrocery = normalizeThemeConfig(grocery);
assert.equal(normalizedGrocery.key, 'grocery');
assert.equal(normalizedGrocery.vertical, VERTICALS.ECOMMERCE);
assert.equal(normalizedGrocery.mode, THEME_MODES.BESPOKE);
assert.equal(normalizedGrocery.palette.primary, '#16A34A');
assert.equal(normalizedGrocery.slots.storefront.checkout, 'themes/grocery/public/CheckoutPage');

// — Robustness: a config with no slots and no admin panels infers GENERIC mode.
const plain = normalizeThemeConfig({ key: 'plain', vertical: 'web', primaryColor: '#ffffff' });
assert.equal(plain.mode, THEME_MODES.GENERIC);

// — Robustness: an invalid contract is rejected (a theme cannot extend itself).
const selfExtend = validateThemeContract({ key: 'loop', vertical: 'web', extends: 'loop' });
assert.equal(selfExtend.valid, false);
assert.ok(selfExtend.errors.some((e) => /extend itself/.test(e)));

// — Robustness: REPLACE inheritance ignores the base instead of merging it.
const replaced = composeTheme(
  { key: 'base', vertical: 'web', features: { blog: true } },
  { key: 'child', inheritance: 'replace', features: { booking: true } },
);
assert.equal(replaced.inheritance, 'replace');
assert.deepEqual(replaced.features, { booking: true }); // base.blog dropped under replace

console.log('theme-engine tests passed');
