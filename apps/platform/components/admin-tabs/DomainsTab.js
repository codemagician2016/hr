'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/adminApi';
import { getTenantStorefrontUrl, getPlatformDomain } from '@/lib/platformDomain';
import {
  ErrorBanner,
  Empty,
  Modal,
  ModalActions,
  PrimaryButton,
  Spinner,
  formatAdminDate,
  formatMoneyMinor,
} from '@/components/admin-ui';

// CNAME target tenants point their domain at. Cloudflare-for-SaaS issues the
// cert + routes to the tenant; keep in sync with SettingsTab + the backend's
// expectedCustomDomainCname() (custom.<platform-domain>).
const CUSTOM_DOMAIN_PROVIDER = (process.env.NEXT_PUBLIC_CUSTOM_DOMAIN_PROVIDER || '').toLowerCase();
const CUSTOM_DOMAIN_CNAME_TARGET =
  process.env.NEXT_PUBLIC_CUSTOM_DOMAIN_CNAME_TARGET ||
  (CUSTOM_DOMAIN_PROVIDER === 'vercel' ? 'cname.vercel-dns-0.com' : `custom.${getPlatformDomain()}`);
// Apex (root) A-record IPs shown in the DNS guide. Cloudflare-for-SaaS routes by
// SNI, so these anycast IPs deliver root traffic to the right site. Keep in sync
// with the backend CUSTOM_DOMAIN_TARGET_IPS / DEFAULT_CUSTOM_DOMAIN_IPS.
const CUSTOM_DOMAIN_APEX_IPS = String(
  process.env.NEXT_PUBLIC_CUSTOM_DOMAIN_APEX_IPS || '172.67.157.143,104.21.40.227'
)
  .split(',')
  .map((ip) => ip.trim())
  .filter(Boolean);
const PROD_BUY_TRANSFER_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.NEXT_PUBLIC_DOMAIN_RESELLER_PROD_BUY_TRANSFER_ENABLED || '').trim().toLowerCase()
);
const PROD_DOMAIN_BUY_TRANSFER_PAUSED_MESSAGE =
  'Domain buying and transfers are temporarily unavailable on production. Connect an existing domain instead.';

function normalizePlatformDomainForPause(value) {
  const host = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/:\d+$/, '');
  if (!host) return '';
  return host.replace(/^(app|admin|www)\./, '');
}

function isProdBuyTransferPaused() {
  const platformDomain = typeof window !== 'undefined'
    ? getPlatformDomain()
    : normalizePlatformDomainForPause(process.env.NEXT_PUBLIC_PLATFORM_DOMAIN);
  return platformDomain === 'sitepresso.com' && !PROD_BUY_TRANSFER_ENABLED;
}

/* ------------------------------------------------------------------ *
 * Domain Studio — premium custom-domain experience.
 * Three entry paths (Register / Transfer / Connect existing), a persistent cart
 * rail, a live setup stepper, and a lifecycle hub. The free Sitepresso
 * subdomain is the permanent safety net surfaced on every screen.
 * ------------------------------------------------------------------ */

const ENTRY_CARDS = [
  {
    key: 'register',
    icon: 'register',
    title: 'Register new',
    blurb: 'Find and buy a brand-new domain through Sitepresso.',
    price: 'From ₹999 / year',
    accent: 'from-indigo-500/10 to-indigo-500/0 border-indigo-200',
    ring: 'ring-indigo-500',
  },
  {
    key: 'transfer',
    icon: 'transfer',
    title: 'Transfer existing',
    blurb: 'Move a domain you own from another registrar to us.',
    price: 'Adds 1 year of registration',
    accent: 'from-emerald-500/10 to-emerald-500/0 border-emerald-200',
    ring: 'ring-emerald-500',
  },
  {
    key: 'byod',
    icon: 'connect',
    title: 'Connect existing',
    blurb: 'Keep your domain at its current provider and point it here.',
    price: 'Free',
    accent: 'from-slate-500/10 to-slate-500/0 border-slate-200',
    ring: 'ring-slate-500',
  },
];

// Light "personality" for the common TLDs — purely cosmetic guidance so the
// customer reads the result grid faster.
const TLD_PERSONALITY = {
  com: { tag: 'Most trusted', tone: 'indigo' },
  in: { tag: 'India', tone: 'orange' },
  store: { tag: 'Retail', tone: 'pink' },
  shop: { tag: 'Retail', tone: 'pink' },
  online: { tag: 'All-purpose', tone: 'slate' },
  site: { tag: 'All-purpose', tone: 'slate' },
  tech: { tag: 'Tech', tone: 'violet' },
  io: { tag: 'Tech', tone: 'violet' },
  co: { tag: 'Startup', tone: 'cyan' },
  me: { tag: 'Personal', tone: 'rose' },
  net: { tag: 'Classic', tone: 'slate' },
  org: { tag: 'Community', tone: 'emerald' },
  nz: { tag: 'New Zealand', tone: 'sky' },
  'co.nz': { tag: 'New Zealand', tone: 'sky' },
  au: { tag: 'Australia', tone: 'amber' },
  'com.au': { tag: 'Australia', tone: 'amber' },
  'co.uk': { tag: 'United Kingdom', tone: 'blue' },
  uk: { tag: 'United Kingdom', tone: 'blue' },
  eu: { tag: 'Europe', tone: 'blue' },
};

const TONE_CLASS = {
  indigo: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  orange: 'border-orange-200 bg-orange-50 text-orange-700',
  pink: 'border-pink-200 bg-pink-50 text-pink-700',
  slate: 'border-slate-200 bg-slate-50 text-slate-600',
  violet: 'border-violet-200 bg-violet-50 text-violet-700',
  cyan: 'border-cyan-200 bg-cyan-50 text-cyan-700',
  rose: 'border-rose-200 bg-rose-50 text-rose-700',
  emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  sky: 'border-sky-200 bg-sky-50 text-sky-700',
  amber: 'border-amber-200 bg-amber-50 text-amber-700',
  blue: 'border-blue-200 bg-blue-50 text-blue-700',
};

function normalizeDomainInput(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split('?')[0]
    .split('#')[0]
    .split(':')[0]
    .replace(/\.$/, '');
}

// Gentle normalizer for the live text input: lowercases + strips protocol and
// whitespace, but KEEPS dots (incl. a trailing one mid-typing) so the user can
// type a full domain naturally. Full normalization runs on submit.
function normalizeDomainTyping(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\s+/g, '');
}

const COMMON_SECOND_LEVEL_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'co.in', 'firm.in', 'net.in', 'org.in', 'gen.in',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'org.nz',
  'com.br', 'com.mx', 'com.sg', 'com.my', 'com.pk',
  'co.za',
]);

function domainLabels(domain) {
  return String(domain || '').split('.').filter(Boolean);
}

function isLikelyApexDomain(domain) {
  const labels = domainLabels(domain);
  if (labels.length === 2) return true;
  if (labels.length === 3 && COMMON_SECOND_LEVEL_PUBLIC_SUFFIXES.has(labels.slice(1).join('.'))) return true;
  return false;
}

function dnsHostForDomain(domain) {
  const labels = domainLabels(domain);
  if (isLikelyApexDomain(domain)) return '@';
  if (labels.length >= 4 && COMMON_SECOND_LEVEL_PUBLIC_SUFFIXES.has(labels.slice(-2).join('.'))) {
    return labels.slice(0, -3).join('.') || '@';
  }
  return labels.slice(0, -2).join('.') || '@';
}

function byodGuideForInput(value) {
  const clean = normalizeDomainInput(value);
  const fallbackApex = 'yourdomain.com';
  if (!clean) {
    return {
      primary: `www.${fallbackApex}`,
      apex: fallbackApex,
      www: `www.${fallbackApex}`,
      recordHost: 'www',
      hasWwwPair: true,
      shouldRecommendWww: false,
    };
  }

  if (clean.startsWith('www.') && isLikelyApexDomain(clean.slice(4))) {
    const apex = clean.slice(4);
    return {
      primary: clean,
      apex,
      www: clean,
      recordHost: 'www',
      hasWwwPair: true,
      shouldRecommendWww: false,
    };
  }

  if (isLikelyApexDomain(clean)) {
    const www = `www.${clean}`;
    return {
      primary: www,
      apex: clean,
      www,
      recordHost: 'www',
      hasWwwPair: true,
      shouldRecommendWww: true,
    };
  }

  return {
    primary: clean,
    apex: '',
    www: '',
    recordHost: dnsHostForDomain(clean),
    hasWwwPair: false,
    shouldRecommendWww: false,
  };
}

// "myshop" -> a few brandable variants the customer can try in one tap.
function variantSuggestions(sld) {
  const base = String(sld || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!base || base.length < 2) return [];
  const out = [`get${base}`, `${base}hq`, `my${base}`, `${base}app`, `try${base}`, `the${base}`];
  return Array.from(new Set(out)).filter((v) => v !== base).slice(0, 5);
}

function statusTone(status) {
  switch (String(status || '').toUpperCase()) {
    case 'ACTIVE':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'EXPIRING':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'EXPIRED':
    case 'FAILED':
      return 'border-red-200 bg-red-50 text-red-700';
    case 'TRANSFER_IN_PENDING':
    case 'TRANSFER_OUT_PENDING':
    case 'PENDING':
    case 'PENDING_DNS':
    case 'PENDING_SSL':
      return 'border-blue-200 bg-blue-50 text-blue-700';
    case 'BYOD':
      return 'border-slate-200 bg-slate-50 text-slate-700';
    case 'LOCKED':
      return 'border-gray-300 bg-gray-100 text-gray-700';
    default:
      return 'border-gray-200 bg-gray-50 text-gray-700';
  }
}

function statusLabel(status) {
  const normalized = String(status || 'NONE').toUpperCase();
  if (normalized === 'BYOD') return 'External';
  if (normalized === 'ACTIVE') return 'Connected';
  return normalized.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function noticeMessage(notice) {
  return typeof notice === 'string' ? notice : notice?.message || '';
}

function noticeClassName(notice) {
  const tone = typeof notice === 'string' ? 'success' : notice?.tone || 'success';
  if (tone === 'info') return 'rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900';
  if (tone === 'warning') return 'rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900';
  return 'rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800';
}

function roleTone(role) {
  switch (String(role || '').toUpperCase()) {
    case 'PRIMARY':
      return 'border-indigo-200 bg-indigo-50 text-indigo-700';
    case 'REDIRECT':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    default:
      return 'border-gray-200 bg-gray-50 text-gray-600';
  }
}

function roleLabel(role) {
  const normalized = String(role || 'PARKED').toUpperCase();
  if (normalized === 'PRIMARY') return 'Primary site';
  if (normalized === 'REDIRECT') return '301 redirect';
  return 'Parked';
}

function tldOf(domainName) {
  const parts = String(domainName || '').toLowerCase().split('.');
  if (parts.length <= 1) return '';
  // handle two-level TLDs like co.nz / com.au / co.uk
  const last2 = parts.slice(-2).join('.');
  if (TLD_PERSONALITY[last2]) return last2;
  return parts[parts.length - 1];
}

function IconSearch({ className = 'h-4 w-4' }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <circle cx="11" cy="11" r="7" />
      <path strokeLinecap="round" d="m20 20-3.5-3.5" />
    </svg>
  );
}

function IconCheck({ className = 'h-4 w-4' }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m5 12 4 4L19 6" />
    </svg>
  );
}

