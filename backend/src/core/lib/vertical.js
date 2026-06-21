// Single source of truth for the default vertical. Sitepresso runs three
// products on one platform — STATIC / APPOINTMENT / ECOMMERCE — and a lot
// of code reads `business.vertical` with a fallback for legacy tenants
// (created before the column existed). Centralising the constant + helper
// here means the back-compat default lives in one place.
//
// Mirror copies live at platform/lib/vertical.js and business/lib/vertical.js
// because vertical isolation forbids cross-app imports. Update all three
// when the default changes.
'use strict';

const DEFAULT_VERTICAL = 'APPOINTMENT';
const VALID_VERTICALS = new Set(['STATIC', 'APPOINTMENT', 'ECOMMERCE']);

function resolveVertical(value) {
  if (typeof value === 'string') {
    const upper = value.toUpperCase();
    if (VALID_VERTICALS.has(upper)) return upper;
  }
  return DEFAULT_VERTICAL;
}

module.exports = { DEFAULT_VERTICAL, VALID_VERTICALS, resolveVertical };
