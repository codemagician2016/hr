// Super-admin subscription coupons. Lets the SUPER_ADMIN create coupon
// codes that business admins redeem when buying / renewing a subscription.
//
// Two benefit types work today (no payment gateway needed):
//   - FREE_PERIOD    → extend Subscription.currentPeriodEnd by N days/months
//   - LIFETIME_FREE  → push currentPeriodEnd far into the future (year 2099)
//
// Paddle-backed discounts:
//   - PERCENT_OFF    → Paddle checkout discount code
//   - FIXED_OFF      → Paddle checkout discount code
//
// Re-homed into core for the HR fork. These are SaaS subscription promo codes
// only — no booking/appointment-specific surface (the original had none). The
// AdminCoupon / AdminCouponRedemption Prisma models remain unchanged.

const prisma = require('../lib/prisma');
const {
  createPaddleDiscount,
  getPaddleDiscount,
  isPaddleConfigured,
  listPaddleDiscounts,
} = require('../lib/paddle');
const { selectPlan } = require('./subscription.controller');

const BENEFIT_TYPES = ['FREE_PERIOD', 'LIFETIME_FREE', 'PERCENT_OFF', 'FIXED_OFF'];
const BENEFIT_UNITS = ['DAYS', 'MONTHS', 'CYCLES'];
const LIFETIME_END = new Date('2099-12-31T00:00:00.000Z');

// ---------- validation helpers ----------

function normaliseCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

function isPaddleDiscountCoupon(coupon) {
  return coupon?.benefitType === 'PERCENT_OFF' || coupon?.benefitType === 'FIXED_OFF';
}

function currencyMinorMultiplier(currencyCode) {
  const zeroDecimal = new Set(['JPY','KRW','VND','CLP','ISK','HUF','COP','IDR','PYG','UGX','RWF','XAF','XOF','KMF','DJF','GNF','BIF']);
  const threeDecimal = new Set(['KWD','BHD','OMR','JOD','TND','IQD','LYD']);
  const code = String(currencyCode || '').toUpperCase();
  if (zeroDecimal.has(code)) return 1;
  if (threeDecimal.has(code)) return 1000;
  return 100;
}

function discountPayloadForCoupon(coupon) {
  const code = normaliseCode(coupon.code);
  if (!/^[A-Z0-9]{1,32}$/.test(code)) {
    const err = new Error('Paddle checkout discount codes may only contain letters and numbers, up to 32 characters.');
    err.status = 400;
    throw err;
  }

  const type = coupon.benefitType === 'PERCENT_OFF' ? 'percentage' : 'flat';
  const amount = coupon.benefitType === 'PERCENT_OFF'
    ? String(Number(coupon.benefitValue || 0))
    : String(Math.round(Number(coupon.benefitValue || 0) * currencyMinorMultiplier(coupon.benefitCurrency)));
  const payload = {
    description: coupon.description || `Sitepresso ${code}`,
    enabled_for_checkout: true,
    code,
    type,
    mode: 'standard',
    amount,
    recur: true,
    maximum_recurring_intervals: null,
    custom_data: {
      app: 'sitepresso',
      adminCouponId: coupon.id,
      adminCouponCode: code,
    },
  };
  if (coupon.benefitType === 'FIXED_OFF') {
    payload.currency_code = String(coupon.benefitCurrency || '').toUpperCase();
  }
  if (coupon.maxTotalUses) payload.usage_limit = coupon.maxTotalUses;
  if (coupon.validUntil) payload.expires_at = new Date(coupon.validUntil).toISOString();
  return payload;
}

async function ensurePaddleDiscountForCoupon(coupon) {
  if (!isPaddleDiscountCoupon(coupon)) return null;
  if (!isPaddleConfigured()) {
    const err = new Error('Paddle is not configured, so checkout discount coupons cannot be activated.');
    err.status = 503;
    throw err;
  }
  if (coupon.paddleDiscountId) {
    const existing = await getPaddleDiscount(coupon.paddleDiscountId).catch(() => null);
    if (existing?.id) return existing;
  }

  const code = normaliseCode(coupon.code);
  const listed = await listPaddleDiscounts({ code }).catch(() => ({ data: [] }));
  const matched = listed.data.find((discount) => String(discount.code || '').toUpperCase() === code);
  const discount = matched || await createPaddleDiscount(discountPayloadForCoupon(coupon));
  await prisma.adminCoupon.update({
    where: { id: coupon.id },
    data: {
      paddleDiscountId: discount.id,
      paddleDiscountStatus: discount.status || 'active',
    },
  });
  return discount;
}

// ---------- Super-admin CRUD ----------