function IconCart({ className = 'h-4 w-4' }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.9}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 7h13l-1.4 7.2a2 2 0 0 1-2 1.6H8.1a2 2 0 0 1-2-1.7L5 4H3" />
      <circle cx="9" cy="20" r="1.4" />
      <circle cx="17" cy="20" r="1.4" />
    </svg>
  );
}

function IconTransfer({ className = 'h-4 w-4' }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.9}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h11m0 0-3-3m3 3-3 3M17 17H6m0 0 3 3m-3-3 3-3" />
      <path strokeLinecap="round" d="M5 5.5A8.5 8.5 0 0 1 19.5 5M19 18.5A8.5 8.5 0 0 1 4.5 19" />
    </svg>
  );
}

function IconLink({ className = 'h-4 w-4' }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.9}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 13a5 5 0 0 0 7.1 0l1.4-1.4a5 5 0 0 0-7.1-7.1L10.6 5.3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 11a5 5 0 0 0-7.1 0l-1.4 1.4a5 5 0 0 0 7.1 7.1l.8-.8" />
    </svg>
  );
}

function IconShield({ className = 'h-4 w-4' }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.9}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3 5.5 5.4v5.2c0 4.2 2.7 8 6.5 9.4 3.8-1.4 6.5-5.2 6.5-9.4V5.4L12 3Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m8.8 12 2.1 2.1 4.4-4.6" />
    </svg>
  );
}

function EntryIcon({ type, className = 'h-5 w-5' }) {
  if (type === 'transfer') return <IconTransfer className={className} />;
  if (type === 'connect') return <IconLink className={className} />;
  return <IconCart className={className} />;
}

/* ----------------------------- atoms ----------------------------- */

function Switch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
    >
      <span className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${checked ? 'bg-emerald-500' : 'bg-gray-300'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </span>
      {label}
    </button>
  );
}

function Metric({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-950">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-gray-400">{hint}</p>}
    </div>
  );
}

