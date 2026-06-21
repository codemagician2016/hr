'use strict';

const prisma = require('./prisma');
const { resolveVertical } = require('./vertical');
const { buildSitemapXml, buildRobotsTxt } = require('./seoHelpers');

const PLATFORM_DOMAIN = (process.env.PLATFORM_DOMAIN || 'sitepresso.com').toLowerCase();

// Search indexing is enabled ONLY on the production platform. Staging
// (aapkatech.com) and local must never appear in Google — regardless of
// per-tenant content — so indexability is hard-gated to the prod domain
// here, restoring staging's noindex default. Set SEO_INDEXING=on to force
// it on (e.g. to demo on staging) or =off to force it off.
const SEO_INDEXING_ENABLED = process.env.SEO_INDEXING
  ? process.env.SEO_INDEXING.toLowerCase() === 'on'
  : PLATFORM_DOMAIN === 'sitepresso.com';
const CHANGE_FREQUENCIES = new Set(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never']);
const AI_CRAWLERS = ['GPTBot', 'ChatGPT-User', 'Google-Extended', 'ClaudeBot', 'PerplexityBot', 'CCBot'];
const CUSTOM_CHAT_WIDGET_SCRIPT_MAX = 20000;

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(value, max = 160) {
  const clean = stripHtml(value);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).replace(/\s+\S*$/, '')}...`;
}

function normalizePath(value) {
  let path = String(value || '').trim();
  if (!path) return '/';
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname || '/';
  } catch {}
  path = path.split('#')[0].split('?')[0].trim();
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  return path.length > 1 ? path.replace(/\/+$/, '') : '/';
}

function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0]
    .replace(/\.$/, '');
}

function extractFirstMatch(value, pattern) {
  const match = String(value || '').match(pattern);
  return match?.[1] || match?.[0] || '';
}

function extractMetaContent(value) {
  return extractFirstMatch(value, /\bcontent=["']([^"']+)["']/i);
}

function normalizeTrackingValue(key, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (key === 'googleAnalyticsId') {
    return extractFirstMatch(raw, /\bG-[A-Z0-9-]+\b/i).toUpperCase();
  }
  if (key === 'googleTagManagerId') {
    return extractFirstMatch(raw, /\bGTM-[A-Z0-9-]+\b/i).toUpperCase();
  }
  if (key === 'metaPixelId') {
    return extractFirstMatch(raw, /\b\d{6,32}\b/) || raw.replace(/[^\d]/g, '');
  }
  if (key === 'googleSearchConsoleVerification' || key === 'bingVerification') {
    return extractMetaContent(raw) || raw;
  }
  return raw;
}

function safeUrl(baseUrl, path) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}${normalizePath(path)}`;
}

function platformSubdomainHost(business) {
  return `${business?.slug || 'www'}.${PLATFORM_DOMAIN}`;
}

function isLocalRequestHost(host) {
  const clean = normalizeDomain(host);
  return clean.startsWith('localhost') || clean === '127.0.0.1';
}

function customDomainStatus(subscription = {}) {
  const status = String(
    subscription?.customDomainStatus
      || (subscription?.customDomainVerified ? 'ACTIVE' : 'NONE')
  ).toUpperCase();
  return status || 'NONE';
}

