const prismaDefault = require('../core/lib/prisma');
const {
  customDomainClaimDomains,
  deleteCloudflareCustomHostname,
  provisionCustomDomain,
} = require('../core/controllers/subscription.controller');
const {
  customDomainLookupHosts,
  normalizeCustomDomainHost,
  routableCustomDomainWhere,
} = require('../core/lib/customDomainRouting');
const {
  assertValidDomainName,
  normalizeDomainName,
  normalizeTld,
  tldFromDomain,
} = require('./domainNames');
const { getDomainResellerMode, MODE_LIVE } = require('./config');
const { DEFAULT_SEARCH_TLDS, starterPriceForTld } = require('./pricing');
const { localizeResults, localizeDomainResult, currencyForCountry } = require('./localizePricing');
const {
  createDefaultAdapters,
  getAdapterForTld,
  resolveRegistrarForTld,
  searchAvailableAcrossRegistrars,
} = require('./routing');
const { renewalNoticeWindows } = require('./renewalCron');
const {
  createPaddleCustomer,
  createPaddleTransaction,
  getPaddleTransaction,
  isPaddleConfigured,
  refundPaddleTransaction,
} = require('../core/lib/paddle');
const { ensurePaddleBillingProfile } = require('../core/lib/paddleCustomerProfile');
const { recordCheckoutCreated } = require('../core/lib/billingLedger');

const OWNED_DOMAIN_STATUSES = new Set(['ACTIVE', 'EXPIRING', 'PENDING', 'TRANSFER_IN_PENDING', 'LOCKED']);
const REDIRECTABLE_DOMAIN_STATUSES = new Set(['ACTIVE', 'EXPIRING', 'BYOD', 'LOCKED']);
const DOMAIN_REGISTRATION_PAYMENT_KIND = 'domain_registration';
const DOMAIN_RENEWAL_PAYMENT_KIND = 'domain_renewal';
const RENEWABLE_DOMAIN_STATUSES = new Set(['ACTIVE', 'EXPIRING', 'EXPIRED']);

