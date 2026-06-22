const THEME_CONTRACT_VERSION = 1;

const VERTICALS = Object.freeze({
  HR: 'HR',
  APPOINTMENT: 'APPOINTMENT',
  ECOMMERCE: 'ECOMMERCE',
  STATIC: 'STATIC',
});

const THEME_MODES = Object.freeze({
  GENERIC: 'generic',
  MIXED: 'mixed',
  BESPOKE: 'bespoke',
});

const THEME_INHERITANCE_MODES = Object.freeze({
  MERGE: 'merge',
  REPLACE: 'replace',
});

const SLOT_GROUPS = Object.freeze({
  ADMIN: 'admin',
  STOREFRONT: 'storefront',
  CUSTOMER: 'customer',
  STAFF: 'staff',
});

const APP_SURFACES = Object.freeze({
  ADMIN: 'admin',
  STOREFRONT: 'storefront',
  CUSTOMER: 'customer',
  STAFF: 'staff',
});

const ADMIN_SURFACE_MODEL = Object.freeze({
  CANONICAL_APP: 'apps/platform',
  CANONICAL_ROUTE: '/dashboard',
});

module.exports = {
  THEME_CONTRACT_VERSION,
  VERTICALS,
  THEME_MODES,
  THEME_INHERITANCE_MODES,
  SLOT_GROUPS,
  APP_SURFACES,
  ADMIN_SURFACE_MODEL,
};