function seoDomainState(business, settings = {}, requestHost = '') {
  const fallbackHost = platformSubdomainHost(business);
  const fallbackBaseUrl = `https://${fallbackHost}`;
  const customDomain = normalizeDomain(business?.subscription?.customDomain);
  const customStatus = customDomainStatus(business?.subscription);
  const customVerified = Boolean(business?.subscription?.customDomainVerified);
  const legacyActiveCustom = customDomain && customVerified && customStatus === 'NONE';
  const customActive = customDomain && customVerified && (customStatus === 'ACTIVE' || legacyActiveCustom);
  const customPreparing = customDomain && !customActive && ['PENDING_DNS', 'PENDING_SSL', 'NONE'].includes(customStatus);
  const customIssue = customDomain && !customActive && ['FAILED', 'DOMAIN_ISSUE'].includes(customStatus);

  // ── Indexability gate (Wix / WordPress.com / Shopify model) ─────────
  // A FREE-SUBDOMAIN site becomes indexable automatically once it's a
  // *real* site — no staff moderation, purely data-driven. The signal is
  // that the tenant has written their OWN homepage copy: a non-empty
  // heroHeadline plus at least one of subheading / about / services-intro.
  // (The seeder only fills cmsServices/cmsTeam and leaves these NULL, so
  // an untouched site renders the theme's default boilerplate — keeping
  // those noindex stops the index filling with near-duplicate template
  // copy.) A verified custom domain stays fully indexed as before, and the
  // tenant's allowIndexing opt-out is always honoured.
  const content = business?.content || {};
  const hasOwn = (v) => typeof v === 'string' && v.trim().length > 0;
  const contentReady = hasOwn(content.heroHeadline)
    && (hasOwn(content.heroSubheading) || hasOwn(content.aboutBody) || hasOwn(content.servicesIntro));
  const tenantAllowsIndex = settings?.allowIndexing !== false;
  const subdomainIndexable = !customActive && contentReady && tenantAllowsIndex;
  // Hard env gate: nothing indexes off the production platform.
  const indexable = SEO_INDEXING_ENABLED && (customActive || subdomainIndexable);

  let status = 'seo_disabled_subdomain';
  let label = 'SEO disabled on free subdomain';
  let message = 'The website is live, but it still shows the starter template copy. Edit your homepage headline and intro and the site becomes indexable on its free subdomain automatically — or connect a custom domain for full branding.';
  if (customActive) {
    status = 'active_custom_domain';
    label = 'Active custom domain';
    message = 'Custom domain is verified. Sitemap, robots.txt, canonical URLs and social URLs use this domain.';
  } else if (customIssue) {
    status = 'domain_issue';
    label = 'Domain issue';
    message = 'Custom domain has an issue. The site still indexes on its free subdomain (if your homepage copy is set); fix the domain to move SEO onto your brand.';
  } else if (customPreparing) {
    status = 'preparing';
    label = 'Preparing custom domain';
    message = 'Custom domain is still being verified. The site indexes on its free subdomain meanwhile; canonical URLs switch to your domain once DNS and HTTPS are active.';
  } else if (subdomainIndexable) {
    status = 'indexable_subdomain';
    label = 'Indexed on free subdomain';
    message = 'Your site is indexable on its free subdomain — sitemap, robots.txt and schema are live. Connect a custom domain to rank on your own brand.';
  }

  // Canonical host + base URL: custom domain when active, otherwise the
  // free subdomain (only once the site qualifies to be indexed).
  const canonicalHost = customActive ? customDomain : (indexable ? fallbackHost : null);
  const cleanRequestHost = normalizeDomain(requestHost);
  const previewBaseUrl = isLocalRequestHost(cleanRequestHost)
    ? `http://${cleanRequestHost}`
    : fallbackBaseUrl;
  const baseUrl = !indexable
    ? null
    : (isLocalRequestHost(cleanRequestHost)
        ? `http://${cleanRequestHost}`
        : (customActive ? `https://${customDomain}` : fallbackBaseUrl));

  return {
    status,
    label,
    message,
    baseUrl,
    canonicalHost,
    previewBaseUrl,
    fallbackHost,
    fallbackBaseUrl,
    customDomain: customDomain || null,
    customDomainStatus: customDomain ? customStatus : 'NONE',
    customDomainVerified: customVerified,
    usingCustomDomain: Boolean(customActive),
    seoEnabled: Boolean(indexable),
    indexable: Boolean(indexable),
    contentReady: Boolean(contentReady),
    indexMode: !indexable ? 'disabled' : (customActive ? 'custom_domain' : 'subdomain'),
    preparingCustomDomain: Boolean(customPreparing),
    domainIssue: Boolean(customIssue),
    configuredCanonicalDomain: normalizeDomain(settings?.canonicalDomain) || null,
  };
}

function publicBaseUrl(business, settings = {}, requestHost = '') {
  return seoDomainState(business, settings, requestHost).baseUrl;
}

function defaultSettingsForBusiness(business) {
  return {
    siteTitle: business?.name || '',
    siteDescription: business?.description || '',
    defaultKeywords: '',
    canonicalDomain: '',
    defaultOgImageUrl: '',
    googleAnalyticsId: '',
    googleTagManagerId: '',
    googleSearchConsoleVerification: '',
    metaPixelId: '',
    bingVerification: '',
    customChatWidgetScript: '',
    allowIndexing: true,
    aiCrawlerPolicy: 'allow',
    enableLlmsTxt: true,
    schemaType: schemaTypeForBusiness(business),
    socialSameAs: '[]',
  };
}