function domainError(message, status = 400, code = 'DOMAIN_ERROR', extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function requireDomainDelegate(client) {
  if (!client?.domain) {
    throw domainError(
      'Domain reseller tables are not available yet. Run the domain migration and regenerate the Prisma client.',
      503,
      'DOMAIN_TABLES_UNAVAILABLE'
    );
  }
}

function normalizeYears(value) {
  const years = Number.parseInt(value, 10);
  if (!Number.isFinite(years) || years < 1) return 1;
  return Math.min(years, 10);
}

function registrarLabel(registrar) {
  if (registrar === 'OPENPROVIDER') return 'Sitepresso via Openprovider';
  if (registrar === 'BYOD') return 'External registrar';
  return 'Sitepresso';
}

function asMinor(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function quoteDomainAmountMinor(match = {}, years = 1) {
  const normalizedYears = normalizeYears(years);
  const firstYear = asMinor(match.priceMinor ?? match.retailMinor);
  const renewal = asMinor(match.renewalPriceMinor ?? match.renewalRetailMinor ?? match.priceMinor ?? match.retailMinor);
  const subtotal = firstYear + Math.max(0, normalizedYears - 1) * renewal;
  const discountMinor = normalizedYears >= 2 ? Math.round(subtotal * 0.1) : 0;
  return {
    years: normalizedYears,
    subtotalMinor: subtotal,
    discountMinor,
    totalMinor: Math.max(0, subtotal - discountMinor),
  };
}

function privacyRetailMinor(currency) {
  return String(currency || 'INR').toUpperCase() === 'INR' ? 29900 : 499;
}

function getPlatformBaseUrl(req = null) {
  const explicit = String(process.env.NEXT_PUBLIC_PLATFORM_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const frontendUrl = String(process.env.FRONTEND_URL || '').trim();
  if (frontendUrl) return frontendUrl.replace(/\/$/, '');

  const forwardedHost = String(req?.get?.('X-Forwarded-Host') || req?.get?.('Host') || '').trim();
  if (forwardedHost) {
    const proto = String(req?.get?.('X-Forwarded-Proto') || '').trim() || 'https';
    return `${proto}://${forwardedHost.replace(/\/$/, '')}`;
  }

  const platformDomain = process.env.PLATFORM_DOMAIN || 'sitepresso.com';
  return `https://${platformDomain}`;
}

function buildDomainCheckoutLauncherUrl(req, business) {
  const base = getPlatformBaseUrl(req);
  const url = new URL(`${base}/billing/checkout`);
  url.searchParams.set('redirect', `/${business.slug}/admin?tab=domains&domain=success`);
  return url.toString();
}

function buildCheckoutOpenUrl(launcherUrl, transactionId) {
  if (!launcherUrl || !transactionId) return null;
  try {
    const url = new URL(launcherUrl);
    url.searchParams.set('_ptxn', transactionId);
    return url.toString();
  } catch {
    const joiner = launcherUrl.includes('?') ? '&' : '?';
    return `${launcherUrl}${joiner}_ptxn=${encodeURIComponent(transactionId)}`;
  }
}

function billingNameForBusiness(business) {
  if (business?.billingPurchaserType === 'BUSINESS') {
    return business.billingBusinessName || business.billingContactName || business.name || 'Sitepresso customer';
  }
  return business?.billingContactName || business?.name || 'Sitepresso customer';
}

function extractPaddleCustomerIdFromConflict(err) {
  const directId = String(
    err?.data?.error?.errors?.[0]?.meta?.existing_customer_id
    || err?.data?.meta?.existing_customer_id
    || ''
  ).trim();
  if (directId) return directId;

  const detail = String(err?.data?.error?.errors?.[0]?.detail || err?.message || '');
  const match = detail.match(/\bcustomer of id\s+(ctm_[a-z0-9]+)\b/i);
  return match ? match[1] : null;
}

function isDomainRegistrationPayment(entity) {
  return entity?.custom_data?.kind === DOMAIN_REGISTRATION_PAYMENT_KIND;
}

function isDomainRenewalPayment(entity) {
  return entity?.custom_data?.kind === DOMAIN_RENEWAL_PAYMENT_KIND;
}

function paddleCustomBusinessId(entity) {
  return String(entity?.custom_data?.businessId || '').trim();
}

function paddleCustomDomainName(entity) {
  const raw = entity?.custom_data?.domainName;
  return raw ? normalizeDomainName(raw) : '';
}

function paddleTransactionCurrency(entity) {
  return String(
    entity?.currency_code
    || entity?.details?.totals?.currency_code
    || entity?.totals?.currency_code
    || ''
  ).trim().toUpperCase();
}

function paddleTransactionUnitAmounts(entity) {
  const out = [];
  const items = Array.isArray(entity?.items) ? entity.items : [];
  for (const item of items) {
    const amount = item?.price?.unit_price?.amount || item?.unit_price?.amount;
    const parsed = Number.parseInt(amount, 10);
    if (Number.isFinite(parsed)) out.push(parsed);
  }
  return out;
}

function assertDomainPaymentSnapshotMatches(entity) {
  const data = entity?.custom_data || {};
  const expectedCurrency = String(data.currency || '').trim().toUpperCase();
  const actualCurrency = paddleTransactionCurrency(entity);
  if (expectedCurrency && actualCurrency && expectedCurrency !== actualCurrency) {
    throw domainError('Paddle transaction currency does not match this domain quote.', 409, 'DOMAIN_PAYMENT_CURRENCY_MISMATCH');
  }

  const expectedAmount = asMinor(data.checkoutTotalMinor, 0);
  if (expectedAmount > 0) {
    const unitAmounts = paddleTransactionUnitAmounts(entity);
    if (unitAmounts.length > 0 && !unitAmounts.includes(expectedAmount)) {
      throw domainError('Paddle transaction amount does not match this domain quote.', 409, 'DOMAIN_PAYMENT_AMOUNT_MISMATCH');
    }
  }
}

function daysUntil(date) {
  if (!date) return null;
  const ms = new Date(date).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.ceil(ms / 86400000);
}

function deriveDisplayStatus(domain) {
  if (!domain) return 'NONE';
  if (domain.status === 'ACTIVE' && domain.expiresAt) {
    const left = daysUntil(domain.expiresAt);
    if (left != null && left <= 14 && left >= 0) return 'EXPIRING';
    if (left != null && left < 0) return 'EXPIRED';
  }
  return domain.status;
}

function trafficRoleForDomain(domain, subscription = null) {
  const domainName = normalizeDomainName(domain?.name || '');
  const primaryName = normalizeDomainName(subscription?.customDomain || '');
  if (!domainName) return 'PARKED';
  if (primaryName && domainName === primaryName) return 'PRIMARY';
  if (primaryName && REDIRECTABLE_DOMAIN_STATUSES.has(String(domain?.status || '').toUpperCase())) return 'REDIRECT';
  return 'PARKED';
}

function serializeDomain(domain, subscription = null) {
  if (!domain) return null;
  const primaryName = normalizeDomainName(subscription?.customDomain || '');
  const domainName = normalizeDomainName(domain.name);
  const primary = Boolean(primaryName && primaryName === domainName);
  const trafficRole = trafficRoleForDomain(domain, subscription);
  let displayStatus = deriveDisplayStatus(domain);
  if (domain.registrar === 'BYOD' && primary) {
    const customStatus = String(subscription?.customDomainStatus || '').toUpperCase();
    if (customStatus && customStatus !== 'NONE') displayStatus = customStatus;
  }
  return {
    id: domain.id,
    businessId: domain.businessId,
    name: domain.name,
    tld: domain.tld,
    registrar: domain.registrar,
    registrarLabel: registrarLabel(domain.registrar),
    registrarRef: domain.registrarRef || null,
    status: domain.status,
    displayStatus,
    statusMessage: domain.statusMessage || null,
    registeredAt: domain.registeredAt ? domain.registeredAt.toISOString?.() || domain.registeredAt : null,
    expiresAt: domain.expiresAt ? domain.expiresAt.toISOString?.() || domain.expiresAt : null,
    daysUntilExpiry: daysUntil(domain.expiresAt),
    autoRenew: Boolean(domain.autoRenew),
    privacyEnabled: Boolean(domain.privacyEnabled),
    trusteeEnabled: Boolean(domain.trusteeEnabled),
    wholesaleMinor: domain.wholesaleMinor,
    retailMinor: domain.retailMinor,
    renewalRetailMinor: domain.renewalRetailMinor,
    currency: domain.currency,
    customHostnameId: domain.customHostnameId || null,
    registrationPaddleTransactionId: domain.registrationPaddleTransactionId || null,
    renewalPaddleTransactionId: domain.renewalPaddleTransactionId || null,
    renewalPaymentStatus: domain.renewalPaymentStatus || null,
    renewalPaymentDueAt: domain.renewalPaymentDueAt ? domain.renewalPaymentDueAt.toISOString?.() || domain.renewalPaymentDueAt : null,
    renewalYears: domain.renewalYears || null,
    primary,
    trafficRole,
    trafficTarget: trafficRole === 'REDIRECT' ? primaryName : null,
    canonicalHost: primaryName || null,
    canRenew: domain.registrar !== 'BYOD' && RENEWABLE_DOMAIN_STATUSES.has(domain.status),
    canTransferOut: domain.registrar !== 'BYOD' && domain.status !== 'TRANSFER_OUT_PENDING',
    canTogglePrivacy: domain.registrar !== 'BYOD',
    createdAt: domain.createdAt ? domain.createdAt.toISOString?.() || domain.createdAt : null,
    updatedAt: domain.updatedAt ? domain.updatedAt.toISOString?.() || domain.updatedAt : null,
  };
}

function summarizeDomains(domains = [], subscription = null) {
  return domains.reduce((summary, domain) => {
    const view = serializeDomain(domain, subscription);
    summary.total += 1;
    const displayStatus = view.displayStatus;
    if (displayStatus === 'ACTIVE') summary.active += 1;
    if (displayStatus === 'EXPIRING') summary.expiring += 1;
    if (displayStatus === 'EXPIRED') summary.expired += 1;
    if (domain.autoRenew) summary.autoRenew += 1;
    if (view.trafficRole === 'PRIMARY') summary.primary += 1;
    if (view.trafficRole === 'REDIRECT') summary.redirects += 1;
    if (view.trafficRole === 'PARKED') summary.parked += 1;
    return summary;
  }, { total: 0, active: 0, expiring: 0, expired: 0, autoRenew: 0, primary: 0, redirects: 0, parked: 0 });
}

async function searchDomainOptions({ query, tlds, adapters, defaultTlds = DEFAULT_SEARCH_TLDS, targetCurrency } = {}) {
  const cleanQuery = normalizeDomainName(query);
  if (!cleanQuery) throw domainError('Enter a business name or domain to search.', 400, 'DOMAIN_SEARCH_REQUIRED');
  const requestedTlds = Array.isArray(tlds)
    ? tlds.map(normalizeTld).filter(Boolean)
    : typeof tlds === 'string'
      ? tlds.split(',').map(normalizeTld).filter(Boolean)
      : undefined;
  const result = await searchAvailableAcrossRegistrars(cleanQuery, {
    adapters,
    defaultTlds,
    ...(requestedTlds?.length ? { tlds: requestedTlds } : {}),
  });
  if (targetCurrency && Array.isArray(result?.results)) {
    result.results = await localizeResults(result.results, targetCurrency);
  }
  return result;
}

async function listBusinessDomains({ prisma = prismaDefault, businessId }) {
  requireDomainDelegate(prisma);
  if (!businessId) throw domainError('Business scope is required.', 400, 'BUSINESS_REQUIRED');
  let [domains, subscription] = await Promise.all([
    prisma.domain.findMany({
      where: { businessId },
      orderBy: [{ createdAt: 'desc' }],
    }),
    prisma.subscription.findUnique({
      where: { businessId },
      select: {
        customDomain: true,
        customDomainVerified: true,
        customDomainStatus: true,
        customDomainStatusMessage: true,
        customDomainCheckedAt: true,
      },
    }).catch(() => null),
  ]);

  // Legacy custom domains were stored only on Subscription. Surface them in
  // Domain Studio as externally managed domains so customers do not lose the
  // current connected-domain state when moving from Settings to Domain Studio.
  if (subscription?.customDomain && !domains.some((domain) => domain.name === subscription.customDomain)) {
    try {
      const backfilled = await createDomainRow({
        prisma,
        businessId,
        domainName: subscription.customDomain,
        registrar: 'BYOD',
        status: 'BYOD',
        statusMessage: subscription.customDomainStatusMessage || 'External domain connected through Sitepresso.',
        autoRenew: false,
        privacyEnabled: false,
        trusteeEnabled: false,
        price: {
          wholesaleMinor: 0,
          retailMinor: 0,
          priceMinor: 0,
          renewalRetailMinor: 0,
          currency: 'INR',
        },
      });
      domains = [backfilled, ...domains];
    } catch (err) {
      // If a unique race or older data inconsistency blocks the backfill, keep
      // the list endpoint readable and let support clean the duplicate row.
      console.warn('[domain-reseller] legacy custom domain backfill skipped:', err?.message || err);
    }
  }

  return {
    domains: domains.map((domain) => serializeDomain(domain, subscription)),
    summary: summarizeDomains(domains, subscription),
    subscriptionDomain: subscription || null,
    renewalWindows: renewalNoticeWindows(new Date()).map((item) => ({
      days: item.days,
      start: item.start.toISOString(),
      end: item.end.toISOString(),
    })),
    defaultTlds: [...DEFAULT_SEARCH_TLDS],
  };
}

async function findOwnedDomain({ prisma = prismaDefault, businessId, id }) {
  requireDomainDelegate(prisma);
  const domain = await prisma.domain.findFirst({ where: { id, businessId } });
  if (!domain) throw domainError('Domain not found.', 404, 'DOMAIN_NOT_FOUND');
  return domain;
}

async function checkCustomDomainConflict({ prisma, businessId, domainName }) {
  const claimDomains = customDomainClaimDomains(domainName);
  const existing = await prisma.subscription.findFirst({
    where: {
      customDomain: { in: claimDomains },
      NOT: { businessId },
    },
    select: { businessId: true, customDomain: true },
  }).catch(() => null);
  if (existing) {
    throw domainError(
      'This domain is already connected to another Sitepresso business.',
      409,
      'CUSTOM_DOMAIN_IN_USE',
      { domain: domainName }
    );
  }
}

async function bindDomainOverlay({
  prisma = prismaDefault,
  businessId,
  domainName,
  domainId = null,
  allowApexPending = true,
} = {}) {
  const [business, subscription] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, slug: true, vertical: true },
    }),
    prisma.subscription.findUnique({
      where: { businessId },
      select: {
        customDomain: true,
        customHostnameId: true,
        customDomainVerified: true,
        customDomainStatus: true,
      },
    }).catch(() => null),
  ]);
  if (!business || !subscription) {
    return {
      bound: false,
      status: 'PENDING',
      message: 'Domain saved. Custom-domain binding will run after the subscription is ready.',
    };
  }

  await checkCustomDomainConflict({ prisma, businessId, domainName });

  const provisioning = await provisionCustomDomain({
    domain: domainName,
    business,
    priorSubscription: subscription,
    allowApexPending,
  });
  if (provisioning.blockedBySuggestion) {
    return {
      bound: false,
      status: 'PENDING_DNS',
      message: provisioning.suggestion?.message || 'DNS needs one more step before activation.',
      instructions: provisioning.suggestion?.instructions || provisioning.instructions || null,
    };
  }

  const domainStatus = provisioning.domainStatus || {
    verified: false,
    status: 'PENDING_DNS',
    message: 'Waiting for DNS to point at Sitepresso.',
  };
  const subscriptionUpdate = {
    customDomain: domainName,
    customHostnameId: provisioning.customHostnameId,
    customDomainVerified: Boolean(domainStatus.verified),
    customDomainStatus: domainStatus.status,
    customDomainStatusMessage: domainStatus.message,
    customDomainCheckedAt: new Date(),
  };
  await prisma.subscription.update({
    where: { businessId },
    data: subscriptionUpdate,
  });
  if (domainId) {
    await prisma.domain.update({
      where: { id: domainId },
      data: {
        customHostnameId: provisioning.customHostnameId || undefined,
        statusMessage: domainStatus.message,
      },
    }).catch(() => null);
  }
  return {
    bound: true,
    provider: provisioning.provider,
    status: domainStatus.status,
    message: domainStatus.message,
    verified: Boolean(domainStatus.verified),
    instructions: provisioning.instructions || null,
  };
}

async function currentPrimaryDomain({ prisma = prismaDefault, businessId } = {}) {
  if (!prisma.subscription?.findUnique) return null;
  const subscription = await prisma.subscription.findUnique({
    where: { businessId },
    select: {
      customDomain: true,
      customHostnameId: true,
      customDomainVerified: true,
      customDomainStatus: true,
      customDomainStatusMessage: true,
      customDomainCheckedAt: true,
    },
  }).catch(() => null);
  return subscription?.customDomain ? subscription : null;
}

async function provisionRedirectAlias({
  prisma = prismaDefault,
  businessId,
  domainName,
  domainId = null,
  allowApexPending = true,
} = {}) {
  requireDomainDelegate(prisma);
  const cleanDomain = assertValidDomainName(normalizeDomainName(domainName));
  const [business, subscription, existingDomain] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, slug: true, vertical: true },
    }),
    currentPrimaryDomain({ prisma, businessId }),
    domainId
      ? prisma.domain.findFirst({ where: { id: domainId, businessId } }).catch(() => null)
      : prisma.domain.findUnique({ where: { name: cleanDomain } }).catch(() => null),
  ]);

  if (!business || !subscription?.customDomain) {
    return {
      bound: false,
      role: 'PARKED',
      status: 'PARKED',
      message: 'Choose a primary domain first, then extra domains can redirect to it.',
      redirectTo: null,
    };
  }

  const primaryName = normalizeDomainName(subscription.customDomain);
  if (primaryName === cleanDomain) {
    return bindDomainOverlay({ prisma, businessId, domainName: cleanDomain, domainId, allowApexPending });
  }

  await checkCustomDomainConflict({ prisma, businessId, domainName: cleanDomain });

  const aliasPrior = existingDomain?.customHostnameId
    ? {
        customHostnameId: existingDomain.customHostnameId,
        customDomainVerified: true,
        customDomainStatus: 'ACTIVE',
      }
    : null;
  const provisioning = await provisionCustomDomain({
    domain: cleanDomain,
    business,
    priorSubscription: aliasPrior,
    allowApexPending,
  });

  const domainStatus = provisioning.domainStatus || {
    verified: false,
    status: 'PENDING_DNS',
    message: provisioning.suggestion?.message || 'Waiting for DNS to point at Sitepresso.',
  };
  const statusMessage = provisioning.suggestion?.message || domainStatus.message;
  const instructions = provisioning.instructions || provisioning.suggestion?.instructions || null;

  if (domainId) {
    await prisma.domain.update({
      where: { id: domainId },
      data: {
        customHostnameId: provisioning.customHostnameId || existingDomain?.customHostnameId || undefined,
        statusMessage: `Redirects to ${primaryName}. ${statusMessage}`,
      },
    }).catch(() => null);
  }

  return {
    bound: !provisioning.blockedBySuggestion,
    provider: provisioning.provider,
    role: 'REDIRECT',
    redirectTo: primaryName,
    status: domainStatus.status,
    message: statusMessage,
    verified: Boolean(domainStatus.verified),
    instructions,
  };
}

