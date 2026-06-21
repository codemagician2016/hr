const prisma = require('../lib/prisma');
const { ROLES } = require('../lib/roles');
const { logActivity } = require('../lib/ecomActivityLogger');
const {
  billableStaffSeatCount,
  limitLabel,
  numericEntitlement,
} = require('../lib/entitlements');
const {
  ACTION_DEFINITIONS,
  CHAT_ACTIONS,
  CHAT_ACTOR_ROLES,
  CHAT_CONTEXTS,
  buildActionCatalog,
  buildActionPreview,
  normalizeActorRole,
  normalizeContext,
} = require('../../../../packages/chat-v2-shared');

const ECOMMERCE_ONLY_ACTIONS = new Set([
  CHAT_ACTIONS.CREATE_COUPON,
  CHAT_ACTIONS.CREATE_BANNER,
  CHAT_ACTIONS.CREATE_CMS_CALLOUT,
  CHAT_ACTIONS.DIAGNOSE_DELIVERY,
  CHAT_ACTIONS.DIAGNOSE_BANNER,
]);

function cleanText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function cleanNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function adminTargetUrl(tab) {
  return tab ? `/dashboard?tab=${encodeURIComponent(tab)}` : null;
}

function actorRoleFromUser(user) {
  if (!user) return CHAT_ACTOR_ROLES.VISITOR;
  if (user.role === ROLES.SUPER_ADMIN) return CHAT_ACTOR_ROLES.SUPER_ADMIN;
  if (user.role === ROLES.BUSINESS_ADMIN) return CHAT_ACTOR_ROLES.OWNER;
  if (user.role === ROLES.STAFF) return CHAT_ACTOR_ROLES.STAFF;
  return CHAT_ACTOR_ROLES.VISITOR;
}

async function loadBusiness(businessId) {
  if (!businessId) return null;
  return prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      slug: true,
      vertical: true,
      country: true,
      defaultCurrency: true,
      paymentMode: true,
      pickupEnabled: true,
      deliveryMode: true,
      multiStoreMode: true,
    },
  });
}

async function userHasEcomPermission(req, permissionKey) {
  const user = req.user;
  if (!user) return false;
  if (user.role === ROLES.SUPER_ADMIN) return true;
  if (user.role === ROLES.BUSINESS_ADMIN && !user.businessRoleId) return true;
  if (user.businessRole?.isSystem && user.businessRole?.name === 'Owner') return true;
  if (!user.businessRoleId) return false;
  const grant = await prisma.ecomRolePermissionGrant.findFirst({
    where: {
      roleId: user.businessRoleId,
      permission: { key: permissionKey },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true },
  });
  return !!grant;
}

async function assertPreviewPermission(req, preview) {
  if (!preview?.permission || await userHasEcomPermission(req, preview.permission)) return preview;
  return {
    ...preview,
    allowed: false,
    blockedReason: `Missing permission: ${preview.permission}`,
    message: `You need the ${preview.permission} permission for this action.`,
  };
}

function gatewayPolicyForCountry(country) {
  const code = String(country || '').toUpperCase();
  if (code === 'IN') {
    return 'India: Razorpay for subscription billing, Razorpay Partner for tenant payments.';
  }
  if (code === 'NZ') {
    return 'New Zealand: Stripe for subscription billing, Stripe Connect for tenant payments.';
  }
  return 'Rest of world: Paddle MOR for subscription billing, Stripe Connect for tenant payments.';
}

function businessSupportsAction(business, actionKey) {
  if (!ECOMMERCE_ONLY_ACTIONS.has(actionKey)) return true;
  return String(business?.vertical || '').toUpperCase() === 'ECOMMERCE';
}

function blockUnsupportedBusiness(preview, business) {
  if (businessSupportsAction(business, preview?.actionKey)) return preview;
  return {
    ...preview,
    allowed: false,
    blockedReason: 'This action is available for ecommerce stores only.',
    message: 'This action is available for ecommerce stores only.',
  };
}