function schemaTypeForBusiness(business) {
  const category = String(business?.category || '').toLowerCase();
  const vertical = resolveVertical(business?.vertical);
  if (category.includes('restaurant') || category.includes('cafe')) return 'Restaurant';
  if (category.includes('doctor') || category.includes('clinic') || category.includes('medical')) return 'MedicalBusiness';
  if (category.includes('law') || category.includes('legal')) return 'LegalService';
  if (vertical === 'ECOMMERCE') return 'Store';
  if (vertical === 'STATIC') return 'LocalBusiness';
  return 'ProfessionalService';
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return String(value).split(',').map((item) => item.trim()).filter(Boolean);
  }
}

function firstBlockText(page) {
  const blocks = Array.isArray(page?.content?.blocks) ? page.content.blocks : [];
  for (const block of blocks) {
    const props = block?.props || {};
    const text = props.body || props.subtitle || props.caption || props.heading || props.title;
    if (text && stripHtml(text).length > 20) return text;
  }
  return '';
}

function homeDescription(business, content, settings) {
  return truncate(
    settings?.siteDescription ||
    content?.heroSubheading ||
    content?.contactBody ||
    content?.tagline ||
    business?.description ||
    `${business?.name || 'This business'} website.`
  );
}

function baseRegistryEntry(entry) {
  return {
    url: normalizePath(entry.url),
    pageType: entry.pageType,
    entityId: entry.entityId || null,
    pageTitle: entry.pageTitle || '',
    fallbackTitle: entry.fallbackTitle || entry.pageTitle || '',
    fallbackDescription: truncate(entry.fallbackDescription || ''),
    fallbackKeywords: entry.fallbackKeywords || '',
    isPublished: entry.isPublished !== false,
    lastmod: entry.lastmod || null,
    defaultPriority: entry.defaultPriority ?? 0.5,
    defaultChangeFrequency: entry.defaultChangeFrequency || 'monthly',
  };
}

async function loadBusinessSeoContext(businessIdOrSlug, { bySlug = false } = {}) {
  const where = bySlug ? { slug: String(businessIdOrSlug).toLowerCase() } : { id: businessIdOrSlug };
  return prisma.business.findUnique({
    where,
    include: {
      content: true,
      seoSettings: true,
      seoPageOverrides: true,
      subscription: true,
      pages: { orderBy: [{ parentNav: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }] },
      blogPosts: { orderBy: [{ publishedAt: 'desc' }, { updatedAt: 'desc' }] },
    },
  });
}

// Per-page-type meta templates. Variables: {title} {business} {section}
// {category} {city}. Empty vars + dangling separators are cleaned up.
function applyMetaTemplate(tpl, vars) {
  if (!tpl || typeof tpl !== 'string') return '';
  const out = tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
  return out.replace(/\s{2,}/g, ' ').replace(/\s*[|\-–·]\s*$/, '').replace(/^\s*[|\-–·]\s*/, '').trim();
}

function parseMetaTemplates(settings) {
  try {
    const t = JSON.parse(settings?.metaTemplates || '{}');
    return t && typeof t === 'object' ? t : {};
  } catch {
    return {};
  }
}

