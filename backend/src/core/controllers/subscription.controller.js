const prisma = require('../lib/prisma');
const dnsNative = require('dns');
const crypto = require('crypto');
const dns = dnsNative.promises;
const { writeAudit } = require('../lib/audit');
const {
  cancelPaddleSubscription,
  createPaddleCustomerPortalSession,
  createPaddleCustomer,
  createPaddleTransaction,
  getPaddleEnvironment,
  getPaddlePrice,
  getPaddleSubscription,
  getPaddleTransaction,
  getPaddleTransactionInvoice,
  isPaddleConfigured,
  listPaddleClientTokens,
  listPaddleSubscriptionsForCustomer,
  listPaddleTransactions,
  updatePaddleSubscription,
} = require('../lib/paddle');
const {
  buildBillingContext,
  extractAfterCursor,
  invoiceAvailableForTransaction,
  serializeBillingTransaction,
} = require('../lib/paddleBillingViews');
const { listBusinessAdminRecipients } = require('../lib/inbox');
const { sendEmail } = require('../utils/email');
const { launchFreePlanGrantsAllowed, launchFreeUntil } = require('../lib/launchPeriod');
const {
  FOREVER,
  FREE_TIER_SLUG,
  ensureBusinessSubscription,
  getBusinessSubscription,
  getPriceIdForBillingCycle,
  hydrateSubscription,
  normalizeCountryCode,
  resolveTierPriceRecord,
  syncBusinessSubscriptionFromPaddle,
  syncBusinessSubscriptionFromStripe,
  syncBusinessSubscriptionFromRazorpay,
} = require('../lib/subscriptionBilling');
const {
  activeGatewayFromSubscription,
  gatewayLabel,
  gatewayMigrationBlock,
  resolveGateway,
  resolveGatewayForChange,
} = require('../lib/billing/gatewayRouter');
const { getGateway } = require('../lib/billing/gateways');
const { ensurePublishedPriceId, GATEWAY_TARGETS } = require('../lib/gatewayCatalogService');
const { ensurePaddleBillingProfile } = require('../lib/paddleCustomerProfile');
const { resolveVertical, VALID_VERTICALS } = require('../lib/vertical');
const { buildBillingWorkspace } = require('../lib/billingWorkspace');
const { buildBillingChangePreview } = require('../lib/billingChangePreview');
const { reconcileSubscriptionRow } = require('../lib/paddleReconciliation');
const { recordCheckoutCreated } = require('../lib/billingLedger');
const {
  changeTiming,
  classifyPlanChange,
  pendingEffectiveAtFromGateway,
  paddleProrationModeFor,
  razorpayScheduleChangeAtFor,
  stripeProrationBehaviorFor,
  targetTrialDays,
} = require('../lib/billingPlanChangePolicy');

// Theme system (April 2026 expansion): profession × style × optional colour
// overrides. Subscription.theme stores the profession key; Subscription.
// themeStyle stores the visual variant; Subscription.themeColors stores
// optional JSON { primary, accent, surface, bg, text } overrides.
const CURRENT_THEMES = [
  // Healthcare
  'doctor_clinic', 'general_practice', 'dental', 'physio', 'psychology', 'dermatology',
  'chiropractic', 'optometry', 'nutrition', 'veterinary',
  // Personal care & beauty
  'barbershop', 'hair_salon', 'makeup', 'nail_tech', 'spa', 'tattoo',
  // Education & coaching
  'tutor', 'music_teacher', 'fitness_coach', 'yoga', 'math_tuition', 'online_courses',
  // Professional services
  'legal', 'accountant', 'ca_tax_consultant', 'it_services', 'financial_advisor', 'consultant', 'immigration',
  'architect', 'real_estate', 'marketing_agency',
  // Fitness & wellness
  'gym', 'meditation',
  // Home & local services
  'electrician', 'plumber', 'cleaner', 'mechanic', 'water_purifier',
  // Creative & freelancers
  'photographer', 'event_planner', 'designer', 'dj', 'artist', 'writer_content',
  // Pet services
  'pet_groomer', 'dog_trainer',
  // Mental health
  'therapist', 'life_coach',
  // Corporate
  'hr_interviews', 'saas_demo',
  // Phase 0 archetypes (May 2026) — three business archetypes that drive
  // both the vertical and the full experience (vocabulary, KPIs, flows).
  'grocery', 'corporate', 'bar_pub',
  // Auto-provisioned default before owner picks a profession.
  // 'other' is the new neutral fallback (added 2026-04-30) — used by
  // CATEGORY_TO_THEME for unmapped professions. 'default' is kept for
  // back-compat with subscriptions auto-created before the category-
  // theme mapping landed.
  'default', 'other',
];
const {
  getThemeConfig,
  listThemeKeys,
  getThemeVertical,
  listCmsServices,
  listCmsTeam,
} = require('../lib/themeRegistry');
const { computeLocalPrice, DEFAULT_CMS_TEAM } = require('../lib/defaultServices');
const VALID_THEMES = new Set([...CURRENT_THEMES, ...listThemeKeys()]);
const NAVBAR_TAGLINE_MAX_LENGTH = 48;

// Layout presets + section-variant sanitiser (kept in a shared module so
// the registry has one source of truth).
const { VALID_LAYOUT_PRESETS, resolvePreset, sanitizeSectionVariants } = require('../lib/layoutPresets');

// White-label visual styles — the 5 fixed HR styles (theme-engine FIXED_STYLE_KEYS).
// The tenant picks one of these + one brand color + a logo; nothing else is designable.
const VALID_STYLES = new Set(['slate', 'indigo', 'emerald', 'rose', 'mono']);

// Custom domains are served by Cloudflare for SaaS (custom hostnames + Worker
// routing). The legacy Vercel provider branch was removed — Cloudflare is the
// only path. Cloudflare anycast IPs for the apex (root) A records: Cloudflare-
// for-SaaS routes custom hostnames by SNI, so any Cloudflare anycast IP
// delivers traffic to the correct zone — these are the IPs `custom.<platform>`
// resolves to, one per distinct Cloudflare range for redundancy. Override
// per-env with CUSTOM_DOMAIN_TARGET_IPS if Cloudflare ever rotates them.
const DEFAULT_CUSTOM_DOMAIN_IPS = ['172.67.157.143', '104.21.40.227'];

function customDomainProvider() {
  // Cloudflare-for-SaaS is the only supported provider now.
  return 'cloudflare';
}

function expectedCustomDomainIps() {
  const fromEnv = String(process.env.CUSTOM_DOMAIN_TARGET_IPS || '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_CUSTOM_DOMAIN_IPS;
}

function expectedCustomDomainCname() {
  const configured = String(process.env.CUSTOM_DOMAIN_TARGET_CNAME || '').toLowerCase().replace(/\.$/, '').trim();
  if (configured) return configured;

  const platformDomain = String(process.env.PLATFORM_DOMAIN || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/\.$/, '')
    .trim();
  return platformDomain ? `custom.${platformDomain}` : '';
}

function customDomainLabels(domain) {
  return String(domain || '').split('.').filter(Boolean);
}

const COMMON_SECOND_LEVEL_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'co.in', 'firm.in', 'net.in', 'org.in', 'gen.in',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'org.nz',
  'com.br', 'com.mx', 'com.sg', 'com.my', 'com.pk',
  'co.za',
]);

function isLikelyApexDomain(domain) {
  const labels = customDomainLabels(domain);
  if (labels.length === 2) return true;
  if (labels.length === 3 && COMMON_SECOND_LEVEL_PUBLIC_SUFFIXES.has(labels.slice(1).join('.'))) return true;
  return false;
}

function dnsRecordNameForDomain(domain) {
  const labels = customDomainLabels(domain);
  if (isLikelyApexDomain(domain)) return '@';
  if (labels.length >= 4 && COMMON_SECOND_LEVEL_PUBLIC_SUFFIXES.has(labels.slice(-2).join('.'))) {
    return labels.slice(0, -3).join('.') || '@';
  }
  return labels.slice(0, -2).join('.') || '@';
}

function shouldUseCnameInstruction(domain, expectedCname) {
  if (!expectedCname) return false;
  // When no A target is configured (post-tunnel migration), CNAME is the
  // only path — apex sellers use ALIAS/ANAME/CNAME-flattening at their DNS.
  if (expectedCustomDomainIps().length === 0) return true;
  const labels = customDomainLabels(domain);
  return domain.startsWith('www.') || labels.length > 2;
}

function normalizeCustomDomain(input) {
  let domain = String(input || '').trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '').split('/')[0].split(':')[0].replace(/\.$/, '');
  if (!domain || domain.length > 253 || domain.includes('..')) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return null;
  return domain;
}

function customDomainClaimDomains(domain) {
  const clean = normalizeCustomDomain(domain);
  if (!clean) return [];
  if (clean.startsWith('www.')) {
    const apex = clean.slice(4);
    return isLikelyApexDomain(apex) ? [clean, apex] : [clean];
  }
  if (isLikelyApexDomain(clean)) return [clean, `www.${clean}`];
  return [clean];
}

function customDomainWwwPair(domain) {
  const clean = normalizeCustomDomain(domain);
  if (!clean) return null;
  if (clean.startsWith('www.') && isLikelyApexDomain(clean.slice(4))) {
    const apex = clean.slice(4);
    return { apex, www: clean };
  }
  if (isLikelyApexDomain(clean)) {
    return { apex: clean, www: `www.${clean}` };
  }
  return null;
}

function customDomainOwnershipBase(domain) {
  const clean = normalizeCustomDomain(domain);
  if (!clean) return '';
  if (clean.startsWith('www.') && isLikelyApexDomain(clean.slice(4))) return clean.slice(4);
  return clean;
}

function customDomainTransferSecret() {
  return String(
    process.env.CUSTOM_DOMAIN_TRANSFER_SECRET ||
    process.env.JWT_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.COOKIE_SECRET ||
    (process.env.NODE_ENV === 'production' ? '' : 'drifthr-local-domain-transfer')
  );
}

function customDomainOwnershipChallenge({ domain, businessId }) {
  const clean = normalizeCustomDomain(domain);
  const baseDomain = customDomainOwnershipBase(clean);
  const secret = customDomainTransferSecret();
  if (!clean || !baseDomain || !businessId || !secret) return null;
  const token = crypto
    .createHmac('sha256', secret)
    .update(`custom-domain-transfer:v1:${businessId}:${clean}:${baseDomain}`)
    .digest('hex')
    .slice(0, 40);
  return {
    type: 'TXT',
    name: `_drifthr-verify.${baseDomain}`,
    host: '_drifthr-verify',
    value: `drifthr-verify=${token}`,
    baseDomain,
    ttl: 'Auto or 1 hour',
  };
}

async function inspectTxtRecords(name) {
  const fullName = String(name || '').toLowerCase().replace(/\.$/, '');
  if (!fullName) return [];
  const resolvers = [dns, ...['1.1.1.1', '8.8.8.8'].map((server) => {
    const resolver = new dnsNative.promises.Resolver();
    resolver.setServers([server]);
    return resolver;
  })];
  const values = new Set();
  for (const resolver of resolvers) {
    try {
      const rows = await resolver.resolveTxt(fullName);
      for (const row of rows || []) {
        const value = Array.isArray(row) ? row.join('') : String(row || '');
        if (value) values.add(value.replace(/^"|"$/g, ''));
      }
    } catch {
      // Try the next resolver; DNS propagation is uneven.
    }
  }
  return Array.from(values);
}

async function customDomainOwnershipVerified({ domain, businessId }) {
  const challenge = customDomainOwnershipChallenge({ domain, businessId });
  if (!challenge) return { verified: false, challenge, values: [] };
  const values = await inspectTxtRecords(challenge.name);
  return {
    verified: values.some((value) => value === challenge.value || value.includes(challenge.value)),
    challenge,
    values,
  };
}

function customDomainTransferRequiredResponse({ domain, businessId, message }) {
  const challenge = customDomainOwnershipChallenge({ domain, businessId });
  if (!challenge) {
    return {
      code: 'CUSTOM_DOMAIN_TRANSFER_UNAVAILABLE',
      domain,
      message: 'This domain is already connected to another DriftHR website. Automatic ownership verification is not configured, so contact support to move it.',
      canTransfer: false,
      ownershipVerification: null,
    };
  }
  return {
    code: 'CUSTOM_DOMAIN_TRANSFER_VERIFICATION_REQUIRED',
    domain,
    message: message || 'This domain is already connected to another DriftHR website. Add the TXT record below to prove domain ownership, then verify and move it here.',
    canTransfer: true,
    ownershipVerification: challenge,
  };
}

function customDomainEmailSafe(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function inspectDomainDns(domain) {
  const expectedIps = expectedCustomDomainIps();
  const expectedCname = expectedCustomDomainCname();
  const fallbackIps = expectedIps.length ? expectedIps : DEFAULT_CUSTOM_DOMAIN_IPS;
  const result = { a: [], cname: [], expectedIps: fallbackIps, expectedCname: expectedCname || null };
  const resolvers = [dns, ...['1.1.1.1', '8.8.8.8'].map((server) => {
    const resolver = new dnsNative.promises.Resolver();
    resolver.setServers([server]);
    return resolver;
  })];
  const seenA = new Set();
  const seenCname = new Set();

  for (const resolver of resolvers) {
    try {
      const records = await resolver.resolve4(domain);
      records.forEach((ip) => seenA.add(ip));
    } catch {}
    try {
      const records = await resolver.resolveCname(domain);
      records
        .map((v) => v.toLowerCase().replace(/\.$/, ''))
        .forEach((host) => seenCname.add(host));
    } catch {}
  }

  result.a = [...seenA];
  result.cname = [...seenCname];
  const aMatches = fallbackIps.length > 0 && result.a.some((ip) => fallbackIps.includes(ip));
  const cnameMatches = expectedCname && result.cname.some((host) => host === expectedCname);
  result.matches = Boolean(aMatches || cnameMatches);
  return result;
}

function dnsInstructionsForDomain(domain) {
  const expectedIps = expectedCustomDomainIps();
  const expectedCname = expectedCustomDomainCname();
  const wwwPair = customDomainWwwPair(domain);
  const hasApexIps = expectedIps.length > 0;
  const proxyNote = 'DNS only until verification passes, then proxy may be enabled if supported.';

  // Apex-capable domain (root or www entered): give BOTH the apex record(s) AND
  // the www CNAME, plus a 301-forwarding fallback for registrars that can't add
  // a record at the root. Apex uses A records (one row per IP) when IPs are
  // configured, else ALIAS/ANAME/CNAME-flattening.
  if (wwwPair && expectedCname) {
    const primaryIsWww = normalizeCustomDomain(domain) === wwwPair.www;
    const rootForwardTo = `https://${wwwPair.www}`;

    const wwwRecord = {
      type: 'CNAME',
      name: 'www',
      value: expectedCname,
      values: [expectedCname],
      domain: wwwPair.www,
      status: primaryIsWww ? 'Required' : 'Recommended',
      proxy: proxyNote,
    };

    const apexRecords = hasApexIps
      ? expectedIps.map((ip) => ({
          type: 'A',
          name: '@',
          value: ip,
          domain: wwwPair.apex,
          status: primaryIsWww ? 'Recommended' : 'Required',
          proxy: proxyNote,
        }))
      : [{
          type: 'ALIAS/ANAME',
          name: '@',
          value: expectedCname,
          values: [expectedCname],
          domain: wwwPair.apex,
          status: primaryIsWww ? 'Recommended' : 'Required',
          proxy: 'Root domains need ALIAS/ANAME/CNAME-flattening support at the registrar. If unavailable, use the www CNAME plus the 301 redirect below.',
        }];

    const records = primaryIsWww ? [wwwRecord, ...apexRecords] : [...apexRecords, wwwRecord];
    const primary = records[0];

    const apexHint = hasApexIps
      ? `point the root by adding ${expectedIps.length} A record${expectedIps.length === 1 ? '' : 's'} on Name @ to ${expectedIps.join(' and ')}`
      : `point the root with an ALIAS/ANAME (or flattened CNAME) on @ -> ${expectedCname} if your registrar supports it`;

    return {
      type: primary.type,
      name: primary.name,
      value: primary.value,
      values: primary.values || [primary.value],
      proxy: primary.proxy,
      records,
      rootForwardTo,
      notes: `Add the www record (CNAME www -> ${expectedCname}) and, to make ${wwwPair.apex} work without www, ${apexHint}. If your registrar will not let you add a record at the root, instead add a 301 Forwarding/Redirect from ${wwwPair.apex} to ${rootForwardTo} (turn on "preserve path") — www keeps working on its own either way.`,
    };
  }

  // Bare subdomain (e.g. shop.example.com) -> single CNAME.
  if (shouldUseCnameInstruction(domain, expectedCname)) {
    return {
      type: 'CNAME',
      name: dnsRecordNameForDomain(domain),
      value: expectedCname,
      values: [expectedCname],
      proxy: proxyNote,
    };
  }
  const values = expectedIps.length ? expectedIps : DEFAULT_CUSTOM_DOMAIN_IPS;
  return {
    type: 'A',
    name: domain.startsWith('www.') ? 'www' : '@',
    value: values[0],
    values,
    proxy: proxyNote,
  };
}

function shouldSuggestWwwDomain(domain, dnsState = null) {
  return Boolean(
    isLikelyApexDomain(domain) &&
    expectedCustomDomainIps().length === 0 &&
    expectedCustomDomainCname() &&
    !dnsState?.matches
  );
}

async function buildApexWwwSuggestion(domain, dnsState = null) {
  if (!shouldSuggestWwwDomain(domain, dnsState)) return null;
  const suggestedDomain = `www.${domain}`;
  const suggestedDns = await inspectDomainDns(suggestedDomain);
  return {
    code: 'APEX_DOMAIN_NEEDS_WWW',
    domain,
    suggestedDomain,
    suggestedDns,
    instructions: dnsInstructionsForDomain(suggestedDomain),
    message: `Root domain ${domain} is not pointed at DriftHR. For GoDaddy-style DNS, connect ${suggestedDomain} and add CNAME "www" to ${expectedCustomDomainCname()}.`,
  };
}

function cloudflareCustomHostnameToken() {
  return String(process.env.CLOUDFLARE_CUSTOM_HOSTNAME_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '').trim();
}

function cloudflareCustomHostnameZoneId() {
  return String(process.env.CLOUDFLARE_CUSTOM_HOSTNAME_ZONE_ID || process.env.CLOUDFLARE_ZONE_ID || '').trim();
}

function cloudflareCustomHostnameZoneName() {
  const configured = String(process.env.CLOUDFLARE_CUSTOM_HOSTNAME_ZONE_NAME || process.env.CLOUDFLARE_ZONE_NAME || '').trim();
  if (configured) return configured;
  return String(process.env.PLATFORM_DOMAIN || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/\.$/, '')
    .trim();
}

function isCloudflareCustomHostnameConfigured() {
  return Boolean(cloudflareCustomHostnameToken() && (cloudflareCustomHostnameZoneId() || cloudflareCustomHostnameZoneName()));
}

async function cloudflareApi(path, options = {}) {
  const token = cloudflareCustomHostnameToken();
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.success === false) {
    const errors = Array.isArray(json.errors) ? json.errors.map((e) => e.message).filter(Boolean).join('; ') : '';
    const err = new Error(errors || `Cloudflare API failed with ${response.status}`);
    err.status = response.status;
    err.cloudflare = json;
    throw err;
  }
  return json.result;
}