async function enrichPreview(preview, req) {
  if (!preview?.allowed) return preview;
  const business = req.user?.businessId ? await loadBusiness(req.user.businessId) : null;
  if (business) {
    const supported = blockUnsupportedBusiness(preview, business);
    if (!supported.allowed) return supported;
    preview = supported;
  }
  const permissionChecked = await assertPreviewPermission(req, preview);
  if (!permissionChecked.allowed) return permissionChecked;
  preview = permissionChecked;
  if (!req.user?.businessId) return preview;
  if (!business) return preview;

  if (preview.actionKey === CHAT_ACTIONS.DIAGNOSE_PAYMENT) {
    return {
      ...preview,
      previewLines: [
        `Store country: ${business.country || 'not set'}`,
        `Store currency: ${business.defaultCurrency || 'not set'}`,
        `Checkout mode: ${business.paymentMode || 'BOTH'}`,
        gatewayPolicyForCountry(business.country),
        'If online payment is not visible, check tenant gateway connection and checkout payment mode.',
      ],
      message: gatewayPolicyForCountry(business.country),
    };
  }

  if (preview.actionKey === CHAT_ACTIONS.DIAGNOSE_DELIVERY) {
    const [locations, zones, pickupCounters] = await Promise.all([
      prisma.businessLocation.count({ where: { businessId: business.id, isActive: true } }),
      prisma.ecomDeliveryZone.count({ where: { businessId: business.id, isActive: true } }),
      prisma.ecomPickupLocation.count({ where: { businessId: business.id, isActive: true } }),
    ]);
    return {
      ...preview,
      previewLines: [
        `Delivery mode: ${business.deliveryMode || 'ASAP'}`,
        `Store mode: ${business.multiStoreMode || 'OFF'}`,
        `Active branches/locations: ${locations}`,
        `Active delivery areas: ${zones}`,
        `Pickup enabled: ${business.pickupEnabled ? 'yes' : 'no'} (${pickupCounters} pickup counters)`,
        zones > 0 ? 'Delivery coverage exists. Test with a customer pincode/location.' : 'No active delivery area found. Add a pincode or map area in Store setup.',
      ],
    };
  }

  if (preview.actionKey === CHAT_ACTIONS.DIAGNOSE_BANNER) {
    const [total, active, missingImages, cmsTotal, cmsPublished] = await Promise.all([
      prisma.ecomBanner.count({ where: { businessId: business.id } }),
      prisma.ecomBanner.count({ where: { businessId: business.id, isActive: true } }),
      prisma.ecomBanner.count({
        where: {
          businessId: business.id,
          isActive: true,
          desktopImageUrl: null,
          mobileImageUrl: null,
        },
      }),
      prisma.ecomCmsBlock.count({ where: { businessId: business.id, slotKey: { not: { startsWith: '__' } } } }),
      prisma.ecomCmsBlock.count({ where: { businessId: business.id, status: 'PUBLISHED', slotKey: { not: { startsWith: '__' } } } }),
    ]);
    return {
      ...preview,
      previewLines: [
        `Total banners: ${total}`,
        `Active banners: ${active}`,
        `Active banners missing image: ${missingImages}`,
        `CMS blocks: ${cmsTotal} total, ${cmsPublished} published`,
        active > 0 ? 'If a banner is still hidden, check date window, placement, audience, location, and link target.' : 'No active banner found. Publish at least one banner.',
      ],
    };
  }

  if (preview.actionKey === CHAT_ACTIONS.DIAGNOSE_PLAN_LIMITS) {
    const [staffSeats, activeBranches, activeRiders, staffLimit, branchLimit, locationLimit] = await Promise.all([
      billableStaffSeatCount(business.id),
      prisma.businessLocation.count({ where: { businessId: business.id, isActive: true } }),
      prisma.ecomRider.count({ where: { businessId: business.id, status: { not: 'DEPARTED' } } }),
      numericEntitlement(business.id, 'staff_count'),
      numericEntitlement(business.id, 'branches_count'),
      numericEntitlement(business.id, 'locations_count'),
    ]);
    return {
      ...preview,
      previewLines: [
        `Current plan: ${staffLimit.tierSlug || 'not assigned'}`,
        `Billable staff/rider seats: ${staffSeats} of ${limitLabel(staffLimit.limit)}`,
        `Active branches: ${activeBranches} of ${limitLabel(branchLimit.limit)}`,
        `Fulfillment locations: ${activeBranches} of ${limitLabel(locationLimit.limit)}`,
        `Riders in fleet: ${activeRiders}`,
        staffLimit.accessAllowed ? 'Billing access is active.' : 'Billing access needs attention before adding more seats or locations.',
      ],
      message: `Current plan ${staffLimit.tierSlug || 'not assigned'} allows ${limitLabel(staffLimit.limit)} staff/rider seats.`,
    };
  }

  return preview;
}

