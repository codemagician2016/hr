'use client';

// Feature 38 — candidate CAREERS portal (board + passwordless sign-in). Served on
// the tenant host at /careers; the tenant slug comes from the resolved Host.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, apiPost, resolveTenant } from '@/lib/api';

function useSlug() {
  const [slug, setSlug] = useState(null);
  useEffect(() => {
    resolveTenant().then((r) => setSlug(r?.business?.slug || null)).catch(() => setSlug(null));
  }, []);
  return slug;
}

export default function CareersBoard() {
  const slug = useSlug();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [gated, setGated] = useState(false);

  const load = useCallback(async () => {
    if (!slug) return;
    try { setData(await apiGet(`/api/careers/${slug}/jobs`)); }
    catch (e) { if (e.status === 404) setGated(true); else setErr(e.message || 'Could not load jobs.'); }
  }, [slug]);
  useEffect(() => { load(); }, [load]);

  if (gated) return <Centered><h1 className="text-xl font-semibold">Careers</h1><p className="text-gray-500 mt-2">This careers page isn’t available.</p></Centered>;

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">{data?.business?.name ? `${data.business.name} — Careers` : 'Careers'}</h1>
        <p className="text-gray-500 mt-1">Open roles. Apply in minutes — <Link href="/careers/profile" className="underline" style={{ color: 'var(--theme-primary)' }}>sign in</Link> to reuse your details.</p>
      </header>

      <SignIn slug={slug} />

      {err && <p className="text-sm text-red-600 mb-3">{err}</p>}
      <ul className="space-y-3">
        {(data?.items || []).map((j) => (
          <li key={j.id} className="rounded-xl border border-gray-200 bg-white p-4 hover:shadow-sm">
            <Link href={`/careers/jobs/${j.publicSlug}`} className="font-medium text-gray-900 hover:underline">{j.title}</Link>
            <p className="text-xs text-gray-500 mt-1">{j.countryCode} · {String(j.employmentType || '').replace('_', ' ')} · {j.openings} opening{j.openings === 1 ? '' : 's'}</p>
          </li>
        ))}
        {data && (data.items || []).length === 0 && <p className="text-sm text-gray-500">No open roles right now — check back soon.</p>}
      </ul>
    </div>
  );
}

function SignIn({ slug }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState({ sending: false, sent: false, existing: false, err: '' });
  async function submit(e) {
    e.preventDefault();
    if (!slug) return;
    setState((s) => ({ ...s, sending: true, err: '' }));
    try {
      const r = await apiPost(`/api/careers/${slug}/auth/request`, { email });
      setState({ sending: false, sent: true, existing: !!r.existing, err: '' });
    } catch (e2) { setState({ sending: false, sent: false, existing: false, err: e2.message || 'Could not send the link.' }); }
  }
  if (state.sent) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 mb-6 text-sm text-emerald-800">
        We’ve emailed a secure sign-in link to <b>{email}</b>{state.existing ? ' — welcome back!' : ''}. Open it to {state.existing ? 'continue with your saved details' : 'set up your profile'} and apply faster.
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="rounded-xl border border-gray-200 bg-gray-50 p-4 mb-6 flex flex-col sm:flex-row gap-2 items-start sm:items-center">
      <div className="text-sm text-gray-600 sm:flex-1">Already applied here, or want a faster apply? Get a sign-in link:</div>
      <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com"
        className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-full sm:w-56" />
      <button type="submit" disabled={state.sending} className="px-3 py-2 rounded-lg text-sm text-white disabled:opacity-50" style={{ background: 'var(--theme-primary)' }}>
        {state.sending ? 'Sending…' : 'Email me a link'}
      </button>
      {state.err && <span className="text-xs text-red-600">{state.err}</span>}
    </form>
  );
}

function Centered({ children }) {
  return <div className="max-w-3xl mx-auto px-4 py-16 text-center">{children}</div>;
}
