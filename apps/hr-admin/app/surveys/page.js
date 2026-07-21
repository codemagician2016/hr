'use client';

// Surveys & eNPS admin — Feature 33 (employee listening) operator surface.
// List → Builder (create + DRAFT edit) → Results dashboard, all against
// /api/hr/surveys (canManageSurveys, Owner + HR-Admin):
//   GET /            list (status filter, server-paginated)
//   POST /           create DRAFT (template + questions + audience + schedule)
//   GET /:id         detail (questions + occurrences)
//   PATCH /:id       edit (version-locked; 409 ANONYMITY_LOCKED; questions DRAFT-only)
//   POST /:id/publish|close|archive
//   GET /:id/results | /results/trend | /results/segments | /results/verbatims?ack=1
// Anonymity is the load-bearing rule: every aggregate the dashboard shows is
// k-suppressed server-side; every suppressed tile here explains WHY (tooltip).
// Follows the announcements page idioms (audience picker, schedule, DataTable).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBanner, formatAdminDate } from '@hr/ui';
import { get, post, patch } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, ActionButton, ServerPagination, Tabs } from '@/lib/ui';
import { InfoTip, LabelWithTip } from '../letters/lib';
import ModuleGuide from '@/components/ModuleGuide';
import EmployeeSearchSelect, { employeeName } from '@/components/EmployeeSearchSelect';

const STATUSES = ['', 'DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED'];
const PAGE_SIZES = [25, 50, 100];
const TYPES = [
  { value: 'PULSE', label: 'Pulse' },
  { value: 'ENPS', label: 'eNPS' },
  { value: 'CUSTOM', label: 'Custom' },
];
const SCOPES = [
  { value: 'ALL', label: 'Everyone (whole company)' },
  { value: 'ENTITY', label: 'By entity / legal company' },
  { value: 'DEPARTMENT', label: 'By department' },
  { value: 'SPECIFIC', label: 'Specific people' },
];
const CADENCES = [
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'FORTNIGHTLY', label: 'Fortnightly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
];
const QUESTION_TYPES = [
  { value: 'SCALE', label: 'Scale' },
  { value: 'LIKERT', label: 'Likert' },
  { value: 'NPS', label: 'NPS (0–10)' },
  { value: 'SINGLE', label: 'Single choice' },
  { value: 'MULTI', label: 'Multi choice' },
  { value: 'TEXT', label: 'Text' },
];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ENPS_DRIVER_PROMPT = 'How likely are you to recommend us as a place to work?';
const ANON_EXPLAINER = "Responses can't be traced to a person; can't be changed once people start answering.";

const TYPE_TONE = {
  PULSE: { bg: '#ecfeff', fg: '#0e7490' },
  ENPS: { bg: '#eef2ff', fg: '#4338ca' },
  CUSTOM: { bg: '#f1f5f9', fg: '#475569' },
};

let seq = 0;
const nextKey = () => `q${(seq += 1)}`;

// ── tiny shared bits ─────────────────────────────────────────────────────────
function TypeChip({ type }) {
  const t = TYPE_TONE[type] || TYPE_TONE.CUSTOM;
  return (
    <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: t.bg, color: t.fg }}>
      {type === 'ENPS' ? 'eNPS' : type}
    </span>
  );
}

function LockIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 11V7a5 5 0 0110 0v4M5 11h14v10H5z" />
    </svg>
  );
}

function AnonBadge({ anonymous }) {
  if (!anonymous) return <span className="text-xs text-gray-400">Attributed</span>;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs font-medium text-gray-600"
      title={ANON_EXPLAINER}
    >
      <LockIcon /> Anonymous
    </span>
  );
}

// Every suppressed number on the dashboard renders through this tile so the
// "why is this hidden" tooltip is never missing (§6.3 convention).
function Suppressed({ k, label = 'Insufficient data' }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-dashed border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-500">
      <LockIcon size={14} />
      <span>
        {label} — hidden to protect anonymity (need ≥{k})
      </span>
      <InfoTip
        text={`Fewer than ${k} people are behind this number. Showing it could make individual answers guessable, so it stays hidden until at least ${k} responses exist.`}
        label="Why is this hidden?"
      />
    </div>
  );
}

function HBar({ pct, color }) {
  return (
    <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
      <div className="h-2 rounded-full" style={{ width: `${Math.max(0, Math.min(100, pct || 0))}%`, background: color }} />
    </div>
  );
}

function toLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function audienceLabel(row) {
  if (row.audienceScope === 'ALL') return 'Everyone';
  if (row.audienceScope === 'ENTITY') return `${(row.audienceEntityIds || []).length} entity(ies)`;
  if (row.audienceScope === 'DEPARTMENT') return `${(row.audienceDeptIds || []).length} dept(s)`;
  if (row.audienceScope === 'SPECIFIC') return `${(row.audienceEmployeeIds || []).length} employee(s)`;
  return '—';
}

function cadenceLabel(row) {
  if (!row.cadence) return 'One-shot';
  const c = CADENCES.find((x) => x.value === row.cadence);
  return `${c ? c.label : row.cadence} · ${row.windowDays || 7}d window`;
}

// ── builder form model ───────────────────────────────────────────────────────
function newQuestion(type) {
  const base = {
    _key: nextKey(), section: '', type, prompt: '', required: true,
    scaleMin: null, scaleMax: null, scaleMinLabel: '', scaleMaxLabel: '',
    options: [], allowOther: false, isEnpsDriver: false,
  };
  if (type === 'SCALE') return { ...base, scaleMin: 1, scaleMax: 5 };
  if (type === 'LIKERT') return { ...base, scaleMin: 1, scaleMax: 5, scaleMinLabel: 'Strongly disagree', scaleMaxLabel: 'Strongly agree' };
  if (type === 'NPS') return { ...base, scaleMin: 0, scaleMax: 10, scaleMinLabel: 'Not at all likely', scaleMaxLabel: 'Extremely likely' };
  if (type === 'SINGLE' || type === 'MULTI') return { ...base, options: [{ value: 'opt_1', label: '' }, { value: 'opt_2', label: '' }] };
  return base;
}

function enpsDriverQuestion() {
  return { ...newQuestion('NPS'), prompt: ENPS_DRIVER_PROMPT, isEnpsDriver: true, required: true };
}

function emptyForm() {
  return {
    id: null, version: null, status: 'DRAFT',
    title: '', description: '', type: 'PULSE',
    anonymous: true, minResponsesToShow: 5,
    audienceScope: 'ALL', audienceEntityIds: [], audienceDeptIds: [], audienceEmployeeIds: [],
    audienceEmployeeLabels: {},
    sendNow: true, publishedAt: '',
    recurring: false, cadence: 'MONTHLY', cadenceAnchorDay: 1, windowDays: 7, recurrenceEndsAt: '',
    questions: [],
  };
}

function formFromSurvey(s) {
  return {
    id: s.id, version: s.version, status: s.status,
    title: s.title || '', description: s.description || '', type: s.type || 'PULSE',
    anonymous: s.anonymous !== false, minResponsesToShow: s.minResponsesToShow ?? 5,
    audienceScope: s.audienceScope || 'ALL',
    audienceEntityIds: s.audienceEntityIds || [],
    audienceDeptIds: s.audienceDeptIds || [],
    audienceEmployeeIds: s.audienceEmployeeIds || [],
    audienceEmployeeLabels: {},
    sendNow: !s.publishedAt, publishedAt: toLocalInputValue(s.publishedAt),
    recurring: !!s.cadence, cadence: s.cadence || 'MONTHLY',
    cadenceAnchorDay: s.cadenceAnchorDay ?? 1,
    windowDays: s.windowDays ?? 7,
    recurrenceEndsAt: toLocalInputValue(s.recurrenceEndsAt),
    questions: (s.questions || []).map((q) => ({
      _key: nextKey(), id: q.id, section: q.section || '', type: q.type,
      prompt: q.prompt || '', required: q.required !== false,
      scaleMin: q.scaleMin, scaleMax: q.scaleMax,
      scaleMinLabel: q.scaleMinLabel || '', scaleMaxLabel: q.scaleMaxLabel || '',
      options: Array.isArray(q.options) ? q.options.map((o) => ({ value: o.value, label: o.label })) : [],
      allowOther: !!q.allowOther, isEnpsDriver: !!q.isEnpsDriver,
    })),
  };
}

