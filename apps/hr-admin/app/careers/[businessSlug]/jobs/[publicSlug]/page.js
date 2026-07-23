'use client';

// PUBLIC job detail + apply page (Feature 12) — UNAUTHENTICATED. Renders the JD
// and the screening questions from GET /api/public/careers/:businessSlug/jobs/
// :publicSlug (which NEVER serialises points / knockout values), and posts the
// application to .../apply. The candidate sees a thank-you only — no score, no
// knockout status, nothing internal. Consent is mandatory.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { get, post } from '@/lib/api';

export default function PublicJobApplyPage() {
  const { businessSlug, publicSlug } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [trackUrl, setTrackUrl] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try { setData(await get(`/api/public/careers/${businessSlug}/jobs/${publicSlug}`)); }
    catch (e) { setError(e.status === 404 ? 'This role is no longer open.' : e.message); }
  }, [businessSlug, publicSlug]);
  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <Centered>
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
          <div className="text-lg font-semibold text-gray-900">{error}</div>
          <Link href={`/careers/${businessSlug}`} className="mt-3 inline-block text-sm" style={{ color: 'var(--theme-primary, #4f46e5)' }}>← See all open roles</Link>
        </div>
      </Centered>
    );
  }
  if (!data) return <Centered><div className="text-sm text-gray-400">Loading…</div></Centered>;

  const { business, job, screeningQuestions } = data;

  if (submitted) {
    return (
      <Centered>
        <div className="rounded-2xl border border-emerald-200 bg-white p-10 text-center shadow-sm max-w-md">
          <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 text-2xl">✓</div>
          <h1 className="text-xl font-semibold text-gray-900">Application received</h1>
          <p className="text-sm text-gray-500 mt-2">Thank you for applying to <b>{job.title}</b> at {business?.name}. Our team will be in touch if there's a match.</p>
          {trackUrl && (
            <a href={trackUrl} className="mt-5 inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-sm" style={{ background: 'var(--theme-primary, #4f46e5)' }}>
              Track your application →
            </a>
          )}
          <div className="mt-4">
            <Link href={`/careers/${businessSlug}`} className="inline-block text-sm font-medium" style={{ color: 'var(--theme-primary, #4f46e5)' }}>← See other open roles</Link>
          </div>
        </div>
      </Centered>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      <div className="max-w-2xl mx-auto px-5 py-10">
        <Link href={`/careers/${businessSlug}`} className="text-xs text-gray-500 hover:underline">← All roles</Link>
        <header className="mt-3 mb-6">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">{business?.name}</div>
          <h1 className="text-3xl font-semibold text-gray-900 mt-1">{job.title}</h1>
          <div className="text-xs text-gray-500 mt-2 flex flex-wrap gap-2">
            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5">{(job.employmentType || '').replace(/_/g, ' ') || 'Full time'}</span>
            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5">{job.countryCode}</span>
            {job.openings > 1 && <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5">{job.openings} openings</span>}
          </div>
        </header>

        {job.description && (
          <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm mb-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-2">About the role</h2>
            <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{job.description}</div>
          </section>
        )}

        <ApplyForm
          businessSlug={businessSlug} publicSlug={publicSlug}
          questions={screeningQuestions || []}
          onSubmitted={(url) => { setTrackUrl(url || null); setSubmitted(true); }}
        />

        <footer className="mt-10 text-center text-[11px] text-gray-400">Powered by DriftHR</footer>
      </div>
    </div>
  );
}

function Centered({ children }) {
  return <div className="min-h-screen bg-gray-50 flex items-center justify-center px-5">{children}</div>;
}

function ApplyForm({ businessSlug, publicSlug, questions, onSubmitted }) {
  const [d, setD] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [answers, setAnswers] = useState({}); // questionId -> value
  const [resume, setResume] = useState(null); // { dataUrl, name }
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (v) => setD((s) => ({ ...s, [k]: v }));
  const setAnswer = (qid, v) => setAnswers((s) => ({ ...s, [qid]: v }));

  function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) { setResume(null); return; }
    if (file.size > 10 * 1024 * 1024) { setError('Resume must be under 10 MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => setResume({ dataUrl: reader.result, name: file.name });
    reader.readAsDataURL(file);
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!d.firstName.trim() || !d.lastName.trim() || !d.email.trim()) { setError('Please fill in your name and email.'); return; }
    if (!consent) { setError('Please consent to your data being processed for this application.'); return; }
    setSaving(true);
    const answerList = questions
      .map((q) => ({ questionId: q.id, answerValue: answers[q.id] }))
      .filter((a) => a.answerValue !== undefined && a.answerValue !== '');
    try {
      const res = await post(`/api/public/careers/${businessSlug}/jobs/${publicSlug}/apply`, {
        firstName: d.firstName.trim(), lastName: d.lastName.trim(), email: d.email.trim(),
        phone: d.phone.trim() || undefined,
        resumeDataUrl: resume ? resume.dataUrl : undefined,
        answers: answerList, consent: true,
      });
      onSubmitted(res?.trackUrl || null);
    } catch (err) {
      setError(err.status === 409 ? 'You have already applied to this role.' : (err.message || 'Something went wrong. Please try again.'));
    } finally { setSaving(false); }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm space-y-5">
      <h2 className="text-sm font-semibold text-gray-900">Apply for this role</h2>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="grid grid-cols-2 gap-3">
        <Field label="First name" required><input value={d.firstName} onChange={(e) => set('firstName')(e.target.value)} required className="ipt" /></Field>
        <Field label="Last name" required><input value={d.lastName} onChange={(e) => set('lastName')(e.target.value)} required className="ipt" /></Field>
        <Field label="Email" required><input type="email" value={d.email} onChange={(e) => set('email')(e.target.value)} required className="ipt" /></Field>
        <Field label="Phone"><input value={d.phone} onChange={(e) => set('phone')(e.target.value)} className="ipt" /></Field>
      </div>

      <Field label="Résumé (PDF / image, optional)">
        <input type="file" accept="application/pdf,image/png,image/jpeg" onChange={onFile} className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-sm" />
        {resume && <div className="text-xs text-gray-400 mt-1">{resume.name}</div>}
      </Field>

      {questions.length > 0 && (
        <div className="space-y-4 border-t pt-4">
          <div className="text-sm font-semibold text-gray-900">A few quick questions</div>
          {questions.map((q) => (
            <Field key={q.id} label={q.prompt} required={q.required}>
              <ScreeningInput q={q} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />
            </Field>
          ))}
        </div>
      )}

      <label className="flex items-start gap-2 text-xs text-gray-600">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
        <span>I consent to {businessSlug ? 'this company' : 'the company'} processing my personal data for the purpose of this job application.</span>
      </label>

      <button type="submit" disabled={saving} className="w-full rounded-xl py-2.5 text-sm font-semibold text-white shadow-sm disabled:opacity-60" style={{ background: 'var(--theme-primary, #4f46e5)' }}>
        {saving ? 'Submitting…' : 'Submit application'}
      </button>

      <style jsx>{`
        .ipt { width: 100%; border: 1px solid #d1d5db; border-radius: 0.5rem; padding: 0.5rem 0.75rem; font-size: 0.875rem; }
        .ipt:focus { outline: none; box-shadow: 0 0 0 2px rgba(79,70,229,0.3); }
      `}</style>
    </form>
  );
}

