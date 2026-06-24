'use strict';

// White-label Branding settings (HR) — mounted at /api/hr/branding.
//
// DriftHR is the VENDOR; a tenant must be able to set THEIR OWN brand (logo,
// favicon, colours, display name, support/email-from) and see it on the HR
// console, the ESS portal, and both login pages — never the DriftHR mark.
//
// This controller is the single read/write door for the tenant-wide brand:
//   • GET  /api/hr/branding  → the resolved tenant-wide TenantBrand (entityId
//     NULL) merged with the BusinessContent logo/favicon fallbacks, so the page
//     can pre-fill even for tenants that only ever set a storefront logo.
//   • PUT  /api/hr/branding  → upsert the tenant-wide TenantBrand AND mirror
//     logoUrl/faviconUrl onto BusinessContent (the source the existing
//     storefront/letters/Form-16 readers + tenant-resolve already read), AND
//     mirror primaryColor onto Subscription.themeColors (the source the theme
//     engine resolves --theme-primary from). Saving a colour therefore re-themes
//     every portal on next resolve.
//   • POST /api/hr/branding/asset → upload a logo/favicon (reuses the same S3
//     uploadDataUrl door as /api/upload/image; falls back to 501 so the client
//     can inline a data URL when hosting isn't configured).
//
// Tenant-scoped: businessId always comes from the session (req.user.businessId),
// never the client. Gated (in the route) on canEditDomain OR
// canManageCompanyProfile OR canEditBranding OR Owner.

const prisma = require('../../core/lib/prisma');
const s3 = require('../../core/lib/s3');
const { writeAudit } = require('../../core/lib/audit');

// The tenant-wide brand uses a stable `code` so the upsert is idempotent. A
// per-entity brand (entityId != null) is out of scope for this self-service
// surface — the console always edits the tenant-wide default.
const TENANT_WIDE_CODE = 'default';

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function normHex(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  return HEX.test(s) ? s.toUpperCase() : undefined; // undefined = invalid (reject)
}

function normStr(v, max = 200) {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (!s) return null; // empty string clears the field
  return s.slice(0, max);
}

function normUrl(v) {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (!s) return null; // clear
  // Accept http(s) absolute URLs or same-origin/relative paths (uploaded asset
  // proxies). Reject anything with a scheme we don't trust (javascript:, data:
  // is allowed only as an inline image fallback when S3 isn't configured).
  if (/^https?:\/\//i.test(s)) return s.slice(0, 2000);
  if (/^\/[^\s]*$/.test(s)) return s.slice(0, 2000);
  if (/^data:image\//i.test(s)) return s.slice(0, 5 * 1024 * 1024);
  return undefined; // invalid
}

// Shape the brand the API returns (and the resolve payload mirrors).
function shapeBrand(brand, content) {
  return {
    logoUrl: brand?.logoUrl || content?.logoUrl || null,
    faviconUrl: brand?.faviconUrl || content?.faviconUrl || null,
    primaryColor: brand?.primaryColor || null,
    secondaryColor: brand?.secondaryColor || null,
    accentColor: brand?.accentColor || null,
    name: brand?.name || null,
    emailFromName: brand?.emailFromName || null,
    emailFooter: brand?.emailFooter || null,
    supportEmail: brand?.supportEmail || null,
  };
}

// Resolve the tenant-wide brand row + content for a business.
async function loadTenantBrand(businessId) {
  const [brand, content] = await Promise.all([
    prisma.tenantBrand.findFirst({
      where: { businessId, entityId: null, deletedAt: null },
      orderBy: { isDefault: 'desc' },
    }),
    prisma.businessContent.findUnique({ where: { businessId } }),
  ]);
  return { brand, content };
}

// GET /api/hr/branding
async function getBranding(req, res) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { name: true },
  });
  const { brand, content } = await loadTenantBrand(businessId);
  const shaped = shapeBrand(brand, content);
  // Display name falls back to the legal business name so the page never shows
  // an empty wordmark for a tenant who hasn't set a brand display name yet.
  if (!shaped.name) shaped.name = business?.name || null;
  return res.json({ brand: shaped, businessName: business?.name || null });
}