function buildUrlRegistry(business, settings = {}) {
  const content = business?.content || {};
  const templates = parseMetaTemplates(settings);
  const bizVars = { business: business?.name || '', city: business?.city || '', category: business?.category || '' };
  const entries = [
    baseRegistryEntry({
      url: '/',
      pageType: 'home',
      entityId: business?.id,
      pageTitle: 'Home',
      fallbackTitle: settings.siteTitle || content.heroHeadline || business?.name || 'Home',
      fallbackDescription: homeDescription(business, content, settings),
      fallbackKeywords: settings.defaultKeywords || '',
      isPublished: true,
      lastmod: content.updatedAt || business?.updatedAt,
      defaultPriority: 1,
      defaultChangeFrequency: 'weekly',
    }),
  ];

  for (const page of business?.pages || []) {
    const pageTpl = templates.page || {};
    const pageVars = { ...bizVars, title: page.title, section: page.parentNav || '' };
    entries.push(baseRegistryEntry({
      url: `/pages/${page.parentNav}/${page.slug}`,
      pageType: 'page',
      entityId: page.id,
      pageTitle: page.title,
      fallbackTitle: page.metaTitle || applyMetaTemplate(pageTpl.title, pageVars) || page.title,
      fallbackDescription: page.metaDescription || firstBlockText(page) || applyMetaTemplate(pageTpl.description, pageVars) || page.title,
      fallbackKeywords: page.metaKeywords || settings.defaultKeywords || '',
      isPublished: !!page.isPublished,
      lastmod: page.updatedAt,
      defaultPriority: page.parentNav === 'info' ? 0.6 : 0.7,
      defaultChangeFrequency: 'monthly',
    }));
  }

  const publishedPosts = (business?.blogPosts || []).filter((post) => post.isPublished);
  if (publishedPosts.length > 0) {
    entries.push(baseRegistryEntry({
      url: '/blog',
      pageType: 'blog_index',
      pageTitle: 'Blog',
      fallbackTitle: `${business?.name || 'Business'} Blog`,
      fallbackDescription: `Latest articles and updates from ${business?.name || 'the business'}.`,
      fallbackKeywords: settings.defaultKeywords || '',
      isPublished: true,
      lastmod: publishedPosts[0]?.publishedAt || publishedPosts[0]?.updatedAt,
      defaultPriority: 0.8,
      defaultChangeFrequency: 'weekly',
    }));
  }

  for (const post of business?.blogPosts || []) {
    const postTpl = templates.blog_post || {};
    const postVars = { ...bizVars, title: post.title };
    entries.push(baseRegistryEntry({
      url: `/blog/${post.slug}`,
      pageType: 'blog_post',
      entityId: post.id,
      pageTitle: post.title,
      fallbackTitle: post.metaTitle || applyMetaTemplate(postTpl.title, postVars) || post.title,
      fallbackDescription: post.metaDescription || post.excerpt || applyMetaTemplate(postTpl.description, postVars) || post.title,
      fallbackKeywords: post.tagsCsv || settings.defaultKeywords || '',
      isPublished: !!post.isPublished,
      lastmod: post.publishedAt || post.updatedAt,
      defaultPriority: 0.6,
      defaultChangeFrequency: 'monthly',
    }));
  }

  return entries;
}

function mergeEntryWithOverride(entry, override, settings = {}, baseUrl = '') {
  const noIndex = !entry.isPublished || (override?.noIndex ?? !settings.allowIndexing);
  const includeInSitemap = override?.includeInSitemap ?? true;
  const title = override?.metaTitle || entry.fallbackTitle;
  const description = truncate(override?.metaDescription || entry.fallbackDescription);
  const canonicalPath = override?.canonicalUrl ? normalizePath(override.canonicalUrl) : entry.url;
  const canonicalUrl = baseUrl ? safeUrl(baseUrl, canonicalPath) : '';
  const changeFrequency = CHANGE_FREQUENCIES.has(override?.changeFrequency)
    ? override.changeFrequency
    : entry.defaultChangeFrequency;
  const sitemapPriority = Number.isFinite(override?.sitemapPriority)
    ? Math.max(0, Math.min(1, override.sitemapPriority))
    : entry.defaultPriority;

  return {
    ...entry,
    id: override?.id || null,
    metaTitle: title,
    metaDescription: description,
    keywords: override?.keywords || entry.fallbackKeywords || settings.defaultKeywords || '',
    canonicalUrl,
    ogTitle: override?.ogTitle || title,
    ogDescription: truncate(override?.ogDescription || description),
    ogImageUrl: override?.ogImageUrl || settings.defaultOgImageUrl || '',
    noIndex: !!noIndex,
    includeInSitemap: !!includeInSitemap,
    sitemapPriority,
    changeFrequency,
    warnings: seoWarnings({ title, description, entry, noIndex, includeInSitemap, seoDisabled: !baseUrl }),
  };
}

function withSeoDisabled(row) {
  return {
    ...row,
    canonicalUrl: '',
    noIndex: true,
    includeInSitemap: false,
  };
}

