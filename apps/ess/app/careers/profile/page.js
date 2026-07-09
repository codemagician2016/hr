'use client';

// Feature 38 — candidate self-service profile (magic-link session). Edit personal
// details, education, work experience, skills + resume; track applications.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, apiPost, apiSend } from '@/lib/api';

function fileToDataUrl(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }

export default function CandidateProfile() {
  const [data, setData] = useState(null);
  const [apps, setApps] = useState([]);
  const [authed, setAuthed] = useState(null);

  const load = useCallback(() => {
    apiGet('/api/candidate/me').then((r) => { setData(r); setAuthed(true); }).catch(() => setAuthed(false));
    apiGet('/api/candidate/applications').then((r) => setApps(r.items || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  if (authed === false) {
    return <div className="max-w-2xl mx-auto px-4 py-16 text-center"><h1 className="text-xl font-semibold">Sign in required</h1><p className="text-gray-500 mt-2">Request a sign-in link from the <Link href="/careers" className="underline">careers page</Link>.</p></div>;
  }
  if (!data) return <div className="max-w-2xl mx-auto px-4 py-16 text-center text-gray-400">Loading…</div>;

  return (
    <div className="max-w-2xl mx-auto px-4 py-10 space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Your profile</h1>
        <div className="flex items-center gap-3">
          <Link href="/careers" className="text-sm text-gray-500 hover:underline">Browse roles</Link>
          <button onClick={() => apiPost('/api/candidate/logout').then(() => { window.location.href = '/careers'; })} className="text-sm text-gray-500 hover:underline">Sign out</button>
        </div>
      </div>

      <Basics candidate={data.candidate} onSaved={load} />
      <Resume resumeUrl={data.candidate.resumeUrl} onSaved={load} />
      <Collection title="Education" items={data.educations} base="/api/candidate/education" fields={EDU_FIELDS} render={(e) => `${e.level} · ${e.institution}${e.grade ? ` · ${e.grade}` : ''}`} onChanged={load} />
      <Collection title="Work experience" items={data.experiences} base="/api/candidate/experience" fields={EXP_FIELDS} render={(e) => `${e.title} @ ${e.company}${e.isCurrent ? ' (current)' : ''}`} onChanged={load} />
      <Collection title="Skills" items={data.skills} base="/api/candidate/skill" fields={SKILL_FIELDS} render={(s) => `${s.name}${s.level ? ` · ${s.level}` : ''}`} onChanged={load} />

      <section>
        <h2 className="font-semibold text-gray-900 mb-2">Your applications</h2>
        {apps.length === 0 ? <p className="text-sm text-gray-500">No applications yet.</p> : (
          <ul className="space-y-2">
            {apps.map((a) => (
              <li key={a.id} className="flex items-center justify-between rounded-lg border border-gray-200 p-3">
                <span className="text-sm text-gray-800">{a.job?.title || 'Role'}</span>
                <span className="text-xs rounded-full px-2 py-0.5 bg-gray-100 text-gray-600">{a.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Basics({ candidate, onSaved }) {
  const [f, setF] = useState({ firstName: candidate.firstName || '', lastName: candidate.lastName || '', phone: candidate.phone || '', headline: candidate.headline || '', location: candidate.location || '', linkedinUrl: candidate.linkedinUrl || '' });
  const [saved, setSaved] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  async function save(e) { e.preventDefault(); await apiSend('/api/candidate/me', 'PUT', f); setSaved(true); setTimeout(() => setSaved(false), 1500); onSaved(); }
  return (
    <form onSubmit={save} className="rounded-xl border border-gray-200 p-4 space-y-3">
      <h2 className="font-semibold text-gray-900">Details <span className="text-xs text-gray-400">{candidate.email}</span></h2>
      <div className="grid grid-cols-2 gap-2">
        <input placeholder="First name" value={f.firstName} onChange={set('firstName')} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
        <input placeholder="Last name" value={f.lastName} onChange={set('lastName')} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
        <input placeholder="Headline (e.g. Senior Engineer)" value={f.headline} onChange={set('headline')} className="px-3 py-2 border border-gray-300 rounded-lg text-sm col-span-2" />
        <input placeholder="Phone" value={f.phone} onChange={set('phone')} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
        <input placeholder="Location" value={f.location} onChange={set('location')} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
        <input placeholder="LinkedIn URL" value={f.linkedinUrl} onChange={set('linkedinUrl')} className="px-3 py-2 border border-gray-300 rounded-lg text-sm col-span-2" />
      </div>
      <button type="submit" className="px-3 py-2 rounded-lg text-sm text-white" style={{ background: 'var(--theme-primary)' }}>{saved ? 'Saved ✓' : 'Save'}</button>
    </form>
  );
}

function Resume({ resumeUrl, onSaved }) {
  const [busy, setBusy] = useState(false);
  async function upload(file) { if (!file) return; setBusy(true); try { await apiPost('/api/candidate/resume', { resumeDataUrl: await fileToDataUrl(file) }); onSaved(); } finally { setBusy(false); } }
  return (
    <div className="rounded-xl border border-gray-200 p-4 flex items-center gap-3">
      <h2 className="font-semibold text-gray-900">Resume</h2>
      {resumeUrl && <a href={resumeUrl} target="_blank" rel="noreferrer" className="text-sm underline" style={{ color: 'var(--theme-primary)' }}>Current</a>}
      <label className="text-sm text-gray-600 cursor-pointer underline">{busy ? 'Uploading…' : (resumeUrl ? 'Replace' : 'Upload')}
        <input type="file" accept="application/pdf,image/png,image/jpeg" className="hidden" onChange={(e) => upload(e.target.files && e.target.files[0])} />
      </label>
    </div>
  );
}

const EDU_FIELDS = [['level', 'Level (e.g. Bachelor’s)'], ['institution', 'Institution'], ['fieldOfStudy', 'Field'], ['grade', 'Grade / %']];
const EXP_FIELDS = [['title', 'Title'], ['company', 'Company'], ['location', 'Location'], ['description', 'What you did']];
const SKILL_FIELDS = [['name', 'Skill'], ['level', 'Level']];

function Collection({ title, items, base, fields, render, onChanged }) {
  const [f, setF] = useState({});
  const [adding, setAdding] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  async function add(e) { e.preventDefault(); await apiPost(base, f); setF({}); setAdding(false); onChanged(); }
  async function del(id) { await apiSend(`${base}/${id}`, 'DELETE'); onChanged(); }
  return (
    <section className="rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-semibold text-gray-900">{title}</h2>
        <button onClick={() => setAdding((a) => !a)} className="text-sm underline" style={{ color: 'var(--theme-primary)' }}>{adding ? 'Cancel' : '+ Add'}</button>
      </div>
      <ul className="space-y-1 mb-2">
        {(items || []).map((it) => (
          <li key={it.id} className="flex items-center justify-between text-sm text-gray-700">
            <span>{render(it)}</span>
            <button onClick={() => del(it.id)} className="text-xs text-red-500 hover:underline">Remove</button>
          </li>
        ))}
        {(items || []).length === 0 && <li className="text-sm text-gray-400">None yet.</li>}
      </ul>
      {adding && (
        <form onSubmit={add} className="grid grid-cols-2 gap-2 pt-2 border-t border-gray-100">
          {fields.map(([k, ph]) => <input key={k} placeholder={ph} value={f[k] || ''} onChange={set(k)} className="px-2 py-1.5 border border-gray-300 rounded text-sm" />)}
          <button type="submit" className="col-span-2 px-3 py-1.5 rounded-lg text-sm text-white justify-self-start" style={{ background: 'var(--theme-primary)' }}>Add</button>
        </form>
      )}
    </section>
  );
}