async function resolveCloudflareZoneId() {
  const explicit = cloudflareCustomHostnameZoneId();
  if (explicit) return explicit;
  const zoneName = cloudflareCustomHostnameZoneName();
  if (!zoneName) return null;
  const zones = await cloudflareApi(`/zones?name=${encodeURIComponent(zoneName)}`);
  return Array.isArray(zones) ? zones[0]?.id || null : null;
}

function serializeCloudflareHostname(result) {
  if (!result) return null;
  return {
    id: result.id || null,
    hostname: result.hostname || null,
    status: result.status || null,
    sslStatus: result.ssl?.status || null,
    ownershipVerification: result.ownership_verification || null,
  };
}

function cloudflareHostnameIsActive(result) {
  return result?.status === 'active' && (!result.ssl?.status || result.ssl.status === 'active');
}

async function findCloudflareCustomHostname(zoneId, domain) {
  const result = await cloudflareApi(`/zones/${zoneId}/custom_hostnames?hostname=${encodeURIComponent(domain)}`);
  return Array.isArray(result) ? result[0] || null : null;
}

function cloudflareFallbackOrigin() {
  return String(process.env.CLOUDFLARE_CUSTOM_HOSTNAME_FALLBACK_ORIGIN || expectedCustomDomainCname() || '').trim();
}

function cloudflareCustomHostnameBody(domain) {
  return {
    hostname: domain,
    ssl: {
      method: 'http',
      type: 'dv',
      settings: {
        http2: 'on',
        min_tls_version: '1.2',
        tls_1_3: 'on',
      },
    },
  };
}

async function ensureCloudflareFallbackOrigin(zoneId) {
  const origin = cloudflareFallbackOrigin();
  if (!origin) return null;

  const existing = await cloudflareApi(`/zones/${zoneId}/custom_hostnames/fallback_origin`).catch((err) => {
    if (err.status === 404) return null;
    throw err;
  });
  if (existing?.origin === origin && existing?.status === 'active') return existing;

  return cloudflareApi(`/zones/${zoneId}/custom_hostnames/fallback_origin`, {
    method: 'PUT',
    body: JSON.stringify({ origin }),
  });
}

async function refreshCloudflareCustomHostname(zoneId, customHostnameId, domain) {
  return cloudflareApi(`/zones/${zoneId}/custom_hostnames/${customHostnameId}`, {
    method: 'PATCH',
    body: JSON.stringify(cloudflareCustomHostnameBody(domain)),
  });
}

async function getCloudflareCustomHostname({ domain, customHostnameId }) {
  if (!isCloudflareCustomHostnameConfigured()) return { configured: false };
  const zoneId = await resolveCloudflareZoneId();
  if (!zoneId) return { configured: false, error: 'Cloudflare zone is not configured.' };
  if (customHostnameId) {
    const result = await cloudflareApi(`/zones/${zoneId}/custom_hostnames/${customHostnameId}`);
    return { configured: true, zoneId, result };
  }
  const result = await findCloudflareCustomHostname(zoneId, domain);
  return { configured: true, zoneId, result };
}

async function ensureCloudflareCustomHostname({ domain, business }) {
  if (!isCloudflareCustomHostnameConfigured()) return { configured: false };
  const zoneId = await resolveCloudflareZoneId();
  if (!zoneId) return { configured: false, error: 'Cloudflare zone is not configured.' };

  await ensureCloudflareFallbackOrigin(zoneId);
  const hostnames = customDomainClaimDomains(domain);
  const primaryDomain = normalizeCustomDomain(domain);
  const results = [];

  for (const hostname of hostnames) {
    try {
      const existing = await findCloudflareCustomHostname(zoneId, hostname);
      const result = existing
        ? await refreshCloudflareCustomHostname(zoneId, existing.id, hostname)
        : await cloudflareApi(`/zones/${zoneId}/custom_hostnames`, {
          method: 'POST',
          body: JSON.stringify(cloudflareCustomHostnameBody(hostname)),
        });
      results.push({ hostname, configured: true, result });
    } catch (err) {
      results.push({ hostname, configured: false, error: err?.message || 'unknown error', status: err?.status || null });
      if (hostname === primaryDomain) throw err;
      console.warn('[custom-domain] secondary Cloudflare custom hostname failed:', hostname, err?.message || err);
    }
  }

  const primary = results.find((item) => item.hostname === primaryDomain) || results[0];
  return { configured: true, zoneId, result: primary?.result || null, hostnames: results };
}

async function deleteCloudflareCustomHostname(customHostnameId, options = {}) {
  const domain = typeof options === 'string' ? options : options?.domain;
  const hostnames = customDomainClaimDomains(domain);
  if ((!customHostnameId && hostnames.length === 0) || !isCloudflareCustomHostnameConfigured()) {
    return { deleted: false, skipped: true };
  }
  const zoneId = await resolveCloudflareZoneId();
  if (!zoneId) return { deleted: false, skipped: true, error: 'Cloudflare zone is not configured.' };

  const deletedHostnames = [];
  const deletedIds = new Set();
  try {
    let result = null;
    if (customHostnameId) {
      try {
        result = await cloudflareApi(`/zones/${zoneId}/custom_hostnames/${customHostnameId}`, {
          method: 'DELETE',
        });
        deletedIds.add(customHostnameId);
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }

    for (const hostname of hostnames) {
      const existing = await findCloudflareCustomHostname(zoneId, hostname).catch((err) => {
        if (err.status === 404) return null;
        throw err;
      });
      if (!existing?.id || deletedIds.has(existing.id)) continue;
      await cloudflareApi(`/zones/${zoneId}/custom_hostnames/${existing.id}`, { method: 'DELETE' });
      deletedIds.add(existing.id);
      deletedHostnames.push(hostname);
    }

    return { deleted: deletedIds.size > 0, zoneId, result, deletedHostnames };
  } catch (err) {
    if (err.status === 404) return { deleted: true, zoneId, missing: true };
    throw err;
  }
}

function publicCustomDomainMessage(message) {
  return String(message || '')
    .replace(/Vercel/gi, 'domain')
    .replace(/Cloudflare/gi, 'DNS provider')
    .replace(/custom-hostname/gi, 'domain')
    .replace(/custom hostname/gi, 'domain');
}

function stabilizeCustomDomainStatus(domainStatus, priorSubscription = null) {
  const wasActive = (
    priorSubscription?.customDomainVerified === true ||
    String(priorSubscription?.customDomainStatus || '').toUpperCase() === 'ACTIVE'
  );
  if (!wasActive || !domainStatus || domainStatus.status === 'ACTIVE') return domainStatus;
  return {
    ...domainStatus,
    verified: false,
    status: 'FAILED',
    message: `Domain issue: ${publicCustomDomainMessage(domainStatus.message)} SEO is paused until this is fixed; the free subdomain remains live but noindex.`,
  };
}

async function provisionCustomDomain({ domain, business, priorSubscription = null, allowApexPending = false } = {}) {
  const provider = customDomainProvider();

  const dnsState = await inspectDomainDns(domain);
  const apexWwwSuggestion = await buildApexWwwSuggestion(domain, dnsState);
  if (apexWwwSuggestion && !allowApexPending) {
    return { provider, dnsState, suggestion: apexWwwSuggestion, blockedBySuggestion: true };
  }

  let cloudflareState = { configured: false };
  let cloudflareError = null;
  // Ownership gate (v1.1 correctness): only REGISTER the CF custom hostname once
  // the tenant has proven ownership via the TXT challenge. Registering before
  // verification lets the first caller squat any unregistered domain AND burns
  // CF custom-hostname quota on unverified attempts. When ownership is NOT yet
  // proven we persist PENDING_DNS WITHOUT touching CF — the ACTIVE-promotion
  // path (getCustomDomainStatus, gated on CF's own DV verdict) is unchanged.
  const ownership = business?.id
    ? await customDomainOwnershipVerified({ domain, businessId: business.id }).catch(() => ({ verified: false }))
    : { verified: false };
  if (ownership.verified) {
    // Cloudflare-for-SaaS needs the custom hostname REGISTERED before it will
    // serve/validate it — register up-front (at connect time) rather than
    // waiting for DNS to already match. CF then auto-validates + issues the
    // cert as soon as the tenant's CNAME points at the fallback target.
    try {
      cloudflareState = await ensureCloudflareCustomHostname({ domain, business });
    } catch (err) {
      console.error('[custom-domain] Cloudflare custom hostname failed:', err?.message || err);
      cloudflareError = err?.message || 'unknown error';
    }
  } else {
    // Not yet verified — DO NOT register the CF hostname. Persist PENDING_DNS so
    // the tenant adds DNS + the TXT record; a later recheck registers CF once
    // ownership is proven.
    return {
      provider,
      domainStatus: {
        verified: false,
        status: 'PENDING_DNS',
        message: 'Waiting for DNS to point at DriftHR.',
      },
      customHostnameId: undefined,
      dnsState,
      instructions: dnsInstructionsForDomain(domain),
      cloudflareState,
      cloudflareError: null,
      suggestion: apexWwwSuggestion,
    };
  }
  return {
    provider,
    domainStatus: stabilizeCustomDomainStatus(
      customDomainStatusFrom({
        dnsState,
        cloudflareState,
        cloudflareError,
        priorSubscription,
      }),
      priorSubscription
    ),
    customHostnameId: cloudflareState.result?.id || undefined,
    dnsState,
    instructions: dnsInstructionsForDomain(domain),
    cloudflareState,
    cloudflareError,
    suggestion: apexWwwSuggestion,
  };
}

function customDomainStatusFrom({ dnsState, cloudflareState, cloudflareError, priorSubscription = null }) {
  // Cloudflare's own verdict is authoritative: if the custom hostname is active
  // (cert issued + serving), the domain is LIVE — flip to ACTIVE regardless of
  // our local DNS heuristic. inspectDomainDns() reads "not matching" when the
  // tenant CNAMEs to our PROXIED target (it resolves to Cloudflare IPs, not the
  // literal CNAME string), which otherwise kept domains stuck on PENDING_DNS
  // even after they were live.
  if (cloudflareState?.configured && cloudflareHostnameIsActive(cloudflareState.result)) {
    return {
      verified: true,
      status: 'ACTIVE',
      message: 'DNS and HTTPS are active.',
    };
  }
  if (!dnsState.matches) {
    return {
      verified: false,
      status: 'PENDING_DNS',
      message: 'Waiting for DNS to point at DriftHR.',
    };
  }
  if (cloudflareError) {
    if (priorSubscription?.customHostnameId) {
      return {
        verified: true,
        status: 'ACTIVE',
        message: 'DNS is correct and the domain is already active. Recheck failed, so the domain is being kept live.',
      };
    }
    return {
      verified: false,
      status: 'FAILED',
      message: `DNS is correct, but domain activation failed: ${publicCustomDomainMessage(cloudflareError)}`,
    };
  }
  if (!cloudflareState?.configured) {
    return {
      verified: false,
      status: 'PENDING_SSL',
      message: 'DNS is correct. Domain activation is not configured yet.',
    };
  }
  if (cloudflareHostnameIsActive(cloudflareState.result)) {
    return {
      verified: true,
      status: 'ACTIVE',
      message: 'DNS and HTTPS are active.',
    };
  }
  const sslStatus = cloudflareState.result?.ssl?.status || cloudflareState.result?.status || 'pending';
  return {
    verified: false,
    status: 'PENDING_SSL',
    message: `DNS is correct. Waiting for HTTPS to become active (${sslStatus}).`,
  };
}

// Sanitise a themeColors payload — accepts #RGB / #RRGGBB, drops anything
// else. Empty object → null (don't persist clutter).
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const COLOR_KEYS = ['primary', 'accent', 'surface', 'bg', 'text'];
function sanitizeThemeColors(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const k of COLOR_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && HEX_RE.test(v.trim())) out[k] = v.trim().toUpperCase();
  }
  return Object.keys(out).length === 0 ? null : JSON.stringify(out);
}

function isFreeTier(tier) {
  return String(tier?.slug || '').toLowerCase() === FREE_TIER_SLUG;
}

function isValidBillingCycle(value) {
  return ['MONTHLY', 'YEARLY'].includes(value);
}

function normalizeRequestedVertical(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).toUpperCase();
  return VALID_VERTICALS.has(normalized) ? normalized : null;
}

function formatPlanDate(date) {
  if (!date) return null;
  try {
    return new Date(date).toISOString();
  } catch {
    return null;
  }
}

// Free/cancelled subscriptions store currentPeriodEnd = FOREVER() (~100 years
// out) as a "no expiry" sentinel — it must never surface as a real "next
// billing"/renewal date (it showed up as e.g. "Apr 25, 2126"). Anything more
// than 50 years ahead is the sentinel → null ("no renewal").
function formatRenewalDate(date) {
  const stamp = formatPlanDate(date);
  if (!stamp) return null;
  const FIFTY_YEARS_MS = 50 * 365 * 24 * 60 * 60 * 1000;
  return new Date(stamp).getTime() - Date.now() > FIFTY_YEARS_MS ? null : stamp;
}

async function resolveSelectedTier({ tierId, tierSlug }) {
  return tierId
    ? prisma.pricingTier.findUnique({ where: { id: tierId } })
    : prisma.pricingTier.findUnique({ where: { slug: tierSlug } });
}

async function resolveBusinessForBilling(businessId) {
  return prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      category: true,
      vertical: true,
      email: true,
      phone: true,
      country: true,
      billingPurchaserType: true,
      billingBusinessName: true,
      billingContactName: true,
      billingEmail: true,
      billingTaxId: true,
      billingAddressLine1: true,
      billingAddressLine2: true,
      billingCity: true,
      billingState: true,
      billingPostalCode: true,
      billingCountry: true,
      paddleBillingAddressId: true,
      paddleBillingBusinessId: true,
    },
  });
}

function buildPaddleCustomData({
  business,
  user,
  tierSlug,
  billingCycle,
  targetVertical = null,
  expectedPriceId = null,
  expectedCurrencyCode = null,
  expectedAmountMinor = null,
  checkoutKind = 'plan_subscription',
  requiresCard = true,
  trialDays = null,
  adminCouponCode = null,
  adminCouponDiscountId = null,
}) {
  return {
    businessId: business.id,
    businessSlug: business.slug,
    businessName: business.name,
    userId: user.id,
    userEmail: user.email,
    tierSlug,
    billingCycle,
    targetVertical: targetVertical || null,
    checkoutKind,
    requiresCard,
    trialDays: Number.isFinite(trialDays) ? trialDays : null,
    billingPurchaserType: business.billingPurchaserType || 'INDIVIDUAL',
    billingBusinessName: business.billingBusinessName || null,
    billingTaxId: business.billingTaxId || null,
    billingCountry: business.billingCountry || business.country || null,
    expectedPriceId: expectedPriceId || null,
    expectedCurrencyCode: expectedCurrencyCode || null,
    expectedAmountMinor: Number.isFinite(expectedAmountMinor) ? expectedAmountMinor : null,
    adminCouponCode: adminCouponCode || null,
    adminCouponDiscountId: adminCouponDiscountId || null,
  };
}

function assertPaddlePriceMatchesTierTrial(price, tier) {
  const expectedTrialDays = targetTrialDays(tier);
  const trial = price?.trial_period;
  const trialDays = Number(trial?.frequency);
  const trialInterval = String(trial?.interval || '').toLowerCase();
  const requiresPaymentMethod = (trial?.requires_payment_method ?? price?.requires_payment_method) !== false;

  if (!expectedTrialDays && !trial) {
    return;
  }

  if (expectedTrialDays && trialInterval === 'day' && trialDays === expectedTrialDays && requiresPaymentMethod) {
    return;
  }

  const expected = expectedTrialDays
    ? `a ${expectedTrialDays}-day trial and require a payment method`
    : 'no trial period';
  const err = new Error(
    `${tier.name} checkout is not ready: the Paddle price must have ${expected}. Re-run the Paddle catalog setup before accepting customers.`,
  );
  err.status = 409;
  err.code = 'paddle_trial_price_not_configured';
  throw err;
}

function billingNameForPaddle(business) {
  if (business.billingPurchaserType === 'BUSINESS') {
    return business.billingBusinessName || business.billingContactName || business.name;
  }
  return business.billingContactName || business.name;
}

