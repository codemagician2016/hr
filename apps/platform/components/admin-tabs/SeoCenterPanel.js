'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/adminApi';
import { ErrorBanner, Spinner } from '@/components/admin-ui';
import AiGenerateButton from '@/components/AiGenerateButton';
import { useAiStatus } from '@/lib/useAiStatus';

const SCHEMA_TYPES = [
  'LocalBusiness',
  'ProfessionalService',
  'Organization',
  'Store',
  'Restaurant',
  'MedicalBusiness',
  'LegalService',
];

const CHANGE_FREQUENCIES = ['weekly', 'daily', 'monthly', 'yearly', 'never'];
const TRACKING_FIELDS = [
  {
    key: 'googleAnalyticsId',
    label: 'Google Analytics ID',
    placeholder: 'G-XXXXXXXXXX',
    helper: 'Adds GA4 page-view tracking to the public website.',
    pattern: /^G-[A-Z0-9-]+$/i,
  },
  {
    key: 'googleTagManagerId',
    label: 'Google Tag Manager ID',
    placeholder: 'GTM-XXXXXXX',
    helper: 'Loads the container once on every public page.',
    pattern: /^GTM-[A-Z0-9-]+$/i,
  },
  {
    key: 'googleSearchConsoleVerification',
    label: 'Google Search Console token',
    placeholder: 'verification token',
    helper: 'Accepts the token or the full google-site-verification meta tag.',
    metaName: 'google-site-verification',
  },
  {
    key: 'metaPixelId',
    label: 'Meta/Facebook Pixel ID',
    placeholder: '1234567890',
    helper: 'Installs Meta Pixel and tracks PageView.',
    pattern: /^[0-9]{6,32}$/,
  },
  {
    key: 'bingVerification',
    label: 'Bing verification token',
    placeholder: 'msvalidate token',
    helper: 'Accepts the token or the full msvalidate.01 meta tag.',
    metaName: 'msvalidate.01',
  },
];
const TRACKING_KEYS = TRACKING_FIELDS.map((field) => field.key);

function fieldClass(extra = '') {
  return `w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none ${extra}`;
}

function pickTracking(settings = {}) {
  return Object.fromEntries(TRACKING_KEYS.map((key) => [key, settings[key] || '']));
}

function extractMetaContent(value) {
  const match = String(value || '').match(/\bcontent=["']([^"']+)["']/i);
  return match?.[1] || '';
}

function normalizeTrackingInput(key, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (key === 'googleAnalyticsId') {
    return (raw.match(/\bG-[A-Z0-9-]+\b/i)?.[0] || raw).toUpperCase();
  }
  if (key === 'googleTagManagerId') {
    return (raw.match(/\bGTM-[A-Z0-9-]+\b/i)?.[0] || raw).toUpperCase();
  }
  if (key === 'metaPixelId') {
    return raw.match(/\b\d{6,32}\b/)?.[0] || raw.replace(/[^\d]/g, '');
  }
  if (key === 'googleSearchConsoleVerification' || key === 'bingVerification') {
    return extractMetaContent(raw) || raw;
  }
  return raw;
}

function trackingFieldStatus(field, value) {
  const normalized = normalizeTrackingInput(field.key, value);
  if (!normalized) return { label: 'Not set', className: 'bg-gray-100 text-gray-600' };
  if (field.pattern && !field.pattern.test(normalized)) {
    return { label: 'Check format', className: 'bg-amber-50 text-amber-800' };
  }
  return { label: 'Ready', className: 'bg-emerald-50 text-emerald-700' };
}

function charTone(length, min, max) {
  if (!length) return 'text-gray-400';
  if (length < min || length > max) return 'text-amber-700';
  return 'text-emerald-700';
}

function pageAbsoluteUrl(baseUrl, path) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  const cleanPath = String(path || '/').startsWith('/') ? path : `/${path}`;
  return root ? `${root}${cleanPath === '/' ? '' : cleanPath}` : cleanPath;
}

function issueChipClass(warning) {
  if (/missing|noindex|draft/i.test(warning)) return 'bg-amber-50 text-amber-800';
  if (/over|short/i.test(warning)) return 'bg-orange-50 text-orange-800';
  return 'bg-gray-100 text-gray-700';
}

function scoreColor(score) {
  if (score >= 80) return 'text-emerald-600';
  if (score >= 50) return 'text-amber-600';
  return 'text-red-600';
}

function severityDot(severity) {
  if (severity === 'error') return 'bg-red-500';
  if (severity === 'warning') return 'bg-amber-500';
  return 'bg-gray-400';
}

function seoDomainTone(status) {
  if (status === 'active_custom_domain' || status === 'indexable_subdomain') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (status === 'preparing') return 'border-amber-200 bg-amber-50 text-amber-900';
  if (status === 'domain_issue') return 'border-red-200 bg-red-50 text-red-700';
  return 'border-gray-200 bg-gray-50 text-gray-700';
}

