'use strict';

// Self-serve HR add-on purchase (Settings › Billing → Add-ons). A sellable add-on
// (owner decision: "any plan can buy") that stacks on top of the tenant's base
// plan. Talent Acquisition is the first.
//
// Billing model: per-gateway STANDALONE add-on subscriptions (Stripe NZ /
// Razorpay IN) are a prod follow-up — the current gateway machinery is one
// subscription per business. Until add-on gateway prices are provisioned, a
// tenant with billing access self-enables the add-on as a time-boxed TRIAL so
// the module works end-to-end immediately; the entitlement resolver already
// honours Business.featureFlags.addOns[key]. When add-on gateway prices exist,
// this endpoint returns a checkoutUrl instead (see TODO).

const prisma = require('../lib/prisma');
const { hrEntitlements, HR_ADDON_KEYS } = require('../lib/entitlements');
const { billingAccessState } = require('../lib/billingAccess');
const { writeAudit } = require('../lib/audit');

// Sellable add-on catalog (display + indicative pricing). Pricing is presentment
// only until gateway add-on prices are wired.
const ADDON_CATALOG = {
  talent_acquisition: {
    key: 'talent_acquisition',
    name: 'Talent Acquisition',
    blurb: 'Post jobs on your careers page, screen + score candidates objectively, run interviews, and hire straight into onboarding.',
    price: { INR: '₹1,499/mo', NZD: 'NZ$29/mo', USD: '$19/mo' },
  },
};
const ADDON_TRIAL_DAYS = 14;

// GET /api/subscription/add-ons — the sellable add-on list + this tenant's status.
async function listAddOns(req, res, next) {
  try {
    const businessId = req.user.businessId;
    const ents = businessId ? await hrEntitlements(businessId) : {};
    const addOns = Object.values(ADDON_CATALOG).map((a) => ({
      key: a.key,
      name: a.name,
      blurb: a.blurb,
      price: a.price,
      enabled: !!(ents[a.key] && ents[a.key].enabled),
      source: (ents[a.key] && ents[a.key].source) || null,
    }));
    res.json({ addOns });
  } catch (e) { next(e); }
}

// POST /api/subscription/add-ons/:key/subscribe — self-serve enable.
async function subscribeAddOn(req, res, next) {
  try {
    const key = String(req.params.key || '');
    if (!HR_ADDON_KEYS.includes(key) || !ADDON_CATALOG[key]) {
      return res.status(422).json({ message: `Unknown add-on: ${key}` });
    }
    const businessId = req.user.businessId;
    if (!businessId) return res.status(400).json({ message: 'Set up your business first.' });

    const ents = await hrEntitlements(businessId);
    if (ents[key] && ents[key].enabled) return res.json({ status: 'already_active', entitlements: ents });

    // Require baseline billing access (freemium: a Free-tier tenant qualifies).
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { featureFlags: true, subscription: { include: { tier: true } } },
    });
    const access = billingAccessState(business);
    if (access.state !== 'active' && access.state !== 'grace') {
      return res.status(402).json({ code: 'billing_access_required', message: 'Activate your account before adding modules.' });
    }

    // TODO(prod): when a per-gateway add-on price exists, create a standalone
    // gateway subscription here and return { checkoutUrl }. Until then, grant a
    // self-serve time-boxed trial so the module is usable immediately.
    const flags = (business.featureFlags && typeof business.featureFlags === 'object') ? business.featureFlags : {};
    const addOns = (flags.addOns && typeof flags.addOns === 'object') ? { ...flags.addOns } : {};
    const addOnTrials = (flags.addOnTrials && typeof flags.addOnTrials === 'object') ? { ...flags.addOnTrials } : {};
    addOns[key] = true;
    addOnTrials[key] = new Date(Date.now() + ADDON_TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await prisma.business.update({ where: { id: businessId }, data: { featureFlags: { ...flags, addOns, addOnTrials } } });

    try {
      await writeAudit({ businessId, actorId: req.user.id, action: 'addon.self_enable_trial', entityType: 'Business', entityId: businessId, meta: { key, trialDays: ADDON_TRIAL_DAYS } });
    } catch { /* best-effort */ }

    res.json({ status: 'trial_started', trialDays: ADDON_TRIAL_DAYS, entitlements: await hrEntitlements(businessId) });
  } catch (e) { next(e); }
}

module.exports = { listAddOns, subscribeAddOn };
