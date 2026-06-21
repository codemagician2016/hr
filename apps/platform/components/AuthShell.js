'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

// Two-column auth shell. Form on the left, branded marketing panel on the right.
// Right panel hides below `lg`.
export default function AuthShell({ eyebrow, title, subtitle, children, footerNote }) {
  const t = useTranslations('authShell');
  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-white">
      <div className="flex flex-col px-6 sm:px-10 lg:px-16 py-6 lg:py-10">
        <div className="flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <img
              src="/brand/sitepresso-logo.svg"
              alt="Sitepresso"
              className="h-12 w-auto sm:h-14"
            />
          </Link>
          <Link
            href="/"
            className="text-xs font-mono tracking-wider text-gray-500 hover:text-gray-900 transition-colors"
          >
            ← {t('backToSite')}
          </Link>
        </div>

        <div className="flex-1 flex items-center justify-center py-10 lg:py-14">
          <div className="w-full max-w-md">
            {eyebrow && (
              <p className="text-xs font-mono tracking-[0.18em] text-indigo-600 uppercase flex items-center gap-2 mb-4">
                <span className="inline-block w-5 h-px bg-indigo-600" />
                {eyebrow}
              </p>
            )}
            {title && (
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-gray-900 leading-tight">
                {title}
              </h1>
            )}
            {subtitle && (
              <p className="mt-2 text-sm text-gray-500">{subtitle}</p>
            )}
            <div className="mt-8">{children}</div>
          </div>
        </div>

        {footerNote && (
          <div className="text-center text-xs text-gray-400">{footerNote}</div>
        )}
      </div>

      <div className="hidden lg:flex relative overflow-hidden flex-col justify-between border-l border-gray-200 p-10 xl:p-14"
        style={{ background: 'linear-gradient(135deg, #f8fbff 0%, #ecfdf5 52%, #fff7ed 100%)' }}>
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-70" style={{
          backgroundImage: 'linear-gradient(rgba(15,23,42,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(15,23,42,0.045) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }} />

        <div className="relative max-w-xl">
          <p className="text-xs font-mono tracking-[0.24em] text-emerald-700 uppercase">
            {t('eyebrow')}
          </p>
          <h2 className="mt-5 text-4xl xl:text-5xl font-bold text-gray-950 leading-[1.05] tracking-tight">
            {t('headlineStart')} <span className="italic font-serif text-emerald-700">{t('headlineItalic')}</span>
          </h2>
          <p className="mt-5 text-gray-600 text-base leading-relaxed max-w-md">
            {t('subhead')}
          </p>
        </div>

        <div className="relative">
          <div className="rounded-lg border border-white/80 bg-white/85 p-4 shadow-2xl shadow-gray-900/10 backdrop-blur">
            <div className="rounded-lg border border-gray-200 bg-gray-950 p-3">
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                </div>
                <span className="rounded-md bg-white/10 px-3 py-1 text-[11px] font-semibold text-emerald-200">{t('mockStatus')}</span>
              </div>

              <div className="mt-4 grid gap-3 xl:grid-cols-[0.8fr_1.2fr]">
                <div className="space-y-3">
                  {[
                    ['Website', 'bg-sky-400'],
                    ['Bookings', 'bg-emerald-400'],
                    ['Shop', 'bg-amber-400'],
                  ].map(([label, color]) => (
                    <div key={label} className="rounded-lg border border-white/10 bg-white/[0.06] p-3">
                      <div className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-full ${color}`} />
                        <span className="text-xs font-semibold text-white">{label}</span>
                      </div>
                      <div className="mt-3 h-1.5 rounded-full bg-white/10">
                        <div className={`h-1.5 rounded-full ${color}`} style={{ width: label === 'Website' ? '84%' : label === 'Bookings' ? '68%' : '76%' }} />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="rounded-lg bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500">{t('mockPanelEyebrow')}</p>
                      <h3 className="mt-1 text-lg font-bold text-gray-950">{t('mockPanelTitle')}</h3>
                    </div>
                    <span className="rounded-md bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700">{t('mockPanelBadge')}</span>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    {[
                      [t('metricSites'), '24'],
                      [t('metricLeads'), '138'],
                      [t('metricSales'), '$4.8k'],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500">{label}</p>
                        <p className="mt-1 text-base font-bold text-gray-950">{value}</p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 space-y-2">
                    {[t('activityDomain'), t('activitySeo'), t('activityTheme')].map((item) => (
                      <div key={item} className="flex items-center gap-2 rounded-lg border border-gray-100 bg-white px-3 py-2 shadow-sm">
                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                        <span className="text-xs font-medium text-gray-700">{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {[t('pillFree'), t('pillDomain'), t('pillNoFees'), t('pillThemes')].map((b) => (
              <span key={b} className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-sm">
                <svg className="w-3.5 h-3.5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                {b}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Shared form-input styling — used by login/signup/forgot-password.
// Placeholder-email warning — detects autofill that landed an obvious
// dummy address in the field (anything @example.com / @example.org /
// @test.com). Browsers happily store these from past dev/test logins
// and silently autofill them on future visits, leading to "Invalid
// email or password" loops because the address belongs to no real
// account. Surfacing a visible inline warning catches the user before
// they hit Submit.
const PLACEHOLDER_EMAIL_RE = /@(example|test|sample|placeholder)\.(com|org|net|local)$/i;

function looksLikePlaceholderEmail(value) {
  return typeof value === 'string' && PLACEHOLDER_EMAIL_RE.test(value.trim());
}

export function Input({ label, error, hint, rightSlot, className = '', type, value, ...props }) {
  const [showPassword, setShowPassword] = useState(false);
  const isPassword = type === 'password';
  const effectiveType = isPassword && showPassword ? 'text' : type;

  const showPlaceholderWarning = type === 'email' && looksLikePlaceholderEmail(value);
  const effectiveError = error || (showPlaceholderWarning
    ? `That looks like a placeholder address — clear it and type your real email.`
    : null);
  return (
    <label className="block">
      {label && (
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-sm font-medium text-gray-800">{label}</span>
          {rightSlot}
        </div>
      )}
      <div className="relative">
        <input
          type={effectiveType}
          value={value}
          className={`w-full px-4 py-3 bg-white border rounded-xl text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-4 focus:ring-indigo-100 transition-shadow ${
            isPassword ? 'pr-11' : ''
          } ${
            effectiveError ? 'border-red-400 focus:border-red-500' : 'border-gray-200 focus:border-indigo-500'
          } ${className}`}
          {...props}
        />
        {isPassword && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShowPassword(v => !v)}
            className="absolute inset-y-0 right-3 flex items-center text-gray-400 hover:text-gray-600"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? (
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
              </svg>
            )}
          </button>
        )}
      </div>
      {effectiveError && <p className="mt-1.5 text-xs text-red-600">{effectiveError}</p>}
      {hint && !effectiveError && <p className="mt-1.5 text-xs text-gray-400">{hint}</p>}
    </label>
  );
}

export function PrimaryButton({ loading, children, ...props }) {
  return (
    <button
      {...props}
      disabled={loading || props.disabled}
      className={`w-full flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold text-white transition-all shadow-sm
        bg-gradient-to-r from-indigo-600 to-purple-600 hover:shadow-md hover:-translate-y-[1px]
        disabled:opacity-60 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none
        ${props.className || ''}`}
    >
      {loading && (
        <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      )}
      {children}
    </button>
  );
}

export function ErrorBanner({ message }) {
  if (!message) return null;
  return (
    <div
      className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700 animate-shake"
      role="alert"
    >
      <svg className="w-4 h-4 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M18 10A8 8 0 11 2 10a8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
      </svg>
      <span>{message}</span>
    </div>
  );
}