function seoDomainShortLabel(status) {
  if (status === 'active_custom_domain') return 'Custom active';
  if (status === 'indexable_subdomain') return 'Live in search';
  if (status === 'preparing') return 'Preparing';
  if (status === 'domain_issue') return 'Domain issue';
  return 'Not in search';
}

function asLines(value) {
  if (!value) return '';
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.join('\n');
  } catch {}
  return String(value);
}

function linesToJson(value) {
  return JSON.stringify(String(value || '').split(/\n|,/).map((item) => item.trim()).filter(Boolean));
}

function rowPatch(row) {
  return {
    url: row.url,
    pageType: row.pageType,
    entityId: row.entityId,
    pageTitle: row.pageTitle,
    metaTitle: row.metaTitle || '',
    metaDescription: row.metaDescription || '',
    keywords: row.keywords || '',
    canonicalUrl: row.canonicalUrl || '',
    ogTitle: row.ogTitle || '',
    ogDescription: row.ogDescription || '',
    ogImageUrl: row.ogImageUrl || '',
    noIndex: !!row.noIndex,
    includeInSitemap: row.includeInSitemap !== false,
    sitemapPriority: Number(row.sitemapPriority ?? 0.5),
    changeFrequency: row.changeFrequency || 'monthly',
  };
}

