// Backend-side bridge to the shared app theme registries.
//
// Source of truth:
//   apps/booking/lib/themeConfigs.js
//   apps/shop/lib/themeConfigs.js
//   apps/web/lib/themeConfigs.js
//
// These registries are also consumed by the frontend shells. Keeping the
// backend on the same registry removes the old manual mirror where every web
// theme had to be listed a second time.

const path = require('path');

function loadRegistry(relPath) {
  const abs = path.join(__dirname, '..', '..', '..', '..', relPath);
  try {
    return require(abs);
  } catch (error) {
    console.warn(`themeRegistry: failed to load ${relPath} - ${error.message}`);
    return {};
  }
}

const REGISTRY = Object.freeze({
  ...loadRegistry('apps/booking/lib/themeConfigs.js'),
  ...loadRegistry('apps/shop/lib/themeConfigs.js'),
  ...loadRegistry('apps/web/lib/themeConfigs.js'),
});

function getThemeConfig(themeKey) {
  if (!themeKey) return null;
  return REGISTRY[themeKey] || null;
}

function listThemeKeys() {
  return Object.keys(REGISTRY).filter((key) => !!REGISTRY[key]);
}

function getThemeVertical(themeKey) {
  const cfg = getThemeConfig(themeKey);
  if (!cfg) return null;
  const vertical = String(cfg.vertical || '').toLowerCase();
  if (vertical === 'booking' || vertical === 'appointment') return 'APPOINTMENT';
  if (vertical === 'shop' || vertical === 'ecommerce') return 'ECOMMERCE';
  if (vertical === 'web' || vertical === 'static') return 'STATIC';
  return null;
}

function pluralOf(noun, fallback) {
  if (!noun) return fallback;
  return typeof noun === 'object' ? noun.plural : `${noun}s`;
}

// Returns a flat vocab object the centralized admin sidebar/KPI cards can drop
// into label slots. Keys mirror the i18n keys used in adminNav.
function getAdminVocab(themeKey) {
  const cfg = getThemeConfig(themeKey);
  if (!cfg?.vocab) return null;
  const v = cfg.vocab;
  return {
    appointments: pluralOf(v.noun, 'Appointments'),
    services: pluralOf(v.serviceNoun, 'Services'),
    team: pluralOf(v.staffNoun, 'Team'),
    customers: pluralOf(v.customerNoun, 'Customers'),
    bookCta: v.bookCta || 'Book Now',
  };
}

// KPI labels for the admin Overview cards. The card values still come from the
// same /api/business/me stats; only the labels swap.
function getKpiLabels(themeKey) {
  const cfg = getThemeConfig(themeKey);
  const kpis = cfg?.admin?.kpis || cfg?.kpis;
  if (!Array.isArray(kpis) || kpis.length === 0) return null;
  return Object.fromEntries(kpis.map((kpi) => [kpi.key, kpi.label]));
}

function listSeedServices(themeKey) {
  const cfg = getThemeConfig(themeKey);
  return Array.isArray(cfg?.services) ? cfg.services : [];
}

// Theme-specific storefront CMS service cards. Booking themes keep services at
// top-level; web themes nest them under website.defaultContent.services.
function listCmsServices(themeKey) {
  const cfg = getThemeConfig(themeKey);
  const services = cfg?.website?.defaultContent?.services || cfg?.services;
  return Array.isArray(services) ? services : [];
}

function listCmsTeam(themeKey) {
  const cfg = getThemeConfig(themeKey);
  const team = cfg?.website?.defaultContent?.team || cfg?.team;
  return Array.isArray(team) ? team : [];
}

function listSeedIntakeFields(themeKey) {
  const cfg = getThemeConfig(themeKey);
  return Array.isArray(cfg?.intakeFields) ? cfg.intakeFields : [];
}

module.exports = {
  getThemeConfig,
  listThemeKeys,
  getThemeVertical,
  getAdminVocab,
  getKpiLabels,
  listSeedServices,
  listCmsServices,
  listCmsTeam,
  listSeedIntakeFields,
};