async function shouldBindAsPrimary({ prisma = prismaDefault, businessId, bindDomain = true } = {}) {
  if (!bindDomain) return false;
  const subscription = await currentPrimaryDomain({ prisma, businessId });
  return !subscription?.customDomain;
}

async function createDomainRow({
  prisma,
  businessId,
  domainName,
  registrar,
  registrarRef = null,
  status,
  statusMessage = null,
  expiresAt = null,
  registeredAt = null,
  autoRenew = true,
  privacyEnabled = false,
  trusteeEnabled = false,
  price = {},
} = {}) {
  const tld = tldFromDomain(domainName);
  const starterPrice = starterPriceForTld(tld);
  return prisma.domain.create({
    data: {
      businessId,
      name: domainName,
      tld,
      registrar,
      registrarRef,
      status,
      statusMessage,
      registeredAt: registeredAt ? new Date(registeredAt) : null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      autoRenew,
      privacyEnabled,
      trusteeEnabled,
      wholesaleMinor: price.wholesaleMinor ?? starterPrice.wholesaleMinor,
      retailMinor: price.priceMinor ?? price.retailMinor ?? starterPrice.retailMinor,
      renewalRetailMinor: price.renewalPriceMinor ?? price.renewalRetailMinor ?? starterPrice.renewalRetailMinor ?? starterPrice.retailMinor,
      currency: price.currency || starterPrice.currency || 'INR',
    },
  });
}

async function quoteDomainRegistration({
  domainName,
  years = 1,
  confirmPremium = false,
  adapters = createDefaultAdapters(),
  targetCurrency,
} = {}) {
  const cleanDomain = assertValidDomainName(normalizeDomainName(domainName));
  const tld = tldFromDomain(cleanDomain);
  const route = resolveRegistrarForTld(tld);
  if (!route.supported) {
    throw domainError('This TLD is not supported for in-platform registration yet.', 422, 'TLD_UNSUPPORTED', { tld, reason: route.reason });
  }

  const search = await searchAvailableAcrossRegistrars(cleanDomain, { tlds: [tld], adapters });
  let match = search.results.find((item) => item.domainName === cleanDomain);
  if (targetCurrency && match) {
    match = await localizeDomainResult(match, targetCurrency);
  }
  if (!match || !match.available) {
    throw domainError('This domain is not available to register.', 409, 'DOMAIN_NOT_AVAILABLE');
  }
  if (match.premium && !confirmPremium) {
    throw domainError('This is a premium domain. Confirm the premium price before continuing.', 409, 'PREMIUM_DOMAIN_CONFIRMATION_REQUIRED', { result: match });
  }

  return {
    domainName: cleanDomain,
    tld,
    route,
    years: normalizeYears(years),
    match,
  };
}

async function assertDomainCanStartRegistration({ prisma, businessId, domainName }) {
  const existing = await prisma.domain.findUnique({ where: { name: domainName } });
  if (!existing) return null;
  if (existing.businessId !== businessId) {
    throw domainError('This domain is already managed in Sitepresso.', 409, 'DOMAIN_ALREADY_MANAGED');
  }
  if (existing.status !== 'PENDING' && existing.status !== 'FAILED') {
    throw domainError('This domain is already managed in Sitepresso.', 409, 'DOMAIN_ALREADY_MANAGED');
  }
  return existing;
}

function domainRegistrationCustomData({
  business,
  user,
  domainName,
  tld,
  registrar,
  years,
  privacyEnabled,
  trusteeEnabled,
  match,
}) {
  const amount = quoteDomainAmountMinor(match, years);
  const privacyMinor = privacyEnabled ? privacyRetailMinor(match.currency) * amount.years : 0;
  return {
    kind: DOMAIN_REGISTRATION_PAYMENT_KIND,
    businessId: business.id,
    businessSlug: business.slug,
    businessName: business.name || null,
    userId: user?.id || null,
    userEmail: user?.email || null,
    domainName,
    tld,
    registrar,
    years: amount.years,
    privacyEnabled: Boolean(privacyEnabled),
    trusteeEnabled: Boolean(trusteeEnabled || match.requiresTrustee),
    premium: Boolean(match.premium),
    retailMinor: asMinor(match.priceMinor ?? match.retailMinor),
    renewalRetailMinor: asMinor(match.renewalPriceMinor ?? match.renewalRetailMinor ?? match.priceMinor ?? match.retailMinor),
    checkoutSubtotalMinor: amount.subtotalMinor,
    checkoutDiscountMinor: amount.discountMinor,
    checkoutPrivacyMinor: privacyMinor,
    checkoutTotalMinor: amount.totalMinor + privacyMinor,
    wholesaleMinor: asMinor(match.wholesaleMinor),
    currency: String(match.currency || 'INR').toUpperCase(),
  };
}

function domainRenewalAmount(domain, years = 1) {
  const normalizedYears = normalizeYears(years);
  const unitMinor = asMinor(domain?.renewalRetailMinor ?? domain?.retailMinor, 0);
  return {
    years: normalizedYears,
    unitMinor,
    totalMinor: Math.max(0, unitMinor * normalizedYears),
    currency: String(domain?.currency || 'INR').toUpperCase(),
  };
}

function domainRenewalCustomData({
  business,
  user,
  domain,
  years,
}) {
  const amount = domainRenewalAmount(domain, years);
  return {
    kind: DOMAIN_RENEWAL_PAYMENT_KIND,
    businessId: business.id,
    businessSlug: business.slug,
    businessName: business.name || null,
    userId: user?.id || null,
    userEmail: user?.email || null,
    domainId: domain.id,
    domainName: domain.name,
    tld: domain.tld,
    registrar: domain.registrar,
    years: amount.years,
    renewalRetailMinor: amount.unitMinor,
    checkoutTotalMinor: amount.totalMinor,
    currency: amount.currency,
  };
}

function buildDomainPaddleTransactionPayload({ paddleCustomerId, customData, match }) {
  const amount = asMinor(customData.checkoutTotalMinor, asMinor(match.priceMinor ?? match.retailMinor));
  const currency = String(match.currency || 'INR').toUpperCase();
  const years = normalizeYears(customData.years);
  const discountText = customData.checkoutDiscountMinor > 0 ? ' Includes a multi-year discount.' : '';
  return {
    items: [
      {
        quantity: 1,
        price: {
          description: `Domain registration and management for ${customData.domainName}`,
          name: `Domain registration - ${customData.domainName} (${years} yr${years === 1 ? '' : 's'})`,
          billing_cycle: null,
          trial_period: null,
          unit_price: {
            amount: String(amount),
            currency_code: currency,
          },
          product: {
            name: 'Sitepresso domain registration',
            tax_category: 'standard',
            description: `Register ${customData.domainName} through Sitepresso for ${years} year${years === 1 ? '' : 's'}.${discountText}`,
          },
        },
      },
    ],
    currency_code: currency,
    collection_mode: 'automatic',
    customer_id: paddleCustomerId || undefined,
    custom_data: customData,
  };
}

function buildDomainRenewalPaddleTransactionPayload({ paddleCustomerId, customData }) {
  const amount = asMinor(customData.checkoutTotalMinor, 0);
  const currency = String(customData.currency || 'INR').toUpperCase();
  const years = normalizeYears(customData.years);
  return {
    items: [
      {
        quantity: 1,
        price: {
          description: `Domain renewal for ${customData.domainName}`,
          name: `Domain renewal - ${customData.domainName} (${years} yr${years === 1 ? '' : 's'})`,
          billing_cycle: null,
          trial_period: null,
          unit_price: {
            amount: String(amount),
            currency_code: currency,
          },
          product: {
            name: 'Sitepresso domain renewal',
            tax_category: 'standard',
            description: `Renew ${customData.domainName} through Sitepresso for ${years} year${years === 1 ? '' : 's'}.`,
          },
        },
      },
    ],
    currency_code: currency,
    collection_mode: 'automatic',
    customer_id: paddleCustomerId || undefined,
    custom_data: customData,
  };
}

async function ensurePaddleCustomerForDomain({ prisma, business, user }) {
  const subscription = await prisma.subscription.findUnique({
    where: { businessId: business.id },
    select: { paddleCustomerId: true },
  }).catch(() => null);
  if (subscription?.paddleCustomerId) return subscription.paddleCustomerId;

  try {
    const customer = await createPaddleCustomer({
      email: business.billingEmail || business.email || user?.email,
      name: billingNameForBusiness(business),
      custom_data: {
        businessId: business.id,
        businessSlug: business.slug,
        businessName: business.name,
        userId: user?.id || null,
        userEmail: user?.email || null,
        billingPurchaserType: business.billingPurchaserType || 'INDIVIDUAL',
        billingBusinessName: business.billingBusinessName || null,
        billingTaxId: business.billingTaxId || null,
        billingCountry: business.billingCountry || business.country || null,
      },
    });
    const paddleCustomerId = customer?.id || null;
    if (paddleCustomerId) {
      await prisma.subscription.update({
        where: { businessId: business.id },
        data: { paddleCustomerId },
      }).catch(() => null);
    }
    return paddleCustomerId;
  } catch (customerErr) {
    const existingCustomerId = extractPaddleCustomerIdFromConflict(customerErr);
    if (!existingCustomerId) throw customerErr;
    await prisma.subscription.update({
      where: { businessId: business.id },
      data: { paddleCustomerId: existingCustomerId },
    }).catch(() => null);
    return existingCustomerId;
  }
}

