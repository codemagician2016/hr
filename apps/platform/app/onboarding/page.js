'use client';

// HR company-setup wizard (hr.com/onboarding).
//
// Adapted from the DriftHR onboarding shell — same draft-persistence +
// auth-gate + stepper pattern, rebuilt for the HR vertical. Six steps:
//   1. Company    — name + country (IN / NZ)
//   2. Entity     — legal entity + statutory IDs (PAN/TAN/GSTIN for IN, IRD for NZ)
//   3. Pay calendar — IN monthly / NZ fortnightly (with sensible defaults)
//   4. Employees  — optional, skippable seed of the directory
//   5. Branding   — 1 of 5 styles + 1 of 12 brand colors + logo
//   6. Finish     — review + go to admin
//
// Wiring (all degrade gracefully if a shape differs):
//   POST /api/business/setup?onboarding=1   — create/confirm the business
//   POST /api/hr/org/entities               — legal entity + statutory IDs
//   POST /api/hr/employees                  — optional first employees
//   PUT  /api/subscription/theme            — branding (themeStyle + themeColors)
//
// PayCalendar has no public REST surface yet (managed inside the payroll
// engine), so step 3 captures the operator's intended frequency and stores
// it on the draft + surfaces it on the finish screen; it is NOT a blocker.

import { useEffect, useState } from 'react';
import axios from 'axios';
import Link from 'next/link';
import LanguageSelector from '@/components/LanguageSelector';

import { STYLES, STYLE_KEYS, DEFAULT_STYLE_KEY } from '@/lib/themeStyles';

// Brand colors (12 curated) — resolved once from the theme engine so the
// onboarding swatches match what the admin Branding panel shows.
import {
  COLOR_KEYS as ENGINE_COLOR_KEYS,
  resolveColor as engineResolveColor,
} from '@hr/theme-engine';

const STORAGE_KEY = 'hr:onboarding:v1';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const IRD_RE = /^[0-9]{8,9}$/;

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm text-gray-950 outline-none transition placeholder:text-gray-400 focus:border-indigo-600 focus:ring-2 focus:ring-indigo-100 disabled:bg-gray-50 disabled:text-gray-400';
const LABEL_CLASS = 'block text-sm font-medium text-gray-700 mb-1';

const COUNTRIES = [
  {
    code: 'IN',
    name: 'India',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    payFrequency: 'MONTHLY',
    flag: '🇮🇳',
    statutory: 'PAN, TAN & GSTIN',
  },
  {
    code: 'NZ',
    name: 'New Zealand',
    currency: 'NZD',
    timezone: 'Pacific/Auckland',
    payFrequency: 'FORTNIGHTLY',
    flag: '🇳🇿',
    statutory: 'IRD number',
  },
];

const PAY_FREQUENCY_BY_COUNTRY = {
  IN: [
    { key: 'MONTHLY', label: 'Monthly', body: 'One pay run per calendar month — the standard for India.', recommended: true },
    { key: 'SEMI_MONTHLY', label: 'Semi-monthly', body: 'Two pay runs a month (e.g. mid-month + month-end).' },
  ],
  NZ: [
    { key: 'FORTNIGHTLY', label: 'Fortnightly', body: 'A pay run every two weeks — the most common NZ cycle.', recommended: true },
    { key: 'WEEKLY', label: 'Weekly', body: 'A pay run every week.' },
    { key: 'MONTHLY', label: 'Monthly', body: 'One pay run per calendar month.' },
  ],
};

const PAY_DAY_DEFAULT = {
  MONTHLY: { label: 'Last working day of the month' },
  SEMI_MONTHLY: { label: '15th and last working day' },
  FORTNIGHTLY: { label: 'Every second Thursday' },
  WEEKLY: { label: 'Every Thursday' },
};

const BRAND_COLORS = ENGINE_COLOR_KEYS.map((key) => {
  let hex = '#4F46E5';
  try {
    const resolved = engineResolveColor(key);
    hex = typeof resolved === 'string' ? resolved : (resolved?.hex || resolved?.primary || hex);
  } catch { /* fall back to default */ }
  return { key, hex, label: key.charAt(0).toUpperCase() + key.slice(1) };
});

const STYLE_OPTIONS = STYLE_KEYS.map((key) => {
  const style = STYLES[key] || {};
  return { key, label: style.label || style.name || key, primaryColor: style.primaryColor, bgColor: style.bgColor, textColor: style.textColor };
});

const STEPS = [
  { key: 'company', label: 'Company', hint: 'Name and country' },
  { key: 'entity', label: 'Legal entity', hint: 'Statutory registration details' },
  { key: 'paycal', label: 'Pay calendar', hint: 'How often you run payroll' },
  { key: 'people', label: 'Employees', hint: 'Add a few now — or skip', optional: true },
  { key: 'branding', label: 'Branding', hint: 'Style, color and logo' },
  { key: 'finish', label: 'Finish', hint: 'Review and launch' },
];