function seoWarnings({ title, description, entry, noIndex, includeInSitemap, seoDisabled = false }) {
  const warnings = [];
  if (!title) warnings.push('Missing meta title');
  if (title && title.length > 70) warnings.push('Title over 70 characters');
  if (title && title.length < 20) warnings.push('Title may be too short');
  if (!description) warnings.push('Missing meta description');
  if (description && description.length > 160) warnings.push('Description over 160 characters');
  if (description && description.length < 70) warnings.push('Description may be too short');
  if (!entry.isPublished) warnings.push('Draft page');
  if (!seoDisabled && noIndex && includeInSitemap) warnings.push('Noindex page is included in sitemap');
  return warnings;
}

// Per-site SEO audit (Squarespace/Duda-class checklist) computed from the
// page registry. Returns a 0-100 score, severity counts, and a grouped,
// actionable issue list with the affected pages. Only indexable (published,
// non-noindex) pages count toward the score.
const AUDIT_CHECKS = [
  { code: 'title_missing',    severity: 'error',   label: 'Missing meta title',              test: (r) => !r.metaTitle },
  { code: 'title_short',      severity: 'warning', label: 'Title too short (under 20 chars)', test: (r) => r.metaTitle && r.metaTitle.length < 20 },
  { code: 'title_long',       severity: 'warning', label: 'Title too long (over 70 chars)',   test: (r) => r.metaTitle && r.metaTitle.length > 70 },
  { code: 'desc_missing',     severity: 'error',   label: 'Missing meta description',         test: (r) => !r.metaDescription },
  { code: 'desc_short',       severity: 'warning', label: 'Description too short (under 70)',  test: (r) => r.metaDescription && r.metaDescription.length < 70 },
  { code: 'desc_long',        severity: 'warning', label: 'Description too long (over 160)',   test: (r) => r.metaDescription && r.metaDescription.length > 160 },
  { code: 'keywords_missing', severity: 'info',    label: 'No focus keywords set',            test: (r) => !String(r.keywords || '').trim() },
  { code: 'og_missing',       severity: 'warning', label: 'No social / Open Graph image',     test: (r) => !String(r.ogImageUrl || '').trim() },
];

function buildAudit(rows) {
  const indexable = rows.filter((r) => r.isPublished && !r.noIndex);
  const asPage = (r) => ({ url: r.url, title: r.pageTitle || r.metaTitle || r.url });
  const issues = [];
  let failed = 0;

  for (const c of AUDIT_CHECKS) {
    const hit = indexable.filter(c.test);
    failed += hit.length;
    if (hit.length) issues.push({ code: c.code, severity: c.severity, label: c.label, pages: hit.map(asPage) });
  }

  const noindexInSitemap = rows.filter((r) => r.isPublished && r.noIndex && r.includeInSitemap);
  if (noindexInSitemap.length) {
    issues.push({ code: 'noindex_in_sitemap', severity: 'error', label: 'Noindex page included in sitemap', pages: noindexInSitemap.map(asPage) });
  }

  const duplicateGroups = (key) => {
    const map = new Map();
    for (const r of indexable) {
      const v = String(r[key] || '').trim().toLowerCase();
      if (!v) continue;
      if (!map.has(v)) map.set(v, []);
      map.get(v).push(asPage(r));
    }
    return [...map.values()].filter((g) => g.length > 1);
  };
  const dupTitles = duplicateGroups('metaTitle');
  const dupDescs = duplicateGroups('metaDescription');
  if (dupTitles.length) issues.push({ code: 'dup_title', severity: 'warning', label: 'Duplicate meta titles', pages: dupTitles.flat() });
  if (dupDescs.length) issues.push({ code: 'dup_desc', severity: 'warning', label: 'Duplicate meta descriptions', pages: dupDescs.flat() });

  const total = indexable.length * AUDIT_CHECKS.length;
  let score = total ? Math.round((100 * (total - failed)) / total) : 100;
  score = Math.max(0, score - dupTitles.length * 3 - dupDescs.length * 2 - noindexInSitemap.length * 2);

  return {
    score,
    pages: rows.length,
    indexablePages: indexable.length,
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    info: issues.filter((i) => i.severity === 'info').length,
    issues,
  };
}