function getPlatformBaseUrl(req = null) {
  const platformDomain = process.env.PLATFORM_DOMAIN || 'drifthr.com';
  const explicit = String(process.env.NEXT_PUBLIC_PLATFORM_URL || '').trim();
  if (explicit) return explicit;

  const frontendUrl = String(process.env.FRONTEND_URL || '').trim();
  if (frontendUrl) return frontendUrl;

  const forwardedHost = String(req?.get?.('X-Forwarded-Host') || req?.get?.('Host') || '').trim();
  if (forwardedHost) {
    const proto = String(req?.get?.('X-Forwarded-Proto') || '').trim() || 'https';
    return `${proto}://${forwardedHost.replace(/\/$/, '')}`;
  }

  return `https://${platformDomain}`;
}

function buildCheckoutLauncherUrl(req, business, cancelRedirect) {
  if (process.env.PADDLE_CHECKOUT_URL) return process.env.PADDLE_CHECKOUT_URL;

  // Post-B2 the launcher page lives on the platform itself at
  // drifthr.com/billing/checkout. Always build from the platform base
  // URL so the redirect is same-origin to the admin that opened it —
  // avoids cross-origin top-navigation and stale-subdomain pitfalls
  // we hit during the first Paddle attempt.
  const base = getPlatformBaseUrl(req).replace(/\/$/, '');
  const url = new URL(`${base}/billing/checkout`);
  url.searchParams.set('redirect', `/${business.slug}/admin?tab=subscription&billing=success`);
  // Where to send the user if they CANCEL/close checkout. During onboarding a
  // never-paid tenant must return to /onboarding (admin is empty/gated), not
  // the admin dashboard.
  if (cancelRedirect) url.searchParams.set('cancel', cancelRedirect);
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

function extractPaddleCustomerIdFromConflict(err) {
  const directId = String(
    err?.data?.error?.errors?.[0]?.meta?.existing_customer_id
    || err?.data?.meta?.existing_customer_id
    || ''
  ).trim();
  if (directId) return directId;

  const detail = String(
    err?.data?.error?.errors?.[0]?.detail
    || err?.message
    || ''
  );
  const match = detail.match(/\bcustomer of id\s+(ctm_[a-z0-9]+)\b/i);
  return match ? match[1] : null;
}

function paddleBusinessId(entity) {
  return String(entity?.custom_data?.businessId || '').trim();
}

function paddleTransactionIsCompleted(transaction) {
  return String(transaction?.status || '').toLowerCase() === 'completed';
}

function subscriptionIsTrialing(subscription) {
  return ['TRIALING', 'TRIAL'].includes(String(subscription?.status || '').toUpperCase())
    || subscription?.trial?.state === 'TRIAL_ACTIVE';
}

function paddleEntityMatchesBusiness({ entity, businessId, existing }) {
  const customBusinessId = paddleBusinessId(entity);
  if (customBusinessId && customBusinessId !== businessId) return false;

  const customerId = String(entity?.customer_id || '').trim();
  const expectedCustomerId = String(existing?.paddleCustomerId || '').trim();
  if (customerId && expectedCustomerId && customerId !== expectedCustomerId) return false;

  return Boolean(
    (customBusinessId && customBusinessId === businessId)
    || (customerId && expectedCustomerId && customerId === expectedCustomerId)
  );
}

async function clearScheduledCancellationIfNeeded(subscription) {
  if (!subscription?.paddleSubscriptionId || !subscription?.pendingTierSlug) return null;

  return updatePaddleSubscription(subscription.paddleSubscriptionId, {
    scheduled_change: null,
  });
}

async function getPaddleClientConfig(req, res) {
  try {
    const envToken = String(
      process.env.PADDLE_CLIENT_TOKEN
      || process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN
      || ''
    ).trim();

    let clientToken = envToken;
    if (!clientToken) {
      const tokens = await listPaddleClientTokens();
      if (Array.isArray(tokens) && tokens.length > 0) {
        clientToken = String(tokens[0].token || '').trim();
      }
    }

    if (!clientToken) {
      return res.status(500).json({
        message: 'No active Paddle client-side token is available. Add PADDLE_CLIENT_TOKEN or grant client_tokens.read to the API key.',
      });
    }

    return res.json({
      environment: getPaddleEnvironment(),
      clientToken,
    });
  } catch (err) {
    console.error('[getPaddleClientConfig] error:', err?.message || err);
    return res.status(err?.statusCode ?? err?.status ?? 500).json({
      message: err?.message || 'Could not load Paddle checkout configuration.',
    });
  }
}

// GET /api/subscription — current business's subscription + plan
async function getMySubscription(req, res) {
  if (!req.user.businessId) {
    return res.status(404).json({ message: 'You have no business yet' });
  }
  const subscription = await getBusinessSubscription(req.user.businessId);
  if (!subscription) {
    return res.status(404).json({ message: 'No subscription found' });
  }
  res.json({ subscription });
}

function cleanBillingText(value, max = 200) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

function serializeBillingProfile(business) {
  return {
    purchaserType: business.billingPurchaserType || 'INDIVIDUAL',
    businessName: business.billingBusinessName || '',
    contactName: business.billingContactName || '',
    email: business.billingEmail || '',
    taxId: business.billingTaxId || '',
    addressLine1: business.billingAddressLine1 || '',
    addressLine2: business.billingAddressLine2 || '',
    city: business.billingCity || '',
    state: business.billingState || '',
    postalCode: business.billingPostalCode || '',
    country: business.billingCountry || '',
  };
}

async function getBillingProfile(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const business = await prisma.business.findUnique({
    where: { id: req.user.businessId },
    select: {
      billingPurchaserType: true,
      billingBusinessName: true,
      billingContactName: true,
      billingEmail: true,
      billingTaxId: true,
      billingAddressLine1: true,
      billingAddressLine2: true,
      billingCity: true,
      billingState: true,
      billingPostalCode: true,
      billingCountry: true,
    },
  });
  if (!business) return res.status(404).json({ message: 'Business not found' });
  return res.json({ billingProfile: serializeBillingProfile(business) });
}

async function updateBillingProfile(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  const purchaserType = String(req.body?.purchaserType || 'INDIVIDUAL').toUpperCase() === 'BUSINESS'
    ? 'BUSINESS'
    : 'INDIVIDUAL';
  const country = cleanBillingText(req.body?.country, 2);
  const email = cleanBillingText(req.body?.email, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: 'Enter a valid billing email.' });
  }
  const normalizedBillingCountry = normalizeCountryCode(country);
  if (country && !normalizedBillingCountry) {
    return res.status(400).json({ message: 'Billing country must be a valid ISO-2 country code.' });
  }
  const existing = await prisma.business.findUnique({
    where: { id: req.user.businessId },
    select: {
      id: true,
      country: true,
      billingCountry: true,
      subscription: {
        select: {
          paddleSubscriptionId: true,
          stripeSubscriptionId: true,
          razorpaySubscriptionId: true,
        },
      },
    },
  });
  if (!existing) return res.status(404).json({ message: 'Business not found' });

  const targetGateway = resolveGateway(normalizedBillingCountry || existing.country);
  const migrationBlock = gatewayMigrationBlock({
    subscription: existing.subscription,
    targetGateway,
    paidTarget: true,
  });
  if (migrationBlock) {
    return res.status(409).json({
      ...migrationBlock,
      message: `Changing billing country would move this subscription from ${gatewayLabel(migrationBlock.activeGateway)} to ${gatewayLabel(migrationBlock.targetGateway)}. Keep the current billing country for this account, or contact support to migrate billing safely.`,
    });
  }

  const business = await prisma.business.update({
    where: { id: req.user.businessId },
    data: {
      billingPurchaserType: purchaserType,
      billingBusinessName: cleanBillingText(req.body?.businessName, 160),
      billingContactName: cleanBillingText(req.body?.contactName, 160),
      billingEmail: email,
      billingTaxId: cleanBillingText(req.body?.taxId, 80),
      billingAddressLine1: cleanBillingText(req.body?.addressLine1, 240),
      billingAddressLine2: cleanBillingText(req.body?.addressLine2, 240),
      billingCity: cleanBillingText(req.body?.city, 120),
      billingState: cleanBillingText(req.body?.state, 120),
      billingPostalCode: cleanBillingText(req.body?.postalCode, 40),
      billingCountry: normalizedBillingCountry,
    },
    select: {
      billingPurchaserType: true,
      billingBusinessName: true,
      billingContactName: true,
      billingEmail: true,
      billingTaxId: true,
      billingAddressLine1: true,
      billingAddressLine2: true,
      billingCity: true,
      billingState: true,
      billingPostalCode: true,
      billingCountry: true,
    },
  });

  return res.json({
    billingProfile: serializeBillingProfile(business),
    billingRoute: {
      country: normalizedBillingCountry || existing.country || null,
      gateway: targetGateway,
      gatewayLabel: gatewayLabel(targetGateway),
    },
  });
}

function parsePageSize(value, fallback = 8, max = 20) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

async function loadBusinessBillingSnapshot(subscription, { after = null, perPage = 8 } = {}) {
  const billingOverview = {
    currentPlan: subscription?.tier
      ? { name: subscription.tier.name, slug: subscription.tier.slug }
      : null,
    status: subscription?.status || null,
    billingCycle: subscription?.billingCycle || null,
    currentPeriodEnd: formatRenewalDate(subscription?.currentPeriodEnd),
    pendingTierSlug: subscription?.pendingTierSlug || null,
    pendingBillingCycle: subscription?.pendingBillingCycle || null,
    pendingChangeEffectiveAt: formatPlanDate(subscription?.pendingChangeEffectiveAt),
    paddleCustomerId: subscription?.paddleCustomerId || null,
    paddleSubscriptionId: subscription?.paddleSubscriptionId || null,
    paddleTransactionId: subscription?.paddleTransactionId || null,
    collectionMode: null,
    currentPeriodStart: null,
    nextBilledAt: formatRenewalDate(subscription?.currentPeriodEnd),
  };

  // Promotion (admin coupon) applied to this business — surfaced so the TENANT
  // can see their promo on the billing page ("Lifetime free — no renewal needed"
  // / "3 months free — until <date>"), not just the super-admin. lifetime mirrors
  // the FOREVER convention (currentPeriodEnd > 50yr out, e.g. a LIFETIME_FREE coupon).
  billingOverview.lifetime = !!subscription?.currentPeriodEnd
    && (new Date(subscription.currentPeriodEnd).getTime() - Date.now() > 50 * 365 * 24 * 60 * 60 * 1000);
  billingOverview.promo = null;
  if (subscription?.businessId) {
    const red = await prisma.adminCouponRedemption.findFirst({
      where: { businessId: subscription.businessId },
      orderBy: { createdAt: 'desc' },
      include: { coupon: { select: { code: true, benefitType: true, benefitValue: true, benefitUnit: true } } },
    }).catch(() => null);
    if (red?.coupon) {
      const c = red.coupon;
      const label = c.benefitType === 'LIFETIME_FREE' ? 'Lifetime free'
        : c.benefitType === 'FREE_PERIOD' ? `${c.benefitValue || ''} ${String(c.benefitUnit || 'days').toLowerCase()} free`.trim()
        : c.benefitType === 'PERCENT_OFF' ? `${c.benefitValue || ''}% off`
        : c.benefitType === 'FIXED_OFF' ? `${c.benefitValue || ''} off` : 'Promotion';
      billingOverview.promo = { code: c.code, benefitType: c.benefitType, label };
    }
  }

  // Decide the history source by the ACTIVE gateway, not by paddleCustomerId
  // presence — paddleCustomerId is sticky once set, so a tenant who migrated
  // Paddle→Razorpay/Stripe would otherwise have their new gateway charges hidden
  // behind the dead Paddle subscription. (B8)
  const { activeGatewayFromSubscription } = require('../lib/billing/gatewayRouter');
  const activeGateway = String(subscription?.gateway || activeGatewayFromSubscription(subscription) || 'PADDLE').toUpperCase();

  let paddleSubscription = null;
  if (activeGateway === 'PADDLE' && subscription?.paddleSubscriptionId) {
    paddleSubscription = await getPaddleSubscription(subscription.paddleSubscriptionId).catch(() => null);
  }

  if (paddleSubscription) {
    billingOverview.collectionMode = paddleSubscription.collection_mode || null;
    billingOverview.currentPeriodStart = paddleSubscription?.current_billing_period?.starts_at || null;
    billingOverview.currentPeriodEnd = paddleSubscription?.current_billing_period?.ends_at || billingOverview.currentPeriodEnd;
    billingOverview.nextBilledAt = paddleSubscription?.next_billed_at || billingOverview.nextBilledAt;
    if (!billingOverview.pendingChangeEffectiveAt && paddleSubscription?.scheduled_change?.effective_at) {
      billingOverview.pendingChangeEffectiveAt = paddleSubscription.scheduled_change.effective_at;
    }
  }

  if (activeGateway !== 'PADDLE' || !subscription?.paddleCustomerId) {
    // Non-Paddle gateways (Razorpay / Stripe) have no Paddle customer, so their
    // charges live in our local PaymentAttempt ledger (written by the gateway
    // webhooks). Surface them in the same shape the UI expects so Payment
    // history / Latest payment work across every gateway, not just Paddle.
    let transactions = [];
    if (prisma.paymentAttempt && subscription?.businessId) {
      const rows = await prisma.paymentAttempt.findMany({
        where: { businessId: subscription.businessId, provider: { not: 'paddle' } },
        orderBy: { createdAt: 'desc' },
        take: perPage,
      }).catch(() => []);
      const plan = subscription?.tier
        ? { name: subscription.tier.name, slug: subscription.tier.slug, billingCycle: subscription.billingCycle || null }
        : null;
      transactions = rows.map((row) => {
        const completed = String(row.status || '').toUpperCase() === 'COMPLETED';
        const provider = String(row.provider || '').toLowerCase();
        return {
          id: row.id,
          status: String(row.status || '').toUpperCase(),
          currencyCode: row.currencyCode || null,
          totalMinor: row.amountMinor ?? null,
          balanceMinor: 0,
          invoiceNumber: row.invoiceNumber || null,
          // India (Razorpay) → our own GST invoice; NZ (Stripe) → Stripe's invoice.
          // Both surface a downloadable invoice once the charge has completed.
          hasInvoice: completed && (provider === 'razorpay' || provider === 'stripe'),
          createdAt: row.createdAt ? row.createdAt.toISOString() : null,
          billedAt: row.createdAt ? row.createdAt.toISOString() : null,
          paidAt: completed && row.createdAt ? row.createdAt.toISOString() : null,
          plan,
        };
      });
    }
    return {
      overview: billingOverview,
      transactions,
      pagination: { nextAfter: null },
    };
  }

  const { data, meta } = await listPaddleTransactions({
    customer_id: subscription.paddleCustomerId,
    order_by: 'created_at[DESC]',
    per_page: perPage,
    after,
  });
  const context = await buildBillingContext(data);
  const transactions = data
    .map((transaction) => serializeBillingTransaction(transaction, context))
    .filter((transaction) => !transaction.business || transaction.business.id === subscription.businessId);

  return {
    overview: billingOverview,
    transactions,
    pagination: {
      nextAfter: extractAfterCursor(meta?.pagination?.next),
    },
  };
}

async function getBilling(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  const subscription = await getBusinessSubscription(req.user.businessId);
  if (!subscription) {
    return res.status(404).json({ message: 'No subscription found' });
  }

  if (!isPaddleConfigured()) {
    // Paddle isn't configured (e.g. a Razorpay-only / Stripe-only deployment),
    // but the tenant may still bill via another gateway. Route through the same
    // snapshot loader so their local gateway charges (Payment history) and the
    // renewal date (from currentPeriodEnd) still surface — only the Paddle
    // customer-portal action is unavailable here.
    const snapshot = await loadBusinessBillingSnapshot(subscription, {
      after: String(req.query.after || '').trim() || null,
      perPage: parsePageSize(req.query.perPage, 8, 12),
    }).catch((err) => {
      console.error('[getBilling] snapshot (no-paddle) failed:', err?.message || err);
      return {
        overview: {
          currentPlan: subscription?.tier ? { name: subscription.tier.name, slug: subscription.tier.slug } : null,
          status: subscription?.status || null,
          billingCycle: subscription?.billingCycle || null,
          currentPeriodEnd: formatRenewalDate(subscription?.currentPeriodEnd),
          pendingTierSlug: subscription?.pendingTierSlug || null,
          pendingBillingCycle: subscription?.pendingBillingCycle || null,
          pendingChangeEffectiveAt: formatPlanDate(subscription?.pendingChangeEffectiveAt),
          paddleCustomerId: null,
          paddleSubscriptionId: null,
          paddleTransactionId: null,
          collectionMode: null,
          currentPeriodStart: null,
          nextBilledAt: formatRenewalDate(subscription?.currentPeriodEnd),
        },
        transactions: [],
        pagination: { nextAfter: null },
      };
    });
    return res.json({
      configured: false,
      overview: snapshot.overview,
      // Paddle unconfigured here, but a Stripe (NZ) tenant still has a portal.
      actions: { canOpenPortal: Boolean(subscription.stripeCustomerId) },
      transactions: snapshot.transactions,
      pagination: snapshot.pagination,
    });
  }

  try {
    const snapshot = await loadBusinessBillingSnapshot(subscription, {
      after: String(req.query.after || '').trim() || null,
      perPage: parsePageSize(req.query.perPage, 8, 12),
    });

    return res.json({
      configured: true,
      overview: snapshot.overview,
      actions: {
        // Paddle + Stripe both have a hosted customer portal (card change,
        // cancel, invoices). Razorpay has none → no button (support-managed).
        canOpenPortal: Boolean(subscription.paddleCustomerId || subscription.stripeCustomerId),
      },
      transactions: snapshot.transactions,
      pagination: snapshot.pagination,
    });
  } catch (err) {
    console.error('[getBilling] error:', err?.message || err);
    return res.status(err?.statusCode ?? err?.status ?? 500).json({
      message: err?.message || 'Could not load billing details from Paddle.',
    });
  }
}