function Stat({ label, value, tone = 'gray' }) {
  const tones = {
    gray: 'border-gray-200 bg-white text-gray-900',
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  };
  return (
    <div className={`rounded-xl border px-4 py-3 ${tones[tone] || tones.gray}`}>
      <p className="text-xs font-semibold uppercase tracking-[0.14em] opacity-70">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

function SeoAssetLink({ href, disabled, children }) {
  if (disabled || !href) {
    return (
      <span className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-400">
        {children}
      </span>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">
      {children}
    </a>
  );
}

export default function SeoCenterPanel() {
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingPages, setSavingPages] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState({});
  const [trackingDraft, setTrackingDraft] = useState({});
  const [editingTracking, setEditingTracking] = useState(false);
  const [rows, setRows] = useState([]);
  const [query, setQuery] = useState('');
  const [importPreview, setImportPreview] = useState(null);
  const [importing, setImporting] = useState(false);
  const [redirects, setRedirects] = useState([]);
  const [redirectForm, setRedirectForm] = useState({ fromPath: '', toPath: '', statusCode: 301 });
  const [redirectCsv, setRedirectCsv] = useState('');
  const [redirectBusy, setRedirectBusy] = useState(false);
  const [templates, setTemplates] = useState({});
  const { available: aiAvailable } = useAiStatus();
  const seoDomain = data?.seoDomain || {};
  const seoEnabled = seoDomain.seoEnabled === true;

  async function load() {
    setLoading(true);
    setError('');
    try {
      const next = await api('/api/business/seo');
      const nextSettings = {
        ...next.settings,
        socialSameAs: asLines(next.settings?.socialSameAs),
      };
      setData(next);
      setSettings(nextSettings);
      try { const t = JSON.parse(next.settings?.metaTemplates || '{}'); setTemplates(t && typeof t === 'object' ? t : {}); } catch { setTemplates({}); }
      setTrackingDraft(pickTracking(nextSettings));
      setEditingTracking(false);
      setRows(next.rows || []);
    } catch (err) {
      setError(err?.data?.message || err.message || 'Could not load SEO settings');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function loadRedirects() {
    try {
      const r = await api('/api/business/seo/redirects');
      setRedirects(r.redirects || []);
    } catch { /* table may not exist yet pre-migration; ignore */ }
  }
  useEffect(() => { loadRedirects(); }, []);

  async function addRedirect() {
    if (!redirectForm.fromPath.trim() || !redirectForm.toPath.trim()) {
      setError('Both a From path and a To path/URL are required');
      return;
    }
    setRedirectBusy(true); setError(''); setSaved('');
    try {
      await api('/api/business/seo/redirects', { method: 'POST', body: JSON.stringify(redirectForm) });
      setRedirectForm({ fromPath: '', toPath: '', statusCode: 301 });
      setSaved('Redirect saved');
      await loadRedirects();
    } catch (err) {
      setError(err?.data?.message || err.message || 'Could not save redirect');
    } finally { setRedirectBusy(false); }
  }

  async function removeRedirect(id) {
    setRedirectBusy(true);
    try {
      await api(`/api/business/seo/redirects/${id}`, { method: 'DELETE' });
      await loadRedirects();
    } catch (err) {
      setError(err?.data?.message || err.message || 'Could not delete redirect');
    } finally { setRedirectBusy(false); }
  }

  async function importRedirects() {
    if (!redirectCsv.trim()) return;
    setRedirectBusy(true); setError(''); setSaved('');
    try {
      const res = await api('/api/business/seo/redirects/import', { method: 'POST', body: JSON.stringify({ csv: redirectCsv }) });
      setSaved(`Imported ${res.imported} redirect${res.imported === 1 ? '' : 's'}${res.skipped ? ` (${res.skipped} skipped)` : ''}`);
      setRedirectCsv('');
      await loadRedirects();
    } catch (err) {
      setError(err?.data?.message || err.message || 'Could not import redirects');
    } finally { setRedirectBusy(false); }
  }

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => (
      row.url.toLowerCase().includes(needle) ||
      row.pageType.toLowerCase().includes(needle) ||
      String(row.pageTitle || '').toLowerCase().includes(needle) ||
      String(row.metaTitle || '').toLowerCase().includes(needle) ||
      String(row.metaDescription || '').toLowerCase().includes(needle) ||
      String(row.keywords || '').toLowerCase().includes(needle)
    ));
  }, [rows, query]);

  const seoReadinessItems = useMemo(() => {
    const published = rows.filter((row) => row.isPublished && !row.noIndex);
    const withTitles = published.filter((row) => String(row.metaTitle || '').trim().length >= 20);
    const withDescriptions = published.filter((row) => String(row.metaDescription || '').trim().length >= 70);
    const withKeywords = published.filter((row) => String(row.keywords || '').trim());
    const configuredTracking = TRACKING_FIELDS.filter((field) => normalizeTrackingInput(field.key, settings[field.key])).length;
    return [
      { label: 'Meta titles', value: `${withTitles.length}/${published.length}`, ready: published.length === 0 || withTitles.length === published.length },
      { label: 'Descriptions', value: `${withDescriptions.length}/${published.length}`, ready: published.length === 0 || withDescriptions.length === published.length },
      { label: 'Keywords', value: `${withKeywords.length}/${published.length}`, ready: published.length === 0 || withKeywords.length === published.length },
      { label: 'Tracking', value: `${configuredTracking}/${TRACKING_FIELDS.length}`, ready: configuredTracking > 0 },
      { label: 'Schema', value: settings.schemaType || 'Auto', ready: true },
    ];
  }, [rows, settings]);

  function updateSetting(key, value) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function updateRow(url, key, value) {
    setRows((current) => current.map((row) => (
      row.url === url ? { ...row, [key]: value } : row
    )));
  }

  async function saveSettings(nextSettings = settings, message = 'Global SEO settings saved') {
    setSavingSettings(true);
    setError('');
    setSaved('');
    try {
      const payload = {
        ...nextSettings,
        socialSameAs: linesToJson(nextSettings.socialSameAs),
        metaTemplates: JSON.stringify(templates || {}),
      };
      const res = await api('/api/business/seo/settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      const savedSettings = { ...res.settings, socialSameAs: asLines(res.settings?.socialSameAs) };
      setSettings(savedSettings);
      setTrackingDraft(pickTracking(savedSettings));
      setSaved(message);
      await load();
      return true;
    } catch (err) {
      setError(err?.data?.message || err.message || 'Could not save SEO settings');
      return false;
    } finally {
      setSavingSettings(false);
    }
  }

  async function toggleIndexing(next) {
    await saveSettings(
      { ...settings, allowIndexing: next },
      next ? 'Search indexing turned ON' : 'Search indexing turned OFF',
    );
  }

  async function saveTracking() {
    const normalizedTracking = Object.fromEntries(
      TRACKING_FIELDS.map((field) => [field.key, normalizeTrackingInput(field.key, trackingDraft[field.key])]),
    );
    const ok = await saveSettings(
      { ...settings, ...normalizedTracking },
      'Tracking and verification saved',
    );
    if (ok) setEditingTracking(false);
  }

  function cancelTrackingEdit() {
    setTrackingDraft(pickTracking(settings));
    setEditingTracking(false);
  }

  async function savePages() {
    setSavingPages(true);
    setError('');
    setSaved('');
    try {
      await api('/api/business/seo/pages', {
        method: 'PUT',
        body: JSON.stringify({ rows: rows.map(rowPatch) }),
      });
      setSaved('Page SEO saved');
      await load();
    } catch (err) {
      setError(err?.data?.message || err.message || 'Could not save page SEO');
    } finally {
      setSavingPages(false);
    }
  }

  async function downloadCsv() {
    const res = await fetch('/api/business/seo/export.csv', { credentials: 'include' });
    if (!res.ok) {
      setError('Could not download SEO CSV');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sitepresso-seo.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  async function previewImport(file) {
    if (!file) return;
    setImporting(true);
    setError('');
    setImportPreview(null);
    try {
      const csv = await readFile(file);
      const preview = await api('/api/business/seo/import', {
        method: 'POST',
        body: JSON.stringify({ csv, dryRun: true }),
      });
      setImportPreview({ csv, ...preview });
    } catch (err) {
      const message = err?.data?.errors?.length
        ? err.data.errors.map((item) => `Row ${item.row}: ${item.message}`).join('\n')
        : (err?.data?.message || err.message || 'Could not preview CSV');
      setError(message);
    } finally {
      setImporting(false);
    }
  }

  async function applyImport() {
    if (!importPreview?.csv) return;
    setImporting(true);
    setError('');
    try {
      const res = await api('/api/business/seo/import', {
        method: 'POST',
        body: JSON.stringify({ csv: importPreview.csv, dryRun: false }),
      });
      setSaved(`Imported ${res.imported || 0} SEO rows`);
      setImportPreview(null);
      await load();
    } catch (err) {
      setError(err?.data?.message || err.message || 'Could not import CSV');
    } finally {
      setImporting(false);
    }
  }

  if (loading) return <div className="rounded-2xl border border-gray-200 bg-white p-8"><Spinner /></div>;

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} />}
      {saved && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{saved}</div>}

      <div className="grid gap-3 md:grid-cols-4">
        <Stat label="Indexable URLs" value={seoEnabled ? rows.filter((row) => !row.noIndex && row.isPublished).length : 0} tone={seoEnabled ? 'emerald' : 'gray'} />
        <Stat label="SEO Issues" value={data?.issueCount || 0} tone={data?.issueCount ? 'amber' : 'emerald'} />
        <Stat label="Sitemap URLs" value={seoEnabled ? rows.filter((row) => row.includeInSitemap && !row.noIndex && row.isPublished).length : 0} />
        <Stat label="Draft/Hidden" value={rows.filter((row) => !row.isPublished || row.noIndex).length} />
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">SEO Center</h2>
            <p className="mt-1 text-sm text-gray-500">
              Manage search previews, sitemap visibility, verification tags, analytics, schema, and AI crawler preferences for this website.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <SeoAssetLink href={data?.sitemapUrl} disabled={!seoEnabled}>Sitemap</SeoAssetLink>
            <SeoAssetLink href={data?.robotsUrl} disabled={!seoEnabled}>Robots</SeoAssetLink>
            <SeoAssetLink href={data?.llmsUrl} disabled={!seoEnabled}>llms.txt</SeoAssetLink>
          </div>
        </div>
        <div className={`mt-4 rounded-xl border px-4 py-3 ${seoDomainTone(seoDomain.status)}`}>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] opacity-75">Search visibility</p>
              <p className="mt-1 text-sm font-bold">
                {seoEnabled
                  ? (seoDomain.indexMode === 'custom_domain'
                      ? 'Live in Google on your custom domain'
                      : 'Live in Google on your free web address')
                  : (settings.allowIndexing === false
                      ? 'Hidden from search — indexing is turned off'
                      : (seoDomain.contentReady === false
                          ? 'Almost there — not in search yet'
                          : 'Not in search yet'))}
              </p>
              <p className="mt-1 break-all font-mono text-xs opacity-80">
                {seoEnabled ? (data?.baseUrl || seoDomain.baseUrl) : (seoDomain.fallbackBaseUrl || data?.previewBaseUrl)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="rounded-full bg-white/70 px-3 py-1 text-xs font-bold">{seoDomainShortLabel(seoDomain.status)}</span>
              <button
                type="button"
                onClick={() => toggleIndexing(settings.allowIndexing === false)}
                disabled={savingSettings}
                title="Turn search-engine indexing on or off"
                className={`rounded-full px-3 py-1.5 text-xs font-bold text-white transition disabled:opacity-50 ${settings.allowIndexing === false ? 'bg-gray-400 hover:bg-gray-500' : 'bg-emerald-600 hover:bg-emerald-700'}`}
              >
                {settings.allowIndexing === false ? 'Indexing: OFF' : 'Indexing: ON'}
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs leading-relaxed">{seoDomain.message || 'Search engines see this site once it has real homepage content.'}</p>
          <p className="mt-2 text-xs leading-relaxed opacity-80">
            <span className="font-semibold">No code or Google scripts needed.</span> Indexing is automatic — keep this ON and publish a real homepage headline + intro. The Analytics, Tag Manager, Search Console and Pixel fields below are optional: paste an ID and the script is added for you.
          </p>
          {seoDomain.customDomain && !seoDomain.usingCustomDomain && (
            <p className="mt-1 text-xs">
              Connected domain being checked: <span className="font-mono font-semibold">{seoDomain.customDomain}</span>
            </p>
          )}
        </div>
      </div>

      {data?.audit && (
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-gray-900">SEO Audit</h3>
              <p className="mt-1 text-xs text-gray-500">
                Automated checks across your {data.audit.indexablePages} indexable page{data.audit.indexablePages === 1 ? '' : 's'}. Fix these to rank better.
              </p>
            </div>
            <div className="text-right shrink-0">
              <div className={`text-3xl font-extrabold leading-none ${scoreColor(data.audit.score)}`}>{data.audit.score}</div>
              <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400">Score / 100</div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-red-50 px-2.5 py-1 font-semibold text-red-700">{data.audit.errors} error{data.audit.errors === 1 ? '' : 's'}</span>
            <span className="rounded-full bg-amber-50 px-2.5 py-1 font-semibold text-amber-800">{data.audit.warnings} warning{data.audit.warnings === 1 ? '' : 's'}</span>
            <span className="rounded-full bg-gray-100 px-2.5 py-1 font-semibold text-gray-600">{data.audit.info} suggestion{data.audit.info === 1 ? '' : 's'}</span>
          </div>
          {data.audit.issues.length === 0 ? (
            <p className="mt-4 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">✓ No issues found — every indexable page passes the checks.</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {data.audit.issues.map((issue) => (
                <li key={issue.code} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${severityDot(issue.severity)}`} />
                    <span className="text-sm font-medium text-gray-800">{issue.label}</span>
                    <span className="text-xs text-gray-400">· {issue.pages.length} page{issue.pages.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5 pl-4">
                    {issue.pages.slice(0, 8).map((p, i) => (
                      <span key={`${issue.code}-${p.url}-${i}`} className="rounded border border-gray-200 bg-white px-1.5 py-0.5 font-mono text-[11px] text-gray-500">{p.url}</span>
                    ))}
                    {issue.pages.length > 8 && <span className="text-[11px] text-gray-400">+{issue.pages.length - 8} more</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Redirects</h3>
          <p className="mt-1 text-xs text-gray-500">301/302 redirects for moved or old URLs. Renaming a page auto-creates a 301 so existing links never break.</p>
        </div>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="block flex-1">
            <span className="text-xs font-medium text-gray-600">From (old path)</span>
            <input className={fieldClass('mt-1')} placeholder="/old-page" value={redirectForm.fromPath} onChange={(e) => setRedirectForm((f) => ({ ...f, fromPath: e.target.value }))} />
          </label>
          <label className="block flex-1">
            <span className="text-xs font-medium text-gray-600">To (path or full URL)</span>
            <input className={fieldClass('mt-1')} placeholder="/new-page" value={redirectForm.toPath} onChange={(e) => setRedirectForm((f) => ({ ...f, toPath: e.target.value }))} />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Type</span>
            <select className={fieldClass('mt-1 bg-white')} value={redirectForm.statusCode} onChange={(e) => setRedirectForm((f) => ({ ...f, statusCode: Number(e.target.value) }))}>
              <option value={301}>301 permanent</option>
              <option value={302}>302 temporary</option>
            </select>
          </label>
          <button type="button" onClick={addRedirect} disabled={redirectBusy} className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Add</button>
        </div>
        {redirects.length === 0 ? (
          <p className="mt-4 text-sm text-gray-400">No redirects yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
                  <th className="py-2 pr-3 font-semibold">From</th>
                  <th className="py-2 pr-3 font-semibold">To</th>
                  <th className="py-2 pr-3 font-semibold">Type</th>
                  <th className="py-2 pr-3 font-semibold">Hits</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {redirects.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="py-2 pr-3 font-mono text-xs text-gray-700">{r.fromPath}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-gray-500">{r.toPath}</td>
                    <td className="py-2 pr-3">
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-semibold text-gray-600">{r.statusCode}</span>
                      {r.source === 'auto_slug_change' && <span className="ml-1 text-[10px] font-semibold text-indigo-500">auto</span>}
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-400">{r.hits || 0}</td>
                    <td className="py-2 text-right">
                      <button type="button" onClick={() => removeRedirect(r.id)} disabled={redirectBusy} className="text-xs font-semibold text-red-600 hover:underline disabled:opacity-50">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-semibold text-gray-500">Bulk import (CSV: from,to,type)</summary>
          <textarea className={fieldClass('mt-2 resize-none font-mono text-xs')} rows={3} placeholder={'/old-1,/new-1,301\n/old-2,https://example.com,302'} value={redirectCsv} onChange={(e) => setRedirectCsv(e.target.value)} />
          <button type="button" onClick={importRedirects} disabled={redirectBusy || !redirectCsv.trim()} className="mt-2 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 disabled:opacity-50">Import</button>
        </details>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.65fr)]">
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-gray-900">Global SEO</h3>
              <p className="mt-1 text-xs text-gray-500">Defaults used by the home page and any page without its own override.</p>
            </div>
            <button
              type="button"
              onClick={() => saveSettings()}
              disabled={savingSettings}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {savingSettings ? 'Saving...' : 'Save'}
            </button>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Site title</span>
              <input className={fieldClass('mt-1')} value={settings.siteTitle || ''} onChange={(e) => updateSetting('siteTitle', e.target.value)} maxLength={90} />
            </label>
            <div className="block">
              <span className="text-sm font-medium text-gray-700">Canonical domain</span>
              <div className="mt-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                <div className="break-all font-mono text-sm font-semibold text-gray-900">
                  {seoEnabled ? seoDomain.canonicalHost : 'Not published until custom domain is active'}
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Managed automatically from the custom-domain status. Free subdomains are kept out of search.
                </p>
              </div>
            </div>
            <label className="block md:col-span-2">
              <span className="text-sm font-medium text-gray-700">Site description</span>
              <textarea className={fieldClass('mt-1 resize-none')} rows={3} value={settings.siteDescription || ''} onChange={(e) => updateSetting('siteDescription', e.target.value)} maxLength={220} />
              <span className="mt-1 block text-xs text-gray-400">{String(settings.siteDescription || '').length}/160 recommended</span>
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Default keywords</span>
              <input className={fieldClass('mt-1')} value={settings.defaultKeywords || ''} onChange={(e) => updateSetting('defaultKeywords', e.target.value)} placeholder="service, city, brand" />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Default social image URL</span>
              <input className={fieldClass('mt-1')} value={settings.defaultOgImageUrl || ''} onChange={(e) => updateSetting('defaultOgImageUrl', e.target.value)} />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Schema type</span>
              <select className={fieldClass('mt-1 bg-white')} value={settings.schemaType || 'LocalBusiness'} onChange={(e) => updateSetting('schemaType', e.target.value)}>
                {SCHEMA_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">AI crawler policy</span>
              <select className={fieldClass('mt-1 bg-white')} value={settings.aiCrawlerPolicy || 'allow'} onChange={(e) => updateSetting('aiCrawlerPolicy', e.target.value)}>
                <option value="allow">Allow AI crawlers</option>
                <option value="disallow_training">Block common AI training crawlers</option>
                <option value="disallow_all_ai">Block common AI crawlers</option>
              </select>
            </label>
            <label className="block md:col-span-2">
              <span className="text-sm font-medium text-gray-700">Social profile URLs</span>
              <textarea className={fieldClass('mt-1 resize-none')} rows={3} value={settings.socialSameAs || ''} onChange={(e) => updateSetting('socialSameAs', e.target.value)} placeholder="https://facebook.com/brand&#10;https://linkedin.com/company/brand" />
            </label>
          </div>

          <div className="mt-5 grid gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4 md:grid-cols-2">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={settings.enableLlmsTxt !== false} onChange={(e) => updateSetting('enableLlmsTxt', e.target.checked)} className="h-4 w-4 rounded accent-indigo-600" />
              Publish llms.txt <span className="text-xs text-gray-400">(lets AI assistants read your pages)</span>
            </label>
            <p className="flex items-center text-xs text-gray-500">Search indexing on/off is the <span className="mx-1 font-semibold text-gray-700">Indexing</span> toggle at the top.</p>
          </div>

          <div className="mt-5 rounded-xl border border-gray-200 p-4">
            <p className="text-sm font-semibold text-gray-800">Meta templates <span className="text-xs font-normal text-gray-400">— auto-fill titles/descriptions for pages that don&apos;t set their own</span></p>
            <p className="mt-1 text-[11px] text-gray-400">
              Variables: <code className="rounded bg-gray-100 px-1">{'{title}'}</code> <code className="rounded bg-gray-100 px-1">{'{business}'}</code> <code className="rounded bg-gray-100 px-1">{'{section}'}</code> <code className="rounded bg-gray-100 px-1">{'{category}'}</code>
            </p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium text-gray-600">CMS page · title</span>
                <input className={fieldClass('mt-1')} placeholder="{title} | {business}" value={templates.page?.title || ''} onChange={(e) => setTemplates((t) => ({ ...t, page: { ...(t.page || {}), title: e.target.value } }))} />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">CMS page · description</span>
                <input className={fieldClass('mt-1')} placeholder="{title} — {section} at {business}" value={templates.page?.description || ''} onChange={(e) => setTemplates((t) => ({ ...t, page: { ...(t.page || {}), description: e.target.value } }))} />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">Blog post · title</span>
                <input className={fieldClass('mt-1')} placeholder="{title} | {business} Blog" value={templates.blog_post?.title || ''} onChange={(e) => setTemplates((t) => ({ ...t, blog_post: { ...(t.blog_post || {}), title: e.target.value } }))} />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">Blog post · description</span>
                <input className={fieldClass('mt-1')} placeholder="{title} — from {business}" value={templates.blog_post?.description || ''} onChange={(e) => setTemplates((t) => ({ ...t, blog_post: { ...(t.blog_post || {}), description: e.target.value } }))} />
              </label>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-gray-900">Tracking & verification</h3>
                <p className="mt-1 text-xs text-gray-500">Analytics, ad pixels, and ownership tokens installed on the public website.</p>
              </div>
              {editingTracking ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={cancelTrackingEdit}
                    disabled={savingSettings}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveTracking}
                    disabled={savingSettings}
                    className="rounded-lg bg-gray-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    {savingSettings ? 'Saving...' : 'Save'}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingTracking(true)}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                >
                  Edit
                </button>
              )}
            </div>

            <div className="mt-4 space-y-3">
              {TRACKING_FIELDS.map((field) => {
                const currentValue = editingTracking ? trackingDraft[field.key] : settings[field.key];
                const normalizedValue = normalizeTrackingInput(field.key, currentValue);
                const status = trackingFieldStatus(field, currentValue);
                return (
                  <label key={field.key} className="block rounded-xl border border-gray-100 bg-gray-50/60 p-3">
                    <span className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold text-gray-800">{field.label}</span>
                      <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${status.className}`}>{status.label}</span>
                    </span>
                    <input
                      className={fieldClass(`mt-2 ${editingTracking ? 'bg-white' : 'bg-white/70 text-gray-600'}`)}
                      value={currentValue || ''}
                      onChange={(e) => setTrackingDraft((draft) => ({ ...draft, [field.key]: e.target.value }))}
                      placeholder={field.placeholder}
                      readOnly={!editingTracking}
                    />
                    <span className="mt-1 block text-xs text-gray-500">{field.helper}</span>
                    {field.metaName && normalizedValue && (
                      <code className="mt-2 block overflow-x-auto rounded-lg bg-white px-2 py-1 text-[11px] text-gray-600">
                        {`<meta name="${field.metaName}" content="${normalizedValue}" />`}
                      </code>
                    )}
                  </label>
                );
              })}
            </div>

            <div className="mt-4 grid gap-2 text-xs text-gray-600 sm:grid-cols-3">
              <div className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800">
                {TRACKING_FIELDS.filter((field) => normalizeTrackingInput(field.key, settings[field.key])).length}/{TRACKING_FIELDS.length} configured
              </div>
              <div className="rounded-lg bg-gray-50 px-3 py-2">Script IDs are format-checked before install.</div>
              <div className="rounded-lg bg-gray-50 px-3 py-2">Verification meta tags are rendered in the page head.</div>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <h3 className="text-base font-semibold text-gray-900">CSV workflow</h3>
            <p className="mt-1 text-xs text-gray-500">Download all website URLs, edit SEO in a sheet, then upload the same file back.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={downloadCsv} className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">Download CSV</button>
              <label className="cursor-pointer rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white">
                {importing ? 'Reading...' : 'Upload CSV'}
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => previewImport(e.target.files?.[0])} />
              </label>
            </div>
            {importPreview && (
              <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                <p className="font-semibold">{importPreview.count} changes ready</p>
                <p className="mt-1 text-xs">Review looks valid. Apply to update page SEO overrides.</p>
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={applyImport} disabled={importing} className="rounded-md bg-blue-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Apply import</button>
                  <button type="button" onClick={() => setImportPreview(null)} className="rounded-md border border-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-blue-900">Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Page SEO</h3>
            <p className="mt-1 text-xs text-gray-500">Every public URL that can appear in search. Draft pages are kept visible here for preparation.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className={fieldClass('sm:w-64')} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search URLs" />
            <button type="button" onClick={savePages} disabled={savingPages} className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {savingPages ? 'Saving...' : 'Save page SEO'}
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {seoReadinessItems.map((item) => (
            <div key={item.label} className={`rounded-lg border px-3 py-2 ${item.ready ? 'border-emerald-100 bg-emerald-50 text-emerald-900' : 'border-amber-100 bg-amber-50 text-amber-900'}`}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] opacity-70">{item.label}</p>
              <p className="mt-1 text-sm font-bold">{item.value}</p>
            </div>
          ))}
        </div>

        <div className="mt-5 space-y-5">
          {filteredRows.length === 0 && (
            <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-gray-500">
              No URLs match this search.
            </div>
          )}

          {filteredRows.map((row) => {
            const titleLength = String(row.metaTitle || '').length;
            const descriptionLength = String(row.metaDescription || '').length;
            const previewTitle = row.metaTitle || row.pageTitle || settings.siteTitle || 'Untitled page';
            const previewDescription = row.metaDescription || 'Add a focused meta description so visitors understand this page before they click.';
            const absoluteUrl = pageAbsoluteUrl(data?.baseUrl, row.url);

            return (
              <div key={row.url} className="border-t border-gray-100 pt-5 first:border-t-0 first:pt-0">
                <div className="grid gap-4 xl:grid-cols-[minmax(180px,260px)_minmax(0,1fr)_220px]">
                  <div>
                    <div className="font-mono text-sm font-bold text-gray-950">{row.url}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-gray-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-600">{row.pageType}</span>
                      {!row.isPublished && <span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-800">Draft</span>}
                      {row.noIndex && <span className="rounded-full bg-gray-100 px-2 py-1 text-[10px] font-semibold text-gray-700">Noindex</span>}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1">
                      {row.warnings?.length ? row.warnings.slice(0, 4).map((warning) => (
                        <span key={warning} className={`rounded-full px-2 py-1 text-[10px] font-semibold ${issueChipClass(warning)}`}>{warning}</span>
                      )) : (
                        <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-800">Clean</span>
                      )}
                    </div>
                  </div>

                  <div className="space-y-3">
                    {aiAvailable && (
                      <div className="flex justify-end">
                        <AiGenerateButton
                          available={aiAvailable}
                          type="seo_meta"
                          label="Generate meta"
                          getInput={() => ({
                            title: row.url === '/' ? 'Home' : (row.url.replace(/^\//, '').replace(/[-/]/g, ' ').trim() || 'Home'),
                            context: `${row.pageType || 'website'} page`,
                            keywords: (row.keywords || '').split(',').map((s) => s.trim()).filter(Boolean),
                          })}
                          onResult={(r) => {
                            if (r?.metaTitle) updateRow(row.url, 'metaTitle', r.metaTitle);
                            if (r?.metaDescription) updateRow(row.url, 'metaDescription', r.metaDescription);
                          }}
                        />
                      </div>
                    )}
                    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.65fr)]">
                      <label className="block">
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-gray-800">Meta title</span>
                          <span className={`text-xs font-semibold ${charTone(titleLength, 20, 70)}`}>{titleLength}/70</span>
                        </span>
                        <input
                          className={fieldClass('mt-1')}
                          value={row.metaTitle || ''}
                          onChange={(e) => updateRow(row.url, 'metaTitle', e.target.value)}
                          maxLength={120}
                          placeholder="Search result title"
                        />
                      </label>
                      <label className="block">
                        <span className="text-sm font-semibold text-gray-800">Keywords</span>
                        <input
                          className={fieldClass('mt-1')}
                          value={row.keywords || ''}
                          onChange={(e) => updateRow(row.url, 'keywords', e.target.value)}
                          placeholder="tax filing, gst, ca services"
                        />
                      </label>
                    </div>

                    <label className="block">
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-gray-800">Meta description</span>
                        <span className={`text-xs font-semibold ${charTone(descriptionLength, 70, 160)}`}>{descriptionLength}/160</span>
                      </span>
                      <textarea
                        className={fieldClass('mt-1 resize-none')}
                        rows={3}
                        value={row.metaDescription || ''}
                        onChange={(e) => updateRow(row.url, 'metaDescription', e.target.value)}
                        maxLength={240}
                        placeholder="Short search result summary"
                      />
                    </label>

                    <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                      <p className="truncate text-xs text-emerald-700">{absoluteUrl}</p>
                      <p className="mt-1 truncate text-base font-semibold text-blue-700">{previewTitle}</p>
                      <p className="mt-1 text-sm leading-5 text-gray-600">{previewDescription}</p>
                    </div>
                  </div>

                  <div className="space-y-3 xl:border-l xl:border-gray-100 xl:pl-4">
                    <div className="grid grid-cols-2 gap-2 xl:grid-cols-1">
                      <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
                        <input type="checkbox" checked={!row.noIndex} onChange={(e) => updateRow(row.url, 'noIndex', !e.target.checked)} className="h-4 w-4 rounded accent-indigo-600" />
                        Index page
                      </label>
                      <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
                        <input type="checkbox" checked={row.includeInSitemap !== false} onChange={(e) => updateRow(row.url, 'includeInSitemap', e.target.checked)} className="h-4 w-4 rounded accent-indigo-600" />
                        In sitemap
                      </label>
                    </div>
                    <label className="block">
                      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-gray-500">Priority</span>
                      <input className={fieldClass('mt-1')} type="number" min="0" max="1" step="0.1" value={row.sitemapPriority ?? 0.5} onChange={(e) => updateRow(row.url, 'sitemapPriority', e.target.value)} />
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-gray-500">Change frequency</span>
                      <select className={fieldClass('mt-1 bg-white')} value={row.changeFrequency || 'monthly'} onChange={(e) => updateRow(row.url, 'changeFrequency', e.target.value)}>
                        {CHANGE_FREQUENCIES.map((freq) => <option key={freq} value={freq}>{freq}</option>)}
                      </select>
                    </label>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