async function getSeoCenter(businessId, { requestHost = '' } = {}) {
  const business = await loadBusinessSeoContext(businessId);
  if (!business) return null;
  const settings = { ...defaultSettingsForBusiness(business), ...(business.seoSettings || {}) };
  const seoDomain = seoDomainState(business, settings, requestHost);
  const baseUrl = seoDomain.baseUrl;
  const overrides = new Map((business.seoPageOverrides || []).map((row) => [normalizePath(row.url), row]));
  const entries = buildUrlRegistry(business, settings);
  const rows = entries.map((entry) => mergeEntryWithOverride(entry, overrides.get(entry.url), settings, baseUrl));
  const issueCount = rows.reduce((sum, row) => sum + row.warnings.length, 0);
  const audit = buildAudit(rows);
  return { business, settings: { ...settings, canonicalDomain: seoDomain.canonicalHost }, seoDomain, baseUrl, rows, issueCount, audit };
}

async function getPublicSeoForPath(slug, path, { requestHost = '' } = {}) {
  const business = await loadBusinessSeoContext(slug, { bySlug: true });
  if (!business || !business.isActive) return null;
  const settings = { ...defaultSettingsForBusiness(business), ...(business.seoSettings || {}) };
  const seoDomain = seoDomainState(business, settings, requestHost);
  const baseUrl = seoDomain.baseUrl;
  const entries = buildUrlRegistry(business, settings);
  const entry = entries.find((item) => item.url === normalizePath(path)) || entries[0];
  const override = (business.seoPageOverrides || []).find((row) => normalizePath(row.url) === entry.url);
  const row = mergeEntryWithOverride(entry, override, settings, baseUrl);
  return {
    business,
    settings: { ...settings, canonicalDomain: seoDomain.canonicalHost },
    seoDomain,
    baseUrl,
    row: seoDomain.seoEnabled ? row : withSeoDisabled(row),
  };
}

async function buildTenantSitemap(slug, { requestHost = '' } = {}) {
  const center = await getPublicSeoForPath(slug, '/', { requestHost });
  if (!center || !center.seoDomain?.seoEnabled) return null;
  const business = await loadBusinessSeoContext(slug, { bySlug: true });
  const settings = { ...defaultSettingsForBusiness(business), ...(business.seoSettings || {}) };
  const seoDomain = seoDomainState(business, settings, requestHost);
  const baseUrl = seoDomain.baseUrl;
  const overrides = new Map((business.seoPageOverrides || []).map((row) => [normalizePath(row.url), row]));
  const entries = buildUrlRegistry(business, settings)
    .map((entry) => mergeEntryWithOverride(entry, overrides.get(entry.url), settings, baseUrl))
    .filter((row) => row.isPublished && row.includeInSitemap && !row.noIndex)
    .map((row) => ({
      url: safeUrl(baseUrl, row.url),
      lastmod: row.lastmod,
      changefreq: row.changeFrequency,
      priority: row.sitemapPriority,
    }));
  return buildSitemapXml(entries);
}

async function buildTenantRobots(slug, { requestHost = '' } = {}) {
  const business = await loadBusinessSeoContext(slug, { bySlug: true });
  if (!business || !business.isActive) return null;
  const settings = { ...defaultSettingsForBusiness(business), ...(business.seoSettings || {}) };
  const seoDomain = seoDomainState(business, settings, requestHost);
  if (!seoDomain.seoEnabled) {
    return buildRobotsTxt({ disallowed: ['/'] });
  }
  const baseUrl = seoDomain.baseUrl;
  const disallowed = ['/admin', '/staff', '/dashboard', '/cart', '/checkout'];
  if (!settings.allowIndexing) disallowed.unshift('/');
  let txt = buildRobotsTxt({
    sitemapUrl: `${baseUrl}/sitemap.xml`,
    disallowed,
  });
  if (settings.aiCrawlerPolicy === 'disallow_training' || settings.aiCrawlerPolicy === 'disallow_all_ai') {
    const aiBlock = AI_CRAWLERS.map((bot) => `\nUser-agent: ${bot}\nDisallow: /`).join('\n');
    txt += `\n${aiBlock}\n`;
  }
  return txt;
}

async function buildTenantLlmsTxt(slug, { requestHost = '' } = {}) {
  const center = await getPublicSeoForPath(slug, '/', { requestHost });
  if (!center || !center.seoDomain?.seoEnabled) return null;
  const { business, settings, baseUrl } = center;
  if (settings.enableLlmsTxt === false) return null;
  const rows = (await getSeoCenter(business.id, { requestHost })).rows
    .filter((row) => row.isPublished && !row.noIndex)
    .slice(0, 80);
  const lines = [
    `# ${business.name}`,
    '',
    settings.siteDescription || business.description || `Official website for ${business.name}.`,
    '',
    '## Key Pages',
    ...rows.map((row) => `- [${row.pageTitle || row.metaTitle}](${safeUrl(baseUrl, row.url)}): ${row.metaDescription || row.pageType}`),
  ];
  return `${lines.join('\n')}\n`;
}