// GET /api/admin/subscription-coupons
async function list(req, res) {
  const coupons = await prisma.adminCoupon.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { redemptions: true } } },
  });
  res.json({ coupons });
}

// POST /api/admin/subscription-coupons
// Validation handled by createAdminCouponSchema (Zod) — req.body lands
// already-coerced (code uppercased, dates as Date, currency upper-cased
// 3-char, allowed lists trimmed/lowercased/uppercased).
async function create(req, res) {
  const { description, ...rest } = req.body;
  const data = {
    ...rest,
    description: description ? description.trim() || null : null,
  };

  try {
    let coupon = await prisma.adminCoupon.create({
      data: { ...data, createdById: req.user?.id || null },
    });
    let paddleWarning = null;
    if (isPaddleDiscountCoupon(coupon)) {
      try {
        await ensurePaddleDiscountForCoupon(coupon);
        coupon = await prisma.adminCoupon.findUnique({ where: { id: coupon.id } });
      } catch (paddleErr) {
        paddleWarning = paddleErr.message || 'Paddle discount could not be created yet.';
      }
    }
    res.status(201).json({ coupon, paddleWarning });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ message: 'A coupon with that code already exists' });
    throw err;
  }
}

// PUT /api/admin/subscription-coupons/:id
// Partial update. The schema (updateAdminCouponSchema) validates each
// supplied field's shape + benefit-type rules. Cross-field date order
// is re-checked here against the merged record so a partial update of
// validUntil alone is still safe.
async function update(req, res) {
  const { id } = req.params;
  const existing = await prisma.adminCoupon.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ message: 'Coupon not found' });

  const data = { ...req.body };
  if (typeof data.description === 'string') {
    data.description = data.description.trim() || null;
  }

  const effectiveFrom = data.validFrom ?? existing.validFrom;
  const effectiveUntil = data.validUntil ?? existing.validUntil;
  if (effectiveFrom && effectiveUntil && new Date(effectiveFrom) >= new Date(effectiveUntil)) {
    return res.status(400).json({ message: 'validUntil must be after validFrom' });
  }

  try {
    let coupon = await prisma.adminCoupon.update({
      where: { id },
      data,
    });
    let paddleWarning = null;
    if (isPaddleDiscountCoupon(coupon)) {
      try {
        await ensurePaddleDiscountForCoupon(coupon);
        coupon = await prisma.adminCoupon.findUnique({ where: { id: coupon.id } });
      } catch (paddleErr) {
        paddleWarning = paddleErr.message || 'Paddle discount could not be created yet.';
      }
    }
    res.json({ coupon, paddleWarning });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ message: 'A coupon with that code already exists' });
    throw err;
  }
}

// DELETE /api/admin/subscription-coupons/:id — soft delete (isActive=false)
async function remove(req, res) {
  const { id } = req.params;
  const existing = await prisma.adminCoupon.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ message: 'Coupon not found' });
  await prisma.adminCoupon.update({
    where: { id },
    data: { isActive: false },
  });
  res.json({ message: 'Coupon deactivated' });
}

