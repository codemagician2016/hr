'use client';

// Settings shell — sub-tabs for details / hours+holidays /
// marketing / intakeforms / integrations / coupons / embed.
// CouponRedeemCard + AppliedSuccessCard are co-located helpers.
//
// Extracted from [slug]/admin/page.js 2026-04-29.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { COUNTRIES, DEFAULT_COUNTRY, addressPlaceholderFor, timezonesFor, defaultTimezoneFor } from '@/lib/countries';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, Modal, ModalActions, PrimaryButton, TextInput, TextArea, formatAdminDate, formatAdminDateTime, formatMoneyMinor, capitalizeSlug } from '@/components/admin-ui';
import { SECTORS, getProfession } from '@/lib/professions';
import { getThemeForCategory } from '@/lib/categoryTheme';
import { THEMES } from '@/lib/themes';
import { resolveVertical } from '@/lib/vertical';
import { useConfirm } from '@/components/ConfirmDialog';
import CategoryChangeForkModal from '@/components/admin-modals/CategoryChangeForkModal';
import HoursAndHolidaysTab from '@/components/admin-tabs/HoursAndHolidaysTab';
import CouponsTab from '@/components/admin-tabs/CouponsTab';
import EmbedTab from '@/components/admin-tabs/EmbedTab';
import FeaturesTab from '@/components/admin-tabs/FeaturesTab';
import VideoIntegrationsCard from '@/components/admin-cards/VideoIntegrationsCard';
import MarketingAutomationPanel from '@/components/MarketingAutomationPanel';
import IntakeFormBuilder from '@/components/IntakeFormBuilder';
import { Letterhead2SettingsPanel } from '@/components/admin-tabs/DoctorClinicSettingsPanels';
import { getPlatformDomain } from '@/lib/platformDomain';
import { currencyForCountry } from '@/lib/currency';
import CountryAddressFields from '@/components/CountryAddressFields';

const PLATFORM_DOMAIN = getPlatformDomain();
const SLUG_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const CUSTOM_DOMAIN_PROVIDER = (process.env.NEXT_PUBLIC_CUSTOM_DOMAIN_PROVIDER || '').toLowerCase();
const CUSTOM_DOMAIN_CNAME_TARGET =
  process.env.NEXT_PUBLIC_CUSTOM_DOMAIN_CNAME_TARGET ||
  (CUSTOM_DOMAIN_PROVIDER === 'vercel' ? 'cname.vercel-dns-0.com' : `custom.${PLATFORM_DOMAIN}`);
const CUSTOM_DOMAIN_APEX_IPS = (process.env.NEXT_PUBLIC_CUSTOM_DOMAIN_APEX_IPS || '')
  .split(',')
  .map((ip) => ip.trim())
  .filter(Boolean);
const DOCTOR_BOOKING_THEME_KEYS = new Set(['doctor_clinic', 'general_practice']);
const DOCTOR_BOOKING_CATEGORY_KEYS = new Set(['doctor', 'doctor_clinic', 'general_practice', 'gp', 'physician']);
const BOOKING_INTAKE_THEME_KEYS = new Set(['doctor_clinic', 'water_purifier', 'law_firm']);
const CHAT_WIDGET_SCRIPT_MAX = 20000;
const SETTINGS_GROUPS = [
  { key: 'core', label: 'Core setup' },
  { key: 'experience', label: 'Customer experience' },
  { key: 'growth', label: 'Growth tools' },
  { key: 'account', label: 'Account control' },
];
const SETTINGS_GROUP_LABELS = SETTINGS_GROUPS.reduce((acc, group) => {
  acc[group.key] = group.label;
  return acc;
}, {});

function normalizeFeatureKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getSettingsCapabilities({ business = {}, form = {}, subscription = null } = {}) {
  const vertical = resolveVertical(form.vertical || business.vertical);
  const themeKey = normalizeFeatureKey(subscription?.theme || business.theme);
  const categoryKey = normalizeFeatureKey(form.category || business.category || business.profession);
  const theme = THEMES[themeKey] || {};
  const themeTags = Array.isArray(theme.tags) ? theme.tags.map(normalizeFeatureKey) : [];
  const isAppointment = vertical === 'APPOINTMENT';
  const isEcommerce = vertical === 'ECOMMERCE';
  const isDoctorClinicTheme = isAppointment && themeKey === 'doctor_clinic';
  const isDoctorBooking = isAppointment && (
    DOCTOR_BOOKING_THEME_KEYS.has(themeKey) ||
    DOCTOR_BOOKING_CATEGORY_KEYS.has(categoryKey) ||
    themeTags.includes('doctor') ||
    themeTags.includes('physician')
  );
  const supportsBookingIntake = isAppointment && (
    isDoctorBooking ||
    BOOKING_INTAKE_THEME_KEYS.has(themeKey)
  );

  return {
    appointment: isAppointment,
    ecommerce: isEcommerce,
    static: vertical === 'STATIC',
    // ECOMMERCE (grocery) manages hours via delivery slots, holidays as
    // "days you don't deliver", and the store/location model — all in the
    // Store Setup window now — so these Settings sub-tabs are hidden for it.
    hours: isAppointment,
    holidays: isAppointment,
    multiStore: false,
    marketing: isAppointment || isEcommerce,
    integrations: isAppointment,
    coupons: isAppointment,
    embed: isAppointment,
    intakeForms: supportsBookingIntake,
    doctorClinicSettings: isDoctorClinicTheme,
    letterhead2: isDoctorBooking,
    features: isEcommerce,
  };
}