function Field({ label, required, children }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}{required && <span className="text-red-500"> *</span>}</span>
      {children}
    </label>
  );
}

// Renders the right input for each screening-question kind. Options carry only a
// label + value (the public API strips points / knockout values).
function ScreeningInput({ q, value, onChange }) {
  const opts = q.options || [];
  if (q.kind === 'BOOLEAN') {
    return (
      <div className="flex gap-4">
        {[{ v: 'true', l: 'Yes' }, { v: 'false', l: 'No' }].map((o) => (
          <label key={o.v} className="flex items-center gap-1.5 text-sm text-gray-700">
            <input type="radio" name={q.id} checked={String(value) === o.v} onChange={() => onChange(o.v === 'true')} /> {o.l}
          </label>
        ))}
      </div>
    );
  }
  if (q.kind === 'SINGLE_CHOICE' || q.kind === 'QUALIFICATION') {
    return (
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
        <option value="">Select…</option>
        {opts.map((o) => <option key={o.id} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  if (q.kind === 'MULTI_CHOICE') {
    const arr = Array.isArray(value) ? value : [];
    const toggle = (v, on) => onChange(on ? [...arr, v] : arr.filter((x) => x !== v));
    return (
      <div className="space-y-1.5">
        {opts.map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={arr.includes(o.value)} onChange={(e) => toggle(o.value, e.target.checked)} /> {o.label}
          </label>
        ))}
      </div>
    );
  }
  if (q.kind === 'NUMBER') {
    return <input type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />;
  }
  return <textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} rows={3} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />;
}
