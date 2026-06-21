'use strict';

const prisma = require('../lib/prisma');
const { assertBooleanFeature } = require('../lib/entitlements');
const {
  getSeoCenter,
  sanitizeSettingsInput,
  sanitizePageOverrideInput,
  normalizePath,
} = require('../lib/seoCenter');

// Advanced-SEO tier gate (Professional+). Per-page meta overrides, 301/302
// redirects, and bulk CSV are premium; basic SEO (sitemap/robots/site-wide
// meta) stays free. Returns true if allowed, else writes the 403/402 + false.
async function requireAdvancedSeo(req, res) {
  try {
    await assertBooleanFeature({ businessId: req.user.businessId, key: 'advanced_seo', label: 'Advanced SEO (per-page meta, redirects, bulk import)' });
    return true;
  } catch (err) {
    res.status(err.status || 403).json({ message: err.message, code: err.code });
    return false;
  }
}

// Normalise a redirect rule from arbitrary input (form, CSV, API). Returns
// null when invalid: From must be an internal path (not "/"), To must be a
// path or absolute URL, and the two must differ.
function sanitizeRedirect(raw = {}) {
  const fromPath = normalizePath(raw.fromPath || raw.from || raw.from_path || '');
  let toPath = String(raw.toPath || raw.to || raw.to_path || '').trim();
  if (toPath && !/^https?:\/\//i.test(toPath)) toPath = normalizePath(toPath);
  const statusCode = [301, 302, 307, 308].includes(Number(raw.statusCode || raw.status)) ? Number(raw.statusCode || raw.status) : 301;
  if (!fromPath || fromPath === '/' || !toPath || fromPath === toPath) return null;
  return { fromPath, toPath, statusCode };
}

const EXPORT_COLUMNS = [
  'url',
  'page_type',
  'page_title',
  'meta_title',
  'meta_description',
  'keywords',
  'canonical_url',
  'indexing',
  'include_in_sitemap',
  'sitemap_priority',
  'changefreq',
  'og_title',
  'og_description',
  'og_image',
];

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsv(rows) {
  const lines = [EXPORT_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push([
      row.url,
      row.pageType,
      row.pageTitle,
      row.metaTitle,
      row.metaDescription,
      row.keywords,
      row.canonicalUrl,
      row.noIndex ? 'noindex' : 'index',
      row.includeInSitemap ? 'yes' : 'no',
      row.sitemapPriority,
      row.changeFrequency,
      row.ogTitle,
      row.ogDescription,
      row.ogImageUrl,
    ].map(csvEscape).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows.shift().map((h) => String(h || '').trim().toLowerCase());
  return rows
    .filter((r) => r.some((v) => String(v || '').trim()))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] || ''])));
}

function truthy(value, fallback = false) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return fallback;
  return ['1', 'true', 'yes', 'y', 'index', 'indexed'].includes(s);
}

function csvRecordToOverride(record, knownRowsByUrl) {
  const url = record.url || record.path;
  const existing = knownRowsByUrl.get(String(url || '').trim());
  const indexing = String(record.indexing || '').trim().toLowerCase();
  return sanitizePageOverrideInput({
    url,
    pageType: record.page_type || existing?.pageType || 'custom',
    entityId: existing?.entityId || null,
    pageTitle: record.page_title || existing?.pageTitle || null,
    metaTitle: record.meta_title,
    metaDescription: record.meta_description,
    keywords: record.keywords,
    canonicalUrl: record.canonical_url,
    ogTitle: record.og_title,
    ogDescription: record.og_description,
    ogImageUrl: record.og_image,
    noIndex: indexing ? indexing === 'noindex' || indexing === 'no' || indexing === 'false' : !!existing?.noIndex,
    includeInSitemap: truthy(record.include_in_sitemap, existing?.includeInSitemap !== false),
    sitemapPriority: record.sitemap_priority,
    changeFrequency: record.changefreq || record.change_frequency,
  });
}

async function getSeo(req, res) {
  const center = await getSeoCenter(req.user.businessId, { requestHost: req.get('X-Tenant-Host') || req.get('host') || '' });
  if (!center) return res.status(404).json({ message: 'Business not found' });
  const seoEnabled = Boolean(center.seoDomain?.seoEnabled && center.baseUrl);
  res.json({
    settings: center.settings,
    seoDomain: center.seoDomain,
    baseUrl: center.baseUrl,
    previewBaseUrl: center.seoDomain?.previewBaseUrl || center.seoDomain?.fallbackBaseUrl || null,
    rows: center.rows,
    issueCount: center.issueCount,
    sitemapUrl: seoEnabled ? `${center.baseUrl}/sitemap.xml` : null,
    robotsUrl: seoEnabled ? `${center.baseUrl}/robots.txt` : null,
    llmsUrl: seoEnabled ? `${center.baseUrl}/llms.txt` : null,
  });
}

async function updateSeoSettings(req, res) {
  const data = sanitizeSettingsInput(req.body || {});
  const settings = await prisma.businessSeoSettings.upsert({
    where: { businessId: req.user.businessId },
    update: data,
    create: { businessId: req.user.businessId, ...data },
  });
  res.json({ settings });
}

