'use client';

// Settings → Custom fields (Phase 5b).
//
// Tenant-defined, typed custom fields on the Employee entity. An admin defines a
// field (label + type + ESS visibility/policy); it then renders + edits on the
// admin employee-detail page and (per policy) on the ESS profile. This console is
// the definition CRUD. All routes require canManageEmployees (server-gated); the
// page shows a read-only banner + hides the editors for operators who lack it.
//
//   GET    /api/hr/custom-fields/definitions?entityType=EMPLOYEE&includeInactive=1
//          → { definitions:[ Def ] }  (or a bare array — read defensively)
//          Def = { id, key, label, description, fieldType:'TEXT'|'NUMBER'|'DATE'|
//                  'SELECT'|'BOOLEAN', options:[{value,label}]|null, required,
//                  essVisible, essPolicy:'HIDDEN'|'READ_ONLY'|'SELF_EDIT',
//                  section, orderIndex, isActive }
//   POST   /api/hr/custom-fields/definitions   { entityType:'EMPLOYEE', fieldType,
//          key?, label, description?, options?, required?, essVisible?, essPolicy?,
//          section?, orderIndex? } → { definition: Def }   (key auto-slugified)
//   PATCH  /api/hr/custom-fields/definitions/:id  (editable subset: label,
//          description, options, required, essVisible, essPolicy, section,
//          orderIndex, isActive) — fieldType + key are IMMUTABLE
//   DELETE /api/hr/custom-fields/definitions/:id  → soft-archive

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBanner, Modal, ModalActions, PrimaryButton, TextInput } from '@hr/ui';
import { get, post, patch, del } from '@/lib/api';
import { DataTable, PageHeader, ActionButton } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';

/* ── vocab ────────────────────────────────────────────────────────────────── */

const FIELD_TYPES = [
  ['TEXT', 'Text'],
  ['NUMBER', 'Number'],
  ['DATE', 'Date'],
  ['SELECT', 'Dropdown (choose one)'],
  ['BOOLEAN', 'Yes / No'],
];
const FIELD_TYPE_LABEL = Object.fromEntries(FIELD_TYPES);

const ESS_POLICIES = [
  ['HIDDEN', 'Hidden from employees'],
  ['READ_ONLY', 'Employees can view (read-only)'],
  ['SELF_EDIT', 'Employees can view & edit'],
];
const ESS_POLICY_LABEL = Object.fromEntries(ESS_POLICIES);

/* ── chips ────────────────────────────────────────────────────────────────── */

function TypeChip({ type, count }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
        {FIELD_TYPE_LABEL[type] || type}
      </span>
      {type === 'SELECT' && (
        <span className="text-[11px] text-gray-400">{count} option{count === 1 ? '' : 's'}</span>
      )}
    </span>
  );
}

function EssChip({ def }) {
  const hidden = !def.essVisible || def.essPolicy === 'HIDDEN';
  if (hidden) {
    return (
      <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
        Hidden
      </span>
    );
  }
  const editable = def.essPolicy === 'SELF_EDIT';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${editable ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-sky-50 text-sky-700 border-sky-200'}`}>
      {editable ? 'Employee can edit' : 'Read-only'}
    </span>
  );
}

/* ── create / edit modal ────────────────────────────────────────────────────── */