async function getBillingWorkspace(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  try {
    const workspace = await buildBillingWorkspace({
      businessId: req.user.businessId,
      transactionLimit: 8,
      eventLimit: 24,
    });
    return res.json({ workspace });
  } catch (err) {
    console.error('[getBillingWorkspace] error:', err?.message || err);
    return res.status(err?.statusCode ?? err?.status ?? 500).json({
      message: err?.message || 'Could not load billing workspace.',
    });
  }
}

async function previewBillingChange(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  try {
    const preview = await buildBillingChangePreview({
      businessId: req.user.businessId,
      tierId: req.body?.tierId || null,
      tierSlug: req.body?.tierSlug || null,
      targetVertical: req.body?.targetVertical || null,
      billingCycle: req.body?.billingCycle || 'MONTHLY',
    });
    return res.json({ preview });
  } catch (err) {
    console.error('[previewBillingChange] error:', err?.message || err);
    return res.status(err?.statusCode ?? err?.status ?? 500).json({
      message: err?.message || 'Could not preview billing change.',
    });
  }
}

async function runSelectPlanCommand(req, body) {
  const commandReq = Object.create(req);
  commandReq.body = body;
  commandReq.user = req.user;

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
    const err = new Error(commandRes.payload?.message || 'Could not change plan.');
    err.status = commandRes.statusCode;
    err.payload = commandRes.payload;
    throw err;
  }
  return commandRes.payload;
}

async function commitBillingChange(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  const tierId = req.body?.tierId || null;
  const tierSlug = req.body?.tierSlug || null;
  const billingCycle = req.body?.billingCycle || 'MONTHLY';
  const targetVertical = normalizeRequestedVertical(req.body?.targetVertical);

  if (!tierId && !tierSlug) {
    return res.status(400).json({ message: 'tierId or tierSlug is required' });
  }
  if (!isValidBillingCycle(billingCycle)) {
    return res.status(400).json({ message: 'billingCycle must be MONTHLY or YEARLY' });
  }
  if (req.body?.targetVertical && !targetVertical) {
    return res.status(400).json({ message: 'targetVertical must be STATIC, APPOINTMENT, or ECOMMERCE' });
  }

  try {
    const preview = await buildBillingChangePreview({
      businessId: req.user.businessId,
      tierId,
      tierSlug,
      targetVertical,
      billingCycle,
    });

    if (
      targetVertical
      && preview.target?.tier?.vertical !== targetVertical
      && preview.target?.tier?.slug !== FREE_TIER_SLUG
    ) {
      return res.status(409).json({
        message: 'The selected plan is not available for the selected business type.',
        preview,
      });
    }

    if (!preview.safeToCommit) {
      return res.status(409).json({
        message: preview.blocking?.[0]?.message || 'This billing change is not safe to commit.',
        preview,
      });
    }

    const result = await runSelectPlanCommand(req, {
      tierId,
      tierSlug,
      billingCycle,
      targetVertical,
    });

    await prisma.pricingAuditLog.create({
      data: {
        entityType: 'billing_change',
        entityId: req.user.businessId,
        action: 'CREATED',
        changedBy: req.user.id,
        oldValue: preview.current,
        newValue: {
          target: preview.target,
          action: result?.action || null,
          requiresCheckout: preview.money?.requiresCheckout || false,
          pendingVertical: targetVertical && targetVertical !== preview.current?.vertical ? targetVertical : null,
        },
        note: 'Atomic billing change command accepted after preview validation',
      },
    }).catch((auditErr) => {
      console.error('[commitBillingChange] audit log failed', auditErr?.message || auditErr);
    });

    return res.json({ ...result, preview });
  } catch (err) {
    console.error('[commitBillingChange] error:', err?.message || err);
    return res.status(err?.statusCode ?? err?.status ?? 500).json({
      ...(err?.payload || {}),
      message: err?.message || 'Could not commit billing change.',
    });
  }
}

async function openBillingPortal(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  const subscription = await getBusinessSubscription(req.user.businessId);
  const activeGateway = activeGatewayFromSubscription(subscription) || subscription?.gateway || 'PADDLE';

  if (activeGateway === 'STRIPE') {
    if (!subscription?.stripeCustomerId) {
      return res.status(409).json({
        message: 'This business does not have a Stripe customer yet. Choose a paid plan first.',
      });
    }
    const stripeGw = getGateway('STRIPE');
    if (!stripeGw.isConfigured()) {
      return res.status(500).json({ message: 'Stripe is not configured on the backend.' });
    }
    try {
      const returnUrl = `${req.headers.origin || process.env.PLATFORM_ORIGIN || 'https://app.drifthr.com'}/dashboard?tab=subscription`;
      const session = await stripeGw.createBillingPortalSession({
        customerRef: subscription.stripeCustomerId,
        returnUrl,
      });
      if (!session?.url) {
        return res.status(502).json({ message: 'Stripe did not return a customer portal URL.' });
      }
      return res.json({ url: session.url, gateway: 'STRIPE' });
    } catch (err) {
      console.error('[openBillingPortal:stripe] error:', err?.message || err);
      return res.status(err?.statusCode ?? err?.status ?? 500).json({
        message: err?.message || 'Could not open the Stripe billing portal.',
      });
    }
  }

  if (activeGateway === 'RAZORPAY') {
    return res.status(409).json({
      code: 'RAZORPAY_PORTAL_MANAGED',
      gateway: 'RAZORPAY',
      message: 'Razorpay subscription billing does not have a self-serve customer portal in DriftHR yet. Use support for cancellation, invoice, or mandate changes.',
    });
  }

  if (!isPaddleConfigured()) {
    return res.status(500).json({ message: 'Paddle is not configured on the backend.' });
  }
  if (!subscription?.paddleCustomerId) {
    return res.status(409).json({
      message: 'This business does not have a Paddle customer yet. Choose a paid plan first.',
    });
  }

  try {
    const session = await createPaddleCustomerPortalSession(
      subscription.paddleCustomerId,
      subscription.paddleSubscriptionId
        ? { subscription_ids: [subscription.paddleSubscriptionId] }
        : {}
    );
    const url = session?.urls?.general?.overview || null;
    if (!url) {
      return res.status(502).json({ message: 'Paddle did not return a customer portal URL.' });
    }
    return res.json({ url, gateway: 'PADDLE' });
  } catch (err) {
    console.error('[openBillingPortal] error:', err?.message || err);
    return res.status(err?.statusCode ?? err?.status ?? 500).json({
      message: err?.message || 'Could not open the Paddle billing portal.',
    });
  }
}

async function getBillingInvoice(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  const subscription = await getBusinessSubscription(req.user.businessId);
  const activeGateway = activeGatewayFromSubscription(subscription) || subscription?.gateway || 'PADDLE';

  if (activeGateway === 'STRIPE') {
    if (!subscription?.stripeCustomerId && !subscription?.stripeSubscriptionId) {
      return res.status(404).json({ message: 'No Stripe billing record found for this business.' });
    }
    const stripeGw = getGateway('STRIPE');
    if (!stripeGw.isConfigured()) {
      return res.status(500).json({ message: 'Stripe is not configured on the backend.' });
    }
    // The client passes our local PaymentAttempt id; the actual Stripe invoice
    // id lives on that row (paddleTransactionId is the generic gateway txn id
    // column). Resolve it, falling back to the raw param for older callers.
    const localRow = await prisma.paymentAttempt.findFirst({
      where: { id: req.params.transactionId, businessId: req.user.businessId },
      select: { paddleTransactionId: true },
    }).catch(() => null);
    const stripeRef = localRow?.paddleTransactionId || req.params.transactionId;
    try {
      const url = await stripeGw.getInvoiceUrl(stripeRef, {
        customerRef: subscription.stripeCustomerId,
        subscriptionRef: subscription.stripeSubscriptionId,
      });
      if (!url) {
        return res.status(409).json({ message: 'A Stripe invoice PDF is not available for this payment yet.' });
      }
      return res.json({ url, gateway: 'STRIPE' });
    } catch (err) {
      console.error('[getBillingInvoice:stripe] error:', err?.message || err);
      return res.status(err?.statusCode ?? err?.status ?? 500).json({
        message: err?.message || 'Could not load the Stripe invoice.',
      });
    }
  }

  if (activeGateway === 'RAZORPAY') {
    // Self-billed (India) — we are the merchant of record, so we issue our own
    // GST tax invoice. Point the client at the printable HTML invoice (the buyer
    // saves it as PDF). The view route re-validates ownership + paid status.
    return res.json({
      url: `/api/subscription/billing/invoices/${encodeURIComponent(req.params.transactionId)}/view`,
      gateway: 'RAZORPAY',
    });
  }

  if (!isPaddleConfigured()) {
    return res.status(500).json({ message: 'Paddle is not configured on the backend.' });
  }
  if (!subscription?.paddleCustomerId && !subscription?.paddleSubscriptionId) {
    return res.status(404).json({ message: 'No Paddle billing record found for this business.' });
  }

  try {
    const transaction = await getPaddleTransaction(req.params.transactionId);
    const belongsToBusiness = (
      subscription?.paddleCustomerId
      && transaction?.customer_id === subscription.paddleCustomerId
    ) || (
      subscription?.paddleSubscriptionId
      && transaction?.subscription_id === subscription.paddleSubscriptionId
    );

    if (!belongsToBusiness) {
      return res.status(404).json({ message: 'That invoice does not belong to this business.' });
    }
    if (!invoiceAvailableForTransaction(transaction)) {
      return res.status(409).json({ message: 'A PDF invoice is not available for this payment yet.' });
    }

    const invoice = await getPaddleTransactionInvoice(req.params.transactionId, 'inline');
    if (!invoice?.url) {
      return res.status(502).json({ message: 'Paddle did not return an invoice URL.' });
    }
    return res.json({ url: invoice.url, gateway: 'PADDLE' });
  } catch (err) {
    console.error('[getBillingInvoice] error:', err?.message || err);
    return res.status(err?.statusCode ?? err?.status ?? 500).json({
      message: err?.message || 'Could not load the invoice PDF.',
    });
  }
}

// GET /api/subscription/billing/invoices/:transactionId/view — renders OUR own
// GST tax invoice (printable HTML → Save as PDF) for a self-billed India
// (Razorpay) charge. Paddle/Stripe charges are invoiced by the gateway.
async function viewSubscriptionInvoice(req, res) {
  if (!req.user.businessId) return res.status(400).send('Set up your business first.');

  const business = await prisma.business.findUnique({
    where: { id: req.user.businessId },
    select: {
      id: true, name: true, email: true, country: true, state: true,
      billingPurchaserType: true, billingBusinessName: true, billingContactName: true,
      billingEmail: true, billingTaxId: true, billingAddressLine1: true, billingAddressLine2: true,
      billingCity: true, billingState: true, billingPostalCode: true, billingCountry: true,
      subscription: { select: { billingCycle: true, gateway: true, tier: { select: { name: true } } } },
    },
  });
  if (!business) return res.status(404).send('Business not found.');

  const payment = await prisma.paymentAttempt.findFirst({
    where: { id: req.params.transactionId, businessId: business.id },
  });
  if (!payment) return res.status(404).send('Payment not found.');
  if (String(payment.status || '').toUpperCase() !== 'COMPLETED') {
    return res.status(409).send('An invoice is available once the payment has completed.');
  }
  if (String(payment.provider || '').toLowerCase() !== 'razorpay') {
    return res.status(409).send('This payment is invoiced by the payment provider, not DriftHR.');
  }

  try {
    const { ensureInvoiceNumber, buildInvoiceData, renderInvoiceHtml } = require('../lib/subscriptionInvoice');
    const invoiceNumber = await ensureInvoiceNumber(payment);
    const cycle = business.subscription?.billingCycle ? ` (${String(business.subscription.billingCycle).toLowerCase()})` : '';
    const planName = business.subscription?.tier?.name
      ? `${business.subscription.tier.name}${cycle} subscription`
      : 'DriftHR subscription';
    const data = buildInvoiceData({ business, paymentAttempt: payment, planName, invoiceNumber });
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderInvoiceHtml(data));
  } catch (err) {
    console.error('[viewSubscriptionInvoice] error:', err?.message || err);
    return res.status(500).send('Could not generate the invoice. Please contact support.');
  }
}

// POST /api/subscription/start-trial — compatibility endpoint for old clients.
// Public trials are card-required gateway trials. This endpoint never writes
// local trial/access state; it opens the same secure checkout as /select and
// webhook/API sync becomes the source of truth for TRIALING.
async function startTrial(req, res) {
  try {
    const { tierSlug } = req.body || {};
    if (!tierSlug) return res.status(400).json({ message: 'tierSlug is required' });

    const tier = await prisma.pricingTier.findUnique({
      where: { slug: String(tierSlug).toLowerCase() },
    });
    if (!tier || !tier.isActive) {
      return res.status(404).json({ message: 'Tier not found' });
    }
    if (isFreeTier(tier)) {
      return res.status(409).json({ message: 'Trials are available only on paid plans.' });
    }

    req.body = {
      ...req.body,
      tierSlug: tier.slug,
      billingCycle: req.body.billingCycle || 'MONTHLY',
    };
    return selectPlan(req, res);
  } catch (err) {
    console.error('[startTrial] error:', err?.message || err);
    return res.status(err?.statusCode ?? err?.status ?? 500).json({
      message: err?.message || 'Could not start trial.',
    });
  }
}

// POST /api/subscription/select — business-admin billing workflow.
// Accepts either tierId OR tierSlug. countryCode is intentionally NOT
// read from req.body — pricing zone derives from the stored billing profile
// country, falling back to the signup country. This keeps preview, checkout,
// and Paddle billing-profile tax/address data on the same server-owned source.
// Stripe (New Zealand) checkout — creates a hosted Stripe Checkout Session for
// a new subscriber, or swaps the price on an existing Stripe subscription. The
// actual entitlement flip happens via the Stripe webhook, mirroring Paddle.
async function handleStripeCheckout({ req, res, business, tier, selectedBillingCycle, pendingVertical, subscription }) {
  const stripeGw = getGateway('STRIPE');
  if (!stripeGw.isConfigured()) {
    return res.status(503).json({ message: 'Stripe is not configured on the backend yet.' });
  }

  // Stripe is the NZ gateway, so its prices live on the NZ TierPrice row —
  // look them up by the GATEWAY's owned country, not business.billingCountry
  // (a tenant with a null/odd billingCountry was sent to Stripe by routing yet
  // got a spurious 409 because the NZ price row was looked up under their own
  // country). (B24)
  const country = GATEWAY_TARGETS.STRIPE.country;
  let priceRow = await prisma.tierPrice.findFirst({ where: { tierId: tier.id, countryCode: country } });
  let stripePriceId = selectedBillingCycle === 'YEARLY'
    ? priceRow?.stripePriceIdAnnual
    : priceRow?.stripePriceIdMonthly;
  if (!stripePriceId) {
    // Self-heal: the price simply wasn't synced to Stripe yet — publish it now
    // (idempotent) and re-read so the signup doesn't dead-end.
    stripePriceId = await ensurePublishedPriceId({ gateway: 'STRIPE', tierId: tier.id, countryCode: country, billingCycle: selectedBillingCycle });
    priceRow = await prisma.tierPrice.findFirst({ where: { tierId: tier.id, countryCode: country } });
  }
  if (!stripePriceId) {
    return res.status(409).json({
      message: `Stripe price for ${tier.name} (${selectedBillingCycle.toLowerCase()}) is not set up yet. Seed the ${country} TierPrice for this tier, then retry.`,
    });
  }

  const metadata = {
    businessId: business.id,
    businessSlug: business.slug,
    userId: req.user.id,
    userEmail: req.user.email || '',
    tierSlug: tier.slug,
    billingCycle: selectedBillingCycle,
    ...(pendingVertical ? { targetVertical: pendingVertical } : {}),
  };

  // Existing Stripe subscriber → swap the price in place (proration), instead of
  // opening a second checkout (which would create a duplicate subscription).
  if (subscription?.stripeSubscriptionId) {
    const direction = classifyPlanChange({
      currentTier: subscription.tier,
      targetTier: tier,
      currentBillingCycle: subscription.billingCycle,
      targetBillingCycle: selectedBillingCycle,
    });
    const timing = changeTiming(direction);
    const prorationBehavior = stripeProrationBehaviorFor({ direction, subscription });
    const stripe = stripeGw.raw();
    let staleSubscription = false;
    try {
      const current = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
      const itemId = current?.items?.data?.[0]?.id;
      if (!itemId) {
        return res.status(409).json({ message: 'Could not locate the current Stripe subscription item to change.' });
      }
      await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
        items: [{ id: itemId, price: stripePriceId }],
        proration_behavior: prorationBehavior,
        ...(prorationBehavior === 'always_invoice' ? { payment_behavior: 'pending_if_incomplete' } : {}),
        metadata,
      });
      const effectiveAt = timing === 'period_end'
        ? pendingEffectiveAtFromGateway({ subscription, stripeSubscription: current })
        : null;
      const pending = await prisma.subscription.update({
        where: { businessId: req.user.businessId },
        data: timing === 'period_end'
          ? {
              pendingTierSlug: tier.slug,
              pendingBillingCycle: selectedBillingCycle,
              pendingChangeEffectiveAt: effectiveAt,
              pendingVertical: pendingVertical || null,
            }
          : {
              pendingTierSlug: null,
              pendingBillingCycle: null,
              pendingChangeEffectiveAt: null,
              pendingVertical: pendingVertical || null,
            },
        include: { tier: true },
      });
      return res.json({
        action: timing === 'period_end' ? 'scheduled' : 'updated',
        gateway: 'STRIPE',
        subscription: await hydrateSubscription(pending),
        message: timing === 'period_end'
          ? `${tier.name} is scheduled for your next renewal. Your current plan stays active until then.`
          : `${tier.name} is being applied. Stripe will charge the prorated difference now and confirm shortly.`,
      });
    } catch (err) {
      // A checkout that was started but never completed leaves the Stripe
      // subscription in incomplete / incomplete_expired / canceled (or it was
      // deleted) — none of which can be updated in place. Don't dead-end the
      // user; fall through and start a fresh checkout below.
      const msg = String(err?.message || '');
      const code = err?.code || err?.raw?.code || '';
      const stale = err?.statusCode === 404 || code === 'resource_missing'
        || /incomplete|cancel|expired|no such subscription|invalid.*status|cannot be updated|not be updated/i.test(msg);
      if (!stale) {
        return res.status(err.statusCode || err.status || 502).json({ message: err.message || 'Could not update the Stripe subscription.' });
      }
      staleSubscription = true;
    }
    if (staleSubscription) { /* fall through to create a fresh checkout below */ }
  }

  const base = getPlatformBaseUrl(req).replace(/\/$/, '');
  const successUrl = `${base}/${business.slug}/admin?tab=subscription&billing=success&session_id={CHECKOUT_SESSION_ID}`;
  // Onboarding cancel returns to /onboarding (admin is empty until they pay).
  const cancelUrl = req.body?.fromOnboarding
    ? `${base}/onboarding`
    : `${base}/${business.slug}/admin?tab=subscription`;

  const { url } = await stripeGw.createSubscriptionCheckout({
    priceRef: stripePriceId,
    quantity: 1,
    trialDays: targetTrialDays(tier),
    customerRef: subscription?.stripeCustomerId || undefined,
    customerEmail: business.billingEmail || business.email || req.user.email || undefined,
    successUrl,
    cancelUrl,
    metadata,
    businessId: business.id,
    // Re-initiating the same plan within 24h returns the same session, not a
    // second subscription (B9).
    idempotencyKey: `stripe_checkout:${business.id}:${tier.slug}:${selectedBillingCycle}`,
  });
  if (!url) {
    return res.status(502).json({ message: 'Could not create a Stripe checkout session.' });
  }

  const updated = await prisma.subscription.update({
    where: { businessId: req.user.businessId },
    data: {
      gateway: 'STRIPE',
      pendingTierSlug: null,
      pendingBillingCycle: null,
      pendingChangeEffectiveAt: null,
      pendingVertical: pendingVertical || null,
    },
    include: { tier: true },
  });

  return res.json({
    action: 'checkout',
    gateway: 'STRIPE',
    checkoutUrl: url,
    subscription: await hydrateSubscription(updated),
    message: `Continue to secure checkout to activate ${tier.name}.`,
  });
}