function TldChip({ tld }) {
  const personality = TLD_PERSONALITY[tld];
  if (!personality) return null;
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${TONE_CLASS[personality.tone] || TONE_CLASS.slate}`}>
      {personality.tag}
    </span>
  );
}

function SafetyNetBanner({ subdomainUrl, buyTransferPaused = false }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-white px-4 py-3 shadow-sm">
      <span className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
        <IconShield className="h-5 w-5" />
      </span>
      <div className="min-w-0 text-sm text-emerald-900">
        <p className="font-semibold">Your store is already live — a custom domain is a bonus, never a risk.</p>
        <p className="mt-0.5 text-emerald-800">
          It always stays reachable at{' '}
          <a href={subdomainUrl} target="_blank" rel="noreferrer" className="font-mono font-semibold underline decoration-emerald-300 underline-offset-2">
            {subdomainUrl.replace(/^https?:\/\//, '')}
          </a>
          {buyTransferPaused
            ? ' through every DNS change or renewal.'
            : ' through every registration, transfer, or renewal.'}
        </p>
      </div>
    </div>
  );
}

/* ----------------------- discovery (UX-1) ----------------------- */

function EntryCards({ mode, setMode, buyTransferPaused = false }) {
  const cards = buyTransferPaused ? ENTRY_CARDS.filter((card) => card.key === 'byod') : ENTRY_CARDS;
  return (
    <div className={`grid gap-2 ${buyTransferPaused ? 'lg:grid-cols-1' : 'lg:grid-cols-3'}`}>
      {cards.map((card) => {
        const active = mode === card.key;
        return (
          <button
            key={card.key}
            type="button"
            aria-pressed={active}
            onClick={() => setMode(card.key)}
            className={`group flex items-start gap-3 rounded-xl border bg-gradient-to-b p-3 text-left transition-all ${card.accent} ${
              active ? `shadow-sm ring-2 ${card.ring} ring-offset-1` : 'hover:-translate-y-0.5 hover:shadow-sm'
            }`}
          >
            <span className={`mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-lg border bg-white ${
              active ? 'border-gray-900 text-gray-950' : 'border-gray-200 text-gray-500 group-hover:text-gray-800'
            }`}>
              <EntryIcon type={card.icon} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold text-gray-950">{card.title}</h3>
                <span
                  className={`flex h-5 w-5 flex-none items-center justify-center rounded-full border transition-colors ${
                    active ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 bg-white group-hover:border-gray-400'
                  }`}
                >
                  {active && <IconCheck className="h-3.5 w-3.5" />}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-gray-600">{card.blurb}</p>
              <p className="mt-1.5 text-xs font-semibold text-gray-900">{card.price}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function SearchSkeleton() {
  return (
    <div className="divide-y divide-gray-100">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-4">
          <div className="h-4 w-40 animate-pulse rounded bg-gray-200" />
          <div className="ml-auto h-4 w-20 animate-pulse rounded bg-gray-200" />
          <div className="h-8 w-16 animate-pulse rounded bg-gray-200" />
        </div>
      ))}
    </div>
  );
}

function PriceBlock({ item, align = 'right' }) {
  const promo = item.renewalPriceMinor && item.renewalPriceMinor !== item.priceMinor;
  return (
    <div className={align === 'right' ? 'text-right' : ''}>
      <p className="text-sm font-semibold text-gray-950">{formatMoneyMinor(item.priceMinor, item.currency)}<span className="text-xs font-normal text-gray-400"> / yr</span></p>
      <p className={`text-xs ${promo ? 'font-medium text-amber-600' : 'text-gray-500'}`}>
        {promo ? 'Renews at ' : 'Renews '}{formatMoneyMinor(item.renewalPriceMinor || item.priceMinor, item.currency)}/yr
      </p>
    </div>
  );
}

function BestPickHero({ item, inCart, busy, onAdd }) {
  const tld = item.tld || tldOf(item.domainName);
  return (
    <div className="relative overflow-hidden rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-white p-4 shadow-sm">
      <span className="absolute right-0 top-0 rounded-bl-xl bg-indigo-600 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-white">
        Best pick
      </span>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
              <IconCheck className="h-4 w-4" />
            </span>
            <p className="truncate font-mono text-xl font-bold text-gray-950">{item.domainName}</p>
            <TldChip tld={tld} />
          </div>
          <div className="mt-2"><PriceBlock item={item} align="left" /></div>
          {item.notes && <p className="mt-1 text-xs text-gray-500">{item.notes}</p>}
        </div>
        <button
          type="button"
          disabled={busy || inCart}
          onClick={() => onAdd(item)}
          className="shrink-0 rounded-xl bg-indigo-600 px-6 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
        >
          {inCart ? 'In cart ✓' : '+ Add to cart'}
        </button>
      </div>
    </div>
  );
}

function ExactMatchUnavailable({ item }) {
  if (!item || item.available) return null;
  return (
    <div className="rounded-2xl border border-red-100 bg-red-50/70 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-red-500">✕</span>
        <p className="font-mono text-lg font-bold text-red-950">{item.domainName}</p>
        <span className="rounded-full border border-red-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-red-700">Taken</span>
      </div>
      <p className="mt-1 text-sm text-red-800">The exact .com is not available. The alternatives below are ranked for trust, brand protection, and price.</p>
    </div>
  );
}

function ResultRow({ item, inCart, busy, onAdd, onPremium }) {
  const available = item.available;
  const tld = item.tld || tldOf(item.domainName);
  return (
    <div className="grid items-center gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1.7fr)_auto_auto]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className={available ? 'text-emerald-600' : 'text-gray-300'}>{available ? '✓' : '✕'}</span>
          <p className={`truncate font-mono text-sm font-semibold ${available ? 'text-gray-950' : 'text-gray-400 line-through'}`}>{item.domainName}</p>
          <TldChip tld={tld} />
          {item.premium && <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Premium</span>}
          {item.requiresTrustee && <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">🔒 Trustee</span>}
        </div>
        {item.notes && <p className="mt-1 text-xs text-gray-500">{item.notes}</p>}
      </div>
      {available ? <PriceBlock item={item} /> : <span className="text-xs font-medium text-gray-400">Taken</span>}
      <button
        type="button"
        disabled={!available || busy || inCart}
        onClick={() => (item.premium ? onPremium(item) : onAdd(item))}
        className="justify-self-end rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-800 transition hover:border-gray-900 hover:bg-gray-900 hover:text-white disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-300 disabled:hover:bg-gray-50"
      >
        {inCart ? 'Added' : '+ Add'}
      </button>
    </div>
  );
}

/* ------------------------- cart rail (UX-2) ------------------------- */

function multiYearTotalMinor(item, years) {
  const firstYear = item.priceMinor || 0;
  const renewal = item.renewalPriceMinor || item.priceMinor || 0;
  const raw = firstYear + Math.max(0, years - 1) * renewal;
  return years >= 2 ? Math.max(0, raw - Math.round(raw * 0.1)) : raw;
}

function privacyPriceMinor(currency) {
  return String(currency || 'INR').toUpperCase() === 'INR' ? 29900 : 499;
}

function CartRail({ items, years, setYears, privacyEnabled, setPrivacyEnabled, onRemove, onCheckout, busy, bundleSuggestion, onAddBundle }) {
  const currency = items[0]?.currency || 'INR';
  const domainsToday = items.reduce((sum, it) => sum + multiYearTotalMinor(it, years), 0);
  const privacyToday = privacyEnabled ? items.length * privacyPriceMinor(currency) * years : 0;
  const totalToday = domainsToday + privacyToday;
  const renewsAt = items.reduce((sum, it) => sum + (it.renewalPriceMinor || it.priceMinor || 0), 0) + (privacyEnabled ? items.length * privacyPriceMinor(currency) : 0);
  const hasMultiYearDiscount = years >= 2;
  const trusteeItems = items.filter((item) => item.requiresTrustee);

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50/60 p-5 text-center">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-500">
          <IconCart className="h-5 w-5" />
        </span>
        <p className="mt-2 text-sm font-semibold text-gray-700">Your cart is empty</p>
        <p className="mt-1 text-xs text-gray-500">Search a name and add a domain to see your total.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <h3 className="text-sm font-bold text-gray-950">Cart</h3>
        <span className="rounded-full bg-gray-900 px-2 py-0.5 text-[11px] font-bold text-white">{items.length}</span>
      </div>
      <div className="divide-y divide-gray-100">
        {items.map((it) => (
          <div key={it.domainName} className="flex items-start gap-2 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-sm font-semibold text-gray-950">{it.domainName}</p>
              <p className="text-xs text-gray-500">{formatMoneyMinor(multiYearTotalMinor(it, years), it.currency)} · {years} yr{years === 1 ? '' : 's'}</p>
            </div>
            <button
              type="button"
              onClick={() => onRemove(it.domainName)}
              disabled={busy}
              className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
              aria-label={`Remove ${it.domainName}`}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="border-t border-gray-100 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-gray-900">Registration length</p>
            <p className="text-[11px] text-gray-500">{hasMultiYearDiscount ? '10% multi-year saving applied today.' : 'Register longer to reduce renewal chores.'}</p>
          </div>
          <div className="inline-flex overflow-hidden rounded-lg border border-gray-200 bg-white">
            {[1, 2, 3].map((year) => (
              <button
                key={year}
                type="button"
                disabled={busy}
                onClick={() => setYears(year)}
                className={`px-3 py-1.5 text-xs font-semibold ${years === year ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
              >
                {year}y
              </button>
            ))}
          </div>
        </div>
      </div>

      <label className="flex items-start gap-2 border-t border-gray-100 bg-gray-50/60 px-4 py-3 text-xs text-gray-700">
        <input
          type="checkbox"
          checked={privacyEnabled}
          onChange={(e) => setPrivacyEnabled(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-gray-300"
        />
        <span>
          <span className="font-semibold text-gray-900">WHOIS privacy</span> — hides your name, email & phone from spammers.{' '}
          <span className="text-gray-500">{formatMoneyMinor(privacyPriceMinor(currency), currency)}/yr each. Recommended.</span>
        </span>
      </label>

      {trusteeItems.length > 0 && (
        <div className="border-t border-blue-100 bg-blue-50/70 px-4 py-3 text-xs text-blue-900">
          <p className="font-semibold">Eligibility documents may be required</p>
          <p className="mt-0.5">
            {trusteeItems.map((item) => item.domainName).join(', ')} uses a restricted registry. We will collect business/eligibility details before final activation if the registrar asks for them.
          </p>
        </div>
      )}

      {bundleSuggestion && (
        <div className="border-t border-indigo-100 bg-indigo-50/60 px-4 py-3 text-xs text-indigo-900">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Protect the brand spelling</p>
              <p className="mt-0.5">
                Add <span className="font-mono font-semibold">{bundleSuggestion.domainName}</span> for{' '}
                <span className="font-semibold">{formatMoneyMinor(bundleSuggestion.priceMinor, bundleSuggestion.currency)}</span>.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onAddBundle(bundleSuggestion)}
              disabled={busy}
              className="shrink-0 rounded-md bg-indigo-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      )}

      <div className="space-y-1 border-t border-gray-100 px-4 py-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="font-bold text-gray-950">Total today</span>
          <span className="font-bold text-gray-950">{formatMoneyMinor(totalToday, currency)}</span>
        </div>
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>Renews at</span>
          <span>{formatMoneyMinor(renewsAt, currency)}/yr</span>
        </div>
      </div>

      <div className="px-4 pb-4">
        <button
          type="button"
          onClick={onCheckout}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-gray-950 px-4 py-3 text-sm font-bold text-white transition hover:bg-gray-800 disabled:bg-gray-300"
        >
          {busy ? <Spinner small /> : null}
          Continue to checkout
        </button>
        <p className="mt-2 text-center text-[11px] text-gray-400">Secure payment · No charge until you confirm</p>
      </div>
    </div>
  );
}

function PremiumGuardrailModal({ item, busy, onClose, onConfirm }) {
  return (
    <Modal title="This is a premium domain" onClose={onClose} size="md">
      <div className="space-y-4">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-mono text-base font-bold">{item.domainName}</p>
          <p className="mt-2">
            Premium domains are priced higher by the registry. This one is{' '}
            <span className="font-bold">{formatMoneyMinor(item.priceMinor, item.currency)}</span> for the first year
            {item.renewalPriceMinor && item.renewalPriceMinor !== item.priceMinor
              ? <> and renews at <span className="font-bold">{formatMoneyMinor(item.renewalPriceMinor, item.currency)}/yr</span>.</>
              : '.'}
          </p>
        </div>
        <p className="text-sm text-gray-600">Add it to your cart only if you’re sure. A standard TLD (like .in or .store) is usually a fraction of the price.</p>
        <ModalActions>
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700">Pick another</button>
          <PrimaryButton loading={busy} onClick={() => onConfirm(item)}>Add anyway</PrimaryButton>
        </ModalActions>
      </div>
    </Modal>
  );
}

/* --------------------- live setup stepper (UX-2) --------------------- */

const SETUP_STEPS = [
  { key: 'register', label: 'Registering with registrar' },
  { key: 'dns', label: 'Setting up DNS' },
  { key: 'ssl', label: 'Issuing SSL certificate' },
  { key: 'connected', label: 'Connecting to your store' },
];

// Map the real domain + subscription status into stepper state.
function deriveSetupState(domain, subscriptionDomain) {
  const domainStatus = String(domain?.status || '').toUpperCase();
  const cdStatus = String(subscriptionDomain?.customDomainStatus || '').toUpperCase();
  const registered = ['ACTIVE', 'EXPIRING', 'PENDING', 'LOCKED'].includes(domainStatus);
  const matchesPrimary = subscriptionDomain?.customDomain === domain?.name;
  const dnsDone = matchesPrimary && ['PENDING_SSL', 'ACTIVE'].includes(cdStatus);
  const sslDone = matchesPrimary && cdStatus === 'ACTIVE';
  const connected = sslDone;
  return { register: registered ? 'done' : 'active', dns: dnsDone ? 'done' : registered ? 'active' : 'pending', ssl: sslDone ? 'done' : dnsDone ? 'active' : 'pending', connected: connected ? 'done' : 'pending' };
}

function StepIcon({ state }) {
  if (state === 'done') return <span className="text-emerald-600">✓</span>;
  if (state === 'active') return <span className="inline-block animate-spin text-indigo-500">◍</span>;
  return <span className="text-gray-300">○</span>;
}

function SetupStepperModal({ names, subdomainUrl, getDomain, getSubscriptionDomain, onRefresh, onClose }) {
  const primaryName = names[0];
  const [tick, setTick] = useState(0);
  const domain = getDomain(primaryName);
  const subscriptionDomain = getSubscriptionDomain();
  const state = deriveSetupState(domain, subscriptionDomain);
  const allDone = state.connected === 'done';

  useEffect(() => {
    if (allDone) return undefined;
    const id = setInterval(() => {
      onRefresh();
      setTick((t) => t + 1);
    }, 5000);
    return () => clearInterval(id);
  }, [allDone, onRefresh]);

  return (
    <Modal title="" onClose={onClose} size="md">
      <div className="space-y-5 text-center">
        <div>
          <p className="text-4xl">{allDone ? '🎉' : '🚀'}</p>
          <h3 className="mt-2 text-xl font-bold text-gray-950">
            {names.length === 1 ? <span className="font-mono">{names[0]}</span> : `${names.length} domains`} {allDone ? 'is live!' : 'is yours!'}
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            {allDone ? 'Everything is connected and serving your store.' : 'We’re setting things up — this usually takes 5–10 minutes.'}
          </p>
        </div>

        <ul className="mx-auto max-w-sm space-y-2 text-left">
          {SETUP_STEPS.map((step) => (
            <li key={step.key} className="flex items-center gap-3 rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2 text-sm">
              <StepIcon state={state[step.key]} />
              <span className={state[step.key] === 'done' ? 'text-gray-900' : 'text-gray-600'}>{step.label}</span>
              {state[step.key] === 'active' && <span className="ml-auto text-[11px] font-medium text-indigo-500">in progress</span>}
            </li>
          ))}
        </ul>

        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-left text-sm text-emerald-900">
          While we set things up, your store stays live at{' '}
          <a href={subdomainUrl} target="_blank" rel="noreferrer" className="font-mono font-semibold underline">{subdomainUrl.replace(/^https?:\/\//, '')}</a>
          {' '}— share this anytime.
        </div>

        <ModalActions>
          <PrimaryButton onClick={onClose}>{allDone ? 'Done' : 'Continue — we’ll email you'}</PrimaryButton>
        </ModalActions>
      </div>
    </Modal>
  );
}

/* ----------------------- transfer-out modal ----------------------- */

function TransferOutModal({ domain, busy, result, onClose, onConfirm }) {
  const [accepted, setAccepted] = useState(false);
  const [copied, setCopied] = useState(false);
  async function copyCode() {
    if (!result?.authCode) return;
    try {
      await navigator.clipboard?.writeText(result.authCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Modal title={result?.authCode ? 'Your authorization code' : `Transfer ${domain?.name || 'domain'} out`} onClose={onClose} size="lg">
      {result?.authCode ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">Paste this at your new registrar to start the transfer within {result.expiresInDays || 7} days. We also emailed it to your registrant address.</p>
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
            <code className="min-w-0 flex-1 break-all font-mono text-sm font-semibold text-gray-950">{result.authCode}</code>
            <button type="button" onClick={copyCode} className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50">
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <ModalActions>
            <PrimaryButton onClick={onClose}>Done</PrimaryButton>
          </ModalActions>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">Sitepresso will unlock the domain, turn off renewal reminders, and reveal the authorization code. This is your right — there’s no lock-in.</p>
          <label className="flex items-start gap-3 rounded-lg border border-gray-200 p-3 text-sm text-gray-700">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-gray-300" />
            <span>I understand this domain can leave Sitepresso once the transfer completes — my store will fall back to its free subdomain.</span>
          </label>
          <ModalActions>
            <button type="button" onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700">Cancel</button>
            <PrimaryButton disabled={!accepted} loading={busy} onClick={() => onConfirm(domain)}>Get code</PrimaryButton>
          </ModalActions>
        </div>
      )}
    </Modal>
  );
}

/* --------------------- domains hub cards (UX-5) --------------------- */

function TrustBadges({ domain }) {
  const badges = [];
  if (domain.trafficRole === 'REDIRECT') badges.push({ t: '301 to primary', c: 'border-emerald-200 bg-emerald-50 text-emerald-700' });
  if (domain.displayStatus === 'ACTIVE' || domain.status === 'ACTIVE') badges.push({ t: '🔒 SSL auto-issued', c: 'border-emerald-200 bg-emerald-50 text-emerald-700' });
  if (domain.privacyEnabled) badges.push({ t: '🛡 Privacy on', c: 'border-indigo-200 bg-indigo-50 text-indigo-700' });
  if (domain.registrar === 'BYOD') badges.push({ t: `Managed externally`, c: 'border-slate-200 bg-slate-50 text-slate-600' });
  else badges.push({ t: 'Owned by you', c: 'border-gray-200 bg-gray-50 text-gray-600' });
  if (!badges.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {badges.map((b) => (
        <span key={b.t} className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${b.c}`}>{b.t}</span>
      ))}
    </div>
  );
}

function CountdownRing({ days }) {
  if (days == null) return null;
  const max = 60;
  const pct = Math.max(0, Math.min(1, days / max));
  const tone = days <= 7 ? 'text-red-500' : days <= 14 ? 'text-amber-500' : 'text-emerald-500';
  const r = 16;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-12 w-12 shrink-0">
      <svg viewBox="0 0 40 40" className="h-12 w-12 -rotate-90">
        <circle cx="20" cy="20" r={r} fill="none" stroke="currentColor" strokeWidth="4" className="text-gray-100" />
        <circle cx="20" cy="20" r={r} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} className={tone} />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-xs font-bold ${tone}`}>{days}</span>
        <span className="text-[7px] uppercase text-gray-400">days</span>
      </span>
    </div>
  );
}

function RecoveryBanner({ domain }) {
  const status = String(domain.displayStatus || domain.status || '').toUpperCase();
  if (status === 'EXPIRED') {
    return (
      <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
        🔴 Expired — your store fell back to its subdomain. Renew within the grace period to recover it before someone else can.
      </div>
    );
  }
  if (status === 'EXPIRING' && !domain.autoRenew) {
    return (
      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        ⚠️ Renewal reminders are off and this domain expires soon. Renew now to keep it.
      </div>
    );
  }
  return null;
}

function DomainSetupNotification({ domain, onOpenSettings }) {
  const status = String(domain.displayStatus || domain.status || '').toUpperCase();
  const guide = byodGuideForInput(domain.name);
  const isExternal = domain.registrar === 'BYOD';
  const pendingDns = status === 'PENDING_DNS' || status === 'PENDING';
  const pendingSsl = status === 'PENDING_SSL';
  const failed = status === 'FAILED';

  if (!isExternal && !pendingDns && !pendingSsl && !failed) return null;

  if (pendingDns) {
    return (
      <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="font-semibold">Pending DNS — add this record, then wait for DNS to update</p>
            <p className="mt-1">
              At your domain provider, add <span className="font-mono font-semibold">CNAME</span>{' '}
              <span className="font-mono font-semibold">{guide.recordHost}</span> →{' '}
              <span className="font-mono font-semibold">{CUSTOM_DOMAIN_CNAME_TARGET}</span>. DNS usually updates in a few minutes, but some providers take up to 30 minutes.
            </p>
            <p className="mt-1">Sitepresso will keep checking automatically. Your free Sitepresso URL stays live while this is pending.</p>
          </div>
          {domain.primary && (
            <button type="button" onClick={onOpenSettings} className="shrink-0 rounded-md border border-blue-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-50">
              View DNS setup
            </button>
          )}
        </div>
      </div>
    );
  }

  if (pendingSsl) {
    return (
      <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900">
        <p className="font-semibold">DNS found — HTTPS is being activated</p>
        <p className="mt-1">No more DNS changes are needed right now. The secure certificate usually finishes in a few minutes; occasionally it can take up to 30 minutes.</p>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="font-semibold">DNS issue detected</p>
            <p className="mt-1">Check that the record is exactly <span className="font-mono">CNAME {guide.recordHost} → {CUSTOM_DOMAIN_CNAME_TARGET}</span>, remove conflicting records for the same host, then verify again.</p>
          </div>
          {domain.primary && (
            <button type="button" onClick={onOpenSettings} className="shrink-0 rounded-md border border-red-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-red-700 hover:bg-red-50">
              Fix DNS
            </button>
          )}
        </div>
      </div>
    );
  }

  return null;
}

function DomainCard({ domain, busy, onAction, onTransferOut, onOpenSettings, hero, hideTransferOut = false }) {
  const money = domain.retailMinor > 0 ? formatMoneyMinor(domain.renewalRetailMinor || domain.retailMinor, domain.currency) : 'External';
  const role = domain.trafficRole || (domain.primary ? 'PRIMARY' : 'PARKED');
  return (
    <div className={`rounded-2xl border bg-white p-4 ${hero ? 'border-indigo-200 ring-1 ring-indigo-100' : 'border-gray-200'}`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {domain.canRenew && domain.daysUntilExpiry != null && domain.daysUntilExpiry <= 60 && <CountdownRing days={domain.daysUntilExpiry} />}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate font-mono text-base font-bold text-gray-950">{domain.name}</h3>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${roleTone(role)}`}>{roleLabel(role)}</span>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusTone(domain.displayStatus)}`}>{statusLabel(domain.displayStatus)}</span>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              {domain.registrarLabel} · Renewal {money}
              {domain.expiresAt ? ` · Expires ${formatAdminDate(domain.expiresAt)}` : ''}
            </p>
            {role === 'PRIMARY' && <p className="mt-0.5 text-xs text-gray-500">Canonical website address used for sitemap, internal links, and SEO metadata.</p>}
            {role === 'REDIRECT' && domain.trafficTarget && (
              <p className="mt-0.5 text-xs text-emerald-700">
                Permanently redirects to <span className="font-mono">{domain.trafficTarget}</span> and keeps the same path.
              </p>
            )}
            {role === 'PARKED' && <p className="mt-0.5 text-xs text-gray-400">Connected to your account but not serving website traffic yet.</p>}
            {domain.statusMessage && <p className="mt-1 text-xs text-gray-500">{domain.statusMessage}</p>}
            <div className="mt-2"><TrustBadges domain={domain} /></div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!domain.primary && (
            <button type="button" disabled={busy} onClick={() => onAction('primary', domain)} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">Make primary</button>
          )}
          {!domain.primary && domain.trafficTarget && (
            <button type="button" disabled={busy} onClick={() => onAction('redirect', domain)} className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
              {role === 'REDIRECT' ? 'Check redirect' : 'Set redirect'}
            </button>
          )}
          {domain.canRenew && (
            <button type="button" disabled={busy} onClick={() => onAction('renew', domain)} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">Renew</button>
          )}
          {domain.registrar === 'BYOD' && domain.primary && (
            <button type="button" onClick={onOpenSettings} className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50">DNS setup</button>
          )}
          {domain.registrar === 'BYOD' && (
            <button type="button" disabled={busy} onClick={() => onAction('disconnect', domain)} className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">Disconnect</button>
          )}
          {domain.canTransferOut && !hideTransferOut && (
            <button type="button" disabled={busy} onClick={() => onTransferOut(domain)} className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">Transfer out</button>
          )}
        </div>
      </div>

      <RecoveryBanner domain={domain} />
      <DomainSetupNotification domain={domain} onOpenSettings={onOpenSettings} />

      {domain.displayStatus === 'FAILED' && domain.registrar !== 'BYOD' && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          Payment or registrar activation needs attention. Retry checkout or contact support before customers start sharing the new address.
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2 border-t border-gray-100 pt-3">
        <Switch checked={domain.autoRenew} disabled={busy || domain.registrar === 'BYOD'} onChange={(enabled) => onAction('auto-renew', domain, { enabled })} label="Renewal reminders" />
        <Switch checked={domain.privacyEnabled} disabled={busy || !domain.canTogglePrivacy} onChange={(enabled) => onAction('privacy', domain, { enabled })} label="Privacy" />
      </div>
    </div>
  );
}

function HubEmptyState({ subdomainUrl, onStart, buyTransferPaused = false }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-gradient-to-b from-white to-gray-50 p-8 text-center">
      <p className="text-4xl">🌐</p>
      <h3 className="mt-3 text-lg font-bold text-gray-950">Give your store a real address</h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
        {buyTransferPaused
          ? 'Connect a domain you already own. Your store stays live at '
          : 'Register a new domain, transfer one you own, or connect an external one. Your store stays live at '}
        <span className="font-mono text-gray-700">{subdomainUrl.replace(/^https?:\/\//, '')}</span> the whole time.
      </p>
      <button type="button" onClick={onStart} className="mt-4 rounded-xl bg-gray-950 px-5 py-2.5 text-sm font-bold text-white hover:bg-gray-800">
        {buyTransferPaused ? 'Connect a domain →' : 'Find a domain →'}
      </button>
    </div>
  );
}

/* --------------------- transfer-in (UX-3) --------------------- */

const AUTH_CODE_GUIDES = [
  { name: 'GoDaddy', steps: ['Open My Products → Domains and select the domain', 'Domain Settings → “Additional Settings”', 'Click “Get authorization code” — it’s emailed to your registrant address', 'Make sure the domain is unlocked first'] },
  { name: 'Namecheap', steps: ['Domain List → click “Manage”', 'Open the “Sharing & Transfer” tab', 'Turn off the domain lock', 'Copy the EPP / Auth Code shown'] },
  { name: 'Squarespace / Google', steps: ['Open the domain’s registration settings', 'Turn off the transfer lock', 'Click “Get auth code”'] },
  { name: 'Other', steps: ['Look for “Transfer”, “EPP”, or “Auth code” in domain settings', 'Unlock the domain', 'Copy the authorization (EPP) code'] },
];

function AuthCodeHelper() {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(0);
  return (
    <div className="rounded-lg border border-gray-200">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold text-gray-700">
        <span>ℹ️ How do I find my authorization (EPP) code?</span>
        <span className="text-gray-400">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="border-t border-gray-100 p-3">
          <div className="flex flex-wrap gap-1.5">
            {AUTH_CODE_GUIDES.map((g, i) => (
              <button key={g.name} type="button" onClick={() => setPick(i)} className={`rounded-full px-3 py-1 text-xs font-semibold ${pick === i ? 'bg-gray-900 text-white' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>{g.name}</button>
            ))}
          </div>
          <ol className="mt-3 space-y-1.5 text-sm text-gray-600">
            {AUTH_CODE_GUIDES[pick].steps.map((s, i) => (
              <li key={i} className="flex gap-2"><span className="font-semibold text-gray-400">{i + 1}.</span><span>{s}</span></li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function TransferProgress({ domainId }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    let timer;
    async function poll() {
      try {
        const res = await api(`/api/business/domains/${domainId}/transfer-status`);
        if (!alive) return;
        setData(res);
        if (res?.pollingIntervalMs) timer = setTimeout(poll, res.pollingIntervalMs);
      } catch {
        /* stop polling on error */
      }
    }
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [domainId]);

  const steps = data?.steps || [
    { key: 'auth', label: 'Auth code accepted', complete: true },
    { key: 'registrar', label: 'Registrar approval (~24–48h)', complete: false },
    { key: 'binding', label: 'Connect to your store', complete: false },
  ];

  return (
    <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50/50 p-3">
      <p className="text-xs font-semibold text-blue-900">🚚 Transfer in progress — usually 5–7 days. We handle it from here.</p>
      <ol className="mt-2 space-y-1.5">
        {steps.map((s, i) => {
          const active = !s.complete && (i === 0 || steps[i - 1]?.complete);
          return (
            <li key={s.key} className="flex items-center gap-2 text-sm">
              {s.complete ? <span className="text-emerald-600">✓</span> : active ? <span className="animate-spin text-blue-500">◍</span> : <span className="text-gray-300">○</span>}
              <span className={s.complete ? 'text-gray-700' : 'text-gray-500'}>{s.label}</span>
            </li>
          );
        })}
      </ol>
      <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <strong>⚠️ Action needed:</strong> check your registrant email for a “confirm transfer” message and click <strong>Approve</strong>. Transfers stall here more than anywhere else.
      </div>
    </div>
  );
}

/* --------------------- BYOD DNS wizard (UX-4) --------------------- */

function CopyField({ label, value, className = '', valueClassName = '' }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* ignore */ }
  }
  return (
    <div className={className}>
      {label && <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>}
      <div className="mt-0.5 flex min-h-[44px] items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5">
        <code className={`min-w-0 flex-1 break-all font-mono text-xs leading-5 text-gray-900 ${valueClassName}`}>{value}</code>
        <button type="button" onClick={copy} className="shrink-0 rounded border border-gray-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-gray-700 hover:bg-gray-50">{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

function dnsRecordsFromInstructions(inst) {
  if (!inst) return [];
  if (Array.isArray(inst.records) && inst.records.length) return inst.records;
  const values = Array.isArray(inst.values) && inst.values.length
    ? inst.values
    : inst.value
      ? [inst.value]
      : [];
  return values.map((value) => ({ type: inst.type, name: inst.name, value }));
}

const DNS_STEPS = [
  { key: 'records', label: 'Add the DNS records below' },
  { key: 'dns', label: 'We verify your DNS' },
  { key: 'ssl', label: 'HTTPS certificate is issued' },
  { key: 'live', label: 'Domain goes live' },
];

const APEX_IPS_HINT = CUSTOM_DOMAIN_APEX_IPS.join(' and ');
const DNS_PROVIDER_TIPS = [
  { key: 'cloudflare', label: 'Cloudflare', tip: `Add CNAME: Name www, Target ${CUSTOM_DOMAIN_CNAME_TARGET}, Proxy status DNS only. For the root domain, add two A records on Name @ to ${APEX_IPS_HINT} — or instead create a Redirect Rule from the root domain to the www address.` },
  { key: 'godaddy', label: 'GoDaddy', tip: `Add DNS record: Type CNAME, Name www, Value ${CUSTOM_DOMAIN_CNAME_TARGET}. For the root domain, add two A records (Name @) pointing to ${APEX_IPS_HINT}. If you prefer not to add A records, open Forwarding and forward the root domain to the www address as Permanent (301).` },
  { key: 'namecheap', label: 'Namecheap', tip: `In Advanced DNS, add CNAME Record: Host www, Value ${CUSTOM_DOMAIN_CNAME_TARGET}. For the root, add two A Records (Host @) to ${APEX_IPS_HINT}. Or instead add a URL Redirect Record: Host @, Value https://www.yourdomain.com, Type Permanent.` },
  { key: 'squarespace', label: 'Squarespace', tip: `Open Domains > DNS settings, add the CNAME for www exactly. For the root domain, add the two A records (Host @) to ${APEX_IPS_HINT}, or use domain forwarding to the www address.` },
];

function dnsStepState(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'ACTIVE') return { records: 'done', dns: 'done', ssl: 'done', live: 'done' };
  if (s === 'PENDING_SSL') return { records: 'done', dns: 'done', ssl: 'active', live: 'pending' };
  if (s === 'PENDING_DNS') return { records: 'done', dns: 'active', ssl: 'pending', live: 'pending' };
  if (s === 'FAILED') return { records: 'active', dns: 'pending', ssl: 'pending', live: 'pending' };
  return { records: 'active', dns: 'pending', ssl: 'pending', live: 'pending' };
}

function ByodDnsWizard({ domain, onClose, onMakePrimary }) {
  const [state, setState] = useState({ loading: true, error: '', data: null });
  const [verifying, setVerifying] = useState(false);
  const [providerTip, setProviderTip] = useState(DNS_PROVIDER_TIPS[0].key);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: '' }));
    try {
      const data = await api('/api/subscription/custom-domain/status');
      setState({ loading: false, error: '', data });
    } catch (err) {
      setState({ loading: false, error: err?.data?.message || err.message || 'Could not load DNS status', data: null });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const data = state.data;
  const boundHere = data?.domain && domain?.name && String(data.domain).toLowerCase() === String(domain.name).toLowerCase();
  // The status endpoint returns instructions either as a records[] array OR as a
  // single { type, name, value, values } object — normalize both (mirrors SettingsTab).
  const inst = boundHere ? data?.instructions : null;
  const records = dnsRecordsFromInstructions(inst);
  const steps = dnsStepState(boundHere ? data?.status : null);
  const pickedProvider = DNS_PROVIDER_TIPS.find((item) => item.key === providerTip) || DNS_PROVIDER_TIPS[0];

  async function verifyNow() {
    setVerifying(true);
    try { await api('/api/subscription/custom-domain/verify', { method: 'POST', body: '{}' }); await load(); } catch { /* ignore */ } finally { setVerifying(false); }
  }

  return (
    <Modal title={`Connect ${domain?.name || 'your domain'}`} onClose={onClose} size="lg">
      {state.loading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : state.error ? (
        <ErrorBanner message={state.error} />
      ) : !boundHere ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">To get the exact DNS records for <span className="font-mono font-semibold">{domain?.name}</span>, make it your primary connected domain first.</p>
          <ModalActions>
            <button type="button" onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700">Close</button>
            <PrimaryButton onClick={() => onMakePrimary(domain)}>Make primary & get records</PrimaryButton>
          </ModalActions>
        </div>
      ) : (
        <div className="space-y-4">
          {/* stepper */}
          <ol className="space-y-1.5">
            {DNS_STEPS.map((s) => (
              <li key={s.key} className="flex items-center gap-2 text-sm">
                <StepIcon state={steps[s.key]} />
                <span className={steps[s.key] === 'done' ? 'text-gray-700' : 'text-gray-600'}>{s.label}</span>
                {steps[s.key] === 'active' && <span className="ml-auto text-[11px] font-medium text-indigo-500">in progress</span>}
              </li>
            ))}
          </ol>

          {/* records */}
          <div className="rounded-xl border border-gray-200 p-3">
            <p className="text-sm font-semibold text-gray-900">Add {records.length === 1 ? 'this record' : 'these records'} at your DNS provider</p>
            <p className="mt-0.5 text-xs text-gray-500">Wherever your domain is managed (GoDaddy, Namecheap, Cloudflare…). DNS can take up to 30 minutes to propagate.</p>
            <div className="mt-3 space-y-3">
              {records.map((r, i) => (
                <div key={i} className="grid gap-2 rounded-lg bg-gray-50/70 p-2.5 sm:grid-cols-3">
                  <CopyField label="Type" value={r.type} />
                  <CopyField label="Name / Host" value={r.name} />
                  <CopyField label="Value / Points to" value={r.value} />
                </div>
              ))}
              {records.length === 0 && <p className="text-xs text-gray-500">No records required — your domain is set up.</p>}
            </div>
            {data?.instructions?.notes && <p className="mt-2 text-xs text-gray-500">{data.instructions.notes}</p>}
          </div>

          <div className="rounded-xl border border-gray-200 p-3">
            <p className="text-sm font-semibold text-gray-900">Provider tips</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {DNS_PROVIDER_TIPS.map((provider) => (
                <button
                  key={provider.key}
                  type="button"
                  onClick={() => setProviderTip(provider.key)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${providerTip === provider.key ? 'bg-gray-900 text-white' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                >
                  {provider.label}
                </button>
              ))}
            </div>
            <p className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">{pickedProvider.tip}</p>
          </div>

          {/* live status / diagnosis */}
          <div className={`rounded-lg border px-3 py-2 text-sm ${data?.status === 'ACTIVE' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : data?.status === 'FAILED' ? 'border-red-200 bg-red-50 text-red-800' : 'border-blue-200 bg-blue-50 text-blue-800'}`}>
            <p className="font-semibold">{data?.status === 'ACTIVE' ? '✓ Connected' : data?.status === 'PENDING_SSL' ? '⏳ Issuing SSL…' : data?.status === 'FAILED' ? 'DNS not detected yet' : '⏳ Waiting for DNS…'}</p>
            {data?.statusMessage && <p className="mt-0.5 text-xs opacity-90">{data.statusMessage}</p>}
          </div>

          {data?.status !== 'ACTIVE' && (
            <div className="grid gap-2 rounded-xl border border-gray-200 bg-white p-3 text-xs md:grid-cols-2">
              <div>
                <p className="font-semibold text-gray-900">Needed</p>
                <p className="mt-1 text-gray-500">
                  DNS must return the exact record value shown above, then SSL can issue automatically.
                </p>
              </div>
              <div>
                <p className="font-semibold text-gray-900">Current check</p>
                <p className="mt-1 text-gray-500">
                  {data?.statusMessage || 'No matching DNS record has been confirmed yet. DNS can take up to 30 minutes to propagate.'}
                </p>
              </div>
            </div>
          )}

          <ModalActions>
            <button type="button" onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700">Close</button>
            <PrimaryButton loading={verifying} onClick={verifyNow}>Verify now</PrimaryButton>
          </ModalActions>
        </div>
      )}
    </Modal>
  );
}

function RedirectSetupModal({ setup, onClose }) {
  const domain = setup?.domain;
  const binding = setup?.binding || {};
  const records = dnsRecordsFromInstructions(binding.instructions);
  const target = binding.redirectTo || domain?.trafficTarget;

  return (
    <Modal title={`Redirect ${domain?.name || 'domain'}`} onClose={onClose} size="lg">
      <div className="space-y-4">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <p className="font-semibold">{domain?.name || 'This domain'} will permanently redirect to <span className="font-mono">{target || 'your primary domain'}</span>.</p>
          <p className="mt-0.5 text-xs text-emerald-800">Paths and query strings are preserved, so old links and ads land on the same page at the primary domain.</p>
        </div>

        {records.length > 0 && (
          <div className="rounded-xl border border-gray-200 p-3">
            <p className="text-sm font-semibold text-gray-900">DNS records for this redirect domain</p>
            <p className="mt-0.5 text-xs text-gray-500">Add these wherever the domain is managed. Once DNS reaches Sitepresso, the redirect is handled automatically.</p>
            <div className="mt-3 space-y-3">
              {records.map((r, i) => (
                <div key={i} className="grid gap-2 rounded-lg bg-gray-50/70 p-2.5 sm:grid-cols-3">
                  <CopyField label="Type" value={r.type} />
                  <CopyField label="Name / Host" value={r.name} />
                  <CopyField label="Value / Points to" value={r.value} />
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={`rounded-lg border px-3 py-2 text-sm ${binding.status === 'ACTIVE' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : binding.status === 'FAILED' ? 'border-red-200 bg-red-50 text-red-800' : 'border-blue-200 bg-blue-50 text-blue-800'}`}>
          <p className="font-semibold">{binding.status === 'ACTIVE' ? 'Redirect is ready' : binding.status === 'PENDING_SSL' ? 'DNS found, SSL is issuing' : 'Waiting for DNS'}</p>
          {binding.message && <p className="mt-0.5 text-xs opacity-90">{binding.message}</p>}
        </div>

        <ModalActions>
          <PrimaryButton onClick={onClose}>Done</PrimaryButton>
        </ModalActions>
      </div>
    </Modal>
  );
}

function DnsSetupGuide({ domainInput, onUseWww }) {
  const guide = byodGuideForInput(domainInput);
  const rootForwardTo = guide.hasWwwPair ? `https://${guide.www}` : '';
  const exampleApex = guide.hasWwwPair ? guide.apex : 'yourdomain.com';
  const exampleWww = guide.hasWwwPair ? guide.www : `www.${exampleApex}`;
  const exampleSubdomain = `shop.${exampleApex}`;

  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50/70 p-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-sm font-semibold text-gray-900">DNS setup guide</p>
          <p className="mt-0.5 text-xs text-gray-500">
            Use this if your domain stays at GoDaddy, Namecheap, Cloudflare, Squarespace, or another DNS provider.
          </p>
        </div>
        <span className="inline-flex w-fit rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
          HTTPS is automatic
        </span>
      </div>

      {guide.shouldRecommendWww && (
        <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p>
              Use <span className="font-mono font-semibold">{guide.www}</span> in Sitepresso. It is the easiest setup because every registrar supports a <span className="font-mono">www</span> CNAME record.
            </p>
            <button
              type="button"
              onClick={() => onUseWww(guide.www)}
              className="shrink-0 rounded-md border border-blue-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50"
            >
              Use {guide.www}
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 space-y-3">
        <div className="flex gap-3">
          <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-gray-900 text-xs font-bold text-white">1</span>
          <p className="text-sm text-gray-700">
            Open your domain provider and go to <strong>DNS settings</strong> for <span className="font-mono">{guide.apex || guide.primary}</span>.
          </p>
        </div>

        <div className="flex gap-3">
          <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-gray-900 text-xs font-bold text-white">2</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-gray-700">
              Add this record so <span className="font-mono">{guide.primary}</span> opens your Sitepresso site:
            </p>
            <div className="mt-2 grid gap-3 rounded-xl border border-gray-200 bg-white p-3 sm:grid-cols-2 xl:grid-cols-[120px_180px_minmax(320px,1fr)_110px]">
              <CopyField label="Type" value="CNAME" />
              <CopyField label="Name / Host" value={guide.recordHost} />
              <CopyField label="Value / Points to" value={CUSTOM_DOMAIN_CNAME_TARGET} className="sm:col-span-2 xl:col-span-1" valueClassName="text-[13px] font-semibold" />
              <CopyField label="TTL" value="Auto" />
            </div>
            <p className="mt-1 text-[11px] text-gray-400">
              Do not add <span className="font-mono">https://</span> in the value. If your DNS provider has a proxy toggle, keep this record DNS-only until Sitepresso says it is connected.
            </p>
          </div>
        </div>

        {guide.hasWwwPair ? (
          <div className="flex gap-3">
            <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-gray-900 text-xs font-bold text-white">3</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-gray-700">
                Make the root domain (<span className="font-mono">{guide.apex}</span>) work too. Use whichever your provider supports:
              </p>
              {CUSTOM_DOMAIN_APEX_IPS.length > 0 && (
                <div className="mt-2 rounded-xl border border-gray-200 bg-white p-3">
                  <p className="text-xs font-semibold text-gray-900">Option A — add A records (works at most registrars)</p>
                  <p className="mt-0.5 text-[11px] text-gray-500">Add one A record per IP below, both with Name <span className="font-mono">@</span>. Keep them DNS-only (no proxy).</p>
                  <div className="mt-2 space-y-2">
                    {CUSTOM_DOMAIN_APEX_IPS.map((ip) => (
                      <div key={ip} className="grid gap-2 rounded-lg bg-gray-50/70 p-2 sm:grid-cols-3">
                        <CopyField label="Type" value="A" />
                        <CopyField label="Name / Host" value="@" />
                        <CopyField label="Value / Points to" value={ip} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className="mt-3 text-xs font-semibold text-gray-900">Option B — or forward the root to www</p>
              <div className="mt-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                This is usually not in the DNS record table. Look for <strong>Forwarding</strong>, <strong>URL redirect</strong>, or <strong>Redirect rule</strong> in your domain provider.
              </div>
              <div className="mt-2 grid gap-3 rounded-xl border border-gray-200 bg-white p-3 md:grid-cols-[minmax(190px,0.8fr)_minmax(280px,1.2fr)_150px]">
                <CopyField label="From root domain" value={guide.apex} />
                <CopyField label="Send visitors to" value={rootForwardTo} valueClassName="text-[13px] font-semibold" />
                <CopyField label="Redirect type" value="301 Permanent" />
              </div>
              <div className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
                <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                  <p className="font-semibold text-gray-900">GoDaddy</p>
                  <p className="mt-0.5 text-gray-500">Forwarding &gt; Domain</p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                  <p className="font-semibold text-gray-900">Namecheap</p>
                  <p className="mt-0.5 text-gray-500">URL Redirect Record</p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
                  <p className="font-semibold text-gray-900">Cloudflare</p>
                  <p className="mt-0.5 text-gray-500">Redirect Rule</p>
                </div>
              </div>
              <p className="mt-1 text-[11px] text-gray-400">
                If there is a “preserve path” option, turn it on. If there is an “https only” option, turn it on.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex gap-3">
            <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-gray-900 text-xs font-bold text-white">3</span>
            <p className="text-sm text-gray-700">
              Enter <span className="font-mono">{guide.primary}</span> above and press <strong>Connect</strong>. Sitepresso will verify DNS and issue HTTPS automatically.
            </p>
          </div>
        )}

        {guide.hasWwwPair && (
          <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600">
            <p>
              Last step in Sitepresso: enter <span className="font-mono font-semibold">{guide.primary}</span> above and press <strong>Connect</strong>. Sitepresso verifies DNS and issues HTTPS automatically.
            </p>
            <p className="mt-1">
              Advanced fallback only if your provider does not have forwarding: add an <strong>ALIAS</strong>, <strong>ANAME</strong>, or flattened <strong>CNAME</strong> record with <span className="font-mono">Name @</span> and <span className="font-mono">Value {CUSTOM_DOMAIN_CNAME_TARGET}</span>.
            </p>
          </div>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-3">
        <p className="text-sm font-semibold text-gray-900">Examples: what to enter for each domain style</p>
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          <div className="rounded-lg border border-gray-200 bg-gray-50/70 p-3 text-xs text-gray-600">
            <p className="font-semibold text-gray-900">If the customer enters the root domain</p>
            <p className="mt-1 font-mono text-gray-950">{exampleApex}</p>
            <div className="mt-2 space-y-1">
              <p>1. In Sitepresso, use <span className="font-mono">{exampleWww}</span>.</p>
              <p>2. Add DNS: <span className="font-mono">CNAME</span> / <span className="font-mono">www</span> / <span className="font-mono">{CUSTOM_DOMAIN_CNAME_TARGET}</span>.</p>
              <p>3. Add redirect: <span className="font-mono">{exampleApex}</span> to <span className="font-mono">https://{exampleWww}</span>.</p>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-gray-50/70 p-3 text-xs text-gray-600">
            <p className="font-semibold text-gray-900">If the customer enters the www domain</p>
            <p className="mt-1 font-mono text-gray-950">{exampleWww}</p>
            <div className="mt-2 space-y-1">
              <p>1. Keep <span className="font-mono">{exampleWww}</span> in Sitepresso.</p>
              <p>2. Add DNS: <span className="font-mono">CNAME</span> / <span className="font-mono">www</span> / <span className="font-mono">{CUSTOM_DOMAIN_CNAME_TARGET}</span>.</p>
              <p>3. Add redirect from <span className="font-mono">{exampleApex}</span> to <span className="font-mono">https://{exampleWww}</span>.</p>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-gray-50/70 p-3 text-xs text-gray-600">
            <p className="font-semibold text-gray-900">If the customer enters another subdomain</p>
            <p className="mt-1 font-mono text-gray-950">{exampleSubdomain}</p>
            <div className="mt-2 space-y-1">
              <p>1. Keep <span className="font-mono">{exampleSubdomain}</span> in Sitepresso.</p>
              <p>2. Add DNS: <span className="font-mono">CNAME</span> / <span className="font-mono">shop</span> / <span className="font-mono">{CUSTOM_DOMAIN_CNAME_TARGET}</span>.</p>
              <p>3. No root redirect is needed unless they also want <span className="font-mono">{exampleApex}</span> to open the site.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================ main ============================ */

export default function DomainsTab({ business, vertical }) {
  const [state, setState] = useState({ loading: true, error: '', domains: [], summary: null, subscriptionDomain: null });
  const [mode, setMode] = useState(() => (isProdBuyTransferPaused() ? 'byod' : 'register'));
  const [query, setQuery] = useState(business?.slug || '');
  const [searchState, setSearchState] = useState({ loading: false, error: '', results: [], unsupported: [], searched: false, sld: '' });
  const [cart, setCart] = useState([]);
  const [registrationYears, setRegistrationYears] = useState(1);
  const [privacyEnabled, setPrivacyEnabled] = useState(true);
  const [premiumPending, setPremiumPending] = useState(null);
  const [transferForm, setTransferForm] = useState({ domain: '', authCode: '' });
  const [transferChecks, setTransferChecks] = useState({ unlocked: false, olderThan60: false, emailReady: false });
  const [byodDomain, setByodDomain] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [notice, setNotice] = useState('');
  const [transferOut, setTransferOut] = useState({ domain: null, result: null });
  const [setup, setSetup] = useState(null); // { names: [] }
  const [byodWizard, setByodWizard] = useState(null); // { domain }
  const [redirectSetup, setRedirectSetup] = useState(null); // { domain, binding }
  const searchRef = useRef(null);
  const byodRef = useRef(null);
  const resultsRef = useRef(null);
  const searchScrollRef = useRef(false);
  const searchSeqRef = useRef(0);
  const domainPaymentSyncAttemptedRef = useRef(false);

  const buyTransferPaused = isProdBuyTransferPaused();
  const subdomainUrl = useMemo(() => getTenantStorefrontUrl(business?.slug), [business]);
  const cartNames = useMemo(() => new Set(cart.map((c) => c.domainName)), [cart]);

  const load = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const data = await api('/api/business/domains');
      setState({ loading: false, error: '', domains: data.domains || [], summary: data.summary || null, subscriptionDomain: data.subscriptionDomain || null });
    } catch (err) {
      setState((prev) => ({ ...prev, loading: false, error: err?.data?.message || err.message || 'Could not load domains' }));
    }
  }, []);

  // Quiet refresh used by the setup-stepper poll (no global spinner flash).
  const quietLoad = useCallback(async () => {
    try {
      const data = await api('/api/business/domains');
      setState((prev) => ({ ...prev, domains: data.domains || [], summary: data.summary || null, subscriptionDomain: data.subscriptionDomain || null }));
    } catch {
      /* keep last good state */
    }
  }, []);

  useEffect(() => {
    if (domainPaymentSyncAttemptedRef.current || typeof window === 'undefined') return undefined;
    const params = new URLSearchParams(window.location.search);
    if (params.get('domain') !== 'success') return undefined;

    domainPaymentSyncAttemptedRef.current = true;
    let cancelled = false;

    async function syncDomainPayment() {
      setNotice({ tone: 'info', message: 'Checking domain payment status...' });
      try {
        const res = await api('/api/business/domains/sync-paddle-payment', { method: 'POST', body: '{}' });
        if (cancelled) return;
        await quietLoad();
        setNotice({
          tone: res?.synced ? 'success' : 'info',
          message: res?.message || (res?.synced
            ? 'Domain payment confirmed. Registration is being finalized.'
            : 'Domain payment is still pending. This page will update when registration completes.'),
        });
      } catch (err) {
        if (!cancelled) {
          setNotice({
            tone: 'warning',
            message: err?.data?.message || err.message || 'Could not verify the domain payment yet. Refresh in a moment.',
          });
        }
      } finally {
        if (typeof window !== 'undefined') {
          const cleanUrl = new URL(window.location.href);
          cleanUrl.searchParams.delete('domain');
          window.history.replaceState({}, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
        }
      }
    }

    syncDomainPayment();
    return () => { cancelled = true; };
  }, [quietLoad]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!buyTransferPaused) return;
    if (mode === 'register' || mode === 'transfer') setMode('byod');
    if (cart.length) setCart([]);
  }, [buyTransferPaused, cart.length, mode]);

  // Auto-refresh while any connected domain is still verifying, so the badge
  // flips to "Connected" (green) on its own once Cloudflare finishes issuing —
  // no manual reload needed.
  useEffect(() => {
    const pending = (state.domains || []).some((d) =>
      ['PENDING_DNS', 'PENDING_SSL', 'PENDING'].includes(String(d.displayStatus || '').toUpperCase())
    );
    if (!pending) return undefined;
    const id = setInterval(() => { quietLoad(); }, 20000);
    return () => clearInterval(id);
  }, [state.domains, quietLoad]);

  const expiringDomains = useMemo(
    () => (state.domains || []).filter((d) => d.displayStatus === 'EXPIRING' || d.displayStatus === 'EXPIRED'),
    [state.domains]
  );
  const sortedDomains = useMemo(() => {
    const list = [...(state.domains || [])];
    const rank = (domain) => (domain.primary ? 0 : domain.trafficRole === 'REDIRECT' ? 1 : 2);
    list.sort((a, b) => rank(a) - rank(b));
    return list;
  }, [state.domains]);

  const expectedExactName = normalizeDomainInput(query).includes('.') ? normalizeDomainInput(query) : `${searchState.sld}.com`;
  const exactResult = searchState.results.find((r) => r.domainName === expectedExactName) || null;
  const exactAvailable = exactResult?.available ? exactResult : null;
  const bestPick = exactAvailable || searchState.results.find((r) => r.available) || null;
  const restResults = searchState.results.filter((r) => r !== bestPick);
  const cartTlds = useMemo(() => new Set(cart.map((item) => item.tld || tldOf(item.domainName))), [cart]);
  const bundleSuggestion = useMemo(() => {
    if (!cart.length) return null;
    const preferred = ['in', 'store', 'shop', 'online', 'co.nz', 'com.au'];
    return preferred
      .map((tld) => searchState.results.find((item) => item.available && !cartNames.has(item.domainName) && (item.tld || tldOf(item.domainName)) === tld && !cartTlds.has(tld)))
      .find(Boolean) || null;
  }, [cart.length, cartNames, cartTlds, searchState.results]);

  async function runSearch(e, overrideQuery) {
    e?.preventDefault?.();
    if (buyTransferPaused) {
      setMode('byod');
      return;
    }
    const clean = normalizeDomainInput(overrideQuery ?? query);
    if (!clean || clean.length < 2) return;
    searchScrollRef.current = Boolean(e?.preventDefault);
    if (overrideQuery) setQuery(clean);
    const seq = ++searchSeqRef.current;
    setSearchState({ loading: true, error: '', results: [], unsupported: [], searched: true, sld: clean });
    try {
      const data = await api(`/api/business/domains/search?q=${encodeURIComponent(clean)}`);
      if (seq !== searchSeqRef.current) return;
      setSearchState({ loading: false, error: '', results: data.results || [], unsupported: data.unsupported || [], searched: true, sld: data.query || clean });
    } catch (err) {
      if (seq !== searchSeqRef.current) return;
      setSearchState({ loading: false, error: err?.data?.message || err.message || 'Search failed', results: [], unsupported: [], searched: true, sld: clean });
    }
  }

  useEffect(() => {
    const clean = normalizeDomainInput(query);
    if (buyTransferPaused || mode !== 'register' || clean.length < 2) return undefined;
    const id = setTimeout(() => { runSearch(null, clean); }, 550);
    return () => clearTimeout(id);
    // runSearch intentionally stays out of deps; it is a local function and
    // searchSeqRef guards stale responses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buyTransferPaused, query, mode]);

  useEffect(() => {
    if (searchState.loading || !searchState.searched || !searchScrollRef.current) return;
    searchScrollRef.current = false;
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [searchState.loading, searchState.searched, searchState.sld]);

  function addToCart(item) {
    setPremiumPending(null);
    setCart((prev) => (prev.some((c) => c.domainName === item.domainName) ? prev : [...prev, item]));
    setNotice('');
  }
  function removeFromCart(domainName) {
    setCart((prev) => prev.filter((c) => c.domainName !== domainName));
  }

  async function checkout() {
    if (cart.length === 0) return;
    if (buyTransferPaused) {
      setSearchState((prev) => ({ ...prev, error: PROD_DOMAIN_BUY_TRANSFER_PAUSED_MESSAGE }));
      return;
    }
    setBusyKey('checkout');
    setNotice('');
    const registered = [];
    try {
      for (const item of cart) {
        const res = await api('/api/business/domains/checkout', {
          method: 'POST',
          body: JSON.stringify({ domainName: item.domainName, years: registrationYears, privacyEnabled, confirmPremium: item.premium === true }),
        });
        if (res?.action === 'checkout' && res.checkoutUrl) {
          // Paddle path — one transaction per redirect. Remaining items stay in cart.
          window.location.href = res.checkoutUrl;
          return;
        }
        registered.push(item.domainName);
      }
      // Direct registration path (sandbox/dev): all done — show the live setup stepper.
      setCart([]);
      await load();
      setSetup({ names: registered });
    } catch (err) {
      setSearchState((prev) => ({ ...prev, error: err?.data?.message || err.message || 'Could not start checkout' }));
    } finally {
      setBusyKey('');
    }
  }

  async function startTransfer(e) {
    e.preventDefault();
    if (buyTransferPaused) {
      setState((prev) => ({ ...prev, error: PROD_DOMAIN_BUY_TRANSFER_PAUSED_MESSAGE }));
      setMode('byod');
      return;
    }
    if (!transferPreflightReady) {
      setState((prev) => ({ ...prev, error: 'Confirm the transfer pre-flight checks before starting.' }));
      return;
    }
    setBusyKey('transfer');
    setNotice('');
    try {
      const res = await api('/api/business/domains/transfer-in', {
        method: 'POST',
        body: JSON.stringify({ domainName: normalizeDomainInput(transferForm.domain), authCode: transferForm.authCode }),
      });
      setNotice(`${res.domain?.name || transferForm.domain} transfer has started. Check your registrant email to approve it.`);
      setTransferForm({ domain: '', authCode: '' });
      setTransferChecks({ unlocked: false, olderThan60: false, emailReady: false });
      await load();
    } catch (err) {
      setState((prev) => ({ ...prev, error: err?.data?.message || err.message || 'Could not start transfer' }));
    } finally {
      setBusyKey('');
    }
  }

  async function addByod(e) {
    e.preventDefault();
    setBusyKey('byod');
    setNotice('');
    try {
      const res = await api('/api/business/domains/byod', { method: 'POST', body: JSON.stringify({ domainName: normalizeDomainInput(byodDomain) }) });
      const savedName = res.domain?.name || normalizeDomainInput(byodDomain);
      const redirecting = res.binding?.role === 'REDIRECT';
      const bindingStatus = String(res.binding?.status || res.domain?.displayStatus || '').toUpperCase();
      if (redirecting) {
        setNotice({
          tone: ['PENDING_DNS', 'PENDING_SSL', 'PENDING'].includes(bindingStatus) ? 'info' : 'success',
          message: `${savedName} is saved as a redirect to ${res.binding.redirectTo}. If you just changed DNS, it can take up to 30 minutes before the redirect works everywhere.`,
        });
      } else if (bindingStatus === 'ACTIVE') {
        setNotice(`${savedName} is connected. DNS and HTTPS are active.`);
      } else if (bindingStatus === 'PENDING_SSL') {
        setNotice({
          tone: 'info',
          message: `${savedName} is added. Status: Pending HTTPS. DNS is correct; Sitepresso is issuing the secure certificate, which usually takes a few minutes and can take up to 30 minutes.`,
        });
      } else {
        setNotice({
          tone: 'info',
          message: `${savedName} is added. Status: Pending DNS. Add the CNAME record shown below, then wait for DNS to update. This usually takes a few minutes, but some providers take up to 30 minutes. Your free Sitepresso URL stays live meanwhile.`,
        });
      }
      setByodDomain('');
      await load();
      if (redirecting) {
        setRedirectSetup({ domain: res.domain || { name: savedName }, binding: res.binding });
      } else {
        setByodWizard({ domain: res.domain || { name: savedName } });
      }
    } catch (err) {
      setState((prev) => ({ ...prev, error: err?.data?.message || err.message || 'Could not save domain' }));
    } finally {
      setBusyKey('');
    }
  }

  async function onAction(action, domain, body = {}) {
    const pathByAction = {
      privacy: `/api/business/domains/${domain.id}/privacy`,
      'auto-renew': `/api/business/domains/${domain.id}/auto-renew`,
      renew: `/api/business/domains/${domain.id}/renew`,
      primary: `/api/business/domains/${domain.id}/primary`,
      redirect: `/api/business/domains/${domain.id}/redirect`,
      disconnect: `/api/business/domains/${domain.id}`,
    };
    const path = pathByAction[action];
    if (!path) return;
    if (action === 'disconnect') {
      const ok = window.confirm(`Disconnect ${domain.name} from this store?\n\nYour Sitepresso subdomain will keep working.`);
      if (!ok) return;
    }
    setBusyKey(`${action}:${domain.id}`);
    setNotice('');
    try {
      const result = await api(path, { method: action === 'disconnect' ? 'DELETE' : 'POST', body: action === 'disconnect' ? undefined : JSON.stringify(body) });
      if (result?.action === 'checkout' && result.checkoutUrl) {
        window.location.href = result.checkoutUrl;
        return;
      }
      if (action === 'redirect' && result?.binding) {
        setRedirectSetup({ domain: result.domain || domain, binding: result.binding });
      }
      setNotice(action === 'disconnect'
        ? `${domain.name} disconnected. Your subdomain remains live.`
        : action === 'redirect'
          ? `${domain.name} redirect checked.`
          : action === 'renew' && result?.action === 'renewed'
            ? `${domain.name} renewed.`
            : `${domain.name} updated.`);
      await load();
    } catch (err) {
      setState((prev) => ({ ...prev, error: err?.data?.message || err.message || 'Domain update failed' }));
    } finally {
      setBusyKey('');
    }
  }

  async function confirmTransferOut(domain) {
    setBusyKey(`auth:${domain.id}`);
    try {
      const result = await api(`/api/business/domains/${domain.id}/auth-code`, { method: 'POST', body: '{}' });
      setTransferOut({ domain, result });
      await load();
    } catch (err) {
      setState((prev) => ({ ...prev, error: err?.data?.message || err.message || 'Could not get authorization code' }));
    } finally {
      setBusyKey('');
    }
  }

  function focusSearch() {
    setMode(buyTransferPaused ? 'byod' : 'register');
    setTimeout(() => (buyTransferPaused ? byodRef.current : searchRef.current)?.focus(), 50);
  }

  const busy = Boolean(busyKey);
  const variants = searchState.searched ? variantSuggestions(searchState.sld) : [];
  const availableCount = searchState.results.filter((item) => item.available).length;
  const currentSearchName = searchState.sld || normalizeDomainInput(query);
  const currentSearchLabel = currentSearchName || business?.slug || 'your brand';
  const baseSearchLabel = normalizeDomainInput(query).split('.')[0] || business?.slug || '';
  const popularTlds = ['com', 'in', 'store', 'shop', 'online'];
  const transferPreflightReady = transferChecks.unlocked && transferChecks.olderThan60 && transferChecks.emailReady;
  const fullHeaderDescription = buyTransferPaused
    ? `Connect and manage custom domains for ${business?.name || 'this business'}.`
    : `Buy, transfer, connect, and renew custom domains for ${business?.name || 'this business'} — without ever leaving Sitepresso.`;

  return (
    <div className="space-y-5">
      {/* header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-950">Domain Studio</h1>
          <p className="mt-1 text-sm text-gray-500">{fullHeaderDescription}</p>
        </div>
        <span className="self-start rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-gray-500 lg:self-auto">{vertical || 'ALL'} ready</span>
      </div>

      {noticeMessage(notice) && <div className={noticeClassName(notice)}>{noticeMessage(notice)}</div>}
      {state.error && <ErrorBanner message={state.error} />}

      {/* workspace */}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <EntryCards mode={mode} setMode={setMode} buyTransferPaused={buyTransferPaused} />

          {mode === 'register' && (
            <div className="rounded-2xl border border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3 border-b border-gray-100 pb-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-600">Domain search</p>
                  <h2 className="mt-0.5 truncate text-base font-semibold tracking-tight text-gray-950">Find the best address for {business?.name || 'your business'}</h2>
                </div>
                <span className="inline-flex flex-none items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Live fallback active
                </span>
              </div>

              <form onSubmit={runSearch} className="mt-3 flex flex-col gap-3 md:flex-row">
                <div className="relative min-w-0 flex-1">
                  <IconSearch className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                  <input
                    ref={searchRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(normalizeDomainTyping(e.target.value))}
                    onBlur={() => setQuery((v) => normalizeDomainInput(v))}
                    placeholder={business?.slug || 'mybusiness'}
                    className="w-full rounded-xl border border-gray-300 px-11 py-3 text-base font-medium text-gray-950 outline-none transition placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                  />
                </div>
                <PrimaryButton type="submit" loading={searchState.loading}>Search domains</PrimaryButton>
              </form>

              {baseSearchLabel && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-gray-500">Popular endings</span>
                  {popularTlds.map((tld) => {
                    const next = `${baseSearchLabel}.${tld}`;
                    return (
                      <button
                        key={tld}
                        type="button"
                        onClick={(e) => runSearch(e, next)}
                        className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-semibold text-gray-700 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
                      >
                        .{tld}
                      </button>
                    );
                  })}
                </div>
              )}

              {searchState.error && <div className="mt-3"><ErrorBanner message={searchState.error} /></div>}

              <div ref={resultsRef} className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white">
                <div className="flex flex-col gap-2 border-b border-gray-100 bg-gray-50/80 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-950">
                      {searchState.loading ? 'Checking availability' : searchState.searched ? `Results for ${currentSearchLabel}` : 'Search results'}
                    </p>
                    {!searchState.searched && !searchState.loading && (
                      <p className="text-xs text-gray-500">Available domains will appear here immediately after search.</p>
                    )}
                  </div>
                  <span className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-xs font-semibold ${
                    searchState.loading
                      ? 'border-blue-200 bg-blue-50 text-blue-700'
                      : searchState.searched
                        ? availableCount > 0
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : 'border-amber-200 bg-amber-50 text-amber-700'
                        : 'border-gray-200 bg-white text-gray-500'
                  }`}>
                    {searchState.loading ? 'Searching' : searchState.searched ? `${availableCount} available` : 'Ready'}
                  </span>
                </div>
                {searchState.loading && <SearchSkeleton />}
                {!searchState.loading && !searchState.searched && <Empty text="Search a name to see available domains across .com, .in, .store and more." />}
                {!searchState.loading && searchState.searched && (
                  <>
                    {(exactResult && !exactResult.available) || bestPick || variants.length > 0 ? (
                      <div className="space-y-3 p-3">
                        {exactResult && !exactResult.available && <ExactMatchUnavailable item={exactResult} />}
                        {bestPick && (
                          <BestPickHero
                            item={bestPick}
                            inCart={cartNames.has(bestPick.domainName)}
                            busy={busyKey === 'checkout'}
                            onAdd={(it) => (it.premium ? setPremiumPending(it) : addToCart(it))}
                          />
                        )}
                        {variants.length > 0 && (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold text-gray-500">Also try</span>
                            {variants.map((v) => (
                              <button key={v} type="button" onClick={(e) => runSearch(e, v)} className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-700 transition hover:border-gray-900 hover:bg-gray-900 hover:text-white">{v}</button>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : null}
                    {restResults.length > 0 && (
                      <div className={(exactResult && !exactResult.available) || bestPick || variants.length > 0 ? 'border-t border-gray-100' : ''}>
                        {restResults.map((item) => (
                          <ResultRow
                            key={item.domainName}
                            item={item}
                            inCart={cartNames.has(item.domainName)}
                            busy={busyKey === 'checkout'}
                            onAdd={addToCart}
                            onPremium={(it) => setPremiumPending(it)}
                          />
                        ))}
                      </div>
                    )}
                    {restResults.length === 0 && !bestPick && <Empty text="No domain options found. Try a different name." />}
                  </>
                )}
              </div>

              {searchState.unsupported?.length > 0 && (
                <p className="mt-3 text-xs text-gray-400">
                  Not offered: {searchState.unsupported.map((u) => `.${u.tld}`).join(', ')} (restricted TLDs).
                </p>
              )}
            </div>
          )}

          {mode === 'transfer' && (
            <div className="rounded-2xl border border-gray-200 bg-white p-4">
              <h2 className="text-base font-semibold text-gray-950">Transfer your domain to Sitepresso</h2>
              <p className="mt-1 text-sm text-gray-500">Adds one year to your registration. Your store stays live at its subdomain through the 5–7 day transfer.</p>
              <form onSubmit={startTransfer} className="mt-4 grid gap-4 md:grid-cols-2">
                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Domain name</span>
                  <input value={transferForm.domain} onChange={(e) => setTransferForm((p) => ({ ...p, domain: normalizeDomainInput(e.target.value) }))} className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm outline-none focus:border-gray-900" placeholder="example.com" />
                </label>
                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Authorization (EPP) code</span>
                  <input value={transferForm.authCode} onChange={(e) => setTransferForm((p) => ({ ...p, authCode: e.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm outline-none focus:border-gray-900" placeholder="ABCD-1234-XYZ" />
                  <span className="mt-1 block text-xs text-gray-400">Get this from your current registrar’s control panel (GoDaddy, Namecheap, etc.).</span>
                </label>
                <div className="md:col-span-2"><AuthCodeHelper /></div>
                <div className="md:col-span-2 rounded-xl border border-gray-200 bg-gray-50 p-3">
                  <p className="text-sm font-semibold text-gray-900">Pre-flight checks</p>
                  <p className="mt-0.5 text-xs text-gray-500">Transfers fail most often because the domain is locked or the approval email is missed.</p>
                  <div className="mt-3 grid gap-2 md:grid-cols-3">
                    {[
                      ['unlocked', 'Domain is unlocked at the current registrar'],
                      ['olderThan60', 'Domain is older than 60 days and was not recently transferred'],
                      ['emailReady', 'Registrant email inbox is accessible for approval'],
                    ].map(([key, label]) => (
                      <label key={key} className="flex items-start gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700">
                        <input
                          type="checkbox"
                          checked={transferChecks[key]}
                          onChange={(e) => setTransferChecks((prev) => ({ ...prev, [key]: e.target.checked }))}
                          className="mt-0.5 h-4 w-4 rounded border-gray-300"
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="md:col-span-2">
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    <p className="font-semibold">⚠️ After you start: approve the email</p>
                    <p className="mt-0.5">Your registrant address will get a “confirm transfer” email. You must click <strong>Approve</strong> — this is the #1 reason transfers stall.</p>
                  </div>
                </div>
                <div className="md:col-span-2">
                  <PrimaryButton type="submit" loading={busyKey === 'transfer'} disabled={!transferForm.domain || !transferForm.authCode || !transferPreflightReady}>Start transfer</PrimaryButton>
                </div>
              </form>
            </div>
          )}

          {mode === 'byod' && (
            <div className="rounded-2xl border border-gray-200 bg-white p-4">
              <h2 className="text-base font-semibold text-gray-950">Connect an existing domain</h2>
              <p className="mt-1 text-sm text-gray-500">Keep your domain where it is. Add one DNS record, then Sitepresso verifies it and turns on HTTPS automatically.</p>
              <form onSubmit={addByod} className="mt-4 space-y-2">
                <label htmlFor="byod-domain" className="block text-sm font-medium text-gray-700">Your domain</label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input id="byod-domain" ref={byodRef} value={byodDomain} onChange={(e) => setByodDomain(normalizeDomainTyping(e.target.value))} onBlur={() => setByodDomain((v) => normalizeDomainInput(v))} className="w-full sm:max-w-sm rounded-lg border border-gray-300 px-4 py-2.5 text-sm outline-none focus:border-gray-900" placeholder="www.yourdomain.com" />
                  <PrimaryButton type="submit" loading={busyKey === 'byod'} disabled={!byodDomain}>Connect</PrimaryButton>
                </div>
                <p className="text-xs text-gray-400">Recommended: use <span className="font-mono">www.yourdomain.com</span>. It works on every registrar; the guide below shows how to make <span className="font-mono">yourdomain.com</span> work too.</p>
                <p className="text-xs text-gray-400">After you press Connect, Sitepresso starts verification right away. DNS usually updates within a few minutes, but some providers can take longer.</p>
              </form>
              <DnsSetupGuide domainInput={byodDomain} onUseWww={(nextDomain) => setByodDomain(nextDomain)} />
            </div>
          )}
        </div>

        <aside className="space-y-4 xl:self-start">
          {mode === 'register' && (
            <div className="xl:sticky xl:top-4 xl:self-start">
              <CartRail
                items={cart}
                years={registrationYears}
                setYears={setRegistrationYears}
                privacyEnabled={privacyEnabled}
                setPrivacyEnabled={setPrivacyEnabled}
                onRemove={removeFromCart}
                onCheckout={checkout}
                busy={busyKey === 'checkout'}
                bundleSuggestion={bundleSuggestion}
                onAddBundle={addToCart}
              />
            </div>
          )}

          <SafetyNetBanner subdomainUrl={subdomainUrl} buyTransferPaused={buyTransferPaused} />

          <div className="grid grid-cols-2 gap-3">
            <Metric label="Domains" value={state.summary?.total ?? 0} />
            <Metric label="Primary" value={state.summary?.primary ?? 0} hint="canonical" />
            <Metric label="Redirects" value={state.summary?.redirects ?? 0} hint="301 to primary" />
            <Metric label="Active" value={state.summary?.active ?? 0} hint="serving traffic" />
            <Metric label="Expiring" value={state.summary?.expiring ?? 0} hint="within 14 days" />
          </div>

          {expiringDomains.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              ⚠️ {expiringDomains.length} domain{expiringDomains.length === 1 ? '' : 's'} need renewal attention below.
            </div>
          )}
        </aside>
      </div>

      {/* managed domains hub */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-950">Your domains</h2>
          {state.loading && <Spinner small />}
        </div>
        {state.loading && state.domains.length === 0 && <div className="flex justify-center rounded-2xl border border-gray-200 bg-white py-10"><Spinner /></div>}
        {!state.loading && state.domains.length === 0 && <HubEmptyState subdomainUrl={subdomainUrl} onStart={focusSearch} buyTransferPaused={buyTransferPaused} />}
        {sortedDomains.map((domain) => (
          <div key={domain.id}>
            <DomainCard
              domain={domain}
              hero={domain.primary}
              busy={busy}
              onAction={onAction}
              onTransferOut={(nextDomain) => setTransferOut({ domain: nextDomain, result: null })}
              onOpenSettings={() => setByodWizard({ domain })}
              hideTransferOut={buyTransferPaused}
            />
            {domain.status === 'TRANSFER_IN_PENDING' && <TransferProgress domainId={domain.id} />}
          </div>
        ))}
      </div>

      {premiumPending && (
        <PremiumGuardrailModal item={premiumPending} busy={false} onClose={() => setPremiumPending(null)} onConfirm={addToCart} />
      )}

      {setup && (
        <SetupStepperModal
          names={setup.names}
          subdomainUrl={subdomainUrl}
          getDomain={(name) => (state.domains || []).find((d) => d.name === name)}
          getSubscriptionDomain={() => state.subscriptionDomain}
          onRefresh={quietLoad}
          onClose={() => setSetup(null)}
        />
      )}

      {transferOut.domain && (
        <TransferOutModal
          domain={transferOut.domain}
          busy={busyKey === `auth:${transferOut.domain.id}`}
          result={transferOut.result}
          onClose={() => setTransferOut({ domain: null, result: null })}
          onConfirm={confirmTransferOut}
        />
      )}

      {byodWizard && (
        <ByodDnsWizard
          key={`${byodWizard.domain?.name || ''}:${byodWizard.t || ''}`}
          domain={byodWizard.domain}
          onClose={() => setByodWizard(null)}
          onMakePrimary={async (d) => { await onAction('primary', d); setByodWizard({ domain: d, t: Date.now() }); }}
        />
      )}

      {redirectSetup && (
        <RedirectSetupModal
          setup={redirectSetup}
          onClose={() => setRedirectSetup(null)}
        />
      )}
    </div>
  );
}