async function updateSeoPages(req, res) {
  if (!(await requireAdvancedSeo(req, res))) return;
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (rows.length > 250) return res.status(400).json({ message: 'You can update at most 250 SEO rows at once' });
  const saved = [];
  for (const raw of rows) {
    const data = sanitizePageOverrideInput(raw);
    if (!data?.url) continue;
    const row = await prisma.seoPageOverride.upsert({
      where: {
        businessId_url: {
          businessId: req.user.businessId,
          url: data.url,
        },
      },
      update: data,
      create: { businessId: req.user.businessId, ...data },
    });
    saved.push(row);
  }
  res.json({ saved });
}

async function exportSeoCsv(req, res) {
  const center = await getSeoCenter(req.user.businessId, { requestHost: req.get('X-Tenant-Host') || req.get('host') || '' });
  if (!center) return res.status(404).json({ message: 'Business not found' });
  const csv = rowsToCsv(center.rows);
  const slug = center.business.slug || 'site';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-seo.csv"`);
  res.send(csv);
}

async function importSeoCsv(req, res) {
  if (!(await requireAdvancedSeo(req, res))) return;
  const csv = req.body?.csv || req.body?.content || '';
  const dryRun = req.body?.dryRun !== false;
  if (!csv || String(csv).length > 2_000_000) {
    return res.status(400).json({ message: 'CSV content is required and must be under 2 MB' });
  }
  const center = await getSeoCenter(req.user.businessId, { requestHost: req.get('X-Tenant-Host') || req.get('host') || '' });
  if (!center) return res.status(404).json({ message: 'Business not found' });
  const knownRowsByUrl = new Map(center.rows.map((row) => [row.url, row]));
  const records = parseCsv(csv);
  const errors = [];
  const updates = [];
  records.forEach((record, index) => {
    const data = csvRecordToOverride(record, knownRowsByUrl);
    if (!data?.url) {
      errors.push({ row: index + 2, message: 'Missing url' });
      return;
    }
    if (!knownRowsByUrl.has(data.url)) {
      errors.push({ row: index + 2, message: `URL ${data.url} is not part of this website` });
      return;
    }
    updates.push(data);
  });
  if (errors.length) return res.status(400).json({ message: 'CSV has errors', errors, preview: updates });
  if (dryRun) return res.json({ dryRun: true, preview: updates, count: updates.length });

  const saved = [];
  for (const data of updates) {
    const row = await prisma.seoPageOverride.upsert({
      where: { businessId_url: { businessId: req.user.businessId, url: data.url } },
      update: data,
      create: { businessId: req.user.businessId, ...data },
    });
    saved.push(row);
  }
  res.json({ imported: saved.length, saved });
}

async function getRedirects(req, res) {
  const redirects = await prisma.redirect.findMany({
    where: { businessId: req.user.businessId },
    orderBy: [{ createdAt: 'desc' }],
  });
  res.json({ redirects });
}

async function saveRedirect(req, res) {
  if (!(await requireAdvancedSeo(req, res))) return;
  const data = sanitizeRedirect(req.body || {});
  if (!data) return res.status(400).json({ message: 'A valid From path (not "/") and a different To path/URL are required.' });
  const redirect = await prisma.redirect.upsert({
    where: { businessId_fromPath: { businessId: req.user.businessId, fromPath: data.fromPath } },
    update: { toPath: data.toPath, statusCode: data.statusCode, isActive: req.body?.isActive !== false },
    create: { businessId: req.user.businessId, ...data, source: 'manual' },
  });
  res.json({ redirect });
}

async function deleteRedirect(req, res) {
  await prisma.redirect.deleteMany({ where: { id: req.params.id, businessId: req.user.businessId } });
  res.json({ deleted: true });
}

async function importRedirectsCsv(req, res) {
  if (!(await requireAdvancedSeo(req, res))) return;
  const csv = req.body?.csv || req.body?.content || '';
  if (!csv || String(csv).length > 1_000_000) return res.status(400).json({ message: 'CSV content is required and must be under 1 MB' });
  const lines = String(csv).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const valid = [];
  const errors = [];
  lines.forEach((line, i) => {
    const [from, to, status] = line.split(',').map((s) => (s || '').trim());
    if (/^from/i.test(from) && /^to/i.test(to || '')) return; // header row
    const data = sanitizeRedirect({ fromPath: from, toPath: to, statusCode: status });
    if (!data) { errors.push({ row: i + 1, message: `Invalid redirect: "${line}"` }); return; }
    valid.push(data);
  });
  if (!valid.length) return res.status(400).json({ message: 'No valid redirects found (expected "from,to[,status]" per line)', errors });
  let imported = 0;
  for (const data of valid.slice(0, 500)) {
    await prisma.redirect.upsert({
      where: { businessId_fromPath: { businessId: req.user.businessId, fromPath: data.fromPath } },
      update: { toPath: data.toPath, statusCode: data.statusCode, isActive: true },
      create: { businessId: req.user.businessId, ...data, source: 'import' },
    });
    imported += 1;
  }
  res.json({ imported, skipped: errors.length, errors: errors.slice(0, 20) });
}

module.exports = {
  getSeo,
  updateSeoSettings,
  updateSeoPages,
  exportSeoCsv,
  importSeoCsv,
  getRedirects,
  saveRedirect,
  deleteRedirect,
  importRedirectsCsv,
};
