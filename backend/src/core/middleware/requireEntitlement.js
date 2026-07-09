'use strict';

const { assertBooleanFeature } = require('../lib/entitlements');

// Express middleware: gate a route behind a BOOLEAN entitlement — a plan feature or
// a purchasable ADD-ON (e.g. talent_acquisition). Runs AFTER an auth middleware that
// sets req.user.businessId, and BEFORE the RBAC (requirePermission) gates, so the
// two concerns stay orthogonal: entitlement = WHETHER the tenant's plan includes the
// module; RBAC = WHO inside the tenant may use it. Turns the engine's throws into a
// clean 402 (needs billing) / 403 (not in plan) with a code the UI can branch on.
function requireEntitlement(key, label) {
  return async function entitlementGate(req, res, next) {
    try {
      const businessId = req.user && req.user.businessId;
      if (!businessId) return res.status(401).json({ message: 'Authentication required' });
      await assertBooleanFeature({ businessId, key, label: label || 'This feature' });
      return next();
    } catch (e) {
      if (e && (e.status === 402 || e.status === 403)) {
        return res.status(e.status).json({ message: e.message, code: e.code, entitlement: e.entitlement });
      }
      return next(e);
    }
  };
}

module.exports = { requireEntitlement };