// GET /api/admin/subscription-coupons/:id/redemptions
async function redemptions(req, res) {
  const { id } = req.params;
  const rows = await prisma.adminCouponRedemption.findMany({
    where: { couponId: id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const businessIds = rows.map((r) => r.businessId);
  const businesses = businessIds.length
    ? await prisma.business.findMany({ where: { id: { in: businessIds } }, select: { id: true, name: true, slug: true } })
    : [];
  const byId = Object.fromEntries(businesses.map((b) => [b.id, b]));
  res.json({
    redemptions: rows.map((r) => ({ ...r, business: byId[r.businessId] || null })),
  });
}

// ---------- Business-admin redemption ----------

// Find a coupon by code and run every applicability / eligibility check.
// Returns { valid: true, coupon } or { valid: false, message }.
async function checkCoupon({ code, business, user, tierSlug }) {
  const normalized = normaliseCode(code);
  if (!normalized) return { valid: false, message: 'Please enter a coupon code' };

  const coupon = await prisma.adminCoupon.findUnique({ where: { code: normalized } });
  if (!coupon) return { valid: false, message: 'Invalid coupon code' };
  if (!coupon.isActive) return { valid: false, message: 'This coupon is no longer active' };

  const now = new Date();
  if (coupon.validFrom && now < coupon.validFrom) return { valid: false, message: 'This coupon is not valid yet' };
  if (coupon.validUntil && now > coupon.validUntil) return { valid: false, message: 'This coupon has expired' };

  if (coupon.maxTotalUses && coupon.usedCount >= coupon.maxTotalUses) {
    return { valid: false, message: 'This coupon has reached its usage limit' };
  }

  if (coupon.allowedCountries.length > 0) {
    const country = (business?.country || '').toUpperCase();
    if (!country || !coupon.allowedCountries.includes(country)) {
      return { valid: false, message: 'This coupon is not available in your country' };
    }
  }

  if (coupon.allowedEmails.length > 0) {
    const email = (user?.email || '').toLowerCase();
    if (!email || !coupon.allowedEmails.includes(email)) {
      return { valid: false, message: 'This coupon is not available for your account' };
    }
  }

  // Business restriction accepts EITHER the uuid or the human-friendly shortId,
  // so a super-admin can paste short codes (e.g. "10293847") into the coupon's
  // business-restriction field instead of uuids. Existing uuid-based coupons
  // keep matching on business.id.
  if (coupon.allowedBusinessIds.length > 0 && business?.id) {
    const matchesBusiness = coupon.allowedBusinessIds.includes(business.id)
      || (business.shortId && coupon.allowedBusinessIds.includes(business.shortId));
    if (!matchesBusiness) {
      return { valid: false, message: 'This coupon is not available for your business' };
    }
  }

  if (coupon.applicableTiers.length > 0 && tierSlug && !coupon.applicableTiers.includes(tierSlug)) {
    return { valid: false, message: 'This coupon is not valid for the selected plan' };
  }

  // Per-business usage cap (usually 1).
  if (business?.id) {
    const existing = await prisma.adminCouponRedemption.findUnique({
      where: { couponId_businessId: { couponId: coupon.id, businessId: business.id } },
    });
    if (existing) return { valid: false, message: 'You have already used this coupon' };
    if (coupon.maxPerUser && coupon.maxPerUser <= 1) {
      // Future-proofing: if maxPerUser > 1 is added later, swap unique index
      // for a count() based check. For now, the unique index ≈ maxPerUser=1.
    }
  }

  if (coupon.firstSubscriptionOnly && business?.id) {
    const prior = await prisma.subscription.findUnique({ where: { businessId: business.id } });
    if (prior) {
      // If there's already a paid cycle in history, block.
      // For now we treat any existing subscription as "not first". Refine
      // later when Paddle invoice history is wired in.
      const isStillInitial = !prior.paddleSubscriptionId;
      if (!isStillInitial) {
        return { valid: false, message: 'This coupon is only available for a first subscription' };
      }
    }
  }

  return { valid: true, coupon };
}

// POST /api/subscription/redeem-coupon
// Body: { code, tierSlug? }
// Applies the coupon to the caller's business subscription.
async function redeemCoupon(req, res) {
  const businessId = req.user.businessId;
  if (!businessId) return res.status(400).json({ message: 'No business associated with this account' });

  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { id: true, shortId: true, name: true, country: true } });
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const { code, tierSlug } = req.body;
  const check = await checkCoupon({ code, business, user: req.user, tierSlug });
  if (!check.valid) return res.status(400).json({ message: check.message });
  const coupon = check.coupon;

  if (isPaddleDiscountCoupon(coupon)) {
    const existingSubscription = await prisma.subscription.findUnique({
      where: { businessId },
      select: { paddleSubscriptionId: true },
    });
    if (existingSubscription?.paddleSubscriptionId) {
      return res.status(409).json({
        message: 'Checkout discount coupons are available when starting a new Paddle checkout. Use the billing portal for an existing subscription change.',
      });
    }
    const effectiveTierSlug = tierSlug || (coupon.applicableTiers.length === 1 ? coupon.applicableTiers[0] : null);
    if (!effectiveTierSlug) {
      return res.status(400).json({ message: 'Pick a paid plan before applying this checkout discount.' });
    }
    const discount = await ensurePaddleDiscountForCoupon(coupon);
    const commandReq = Object.create(req);
    commandReq.user = req.user;
    commandReq.body = {
      tierSlug: effectiveTierSlug,
      billingCycle: req.body?.billingCycle || 'MONTHLY',
      targetVertical: req.body?.targetVertical || null,
      adminCouponCode: coupon.code,
      adminCouponDiscountId: discount.id,
    };
    const commandRes = {
      statusCode: 200,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        return payload;
      },
    };

    await selectPlan(commandReq, commandRes);
    if (commandRes.statusCode >= 400) {
      return res.status(commandRes.statusCode).json(commandRes.payload || {
        message: 'Could not start discounted checkout.',
      });
    }

    return res.json({
      ...(commandRes.payload || {}),
      action: commandRes.payload?.action || 'checkout',
      message: 'Discount applied. Complete Paddle checkout to activate the subscription.',
      checkoutDiscount: {
        code: discount?.code || coupon.code,
        paddleDiscountId: discount?.id || coupon.paddleDiscountId || null,
        status: discount?.status || null,
      },
      coupon: {
        code: coupon.code,
        benefitType: coupon.benefitType,
        benefitValue: coupon.benefitValue,
        benefitUnit: coupon.benefitUnit,
        benefitCurrency: coupon.benefitCurrency,
        applicableTiers: coupon.applicableTiers,
      },
    });
  }

  // Resolve / create subscription row.
  let subscription = await prisma.subscription.findUnique({ where: { businessId } });

  // If the coupon restricts to certain tiers, prefer that tier for the
  // subscription; otherwise keep the existing tier or fall back to the
  // requested tierSlug.
  let effectiveTierSlug = tierSlug;
  if (!effectiveTierSlug && coupon.applicableTiers.length === 1) {
    effectiveTierSlug = coupon.applicableTiers[0];
  }

  let tierId = subscription?.tierId || null;
  if (effectiveTierSlug) {
    const tier = await prisma.pricingTier.findUnique({ where: { slug: effectiveTierSlug } });
    if (!tier) return res.status(400).json({ message: `Unknown plan: ${effectiveTierSlug}` });
    tierId = tier.id;
  }

  // Compute new period end based on coupon benefit.
  const now = new Date();
  const basePeriodEnd = subscription?.currentPeriodEnd && subscription.currentPeriodEnd > now
    ? subscription.currentPeriodEnd
    : now;

  let newPeriodEnd = basePeriodEnd;
  let appliedFreeDays = null;

  if (coupon.benefitType === 'LIFETIME_FREE') {
    newPeriodEnd = LIFETIME_END;
    appliedFreeDays = null;
  } else if (coupon.benefitType === 'FREE_PERIOD') {
    const value = Number(coupon.benefitValue) || 0;
    const days = coupon.benefitUnit === 'MONTHS' ? Math.round(value * 30) : Math.round(value);
    appliedFreeDays = days;
    newPeriodEnd = new Date(basePeriodEnd.getTime() + days * 24 * 60 * 60 * 1000);
  }

  if (!tierId) {
    return res.status(400).json({ message: 'No tier associated with this subscription. Pick a plan before redeeming.' });
  }

  // Upsert subscription + record redemption + bump usage in one transaction.
  const result = await prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.upsert({
      where: { businessId },
      update: {
        tierId,
        status: 'ACTIVE',
        currentPeriodEnd: newPeriodEnd,
      },
      create: {
        businessId,
        tierId,
        status: 'ACTIVE',
        currentPeriodEnd: newPeriodEnd,
        billingCycle: 'MONTHLY',
      },
    });

    await tx.adminCouponRedemption.create({
      data: {
        couponId: coupon.id,
        businessId,
        subscriptionId: sub.id,
        appliedFreeDays,
        benefitSnapshot: {
          code: coupon.code,
          benefitType: coupon.benefitType,
          benefitValue: coupon.benefitValue,
          benefitUnit: coupon.benefitUnit,
        },
      },
    });

    await tx.adminCoupon.update({
      where: { id: coupon.id },
      data: { usedCount: { increment: 1 } },
    });

    return sub;
  });

  res.json({
    message: coupon.benefitType === 'LIFETIME_FREE'
      ? `Lifetime free access applied — welcome aboard!`
      : `${appliedFreeDays} day${appliedFreeDays === 1 ? '' : 's'} of free subscription added.`,
    subscription: result,
    coupon: {
      code: coupon.code,
      benefitType: coupon.benefitType,
      benefitValue: coupon.benefitValue,
      benefitUnit: coupon.benefitUnit,
    },
  });
}

// POST /api/subscription/validate-coupon — dry run, no DB write
async function validateCouponPreview(req, res) {
  const businessId = req.user.businessId;
  if (!businessId) return res.status(400).json({ valid: false, message: 'No business associated with this account' });

  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { id: true, shortId: true, country: true } });
  const { code, tierSlug } = req.body;
  const check = await checkCoupon({ code, business, user: req.user, tierSlug });
  if (!check.valid) return res.json(check);

  const { coupon } = check;
  res.json({
    valid: true,
    coupon: {
      code: coupon.code,
      description: coupon.description,
      benefitType: coupon.benefitType,
      benefitValue: coupon.benefitValue,
      benefitUnit: coupon.benefitUnit,
      benefitCurrency: coupon.benefitCurrency,
      applicableTiers: coupon.applicableTiers,
    },
    willApply: isPaddleDiscountCoupon(coupon) ? 'checkout_discount' : 'immediately',
  });
}

module.exports = {
  list,
  create,
  update,
  remove,
  redemptions,
  redeemCoupon,
  validateCouponPreview,
};