// Razorpay (India) checkout — creates a Razorpay Subscription (UPI Autopay /
// card mandate) and returns its hosted authorization URL (short_url). Existing
// Razorpay subscribers are updated in place when the gateway allows it; webhook
// sync remains the source of truth for final entitlement state.
async function handleRazorpayCheckout({ req, res, business, tier, selectedBillingCycle, pendingVertical, subscription }) {
  const razorpayGw = getGateway('RAZORPAY');
  if (!razorpayGw.isConfigured()) {
    return res.status(503).json({ message: 'Razorpay is not configured on the backend yet.' });
  }

  // ── Charge-at-will path (flag-gated; DORMANT unless RAZORPAY_CHARGE_AT_WILL=on)
  // For a TOKEN subscriber, a plan change is LOCAL (upgrade = prorated charge on
  // the saved mandate + flip tier; downgrade = schedule the lower amount for next
  // cycle) — no Razorpay plan update, so the UPI "can't update in place" dead-end
  // never happens. New sign-ups / migrations register a high-max mandate via the
  // auth-order flow (frontend completes it with Checkout.js recurring:1).
  {
    const { chargeAtWillEnabled, applyTokenPlanChange, startMandateAuth } = require('../lib/billing/chargeAtWill');
    if (chargeAtWillEnabled()) {
      try {
        if (subscription?.billingModel === 'TOKEN' && subscription?.razorpayTokenId) {
          const direction = classifyPlanChange({
            currentTier: subscription.tier, targetTier: tier,
            currentBillingCycle: subscription.billingCycle, targetBillingCycle: selectedBillingCycle,
          });
          const result = await applyTokenPlanChange({ subscription, targetTier: tier, targetBillingCycle: selectedBillingCycle, direction });
          if (result.action === 'reauthorize') {
            const auth = await startMandateAuth({ business, tier, billingCycle: selectedBillingCycle, subscription });
            return res.json({ ...auth, note: result.message });
          }
          const fresh = result.subscription
            || await prisma.subscription.findUnique({ where: { businessId: req.user.businessId }, include: { tier: true } });
          return res.json({ gateway: 'RAZORPAY', action: result.action, message: result.message, subscription: await hydrateSubscription(fresh) });
        }
        // New sign-up, or migrating a legacy Subscriptions tenant → mandate auth.
        return res.json(await startMandateAuth({ business, tier, billingCycle: selectedBillingCycle, subscription }));
      } catch (err) {
        return res.status(err.status || 502).json({ message: err.message || 'Charge-at-will checkout failed.' });
      }
    }
  }

  // Razorpay is the IN gateway → look its plans up by the gateway's owned
  // country (IN), not business.billingCountry, to avoid a spurious 409. (B24)
  const country = GATEWAY_TARGETS.RAZORPAY.country;
  let priceRow = await prisma.tierPrice.findFirst({ where: { tierId: tier.id, countryCode: country } });
  let planId = selectedBillingCycle === 'YEARLY' ? priceRow?.razorpayPlanIdAnnual : priceRow?.razorpayPlanIdMonthly;
  if (!planId) {
    // Self-heal: publish the Razorpay plan now (idempotent) and re-read.
    planId = await ensurePublishedPriceId({ gateway: 'RAZORPAY', tierId: tier.id, countryCode: country, billingCycle: selectedBillingCycle });
    priceRow = await prisma.tierPrice.findFirst({ where: { tierId: tier.id, countryCode: country } });
  }
  if (!planId) {
    return res.status(409).json({
      message: `Razorpay plan for ${tier.name} (${selectedBillingCycle.toLowerCase()}) is not set up yet. Seed the ${country} TierPrice for this tier, then retry.`,
    });
  }

  const metadata = {
    businessId: business.id,
    businessSlug: business.slug,
    userId: req.user.id,
    tierSlug: tier.slug,
    billingCycle: selectedBillingCycle,
    ...(pendingVertical ? { targetVertical: pendingVertical } : {}),
  };

  if (subscription?.razorpaySubscriptionId) {
    const direction = classifyPlanChange({
      currentTier: subscription.tier,
      targetTier: tier,
      currentBillingCycle: subscription.billingCycle,
      targetBillingCycle: selectedBillingCycle,
    });
    const timing = changeTiming(direction);
    const scheduleChangeAt = razorpayScheduleChangeAtFor({ direction, subscription });
    let result;
    let staleSubscription = false;
    try {
      result = await razorpayGw.updateSubscription(subscription.razorpaySubscriptionId, {
        planRef: planId,
        quantity: 1,
        scheduleChangeAt,
        customerNotify: true,
      });
    } catch (err) {
      const description = String(err?.message || '');
      if (/upi/i.test(description)) {
        return res.status(409).json({
          message: 'Razorpay cannot update this UPI Autopay subscription in place. Please contact support so we can move you without creating duplicate mandates.',
        });
      }
      // A checkout that was started but never paid (e.g. abandoned onboarding)
      // leaves the Razorpay subscription in "created" state, which cannot be
      // updated in place. Don't dead-end the user — fall through and start a
      // fresh checkout; the abandoned subscription expires on Razorpay's side.
      if (/not in Authenticated or Active|not authenticated|created state|cannot be updated/i.test(description)) {
        staleSubscription = true;
      } else {
        return res.status(err.status || 502).json({ message: err.message || 'Could not update the Razorpay subscription.' });
      }
    }

    if (!staleSubscription) {
    const effectiveAt = timing === 'period_end'
      ? pendingEffectiveAtFromGateway({ subscription, razorpaySubscription: result })
      : null;
    const pending = await prisma.subscription.update({
      where: { businessId: req.user.businessId },
      data: timing === 'period_end'
        ? {
            gateway: 'RAZORPAY',
            pendingTierSlug: tier.slug,
            pendingBillingCycle: selectedBillingCycle,
            pendingChangeEffectiveAt: effectiveAt,
            pendingVertical: pendingVertical || null,
          }
        : {
            gateway: 'RAZORPAY',
            pendingTierSlug: null,
            pendingBillingCycle: null,
            pendingChangeEffectiveAt: null,
            pendingVertical: pendingVertical || null,
          },
      include: { tier: true },
    });

    return res.json({
      action: timing === 'period_end' ? 'scheduled' : 'updated',
      gateway: 'RAZORPAY',
      subscription: await hydrateSubscription(pending),
      message: timing === 'period_end'
        ? `${tier.name} is scheduled for your next Razorpay billing cycle.`
        : `${tier.name} is being applied. Razorpay will invoice any immediate difference.`,
    });
    }
    // staleSubscription === true → fall through to start a fresh checkout below.
  }

  let result;
  try {
    result = await razorpayGw.createSubscriptionCheckout({
      planRef: planId,
      totalCount: selectedBillingCycle === 'YEARLY' ? 10 : 120, // ~10 years of cycles; renew before end
      customerEmail: business.billingEmail || business.email || req.user.email || undefined,
      customerName: business.name || undefined,
      customerContact: business.phone || undefined,
      metadata,
      businessId: business.id,
      trialDays: targetTrialDays(tier),
    });
  } catch (err) {
    return res.status(err.status || 502).json({ message: err.message || 'Could not create a Razorpay subscription.' });
  }
  if (!result?.url) {
    return res.status(502).json({ message: 'Could not create a Razorpay subscription.' });
  }

  const updated = await prisma.subscription.update({
    where: { businessId: req.user.businessId },
    data: {
      gateway: 'RAZORPAY',
      razorpaySubscriptionId: result.reference || undefined,
      pendingTierSlug: null,
      pendingBillingCycle: null,
      pendingChangeEffectiveAt: null,
      pendingVertical: pendingVertical || null,
    },
    include: { tier: true },
  });

  return res.json({
    action: 'checkout',
    gateway: 'RAZORPAY',
    checkoutUrl: result.url,
    // Embedded-checkout fields: the frontend opens Razorpay Checkout.js with this
    // subscription id (so the user returns to the admin via the handler instead
    // of being stranded on Razorpay's hosted short_url). razorpayKeyId is the
    // PUBLISHABLE key id — safe to expose. checkoutUrl stays as graceful
    // degradation if Checkout.js can't load.
    razorpaySubscriptionId: result.reference || null,
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || null,
    subscription: await hydrateSubscription(updated),
    message: `Continue to authorize UPI Autopay to activate ${tier.name}.`,
  });
}

