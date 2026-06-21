const prisma = require('../core/lib/prisma');
const { ROLES } = require('../core/lib/roles');
const {
  addByodDomain,
  createDomainRegistrationCheckout,
  listBusinessDomains,
  registerManagedDomain,
  searchDomainOptions,
  transferInDomain,
} = require('./domainService');
const { sendDomainError } = require('./domainAdmin.controller');
const { assertProdBuyTransferEnabled } = require('./availability');
const { currencyForCountry } = require('./localizePricing');

// Best-effort customer country for an unauthenticated storefront search:
// the signed-in business's country, else the Cloudflare geo header.
function requestCountry(req) {
  return (
    req.headers?.['cf-ipcountry'] ||
    req.headers?.['x-vercel-ip-country'] ||
    req.query?.country ||
    null
  );
}

async function businessForSlug(slug) {
  return prisma.business.findUnique({
    where: { slug: String(slug || '').trim().toLowerCase() },
    select: { id: true, slug: true },
  });
}

async function requireSlugOwner(req, res) {
  const business = await businessForSlug(req.params.slug);
  if (!business) {
    res.status(404).json({ message: 'Business not found.', code: 'BUSINESS_NOT_FOUND' });
    return null;
  }
  const isOwner = req.user?.businessId === business.id || req.user?.role === ROLES.SUPER_ADMIN;
  if (!isOwner) {
    res.status(403).json({ message: 'Forbidden: this domain action is only available to the business owner.', code: 'DOMAIN_OWNER_REQUIRED' });
    return null;
  }
  return business;
}

async function search(req, res) {
  try {
    assertProdBuyTransferEnabled();
    let country = requestCountry(req);
    if (!country && req.user?.businessId) {
      const biz = await prisma.business.findUnique({
        where: { id: req.user.businessId },
        select: { country: true, billingCountry: true },
      }).catch(() => null);
      country = biz?.billingCountry || biz?.country || null;
    }
    const targetCurrency = await currencyForCountry(country, prisma);
    const result = await searchDomainOptions({
      query: req.query?.q || req.query?.query,
      tlds: req.query?.tlds,
      targetCurrency,
    });
    return res.json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

async function listForSlug(req, res) {
  try {
    const business = await requireSlugOwner(req, res);
    if (!business) return null;
    const result = await listBusinessDomains({ businessId: business.id });
    return res.json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

async function registerForSlug(req, res) {
  try {
    assertProdBuyTransferEnabled();
    const business = await requireSlugOwner(req, res);
    if (!business) return null;
    const result = await registerManagedDomain({
      businessId: business.id,
      domainName: req.body?.domainName || req.body?.domain,
      years: req.body?.years,
      privacyEnabled: req.body?.privacyEnabled !== false,
      trusteeEnabled: !!req.body?.trusteeEnabled,
      confirmPremium: !!req.body?.confirmPremium,
    });
    return res.status(201).json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

async function checkoutForSlug(req, res) {
  try {
    assertProdBuyTransferEnabled();
    const business = await requireSlugOwner(req, res);
    if (!business) return null;
    const result = await createDomainRegistrationCheckout({
      businessId: business.id,
      domainName: req.body?.domainName || req.body?.domain,
      years: req.body?.years,
      privacyEnabled: req.body?.privacyEnabled !== false,
      trusteeEnabled: !!req.body?.trusteeEnabled,
      confirmPremium: !!req.body?.confirmPremium,
      user: req.user,
      req,
    });
    return res.status(result.action === 'registered' ? 201 : 200).json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

async function transferInForSlug(req, res) {
  try {
    assertProdBuyTransferEnabled();
    const business = await requireSlugOwner(req, res);
    if (!business) return null;
    const result = await transferInDomain({
      businessId: business.id,
      domainName: req.body?.domainName || req.body?.domain,
      authCode: req.body?.authCode || req.body?.eppCode,
      years: req.body?.years,
    });
    return res.status(202).json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

async function byodForSlug(req, res) {
  try {
    const business = await requireSlugOwner(req, res);
    if (!business) return null;
    const result = await addByodDomain({
      businessId: business.id,
      domainName: req.body?.domainName || req.body?.domain,
    });
    return res.status(201).json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

module.exports = {
  byodForSlug,
  checkoutForSlug,
  listForSlug,
  registerForSlug,
  search,
  transferInForSlug,
};
