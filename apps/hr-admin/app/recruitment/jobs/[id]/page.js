'use client';

// Recruitment job detail (Feature 12). Tabs:
//   - Pipeline: a Kanban-ish board of applications by stage, with the screening
//     score badge + a red KO chip; quick stage-move actions; links to the
//     candidate profile.
//   - Screening: the screening-question builder (typed questions; choice/
//     qualification options carry POINTS; tick Knockout to auto-reject).
//   - Scorecard: pick the default interview scorecard template for this job.
//   - Merit list: candidates ranked by combined application + interview score,
//     with a "Why this rank?" drawer printing the exact formula + every line.
// Every field has an ⓘ tooltip; lists are paginated. Server is the RBAC boundary.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ErrorBanner, PrimaryButton, TextInput, Modal, ModalActions, Spinner } from '@hr/ui';
import { get, post, patch, del } from '@/lib/api';
import { asList, PageHeader, Tabs, StatusBadge, ActionButton } from '@/lib/ui';
import { Info, FieldLabel, ScoreBadge, Pager, NumberInput } from '../../_components';

const TABS = [
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'screening', label: 'Screening questions' },
  { key: 'scorecard', label: 'Interview scorecard' },
  { key: 'merit', label: 'Merit list' },
  { key: 'publish', label: 'Publish & careers' },
];

export default function JobDetailPage() {
  const { id } = useParams();
  const [job, setJob] = useState(null);
  const [tab, setTab] = useState('pipeline');
  const [error, setError] = useState('');

  const loadJob = useCallback(async () => {
    try { setJob(await get(`/api/hr/recruitment/jobs/${id}`)); }
    catch (e) { setError(e.message); }
  }, [id]);
  useEffect(() => { loadJob(); }, [loadJob]);

  if (!job) return <div className="p-6"><Spinner /></div>;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Link href="/recruitment" className="text-xs text-gray-500 hover:underline">← All jobs</Link>
      <PageHeader
        title={job.title}
        subtitle={`${job.code} · ${job.countryCode} · ${job.openings} opening${job.openings === 1 ? '' : 's'}`}
        actions={<StatusBadge status={job.status} />}
      />
      {error && <ErrorBanner message={error} />}
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'pipeline' && <PipelineTab jobId={id} />}
      {tab === 'screening' && <ScreeningTab jobId={id} />}
      {tab === 'scorecard' && <ScorecardTab job={job} onSaved={loadJob} />}
      {tab === 'merit' && <MeritTab jobId={id} />}
      {tab === 'publish' && <PublishTab job={job} onSaved={loadJob} />}
    </div>
  );
}

