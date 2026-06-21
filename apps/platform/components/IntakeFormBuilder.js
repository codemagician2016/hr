'use client';

// Admin form builder — drag-drop reordering disabled for MVP, simple
// add/move-up/move-down + edit + delete. Mounted at
// /<slug>/admin → Settings → Intake forms.
//
// Field types supported (matches lib/intakeForms.js):
//   text, textarea, email, phone, number, select, radio, checkbox,
//   date, file, signature, markdown
//
// Conditional show-if rules: each field can be set to only show when
// another field's answer matches a value. Inline UI for now — no
// visual flow editor (MVP).

import { useState, useEffect, useCallback } from 'react';
import { useConfirm } from '@/components/ConfirmDialog';

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.errors = body.errors || [];
    throw err;
  }
  return body;
}

const FIELD_TYPE_OPTIONS = [
  { value: 'text',      label: 'Short text' },
  { value: 'textarea',  label: 'Long text' },
  { value: 'email',     label: 'Email' },
  { value: 'phone',     label: 'Phone' },
  { value: 'number',    label: 'Number' },
  { value: 'select',    label: 'Dropdown' },
  { value: 'radio',     label: 'Radio buttons' },
  { value: 'checkbox',  label: 'Checkboxes' },
  { value: 'date',      label: 'Date' },
  { value: 'file',      label: 'File upload' },
  { value: 'signature', label: 'Signature' },
  { value: 'markdown',  label: 'Info text (read-only)' },
];

function newFieldId() {
  return `f_${Math.random().toString(36).slice(2, 8)}`;
}

