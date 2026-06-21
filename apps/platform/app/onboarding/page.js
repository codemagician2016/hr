'use client';

import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import Link from 'next/link';
import LanguageSelector from '@/components/LanguageSelector';
import { COUNTRIES, DEFAULT_COUNTRY, addressPlaceholderFor, timezonesFor, defaultTimezoneFor } from '@/lib/countries';
import { slugify as rawSlugify } from '@/lib/slugify';
import { getPlatformDomain } from '@/lib/platformDomain';
import { getAvailableFlat, getAvailableGroups } from '@/lib/availableThemes';
import { resolvePreset } from '@/lib/layoutPresets';
import { openRazorpaySubscriptionCheckout } from '@/lib/razorpayCheckout';
import CountryAddressFields from '@/components/CountryAddressFields';

const PLATFORM_DOMAIN = getPlatformDomain();
// Domain buy/transfer + business-email are paused on production until the
// registrar/email reseller goes live. Mirrors DomainsTab's isProdBuyTransferPaused()
// so onboarding and the admin flip together via the one flag. When paused,
// onboarding offers only "free subdomain" + "connect existing" (no buy/transfer/email).
const RESELLER_BUY_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.NEXT_PUBLIC_DOMAIN_RESELLER_PROD_BUY_TRANSFER_ENABLED || '').trim().toLowerCase()
);
const RESELLER_PAUSED = PLATFORM_DOMAIN === 'sitepresso.com' && !RESELLER_BUY_ENABLED;
const STORAGE_KEY = 'sitepresso:onboarding:v4';
const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm text-gray-950 outline-none transition placeholder:text-gray-400 focus:border-gray-950 focus:ring-2 focus:ring-gray-100 disabled:bg-gray-50 disabled:text-gray-400';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;

const slugifyLocal = (name) => rawSlugify(name, 60);

const FLOW_PHASES = [
  { key: 'scope', label: 'Your goal', short: 'Goal', hint: 'What you want to launch' },
  { key: 'basics', label: 'Business', short: 'Business', hint: 'Name, contact & address' },
  { key: 'design', label: 'Design', short: 'Design', hint: 'Theme, layout & colors' },
  { key: 'plan', label: 'Plan', short: 'Plan', hint: 'Choose monthly or yearly' },
  { key: 'offer', label: 'Domain & email', short: 'Domain', hint: 'Add a custom domain & business email' },
  { key: 'start', label: 'Start', short: 'Start', hint: 'Review and continue to checkout' },
  // While the registrar/email reseller is paused on prod, drop the domain/email
  // step ENTIRELY — customers launch on the free subdomain and connect a domain
  // later from the admin. Avoids a confusing half-empty "custom domain" step.
].filter((phase) => !(RESELLER_PAUSED && phase.key === 'offer'));

const VERTICALS = [
  {
    key: 'STATIC',
    label: 'Website',
    title: 'Marketing website',
    body: 'Pages, enquiry forms, SEO, domain, and launch checklist.',
    bestFor: 'Agencies, portfolios, consultants, local services',
  },
  {
    key: 'APPOINTMENT',
    label: 'Bookings',
    title: 'Booking business',
    body: 'Services, staff, schedules, reminders, intake forms, and customer bookings.',
    bestFor: 'Clinics, salons, lawyers, restaurants, trainers',
  },
  {
    key: 'ECOMMERCE',
    label: 'Shop',
    title: 'Online store',
    body: 'Catalog, cart, checkout, fulfilment, pickup, delivery, and order management.',
    bestFor: 'Grocery, fashion, retail, food, product brands',
  },
];

const GOALS = [
  { key: 'publish', label: 'Publish a website', vertical: 'STATIC', icon: 'globe', body: 'Pages, enquiry forms, SEO and a custom domain.' },
  { key: 'bookings', label: 'Take bookings', vertical: 'APPOINTMENT', icon: 'check', body: 'Services, staff, schedules, reminders and intake.' },
  { key: 'sales', label: 'Sell products', vertical: 'ECOMMERCE', icon: 'card', body: 'Catalog, cart, checkout, delivery and orders.' },
];

const DOMAIN_MODES = [
  { key: 'skip', label: 'Use free subdomain', body: 'Launch now and add a custom domain later.' },
  { key: 'register', label: 'Buy new domain', body: 'Search, register, renew, and manage inside Sitepresso.' },
  { key: 'byod', label: 'Connect existing', body: 'Keep your domain at its current registrar and point DNS here.' },
  { key: 'transfer', label: 'Transfer to us', body: 'Move the domain into Sitepresso with an authorization code.' },
];

const EMAIL_OPTIONS = [
  { key: 'mailbox', label: 'Business email mailbox', price: 'Subscription', body: 'A real inbox on your domain (e.g. hello@yourdomain.com). We create it and email you the login — webmail, IMAP and SMTP included.' },
  { key: 'skip', label: 'Not now', price: 'Free', body: 'Keep using your current email. You can add a business mailbox anytime from your dashboard.' },
];

const LAYOUT_OPTIONS = [
  { key: 'conversion', label: 'Conversion focused', body: 'Strong hero, proof, service cards, and repeated calls to action.' },
  { key: 'editorial', label: 'Editorial premium', body: 'Larger imagery, storytelling sections, and trust-led page rhythm.' },
  { key: 'catalog', label: 'Catalog style', body: 'Dense browsing layout for products, services, categories, or locations.' },
  { key: 'minimal', label: 'Minimal', body: 'Quiet, direct, fast-loading pages with restrained sections.' },
];

const COLOR_OPTIONS = [
  { key: 'ink-mint', label: 'Ink and mint', swatches: ['#111827', '#10b981', '#f8fafc'] },
  { key: 'charcoal-gold', label: 'Charcoal and gold', swatches: ['#18181b', '#d97706', '#fafaf9'] },
  { key: 'forest-sky', label: 'Forest and sky', swatches: ['#14532d', '#0284c7', '#f0fdf4'] },
  { key: 'graphite-rose', label: 'Graphite and rose', swatches: ['#27272a', '#e11d48', '#fff1f2'] },
  { key: 'navy-coral', label: 'Navy and coral', swatches: ['#0f172a', '#f97316', '#f8fafc'] },
];

const DESIGN_PRESET_BY_LAYOUT = {
  conversion: 'bold-split',
  editorial: 'magazine',
  catalog: 'commerce',
  minimal: 'minimal-mono',
};

const DEFAULT_DETAILS = {
  launchGoal: 'publish',
  name: '',
  slug: '',
  vertical: 'STATIC',
  category: '',
  description: '',
  address: '',
  state: '',
  country: DEFAULT_COUNTRY,
  timezone: defaultTimezoneFor(DEFAULT_COUNTRY),
  phone: '',
  email: '',
  yourName: '',
  taxId: '',
  addressLine2: '',
  city: '',
  postalCode: '',
};

const DEFAULT_PACKAGE = {
  domain: {
    mode: 'skip',
    query: '',
    selected: null,
    privacyEnabled: true,
    transferDomain: '',
    transferAuthCode: '',
    byodDomain: '',
  },
  email: { option: 'skip', boxes: [{ localPart: 'hello', deliverTo: '' }] },
  design: {
    theme: '',
    layout: 'conversion',
    color: 'ink-mint',
  },
  acceptedTerms: false,
};

function isUnifiedAdminHost() {
  return typeof window !== 'undefined' && window.location.hostname.startsWith('app.');
}

function adminPathForSlug(slug) {
  return isUnifiedAdminHost() ? '/dashboard' : `/${slug}/admin`;
}

