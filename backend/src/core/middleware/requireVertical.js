const prisma = require('../lib/prisma');
const { resolveVertical } = require('../lib/vertical');

function requireVertical(...allowedVerticals) {
  const allowed = new Set(allowedVerticals.map((v) => String(v || '').toUpperCase()));
  return async function requireVerticalMiddleware(req, res, next) {
    try {
      const businessId = req.user?.businessId;
      if (!businessId) {
        return res.status(400).json({ message: 'You must set up your business first' });
      }
      const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: { vertical: true },
      });
      const vertical = resolveVertical(business?.vertical);
      if (!allowed.has(vertical)) {
        return res.status(404).json({ message: 'This feature is not available for this business vertical' });
      }
      req.businessVertical = vertical;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

function requireUserBusinessVertical(...allowedVerticals) {
  const allowed = new Set(allowedVerticals.map((v) => String(v || '').toUpperCase()));
  return async function requireUserBusinessVerticalMiddleware(req, res, next) {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ message: 'Not authenticated' });
      }
      if (user.role === 'SUPER_ADMIN') {
        return next();
      }
      const businessId = user.businessId;
      if (!businessId) {
        return next();
      }
      const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: { vertical: true },
      });
      const vertical = resolveVertical(business?.vertical);
      if (!allowed.has(vertical)) {
        return res.status(404).json({ message: 'This feature is not available for this business vertical' });
      }
      req.businessVertical = vertical;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

function requireStorefrontVertical(...allowedVerticals) {
  const allowed = new Set(allowedVerticals.map((v) => String(v || '').toUpperCase()));
  return async function requireStorefrontVerticalMiddleware(req, res, next) {
    try {
      const slug = String(req.params?.slug || '').trim().toLowerCase();
      if (!slug) {
        return res.status(400).json({ message: 'Business slug is required' });
      }
      const business = await prisma.business.findUnique({
        where: { slug },
        select: {
          vertical: true, isActive: true,
          subscription: {
            select: {
              status: true, activatedAt: true, accessGraceUntil: true,
              currentPeriodEnd: true, trialEndsAt: true,
              paddleSubscriptionId: true, stripeSubscriptionId: true, razorpaySubscriptionId: true,
              tier: { select: { slug: true } },
            },
          },
        },
      });
      if (!business || !business.isActive) {
        return res.status(404).json({ message: 'Business not found' });
      }
      // Billing gate: an EXPIRED tenant's storefront goes dark at the API layer
      // (not just SSR) — products/cart/checkout stop serving until they pay.
      // GRACE/ACTIVE keep serving.
      const { needsRenewal } = require('../lib/billingAccess');
      if (needsRenewal(business)) {
        return res.status(404).json({ message: 'This store is currently unavailable.' });
      }
      const vertical = resolveVertical(business.vertical);
      if (!allowed.has(vertical)) {
        return res.status(404).json({ message: 'This feature is not available for this business vertical' });
      }
      req.businessVertical = vertical;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

function requireCustomerVertical(...allowedVerticals) {
  const allowed = new Set(allowedVerticals.map((v) => String(v || '').toUpperCase()));
  return async function requireCustomerVerticalMiddleware(req, res, next) {
    try {
      const businessId = req.customer?.businessId;
      if (!businessId) {
        return res.status(400).json({ message: 'Customer business is required' });
      }
      const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: { vertical: true, isActive: true },
      });
      if (!business || !business.isActive) {
        return res.status(404).json({ message: 'Business not found' });
      }
      const vertical = resolveVertical(business.vertical);
      if (!allowed.has(vertical)) {
        return res.status(404).json({ message: 'This feature is not available for this business vertical' });
      }
      req.businessVertical = vertical;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

function requireAttachedBusinessVertical(...allowedVerticals) {
  const allowed = new Set(allowedVerticals.map((v) => String(v || '').toUpperCase()));
  return function requireAttachedBusinessVerticalMiddleware(req, res, next) {
    const business = req.business;
    if (!business) {
      return res.status(400).json({ message: 'Business is required' });
    }
    const vertical = resolveVertical(business.vertical);
    if (!allowed.has(vertical)) {
      return res.status(404).json({ message: 'This feature is not available for this business vertical' });
    }
    req.businessVertical = vertical;
    return next();
  };
}

module.exports = {
  requireVertical,
  requireUserBusinessVertical,
  requireStorefrontVertical,
  requireCustomerVertical,
  requireAttachedBusinessVertical,
};
