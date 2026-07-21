'use client';

// Settings → Lifecycle & probation (Program P1.4).
//
// Two consoles over the employee-lifecycle configuration, both served by
// /api/hr/lifecycle (every route requires canManageOnboarding):
//   • Onboarding & exit checklists — LifecycleTemplate authoring: the per-stage
//     task lists a new joiner / leaver walks through. GET/POST/PATCH/DELETE
//     /templates (+ PUT /templates/:id/tasks replaces the FULL task list, and
//     POST /templates/seed-defaults restores the stock starter sets).
//     Editing a template NEVER affects in-flight journeys — their tasks are
//     materialized snapshots taken when the journey starts; a change applies
//     only to journeys created afterwards.
//   • Probation policy — scoped ProbationPolicy rows (entity / employment type;
//     blank = whole company / all types). Resolution is most-specific-wins:
//     (entity + type) > entity > type > tenant-wide. Scope is IMMUTABLE after
//     create (delete + recreate to re-scope). autoConfirm drives the nightly
//     sweep (PROBATION → ACTIVE at the end date, optionally issuing a
//     confirmation letter).
//
// All dropdown vocabularies (stages, task keys, owners, anchors, categories)
// come from GET /templates/meta — nothing enum-ish is hardcoded here except the
// EmploymentType list, which meta does not expose.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBanner, Modal, ModalActions, PrimaryButton, Spinner, TextInput } from '@hr/ui';
import { get, post, patch, put, del } from '@/lib/api';
import { DataTable, PageHeader, ActionButton, Tabs, asList } from '@/lib/ui';
import { InfoTip, SectionTitle } from '@/lib/widgets';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';

// EmploymentType enum (mirrors backend probation.controller.js EMPLOYMENT_TYPES
// — the only vocabulary /templates/meta does not carry).
const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'FIXED_TERM', 'CONTRACT', 'INTERN', 'APPRENTICE', 'CASUAL', 'CONSULTANT'];

// Task keys whose system action needs an extra qualifier select.
const DOC_TASK_KEYS = ['UPLOAD_DOCS', 'COLLECT_STATUTORY', 'VERIFY_DOCS'];
const ASSET_TASK_KEYS = ['ASSIGN_ASSET', 'RETURN_ASSET'];

const ANCHOR_LABELS = {
  OFFER_ACCEPT: 'offer acceptance',
  JOIN_DATE: 'the join date',
  NOTICE_START: 'notice start',
  LWD: 'the last working day',
  RELIEVING: 'the relieving date',
};

let taskLocalId = 0;
function nextLocalId() { taskLocalId += 1; return `t${taskLocalId}`; }