const DEFAULT_STATE = {
  // Step 1
  companyName: '',
  country: 'IN',
  // Step 2
  entityCode: '',
  legalName: '',
  tradeName: '',
  pan: '',
  tan: '',
  gstin: '',
  cin: '',
  nzbn: '',
  irdEntityNumber: '',
  // Step 3
  payFrequency: 'MONTHLY',
  // Step 4
  employees: [],
  // Step 5
  styleKey: DEFAULT_STYLE_KEY,
  colorKey: BRAND_COLORS[0]?.key || 'indigo',
  logoDataUrl: '',
};

// `/dashboard` is the JWT-scoped admin that exists ONLY on the unified admin
// host (app.*). On the marketing host the tenant admin is /<slug>/admin, which
// middleware bounces to the hr-admin app. Mirror the login flow's helper so
// signup→onboarding and login agree on where an already-set-up user lands.
function isUnifiedAdminHost() {
  return typeof window !== 'undefined' && window.location.hostname.startsWith('app.');
}

function slugify(value, max = 60) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, max)
    .replace(/^-+|-+$/g, '');
}

function entityCodeFor(country, name) {
  const base = slugify(name, 10).toUpperCase().replace(/-/g, '') || 'HQ';
  return `${country}-${base}`.slice(0, 16);
}