function CopyDnsValue({ value, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-md border border-gray-300 px-2 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

function DnsRecordRow({ type, name, value, status }) {
  return (
    <div className="grid gap-2 border-t border-gray-100 py-3 text-sm md:grid-cols-[92px_1fr_1.6fr_auto] md:items-center">
      <span className="font-mono text-xs font-bold text-gray-900">{type}</span>
      <code className="rounded bg-gray-50 px-2 py-1 text-xs text-gray-700">{name}</code>
      <code className="break-all rounded bg-gray-50 px-2 py-1 text-xs text-gray-700">{value}</code>
      {status ? <span className="text-xs text-gray-500">{status}</span> : <CopyDnsValue value={value} />}
    </div>
  );
}

function statusClasses(status) {
  if (status === 'ACTIVE') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (status === 'PENDING_DNS' || status === 'PENDING_SSL') return 'border-amber-200 bg-amber-50 text-amber-900';
  if (status === 'FAILED') return 'border-red-200 bg-red-50 text-red-700';
  return 'border-gray-200 bg-gray-50 text-gray-700';
}

function customDomainStatusLabel(status) {
  if (status === 'ACTIVE') return 'Active';
  if (status === 'PENDING_DNS') return 'Waiting for DNS';
  if (status === 'PENDING_SSL') return 'Activating HTTPS';
  if (status === 'FAILED') return 'Domain issue';
  return 'Not connected';
}

function normalizeDomainInput(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0]
    .replace(/\.$/, '');
}

function domainLabels(value) {
  return normalizeDomainInput(value).split('.').filter(Boolean);
}

function isLikelyRootDomain(value) {
  return domainLabels(value).length === 2;
}

function recommendedWwwDomain(value) {
  const clean = normalizeDomainInput(value);
  if (!clean) return '';
  if (!isLikelyRootDomain(clean)) return clean;
  return clean.startsWith('www.') ? clean : `www.${clean}`;
}

function CustomDomainGuide({ slug, platformDomain, cnameTarget, apexIps, initialDomain, siteLabel = 'website' }) {
  const platformSubdomain = `${slug || 'your-site'}.${platformDomain}`;
  const [domain, setDomain] = useState(initialDomain || '');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nextAutoCheck, setNextAutoCheck] = useState(null);
  const [domainEditing, setDomainEditing] = useState(!initialDomain);
  const confirm = useConfirm();

  async function loadStatus({ silent = false } = {}) {
    if (!silent) setBusy(true);
    setError('');
    try {
      const data = await api('/api/subscription/custom-domain/status');
      setStatus(data);
      if (data.domain && (!domainEditing || !domain)) {
        setDomain(data.domain);
        setDomainEditing(false);
      }
    } catch (err) {
      setError(err?.data?.message || err.message || 'Could not check domain');
    } finally {
      if (!silent) setBusy(false);
    }
  }

  useEffect(() => {
    loadStatus({ silent: true });
  }, []);

  useEffect(() => {
    if (!status?.domain || !['PENDING_DNS', 'PENDING_SSL'].includes(status.status)) {
      setNextAutoCheck(null);
      return undefined;
    }

    setNextAutoCheck(Date.now() + 30000);
    const interval = setInterval(() => {
      setNextAutoCheck(Date.now() + 30000);
      loadStatus({ silent: true });
    }, 30000);
    return () => clearInterval(interval);
  }, [status?.domain, status?.status]);

  async function connectDomain(nextDomain = null, options = {}) {
    const clean = normalizeDomainInput(nextDomain || domain);
    if (!clean) {
      setError('Enter your domain first, for example www.example.com');
      return;
    }
    setBusy(true);
    setError('');
    try {
      let data;
      try {
        data = await api('/api/subscription/custom-domain', {
          method: 'PUT',
          body: JSON.stringify({ domain: clean, ...(options.forceTransfer ? { forceTransfer: true } : {}) }),
        });
      } catch (err) {
        if (err?.status === 422 && err?.data?.code === 'APEX_DOMAIN_NEEDS_WWW' && err?.data?.suggestedDomain) {
          const suggestedDomain = err.data.suggestedDomain;
          const ok = await confirm(
            `${clean} is a root domain, but this environment needs a registrar-supported ALIAS/ANAME record for root domains.\n\nYour one-record setup should use ${suggestedDomain}: add CNAME "www" to ${cnameTarget}, then connect ${suggestedDomain} in Sitepresso.\n\nUse ${suggestedDomain} now?`,
            { title: 'Use www domain?', confirmLabel: `Use ${suggestedDomain}`, cancelLabel: 'Cancel' }
          );
          setStatus(err.data);
          if (!ok) return;
          setDomain(suggestedDomain);
          return connectDomain(suggestedDomain);
        }
        if (err?.status === 409 && ['CUSTOM_DOMAIN_IN_USE', 'CUSTOM_DOMAIN_TRANSFER_VERIFICATION_REQUIRED'].includes(err?.data?.code)) {
          setStatus(err.data);
          setDomain(err.data.domain || clean);
          setDomainEditing(true);
          return;
        }
        if (err?.status !== 409 || err?.data?.code !== 'CUSTOM_DOMAIN_IN_USE') {
          throw err;
        }
      }
      setStatus(data);
      setDomain(data.domain || clean);
      setDomainEditing(false);
    } catch (err) {
      setError(err?.data?.message || err.message || 'Could not connect domain');
    } finally {
      setBusy(false);
    }
  }

  async function disconnectDomain() {
    const current = status?.domain || cleanDomain;
    if (!current) return;
    const ok = await confirm(
      `Disconnect ${current} from this ${siteLabel}?\n\nYour Sitepresso subdomain will continue to work. You can connect this domain again later if needed.`,
      { title: 'Disconnect custom domain?', confirmLabel: 'Disconnect domain', cancelLabel: 'Cancel' }
    );
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      const data = await api('/api/subscription/custom-domain', { method: 'DELETE' });
      setStatus(data);
      setDomain('');
      setDomainEditing(true);
    } catch (err) {
      setError(err?.data?.message || err.message || 'Could not disconnect domain');
    } finally {
      setBusy(false);
    }
  }

  const instructions = status?.instructions;
  const cleanDomain = normalizeDomainInput(domain);
  const ownershipVerification = status?.ownershipVerification;
  const hasConnectedDomain = Boolean(status?.domain && !ownershipVerification && status.status !== 'NONE');
  const suggestedWww = status?.suggestion?.suggestedDomain || recommendedWwwDomain(cleanDomain);
  const rootDomainTyped = cleanDomain && isLikelyRootDomain(cleanDomain) && !cleanDomain.startsWith('www.');
  const activeTestUrl = status?.domain
    ? `https://${status.domain}`
    : cleanDomain
      ? `https://${cleanDomain}`
      : `https://${suggestedWww || 'www.yourdomain.com'}`;
  const secondsUntilAutoCheck = nextAutoCheck ? Math.max(0, Math.ceil((nextAutoCheck - Date.now()) / 1000)) : null;
  const dnsRows = instructions?.records?.length
    ? instructions.records
    : instructions
      ? (instructions.values?.length ? instructions.values : instructions.value ? [instructions.value] : []).map((value) => ({
        type: instructions.type,
        name: instructions.name,
        value,
        status: status?.verified ? 'Verified' : 'Required',
      }))
      : [];
  const apexDnsRow = dnsRows.find((row) => row.type === 'A' && row.name === '@');
  const wwwDnsRow = dnsRows.find((row) => row.type === 'CNAME' && row.name === 'www');
  const referenceCnameTarget = wwwDnsRow?.value || (instructions?.type === 'CNAME' && instructions?.value) || cnameTarget;

  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Use your own domain</h3>
          <p className="mt-1 text-xs text-gray-600">
            Your free {siteLabel} URL is <strong className="font-mono">{platformSubdomain}</strong>. To use your own domain,
            add the DNS records below at your domain provider. Sitepresso checks DNS and activates HTTPS automatically once the records match.
          </p>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
        <label className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Your custom domain</label>
        <div className="mt-2 flex flex-col gap-2 md:flex-row">
          <input
            type="text"
            value={domain}
            onChange={(e) => setDomain(normalizeDomainInput(e.target.value))}
            onBlur={() => setDomain((value) => normalizeDomainInput(value))}
            placeholder="www.yourdomain.com"
            disabled={!domainEditing || busy}
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none disabled:bg-gray-50 disabled:text-gray-500"
          />
          {domainEditing ? (
            <>
              {status?.domain && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDomain(status.domain || initialDomain || '');
                    setDomainEditing(false);
                  }}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 disabled:opacity-50"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => connectDomain()}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? 'Saving...' : 'Save domain'}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setDomainEditing(true)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 disabled:opacity-50"
            >
              Edit
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => loadStatus()}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 disabled:opacity-50"
          >
            Check DNS
          </button>
          {hasConnectedDomain && (
            <button
              type="button"
              disabled={busy}
              onClick={disconnectDomain}
              className="rounded-lg border border-red-200 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-50"
            >
              Disconnect
            </button>
          )}
        </div>
        {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
        {ownershipVerification && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-950">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="font-semibold">Verify ownership to move this domain</p>
                <p className="mt-1">
                  This domain is already connected to another Sitepresso website. Add this TXT record at your domain provider, then verify and move it here.
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => connectDomain(status.domain || cleanDomain, { forceTransfer: true })}
                className="rounded-md bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              >
                {busy ? 'Verifying...' : 'Verify & move'}
              </button>
            </div>
            <div className="mt-3 overflow-hidden rounded-lg border border-amber-200 bg-white">
              <DnsRecordRow type={ownershipVerification.type} name={ownershipVerification.name} value={ownershipVerification.value} />
            </div>
          </div>
        )}
        {rootDomainTyped && !status?.suggestion && (
          <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
            <p className="font-semibold">Recommended for easiest setup: use {suggestedWww}</p>
            <p className="mt-1">
              Most registrars let you add one CNAME for <strong>www</strong>. Bare root domains need forwarding or advanced DNS records.
            </p>
            <button
              type="button"
              onClick={() => setDomain(suggestedWww)}
              className="mt-2 rounded-md bg-blue-900 px-3 py-1.5 text-xs font-semibold text-white"
            >
              Use {suggestedWww}
            </button>
          </div>
        )}
        {status && (
          <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${statusClasses(status.status)}`}>
            <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
              <strong>{customDomainStatusLabel(status.status)}</strong>
              {status.checkedAt && <span>Last checked {formatAdminDateTime(status.checkedAt)}</span>}
            </div>
            <p className="mt-1">{status.message}</p>
            {(status.status === 'PENDING_SSL' || status.status === 'ACTIVE') && (
              <p className="mt-1">
                Test URL: <a href={activeTestUrl} target="_blank" rel="noreferrer" className="font-semibold underline">{activeTestUrl}</a>
              </p>
            )}
            {secondsUntilAutoCheck !== null && (
              <p className="mt-1 text-gray-600">
                Sitepresso will retry DNS activation in about {secondsUntilAutoCheck || 30} seconds. HTTPS usually activates in 5-30 minutes,
                but certificate authorities can occasionally take up to 2 hours.
              </p>
            )}
          </div>
        )}
        {status?.suggestion?.code === 'APEX_DOMAIN_NEEDS_WWW' && status.suggestion.suggestedDomain && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <p className="font-semibold">Root domain needs an extra setup step</p>
            <p className="mt-1">
              For registrars like GoDaddy, connect <strong className="font-mono">{status.suggestion.suggestedDomain}</strong> with a
              CNAME record instead. The bare root domain can be redirected later after root-domain DNS support is configured.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDomain(status.suggestion.suggestedDomain);
                connectDomain(status.suggestion.suggestedDomain);
              }}
              className="mt-2 rounded-md bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              Use {status.suggestion.suggestedDomain}
            </button>
          </div>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-emerald-200 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">Recommended DNS setup</p>
            <h4 className="mt-1 text-sm font-semibold text-gray-900">Add both root and www records</h4>
            <p className="mt-1 text-xs text-gray-500">
              This opens both <span className="font-mono">yourdomain.com</span> and <span className="font-mono">www.yourdomain.com</span> over HTTPS.
            </p>
          </div>
          <CopyDnsValue value={referenceCnameTarget} label="Copy target" />
        </div>
        <div className="mt-3 overflow-hidden rounded-lg border border-gray-200">
          <div className="grid grid-cols-[110px_1fr] gap-0 border-b border-gray-100 text-sm md:grid-cols-[110px_1fr_1.6fr_auto]">
            <div className="bg-gray-50 px-3 py-2 text-xs font-bold uppercase text-gray-500">Type</div>
            <div className="bg-gray-50 px-3 py-2 text-xs font-bold uppercase text-gray-500">Name</div>
            <div className="hidden bg-gray-50 px-3 py-2 text-xs font-bold uppercase text-gray-500 md:block">Value</div>
            <div className="hidden bg-gray-50 px-3 py-2 text-xs font-bold uppercase text-gray-500 md:block">TTL</div>
            <div className="px-3 py-2 font-mono text-xs font-semibold text-gray-900">A</div>
            <div className="px-3 py-2 font-mono text-xs text-gray-700">@</div>
            <div className="px-3 py-2 font-mono text-xs text-gray-700 md:block">
              <span className="md:hidden">Value: </span>{apexDnsRow?.value || '76.76.21.21'}
            </div>
            <div className="px-3 py-2 text-xs text-gray-500 md:block">Auto or 1 hour</div>
            <div className="border-t border-gray-100 px-3 py-2 font-mono text-xs font-semibold text-gray-900">CNAME</div>
            <div className="border-t border-gray-100 px-3 py-2 font-mono text-xs text-gray-700">www</div>
            <div className="px-3 py-2 font-mono text-xs text-gray-700 md:block">
              <span className="md:hidden">Value: </span>{wwwDnsRow?.value || referenceCnameTarget}
            </div>
            <div className="px-3 py-2 text-xs text-gray-500 md:block">Auto or 1 hour</div>
          </div>
        </div>
        <div className="mt-3 grid gap-2 text-xs text-gray-600 md:grid-cols-2">
          <div className="rounded-lg bg-emerald-50 px-3 py-2">
            <strong className="block text-emerald-900">Enter in Sitepresso</strong>
            <span className="font-mono">{cleanDomain || suggestedWww || 'www.yourdomain.com'}</span>
          </div>
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <strong className="block text-gray-900">Works both ways</strong>
            Add both records so the root domain and www version open securely.
          </div>
        </div>
      </div>

      {dnsRows.length > 0 && (
        <div className="mt-3 rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Required DNS record</p>
              <h4 className="mt-1 text-sm font-semibold text-gray-900">{instructions.type} record for {status?.domain}</h4>
            </div>
            {dnsRows[0]?.value && <CopyDnsValue value={dnsRows[0].value} label="Copy value" />}
          </div>
          <div className="mt-2">
            {dnsRows.map((row) => (
              <DnsRecordRow key={`${row.type}-${row.name}-${row.value}`} {...row} />
            ))}
          </div>
          <p className="mt-2 text-xs text-gray-500">{instructions.proxy}</p>
        </div>
      )}

      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Reference</p>
            <h4 className="mt-1 text-sm font-semibold text-gray-900">Other subdomain, for example shop.yourdomain.com</h4>
          </div>
          <CopyDnsValue value={referenceCnameTarget} label="Copy target" />
        </div>
        <DnsRecordRow type="CNAME" name="shop" value={referenceCnameTarget} />
        <p className="mt-2 text-xs text-gray-500">
          Use this pattern when the business wants a subdomain other than www.
        </p>
      </div>

      <div className="mt-3 rounded-xl border border-gray-200 bg-white p-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Root domain</p>
          <h4 className="mt-1 text-sm font-semibold text-gray-900">Apex domain, for example yourdomain.com</h4>
          <p className="mt-1 text-xs text-gray-500">
            Root domains use A records. Add all listed values at your domain provider.
          </p>
        </div>
        {apexIps.length > 0 ? (
          <div className="mt-2">
            {apexIps.map((ip) => (
              <DnsRecordRow key={ip} type="A" name="@" value={ip} />
            ))}
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            If your domain provider does not support root-domain A or ALIAS records, use
            <strong className="mx-1">www.yourdomain.com</strong>
            with a CNAME first, then forward the root domain to the www address.
          </div>
        )}
      </div>

      <div className="mt-3 grid gap-2 text-xs text-gray-600 md:grid-cols-3">
        <div className="rounded-lg bg-white px-3 py-2">
          <strong className="block text-gray-900">1. Add DNS</strong>
          CNAME for subdomain, or assigned A records for apex.
        </div>
        <div className="rounded-lg bg-white px-3 py-2">
          <strong className="block text-gray-900">2. Check DNS</strong>
          Click Check DNS after records propagate.
        </div>
        <div className="rounded-lg bg-white px-3 py-2">
          <strong className="block text-gray-900">3. Activate HTTPS</strong>
          Sitepresso activates the domain automatically once DNS matches.
        </div>
      </div>
    </div>
  );
}

function DomainStudioSettingsCard({ slug, platformDomain, cnameTarget, apexIps = [], customDomain, siteLabel = 'website', onOpenDomains }) {
  const [status, setStatus] = useState({ loading: true, error: '', data: null });
  const platformSubdomain = `${slug || 'your-site'}.${platformDomain}`;
  const connectedDomain = status.data?.domain || customDomain || '';
  const statusValue = status.data?.status || (connectedDomain ? 'PENDING_DNS' : 'NONE');
  const isActive = statusValue === 'ACTIVE';
  const isPending = ['PENDING_DNS', 'PENDING_SSL'].includes(statusValue);
  const instructions = status.data?.instructions || status.data?.suggestion?.instructions || null;
  const dnsRows = instructions?.records?.length
    ? instructions.records
    : instructions
      ? (instructions.values?.length ? instructions.values : instructions.value ? [instructions.value] : []).map((value) => ({
        type: instructions.type,
        name: instructions.name,
        value,
        status: status.data?.verified ? 'Verified' : 'Required',
      }))
      : [];
  const referenceCnameTarget = dnsRows.find((row) => row.type === 'CNAME')?.value || cnameTarget;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await api('/api/subscription/custom-domain/status');
        if (alive) setStatus({ loading: false, error: '', data });
      } catch (err) {
        if (alive) setStatus({ loading: false, error: err?.data?.message || err.message || 'Could not load domain status', data: null });
      }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">Domain Studio manages custom domains</p>
          <p className="mt-1 text-xs text-gray-600">
            Business details keeps the free {siteLabel} URL stable. Buying, transferring, DNS setup, renewals, and disconnects now live in Domain Studio.
          </p>
          <div className="mt-3 grid gap-2 text-xs text-gray-600 md:grid-cols-2">
            <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
              <span className="block font-semibold text-gray-900">Free Sitepresso URL</span>
              <span className="font-mono">{platformSubdomain}</span>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
              <span className="block font-semibold text-gray-900">Custom domain</span>
              {status.loading ? (
                <span className="text-gray-400">Checking...</span>
              ) : connectedDomain ? (
                <span className="font-mono">{connectedDomain}</span>
              ) : (
                <span className="text-gray-400">Not connected</span>
              )}
            </div>
          </div>
          {status.error && <p className="mt-2 text-xs text-amber-700">{status.error}</p>}
          {!status.loading && connectedDomain && (
            <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${statusClasses(statusValue)}`}>
              <strong>{customDomainStatusLabel(statusValue)}</strong>
              {status.data?.message && <p className="mt-0.5">{status.data.message}</p>}
              {isPending && <p className="mt-0.5">Open Domain Studio for the copy-paste DNS records and live verification.</p>}
              {isActive && <p className="mt-0.5">Traffic is routed through the connected custom domain.</p>}
            </div>
          )}
          <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-sm font-semibold text-gray-900">Connect a domain you already own</p>
            <div className="mt-3 grid gap-2 text-xs text-gray-600 md:grid-cols-3">
              <div className="rounded-lg bg-gray-50 px-3 py-2">
                <strong className="block text-gray-900">1. Open Domain Studio</strong>
                Choose <span className="font-semibold">Connect existing</span> and enter the domain.
              </div>
              <div className="rounded-lg bg-gray-50 px-3 py-2">
                <strong className="block text-gray-900">2. Add DNS</strong>
                Copy the exact CNAME, A, or TXT records into your domain provider.
              </div>
              <div className="rounded-lg bg-gray-50 px-3 py-2">
                <strong className="block text-gray-900">3. Verify</strong>
                Sitepresso checks DNS and activates HTTPS automatically.
              </div>
            </div>
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
              Your free URL <span className="font-mono font-semibold">{platformSubdomain}</span> stays live while DNS updates.
            </div>
          </div>
          {dnsRows.length > 0 && (
            <div className="mt-3 rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Required DNS</p>
                  <h4 className="mt-1 text-sm font-semibold text-gray-900">Records for {connectedDomain}</h4>
                </div>
                {dnsRows[0]?.value && <CopyDnsValue value={dnsRows[0].value} label="Copy value" />}
              </div>
              <div className="mt-2 overflow-hidden rounded-lg border border-gray-200">
                {dnsRows.map((row) => (
                  <DnsRecordRow key={`${row.type}-${row.name}-${row.value}`} {...row} />
                ))}
              </div>
              {instructions?.proxy && <p className="mt-2 text-xs text-gray-500">{instructions.proxy}</p>}
            </div>
          )}
          <div className="mt-3 rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Reference</p>
                <h4 className="mt-1 text-sm font-semibold text-gray-900">Most common setup: www subdomain</h4>
                <p className="mt-1 text-xs text-gray-500">
                  Add a CNAME record at your domain provider, then connect <span className="font-mono">www.yourdomain.com</span> in Domain Studio.
                </p>
              </div>
              <CopyDnsValue value={referenceCnameTarget} label="Copy target" />
            </div>
            <div className="mt-2 overflow-hidden rounded-lg border border-gray-200">
              <DnsRecordRow type="CNAME" name="www" value={referenceCnameTarget} />
              {apexIps.length > 0 && apexIps.map((ip) => (
                <DnsRecordRow key={ip} type="A" name="@" value={ip} />
              ))}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenDomains}
          className="shrink-0 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800"
        >
          Manage domains
        </button>
      </div>
    </div>
  );
}