async function catalog(req, res) {
  const context = normalizeContext(req.query?.context || req.body?.context, CHAT_CONTEXTS.ADMIN_PORTAL);
  const actorRole = normalizeActorRole(req.query?.actorRole || req.body?.actorRole, actorRoleFromUser(req.user));
  const business = req.user?.businessId ? await loadBusiness(req.user.businessId) : null;
  const catalogData = buildActionCatalog({ context, actorRole });
  const actions = await Promise.all((catalogData.actions || []).map(async (action) => {
    if (!businessSupportsAction(business, action.actionKey)) {
      return {
        ...action,
        allowed: false,
        blockedReason: 'This action is available for ecommerce stores only.',
      };
    }
    if (!action.allowed || !action.permission) return action;
    if (await userHasEcomPermission(req, action.permission)) return action;
    return {
      ...action,
      allowed: false,
      blockedReason: `Missing permission: ${action.permission}`,
    };
  }));
  res.json({
    catalog: {
      ...catalogData,
      actions,
    },
  });
}

async function preview(req, res) {
  const context = normalizeContext(req.body?.context, CHAT_CONTEXTS.ADMIN_PORTAL);
  const actorRole = normalizeActorRole(req.body?.actorRole, actorRoleFromUser(req.user));
  const base = buildActionPreview(cleanText(req.body?.query || req.body?.message, 600), {
    context,
    actorRole,
    actionKey: req.body?.actionKey,
  });
  res.json({ preview: await enrichPreview(base, req) });
}

async function commitCoupon(req, res, draft) {
  if (!req.user?.businessId) return res.status(403).json({ message: 'No business in scope' });
  const business = await loadBusiness(req.user.businessId);
  if (!business || String(business.vertical || '').toUpperCase() !== 'ECOMMERCE') {
    return res.status(404).json({ message: 'Coupon actions are only available for ecommerce businesses' });
  }
  if (!await userHasEcomPermission(req, 'catalogue.price')) {
    return res.status(403).json({ message: 'Missing permission: catalogue.price' });
  }

  const code = cleanText(draft.code, 40).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!code || code.length < 2) return res.status(400).json({ message: 'Coupon code is required' });
  const discountType = draft.discountType === 'FIXED' ? 'FIXED' : 'PERCENTAGE';
  const discountValue = Number(draft.discountValue || 0);
  if (!Number.isFinite(discountValue) || discountValue <= 0) return res.status(400).json({ message: 'Discount value must be greater than zero' });

  const duplicate = await prisma.coupon.findUnique({
    where: { businessId_code: { businessId: business.id, code } },
    select: { id: true },
  });
  if (duplicate) return res.status(409).json({ message: 'A coupon with that code already exists' });

  const validFrom = new Date();
  const validDays = Math.max(1, Math.min(365, Number(draft.validDays || 30)));
  const validUntil = new Date(validFrom.getTime() + validDays * 24 * 60 * 60 * 1000);
  const coupon = await prisma.coupon.create({
    data: {
      businessId: business.id,
      code,
      description: cleanText(draft.description, 500) || 'AapkaChat draft coupon',
      discountType,
      discountValue,
      minOrderAmount: draft.minOrderAmount == null ? null : Number(draft.minOrderAmount),
      maxDiscount: draft.maxDiscount == null ? null : Number(draft.maxDiscount),
      maxUses: draft.maxUses == null ? null : Number(draft.maxUses),
      maxUsesPerCustomer: draft.maxUsesPerCustomer == null ? null : Number(draft.maxUsesPerCustomer),
      applicableServiceIds: [],
      applicableCategoryIds: [],
      validFrom,
      validUntil,
      isActive: false,
      isFirstBookingOnly: draft.audience === 'new_customers',
    },
  });

  await logActivity(req, {
    eventKey: 'coupon.created_from_aapkachat',
    area: 'marketing',
    targetType: 'coupon',
    targetId: coupon.id,
    targetCode: coupon.code,
    payload: { discountType: coupon.discountType, discountValue: coupon.discountValue },
  });

  return res.status(201).json({
    ok: true,
    result: { coupon },
    targetUrl: adminTargetUrl('coupons'),
    message: `Coupon ${coupon.code} was saved as an inactive draft. Open Coupons to review and activate it.`,
  });
}