async function upsertPendingDomainRegistration({
  prisma,
  existing,
  businessId,
  domainName,
  registrar,
  transactionId,
  privacyEnabled,
  trusteeEnabled,
  match,
}) {
  const data = {
    registrar,
    registrarRef: transactionId ? `PADDLE:${transactionId}` : null,
    registrationPaddleTransactionId: transactionId || null,
    status: 'PENDING',
    statusMessage: 'Payment pending. Registration starts immediately after checkout completes.',
    registeredAt: null,
    expiresAt: null,
    autoRenew: true,
    privacyEnabled,
    trusteeEnabled: trusteeEnabled || Boolean(match.requiresTrustee),
    wholesaleMinor: asMinor(match.wholesaleMinor, starterPriceForTld(tldFromDomain(domainName)).wholesaleMinor),
    retailMinor: asMinor(match.priceMinor ?? match.retailMinor, starterPriceForTld(tldFromDomain(domainName)).retailMinor),
    renewalRetailMinor: asMinor(
      match.renewalPriceMinor ?? match.renewalRetailMinor ?? match.priceMinor ?? match.retailMinor,
      starterPriceForTld(tldFromDomain(domainName)).renewalRetailMinor
    ),
    currency: String(match.currency || 'INR').toUpperCase(),
  };

  if (existing) {
    return prisma.domain.update({
      where: { id: existing.id },
      data,
    });
  }

  return prisma.domain.create({
    data: {
      businessId,
      name: domainName,
      tld: tldFromDomain(domainName),
      ...data,
    },
  });
}

async function createDomainRegistrationCheckout({
  prisma = prismaDefault,
  businessId,
  domainName,
  years = 1,
  privacyEnabled = true,
  trusteeEnabled = false,
  confirmPremium = false,
  user = null,
  req = null,
  adapters = createDefaultAdapters(),
  bindDomain = true,
} = {}) {
  requireDomainDelegate(prisma);
  if (!businessId) throw domainError('Business scope is required.', 400, 'BUSINESS_REQUIRED');

  const [business, subscription] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        slug: true,
        name: true,
        email: true,
        country: true,
        billingPurchaserType: true,
        billingBusinessName: true,
        billingContactName: true,
        billingEmail: true,
        billingTaxId: true,
        billingCountry: true,
        billingAddressLine1: true,
        billingAddressLine2: true,
        billingCity: true,
        billingState: true,
        billingPostalCode: true,
        paddleBillingAddressId: true,
        paddleBillingBusinessId: true,
      },
    }),
    prisma.subscription.findUnique({
      where: { businessId },
      select: { paddleCustomerId: true },
    }).catch(() => null),
  ]);
  if (!business) throw domainError('Business not found.', 404, 'BUSINESS_NOT_FOUND');

  const targetCurrency = await currencyForCountry(business.billingCountry || business.country, prisma);
  const quote = await quoteDomainRegistration({
    domainName,
    years,
    confirmPremium,
    adapters,
    targetCurrency,
  });
  const existing = await assertDomainCanStartRegistration({ prisma, businessId, domainName: quote.domainName });

  if (!isPaddleConfigured()) {
    if (getDomainResellerMode() === MODE_LIVE) {
      throw domainError('Paddle must be configured before live domain registration.', 503, 'PADDLE_REQUIRED_FOR_DOMAIN_REGISTRATION');
    }
    const direct = await registerManagedDomain({
      prisma,
      businessId,
      domainName: quote.domainName,
      years: quote.years,
      privacyEnabled,
      trusteeEnabled,
      confirmPremium: true,
      adapters,
      bindDomain,
    });
    return {
      action: 'registered',
      ...direct,
      message: `${quote.domainName} is registered and activation has started.`,
    };
  }

  let paddleCustomerId = subscription?.paddleCustomerId || null;
  if (!paddleCustomerId) {
    paddleCustomerId = await ensurePaddleCustomerForDomain({ prisma, business, user });
  }
  const paddleBillingProfile = await ensurePaddleBillingProfile({
    business,
    paddleCustomerId,
    user,
    tx: prisma,
  }).catch((err) => {
    console.error('[domain checkout] Paddle billing profile sync failed:', err?.message || err);
    return { addressId: null, businessId: null };
  });

  const customData = domainRegistrationCustomData({
    business,
    user,
    domainName: quote.domainName,
    tld: quote.tld,
    registrar: quote.route.registrar,
    years: quote.years,
    privacyEnabled,
    trusteeEnabled,
    match: quote.match,
  });
  const payload = buildDomainPaddleTransactionPayload({
    paddleCustomerId,
    customData,
    match: quote.match,
  });
  if (paddleBillingProfile.addressId) payload.address_id = paddleBillingProfile.addressId;
  if (paddleBillingProfile.businessId) payload.business_id = paddleBillingProfile.businessId;
  const transaction = await createPaddleTransaction(payload);
  await recordCheckoutCreated({
    businessId,
    productKind: 'DOMAIN',
    checkoutKind: DOMAIN_REGISTRATION_PAYMENT_KIND,
    transaction,
    expectedCurrencyCode: customData.currency || quote.match?.currency || null,
    expectedAmountMinor: Number(customData.checkoutTotalMinor || 0) || null,
    metadata: customData,
  }).catch((ledgerErr) => {
    console.error('[domain checkout] billing ledger checkout write failed', ledgerErr?.message || ledgerErr);
  });
  const launcherUrl = buildDomainCheckoutLauncherUrl(req, business);
  const checkoutUrl = buildCheckoutOpenUrl(launcherUrl, transaction?.id || null);
  if (!checkoutUrl) {
    throw domainError('Could not build a checkout URL for this domain registration.', 502, 'DOMAIN_CHECKOUT_URL_FAILED');
  }

  const pending = await upsertPendingDomainRegistration({
    prisma,
    existing,
    businessId,
    domainName: quote.domainName,
    registrar: quote.route.registrar,
    transactionId: transaction?.id || null,
    privacyEnabled,
    trusteeEnabled,
    match: quote.match,
  });

  return {
    action: 'checkout',
    checkoutUrl,
    transactionId: transaction?.id || null,
    domain: serializeDomain(pending),
    search: quote.match,
    message: `Continue to secure checkout to register ${quote.domainName}.`,
  };
}

async function createDomainRenewalCheckout({
  prisma = prismaDefault,
  businessId,
  id,
  years = 1,
  user = null,
  req = null,
} = {}) {
  requireDomainDelegate(prisma);
  if (!businessId) throw domainError('Business scope is required.', 400, 'BUSINESS_REQUIRED');

  const domain = await findOwnedDomain({ prisma, businessId, id });
  if (domain.registrar === 'BYOD') throw domainError('BYOD domains are renewed at their external registrar.', 422, 'BYOD_RENEW_UNSUPPORTED');
  if (!domain.registrarRef || String(domain.registrarRef).startsWith('PADDLE:')) {
    throw domainError('Domain registrar reference is missing; renewal cannot start.', 409, 'DOMAIN_RENEWAL_REGISTRAR_REF_MISSING', { domain: serializeDomain(domain) });
  }
  if (!RENEWABLE_DOMAIN_STATUSES.has(domain.status)) {
    throw domainError('This domain is not in a renewable state.', 409, 'DOMAIN_NOT_RENEWABLE', { domain: serializeDomain(domain) });
  }

  const amount = domainRenewalAmount(domain, years);
  if (amount.totalMinor <= 0) {
    throw domainError('Domain renewal pricing is not configured.', 503, 'DOMAIN_RENEWAL_PRICE_MISSING', { domain: serializeDomain(domain) });
  }

  if (!isPaddleConfigured()) {
    if (getDomainResellerMode() === MODE_LIVE) {
      throw domainError('Paddle must be configured before live domain renewal.', 503, 'PADDLE_REQUIRED_FOR_DOMAIN_RENEWAL');
    }
    const direct = await renewDomain({
      prisma,
      businessId,
      id,
      years: amount.years,
      paymentConfirmed: true,
    });
    return {
      action: 'renewed',
      ...direct,
      message: `${domain.name} was renewed.`,
    };
  }

  const [business, subscription] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        slug: true,
        name: true,
        email: true,
        country: true,
        billingPurchaserType: true,
        billingBusinessName: true,
        billingContactName: true,
        billingEmail: true,
        billingTaxId: true,
        billingCountry: true,
        billingAddressLine1: true,
        billingAddressLine2: true,
        billingCity: true,
        billingState: true,
        billingPostalCode: true,
        paddleBillingAddressId: true,
        paddleBillingBusinessId: true,
      },
    }),
    prisma.subscription.findUnique({
      where: { businessId },
      select: { paddleCustomerId: true, customDomain: true },
    }).catch(() => null),
  ]);
  if (!business) throw domainError('Business not found.', 404, 'BUSINESS_NOT_FOUND');

  const launcherUrl = buildDomainCheckoutLauncherUrl(req, business);
  if (domain.renewalPaymentStatus === 'PENDING' && domain.renewalPaddleTransactionId) {
    return {
      action: 'checkout',
      checkoutUrl: buildCheckoutOpenUrl(launcherUrl, domain.renewalPaddleTransactionId),
      transactionId: domain.renewalPaddleTransactionId,
      domain: serializeDomain(domain, subscription),
      message: `${domain.name} already has a pending renewal checkout.`,
    };
  }

  let paddleCustomerId = subscription?.paddleCustomerId || null;
  if (!paddleCustomerId) {
    paddleCustomerId = await ensurePaddleCustomerForDomain({ prisma, business, user });
  }
  const paddleBillingProfile = await ensurePaddleBillingProfile({
    business,
    paddleCustomerId,
    user,
    tx: prisma,
  }).catch((err) => {
    console.error('[domain renewal checkout] Paddle billing profile sync failed:', err?.message || err);
    return { addressId: null, businessId: null };
  });

  const customData = domainRenewalCustomData({
    business,
    user,
    domain,
    years: amount.years,
  });
  const payload = buildDomainRenewalPaddleTransactionPayload({
    paddleCustomerId,
    customData,
  });
  if (paddleBillingProfile.addressId) payload.address_id = paddleBillingProfile.addressId;
  if (paddleBillingProfile.businessId) payload.business_id = paddleBillingProfile.businessId;

  const transaction = await createPaddleTransaction(payload);
  await recordCheckoutCreated({
    businessId,
    productKind: 'DOMAIN',
    checkoutKind: DOMAIN_RENEWAL_PAYMENT_KIND,
    transaction,
    expectedCurrencyCode: customData.currency || null,
    expectedAmountMinor: Number(customData.checkoutTotalMinor || 0) || null,
    metadata: customData,
  }).catch((ledgerErr) => {
    console.error('[domain renewal checkout] billing ledger checkout write failed', ledgerErr?.message || ledgerErr);
  });
  const checkoutUrl = buildCheckoutOpenUrl(launcherUrl, transaction?.id || null);
  if (!checkoutUrl) {
    throw domainError('Could not build a checkout URL for this domain renewal.', 502, 'DOMAIN_RENEWAL_CHECKOUT_URL_FAILED');
  }

  const minDueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const expiresAt = domain.expiresAt ? new Date(domain.expiresAt) : null;
  const dueAt = expiresAt && expiresAt > minDueAt ? expiresAt : minDueAt;
  const pending = await prisma.domain.update({
    where: { id: domain.id },
    data: {
      renewalPaddleTransactionId: transaction?.id || null,
      renewalPaymentStatus: 'PENDING',
      renewalPaymentDueAt: dueAt,
      renewalYears: amount.years,
      status: domain.status === 'ACTIVE' ? domain.status : 'EXPIRING',
      statusMessage: 'Renewal payment pending. Registrar renewal starts after checkout completes.',
    },
  });

  return {
    action: 'checkout',
    checkoutUrl,
    transactionId: transaction?.id || null,
    domain: serializeDomain(pending, subscription),
    message: `Continue to secure checkout to renew ${domain.name}.`,
  };
}