function Icon({ name, className = 'h-4 w-4' }) {
  const common = { className, fill: 'none', viewBox: '0 0 24 24', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  if (name === 'check') return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
  if (name === 'building') return <svg {...common}><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M9 7h.01M15 7h.01M9 11h.01M15 11h.01M9 15h6v6H9z" /></svg>;
  if (name === 'people') return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 6a3 3 0 0 1 0 6M21 20a5 5 0 0 0-4-4.9" /></svg>;
  if (name === 'calendar') return <svg {...common}><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></svg>;
  if (name === 'palette') return <svg {...common}><path d="M12 3a9 9 0 0 0 0 18h1.2a1.8 1.8 0 0 0 1.2-3.1 1.8 1.8 0 0 1 1.2-3.1H18a6 6 0 0 0 0-12h-6Z" /></svg>;
  return <svg {...common}><path d="M12 3v18M3 12h18" /></svg>;
}

export default function OnboardingPage() {
  const [authChecking, setAuthChecking] = useState(true);
  const [draftReady, setDraftReady] = useState(false);
  const [step, setStep] = useState(0);
  const [s, setS] = useState(DEFAULT_STATE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const [savedBusiness, setSavedBusiness] = useState(null); // { slug, name } once setup runs

  const country = COUNTRIES.find((c) => c.code === s.country) || COUNTRIES[0];

  useEffect(() => { document.title = 'Set up your company · HR'; }, []);

  // Restore draft.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.s) setS((prev) => ({ ...prev, ...parsed.s, employees: Array.isArray(parsed.s.employees) ? parsed.s.employees : [] }));
        if (Number.isInteger(parsed.step)) setStep(Math.max(0, Math.min(STEPS.length - 1, parsed.step)));
      }
    } catch { /* ignore */ } finally { setDraftReady(true); }
  }, []);

  // Persist draft (skip the logo data-url to stay under storage quota).
  useEffect(() => {
    if (!draftReady) return;
    try {
      const { logoDataUrl, ...rest } = s;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ s: rest, step }));
    } catch { /* private mode */ }
  }, [s, step, draftReady]);

  // Auth gate — same recovery flow as the DriftHR shell.
  useEffect(() => {
    axios.get('/api/auth/me', { withCredentials: true })
      .then(async ({ data }) => {
        if (data?.user?.businessId) {
          try {
            const { data: ctx } = await axios.get('/api/business/context', { withCredentials: true });
            if (ctx?.billingState === 'onboarding' || ctx?.billingState === 'expired') return;
            // Already fully set up → into the admin. Mirror the login flow:
            // `/dashboard` exists ONLY on the unified admin host (app.*). On the
            // marketing host we send them to /<slug>/admin (same-origin so the
            // auth cookie rides along; middleware bounces that to the hr-admin
            // app), falling back to /onboarding when the slug can't be resolved.
            if (isUnifiedAdminHost()) {
              window.location.href = '/dashboard';
              return;
            }
            const slug = ctx?.business?.slug || data?.user?.businessSlug || null;
            window.location.href = slug ? `/${slug}/admin` : '/onboarding';
          } catch { /* allow onboarding recovery */ }
        }
      })
      .catch(() => { window.location.href = `/login?redirect=${encodeURIComponent('/onboarding')}`; })
      .finally(() => setAuthChecking(false));
  }, []);

  // Keep pay frequency aligned with the country default whenever country changes.
  useEffect(() => {
    const allowed = (PAY_FREQUENCY_BY_COUNTRY[s.country] || []).map((f) => f.key);
    if (!allowed.includes(s.payFrequency)) patch({ payFrequency: country.payFrequency });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.country]);

  // Default the entity code/legal name from the company name once.
  useEffect(() => {
    if (!s.companyName) return;
    patch((prev) => ({
      entityCode: prev.entityCode || entityCodeFor(s.country, s.companyName),
      legalName: prev.legalName || s.companyName,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.companyName, s.country]);

  function patch(arg) {
    setS((prev) => ({ ...prev, ...(typeof arg === 'function' ? arg(prev) : arg) }));
  }

  // ---- Per-step validity --------------------------------------------------
  const companyReady = s.companyName.trim().length >= 2 && !!s.country;

  const entityReady = (() => {
    if (!s.legalName.trim() || !s.entityCode.trim()) return false;
    if (s.country === 'IN') {
      // PAN is the minimum statutory ID for an Indian employer; TAN/GSTIN are
      // format-validated only when present (TAN is needed before TDS filing).
      if (!s.pan.trim() || !PAN_RE.test(s.pan.trim().toUpperCase())) return false;
      if (s.tan.trim() && !TAN_RE.test(s.tan.trim().toUpperCase())) return false;
      if (s.gstin.trim() && !GSTIN_RE.test(s.gstin.trim().toUpperCase())) return false;
      return true;
    }
    // NZ — employer IRD number is the statutory minimum.
    return !!s.irdEntityNumber.trim() && IRD_RE.test(s.irdEntityNumber.trim());
  })();

  const readyByStep = {
    company: companyReady,
    entity: entityReady,
    paycal: !!s.payFrequency,
    people: true, // optional/skippable
    branding: !!s.styleKey && !!s.colorKey,
    finish: true,
  };
  const canContinue = STEPS.map((st) => readyByStep[st.key]);

  let maxReachable = STEPS.length - 1;
  for (let i = 0; i < STEPS.length - 1; i += 1) {
    if (!canContinue[i]) { maxReachable = i; break; }
  }
  useEffect(() => {
    if (typeof step === 'number' && step > maxReachable) setStep(maxReachable);
  }, [maxReachable, step]);

  function goNext() { if (step < STEPS.length - 1 && canContinue[step]) setStep((p) => p + 1); }
  function goBack() { if (step > 0) setStep((p) => p - 1); }

  // ---- Submit -------------------------------------------------------------
  async function finish() {
    setSubmitting(true);
    setError('');
    try {
      // 1) Business setup (idempotent for the current session's tenant).
      let business = savedBusiness;
      if (!business) {
        const setupRes = await axios.post('/api/business/setup?onboarding=1', {
          name: s.companyName,
          slug: slugify(s.companyName) || undefined,
          country: s.country,
          timezone: country.timezone,
          vertical: 'STATIC',
          description: `${s.companyName} — HR & payroll`,
        }, { withCredentials: true });
        business = setupRes.data?.business || { name: s.companyName, slug: slugify(s.companyName) };
        setSavedBusiness(business);
      }

      // 2) Legal entity + statutory IDs. Non-fatal: if the endpoint shape
      //    differs or the entity already exists, surface a note but continue.
      let entityResult = { ok: false };
      try {
        const entityBody = {
          code: s.entityCode.trim().toUpperCase(),
          legalName: s.legalName.trim(),
          tradeName: s.tradeName.trim() || undefined,
          countryCode: s.country,
          payCurrency: country.currency,
          timezone: country.timezone,
          activeFrom: new Date().toISOString(),
        };
        if (s.country === 'IN') {
          if (s.pan.trim()) entityBody.pan = s.pan.trim().toUpperCase();
          if (s.tan.trim()) entityBody.tan = s.tan.trim().toUpperCase();
          if (s.gstin.trim()) entityBody.gstin = s.gstin.trim().toUpperCase();
          if (s.cin.trim()) entityBody.cin = s.cin.trim().toUpperCase();
        } else {
          if (s.irdEntityNumber.trim()) entityBody.irdEntityNumber = s.irdEntityNumber.trim();
          if (s.nzbn.trim()) entityBody.nzbn = s.nzbn.trim();
        }
        const er = await axios.post('/api/hr/org/entities', entityBody, { withCredentials: true });
        entityResult = { ok: true, id: er.data?.id, code: entityBody.code };
      } catch (entErr) {
        entityResult = { ok: false, message: entErr.response?.data?.message || 'Entity will need finishing in HR · Org.' };
      }

      // 3) Optional first employees. Each is independent + non-blocking.
      let employeesCreated = 0;
      for (const emp of s.employees) {
        const firstName = String(emp.firstName || '').trim();
        const lastName = String(emp.lastName || '').trim();
        const code = String(emp.code || '').trim() || slugify(`${firstName}-${lastName}`, 20).toUpperCase().replace(/-/g, '') || undefined;
        if (!firstName || !lastName || !code) continue;
        try {
          await axios.post('/api/hr/employees', {
            code,
            firstName,
            lastName,
            workEmail: emp.email?.trim() || undefined,
          }, { withCredentials: true });
          employeesCreated += 1;
        } catch { /* skip the bad row, keep going */ }
      }

      // 4) Branding — themeStyle + brand color. Non-fatal.
      let brandingOk = false;
      try {
        const selectedColor = BRAND_COLORS.find((c) => c.key === s.colorKey) || BRAND_COLORS[0];
        await axios.put('/api/subscription/theme', {
          themeStyle: s.styleKey,
          themeColors: { primary: selectedColor.hex, accent: selectedColor.hex },
        }, { withCredentials: true });
        brandingOk = true;
      } catch { /* surfaced in admin Branding */ }

      try { localStorage.removeItem(STORAGE_KEY); } catch {}

      setDone({
        name: business.name || s.companyName,
        slug: business.slug,
        country: country.name,
        entity: entityResult,
        payFrequency: s.payFrequency,
        payDay: PAY_DAY_DEFAULT[s.payFrequency]?.label,
        employeesCreated,
        brandingOk,
        styleLabel: STYLE_OPTIONS.find((x) => x.key === s.styleKey)?.label,
        colorLabel: BRAND_COLORS.find((c) => c.key === s.colorKey)?.label,
      });
      setStep('done');
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

  if (authChecking || !draftReady) return <FullScreenLoader />;
  if (step === 'done' && done) return <CompletionScreen done={done} />;

  const current = STEPS[step];

  return (
    <div className="min-h-screen bg-[#f6f7f9] text-gray-950">
      <header className="border-b border-gray-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white"><Icon name="people" className="h-5 w-5" /></span>
            <span className="text-lg font-bold tracking-tight">HR</span>
          </Link>
          <div className="flex items-center gap-3">
            <LanguageSelector
              currentLocale={typeof document !== 'undefined' ? (document.cookie.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/)?.[1] || 'en') : 'en'}
              compact
            />
            <span className="hidden rounded-full border border-gray-200 px-3 py-1 text-xs font-semibold text-gray-500 sm:inline">Company setup</span>
          </div>
        </div>
      </header>

      <Stepper step={step} setStep={setStep} maxReachable={maxReachable} />

      <main className="mx-auto w-full max-w-4xl px-4 pb-8 pt-5 sm:px-6">
        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-end justify-between gap-4 border-b border-gray-100 px-5 py-3.5 md:px-8 md:py-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">Step {step + 1} of {STEPS.length}</p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight text-gray-950 md:text-2xl">{current.label}</h1>
              <p className="mt-0.5 text-sm text-gray-500">{current.hint}</p>
            </div>
            <p className="hidden shrink-0 text-right text-xs text-gray-400 sm:block">
              {s.companyName || 'Your company'}<br />
              <span className="font-mono">{country.flag} {country.name}</span>
            </p>
          </div>

          <div className="px-5 py-5 md:px-8 md:py-6">
            {current.key === 'company' && <StepCompany s={s} patch={patch} />}
            {current.key === 'entity' && <StepEntity s={s} patch={patch} country={country} />}
            {current.key === 'paycal' && <StepPayCalendar s={s} patch={patch} />}
            {current.key === 'people' && <StepPeople s={s} patch={patch} />}
            {current.key === 'branding' && <StepBranding s={s} patch={patch} />}
            {current.key === 'finish' && <StepFinish s={s} country={country} error={error} />}
          </div>

          <div className="sticky bottom-0 z-10 flex items-center justify-between gap-3 rounded-b-2xl border-t border-gray-100 bg-white/95 px-5 py-3.5 backdrop-blur shadow-[0_-8px_24px_-16px_rgba(0,0,0,0.18)] md:px-8">
            <button type="button" onClick={goBack} disabled={step === 0 || submitting} className="rounded-lg px-4 py-2.5 text-sm font-semibold text-gray-600 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40">
              Back
            </button>
            <div className="flex items-center gap-2">
              {current.optional && (
                <button type="button" onClick={goNext} disabled={submitting} className="rounded-lg px-4 py-2.5 text-sm font-semibold text-gray-500 transition hover:bg-gray-100">
                  Skip
                </button>
              )}
              {current.key === 'finish' ? (
                <button type="button" onClick={finish} disabled={submitting} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300">
                  {submitting && <Spinner small />}
                  {submitting ? 'Setting up…' : 'Finish setup'}
                </button>
              ) : (
                <button type="button" onClick={goNext} disabled={!canContinue[step]} className="rounded-xl bg-gray-950 px-6 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300">
                  Continue
                </button>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

// --------------------------------------------------------------------------
// Stepper
// --------------------------------------------------------------------------
function Stepper({ step, setStep, maxReachable }) {
  const last = STEPS.length - 1;
  return (
    <div className="border-b border-gray-200 bg-white/95 backdrop-blur">
      <div className="mx-auto max-w-4xl px-4 py-3 sm:px-6">
        <ol className="flex items-center">
          {STEPS.map((item, index) => {
            const active = index === step;
            const complete = index < step;
            const locked = index > maxReachable;
            const isLast = index === last;
            return (
              <li key={item.key} className={`flex items-center ${isLast ? 'shrink-0' : 'flex-1'}`}>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => { if (!locked) setStep(index); }}
                  aria-current={active ? 'step' : undefined}
                  title={item.label}
                  className={`group flex shrink-0 items-center gap-2 rounded-xl px-1.5 py-1.5 text-left transition ${locked ? 'cursor-not-allowed' : 'hover:bg-gray-50'}`}
                >
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold transition ${
                    active ? 'bg-indigo-600 text-white ring-4 ring-indigo-100' : complete ? 'bg-emerald-600 text-white' : locked ? 'bg-gray-100 text-gray-300' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {complete ? <Icon name="check" className="h-4 w-4" /> : index + 1}
                  </span>
                  <span className={`hidden whitespace-nowrap text-sm font-semibold lg:inline ${
                    active ? 'text-gray-950' : complete ? 'text-emerald-700' : locked ? 'text-gray-300' : 'text-gray-500'
                  }`}>{item.label}</span>
                </button>
                {!isLast && <span className={`mx-1.5 h-0.5 flex-1 rounded-full sm:mx-2 ${index < step ? 'bg-emerald-500' : 'bg-gray-200'}`} aria-hidden />}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Step 1 — Company
// --------------------------------------------------------------------------
function StepCompany({ s, patch }) {
  return (
    <div className="space-y-6">
      <div>
        <label className={LABEL_CLASS} htmlFor="companyName">Company name</label>
        <input id="companyName" className={INPUT_CLASS} value={s.companyName} maxLength={120}
          onChange={(e) => patch({ companyName: e.target.value })}
          placeholder="e.g. Acme Technologies" autoFocus />
        <p className="mt-1 text-xs text-gray-400">This is the workspace name your team will see.</p>
      </div>
      <div>
        <span className={LABEL_CLASS}>Operating country</span>
        <div className="grid gap-3 sm:grid-cols-2">
          {COUNTRIES.map((c) => {
            const selected = s.country === c.code;
            return (
              <button key={c.code} type="button" onClick={() => patch({ country: c.code })}
                className={`flex items-start gap-3 rounded-xl border p-4 text-left transition ${selected ? 'border-indigo-600 ring-2 ring-indigo-100 bg-indigo-50/40' : 'border-gray-200 hover:border-gray-300'}`}>
                <span className="text-2xl leading-none">{c.flag}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-gray-950">{c.name}</span>
                  <span className="mt-0.5 block text-xs text-gray-500">{c.currency} · {c.payFrequency.toLowerCase()} payroll · {c.statutory}</span>
                </span>
                {selected && <span className="ml-auto text-indigo-600"><Icon name="check" className="h-5 w-5" /></span>}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-gray-400">Country sets your statutory framework, currency and default pay cycle. You can add more entities later.</p>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Step 2 — Legal entity + statutory IDs
// --------------------------------------------------------------------------
function StepEntity({ s, patch, country }) {
  const isIN = s.country === 'IN';
  const fieldErr = (cond) => (cond ? 'border-red-300 focus:border-red-500 focus:ring-red-100' : '');
  return (
    <div className="space-y-6">
      <div className="rounded-lg bg-indigo-50/60 border border-indigo-100 px-4 py-3 text-xs text-indigo-800">
        <span className="font-semibold">{country.flag} {country.name}</span> — we collect your <span className="font-semibold">{country.statutory}</span> so payroll, TDS/PAYE and statutory filings are correct from day one.
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={LABEL_CLASS}>Registered legal name</label>
          <input className={INPUT_CLASS} value={s.legalName} maxLength={160}
            onChange={(e) => patch({ legalName: e.target.value })}
            placeholder={isIN ? 'Acme Technologies Pvt Ltd' : 'Acme Technologies Limited'} />
        </div>
        <div>
          <label className={LABEL_CLASS}>Entity code</label>
          <input className={INPUT_CLASS} value={s.entityCode} maxLength={16}
            onChange={(e) => patch({ entityCode: e.target.value.toUpperCase() })}
            placeholder={isIN ? 'IN-HQ' : 'NZ-AKL'} />
          <p className="mt-1 text-xs text-gray-400">A short internal code for this entity.</p>
        </div>
        <div>
          <label className={LABEL_CLASS}>Trade name <span className="text-gray-400 font-normal">(optional)</span></label>
          <input className={INPUT_CLASS} value={s.tradeName} maxLength={160}
            onChange={(e) => patch({ tradeName: e.target.value })} placeholder="Acme" />
        </div>

        {isIN ? (
          <>
            <div>
              <label className={LABEL_CLASS}>PAN <span className="text-red-500">*</span></label>
              <input className={`${INPUT_CLASS} ${fieldErr(s.pan.trim() && !PAN_RE.test(s.pan.trim().toUpperCase()))}`}
                value={s.pan} maxLength={10}
                onChange={(e) => patch({ pan: e.target.value.toUpperCase() })} placeholder="ABCDE1234F" />
              <p className="mt-1 text-xs text-gray-400">10-character Permanent Account Number.</p>
            </div>
            <div>
              <label className={LABEL_CLASS}>TAN <span className="text-gray-400 font-normal">(for TDS)</span></label>
              <input className={`${INPUT_CLASS} ${fieldErr(s.tan.trim() && !TAN_RE.test(s.tan.trim().toUpperCase()))}`}
                value={s.tan} maxLength={10}
                onChange={(e) => patch({ tan: e.target.value.toUpperCase() })} placeholder="BLRA12345E" />
              <p className="mt-1 text-xs text-gray-400">Needed before Form 24Q TDS filing.</p>
            </div>
            <div>
              <label className={LABEL_CLASS}>GSTIN <span className="text-gray-400 font-normal">(optional)</span></label>
              <input className={`${INPUT_CLASS} ${fieldErr(s.gstin.trim() && !GSTIN_RE.test(s.gstin.trim().toUpperCase()))}`}
                value={s.gstin} maxLength={15}
                onChange={(e) => patch({ gstin: e.target.value.toUpperCase() })} placeholder="29ABCDE1234F1Z5" />
            </div>
            <div>
              <label className={LABEL_CLASS}>CIN <span className="text-gray-400 font-normal">(optional)</span></label>
              <input className={INPUT_CLASS} value={s.cin} maxLength={21}
                onChange={(e) => patch({ cin: e.target.value.toUpperCase() })} placeholder="U72900KA2020PTC123456" />
            </div>
          </>
        ) : (
          <>
            <div>
              <label className={LABEL_CLASS}>IRD number <span className="text-red-500">*</span></label>
              <input className={`${INPUT_CLASS} ${fieldErr(s.irdEntityNumber.trim() && !IRD_RE.test(s.irdEntityNumber.trim()))}`}
                value={s.irdEntityNumber} maxLength={11} inputMode="numeric"
                onChange={(e) => patch({ irdEntityNumber: e.target.value.replace(/[^0-9]/g, '') })} placeholder="123456789" />
              <p className="mt-1 text-xs text-gray-400">Employer IRD number used for PAYE.</p>
            </div>
            <div>
              <label className={LABEL_CLASS}>NZBN <span className="text-gray-400 font-normal">(optional)</span></label>
              <input className={INPUT_CLASS} value={s.nzbn} maxLength={13} inputMode="numeric"
                onChange={(e) => patch({ nzbn: e.target.value.replace(/[^0-9]/g, '') })} placeholder="9429000000000" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Step 3 — Pay calendar
// --------------------------------------------------------------------------
function StepPayCalendar({ s, patch }) {
  const options = PAY_FREQUENCY_BY_COUNTRY[s.country] || PAY_FREQUENCY_BY_COUNTRY.IN;
  const payDay = PAY_DAY_DEFAULT[s.payFrequency];
  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">Choose how often you run payroll for this entity. We&rsquo;ll set up a pay calendar with a sensible pay day you can fine-tune later in HR · Payroll.</p>
      <div className="grid gap-3">
        {options.map((opt) => {
          const selected = s.payFrequency === opt.key;
          return (
            <button key={opt.key} type="button" onClick={() => patch({ payFrequency: opt.key })}
              className={`flex items-start gap-3 rounded-xl border p-4 text-left transition ${selected ? 'border-indigo-600 ring-2 ring-indigo-100 bg-indigo-50/40' : 'border-gray-200 hover:border-gray-300'}`}>
              <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-gray-300'}`}>
                {selected && <Icon name="check" className="h-3.5 w-3.5" />}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-semibold text-gray-950">
                  {opt.label}
                  {opt.recommended && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">Recommended</span>}
                </span>
                <span className="mt-0.5 block text-xs text-gray-500">{opt.body}</span>
              </span>
            </button>
          );
        })}
      </div>
      {payDay && (
        <div className="flex items-center gap-2 rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-xs text-gray-600">
          <Icon name="calendar" className="h-4 w-4 text-gray-400" />
          Default pay day: <span className="font-semibold text-gray-800">{payDay.label}</span>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Step 4 — Employees (optional)
// --------------------------------------------------------------------------
function StepPeople({ s, patch }) {
  const employees = s.employees;

  function update(i, field, value) {
    patch((prev) => {
      const next = prev.employees.slice();
      next[i] = { ...next[i], [field]: value };
      return { employees: next };
    });
  }
  function add() {
    patch((prev) => ({ employees: [...prev.employees, { code: '', firstName: '', lastName: '', email: '' }] }));
  }
  function remove(i) {
    patch((prev) => ({ employees: prev.employees.filter((_, idx) => idx !== i) }));
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">Add a few employees to seed your directory — or skip and import them in bulk later from HR · People.</p>
      {employees.length === 0 ? (
        <button type="button" onClick={add}
          className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 py-8 text-sm font-semibold text-gray-500 transition hover:border-indigo-400 hover:text-indigo-600">
          <Icon name="people" className="h-5 w-5" /> Add your first employee
        </button>
      ) : (
        <div className="space-y-3">
          {employees.map((emp, i) => (
            <div key={i} className="grid gap-2 rounded-xl border border-gray-200 p-3 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
              <input className={INPUT_CLASS} value={emp.firstName} placeholder="First name"
                onChange={(e) => update(i, 'firstName', e.target.value)} />
              <input className={INPUT_CLASS} value={emp.lastName} placeholder="Last name"
                onChange={(e) => update(i, 'lastName', e.target.value)} />
              <input className={INPUT_CLASS} value={emp.code} placeholder="Emp. code (auto)"
                onChange={(e) => update(i, 'code', e.target.value)} />
              <input className={`${INPUT_CLASS} ${emp.email && !EMAIL_RE.test(emp.email) ? 'border-red-300' : ''}`} value={emp.email} placeholder="Work email"
                onChange={(e) => update(i, 'email', e.target.value)} />
              <button type="button" onClick={() => remove(i)} title="Remove"
                className="flex h-10 w-10 items-center justify-center self-center rounded-lg border border-gray-200 text-gray-400 transition hover:border-red-300 hover:text-red-600">
                ✕
              </button>
            </div>
          ))}
          <button type="button" onClick={add}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-indigo-600 transition hover:bg-indigo-50">
            + Add another
          </button>
        </div>
      )}
      <p className="text-xs text-gray-400">Only rows with a first and last name are created. Employee codes are generated automatically when left blank.</p>
    </div>
  );
}

// --------------------------------------------------------------------------
// Step 5 — Branding
// --------------------------------------------------------------------------
function StepBranding({ s, patch }) {
  function onLogo(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => patch({ logoDataUrl: String(reader.result || '') });
    reader.readAsDataURL(file);
  }
  return (
    <div className="space-y-7">
      <div>
        <span className={LABEL_CLASS}>Visual style</span>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {STYLE_OPTIONS.map((style) => {
            const selected = s.styleKey === style.key;
            return (
              <button key={style.key} type="button" onClick={() => patch({ styleKey: style.key })}
                className={`overflow-hidden rounded-xl border text-left transition ${selected ? 'border-indigo-600 ring-2 ring-indigo-100' : 'border-gray-200 hover:border-gray-300'}`}>
                <span className="block h-14" style={{ backgroundColor: style.bgColor || '#f8fafc' }}>
                  <span className="flex h-full items-center justify-center">
                    <span className="h-5 w-12 rounded" style={{ backgroundColor: style.primaryColor || '#4f46e5' }} />
                  </span>
                </span>
                <span className="flex items-center justify-between px-2.5 py-1.5">
                  <span className="text-xs font-semibold text-gray-800">{style.label}</span>
                  {selected && <Icon name="check" className="h-3.5 w-3.5 text-indigo-600" />}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <span className={LABEL_CLASS}>Brand color</span>
        <div className="flex flex-wrap gap-2.5">
          {BRAND_COLORS.map((c) => {
            const selected = s.colorKey === c.key;
            return (
              <button key={c.key} type="button" onClick={() => patch({ colorKey: c.key })} title={c.label}
                aria-label={c.label}
                className={`flex h-10 w-10 items-center justify-center rounded-full transition ${selected ? 'ring-2 ring-offset-2 ring-gray-900' : 'hover:scale-105'}`}
                style={{ backgroundColor: c.hex }}>
                {selected && <Icon name="check" className="h-4 w-4 text-white" />}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-gray-400">Used across your admin, payslips and employee portal.</p>
      </div>

      <div>
        <span className={LABEL_CLASS}>Company logo <span className="text-gray-400 font-normal">(optional)</span></span>
        <div className="flex items-center gap-4">
          <span className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl border border-gray-200 bg-gray-50">
            {s.logoDataUrl
              ? <img src={s.logoDataUrl} alt="Logo preview" className="h-full w-full object-contain" />
              : <Icon name="building" className="h-6 w-6 text-gray-300" />}
          </span>
          <label className="cursor-pointer rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50">
            {s.logoDataUrl ? 'Replace logo' : 'Upload logo'}
            <input type="file" accept="image/*" className="hidden" onChange={onLogo} />
          </label>
          {s.logoDataUrl && (
            <button type="button" onClick={() => patch({ logoDataUrl: '' })} className="text-sm text-gray-400 hover:text-red-600">Remove</button>
          )}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Step 6 — Finish (review)
// --------------------------------------------------------------------------
function StepFinish({ s, country, error }) {
  const styleLabel = STYLE_OPTIONS.find((x) => x.key === s.styleKey)?.label;
  const colorLabel = BRAND_COLORS.find((c) => c.key === s.colorKey)?.label;
  const statutory = s.country === 'IN'
    ? [s.pan && `PAN ${s.pan}`, s.tan && `TAN ${s.tan}`, s.gstin && `GSTIN ${s.gstin}`].filter(Boolean).join(' · ')
    : [s.irdEntityNumber && `IRD ${s.irdEntityNumber}`, s.nzbn && `NZBN ${s.nzbn}`].filter(Boolean).join(' · ');
  const freqLabel = (PAY_FREQUENCY_BY_COUNTRY[s.country] || []).find((f) => f.key === s.payFrequency)?.label || s.payFrequency;
  const rows = [
    ['Company', s.companyName],
    ['Country', `${country.flag} ${country.name} · ${country.currency}`],
    ['Legal entity', `${s.legalName} (${s.entityCode})`],
    ['Statutory IDs', statutory || '—'],
    ['Pay calendar', `${freqLabel} · ${PAY_DAY_DEFAULT[s.payFrequency]?.label || ''}`],
    ['Employees seeded', s.employees.filter((e) => e.firstName && e.lastName).length || 'None (add later)'],
    ['Branding', `${styleLabel} style · ${colorLabel}`],
  ];
  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">Review your setup. You can change any of this later from your admin.</p>
      <dl className="divide-y divide-gray-100 rounded-xl border border-gray-200">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-4 px-4 py-3">
            <dt className="text-sm text-gray-500">{k}</dt>
            <dd className="text-right text-sm font-medium text-gray-900">{v}</dd>
          </div>
        ))}
      </dl>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
    </div>
  );
}

// --------------------------------------------------------------------------
// Completion + loaders
// --------------------------------------------------------------------------
function CompletionScreen({ done }) {
  // Where "Go to your dashboard" points. `/dashboard` is valid ONLY on the
  // unified admin host (app.*); on the marketing host we use the freshly
  // created tenant's /<slug>/admin (middleware bounces it to the hr-admin app).
  // Fall back to "/" rather than a guaranteed-404 /dashboard if no slug.
  const adminHref = isUnifiedAdminHost()
    ? '/dashboard'
    : (done.slug ? `/${done.slug}/admin` : '/');
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f6f7f9] px-4">
      <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
          <Icon name="check" className="h-7 w-7" />
        </div>
        <h1 className="mt-4 text-2xl font-bold tracking-tight text-gray-950">{done.name} is set up</h1>
        <p className="mt-1 text-sm text-gray-500">Your HR &amp; payroll workspace is ready.</p>

        <ul className="mt-6 space-y-2 text-left text-sm">
          <li className="flex items-center gap-2 text-gray-700"><Icon name="check" className="h-4 w-4 text-emerald-600" /> Company created in {done.country}</li>
          <li className="flex items-center gap-2 text-gray-700">
            {done.entity?.ok
              ? <><Icon name="check" className="h-4 w-4 text-emerald-600" /> Legal entity {done.entity.code} with statutory IDs</>
              : <><span className="text-amber-500 font-bold">!</span> {done.entity?.message || 'Finish your legal entity in HR · Org'}</>}
          </li>
          <li className="flex items-center gap-2 text-gray-700"><Icon name="check" className="h-4 w-4 text-emerald-600" /> {String(done.payFrequency).toLowerCase()} pay calendar — {done.payDay}</li>
          {done.employeesCreated > 0 && (
            <li className="flex items-center gap-2 text-gray-700"><Icon name="check" className="h-4 w-4 text-emerald-600" /> {done.employeesCreated} employee{done.employeesCreated === 1 ? '' : 's'} added</li>
          )}
          <li className="flex items-center gap-2 text-gray-700">
            {done.brandingOk
              ? <><Icon name="check" className="h-4 w-4 text-emerald-600" /> {done.styleLabel} style · {done.colorLabel} brand color</>
              : <><span className="text-amber-500 font-bold">!</span> Set your branding in admin</>}
          </li>
        </ul>

        <a href={adminHref}
          className="mt-7 inline-flex w-full items-center justify-center rounded-xl bg-indigo-600 px-6 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-700">
          Go to your dashboard
        </a>
      </div>
    </div>
  );
}

function FullScreenLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f6f7f9]">
      <Spinner />
    </div>
  );
}

function Spinner({ small }) {
  const size = small ? 'h-4 w-4' : 'h-8 w-8';
  return (
    <svg className={`${size} animate-spin text-indigo-600`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.4 0 0 5.4 0 12h4z" />
    </svg>
  );
}
