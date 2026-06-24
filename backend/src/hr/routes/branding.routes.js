'use strict';

// White-label Branding settings (HR) — mounted at /api/hr/branding.
//
// Tenant-scoped (req.user.businessId) self-service brand: logo, favicon, colours,
// display name, support/email-from. Gated on ANY of canEditDomain /
// canManageCompanyProfile / canEditBranding (Owner/SUPER_ADMIN bypass), so the
// same operators who manage the company profile or the domain can also brand the
// portal. The server is the enforcement boundary; the page hides controls when
// the operator lacks the keys.

const express = require('express');
const router = express.Router();
const { protect } = require('../../core/middleware/auth.middleware');
const { ROLES } = require('../../core/lib/roles');
const { effectivePermissions } = require('../../core/lib/rbac');
const c = require('../controllers/branding.controller');

// OR-gate: pass if the operator holds ANY of the listed permission keys, or is a
// SUPER_ADMIN. There is no built-in requireAnyPermission, so inline it here.
const BRANDING_KEYS = ['canEditBranding', 'canEditDomain', 'canManageCompanyProfile'];
function requireBrandingAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
  if (req.user.role === ROLES.SUPER_ADMIN) return next();
  const perms = effectivePermissions(req.user) || {};
  if (BRANDING_KEYS.some((k) => perms[k])) return next();
  return res.status(403).json({
    message: 'Forbidden: missing branding permission',
    anyOf: BRANDING_KEYS,
  });
}

router.use(protect);

router.get('/', requireBrandingAccess, c.getBranding);
router.put('/', requireBrandingAccess, c.updateBranding);
router.post('/asset', requireBrandingAccess, c.uploadAsset);

module.exports = router;