async function registerManagedDomain({
  prisma = prismaDefault,
  businessId,
  domainName,
  years = 1,
  privacyEnabled = true,
  trusteeEnabled = false,
  confirmPremium = false,
  adapters = createDefaultAdapters(),
  bindDomain = true,
} = {}) {
  requireDomainDelegate(prisma);
  const cleanDomain = assertValidDomainName(normalizeDomainName(domainName));
  const tld = tldFromDomain(cleanDomain);
  const route = resolveRegistrarForTld(tld);
  if (!route.supported) {
    throw domainError('This TLD is not supported for in-platform registration yet.', 422, 'TLD_UNSUPPORTED', { tld, reason: route.reason });
  }

  const existing = await prisma.domain.findUnique({ where: { name: cleanDomain } });
  if (existing) throw domainError('This domain is already managed in Sitepresso.', 409, 'DOMAIN_ALREADY_MANAGED');

  const { match } = await quoteDomainRegistration({
    domainName: cleanDomain,
    years,
    confirmPremium,
    adapters,
  });
  if (
    getDomainResellerMode() === MODE_LIVE &&
    String(process.env.DOMAIN_RESELLER_ALLOW_UNPAID_LIVE || '').toLowerCase() !== 'true'
  ) {
    throw domainError('Payment confirmation is required before live domain registration.', 402, 'DOMAIN_PAYMENT_REQUIRED', { result: match });
  }

  const adapter = adapters[route.registrar] || getAdapterForTld(tld, adapters);
  if (!adapter) throw domainError('No registrar adapter is configured for this TLD.', 503, 'REGISTRAR_NOT_CONFIGURED');

  const registration = await adapter.register({
    domainName: cleanDomain,
    years: normalizeYears(years),
    privacyEnabled,
    trusteeEnabled,
  });
  const domain = await createDomainRow({
    prisma,
    businessId,
    domainName: cleanDomain,
    registrar: route.registrar,
    registrarRef: registration.registrarRef,
    status: 'ACTIVE',
    statusMessage: 'Domain registered. Custom-domain activation is in progress.',
    expiresAt: registration.expiresAt,
    registeredAt: new Date(),
    autoRenew: true,
    privacyEnabled,
    trusteeEnabled: trusteeEnabled || Boolean(match.requiresTrustee),
    price: match,
  });

  let binding = null;
  if (bindDomain) {
    const bindAsPrimary = await shouldBindAsPrimary({ prisma, businessId, bindDomain });
    binding = bindAsPrimary
      ? await bindDomainOverlay({ prisma, businessId, domainName: cleanDomain, domainId: domain.id })
      : await provisionRedirectAlias({ prisma, businessId, domainName: cleanDomain, domainId: domain.id });
  }
  const subscription = binding
    ? { customDomain: binding.role === 'REDIRECT' ? binding.redirectTo : cleanDomain, customDomainStatus: binding.status, customDomainStatusMessage: binding.message }
    : null;
  const fresh = await prisma.domain.findUnique({ where: { id: domain.id } });
  return { domain: serializeDomain(fresh || domain, subscription), binding, search: match };
}

async function completePaidDomainRegistration({
  prisma = prismaDefault,
  entity,
  adapters = createDefaultAdapters(),
  bindDomain = true,
} = {}) {
  if (!isDomainRegistrationPayment(entity)) return { handled: false };
  requireDomainDelegate(prisma);

  const data = entity.custom_data || {};
  const businessId = data.businessId;
  const cleanDomain = assertValidDomainName(normalizeDomainName(data.domainName));
  if (!businessId) throw domainError('Domain payment is missing business scope.', 400, 'DOMAIN_PAYMENT_BUSINESS_REQUIRED');
  assertDomainPaymentSnapshotMatches(entity);

  let domain = await prisma.domain.findUnique({ where: { name: cleanDomain } });
  if (domain && domain.businessId !== businessId) {
    throw domainError('Paid domain registration belongs to another business.', 409, 'DOMAIN_PAYMENT_DOMAIN_CONFLICT');
  }
  if (domain?.status === 'ACTIVE') {
    if (entity?.id && domain.registrationPaddleTransactionId && domain.registrationPaddleTransactionId !== entity.id) {
      throw domainError('Domain payment reference does not match the completed registration.', 409, 'DOMAIN_PAYMENT_REFERENCE_MISMATCH');
    }
    return { handled: true, idempotent: true, domain: serializeDomain(domain), transactionId: entity?.id || null };
  }

  const tld = tldFromDomain(cleanDomain);
  const route = resolveRegistrarForTld(tld);
  if (!route.supported) {
    throw domainError('This TLD is not supported for in-platform registration yet.', 422, 'TLD_UNSUPPORTED', { tld, reason: route.reason });
  }
  const registrar = data.registrar || route.registrar;
  const starterPrice = starterPriceForTld(tld);
  const price = {
    wholesaleMinor: asMinor(data.wholesaleMinor, starterPrice.wholesaleMinor),
    priceMinor: asMinor(data.retailMinor, starterPrice.retailMinor),
    renewalPriceMinor: asMinor(data.renewalRetailMinor, starterPrice.renewalRetailMinor || starterPrice.retailMinor),
    currency: String(data.currency || starterPrice.currency || 'INR').toUpperCase(),
    requiresTrustee: asBool(data.trusteeEnabled, Boolean(starterPrice.requiresTrustee)),
  };

  if (!domain) {
    domain = await createDomainRow({
      prisma,
      businessId,
      domainName: cleanDomain,
      registrar,
      registrarRef: entity?.id ? `PADDLE:${entity.id}` : null,
      status: 'PENDING',
      statusMessage: 'Payment received. Registration is starting.',
      autoRenew: true,
      privacyEnabled: asBool(data.privacyEnabled, true),
      trusteeEnabled: asBool(data.trusteeEnabled, Boolean(price.requiresTrustee)),
      price,
    });
  }

  const expectedPaymentRef = entity?.id ? `PADDLE:${entity.id}` : null;
  if (expectedPaymentRef && domain.registrarRef && domain.registrarRef.startsWith('PADDLE:') && domain.registrarRef !== expectedPaymentRef) {
    throw domainError('Domain payment reference does not match the pending registration.', 409, 'DOMAIN_PAYMENT_REFERENCE_MISMATCH');
  }

  const adapter = adapters[registrar] || getAdapterForTld(tld, adapters);
  if (!adapter) throw domainError('No registrar adapter is configured for this TLD.', 503, 'REGISTRAR_NOT_CONFIGURED');

  let registration;
  try {
    registration = await adapter.register({
      domainName: cleanDomain,
      years: normalizeYears(data.years),
      privacyEnabled: asBool(data.privacyEnabled, true),
      trusteeEnabled: asBool(data.trusteeEnabled, Boolean(price.requiresTrustee)),
    });
  } catch (err) {
    await prisma.domain.update({
      where: { id: domain.id },
      data: {
        status: 'FAILED',
        autoRenew: false,
        statusMessage: `Payment succeeded, but registrar registration failed: ${err?.message || 'unknown error'}`,
      },
    }).catch(() => null);
    if (entity?.id) {
      const refundAmount = asMinor(data.checkoutTotalMinor, asMinor(data.retailMinor, 0));
      try {
        const adjustment = await refundPaddleTransaction({
          transactionId: entity.id,
          amountMinor: refundAmount,
          reason: 'domain_registration_failed',
        });
        return {
          handled: true,
          idempotent: false,
          failed: true,
          refundRequested: true,
          refundAdjustmentId: adjustment?.id || null,
          transactionId: entity.id,
          domain: serializeDomain(await prisma.domain.findUnique({ where: { id: domain.id } }).catch(() => null) || domain),
        };
      } catch (refundErr) {
        await prisma.domain.update({
          where: { id: domain.id },
          data: {
            statusMessage: `Payment succeeded and registrar registration failed. Refund request also failed: ${refundErr?.message || 'unknown error'}`,
          },
        }).catch(() => null);
        throw refundErr;
      }
    }
    throw err;
  }

  let updated = await prisma.domain.update({
    where: { id: domain.id },
    data: {
      registrar,
      registrarRef: registration.registrarRef || domain.registrarRef || expectedPaymentRef,
      registrationPaddleTransactionId: entity?.id || domain.registrationPaddleTransactionId || null,
      status: 'ACTIVE',
      statusMessage: 'Domain registered. Custom-domain activation is in progress.',
      registeredAt: new Date(),
      expiresAt: registration.expiresAt ? new Date(registration.expiresAt) : domain.expiresAt,
      autoRenew: true,
      privacyEnabled: asBool(data.privacyEnabled, true),
      trusteeEnabled: asBool(data.trusteeEnabled, Boolean(price.requiresTrustee)),
    },
  });

  let binding = null;
  if (bindDomain) {
    try {
      const bindAsPrimary = await shouldBindAsPrimary({ prisma, businessId, bindDomain });
      binding = bindAsPrimary
        ? await bindDomainOverlay({ prisma, businessId, domainName: cleanDomain, domainId: updated.id })
        : await provisionRedirectAlias({ prisma, businessId, domainName: cleanDomain, domainId: updated.id });
      updated = await prisma.domain.findUnique({ where: { id: updated.id } }) || updated;
    } catch (err) {
      await prisma.domain.update({
        where: { id: updated.id },
        data: {
          statusMessage: `Domain registered. Custom-domain activation needs attention: ${err?.message || 'unknown error'}`,
        },
      }).catch(() => null);
    }
  }

  const subscription = binding
    ? { customDomain: binding.role === 'REDIRECT' ? binding.redirectTo : cleanDomain, customDomainStatus: binding.status, customDomainStatusMessage: binding.message }
    : await prisma.subscription.findUnique({ where: { businessId }, select: { customDomain: true } }).catch(() => null);

  return {
    handled: true,
    idempotent: false,
    transactionId: entity?.id || null,
    domain: serializeDomain(updated, subscription),
    binding,
  };
}