async function commitBanner(req, res, draft) {
  if (!req.user?.businessId) return res.status(403).json({ message: 'No business in scope' });
  const business = await loadBusiness(req.user.businessId);
  if (!business || String(business.vertical || '').toUpperCase() !== 'ECOMMERCE') {
    return res.status(404).json({ message: 'Banner actions are only available for ecommerce businesses' });
  }
  if (!await userHasEcomPermission(req, 'catalogue.edit')) {
    return res.status(403).json({ message: 'Missing permission: catalogue.edit' });
  }

  const placements = ['HOMEPAGE_HERO', 'HOMEPAGE_STRIP', 'CATEGORY_HERO', 'CART_UPSELL', 'ACCOUNT_OFFER', 'CHECKOUT_BANNER'];
  const audiences = ['ALL', 'GUEST', 'LOGGED_IN', 'NEW', 'RETURNING', 'VIP'];
  const placement = placements.includes(draft.placement) ? draft.placement : 'HOMEPAGE_STRIP';
  const audience = audiences.includes(draft.audience) ? draft.audience : 'ALL';
  const headline = cleanText(draft.headline, 200) || 'Storefront offer';
  const banner = await prisma.ecomBanner.create({
    data: {
      businessId: business.id,
      placement,
      sortOrder: Math.max(0, Math.round(cleanNumber(draft.sortOrder, 0))),
      audience,
      headline,
      subheadline: cleanText(draft.subheadline, 500) || null,
      ctaLabel: cleanText(draft.ctaLabel, 80) || 'Shop now',
      linkType: 'URL',
      linkUrl: cleanText(draft.linkUrl, 2000) || '/shop',
      desktopImageUrl: null,
      mobileImageUrl: null,
      altText: cleanText(draft.altText, 200) || headline,
      isActive: false,
    },
  });

  await logActivity(req, {
    eventKey: 'banner.created_from_aapkachat',
    area: 'marketing',
    targetType: 'banner',
    targetId: banner.id,
    targetCode: banner.headline || banner.placement,
    payload: { placement: banner.placement, source: 'aapkachat_action_widget' },
  });

  return res.status(201).json({
    ok: true,
    result: { banner },
    targetUrl: adminTargetUrl('banners'),
    message: `Banner "${banner.headline}" was saved as an inactive draft. Open Banners to add images and publish it.`,
  });
}

