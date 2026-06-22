'use strict';

/**
 * complianceRegistry.js — resolves the country compliance module.
 *
 * Per docs/04 §0.1 and §9: the core routes by the registered module's `country`
 * and NEVER name-checks "IN"/"NZ" in business logic. Modules are *registered*,
 * not imported by name, so RoW can be added without touching the engine.
 *
 * This module is dependency-light and pure aside from the in-memory registry
 * (no DB, no I/O). Country modules are PURE and self-contained (no import from
 * core), each exporting:
 *   { country: 'IN'|'NZ', rules:{ effectiveFrom }, compute(...) }
 *
 * Effective-dating: a module may register multiple versions (each with its own
 * rules.effectiveFrom). resolveComplianceModule picks the latest version whose
 * effectiveFrom <= effectiveDate. This mirrors the rule-version pin (§10).
 */

// country -> [{ effectiveFrom: 'YYYY-MM-DD', module }] sorted desc by date.
const REGISTRY = new Map();

/** Validate a module satisfies the ComplianceModule contract shape. */
function assertModuleShape(mod) {
  if (!mod || typeof mod !== 'object') {
    throw new TypeError('registerComplianceModule: module must be an object');
  }
  if (typeof mod.country !== 'string' || !/^[A-Z]{2}$/.test(mod.country)) {
    throw new TypeError('registerComplianceModule: module.country must be an ISO-3166 alpha-2 code');
  }
  if (typeof mod.compute !== 'function') {
    throw new TypeError(`registerComplianceModule: module ${mod.country} must export compute()`);
  }
  const eff = mod.rules && mod.rules.effectiveFrom;
  if (eff != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(eff))) {
    throw new TypeError(
      `registerComplianceModule: module ${mod.country} rules.effectiveFrom must be YYYY-MM-DD`
    );
  }
  return eff || '0000-01-01';
}

/**
 * Register (or replace) a compliance module version.
 * Idempotent for a given (country, effectiveFrom): re-registering replaces it.
 */
function registerComplianceModule(mod) {
  const effectiveFrom = assertModuleShape(mod);
  const country = mod.country;
  const list = REGISTRY.get(country) || [];
  const without = list.filter((v) => v.effectiveFrom !== effectiveFrom);
  without.push({ effectiveFrom, module: mod });
  without.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1)); // desc
  REGISTRY.set(country, without);
  return mod;
}

/**
 * Resolve the active compliance module for a country at an effective date.
 *
 * @param {string} countryCode  e.g. entity.countryCode ('IN' | 'NZ')
 * @param {string|Date} [effectiveDate]  YYYY-MM-DD or Date; defaults to latest
 * @returns the matching module
 * @throws if no module is registered for the country, or none is effective yet
 */
function resolveComplianceModule(countryCode, effectiveDate) {
  if (typeof countryCode !== 'string' || !/^[A-Z]{2}$/.test(countryCode)) {
    throw new TypeError(`resolveComplianceModule: invalid countryCode "${countryCode}"`);
  }
  const versions = REGISTRY.get(countryCode);
  if (!versions || versions.length === 0) {
    throw new Error(`No compliance module registered for country "${countryCode}"`);
  }
  if (effectiveDate == null) {
    return versions[0].module; // latest
  }
  const eff = normalizeDate(effectiveDate);
  for (const v of versions) {
    if (v.effectiveFrom <= eff) return v.module;
  }
  throw new Error(
    `No compliance module for "${countryCode}" effective on/before ${eff} ` +
      `(earliest is ${versions[versions.length - 1].effectiveFrom})`
  );
}

/** Is a module registered for this country? */
function hasComplianceModule(countryCode) {
  return REGISTRY.has(countryCode) && REGISTRY.get(countryCode).length > 0;
}

/** List registered (country, effectiveFrom) pairs — for diagnostics. */
function listRegistered() {
  const out = [];
  for (const [country, versions] of REGISTRY.entries()) {
    for (const v of versions) out.push({ country, effectiveFrom: v.effectiveFrom });
  }
  return out;
}

/** Clear the registry (test isolation only). */
function _resetRegistry() {
  REGISTRY.clear();
}

function normalizeDate(d) {
  if (d instanceof Date) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const s = String(d);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (!m) throw new TypeError(`resolveComplianceModule: invalid effectiveDate "${d}"`);
  return m[1];
}

module.exports = {
  registerComplianceModule,
  resolveComplianceModule,
  hasComplianceModule,
  listRegistered,
  _resetRegistry,
};
