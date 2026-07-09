'use client';

// Feature 38 — job detail + smart apply. Authed candidate → one-click reuse of the
// saved profile (optional resume swap). Guest → email + basic info; a returning email
// is offered a sign-in link instead of a blind duplicate.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { apiGet, apiPost, resolveTenant } from '@/lib/api';

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
}

export default function JobDetail() {
  const { publicSlug } = useParams();
  const [slug, setSlug] = useState(null);
  const [me, setMe] = useState(null);
  const [job, setJob] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => { resolveTenant().then((r) => setSlug(r?.business?.slug || null)).catch(() => {}); }, []);
  useEffect(() => { apiGet('/api/candidate/me').then(setMe).catch(() => setMe(null)); }, []);
  const load = useCallback(async () => {
    if (!slug) return;
    try { setJob((await apiGet(`/api/careers/${slug}/jobs/${publicSlug}`)).job); }
    catch (e) { setErr(e.status === 404 ? 'This role is no longer open.' : (e.message || 'Could not load the job.')); }
  }, [slug, publicSlug]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <Link href="/careers" className="text-sm text-gray-500 hover:underline">← All roles</Link>
      {err && <p className="text-sm text-red-600 mt-4">{err}</p>}
      {job && (
        <>
          <h1 className="text-2xl font-bold text-gray-900 mt-3">{job.title}</h1>
          <p className="text-xs text-gray-500 mt-1">{job.countryCode} · {String(job.employmentType || '').replace('_', ' ')} · {job.openings} opening{job.openings === 1 ? '' : 's'}</p>
          {job.description && <div className="prose prose-sm mt-4 whitespace-pre-wrap text-gray-700">{job.description}</div>}
          <ApplyBox slug={slug} publicSlug={publicSlug} me={me} />
        </>
      )}
    </div>
  );
}

function ApplyBox({ slug, publicSlug, me }) {
  const authed = !!(me && me.candidate);
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', consent: false });
  const [resume, setResume] = useState(null);
  const [state, setState] = useState({ busy: false, done: '', needsAuth: false, err: '' });
  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setState({ busy: true, done: '', needsAuth: false, err: '' });
    try {
      const body = {};
      if (!authed) Object.assign(body, form);
      if (resume) body.resumeDataUrl = await fileToDataUrl(resume);
      const r = await apiPost(`/api/careers/${slug}/jobs/${publicSlug}/apply`, body);
      if (r.needsAuth) setState({ busy: false, done: '', needsAuth: true, err: '' });
      else setState({ busy: false, done: r.message || 'Applied!', needsAuth: false, err: '' });
    } catch (e2) {
      setState({ busy: false, done: '', needsAuth: false, err: e2.status === 409 ? 'You’ve already applied to this role.' : (e2.message || 'Could not apply.') });
    }
  }

  if (state.done) return <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{state.done} <Link href="/careers/profile" className="underline">Track your applications →</Link></div>;
  if (state.needsAuth) return <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">Looks like you’ve applied before with this email — we’ve emailed a secure link to continue with your saved details and apply in one click.</div>;

  return (
    <form onSubmit={submit} className="mt-6 rounded-xl border border-gray-200 p-4 space-y-3">
      <h2 className="font-semibold text-gray-900">{authed ? `Apply as ${me.candidate.firstName || me.candidate.email}` : 'Apply'}</h2>
      {authed ? (
        <p className="text-sm text-gray-500">We’ll use your saved profile. Attach a different resume for this role if you like.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <input required placeholder="First name" value={form.firstName} onChange={set('firstName')} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
          <input required placeholder="Last name" value={form.lastName} onChange={set('lastName')} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
          <input required type="email" placeholder="Email" value={form.email} onChange={set('email')} className="px-3 py-2 border border-gray-300 rounded-lg text-sm col-span-2" />
          <input placeholder="Phone (optional)" value={form.phone} onChange={set('phone')} className="px-3 py-2 border border-gray-300 rounded-lg text-sm col-span-2" />
        </div>
      )}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Resume {authed ? '(optional — swap for this role)' : '(PDF/PNG/JPG)'}</label>
        <input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => setResume(e.target.files && e.target.files[0])} className="text-sm" />
      </div>
      {!authed && (
        <label className="flex items-start gap-2 text-xs text-gray-600">
          <input type="checkbox" checked={form.consent} onChange={set('consent')} className="mt-0.5" />
          I consent to my data being processed for recruitment.
        </label>
      )}
      {state.err && <p className="text-sm text-red-600">{state.err}</p>}
      <button type="submit" disabled={state.busy} className="px-4 py-2 rounded-lg text-sm text-white disabled:opacity-50" style={{ background: 'var(--theme-primary)' }}>
        {state.busy ? 'Submitting…' : 'Submit application'}
      </button>
    </form>
  );
}