async function selectPlan(req, res) {
  const {
    tierId,
    tierSlug,
    billingCycle,
    theme: requestedTheme,
    targetVertical,
    adminCouponCode,
    adminCouponDiscountId,
  } = req.body;
  const selectedBillingCycle = billingCycle || 'MONTHLY';
  const requestedTargetVertical = normalizeRequestedVertical(targetVertical);

  try {
    if (!tierId && !tierSlug) return res.status(400).json({ message: 'tierId or tierSlug is required' });
    if (!isValidBillingCycle(selectedBillingCycle)) {
      return res.status(400).json({ message: 'billingCycle must be MONTHLY or YEARLY' });
    }
    if (targetVertical && !requestedTargetVertical) {
      return res.status(400).json({ message: 'targetVertical must be STATIC, APPOINTMENT, or ECOMMERCE' });
    }
    if (requestedTheme && !VALID_THEMES.has(requestedTheme)) {
      return res.status(400).json({ message: 'Unknown theme' });
    }
    if (!req.user.businessId) {
      return res.status(400).json({ message: 'You must set up your business first' });
    }

    const [tier, business] = await Promise.all([
      resolveSelectedTier({ tierId, tierSlug }),
      resolveBusinessForBilling(req.user.businessId),
    ]);

    if (!tier || !tier.isActive) return res.status(404).json({ message: 'Tier not found' });
    if (!business) return res.status(404).json({ message: 'Business not found' });
    const currentVertical = resolveVertical(business.vertical);
    if (tier.isCustomPriced) {
      return res.status(409).json({
        message: `${tier.name} is managed as a custom-priced plan. Please contact support to activate it.`,
      });
    }
    if (requestedTargetVertical && requestedTargetVertical !== currentVertical) {
      return res.status(409).json({
        code: 'vertical_switch_disabled',
        message: 'Business type is locked for this account. Create a new account for another business type, or delete this business and start again.',
      });
    }
    if (!isFreeTier(tier) && resolveVertical(tier.vertical) !== currentVertical) {
      return res.status(409).json({
        code: 'plan_vertical_mismatch',
        message: `${tier.name} belongs to a different business type. Choose a ${currentVertical.toLowerCase()} plan for this account.`,
      });
    }
    if (
      requestedTargetVertical
      && resolveVertical(tier.vertical) !== requestedTargetVertical
      && !isFreeTier(tier)
    ) {
      return res.status(409).json({
        message: `${tier.name} is not available for the selected business type.`,
      });
    }
    const pendingVertical = requestedTargetVertical && requestedTargetVertical !== currentVertical
      ? requestedTargetVertical
      : null;

    await ensureBusinessSubscription(req.user.businessId);
    let subscription = await getBusinessSubscription(req.user.businessId);
    let selectedTheme = requestedTheme;
    if (requestedTheme) {
      const { getThemeForCategory } = require('../lib/categoryTheme');
      const { resolveStaticThemeFromBusinessSignals } = require('../lib/staticThemeInference');
      const categoryTheme = getThemeForCategory(business.category);
      selectedTheme = resolveStaticThemeFromBusinessSignals({
        theme: requestedTheme,
        fallbackTheme: categoryTheme,
        business,
      });
    }

    if (selectedTheme && subscription?.theme !== selectedTheme) {
      const themed = await prisma.subscription.update({
        where: { businessId: req.user.businessId },
        data: { theme: selectedTheme },
        include: { tier: true },
      });
      subscription = await hydrateSubscription(themed);

      // First time this tenant lands on a theme with hand-curated services
      // + intake fields (e.g. water_purifier ships 10 services + 8 intake
      // fields), auto-seed them so the admin's first visit isn't an empty
      // shell. Only seeds if the tenant has no existing services for that
      // theme — never wipes user data.
      try { await applyThemeSeeds(req.user.businessId, selectedTheme); }
      catch (err) { console.warn('themeRegistry seed failed:', err.message); }
    }

    if (
      subscription?.tier?.id === tier.id
      && subscription?.billingCycle === selectedBillingCycle
      && !subscription?.pendingTierSlug
      && (
        isFreeTier(tier)
        || subscription?.paddleSubscriptionId
        || subscription?.stripeSubscriptionId
        || subscription?.razorpaySubscriptionId
      )
    ) {
      return res.json({
        action: 'updated',
        subscription,
        message: `${tier.name} is already your active plan.`,
      });
    }

    if (isFreeTier(tier)) {
      return res.status(409).json({
        action: 'free_tier_internal_only',
        subscription,
        message: 'The free tier is an internal fallback state. Please choose a paid plan or use the Paddle billing portal to cancel renewal.',
      });
    }

    // Launch-period free access: grant any paid tier immediately without Paddle.
    if (launchFreePlanGrantsAllowed()) {
      const until = launchFreeUntil();
      const subscriptionUpdate = prisma.subscription.update({
        where: { businessId: req.user.businessId },
        data: {
          tierId: tier.id,
          status: 'ACTIVE',
          billingCycle: selectedBillingCycle,
          currentPeriodEnd: until || FOREVER(),
          pendingTierSlug: null,
          pendingBillingCycle: null,
          pendingChangeEffectiveAt: null,
          pendingVertical: null,
        },
        include: { tier: true },
      });
      const [granted] = pendingVertical
        ? await prisma.$transaction([
          subscriptionUpdate,
          prisma.business.update({
            where: { id: req.user.businessId },
            data: { vertical: pendingVertical },
          }),
        ])
        : [await subscriptionUpdate];
      return res.json({
        action: 'launch_grant',
        subscription: await hydrateSubscription(granted),
        message: `${tier.name} is active — free during the launch period.`,
      });
    }

    // SaaS subscription routing: India → Razorpay, NZ → Stripe,
    // rest of world → Paddle MoR.
    // BILLING_MULTI_GATEWAY=false is retained only as an emergency fallback that
    // forces SaaS subscriptions through Paddle.
    // Use the gateway the tenant is already subscribed on; only a brand-new
    // subscription routes by country. This keeps an existing Paddle tenant
    // changing plans on Paddle instead of being blocked on an unpublished
    // Razorpay/Stripe plan or a spurious gateway-migration wall. (A deliberate
    // gateway switch goes through the billing-country change, which is guarded
    // separately.)
    const billingGateway = resolveGatewayForChange({
      subscription,
      countryCode: normalizeCountryCode(business.billingCountry || business.country),
    });
    const migrationBlock = gatewayMigrationBlock({
      subscription,
      targetGateway: billingGateway,
      paidTarget: true,
    });
    if (migrationBlock) {
      return res.status(409).json(migrationBlock);
    }
    if (billingGateway === 'STRIPE') {
      return handleStripeCheckout({ req, res, business, tier, selectedBillingCycle, pendingVertical, subscription });
    }
    if (billingGateway === 'RAZORPAY') {
      return handleRazorpayCheckout({ req, res, business, tier, selectedBillingCycle, pendingVertical, subscription });
    }

    if (!isPaddleConfigured()) {
      return res.status(500).json({ message: 'Paddle is not configured on the backend yet.' });
    }

    // Country comes from the persisted billing profile, then signup country.
    // Ignoring any client hint here is intentional — see selectPlan() above.
    const resolvedCountry = normalizeCountryCode(business.billingCountry || business.country) || null;
    const priceRecord = await resolveTierPriceRecord({
      tierId: tier.id,
      countryCode: resolvedCountry,
    });
    // Audit the (Business.country, tier, billingCycle) tuple every time
    // we charge, so a later zone-table change can be cross-referenced
    // with what was actually billed. Best-effort — log failures don't
    // block billing.
    try {
      await prisma.pricingAuditLog.create({
        data: {
          entityType: 'subscription',
          entityId: business.id,
          action: 'UPDATED',
          changedBy: req.user.id,
          newValue: {
            event: 'plan_select_country_resolved',
            businessCountry: resolvedCountry,
            billingCountry: business.billingCountry || null,
            signupCountry: business.country || null,
            tierSlug: tier.slug,
            tierVertical: tier.vertical,
            billingCycle: selectedBillingCycle,
            priceCurrency: priceRecord?.currencyCode || null,
          },
          note: 'Billing country is server-owned profile data; client country hints are ignored',
        },
      });
    } catch (auditErr) {
      // eslint-disable-next-line no-console
      console.error('[selectPlan] audit log failed', auditErr?.message || auditErr);
    }
    const priceId = getPriceIdForBillingCycle(priceRecord, selectedBillingCycle);
    if (!priceId) {
      return res.status(409).json({
        message: `Paddle price ID is not configured for ${tier.name} (${selectedBillingCycle.toLowerCase()}).`,
      });
    }
    const expectedCurrencyCode = priceRecord?.currencyCode || null;
    const expectedAmountMinor = selectedBillingCycle === 'YEARLY'
      ? Number(priceRecord?.amountAnnualMinor)
      : Number(priceRecord?.amountMonthlyMinor);
    if (!expectedCurrencyCode) {
      return res.status(409).json({
        message: `Currency is not configured for ${tier.name} (${selectedBillingCycle.toLowerCase()}).`,
      });
    }
    if (!Number.isFinite(expectedAmountMinor) || expectedAmountMinor <= 0) {
      return res.status(409).json({
        message: `Billing amount is not configured for ${tier.name} (${selectedBillingCycle.toLowerCase()}).`,
      });
    }

    const paddlePrice = await getPaddlePrice(priceId);
    // The price's trial config only matters for a NEW checkout — the trial
    // applies to a brand-new subscription. An in-place upgrade/downgrade of an
    // EXISTING Paddle subscriber uses proration with NO trial (see
    // updatePaddleSubscription below), so a tier/price trial-config drift must
    // NOT block an existing subscriber from changing plans. (Was blocking every
    // upgrade/downgrade with "the Paddle price must have no trial period.")
    if (!subscription?.paddleSubscriptionId) {
      assertPaddlePriceMatchesTierTrial(paddlePrice, tier);
    }

    if (subscription?.paddleSubscriptionId) {
      const direction = classifyPlanChange({
        currentTier: subscription.tier,
        targetTier: tier,
        currentBillingCycle: subscription.billingCycle,
        targetBillingCycle: selectedBillingCycle,
      });
      const timing = changeTiming(direction);
      const trialingSubscription = subscriptionIsTrialing(subscription);
      const prorationBillingMode = paddleProrationModeFor({ direction, subscription });

      if (subscription.pendingTierSlug) {
        await clearScheduledCancellationIfNeeded(subscription);
      }

      let staleSubscription = false;
      try {
        const paddleSubscription = await updatePaddleSubscription(subscription.paddleSubscriptionId, {
          items: [{ price_id: priceId, quantity: 1 }],
          proration_billing_mode: prorationBillingMode,
        });

        if (timing === 'immediate' && subscription.pendingTierSlug) {
          await prisma.subscription.update({
            where: { businessId: req.user.businessId },
            data: {
              pendingTierSlug: null,
              pendingBillingCycle: null,
              pendingChangeEffectiveAt: null,
              pendingVertical: null,
            },
          });
        }

        if (timing === 'period_end') {
          const effectiveAt = pendingEffectiveAtFromGateway({ subscription, paddleSubscription });
          const pending = await prisma.subscription.update({
            where: { businessId: req.user.businessId },
            data: {
              pendingTierSlug: tier.slug,
              pendingBillingCycle: selectedBillingCycle,
              pendingChangeEffectiveAt: effectiveAt,
              pendingVertical: pendingVertical || null,
            },
            include: { tier: true },
          });
          return res.json({
            action: 'scheduled',
            subscription: await hydrateSubscription(pending),
            message: `${tier.name} is scheduled for your next renewal. Your current plan stays active until then.`,
          });
        }

        const synced = await syncBusinessSubscriptionFromPaddle({
          businessId: req.user.businessId,
          paddleSubscription,
          paddleTransactionId: subscription.paddleTransactionId || null,
          paddleEventOccurredAt: paddleSubscription?.updated_at || paddleSubscription?.created_at || null,
          ...(pendingVertical ? { targetVertical: pendingVertical } : {}),
        });

        return res.json({
          action: 'updated',
          subscription: synced,
          message: trialingSubscription || String(paddleSubscription?.status || '').toLowerCase() === 'trialing'
            ? `${tier.name} is active for the rest of your trial. Paddle will bill the updated plan when the trial ends.`
            : `${tier.name} is active. Paddle charged the prorated difference for the rest of this billing period.`,
        });
      } catch (err) {
        // A Paddle subscription that was never completed (abandoned checkout) or
        // was canceled/paused can't be updated in place. Don't dead-end the
        // user; fall through and start a fresh checkout below.
        const msg = String(err?.message || '');
        const status = err?.status || err?.statusCode;
        const stale = status === 404 || status === 410
          || /cancel|paus|past_due|expired|no such|not found|does not exist|inactive|is not active|cannot be updated|not be updated|invalid.*status|archived/i.test(msg);
        if (!stale) {
          return res.status(err.status || 502).json({ message: err.message || 'Could not update the Paddle subscription.' });
        }
        staleSubscription = true;
      }
      if (staleSubscription) { /* fall through to create a fresh Paddle checkout below */ }
    }

    let paddleCustomerId = subscription?.paddleCustomerId || null;
    if (!paddleCustomerId) {
      try {
        const customer = await createPaddleCustomer({
          email: business.billingEmail || business.email || req.user.email,
          name: billingNameForPaddle(business),
          custom_data: buildPaddleCustomData({
            business,
            user: req.user,
            tierSlug: tier.slug,
            billingCycle: selectedBillingCycle,
            targetVertical: pendingVertical,
            trialDays: targetTrialDays(tier),
          }),
        });
        paddleCustomerId = customer?.id || null;
      } catch (customerErr) {
        const existingCustomerId = extractPaddleCustomerIdFromConflict(customerErr);
        if (!existingCustomerId) throw customerErr;
        paddleCustomerId = existingCustomerId;
      }
    }
    const paddleBillingProfile = await ensurePaddleBillingProfile({
      business,
      paddleCustomerId,
      user: req.user,
    }).catch((profileErr) => {
      console.error('[selectPlan] Paddle billing profile sync failed', profileErr?.message || profileErr);
      return { addressId: null, businessId: null };
    });

    const transactionPayload = {
      items: [{ price_id: priceId, quantity: 1 }],
      collection_mode: 'automatic',
      customer_id: paddleCustomerId,
      address_id: paddleBillingProfile.addressId || undefined,
      business_id: paddleBillingProfile.businessId || undefined,
      discount_id: adminCouponDiscountId || undefined,
      custom_data: buildPaddleCustomData({
        business,
        user: req.user,
        tierSlug: tier.slug,
        billingCycle: selectedBillingCycle,
        targetVertical: pendingVertical,
        expectedPriceId: priceId,
        expectedCurrencyCode,
        expectedAmountMinor,
        trialDays: targetTrialDays(tier),
        adminCouponCode: adminCouponCode || undefined,
        adminCouponDiscountId: adminCouponDiscountId || undefined,
      }),
    };

    const transaction = await createPaddleTransaction(transactionPayload);
    try {
      await recordCheckoutCreated({
        businessId: req.user.businessId,
        productKind: 'PLAN',
        checkoutKind: 'plan_subscription',
        transaction,
        expectedPriceId: priceId,
        expectedCurrencyCode,
        expectedAmountMinor,
        metadata: transactionPayload.custom_data,
      });
    } catch (ledgerErr) {
      console.error('[selectPlan] billing ledger checkout write failed', ledgerErr?.message || ledgerErr);
    }
    const onboardingCancel = req.body?.fromOnboarding
      ? '/onboarding'
      : `/${business.slug}/admin?tab=subscription`;
    const checkoutLauncherUrl = buildCheckoutLauncherUrl(req, business, onboardingCancel);
    const checkoutUrl = buildCheckoutOpenUrl(checkoutLauncherUrl, transaction?.id || null);
    if (!checkoutUrl) {
      return res.status(502).json({
        message: 'Could not build a checkout launcher URL for this transaction.',
      });
    }

    const updated = await prisma.subscription.update({
      where: { businessId: req.user.businessId },
      data: {
        paddleCustomerId,
        paddleTransactionId: transaction.id || null,
        pendingTierSlug: null,
        pendingBillingCycle: null,
        pendingChangeEffectiveAt: null,
        pendingVertical: pendingVertical || null,
      },
      include: { tier: true },
    });

    return res.json({
      action: 'checkout',
      checkoutUrl,
      transactionId: transaction.id || null,
      subscription: await hydrateSubscription(updated),
      message: `Continue to secure checkout to activate ${tier.name}.`,
    });
  } catch (err) {
    console.error('[selectPlan] error:', err?.message || err);

    if (err?.code === 'subscription_invalid_billing_mode_for_scheduled_change') {
      return res.status(409).json({
        message: 'This subscription already has a scheduled billing change. Please try the plan change again in a moment.',
      });
    }

    return res.status(err?.statusCode ?? err?.status ?? 500).json({
      message: err?.message || 'Could not change plan. Please try again.',
    });
  }
}

// PUT /api/subscription/theme — change theme (profession) + optional style +
// optional colour overrides + optional layout (designPreset / sectionVariants)
// on the active subscription.
//
// Body shape:
//   { theme?: string, themeStyle?: string, themeColors?: object | null,
//     designPreset?: string | null, sectionVariants?: object | null }
// Any subset is accepted — omit a field to leave it unchanged. Pass
// themeColors:null / designPreset:null / sectionVariants:null explicitly
// to clear per-tenant overrides (designPreset:null falls back to "classic").
function clampNavbarTagline(value) {
  if (typeof value !== 'string') return value;
  return value.trim().slice(0, NAVBAR_TAGLINE_MAX_LENGTH);
}

function stringifyIfArray(value, mapper = (item) => item) {
  if (!Array.isArray(value)) return undefined;
  return JSON.stringify(value.map(mapper));
}

function cmsServiceDefaultsForTheme(themeKey, countryCode) {
  const sourceServices = listCmsServices(themeKey);
  if (!sourceServices.length) return undefined;

  return JSON.stringify(sourceServices.map((tpl) => {
    const { basePriceUsd: _basePriceUsd, ...rest } = tpl;
    return {
      ...rest,
      price: tpl.price != null
        ? String(tpl.price)
        : tpl.basePriceUsd
          ? String(computeLocalPrice(tpl.basePriceUsd, 1, 'USD') || '')
          : '',
      currency: tpl.currency || (countryCode ? undefined : 'USD'),
    };
  }));
}

const THEME_CONTENT_RESET_BASE = Object.freeze({
  heroHeadline: null,
  heroSubheading: null,
  heroCtaText: null,
  heroLine3: null,
  heroBannerUrl: null,
  heroBannerPosX: null,
  heroBannerPosY: null,
  heroBannerZoom: null,
  heroTrust1: null,
  heroTrust2: null,
  heroTrust3: null,
  showHero: true,
  showHeroTrust: true,

  tagline: null,
  servicesIntro: null,
  aboutTitle: null,
  aboutBody: null,
  contactTitle: null,
  contactBody: null,
  contactCardTitle: null,
  contactCardBody: null,
  ctaHeadline: null,
  ctaBody: null,
  ctaBackgroundUrl: null,
  ctaBackgroundPosX: null,
  ctaBackgroundPosY: null,
  ctaBackgroundZoom: null,

  cmsServices: null,
  cmsTeam: null,
  testimonials: null,
  statsItems: null,
  aboutHighlights: null,
  pricingTiers: null,
  galleryItems: null,
  faqItems: null,

  aboutEyebrow: null,
  aboutImageUrl: null,
  aboutImagePosition: null,
  aboutImagePosX: null,
  aboutImagePosY: null,
  aboutImageZoom: null,
  aboutAddressLabel: null,
  aboutPhoneLabel: null,
  servicesEyebrow: null,
  servicesTitle: null,
  servicesImageUrl: null,
  servicesImagePosX: null,
  servicesImagePosY: null,
  servicesImageZoom: null,
  teamEyebrow: null,
  teamTitle: null,
  teamIntro: null,
  teamMemberLabel: null,
  testimonialsEyebrow: null,
  testimonialsTitle: null,
  galleryEyebrow: null,
  galleryTitle: null,
  gallerySub: null,
  faqEyebrow: null,
  faqTitle: null,
  faqIntro: null,
  contactEyebrow: null,
  pricingEyebrow: null,
  pricingTitle: null,
  pricingIntro: null,
  sectionOrder: null,

  navHomeLabel: null,
  navServicesLabel: null,
  navPricingLabel: null,
  navAboutLabel: null,
  navTeamLabel: null,
  navGalleryLabel: null,
  navTestimonialsLabel: null,
  navBookingLabel: null,
  navFaqLabel: null,
  navContactLabel: null,
  footerDescription: null,
  footerCopyright: null,
  footerQuickLinksTitle: null,
  footerContactTitle: null,
  footerLinkBookLabel: null,
  footerLinkBookingsLabel: null,
  footerLinkAboutLabel: null,
  footerLinkServicesLabel: null,
  footerLinkContactLabel: null,
  footerLinkSignInLabel: null,
  inactiveNoticeTitle: null,
  inactiveNoticeBody: null,
  bookingEyebrow: null,
  bookingTitle: null,
  bookingSub: null,
  bookingCta: null,
  enquiryFormTitle: null,
  enquiryFormBody: null,
  enquiryFormCta: null,
  enquiryThanksTitle: null,
  enquiryThanksBody: null,

  showStats: true,
  showServices: true,
  showAbout: true,
  showTeam: true,
  showTestimonials: true,
  showContact: true,
  showCta: true,
  showPricing: false,
  showGallery: false,
  showFaq: false,
  showBooking: true,
  showBlogServices: false,
  showBlogAbout: false,
  showBlogTestimonials: false,
  showBlogContact: false,
});

function buildThemeContentResetPatch(themeKey, business = {}) {
  const cfg = getThemeConfig(themeKey);
  const content = cfg?.website?.defaultContent || {};
  if (!cfg) return {};

  const patch = { ...THEME_CONTENT_RESET_BASE };
  const setText = (field, value) => {
    if (typeof value === 'string') patch[field] = field === 'tagline' ? clampNavbarTagline(value) : value;
  };
  const setBool = (field, value) => {
    if (typeof value === 'boolean') patch[field] = value;
  };

  setText('heroHeadline', content.heroHeadline);
  setText('heroSubheading', content.heroSubheading);
  setText('heroCtaText', content.heroCtaText || content.ctaText || cfg.vocab?.bookCta || cfg.vocab?.bookNow);
  setText('heroLine3', content.heroLine3);
  setText('heroBannerUrl', content.heroBannerUrl);
  setText('tagline', content.tagline);
  setText('servicesIntro', content.servicesIntro);
  setText('aboutTitle', content.aboutTitle);
  setText('aboutBody', content.aboutBody);
  setText('contactTitle', content.contactTitle);
  setText('contactBody', content.contactBody);
  setText('contactCardTitle', content.contactCardTitle);
  setText('contactCardBody', content.contactCardBody);
  setText('ctaHeadline', content.ctaHeadline || content.contactCtaBarTitle);
  setText('ctaBody', content.ctaBody || content.contactCtaBarBody);
  setText('aboutEyebrow', content.aboutEyebrow);
  setText('servicesEyebrow', content.servicesEyebrow);
  setText('servicesTitle', content.servicesTitle);
  setText('teamEyebrow', content.teamEyebrow);
  setText('teamTitle', content.teamTitle);
  setText('teamIntro', content.teamIntro);
  setText('teamMemberLabel', content.teamMemberLabel);
  setText('testimonialsEyebrow', content.testimonialsEyebrow);
  setText('testimonialsTitle', content.testimonialsTitle);
  setText('galleryEyebrow', content.galleryEyebrow);
  setText('galleryTitle', content.galleryTitle);
  setText('gallerySub', content.gallerySub);
  setText('faqEyebrow', content.faqEyebrow);
  setText('faqTitle', content.faqTitle);
  setText('faqIntro', content.faqIntro);
  setText('contactEyebrow', content.contactEyebrow);
  setText('pricingEyebrow', content.pricingEyebrow);
  setText('pricingTitle', content.pricingTitle);
  setText('pricingIntro', content.pricingIntro);
  setText('enquiryFormTitle', content.enquiryFormTitle);
  setText('enquiryFormBody', content.enquiryFormBody);
  setText('enquiryFormCta', content.enquiryFormCta);
  setText('enquiryThanksTitle', content.enquiryThanksTitle);
  setText('enquiryThanksBody', content.enquiryThanksBody);
  setText('sectionOrder', content.sectionOrder);
  const preset = resolvePreset({ designPreset: cfg.defaultDesignPreset || null });
  if (preset?.sectionOrder?.length) patch.sectionOrder = preset.sectionOrder.join(',');
  setText('footerDescription', content.footerDescription);
  setBool('showFaq', content.showFaq);
  setBool('showGallery', content.showGallery);
  setBool('showPricing', content.showPricing);
  setBool('showStats', content.showStats);
  setBool('showServices', content.showServices);
  setBool('showAbout', content.showAbout);
  setBool('showTeam', content.showTeam);
  setBool('showTestimonials', content.showTestimonials);
  setBool('showContact', content.showContact);
  setBool('showCta', content.showCta);

  if (Array.isArray(content.trustItems)) {
    patch.heroTrust1 = content.trustItems[0] || null;
    patch.heroTrust2 = content.trustItems[1] || null;
    patch.heroTrust3 = content.trustItems[2] || null;
    patch.showHeroTrust = content.trustItems.length > 0;
  }

  const cmsServices = cmsServiceDefaultsForTheme(themeKey, business.country);
  if (cmsServices) patch.cmsServices = cmsServices;
  const cmsTeam = listCmsTeam(themeKey);
  patch.cmsTeam = JSON.stringify(cmsTeam.length ? cmsTeam : DEFAULT_CMS_TEAM);

  const testimonials = stringifyIfArray(content.testimonials);
  if (testimonials) patch.testimonials = testimonials;
  const statsItems = stringifyIfArray(content.stats);
  if (statsItems) patch.statsItems = statsItems;
  const aboutHighlights = stringifyIfArray(content.aboutHighlights);
  if (aboutHighlights) patch.aboutHighlights = aboutHighlights;
  const faqItems = stringifyIfArray(content.faqItems);
  if (faqItems) patch.faqItems = faqItems;
  const pricingTiers = stringifyIfArray(content.pricing);
  if (pricingTiers) patch.pricingTiers = pricingTiers;
  const galleryItems = stringifyIfArray(content.gallery, (item) => (
    typeof item === 'string' ? { image: '', caption: item } : item
  ));
  if (galleryItems) patch.galleryItems = galleryItems;

  return patch;
}