function parseJsonObjects(value) {
  return parseJsonArray(value).filter((x) => x && typeof x === 'object');
}

function breadcrumbJsonLd(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.url })),
  };
}

function navLabelForSchema(parentNav) {
  const map = { services: 'Services', team: 'Team', about: 'About', products: 'Products', info: 'Information' };
  return map[parentNav] || (parentNav ? parentNav.charAt(0).toUpperCase() + parentNav.slice(1) : 'Pages');
}

// FAQPage from the homepage faqItems — drives Google FAQ rich results + AEO.
function faqPageJsonLd(content, baseUrl) {
  const items = parseJsonObjects(content?.faqItems)
    .map((it) => ({ q: String(it.q || it.question || '').trim(), a: stripHtml(it.a || it.answer || '') }))
    .filter((it) => it.q && it.a)
    .slice(0, 20);
  if (items.length < 2) return null; // rich result needs ≥2 Q&A
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${baseUrl}/#faq`,
    mainEntity: items.map((it) => ({
      '@type': 'Question',
      name: it.q,
      acceptedAnswer: { '@type': 'Answer', text: it.a },
    })),
  };
}

// ItemList of Service entities from cmsServices — entity clarity for search + AI.
function servicesItemListJsonLd(business, content, baseUrl, orgId) {
  const items = parseJsonObjects(content?.cmsServices)
    .map((s) => ({ name: String(s.name || '').trim(), description: stripHtml(s.description || '') }))
    .filter((s) => s.name)
    .slice(0, 30);
  if (!items.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${baseUrl}/#services`,
    name: `Services — ${business.name}`,
    itemListElement: items.map((s, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: { '@type': 'Service', name: s.name, description: s.description || undefined, provider: { '@id': orgId } },
    })),
  };
}

// Site-wide schema graph: Organization/LocalBusiness + WebSite, plus the
// business-level FAQPage and Services list (injected via the layout).
function buildJsonLd({ business, settings, baseUrl }) {
  if (!baseUrl) return [];
  const content = business.content || {};
  const sameAs = parseJsonArray(settings.socialSameAs);
  const schemaType = settings.schemaType || schemaTypeForBusiness(business);
  const orgId = `${baseUrl}/#organization`;
  const websiteId = `${baseUrl}/#website`;
  const graph = [
    {
      '@context': 'https://schema.org',
      '@type': schemaType,
      '@id': orgId,
      name: business.name,
      url: baseUrl,
      description: truncate(settings.siteDescription || business.description || '') || undefined,
      email: business.email || undefined,
      telephone: business.phone || undefined,
      image: content.logoUrl || settings.defaultOgImageUrl || undefined,
      logo: content.logoUrl || undefined,
      priceRange: business.priceRange || undefined,
      sameAs: sameAs.length ? sameAs : undefined,
      address: business.address ? {
        '@type': 'PostalAddress',
        streetAddress: business.address,
        addressRegion: business.state || undefined,
        addressCountry: business.country || undefined,
      } : undefined,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': websiteId,
      url: baseUrl,
      name: settings.siteTitle || business.name,
      publisher: { '@id': orgId },
    },
  ];
  const faq = faqPageJsonLd(content, baseUrl);
  if (faq) graph.push(faq);
  const services = servicesItemListJsonLd(business, content, baseUrl, orgId);
  if (services) graph.push(services);
  return graph;
}