async function commitCmsCallout(req, res, draft) {
  if (!req.user?.businessId) return res.status(403).json({ message: 'No business in scope' });
  const business = await loadBusiness(req.user.businessId);
  if (!business || String(business.vertical || '').toUpperCase() !== 'ECOMMERCE') {
    return res.status(404).json({ message: 'CMS actions are only available for ecommerce businesses' });
  }
  if (!await userHasEcomPermission(req, 'catalogue.edit')) {
    return res.status(403).json({ message: 'Missing permission: catalogue.edit' });
  }

  const payload = draft.payload && typeof draft.payload === 'object' ? draft.payload : {};
  const code = cleanText(payload.code || draft.code, 40).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!code || code.length < 2) return res.status(400).json({ message: 'Coupon/code text is required for the callout' });
  const slotKey = cleanText(draft.slotKey, 120) || 'homepage';
  if (slotKey.startsWith('__')) return res.status(400).json({ message: 'That CMS slot is reserved' });

  const block = await prisma.ecomCmsBlock.create({
    data: {
      businessId: business.id,
      slotKey,
      blockType: 'COUPON_CALLOUT',
      sortOrder: Math.max(0, Math.round(cleanNumber(draft.sortOrder, 0))),
      payload: {
        code,
        headline: cleanText(payload.headline, 160) || 'Limited time offer',
        subtext: cleanText(payload.subtext, 240) || 'Review this draft before publishing.',
      },
      audience: cleanText(draft.audience, 40) || 'ALL',
      status: 'DRAFT',
    },
  });

  await logActivity(req, {
    eventKey: 'cms.block_created_from_aapkachat',
    area: 'marketing',
    targetType: 'cmsBlock',
    targetId: block.id,
    targetCode: `${block.slotKey} :: ${block.blockType}`,
    payload: { source: 'aapkachat_action_widget' },
  });

  return res.status(201).json({
    ok: true,
    result: { block },
    targetUrl: adminTargetUrl('cms'),
    message: `CMS callout ${code} was saved as a draft. Open CMS to review and publish it.`,
  });
}

async function commitSupportTicket(req, res, draft) {
  if (!req.user?.businessId) return res.status(403).json({ message: 'No business in scope' });
  const subject = cleanText(draft.subject, 160) || 'Support request from AapkaChat';
  const body = cleanText(draft.body) || 'I need help.';
  const conversation = await prisma.$transaction(async (tx) => {
    const created = await tx.supportConversation.create({
      data: {
        businessId: req.user.businessId,
        kind: 'PLATFORM_SUPPORT',
        projectKey: 'sitepresso',
        channel: 'TENANT_SUPPORT',
        sourceUrl: cleanText(req.body?.sourceUrl, 500) || null,
        subject,
        status: 'OPEN',
        tenantReadAt: new Date(),
      },
    });
    await tx.supportMessage.create({
      data: {
        conversationId: created.id,
        businessId: req.user.businessId,
        senderType: 'TENANT_USER',
        userId: req.user.id,
        senderName: req.user.name,
        senderEmail: req.user.email,
        body,
        metadata: { source: 'aapkachat_action_widget' },
      },
    });
    return created;
  });
  return res.status(201).json({
    ok: true,
    result: { conversationId: conversation.id },
    message: 'Support ticket submitted. Sitepresso support can reply from the AapkaChat/support inbox.',
  });
}

async function commit(req, res) {
  const context = normalizeContext(req.body?.context, CHAT_CONTEXTS.ADMIN_PORTAL);
  const actorRole = normalizeActorRole(req.body?.actorRole, actorRoleFromUser(req.user));
  const preview = buildActionPreview('', {
    context,
    actorRole,
    actionKey: req.body?.actionKey,
  });
  if (!preview.allowed) return res.status(403).json({ message: preview.blockedReason || 'Action not allowed' });
  const def = ACTION_DEFINITIONS[req.body?.actionKey];
  if (def?.permission && !await userHasEcomPermission(req, def.permission)) {
    return res.status(403).json({ message: `Missing permission: ${def.permission}` });
  }

  if (req.body?.actionKey === CHAT_ACTIONS.CREATE_COUPON) {
    return commitCoupon(req, res, req.body?.draft || {});
  }
  if (req.body?.actionKey === CHAT_ACTIONS.CREATE_BANNER) {
    return commitBanner(req, res, req.body?.draft || {});
  }
  if (req.body?.actionKey === CHAT_ACTIONS.CREATE_CMS_CALLOUT) {
    return commitCmsCallout(req, res, req.body?.draft || {});
  }
  if (req.body?.actionKey === CHAT_ACTIONS.RAISE_SUPPORT_TICKET) {
    return commitSupportTicket(req, res, req.body?.draft || {});
  }
  return res.status(400).json({ message: 'This action is preview-only for now. Nothing was changed.' });
}

module.exports = {
  catalog,
  preview,
  commit,
};