async function updateTheme(req, res) {
  const { theme, themeStyle, themeColors, designPreset, sectionVariants, resetThemeContent } = req.body;

  if (theme !== undefined && (!theme || !VALID_THEMES.has(theme))) {
    return res.status(400).json({ message: 'Unknown theme (profession)' });
  }
  if (themeStyle !== undefined && !VALID_STYLES.has(themeStyle)) {
    return res.status(400).json({ message: 'Unknown theme style' });
  }
  if (designPreset !== undefined && designPreset !== null && typeof designPreset !== 'string') {
    return res.status(400).json({ message: 'designPreset must be a string or null' });
  }
  if (designPreset !== undefined && designPreset !== null && !VALID_LAYOUT_PRESETS.has(designPreset)) {
    return res.status(400).json({ message: 'Unknown layout preset' });
  }
  if (sectionVariants !== undefined && sectionVariants !== null && typeof sectionVariants !== 'object') {
    return res.status(400).json({ message: 'sectionVariants must be an object or null' });
  }
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  const existing = await prisma.subscription.findUnique({
    where: { businessId: req.user.businessId },
  });
  if (!existing) return res.status(404).json({ message: 'No subscription found' });

  if (theme !== undefined) {
    const business = await prisma.business.findUnique({
      where: { id: req.user.businessId },
      select: { vertical: true, country: true },
    });
    const businessVertical = resolveVertical(business?.vertical);
    const themeVertical = getThemeVertical(theme);
    if (themeVertical && businessVertical && themeVertical !== businessVertical) {
      return res.status(400).json({
        message: `This is a ${themeVertical.toLowerCase()} theme. This account's business type is locked; create a separate account or delete this business and start again.`,
      });
    }
  }

  const shouldResetThemeContent = theme !== undefined && theme !== existing.theme && resetThemeContent !== false;
  const nextThemeConfig = shouldResetThemeContent ? getThemeConfig(theme) : null;

  const data = {};
  if (theme !== undefined)      data.theme      = theme;
  if (themeStyle !== undefined) data.themeStyle = themeStyle;
  else if (shouldResetThemeContent) data.themeStyle = nextThemeConfig?.defaultThemeStyle || 'light';
  if (themeColors !== undefined) {
    data.themeColors = themeColors === null ? null : sanitizeThemeColors(themeColors);
  } else if (shouldResetThemeContent) data.themeColors = null;
  if (designPreset !== undefined) {
    data.designPreset = designPreset || null;
  } else if (shouldResetThemeContent) data.designPreset = nextThemeConfig?.defaultDesignPreset || null;
  if (sectionVariants !== undefined) {
    data.sectionVariants = sectionVariants === null ? null : JSON.stringify(sanitizeSectionVariants(sectionVariants));
  } else if (shouldResetThemeContent) data.sectionVariants = null;
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: 'No theme fields to update' });
  }

  const businessForContent = shouldResetThemeContent
    ? await prisma.business.findUnique({
      where: { id: req.user.businessId },
      select: { country: true },
    })
    : null;
  const themeContentPatch = shouldResetThemeContent
    ? buildThemeContentResetPatch(theme, businessForContent || {})
    : {};

  const [subscription] = await prisma.$transaction([
    prisma.subscription.update({
      where: { businessId: req.user.businessId },
      data,
      include: { tier: true },
    }),
    ...(Object.keys(themeContentPatch).length > 0
      ? [prisma.businessContent.upsert({
        where: { businessId: req.user.businessId },
        update: themeContentPatch,
        create: { businessId: req.user.businessId, ...themeContentPatch },
      })]
      : []),
  ]);
  res.json({ subscription: await hydrateSubscription(subscription) });
}

async function updateCustomDomain(req, res) {
  // v1 safety: custom-domain CONNECT is OFF until Cloudflare-for-SaaS is wired
  // up. This disables the entire connect attack surface (squat/quota-burn/
  // first-bind) in v1; it lights up automatically once the CF-for-SaaS env is
  // set in v1.1. Subdomains use provisionSubdomain (NOT this handler), and the
  // disconnect/status read+cleanup paths stay live.
  if (!isCloudflareCustomHostnameConfigured()) {
    return res.status(503).json({
      error: 'CUSTOM_DOMAIN_NOT_AVAILABLE',
      message: 'Custom domains are not enabled yet.',
    });
  }
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const domain = normalizeCustomDomain(req.body?.domain || req.body?.customDomain);
  if (!domain) {
    return res.status(400).json({ message: 'Enter a valid domain, for example shop.example.com' });
  }
  const platformDomain = String(process.env.PLATFORM_DOMAIN || 'drifthr.com').toLowerCase();
  if (domain === platformDomain || domain.endsWith(`.${platformDomain}`)) {
    return res.status(400).json({ message: 'Use the website URL field for DriftHR subdomains. Custom domain must be your own domain.' });
  }
  const forceTransfer = req.body?.forceTransfer === true || req.body?.confirmDomainTransfer === true;
  const claimDomains = customDomainClaimDomains(domain);
  const existing = await prisma.subscription.findFirst({
    where: {
      customDomain: { in: claimDomains },
      NOT: { businessId: req.user.businessId },
    },
    select: {
      businessId: true,
      customHostnameId: true,
      customDomain: true,
    },
  });
  if (existing && !forceTransfer) {
    return res.status(409).json({
      ...customDomainTransferRequiredResponse({ domain, businessId: req.user.businessId }),
      code: 'CUSTOM_DOMAIN_IN_USE',
    });
  }
  if (existing && forceTransfer) {
    const ownership = await customDomainOwnershipVerified({ domain, businessId: req.user.businessId });
    if (!ownership.verified) {
      return res.status(409).json(customDomainTransferRequiredResponse({
        domain,
        businessId: req.user.businessId,
        message: 'We could not find the required TXT record yet. Keep the TXT record at your domain provider, wait for DNS to update, then verify again.',
      }));
    }
  }
  const previousOwnerAdmins = existing && forceTransfer
    ? await listBusinessAdminRecipients(existing.businessId).catch(() => [])
    : [];

  await ensureBusinessSubscription(req.user.businessId);
  const currentSubscription = await prisma.subscription.findUnique({
    where: { businessId: req.user.businessId },
    select: {
      customDomain: true,
      customHostnameId: true,
      customDomainVerified: true,
      customDomainStatus: true,
    },
  });
  const business = await prisma.business.findUnique({
    where: { id: req.user.businessId },
    select: { id: true, slug: true, vertical: true },
  });
  const provisioning = await provisionCustomDomain({
    domain,
    business,
    priorSubscription: currentSubscription,
    allowApexPending: !!req.body?.allowApexPending,
  });
  if (provisioning.blockedBySuggestion) {
    return res.status(422).json({
      ...provisioning.suggestion,
      message: provisioning.suggestion.message,
      dns: provisioning.dnsState,
    });
  }
  if (existing && forceTransfer) {
    await prisma.subscription.updateMany({
      where: {
        customDomain: { in: claimDomains },
        NOT: { businessId: req.user.businessId },
      },
      data: {
        customDomain: null,
        customHostnameId: null,
        customDomainVerified: false,
        customDomainStatus: 'NONE',
        customDomainStatusMessage: 'Domain was moved to another DriftHR business.',
        customDomainCheckedAt: new Date(),
      },
    });
    if (previousOwnerAdmins.length > 0) {
      Promise.allSettled(previousOwnerAdmins.map((admin) => sendEmail(
        admin.email,
        `Custom domain moved: ${domain}`,
        `
          <p>Hello ${customDomainEmailSafe(admin.name || 'there')},</p>
          <p>The custom domain <strong>${customDomainEmailSafe(domain)}</strong> was moved away from your DriftHR website after DNS ownership verification.</p>
          <p>Your DriftHR subdomain still works. If you did not expect this change, please contact support.</p>
        `
      ))).catch((err) => {
        console.error('[custom-domain] previous owner notification failed:', err?.message || err);
      });
    }
  }
  let subscription;
  try {
    subscription = await prisma.subscription.update({
      where: { businessId: req.user.businessId },
      data: {
        customDomain: domain,
        customHostnameId: provisioning.customHostnameId,
        customDomainVerified: provisioning.domainStatus.verified,
        customDomainStatus: provisioning.domainStatus.status,
        customDomainStatusMessage: provisioning.domainStatus.message,
        customDomainCheckedAt: new Date(),
      },
      select: {
        customDomain: true,
        customHostnameId: true,
        customDomainVerified: true,
        customDomainStatus: true,
        customDomainStatusMessage: true,
        customDomainCheckedAt: true,
      },
    });
  } catch (err) {
    // Unique-constraint collision on customDomain — another tenant owns it.
    if (err?.code === 'P2002') {
      return res.status(409).json({ reason: 'taken', message: 'That domain is already connected to another DriftHR website.' });
    }
    throw err;
  }

  // Sensitive action — audit the domain (re)connect (best-effort, tenant-scoped).
  await writeAudit({
    businessId: req.user.businessId,
    actorId: req.user.id,
    action: 'domain.change',
    entityType: 'Subscription',
    entityId: req.user.businessId,
    meta: {
      op: 'connect',
      domain: subscription.customDomain,
      status: subscription.customDomainStatus,
      verified: subscription.customDomainVerified,
      transferredFrom: existing ? existing.businessId : null,
    },
  });

  return res.json({
    domain: subscription.customDomain,
    verified: subscription.customDomainVerified,
    status: subscription.customDomainStatus,
    message: subscription.customDomainStatusMessage,
    checkedAt: subscription.customDomainCheckedAt,
    provider: provisioning.provider,
    dns: provisioning.dnsState,
    cloudflare: {
      configured: !!provisioning.cloudflareState?.configured,
      ...serializeCloudflareHostname(provisioning.cloudflareState?.result),
      hostnames: (provisioning.cloudflareState?.hostnames || []).map((item) => ({
        hostname: item.hostname,
        configured: item.configured !== false,
        ...serializeCloudflareHostname(item.result),
        error: item.error || null,
      })),
      error: provisioning.cloudflareError,
      cleanup: provisioning.cloudflareCleanup || null,
    },
    instructions: provisioning.instructions,
    suggestion: provisioning.suggestion,
  });
}

async function disconnectCustomDomain(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const current = await prisma.subscription.findUnique({
    where: { businessId: req.user.businessId },
    select: {
      customDomain: true,
      customHostnameId: true,
      business: { select: { id: true, slug: true, vertical: true } },
    },
  });
  if (!current?.customDomain) {
    return res.json({
      domain: null,
      verified: false,
      status: 'NONE',
      message: 'No custom domain connected.',
      provider: customDomainProvider(),
      instructions: null,
    });
  }

  const cleanup = { cloudflare: null };
  if (current.customHostnameId) {
    try {
      cleanup.cloudflare = await deleteCloudflareCustomHostname(current.customHostnameId, { domain: current.customDomain });
    } catch (err) {
      cleanup.cloudflare = { deleted: false, error: err?.message || 'unknown error' };
      console.error('[custom-domain] Cloudflare custom hostname cleanup failed:', cleanup.cloudflare.error);
    }
  }

  await prisma.subscription.update({
    where: { businessId: req.user.businessId },
    data: {
      customDomain: null,
      customHostnameId: null,
      customDomainVerified: false,
      customDomainStatus: 'NONE',
      customDomainStatusMessage: 'Custom domain was disconnected.',
      customDomainCheckedAt: new Date(),
    },
  });

  // Sensitive action — audit the domain disconnect (best-effort, tenant-scoped).
  await writeAudit({
    businessId: req.user.businessId,
    actorId: req.user.id,
    action: 'domain.change',
    entityType: 'Subscription',
    entityId: req.user.businessId,
    meta: { op: 'disconnect' },
  });

  return res.json({
    domain: null,
    verified: false,
    status: 'NONE',
    message: 'Custom domain disconnected. Your DriftHR subdomain remains active.',
    provider: customDomainProvider(),
    instructions: null,
    cleanup,
  });
}

// POST /api/subscription/sync-from-paddle — pull the latest Paddle state for
// this business and apply it. Fallback for when webhooks are misconfigured
// or delayed: the admin calls this after landing back on ?billing=success so
// the tier flips without waiting for the webhook.
async function syncFromPaddle(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  if (!isPaddleConfigured()) {
    return res.status(500).json({ message: 'Paddle is not configured on the backend.' });
  }

  try {
    const existing = await getBusinessSubscription(req.user.businessId);
    const requestedTransactionId = req.body?.transactionId ? String(req.body.transactionId).trim() : null;
    const storedTransactionId = existing?.paddleTransactionId ? String(existing.paddleTransactionId).trim() : null;
    const transactionId = requestedTransactionId || storedTransactionId || null;

    let paddleSubscription = null;
    let paddleTransaction = null;

    // Preferred: resolve via the transaction id the checkout page saw.
    if (transactionId) {
      const txn = await getPaddleTransaction(transactionId).catch(() => null);
      paddleTransaction = txn || null;
      if (!txn && requestedTransactionId) {
        return res.status(404).json({
          synced: false,
          message: 'This Paddle transaction could not be found yet.',
          subscription: existing,
        });
      }
      if (txn && !paddleEntityMatchesBusiness({ entity: txn, businessId: req.user.businessId, existing })) {
        return res.status(403).json({
          synced: false,
          message: 'This Paddle transaction does not belong to this business.',
          subscription: existing,
        });
      }
      if (txn && !paddleTransactionIsCompleted(txn)) {
        return res.json({
          synced: false,
          message: 'Paddle payment is not completed yet.',
          subscription: existing,
        });
      }
      if (txn?.subscription_id) {
        paddleSubscription = await getPaddleSubscription(txn.subscription_id).catch(() => null);
        if (
          paddleSubscription
          && !paddleEntityMatchesBusiness({ entity: paddleSubscription, businessId: req.user.businessId, existing })
        ) {
          return res.status(403).json({
            synced: false,
            message: 'This Paddle subscription does not belong to this business.',
            subscription: existing,
          });
        }
      }
    }

    // Fallback: list subscriptions for the customer.
    if (!paddleSubscription && existing?.paddleCustomerId) {
      const list = await listPaddleSubscriptionsForCustomer(existing.paddleCustomerId).catch(() => null);
      if (Array.isArray(list) && list.length > 0) {
        // Take the most recently updated one
        paddleSubscription = [...list].sort((a, b) => {
          const t1 = new Date(b.updated_at || b.created_at || 0).getTime();
          const t0 = new Date(a.updated_at || a.created_at || 0).getTime();
          return t1 - t0;
        })[0];
        if (
          paddleSubscription
          && !paddleEntityMatchesBusiness({ entity: paddleSubscription, businessId: req.user.businessId, existing })
        ) {
          return res.status(403).json({
            synced: false,
            message: 'This Paddle subscription does not belong to this business.',
            subscription: existing,
          });
        }
      }
    }

    if (!paddleSubscription) {
      return res.json({
        synced: false,
        message: 'No Paddle subscription found yet. If you just completed checkout, try again in a few seconds.',
        subscription: existing,
      });
    }

    const updated = await syncBusinessSubscriptionFromPaddle({
      businessId: req.user.businessId,
      paddleSubscription,
      paddleTransactionId: transactionId,
      paddleEventOccurredAt: paddleSubscription?.updated_at || paddleSubscription?.created_at || null,
      ...(paddleTransaction?.custom_data?.targetVertical ? { targetVertical: paddleTransaction.custom_data.targetVertical } : {}),
    });

    return res.json({ synced: true, subscription: updated });
  } catch (err) {
    console.error('[syncFromPaddle] error:', err?.message || err);
    return res.status(err?.statusCode ?? err?.status ?? 500).json({
      message: err?.message || 'Could not sync subscription from Paddle.',
    });
  }
}