function normalizeDomain(value) {
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

function isLikelyEmail(value) {
  return EMAIL_RE.test(String(value || '').trim());
}

function isLikelyDomain(value) {
  return DOMAIN_RE.test(normalizeDomain(value));
}

function selectedCustomDomain(domain) {
  if (!domain || domain.mode === 'skip') return '';
  if (domain.mode === 'register') return normalizeDomain(domain.selected?.domainName);
  if (domain.mode === 'byod') return normalizeDomain(domain.byodDomain);
  if (domain.mode === 'transfer') return normalizeDomain(domain.transferDomain);
  return '';
}

function domainDisplayName(domain, slug) {
  return selectedCustomDomain(domain) || `${slug || 'your-site'}.${PLATFORM_DOMAIN}`;
}

// Per-mailbox price (major units, shown in the region symbol). Placeholder
// reseller price — adjust or wire to the pricing API when finalized.
const MAILBOX_MONTHLY_MAJOR = 99;

function mailboxBoxes(email) {
  const boxes = Array.isArray(email?.boxes) ? email.boxes : [];
  return boxes.length ? boxes : [{ localPart: 'hello', deliverTo: '' }];
}

function mailboxCount(email) {
  return email?.option === 'mailbox' ? mailboxBoxes(email).length : 0;
}

// Mailboxes are paid add-ons. They start from their own secure checkout so we
// never provision provider resources from a plan checkout alone.
function mailboxFreeCount() {
  return 0;
}

function mailboxMonthlyTotal(email, billingCycle) {
  const count = mailboxCount(email);
  const billable = Math.max(0, count - mailboxFreeCount(billingCycle));
  return billable * MAILBOX_MONTHLY_MAJOR;
}

function mailboxAddresses(email, domain) {
  if (!email || email.option !== 'mailbox') return [];
  const domainName = selectedCustomDomain(domain);
  if (!domainName) return [];
  return mailboxBoxes(email)
    .map((b) => String(b.localPart || '').trim().toLowerCase())
    .filter(Boolean)
    .map((local) => `${local}@${domainName}`);
}

function businessEmailAddress(email, domain) {
  return mailboxAddresses(email, domain)[0] || '';
}

function designPresetForLayout(layoutKey) {
  return DESIGN_PRESET_BY_LAYOUT[layoutKey] || 'classic';
}

function serializeLayoutText(value) {
  const clean = {};
  for (const [key, raw] of Object.entries(value || {})) {
    const next = typeof raw === 'string' ? raw.trim() : raw;
    if (next !== undefined && next !== null && next !== '') clean[key] = next;
  }
  return Object.keys(clean).length ? JSON.stringify(clean) : '';
}

function colorPersistence(selectedColor) {
  const [text, primary, bg] = selectedColor?.swatches || COLOR_OPTIONS[0].swatches;
  return {
    themeColors: {
      primary,
      accent: primary,
      surface: '#FFFFFF',
      bg,
      text,
    },
    contentColors: {
      customPrimary: primary,
      customAccent: primary,
      customBg: bg,
      customSurface: '#FFFFFF',
      customText: text,
      customMuted: '#64748B',
    },
  };
}

function launchPreferencePayload({ details, launchPackage, selectedLayout, selectedColor, selectedEmail }) {
  const emailAddress = businessEmailAddress(launchPackage.email, launchPackage.domain);
  const designPreset = designPresetForLayout(launchPackage.design.layout);
  const preset = resolvePreset({ designPreset });
  const { themeColors, contentColors } = colorPersistence(selectedColor);
  const sectionOrder = Array.isArray(preset?.sectionOrder) ? preset.sectionOrder.join(',') : '';
  const layoutText = serializeLayoutText({
    onboardingLaunchGoal: details.launchGoal,
    onboardingLayout: selectedLayout?.label,
    onboardingPalette: selectedColor?.label,
    onboardingEmail: selectedEmail?.label,
    heroPanelTitle: 'Launch checklist',
    heroChecklist: [
      'Business profile ready',
      launchPackage.domain.mode === 'skip' ? 'Free Sitepresso URL active' : `Domain setup queued for ${selectedCustomDomain(launchPackage.domain) || 'your domain'}`,
      launchPackage.email.option === 'skip' ? 'Email setup skipped for now' : `Email setup queued for ${emailAddress || 'your domain'}`,
    ].join('\n'),
    servicesLeadLabel: VERTICALS.find((v) => v.key === details.vertical)?.label,
    servicesLeadCta: details.vertical === 'ECOMMERCE' ? 'Shop now' : details.vertical === 'APPOINTMENT' ? 'Book now' : 'Enquire now',
    contactPromptLabel: emailAddress ? `Prefer email? ${emailAddress}` : `Replies go to ${details.email}`,
    contactChecklist: 'DNS, email, payments, and go-live stay visible in your admin launch checklist.',
  });

  return {
    emailAddress,
    themePatch: {
      theme: launchPackage.design.theme,
      themeColors,
      designPreset,
      sectionVariants: null,
      resetThemeContent: false,
    },
    contentPatch: {
      ...contentColors,
      sectionOrder,
      layoutText,
      tagline: details.description,
      heroHeadline: details.name ? `Welcome to ${details.name}` : '',
      heroSubheading: details.description,
      businessEmail: emailAddress || details.email,
      contactBody: details.description || `Contact ${details.name || 'us'} to get started.`,
    },
  };
}

function formatCurrencyMinor(minor, currencyCode = 'USD') {
  if (minor == null) return '-';
  const upper = String(currencyCode || 'USD').toUpperCase();
  const zeroDecimal = new Set(['JPY', 'KRW', 'VND']);
  const divisor = zeroDecimal.has(upper) ? 1 : 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: upper }).format(Number(minor) / divisor);
  } catch {
    return `${upper} ${(Number(minor) / divisor).toFixed(divisor === 1 ? 0 : 2)}`;
  }
}

function formatMajor(amount, symbol = '$') {
  const n = Number(amount || 0);
  if (!n) return 'Free';
  return `${symbol}${n.toLocaleString('en-IN')}`;
}

function planMonthlyEquivalent(plan, billingCycle) {
  if (!plan) return 0;
  if (billingCycle === 'YEARLY') return Math.round((Number(plan.yearly) || Number(plan.monthly) * 12 || 0) / 12);
  return Number(plan.monthly) || 0;
}

function planToday(plan, billingCycle) {
  if (!plan) return 0;
  if (billingCycle === 'YEARLY') return Number(plan.yearly) || Number(plan.monthly) * 12 || 0;
  return Number(plan.monthly) || 0;
}