function SettingsTab({ business, subscription: initialSubscription, refreshTenant, reloadChecklist, onTabChange, initialSubTab }) {
  // Sub-tab covers: details / hours / holidays / integrations
  // / coupons / embed. `initialSubTab` lets old ?tab=coupons / ?tab=embed
  // deep-links land directly on the right sub-tab.
  const router = useRouter();
  const searchParams = useSearchParams();
  // business.category may be a profession key from the SECTORS taxonomy
  // (post-2026-04-30 signups) OR a legacy free-text label. The dropdown
  // pre-selects the sector when we can resolve the profession key;
  // legacy free-text falls through to no selection (admin picks fresh).
  const initialProfession = business.category || '';
  const initialProfRow = getProfession(initialProfession);
  const [form, setForm] = useState({
    name: business.name,
    slug: business.slug,
    category: initialProfession,                                 // profession key OR legacy free-text
    sector: initialProfRow?.sectorKey || '',                     // derived for the cascading dropdown
    description: business.description || '',
    address: business.address || '',
    addressLine2: business.addressLine2 || '',
    city: business.city || '',
    postalCode: business.postalCode || '',
    state: business.state || '',
    country: business.country || DEFAULT_COUNTRY,
    timezone: business.timezone || defaultTimezoneFor(business.country || DEFAULT_COUNTRY),
    phone: business.phone || '',
    email: business.email || '',
    bookingType: business.bookingType || 'POSTPAID',
    reviewRequestEnabled: business.reviewRequestEnabled !== false,
    reviewRequestLink: business.reviewRequestLink || '',
    autoConfirmBookings: !!business.autoConfirmBookings,
    defaultLanguage: business.defaultLanguage || '',
    defaultCurrency: business.defaultCurrency || '',
    vertical: resolveVertical(business.vertical),
  });
  const confirm = useConfirm();
  // Snapshot of the original category at mount — used to detect "the
  // admin actually changed it" so we only show the warning modal on
  // change, not on every save.
  const originalCategoryRef = initialProfession;
  const currentTheme = initialSubscription?.theme || null;
  const [slugStatus, setSlugStatus] = useState(null); // null | 'checking' | { available, reason }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  // CategoryChangeForkModal state — gates access to the CategoryPicker.
  // Until the admin chooses "Change category" in the fork, the picker
  // stays read-only so accidental clicks on the dropdown don't surprise
  // them with a content shift.
  const [categoryEditUnlocked, setCategoryEditUnlocked] = useState(false);
  const [showCategoryFork, setShowCategoryFork] = useState(false);
  const [savedSlug, setSavedSlug] = useState(business.slug || '');
  const [savedSlugLastChangedAt, setSavedSlugLastChangedAt] = useState(business.slugLastChangedAt || null);
  const [slugEditing, setSlugEditing] = useState(false);

  const [subscription, setSubscription] = useState(initialSubscription || null);
  const settingsCapabilities = getSettingsCapabilities({ business, form, subscription });
  const isEcommerce = settingsCapabilities.ecommerce;
  const isAppointment = settingsCapabilities.appointment;
  const siteSurfaceLabel = isEcommerce ? 'storefront' : isAppointment ? 'booking website' : 'website';
  useEffect(() => {
    const nextSlug = business.slug || '';
    setSavedSlug(nextSlug);
    setSavedSlugLastChangedAt(business.slugLastChangedAt || null);
    setSlugEditing(false);
    setSlugStatus(null);
    setForm((f) => (f.slug === nextSlug ? f : { ...f, slug: nextSlug }));
  }, [business.id, business.slug, business.slugLastChangedAt]);

  // Re-sync language + currency from the business prop. For ECOMMERCE these
  // are now edited in Store Setup, so without this the details form could hold
  // a stale value and overwrite a Store Setup change on its next "Save changes".
  useEffect(() => {
    setForm((f) => ({
      ...f,
      defaultLanguage: business.defaultLanguage || '',
      defaultCurrency: business.defaultCurrency || '',
    }));
  }, [business.defaultLanguage, business.defaultCurrency]);

  useEffect(() => {
    let cancelled = false;
    api('/api/subscription')
      .then(({ subscription: fresh }) => { if (!cancelled && fresh) setSubscription(fresh); })
      .catch(() => { /* fall back to the prop */ });
    return () => { cancelled = true; };
  }, [initialSubscription?.plan?.slug]);

  // Slug cooldown — server allows one change every 30 days. Derive the
  // current state from business.slugLastChangedAt (set by the backend the
  // first time the owner changes it after onboarding).
  const slugLastChangedAt = savedSlugLastChangedAt ? new Date(savedSlugLastChangedAt) : null;
  const cooldownMsLeft = slugLastChangedAt ? Math.max(0, SLUG_COOLDOWN_MS - (Date.now() - slugLastChangedAt.getTime())) : 0;
  const slugLocked = cooldownMsLeft > 0;
  const daysLeft = slugLocked ? Math.ceil(cooldownMsLeft / (24 * 60 * 60 * 1000)) : 0;
  const nextChangeDate = slugLocked ? new Date(slugLastChangedAt.getTime() + SLUG_COOLDOWN_MS) : null;
  const slugChanged = form.slug !== savedSlug;

  // Debounced availability check when slug changes (skip when unchanged
  // from the saved value — that's always "available" to the owner).
  useEffect(() => {
    if (!slugChanged) { setSlugStatus(null); return; }
    if (!form.slug || form.slug.length < 2) { setSlugStatus(null); return; }
    setSlugStatus('checking');
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/business/check-slug?slug=${encodeURIComponent(form.slug)}`).then((r) => r.json());
        setSlugStatus(res);
      } catch { setSlugStatus(null); }
    }, 500);
    return () => clearTimeout(handle);
  }, [form.slug, slugChanged]);

  function handleSlugChange(raw) {
    const normalised = raw.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
    setForm((f) => ({ ...f, slug: normalised }));
  }

  async function beginSlugEdit() {
    if (slugLocked) return;
    const currentUrl = `${savedSlug || form.slug || 'your-site'}.${PLATFORM_DOMAIN}`;
    const ok = await confirm(
      `Changing your website URL moves your public site from ${currentUrl} to a new subdomain.\n\nOld shared links, QR codes, search results, and saved customer links may need updating. After saving, this URL can only be changed again after 30 days.\n\nContinue?`,
      { title: 'Change website URL?', confirmLabel: 'Edit URL' }
    );
    if (ok) setSlugEditing(true);
  }

  function cancelSlugEdit() {
    setForm((f) => ({ ...f, slug: savedSlug }));
    setSlugStatus(null);
    setSlugEditing(false);
  }

  // Compulsory fields per product decision (2026-04-20): name, category,
  // email, phone, address. Description stays optional. Save button is
  // gated on all five + a valid, available slug if it's being changed.
  const slugOk = !slugChanged || (slugStatus && slugStatus !== 'checking' && slugStatus.available === true);
  const canSave =
    form.name?.trim() &&
    form.category?.trim() &&
    form.email?.trim() &&
    form.phone?.trim() &&
    form.address?.trim() &&
    form.state?.trim() &&
    form.country?.trim() &&
    form.timezone?.trim() &&
    form.slug?.trim().length >= 2 &&
    slugOk &&
    (!slugChanged || slugEditing) &&
    !(slugLocked && slugChanged);

  async function submit(e) {
    e.preventDefault();
    if (!canSave) return;

    if (slugChanged) {
      const ok = await confirm(
        `Confirm moving your ${siteSurfaceLabel} from ${savedSlug}.${PLATFORM_DOMAIN} to ${form.slug}.${PLATFORM_DOMAIN}?\n\nThis starts the 30-day URL lock. Visitors using old shared links may need the new address.`,
        { title: 'Save new website URL?', confirmLabel: 'Yes, change URL' }
      );
      if (!ok) return;
    }

    // Category-change protection. If the admin picked a different
    // profession from the dropdown, we ALWAYS warn first — changing
    // category is a meaningful business decision (it can change the
    // recommended theme, and may rewrite default copy if they accept).
    // The flow is:
    //   1. Confirm "are you sure?"
    //   2. If yes, ask whether they want the matching theme too —
    //      they can keep their existing content by declining.
    const categoryChanged = form.category !== originalCategoryRef;
    let updateThemeToo = false;
    if (categoryChanged) {
      const ok = await confirm(
        `You're changing your business category. This won't touch any content you've already typed — but the storefront URL slug, default copy, and recommended theme are picked from your category, so we want to make sure.\n\nContinue?`,
        { title: 'Change business category?', confirmLabel: 'Yes, change category' }
      );
      if (!ok) return;

      const recommended = getThemeForCategory(form.category);
      const recommendedName = THEMES[recommended]?.name || recommended;
      // Only ask the second question if the recommended theme is
      // actually different from what they're using today. If it's the
      // same, no prompt — silent.
      if (recommended && recommended !== currentTheme) {
        updateThemeToo = await confirm(
          `Your new category usually pairs with the "${recommendedName}" theme. Switch to it?\n\nIf you've already customised your homepage copy, picking "Keep my current theme" preserves everything you've written. You can always switch from the Subscription tab later.`,
          { title: 'Switch theme to match?', confirmLabel: 'Yes, switch theme', cancelLabel: 'Keep my current theme' }
        );
      }
    }

    setSaving(true); setError(''); setSaved(false);
    try {
      const expectedCurrency = currencyForCountry(form.country);
      const previousCurrency = business.defaultCurrency || currencyForCountry(business.country || form.country);
      const requestedCurrency = form.defaultCurrency || expectedCurrency;
      if (
        business.vertical === 'ECOMMERCE' &&
        requestedCurrency &&
        requestedCurrency !== expectedCurrency &&
        requestedCurrency !== previousCurrency
      ) {
        const ok = await confirm(
          `Your business country is ${form.country}, where the default checkout currency is ${expectedCurrency}. You selected ${requestedCurrency}.\n\nThis currency will apply to new carts, checkout, order totals, inventory valuation, and ecommerce reports. Continue?`,
          { title: 'Use a different checkout currency?', confirmLabel: `Use ${requestedCurrency}` }
        );
        if (!ok) return;
      }

      // The save payload sends `profession` (taxonomy key) so the
      // backend routes through resolvedCategory + can derive vertical.
      // `category` is kept for back-compat but the controller prefers
      // profession when both are present.
      const payload = {
        ...form,
        profession: form.category,
      };
      delete payload.sector; // UI-only field, backend doesn't need it
      const setupResult = await api('/api/business/setup', { method: 'POST', body: JSON.stringify(payload) });
      if (setupResult?.business?.slug) {
        setSavedSlug(setupResult.business.slug);
        setSavedSlugLastChangedAt(setupResult.business.slugLastChangedAt || null);
        setForm((f) => ({ ...f, slug: setupResult.business.slug }));
        setSlugStatus(null);
        setSlugEditing(false);
      }

      // If the admin opted in, swap the subscription theme too.
      if (updateThemeToo) {
        const newTheme = getThemeForCategory(form.category);
        try {
          await api('/api/subscription/theme', { method: 'PUT', body: JSON.stringify({ theme: newTheme }) });
        } catch (e) {
          // Theme-update failure shouldn't roll back the category save —
          // the admin can re-apply the theme manually.
          console.warn('Theme update failed; category was saved:', e.message);
        }
      }

      setSaved(true);
      refreshTenant?.();
      reloadChecklist?.();
    } catch (err) {
      // Backend returns 429 with a human-friendly message if cooldown hit.
      setError(err?.data?.message || err.message);
    } finally { setSaving(false); }
  }

  const openWebsiteSection = useCallback((section = 'themes') => {
    const params = new URLSearchParams(searchParams.toString());
    ['view', 'id', 'parent', 'sub', 'status', 'staff', 'q', 'past', 'customer', 'segment', 'date'].forEach((key) => params.delete(key));
    params.set('tab', 'content');
    if (section && section !== 'editor') params.set('section', section);
    else params.delete('section');
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const SUB_TABS = [
    { key: 'details',      group: 'core',       label: 'Profile & identity',      visible: true, sub: 'Business name, contact details, public URL, and domain handoff' },
    { key: 'support',      group: 'experience', label: 'Support widget',          visible: true, sub: 'Customer chat script shown on the public site' },
    { key: 'hours',        group: 'core',       label: 'Hours & holidays',        visible: settingsCapabilities.hours || settingsCapabilities.holidays, sub: 'Opening hours, availability rhythm, and closed dates' },
    { key: 'multi-store',  group: 'core',       label: 'Multi-store mode',        visible: settingsCapabilities.multiStore, sub: 'Single shop, fulfillment locations, or chain stores' },
    { key: 'marketing',    group: 'growth',     label: 'Marketing automation',    visible: settingsCapabilities.marketing, sub: 'Birthdays, win-back, and lapsed-customer campaigns' },
    { key: 'intakeforms',  group: 'experience', label: 'Intake forms',            visible: settingsCapabilities.intakeForms, sub: 'Pre-visit details for booking themes that need them' },
    { key: 'letterhead2',  group: 'experience', label: 'Document letterhead',     visible: settingsCapabilities.letterhead2, sub: 'Reusable branded layout for generated documents' },
    { key: 'integrations', group: 'experience', label: 'Video meetings',          visible: settingsCapabilities.integrations, sub: 'Google Meet, Zoom, and Microsoft Teams links' },
    { key: 'coupons',      group: 'growth',     label: 'Coupons',                 visible: settingsCapabilities.coupons, sub: 'Discount codes for bookings' },
    { key: 'embed',        group: 'growth',     label: 'Embed button',            visible: settingsCapabilities.embed, sub: 'Book-now button for external pages' },
    { key: 'features',     group: 'experience', label: 'Store features',          visible: settingsCapabilities.features, sub: 'Storefront capabilities controlled by plan and setup' },
    { key: 'danger',       group: 'account',    label: 'Account safety',          visible: true, sub: 'Data export, recovery window, and business deletion' },
  ];
  const visibleSubTabs = SUB_TABS.filter((t) => t.visible !== false);
  const requestedSection = searchParams.get('section');
  const requestedSubTab = initialSubTab || requestedSection;
  const activeSettingsSubTab = visibleSubTabs.some((t) => t.key === requestedSubTab)
    ? requestedSubTab
    : (visibleSubTabs[0]?.key || 'details');
  const activeTabMeta = visibleSubTabs.find((t) => t.key === activeSettingsSubTab) || visibleSubTabs[0] || SUB_TABS[0];
  const groupedSubTabs = SETTINGS_GROUPS
    .map((group) => ({ ...group, tabs: visibleSubTabs.filter((tab) => tab.group === group.key) }))
    .filter((group) => group.tabs.length > 0);
  const activeGroupLabel = SETTINGS_GROUP_LABELS[activeTabMeta?.group] || 'Settings';
  const publicUrl = `${savedSlug || form.slug || 'your-site'}.${PLATFORM_DOMAIN}`;
  const verticalLabel = isEcommerce ? 'Ecommerce' : isAppointment ? 'Appointments' : 'Website';

  useEffect(() => {
    if (requestedSubTab !== 'seo' || searchParams.get('tab') !== 'settings') return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', 'blog');
    params.set('section', 'seo');
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [requestedSubTab, router, searchParams]);

  const setSettingsSubTab = useCallback((nextSubTab) => {
    const safeSubTab = visibleSubTabs.some((t) => t.key === nextSubTab) ? nextSubTab : 'details';
    const params = new URLSearchParams(searchParams.toString());
    if (safeSubTab === 'details') params.delete('section');
    else params.set('section', safeSubTab);
    if (params.get('tab') === 'coupons' || params.get('tab') === 'embed' || params.get('tab') === 'subscription') params.set('tab', 'settings');
    router.replace(params.toString() ? `?${params.toString()}` : '?', { scroll: false });
  }, [router, searchParams, visibleSubTabs]);

  useEffect(() => {
    if (initialSubTab && (searchParams.get('tab') === 'coupons' || searchParams.get('tab') === 'embed' || searchParams.get('tab') === 'subscription')) {
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', 'settings');
      params.set('section', initialSubTab);
      router.replace(`?${params.toString()}`, { scroll: false });
    }
  }, [initialSubTab, router, searchParams]);

  return (
    <div className="w-full space-y-5">
      <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] xl:items-center">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.22em] text-gray-400">Settings center</p>
            <h1 className="mt-2 text-2xl font-black tracking-tight text-gray-950">
              {business?.name || 'Business'} settings
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-600">
              Keep business identity, customer experience, growth tools, and account controls in one governed workspace.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-1">
            {[
              ['Surface', verticalLabel],
              ['Public URL', publicUrl],
              ['Current section', activeTabMeta?.label || 'Settings'],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-wide text-gray-400">{label}</p>
                <p className="mt-1 truncate text-sm font-black text-gray-950">{value}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)] xl:items-start">
        <aside className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm xl:sticky xl:top-32">
          <div className="border-b border-gray-100 px-4 py-4">
            <p className="text-sm font-black text-gray-950">Settings map</p>
            <p className="mt-1 text-xs leading-5 text-gray-500">
              {visibleSubTabs.length} sections available for this business.
            </p>
          </div>
          <nav className="flex gap-3 overflow-x-auto p-3 xl:flex-col xl:gap-5 xl:overflow-visible" aria-label="Settings sections">
            {groupedSubTabs.map((group) => (
              <div key={group.key} className="min-w-[240px] xl:min-w-0">
                <p className="px-2 text-[10px] font-black uppercase tracking-[0.18em] text-gray-400">{group.label}</p>
                <div className="mt-2 flex flex-col gap-1">
                  {group.tabs.map((t) => {
                    const isActive = t.key === activeSettingsSubTab;
                    const isDanger = t.key === 'danger';
                    const activeStyle = isDanger
                      ? { background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b', boxShadow: 'inset 3px 0 0 #dc2626' }
                      : { background: 'var(--theme-primary)', borderColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)' };
                    return (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => setSettingsSubTab(t.key)}
                        aria-current={isActive ? 'page' : undefined}
                        className="flex items-start gap-3 rounded-xl border px-3 py-3 text-left text-sm font-semibold transition-colors"
                        style={isActive
                          ? activeStyle
                          : { color: isDanger ? '#991b1b' : '#374151', background: 'transparent', borderColor: 'transparent' }}
                      >
                        <span
                          className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full"
                          style={{ background: isActive ? (isDanger ? '#dc2626' : 'var(--theme-on-primary)') : (isDanger ? '#fca5a5' : 'rgba(107,114,128,0.35)') }}
                          aria-hidden
                        />
                        <span className="min-w-0">
                          <span className="block">{t.label}</span>
                          <span
                            className="mt-0.5 block text-[11px] font-normal leading-snug"
                            style={{ color: isActive ? (isDanger ? '#7f1d1d' : 'rgba(255,255,255,0.78)') : '#6B7280' }}
                          >
                            {t.sub}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 space-y-5">
          <section className={`rounded-2xl border p-5 shadow-sm ${activeSettingsSubTab === 'danger' ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white'}`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className={`text-[11px] font-black uppercase tracking-[0.2em] ${activeSettingsSubTab === 'danger' ? 'text-red-700' : 'text-gray-400'}`}>
                  {activeGroupLabel}
                </p>
                <h2 className="mt-2 text-xl font-black tracking-tight text-gray-950">{activeTabMeta?.label || 'Settings'}</h2>
                <p className={`mt-2 max-w-3xl text-sm leading-6 ${activeSettingsSubTab === 'danger' ? 'text-red-900' : 'text-gray-600'}`}>
                  {activeTabMeta?.sub}
                </p>
              </div>
              <span className={`rounded-full border px-3 py-1 text-xs font-black ${activeSettingsSubTab === 'danger' ? 'border-red-200 bg-white text-red-700' : 'border-gray-200 bg-gray-50 text-gray-600'}`}>
                {activeSettingsSubTab === 'danger' ? 'Protected action' : verticalLabel}
              </span>
            </div>
          </section>

      {activeSettingsSubTab === 'hours' && <HoursAndHolidaysTab />}

      {activeSettingsSubTab === 'details' && (
      <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 bg-gray-50 px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-black text-gray-950">Business profile</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
              {isEcommerce
                ? 'Shown on your storefront, order emails, and search previews. Billing and invoice details live in Billing & Plan.'
                : isAppointment
                  ? 'Shown on your booking website, confirmation emails, and search previews.'
                  : 'Shown on your website, enquiries, and search previews.'}
            </p>
          </div>
          <span className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-black text-gray-600">
            {publicUrl}
          </span>
        </div>
      </div>
      <form onSubmit={submit} className="space-y-5 p-6">
        <TextInput label="Business name *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Your website URL</label>
          <div className="flex flex-col gap-2 lg:flex-row lg:items-stretch">
            <div className="flex min-w-0 flex-1 items-stretch">
              <input
                type="text"
                value={form.slug}
                onChange={(e) => handleSlugChange(e.target.value)}
                disabled={!slugEditing || slugLocked || saving}
                className="flex-1 min-w-0 px-4 py-2.5 border border-r-0 border-gray-300 rounded-l-lg focus:outline-none text-sm disabled:bg-gray-50 disabled:text-gray-500"
              />
              <span className="px-3 py-2.5 bg-gray-100 border border-gray-300 rounded-r-lg text-sm text-gray-500 whitespace-nowrap flex items-center">
                .{PLATFORM_DOMAIN}
              </span>
            </div>
            {!slugEditing ? (
              <button
                type="button"
                onClick={beginSlugEdit}
                disabled={slugLocked || saving}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {slugLocked ? 'Locked' : 'Edit'}
              </button>
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={cancelSlugEdit}
                  disabled={saving}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!canSave || saving}
                  className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save URL'}
                </button>
              </div>
            )}
          </div>

          <div className="mt-2 min-h-[20px]">
            {!slugChanged && (
              <p className="text-xs text-gray-500">
                Current {siteSurfaceLabel} URL: <strong className="font-mono">{savedSlug || form.slug || 'your-site'}.{PLATFORM_DOMAIN}</strong>
              </p>
            )}
            {slugChanged && slugStatus === 'checking' && (
              <p className="text-xs text-gray-500 flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                Checking availability…
              </p>
            )}
            {slugChanged && slugStatus && slugStatus !== 'checking' && slugStatus.available && (
              <p className="text-xs text-emerald-700 flex items-center gap-1.5">
                <span>✓</span>
                <span>Available — your site will move to <strong className="font-mono">{form.slug}.{PLATFORM_DOMAIN}</strong></span>
              </p>
            )}
            {slugChanged && slugStatus && slugStatus !== 'checking' && !slugStatus.available && (
              <p className="text-xs text-red-600 flex items-center gap-1.5">
                <span>✗</span>
                <span><strong>{form.slug}.{PLATFORM_DOMAIN}</strong> — {slugStatus.reason || 'Already in use'}</span>
              </p>
            )}
          </div>

          {slugEditing && !slugLocked && (
            <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <p className="font-semibold mb-0.5">Changing the URL affects public links</p>
              <p>Save only when you are ready to move this {siteSurfaceLabel}. After saving, the next URL change is locked for 30 days.</p>
            </div>
          )}

          {slugLocked ? (
            <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <p className="font-semibold mb-0.5">URL change locked for {daysLeft} more day{daysLeft === 1 ? '' : 's'}</p>
              <p>You can change your website URL once every 30 days. Next change available on <strong>{nextChangeDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</strong>.</p>
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-gray-500">
              Once onboarded, you can change your URL at most <strong>once every 30 days</strong> — keeps shared links and search results stable.
            </p>
          )}
        </div>

        <DomainStudioSettingsCard
          slug={savedSlug || form.slug}
          platformDomain={PLATFORM_DOMAIN}
          cnameTarget={CUSTOM_DOMAIN_CNAME_TARGET}
          apexIps={CUSTOM_DOMAIN_APEX_IPS}
          customDomain={business.customDomain}
          siteLabel={siteSurfaceLabel}
          onOpenDomains={() => onTabChange?.('domains')}
        />

        {/* Locked category display + Edit button — clicking Edit opens
            CategoryChangeForkModal, which steers the admin toward
            theme/layout changes first and only unlocks the picker if they
            insist on changing the category itself. */}
        {!categoryEditUnlocked ? (
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <label className="block text-sm font-medium text-gray-700">Business category / profession *</label>
                <p className="mt-1 text-sm font-semibold text-gray-900">
                  {getProfession(form.category)?.label || form.category || <span className="text-gray-400">No category set</span>}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  This describes what the business does. Signup uses it to recommend the first theme, but the theme can be changed separately in Subscription.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCategoryFork(true)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:border-indigo-300 hover:text-indigo-700"
              >
                Edit category
              </button>
            </div>
          </div>
        ) : (
          <CategoryPicker
            sector={form.sector}
            category={form.category}
            onChange={(next) => setForm({ ...form, ...next })}
            isLegacyFreeText={!getProfession(form.category) && !!form.category}
          />
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <TextInput label="Business email *" type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} required hint="Customers see this as your contact email." />
          <TextInput label="Phone *" type="tel" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} required />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Country *</label>
            <select
              value={form.country}
              onChange={(e) => {
                const newCountry = e.target.value;
                const zones = timezonesFor(newCountry);
                const stillValid = zones.some((z) => z.tz === form.timezone);
                setForm({
                  ...form,
                  country: newCountry,
                  timezone: stillValid ? form.timezone : defaultTimezoneFor(newCountry),
                });
              }}
              required
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm bg-white"
            >
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
            <p className="text-xs text-gray-500 mt-1">Used to determine your time zone and regional pricing.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Time zone *</label>
            <select
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              disabled={timezonesFor(form.country).length === 1}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm bg-white disabled:bg-gray-50"
            >
              {timezonesFor(form.country).map((z) => <option key={z.tz} value={z.tz}>{z.label}</option>)}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              {timezonesFor(form.country).length === 1
                ? `Auto-selected from your country - used for ${siteSurfaceLabel} timing and availability.`
                : `Pick the time zone your business runs in.`}
            </p>
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Business address <span className="font-normal text-gray-400">— shown on your storefront &amp; customer invoices</span>
            </label>
            <CountryAddressFields
              country={form.country}
              showTax={false}
              value={{ line1: form.address, line2: form.addressLine2, city: form.city, state: form.state, postalCode: form.postalCode }}
              onChange={(next) => setForm((f) => ({
                ...f,
                address: next.line1 || '',
                addressLine2: next.line2 || '',
                city: next.city || '',
                state: next.state || '',
                postalCode: next.postalCode || '',
              }))}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
          <PrimaryButton type="submit" loading={saving} disabled={!canSave}>
            Save business details
          </PrimaryButton>
          <p className="text-xs text-gray-500">
            Saves email, phone, country, time zone, state, and address.
          </p>
        </div>

        {/* Customer review requests. Empty link = feature off. */}
        {(isAppointment || isEcommerce) && (
        <div className="border-t border-gray-200 pt-5 mt-5 space-y-3">
          <div>
            <h4 className="text-sm font-semibold text-gray-900">Customer review requests</h4>
            <p className="text-xs text-gray-500 mt-0.5">
              {isEcommerce
                ? 'Automatically email customers after a delivered or picked-up order, asking them to leave a review. Great for trust and repeat orders.'
                : 'Automatically email customers 24 hours after a completed appointment, asking them to leave a review. Great for word-of-mouth growth.'}
            </p>
          </div>
          <TextInput
            label="Review link (optional)"
            value={form.reviewRequestLink || ''}
            onChange={(v) => setForm({ ...form, reviewRequestLink: v })}
            placeholder="https://g.page/r/your-business/review"
            hint="Paste your Google Business Profile, Yelp, Trustpilot, or any public review URL. Leave blank to turn review emails off."
            maxLength={500}
          />
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.reviewRequestEnabled !== false}
              onChange={(e) => setForm({ ...form, reviewRequestEnabled: e.target.checked })}
              className="w-4 h-4 rounded accent-indigo-600"
            />
            <span className="text-sm text-gray-700">Send review request emails automatically</span>
          </label>
          <p className="text-xs text-gray-400">
            No email goes out unless both a review link is saved <em>and</em> this checkbox is ticked.
          </p>
        </div>
        )}

        {isAppointment && (
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-900">Booking confirmation</h3>
            <p className="text-xs text-gray-500 mt-1">
              By default, every new customer booking starts as <strong>Pending</strong> and waits for you to confirm. Turn this on to skip that step - bookings auto-confirm and the customer gets the confirmation email immediately.
            </p>
            <label className="mt-3 flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!!form.autoConfirmBookings}
                onChange={(e) => setForm({ ...form, autoConfirmBookings: e.target.checked })}
                className="w-4 h-4 rounded accent-indigo-600"
              />
              <span className="text-sm text-gray-700">Auto-confirm new bookings</span>
            </label>
            <p className="text-[11px] text-gray-400 mt-1.5">
              Existing pending bookings aren&apos;t affected - only new ones from this point on.
            </p>
          </div>
        )}

        {/* Booking type moved to Team → Booking rules, where it sits
            alongside the rest of the booking policy knobs. */}

        {/* Default language — used as the fallback when a visitor or new
            staff member hasn't picked a language yet. Doesn't override an
            individual's explicit pick (the navbar picker always wins).
            ECOMMERCE manages this in Store Setup → Store basics, so it's
            hidden here for grocery to avoid two homes for the same control. */}
        {business.vertical !== 'ECOMMERCE' && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-900">Default language</h3>
          <p className="text-xs text-gray-500 mt-1">
            The language new visitors and emails default to. Anyone can override their own view via the picker in the navbar — this just sets the starting point for those who haven&apos;t picked yet.
          </p>
          <select
            value={form.defaultLanguage || ''}
            onChange={(e) => setForm({ ...form, defaultLanguage: e.target.value })}
            className="mt-3 w-full max-w-xs px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">— Auto-detect (browser / location) —</option>
            <option value="en">English</option>
            <option value="hi">हिन्दी (Hindi)</option>
            <option value="es">Español (Spanish)</option>
            <option value="fr">Français (French)</option>
            <option value="de">Deutsch (German)</option>
            <option value="it">Italiano (Italian)</option>
            <option value="pt-BR">Português (Brazilian)</option>
          </select>
          <p className="text-[11px] text-gray-400 mt-1.5">
            Empty = no preference; existing geo + browser detection still applies.
          </p>
        </div>
        )}

        {/* ECOMMERCE (grocery) store config — language, currency, payment
            methods, locations, delivery and holidays — now lives in the
            Store Setup window. Pointer here so admins know where it moved. */}
        {business.vertical === 'ECOMMERCE' && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-900">
            Language, currency, payment methods, locations, delivery times and holidays are now in{' '}
            <button type="button" onClick={() => onTabChange?.('store-setup')} className="font-semibold underline hover:text-emerald-700">Store setup</button>.
          </div>
        )}

        {business.vertical === 'ECOMMERCE' && (
          <EcommerceStorefrontSettings business={business} refreshTenant={refreshTenant} />
        )}

        {/* Right to data portability — GDPR Art. 20 / NZ Privacy Act
            IPP 6. Owners can download a JSON snapshot of everything we
            hold for them at any time. Suitable for backup or porting
            to another platform. */}
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-900">Download my data</h3>
          <p className="text-xs text-gray-500 mt-1">
            Get a JSON snapshot of everything we hold for your business — products, orders, customers, appointments, content, settings. For backup, audit, or porting to another platform. Sensitive credentials (passwords, OAuth tokens) are excluded.
          </p>
          <a
            href="/api/business/data-export"
            download
            className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 text-sm font-semibold text-gray-700 bg-white hover:border-gray-400 hover:bg-gray-50"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            </svg>
            Download JSON
          </a>
        </div>


        {error && <ErrorBanner message={error} />}
        {saved && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">Saved</p>}
        <p className="text-xs text-gray-500">Fields marked <span className="text-red-500">*</span> are required.</p>
        <PrimaryButton type="submit" loading={saving} disabled={!canSave}>Save changes</PrimaryButton>
      </form>
      </section>
      )}

      {activeSettingsSubTab === 'support' && <ChatWidgetSettingsPanel />}
      {activeSettingsSubTab === 'multi-store' && (
        <MultiStoreModePanel business={business} refreshTenant={refreshTenant} onTabChange={onTabChange} />
      )}
      {activeSettingsSubTab === 'integrations' && <VideoIntegrationsCard />}
      {activeSettingsSubTab === 'marketing' && <MarketingAutomationPanel />}
      {activeSettingsSubTab === 'intakeforms' && <IntakeFormBuilder />}
      {activeSettingsSubTab === 'letterhead2' && <Letterhead2SettingsPanel business={business} subscription={subscription} refreshTenant={refreshTenant} />}
      {activeSettingsSubTab === 'coupons' && <CouponsTab />}
      {activeSettingsSubTab === 'embed' && <EmbedTab business={business} />}
      {activeSettingsSubTab === 'features' && <FeaturesTab />}
      {activeSettingsSubTab === 'danger' && <DangerZone business={business} />}
        </div>
      </div>

      {showCategoryFork && (
        <CategoryChangeForkModal
          onCancel={() => setShowCategoryFork(false)}
          onChooseTheme={() => {
            setShowCategoryFork(false);
            openWebsiteSection('styles');
          }}
          onChooseLayout={() => {
            setShowCategoryFork(false);
            openWebsiteSection('layouts');
          }}
          onChooseCategory={() => {
            setShowCategoryFork(false);
            setCategoryEditUnlocked(true);
          }}
        />
      )}
    </div>
  );
}

function chatWidgetStatus(value) {
  const script = String(value || '').trim();
  if (!script) return { label: 'Not set', className: 'bg-gray-100 text-gray-600' };
  if (script.length > CHAT_WIDGET_SCRIPT_MAX) return { label: 'Too long', className: 'bg-amber-50 text-amber-800' };
  if (!/<script[\s>]/i.test(script)) return { label: 'Inline JS', className: 'bg-blue-50 text-blue-700' };
  return { label: 'Ready', className: 'bg-emerald-50 text-emerald-700' };
}

function ChatWidgetSettingsPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [script, setScript] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const status = chatWidgetStatus(script);
  const scriptLength = String(script || '').length;
  const hasScript = String(script || '').trim().length > 0;

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await api('/api/business/seo');
      setScript(data?.settings?.customChatWidgetScript || '');
      setSaved(false);
    } catch (err) {
      setError(err?.data?.message || err.message || 'Could not load chat widget settings');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function save() {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const res = await api('/api/business/seo/settings', {
        method: 'PUT',
        body: JSON.stringify({ customChatWidgetScript: script }),
      });
      setScript(res?.settings?.customChatWidgetScript || '');
      setSaved(true);
    } catch (err) {
      setError(err?.data?.message || err.message || 'Could not save chat widget script');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm"><Spinner /></div>;

  return (
    <section id="chat-widget-script" className="scroll-mt-28 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 bg-gray-50 px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-black text-gray-950">Support chat widget</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-600">
              Paste the provider script from Tawk, Crisp, Intercom, AapkaChat, or another customer support tool.
            </p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-black ${status.className}`}>
            {status.label}
          </span>
        </div>
      </div>

      <div className="grid gap-0 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="p-6">
          <label className="block text-sm font-semibold text-gray-800" htmlFor="support-chat-script">
            Widget script
          </label>
          <textarea
            id="support-chat-script"
            className="mt-2 min-h-72 w-full resize-y rounded-xl border border-gray-300 bg-white px-4 py-3 font-mono text-xs leading-5 text-gray-800 focus:border-indigo-500 focus:outline-none"
            value={script}
            onChange={(e) => {
              setScript(e.target.value);
              setSaved(false);
            }}
            maxLength={CHAT_WIDGET_SCRIPT_MAX}
            placeholder={'<script>\n  // chat widget embed code\n</script>'}
          />

          {error && <div className="mt-4"><ErrorBanner message={error} /></div>}
          {saved && <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">Chat widget script saved</p>}
        </div>

        <aside className="border-t border-gray-100 bg-gray-50 p-6 xl:border-l xl:border-t-0">
          <h3 className="text-sm font-black text-gray-950">Publish status</h3>
          <div className="mt-4 space-y-3">
            {[
              ['Script', hasScript ? 'Configured' : 'Not set'],
              ['Length', `${scriptLength}/${CHAT_WIDGET_SCRIPT_MAX}`],
              ['Placement', 'Public website'],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-gray-200 bg-white px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-wide text-gray-400">{label}</p>
                <p className="mt-1 text-sm font-black text-gray-950">{value}</p>
              </div>
            ))}
          </div>
          <div className="mt-5">
            <PrimaryButton
              type="button"
              onClick={save}
              loading={saving}
              disabled={scriptLength > CHAT_WIDGET_SCRIPT_MAX}
            >
              Save chat script
            </PrimaryButton>
          </div>
          <p className="mt-3 text-xs leading-5 text-gray-500">
            Remove the script and save to turn the embedded support widget off.
          </p>
        </aside>
      </div>
    </section>
  );
}

// ============================================================================
// Archetype switcher panel
// ============================================================================

const ARCHETYPES_ADMIN = [
  {
    key: 'legal',
    label: 'Legal Firm',
    icon: '⚖️',
    vertical: 'APPOINTMENT',
    desc: 'Consultations, case management, attorney profiles, and client intake.',
    features: ['Online consultations', 'Case intake forms', 'Attorney profiles', 'Client portal'],
  },
  {
    key: 'grocery',
    label: 'Grocery Store',
    icon: '🛒',
    vertical: 'ECOMMERCE',
    desc: 'Product catalog, cart, checkout, and delivery management.',
    features: ['Product catalog', 'Cart & checkout', 'Delivery slots', 'Order tracking'],
  },
  {
    key: 'corporate',
    label: 'Corporate',
    icon: '🏢',
    vertical: 'STATIC',
    desc: 'Professional website for companies, agencies, and consultancies.',
    features: ['About & services', 'Team showcase', 'Blog & insights', 'Contact & inquiry'],
  },
];

const ARCHETYPE_THEME_KEYS = new Set(['legal', 'grocery', 'corporate']);

function ArchetypeSwitcherPanel({ subscription }) {
  const currentTheme = subscription?.theme;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Business type</h2>
        <p className="text-sm text-gray-500 mt-1">
          Your business type shapes the admin workflows, storefront, and plan limits for this account. To change it, create a new account or delete this business and start again.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {ARCHETYPES_ADMIN.map((a) => {
          const isCurrent = currentTheme === a.key || (!ARCHETYPE_THEME_KEYS.has(currentTheme) && a.key === 'legal');
          return (
            <div
              key={a.key}
              className={`text-left rounded-xl border-2 p-4 transition-all ${
                isCurrent
                  ? 'border-indigo-500 bg-indigo-50 cursor-default'
                  : 'border-gray-200 bg-gray-50 opacity-70'
              }`}
            >
              <div className="text-3xl mb-2" aria-hidden>{a.icon}</div>
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-sm font-bold text-gray-900">{a.label}</h3>
                {isCurrent && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">Current</span>
                )}
              </div>
              <p className="text-xs text-gray-500 leading-snug mb-3">{a.desc}</p>
              <ul className="space-y-1">
                {a.features.map((f) => (
                  <li key={f} className="flex items-center gap-1.5 text-xs text-gray-600">
                    <span className="w-3.5 h-3.5 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-[9px]">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              {!isCurrent && <p className="mt-3 text-xs font-medium text-gray-500">Separate account required</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Small shared primitives
// ============================================================================
// Subscription-coupon redemption. Drops into SubscriptionTab after the
// current-plan summary. Validates via /validate-coupon then — once the
// caller has picked a plan — applies via /redeem-coupon.
//
// A coupon has no effect on the Free tier (Free doesn't expire), so we
// always require the business admin to pick Starter / Professional /
// Business. If the coupon restricts applicableTiers, only those appear.
export function CouponRedeemCard({ onRedeemed, tiers, currentTierSlug }) {
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState(null); // null | { valid: true, coupon } | { valid: false, message }
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(null);
  const [tierSlug, setTierSlug] = useState('');

  // Paid tiers the user can assign the coupon to. If the coupon lists
  // applicableTiers, we honour that; otherwise any non-free tier works.
  const paidTiers = (tiers || []).filter((t) => t.slug !== 'free');
  const allowedTierSlugs = preview?.valid && preview.coupon?.applicableTiers?.length > 0
    ? preview.coupon.applicableTiers
    : null;
  const pickableTiers = allowedTierSlugs
    ? paidTiers.filter((t) => allowedTierSlugs.includes(t.slug))
    : paidTiers;
  const checkoutDiscount = preview?.valid && ['checkout_discount', 'paddle_checkout'].includes(preview.willApply);

  // Default-select a sensible tier once preview resolves
  useEffect(() => {
    if (!preview?.valid || tierSlug) return;
    if (pickableTiers.length === 0) return;
    // If the current plan is one of the pickable tiers, prefer it; else pick the first.
    const match = pickableTiers.find((t) => t.slug === currentTierSlug) || pickableTiers[0];
    setTierSlug(match.slug);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, pickableTiers.length]);

  async function validate() {
    if (!code.trim()) return;
    setBusy(true); setPreview(null); setTierSlug('');
    try {
      const res = await api('/api/subscription/validate-coupon', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim() }),
      });
      setPreview(res);
    } catch (err) {
      setPreview({ valid: false, message: err.message || 'Failed to validate coupon' });
    } finally {
      setBusy(false);
    }
  }

  async function redeem() {
    if (!tierSlug) {
      setPreview((p) => ({ ...p, _pickTier: true }));
      return;
    }
    setBusy(true);
    try {
      const res = await api('/api/subscription/redeem-coupon', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim(), tierSlug }),
      });
      if (res?.action === 'checkout' && res.checkoutUrl) {
        if (onRedeemed) onRedeemed();
        window.location.href = res.checkoutUrl;
        return;
      }
      setApplied(res);
      setCode('');
      setPreview(null);
      setTierSlug('');
      if (onRedeemed) onRedeemed();
    } catch (err) {
      setPreview({ valid: false, message: err.message || 'Redemption failed' });
    } finally {
      setBusy(false);
    }
  }

  function describe(c) {
    if (!c) return '';
    if (c.benefitType === 'LIFETIME_FREE') return 'Lifetime free subscription';
    if (c.benefitType === 'FREE_PERIOD') {
      const unit = c.benefitUnit === 'MONTHS' ? 'month' : 'day';
      return `${c.benefitValue} ${unit}${c.benefitValue === 1 ? '' : 's'} free`;
    }
    if (c.benefitType === 'PERCENT_OFF') return `${c.benefitValue}% off`;
    if (c.benefitType === 'FIXED_OFF') return `${c.benefitCurrency} ${c.benefitValue} off`;
    return '';
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center flex-shrink-0 text-xl" aria-hidden>🎟️</div>
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-semibold text-gray-900">Have a coupon?</h3>
          <p className="text-xs text-gray-500 mt-0.5">Enter a code to unlock a paid checkout discount or account credit.</p>
        </div>
      </div>

      {applied ? (
        <AppliedSuccessCard
          applied={applied}
          tiers={tiers}
          onDone={() => setApplied(null)}
        />
      ) : (
        <>
          <div className="mt-4 flex flex-col sm:flex-row gap-2">
            <div className="flex-1 relative">
              <input
                type="text"
                value={code}
                onChange={(e) => { setCode(e.target.value.toUpperCase().replace(/\s+/g, '')); setPreview(null); setTierSlug(''); }}
                placeholder="Enter coupon code"
                maxLength={50}
                className="w-full px-3 py-2.5 pr-9 border border-gray-300 rounded-xl text-sm font-mono tracking-wider focus:outline-none focus:border-indigo-500"
              />
              {code && (
                <button
                  type="button"
                  onClick={() => { setCode(''); setPreview(null); setTierSlug(''); }}
                  aria-label="Clear coupon"
                  title="Clear"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 w-6 h-6 rounded-full flex items-center justify-center hover:bg-gray-100"
                >
                  ×
                </button>
              )}
            </div>
            {!preview?.valid && (
              <button
                type="button"
                onClick={validate}
                disabled={busy || !code.trim()}
                className="px-4 py-2.5 bg-gray-900 text-white rounded-xl text-sm font-semibold hover:bg-gray-800 disabled:opacity-50 whitespace-nowrap"
              >
                {busy ? 'Checking…' : 'Check code'}
              </button>
            )}
          </div>

          {preview?.valid && (
            <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 space-y-3">
              <div>
                <p className="font-semibold">✓ Valid coupon — {describe(preview.coupon)}</p>
                {checkoutDiscount && (
                  <p className="text-xs text-amber-800 mt-1">This discount is applied directly to the Paddle checkout for the plan you choose below.</p>
                )}
              </div>

              <div className="pt-2 border-t border-emerald-200">
                  <p className="text-xs font-semibold text-emerald-900 mb-2">Apply this coupon to which plan?</p>
                  {pickableTiers.length === 0 ? (
                    <p className="text-xs text-rose-700">No eligible plans found — check the coupon&rsquo;s plan restrictions.</p>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        {pickableTiers.map((t) => {
                          const isSelected = tierSlug === t.slug;
                          return (
                            <button
                              key={t.slug}
                              type="button"
                              onClick={() => setTierSlug(t.slug)}
                              className={`px-3 py-2 rounded-lg text-xs font-semibold text-left border transition-colors ${
                                isSelected
                                  ? 'bg-emerald-600 text-white border-emerald-600'
                                  : 'bg-white text-gray-800 border-gray-300 hover:border-emerald-400'
                              }`}
                            >
                              <p>{t.name}</p>
                              {t.slug === currentTierSlug && (
                                <p className={`text-[10px] font-normal mt-0.5 ${isSelected ? 'text-emerald-100' : 'text-gray-500'}`}>
                                  Your current plan
                                </p>
                              )}
                            </button>
                          );
                        })}
                      </div>

                      <div className="flex flex-col sm:flex-row gap-2 mt-3">
                        <button
                          type="button"
                          onClick={redeem}
                          disabled={busy || !tierSlug}
                          className="flex-1 px-4 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {busy
                            ? 'Applying…'
                            : tierSlug
                              ? checkoutDiscount
                                ? `Start discounted checkout for ${pickableTiers.find((t) => t.slug === tierSlug)?.name}`
                                : `Apply ${describe(preview.coupon)} to ${pickableTiers.find((t) => t.slug === tierSlug)?.name}`
                              : 'Pick a plan above'}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setCode(''); setPreview(null); setTierSlug(''); }}
                          disabled={busy}
                          className="px-4 py-2.5 bg-white text-gray-700 border border-gray-300 rounded-lg text-sm font-semibold hover:border-gray-500 disabled:opacity-50 whitespace-nowrap"
                        >
                          Not now
                        </button>
                      </div>
                    </>
                  )}
                </div>
            </div>
          )}

          {preview && !preview.valid && (
            <p className="mt-3 text-sm text-rose-700">{preview.message}</p>
          )}
        </>
      )}
    </div>
  );
}

// Subscription-card style confirmation shown after a successful redemption.
function AppliedSuccessCard({ applied, tiers, onDone }) {
  const checkoutDiscount = applied.action === 'paddle_checkout_discount';
  const sub = applied.subscription || {};
  const tierRecord = (tiers || []).find((t) => t.id === sub.tierId);
  const tierName = checkoutDiscount ? 'Paddle checkout' : (tierRecord?.name || 'your plan');
  const endDate = sub.currentPeriodEnd
    ? new Date(sub.currentPeriodEnd).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : null;
  const isLifetime = applied.coupon?.benefitType === 'LIFETIME_FREE';

  return (
    <div className="mt-4 rounded-2xl border-2 border-emerald-500 bg-gradient-to-br from-emerald-50 via-white to-white p-5">
      <div className="flex items-start gap-3 mb-4">
        <span className="text-3xl leading-none" aria-hidden>🎉</span>
        <div className="min-w-0">
          <p className="font-bold text-emerald-900 text-lg">You&rsquo;re all set!</p>
          <p className="text-sm text-emerald-800 mt-0.5">{applied.message}</p>
          {applied.coupon?.code && (
            <p className="text-xs text-emerald-700 mt-1">
              Code <span className="font-mono font-bold">{applied.coupon.code}</span> applied.
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-lg border border-emerald-200 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-emerald-600 font-semibold">Plan</p>
          <p className="text-base font-bold text-gray-900 mt-0.5">{tierName}</p>
        </div>
        <div className="bg-white rounded-lg border border-emerald-200 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-emerald-600 font-semibold">
            {checkoutDiscount ? 'Next step' : isLifetime ? 'Access' : 'Free until'}
          </p>
          <p className="text-base font-bold text-gray-900 mt-0.5">
            {checkoutDiscount ? 'Enter code at checkout' : isLifetime ? 'Forever' : (endDate || '—')}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={onDone}
        className="mt-4 text-xs font-semibold text-emerald-800 hover:underline"
      >
        Redeem another coupon
      </button>
    </div>
  );
}


// ============================================================================
// Category picker — Sector → Profession cascading dropdown
//
// Uses the SECTORS taxonomy (platform/lib/professions.js) — the same
// data signup uses. When the admin changes their pick + saves, the
// confirmation flow in SettingsTab.submit() asks if they want to swap
// to the matching theme too (without forcing them to).
// ============================================================================
function CategoryPicker({ sector, category, onChange, isLegacyFreeText }) {
  const sectorRow = SECTORS.find((s) => s.key === sector) || null;
  const professions = sectorRow?.professions || [];

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">Business category *</label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <select
          value={sector}
          onChange={(e) => {
            // Reset profession when the sector changes — it's no longer
            // valid under the new sector's profession list.
            onChange({ sector: e.target.value, category: '' });
          }}
          required
          className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm bg-white"
        >
          <option value="">Pick a sector…</option>
          {SECTORS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select
          value={category}
          onChange={(e) => onChange({ category: e.target.value })}
          required
          disabled={!sector}
          className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm bg-white disabled:bg-gray-50"
        >
          <option value="">Pick a category…</option>
          {professions.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>
      {isLegacyFreeText && (
        <p className="mt-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          Your previous category (<strong>{category}</strong>) was free text — pick a sector + category from the lists to align with the standard taxonomy and unlock the matching theme.
        </p>
      )}
      <p className="text-xs text-gray-500 mt-1.5">
        Pick the closest match. The category drives the storefront's recommended theme + default copy. None fits? Use <em>Other</em>.
      </p>
    </div>
  );
}

// Payment + fulfillment policy moved to the Store Setup window
// (StoreSetupHub.js → "How do customers pay?" + "How do customers get their
// order?"). The old PaymentFulfillmentSettings panel was removed here so
// there is a single home for it.

// Announcement bar + wishlist settings — ECOMMERCE only.
// Lives in a self-contained component with its own save so it doesn't conflict
// with the main business settings form's validation chain.
function EcommerceStorefrontSettings({ business, refreshTenant }) {
  const [form, setForm] = useState({
    announcementBarEnabled: business.announcementBarEnabled ?? false,
    announcementBarText: business.announcementBarText || '',
    announcementBarBgColor: business.announcementBarBgColor || '#146A39',
    announcementBarTextColor: business.announcementBarTextColor || '#ffffff',
    wishlistEnabled: business.wishlistEnabled !== false,
    wishlistIconType: business.wishlistIconType || 'bookmark',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setForm({
      announcementBarEnabled: business.announcementBarEnabled ?? false,
      announcementBarText: business.announcementBarText || '',
      announcementBarBgColor: business.announcementBarBgColor || '#146A39',
      announcementBarTextColor: business.announcementBarTextColor || '#ffffff',
      wishlistEnabled: business.wishlistEnabled !== false,
      wishlistIconType: business.wishlistIconType || 'bookmark',
    });
  }, [
    business.announcementBarEnabled,
    business.announcementBarText,
    business.announcementBarBgColor,
    business.announcementBarTextColor,
    business.wishlistEnabled,
    business.wishlistIconType,
  ]);

  async function handleSave(e) {
    e?.preventDefault?.();
    setSaving(true); setSaved(false); setError('');
    try {
      await api('/api/business/settings', { method: 'PATCH', body: JSON.stringify(form) });
      await refreshTenant?.();
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-4">
      <h3 className="text-sm font-semibold text-gray-900">Storefront appearance</h3>

      {/* Announcement bar */}
      <div>
        <label className="flex items-center gap-2 cursor-pointer mb-2">
          <input type="checkbox" checked={form.announcementBarEnabled}
            onChange={(e) => setForm({ ...form, announcementBarEnabled: e.target.checked })} />
          <span className="text-sm font-medium text-gray-700">Show announcement bar</span>
        </label>
        {form.announcementBarEnabled && (
          <div className="space-y-2 ml-6">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Bar text</label>
              <input type="text" maxLength={500} value={form.announcementBarText}
                onChange={(e) => setForm({ ...form, announcementBarText: e.target.value })}
                placeholder="e.g. Free delivery on orders over ₹499! 🎉"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div className="flex gap-3 flex-wrap">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Background colour</label>
                <div className="flex items-center gap-2">
                  <input type="color" value={form.announcementBarBgColor}
                    onChange={(e) => setForm({ ...form, announcementBarBgColor: e.target.value })}
                    className="w-10 h-8 rounded border border-gray-300 cursor-pointer" />
                  <input type="text" value={form.announcementBarBgColor} maxLength={7}
                    onChange={(e) => setForm({ ...form, announcementBarBgColor: e.target.value })}
                    className="w-24 rounded-lg border border-gray-300 px-2 py-1.5 text-xs font-mono" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Text colour</label>
                <div className="flex items-center gap-2">
                  <input type="color" value={form.announcementBarTextColor}
                    onChange={(e) => setForm({ ...form, announcementBarTextColor: e.target.value })}
                    className="w-10 h-8 rounded border border-gray-300 cursor-pointer" />
                  <input type="text" value={form.announcementBarTextColor} maxLength={7}
                    onChange={(e) => setForm({ ...form, announcementBarTextColor: e.target.value })}
                    className="w-24 rounded-lg border border-gray-300 px-2 py-1.5 text-xs font-mono" />
                </div>
              </div>
            </div>
            {/* Live preview */}
            <div className="rounded-lg py-2 px-4 text-xs font-medium text-center"
              style={{ background: form.announcementBarBgColor, color: form.announcementBarTextColor }}>
              {form.announcementBarText || 'Preview'}
            </div>
          </div>
        )}
      </div>

      {/* Wishlist */}
      <div className="border-t border-gray-200 pt-3">
        <label className="flex items-center gap-2 cursor-pointer mb-3">
          <input type="checkbox" checked={form.wishlistEnabled}
            onChange={(e) => setForm({ ...form, wishlistEnabled: e.target.checked })} />
          <span className="text-sm font-medium text-gray-700">Enable wishlist</span>
        </label>
        {form.wishlistEnabled && (
          <div className="ml-6">
            <label className="block text-xs font-medium text-gray-600 mb-2">Wishlist icon style</label>
            <div className="flex gap-4">
              {[['bookmark', 'Bookmark'], ['heart', 'Heart']].map(([val, label]) => (
                <label key={val} className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="wishlistIconType" value={val} checked={form.wishlistIconType === val}
                    onChange={() => setForm({ ...form, wishlistIconType: val })} />
                  <span className="text-sm text-gray-700">{label}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-700">{error}</p>}
      {saved && <p className="text-xs text-emerald-700">Saved</p>}
      <PrimaryButton type="button" onClick={handleSave} loading={saving}>Save storefront settings</PrimaryButton>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// DangerZone — GDPR Article 17 account deletion for the business owner.
// 30-day soft-delete grace period, then a cron purges PII (see backend
// lib/accountDeletion.js). Owner types DELETE to confirm.
// ───────────────────────────────────────────────────────────────────────────
function DangerZone({ business }) {
  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [scheduled, setScheduled] = useState(business?.pendingDeletionAt || null);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);

  const purgeAt = scheduled ? new Date(new Date(scheduled).getTime() + 30 * 24 * 60 * 60 * 1000) : null;
  const businessName = business?.name || 'your business';
  const confirmPhrase = String(business?.name || business?.slug || 'DELETE').trim();
  const canConfirmDeletion = confirmText.trim() === confirmPhrase;
  const purgeDateLabel = purgeAt ? formatAdminDate(purgeAt) : 'after the recovery window';

  async function submitDeletion() {
    if (!canConfirmDeletion) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await api('/api/business/request-deletion', {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      setScheduled(new Date().toISOString());
      setConfirmModalOpen(false);
      setConfirmText('');
      // Stash purgeAt so the banner shows the right deadline immediately.
      if (res?.purgeAt) setScheduled(new Date(new Date(res.purgeAt).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString());
    } catch (err) {
      setError(err.message || 'Could not schedule deletion');
    } finally {
      setSubmitting(false);
    }
  }

  async function undoDeletion() {
    setSubmitting(true);
    setError('');
    try {
      await api('/api/business/undo-deletion', { method: 'POST' });
      setScheduled(null);
    } catch (err) {
      setError(err.message || 'Could not undo deletion');
    } finally {
      setSubmitting(false);
    }
  }

  if (scheduled) {
    return (
      <div className="space-y-5">
        <section className="overflow-hidden rounded-2xl border border-red-200 bg-white shadow-sm">
          <div className="border-b border-red-100 bg-red-50 px-6 py-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.2em] text-red-700">Recovery window active</p>
                <h2 className="mt-2 text-2xl font-black tracking-tight text-gray-950">Deletion scheduled</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-red-900">
                  {businessName} is queued for permanent deletion. You can still restore the account before the recovery window ends.
                </p>
              </div>
              <div className="rounded-xl border border-red-200 bg-white px-4 py-3 text-right">
                <p className="text-[11px] font-black uppercase tracking-wide text-red-700">Permanent deletion</p>
                <p className="mt-1 text-sm font-black text-gray-950">{purgeDateLabel}</p>
              </div>
            </div>
          </div>

          <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="p-6">
              <h3 className="text-sm font-black text-gray-950">What is paused now</h3>
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                {[
                  ['Storefront', 'Visitors cannot place new orders or bookings.'],
                  ['Billing', 'Subscription renewal is stopped while deletion is pending.'],
                  ['Data', 'Records are held only so you can restore before the deadline.'],
                ].map(([title, body]) => (
                  <div key={title} className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <p className="text-sm font-black text-gray-950">{title}</p>
                    <p className="mt-1 text-xs leading-5 text-gray-500">{body}</p>
                  </div>
                ))}
              </div>

              <p className="mt-5 text-xs leading-5 text-gray-500">
                For legal-compliance reasons, an audit record is retained. Customer details, content, blog posts, uploaded files, and personal data are removed at purge time.
              </p>
              {error && <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            </div>

            <aside className="border-t border-gray-100 bg-gray-50 p-6 lg:border-l lg:border-t-0">
              <h3 className="text-sm font-black text-gray-950">Restore account</h3>
              <p className="mt-2 text-sm leading-6 text-gray-600">
                Restoring brings the business back before the permanent deletion deadline.
              </p>
              <button
                type="button"
                onClick={undoDeletion}
                disabled={submitting}
                className="mt-5 w-full rounded-xl bg-gray-950 px-4 py-3 text-sm font-black text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Restoring...' : 'Undo deletion'}
              </button>
            </aside>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-2xl border border-red-200 bg-white shadow-sm">
        <div className="border-b border-red-100 bg-gradient-to-r from-red-50 to-white px-6 py-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.22em] text-red-700">Account closure</p>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-gray-950">Delete this business</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-600">
                Schedule deletion for <strong>{businessName}</strong>. The business goes offline quickly, then stays recoverable for 30 days before permanent purge.
              </p>
            </div>
            <span className="rounded-full border border-red-200 bg-white px-3 py-1 text-xs font-black text-red-700">
              High-risk action
            </span>
          </div>
        </div>

        <div className="grid gap-0 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-6 p-6">
            <section>
              <h3 className="text-sm font-black text-gray-950">Before you delete</h3>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <a href="/api/business/data-export" download className="rounded-xl border border-gray-200 bg-gray-50 p-4 transition hover:border-gray-300 hover:bg-white">
                  <p className="text-sm font-black text-gray-950">Download data</p>
                  <p className="mt-1 text-xs leading-5 text-gray-500">Export orders, customers, content, products, and settings before closing.</p>
                </a>
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                  <p className="text-sm font-black text-gray-950">Pause instead</p>
                  <p className="mt-1 text-xs leading-5 text-gray-500">Use Take offline when you only want to stop visitors temporarily.</p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                  <p className="text-sm font-black text-gray-950">Check billing</p>
                  <p className="mt-1 text-xs leading-5 text-gray-500">Review invoices and plan status before scheduling deletion.</p>
                </div>
              </div>
            </section>

            <section>
              <h3 className="text-sm font-black text-gray-950">What will happen</h3>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {[
                  ['Immediately', 'Storefront goes offline and new customer activity stops.'],
                  ['Billing', 'Paid subscription renewal is cancelled when deletion is scheduled.'],
                  ['Recovery period', 'You can undo by signing back in any time during the 30-day window.'],
                  ['After 30 days', 'Personal data, content, files, blog posts, customers, and operational records are purged where legally allowed.'],
                ].map(([title, body]) => (
                  <div key={title} className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-sm font-black text-gray-950">{title}</p>
                    <p className="mt-1 text-xs leading-5 text-gray-500">{body}</p>
                  </div>
                ))}
              </div>
            </section>

            <TextArea
              label="Reason for leaving (optional)"
              value={reason}
              onChange={(v) => setReason(v)}
              rows={3}
              maxLength={500}
              hint="Useful for support review if the account owner is closing because of price, missing features, or a migration."
            />

            {error && <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          </div>

          <aside className="border-t border-red-100 bg-red-50/70 p-6 xl:border-l xl:border-t-0">
            <h3 className="text-sm font-black text-red-950">Final confirmation required</h3>
            <p className="mt-2 text-sm leading-6 text-red-900">
              We will ask you to type the business name before scheduling deletion. This protects against accidental clicks.
            </p>
            <div className="mt-5 rounded-xl border border-red-200 bg-white p-4">
              <p className="text-[11px] font-black uppercase tracking-wide text-red-700">You will type</p>
              <code className="mt-2 block break-all rounded-lg bg-red-50 px-3 py-2 text-sm font-black text-red-900">{confirmPhrase}</code>
            </div>
            <button
              type="button"
              onClick={() => {
                setConfirmText('');
                setConfirmModalOpen(true);
              }}
              className="mt-5 w-full rounded-xl bg-red-600 px-4 py-3 text-sm font-black text-white hover:bg-red-700"
            >
              Continue to confirmation
            </button>
            <p className="mt-3 text-xs leading-5 text-red-800">
              This is not instant permanent deletion. You still have a 30-day recovery window.
            </p>
          </aside>
        </div>
      </section>

      {confirmModalOpen && (
        <Modal onClose={() => setConfirmModalOpen(false)} title="Confirm business deletion">
          <div className="space-y-4">
            <div className="rounded-xl border border-red-200 bg-red-50 p-4">
              <p className="text-sm font-black text-red-950">You are scheduling deletion for {businessName}.</p>
              <p className="mt-1 text-sm leading-6 text-red-900">
                The storefront will go offline, billing renewal will stop, and permanent deletion will happen after the 30-day recovery period.
              </p>
            </div>
            <p className="text-sm text-gray-700">
              Type <strong className="font-mono">{confirmPhrase}</strong> to continue.
            </p>
          </div>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={confirmPhrase}
            className="mt-3 w-full rounded-lg border border-gray-300 px-4 py-2.5 font-mono text-sm focus:outline-none"
            autoFocus
          />
          <ModalActions>
            <button
              type="button"
              onClick={() => { setConfirmModalOpen(false); setConfirmText(''); }}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitDeletion}
              disabled={!canConfirmDeletion || submitting}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: '#dc2626' }}
            >
              {submitting ? 'Scheduling...' : 'Schedule deletion'}
            </button>
          </ModalActions>
        </Modal>
      )}
    </div>
  );
}

const MODE_OPTIONS = [
  {
    key: 'OFF',
    title: 'Single shop',
    sub: 'One storefront, one shared catalog and stock pool. Best for a simple ecommerce seller.',
    pattern: 'Small sellers',
  },
  {
    key: 'FULFILLMENT',
    title: 'Single shop with fulfillment locations',
    sub: 'Shopify style: shoppers see one ecommerce site. Admin manages multiple warehouses or store rooms behind the scenes; products, stock, and orders use the primary active location unless the cart is store-scoped.',
    pattern: 'Shopify style',
  },
  {
    key: 'CHAIN',
    title: 'Chain of physical stores',
    sub: 'Pak\'nSave style: shoppers pick a store before browsing. Each outlet can have its own catalog, pricing, inventory, delivery slots, riders, and team access.',
    pattern: 'Pak\'nSave style',
  },
  {
    key: 'REGIONAL',
    title: 'Regional markets',
    sub: 'Reserved for a future region-first storefront. For multi-city grocery stores today, use Chain of physical stores.',
    pattern: 'Coming soon',
    disabled: true,
  },
  {
    key: 'BOTH',
    title: 'Regional chains',
    sub: 'Reserved for region first, then store inside that region. Use Chain of physical stores for the current Pak\'nSave-style flow.',
    pattern: 'Coming soon',
    disabled: true,
  },
];

function EcommerceLocationReadiness({ mode, deliveryMode, pickupEnabled, onTabChange }) {
  const [state, setState] = useState({ loading: true, error: '', data: null });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setState((s) => ({ ...s, loading: true, error: '' }));
      try {
        const [locations, cities, inventory, slots, riders, pickup] = await Promise.all([
          api('/api/ecom/locations').catch(() => ({})),
          api('/api/ecom/cities').catch(() => ({})),
          api('/api/ecom/inventory/summary').catch(() => ({})),
          api('/api/ecom/slots?pageSize=1').catch(() => ({})),
          api('/api/ecom/riders/summary').catch(() => ({})),
          api('/api/ecom/pickup-locations').catch(() => ({})),
        ]);
        if (cancelled) return;
        const locationRows = locations.locations || [];
        const cityRows = cities.rows || [];
        const zones = cityRows.flatMap((city) => city.zones || []);
        setState({
          loading: false,
          error: '',
          data: {
            activeLocations: locationRows.filter((loc) => loc.isActive !== false).length,
            hasPrimary: locationRows.some((loc) => loc.isPrimary && loc.isActive !== false),
            stockRows: Number(inventory.totalSkus || 0),
            zones: zones.length,
            pinnedZones: zones.filter((zone) => zone.primaryLocationId).length,
            slots: Number(slots.total || 0),
            activeRiders: Number(riders.counts?.ACTIVE || 0),
            pickupLocations: (pickup.locations || []).filter((loc) => loc.isActive).length,
          },
        });
      } catch (err) {
        if (!cancelled) setState({ loading: false, error: err.message || 'Could not load readiness', data: null });
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const m = String(mode || 'OFF').toUpperCase();
  const isPickerMode = m === 'CHAIN' || m === 'BOTH';
  const isScheduledDelivery = String(deliveryMode || 'ASAP').toUpperCase() === 'SCHEDULED';
  const d = state.data || {};
  const checks = [
    {
      label: isPickerMode ? 'Create at least two active stores' : 'Create one active fulfillment location',
      ok: isPickerMode ? d.activeLocations >= 2 : d.activeLocations >= 1,
      tab: 'store-setup',
    },
    { label: 'Mark one location as primary', ok: !!d.hasPrimary, tab: 'store-setup' },
    { label: 'Add stock rows for products at locations', ok: d.stockRows > 0, tab: 'inventory' },
    ...(isPickerMode ? [
      { label: 'Create delivery zones with postcodes', ok: d.zones > 0, tab: 'cities' },
      { label: 'Pin zones to stores for store-specific routing', ok: d.pinnedZones > 0, tab: 'cities' },
      { label: 'Add active riders for store delivery teams', ok: d.activeRiders > 0, tab: 'riders' },
    ] : []),
    // Delivery slots only matter when the store runs scheduled delivery.
    // ASAP / pickup-only stores don't need windows at all.
    ...(isScheduledDelivery ? [
      { label: 'Set your delivery time windows', ok: d.slots > 0, tab: 'store-setup' },
    ] : []),
    ...(pickupEnabled ? [
      { label: 'Add at least one active pickup counter', ok: d.pickupLocations > 0, tab: 'pickup-locations' },
    ] : []),
  ];
  const complete = checks.filter((check) => check.ok).length;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Setup readiness</h3>
          <p className="text-sm text-gray-500 mt-1">
            {state.loading ? 'Checking your store setup...' : `${complete} of ${checks.length} required setup steps are ready.`}
          </p>
        </div>
        {!state.loading && (
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${complete === checks.length ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
            {complete === checks.length ? 'Ready' : 'Needs setup'}
          </span>
        )}
      </div>
      {state.error && <p className="mt-3 text-xs text-red-700">{state.error}</p>}
      {!state.loading && (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-2">
          {checks.map((check) => (
            <button
              key={check.label}
              type="button"
              onClick={() => check.tab && onTabChange?.(check.tab)}
              className={`text-left rounded-xl border px-3 py-2 text-sm transition-colors ${check.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900 hover:border-amber-300'}`}
            >
              <span className="font-semibold">{check.ok ? 'Done' : 'Next'}</span>
              <span className="mx-1 text-gray-400">-</span>
              {check.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MultiStoreModePanel({ business, refreshTenant, onTabChange }) {
  const initial = (business?.multiStoreMode || 'OFF').toUpperCase();
  const [mode, setMode] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedMode, setSavedMode] = useState(initial);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const next = (business?.multiStoreMode || 'OFF').toUpperCase();
    setMode(next);
    setSavedMode(next);
    setSaved(false);
  }, [business?.multiStoreMode]);

  async function save() {
    if (mode === savedMode) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api('/api/business/settings', {
        method: 'PATCH',
        body: JSON.stringify({ multiStoreMode: mode }),
      });
      setSavedMode(mode);
      setSaved(true);
      refreshTenant?.();
    } catch (err) {
      setError(err?.message || 'Could not save');
      setMode(savedMode);
      setSaved(false);
    } finally {
      setSaving(false);
    }
  }

  const dirty = mode !== savedMode;

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-2xl p-5 border border-gray-200">
        <h3 className="text-base font-semibold text-gray-900">Storefront location model</h3>
        <p className="text-sm text-gray-500 mt-1">
          Choose between one storefront with admin-only fulfillment locations, or a grocery chain where shoppers pick their store.
        </p>
      </div>
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm px-3 py-2">{error}</div>
      )}
      <div className="space-y-2">
        {MODE_OPTIONS.map((opt) => {
          const active = mode === opt.key;
          const disabled = saving || (opt.disabled && !active);
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => {
                setMode(opt.key);
                setSaved(false);
                setError(null);
              }}
              disabled={disabled}
              className={`w-full text-left p-4 rounded-xl border transition-colors disabled:opacity-60 ${
                active ? 'border-green-600 bg-green-50' : 'border-gray-200 bg-white hover:border-green-400'
              }`}
            >
              <div className="flex items-start gap-3">
                <span
                  className={`mt-0.5 w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                    active ? 'border-green-600' : 'border-gray-300'
                  }`}
                  aria-hidden="true"
                >
                  {active && <span className="w-2.5 h-2.5 rounded-full bg-green-600" />}
                </span>
                <div className="flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-gray-900">{opt.title}</div>
                    <span className="text-[10px] uppercase tracking-wide text-gray-400">{opt.pattern}</span>
                  </div>
                  <div className="text-sm text-gray-600 mt-1">{opt.sub}</div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <PrimaryButton type="button" onClick={save} loading={saving} disabled={!dirty}>
          Save location model
        </PrimaryButton>
        {dirty && <p className="text-xs text-amber-700">Unsaved change - save before testing storefront behaviour.</p>}
        {saved && !dirty && <p className="text-xs text-emerald-700">Saved. Reload the storefront to test the new behaviour.</p>}
      </div>
      <EcommerceLocationReadiness mode={mode} deliveryMode={business?.deliveryMode} pickupEnabled={!!business?.pickupEnabled} onTabChange={onTabChange} />
    </div>
  );
}

export default SettingsTab;
