'use client';

// Recruitment → Application-form templates (screening-question sets).
//
// A reusable, named set of screening questions ("form template") a recruiter
// authors once and then applies to any job in one click (a different template
// per job). The applied questions are copied onto the job and remain
// individually editable there — the template is just a fast way to populate
// them. All writes require canManageHiring / canManageEmployees (server-gated);
// the page shows a read-only banner + hides the editors for operators who lack
// it. Reads are open to canViewHiring.
//
//   GET    /api/hr/recruitment/screening-form-templates → { items:[Tpl], total }
//          Tpl = { id, name, description, isDefault, questions:[Q] }
//          Q   = { id, prompt, kind:'BOOLEAN'|'SINGLE_CHOICE'|'MULTI_CHOICE'|
//                  'NUMBER'|'TEXT'|'QUALIFICATION', required, isKnockout,
//                  knockoutValue, maxPoints, sortOrder, options:[Opt] }
//          Opt = { id, label, value, points, sortOrder }
//   GET    /api/hr/recruitment/screening-form-templates/:id → Tpl (full detail)
//   POST   /api/hr/recruitment/screening-form-templates
//          { name, description?, isDefault?, questions:[Q] }  (Q + options w/o ids)
//          → 201 Tpl · 409 if name exists · 422 { message } on invalid questions
//          (choice/qualification kinds need >=1 option; each option a non-empty value)
//   PATCH  /api/hr/recruitment/screening-form-templates/:id  editable subset
//          { name?, description?, isDefault?, questions? }. If `questions` is
//          present it REPLACES the whole set. → Tpl
//   DELETE /api/hr/recruitment/screening-form-templates/:id → { ok, id } (soft archive)
//   POST   /api/hr/recruitment/screening-form-templates/seed-defaults
//          → { ok, created }  (idempotent starter templates)

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBanner, Modal, ModalActions, PrimaryButton, TextInput, TextArea, Spinner } from '@hr/ui';
import { get, post, patch, del } from '@/lib/api';
import { DataTable, PageHeader, ActionButton, asList } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';
import { permissionsFromSession, hasAnyPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';
import { Info, FieldLabel, NumberInput } from '../_components';

/* ── vocab (the 6 question kinds — identical to per-job screening questions) ── */

const KINDS = [
  ['BOOLEAN', 'Yes / No'],
  ['SINGLE_CHOICE', 'Single choice'],
  ['MULTI_CHOICE', 'Multiple choice'],
  ['NUMBER', 'Number'],
  ['TEXT', 'Free text'],
  ['QUALIFICATION', 'Qualification (degree points)'],
  ['FILE', 'File upload (CV, certificate)'],
];
const KIND_LABEL = Object.fromEntries(KINDS);
const OPTION_KINDS = ['SINGLE_CHOICE', 'MULTI_CHOICE', 'QUALIFICATION']; // carry options
const MAXPOINTS_KINDS = ['NUMBER', 'QUALIFICATION']; // maxPoints caps scoring
// A FILE answer is an uploaded document's URL — there is nothing to match it
// against, so knockout and points are hidden for it. The server enforces this
// too; hiding it here just stops anyone building a form that cannot work.
const NEVER_SCORED_KINDS = ['FILE'];
// Only these can carry an "Other (please specify)" option.
const FREE_TEXT_KINDS = ['SINGLE_CHOICE', 'MULTI_CHOICE'];

const MANAGE_KEYS = ['canManageHiring', 'canManageEmployees'];

/* ── knockout value round-tripping ──────────────────────────────────────────── */
// The editor keeps knockoutValue as a single STRING (a select value). Incoming
// templates may carry it as a scalar or (per-job legacy shape) a 1-element array.
function normKnockout(kv) {
  let v = Array.isArray(kv) ? kv[0] : kv;
  if (v === true) return 'true';
  if (v === false) return 'false';
  return v == null ? '' : String(v);
}
function buildKnockout(kind, s) {
  if (s === '' || s == null) return null;
  if (kind === 'BOOLEAN') return s === 'true';
  if (kind === 'NUMBER') { const n = Number(s); return Number.isFinite(n) ? n : s; }
  return s; // choice / text → the option value string
}

/* ── chips ──────────────────────────────────────────────────────────────────── */

function DefaultChip() {
  return (
    <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
      Default
    </span>
  );
}

function KindChip({ kind }) {
  return (
    <span className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
      {KIND_LABEL[kind] || kind}
    </span>
  );
}

/* ── question builder — one question row in the modal ──────────────────────── */

function QuestionCard({ q, index, total, onChange, onRemove, onMove }) {
  const set = (k, v) => onChange({ ...q, [k]: v });
  const isOptionKind = OPTION_KINDS.includes(q.kind);
  const options = q.options || [];

  function setKind(kind) {
    // Seed a first option row when switching into a choice/qualification kind.
    const next = { ...q, kind };
    if (OPTION_KINDS.includes(kind) && (!next.options || next.options.length === 0)) {
      next.options = [{ label: '', value: '', points: 0 }];
    }
    onChange(next);
  }
  const setOpt = (i, k, v) => set('options', options.map((o, j) => (j === i ? { ...o, [k]: v } : o)));
  const addOpt = () => set('options', [...options, { label: '', value: '', points: 0 }]);
  const removeOpt = (i) => set('options', options.length <= 1 ? options : options.filter((_, j) => j !== i));
  const moveOpt = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= options.length) return;
    const next = [...options];
    [next[i], next[j]] = [next[j], next[i]];
    set('options', next);
  };

  // knockout answer options for the choice kinds (from this question's options).
  const koChoices = options
    .map((o) => ({ value: String(o.value || o.label || '').trim(), label: String(o.label || o.value || '').trim() }))
    .filter((o) => o.value);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-600">{index + 1}</span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => onMove(index, -1)} disabled={index === 0} className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-30" aria-label="Move question up">▲</button>
          <button type="button" onClick={() => onMove(index, 1)} disabled={index === total - 1} className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-30" aria-label="Move question down">▼</button>
          <button type="button" onClick={() => onRemove(index)} className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50" aria-label="Remove question">Remove</button>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <FieldLabel hint="The question the candidate answers, e.g. 'Do you have a Computer Science degree?'">Question prompt</FieldLabel>
          <input
            value={q.prompt}
            onChange={(e) => set('prompt', e.target.value)}
            placeholder={`Question ${index + 1}`}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            {/* Kept in step with the per-job editor: Yes/No DOES carry points. The
                old wording read as "Yes/No cannot score" and people built Yes/No
                questions expecting them to count. */}
            <FieldLabel hint="Single choice, Multiple choice, Qualification and Yes/No all carry points per option — add the options below. Number scores the value entered (capped by Max points). Text and File are information only and cannot be scored.">Answer type</FieldLabel>
            <select value={q.kind} onChange={(e) => setKind(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
              {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="flex items-end gap-4 pb-1">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={!!q.required} onChange={(e) => set('required', e.target.checked)} />
              Required
            </label>
            {/* An uploaded file has no value to compare against, so it can never be
                a knockout. Offering the checkbox would let someone build a form
                that auto-rejects every applicant. */}
            {!NEVER_SCORED_KINDS.includes(q.kind) && (
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={!!q.isKnockout} onChange={(e) => set('isKnockout', e.target.checked)} />
                Knockout
                <Info text="A knockout auto-rejects the candidate unless they give the passing answer (e.g. 'Eligible to work → Yes')." />
              </label>
            )}
          </div>
        </div>

        {q.isKnockout && !NEVER_SCORED_KINDS.includes(q.kind) && (
          <div>
            <FieldLabel hint="The passing answer. A candidate who answers anything else is auto-rejected.">Passing answer</FieldLabel>
            {q.kind === 'BOOLEAN' ? (
              <select value={q.knockoutValue ?? ''} onChange={(e) => set('knockoutValue', e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
                <option value="">— pick —</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : isOptionKind ? (
              <select value={q.knockoutValue ?? ''} onChange={(e) => set('knockoutValue', e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
                <option value="">— pick an option —</option>
                {koChoices.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input value={q.knockoutValue ?? ''} onChange={(e) => set('knockoutValue', e.target.value)} placeholder="passing value" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            )}
          </div>
        )}

        {MAXPOINTS_KINDS.includes(q.kind) && (
          <div className="max-w-[12rem]">
            <FieldLabel hint="Caps the points this answer can earn toward the application score.">Max points</FieldLabel>
            <NumberInput value={q.maxPoints} onChange={(v) => set('maxPoints', v)} min={0} />
          </div>
        )}

        {isOptionKind && (
          <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-3">
            <div className="mb-2 flex items-center text-sm font-medium text-gray-700">
              Options + points
              <Info text="Each answer option, the value stored, and the points it earns. e.g. 'Master's → 6', 'B.Tech CS → 20'. The highest-points option is the most this question can add; an option left at 0 earns nothing, and a question whose options are ALL 0 is excluded from the total. For Yes/No, give Yes the points and leave No at 0." />
            </div>
            <div className="space-y-2">
              {options.map((o, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-5"><input value={o.label} onChange={(e) => setOpt(i, 'label', e.target.value)} placeholder="label (shown)" className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" /></div>
                  <div className="col-span-3"><input value={o.value} onChange={(e) => setOpt(i, 'value', e.target.value)} placeholder="value" className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" /></div>
                  <div className="col-span-2"><NumberInput value={o.points} onChange={(v) => setOpt(i, 'points', v)} min={0} /></div>
                  {FREE_TEXT_KINDS.includes(q.kind) && (
                    <div className="col-span-12 -mt-1 pl-1">
                      <label className="inline-flex items-center gap-1.5 text-[11px] text-gray-600">
                        <input
                          type="checkbox"
                          checked={!!o.allowsFreeText}
                          onChange={(e) => setOpt(i, 'allowsFreeText', e.target.checked)}
                          className="h-3.5 w-3.5 rounded border-gray-300"
                        />
                        Picking <b>{o.label || 'this option'}</b> opens a text box for the candidate to explain
                      </label>
                    </div>
                  )}
                  <div className="col-span-2 flex items-center justify-end gap-1">
                    <button type="button" onClick={() => moveOpt(i, -1)} disabled={i === 0} className="rounded-md border border-gray-300 px-1.5 py-1 text-[11px] text-gray-500 hover:bg-white disabled:opacity-30" aria-label="Move option up">▲</button>
                    <button type="button" onClick={() => moveOpt(i, 1)} disabled={i === options.length - 1} className="rounded-md border border-gray-300 px-1.5 py-1 text-[11px] text-gray-500 hover:bg-white disabled:opacity-30" aria-label="Move option down">▼</button>
                    <button type="button" onClick={() => removeOpt(i)} disabled={options.length <= 1} className="rounded-md border border-gray-300 px-1.5 py-1 text-[11px] text-gray-500 hover:bg-white disabled:opacity-40" aria-label="Remove option">✕</button>
                  </div>
                </div>
              ))}
            </div>
            <button type="button" onClick={addOpt} className="mt-2 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-white">+ Add option</button>
            <p className="mt-1 text-[11px] text-gray-400">Label = shown to the candidate · Value = stored (falls back to the label) · Points = awarded. Tick an option to turn it into &ldquo;Other (please specify)&rdquo; — the candidate&rsquo;s typed answer is stored with the choice, and scoring still uses Points.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── create / edit modal ────────────────────────────────────────────────────── */

const EMPTY_QUESTION = () => ({ prompt: '', kind: 'BOOLEAN', required: true, isKnockout: false, knockoutValue: '', maxPoints: '', options: [] });

function TemplateModal({ templateId, onClose, onSaved }) {
  const isEdit = !!templateId;
  const [loading, setLoading] = useState(isEdit);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [questions, setQuestions] = useState(() => [EMPTY_QUESTION()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // On edit, load the FULL template (the list may be light) and hydrate the form.
  useEffect(() => {
    if (!isEdit) return;
    let alive = true;
    setLoading(true);
    get(`/api/hr/recruitment/screening-form-templates/${templateId}`)
      .then((t) => {
        if (!alive) return;
        setName(t.name || '');
        setDescription(t.description || '');
        setIsDefault(!!t.isDefault);
        const qs = (t.questions || [])
          .slice()
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
          .map((q) => ({
            prompt: q.prompt || '',
            kind: q.kind || 'BOOLEAN',
            required: q.required ?? true,
            isKnockout: !!q.isKnockout,
            knockoutValue: normKnockout(q.knockoutValue),
            maxPoints: q.maxPoints ?? '',
            options: (q.options || [])
              .slice()
              .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
              .map((o) => ({ label: o.label ?? '', value: o.value ?? '', points: o.points ?? 0 })),
          }));
        setQuestions(qs.length ? qs : [EMPTY_QUESTION()]);
      })
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load the template.'))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [isEdit, templateId]);

  const setQuestion = (i, q) => setQuestions((arr) => arr.map((x, j) => (j === i ? q : x)));
  const addQuestion = () => setQuestions((arr) => [...arr, EMPTY_QUESTION()]);
  const removeQuestion = (i) => setQuestions((arr) => (arr.length <= 1 ? arr : arr.filter((_, j) => j !== i)));
  const moveQuestion = (i, dir) => setQuestions((arr) => {
    const j = i + dir;
    if (j < 0 || j >= arr.length) return arr;
    const next = [...arr];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  function buildQuestions() {
    return questions.map((q, i) => {
      const optionKind = OPTION_KINDS.includes(q.kind);
      const options = optionKind
        ? (q.options || [])
            .map((o) => {
              const label = String(o.label || '').trim();
              const value = String(o.value || '').trim() || label;
              return { label, value, points: Number(o.points) || 0 };
            })
            .filter((o) => o.value) // each option needs a non-empty value (server 422s otherwise)
            .map((o, j) => ({ ...o, sortOrder: j }))
        : [];
      return {
        prompt: String(q.prompt || '').trim(),
        kind: q.kind,
        required: !!q.required,
        isKnockout: !!q.isKnockout,
        knockoutValue: q.isKnockout ? buildKnockout(q.kind, q.knockoutValue) : null,
        maxPoints: MAXPOINTS_KINDS.includes(q.kind) && q.maxPoints !== '' && q.maxPoints != null ? Number(q.maxPoints) : null,
        sortOrder: i,
        options,
      };
    });
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!name.trim()) { setError('Give the template a name.'); return; }
    const built = buildQuestions();
    // Light client-side mirror of the server's 422 rules so the operator gets
    // immediate feedback; the server is still the real validator.
    for (let i = 0; i < built.length; i += 1) {
      const q = built[i];
      if (!q.prompt) { setError(`Question ${i + 1} needs a prompt.`); return; }
      if (OPTION_KINDS.includes(q.kind) && q.options.length === 0) { setError(`Question ${i + 1} (${KIND_LABEL[q.kind]}) needs at least one option with a value.`); return; }
    }

    setSaving(true);
    const body = { name: name.trim(), description: description.trim() || null, isDefault: !!isDefault, questions: built };
    try {
      if (isEdit) {
        await patch(`/api/hr/recruitment/screening-form-templates/${templateId}`, body);
        onSaved(`"${body.name}" saved.`);
      } else {
        await post('/api/hr/recruitment/screening-form-templates', body);
        onSaved(`"${body.name}" created.`);
      }
    } catch (err) {
      // 409 name clash + 422 { message } invalid-questions surface inline.
      const msg = err.data?.message
        || (err.status === 409 ? 'A template with that name already exists.' : '')
        || err.message
        || 'Failed to save the template.';
      setError(msg);
      setSaving(false);
    }
  }

  return (
    <Modal title={isEdit ? 'Edit form template' : 'New form template'} size="lg" onClose={onClose}>
      {loading ? (
        <div className="py-10 flex justify-center"><Spinner /></div>
      ) : (
        <form onSubmit={save} className="space-y-4">
          {error && <ErrorBanner message={error} />}

          <TextInput label="Template name" value={name} onChange={setName} required placeholder="e.g. Engineering screening" hint="How recruiters recognise this set when applying it to a job." />

          <TextArea label="Description" value={description} onChange={setDescription} rows={2} hint="Optional — a short note on when to use this template." />

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            Make this the default template
            <Info text="The default is the suggested starting point when applying a template to a job." />
          </label>

          <div className="rounded-xl border border-gray-200 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center text-sm font-semibold text-gray-800">
                Questions
                <Info text="The screening questions applied to a job. Choice/qualification answers carry points; tick Knockout to auto-reject a wrong answer." />
              </div>
              <span className="text-xs text-gray-400">{questions.length} question{questions.length === 1 ? '' : 's'}</span>
            </div>
            {questions.map((q, i) => (
              <QuestionCard
                key={i}
                q={q}
                index={i}
                total={questions.length}
                onChange={(nq) => setQuestion(i, nq)}
                onRemove={removeQuestion}
                onMove={moveQuestion}
              />
            ))}
            <button type="button" onClick={addQuestion} className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">+ Add question</button>
          </div>

          <ModalActions>
            <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50">Cancel</button>
            <PrimaryButton type="submit" loading={saving}>{isEdit ? 'Save template' : 'Create template'}</PrimaryButton>
          </ModalActions>
        </form>
      )}
    </Modal>
  );
}

/* ── page ─────────────────────────────────────────────────────────────────── */

export default function FormTemplatesPage() {
  const [templates, setTemplates] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [canManage, setCanManage] = useState(true);
  const [notice, setNotice] = useState('');
  const [seeding, setSeeding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };

  const load = useCallback(() => {
    setLoading(true);
    get('/api/hr/recruitment/screening-form-templates')
      .then((res) => setTemplates(asList(res)))
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load form templates.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    get('/api/auth/me')
      .then((res) => {
        const session = res?.user || res;
        setCanManage(hasAnyPermission(permissionsFromSession(session), MANAGE_KEYS));
      })
      .catch(() => {});
  }, [load]);

  const rows = useMemo(() => {
    const list = templates || [];
    return [...list].sort((a, b) => (b.isDefault === true) - (a.isDefault === true) || String(a.name).localeCompare(String(b.name)));
  }, [templates]);

  async function archive(t) {
    if (!window.confirm(`Archive "${t.name}"? It stops appearing when applying a template; jobs that already used it keep their questions.`)) return;
    try {
      await del(`/api/hr/recruitment/screening-form-templates/${t.id}`);
      flash(`"${t.name}" archived.`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to archive the template.');
    }
  }

  async function seedDefaults() {
    setSeeding(true);
    setError('');
    try {
      const res = await post('/api/hr/recruitment/screening-form-templates/seed-defaults', {});
      flash(res?.created ? `Added ${res.created} starter template${res.created === 1 ? '' : 's'}.` : 'Starter templates are already in place.');
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to seed starter templates.');
    } finally {
      setSeeding(false);
    }
  }

  const questionCount = (t) => (Array.isArray(t.questions) ? t.questions.length : (t.questionCount ?? 0));

  const columns = [
    {
      key: 'name', header: 'Template',
      render: (t) => (
        <span className="block">
          <span className="flex items-center gap-2">
            <span className="font-medium text-gray-900">{t.name}</span>
            {t.isDefault && <DefaultChip />}
          </span>
          {t.description && <span className="block text-[11px] text-gray-400 mt-0.5">{t.description}</span>}
        </span>
      ),
    },
    {
      key: 'questions', header: 'Questions',
      render: (t) => <span className="text-xs font-medium text-gray-700 tabular-nums">{questionCount(t)}</span>,
    },
    {
      key: 'kinds', header: 'Question types',
      render: (t) => {
        const kinds = [...new Set((t.questions || []).map((q) => q.kind))];
        if (!kinds.length) return <span className="text-xs text-gray-400">—</span>;
        return <span className="flex flex-wrap gap-1">{kinds.map((k) => <KindChip key={k} kind={k} />)}</span>;
      },
    },
    ...(canManage ? [{
      key: 'actions', header: '',
      render: (t) => (
        <span className="flex items-center gap-2">
          <ActionButton onClick={() => setEditingId(t.id)}>Edit</ActionButton>
          <ActionButton tone="danger" onClick={() => archive(t)}>Archive</ActionButton>
        </span>
      ),
    }] : []),
  ];

  return (
    <div className="p-6 sm:p-8 space-y-8">
      <PageHeader
        title={(
          <span className="inline-flex items-center">
            Form templates
            <InfoTip text="Reusable screening-question sets you author once and apply to any job in one click. The applied questions stay individually editable on the job." />
          </span>
        )}
        subtitle="Author reusable screening-question sets and apply a chosen template to any job."
        actions={canManage ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={seedDefaults}
              disabled={seeding}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {seeding ? 'Seeding…' : 'Seed defaults'}
            </button>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
              style={{ backgroundColor: 'var(--theme-primary)' }}
            >
              New template
            </button>
          </div>
        ) : null}
      />

      <ModuleGuide
        id="recruitment-form-templates"
        title="Reuse a screening-question set across jobs"
        what="A form template is a named set of screening questions — the same typed questions (Yes/No, single/multiple choice, number, free text, qualification) you can add to one job, but saved so you can apply them to any job in one click. The applied questions are copied onto the job and stay individually editable there."
        steps={[
          'Click New template, name it, and add your screening questions.',
          'For choice / qualification questions add options and the points each earns; tick Knockout to auto-reject a wrong answer.',
          'Optionally mark one template as the default starting point.',
          'On a job → Screening questions tab, pick a template and Apply.',
        ]}
        example={<>Build an <b>Engineering screening</b> template — a Yes/No work-eligibility knockout, a degree Qualification question (B.Tech CS → 20), and a years-of-experience Number — then apply it to every engineering role.</>}
        tips={[
          'Use Seed defaults to get a couple of ready-made starter templates.',
          'Applying a template to a job that already has questions asks before replacing them.',
        ]}
      />

      {notice && <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700" role="status">{notice}</div>}
      {!canManage && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
          You have read-only access. Authoring form templates requires the manage-hiring permission.
        </p>
      )}
      {error && <ErrorBanner message={error} />}

      {!loading && templates && (
        <p className="text-xs text-gray-500">{templates.length} template{templates.length === 1 ? '' : 's'}</p>
      )}

      <DataTable
        columns={columns}
        rows={loading ? [] : rows}
        loading={loading}
        rowKey={(r) => r.id}
        caption="Screening-form templates"
        emptyText={canManage ? 'No form templates yet. Click “New template” or “Seed defaults” to start.' : 'No form templates yet.'}
      />

      {creating && (
        <TemplateModal
          templateId={null}
          onClose={() => setCreating(false)}
          onSaved={(msg) => { setCreating(false); flash(msg); load(); }}
        />
      )}
      {editingId && (
        <TemplateModal
          templateId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={(msg) => { setEditingId(null); flash(msg); load(); }}
        />
      )}
    </div>
  );
}