function FieldEditor({ field, otherFields, onChange, onDelete, onMoveUp, onMoveDown }) {
  const needsOptions = ['select', 'radio', 'checkbox'].includes(field.type);
  const optionsText = (field.options || []).join('\n');
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-start gap-2 mb-3">
        <div className="flex flex-col gap-1">
          <button onClick={onMoveUp} className="text-xs text-gray-400 hover:text-gray-700">↑</button>
          <button onClick={onMoveDown} className="text-xs text-gray-400 hover:text-gray-700">↓</button>
        </div>
        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-mono uppercase tracking-wider text-gray-500 mb-1">Type</label>
            <select
              value={field.type}
              onChange={(e) => onChange({ ...field, type: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              {FIELD_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-mono uppercase tracking-wider text-gray-500 mb-1">Label</label>
            <input
              type="text"
              value={field.label || ''}
              onChange={(e) => onChange({ ...field, label: e.target.value })}
              placeholder={field.type === 'markdown' ? 'optional' : 'Customer-visible label'}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
        </div>
        <button
          onClick={onDelete}
          className="text-rose-500 hover:text-rose-700 text-lg leading-none px-1"
          title="Delete field"
        >×</button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-mono uppercase tracking-wider text-gray-500 mb-1">Help text (optional)</label>
          <input
            type="text"
            value={field.helpText || ''}
            onChange={(e) => onChange({ ...field, helpText: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm mt-6">
            <input
              type="checkbox"
              checked={!!field.required}
              onChange={(e) => onChange({ ...field, required: e.target.checked })}
              className="w-4 h-4 rounded accent-indigo-600"
            />
            Required
          </label>
        </div>
      </div>

      {needsOptions && (
        <div className="mt-3">
          <label className="block text-xs font-mono uppercase tracking-wider text-gray-500 mb-1">Options (one per line)</label>
          <textarea
            value={optionsText}
            rows={4}
            onChange={(e) => onChange({ ...field, options: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
            placeholder="Option 1&#10;Option 2&#10;Option 3"
          />
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-gray-100">
        <p className="text-xs text-gray-500 mb-2">Conditional logic — show this field only when…</p>
        <div className="flex flex-wrap gap-2">
          <select
            value={field.showIf?.fieldId || ''}
            onChange={(e) => onChange({
              ...field,
              showIf: e.target.value ? { fieldId: e.target.value, operator: 'equals', value: '' } : null,
            })}
            className="px-2 py-1 border border-gray-300 rounded text-xs"
          >
            <option value="">Always show</option>
            {otherFields.filter((f) => f.id !== field.id && f.type !== 'markdown').map((f) => (
              <option key={f.id} value={f.id}>{f.label || f.id}</option>
            ))}
          </select>
          {field.showIf?.fieldId && (
            <>
              <select
                value={field.showIf.operator}
                onChange={(e) => onChange({ ...field, showIf: { ...field.showIf, operator: e.target.value } })}
                className="px-2 py-1 border border-gray-300 rounded text-xs"
              >
                <option value="equals">equals</option>
                <option value="notEquals">does not equal</option>
                <option value="contains">contains</option>
                <option value="notEmpty">is filled in</option>
              </select>
              {field.showIf.operator !== 'notEmpty' && (
                <input
                  type="text"
                  value={field.showIf.value || ''}
                  onChange={(e) => onChange({ ...field, showIf: { ...field.showIf, value: e.target.value } })}
                  placeholder="value"
                  className="px-2 py-1 border border-gray-300 rounded text-xs"
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FormEditor({ form, onSave, onCancel, busy }) {
  const [name, setName] = useState(form?.name || '');
  const [description, setDescription] = useState(form?.description || '');
  const [fields, setFields] = useState(form?.fields || []);
  const [error, setError] = useState('');
  const confirm = useConfirm();

  function addField() {
    setFields([...fields, { id: newFieldId(), type: 'text', label: '', required: false }]);
  }
  function updateField(idx, next) {
    setFields(fields.map((f, i) => (i === idx ? next : f)));
  }
  async function deleteField(idx) {
    if (!await confirm('Delete this field?', { confirmLabel: 'Delete', tone: 'danger' })) return;
    setFields(fields.filter((_, i) => i !== idx));
  }
  function moveField(idx, dir) {
    const target = idx + dir;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    [next[idx], next[target]] = [next[target], next[idx]];
    setFields(next);
  }
  async function save() {
    setError('');
    if (!name.trim()) { setError('Form name is required'); return; }
    try {
      await onSave({ name: name.trim(), description: description.trim() || null, fields });
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4 max-w-3xl">
      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}
      <div>
        <label className="block text-xs font-mono uppercase tracking-wider text-gray-500 mb-1">Form name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. New patient intake"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
        />
      </div>
      <div>
        <label className="block text-xs font-mono uppercase tracking-wider text-gray-500 mb-1">Description (optional)</label>
        <textarea
          value={description}
          rows={2}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Shown to customer above the form"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
        />
      </div>

      <div>
        <p className="text-sm font-semibold text-gray-900 mb-2">Fields ({fields.length})</p>
        <div className="space-y-3">
          {fields.map((f, i) => (
            <FieldEditor
              key={f.id}
              field={f}
              otherFields={fields}
              onChange={(next) => updateField(i, next)}
              onDelete={() => deleteField(i)}
              onMoveUp={() => moveField(i, -1)}
              onMoveDown={() => moveField(i, 1)}
            />
          ))}
        </div>
        <button
          onClick={addField}
          className="mt-3 px-4 py-2 rounded-lg border border-dashed border-gray-300 text-sm text-gray-600 hover:border-gray-500 hover:text-gray-900 w-full"
        >
          + Add field
        </button>
      </div>

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save form'}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function IntakeFormBuilder() {
  const [forms, setForms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // null | 'new' | { form }
  const confirm = useConfirm();

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const d = await api('/api/intake-forms');
      setForms(d.forms || []);
    } catch (err) {
      setError(err.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function saveForm(payload) {
    setBusy(true);
    try {
      if (editing === 'new') {
        await api('/api/intake-forms', { method: 'POST', body: JSON.stringify(payload) });
      } else if (editing?.form) {
        await api(`/api/intake-forms/${editing.form.id}`, {
          method: 'PUT', body: JSON.stringify(payload),
        });
      }
      setEditing(null);
      await load();
    } finally { setBusy(false); }
  }

  async function deleteForm(form) {
    if (!await confirm(`Delete "${form.name}"? Existing submissions will remain.`, { confirmLabel: 'Delete', tone: 'danger' })) return;
    setBusy(true); setError('');
    try {
      await api(`/api/intake-forms/${form.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading intake forms…</p>;

  if (editing) {
    return (
      <div>
        <div className="mb-4 flex items-center gap-3">
          <button
            onClick={() => setEditing(null)}
            className="text-sm text-indigo-600 hover:text-indigo-800"
          >
            ← Back to forms
          </button>
          <h2 className="text-lg font-semibold text-gray-900">
            {editing === 'new' ? 'New form' : `Edit: ${editing.form?.name}`}
          </h2>
        </div>
        <FormEditor
          form={editing === 'new' ? null : editing.form}
          onSave={saveForm}
          onCancel={() => setEditing(null)}
          busy={busy}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Intake forms</h2>
          <p className="text-sm text-gray-500 mt-1">
            Custom forms customers fill before/at booking — medical history, signatures,
            uploads, conditional questions.
          </p>
        </div>
        <button
          onClick={() => setEditing('new')}
          className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700"
        >
          + New form
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      {forms.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-8 text-center">
          <p className="text-sm text-gray-500">
            No intake forms yet. Create one to start collecting custom info from customers.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs font-semibold uppercase tracking-wider text-gray-600">
              <tr>
                <th className="text-left p-3 pl-5">Name</th>
                <th className="text-left p-3">Fields</th>
                <th className="text-left p-3">Used by</th>
                <th className="text-right p-3">Submissions</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {forms.map((f) => (
                <tr key={f.id} className="border-b border-gray-100 last:border-0">
                  <td className="p-3 pl-5 font-medium text-gray-900">{f.name}</td>
                  <td className="p-3 text-gray-700">{(f.fields || []).length}</td>
                  <td className="p-3 text-gray-700">
                    {f.services?.length ? f.services.map((s) => s.name).join(', ') : <span className="italic text-gray-400">No services attached</span>}
                  </td>
                  <td className="p-3 text-right text-gray-700">{f._count?.submissions || 0}</td>
                  <td className="p-3 text-right space-x-2 whitespace-nowrap">
                    <button
                      onClick={() => setEditing({ form: f })}
                      className="px-3 py-1 rounded-lg border border-gray-300 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteForm(f)}
                      disabled={busy}
                      className="px-3 py-1 rounded-lg border border-rose-300 text-xs font-medium text-rose-700 hover:bg-rose-50"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