function Icon({ name, className = 'h-4 w-4' }) {
  const common = { className, fill: 'none', viewBox: '0 0 24 24', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  if (name === 'check') return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
  if (name === 'search') return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
  if (name === 'globe') return <svg {...common}><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" /></svg>;
  if (name === 'mail') return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>;
  if (name === 'card') return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /></svg>;
  if (name === 'palette') return <svg {...common}><path d="M12 3a9 9 0 0 0 0 18h1.2a1.8 1.8 0 0 0 1.2-3.1 1.8 1.8 0 0 1 1.2-3.1H18a6 6 0 0 0 0-12h-6Z" /><circle cx="7.5" cy="10" r=".6" /><circle cx="10" cy="7.5" r=".6" /><circle cx="13" cy="7.5" r=".6" /></svg>;
  return <svg {...common}><path d="M12 3v18M3 12h18" /></svg>;
}

export default function OnboardingPage() {
  const [authChecking, setAuthChecking] = useState(true);
  const [draftReady, setDraftReady] = useState(false);
  const [phase, setPhase] = useState(0);
  const [details, setDetails] = useState(DEFAULT_DETAILS);
  const [launchPackage, setLaunchPackage] = useState(DEFAULT_PACKAGE);
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugStatus, setSlugStatus] = useState(null);
  const [pricing, setPricing] = useState(null);
  const [plansLoading, setPlansLoading] = useState(true);
  const [billingCycle, setBillingCycle] = useState('YEARLY');
  const [selectedPlanSlug, setSelectedPlanSlug] = useState(null);
  const [domainSearch, setDomainSearch] = useState({ loading: false, searched: false, error: '', results: [] });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [completion, setCompletion] = useState(null);
  // When the user taps "Pay & start" without ticking the Terms box, we scroll
  // to + flash the checkbox so they know why nothing happened (instead of a
  // silently-disabled button).
  const [highlightTerms, setHighlightTerms] = useState(false);

  useEffect(() => { document.title = 'Set up your business · Sitepresso'; }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.details) setDetails((prev) => ({ ...prev, ...parsed.details }));
        if (parsed.launchPackage) {
          setLaunchPackage((prev) => ({
            ...prev,
            ...parsed.launchPackage,
            domain: { ...prev.domain, ...(parsed.launchPackage.domain || {}) },
            email: { ...prev.email, ...(parsed.launchPackage.email || {}) },
            design: { ...prev.design, ...(parsed.launchPackage.design || {}) },
          }));
        }
        if (Number.isInteger(parsed.phase)) setPhase(Math.max(0, Math.min(FLOW_PHASES.length - 1, parsed.phase)));
        if (parsed.billingCycle) setBillingCycle(parsed.billingCycle);
        if (parsed.selectedPlanSlug) setSelectedPlanSlug(parsed.selectedPlanSlug);
      }
    } catch {
      /* ignore invalid draft */
    } finally {
      setDraftReady(true);
    }
  }, []);

  useEffect(() => {
    if (!draftReady || phase === 'done') return;
    const draft = { details, launchPackage, phase, billingCycle, selectedPlanSlug };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(draft)); } catch { /* storage can fail in private mode */ }
  }, [billingCycle, details, draftReady, launchPackage, phase, selectedPlanSlug]);

  useEffect(() => {
    const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const vertical = (params?.get('vertical') || '').toUpperCase();
    if (['STATIC', 'APPOINTMENT', 'ECOMMERCE'].includes(vertical)) {
      setDetails((prev) => ({ ...prev, vertical, launchGoal: vertical === 'ECOMMERCE' ? 'sales' : vertical === 'APPOINTMENT' ? 'bookings' : 'publish' }));
    }
  }, []);

  useEffect(() => {
    axios.get('/api/auth/me', { withCredentials: true })
      .then(async ({ data }) => {
        if (data.user.businessId) {
          try {
            const { data: ctx } = await axios.get('/api/business/context', { withCredentials: true });
            // Only leave onboarding for the admin once billing is sorted
            // (active/grace). A never-paid ONBOARDING tenant (or an EXPIRED one)
            // STAYS here to finish/reactivate — otherwise the admin's
            // onboarding-redirect bounces them straight back (infinite loop).
            if (ctx?.billingState === 'onboarding' || ctx?.billingState === 'expired') return;
            window.location.href = adminPathForSlug(ctx.business.slug);
          } catch { /* allow onboarding recovery */ }
        }
      })
      .catch(() => {
        window.location.href = `/login?redirect=${encodeURIComponent('/onboarding')}`;
      })
      .finally(() => setAuthChecking(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/geo').then((r) => r.json()).then((data) => {
      if (cancelled) return;
      const detected = (data?.country || '').toUpperCase();
      if (detected && COUNTRIES.some((c) => c.code === detected)) {
        setDetails((prev) => (prev.country === DEFAULT_COUNTRY ? { ...prev, country: detected, timezone: defaultTimezoneFor(detected) } : prev));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const def = defaultTimezoneFor(details.country);
    const countryZones = timezonesFor(details.country);
    const stillValid = countryZones.some((z) => z.tz === details.timezone);
    if (!stillValid) setDetails((prev) => ({ ...prev, timezone: def }));
  }, [details.country, details.timezone]);

  useEffect(() => {
    if (slugEdited) return;
    const auto = slugifyLocal(details.name);
    if (auto !== details.slug) setDetails((prev) => ({ ...prev, slug: auto }));
  }, [details.name, details.slug, slugEdited]);

  useEffect(() => {
    const slug = details.slug;
    if (!slug || slug.length < 2) {
      setSlugStatus(null);
      return undefined;
    }
    setSlugStatus('checking');
    const timer = setTimeout(async () => {
      try {
        const res = await axios.get(`/api/business/check-slug?slug=${encodeURIComponent(slug)}`);
        setSlugStatus(res.data);
      } catch {
        setSlugStatus(null);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [details.slug]);

  useEffect(() => {
    (async () => {
      try {
        setPlansLoading(true);
        const params = new URLSearchParams();
        if (details.country) params.set('country', details.country);
        if (details.vertical) params.set('vertical', details.vertical);
        const url = `/api/public/pricing?${params.toString()}`;
        const pricingRes = await axios.get(url).then((r) => r.data).catch(() => null);
        if (pricingRes?.pricing) setPricing(pricingRes.pricing);
      } finally {
        setPlansLoading(false);
      }
    })();
  }, [details.country, details.vertical]);

  const region = pricing?.regions?.[0] || null;
  const symbol = region?.symbol || '$';
  const trial = pricing?.trial || null;
  const trialRequiresCard = trial ? trial.requiresCard !== false : true;
  const plans = useMemo(() => {
    const tiers = Array.isArray(pricing?.tiers) ? pricing.tiers : [];
    return tiers
      .filter((tier) => tier.slug !== 'free')
      .slice()
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map((tier) => {
        const price = region?.plans?.[tier.slug] || {};
        return {
          slug: tier.slug,
          name: tier.name,
          tagline: tier.tagline || tier.description || '',
          features: Array.isArray(tier.features) ? tier.features : [],
          highlighted: !!tier.highlighted,
          badge: tier.badge,
          trialDays: Number(tier.trialDays) > 0 ? Number(tier.trialDays) : null,
          monthly: price.monthly ?? 0,
          yearly: price.yearly ?? 0,
          isCustomPriced: !!tier.isCustomPriced,
        };
      });
  }, [pricing, region]);

  useEffect(() => {
    if (plansLoading || selectedPlanSlug || plans.length === 0) return;
    const preferred = plans.find((p) => p.highlighted && !p.isCustomPriced) || plans.find((p) => !p.isCustomPriced) || plans[0];
    if (preferred?.slug) setSelectedPlanSlug(preferred.slug);
  }, [plans, plansLoading, selectedPlanSlug]);

  // Drop a stale plan selection when the loaded set no longer contains it. Tier
  // slugs are per-vertical (e.g. `professional` vs `static-professional` vs
  // `ecom-professional`), so changing the business type or country swaps the
  // available slugs. Without this, `selectedPlanSlug` stays truthy → the
  // Continue gate passes with no real plan → "Pay & start" dead-ends with
  // "Choose a paid plan". Clearing it lets the auto-select effect re-pick.
  useEffect(() => {
    if (plansLoading || !selectedPlanSlug || plans.length === 0) return;
    if (!plans.some((p) => p.slug === selectedPlanSlug)) setSelectedPlanSlug(null);
  }, [plans, plansLoading, selectedPlanSlug]);

  useEffect(() => {
    const available = getAvailableFlat(details.vertical) || [];
    const currentIsValid = available.some((theme) => theme.key === launchPackage.design.theme);
    const first = available[0];
    if (!currentIsValid && first?.key) patchDesign({ theme: first.key });
    // patchDesign is a stable function declaration; this effect is driven by the selected vertical/theme only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [details.vertical, launchPackage.design.theme]);

  const selectedPlan = plans.find((plan) => plan.slug === selectedPlanSlug) || null;
  const selectedTrialDays = Number(selectedPlan?.trialDays) > 0 ? Number(selectedPlan.trialDays) : 0;
  const trialActive = selectedTrialDays > 0;
  const selectedColor = COLOR_OPTIONS.find((item) => item.key === launchPackage.design.color) || COLOR_OPTIONS[0];
  const selectedLayout = LAYOUT_OPTIONS.find((item) => item.key === launchPackage.design.layout) || LAYOUT_OPTIONS[0];
  const selectedEmail = EMAIL_OPTIONS.find((item) => item.key === launchPackage.email.option) || EMAIL_OPTIONS[0];

  const basicReady =
    details.name.trim().length > 0 &&
    details.slug.length >= 2 &&
    slugStatus &&
    slugStatus !== 'checking' &&
    slugStatus.available === true &&
    isLikelyEmail(details.email) &&
    details.phone.trim().length > 0 &&
    details.address.trim().length > 0 &&
    details.state.trim().length > 0 &&
    details.country.trim().length > 0;

  const customDomainName = selectedCustomDomain(launchPackage.domain);
  const domainReady =
    launchPackage.domain.mode === 'skip' ||
    (launchPackage.domain.mode === 'register' && launchPackage.domain.selected?.domainName) ||
    (launchPackage.domain.mode === 'byod' && isLikelyDomain(launchPackage.domain.byodDomain)) ||
    (launchPackage.domain.mode === 'transfer' && isLikelyDomain(launchPackage.domain.transferDomain) && launchPackage.domain.transferAuthCode.trim().length > 0);

  const emailReady =
    launchPackage.email.option === 'skip' ||
    (customDomainName &&
      mailboxBoxes(launchPackage.email).every((b) =>
        String(b.localPart || '').trim().length > 0 && isLikelyEmail(b.deliverTo || details.email)));

  const designReady = !!launchPackage.design.theme && !!launchPackage.design.layout && !!launchPackage.design.color;

  // Keyed by phase so it stays aligned with FLOW_PHASES even when a phase is
  // dropped (e.g. the 'offer' step while the reseller is paused on prod).
  const canContinueByKey = {
    scope: !!details.launchGoal,                       // Your goal
    basics: basicReady,                                // Business
    design: designReady,                               // Theme, layout, colors
    plan: !!selectedPlanSlug && !!billingCycle,        // Plan + billing cycle
    offer: domainReady && emailReady,                  // Domain + email
    start: launchPackage.acceptedTerms && !submitting, // Pay & start
  };
  const canContinueByPhase = FLOW_PHASES.map((p) => canContinueByKey[p.key]);

  let maxReachablePhase = FLOW_PHASES.length - 1;
  for (let index = 0; index < FLOW_PHASES.length - 1; index += 1) {
    if (!canContinueByPhase[index]) {
      maxReachablePhase = index;
      break;
    }
  }

  useEffect(() => {
    if (Number.isInteger(phase) && phase > maxReachablePhase) setPhase(maxReachablePhase);
  }, [maxReachablePhase, phase]);

  function patchDetails(patch) {
    setDetails((prev) => ({ ...prev, ...patch }));
  }

  function patchPackage(patch) {
    setLaunchPackage((prev) => ({ ...prev, ...patch }));
  }

  function patchDomain(patch) {
    setLaunchPackage((prev) => ({ ...prev, domain: { ...prev.domain, ...patch } }));
  }

  function patchEmail(patch) {
    setLaunchPackage((prev) => ({ ...prev, email: { ...prev.email, ...patch } }));
  }

  function requestBillingCycle(cycle) {
    setBillingCycle(cycle);
  }

  function patchDesign(patch) {
    setLaunchPackage((prev) => ({ ...prev, design: { ...prev.design, ...patch } }));
  }

  function goNext() {
    if (phase < FLOW_PHASES.length - 1 && canContinueByPhase[phase]) setPhase((p) => p + 1);
  }

  function goBack() {
    if (phase > 0) setPhase((p) => p - 1);
  }

  async function searchDomains(e) {
    e.preventDefault();
    const clean = normalizeDomain(launchPackage.domain.query || details.slug);
    if (!clean) return;
    patchDomain({ query: clean, selected: null });
    setDomainSearch({ loading: true, searched: true, error: '', results: [] });
    try {
      const slug = details.slug || 'preview';
      const res = await axios.get(`/api/storefront/${encodeURIComponent(slug)}/domain/search?q=${encodeURIComponent(clean)}`);
      setDomainSearch({ loading: false, searched: true, error: '', results: res.data.results || [] });
    } catch (err) {
      setDomainSearch({
        loading: false,
        searched: true,
        error: err.response?.data?.message || 'Could not search domains',
        results: [],
      });
    }
  }

  async function persistLaunchPreferences() {
    const { themePatch, contentPatch, emailAddress } = launchPreferencePayload({
      details,
      launchPackage,
      selectedLayout,
      selectedColor,
      selectedEmail,
    });

    await axios.put('/api/subscription/theme', themePatch, { withCredentials: true });
    await axios.put('/api/business/content', contentPatch, { withCredentials: true });
    return { emailAddress, designPreset: themePatch.designPreset };
  }

  async function launchBusiness() {
    // Terms gate. If the box isn't ticked, don't silently no-op — scroll to it
    // and flash it so the user sees what's blocking "Pay & start".
    if (!launchPackage.acceptedTerms) {
      setHighlightTerms(true);
      if (typeof document !== 'undefined') {
        const el = document.getElementById('onboarding-terms');
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const setupRes = await axios.post('/api/business/setup?onboarding=1', {
        name: details.name,
        slug: details.slug || undefined,
        vertical: details.vertical,
        category: details.category || launchPackage.design.theme || undefined,
        theme: launchPackage.design.theme || undefined,
        description: details.description,
        address: details.address,
        state: details.state,
        country: details.country,
        timezone: details.timezone,
        phone: details.phone,
        email: details.email,
        contactName: details.yourName,
        taxId: details.taxId,
        addressLine2: details.addressLine2,
        city: details.city,
        postalCode: details.postalCode,
      }, { withCredentials: true });

      const createdSlug = setupRes.data.business.slug;
      const paidPlan = plans.find((plan) => plan.slug === selectedPlanSlug && plan.slug !== 'free' && !plan.isCustomPriced);
      if (!paidPlan) {
        throw new Error('Choose a paid plan before starting checkout.');
      }
      let persistedPrefs = null;

      persistedPrefs = await persistLaunchPreferences();
      const subRes = await axios.post('/api/subscription/select', {
        tierSlug: paidPlan.slug,
        billingCycle,
        theme: launchPackage.design.theme,
        targetVertical: details.vertical,
        // Tells the backend to route a cancelled checkout back to /onboarding
        // (not the empty admin dashboard) for this never-paid tenant.
        fromOnboarding: true,
      }, { withCredentials: true });
      const tierSlug = paidPlan.slug;
      if (subRes.data?.action === 'checkout') {
        try { localStorage.removeItem(STORAGE_KEY); } catch {}
        const adminBase = adminPathForSlug(createdSlug);
        // Razorpay (India): open the embedded Checkout so the new signup returns
        // straight to their admin after authorizing — the bare hosted short_url
        // strands them on Razorpay and invites repeat authorizations. Falls back
        // to the hosted URL if Checkout.js can't load.
        if (subRes.data.gateway === 'RAZORPAY' && subRes.data.razorpaySubscriptionId && subRes.data.razorpayKeyId) {
          try {
            await openRazorpaySubscriptionCheckout({
              keyId: subRes.data.razorpayKeyId,
              subscriptionId: subRes.data.razorpaySubscriptionId,
              description: `Activate ${paidPlan.name || paidPlan.slug}`,
              prefill: { email: details.email || undefined, contact: details.phone || undefined },
              onSuccess: () => { window.location.href = `${adminBase}?tab=subscription&billing=success&gateway=razorpay`; },
              // Cancelled: keep the user IN onboarding (admin is empty until
              // they pay) — just clear the spinner and invite a retry.
              onDismiss: () => { setSubmitting(false); setError('Payment was cancelled — pick a plan to try again.'); },
            });
            return;
          } catch {
            if (subRes.data.checkoutUrl) { window.location.href = subRes.data.checkoutUrl; return; }
            // No hosted fallback either — surface an error instead of silently
            // completing onboarding as if the plan were already active.
            throw new Error('Could not open Razorpay checkout. Please try again.');
          }
        }
        if (subRes.data.checkoutUrl) {
          window.location.href = subRes.data.checkoutUrl;
          return;
        }
      }

      let domainResult = null;
      const domainMode = launchPackage.domain.mode;
      if (domainMode !== 'skip') {
        try {
          if (domainMode === 'register' && launchPackage.domain.selected?.domainName) {
            const res = await axios.post('/api/business/domains/checkout', {
              domainName: launchPackage.domain.selected.domainName,
              privacyEnabled: launchPackage.domain.privacyEnabled !== false,
              confirmPremium: launchPackage.domain.selected.premium === true,
            }, { withCredentials: true });
            if (res.data?.action === 'checkout' && res.data?.checkoutUrl) {
              window.location.href = res.data.checkoutUrl;
              return;
            }
            domainResult = { mode: domainMode, domain: res.data?.domain?.name || launchPackage.domain.selected.domainName, status: res.data?.binding?.status || res.data?.domain?.status || 'PENDING' };
          } else if (domainMode === 'byod' && launchPackage.domain.byodDomain) {
            const res = await axios.post('/api/business/domains/byod', {
              domainName: launchPackage.domain.byodDomain,
            }, { withCredentials: true });
            domainResult = { mode: domainMode, domain: res.data?.domain?.name || launchPackage.domain.byodDomain, status: res.data?.binding?.status || res.data?.domain?.status || 'BYOD' };
          } else if (domainMode === 'transfer' && launchPackage.domain.transferDomain && launchPackage.domain.transferAuthCode) {
            const res = await axios.post('/api/business/domains/transfer-in', {
              domainName: launchPackage.domain.transferDomain,
              authCode: launchPackage.domain.transferAuthCode,
            }, { withCredentials: true });
            domainResult = { mode: domainMode, domain: res.data?.domain?.name || launchPackage.domain.transferDomain, status: res.data?.domain?.status || 'TRANSFER_IN_PENDING' };
          }
        } catch (domainErr) {
          domainResult = {
            mode: domainMode,
            domain: launchPackage.domain.selected?.domainName || launchPackage.domain.byodDomain || launchPackage.domain.transferDomain || '',
            status: 'FAILED',
            message: domainErr.response?.data?.message || 'Domain setup needs attention in the admin Domains tab.',
          };
        }
      }

      // Business email mailbox (reseller) — provision the Zoho mailbox when the
      // customer chose it and a custom domain is connected. Non-fatal: failures
      // surface in the dashboard and don't block launch.
      if (launchPackage.email.option === 'mailbox') {
        const emailDomain = selectedCustomDomain(launchPackage.domain);
        if (emailDomain) {
          for (const box of mailboxBoxes(launchPackage.email)) {
            const lp = String(box.localPart || '').trim();
            if (!lp) continue;
            try {
              await axios.post('/api/business/mailbox/provision', {
                localPart: lp,
                domain: emailDomain,
                deliverTo: box.deliverTo || details.email,
              }, { withCredentials: true });
            } catch { /* mailbox issues are surfaced in the dashboard, not blocking */ }
          }
        }
      }

      let loginCode = null;
      try {
        const codeRes = await axios.post('/api/auth/generate-login-code', {}, { withCredentials: true });
        loginCode = codeRes.data.code;
      } catch {}

      try { localStorage.removeItem(STORAGE_KEY); } catch {}
      setCompletion({
        slug: createdSlug,
        name: setupRes.data.business.name,
        vertical: details.vertical,
        tierSlug,
        loginCode,
        domainResult,
        emailChoice: selectedEmail,
        emailAddress: persistedPrefs.emailAddress,
        design: {
          layout: selectedLayout.label,
          color: selectedColor.label,
          theme: launchPackage.design.theme,
          preset: persistedPrefs.designPreset,
        },
      });
      setPhase('done');
    } catch (err) {
      if (err.response?.status === 401) {
        window.location.href = `/login?redirect=${encodeURIComponent('/onboarding')}`;
        return;
      }
      setError(err.response?.data?.message || err.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (authChecking || !draftReady) {
    return <FullScreenLoader />;
  }

  if (phase === 'done' && completion) {
    return <CompletionScreen completion={completion} />;
  }

  const current = FLOW_PHASES[phase];
  const canContinue = canContinueByPhase[phase];

  return (
    <div className="min-h-screen bg-[#f6f7f9] text-gray-950">
      <header className="border-b border-gray-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <Link href="/" className="flex items-center">
            <img src="/brand/sitepresso-logo.svg" alt="Sitepresso" className="h-7 w-auto sm:h-8" />
          </Link>
          <div className="flex items-center gap-3">
            <LanguageSelector
              currentLocale={typeof document !== 'undefined' ? (document.cookie.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/)?.[1] || 'en') : 'en'}
              compact
            />
            <span className="hidden rounded-full border border-gray-200 px-3 py-1 text-xs font-semibold text-gray-500 sm:inline">Guided setup</span>
          </div>
        </div>
      </header>

      <Stepper phase={phase} setPhase={setPhase} maxReachablePhase={maxReachablePhase} />

      <main className="mx-auto w-full max-w-5xl px-4 pb-8 pt-5 sm:px-6">
        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-end justify-between gap-4 border-b border-gray-100 px-5 py-3.5 md:px-8 md:py-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">Step {phase + 1} of {FLOW_PHASES.length}</p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight text-gray-950 md:text-2xl">{current.label}</h1>
              <p className="mt-0.5 text-sm text-gray-500">{current.hint}</p>
            </div>
            <p className="hidden shrink-0 text-right text-xs text-gray-400 sm:block">{details.name || 'Your business'}<br /><span className="font-mono">{details.slug || 'your-site'}.{PLATFORM_DOMAIN}</span></p>
          </div>

          <div className="px-5 py-5 md:px-8 md:py-5">
            {current.key === 'scope' && <PhaseScope details={details} patchDetails={patchDetails} />}
            {current.key === 'basics' && (
              <PhaseBasics
                details={details}
                patchDetails={patchDetails}
                slugStatus={slugStatus}
                setSlugEdited={setSlugEdited}
              />
            )}
            {current.key === 'design' && (
              <PhaseDesign details={details} design={launchPackage.design} patchDesign={patchDesign} />
            )}
            {current.key === 'plan' && (
              <PhasePlan
                plans={plans}
                loading={plansLoading}
                selectedPlanSlug={selectedPlanSlug}
                setSelectedPlanSlug={setSelectedPlanSlug}
                billingCycle={billingCycle}
                setBillingCycle={requestBillingCycle}
                symbol={symbol}
                trialRequiresCard={trialRequiresCard}
              />
            )}
            {current.key === 'offer' && (
              <PhaseOffer
                details={details}
                domain={launchPackage.domain}
                email={launchPackage.email}
                patchDomain={patchDomain}
                patchEmail={patchEmail}
                searchDomains={searchDomains}
                searchState={domainSearch}
                symbol={symbol}
                billingCycle={billingCycle}
              />
            )}
            {current.key === 'start' && (
              <PhaseStart
                details={details}
                selectedPlan={selectedPlan}
                billingCycle={billingCycle}
                symbol={symbol}
                launchPackage={launchPackage}
                selectedEmail={selectedEmail}
                selectedLayout={selectedLayout}
                selectedColor={selectedColor}
                accepted={launchPackage.acceptedTerms}
                setAccepted={(acceptedTerms) => { patchPackage({ acceptedTerms }); if (acceptedTerms) setHighlightTerms(false); }}
                highlightTerms={highlightTerms}
                error={error}
                submitting={submitting}
                trialDays={selectedTrialDays}
                trialRequiresCard={trialRequiresCard}
              />
            )}
          </div>

          <div className="sticky bottom-0 z-10 flex items-center justify-between gap-3 rounded-b-2xl border-t border-gray-100 bg-white/95 px-5 py-3.5 backdrop-blur shadow-[0_-8px_24px_-16px_rgba(0,0,0,0.18)] md:px-8">
            <button type="button" onClick={goBack} disabled={phase === 0 || submitting} className="rounded-lg px-4 py-2.5 text-sm font-semibold text-gray-600 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40">
              Back
            </button>
            {current.key === 'start' ? (
              // NOT gated on acceptedTerms — the button stays tappable so
              // launchBusiness() can scroll to + flash the Terms box when it's
              // unticked, instead of dead-ending on a disabled button.
              <button type="button" onClick={launchBusiness} disabled={submitting} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300">
                {submitting && <Spinner small />}
                {submitting ? 'Starting…' : trialActive ? `Start ${selectedTrialDays}-day free trial` : 'Pay & start'}
              </button>
            ) : (
              <button type="button" onClick={goNext} disabled={!canContinue} className="rounded-xl bg-gray-950 px-6 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300">
                Continue
              </button>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function Stepper({ phase, setPhase, maxReachablePhase }) {
  const lastIndex = FLOW_PHASES.length - 1;
  return (
    <div className="border-b border-gray-200 bg-white/95 backdrop-blur">
      <div className="mx-auto max-w-5xl px-4 py-3 sm:px-6">
        <ol className="flex items-center">
          {FLOW_PHASES.map((item, index) => {
            const active = index === phase;
            const done = index < phase;
            const locked = index > maxReachablePhase;
            const isLast = index === lastIndex;
            return (
              <li key={item.key} className={`flex items-center ${isLast ? 'shrink-0' : 'flex-1'}`}>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => { if (!locked) setPhase(index); }}
                  aria-current={active ? 'step' : undefined}
                  title={item.label}
                  className={`group flex shrink-0 items-center gap-2 rounded-xl px-1.5 py-1.5 text-left transition ${
                    locked ? 'cursor-not-allowed' : 'hover:bg-gray-50'
                  }`}
                >
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold transition ${
                    active ? 'bg-indigo-600 text-white ring-4 ring-indigo-100' : done ? 'bg-emerald-600 text-white' : locked ? 'bg-gray-100 text-gray-300' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {done ? <Icon name="check" className="h-4 w-4" /> : index + 1}
                  </span>
                  <span className={`hidden whitespace-nowrap text-sm font-semibold lg:inline ${
                    active ? 'text-gray-950' : done ? 'text-emerald-700' : locked ? 'text-gray-300' : 'text-gray-500'
                  }`}>{item.label}</span>
                </button>
                {!isLast && (
                  <span className={`mx-1.5 h-0.5 flex-1 rounded-full sm:mx-2 ${index < phase ? 'bg-emerald-500' : 'bg-gray-200'}`} aria-hidden />
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function QuoteBox({ selectedPlan, billingCycle, symbol, launchPackage, trialDays, trialRequiresCard }) {
  const planMonthly = planMonthlyEquivalent(selectedPlan, billingCycle);
  const domain = launchPackage.domain.selected;
  const mbCount = mailboxCount(launchPackage.email);
  const mbTotal = mailboxMonthlyTotal(launchPackage.email, billingCycle);
  const paidPlanSelected = selectedPlan && selectedPlan.slug !== 'free';
  // The amount the gateway ACTUALLY charges for the plan on the selected cycle
  // (the full annual total when YEARLY) — shown here so the quote matches the
  // checkout page ("as per plan"), instead of only the per-month equivalent.
  const planRecurring = paidPlanSelected ? planToday(selectedPlan, billingCycle) : 0;
  const planPeriod = billingCycle === 'YEARLY' ? '/yr' : '/mo';
  const showTrial = Number(trialDays) > 0 && paidPlanSelected;
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-bold text-gray-950">Estimated cost</p>
      <div className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between gap-3">
          <span className="text-gray-500">Plan{selectedPlan ? ` · ${selectedPlan.name}` : ''}</span>
          <span className="font-semibold text-right">
            {paidPlanSelected ? `${formatMajor(planRecurring, symbol)}${planPeriod}` : 'Free'}
            {paidPlanSelected && billingCycle === 'YEARLY' && (
              <span className="block text-xs font-normal text-gray-400">≈ {formatMajor(planMonthly, symbol)}/mo, billed annually</span>
            )}
          </span>
        </div>
        {!RESELLER_PAUSED && (
          <>
            <div className="flex justify-between gap-3">
              <span className="text-gray-500">Email{mbCount ? ` · ${mbCount} mailbox${mbCount > 1 ? 'es' : ''}` : ''}</span>
              <span className="font-semibold">{mbCount ? `${formatMajor(mbTotal, symbol)}/mo` : 'No charge'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-gray-500">Domain{domain && billingCycle !== 'YEARLY' ? ` · ${domain.currency || ''}` : ''}</span>
              <span className="font-semibold">{domain ? (billingCycle === 'YEARLY' ? <span className="text-emerald-600">Free with annual</span> : `${formatCurrencyMinor(domain.priceMinor, domain.currency)}/yr`) : launchPackage.domain.mode === 'skip' ? 'Free subdomain' : 'Pending'}</span>
            </div>
          </>
        )}
        <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-gray-100 pt-2.5">
          <span className="font-semibold text-gray-950">Due today</span>
          <span className="text-base font-bold text-emerald-600">{showTrial ? 'Free' : (paidPlanSelected ? `${formatMajor(planRecurring, symbol)}${planPeriod}` : (mbTotal ? `${formatMajor(mbTotal, symbol)}/mo` : 'Free'))}</span>
        </div>
        {showTrial && (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-gray-500">After {trialDays}-day trial</span>
            <span className="font-semibold text-gray-950">{paidPlanSelected ? `${formatMajor(planRecurring, symbol)}${planPeriod}` : 'Free'}</span>
          </div>
        )}
        {mbCount > 0 && paidPlanSelected && (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-gray-500">Mailboxes (billed monthly)</span>
            <span className="font-semibold text-gray-950">{formatMajor(mbTotal, symbol)}/mo</span>
          </div>
        )}
      </div>
      <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">
        {showTrial ? `${trialDays}-day free trial.${trialRequiresCard ? ' A card is required; your first charge is when the trial ends.' : ' Cancel before it ends to avoid charges.'} ` : ''}
        {billingCycle === 'YEARLY' ? 'Plan billed once a year at the annual total shown. ' : 'Plan billed monthly. '}
        {RESELLER_PAUSED
          ? 'Final tax confirmed at checkout.'
          : <>Mailboxes billed monthly.{domain ? ` Domain billed yearly at the registrar in ${domain.currency || 'its own currency'}.` : ' Domain (if any) is billed yearly at the registrar.'} Final tax + availability confirmed at checkout.</>}
      </p>
    </div>
  );
}

function PhaseScope({ details, patchDetails }) {
  return (
    <div className="space-y-5">
      <PhaseIntro title="What do you want to launch?" body="This tailors your themes, plan, and setup checklist. You can change direction anytime." />
      <div className="grid gap-3 sm:grid-cols-3">
        {GOALS.map((goal) => {
          const active = details.launchGoal === goal.key;
          return (
            <button
              key={goal.key}
              type="button"
              onClick={() => patchDetails({ launchGoal: goal.key, vertical: goal.vertical })}
              className={`group flex flex-col rounded-2xl border p-5 text-left transition ${active ? 'border-indigo-600 bg-indigo-50/60 ring-2 ring-indigo-100' : 'border-gray-200 bg-white hover:border-gray-400 hover:shadow-sm'}`}
            >
              <span className={`flex h-11 w-11 items-center justify-center rounded-xl ${active ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 group-hover:bg-gray-200'}`}>
                <Icon name={goal.icon} className="h-5 w-5" />
              </span>
              <p className="mt-4 text-base font-semibold text-gray-950">{goal.label}</p>
              <p className="mt-1 text-sm text-gray-500">{goal.body}</p>
              <span className={`mt-4 inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${active ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-500'}`}>
                {active && <Icon name="check" className="h-3 w-3" />}{VERTICALS.find((v) => v.key === goal.vertical)?.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PhaseBasics({ details, patchDetails, slugStatus, setSlugEdited }) {
  function handleSlugChange(e) {
    const raw = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
    setSlugEdited(true);
    patchDetails({ slug: raw });
  }

  return (
    <div className="space-y-3.5">
      <div className="grid gap-3.5 md:grid-cols-2">
        <Field label="Business name">
          <input className={INPUT_CLASS} value={details.name} onChange={(e) => patchDetails({ name: e.target.value })} placeholder="Maple Street Dental" />
        </Field>
        <Field label="Website URL">
          <div className="flex">
            <input className={`${INPUT_CLASS} rounded-r-none border-r-0`} value={details.slug} onChange={handleSlugChange} placeholder="maple-street" />
            <span className="inline-flex items-center rounded-r-lg border border-l-0 border-gray-300 bg-gray-50 px-3 text-sm text-gray-500">.{PLATFORM_DOMAIN}</span>
          </div>
          <SlugStatus status={slugStatus} slug={details.slug} />
        </Field>
      </div>

      <div className="grid gap-3.5 md:grid-cols-2">
        <Field label="Business email">
          <input className={INPUT_CLASS} type="email" value={details.email} onChange={(e) => patchDetails({ email: e.target.value })} placeholder="owner@business.com" />
          {details.email && !isLikelyEmail(details.email) && <p className="mt-1 text-xs font-medium text-red-600">Enter a valid email address.</p>}
        </Field>
        <Field label="Your name">
          <input className={INPUT_CLASS} value={details.yourName} onChange={(e) => patchDetails({ yourName: e.target.value })} placeholder="Priya Sharma" />
        </Field>
      </div>

      <div className="grid gap-3.5 md:grid-cols-2">
        <Field label="Phone">
          <input className={INPUT_CLASS} type="tel" value={details.phone} onChange={(e) => patchDetails({ phone: e.target.value })} placeholder="+91 98765 43210" />
        </Field>
        <Field label="Country">
          <select className={INPUT_CLASS} value={details.country} onChange={(e) => patchDetails({ country: e.target.value })}>
            {COUNTRIES.map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
          </select>
          <p className="mt-1 text-xs text-gray-400">Sets your billing currency &amp; payment method. Locked after signup.</p>
        </Field>
      </div>

      <Field label="Time zone">
        <select className={INPUT_CLASS} value={details.timezone} onChange={(e) => patchDetails({ timezone: e.target.value })} disabled={timezonesFor(details.country).length === 1}>
          {timezonesFor(details.country).map((zone) => <option key={zone.tz} value={zone.tz}>{zone.label}</option>)}
        </select>
      </Field>

      {/* Country-aware address + tax id (India PIN→state/city, NZ Google search,
          US/UK/EU universal). Same component renders in Billing & Plan. */}
      <CountryAddressFields
        country={details.country}
        value={{ line1: details.address, line2: details.addressLine2, city: details.city, state: details.state, postalCode: details.postalCode }}
        onChange={(next) => patchDetails({ address: next.line1, addressLine2: next.line2, city: next.city, state: next.state, postalCode: next.postalCode })}
        taxId={details.taxId}
        onTaxIdChange={(val) => patchDetails({ taxId: val })}
        inputClass={INPUT_CLASS}
      />

      <Field label="Short description">
        <textarea className={`${INPUT_CLASS} min-h-[64px]`} value={details.description} onChange={(e) => patchDetails({ description: e.target.value })} placeholder="A short line that tells customers what you do" />
      </Field>
    </div>
  );
}

function SlugStatus({ status, slug }) {
  if (!slug || slug.length < 2) return <p className="mt-1 text-xs text-gray-400">Choose at least 2 characters.</p>;
  if (status === 'checking') return <p className="mt-1 text-xs text-gray-500">Checking availability...</p>;
  if (status?.available) return <p className="mt-1 text-xs font-medium text-emerald-700">{slug}.{PLATFORM_DOMAIN} is available.</p>;
  if (status && !status.available) return <p className="mt-1 text-xs font-medium text-red-600">{status.reason || 'This URL is not available.'}</p>;
  return null;
}

const DESIGN_SECTIONS = [
  { key: 'theme', label: 'Theme' },
  { key: 'layout', label: 'Layout' },
  { key: 'colors', label: 'Colors' },
];

function PhaseDesign({ details, design, patchDesign }) {
  // Onboarding shows only the THEME (the one design choice you can actually see
  // here — the thumbnail is what you get). Layout + colors are hidden because
  // there's no live preview at signup; they're customised in the admin after
  // launch, where changes preview live. The theme's own defaults carry through.
  return (
    <div className="space-y-5">
      <PhaseTheme details={details} design={design} patchDesign={patchDesign} />
      <p className="text-xs text-gray-500">Pick the theme closest to your business. You can fine-tune layout and colors — with a live preview — from your admin after launch.</p>
    </div>
  );
}

function maxYearlySavingsPct(plans) {
  let best = 0;
  for (const p of plans) {
    const m = Number(p.monthly) || 0;
    const y = Number(p.yearly) || 0;
    if (m > 0 && y > 0 && y < m * 12) best = Math.max(best, Math.round((1 - y / (m * 12)) * 100));
  }
  return best;
}

function PhasePlan({ plans, loading, selectedPlanSlug, setSelectedPlanSlug, billingCycle, setBillingCycle, symbol, trialRequiresCard }) {
  const annual = billingCycle === 'YEARLY';
  const savings = maxYearlySavingsPct(plans);
  const trialPlans = plans.filter((plan) => Number(plan.trialDays) > 0 && !plan.isCustomPriced && plan.slug !== 'free');
  const allPaidPlansHaveTrial = trialPlans.length > 0 && trialPlans.length === plans.filter((plan) => !plan.isCustomPriced && plan.slug !== 'free').length;
  const maxTrialDays = trialPlans.reduce((max, plan) => Math.max(max, Number(plan.trialDays) || 0), 0);
  const uniqueTrialDays = new Set(trialPlans.map((plan) => Number(plan.trialDays) || 0));
  const trialHeadline = allPaidPlansHaveTrial && uniqueTrialDays.size === 1
    ? `${maxTrialDays}-day free trial on paid plans.`
    : allPaidPlansHaveTrial
      ? 'Free trial on paid plans.'
      : 'Trial availability is set per plan.';
  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <PhaseIntro
          title="Choose your plan"
          body={trialPlans.length
            ? `${allPaidPlansHaveTrial ? 'Every paid plan includes' : 'Some plans include'} a free trial. Switch between monthly and yearly — prices update instantly. Cancel anytime before a trial ends and you won't be charged.`
            : 'Switch between monthly and yearly — prices update instantly. Cancel anytime.'}
        />
        <div className="inline-flex shrink-0 items-center rounded-xl border border-gray-200 bg-gray-50 p-1">
          {[['MONTHLY', 'Monthly'], ['YEARLY', 'Yearly']].map(([cycle, label]) => {
            const on = billingCycle === cycle;
            return (
              <button key={cycle} type="button" onClick={() => setBillingCycle(cycle)} className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold transition ${on ? 'bg-white text-gray-950 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
                {label}
                {cycle === 'YEARLY' && savings > 0 && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${on ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-50 text-emerald-600'}`}>Save {savings}%</span>}
              </button>
            );
          })}
        </div>
      </div>

      {trialPlans.length > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-indigo-200 bg-indigo-50 p-3.5 text-sm text-indigo-900">
          <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
          <span>
            <span className="font-semibold">{trialHeadline}</span>{' '}
            {trialRequiresCard
              ? 'A card is required to start — you won’t be charged until the trial ends, and you can cancel anytime before then.'
              : 'Cancel anytime before it ends and you won’t be charged.'}
          </span>
        </div>
      )}

      <div className={`flex items-center gap-2 rounded-xl border p-3 text-sm ${annual ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-gray-200 bg-gray-50 text-gray-600'}`}>
        <Icon name="check" className={`h-4 w-4 shrink-0 ${annual ? 'text-emerald-600' : 'text-gray-400'}`} />
        <span>
          {annual
            ? <><span className="font-semibold">Best value:</span> yearly billing lowers your plan cost. Domains and mailboxes use their own secure checkout when you add them.</>
            : <><span className="font-semibold">Monthly selected:</span> domains and mailboxes stay separate paid add-ons, confirmed at checkout before setup starts.</>}
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {loading && [0, 1, 2].map((i) => <div key={i} className="h-72 rounded-2xl border border-gray-200 bg-gray-50 animate-pulse" />)}
        {!loading && plans.map((plan) => {
          const selected = selectedPlanSlug === plan.slug;
          const isFree = plan.slug === 'free';
          const planTrialDays = Number(plan.trialDays) || 0;
          const perMonth = planMonthlyEquivalent(plan, billingCycle);
          const yearlyTotal = Number(plan.yearly) || Number(plan.monthly) * 12 || 0;
          return (
            <button
              key={plan.slug}
              type="button"
              disabled={plan.isCustomPriced}
              onClick={() => !plan.isCustomPriced && setSelectedPlanSlug(plan.slug)}
              className={`relative flex flex-col rounded-2xl border p-5 text-left transition ${selected ? 'border-indigo-600 bg-indigo-50/50 ring-2 ring-indigo-100' : 'border-gray-200 bg-white hover:border-gray-400 hover:shadow-sm'} disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {plan.highlighted && <span className="absolute -top-2.5 left-5 rounded-full bg-indigo-600 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">{plan.badge || 'Most popular'}</span>}
              <p className="text-base font-semibold text-gray-950">{plan.name}</p>
              <p className="mt-1 min-h-[2.5rem] text-sm text-gray-500">{plan.tagline}</p>
              <div className="mt-3">
                {plan.isCustomPriced ? (
                  <p className="text-2xl font-bold text-gray-950">Talk to us</p>
                ) : isFree ? (
                  <p className="text-3xl font-bold text-gray-950">Free</p>
                ) : (
                  <>
                    <p className="text-3xl font-bold text-gray-950">{formatMajor(perMonth, symbol)}<span className="text-base font-medium text-gray-400">/mo</span></p>
                    <p className="mt-0.5 text-xs text-gray-500">{annual ? `${formatMajor(yearlyTotal, symbol)} billed yearly` : 'billed monthly'}</p>
                  </>
                )}
              </div>
              {planTrialDays > 0 && !plan.isCustomPriced && !isFree && (
                <p className="mt-2 inline-flex items-center gap-1 self-start rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                  {planTrialDays}-day free trial{trialRequiresCard ? ' · card required' : ''}
                </p>
              )}
              <ul className="mt-4 space-y-2 text-sm text-gray-600">
                {plan.features.slice(0, 5).map((feature, index) => (
                  <li key={index} className="flex gap-2"><Icon name="check" className={`mt-0.5 h-4 w-4 shrink-0 ${selected ? 'text-indigo-600' : 'text-emerald-500'}`} /><span>{feature}</span></li>
                ))}
              </ul>
              <span className={`mt-5 inline-flex w-full items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold ${selected ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700'}`}>
                {selected ? 'Selected' : plan.isCustomPriced ? 'Contact sales' : 'Select plan'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const OFFER_SECTIONS = [
  { key: 'domain', label: 'Domain' },
  { key: 'email', label: 'Email' },
];

function PhaseOffer({ details, domain, email, patchDomain, patchEmail, searchDomains, searchState, symbol, billingCycle }) {
  const [section, setSection] = useState('domain');
  const annual = billingCycle === 'YEARLY';
  const status = { domain: domain.mode !== 'skip', email: email.option === 'mailbox' };
  // When the reseller is paused, only the "domain" section exists (connect /
  // free subdomain) — no buy/transfer and no business-email purchase.
  const sections = RESELLER_PAUSED ? OFFER_SECTIONS.filter((s) => s.key !== 'email') : OFFER_SECTIONS;
  const activeSection = RESELLER_PAUSED ? 'domain' : section;
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-gradient-to-r from-emerald-50 to-teal-50 p-3.5">
        <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
        <p className="text-sm text-emerald-900">
          {RESELLER_PAUSED ? (
            <>
              <span className="font-semibold">Your free URL is ready.</span>{' '}
              Already own a domain? Connect it here and point your DNS to us — there’s no charge to connect, and you can also do it anytime from your admin.
            </>
          ) : (
            <>
              <span className="font-semibold">Payment-safe setup:</span>{' '}
              You set up your plan first. A custom domain or business email opens its own secure checkout and only starts provisioning once payment is confirmed — so nothing is charged or set up by surprise.
            </>
          )}
        </p>
      </div>

      {sections.length > 1 && (
        <div className="inline-flex rounded-xl border border-gray-200 bg-gray-50 p-1">
          {sections.map((s) => {
            const on = activeSection === s.key;
            return (
              <button key={s.key} type="button" onClick={() => setSection(s.key)} className={`flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-semibold transition ${on ? 'bg-white text-gray-950 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
                {s.label}
                {status[s.key] && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
              </button>
            );
          })}
        </div>
      )}

      {activeSection === 'domain' && <PhaseDomain details={details} domain={domain} patchDomain={patchDomain} searchDomains={searchDomains} searchState={searchState} />}
      {activeSection === 'email' && !RESELLER_PAUSED && <PhaseEmail email={email} patchEmail={patchEmail} domain={domain} details={details} symbol={symbol} billingCycle={billingCycle} />}
    </div>
  );
}

function PhaseDomain({ details, domain, patchDomain, searchDomains, searchState }) {
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
        Your free URL stays live at <span className="font-mono font-semibold">{details.slug || 'your-site'}.{PLATFORM_DOMAIN}</span>.
      </div>
      <div className={`grid gap-3 ${RESELLER_PAUSED ? 'md:grid-cols-2' : 'md:grid-cols-4'}`}>
        {(RESELLER_PAUSED ? DOMAIN_MODES.filter((m) => m.key === 'skip' || m.key === 'byod') : DOMAIN_MODES).map((mode) => {
          const active = domain.mode === mode.key;
          return (
            <button key={mode.key} type="button" onClick={() => patchDomain({ mode: mode.key })} className={`rounded-xl border p-4 text-left transition ${active ? 'border-gray-950 bg-gray-950 text-white' : 'border-gray-200 bg-white hover:border-gray-400'}`}>
              <p className="font-semibold">{mode.label}</p>
              <p className={`mt-1 text-xs ${active ? 'text-gray-300' : 'text-gray-500'}`}>{mode.body}</p>
            </button>
          );
        })}
      </div>

      {!RESELLER_PAUSED && domain.mode === 'register' && (
        <div className="rounded-xl border border-gray-200">
          <form onSubmit={searchDomains} className="flex flex-col gap-3 border-b border-gray-100 p-4 md:flex-row">
            <div className="relative min-w-0 flex-1">
              <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input className={`${INPUT_CLASS} pl-10`} value={domain.query || details.slug} onChange={(e) => patchDomain({ query: normalizeDomain(e.target.value), selected: null })} placeholder={details.slug || 'mybusiness'} />
            </div>
            <label className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-700">
              <input type="checkbox" checked={domain.privacyEnabled !== false} onChange={(e) => patchDomain({ privacyEnabled: e.target.checked })} className="h-4 w-4 rounded border-gray-300" />
              Privacy
            </label>
            <button type="submit" disabled={searchState.loading} className="rounded-lg bg-gray-950 px-5 py-2.5 text-sm font-semibold text-white disabled:bg-gray-300">{searchState.loading ? 'Searching' : 'Search'}</button>
          </form>
          {searchState.error && <p className="m-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-600">{searchState.error}</p>}
          {!searchState.searched && !searchState.loading && <p className="px-4 py-8 text-center text-sm text-gray-500">Search to compare available domains.</p>}
          {searchState.searched && !searchState.loading && searchState.results.length === 0 && <p className="px-4 py-8 text-center text-sm text-gray-500">No options found. Try a different name.</p>}
          <div className="divide-y divide-gray-100">
            {searchState.results.map((item) => {
              const selected = domain.selected?.domainName === item.domainName;
              const disabled = !item.available || item.premium;
              return (
                <button key={item.domainName} type="button" disabled={disabled} onClick={() => patchDomain({ selected: item })} className={`grid w-full gap-3 px-4 py-3 text-left md:grid-cols-[minmax(0,1.4fr)_auto_auto] md:items-center ${selected ? 'bg-emerald-50' : 'bg-white hover:bg-gray-50'} disabled:cursor-not-allowed disabled:opacity-50`}>
                  <span>
                    <span className="block truncate font-mono text-sm font-semibold text-gray-950">{item.domainName}</span>
                    <span className="text-xs text-gray-500">{item.available ? item.premium ? 'Premium domain' : 'Available' : 'Taken'}</span>
                  </span>
                  <span className="text-sm font-semibold">{formatCurrencyMinor(item.priceMinor, item.currency)} / yr</span>
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${selected ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-600'}`}>{selected ? 'Selected' : disabled ? 'Unavailable' : 'Select'}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {domain.mode === 'byod' && (
        <Field label="Domain to connect">
          <input className={INPUT_CLASS} value={domain.byodDomain} onChange={(e) => patchDomain({ byodDomain: normalizeDomain(e.target.value) })} placeholder="www.example.com" />
          {domain.byodDomain && !isLikelyDomain(domain.byodDomain) && <p className="mt-1 text-xs font-medium text-red-600">Enter a valid domain, for example example.com.</p>}
        </Field>
      )}

      {!RESELLER_PAUSED && domain.mode === 'transfer' && (
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Domain to transfer">
            <input className={INPUT_CLASS} value={domain.transferDomain} onChange={(e) => patchDomain({ transferDomain: normalizeDomain(e.target.value) })} placeholder="example.com" />
            {domain.transferDomain && !isLikelyDomain(domain.transferDomain) && <p className="mt-1 text-xs font-medium text-red-600">Enter a valid domain, for example example.com.</p>}
          </Field>
          <Field label="Authorization code">
            <input className={INPUT_CLASS} value={domain.transferAuthCode} onChange={(e) => patchDomain({ transferAuthCode: e.target.value })} placeholder="EPP code" />
          </Field>
        </div>
      )}
    </div>
  );
}

function PhaseEmail({ email, patchEmail, domain, details, symbol, billingCycle }) {
  const customDomain = selectedCustomDomain(domain);
  const domainName = customDomain || `${details.slug || 'your-site'}.${PLATFORM_DOMAIN}`;
  const needsCustomDomain = email.option === 'mailbox' && !customDomain;
  const boxes = mailboxBoxes(email);
  const freeFirst = billingCycle === 'YEARLY';
  const monthlyTotal = mailboxMonthlyTotal(email, billingCycle);

  const updateBox = (i, patch) => patchEmail({ boxes: boxes.map((b, idx) => (idx === i ? { ...b, ...patch } : b)) });
  const addBox = () => patchEmail({ boxes: [...boxes, { localPart: '', deliverTo: '' }] });
  const removeBox = (i) => patchEmail({ boxes: boxes.filter((_, idx) => idx !== i) });

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2">
        {EMAIL_OPTIONS.map((option) => {
          const active = email.option === option.key;
          return (
            <button key={option.key} type="button" onClick={() => patchEmail({ option: option.key })} className={`rounded-xl border p-4 text-left transition ${active ? 'border-gray-950 bg-gray-950 text-white' : 'border-gray-200 bg-white hover:border-gray-400'}`}>
              <div className="flex items-start justify-between gap-3">
                <p className="font-semibold">{option.label}</p>
                <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${active ? 'bg-white text-gray-950' : 'bg-gray-100 text-gray-500'}`}>{option.key === 'mailbox' ? `${formatMajor(MAILBOX_MONTHLY_MAJOR, symbol)}/mo each` : option.price}</span>
              </div>
              <p className={`mt-2 text-sm ${active ? 'text-gray-300' : 'text-gray-500'}`}>{option.body}</p>
            </button>
          );
        })}
      </div>

      {needsCustomDomain && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          A business mailbox needs a custom domain. Add a domain above (buy, connect, or transfer), or choose “Not now.”
        </div>
      )}

      {email.option === 'mailbox' && customDomain && (
        <div className="space-y-3">
          {boxes.map((box, i) => (
            <div key={i} className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label={`Mailbox ${i + 1} address`}>
                  <div className="flex">
                    <input className={`${INPUT_CLASS} rounded-r-none border-r-0`} value={box.localPart} onChange={(e) => updateBox(i, { localPart: e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, '') })} placeholder="hello" />
                    <span className="inline-flex min-w-0 items-center truncate rounded-r-lg border border-l-0 border-gray-300 bg-white px-3 text-sm text-gray-500">@{domainName}</span>
                  </div>
                </Field>
                <Field label="Send login details to">
                  <input className={INPUT_CLASS} value={box.deliverTo} onChange={(e) => updateBox(i, { deliverTo: e.target.value })} placeholder={details.email || 'you@gmail.com'} />
                  {box.deliverTo && !isLikelyEmail(box.deliverTo) && <p className="mt-1 text-xs font-medium text-red-600">Enter a valid email address.</p>}
                </Field>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <p className="text-xs text-gray-500">We’ll create <span className="font-mono font-semibold text-gray-700">{box.localPart || 'hello'}@{domainName}</span> · {freeFirst && i === 0 ? <span className="font-semibold text-emerald-600">Free with annual plan</span> : <span>{formatMajor(MAILBOX_MONTHLY_MAJOR, symbol)}/mo</span>} · login emailed.</p>
                {boxes.length > 1 && (
                  <button type="button" onClick={() => removeBox(i)} className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50">Remove</button>
                )}
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3">
            <button type="button" onClick={addBox} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:border-gray-950 hover:bg-gray-50">
              <span className="text-base leading-none">+</span> Add another mailbox
            </button>
            <p className="text-sm font-semibold text-gray-950">
              {freeFirst && <span className="mr-1.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">1 free</span>}
              {monthlyTotal === 0 ? 'Included free' : `${formatMajor(monthlyTotal, symbol)}/mo`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function PhaseTheme({ details, design, patchDesign }) {
  const [search, setSearch] = useState('');
  const groups = getAvailableGroups(details.vertical);
  const flat = getAvailableFlat(details.vertical);
  const lower = search.toLowerCase();
  const filteredGroups = groups
    .map((group) => ({ ...group, themes: group.themes.filter((theme) => !search || theme.label.toLowerCase().includes(lower) || theme.desc.toLowerCase().includes(lower)) }))
    .filter((group) => group.themes.length > 0);

  if (details.vertical === 'ECOMMERCE') {
    return (
      <div className="space-y-5">
        <PhaseIntro title="Pick the starting theme" body="The theme seeds storefront structure, sample content, and admin vocabulary." />
        <ThemeGrid themes={flat} selected={design.theme} onSelect={(theme) => patchDesign({ theme })} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PhaseIntro title="Pick the starting theme" body="Search by industry or choose the closest fit. You can refine copy and layout after launch." />
      <input className={INPUT_CLASS} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search themes" />
      <div className="space-y-5">
        {filteredGroups.map((group) => (
          <div key={group.label}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">{group.label}</p>
            <ThemeGrid themes={group.themes} selected={design.theme} onSelect={(theme) => patchDesign({ theme })} compact />
          </div>
        ))}
      </div>
    </div>
  );
}

function ThemeGrid({ themes, selected, onSelect, compact }) {
  return (
    <div className={`grid gap-2 ${compact ? 'md:grid-cols-3 xl:grid-cols-4' : 'md:grid-cols-3'}`}>
      {themes.map((theme) => {
        const active = selected === theme.key;
        return (
          <button key={theme.key} type="button" onClick={() => onSelect(theme.key)} className={`min-h-[96px] rounded-xl border p-3 text-left transition ${active ? 'border-gray-950 bg-gray-950 text-white' : 'border-gray-200 bg-white hover:border-gray-400'}`}>
            <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold ${active ? 'bg-white text-gray-950' : 'bg-gray-100 text-gray-600'}`}>{theme.icon}</span>
            <p className="mt-2 text-sm font-semibold">{theme.label}</p>
            <p className={`mt-1 line-clamp-2 text-xs ${active ? 'text-gray-300' : 'text-gray-500'}`}>{theme.desc}</p>
          </button>
        );
      })}
    </div>
  );
}

function PhaseLayout({ design, patchDesign }) {
  return (
    <div className="space-y-5">
      <PhaseIntro title="Choose the page rhythm" body="This controls how the first generated site is structured." />
      <div className="grid gap-3 md:grid-cols-2">
        {LAYOUT_OPTIONS.map((layout) => {
          const active = design.layout === layout.key;
          return (
            <button key={layout.key} type="button" onClick={() => patchDesign({ layout: layout.key })} className={`rounded-xl border p-4 text-left transition ${active ? 'border-gray-950 bg-gray-950 text-white' : 'border-gray-200 bg-white hover:border-gray-400'}`}>
              <LayoutPreview active={active} type={layout.key} />
              <p className="mt-3 font-semibold">{layout.label}</p>
              <p className={`mt-1 text-sm ${active ? 'text-gray-300' : 'text-gray-500'}`}>{layout.body}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LayoutPreview({ active, type }) {
  const line = active ? 'bg-white/80' : 'bg-gray-200';
  const block = active ? 'bg-white/90' : 'bg-gray-300';
  return (
    <div className={`grid h-24 gap-2 rounded-lg p-2 ${active ? 'bg-white/10' : 'bg-gray-50'}`}>
      <div className={`rounded ${block}`} />
      <div className={`grid gap-2 ${type === 'catalog' ? 'grid-cols-4' : type === 'minimal' ? 'grid-cols-1' : 'grid-cols-3'}`}>
        <div className={`rounded ${line}`} />
        <div className={`rounded ${line}`} />
        <div className={`rounded ${line}`} />
        {type === 'catalog' && <div className={`rounded ${line}`} />}
      </div>
    </div>
  );
}

function PhaseColors({ design, patchDesign }) {
  return (
    <div className="space-y-5">
      <PhaseIntro title="Select a visual tone" body="The palette becomes the starting point for buttons, accents, badges, and section styling." />
      <div className="grid gap-3 md:grid-cols-2">
        {COLOR_OPTIONS.map((color) => {
          const active = design.color === color.key;
          return (
            <button key={color.key} type="button" onClick={() => patchDesign({ color: color.key })} className={`rounded-xl border p-4 text-left transition ${active ? 'border-gray-950 bg-gray-950 text-white' : 'border-gray-200 bg-white hover:border-gray-400'}`}>
              <div className="flex gap-2">
                {color.swatches.map((swatch) => <span key={swatch} className="h-9 w-9 rounded-lg border border-black/10" style={{ backgroundColor: swatch }} />)}
              </div>
              <p className="mt-3 font-semibold">{color.label}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PhaseReview({ details, selectedPlan, billingCycle, symbol, launchPackage, selectedEmail, selectedLayout, selectedColor, trialDays, trialRequiresCard }) {
  const domainLabel = domainDisplayName(launchPackage.domain, details.slug);
  const emailAddrs = mailboxAddresses(launchPackage.email, launchPackage.domain);
  const emailLabel = emailAddrs.length
    ? (emailAddrs.length === 1 ? emailAddrs[0] : `${emailAddrs.length} mailboxes · ${emailAddrs.join(', ')}`)
    : selectedEmail.label;
  const addOns = [];
  if (launchPackage.domain.mode !== 'skip') addOns.push('Custom domain');
  if (launchPackage.email.option === 'mailbox') addOns.push('Business email');
  const paidPlanSelected = selectedPlan && selectedPlan.slug !== 'free';
  const showTrial = Number(trialDays) > 0 && paidPlanSelected;
  const planChargeAfter = paidPlanSelected
    ? `${formatMajor(planToday(selectedPlan, billingCycle), symbol)}${billingCycle === 'YEARLY' ? '/year' : '/month'}`
    : (selectedPlan ? 'Free' : 'Not selected');
  const rows = [
    ['Business', details.name],
    ['Free URL', `${details.slug}.${PLATFORM_DOMAIN}`],
    ['Model', VERTICALS.find((v) => v.key === details.vertical)?.title],
    ['Plan', selectedPlan ? `${selectedPlan.name} · ${billingCycle === 'YEARLY' ? 'Yearly' : 'Monthly'}` : 'Not selected'],
    ...(showTrial
      ? [
          ['Due today', `Free · ${trialDays}-day trial`],
          ['After trial', planChargeAfter],
        ]
      : [['Plan charge', planChargeAfter]]),
    // Domain/email aren't part of onboarding while the reseller is paused.
    ...(RESELLER_PAUSED
      ? []
      : [
          ['Offer', addOns.length ? addOns.join(' + ') : 'Free URL + plan only'],
          ['Domain', domainLabel],
          ['Email', emailLabel],
        ]),
    ['Theme', launchPackage.design.theme],
    ['Design', `${selectedLayout.label} · ${selectedColor.label}`],
  ];
  return (
    <div className="space-y-5">
      <PhaseIntro
        title={showTrial ? 'Review before you start' : 'Review before payment'}
        body={showTrial
          ? `Confirm the package before Sitepresso creates the business and starts your ${trialDays}-day free trial.`
          : RESELLER_PAUSED
          ? 'Confirm the package before Sitepresso creates the business and applies the plan.'
          : 'Confirm the package before Sitepresso creates the business, applies the plan, and starts domain actions.'}
      />
      <div className="overflow-hidden rounded-xl border border-gray-200">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-2 border-b border-gray-100 px-4 py-3 text-sm last:border-b-0 md:grid-cols-[180px_minmax(0,1fr)]">
            <p className="font-semibold text-gray-500">{label}</p>
            <p className="min-w-0 truncate font-semibold text-gray-950">{value || 'Not set'}</p>
          </div>
        ))}
      </div>
      {(showTrial || !RESELLER_PAUSED) && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {showTrial ? `Your ${trialDays}-day free trial starts at secure checkout.${trialRequiresCard ? ' A card is required to start; you won’t be charged until the trial ends, and you can cancel anytime before then.' : ''} ` : ''}
          {!RESELLER_PAUSED && 'Domains are confirmed by the registrar during checkout. Domain purchases may be non-refundable once registered.'}
        </div>
      )}
    </div>
  );
}

function PhaseStart({ details, selectedPlan, billingCycle, symbol, launchPackage, selectedEmail, selectedLayout, selectedColor, accepted, setAccepted, highlightTerms, error, submitting, trialDays, trialRequiresCard }) {
  const paidPlanSelected = selectedPlan && selectedPlan.slug !== 'free';
  const showTrial = Number(trialDays) > 0 && paidPlanSelected;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-5">
        <PhaseReview
          details={details}
          selectedPlan={selectedPlan}
          billingCycle={billingCycle}
          symbol={symbol}
          launchPackage={launchPackage}
          selectedEmail={selectedEmail}
          selectedLayout={selectedLayout}
          selectedColor={selectedColor}
          trialDays={trialDays}
          trialRequiresCard={trialRequiresCard}
        />
        <label
          id="onboarding-terms"
          className={`flex items-start gap-3 rounded-xl border p-4 text-sm text-gray-700 transition-all scroll-mt-24 ${
            highlightTerms && !accepted
              ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-300 animate-pulse'
              : 'border-gray-200 bg-gray-50'
          }`}
        >
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-gray-300" disabled={submitting} />
          <span>
            {highlightTerms && !accepted && (
              <span className="mb-1 block font-semibold text-indigo-700">Please tick this box to continue.</span>
            )}
            I agree to the Terms of Service.{' '}
            {showTrial
              ? `My ${trialDays}-day free trial starts now${trialRequiresCard ? ' and a card is required; I won’t be charged until the trial ends and I can cancel anytime before then' : ''}. `
              : ''}
            {RESELLER_PAUSED
              ? 'Plan and renewal details are confirmed during checkout or in my admin setup checklist.'
              : 'Plan, domain, email, and renewal details are confirmed during checkout or in my admin setup checklist.'}
          </span>
        </label>
        {error && <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}
      </div>
      <div className="lg:sticky lg:top-24 lg:self-start">
        <QuoteBox selectedPlan={selectedPlan} billingCycle={billingCycle} symbol={symbol} launchPackage={launchPackage} trialDays={trialDays} trialRequiresCard={trialRequiresCard} />
      </div>
    </div>
  );
}

function CompletionScreen({ completion }) {
  const { slug, name, vertical, tierSlug, loginCode, domainResult, emailChoice, emailAddress, design } = completion;
  const liveUrl = `https://${slug}.${PLATFORM_DOMAIN}`;
  // Grocery (ECOMMERCE) tenants land directly in the Store Setup window so
  // their first screen is "set up your store", not the empty Overview.
  const adminUrl = adminPathForSlug(slug)
    + (String(vertical || '').toUpperCase() === 'ECOMMERCE' ? '?tab=store-setup' : '');
  const [countdown, setCountdown] = useState(8);
  const [copied, setCopied] = useState(false);

  async function goToAdmin() {
    if (loginCode) {
      try { await axios.post('/api/auth/exchange-login-code', { code: loginCode }, { withCredentials: true }); } catch {}
    }
    window.location.href = adminUrl;
  }

  useEffect(() => {
    const id = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          goToAdmin();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminUrl, loginCode]);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(liveUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  }

  return (
    <div className="min-h-screen bg-[#f6f7f9] px-4 py-10">
      <div className="mx-auto max-w-2xl rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm md:p-8">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          <Icon name="check" className="h-8 w-8" />
        </div>
        <h1 className="mt-5 text-3xl font-bold tracking-tight text-gray-950">{name} is ready for setup</h1>
        <p className="mt-2 text-gray-600">Plan: <span className="font-semibold">{tierSlug}</span>. Your safe launch URL is active.</p>
        <div className="mt-5 inline-flex max-w-full items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 font-mono text-sm text-gray-950">
          <span className="truncate">{liveUrl}</span>
          <button type="button" onClick={copyUrl} className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-semibold text-gray-700">{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <div className="mt-6 grid gap-3 text-left md:grid-cols-3">
          <StatusCard title="Domain" value={domainResult ? domainResult.status : 'Subdomain active'} body={domainResult?.message || 'Manage DNS, privacy, renewals, and primary domain in Domain Studio.'} />
          <StatusCard title="Email" value={emailAddress || emailChoice?.label || 'Skipped'} body="Complete forwarding, mailbox, or external provider DNS from the launch checklist." />
          <StatusCard title="Design" value={design?.layout || 'Theme saved'} body={`${design?.color || 'Palette'} and ${design?.preset || 'layout'} are saved to your website settings.`} />
        </div>
        <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
          Redirecting to your admin launch command center in <span className="font-bold text-gray-950">{countdown}s</span>.
        </div>
        <button type="button" onClick={goToAdmin} className="mt-5 rounded-xl bg-gray-950 px-5 py-3 text-sm font-bold text-white hover:bg-gray-800">Open admin now</button>
      </div>
    </div>
  );
}

function StatusCard({ title, value, body }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</p>
      <p className="mt-1 font-semibold text-gray-950">{value}</p>
      <p className="mt-1 text-sm text-gray-500">{body}</p>
    </div>
  );
}

function PhaseIntro({ title, body }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-950">{title}</h2>
      <p className="mt-1 text-sm text-gray-500">{body}</p>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-gray-700">{label}</span>
      {children}
    </label>
  );
}

function Spinner({ small }) {
  const size = small ? 'h-4 w-4' : 'h-8 w-8';
  return (
    <svg className={`animate-spin ${size}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

function FullScreenLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f6f7f9] text-gray-700">
      <Spinner />
    </div>
  );
}
