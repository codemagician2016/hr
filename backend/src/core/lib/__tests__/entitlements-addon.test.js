'use strict';

/*
 * entitlements-addon.test.js — PURE test of the sellable ADD-ON resolution in
 * booleanEntitlement (Talent Acquisition). Injects fakes for prisma + billingAccess
 * via require.cache so no DB is needed.
 *
 *   node backend/src/core/lib/__tests__/entitlements-addon.test.js
 *
 * Proves: an add-on is granted by EITHER a manual featureFlags.addOns.<key> grant OR
 * an active per-product add-on subscription — self-standing (works even on an expired
 * base plan) — while a TIER-based grant still requires the base plan to be current.
 */

const path = require('path');

const libDir = path.join(__dirname, '..');
function inject(rel, exportsObj) {
  const abs = require.resolve(path.join(libDir, rel));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj };
}

const state = { subscription: null, featureFlags: null, addOnSub: null, accessState: 'active' };
inject('prisma', {
  subscription: { findUnique: async () => state.subscription },
  business: { findUnique: async () => ({ featureFlags: state.featureFlags }) },
  paddleBillingSubscription: { findFirst: async () => state.addOnSub },
});
inject('billingAccess', { billingAccessState: () => ({ state: state.accessState }) });
inject('featuresCatalog', { isPaidTier: () => false });
inject('launchPeriod', { launchFreePlanGrantsAllowed: () => false });

const { booleanEntitlement } = require('../entitlements');

let passed = 0; let failed = 0;
function check(name, cond) { if (cond) { passed += 1; } else { failed += 1; console.error('FAIL ', name); } }
const KEY = 'talent_acquisition';

(async () => {
  // 1) manual featureFlags grant works even on an EXPIRED base plan (self-standing).
  state.subscription = { tier: { slug: 'free', tierFeatures: [] } };
  state.featureFlags = { addOns: { talent_acquisition: true } };
  state.addOnSub = null; state.accessState = 'expired';
  check('featureFlags grant enables the add-on on an expired base plan', (await booleanEntitlement('b', KEY)).enabled === true);

  // 2) an active per-product add-on subscription enables it (also self-standing).
  state.featureFlags = null; state.addOnSub = { id: 'x' }; state.accessState = 'expired';
  const r2 = await booleanEntitlement('b', KEY);
  check('active TALENT sub enables the add-on', r2.enabled === true);
  check('source reflects add_on grant', r2.source === 'add_on');

  // 3) no grant + tier without the feature → disabled.
  state.addOnSub = null; state.featureFlags = null;
  state.subscription = { tier: { slug: 'starter', tierFeatures: [] } }; state.accessState = 'active';
  check('no grant → disabled', (await booleanEntitlement('b', KEY)).enabled === false);

  // 4) Enterprise TIER feature true + active base → enabled.
  state.subscription = { tier: { slug: 'enterprise', tierFeatures: [{ featureKey: 'talent_acquisition', featureType: 'BOOLEAN', featureValue: 'true' }] } };
  state.accessState = 'active';
  check('enterprise tier feature enables (base active)', (await booleanEntitlement('b', KEY)).enabled === true);

  // 5) TIER grant is gated by base-plan access — expired base → disabled.
  state.accessState = 'expired';
  check('tier grant blocked when the base plan is expired', (await booleanEntitlement('b', KEY)).enabled === false);

  // 6) a NON-add-on key is unaffected (no featureFlags/sub OR-in).
  state.subscription = { tier: { slug: 'free', tierFeatures: [] } };
  state.featureFlags = { addOns: { talent_acquisition: true } }; state.addOnSub = { id: 'x' }; state.accessState = 'active';
  check('non-add-on key (payrollEngine) is not add-on-granted', (await booleanEntitlement('b', 'payrollEngine')).enabled === false);

  console.log(`\nentitlements-addon test: ${passed} passed, ${failed} failed of ${passed + failed} assertions.`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error('crashed', e); process.exitCode = 1; });