// "PRE_JOIN" → "Pre Join" (readable enum labels without a hand-kept map).
function prettyEnum(v) {
  if (!v) return '';
  return String(v)
    .split('_')
    .map((w) => (w === 'LWD' || w === 'FNF' || w === 'IT' ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(' ');
}

function anchorLabel(a) { return ANCHOR_LABELS[a] || prettyEnum(a); }

// Human sentence for the due rule: "Due 3 days before the join date".
function dueSentence(anchor, offsetRaw) {
  const offset = parseInt(offsetRaw, 10);
  const label = anchorLabel(anchor || 'JOIN_DATE');
  if (!Number.isFinite(offset) || offset === 0) return `Due on ${label}`;
  const n = Math.abs(offset);
  return `Due ${n} day${n === 1 ? '' : 's'} ${offset < 0 ? 'before' : 'after'} ${label}`;
}

function intOr(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function ActiveChip({ isActive }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${isActive ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
      {isActive ? 'Active' : 'Inactive'}
    </span>
  );
}

function DefaultBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
      Default
    </span>
  );
}

// Compact labelled select used inside the dense task-editor rows.
function MiniSelect({ label, value, onChange, options, blankLabel, disabled }) {
  return (
    <label className="block text-xs">
      <span className="text-gray-500">{label}</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="mt-0.5 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm disabled:bg-gray-50"
      >
        {blankLabel !== undefined && <option value="">{blankLabel}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

/* ── Lifecycle templates ──────────────────────────────────────────────────── */

function templateScopeLabel(r, entities, departments, designations) {
  const parts = [];
  if (r.entityId) {
    const e = entities.find((x) => x.id === r.entityId);
    parts.push(e ? (e.code || e.legalName || 'Entity') : 'Entity');
  }
  if (r.departmentId) {
    const d = departments.find((x) => x.id === r.departmentId);
    parts.push(d ? (d.name || d.code || 'Department') : 'Department');
  }
  if (r.designationId) {
    const d = designations.find((x) => x.id === r.designationId);
    parts.push(d ? (d.name || d.code || 'Designation') : 'Designation');
  }
  return parts.length ? parts.join(' · ') : 'All';
}

// Details modal — name / country / default / active. Scope selectors are
// intentionally omitted for v1 (templates default to tenant-wide; the seeder
// sets entity scope on stock sets). Create POSTs; edit PATCHes.
function TemplateDetailsModal({ direction, template, onClose, onSaved }) {
  const editing = !!template?.id;
  const [name, setName] = useState(template?.name || '');
  const [countryCode, setCountryCode] = useState(template?.countryCode || '');
  const [isDefault, setIsDefault] = useState(template?.isDefault === true);
  const [isActive, setIsActive] = useState(template?.isActive !== false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const noun = direction === 'ONBOARDING' ? 'onboarding' : 'exit';

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      let saved;
      if (editing) {
        saved = await patch(`/api/hr/lifecycle/templates/${template.id}`, {
          name, countryCode: countryCode || null, isDefault, isActive,
        });
      } else {
        saved = await post('/api/hr/lifecycle/templates', {
          name, direction, countryCode: countryCode || null, isDefault,
        });
      }
      onSaved(saved, editing);
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to save the template.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={editing ? `Edit ${noun} template` : `New ${noun} template`} size="lg" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <TextInput
          label="Name" value={name} onChange={setName} required maxLength={200}
          placeholder={direction === 'ONBOARDING' ? 'e.g. Standard India onboarding' : 'e.g. Standard exit & clearance'}
          hint="Shown wherever a checklist is picked for a new journey."
        />
        <label className="block text-sm">
          <span className="flex items-center text-gray-700 font-medium">Country<InfoTip text="Restrict the template to one market. A country-specific default only displaces defaults of the SAME country; blank = all countries." /></span>
          <select
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">All countries</option>
            <option value="IN">IN — India</option>
            <option value="NZ">NZ — New Zealand</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          Default template
          <InfoTip text="The checklist used when a journey starts without an explicit pick. Making this the default clears the flag on same-scope siblings; you can't unset the only default — make another template the default first." />
        </label>
        {editing && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active
            <InfoTip text="Inactive templates are hidden from journey creation but kept for history." />
          </label>
        )}
        <p className="text-xs text-gray-400">
          Changes never touch in-flight journeys — their checklists are snapshots taken at journey start.
        </p>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>{editing ? 'Save template' : 'Create template'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

// One editable task row inside the checklist editor. Dense on purpose — a
// template routinely carries 15–30 tasks across 7 stages.
function TaskRow({ task, meta, direction, onChange, onRemove, onMove, first, last }) {
  const set = (field) => (value) => onChange({ ...task, [field]: value });
  const taskKey = task.taskKey || '';
  const showDoc = DOC_TASK_KEYS.includes(taskKey);
  const showEsign = taskKey.startsWith('ESIGN_');
  const showAsset = ASSET_TASK_KEYS.includes(taskKey);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 space-y-1.5">
          <input
            type="text"
            value={task.title}
            onChange={(e) => set('title')(e.target.value)}
            maxLength={200}
            placeholder="Task title (required) — e.g. Collect signed NDA"
            className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm font-medium"
          />
          <input
            type="text"
            value={task.description || ''}
            onChange={(e) => set('description')(e.target.value)}
            placeholder="Description (optional — shown to the task owner)"
            className="w-full rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-600"
          />
        </div>
        <div className="flex items-center gap-1 pt-0.5">
          <ActionButton onClick={() => onMove(-1)} disabled={first}>↑</ActionButton>
          <ActionButton onClick={() => onMove(1)} disabled={last}>↓</ActionButton>
          <ActionButton tone="danger" onClick={onRemove}>Remove</ActionButton>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <MiniSelect
          label="Owner" value={task.ownerRole} onChange={set('ownerRole')}
          options={meta.owners.map((o) => ({ value: o, label: prettyEnum(o) }))}
        />
        <MiniSelect
          label="System action" value={taskKey} onChange={set('taskKey')}
          blankLabel="Manual task"
          options={meta.taskKeys[direction].map((k) => ({ value: k, label: prettyEnum(k) }))}
        />
        <MiniSelect
          label="Due anchor" value={task.dueAnchor} onChange={set('dueAnchor')}
          options={meta.anchors.map((a) => ({ value: a, label: prettyEnum(a) }))}
        />
        <label className="block text-xs">
          <span className="text-gray-500">Offset (days, ± allowed)</span>
          <input
            type="number" min={-365} max={365} step={1}
            value={task.dueOffsetDays}
            onChange={(e) => set('dueOffsetDays')(e.target.value)}
            className="mt-0.5 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
      </div>
      {(showDoc || showEsign || showAsset) && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {showDoc && (
            <MiniSelect
              label="Document category" value={task.documentCategory} onChange={set('documentCategory')}
              blankLabel="Any document"
              options={meta.documentCategories.map((c) => ({ value: c, label: prettyEnum(c) }))}
            />
          )}
          {showEsign && (
            <MiniSelect
              label="E-sign letter kind" value={task.esignTemplateKind} onChange={set('esignTemplateKind')}
              blankLabel="— pick a kind —"
              options={meta.esignTemplateKinds.map((c) => ({ value: c, label: prettyEnum(c) }))}
            />
          )}
          {showAsset && (
            <MiniSelect
              label="Asset category" value={task.assetCategory} onChange={set('assetCategory')}
              blankLabel="Any asset"
              options={meta.assetCategories.map((c) => ({ value: c, label: prettyEnum(c) }))}
            />
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600">
        <label className="inline-flex items-center gap-1.5">
          <input type="checkbox" checked={task.isBlocking !== false} onChange={(e) => set('isBlocking')(e.target.checked)} />
          Blocking
          <InfoTip text="The journey cannot advance past this task's stage until it is done." />
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input type="checkbox" checked={task.isMandatory !== false} onChange={(e) => set('isMandatory')(e.target.checked)} />
          Mandatory
          <InfoTip text="Mandatory tasks cannot be skipped or waived by the owner." />
        </label>
        <span className="text-gray-400">{dueSentence(task.dueAnchor, task.dueOffsetDays)}</span>
      </div>
    </div>
  );
}

// The checklist editor — tasks GROUPED BY STAGE in meta flow order. Save PUTs
// the FULL flattened list (taskOrder = index within its stage); the server
// replaces the snapshot wholesale, which is safe because in-flight journeys
// hold materialized copies.
function TaskEditorModal({ template, meta, onClose, onSaved }) {
  const direction = template.direction;
  const stages = meta.stages[direction] || [];
  const [byStage, setByStage] = useState(null); // stageKey → task[]
  const [extraStages, setExtraStages] = useState([]); // unknown keys, never dropped
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    get(`/api/hr/lifecycle/templates/${template.id}`)
      .then((full) => {
        if (!alive) return;
        const grouped = {};
        for (const s of stages) grouped[s] = [];
        const extras = [];
        for (const t of full.taskDefs || []) {
          if (!grouped[t.stageKey]) { grouped[t.stageKey] = []; extras.push(t.stageKey); }
          grouped[t.stageKey].push({
            _id: nextLocalId(),
            title: t.title || '',
            description: t.description || '',
            ownerRole: t.ownerRole || 'HR',
            taskKey: t.taskKey || '',
            dueAnchor: t.dueAnchor || (direction === 'ONBOARDING' ? 'JOIN_DATE' : 'LWD'),
            dueOffsetDays: t.dueOffsetDays ?? 0,
            taskOrder: t.taskOrder ?? 0,
            isBlocking: t.isBlocking !== false,
            isMandatory: t.isMandatory !== false,
            documentCategory: t.documentCategory || '',
            esignTemplateKind: t.esignTemplateKind || '',
            assetCategory: t.assetCategory || '',
          });
        }
        for (const s of Object.keys(grouped)) grouped[s].sort((a, b) => a.taskOrder - b.taskOrder);
        setByStage(grouped);
        setExtraStages(extras);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.data?.message || e.message || 'Failed to load the template tasks.');
        setLoading(false);
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.id]);

  const stageList = useMemo(() => [...stages, ...extraStages], [stages, extraStages]);
  const totalTasks = useMemo(
    () => (byStage ? stageList.reduce((n, s) => n + (byStage[s]?.length || 0), 0) : 0),
    [byStage, stageList]
  );

  function addTask(stage) {
    setByStage((prev) => ({
      ...prev,
      [stage]: [...(prev[stage] || []), {
        _id: nextLocalId(),
        title: '',
        description: '',
        ownerRole: 'HR',
        taskKey: '',
        dueAnchor: direction === 'ONBOARDING' ? 'JOIN_DATE' : 'LWD',
        dueOffsetDays: 0,
        isBlocking: true,
        isMandatory: true,
        documentCategory: '',
        esignTemplateKind: '',
        assetCategory: '',
      }],
    }));
  }

  function updateTask(stage, idx, next) {
    setByStage((prev) => {
      const list = [...prev[stage]];
      list[idx] = next;
      return { ...prev, [stage]: list };
    });
  }

  function removeTask(stage, idx) {
    setByStage((prev) => ({ ...prev, [stage]: prev[stage].filter((_, i) => i !== idx) }));
  }

  function moveTask(stage, idx, delta) {
    setByStage((prev) => {
      const list = [...prev[stage]];
      const j = idx + delta;
      if (j < 0 || j >= list.length) return prev;
      [list[idx], list[j]] = [list[j], list[idx]];
      return { ...prev, [stage]: list };
    });
  }

  async function save() {
    setError('');
    if (totalTasks === 0) {
      setError('A template needs at least one task — a checklist with no tasks cannot drive a journey.');
      return;
    }
    if (totalTasks > meta.maxTasks) {
      setError(`At most ${meta.maxTasks} tasks per template.`);
      return;
    }
    // Flatten in stage-flow order; order within a stage = list order.
    const tasks = [];
    for (const stage of stageList) {
      (byStage[stage] || []).forEach((t, i) => {
        const taskKey = t.taskKey || null;
        tasks.push({
          stageKey: stage,
          taskKey,
          title: t.title,
          description: t.description ? t.description : null,
          ownerRole: t.ownerRole,
          taskOrder: i,
          dueOffsetDays: intOr(t.dueOffsetDays, 0),
          dueAnchor: t.dueAnchor,
          isBlocking: t.isBlocking !== false,
          isMandatory: t.isMandatory !== false,
          documentCategory: taskKey && DOC_TASK_KEYS.includes(taskKey) ? (t.documentCategory || null) : null,
          esignTemplateKind: taskKey && taskKey.startsWith('ESIGN_') ? (t.esignTemplateKind || null) : null,
          assetCategory: taskKey && ASSET_TASK_KEYS.includes(taskKey) ? (t.assetCategory || null) : null,
        });
      });
    }
    setSaving(true);
    try {
      await put(`/api/hr/lifecycle/templates/${template.id}/tasks`, { tasks });
      onSaved();
    } catch (e) {
      // Server 400s are user-readable ("Task 3: title is required.") — verbatim.
      setError(e.data?.message || e.message || 'Failed to save the checklist.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Checklist — ${template.name}`} size="lg" onClose={onClose}>
      {loading ? (
        <div className="py-10 flex justify-center"><Spinner /></div>
      ) : (
        <div className="space-y-4">
          {error && <ErrorBanner message={error} />}
          <p className="text-xs text-gray-500">
            Tasks are grouped by stage in journey order; within a stage the list order is the task order (use ↑/↓).
            Saving replaces the whole checklist. In-flight journeys keep their snapshot — only new journeys pick this up.
          </p>
          {stageList.map((stage) => (
            <div key={stage} className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  {prettyEnum(stage)}
                  <span className="ml-1.5 font-normal normal-case text-gray-400">
                    {(byStage[stage] || []).length} task{(byStage[stage] || []).length === 1 ? '' : 's'}
                  </span>
                </h4>
                <ActionButton onClick={() => addTask(stage)}>+ Add task</ActionButton>
              </div>
              {(byStage[stage] || []).length === 0 ? (
                <p className="rounded-lg border border-dashed border-gray-200 px-3 py-2 text-xs text-gray-400">
                  No tasks in this stage — it is skipped for new journeys.
                </p>
              ) : (
                <div className="space-y-2">
                  {byStage[stage].map((t, i) => (
                    <TaskRow
                      key={t._id}
                      task={t}
                      meta={meta}
                      direction={direction}
                      onChange={(next) => updateTask(stage, i, next)}
                      onRemove={() => removeTask(stage, i)}
                      onMove={(delta) => moveTask(stage, i, delta)}
                      first={i === 0}
                      last={i === byStage[stage].length - 1}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-xs text-gray-400">{totalTasks} of {meta.maxTasks} tasks</span>
            <ModalActions>
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              <PrimaryButton onClick={save} loading={saving}>Save checklist</PrimaryButton>
            </ModalActions>
          </div>
        </div>
      )}
    </Modal>
  );
}

function TemplatesSection({ meta, entities, departments, designations, canManage, flash }) {
  const [direction, setDirection] = useState('ONBOARDING');
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [details, setDetails] = useState(null); // null | 'new' | row
  const [tasksFor, setTasksFor] = useState(null); // null | row
  const [seeding, setSeeding] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    get('/api/hr/lifecycle/templates', { direction })
      .then((res) => setItems(asList(res)))
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load lifecycle templates.'))
      .finally(() => setLoading(false));
  }, [direction]);
  useEffect(() => { load(); }, [load]);

  async function remove(row) {
    if (!window.confirm(`Delete "${row.name}"? Journeys already running keep their checklist; new journeys can no longer pick it.`)) return;
    setError('');
    try {
      await del(`/api/hr/lifecycle/templates/${row.id}`);
      flash('Template deleted.');
      load();
    } catch (e) {
      // 409: "Cannot delete the default template — make another template the default first."
      setError(e.data?.message || e.message || 'Failed to delete the template.');
    }
  }

  async function restoreStarters() {
    if (!window.confirm('Restore the stock starter templates? The shipped onboarding & exit sets are re-created with their standard task lists. Templates you authored yourself are untouched, and in-flight journeys are never affected.')) return;
    setSeeding(true);
    setError('');
    try {
      await post('/api/hr/lifecycle/templates/seed-defaults');
      flash('Starter templates restored.');
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to restore the starter templates.');
    } finally {
      setSeeding(false);
    }
  }

  const columns = [
    { key: 'name', header: 'Name', render: (r) => <span className="font-medium text-gray-900">{r.name}</span> },
    { key: 'code', header: 'Code', render: (r) => <span className="font-mono text-xs text-gray-500">{r.code}</span> },
    { key: 'country', header: 'Country', render: (r) => r.countryCode || 'All' },
    { key: 'scope', header: 'Scope', render: (r) => templateScopeLabel(r, entities, departments, designations) },
    { key: 'tasks', header: 'Tasks', render: (r) => r._count?.taskDefs ?? '—' },
    { key: 'default', header: 'Default', render: (r) => (r.isDefault ? <DefaultBadge /> : <span className="text-gray-300">—</span>) },
    { key: 'active', header: 'Status', render: (r) => <ActiveChip isActive={r.isActive} /> },
    ...(canManage ? [{
      key: 'actions', header: '',
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <ActionButton onClick={() => setTasksFor(r)}>Edit tasks</ActionButton>
          <ActionButton onClick={() => setDetails(r)}>Edit details</ActionButton>
          <ActionButton tone="danger" onClick={() => remove(r)}>Delete</ActionButton>
        </span>
      ),
    }] : []),
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <SectionTitle tip="The per-stage checklists a joiner (onboarding) or leaver (exit) walks through. The default template is used when a journey starts without an explicit pick; country-specific templates apply to their market.">
            Onboarding &amp; exit checklists
          </SectionTitle>
          <p className="text-xs text-gray-500 mt-0.5">
            Editing a template never affects journeys already running — their tasks are snapshots taken at journey start.
          </p>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={restoreStarters}
              disabled={seeding}
              className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              {seeding ? 'Restoring…' : 'Restore starter templates'}
            </button>
            <PrimaryButton onClick={() => setDetails('new')}>New template</PrimaryButton>
          </div>
        )}
      </div>
      <Tabs
        tabs={[{ key: 'ONBOARDING', label: 'Onboarding' }, { key: 'OFFBOARDING', label: 'Exit' }]}
        active={direction}
        onChange={setDirection}
      />
      {error && <ErrorBanner message={error} />}
      <DataTable
        columns={columns}
        rows={items || []}
        loading={loading}
        emptyText={direction === 'ONBOARDING'
          ? 'No onboarding templates yet — create one, or restore the starter templates.'
          : 'No exit templates yet — create one, or restore the starter templates.'}
      />
      {details && (
        <TemplateDetailsModal
          direction={direction}
          template={details === 'new' ? null : details}
          onClose={() => setDetails(null)}
          onSaved={(saved, wasEdit) => {
            setDetails(null);
            flash(wasEdit ? 'Template saved.' : 'Template created — now add its tasks.');
            load();
            // A brand-new template has no tasks yet; drop straight into the editor.
            if (!wasEdit && saved?.id && meta) setTasksFor(saved);
          }}
        />
      )}
      {tasksFor && meta && (
        <TaskEditorModal
          template={tasksFor}
          meta={meta}
          onClose={() => setTasksFor(null)}
          onSaved={() => { setTasksFor(null); flash('Checklist saved.'); load(); }}
        />
      )}
    </div>
  );
}

/* ── Probation policy ─────────────────────────────────────────────────────── */

function ProbationModal({ policy, entities, letters, lettersDenied, onClose, onSaved }) {
  const editing = !!policy?.id;
  const [entityId, setEntityId] = useState(policy?.entityId || '');
  const [employmentType, setEmploymentType] = useState(policy?.employmentType || '');
  const [probationDays, setProbationDays] = useState(policy?.probationDays ?? 90);
  const [autoConfirm, setAutoConfirm] = useState(policy?.autoConfirm === true);
  const [letterTemplateId, setLetterTemplateId] = useState(policy?.letterTemplateId || '');
  const [remindDaysBefore, setRemindDaysBefore] = useState(policy?.remindDaysBefore ?? 7);
  const [isActive, setIsActive] = useState(policy?.isActive !== false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const body = {
      probationDays: intOr(probationDays, 90),
      autoConfirm,
      letterTemplateId: letterTemplateId || null,
      remindDaysBefore: intOr(remindDaysBefore, 7),
    };
    try {
      if (editing) {
        await patch(`/api/hr/lifecycle/probation-policies/${policy.id}`, { ...body, isActive });
      } else {
        // Scope travels only on create — it is immutable afterwards.
        await post('/api/hr/lifecycle/probation-policies', {
          ...body,
          entityId: entityId || null,
          employmentType: employmentType || null,
        });
      }
      onSaved();
    } catch (err) {
      // 409: "A probation policy for this scope already exists — edit it instead."
      setError(err.data?.message || err.message || 'Failed to save the probation policy.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={editing ? 'Edit probation policy' : 'New probation policy'} size="lg" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <p className="text-xs text-gray-500">
          The most specific active policy wins: entity + type beats entity, beats type, beats the company-wide row.
          A probation period set directly on the employee or offer still wins over any policy.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="flex items-center text-gray-700 font-medium">Entity (optional)<InfoTip text="Narrow the policy to one legal entity. Blank = the whole company." /></span>
            <select
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
              disabled={editing}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
            >
              <option value="">Whole company</option>
              {entities.map((en) => <option key={en.id} value={en.id}>{en.code} — {en.legalName}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="flex items-center text-gray-700 font-medium">Employment type (optional)<InfoTip text="Narrow the policy to one employment type — e.g. interns on a 180-day probation. Blank = all types." /></span>
            <select
              value={employmentType}
              onChange={(e) => setEmploymentType(e.target.value)}
              disabled={editing}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
            >
              <option value="">All types</option>
              {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{prettyEnum(t)}</option>)}
            </select>
          </label>
          {editing && <p className="col-span-2 text-xs text-gray-400 -mt-1">Scope is fixed after creation — delete and recreate the policy to change it.</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            label="Probation days (0–730)" type="number" min={0} max={730} value={probationDays} onChange={setProbationDays} required
            hint="The probation period for employees this policy covers. 0 = confirmed from day one."
          />
          <TextInput
            label="Remind days before (0–60)" type="number" min={0} max={60} value={remindDaysBefore} onChange={setRemindDaysBefore} required
            hint="HR gets a nudge this many days before each probation end date."
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={autoConfirm} onChange={(e) => setAutoConfirm(e.target.checked)} />
          Auto-confirm at the end date
          <InfoTip text="The nightly sweep confirms the employee automatically at the probation end date (PROBATION → ACTIVE), issuing the confirmation letter below if one is set. Off = HR confirms manually from the onboarding pipeline." />
        </label>
        {lettersDenied ? (
          <TextInput
            label="Confirmation letter template id (optional)"
            value={letterTemplateId} onChange={setLetterTemplateId}
            placeholder="Paste a letter template id"
            hint="You don't have the manage-letters permission, so the template list can't be loaded here. Copy the template id from Letters → Templates, or leave blank for no letter."
          />
        ) : (
          <label className="block text-sm">
            <span className="flex items-center text-gray-700 font-medium">Confirmation letter (optional)<InfoTip text="Issued automatically when the employee is confirmed on auto-confirm. Pick the template you use for confirmation letters; blank = confirm without a letter." /></span>
            <select
              value={letterTemplateId}
              onChange={(e) => setLetterTemplateId(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">No letter</option>
              {letters.map((t) => <option key={t.id} value={t.id}>{t.name}{t.code ? ` (${t.code})` : ''}</option>)}
            </select>
          </label>
        )}
        {editing && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active
            <InfoTip text="Inactive policies are ignored by resolution but kept for history." />
          </label>
        )}
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>{editing ? 'Save policy' : 'Create policy'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

function ProbationSection({ entities, letters, lettersDenied, canManage, flash }) {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | row

  const load = useCallback(() => {
    setLoading(true);
    get('/api/hr/lifecycle/probation-policies')
      .then((res) => setItems(asList(res)))
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load probation policies.'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function remove(row) {
    if (!window.confirm('Delete this probation policy? Employees fall back to the next-most-specific policy (or the 90-day default when none matches).')) return;
    setError('');
    try {
      await del(`/api/hr/lifecycle/probation-policies/${row.id}`);
      flash('Probation policy deleted.');
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to delete the probation policy.');
    }
  }

  function entityLabel(r) {
    if (!r.entityId) return 'Whole company';
    const e = entities.find((x) => x.id === r.entityId);
    return e ? (e.code || e.legalName) : 'Entity';
  }

  function letterLabel(r) {
    if (!r.letterTemplateId) return '—';
    const t = letters.find((x) => x.id === r.letterTemplateId);
    return t ? t.name : 'Configured';
  }

  const columns = [
    { key: 'entity', header: 'Scope', render: (r) => <span className="font-medium text-gray-900">{entityLabel(r)}</span> },
    { key: 'type', header: 'Employment type', render: (r) => (r.employmentType ? prettyEnum(r.employmentType) : 'All types') },
    { key: 'days', header: 'Probation', render: (r) => `${r.probationDays} day${r.probationDays === 1 ? '' : 's'}` },
    {
      key: 'auto', header: 'Auto-confirm',
      render: (r) => (
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${r.autoConfirm ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
          {r.autoConfirm ? 'Yes' : 'Manual'}
        </span>
      ),
    },
    { key: 'letter', header: 'Letter', render: (r) => <span className="text-xs text-gray-600">{letterLabel(r)}</span> },
    { key: 'remind', header: 'Reminder', render: (r) => `${r.remindDaysBefore} day${r.remindDaysBefore === 1 ? '' : 's'} before` },
    { key: 'active', header: 'Status', render: (r) => <ActiveChip isActive={r.isActive} /> },
    ...(canManage ? [{
      key: 'actions', header: '',
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <ActionButton onClick={() => setEditing(r)}>Edit</ActionButton>
          <ActionButton tone="danger" onClick={() => remove(r)}>Delete</ActionButton>
        </span>
      ),
    }] : []),
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <SectionTitle tip="Scoped probation rules used when a new hire is provisioned and by the nightly confirmation sweep. The most specific active policy wins: entity + type beats entity, beats type, beats the company-wide row. A probation period set on the employee or offer wins over any policy.">
            Probation policy
          </SectionTitle>
          <p className="text-xs text-gray-500 mt-0.5">
            Probation length, HR reminders and optional auto-confirmation — per entity and employment type.
          </p>
        </div>
        {canManage && <PrimaryButton onClick={() => setEditing('new')}>New policy</PrimaryButton>}
      </div>
      {error && <ErrorBanner message={error} />}
      <DataTable
        columns={columns}
        rows={items || []}
        loading={loading}
        emptyText="No probation policies yet — new hires get the 90-day default until you add one."
      />
      {editing && (
        <ProbationModal
          policy={editing === 'new' ? null : editing}
          entities={entities}
          letters={letters}
          lettersDenied={lettersDenied}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); flash('Probation policy saved.'); load(); }}
        />
      )}
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

export default function LifecycleSettingsPage() {
  const [meta, setMeta] = useState(null);
  const [entities, setEntities] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [designations, setDesignations] = useState([]);
  const [letters, setLetters] = useState([]);
  const [lettersDenied, setLettersDenied] = useState(false);
  const [canManage, setCanManage] = useState(true);
  const [metaError, setMetaError] = useState('');
  const [notice, setNotice] = useState('');

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };

  useEffect(() => {
    get('/api/hr/lifecycle/templates/meta')
      .then(setMeta)
      .catch((e) => setMetaError(e.data?.message || e.message || 'Failed to load the lifecycle vocabularies.'));
    get('/api/hr/org/entities').then((r) => setEntities(asList(r))).catch(() => {});
    get('/api/hr/org/departments').then((r) => setDepartments(asList(r))).catch(() => {});
    get('/api/hr/org/designations').then((r) => setDesignations(asList(r))).catch(() => {});
    // Letter templates live behind canManageLetters (a DIFFERENT key than this
    // page's canManageOnboarding) — fail soft to a plain id input on 403.
    get('/api/hr/letters/templates')
      .then((r) => setLetters(asList(r)))
      .catch((e) => { if (e.status === 403) setLettersDenied(true); });
    get('/api/auth/me')
      .then((res) => {
        const session = res?.user || res;
        setCanManage(hasPermission(permissionsFromSession(session), 'canManageOnboarding'));
      })
      .catch(() => {});
  }, []);

  return (
    <div className="p-6 sm:p-8 space-y-8">
      <PageHeader
        title={(
          <span className="inline-flex items-center">
            Lifecycle &amp; probation
            <InfoTip text="Author the onboarding / exit checklists new journeys are built from, and the probation rules applied when a hire is provisioned. Everything here is configuration — running journeys keep the snapshot they started with." />
          </span>
        )}
        subtitle="Onboarding & exit checklist templates, and the probation rules applied to new hires."
      />

      <ModuleGuide
        id="settings-lifecycle"
        title="Author lifecycle checklists and probation rules"
        what="Two configuration consoles. Checklists: each template is a per-stage task list (owner, due date relative to an anchor, blocking/mandatory flags, optional system action) that a new joiner or leaver walks through; the default template is used when a journey starts without an explicit pick. Probation policy: scoped rules (entity / employment type) setting the probation length, HR reminders, and optional automatic confirmation at the end date."
        steps={[
          'Pick Onboarding or Exit, then open a template\'s "Edit tasks" to shape its checklist — add tasks per stage, set the owner and the due rule (e.g. 3 days before the join date).',
          'Give a task a System action to wire it to the platform (document upload, e-sign, asset assignment, provisioning); leave it manual otherwise.',
          'Mark one template per direction as the Default — journeys started without an explicit pick use it.',
          'Add Probation policies: days, reminder lead time, and auto-confirm. Scope them by entity and/or employment type; the most specific active policy wins.',
        ]}
        example={<>An intern policy: <b>All entities · Intern · 180 days · auto-confirm on</b>, reminder <b>7 days</b> before. A full-time hire in the same company follows the company-wide <b>90-day</b> row instead, because the intern row only matches interns.</>}
        tips={[
          'Editing a template never affects journeys already running — their tasks are snapshots taken at journey start.',
          '"Restore starter templates" re-creates the shipped checklist sets without touching templates you authored.',
          'A probation period set directly on the employee or offer always wins over these policies.',
        ]}
      />

      {notice && <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700" role="status">{notice}</div>}
      {!canManage && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
          You have read-only access. Lifecycle templates and probation policy require the manage-onboarding permission.
        </p>
      )}
      {metaError && <ErrorBanner message={metaError} />}

      <TemplatesSection
        meta={meta}
        entities={entities}
        departments={departments}
        designations={designations}
        canManage={canManage}
        flash={flash}
      />
      <ProbationSection
        entities={entities}
        letters={letters}
        lettersDenied={lettersDenied}
        canManage={canManage}
        flash={flash}
      />
    </div>
  );
}