// PUT /api/hr/branding
// Body: { logoUrl?, faviconUrl?, primaryColor?, secondaryColor?, accentColor?,
//         name?, emailFromName?, emailFooter?, supportEmail? }
// Any omitted field is left unchanged; an empty string clears it.
async function updateBranding(req, res) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const body = req.body || {};

  // Validate + normalise. `undefined` from a normaliser means "invalid input";
  // we reject the whole request so a bad colour never silently no-ops.
  const fields = {};
  const colorKeys = ['primaryColor', 'secondaryColor', 'accentColor'];
  for (const k of colorKeys) {
    if (body[k] !== undefined) {
      const v = normHex(body[k]);
      if (v === undefined) return res.status(400).json({ message: `Invalid hex colour for ${k}` });
      fields[k] = v;
    }
  }
  for (const k of ['logoUrl', 'faviconUrl']) {
    if (body[k] !== undefined) {
      const v = normUrl(body[k]);
      if (v === undefined) return res.status(400).json({ message: `Invalid URL for ${k}` });
      fields[k] = v;
    }
  }
  if (body.name !== undefined) fields.name = normStr(body.name, 120);
  if (body.emailFromName !== undefined) fields.emailFromName = normStr(body.emailFromName, 120);
  if (body.emailFooter !== undefined) fields.emailFooter = normStr(body.emailFooter, 2000);
  if (body.supportEmail !== undefined) {
    const e = normStr(body.supportEmail, 200);
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return res.status(400).json({ message: 'Invalid support email' });
    }
    fields.supportEmail = e;
  }

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ message: 'No branding fields provided' });
  }

  // TenantBrand.name is required (non-null in the schema). On first create we
  // need a value — use the provided display name, else the legal business name.
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { name: true, subscription: { select: { id: true, themeColors: true } } },
  });
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const createName = fields.name || business.name || 'Brand';

  // 1) Upsert the tenant-wide TenantBrand (entityId NULL, stable code).
  const existing = await prisma.tenantBrand.findFirst({
    where: { businessId, entityId: null, code: TENANT_WIDE_CODE },
    select: { id: true },
  });
  let brand;
  if (existing) {
    brand = await prisma.tenantBrand.update({
      where: { id: existing.id },
      data: { ...fields, isActive: true, deletedAt: null },
    });
  } else {
    brand = await prisma.tenantBrand.create({
      data: {
        businessId,
        entityId: null,
        code: TENANT_WIDE_CODE,
        name: createName,
        isDefault: true,
        isActive: true,
        ...fields,
      },
    });
  }

  // 2) Mirror logo/favicon → BusinessContent so the EXISTING readers (tenant
  //    -resolve, storefront, letters, Form 16) pick the new asset up without a
  //    new code path. Only mirror keys that were actually supplied.
  const contentMirror = {};
  if (fields.logoUrl !== undefined) contentMirror.logoUrl = fields.logoUrl;
  if (fields.faviconUrl !== undefined) contentMirror.faviconUrl = fields.faviconUrl;
  if (Object.keys(contentMirror).length) {
    await prisma.businessContent.upsert({
      where: { businessId },
      update: contentMirror,
      create: { businessId, ...contentMirror },
    });
  }

  // 3) Mirror primaryColor → Subscription.themeColors so the theme engine's
  //    resolveTenantTheme (which reads JSON.parse(themeColors).primary) re-themes
  //    the portal on the next /api/tenant/resolve. Merge with any existing JSON.
  if (fields.primaryColor !== undefined && business.subscription?.id) {
    let themeColors = {};
    try {
      themeColors = business.subscription.themeColors
        ? JSON.parse(business.subscription.themeColors)
        : {};
      if (!themeColors || typeof themeColors !== 'object') themeColors = {};
    } catch {
      themeColors = {};
    }
    if (fields.primaryColor) themeColors.primary = fields.primaryColor;
    else delete themeColors.primary;
    if (fields.accentColor !== undefined) {
      if (fields.accentColor) themeColors.accent = fields.accentColor;
      else delete themeColors.accent;
    }
    await prisma.subscription.update({
      where: { id: business.subscription.id },
      data: { themeColors: JSON.stringify(themeColors) },
    });
  }

  // Sensitive action — audit the brand change (tenant-scoped, best-effort).
  await writeAudit({
    businessId,
    actorId: req.user.id,
    action: 'branding.change',
    entityType: 'TenantBrand',
    entityId: brand.id,
    meta: { changed: Object.keys(fields) },
  }).catch(() => {});

  const content = await prisma.businessContent.findUnique({ where: { businessId } });
  return res.json({ brand: shapeBrand(brand, content) });
}

// POST /api/hr/branding/asset
// Body: { dataUrl: 'data:image/...;base64,...', kind: 'logo' | 'favicon' }
// Returns: { url } on success, 501 when S3 isn't configured (client inlines the
// data URL instead). Mirrors /api/upload/image but scopes by brand asset kind.
async function uploadAsset(req, res) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const { dataUrl, kind } = req.body || {};
  if (!dataUrl || typeof dataUrl !== 'string') {
    return res.status(400).json({ message: 'dataUrl is required' });
  }
  if (!/^data:image\//i.test(dataUrl)) {
    return res.status(400).json({ message: 'dataUrl must be an image' });
  }
  if (dataUrl.length > 8 * 1024 * 1024) {
    return res.status(413).json({ message: 'Image too large' });
  }
  const scope = kind === 'favicon' ? 'brand-favicon' : 'brand-logo';
  if (!s3.isConfigured()) {
    // Client falls back to embedding the data URL inline (small logos only).
    return res.status(501).json({ message: 'Image hosting not configured on this server' });
  }
  try {
    const { url } = await s3.uploadDataUrl({ dataUrl, businessId, scope });
    return res.json({ url });
  } catch (err) {
    return res.status(400).json({ message: err.message || 'Upload failed' });
  }
}

module.exports = {
  getBranding,
  updateBranding,
  uploadAsset,
  // Exposed for unit tests + reuse by tenant.controller's resolve.
  loadTenantBrand,
  shapeBrand,
  _private: { normHex, normStr, normUrl, TENANT_WIDE_CODE },
};