// POST /api/subscription/sync-from-stripe — Stripe analog of syncFromPaddle.
// The success page (?billing=success&session_id=...) calls this so the tier
// flips even if the Stripe webhook lags or isn't configured. Ownership is
// enforced via the businessId we stamped in the session/subscription metadata.
async function syncFromStripe(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const stripeGw = getGateway('STRIPE');
  if (!stripeGw.isConfigured()) {
    return res.status(500).json({ message: 'Stripe is not configured on the backend.' });
  }

  try {
    const existing = await getBusinessSubscription(req.user.businessId);
    const stripe = stripeGw.raw();
    const sessionId = req.body?.sessionId ? String(req.body.sessionId).trim() : null;
    let stripeSubscriptionId = existing?.stripeSubscriptionId || null;

    // Preferred: resolve the subscription from the checkout session the success
    // page saw — but only trust it if its metadata says it's THIS business.
    if (sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId).catch(() => null);
      if (session && session.metadata?.businessId === req.user.businessId && session.subscription) {
        stripeSubscriptionId = typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id || stripeSubscriptionId;
      }
    }

    if (!stripeSubscriptionId) {
      return res.json({
        synced: false,
        message: 'No Stripe subscription found yet. If you just completed checkout, try again in a few seconds.',
        subscription: existing,
      });
    }

    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId, { expand: ['items.data.price'] }).catch(() => null);
    if (!sub) {
      return res.json({
        synced: false,
        message: 'Stripe subscription is not available yet. Try again in a few seconds.',
        subscription: existing,
      });
    }
    // Ownership guard: the subscription must carry our businessId metadata.
    if (sub.metadata?.businessId && sub.metadata.businessId !== req.user.businessId) {
      return res.status(403).json({
        synced: false,
        message: 'This Stripe subscription does not belong to this business.',
        subscription: existing,
      });
    }

    const normalized = stripeGw.normalizeEvent({ type: 'customer.subscription.updated', data: { object: sub } });
    const updated = await syncBusinessSubscriptionFromStripe({
      businessId: req.user.businessId,
      normalized,
      eventAt: new Date(),
      eventId: null,
    });
    return res.json({ synced: true, subscription: updated });
  } catch (err) {
    console.error('[syncFromStripe] error:', err?.message || err);
    return res.status(err?.statusCode ?? err?.status ?? 500).json({
      message: err?.message || 'Could not sync subscription from Stripe.',
    });
  }
}

// POST /api/subscription/sync-from-razorpay — Razorpay analog of syncFromStripe.
// Pulls the live Razorpay subscription for this business and applies it, so the
// tier flips even if the webhook lags. Ownership is enforced via the businessId
// stamped in the subscription notes.
async function syncFromRazorpay(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const razorpayGw = getGateway('RAZORPAY');
  if (!razorpayGw.isConfigured()) {
    return res.status(500).json({ message: 'Razorpay is not configured on the backend.' });
  }

  try {
    const existing = await getBusinessSubscription(req.user.businessId);
    const subId = existing?.razorpaySubscriptionId || null;
    if (!subId) {
      return res.json({
        synced: false,
        message: 'No Razorpay subscription found yet. If you just authorized payment, try again in a few seconds.',
        subscription: existing,
      });
    }
    const sub = await razorpayGw.getSubscription(subId).catch(() => null);
    if (!sub) {
      return res.json({ synced: false, message: 'Razorpay subscription is not available yet.', subscription: existing });
    }
    if (sub.notes?.businessId && sub.notes.businessId !== req.user.businessId) {
      return res.status(403).json({ synced: false, message: 'This Razorpay subscription does not belong to this business.', subscription: existing });
    }
    const normalized = razorpayGw.normalizeEvent({ event: 'subscription.updated', payload: { subscription: { entity: sub } } });
    const updated = await syncBusinessSubscriptionFromRazorpay({
      businessId: req.user.businessId, normalized, eventAt: new Date(), eventId: null,
    });
    // Only report "synced" once Razorpay reports an entitling state. A still-
    // 'created' subscription (mandate not yet authorized) maps to internalStatus
    // null and does NOT apply the tier, so the caller should keep polling rather
    // than flip its banner to "synced" prematurely.
    const entitled = ['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(String(normalized.internalStatus || ''));
    return res.json({ synced: entitled, subscription: updated });
  } catch (err) {
    console.error('[syncFromRazorpay] error:', err?.message || err);
    return res.status(err?.statusCode ?? err?.status ?? 500).json({ message: err?.message || 'Could not sync subscription from Razorpay.' });
  }
}

// POST /api/subscription/cancel — schedule the paid plan to cancel at the END of
// the current billing period. The customer keeps full access until then and can
// Resume any time before it lapses. Gateway-aware; reuses the same cancel
// primitives as account deletion. We set the local CANCEL_SCHEDULED immediately
// so the UI updates without waiting for the webhook (which reconciles later).
async function cancelSubscriptionPlan(req, res) {
  if (!req.user.businessId) return res.status(400).json({ message: 'You must set up your business first' });
  const subscription = await getBusinessSubscription(req.user.businessId);
  if (!subscription) return res.status(404).json({ message: 'No subscription found' });
  const { activeGatewayFromSubscription } = require('../lib/billing/gatewayRouter');
  const gw = String(subscription.gateway || activeGatewayFromSubscription(subscription) || '').toUpperCase();
  const hasPaidSub = Boolean(subscription.paddleSubscriptionId || subscription.stripeSubscriptionId || subscription.razorpaySubscriptionId);
  if (!hasPaidSub || !gw) {
    return res.status(409).json({ message: 'There is no active paid subscription to cancel.' });
  }
  if (String(subscription.status || '').toUpperCase() === 'CANCEL_SCHEDULED') {
    return res.json({ alreadyScheduled: true, subscription: await hydrateSubscription(subscription) });
  }
  try {
    if (gw === 'PADDLE' && subscription.paddleSubscriptionId) {
      await cancelPaddleSubscription(subscription.paddleSubscriptionId, { effective_from: 'next_billing_period' });
    } else if (gw === 'STRIPE' && subscription.stripeSubscriptionId) {
      await getGateway('STRIPE').cancelSubscription(subscription.stripeSubscriptionId, { immediately: false });
    } else if (gw === 'RAZORPAY' && subscription.razorpaySubscriptionId) {
      await getGateway('RAZORPAY').cancelSubscription(subscription.razorpaySubscriptionId, { immediately: false });
    } else {
      return res.status(409).json({ message: 'There is no active paid subscription to cancel.' });
    }
  } catch (err) {
    console.error('[cancelSubscriptionPlan] error:', err?.message || err);
    return res.status(err?.status || 502).json({ message: err?.message || 'Could not schedule the cancellation. Please try again or contact support.' });
  }
  const updated = await prisma.subscription.update({
    where: { businessId: req.user.businessId },
    data: {
      status: 'CANCEL_SCHEDULED',
      pendingTierSlug: FREE_TIER_SLUG,
      pendingBillingCycle: 'MONTHLY',
      pendingChangeEffectiveAt: subscription.currentPeriodEnd || null,
    },
    include: { tier: true },
  });
  return res.json({ scheduled: true, effectiveAt: updated.pendingChangeEffectiveAt, subscription: await hydrateSubscription(updated) });
}

// POST /api/subscription/resume — undo a scheduled cancellation so the plan keeps
// renewing. Paddle (clear scheduled_change) and Stripe (cancel_at_period_end:
// false) support this in place. Razorpay cannot un-cancel a scheduled
// cancellation, so the caller is told to re-subscribe.
async function resumeSubscriptionPlan(req, res) {
  if (!req.user.businessId) return res.status(400).json({ message: 'You must set up your business first' });
  const subscription = await getBusinessSubscription(req.user.businessId);
  if (!subscription) return res.status(404).json({ message: 'No subscription found' });
  const { activeGatewayFromSubscription } = require('../lib/billing/gatewayRouter');
  const gw = String(subscription.gateway || activeGatewayFromSubscription(subscription) || '').toUpperCase();
  const scheduled = String(subscription.status || '').toUpperCase() === 'CANCEL_SCHEDULED'
    || subscription.pendingTierSlug === FREE_TIER_SLUG;
  if (!scheduled) {
    return res.json({ resumed: true, alreadyActive: true, subscription: await hydrateSubscription(subscription) });
  }
  try {
    if (gw === 'PADDLE' && subscription.paddleSubscriptionId) {
      await updatePaddleSubscription(subscription.paddleSubscriptionId, { scheduled_change: null });
    } else if (gw === 'STRIPE' && subscription.stripeSubscriptionId) {
      await getGateway('STRIPE').raw().subscriptions.update(subscription.stripeSubscriptionId, { cancel_at_period_end: false });
    } else if (gw === 'RAZORPAY') {
      return res.status(409).json({
        resumed: false,
        code: 'RAZORPAY_RESUME_UNSUPPORTED',
        message: 'A cancelled Razorpay subscription can’t be resumed automatically — re-subscribe to your plan to continue.',
      });
    } else {
      return res.status(409).json({ resumed: false, message: 'Could not resume — no active subscription found.' });
    }
  } catch (err) {
    console.error('[resumeSubscriptionPlan] error:', err?.message || err);
    return res.status(err?.status || 502).json({ message: err?.message || 'Could not resume the plan. Please try again or contact support.' });
  }
  const updated = await prisma.subscription.update({
    where: { businessId: req.user.businessId },
    data: { status: 'ACTIVE', pendingTierSlug: null, pendingBillingCycle: null, pendingChangeEffectiveAt: null },
    include: { tier: true },
  });
  return res.json({ resumed: true, subscription: await hydrateSubscription(updated) });
}

async function reconcileBillingState(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  if (!isPaddleConfigured()) {
    return res.status(500).json({ message: 'Paddle is not configured on the backend.' });
  }

  try {
    const subscription = await prisma.subscription.findUnique({
      where: { businessId: req.user.businessId },
    });
    if (!subscription) return res.status(404).json({ message: 'No subscription found' });

    const changed = await reconcileSubscriptionRow(subscription);
    const workspace = await buildBillingWorkspace({
      businessId: req.user.businessId,
      transactionLimit: 8,
      eventLimit: 24,
    });
    return res.json({ reconciled: true, changed, workspace });
  } catch (err) {
    console.error('[reconcileBillingState] error:', err?.message || err);
    return res.status(err?.statusCode ?? err?.status ?? 500).json({
      message: err?.message || 'Could not reconcile billing state.',
    });
  }
}

async function getCustomDomainStatus(req, res) {
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }
  const current = await prisma.subscription.findUnique({
    where: { businessId: req.user.businessId },
    select: {
      customDomain: true,
      customHostnameId: true,
      customDomainVerified: true,
      customDomainStatus: true,
      customDomainStatusMessage: true,
      customDomainCheckedAt: true,
      business: { select: { id: true, slug: true, vertical: true } },
    },
  });
  if (!current?.customDomain) {
    return res.json({
      domain: null,
      verified: false,
      status: 'NONE',
      message: 'No custom domain connected.',
      provider: customDomainProvider(),
      instructions: null,
    });
  }
  // Platform subdomains ({slug}.drifthr.com) are provisioned ACTIVE by
  // subdomainProvision and are NOT tenant-owned custom domains. Never run them
  // through the custom-domain TXT recheck (which would downgrade + de-route
  // them) — return the stored status as-is.
  const pd = String(process.env.PLATFORM_DOMAIN || 'drifthr.com').toLowerCase();
  if (current.customDomain === pd || current.customDomain.endsWith(`.${pd}`)) {
    return res.json({
      domain: current.customDomain,
      verified: current.customDomainVerified !== false,
      status: current.customDomainStatus || 'ACTIVE',
      message: current.customDomainStatusMessage || 'Active.',
      provider: customDomainProvider(),
      instructions: null,
    });
  }
  const provisioning = await provisionCustomDomain({
    domain: current.customDomain,
    business: current.business,
    priorSubscription: current,
  });
  const domainStatus = provisioning.domainStatus || {
    verified: false,
    status: 'PENDING_DNS',
    message: provisioning.suggestion?.message || 'DNS needs one more step before activation.',
  };
  const statusMessage = provisioning.suggestion?.message || domainStatus.message;
  const subscription = await prisma.subscription.update({
    where: { businessId: req.user.businessId },
    data: {
      customHostnameId: provisioning.customHostnameId,
      customDomainVerified: domainStatus.verified,
      customDomainStatus: domainStatus.status,
      customDomainStatusMessage: statusMessage,
      customDomainCheckedAt: new Date(),
    },
    select: {
      customDomain: true,
      customHostnameId: true,
      customDomainVerified: true,
      customDomainStatus: true,
      customDomainStatusMessage: true,
      customDomainCheckedAt: true,
    },
  });
  return res.json({
    domain: subscription.customDomain,
    verified: subscription.customDomainVerified,
    status: subscription.customDomainStatus,
    message: subscription.customDomainStatusMessage,
    checkedAt: subscription.customDomainCheckedAt,
    provider: provisioning.provider,
    dns: provisioning.dnsState,
    cloudflare: {
      configured: !!provisioning.cloudflareState?.configured,
      ...serializeCloudflareHostname(provisioning.cloudflareState?.result),
      hostnames: (provisioning.cloudflareState?.hostnames || []).map((item) => ({
        hostname: item.hostname,
        configured: item.configured !== false,
        ...serializeCloudflareHostname(item.result),
        error: item.error || null,
      })),
      error: provisioning.cloudflareError,
      cleanup: provisioning.cloudflareCleanup || null,
    },
    instructions: provisioning.instructions || provisioning.suggestion?.instructions || null,
    suggestion: provisioning.suggestion,
  });
}

// POST /api/subscription/switch-archetype
// Legacy endpoint kept only to return a clear error. Business type is an
// account identity now, not a mutable setting.
const ARCHETYPE_MAP = {
  legal:     { vertical: 'APPOINTMENT', theme: 'legal' },
  grocery:   { vertical: 'ECOMMERCE',   theme: 'grocery' },
  corporate: { vertical: 'STATIC',      theme: 'corporate' },
};

async function switchArchetype(req, res) {
  const { archetype } = req.body;
  if (!archetype || !ARCHETYPE_MAP[archetype]) {
    return res.status(400).json({ message: 'archetype must be one of: legal, grocery, corporate' });
  }
  if (!req.user.businessId) {
    return res.status(400).json({ message: 'You must set up your business first' });
  }

  return res.status(409).json({
    code: 'vertical_switch_disabled',
    message: 'Business type is locked for this account. Create a new account for another business type, or delete this business and start again.',
  });
}

// Names inserted by lib/defaultServices.js at signup. We treat any
// tenant that has ONLY these (untouched by the admin) as eligible for
// theme-seed replacement. Editing/renaming any of them takes the
// tenant out of this set, so themed seeds will not overwrite.
const GENERIC_STUB_NAMES = new Set([
  'Initial consultation',
  'Follow-up appointment',
  'Quick chat',
]);

// Idempotent seeder: when a tenant first picks a theme that ships
// hand-curated services + intake fields, populate them. Replaces the
// 3 default-stub services (Initial consultation / Follow-up / Quick
// chat) IF none have been edited — that's the common case immediately
// after signup. No-ops once the admin has touched the catalogue.
async function applyThemeSeeds(businessId, themeKey) {
  const { listSeedServices, listSeedIntakeFields } = require('../lib/themeRegistry');
  const services = listSeedServices(themeKey);
  const intakeFields = listSeedIntakeFields(themeKey);
  if (services.length === 0 && intakeFields.length === 0) return;

  if (services.length > 0) {
    const existing = await prisma.service.findMany({
      where: { businessId },
      select: { id: true, name: true },
    });
    const allUntouchedStubs =
      existing.length > 0 &&
      existing.every((s) => GENERIC_STUB_NAMES.has(s.name));

    if (existing.length === 0 || allUntouchedStubs) {
      // Tenant either has nothing or only the untouched generic stubs.
      // Replace with the theme's hand-curated catalogue inside a single
      // transaction so a partial failure can't leave both sets in the DB.
      await prisma.$transaction(async (tx) => {
        if (allUntouchedStubs) {
          await tx.service.deleteMany({ where: { businessId } });
        }
        await tx.service.createMany({
          data: services.map((s, i) => ({
            businessId,
            name: s.name,
            description: s.description || null,
            duration: s.duration || 30,
            // Themes don't ship prices (region-specific) — admin sets
            // them from Service Plans tab. Use 0 so the row exists.
            price: 0,
            highlighted: i === 0,
          })),
        });
      });
    }
  }

  // Intake fields: seed an IntakeForm with the theme's required + optional
  // questions. Same idempotency: only when the tenant has no form yet.
  if (intakeFields.length > 0) {
    const existingForm = await prisma.intakeForm.count({ where: { businessId } });
    if (existingForm === 0) {
      await prisma.intakeForm.create({
        data: {
          businessId,
          name: 'Booking intake',
          fields: intakeFields,
        },
      });
    }
  }
}

module.exports = {
  getBilling,
  loadBusinessBillingSnapshot, // exported for tests
  handleRazorpayCheckout,      // exported for tests
  handleStripeCheckout,        // exported for tests
  getBillingWorkspace,
  commitBillingChange,
  previewBillingChange,
  getBillingProfile,
  getBillingInvoice,
  viewSubscriptionInvoice,
  getPaddleClientConfig,
  getMySubscription,
  openBillingPortal,
  reconcileBillingState,
  cancelSubscriptionPlan,
  resumeSubscriptionPlan,
  selectPlan,
  startTrial,
  syncFromPaddle,
  syncFromStripe,
  syncFromRazorpay,
  updateBillingProfile,
  updateTheme,
  switchArchetype,
  updateCustomDomain,
  disconnectCustomDomain,
  getCustomDomainStatus,
  customDomainProvider,
  provisionCustomDomain,
  inspectDomainDns,
  customDomainClaimDomains,
  customDomainOwnershipChallenge,
  customDomainOwnershipVerified,
  ensureCloudflareCustomHostname,
  deleteCloudflareCustomHostname,
  isCloudflareCustomHostnameConfigured,
  customDomainStatusFrom,
  FOREVER,
  VALID_THEMES,
  applyThemeSeeds,
};
