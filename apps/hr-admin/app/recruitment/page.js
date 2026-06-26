'use client';

// Recruitment / ATS (Feature 12) — Jobs console.
//   Tabs: Jobs · Scorecard templates.
//   - Jobs: paginated list (GET /recruitment/jobs) + a New-job modal that posts
//     the title/dept/openings/country + the merit blend (Application% / Interview%,
//     must total 100). Screening questions + the interview scorecard are configured
//     on the job detail page (the builders live there, next to the pipeline).
//   - Scorecard templates: the reusable skill sets (N skills rated 1–10, weighted)
//     HR defines ONCE and reuses across jobs/rounds.
// Every field carries an ⓘ tooltip; every list is paginated. The server is the
// real RBAC boundary (canManageHiring write / canViewHiring read).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ErrorBanner, PrimaryButton, TextInput, TextArea, Modal, ModalActions } from '@hr/ui';
import { get, post, patch } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton } from '@/lib/ui';
import { Info, FieldLabel, Pager, NumberInput } from './_components';
import ModuleGuide from '@/components/ModuleGuide';

const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY'];
const TABS = [
  { key: 'jobs', label: 'Jobs' },
  { key: 'templates', label: 'Scorecard templates' },
  { key: 'mine', label: 'My interviews' },
];