function DefinitionModal({ def, onClose, onSaved }) {
  const isEdit = !!def;
  const [form, setForm] = useState(() => ({
    label: def?.label || '',
    description: def?.description || '',
    fieldType: def?.fieldType || 'TEXT',
    required: def?.required ?? false,
    essVisible: def?.essVisible ?? true,
    essPolicy: def?.essPolicy || 'READ_ONLY',
    section: def?.section || '',
    orderIndex: def?.orderIndex ?? 0,
  }));
  const [options, setOptions] = useState(() =>
    Array.isArray(def?.options) && def.options.length ? def.options.map((o) => ({ value: o.value ?? '', label: o.label ?? '' })) : [{ value: '', label: '' }]
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const isSelect = form.fieldType === 'SELECT';

  function setOption(i, k, v) {
    setOptions((rows) => rows.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));
  }
  function addOption() {
    setOptions((rows) => [...rows, { value: '', label: '' }]);
  }
  function removeOption(i) {
    setOptions((rows) => (rows.length <= 1 ? rows : rows.filter((_, idx) => idx !== i)));
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    // For a dropdown, keep only rows with a value; label falls back to the value.
    const cleanOptions = options
      .map((o) => ({ value: String(o.value || '').trim(), label: String(o.label || '').trim() }))
      .filter((o) => o.value)
      .map((o) => ({ value: o.value, label: o.label || o.value }));

    if (isSelect && cleanOptions.length === 0) {
      setError('A dropdown needs at least one option.');
      setSaving(false);
      return;
    }

    const editable = {
      label: form.label.trim(),
      description: form.description.trim() || null,
      required: !!form.required,
      essVisible: !!form.essVisible,
      essPolicy: form.essPolicy,
      section: form.section.trim() || null,
      orderIndex: Number.isFinite(Number(form.orderIndex)) ? Number(form.orderIndex) : 0,
      options: isSelect ? cleanOptions : null,
    };

    try {
      if (isEdit) {
        // fieldType + key are immutable — only send the editable subset.
        await patch(`/api/hr/custom-fields/definitions/${def.id}`, editable);
        onSaved(`"${editable.label}" saved.`);
      } else {
        await post('/api/hr/custom-fields/definitions', {
          entityType: 'EMPLOYEE',
          fieldType: form.fieldType,
          ...editable,
        });
        onSaved(`"${editable.label}" created.`);
      }
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to save the custom field.');
      setSaving(false);
    }
  }

  return (
    <Modal title={isEdit ? `Edit — ${def.label}` : 'New custom field'} size="lg" onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        {error && <ErrorBanner message={error} />}

        <TextInput label="Label" value={form.label} onChange={(v) => set('label', v)} required placeholder="e.g. T-shirt size" hint="What employees and HR see. A short key is generated from this automatically." />

        <label className="block text-sm">
          <span className="block font-medium text-gray-700 mb-1">Description</span>
          <textarea
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            rows={2}
            placeholder="Optional — a short explanation shown as a hint."
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>

        <div>
          <label className="flex items-center text-sm font-medium text-gray-700 mb-1">
            Field type
            <InfoTip text="How the value is captured. The type is fixed once the field is created — create a new field to change it." />
          </label>
          <select
            value={form.fieldType}
            onChange={(e) => set('fieldType', e.target.value)}
            disabled={isEdit}
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm bg-white disabled:bg-gray-50 disabled:text-gray-500"
          >
            {FIELD_TYPES.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          {isEdit && <p className="mt-1 text-xs text-gray-400">The field type can&apos;t be changed after creation.</p>}
        </div>

        {isSelect && (
          <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-3">
            <div className="mb-2 flex items-center text-sm font-medium text-gray-700">
              Dropdown options
              <InfoTip text="The choices an employee/HR can pick. The value is stored; the label is shown. Leave the label blank to reuse the value." />
            </div>
            <div className="space-y-2">
              {options.map((o, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={o.value}
                    onChange={(e) => setOption(i, 'value', e.target.value)}
                    placeholder="value (stored)"
                    className="flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                  />
                  <input
                    value={o.label}
                    onChange={(e) => setOption(i, 'label', e.target.value)}
                    placeholder="label (shown)"
                    className="flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => removeOption(i)}
                    disabled={options.length <= 1}
                    className="rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-500 hover:bg-white disabled:opacity-40"
                    aria-label="Remove option"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button type="button" onClick={addOption} className="mt-2 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-white">
              + Add option
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <TextInput label="Section" value={form.section} onChange={(v) => set('section', v)} placeholder="Optional — groups related fields" />
          <TextInput label="Order" type="number" value={String(form.orderIndex)} onChange={(v) => set('orderIndex', v)} hint="Lower numbers show first." />
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={!!form.required} onChange={(e) => set('required', e.target.checked)} />
          Required
          <InfoTip text="When on, a value must be supplied for this field." />
        </label>

        <div className="rounded-xl border border-gray-200 p-3 space-y-3">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={!!form.essVisible} onChange={(e) => set('essVisible', e.target.checked)} />
            Show on the employee self-service portal
            <InfoTip text="When off, this field is admin-only and never appears to employees." />
          </label>
          <div>
            <label className="flex items-center text-sm font-medium text-gray-700 mb-1">
              Employee access
              <InfoTip text="Controls what employees can do with this field on their own profile: hidden, view-only, or view & edit." />
            </label>
            <select
              value={form.essPolicy}
              onChange={(e) => set('essPolicy', e.target.value)}
              disabled={!form.essVisible}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm bg-white disabled:bg-gray-50 disabled:text-gray-500"
            >
              {ESS_POLICIES.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
        </div>

        <ModalActions>
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>{isEdit ? 'Save field' : 'Create field'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

/* ── page ─────────────────────────────────────────────────────────────────── */

export default function CustomFieldsPage() {
  const [defs, setDefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [canManage, setCanManage] = useState(true);
  const [notice, setNotice] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null); // Def being edited
  const [creating, setCreating] = useState(false);

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };

  const load = useCallback(() => {
    setLoading(true);
    get('/api/hr/custom-fields/definitions', { entityType: 'EMPLOYEE', includeInactive: 1 })
      .then((res) => setDefs(res?.items || res?.definitions || (Array.isArray(res) ? res : [])))
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load custom fields.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    get('/api/auth/me')
      .then((res) => {
        const session = res?.user || res;
        setCanManage(hasPermission(permissionsFromSession(session), 'canManageEmployees'));
      })
      .catch(() => {});
  }, [load]);

  const rows = useMemo(() => {
    const list = (defs || []).filter((d) => (showArchived ? true : d.isActive !== false));
    return [...list].sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0) || String(a.label).localeCompare(String(b.label)));
  }, [defs, showArchived]);

  async function archive(def) {
    if (!window.confirm(`Archive "${def.label}"? It stops appearing on new records; existing values are kept.`)) return;
    try {
      await del(`/api/hr/custom-fields/definitions/${def.id}`);
      flash(`"${def.label}" archived.`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to archive the field.');
    }
  }

  async function restore(def) {
    try {
      await patch(`/api/hr/custom-fields/definitions/${def.id}`, { isActive: true });
      flash(`"${def.label}" restored.`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to restore the field.');
    }
  }

  const columns = [
    {
      key: 'field', header: 'Field',
      render: (d) => (
        <span className="block">
          <span className="block font-medium text-gray-900">{d.label}</span>
          <span className="block font-mono text-[11px] text-gray-400">{d.key}</span>
          {d.description && <span className="block text-[11px] text-gray-400">{d.description}</span>}
        </span>
      ),
    },
    { key: 'type', header: 'Type', render: (d) => <TypeChip type={d.fieldType} count={(d.options || []).length} /> },
    { key: 'section', header: 'Section', render: (d) => <span className="text-xs text-gray-500">{d.section || '—'}</span> },
    {
      key: 'required', header: 'Required',
      render: (d) => (d.required
        ? <span className="text-xs font-medium text-gray-700">Yes</span>
        : <span className="text-xs text-gray-400">—</span>),
    },
    { key: 'ess', header: 'Employees', render: (d) => <EssChip def={d} /> },
    {
      key: 'status', header: 'Status',
      render: (d) => (d.isActive === false
        ? <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">Archived</span>
        : <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">Active</span>),
    },
    ...(canManage ? [{
      key: 'actions', header: '',
      render: (d) => (
        <span className="flex items-center gap-2">
          <ActionButton onClick={() => setEditing(d)}>Edit</ActionButton>
          {d.isActive === false
            ? <ActionButton tone="positive" onClick={() => restore(d)}>Restore</ActionButton>
            : <ActionButton tone="danger" onClick={() => archive(d)}>Archive</ActionButton>}
        </span>
      ),
    }] : []),
  ];

  const activeCount = (defs || []).filter((d) => d.isActive !== false).length;

  return (
    <div className="p-6 sm:p-8 space-y-8">
      <PageHeader
        title={(
          <span className="inline-flex items-center">
            Custom fields
            <InfoTip text="Extra, typed fields you define on employees — they render and edit on the employee record and (per your choice) on the employee self-service portal." />
          </span>
        )}
        subtitle="Define your own typed fields on employees — text, number, date, dropdown or yes/no."
        actions={canManage ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
            style={{ backgroundColor: 'var(--theme-primary)' }}
          >
            New field
          </button>
        ) : null}
      />

      <ModuleGuide
        id="settings-custom-fields"
        title="Add your own fields to employee records"
        what="Custom fields let you capture details the standard record doesn't — a T-shirt size, a parking slot, a certification date. Choose a type (text, number, date, dropdown or yes/no) and whether employees can see or edit it themselves. Fields then appear on the employee-detail page and, per your choice, on the employee self-service profile."
        steps={[
          'Click New field and give it a label (a short key is generated for you).',
          'Pick the field type — for a dropdown, add the options employees choose from.',
          'Choose whether employees can see it (read-only) or edit it themselves.',
          'Set a section and order to group and sort related fields, then Create.',
        ]}
        example={<>Add <b>T-shirt size</b> as a dropdown (S/M/L/XL), visible to employees to edit — HR sees it on the employee record and each person sets their own on their profile.</>}
        tips={[
          'The field type and key are fixed once created — create a new field to change the type.',
          'Archiving a field hides it from new records but keeps existing values; you can restore it later.',
        ]}
      />

      {notice && <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700" role="status">{notice}</div>}
      {!canManage && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
          You have read-only access. Defining custom fields requires the manage-employees permission.
        </p>
      )}
      {error && <ErrorBanner message={error} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
        {!loading && defs && (
          <p className="text-xs text-gray-500">{activeCount} active field{activeCount === 1 ? '' : 's'}</p>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={loading ? [] : rows}
        loading={loading}
        rowKey={(r) => r.id}
        caption="Employee custom fields"
        emptyText={showArchived ? 'No custom fields yet.' : 'No active custom fields yet. Click “New field” to add one.'}
      />

      {creating && (
        <DefinitionModal
          def={null}
          onClose={() => setCreating(false)}
          onSaved={(msg) => { setCreating(false); flash(msg); load(); }}
        />
      )}
      {editing && (
        <DefinitionModal
          def={editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); flash(msg); load(); }}
        />
      )}
    </div>
  );
}