// Page-specific schema (injected by the blog-post / CMS-page routes):
// Article + BreadcrumbList for blog posts, BreadcrumbList for CMS pages.
function buildPageJsonLd({ business, baseUrl, row }) {
  if (!baseUrl || !row) return [];
  const orgId = `${baseUrl}/#organization`;
  const out = [];
  if (row.pageType === 'blog_post') {
    const post = (business.blogPosts || []).find((p) => p.id === row.entityId);
    if (post) {
      const url = safeUrl(baseUrl, row.url);
      out.push({
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: post.metaTitle || post.title,
        description: truncate(post.metaDescription || post.excerpt || '') || undefined,
        image: post.coverImageUrl || undefined,
        author: { '@type': 'Person', name: post.authorName || business.name },
        publisher: { '@id': orgId },
        datePublished: post.publishedAt || undefined,
        dateModified: post.updatedAt || post.publishedAt || undefined,
        mainEntityOfPage: url,
      });
      out.push(breadcrumbJsonLd([
        { name: 'Home', url: baseUrl },
        { name: 'Blog', url: safeUrl(baseUrl, '/blog') },
        { name: post.title, url },
      ]));
    }
  } else if (row.pageType === 'page') {
    const page = (business.pages || []).find((p) => p.id === row.entityId);
    if (page) {
      out.push(breadcrumbJsonLd([
        { name: 'Home', url: baseUrl },
        { name: navLabelForSchema(page.parentNav), url: baseUrl },
        { name: page.title, url: safeUrl(baseUrl, row.url) },
      ]));
    }
  }
  return out;
}

function sanitizeSettingsInput(body = {}) {
  const stringFields = [
    'siteTitle', 'siteDescription', 'defaultKeywords', 'defaultOgImageUrl',
    'googleAnalyticsId', 'googleTagManagerId', 'googleSearchConsoleVerification', 'metaPixelId',
    'bingVerification', 'customChatWidgetScript', 'aiCrawlerPolicy', 'schemaType', 'socialSameAs', 'metaTemplates',
  ];
  const data = {};
  for (const key of stringFields) {
    if (body[key] !== undefined) data[key] = body[key] == null ? null : String(body[key]).trim();
  }
  if (typeof data.customChatWidgetScript === 'string' && data.customChatWidgetScript.length > CUSTOM_CHAT_WIDGET_SCRIPT_MAX) {
    data.customChatWidgetScript = data.customChatWidgetScript.slice(0, CUSTOM_CHAT_WIDGET_SCRIPT_MAX);
  }
  if (body.allowIndexing !== undefined) data.allowIndexing = !!body.allowIndexing;
  if (body.enableLlmsTxt !== undefined) data.enableLlmsTxt = !!body.enableLlmsTxt;
  for (const key of ['googleAnalyticsId', 'googleTagManagerId', 'googleSearchConsoleVerification', 'metaPixelId', 'bingVerification']) {
    if (data[key] !== undefined) data[key] = normalizeTrackingValue(key, data[key]);
  }
  if (data.aiCrawlerPolicy && !['allow', 'disallow_training', 'disallow_all_ai'].includes(data.aiCrawlerPolicy)) {
    data.aiCrawlerPolicy = 'allow';
  }
  return data;
}

function sanitizePageOverrideInput(row = {}) {
  const url = normalizePath(row.url);
  if (!url) return null;
  const priority = row.sitemapPriority === '' || row.sitemapPriority == null
    ? null
    : Math.max(0, Math.min(1, Number(row.sitemapPriority)));
  const frequency = CHANGE_FREQUENCIES.has(row.changeFrequency) ? row.changeFrequency : null;
  return {
    url,
    pageType: row.pageType || 'custom',
    entityId: row.entityId || null,
    pageTitle: row.pageTitle || null,
    metaTitle: row.metaTitle || null,
    metaDescription: row.metaDescription || null,
    keywords: row.keywords || null,
    canonicalUrl: row.canonicalUrl || null,
    ogTitle: row.ogTitle || null,
    ogDescription: row.ogDescription || null,
    ogImageUrl: row.ogImageUrl || null,
    noIndex: !!row.noIndex,
    includeInSitemap: row.includeInSitemap !== false,
    sitemapPriority: Number.isFinite(priority) ? priority : null,
    changeFrequency: frequency,
  };
}

module.exports = {
  CHANGE_FREQUENCIES,
  normalizePath,
  normalizeDomain,
  seoDomainState,
  publicBaseUrl,
  defaultSettingsForBusiness,
  schemaTypeForBusiness,
  getSeoCenter,
  getPublicSeoForPath,
  buildTenantSitemap,
  buildTenantRobots,
  buildTenantLlmsTxt,
  buildJsonLd,
  buildPageJsonLd,
  buildAudit,
  sanitizeSettingsInput,
  sanitizePageOverrideInput,
};