async function completePaidDomainRenewal({
  prisma = prismaDefault,
  entity,
  adapters = createDefaultAdapters(),
} = {}) {
  if (!isDomainRenewalPayment(entity)) return { handled: false };
  requireDomainDelegate(prisma);

  const data = entity.custom_data || {};
  const businessId = data.businessId;
  const cleanDomain = assertValidDomainName(normalizeDomainName(data.domainName));
  if (!businessId) throw domainError('Domain renewal payment is missing business scope.', 400, 'DOMAIN_RENEWAL_BUSINESS_REQUIRED');
  assertDomainPaymentSnapshotMatches(entity);

  let domain = await prisma.domain.findFirst({
    where: {
      OR: [
        ...(data.domainId ? [{ id: data.domainId, businessId }] : []),
        { name: cleanDomain, businessId },
        ...(entity?.id ? [{ renewalPaddleTransactionId: entity.id, businessId }] : []),
      ],
    },
  });
  if (!domain) throw domainError('No matching domain renewal was found for this payment.', 404, 'DOMAIN_RENEWAL_NOT_FOUND');
  if (domain.businessId !== businessId) {
    throw domainError('Paid domain renewal belongs to another business.', 409, 'DOMAIN_RENEWAL_DOMAIN_CONFLICT');
  }
  if (domain.name !== cleanDomain) {
    throw domainError('Paddle renewal domain does not match the managed domain.', 409, 'DOMAIN_RENEWAL_DOMAIN_MISMATCH');
  }
  if (domain.registrar === 'BYOD') throw domainError('BYOD domains are renewed at their external registrar.', 422, 'BYOD_RENEW_UNSUPPORTED');
  if (!domain.registrarRef || String(domain.registrarRef).startsWith('PADDLE:')) {
    throw domainError('Domain registrar reference is missing; renewal cannot start.', 409, 'DOMAIN_RENEWAL_REGISTRAR_REF_MISSING');
  }

  if (entity?.id && domain.renewalPaddleTransactionId && domain.renewalPaddleTransactionId !== entity.id) {
    throw domainError('Domain renewal payment reference does not match the pending renewal.', 409, 'DOMAIN_RENEWAL_REFERENCE_MISMATCH');
  }
  if (entity?.id && domain.renewalPaymentStatus === 'COMPLETED' && domain.renewalPaddleTransactionId === entity.id) {
    const subscription = await prisma.subscription.findUnique({ where: { businessId }, select: { customDomain: true } }).catch(() => null);
    return { handled: true, idempotent: true, transactionId: entity.id, domain: serializeDomain(domain, subscription) };
  }
  if (!RENEWABLE_DOMAIN_STATUSES.has(domain.status)) {
    throw domainError('This domain is not in a renewable state.', 409, 'DOMAIN_NOT_RENEWABLE', { domain: serializeDomain(domain) });
  }

  const adapter = adapters[domain.registrar] || getAdapterForTld(domain.tld, adapters);
  if (!adapter) throw domainError('No registrar adapter is configured for this TLD.', 503, 'REGISTRAR_NOT_CONFIGURED');

  let renewal;
  try {
    renewal = await adapter.renew(
      domain.registrarRef,
      normalizeYears(data.years || domain.renewalYears || 1),
      { domainName: domain.name }
    );
  } catch (err) {
    await prisma.domain.update({
      where: { id: domain.id },
      data: {
        renewalPaymentStatus: 'FAILED',
        autoRenew: false,
        statusMessage: `Payment succeeded, but registrar renewal failed: ${err?.message || 'unknown error'}`,
      },
    }).catch(() => null);
    if (entity?.id) {
      const refundAmount = asMinor(data.checkoutTotalMinor, asMinor(data.renewalRetailMinor, 0));
      try {
        const adjustment = await refundPaddleTransaction({
          transactionId: entity.id,
          amountMinor: refundAmount,
          reason: 'domain_renewal_failed',
        });
        return {
          handled: true,
          idempotent: false,
          failed: true,
          refundRequested: true,
          refundAdjustmentId: adjustment?.id || null,
          transactionId: entity.id,
          domain: serializeDomain(await prisma.domain.findUnique({ where: { id: domain.id } }).catch(() => null) || domain),
        };
      } catch (refundErr) {
        await prisma.domain.update({
          where: { id: domain.id },
          data: {
            statusMessage: `Payment succeeded and registrar renewal failed. Refund request also failed: ${refundErr?.message || 'unknown error'}`,
          },
        }).catch(() => null);
        throw refundErr;
      }
    }
    throw err;
  }

  const updated = await prisma.domain.update({
    where: { id: domain.id },
    data: {
      expiresAt: renewal.expiresAt ? new Date(renewal.expiresAt) : domain.expiresAt,
      status: 'ACTIVE',
      statusMessage: 'Domain renewed successfully.',
      autoRenew: true,
      renewalPaddleTransactionId: entity?.id || domain.renewalPaddleTransactionId || null,
      renewalPaymentStatus: 'COMPLETED',
      renewalPaymentDueAt: null,
      renewalYears: normalizeYears(data.years || domain.renewalYears || 1),
    },
  });
  const subscription = await prisma.subscription.findUnique({ where: { businessId }, select: { customDomain: true } }).catch(() => null);
  return {
    handled: true,
    idempotent: false,
    transactionId: entity?.id || null,
    domain: serializeDomain(updated, subscription),
  };
}

async function markDomainPaymentFailed({ prisma = prismaDefault, entity } = {}) {
  if (!isDomainRegistrationPayment(entity) && !isDomainRenewalPayment(entity)) return { handled: false };
  requireDomainDelegate(prisma);
  const data = entity.custom_data || {};
  const cleanDomain = normalizeDomainName(data.domainName);
  if (!cleanDomain || !data.businessId) return { handled: true, updated: 0 };

  if (isDomainRenewalPayment(entity)) {
    const result = await prisma.domain.updateMany({
      where: {
        businessId: data.businessId,
        OR: [
          ...(entity?.id ? [{ renewalPaddleTransactionId: entity.id }] : []),
          { name: cleanDomain, renewalPaymentStatus: 'PENDING' },
        ],
      },
      data: {
        renewalPaymentStatus: 'FAILED',
        autoRenew: false,
        statusMessage: 'Domain renewal checkout did not complete. Start renewal again when ready.',
      },
    });
    return { handled: true, updated: result?.count || 0 };
  }

  const result = await prisma.domain.updateMany({
    where: {
      name: cleanDomain,
      businessId: data.businessId,
      status: 'PENDING',
    },
    data: {
      status: 'FAILED',
      autoRenew: false,
      statusMessage: 'Domain checkout did not complete. Start registration again when ready.',
    },
  });
  return { handled: true, updated: result?.count || 0 };
}

async function handleDomainPaymentAdjustment({ prisma = prismaDefault, entity } = {}) {
  requireDomainDelegate(prisma);
  const transactionId = String(entity?.transaction_id || '').trim();
  if (!transactionId) return { handled: false };

  const domain = await prisma.domain.findFirst({
    where: {
      OR: [
        { registrarRef: `PADDLE:${transactionId}` },
        { registrationPaddleTransactionId: transactionId },
        { renewalPaddleTransactionId: transactionId },
      ],
    },
  }).catch(() => null);
  if (!domain) return { handled: false };

  const action = String(entity?.action || '').toLowerCase();
  const status = String(entity?.status || '').toLowerCase();
  if (!['refund', 'chargeback'].includes(action) || status !== 'approved') {
    return { handled: true, updated: 0 };
  }

  if (domain.status === 'PENDING') {
    const result = await prisma.domain.updateMany({
      where: { id: domain.id, status: 'PENDING' },
      data: {
        status: 'FAILED',
        autoRenew: false,
        statusMessage: 'Domain checkout was refunded or disputed before registration completed.',
      },
    });
    return { handled: true, updated: result?.count || 0 };
  }

  if (['ACTIVE', 'EXPIRING', 'LOCKED'].includes(domain.status)) {
    const renewalPaymentStatus = domain.renewalPaddleTransactionId === transactionId
      ? (action === 'chargeback' ? 'CHARGEBACK' : 'REFUNDED')
      : domain.renewalPaymentStatus;
    const updated = await prisma.domain.update({
      where: { id: domain.id },
      data: {
        status: 'LOCKED',
        autoRenew: false,
        renewalPaymentStatus,
        statusMessage: action === 'chargeback'
          ? 'Domain payment was disputed. Domain management is locked until billing is resolved.'
          : 'Domain payment was refunded. Domain management is locked and renewal reminders are disabled.',
      },
    });
    return { handled: true, updated: 1, domain: serializeDomain(updated) };
  }

  return { handled: true, updated: 0 };
}

