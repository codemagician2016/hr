'use client';

// Feature 4 — Employee portal set-password (the welcome / credential-claim page).
//
// PUBLIC (no auth, no AppShell — rendered bare like /login + /careers) so a brand
// -new hire with no session can land here from the invite link. Reads ?token=,
// asks for a password (+ confirm + a live strength check matching the backend
// rule), and POSTs to /api/customer/accept-invite. On success the backend sets
// the password, marks the invite used, and auto-issues the customer session
// cookie — so we route straight into the portal. Branded via TenantProvider.

import { Suspense, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ErrorBanner } from '@hr/ui';
import { useTenant } from '@/components/TenantProvider';
import { apiPost } from '@/lib/api';

// Mirror the backend PASSWORD_RE (inputValidation.js): ≥8 chars, one lowercase,
// one uppercase, one digit. Keep this in lockstep with validatePassword so the
// client never lets a password through that the server will reject.
function passwordChecks(pw) {
  const s = String(pw || '');
  return {
    length: s.length >= 8,
    lower: /[a-z]/.test(s),
    upper: /[A-Z]/.test(s),
    digit: /\d/.test(s),
  };
}
function isStrong(pw) {
  const c = passwordChecks(pw);
  return c.length && c.lower && c.upper && c.digit;
}

function Requirement({ ok, children }) {
  return (
    <li className="flex items-center gap-2 text-xs" style={{ color: ok ? 'var(--theme-primary)' : 'var(--theme-muted)' }}>
      <span
        aria-hidden="true"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold"
        style={{
          background: ok ? 'var(--theme-primary)' : 'transparent',
          color: ok ? 'var(--theme-on-primary)' : 'var(--theme-muted)',
          border: ok ? 'none' : '1px solid var(--theme-border)',
        }}
      >
        {ok ? '✓' : ''}
      </span>
      {children}
    </li>
  );
}

function SetPasswordInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { tenant, theme } = useTenant();
  const business = tenant?.business || {};
  // White-label brand: logo if set, else the business NAME wordmark — NEVER the
  // DriftHR vendor mark.
  const brand = tenant?.brand || {};
  const logoUrl = brand.logoUrl || theme?.logoUrl || business.logoUrl || null;
  const tenantName = brand.name || business.name || business.displayName || null;
  const name = tenantName || 'Set password';

  const token = params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const checks = useMemo(() => passwordChecks(password), [password]);
  const strong = isStrong(password);
  const matches = password.length > 0 && password === confirm;
  const canSubmit = !!token && strong && matches && !submitting;

  async function onSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError('This link is invalid or has expired. Please ask your HR team for a new invite.');
      return;
    }
    if (!strong) { setError('Please choose a stronger password.'); return; }
    if (!matches) { setError('The two passwords do not match.'); return; }
    setSubmitting(true);
    try {
      await apiPost('/api/customer/accept-invite', { token, password });
      // Backend auto-issued the session cookie — go straight into the portal.
      setDone(true);
      setTimeout(() => router.replace('/'), 600);
    } catch (err) {
      setError(err.message || 'We could not set your password. Please try again.');
      setSubmitting(false);
    }
  }

  // No token at all → friendly dead-end (do NOT reveal anything about tokens).
  const missingToken = !token;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4" style={{ background: 'var(--theme-bg)' }}>
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={name} className="h-12 w-auto max-w-[180px] object-contain" />
          ) : (
            // No logo — the business NAME (or a neutral label) as a styled
            // wordmark in the brand colour. NEVER the DriftHR vendor mark.
            <div
              className="flex h-12 items-center justify-center rounded-xl px-4 text-lg font-bold"
              style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
            >
              {tenantName || 'Welcome'}
            </div>
          )}
          <div>
            <h1 className="text-lg font-semibold" style={{ color: 'var(--theme-text)' }}>
              {tenantName ? `Welcome to ${tenantName}` : 'Welcome'}
            </h1>
            <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
              Set a password to access your employee portal.
            </p>
          </div>
        </div>

        {done ? (
          <div
            className="rounded-2xl border bg-white p-6 text-center shadow-sm"
            style={{ borderColor: 'var(--theme-border)' }}
          >
            <div
              className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full text-xl"
              style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
            >
              {'✓'}
            </div>
            <p className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
              You&apos;re all set. Taking you to your portal&hellip;
            </p>
          </div>
        ) : missingToken ? (
          <div
            className="rounded-2xl border bg-white p-6 text-center shadow-sm"
            style={{ borderColor: 'var(--theme-border)' }}
          >
            <p className="mb-3 text-sm" style={{ color: 'var(--theme-text)' }}>
              This link is invalid or has expired.
            </p>
            <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>
              Please ask your HR team to send you a fresh portal invite.
            </p>
            <a
              href="/login"
              className="mt-4 inline-block rounded-lg px-4 py-2 text-sm font-semibold"
              style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
            >
              Go to sign in
            </a>
          </div>
        ) : (
          <form
            onSubmit={onSubmit}
            className="rounded-2xl border bg-white p-5 shadow-sm"
            style={{ borderColor: 'var(--theme-border)' }}
          >
            {error && <div className="mb-3"><ErrorBanner message={error} /></div>}

            <label className="mb-3 block text-sm">
              <span className="mb-1 block font-medium" style={{ color: 'var(--theme-text)' }}>New password</span>
              <input
                type={show ? 'text' : 'password'}
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2"
                style={{ borderColor: 'var(--theme-border)' }}
              />
            </label>

            <label className="mb-2 block text-sm">
              <span className="mb-1 block font-medium" style={{ color: 'var(--theme-text)' }}>Confirm password</span>
              <input
                type={show ? 'text' : 'password'}
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2"
                style={{ borderColor: 'var(--theme-border)' }}
              />
              {confirm.length > 0 && !matches && (
                <span className="mt-1 block text-xs" style={{ color: '#dc2626' }}>Passwords don&apos;t match yet.</span>
              )}
            </label>

            <label className="mb-3 flex items-center gap-2 text-xs" style={{ color: 'var(--theme-muted)' }}>
              <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
              Show password
            </label>

            <ul className="mb-4 space-y-1">
              <Requirement ok={checks.length}>At least 8 characters</Requirement>
              <Requirement ok={checks.upper}>One uppercase letter</Requirement>
              <Requirement ok={checks.lower}>One lowercase letter</Requirement>
              <Requirement ok={checks.digit}>One number</Requirement>
            </ul>

            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full rounded-lg py-2.5 text-sm font-semibold transition disabled:opacity-50"
              style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
            >
              {submitting ? 'Setting your password…' : 'Set password & continue'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function SetPasswordPage() {
  // useSearchParams() must sit under a Suspense boundary in app-router.
  return (
    <Suspense fallback={null}>
      <SetPasswordInner />
    </Suspense>
  );
}