function questionPayload(q, i) {
  const base = {
    section: q.section.trim() ? q.section.trim() : null,
    orderIndex: i,
    type: q.type,
    prompt: q.prompt.trim(),
    required: !!q.required,
    isEnpsDriver: !!q.isEnpsDriver,
  };
  if (q.type === 'SCALE' || q.type === 'LIKERT' || q.type === 'NPS') {
    base.scaleMin = q.type === 'NPS' ? 0 : Number(q.scaleMin);
    base.scaleMax = q.type === 'NPS' ? 10 : Number(q.scaleMax);
    base.scaleMinLabel = q.scaleMinLabel.trim() || null;
    base.scaleMaxLabel = q.scaleMaxLabel.trim() || null;
  }
  if (q.type === 'SINGLE' || q.type === 'MULTI') {
    base.options = q.options.map((o) => ({ value: o.value.trim(), label: o.label.trim() }));
    base.allowOther = !!q.allowOther;
  }
  return base;
}

function payloadFromForm(f) {
  const payload = {
    title: f.title.trim(),
    description: f.description.trim() ? f.description : null,
    type: f.type,
    anonymous: !!f.anonymous,
    minResponsesToShow: Math.max(1, Math.min(100, Math.round(Number(f.minResponsesToShow)) || 5)),
    audienceScope: f.audienceScope,
    audienceEntityIds: f.audienceScope === 'ENTITY' ? f.audienceEntityIds : [],
    audienceDeptIds: f.audienceScope === 'DEPARTMENT' ? f.audienceDeptIds : [],
    audienceEmployeeIds: f.audienceScope === 'SPECIFIC' ? f.audienceEmployeeIds : [],
    publishedAt: !f.sendNow && f.publishedAt ? new Date(f.publishedAt).toISOString() : null,
    cadence: f.recurring ? f.cadence : null,
    cadenceAnchorDay: f.recurring ? (Math.round(Number(f.cadenceAnchorDay)) || 1) : null,
    windowDays: Math.max(1, Math.min(90, Math.round(Number(f.windowDays)) || 7)),
    recurrenceEndsAt: f.recurring && f.recurrenceEndsAt ? new Date(f.recurrenceEndsAt).toISOString() : null,
  };
  // Question edits are DRAFT-only server-side — only a DRAFT form ships them.
  if (f.status === 'DRAFT') payload.questions = f.questions.map(questionPayload);
  if (f.id != null && f.version != null) payload.version = f.version;
  return payload;
}

function validateForm(f) {
  if (!f.title.trim()) return 'Title is required.';
  if (f.status === 'DRAFT' && !f.questions.length) return 'Add at least one question.';
  for (let i = 0; i < f.questions.length; i += 1) {
    const q = f.questions[i];
    const at = `Question ${i + 1}`;
    if (!q.prompt.trim()) return `${at}: the prompt is required.`;
    if (q.type === 'SCALE' || q.type === 'LIKERT') {
      const lo = Number(q.scaleMin);
      const hi = Number(q.scaleMax);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return `${at}: scale bounds are required.`;
      if (lo >= hi) return `${at}: the scale minimum must be below the maximum.`;
    }
    if (q.type === 'SINGLE' || q.type === 'MULTI') {
      if (!q.options.length) return `${at}: add at least one option.`;
      const seen = new Set();
      for (const o of q.options) {
        if (!o.value.trim() || !o.label.trim()) return `${at}: every option needs a value and a label.`;
        if (seen.has(o.value.trim())) return `${at}: duplicate option value "${o.value.trim()}".`;
        seen.add(o.value.trim());
      }
    }
  }
  if (f.type === 'ENPS' && f.questions.filter((q) => q.isEnpsDriver && q.type === 'NPS').length !== 1) {
    return 'An eNPS survey needs exactly one locked NPS driver question.';
  }
  if (f.audienceScope === 'ENTITY' && !f.audienceEntityIds.length) return 'Pick at least one entity.';
  if (f.audienceScope === 'DEPARTMENT' && !f.audienceDeptIds.length) return 'Pick at least one department.';
  if (f.audienceScope === 'SPECIFIC' && !f.audienceEmployeeIds.length) return 'Add at least one employee.';
  if (!f.sendNow && !f.publishedAt) return 'Pick a go-live time or choose "Send now".';
  return null;
}