async function syncPendingDomainRegistrationPayment({
  prisma = prismaDefault,
  businessId,
  transactionId = null,
  adapters = createDefaultAdapters(),
  bindDomain = true,
} = {}) {
  requireDomainDelegate(prisma);
  if (!businessId) throw domainError('Business scope is required.', 400, 'BUSINESS_REQUIRED');
  if (!isPaddleConfigured()) {
    throw domainError('Paddle is not configured.', 503, 'PADDLE_NOT_CONFIGURED');
  }

  const where = {
    businessId,
    OR: transactionId
      ? [
          { status: 'PENDING', registrarRef: `PADDLE:${transactionId}` },
          { renewalPaddleTransactionId: transactionId, renewalPaymentStatus: 'PENDING' },
        ]
      : [
          { status: 'PENDING', registrarRef: { startsWith: 'PADDLE:' } },
          { renewalPaymentStatus: 'PENDING', renewalPaddleTransactionId: { not: null } },
        ],
  };
  const pending = await prisma.domain.findFirst({
    where,
    orderBy: { updatedAt: 'desc' },
  });

  if (!pending?.registrarRef && !pending?.renewalPaddleTransactionId) {
    return {
      synced: false,
      message: 'No pending Paddle domain payment was found for this business.',
      domain: null,
    };
  }

  const txId = transactionId
    || pending.renewalPaddleTransactionId
    || pending.registrarRef.replace(/^PADDLE:/, '');
  const transaction = await getPaddleTransaction(txId);
  const status = String(transaction?.status || '').toLowerCase();
  const txBusinessId = paddleCustomBusinessId(transaction);
  if (txBusinessId && txBusinessId !== businessId) {
    throw domainError('This Paddle transaction does not belong to this business.', 403, 'DOMAIN_PAYMENT_OWNER_MISMATCH');
  }
  const txDomainName = paddleCustomDomainName(transaction);
  if (txDomainName && txDomainName !== pending.name) {
    throw domainError('This Paddle transaction does not belong to the pending domain payment.', 409, 'DOMAIN_PAYMENT_DOMAIN_MISMATCH');
  }

  if (status === 'completed') {
    if (!txBusinessId || txBusinessId !== businessId || !txDomainName || txDomainName !== pending.name) {
      throw domainError('Paddle transaction does not match the pending domain payment.', 409, 'DOMAIN_PAYMENT_REFERENCE_MISMATCH');
    }
    if (isDomainRenewalPayment(transaction)) {
      const result = await completePaidDomainRenewal({
        prisma,
        entity: transaction,
        adapters,
      });
      return {
        synced: true,
        status,
        ...result,
        message: `${pending.name} renewal payment is complete. Renewal has been reconciled.`,
      };
    }
    if (!isDomainRegistrationPayment(transaction)) {
      throw domainError('Paddle transaction does not match the pending domain payment.', 409, 'DOMAIN_PAYMENT_REFERENCE_MISMATCH');
    }
    const result = await completePaidDomainRegistration({
      prisma,
      entity: transaction,
      adapters,
      bindDomain,
    });
    return {
      synced: true,
      status,
      ...result,
      message: `${pending.name} payment is complete. Registration has been reconciled.`,
    };
  }

  if (status === 'canceled' || status === 'failed') {
    const result = await markDomainPaymentFailed({ prisma, entity: transaction });
    return {
      synced: true,
      status,
      ...result,
      message: `${pending.name} checkout did not complete. Start again when ready.`,
    };
  }

  return {
    synced: false,
    status: status || null,
    domain: serializeDomain(pending),
    message: `${pending.name} payment is still pending.`,
  };
}

async function transferInDomain({
  prisma = prismaDefault,
  businessId,
  domainName,
  authCode,
  years = 1,
  adapters = createDefaultAdapters(),
} = {}) {
  requireDomainDelegate(prisma);
  const cleanDomain = assertValidDomainName(normalizeDomainName(domainName));
  if (!String(authCode || '').trim()) {
    throw domainError('Authorization code is required to start a transfer.', 400, 'AUTH_CODE_REQUIRED');
  }
  const tld = tldFromDomain(cleanDomain);
  const route = resolveRegistrarForTld(tld);
  if (!route.supported) throw domainError('This TLD is not supported for transfer-in yet.', 422, 'TLD_UNSUPPORTED', { tld, reason: route.reason });

  const existing = await prisma.domain.findUnique({ where: { name: cleanDomain } });
  if (existing) throw domainError('This domain is already managed in Sitepresso.', 409, 'DOMAIN_ALREADY_MANAGED');

  const adapter = adapters[route.registrar] || getAdapterForTld(tld, adapters);
  const transfer = await adapter.transferIn(cleanDomain, String(authCode).trim(), { years: normalizeYears(years) });
  const pricing = starterPriceForTld(tld);
  const domain = await createDomainRow({
    prisma,
    businessId,
    domainName: cleanDomain,
    registrar: route.registrar,
    registrarRef: transfer.registrarRef,
    status: transfer.status || 'TRANSFER_IN_PENDING',
    statusMessage: 'Transfer started. Your Sitepresso subdomain remains live while the registry completes the move.',
    autoRenew: true,
    privacyEnabled: false,
    trusteeEnabled: Boolean(pricing.requiresTrustee),
    price: pricing,
  });
  return { domain: serializeDomain(domain), pollingPath: `/api/business/domains/${domain.id}/transfer-status` };
}

async function addByodDomain({
  prisma = prismaDefault,
  businessId,
  domainName,
  bindDomain = true,
} = {}) {
  requireDomainDelegate(prisma);
  const cleanDomain = assertValidDomainName(normalizeDomainName(domainName));
  const tld = tldFromDomain(cleanDomain);
  const existing = await prisma.domain.findUnique({ where: { name: cleanDomain } });
  if (existing && existing.businessId !== businessId) {
    throw domainError('This domain is already managed in another Sitepresso business.', 409, 'DOMAIN_ALREADY_MANAGED');
  }
  if (existing) {
    let binding = null;
    let subscription = await currentPrimaryDomain({ prisma, businessId });
    if (bindDomain) {
      const bindAsPrimary = !subscription?.customDomain;
      binding = bindAsPrimary
        ? await bindDomainOverlay({ prisma, businessId, domainName: cleanDomain, domainId: existing.id, allowApexPending: true })
        : await provisionRedirectAlias({ prisma, businessId, domainName: cleanDomain, domainId: existing.id, allowApexPending: false });
      subscription = {
        customDomain: binding.role === 'REDIRECT' ? binding.redirectTo : cleanDomain,
        customDomainStatus: binding.status,
        customDomainStatusMessage: binding.message,
      };
    }
    const fresh = await prisma.domain.findUnique({ where: { id: existing.id } }).catch(() => null);
    return { domain: serializeDomain(fresh || existing, subscription), binding };
  }

  const domain = await createDomainRow({
    prisma,
    businessId,
    domainName: cleanDomain,
    registrar: 'BYOD',
    status: 'BYOD',
    statusMessage: 'External domain saved. DNS verification runs through the custom-domain workflow.',
    autoRenew: false,
    privacyEnabled: false,
    trusteeEnabled: false,
    price: { ...starterPriceForTld(tld), wholesaleMinor: 0, retailMinor: 0, priceMinor: 0, renewalRetailMinor: 0 },
  });
  let binding = null;
  if (bindDomain) {
    const bindAsPrimary = await shouldBindAsPrimary({ prisma, businessId, bindDomain });
    binding = bindAsPrimary
      ? await bindDomainOverlay({ prisma, businessId, domainName: cleanDomain, domainId: domain.id, allowApexPending: true })
      : await provisionRedirectAlias({ prisma, businessId, domainName: cleanDomain, domainId: domain.id, allowApexPending: false });
  }
  const subscription = binding
    ? { customDomain: binding.role === 'REDIRECT' ? binding.redirectTo : cleanDomain, customDomainStatus: binding.status, customDomainStatusMessage: binding.message }
    : null;
  const fresh = await prisma.domain.findUnique({ where: { id: domain.id } }).catch(() => null);
  return { domain: serializeDomain(fresh || domain, subscription), binding };
}

async function getTransferStatus({ prisma = prismaDefault, businessId, id }) {
  const domain = await findOwnedDomain({ prisma, businessId, id });
  return {
    domain: serializeDomain(domain),
    pollingIntervalMs: domain.status === 'TRANSFER_IN_PENDING' ? 30000 : null,
    steps: [
      { key: 'auth', label: 'Auth code accepted', complete: true },
      { key: 'registrar', label: 'Registrar approval', complete: domain.status !== 'TRANSFER_IN_PENDING' },
      { key: 'binding', label: 'Connect to Sitepresso', complete: domain.status === 'ACTIVE' },
    ],
  };
}

async function togglePrivacy({ prisma = prismaDefault, businessId, id, enabled, adapters = createDefaultAdapters() }) {
  const domain = await findOwnedDomain({ prisma, businessId, id });
  if (domain.registrar === 'BYOD') throw domainError('Privacy is managed at the external registrar for BYOD domains.', 422, 'BYOD_PRIVACY_UNSUPPORTED');
  const nextEnabled = enabled === undefined ? !domain.privacyEnabled : Boolean(enabled);
  const adapter = adapters[domain.registrar] || getAdapterForTld(domain.tld, adapters);
  await adapter.setPrivacy(domain.registrarRef, nextEnabled, { domainName: domain.name });
  const updated = await prisma.domain.update({
    where: { id: domain.id },
    data: {
      privacyEnabled: nextEnabled,
      statusMessage: nextEnabled ? 'WHOIS privacy is enabled.' : 'WHOIS privacy is disabled.',
    },
  });
  const subscription = await prisma.subscription.findUnique({ where: { businessId }, select: { customDomain: true } }).catch(() => null);
  return { domain: serializeDomain(updated, subscription) };
}