// ── Pipeline board ──────────────────────────────────────────────────────────
const STAGE_ORDER = ['SOURCED', 'SCREENING', 'INTERVIEW', 'ASSESSMENT', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'];

function PipelineTab({ jobId }) {
  const [stages, setStages] = useState([]);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [st, ap] = await Promise.all([
        get(`/api/hr/recruitment/jobs/${jobId}/stages`),
        get('/api/hr/recruitment/applications', { jobId }),
      ]);
      setStages(asList(st)); setApps(asList(ap));
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [jobId]);
  useEffect(() => { load(); }, [load]);

  async function moveTo(appId, stageId) {
    try { await post(`/api/hr/recruitment/applications/${appId}/move`, { stageId }); load(); }
    catch (e) { setError(e.message); }
  }

  if (loading) return <Spinner />;
  if (!stages.length) return <div className="text-sm text-gray-500">No pipeline stages yet. Add stages to this job (SCREENING, INTERVIEW, OFFER, HIRED, REJECTED).</div>;

  const sorted = [...stages].sort((a, b) => a.sortOrder - b.sortOrder);
  const byStage = (sid) => apps.filter((a) => a.currentStageId === sid);

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {sorted.map((stage) => (
          <div key={stage.id} className="min-w-[220px] w-56 flex-shrink-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2 flex items-center justify-between">
              <span>{stage.name}</span>
              <span className="text-gray-400">{byStage(stage.id).length}</span>
            </div>
            <div className="space-y-2">
              {byStage(stage.id).map((a) => (
                <CandidateCard key={a.id} app={a} stages={sorted} onMove={moveTo} />
              ))}
              {byStage(stage.id).length === 0 && <div className="text-xs text-gray-300 border border-dashed rounded-lg p-3 text-center">Empty</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CandidateCard({ app, stages, onMove }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <Link href={`/recruitment/applications/${app.id}`} className="text-sm font-medium text-gray-900 hover:underline">
          {app.candidate ? `${app.candidate.firstName} ${app.candidate.lastName}` : (app.candidateId || 'Candidate').slice(0, 8)}
        </Link>
        <ScoreBadge score={app.screeningScore} max={app.screeningMaxScore} knockedOut={app.knockedOut} />
      </div>
      <div className="mt-1 flex items-center justify-between">
        <span className="text-[11px] text-gray-400">{app.meritScore != null ? `Merit ${Number(app.meritScore)}` : 'Not scored'}</span>
        <button type="button" className="text-[11px] hover:underline" style={{ color: 'var(--theme-primary)' }} onClick={() => setOpen((v) => !v)}>Move</button>
      </div>
      {open && (
        <div className="mt-2 flex flex-wrap gap-1">
          {stages.map((s) => (
            <button key={s.id} type="button" onClick={() => onMove(app.id, s.id)} className="text-[10px] px-1.5 py-0.5 border rounded hover:bg-gray-50">{s.name}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Screening questions builder ─────────────────────────────────────────────
const SCREENING_KINDS = [
  { v: 'SINGLE_CHOICE', label: 'Single choice' },
  { v: 'MULTI_CHOICE', label: 'Multiple choice' },
  { v: 'BOOLEAN', label: 'Yes / No' },
  { v: 'QUALIFICATION', label: 'Qualification (degree points)' },
  { v: 'NUMBER', label: 'Number' },
  { v: 'TEXT', label: 'Free text' },
];

function ScreeningTab({ jobId }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setRows(asList(await get(`/api/hr/recruitment/jobs/${jobId}/screening-questions`))); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [jobId]);
  useEffect(() => { load(); }, [load]);

  async function remove(id) {
    if (!confirm('Delete this question?')) return;
    try { await del(`/api/hr/recruitment/screening-questions/${id}`); load(); }
    catch (e) { setError(e.message); }
  }

  if (loading) return <Spinner />;
  return (
    <div>
      {error && <ErrorBanner message={error} />}
      <p className="text-sm text-gray-500 mb-3">
        Questions a candidate answers when they apply. Choice/qualification answers carry <b>points</b> (e.g. Master's → 6, CS engineering → 20).
        Tick <b>Knockout</b> to auto-reject a wrong answer. These auto-score the application — no manual marking.
      </p>
      <div className="flex justify-end mb-3">
        <PrimaryButton onClick={() => setEditing({ prompt: '', kind: 'SINGLE_CHOICE', required: true, isKnockout: false, options: [{ label: '', value: '', points: 0 }] })}>Add question</PrimaryButton>
      </div>
      <div className="space-y-3">
        {rows.length === 0 && <div className="text-sm text-gray-400 border border-dashed rounded-xl p-6 text-center">No screening questions yet.</div>}
        {rows.map((q) => (
          <div key={q.id} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-sm font-medium text-gray-900">{q.prompt}
                  {q.isKnockout && <span className="ml-2 inline-flex items-center rounded-full border border-red-200 bg-red-50 text-red-700 px-2 py-0.5 text-[10px] font-semibold">KNOCKOUT</span>}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">{SCREENING_KINDS.find((k) => k.v === q.kind)?.label || q.kind}</div>
                {(q.options || []).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {q.options.map((o) => (
                      <span key={o.id} className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{o.label} <b>+{Number(o.points)}</b></span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <ActionButton onClick={() => setEditing(q)}>Edit</ActionButton>
                <ActionButton tone="danger" onClick={() => remove(q.id)}>Delete</ActionButton>
              </div>
            </div>
          </div>
        ))}
      </div>
      {editing && <QuestionModal jobId={jobId} question={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function QuestionModal({ jobId, question, onClose, onSaved }) {
  const [prompt, setPrompt] = useState(question.prompt || '');
  const [kind, setKind] = useState(question.kind || 'SINGLE_CHOICE');
  const [isKnockout, setIsKnockout] = useState(!!question.isKnockout);
  const [knockoutValue, setKnockoutValue] = useState(Array.isArray(question.knockoutValue) ? question.knockoutValue.join(',') : (question.knockoutValue ?? ''));
  const [options, setOptions] = useState(question.options && question.options.length ? question.options.map((o) => ({ ...o })) : [{ label: '', value: '', points: 0 }]);
  const [maxPoints, setMaxPoints] = useState(question.maxPoints ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isEdit = !!question.id;
  const hasOptions = ['SINGLE_CHOICE', 'MULTI_CHOICE', 'QUALIFICATION', 'BOOLEAN'].includes(kind);

  const setOpt = (i, k, v) => setOptions((arr) => arr.map((o, j) => (j === i ? { ...o, [k]: v } : o)));
  const addOpt = () => setOptions((arr) => [...arr, { label: '', value: '', points: 0 }]);
  const removeOpt = (i) => setOptions((arr) => arr.filter((_, j) => j !== i));

  async function save(e) {
    e.preventDefault();
    if (!prompt.trim()) { setError('Enter the question prompt.'); return; }
    setSaving(true); setError('');
    const payload = {
      prompt, kind, isKnockout, required: true,
      maxPoints: kind === 'NUMBER' && maxPoints !== '' ? Number(maxPoints) : undefined,
      knockoutValue: isKnockout ? parseKnockout(kind, knockoutValue) : undefined,
      options: hasOptions ? options.filter((o) => o.label.trim()).map((o, i) => ({ label: o.label, value: o.value || o.label, points: Number(o.points) || 0, sortOrder: i })) : [],
    };
    try {
      if (isEdit) await patch(`/api/hr/recruitment/screening-questions/${question.id}`, payload);
      else await post(`/api/hr/recruitment/jobs/${jobId}/screening-questions`, payload);
      onSaved();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={isEdit ? 'Edit screening question' : 'Add screening question'} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={save} className="space-y-4">
        <div>
          <FieldLabel hint="The question the candidate answers, e.g. 'Do you have a Computer Science engineering degree?'">Question</FieldLabel>
          <TextInput value={prompt} onChange={(e) => setPrompt(e.target.value)} required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel hint="The answer type. Single/Multiple choice and Qualification carry points per option; Yes/No is a simple boolean (great for knockouts).">Answer type</FieldLabel>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {SCREENING_KINDS.map((k) => <option key={k.v} value={k.v}>{k.label}</option>)}
            </select>
          </div>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={isKnockout} onChange={(e) => setIsKnockout(e.target.checked)} />
              Knockout question
              <Info text="A knockout auto-rejects the candidate if they don't give a passing answer (e.g. 'Must be eligible to work in NZ → Yes'). Their merit drops to 0 but they stay visible." />
            </label>
          </div>
        </div>

        {isKnockout && (
          <div>
            <FieldLabel hint="The passing value(s). For Yes/No use 'true'. For choices, the option value(s) that pass — comma-separate multiple.">Passing answer(s)</FieldLabel>
            <TextInput value={knockoutValue} onChange={(e) => setKnockoutValue(e.target.value)} placeholder={kind === 'BOOLEAN' ? 'true' : 'e.g. yes'} />
          </div>
        )}

        {kind === 'NUMBER' && (
          <div>
            <FieldLabel hint="Cap the points a numeric answer can earn.">Max points</FieldLabel>
            <NumberInput value={maxPoints} onChange={setMaxPoints} min={0} />
          </div>
        )}

        {hasOptions && (
          <div>
            <div className="text-sm font-medium text-gray-900 mb-2">Options + points
              <Info text="Each answer option and the points it earns. e.g. 'Master's → 6', 'Bachelor's → 4', 'B.Tech CS → 20'. The application score sums these." />
            </div>
            <div className="space-y-2">
              {options.map((o, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-7"><TextInput value={o.label} placeholder={`Option ${i + 1}`} onChange={(e) => setOpt(i, 'label', e.target.value)} /></div>
                  <div className="col-span-3"><NumberInput value={o.points} onChange={(v) => setOpt(i, 'points', v)} min={0} /></div>
                  <div className="col-span-2 text-right"><button type="button" onClick={() => removeOpt(i)} disabled={options.length === 1} className="text-xs text-red-600 hover:underline">Remove</button></div>
                </div>
              ))}
            </div>
            <button type="button" onClick={addOpt} className="text-sm mt-2 hover:underline" style={{ color: 'var(--theme-primary)' }}>+ Add option</button>
            <p className="text-[11px] text-gray-400 mt-1">Left = label shown to the candidate · Right = points awarded.</p>
          </div>
        )}

        <ModalActions>
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-600">Cancel</button>
          <PrimaryButton type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save question'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

function parseKnockout(kind, raw) {
  const parts = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (kind === 'BOOLEAN') return parts.map((p) => p.toLowerCase() === 'true');
  return parts;
}

// ── Scorecard template picker ───────────────────────────────────────────────
function ScorecardTab({ job, onSaved }) {
  const [templates, setTemplates] = useState([]);
  const [sel, setSel] = useState(job.scorecardTemplateId || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    get('/api/hr/recruitment/scorecard-templates').then((r) => setTemplates(asList(r))).catch((e) => setError(e.message));
  }, []);

  async function save() {
    setSaving(true); setError('');
    try { await patch(`/api/hr/recruitment/jobs/${job.id}`, { scorecardTemplateId: sel || null }); onSaved(); }
    catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  const chosen = templates.find((t) => t.id === sel);
  return (
    <div className="max-w-xl">
      {error && <ErrorBanner message={error} />}
      <p className="text-sm text-gray-500 mb-3">Pick the interview scorecard this job's rounds use by default. Interviewers rate each skill 1–10; the weighted total feeds the merit list.</p>
      <FieldLabel hint="The reusable skill set (created on the Recruitment → Scorecard templates tab). Each interview round defaults to this template.">Default interview scorecard</FieldLabel>
      <select value={sel} onChange={(e) => setSel(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
        <option value="">— None —</option>
        {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({(t.skills || []).length} skills)</option>)}
      </select>
      {chosen && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(chosen.skills || []).map((s) => <span key={s.id} className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{s.name} ×{Number(s.weight)}</span>)}
        </div>
      )}
      <div className="mt-4"><PrimaryButton onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</PrimaryButton></div>
    </div>
  );
}

// ── Merit list ──────────────────────────────────────────────────────────────
function MeritTab({ jobId }) {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [why, setWhy] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try { setData(await get(`/api/hr/recruitment/jobs/${jobId}/merit-list`, { page, pageSize: 25 })); }
    catch (e) { setError(e.message); }
  }, [jobId, page]);
  useEffect(() => { load(); }, [load]);

  if (!data) return error ? <ErrorBanner message={error} /> : <Spinner />;
  const name = (a) => a.candidate ? `${a.candidate.firstName} ${a.candidate.lastName}` : (a.id || '').slice(0, 8);

  return (
    <div>
      {error && <ErrorBanner message={error} />}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600 mb-4">
        <b>Formula:</b> {data.job.formula}
      </div>

      <h3 className="text-sm font-semibold text-gray-900 mb-2">Ranked candidates</h3>
      <div className="rounded-2xl border border-gray-200 bg-white overflow-x-auto shadow-sm">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-100">
            <th className="px-4 py-3">Rank</th><th className="px-4 py-3">Candidate</th><th className="px-4 py-3">Application</th><th className="px-4 py-3">Interview</th><th className="px-4 py-3">Merit</th><th className="px-4 py-3"></th>
          </tr></thead>
          <tbody>
            {data.ranked.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">No interviewed candidates yet.</td></tr>}
            {data.ranked.map((a) => (
              <tr key={a.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                <td className="px-4 py-3 font-semibold">{a.rank}</td>
                <td className="px-4 py-3"><Link href={`/recruitment/applications/${a.id}`} className="text-gray-900 hover:underline">{name(a)}</Link></td>
                <td className="px-4 py-3"><ScoreBadge score={a.screeningScore} max={a.screeningMaxScore} /></td>
                <td className="px-4 py-3 text-gray-700">{a.interviewScore != null ? Number(a.interviewScore) : '—'}</td>
                <td className="px-4 py-3 font-semibold" style={{ color: 'var(--theme-primary)' }}>{a.meritScore != null ? Number(a.meritScore) : '—'}</td>
                <td className="px-4 py-3 text-right"><ActionButton onClick={() => setWhy(a)}>Why this rank?</ActionButton></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={data.pagination.page} totalPages={data.pagination.totalPages} total={data.pagination.total} onPage={setPage} />

      {data.pending.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-gray-500 mb-2">Awaiting interview ({data.pending.length})</h3>
          <div className="flex flex-wrap gap-2">
            {data.pending.map((a) => (
              <Link key={a.id} href={`/recruitment/applications/${a.id}`} className="text-xs px-2.5 py-1 rounded-full border bg-white hover:bg-gray-50">
                {name(a)} <ScoreBadge score={a.screeningScore} max={a.screeningMaxScore} />
              </Link>
            ))}
          </div>
        </div>
      )}
      {data.knockedOut.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-gray-500 mb-2">Knocked out / rejected ({data.knockedOut.length})</h3>
          <div className="flex flex-wrap gap-2">
            {data.knockedOut.map((a) => (
              <span key={a.id} className="text-xs px-2.5 py-1 rounded-full border border-red-100 bg-red-50 text-red-700">{name(a)}</span>
            ))}
          </div>
        </div>
      )}

      {why && <WhyDrawer app={why} onClose={() => setWhy(null)} />}
    </div>
  );
}

function WhyDrawer({ app, onClose }) {
  const snap = app.scoreSnapshot || {};
  return (
    <Modal title={`Why this rank — ${app.candidate ? `${app.candidate.firstName} ${app.candidate.lastName}` : ''}`} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="rounded-lg bg-gray-50 border p-3 text-gray-600 text-xs">{snap.formula}</div>
        {snap.screening && (
          <div>
            <div className="font-semibold text-gray-900 mb-1">Application — {snap.screening.score}/{snap.screening.max} ({snap.screening.pct}%)</div>
            <ul className="text-xs text-gray-600 space-y-0.5">
              {(snap.screening.lines || []).map((l, i) => (
                <li key={i} className="flex justify-between">
                  <span>{l.q}{l.label ? ` — ${l.label}` : ''}{l.isKnockout ? (l.knockoutFailed ? ' (knockout FAILED)' : ' (knockout passed)') : ''}</span>
                  <span className="tabular-nums">+{l.awarded}</span>
                </li>
              ))}
            </ul>
            {snap.screening.knockouts && <div className="text-[11px] text-gray-400 mt-1">Knockouts: {snap.screening.knockouts.passed} passed, {snap.screening.knockouts.failed} failed</div>}
          </div>
        )}
        {snap.interview && (
          <div>
            <div className="font-semibold text-gray-900 mb-1">Interview — {snap.interview.score ?? 'pending'} ({snap.interview.aggregation} of {snap.interview.interviewers} interviewer{snap.interview.interviewers === 1 ? '' : 's'})</div>
            <ul className="text-xs text-gray-600 space-y-0.5">
              {(snap.interview.perInterviewer || []).map((p, i) => (
                <li key={i} className="flex justify-between"><span>{p.who}</span><span className="tabular-nums">{p.total}</span></li>
              ))}
            </ul>
          </div>
        )}
        <div className="border-t pt-3 flex justify-between font-semibold">
          <span>Merit (weighted)</span>
          <span style={{ color: 'var(--theme-primary)' }}>{snap.merit ?? (app.meritScore != null ? Number(app.meritScore) : '—')}</span>
        </div>
      </div>
    </Modal>
  );
}

// ── Publish & careers ───────────────────────────────────────────────────────
function PublishTab({ job, onSaved }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function act(path) {
    setBusy(true); setError('');
    try { await post(`/api/hr/recruitment/jobs/${job.id}/${path}`, {}); onSaved(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function togglePublic() {
    setBusy(true); setError('');
    try { await patch(`/api/hr/recruitment/jobs/${job.id}`, { isPublic: !job.isPublic }); onSaved(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return (
    <div className="max-w-xl space-y-4">
      {error && <ErrorBanner message={error} />}
      <div className="rounded-xl border p-4">
        <div className="text-sm font-medium text-gray-900 mb-1">Status: <StatusBadge status={job.status} /></div>
        <p className="text-xs text-gray-500 mb-3">Publishing flips the job to OPEN. Closing stops new applications.</p>
        <div className="flex gap-2">
          {job.status === 'DRAFT' && <PrimaryButton onClick={() => act('publish')} disabled={busy}>Publish (→ OPEN)</PrimaryButton>}
          {(job.status === 'OPEN' || job.status === 'ON_HOLD') && <ActionButton tone="danger" onClick={() => act('close')}>Close job</ActionButton>}
        </div>
      </div>
      <div className="rounded-xl border p-4">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={job.isPublic} onChange={togglePublic} disabled={busy} />
          Show on the public careers page
          <Info text="When ON and the job is OPEN, candidates can apply via your tenant's public careers link without an account." />
        </label>
        {job.isPublic && job.publicSlug && (
          <p className="text-xs text-gray-500 mt-2">Public apply link: <code className="bg-gray-100 px-1.5 py-0.5 rounded">/api/public/careers/&lt;your-slug&gt;/jobs/{job.publicSlug}</code></p>
        )}
      </div>
    </div>
  );
}