export default function RecruitmentPage() {
  const [tab, setTab] = useState('jobs');
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Recruitment"
        subtitle="Post jobs, screen + score candidates objectively, and rank them on a merit list."
      />
      <ModuleGuide
        id="recruitment"
        title="Post a role and rank candidates on a merit list"
        what="The Recruitment console (ATS) is where you post jobs, screen applicants, and score them objectively so every candidate ends up on one ranked merit list. It keeps hiring auditable and removes gut-feel by blending a screening score with an interview score."
        steps={[
          'On the Jobs tab, click New job. Set a unique job code (e.g. ENG-001), title, country (India), employment type and number of openings.',
          'Set the merit weighting — the two sliders (Application % and Interview %) must total 100. The default is 40% application / 60% interview.',
          'Tick "Post to the public careers page" if you want a shareable apply link once the job is OPEN; leave it off for an internal-only requisition.',
          'Open the new job to add screening questions and attach an interview scorecard, then move candidates through the pipeline.',
          'Use the Scorecard templates tab to build reusable skill sets (each skill rated 1–10, optionally weighted) so panels score consistently across roles.',
          'Interviewers use the My interviews tab to open their assigned panels and fill only their own scorecard.',
        ]}
        example={<>For <b>Backend Engineer (ENG-001)</b> at <b>Acme India Pvt Ltd</b>, Bengaluru, 2 openings, you keep the default <b>40% application / 60% interview</b> blend. Candidate <b>Aarav Sharma</b> scores <b>72%</b> on screening and his panel (mean of three cards) gives <b>85%</b> on interview, so his merit = 0.40×72 + 0.60×85 = <b>79.8%</b> — ranking him above a stronger-on-paper candidate who interviewed weakly.</>}
        tips={[
          'The Application % + Interview % sliders are linked and must sum to 100 — the Create button blocks an invalid blend.',
          'Pick the right multi-interviewer aggregation on a template: TRIMMED MEAN drops the highest and lowest card (needs ≥4 panelists) to soften an outlier rating.',
        ]}
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'jobs' && <JobsTab />}
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'mine' && <MyInterviewsTab />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// My interviews tab — an interviewer's own assigned panels (scope-bound /me/*)
// ══════════════════════════════════════════════════════════════════════════
function MyInterviewsTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    setLoading(true);
    get('/api/hr/recruitment/me/interviews')
      .then((r) => setRows(asList(r)))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const columns = [
    { key: 'jobTitle', header: 'Role', render: (r) => r.jobTitle || '—' },
    { key: 'candidate', header: 'Candidate', render: (r) => r.candidate ? `${r.candidate.firstName} ${r.candidate.lastName}` : '—' },
    { key: 'scheduledAt', header: 'When', render: (r) => r.scheduledAt ? new Date(r.scheduledAt).toLocaleString() : 'TBD' },
    { key: 'mode', header: 'Mode' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'actions', header: '', render: (r) => <Link href={`/recruitment/interviews/${r.id}/score`} className="text-xs font-medium hover:underline" style={{ color: 'var(--theme-primary)' }}>Score →</Link> },
  ];
  return (
    <div>
      {error && <ErrorBanner message={error} />}
      <p className="text-sm text-gray-500 mb-3">Interviews you're on the panel for. Open one to fill <b>your</b> scorecard (you only ever see your own card).</p>
      <DataTable columns={columns} rows={rows} loading={loading} rowKey={(r) => r.id} emptyText="You have no assigned interviews." />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Jobs tab
// ══════════════════════════════════════════════════════════════════════════
function JobsTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 12;

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setRows(asList(await get('/api/hr/recruitment/jobs'))); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

  const columns = [
    { key: 'title', header: 'Job', render: (r) => (
      <Link href={`/recruitment/jobs/${r.id}`} className="font-medium text-gray-900 hover:underline">{r.title}</Link>
    ) },
    { key: 'code', header: 'Code', render: (r) => <span className="text-xs text-gray-500">{r.code}</span> },
    { key: 'countryCode', header: 'Country' },
    { key: 'openings', header: 'Openings' },
    { key: 'blend', header: 'Merit blend', render: (r) => <span className="text-xs text-gray-500">{Number(r.applicationWeightPct)}% app · {Number(r.interviewWeightPct)}% iv</span> },
    { key: 'isPublic', header: 'Careers', render: (r) => r.isPublic ? <span className="text-xs text-emerald-700">Public</span> : <span className="text-xs text-gray-400">Internal</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      <div className="flex justify-end mb-3">
        <PrimaryButton onClick={() => setShowNew(true)}>New job</PrimaryButton>
      </div>
      <DataTable columns={columns} rows={pageRows} loading={loading} rowKey={(r) => r.id} emptyText="No jobs yet. Post your first role." />
      <Pager page={page} totalPages={totalPages} total={total} onPage={setPage} />
      {showNew && <NewJobModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />}
    </div>
  );
}

function NewJobModal({ onClose, onCreated }) {
  const [d, setD] = useState({
    code: '', title: '', countryCode: 'IN', employmentType: 'FULL_TIME', openings: 1,
    description: '', applicationWeightPct: 40, interviewWeightPct: 60, isPublic: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (v) => setD((s) => ({ ...s, [k]: v }));
  const weightSum = Number(d.applicationWeightPct || 0) + Number(d.interviewWeightPct || 0);

  async function save(e) {
    e.preventDefault();
    if (weightSum !== 100) { setError('Application % + Interview % must total 100.'); return; }
    setSaving(true); setError('');
    try { await post('/api/hr/recruitment/jobs', d); onCreated(); }
    catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="New job" onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel hint="A short internal code for this requisition, e.g. ENG-001. Must be unique.">Job code</FieldLabel>
            <TextInput value={d.code} onChange={(e) => set('code')(e.target.value)} required />
          </div>
          <div>
            <FieldLabel hint="The role title candidates will see on the careers page.">Title</FieldLabel>
            <TextInput value={d.title} onChange={(e) => set('title')(e.target.value)} required />
          </div>
          <div>
            <FieldLabel hint="The hiring country. Drives the offer pre-flight (India 50% wage rule) and the onboarding template seeded on hire.">Country</FieldLabel>
            <select value={d.countryCode} onChange={(e) => set('countryCode')(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="IN">India</option>
            </select>
          </div>
          <div>
            <FieldLabel hint="Employment type for this role.">Employment type</FieldLabel>
            <select value={d.employmentType} onChange={(e) => set('employmentType')(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
            </select>
          </div>
          <div>
            <FieldLabel hint="How many people you intend to hire for this role.">Openings</FieldLabel>
            <NumberInput value={d.openings} onChange={set('openings')} min={1} />
          </div>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={d.isPublic} onChange={(e) => set('isPublic')(e.target.checked)} />
              Post to the public careers page
              <Info text="When ticked and the job is OPEN, it appears on your tenant's public careers board with a shareable apply link." />
            </label>
          </div>
        </div>
        <div>
          <FieldLabel hint="A plain-language description of the role, shown to candidates.">Description</FieldLabel>
          <TextArea value={d.description} onChange={(e) => set('description')(e.target.value)} rows={3} />
        </div>

        {/* ── Merit weighting (two sliders that must total 100) ── */}
        <div className="rounded-xl border border-gray-200 p-4 bg-gray-50">
          <div className="text-sm font-medium text-gray-900 mb-1">Merit weighting
            <Info text="How the final merit score blends the application (screening) score and the interview score. They must total 100%. Default is 40% application / 60% interview." />
          </div>
          <div className="grid grid-cols-2 gap-4 mt-2">
            <div>
              <div className="flex justify-between text-xs text-gray-600 mb-1"><span>Application %</span><span className="font-semibold">{Number(d.applicationWeightPct)}</span></div>
              <input type="range" min={0} max={100} step={5} value={d.applicationWeightPct}
                onChange={(e) => { const a = Number(e.target.value); setD((s) => ({ ...s, applicationWeightPct: a, interviewWeightPct: 100 - a })); }}
                className="w-full" style={{ accentColor: 'var(--theme-primary)' }} />
            </div>
            <div>
              <div className="flex justify-between text-xs text-gray-600 mb-1"><span>Interview %</span><span className="font-semibold">{Number(d.interviewWeightPct)}</span></div>
              <input type="range" min={0} max={100} step={5} value={d.interviewWeightPct}
                onChange={(e) => { const b = Number(e.target.value); setD((s) => ({ ...s, interviewWeightPct: b, applicationWeightPct: 100 - b })); }}
                className="w-full" style={{ accentColor: 'var(--theme-primary)' }} />
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Merit = {Number(d.applicationWeightPct)}% × application + {Number(d.interviewWeightPct)}% × interview.
            {weightSum !== 100 && <span className="text-red-600"> (must total 100 — currently {weightSum})</span>}
          </p>
        </div>

        <p className="text-xs text-gray-500">Tip: add screening questions and an interview scorecard on the job page after you create it.</p>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-600">Cancel</button>
          <PrimaryButton type="submit" disabled={saving}>{saving ? 'Creating…' : 'Create job'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Scorecard templates tab
// ══════════════════════════════════════════════════════════════════════════
function TemplatesTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // template obj or {} for new

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setRows(asList(await get('/api/hr/recruitment/scorecard-templates'))); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const columns = [
    { key: 'name', header: 'Template' },
    { key: 'skills', header: 'Skills', render: (r) => <span className="text-xs text-gray-500">{(r.skills || []).length} skill{(r.skills || []).length === 1 ? '' : 's'}</span> },
    { key: 'aggregation', header: 'Aggregation', render: (r) => <span className="text-xs text-gray-500">{r.aggregation}</span> },
    { key: 'isActive', header: 'Active', render: (r) => r.isActive ? <span className="text-xs text-emerald-700">Yes</span> : <span className="text-xs text-gray-400">No</span> },
    { key: 'actions', header: '', render: (r) => <ActionButton onClick={() => setEditing(r)}>Edit</ActionButton> },
  ];

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      <div className="flex justify-end mb-3">
        <PrimaryButton onClick={() => setEditing({ name: '', aggregation: 'MEAN', skills: [{ name: '', weight: 1, scaleMin: 1, scaleMax: 10 }] })}>New template</PrimaryButton>
      </div>
      <DataTable columns={columns} rows={rows} loading={loading} rowKey={(r) => r.id} emptyText="No scorecard templates yet. Create a reusable skill set." />
      {editing && <TemplateModal template={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function TemplateModal({ template, onClose, onSaved }) {
  const [name, setName] = useState(template.name || '');
  const [aggregation, setAggregation] = useState(template.aggregation || 'MEAN');
  const [skills, setSkills] = useState(template.skills && template.skills.length ? template.skills.map((s) => ({ ...s })) : [{ name: '', weight: 1, scaleMin: 1, scaleMax: 10 }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isEdit = !!template.id;

  const setSkill = (i, k, v) => setSkills((arr) => arr.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const addSkill = () => setSkills((arr) => [...arr, { name: '', weight: 1, scaleMin: 1, scaleMax: 10 }]);
  const removeSkill = (i) => setSkills((arr) => arr.filter((_, j) => j !== i));

  async function save(e) {
    e.preventDefault();
    if (!name.trim()) { setError('Give the template a name.'); return; }
    if (!skills.some((s) => s.name.trim())) { setError('Add at least one skill.'); return; }
    setSaving(true); setError('');
    const payload = { name, aggregation, skills: skills.filter((s) => s.name.trim()).map((s, i) => ({ ...s, sortOrder: i })) };
    try {
      if (isEdit) await patch(`/api/hr/recruitment/scorecard-templates/${template.id}`, { ...payload, version: template.version });
      else await post('/api/hr/recruitment/scorecard-templates', payload);
      onSaved();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={isEdit ? 'Edit scorecard template' : 'New scorecard template'} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={save} className="space-y-4">
        <div>
          <FieldLabel hint="Name this reusable skill set, e.g. 'Backend Engineer — Tech Round'. You can attach it to any job/round.">Template name</FieldLabel>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <FieldLabel hint="How multiple interviewers' cards combine into one interview score. MEAN = average; MEDIAN = middle; MAX = best; TRIMMED MEAN drops the highest and lowest when ≥4 cards.">Multi-interviewer aggregation</FieldLabel>
          <select value={aggregation} onChange={(e) => setAggregation(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {['MEAN', 'TRIMMED_MEAN', 'MEDIAN', 'MAX'].map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <div className="text-sm font-medium text-gray-900 mb-2">Skills (rated 1–10)
            <Info text="Each skill the interviewer rates on a 1–10 scale during the interview. Optional per-skill weight lets a critical skill count more toward the total." />
          </div>
          <div className="space-y-2">
            {skills.map((s, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center">
                <div className="col-span-7">
                  <TextInput value={s.name} placeholder={`Skill ${i + 1} (e.g. Data Structures)`} onChange={(e) => setSkill(i, 'name', e.target.value)} />
                </div>
                <div className="col-span-3">
                  <NumberInput value={s.weight} onChange={(v) => setSkill(i, 'weight', v)} min={0} step={0.5} />
                </div>
                <div className="col-span-2 text-right">
                  <button type="button" onClick={() => removeSkill(i)} className="text-xs text-red-600 hover:underline" disabled={skills.length === 1}>Remove</button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2 text-xs text-gray-500">
            <span className="col-span-7">Skill name</span>
            <button type="button" onClick={addSkill} className="ml-auto text-sm hover:underline" style={{ color: 'var(--theme-primary)' }}>+ Add skill</button>
          </div>
          <p className="text-[11px] text-gray-400 mt-1">The second column is the weight (×). Leave at 1 for equal weighting.</p>
        </div>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-600">Cancel</button>
          <PrimaryButton type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save template'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}