async function toggleAutoRenew({ prisma = prismaDefault, businessId, id, enabled }) {
  const domain = await findOwnedDomain({ prisma, businessId, id });
  const nextEnabled = enabled === undefined ? !domain.autoRenew : Boolean(enabled);
  const updated = await prisma.domain.update({
    where: { id: domain.id },
    data: {
      autoRenew: nextEnabled,
      statusMessage: nextEnabled
        ? 'Renewal reminders are enabled. Renewal still requires checkout confirmation before the registrar is charged.'
        : 'Renewal reminders are disabled.',
    },
  });
  const subscription = await prisma.subscription.findUnique({ where: { businessId }, select: { customDomain: true } }).catch(() => null);
  return { domain: serializeDomain(updated, subscription) };
}

async function renewDomain({
  prisma = prismaDefault,
  businessId,
  id,
  years = 1,
  adapters = createDefaultAdapters(),
  paymentConfirmed = false,
} = {}) {
  const domain = await findOwnedDomain({ prisma, businessId, id });
  if (domain.registrar === 'BYOD') throw domainError('BYOD domains are renewed at their external registrar.', 422, 'BYOD_RENEW_UNSUPPORTED');
  if (!domain.registrarRef || String(domain.registrarRef).startsWith('PADDLE:')) {
    throw domainError('Domain registrar reference is missing; renewal cannot start.', 409, 'DOMAIN_RENEWAL_REGISTRAR_REF_MISSING', { domain: serializeDomain(domain) });
  }
  if (!RENEWABLE_DOMAIN_STATUSES.has(domain.status)) {
    throw domainError('This domain is not in a renewable state.', 409, 'DOMAIN_NOT_RENEWABLE', { domain: serializeDomain(domain) });
  }
  if (
    getDomainResellerMode() === MODE_LIVE
    && String(process.env.DOMAIN_RESELLER_ALLOW_UNPAID_LIVE || '').toLowerCase() !== 'true'
    && !paymentConfirmed
  ) {
    throw domainError('Payment confirmation is required before live domain renewal.', 402, 'DOMAIN_RENEWAL_PAYMENT_REQUIRED', { domain: serializeDomain(domain) });
  }
  const adapter = adapters[domain.registrar] || getAdapterForTld(domain.tld, adapters);
  const renewal = await adapter.renew(domain.registrarRef, normalizeYears(years), { domainName: domain.name });
  const updated = await prisma.domain.update({
    where: { id: domain.id },
    data: {
      expiresAt: renewal.expiresAt ? new Date(renewal.expiresAt) : domain.expiresAt,
      status: 'ACTIVE',
      statusMessage: 'Domain renewed successfully.',
      renewalPaymentStatus: paymentConfirmed ? 'COMPLETED' : domain.renewalPaymentStatus,
      renewalPaymentDueAt: paymentConfirmed ? null : domain.renewalPaymentDueAt,
      renewalYears: paymentConfirmed ? normalizeYears(years) : domain.renewalYears,
    },
  });
  const subscription = await prisma.subscription.findUnique({ where: { businessId }, select: { customDomain: true } }).catch(() => null);
  return { domain: serializeDomain(updated, subscription) };
}

async function getAuthCode({ prisma = prismaDefault, businessId, id, adapters = createDefaultAdapters() }) {
  const domain = await findOwnedDomain({ prisma, businessId, id });
  if (domain.registrar === 'BYOD') throw domainError('Transfer-out codes are managed at the external registrar for BYOD domains.', 422, 'BYOD_AUTH_CODE_UNSUPPORTED');
  const adapter = adapters[domain.registrar] || getAdapterForTld(domain.tld, adapters);
  const result = await adapter.getAuthCode(domain.registrarRef, { domainName: domain.name });
  const updated = await prisma.domain.update({
    where: { id: domain.id },
    data: {
      status: 'TRANSFER_OUT_PENDING',
      autoRenew: false,
      statusMessage: 'Transfer-out authorization code generated. Renewal reminders are off while transfer is pending.',
    },
  });
  const subscription = await prisma.subscription.findUnique({ where: { businessId }, select: { customDomain: true } }).catch(() => null);
  return { authCode: result.authCode, domain: serializeDomain(updated, subscription), expiresInDays: 7 };
}

async function makePrimary({ prisma = prismaDefault, businessId, id }) {
  const domain = await findOwnedDomain({ prisma, businessId, id });
  const binding = await bindDomainOverlay({ prisma, businessId, domainName: domain.name, domainId: domain.id });
  const fresh = await prisma.domain.findUnique({ where: { id: domain.id } });
  return {
    domain: serializeDomain(fresh || domain, {
      customDomain: domain.name,
      customDomainStatus: binding.status,
      customDomainStatusMessage: binding.message,
    }),
    binding,
  };
}

async function enableRedirectAlias({ prisma = prismaDefault, businessId, id }) {
  const domain = await findOwnedDomain({ prisma, businessId, id });
  const subscription = await currentPrimaryDomain({ prisma, businessId });
  if (!subscription?.customDomain) {
    throw domainError('Choose a primary domain before enabling redirect aliases.', 422, 'PRIMARY_DOMAIN_REQUIRED');
  }
  if (normalizeDomainName(subscription.customDomain) === normalizeDomainName(domain.name)) {
    return {
      domain: serializeDomain(domain, subscription),
      binding: {
        role: 'PRIMARY',
        status: subscription.customDomainStatus || 'ACTIVE',
        message: 'This is already the primary website address.',
      },
    };
  }
  const binding = await provisionRedirectAlias({
    prisma,
    businessId,
    domainName: domain.name,
    domainId: domain.id,
    allowApexPending: domain.registrar !== 'BYOD',
  });
  const fresh = await prisma.domain.findUnique({ where: { id: domain.id } }).catch(() => null);
  return {
    domain: serializeDomain(fresh || domain, subscription),
    binding,
  };
}

function verticalToRouterKey(vertical) {
  if (vertical === 'ECOMMERCE') return 'shop';
  if (vertical === 'STATIC') return 'web';
  return 'booking';
}

async function resolveDomainTraffic({ prisma = prismaDefault, host } = {}) {
  requireDomainDelegate(prisma);
  const requestedHost = normalizeCustomDomainHost(host);
  const lookupHosts = customDomainLookupHosts(requestedHost);
  if (!lookupHosts.length) {
    throw domainError('Host is required.', 400, 'HOST_REQUIRED');
  }

  const primaryBusiness = await prisma.business.findFirst({
    where: { subscription: { is: routableCustomDomainWhere(requestedHost) } },
    select: {
      slug: true,
      vertical: true,
      subscription: {
        select: {
          customDomain: true,
          customDomainVerified: true,
          customDomainStatus: true,
        },
      },
    },
  }).catch(() => null);

  if (primaryBusiness?.subscription?.customDomain) {
    const canonicalHost = normalizeCustomDomainHost(primaryBusiness.subscription.customDomain);
    const payload = {
      slug: primaryBusiness.slug,
      vertical: verticalToRouterKey(primaryBusiness.vertical),
      canonicalHost,
      requestedHost,
    };
    if (canonicalHost && canonicalHost !== requestedHost) {
      return { action: 'redirect', statusCode: 301, targetHost: canonicalHost, ...payload };
    }
    return { action: 'serve', ...payload };
  }

  const aliasDomain = await prisma.domain.findFirst({
    where: {
      name: { in: lookupHosts },
      status: { in: Array.from(REDIRECTABLE_DOMAIN_STATUSES) },
    },
    select: {
      name: true,
      business: {
        select: {
          slug: true,
          vertical: true,
          subscription: {
            select: {
              customDomain: true,
              customDomainVerified: true,
              customDomainStatus: true,
            },
          },
        },
      },
    },
  }).catch(() => null);

  const primaryHost = normalizeCustomDomainHost(aliasDomain?.business?.subscription?.customDomain || '');
  if (!aliasDomain || !primaryHost) {
    throw domainError('Domain is not connected to a primary Sitepresso website.', 404, 'DOMAIN_ROUTE_NOT_FOUND');
  }

  const payload = {
    slug: aliasDomain.business.slug,
    vertical: verticalToRouterKey(aliasDomain.business.vertical),
    canonicalHost: primaryHost,
    requestedHost,
    aliasHost: normalizeCustomDomainHost(aliasDomain.name),
  };
  if (primaryHost !== requestedHost) {
    return { action: 'redirect', statusCode: 301, targetHost: primaryHost, ...payload };
  }
  return { action: 'serve', ...payload };
}

async function disconnectDomain({ prisma = prismaDefault, businessId, id }) {
  const domain = await findOwnedDomain({ prisma, businessId, id });
  const subscription = await prisma.subscription.findUnique({
    where: { businessId },
    select: { customDomain: true, customHostnameId: true },
  }).catch(() => null);
  if (subscription?.customDomain === domain.name) {
    if (subscription.customHostnameId) {
      await deleteCloudflareCustomHostname(subscription.customHostnameId, { domain: subscription.customDomain }).catch(() => null);
    }
    await prisma.subscription.update({
      where: { businessId },
      data: {
        customDomain: null,
        customHostnameId: null,
        customDomainVerified: false,
        customDomainStatus: 'NONE',
        customDomainStatusMessage: 'Domain disconnected from the Sitepresso site.',
        customDomainCheckedAt: new Date(),
      },
    });
  }
  await prisma.domain.delete({ where: { id: domain.id } });
  return { disconnected: true, domain: serializeDomain(domain, subscription) };
}

module.exports = {
  addByodDomain,
  bindDomainOverlay,
  completePaidDomainRegistration,
  completePaidDomainRenewal,
  createDomainRegistrationCheckout,
  createDomainRenewalCheckout,
  deriveDisplayStatus,
  disconnectDomain,
  domainError,
  DOMAIN_REGISTRATION_PAYMENT_KIND,
  DOMAIN_RENEWAL_PAYMENT_KIND,
  enableRedirectAlias,
  getAuthCode,
  getTransferStatus,
  handleDomainPaymentAdjustment,
  isDomainRegistrationPayment,
  isDomainRenewalPayment,
  listBusinessDomains,
  markDomainPaymentFailed,
  makePrimary,
  provisionRedirectAlias,
  quoteDomainAmountMinor,
  quoteDomainRegistration,
  registerManagedDomain,
  requireDomainDelegate,
  renewDomain,
  resolveDomainTraffic,
  searchDomainOptions,
  serializeDomain,
  summarizeDomains,
  syncPendingDomainRegistrationPayment,
  trafficRoleForDomain,
  toggleAutoRenew,
  togglePrivacy,
  transferInDomain,
};
