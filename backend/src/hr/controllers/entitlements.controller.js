'use strict';

// HR add-on entitlements — the tenant's purchasable-module map (nav + BillingTab)
// plus a super-admin grant/revoke lever. The canonical entitlement resolution lives
// in core/lib/entitlements.js; this exposes it to the HR surface.

const prisma = require('../../core/lib/prisma');
const { hrEntitlements, HR_ADDON_KEYS } = require('../../core/lib/entitlements');
const { writeAudit } = require('../../core/lib/audit');

// GET /api/hr/entitlements — { entitlements: { talent_acquisition: {enabled, source} } }
async function listEntitlements(req, res, next) {
  try {
    res.json({ entitlements: await hrEntitlements(req.user.businessId) });
  } catch (e) { next(e); }
}

// Set Business.featureFlags.addOns.<key> (merge-safe).
async function setAddOn(businessId, key, on) {
  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { featureFlags: true } });
  const flags = (biz && biz.featureFlags && typeof biz.featureFlags === 'object') ? biz.featureFlags : {};
  const addOns = (flags.addOns && typeof flags.addOns === 'object') ? { ...flags.addOns } : {};
  addOns[key] = !!on;
  await prisma.business.update({ where: { id: businessId }, data: { featureFlags: { ...flags, addOns } } });
}

// POST /api/hr/entitlements/:key/grant  (super-admin) — comp / trial / manual grant.
// The real purchase path is the Paddle add-on checkout; this is the manageable lever
// until price refs are configured. Body: { businessId?, enabled? (default true) }.
async function grantAddOn(req, res, next) {
  try {
    const key = String(req.params.key || '');
    if (!HR_ADDON_KEYS.includes(key)) return res.status(422).json({ message: `Unknown add-on: ${key}` });
    const businessId = (req.body && req.body.businessId) || req.user.businessId;
    const on = !(req.body && req.body.enabled === false);
    await setAddOn(businessId, key, on);
    await writeAudit({
      businessId, actorId: req.user.id, action: on ? 'addon.grant' : 'addon.revoke',
      entityType: 'Business', entityId: businessId, meta: { key },
    });
    res.json({ entitlements: await hrEntitlements(businessId) });
  } catch (e) { next(e); }
}

module.exports = { listEntitlements, grantAddOn };
