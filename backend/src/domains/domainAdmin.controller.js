const {
  addByodDomain,
  createDomainRegistrationCheckout,
  createDomainRenewalCheckout,
  disconnectDomain,
  enableRedirectAlias,
  getAuthCode,
  getTransferStatus,
  listBusinessDomains,
  makePrimary,
  registerManagedDomain,
  searchDomainOptions,
  syncPendingDomainRegistrationPayment,
  toggleAutoRenew,
  togglePrivacy,
  transferInDomain,
} = require('./domainService');
const { assertProdBuyTransferEnabled } = require('./availability');
const { currencyForCountry } = require('./localizePricing');
const prisma = require('../core/lib/prisma');

function sendDomainError(res, err) {
  const status = err?.status || err?.statusCode || 500;
  if (status >= 500) {
    console.error('[domain-reseller] request failed:', err?.message || err);
  }
  return res.status(status).json({
    message: err?.message || 'Domain request failed.',
    code: err?.code || 'DOMAIN_ERROR',
    ...(err?.domain ? { domain: err.domain } : {}),
    ...(err?.tld ? { tld: err.tld } : {}),
    ...(err?.reason ? { reason: err.reason } : {}),
    ...(err?.result ? { result: err.result } : {}),
  });
}

function businessIdFor(req) {
  return req.user?.businessId;
}

async function requireDomainStudio(req) {
  const businessId = businessIdFor(req);
  if (!businessId) {
    const err = new Error('Business scope is required.');
    err.status = 400;
    err.code = 'BUSINESS_REQUIRED';
    throw err;
  }
}

async function search(req, res) {
  try {
    await requireDomainStudio(req);
    assertProdBuyTransferEnabled();
    const biz = await prisma.business.findUnique({
      where: { id: businessIdFor(req) },
      select: { country: true, billingCountry: true },
    }).catch(() => null);
    const targetCurrency = await currencyForCountry(biz?.billingCountry || biz?.country, prisma);
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

async function list(req, res) {
  try {
    const result = await listBusinessDomains({ businessId: businessIdFor(req) });
    return res.json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

async function register(req, res) {
  try {
    await requireDomainStudio(req);
    assertProdBuyTransferEnabled();
    const result = await registerManagedDomain({
      businessId: businessIdFor(req),
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

async function checkout(req, res) {
  try {
    await requireDomainStudio(req);
    assertProdBuyTransferEnabled();
    const result = await createDomainRegistrationCheckout({
      businessId: businessIdFor(req),
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

async function syncPayment(req, res) {
  try {
    await requireDomainStudio(req);
    const result = await syncPendingDomainRegistrationPayment({
      businessId: businessIdFor(req),
      transactionId: req.body?.transactionId || req.body?.transaction_id || null,
    });
    return res.json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

async function transferIn(req, res) {
  try {
    await requireDomainStudio(req);
    assertProdBuyTransferEnabled();
    const result = await transferInDomain({
      businessId: businessIdFor(req),
      domainName: req.body?.domainName || req.body?.domain,
      authCode: req.body?.authCode || req.body?.eppCode,
      years: req.body?.years,
    });
    return res.status(202).json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

async function byod(req, res) {
  try {
    await requireDomainStudio(req);
    const result = await addByodDomain({
      businessId: businessIdFor(req),
      domainName: req.body?.domainName || req.body?.domain,
    });
    return res.status(201).json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

async function transferStatus(req, res) {
  try {
    const result = await getTransferStatus({
      businessId: businessIdFor(req),
      id: req.params.id,
    });
    return res.json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

async function authCode(req, res) {
  try {
    const result = await getAuthCode({
      businessId: businessIdFor(req),
      id: req.params.id,
    });
    return res.json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

async function privacy(req, res) {
  try {
    const result = await togglePrivacy({
      businessId: businessIdFor(req),
      id: req.params.id,
      enabled: req.body?.enabled,
    });
    return res.json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

async function autoRenew(req, res) {
  try {
    const result = await toggleAutoRenew({
      businessId: businessIdFor(req),
      id: req.params.id,
      enabled: req.body?.enabled,
    });
    return res.json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

async function renew(req, res) {
  try {
    const result = await createDomainRenewalCheckout({
      businessId: businessIdFor(req),
      id: req.params.id,
      years: req.body?.years,
      user: req.user,
      req,
    });
    return res.json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

async function primary(req, res) {
  try {
    const result = await makePrimary({
      businessId: businessIdFor(req),
      id: req.params.id,
    });
    return res.json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

async function redirect(req, res) {
  try {
    const result = await enableRedirectAlias({
      businessId: businessIdFor(req),
      id: req.params.id,
    });
    return res.json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

async function remove(req, res) {
  try {
    const result = await disconnectDomain({
      businessId: businessIdFor(req),
      id: req.params.id,
    });
    return res.json(result);
  } catch (err) {
    return sendDomainError(res, err);
  }
}

module.exports = {
  authCode,
  autoRenew,
  byod,
  checkout,
  list,
  primary,
  privacy,
  register,
  redirect,
  remove,
  renew,
  search,
  sendDomainError,
  syncPayment,
  transferIn,
  transferStatus,
};