function cadenceSentence(f) {
  if (!f.recurring) return null;
  const day = Math.round(Number(f.cadenceAnchorDay)) || 1;
  const win = Math.round(Number(f.windowDays)) || 7;
  const until = f.recurrenceEndsAt ? `, until ${formatAdminDate(new Date(f.recurrenceEndsAt).toISOString())}` : '';
  let when;
  if (f.cadence === 'WEEKLY') when = `Every week on ${WEEKDAYS[((day - 1) % 7 + 7) % 7]}`;
  else if (f.cadence === 'FORTNIGHTLY') when = `Every two weeks on ${WEEKDAYS[((day - 1) % 7 + 7) % 7]}`;
  else if (f.cadence === 'QUARTERLY') when = `Every quarter on day ${day} of the first month`;
  else when = `Every month on day ${day}`;
  return `${when}, open ${win} day${win === 1 ? '' : 's'}${until}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Page — list / builder / results drill-in
// ═════════════════════════════════════════════════════════════════════════════
export default function SurveysPage() {
  const [view, setView] = useState({ mode: 'list' }); // {mode:'list'} | {mode:'builder',form} | {mode:'results',id}
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState(null); // { tone: 'ok'|'warn', text }
  const [publishRow, setPublishRow] = useState(null); // confirm modal

  // Reference data for the audience picker (cached once, announcement idiom).
  const [entities, setEntities] = useState([]);
  const [departments, setDepartments] = useState([]);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/surveys', { status, page, pageSize })
      .then(setData)
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load surveys.'))
      .finally(() => setLoading(false));
  }, [status, page, pageSize]);

  useEffect(() => {
    if (view.mode === 'list') load();
  }, [load, view.mode]);

  useEffect(() => {
    // Best-effort reference data — a failure just disables the narrowed scopes.
    get('/api/hr/org/entities').then((r) => setEntities(r.items || r || [])).catch(() => {});
    get('/api/hr/org/departments').then((r) => setDepartments(r.items || r || [])).catch(() => {});
  }, []);

  const items = data?.items || [];
  const total = data?.total ?? items.length;

  function openCreate() {
    setNotice(null);
    setView({ mode: 'builder', form: emptyForm() });
  }

  async function openEdit(row) {
    setBusyId(row.id);
    setError('');
    try {
      const r = await get(`/api/hr/surveys/${row.id}`);
      setNotice(null);
      setView({ mode: 'builder', form: formFromSurvey(r.survey) });
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to load the survey.');
    } finally {
      setBusyId('');
    }
  }

  async function act(id, action) {
    setBusyId(id);
    setError('');
    try {
      await post(`/api/hr/surveys/${id}/${action}`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || `Failed to ${action} the survey.`);
    } finally {
      setBusyId('');
    }
  }

  async function confirmPublish() {
    const row = publishRow;
    if (!row) return;
    setBusyId(row.id);
    setError('');
    try {
      const res = await post(`/api/hr/surveys/${row.id}/publish`);
      if (res.warning) {
        // Tiny-audience warning straight from the publish response (§8.1).
        setNotice({ tone: 'warn', text: `Published — but heads up: ${res.warning}.` });
      } else if (res.notified) {
        setNotice({ tone: 'ok', text: `Published. Invites sent to ${res.notified} ${res.notified === 1 ? 'person' : 'people'}.` });
      } else {
        setNotice({ tone: 'ok', text: 'Published. Scheduled for its go-live time — invites go out then.' });
      }
      setPublishRow(null);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to publish the survey.');
      setPublishRow(null);
    } finally {
      setBusyId('');
    }
  }

  const columns = useMemo(() => [
    {
      key: 'title', header: 'Title',
      render: (r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-gray-900 truncate">{r.title}</span>
          </div>
          <div className="text-xs text-gray-400">
            {r.questionCount != null ? `${r.questionCount} question${r.questionCount === 1 ? '' : 's'}` : ''}
            {r.occurrenceCount ? ` · ${r.occurrenceCount} run${r.occurrenceCount === 1 ? '' : 's'}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'type', header: 'Type', render: (r) => <TypeChip type={r.type} /> },
    { key: 'anonymous', header: 'Anonymity', render: (r) => <AnonBadge anonymous={r.anonymous} /> },
    { key: 'audience', header: 'Audience', render: (r) => <span className="text-gray-600">{audienceLabel(r)}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'cadence', header: 'Cadence', render: (r) => <span className="text-gray-600">{cadenceLabel(r)}</span> },
    { key: 'publishedAt', header: 'Goes live', render: (r) => (r.publishedAt ? formatAdminDate(r.publishedAt) : '—') },
    {
      key: 'actions', header: '', className: 'text-right', cellClassName: 'text-right',
      render: (r) => (
        <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
          {r.status === 'DRAFT' && (
            <ActionButton onClick={() => openEdit(r)} disabled={busyId === r.id}>Edit</ActionButton>
          )}
          {r.status !== 'DRAFT' && (
            <ActionButton onClick={() => setView({ mode: 'results', id: r.id })} disabled={busyId === r.id}>Results</ActionButton>
          )}
          {r.status === 'DRAFT' && (
            <ActionButton tone="positive" onClick={() => setPublishRow(r)} disabled={busyId === r.id}>Publish</ActionButton>
          )}
          {r.status === 'PUBLISHED' && (
            <ActionButton onClick={() => act(r.id, 'close')} disabled={busyId === r.id}>Close</ActionButton>
          )}
          {r.status !== 'ARCHIVED' && (
            <ActionButton tone="danger" onClick={() => act(r.id, 'archive')} disabled={busyId === r.id}>Archive</ActionButton>
          )}
        </div>
      ),
    },
  ], [busyId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (view.mode === 'builder') {
    return (
      <Builder
        initial={view.form}
        entities={entities}
        departments={departments}
        onBack={() => setView({ mode: 'list' })}
        onSaved={() => { setView({ mode: 'list' }); }}
      />
    );
  }

  if (view.mode === 'results') {
    return <ResultsView id={view.id} onBack={() => setView({ mode: 'list' })} />;
  }

  return (
    <div>
      <PageHeader
        title="Surveys & eNPS"
        subtitle="Pulse surveys and employee Net Promoter Score — listen often, never de-anonymise."
        actions={
          <button
            type="button"
            onClick={openCreate}
            className="rounded-lg px-3 py-2 text-sm font-medium text-white"
            style={{ background: 'var(--theme-primary)' }}
          >
            + New survey
          </button>
        }
      />

      <ModuleGuide
        id="surveys"
        title="Run an anonymous pulse or eNPS and read the results safely"
        what="Short, frequent employee-listening surveys. Build the questions once, target an audience, send now or on a schedule (weekly to quarterly), and read a results dashboard that hides any group too small to stay anonymous."
        steps={[
          'Click "+ New survey", pick a type — eNPS pre-inserts the locked 0–10 recommend question.',
          'Keep Anonymous ON (the default) and set the anonymity floor ("hide segments smaller than N").',
          'Add questions (scale, Likert, NPS, single/multi choice, free text), optionally grouped in sections.',
          'Choose the audience — everyone, an entity, a department, or specific people.',
          'Send now, schedule a go-live, or flip Recurring for an automatic weekly/monthly/quarterly pulse.',
          'Publish from the list, then open Results for the eNPS gauge, trend, per-question and segment views.',
        ]}
        example={<>HR at <b>Acme India Pvt Ltd</b> creates a monthly <b>eNPS</b> targeting <b>Everyone</b>, open <b>7 days</b> per run. After the first close the dashboard shows <b>eNPS +24</b>, a 78% response rate, and an Engineering-vs-Sales segment table — a 3-person team renders "Insufficient data" instead of a score.</>}
        tips={[
          'Anonymity is enforced in the data model: anonymous ballots carry no employee link, and it cannot be switched off once anyone has answered.',
          'Segments (and the total) below the floor are suppressed server-side — the dashboard can never leak a small team, and free-text verbatims sit behind an explicit warning.',
        ]}
      />

      <div className="mb-4 flex items-center gap-3">
        <label className="text-sm text-gray-600">
          Status
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            className="ml-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
          >
            {STATUSES.map((s) => <option key={s} value={s}>{s || 'All'}</option>)}
          </select>
        </label>
        <span className="inline-flex items-center text-xs text-gray-400">
          Employees see open runs of published surveys targeted to them
          <InfoTip
            text="An employee only sees a survey that is PUBLISHED, whose run window is open, and whose audience includes them. Anonymous surveys show a lock badge on their portal."
            label="Visibility"
          />
        </span>
      </div>

      {notice && (
        <div
          className={`mb-4 rounded-xl border px-4 py-3 text-sm ${notice.tone === 'warn'
            ? 'border-amber-200 bg-amber-50 text-amber-800'
            : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}
        >
          {notice.text}
        </div>
      )}
      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}

      <DataTable
        columns={columns}
        rows={items}
        loading={loading}
        rowKey={(r) => r.id}
        emptyText="No surveys yet. Create your first pulse or eNPS."
      />

      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        sizes={PAGE_SIZES}
        noun="surveys"
      />

      {publishRow && (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
          <div className="mt-24 w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-gray-900">Publish “{publishRow.title}”?</h2>
            <p className="mt-2 text-sm text-gray-600">
              This opens run #1 to <span className="font-medium">{audienceLabel(publishRow)}</span> and sends the
              invites{publishRow.publishedAt && new Date(publishRow.publishedAt) > new Date() ? ' at its scheduled go-live time' : ' right away'}.
              {publishRow.anonymous ? ' Responses will be anonymous — anonymity cannot be switched off once anyone answers.' : ''}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPublishRow(null)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmPublish}
                disabled={busyId === publishRow.id}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--theme-primary)' }}
              >
                {busyId === publishRow.id ? 'Publishing…' : 'Publish'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Builder — create + DRAFT edit (full-page drill-in; too big for a modal)
// ═════════════════════════════════════════════════════════════════════════════
function Builder({ initial, entities, departments, onBack, onSaved }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleId = (k, id) => setForm((f) => {
    const has = (f[k] || []).includes(id);
    return { ...f, [k]: has ? f[k].filter((x) => x !== id) : [...(f[k] || []), id] };
  });
  const setQuestion = (key, patchObj) => setForm((f) => ({
    ...f,
    questions: f.questions.map((q) => (q._key === key ? { ...q, ...patchObj } : q)),
  }));
  const removeQuestion = (key) => setForm((f) => ({ ...f, questions: f.questions.filter((q) => q._key !== key) }));
  const moveQuestion = (idx, dir) => setForm((f) => {
    const to = idx + dir;
    if (to < 0 || to >= f.questions.length) return f;
    const next = [...f.questions];
    const [q] = next.splice(idx, 1);
    next.splice(to, 0, q);
    return { ...f, questions: next };
  });
  const addQuestion = (type) => setForm((f) => ({ ...f, questions: [...f.questions, newQuestion(type)] }));

  function changeType(nextType) {
    setForm((f) => {
      let questions = f.questions;
      // Picking eNPS pre-inserts the LOCKED 0–10 driver question (once).
      if (nextType === 'ENPS' && !questions.some((q) => q.isEnpsDriver && q.type === 'NPS')) {
        questions = [enpsDriverQuestion(), ...questions];
      }
      return { ...f, type: nextType, questions };
    });
  }

  async function save() {
    const clientError = validateForm(form);
    if (clientError) { setFormError(clientError); return; }
    setSaving(true);
    setFormError('');
    try {
      const payload = payloadFromForm(form);
      if (form.id) await patch(`/api/hr/surveys/${form.id}`, payload);
      else await post('/api/hr/surveys', payload);
      onSaved();
    } catch (e) {
      // 409 VERSION_CONFLICT / ANONYMITY_LOCKED and 400 validation come through
      // with a server message — surface it verbatim.
      setFormError(e.data?.message || e.message || 'Failed to save the survey.');
    } finally {
      setSaving(false);
    }
  }

  const isDraft = form.status === 'DRAFT';
  const sentence = cadenceSentence(form);
  const weekly = form.cadence === 'WEEKLY' || form.cadence === 'FORTNIGHTLY';

  return (
    <div>
      <PageHeader
        title={form.id ? 'Edit survey' : 'New survey'}
        subtitle={form.id ? `Editing “${form.title || 'Untitled'}” (draft)` : 'Build a pulse, eNPS or custom survey.'}
        actions={
          <button
            type="button"
            onClick={onBack}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            ← Back to surveys
          </button>
        }
      />

      {formError && <div className="mb-4"><ErrorBanner message={formError} /></div>}

      <div className="space-y-5">
        {/* ── Basics ── */}
        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">Basics</h2>
          <div className="space-y-4">
            <div>
              <LabelWithTip label="Title" tip="Shown to employees at the top of the survey and on their portal list." htmlFor="sv-title" />
              <input
                id="sv-title"
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                placeholder="e.g. Monthly pulse — July"
              />
            </div>
            <div>
              <LabelWithTip label="Description (optional)" tip="A short intro employees see before the questions — why you're asking and what happens with the answers." htmlFor="sv-desc" />
              <textarea
                id="sv-desc"
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                rows={2}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                placeholder="Two minutes, fully anonymous — help us make this a better place to work."
              />
            </div>
            <div>
              <LabelWithTip label="Type" tip="Pulse = a short recurring check-in. eNPS = the 0–10 'would you recommend us' score (the driver question is pre-inserted and locked). Custom = anything else." htmlFor="sv-type" />
              <div className="flex gap-2" id="sv-type">
                {TYPES.map((t) => {
                  const on = form.type === t.value;
                  return (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => changeType(t.value)}
                      disabled={!isDraft}
                      className={`rounded-full border px-4 py-1.5 text-sm font-medium disabled:opacity-50 ${on ? 'border-transparent text-white' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}
                      style={on ? { background: 'var(--theme-primary)' } : undefined}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {/* ── Anonymity (prominent, the load-bearing toggle) ── */}
        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start gap-4">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={form.anonymous}
                onChange={(e) => set('anonymous', e.target.checked)}
                className="mt-1 h-4 w-4"
              />
              <span>
                <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                  <LockIcon size={14} /> Anonymous
                </span>
                <span className="mt-0.5 block max-w-md text-xs text-gray-500">{ANON_EXPLAINER}</span>
              </span>
            </label>
            <div className="ml-auto">
              <LabelWithTip
                label="Hide segments smaller than"
                tip="The k-anonymity floor. Any total or breakdown group with fewer responses than this is hidden ('Insufficient data') so a small team can never be read off the dashboard. Industry default: 5."
                htmlFor="sv-k"
              />
              <input
                id="sv-k"
                type="number"
                min={1}
                max={100}
                value={form.minResponsesToShow}
                onChange={(e) => set('minResponsesToShow', e.target.value)}
                className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
        </section>

        {/* ── Questions ── */}
        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
              Questions
              {!isDraft && (
                <span className="ml-2 font-normal normal-case text-gray-400">
                  (locked — questions can only change while the survey is a draft with no responses)
                </span>
              )}
            </h2>
          </div>

          {form.questions.length === 0 && (
            <p className="mb-3 text-sm text-gray-400">No questions yet — add your first one below.</p>
          )}

          <div className="space-y-3">
            {form.questions.map((q, i) => (
              <QuestionEditor
                key={q._key}
                q={q}
                index={i}
                total={form.questions.length}
                locked={!isDraft}
                driverLocked={q.isEnpsDriver && form.type === 'ENPS'}
                onChange={(patchObj) => setQuestion(q._key, patchObj)}
                onRemove={() => removeQuestion(q._key)}
                onMove={(dir) => moveQuestion(i, dir)}
              />
            ))}
          </div>

          {isDraft && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-gray-500">Add question:</span>
              {QUESTION_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => addQuestion(t.value)}
                  className="rounded-full border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  + {t.label}
                </button>
              ))}
            </div>
          )}
        </section>

        {/* ── Audience (same picker family as announcements) ── */}
        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">Audience</h2>
          <div className="space-y-4">
            <div>
              <LabelWithTip label="Who gets this survey" tip="Everyone, or narrowed to one-or-more entities / departments, or a specific set of people. If the audience is smaller than the anonymity floor, results will stay hidden." htmlFor="sv-scope" />
              <select
                id="sv-scope"
                value={form.audienceScope}
                onChange={(e) => set('audienceScope', e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>

            {form.audienceScope === 'ENTITY' && (
              <ChipPicker
                label="Entities"
                options={entities.map((e) => ({ id: e.id, label: e.displayName || e.legalName || e.code }))}
                selected={form.audienceEntityIds}
                onToggle={(id) => toggleId('audienceEntityIds', id)}
                emptyHint="No entities found."
              />
            )}
            {form.audienceScope === 'DEPARTMENT' && (
              <ChipPicker
                label="Departments"
                options={departments.map((d) => ({ id: d.id, label: d.name || d.code }))}
                selected={form.audienceDeptIds}
                onToggle={(id) => toggleId('audienceDeptIds', id)}
                emptyHint="No departments found."
              />
            )}
            {form.audienceScope === 'SPECIFIC' && (
              <EmployeeMultiPicker
                ids={form.audienceEmployeeIds || []}
                labels={form.audienceEmployeeLabels || {}}
                onAdd={(emp) => setForm((f) => {
                  if ((f.audienceEmployeeIds || []).includes(emp.id)) return f;
                  return {
                    ...f,
                    audienceEmployeeIds: [...(f.audienceEmployeeIds || []), emp.id],
                    audienceEmployeeLabels: { ...(f.audienceEmployeeLabels || {}), [emp.id]: employeeName(emp) },
                  };
                })}
                onRemove={(id) => setForm((f) => {
                  const nextLabels = { ...(f.audienceEmployeeLabels || {}) };
                  delete nextLabels[id];
                  return {
                    ...f,
                    audienceEmployeeIds: (f.audienceEmployeeIds || []).filter((x) => x !== id),
                    audienceEmployeeLabels: nextLabels,
                  };
                })}
              />
            )}
          </div>
        </section>

        {/* ── Schedule ── */}
        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500">Schedule</h2>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-4">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="sv-when" checked={form.sendNow} onChange={() => set('sendNow', true)} />
                Send now (goes live when you publish)
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="sv-when" checked={!form.sendNow} onChange={() => set('sendNow', false)} />
                Pick a go-live time
              </label>
              {!form.sendNow && (
                <input
                  type="datetime-local"
                  value={form.publishedAt}
                  onChange={(e) => set('publishedAt', e.target.value)}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  aria-label="Go-live time"
                />
              )}
            </div>

            <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
              <label className="inline-flex items-center gap-2 text-sm font-medium text-gray-900">
                <input type="checkbox" checked={form.recurring} onChange={(e) => set('recurring', e.target.checked)} />
                Recurring
                <InfoTip text="Automatically opens a fresh run on the cadence (Pulse #1, #2, #3…). Each run stays open for the window length; eNPS trends across runs." label="Recurring" />
              </label>

              {form.recurring && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <LabelWithTip label="Cadence" tip="How often a new run opens." htmlFor="sv-cadence" />
                    <select
                      id="sv-cadence"
                      value={form.cadence}
                      onChange={(e) => set('cadence', e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    >
                      {CADENCES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <LabelWithTip
                      label={weekly ? 'Anchor day (week)' : 'Anchor day (month)'}
                      tip={weekly ? 'Which weekday each run opens on.' : 'Which day of the month each run opens on (1–31).'}
                      htmlFor="sv-anchor"
                    />
                    {weekly ? (
                      <select
                        id="sv-anchor"
                        value={String(Math.min(7, Math.max(1, Number(form.cadenceAnchorDay) || 1)))}
                        onChange={(e) => set('cadenceAnchorDay', Number(e.target.value))}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                      >
                        {WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
                      </select>
                    ) : (
                      <input
                        id="sv-anchor"
                        type="number"
                        min={1}
                        max={31}
                        value={form.cadenceAnchorDay}
                        onChange={(e) => set('cadenceAnchorDay', e.target.value)}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                      />
                    )}
                  </div>
                  <div>
                    <LabelWithTip label="Window (days)" tip="How many days each run stays open for answers (1–90)." htmlFor="sv-window" />
                    <input
                      id="sv-window"
                      type="number"
                      min={1}
                      max={90}
                      value={form.windowDays}
                      onChange={(e) => set('windowDays', e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <LabelWithTip label="Ends (optional)" tip="Stop opening new runs after this date. Leave blank to keep going until you close the survey." htmlFor="sv-ends" />
                    <input
                      id="sv-ends"
                      type="datetime-local"
                      value={form.recurrenceEndsAt}
                      onChange={(e) => set('recurrenceEndsAt', e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </div>
                </div>
              )}

              {!form.recurring && (
                <div className="mt-3">
                  <LabelWithTip label="Window (days)" tip="How many days the survey stays open for answers after go-live (1–90)." htmlFor="sv-window-once" />
                  <input
                    id="sv-window-once"
                    type="number"
                    min={1}
                    max={90}
                    value={form.windowDays}
                    onChange={(e) => set('windowDays', e.target.value)}
                    className="w-32 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
              )}

              {sentence && (
                <p className="mt-3 text-sm font-medium" style={{ color: 'var(--theme-primary)' }}>
                  {sentence}
                </p>
              )}
            </div>
          </div>
        </section>
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving || !form.title.trim()}
          className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--theme-primary)' }}
        >
          {saving ? 'Saving…' : form.id ? 'Save changes' : 'Create draft'}
        </button>
      </div>
      <p className="mt-3 text-right text-xs text-gray-400">
        Saving keeps it a draft. Use “Publish” on the list to go live and invite the audience.
      </p>
    </div>
  );
}

// One question card in the builder.
function QuestionEditor({ q, index, total, locked, driverLocked, onChange, onRemove, onMove }) {
  const typeLabel = (QUESTION_TYPES.find((t) => t.value === q.type) || {}).label || q.type;
  const setOption = (i, patchObj) => onChange({
    options: q.options.map((o, j) => (j === i ? { ...o, ...patchObj } : o)),
  });
  const removeOption = (i) => onChange({ options: q.options.filter((_, j) => j !== i) });
  const addOption = () => {
    const has = new Set(q.options.map((o) => o.value));
    let n = q.options.length + 1;
    while (has.has(`opt_${n}`)) n += 1;
    onChange({ options: [...q.options, { value: `opt_${n}`, label: '' }] });
  };
  const disabled = locked;

  return (
    <div className="rounded-xl border border-gray-200 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs font-semibold text-gray-400">Q{index + 1}</span>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600">{typeLabel}</span>
        {q.isEnpsDriver && (
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
            style={{ background: '#eef2ff', color: '#4338ca' }}
            title="This question drives the eNPS score. It is locked on an eNPS survey and cannot be deleted."
          >
            <LockIcon /> eNPS driver{driverLocked ? ' · locked' : ''}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <ActionButton onClick={() => onMove(-1)} disabled={disabled || index === 0}>↑</ActionButton>
          <ActionButton onClick={() => onMove(1)} disabled={disabled || index === total - 1}>↓</ActionButton>
          {!driverLocked && (
            <ActionButton tone="danger" onClick={onRemove} disabled={disabled}>✕</ActionButton>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <input
          value={q.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
          disabled={disabled}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
          placeholder="Question prompt…"
          aria-label={`Question ${index + 1} prompt`}
        />

        <div className="flex flex-wrap items-center gap-4">
          <input
            value={q.section}
            onChange={(e) => onChange({ section: e.target.value })}
            disabled={disabled}
            className="w-56 rounded-lg border border-gray-300 px-3 py-1.5 text-xs disabled:bg-gray-50"
            placeholder="Section label (optional, e.g. Wellbeing)"
            aria-label={`Question ${index + 1} section`}
          />
          <label className="inline-flex items-center gap-1.5 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={q.required}
              onChange={(e) => onChange({ required: e.target.checked })}
              disabled={disabled || driverLocked}
            />
            Required
          </label>
        </div>

        {(q.type === 'SCALE' || q.type === 'LIKERT') && (
          <div className="grid gap-2 sm:grid-cols-4">
            <input
              type="number"
              value={q.scaleMin ?? ''}
              onChange={(e) => onChange({ scaleMin: e.target.value === '' ? null : Number(e.target.value) })}
              disabled={disabled}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs disabled:bg-gray-50"
              placeholder="Min (e.g. 1)"
              aria-label="Scale minimum"
            />
            <input
              type="number"
              value={q.scaleMax ?? ''}
              onChange={(e) => onChange({ scaleMax: e.target.value === '' ? null : Number(e.target.value) })}
              disabled={disabled}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs disabled:bg-gray-50"
              placeholder="Max (e.g. 5)"
              aria-label="Scale maximum"
            />
            <input
              value={q.scaleMinLabel}
              onChange={(e) => onChange({ scaleMinLabel: e.target.value })}
              disabled={disabled}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs disabled:bg-gray-50"
              placeholder="Low label (e.g. Strongly disagree)"
              aria-label="Scale low label"
            />
            <input
              value={q.scaleMaxLabel}
              onChange={(e) => onChange({ scaleMaxLabel: e.target.value })}
              disabled={disabled}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs disabled:bg-gray-50"
              placeholder="High label (e.g. Strongly agree)"
              aria-label="Scale high label"
            />
          </div>
        )}

        {q.type === 'NPS' && (
          <p className="text-xs text-gray-400">0–10 scale, fixed. Promoters 9–10 · passives 7–8 · detractors 0–6.</p>
        )}

        {(q.type === 'SINGLE' || q.type === 'MULTI') && (
          <div className="space-y-2">
            {q.options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={o.value}
                  onChange={(e) => setOption(i, { value: e.target.value })}
                  disabled={disabled}
                  className="w-28 rounded-lg border border-gray-300 px-2 py-1.5 font-mono text-xs disabled:bg-gray-50"
                  placeholder="value"
                  aria-label={`Option ${i + 1} value`}
                  title="Stable value stored with each answer — keep it short and never reuse it for a different meaning."
                />
                <input
                  value={o.label}
                  onChange={(e) => setOption(i, { label: e.target.value })}
                  disabled={disabled}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs disabled:bg-gray-50"
                  placeholder={`Option ${i + 1} label`}
                  aria-label={`Option ${i + 1} label`}
                />
                <ActionButton tone="danger" onClick={() => removeOption(i)} disabled={disabled}>✕</ActionButton>
              </div>
            ))}
            <div className="flex items-center gap-4">
              {!disabled && (
                <button type="button" onClick={addOption} className="text-xs font-medium" style={{ color: 'var(--theme-primary)' }}>
                  + Add option
                </button>
              )}
              <label className="inline-flex items-center gap-1.5 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={q.allowOther}
                  onChange={(e) => onChange({ allowOther: e.target.checked })}
                  disabled={disabled}
                />
                Allow “Other” free text
                <InfoTip text="Adds an 'Other' choice with a small text box. Because free text can identify people, it only surfaces in the gated Verbatims view — never in option or segment charts." label="Other" />
              </label>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ChipPicker({ label, options, selected, onToggle, emptyHint }) {
  return (
    <div>
      <div className="mb-1 block text-sm font-medium text-gray-700">{label}</div>
      {options.length === 0 ? (
        <p className="text-xs text-gray-400">{emptyHint}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {options.map((o) => {
            const on = selected.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => onToggle(o.id)}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${on ? 'border-transparent text-white' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}
                style={on ? { background: 'var(--theme-primary)' } : undefined}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Specific-people targeting — the announcements EmployeeMultiPicker pattern:
// search-select adds a chip, only IDs persist, names are a display cache.
function EmployeeMultiPicker({ ids, labels, onAdd, onRemove }) {
  const [pickCount, setPickCount] = useState(0);
  return (
    <div>
      <LabelWithTip
        label="Specific people"
        tip="Search the directory by name, code or work email and add each person you want to survey. Only people you're allowed to see appear."
        htmlFor="sv-emps"
      />
      <EmployeeSearchSelect
        key={pickCount}
        id="sv-emps"
        status="ACTIVE"
        placeholder="Search by name, code or email…"
        onSelect={(emp) => { if (emp) { onAdd(emp); setPickCount((n) => n + 1); } }}
      />
      {ids.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {ids.map((id) => (
            <span key={id} className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">
              {labels[id] || id}
              <button type="button" onClick={() => onRemove(id)} className="text-gray-400 hover:text-gray-700" aria-label={`Remove ${labels[id] || id}`}>
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-gray-400">No people added yet — search above to target individuals.</p>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Results dashboard — Overview / Trend / Segments / Verbatims
// ═════════════════════════════════════════════════════════════════════════════
function enpsColor(v) {
  if (v < 0) return '#dc2626';
  if (v <= 20) return '#d97706';
  return '#059669';
}

function ResultsView({ id, onBack }) {
  const [meta, setMeta] = useState(null); // survey detail (occurrences + questions)
  const [error, setError] = useState('');
  const [occId, setOccId] = useState('');
  const [tab, setTab] = useState('overview');
  const [results, setResults] = useState(null);
  const [loadingResults, setLoadingResults] = useState(true);
  const [trend, setTrend] = useState(null);
  const [segments, setSegments] = useState(null);
  const [segQuestionId, setSegQuestionId] = useState('');
  const [ackOpen, setAckOpen] = useState(false);
  const [verbAcked, setVerbAcked] = useState(false);
  const [verbatims, setVerbatims] = useState(null);

  useEffect(() => {
    get(`/api/hr/surveys/${id}`)
      .then((r) => {
        setMeta(r.survey);
        const occs = r.survey.occurrences || [];
        if (occs.length) setOccId(occs[0].id); // detail sorts seq desc → latest first
      })
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load the survey.'));
  }, [id]);

  useEffect(() => {
    if (!meta) return;
    setLoadingResults(true);
    get(`/api/hr/surveys/${id}/results`, occId ? { occurrenceId: occId } : undefined)
      .then(setResults)
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load results.'))
      .finally(() => setLoadingResults(false));
  }, [id, meta, occId]);

  useEffect(() => {
    get(`/api/hr/surveys/${id}/results/trend`).then(setTrend).catch(() => setTrend(null));
  }, [id]);

  useEffect(() => {
    if (!meta) return;
    const params = {};
    if (occId) params.occurrenceId = occId;
    if (segQuestionId) params.questionId = segQuestionId;
    get(`/api/hr/surveys/${id}/results/segments`, params)
      .then(setSegments)
      .catch((e) => setSegments({ error: e.data?.message || e.message || 'Failed to load segments.' }));
  }, [id, meta, occId, segQuestionId]);

  useEffect(() => {
    if (!verbAcked) { setVerbatims(null); return; }
    const params = { ack: 1 };
    if (occId) params.occurrenceId = occId;
    get(`/api/hr/surveys/${id}/results/verbatims`, params)
      .then(setVerbatims)
      .catch((e) => setVerbatims({ error: e.data?.message || e.message || 'Failed to load verbatims.' }));
  }, [id, verbAcked, occId]);

  const k = results?.survey?.minResponsesToShow ?? meta?.minResponsesToShow ?? 5;
  const occ = results?.occurrence || null;
  const occurrences = meta?.occurrences || [];
  const driverQ = (results?.questions || []).find((q) => q.isEnpsDriver) || null;
  const segmentableQs = (meta?.questions || []).filter((q) => q.type !== 'TEXT');

  return (
    <div>
      <PageHeader
        title={meta ? meta.title : 'Survey results'}
        subtitle={
          meta ? (
            <span className="inline-flex items-center gap-2">
              <TypeChip type={meta.type} />
              <AnonBadge anonymous={meta.anonymous} />
              <StatusBadge status={meta.status} />
            </span>
          ) : 'Loading…'
        }
        actions={
          <button
            type="button"
            onClick={onBack}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            ← Back to surveys
          </button>
        }
      />

      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}

      {occurrences.length > 1 && (
        <div className="mb-4">
          <label className="text-sm text-gray-600">
            Run
            <select
              value={occId}
              onChange={(e) => setOccId(e.target.value)}
              className="ml-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
            >
              {occurrences.map((o) => (
                <option key={o.id} value={o.id}>
                  Pulse #{o.seq} · {formatAdminDate(o.opensAt)} → {formatAdminDate(o.closesAt)}{o.status === 'OPEN' ? ' · open' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <Tabs
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'trend', label: 'Trend' },
          { key: 'segments', label: 'Segments' },
          { key: 'verbatims', label: 'Verbatims' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' && (
        <div className="space-y-5">
          {!occ && !loadingResults && (
            <p className="text-sm text-gray-400">No runs yet — results appear once the survey is published and live.</p>
          )}

          {occ && (
            <div className="grid gap-4 md:grid-cols-3">
              {driverQ && (
                <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm md:col-span-2">
                  <div className="mb-2 flex items-center text-sm font-semibold text-gray-700">
                    eNPS
                    <InfoTip text="% promoters (9–10) minus % detractors (0–6), −100 to +100. Passives (7–8) are counted but excluded from the subtraction. Rule of thumb: above 0 is okay, above +20 is good, above +50 is world-class." label="What is eNPS?" />
                  </div>
                  {driverQ.aggregate?.suppressed ? (
                    <Suppressed k={k} />
                  ) : (
                    <EnpsBlock agg={driverQ.aggregate} />
                  )}
                </div>
              )}

              <div className={`rounded-2xl border border-gray-200 bg-white p-5 shadow-sm ${driverQ ? '' : 'md:col-span-2'}`}>
                <div className="mb-2 flex items-center text-sm font-semibold text-gray-700">
                  Response rate
                  <InfoTip text="Submitted ballots over invited people for this run — computed from the participation ledger (who answered), never from the anonymous ballot contents." label="Response rate" />
                </div>
                <div className="flex items-center gap-4">
                  <RateRing pct={occ.responseRate || 0} />
                  <div className="text-sm text-gray-600">
                    <div className="font-medium text-gray-900">{occ.responseCount} of {occ.invitedCount} invited</div>
                    <div className="text-xs text-gray-400">Pulse #{occ.seq} · {occ.status === 'OPEN' ? `open until ${formatAdminDate(occ.closesAt)}` : 'closed'}</div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {(results?.questions || []).map((q) => (
            <QuestionResultCard key={q.id} q={q} k={k} />
          ))}
        </div>
      )}

      {tab === 'trend' && (
        <TrendPanel trend={trend} k={k} />
      )}

      {tab === 'segments' && (
        <div className="space-y-4">
          {segmentableQs.length > 1 && (
            <label className="text-sm text-gray-600">
              Question
              <select
                value={segQuestionId}
                onChange={(e) => setSegQuestionId(e.target.value)}
                className="ml-2 max-w-md rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
              >
                <option value="">Default (eNPS driver / first ratable)</option>
                {segmentableQs.map((q) => <option key={q.id} value={q.id}>{q.prompt}</option>)}
              </select>
            </label>
          )}
          <SegmentsPanel segments={segments} k={k} />
        </div>
      )}

      {tab === 'verbatims' && (
        <div className="space-y-4">
          {!verbAcked ? (
            <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                <LockIcon size={14} /> Free-text answers are gated
              </div>
              <p className="mt-2 max-w-xl text-sm text-gray-600">
                Free text may reduce anonymity — the way someone writes, or what they mention, can identify them even
                without a name. Verbatims are shown without segment labels, in shuffled order, and only when enough
                people wrote something.
              </p>
              <button
                type="button"
                onClick={() => setAckOpen(true)}
                className="mt-4 rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: 'var(--theme-primary)' }}
              >
                Read the verbatims
              </button>
            </div>
          ) : (
            <VerbatimsPanel verbatims={verbatims} k={k} />
          )}
        </div>
      )}

      {ackOpen && (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
          <div className="mt-24 w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-gray-900">Before you read free text</h2>
            <p className="mt-2 text-sm text-gray-600">
              Free-text may reduce anonymity: writing style and specific details can identify a person even on an
              anonymous survey. Treat these as confidential, never quote them back verbatim in a small group, and never
              try to work out who wrote what.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAckOpen(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { setAckOpen(false); setVerbAcked(true); }}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white"
                style={{ background: 'var(--theme-primary)' }}
              >
                I understand — show them
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Headline eNPS: colour-banded score + promoter/passive/detractor bars.
function EnpsBlock({ agg }) {
  const color = enpsColor(agg.enps);
  const rows = [
    { label: 'Promoters (9–10)', count: agg.promoters, pct: agg.promoterPct, color: '#059669' },
    { label: 'Passives (7–8)', count: agg.passives, pct: agg.passivePct, color: '#9ca3af' },
    { label: 'Detractors (0–6)', count: agg.detractors, pct: agg.detractorPct, color: '#dc2626' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="text-center">
        <div className="text-5xl font-bold tabular-nums" style={{ color }}>
          {agg.enps > 0 ? `+${agg.enps}` : agg.enps}
        </div>
        <div className="mt-1 text-xs text-gray-400">−100 … +100 · {agg.total} responses</div>
      </div>
      <div className="min-w-[220px] flex-1 space-y-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2 text-xs text-gray-600">
            <span className="w-32 shrink-0">{r.label}</span>
            <HBar pct={r.pct} color={r.color} />
            <span className="w-20 shrink-0 text-right tabular-nums">{r.count} · {r.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RateRing({ pct }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, pct)) / 100) * c;
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" role="img" aria-label={`${pct}% response rate`}>
      <circle cx="36" cy="36" r={r} fill="none" stroke="#e5e7eb" strokeWidth="8" />
      <circle
        cx="36" cy="36" r={r} fill="none" stroke="var(--theme-primary)" strokeWidth="8"
        strokeDasharray={`${filled} ${c - filled}`} strokeLinecap="round" transform="rotate(-90 36 36)"
      />
      <text x="36" y="41" textAnchor="middle" fontSize="15" fontWeight="600" fill="#111827">{pct}%</text>
    </svg>
  );
}

// One per-question result card, by aggregate type (everything k-suppressible).
function QuestionResultCard({ q, k }) {
  const agg = q.aggregate || {};
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0">
          {q.section && <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{q.section}</div>}
          <div className="text-sm font-medium text-gray-900">{q.prompt}</div>
        </div>
        <span className="ml-auto shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500">
          {(QUESTION_TYPES.find((t) => t.value === q.type) || {}).label || q.type}
        </span>
      </div>

      {agg.suppressed ? (
        <Suppressed k={k} />
      ) : agg.type === 'NPS' ? (
        <EnpsBlock agg={agg} />
      ) : agg.type === 'SCALE' || agg.type === 'LIKERT' ? (
        <ScaleDistribution q={q} agg={agg} />
      ) : agg.type === 'SINGLE' || agg.type === 'MULTI' ? (
        <OptionBars agg={agg} />
      ) : agg.type === 'TEXT' ? (
        <p className="text-sm text-gray-600">
          {agg.count} text response{agg.count === 1 ? '' : 's'} — read them in the Verbatims tab.
        </p>
      ) : (
        <Suppressed k={k} />
      )}
    </div>
  );
}

function ScaleDistribution({ q, agg }) {
  const max = Math.max(1, ...agg.distribution.map((d) => d.count));
  return (
    <div>
      <div className="mb-2 text-sm text-gray-700">
        Mean <span className="font-semibold tabular-nums">{agg.mean}</span>
        <span className="ml-2 text-xs text-gray-400">{agg.count} response{agg.count === 1 ? '' : 's'}</span>
      </div>
      <div className="space-y-1.5">
        {agg.distribution.map((d) => (
          <div key={d.value} className="flex items-center gap-2 text-xs text-gray-600">
            <span className="w-6 shrink-0 text-right tabular-nums">{d.value}</span>
            <HBar pct={(d.count / max) * 100} color="var(--theme-primary)" />
            <span className="w-8 shrink-0 tabular-nums">{d.count}</span>
          </div>
        ))}
      </div>
      {(q.scaleMinLabel || q.scaleMaxLabel) && (
        <div className="mt-2 flex justify-between text-[11px] text-gray-400">
          <span>{q.scaleMin} = {q.scaleMinLabel || 'low'}</span>
          <span>{q.scaleMax} = {q.scaleMaxLabel || 'high'}</span>
        </div>
      )}
    </div>
  );
}

function OptionBars({ agg }) {
  return (
    <div className="space-y-1.5">
      {agg.options.map((o) => (
        <div key={o.value} className="flex items-center gap-2 text-xs text-gray-600">
          <span className="w-40 shrink-0 truncate" title={o.label}>{o.label}</span>
          <HBar pct={o.pct} color="var(--theme-primary)" />
          <span className="w-20 shrink-0 text-right tabular-nums">{o.count} · {o.pct}%</span>
        </div>
      ))}
      <div className="pt-1 text-[11px] text-gray-400">
        {agg.count} response{agg.count === 1 ? '' : 's'}
        {agg.otherCount > 0 ? ` · ${agg.otherCount} wrote "Other" (see Verbatims)` : ''}
      </div>
    </div>
  );
}

// eNPS trend across occurrences — plain SVG polyline, suppressed points are gaps.
function TrendPanel({ trend, k }) {
  const points = trend?.points || [];
  if (!trend || !trend.driverQuestionId) {
    return <p className="text-sm text-gray-400">Trend needs an eNPS driver question — add one (or use the eNPS type) to chart the score over time.</p>;
  }
  if (!points.length) {
    return <p className="text-sm text-gray-400">No runs yet — the trend appears after the first occurrence.</p>;
  }

  const W = 640;
  const H = 200;
  const PAD = 28;
  const x = (i) => (points.length === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (points.length - 1));
  const y = (v) => PAD + ((100 - v) * (H - 2 * PAD)) / 200; // +100 → top, −100 → bottom

  // Break the polyline at suppressed points so a thin run shows a GAP, not a fake value.
  const segs = [];
  let cur = [];
  points.forEach((p, i) => {
    if (p.suppressed) {
      if (cur.length) segs.push(cur);
      cur = [];
    } else {
      cur.push({ ...p, i });
    }
  });
  if (cur.length) segs.push(cur);
  const shown = points.filter((p) => !p.suppressed);
  const suppressedCount = points.length - shown.length;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-2 flex items-center text-sm font-semibold text-gray-700">
        eNPS over time
        <InfoTip text="One point per run. A run with fewer responses than the anonymity floor shows a gap — never a fabricated number." label="Trend" />
      </div>
      <div className="overflow-x-auto">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="eNPS trend chart">
          {/* zero line + band guides */}
          <line x1={PAD} y1={y(0)} x2={W - PAD} y2={y(0)} stroke="#e5e7eb" strokeDasharray="4 4" />
          <text x={W - PAD + 4} y={y(0) + 4} fontSize="10" fill="#9ca3af">0</text>
          <text x={W - PAD + 4} y={y(100) + 4} fontSize="10" fill="#9ca3af">+100</text>
          <text x={W - PAD + 4} y={y(-100) + 4} fontSize="10" fill="#9ca3af">−100</text>
          {segs.map((seg, si) => (
            <polyline
              key={si}
              fill="none"
              stroke="var(--theme-primary)"
              strokeWidth="2"
              points={seg.map((p) => `${x(p.i)},${y(p.enps)}`).join(' ')}
            />
          ))}
          {points.map((p, i) => p.suppressed ? (
            <g key={p.occurrenceId}>
              <circle cx={x(i)} cy={y(0)} r="4" fill="#e5e7eb" stroke="#9ca3af" strokeDasharray="2 2">
                <title>{`Pulse #${p.seq}: hidden to protect anonymity (need ≥${k} responses)`}</title>
              </circle>
            </g>
          ) : (
            <g key={p.occurrenceId}>
              <circle cx={x(i)} cy={y(p.enps)} r="4" fill={enpsColor(p.enps)}>
                <title>{`Pulse #${p.seq}: eNPS ${p.enps > 0 ? '+' : ''}${p.enps} (${p.total} responses)`}</title>
              </circle>
            </g>
          ))}
          {points.map((p, i) => (
            <text key={`t${p.occurrenceId}`} x={x(i)} y={H - 8} fontSize="10" fill="#9ca3af" textAnchor="middle">
              #{p.seq}
            </text>
          ))}
        </svg>
      </div>
      {suppressedCount > 0 && (
        <div className="mt-2 flex items-center gap-1 text-xs text-gray-400">
          {suppressedCount} run{suppressedCount === 1 ? '' : 's'} hidden to protect anonymity (need ≥{k})
          <InfoTip text={`Runs with fewer than ${k} responses are plotted as a gap so a small cohort's score can never be read off the chart.`} label="Why the gaps?" />
        </div>
      )}
    </div>
  );
}

function segmentSummary(g) {
  const a = g.aggregate || {};
  if (a.suppressed) return null;
  if (a.type === 'NPS') return `eNPS ${a.enps > 0 ? '+' : ''}${a.enps}`;
  if (a.type === 'SCALE' || a.type === 'LIKERT') return `Mean ${a.mean}`;
  if (a.type === 'SINGLE' || a.type === 'MULTI') {
    const top = [...(a.options || [])].sort((p, q) => q.count - p.count)[0];
    return top ? `Top: ${top.label} (${top.pct}%)` : '—';
  }
  return '—';
}

function SegmentsPanel({ segments, k }) {
  if (!segments) return <p className="text-sm text-gray-400">Loading segments…</p>;
  if (segments.error) return <ErrorBanner message={segments.error} />;
  const groups = segments.groups || [];
  const dimLabel = segments.dimension === 'ENTITY' ? 'Entity' : 'Department';

  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-gray-100 px-5 py-3">
        <span className="text-sm font-semibold text-gray-700">By {dimLabel.toLowerCase()}</span>
        {segments.questionPrompt && <span className="truncate text-xs text-gray-400">· {segments.questionPrompt}</span>}
        <InfoTip
          text={`Responses are grouped by the ${dimLabel.toLowerCase()} each person was in when they answered — a single coarse label, never a combination that could identify someone.`}
          label="Segments"
        />
      </div>
      {groups.length === 0 && !segments.suppressedGroups ? (
        <p className="px-5 py-6 text-sm text-gray-400">No segment data yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-5 py-2.5 font-medium">{dimLabel}</th>
              <th className="px-5 py-2.5 font-medium">Responses</th>
              <th className="px-5 py-2.5 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const summary = segmentSummary(g);
              return (
                <tr key={g.label} className="border-b border-gray-50 last:border-0">
                  <td className="px-5 py-3 font-medium text-gray-900">{g.label}</td>
                  <td className="px-5 py-3 tabular-nums text-gray-600">{g.count}</td>
                  <td className="px-5 py-3 text-gray-700">
                    {summary != null ? summary : (
                      <span className="inline-flex items-center gap-1 text-gray-400">
                        <LockIcon /> Insufficient data — hidden to protect anonymity (need ≥{k})
                        <InfoTip text={`This group has enough people, but fewer than ${k} of them answered this question — so its numbers stay hidden.`} label="Why hidden?" />
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {segments.suppressedGroups > 0 && (
              <tr>
                <td colSpan={3} className="px-5 py-3">
                  <span className="inline-flex items-center gap-1.5 text-sm text-gray-400">
                    <LockIcon />
                    {segments.suppressedGroups} group{segments.suppressedGroups === 1 ? '' : 's'} — Insufficient data — hidden to protect anonymity (need ≥{k})
                    <InfoTip
                      text={`Groups with fewer than ${k} respondents are hidden entirely (no name, no count). If only one group were hidden it could be worked out from the total, so the next-smallest group is hidden too.`}
                      label="Why hidden?"
                    />
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

function VerbatimsPanel({ verbatims, k }) {
  if (!verbatims) return <p className="text-sm text-gray-400">Loading verbatims…</p>;
  if (verbatims.error) return <ErrorBanner message={verbatims.error} />;
  if (verbatims.suppressed) {
    return <Suppressed k={k} label="Not enough written answers" />;
  }
  const items = verbatims.verbatims || [];
  if (!items.length) return <p className="text-sm text-gray-400">No written answers on this run.</p>;
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">
        {items.length} quote{items.length === 1 ? '' : 's'}, shuffled, no segment labels — order never matches submission order.
      </p>
      {items.map((v, i) => (
        <blockquote key={i} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="whitespace-pre-wrap text-sm text-gray-800">“{v.text}”</p>
          {v.prompt && <footer className="mt-2 text-xs text-gray-400">re: {v.prompt}</footer>}
        </blockquote>
      ))}
    </div>
  );
}
