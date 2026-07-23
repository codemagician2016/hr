'use client';

// Settings → Pipeline templates (Phase 4).
//
// Reusable, named sets of hiring pipeline stages that materialise onto a Job's
// stages in one shot (instead of adding stages one-by-one). At most one template
// per tenant is the default; createJob auto-applies the default onto a new job.
//
//   GET    /api/hr/recruitment/pipeline-templates            → { items:[{id,name,description,isDefault,stages:[{id,name,kind,sortOrder}]}] }
//   POST   /api/hr/recruitment/pipeline-templates             { name, description?, isDefault?, stages:[{name,kind,sortOrder}] }
//   PATCH  /api/hr/recruitment/pipeline-templates/:id         (partial; stages = full replacement)
//   DELETE /api/hr/recruitment/pipeline-templates/:id         (soft delete)
//   POST   /api/hr/recruitment/pipeline-templates/seed-defaults → creates the standard templates
//
// Writes are gated on canManageHiring / canManageEmployees (server is the real
// boundary). Read-only operators see the list but no editors. 4xx bodies are
// surfaced verbatim (e.g. the "each stage requires a valid kind …" 422).

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, Modal, ModalActions, PrimaryButton, TextInput, TextArea, Spinner } from '@hr/ui';
import { get, post, patch, del } from '@/lib/api';
import { DataTable, PageHeader, ActionButton } from '@/lib/ui';
import { InfoTip, SectionTitle } from '@/lib/widgets';
import { permissionsFromSession, hasAnyPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';

// StageKind enum (mirrors prisma enum StageKind). Each carries a friendly label +
// a chip colour so the ordered pipeline reads at a glance.
const STAGE_KINDS = [
  { value: 'SOURCED', label: 'Sourced', cls: 'bg-slate-50 text-slate-700 border-slate-200' },
  { value: 'SCREENING', label: 'Screening', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  { value: 'ASSESSMENT', label: 'Assessment', cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  { value: 'INTERVIEW', label: 'Interview', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  { value: 'OFFER', label: 'Offer', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  { value: 'HIRED', label: 'Hired', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  { value: 'REJECTED', label: 'Rejected', cls: 'bg-red-50 text-red-700 border-red-200' },
  { value: 'WITHDRAWN', label: 'Withdrawn', cls: 'bg-gray-100 text-gray-600 border-gray-200' },
];
const KIND_META = Object.fromEntries(STAGE_KINDS.map((k) => [k.value, k]));

function StageChip({ kind, name }) {
  const meta = KIND_META[kind] || { label: kind, cls: 'bg-gray-100 text-gray-600 border-gray-200' };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>
      {name || meta.label}
    </span>
  );
}

function DefaultBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
      Default
    </span>
  );
}

function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={() => !disabled && onChange(!checked)} disabled={disabled}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${checked ? '' : 'bg-gray-200'}`}
      style={checked ? { backgroundColor: 'var(--theme-primary)' } : undefined}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  );
}

/* ── create / edit modal ──────────────────────────────────────────────────── */

function TemplateEditModal({ tpl, onClose, onSaved }) {
  const editing = !!tpl;
  const [name, setName] = useState(tpl?.name || '');
  const [description, setDescription] = useState(tpl?.description || '');
  const [isDefault, setIsDefault] = useState(!!tpl?.isDefault);
  const [stages, setStages] = useState(
    (tpl?.stages || []).slice().sort((a, b) => a.sortOrder - b.sortOrder).map((s) => ({ name: s.name, kind: s.kind })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setStage = (i, patchObj) => setStages((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patchObj } : r)));
  const addStage = () => setStages((rows) => [...rows, { name: '', kind: 'SCREENING' }]);
  const removeStage = (i) => setStages((rows) => rows.filter((_, idx) => idx !== i));
  const move = (i, dir) => setStages((rows) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return rows;
    const next = rows.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const payload = {
      name,
      description: description || null,
      isDefault,
      // Server re-sequences sortOrder contiguously; we send the current order.
      stages: stages.map((s, idx) => ({ name: s.name, kind: s.kind, sortOrder: idx })),
    };
    try {
      if (editing) await patch(`/api/hr/recruitment/pipeline-templates/${tpl.id}`, payload);
      else await post('/api/hr/recruitment/pipeline-templates', payload);
      onSaved(editing ? `"${name}" saved.` : `"${name}" created.`);
    } catch (err) {
      // 4xx bodies (name required, invalid kind, duplicate name) are user-readable.
      setError(err.data?.message || err.message || 'Failed to save the template.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={editing ? `Edit — ${tpl.name}` : 'New pipeline template'} size="lg" onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        {error && <ErrorBanner message={error} />}

        <TextInput label="Name" value={name} onChange={setName} required placeholder="e.g. Standard hiring" />
        <TextArea label="Description (optional)" value={description} onChange={setDescription} rows={2} maxLength={280} />

        <label className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 px-3 py-2.5">
          <span className="min-w-0">
            <span className="flex items-center text-sm font-medium text-gray-900">
              Default template
              <InfoTip text="The default is auto-applied onto every new job you create. Setting this one as default clears the flag from any other template — at most one default per company." />
            </span>
            <span className="block text-xs text-gray-500">Auto-applied to new jobs. Only one template can be the default.</span>
          </span>
          <Toggle checked={isDefault} onChange={setIsDefault} label="Default template" />
        </label>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="flex items-center text-sm font-medium text-gray-700">
              Stages
              <InfoTip text="The ordered pipeline a candidate moves through. Each stage has a name and a kind (Sourced, Screening, Interview, Assessment, Offer, Hired, Rejected, Withdrawn). Reorder with the arrows." />
            </span>
            <ActionButton onClick={addStage}>+ Add stage</ActionButton>
          </div>

          {stages.length === 0 ? (
            <p className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-3 py-4 text-sm text-gray-500">
              No stages yet. Add at least one so the template can be applied onto a job.
            </p>
          ) : (
            <div className="space-y-2">
              {stages.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-5 text-right text-xs text-gray-400">{i + 1}</span>
                  <input
                    type="text"
                    value={s.name}
                    onChange={(e) => setStage(i, { name: e.target.value })}
                    required
                    placeholder="Stage name"
                    className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none"
                  />
                  <select
                    value={s.kind}
                    onChange={(e) => setStage(i, { kind: e.target.value })}
                    className="px-2 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none"
                  >
                    {STAGE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                  </select>
                  <div className="flex items-center">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title="Move up" className="px-1.5 py-1 text-gray-500 hover:text-gray-800 disabled:opacity-30">↑</button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === stages.length - 1} title="Move down" className="px-1.5 py-1 text-gray-500 hover:text-gray-800 disabled:opacity-30">↓</button>
                    <button type="button" onClick={() => removeStage(i)} title="Remove" className="px-1.5 py-1 text-red-500 hover:text-red-700">✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <ModalActions>
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>{editing ? 'Save template' : 'Create template'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

/* ── page ─────────────────────────────────────────────────────────────────── */

export default function PipelineTemplatesPage() {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [canManage, setCanManage] = useState(true);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(undefined); // undefined = closed, null = create, object = edit
  const [seeding, setSeeding] = useState(false);
  const [busyId, setBusyId] = useState('');

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };

  const load = useCallback(() => {
    setLoading(true);
    get('/api/hr/recruitment/pipeline-templates')
      .then((res) => setItems(res?.items || []))
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load pipeline templates.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    get('/api/auth/me')
      .then((res) => {
        const session = res?.user || res;
        setCanManage(hasAnyPermission(permissionsFromSession(session), ['canManageHiring', 'canManageEmployees']));
      })
      .catch(() => {});
  }, [load]);

  async function restoreDefaults() {
    if (!window.confirm('Create the standard pipeline templates (Standard hiring, Technical hiring)? Existing templates with the same name are left untouched.')) return;
    setSeeding(true);
    setError('');
    try {
      const res = await post('/api/hr/recruitment/pipeline-templates/seed-defaults');
      const made = (res?.created || []).length;
      const skipped = (res?.skipped || []).length;
      flash(`${made} template${made === 1 ? '' : 's'} created${skipped ? ` · ${skipped} already existed` : ''}.`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to restore the default templates.');
    } finally {
      setSeeding(false);
    }
  }

  async function remove(tpl) {
    if (!window.confirm(`Delete "${tpl.name}"? Jobs already using these stages keep them — only the reusable template is removed.`)) return;
    setBusyId(tpl.id);
    setError('');
    try {
      await del(`/api/hr/recruitment/pipeline-templates/${tpl.id}`);
      flash(`"${tpl.name}" deleted.`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to delete the template.');
    } finally {
      setBusyId('');
    }
  }

  const columns = [
    {
      key: 'name', header: 'Template',
      render: (t) => (
        <span className="block">
          <span className="flex items-center gap-2">
            <span className="font-medium text-gray-900">{t.name}</span>
            {t.isDefault && <DefaultBadge />}
          </span>
          {t.description && <span className="block text-xs text-gray-500 mt-0.5">{t.description}</span>}
        </span>
      ),
    },
    {
      key: 'stages', header: 'Stages',
      render: (t) => {
        const ordered = (t.stages || []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
        if (!ordered.length) return <span className="text-xs text-gray-400">No stages</span>;
        return (
          <span className="inline-flex flex-wrap items-center gap-1">
            {ordered.map((s, i) => (
              <span key={s.id || i} className="inline-flex items-center gap-1">
                {i > 0 && <span className="text-gray-300">→</span>}
                <StageChip kind={s.kind} name={s.name} />
              </span>
            ))}
          </span>
        );
      },
    },
    { key: 'count', header: '', render: (t) => <span className="text-xs text-gray-500">{(t.stages || []).length} stage{(t.stages || []).length === 1 ? '' : 's'}</span> },
    ...(canManage ? [{
      key: 'actions', header: '', className: 'text-right',
      render: (t) => (
        <div className="flex gap-2 justify-end">
          <ActionButton onClick={() => setEditing(t)}>Edit</ActionButton>
          <ActionButton tone="danger" disabled={busyId === t.id} onClick={() => remove(t)}>Delete</ActionButton>
        </div>
      ),
    }] : []),
  ];

  return (
    <div className="p-6 sm:p-8 space-y-8">
      <PageHeader
        title={(
          <span className="inline-flex items-center">
            Pipeline templates
            <InfoTip text="Reusable, named sets of hiring stages you can apply onto any job in one click — instead of building the pipeline stage-by-stage each time." />
          </span>
        )}
        subtitle="Reusable hiring pipelines you can apply onto any job."
        actions={canManage ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={restoreDefaults}
              disabled={seeding}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {seeding ? 'Restoring…' : 'Restore defaults'}
            </button>
            <PrimaryButton onClick={() => setEditing(null)}>New template</PrimaryButton>
          </div>
        ) : null}
      />

      <ModuleGuide
        id="settings-pipeline-templates"
        title="Build a hiring pipeline once, reuse it on every job"
        what="A pipeline template is a named, ordered set of stages (Sourced → Screening → Interview → Offer → Hired, etc.). Apply one onto a job and its stages are created in a single step. Mark one template as the default and it is applied automatically to every new job you open."
        steps={[
          'Click New template, name it, and add the stages in order — each with a name and a kind. Use the arrows to reorder.',
          'Optionally flip Default on so it is applied to every new job automatically (only one template can be the default).',
          'From a job\'s Candidates tab, use "Apply template" to materialise a template\'s stages onto that job.',
          'New to this? Click Restore defaults to create the standard Standard-hiring and Technical-hiring templates.',
        ]}
        example={<>Create a <b>Technical hiring</b> template — Sourced → Screening → <b>Assessment</b> → Interview → Offer → Hired — set it as the default, and every new engineering requisition opens with that exact pipeline already in place.</>}
        tips={[
          'Applying a template onto a job that already has stages is refused unless you replace them — and replacing is only allowed while the job has no candidates yet.',
          'Deleting a template never touches jobs that already used it; it only removes the reusable template.',
          'Managing templates needs the manage-hiring permission; the server is the real boundary.',
        ]}
      />

      {notice && <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700" role="status">{notice}</div>}
      {!canManage && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
          You have read-only access. Managing pipeline templates requires the manage-hiring permission.
        </p>
      )}
      {error && <ErrorBanner message={error} />}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle tip="Every reusable pipeline in your company. The one marked Default is applied automatically to new jobs.">Templates</SectionTitle>
          {!loading && items && <p className="text-xs text-gray-500">{items.length} template{items.length === 1 ? '' : 's'}</p>}
        </div>
        {loading ? (
          <DataTable columns={columns} rows={[]} loading emptyText="" />
        ) : (
          <DataTable columns={columns} rows={items || []} rowKey={(r) => r.id} emptyText="No pipeline templates yet — create one or restore the defaults." caption="Pipeline templates" />
        )}
      </div>

      {editing !== undefined && (
        <TemplateEditModal
          tpl={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(msg) => { setEditing(undefined); flash(msg); load(); }}
        />
      )}
    </div>
  );
}
