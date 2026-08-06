'use client';

// Platform-host fallback for the employee invite link.
//
// The real page lives in apps/ess and is served on the tenant's OWN portal host
// ({slug}.drifthr.com). That host only exists once the tenant's subdomain has
// been provisioned — and provisioning is best-effort, so a tenant whose DNS
// record was never created emails invites that land on DNS_PROBE_FINISHED_NXDOMAIN.
// A new hire cannot claim their login, and nothing about the failure is visible
// until they report it.
//
// This page exists so an invite is never hostage to DNS. It is byte-for-byte the
// same flow — read ?token=, take a password, POST /api/customer/accept-invite —
// and it works because the token is the ONLY thing that identifies the tenant:
// acceptInvite looks the invite up by tokenHash and reads businessId off the row,
// so no host, slug or session context is required.
//
// Deliberately NOT branded: this host serves every tenant, so there is no theme
// to resolve. The tenant-branded experience is still the ESS page, which is
// preferred whenever the tenant actually has a working portal host.

import { Suspense, useMemo, useState } from 'react';
import axios from 'axios';
import { useSearchParams } from 'next/navigation';

// Mirrors the backend PASSWORD_RE (inputValidation.js) and the ESS page: ≥8
// chars, one lowercase, one uppercase, one digit. Kept in lockstep so the client
// never lets through a password the server will reject.
function passwordChecks(pw) {
  const s = String(pw || '');
  return { length: s.length >= 8, lower: /[a-z]/.test(s), upper: /[A-Z]/.test(s), digit: /\d/.test(s) };
}
function isStrong(pw) {
  const c = passwordChecks(pw);
  return c.length && c.lower && c.upper && c.digit;
}

function Requirement({ ok, children }) {
  return (
    <li className={`flex items-center gap-2 text-xs ${ok ? 'text-emerald-600' : 'text-gray-400'}`}>
      <span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold">
        {ok ? '✓' : '○'}
      </span>
      {children}
    </li>
  );
}

function SetPasswordInner() {
  const params = useSearchParams();
  const token = params.get('token') || '';

  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const checks = useMemo(() => passwordChecks(pw), [pw]);
  const strong = isStrong(pw);
  const matches = pw.length > 0 && pw === confirm;
  const canSubmit = !!token && strong && matches && !submitting;

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!token) { setError('This link is missing its token. Please ask your HR team to resend the invite.'); return; }
    if (!strong) { setError('Please choose a stronger password.'); return; }
    if (!matches) { setError('The two passwords do not match.'); return; }
    setSubmitting(true);
    try {
      await axios.post('/api/customer/accept-invite', { token, password: pw }, { withCredentials: true });
      setDone(true);
    } catch (err) {
      // The backend deliberately returns ONE generic message for wrong/expired/
      // used/revoked so a link cannot be probed. Pass it straight through.
      setError(err?.response?.data?.message || 'This link is invalid or has expired. Please ask your HR team for a new invite.');
    } finally {
      setSubmitting(false);
    }
  }

  // No token at all → a friendly dead end that reveals nothing about tokens.
  if (!token) {
    return (
      <div className="mx-auto mt-24 max-w-md px-6 text-center">
        <h1 className="text-xl font-semibold text-gray-900">This link looks incomplete</h1>
        <p className="mt-2 text-sm text-gray-600">Ask your HR team to resend your invite.</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mx-auto mt-24 max-w-md px-6 text-center">
        <h1 className="text-xl font-semibold text-gray-900">Your password is set</h1>
        <p className="mt-2 text-sm text-gray-600">
          You can now sign in to your employee portal with your work email. If your HR team sent you a
          portal address, use that; otherwise ask them for the link.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-16 max-w-md px-6">
      <h1 className="text-xl font-semibold text-gray-900">Set your password</h1>
      <p className="mt-1 text-sm text-gray-600">Choose a password to finish setting up your employee account.</p>

      <form onSubmit={submit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="pw" className="block text-sm font-medium text-gray-700">New password</label>
          <input
            id="pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <ul className="space-y-1">
          <Requirement ok={checks.length}>At least 8 characters</Requirement>
          <Requirement ok={checks.lower}>A lowercase letter</Requirement>
          <Requirement ok={checks.upper}>An uppercase letter</Requirement>
          <Requirement ok={checks.digit}>A number</Requirement>
        </ul>
        <div>
          <label htmlFor="cpw" className="block text-sm font-medium text-gray-700">Confirm password</label>
          <input
            id="cpw" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          {confirm.length > 0 && !matches && <p className="mt-1 text-xs text-red-600">The two passwords do not match.</p>}
        </div>

        {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button
          type="submit" disabled={!canSubmit}
          className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {submitting ? 'Setting your password…' : 'Set password'}
        </button>
      </form>
    </div>
  );
}

export default function SetPasswordPage() {
  // useSearchParams needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={null}>
      <SetPasswordInner />
    </Suspense>
  );
}
