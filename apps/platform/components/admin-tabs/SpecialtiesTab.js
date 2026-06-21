'use client';

// Doctor v2 — Specialties / Departments management (APPOINTMENT vertical).
// CRUD over /api/specialties. Doctors are assigned to a specialty from
// Team → edit member (specialty dropdown).

import { useState } from 'react';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, Empty, PrimaryButton, TextInput, TextArea } from '@/components/admin-ui';
import { useConfirm } from '@/components/ConfirmDialog';
import { useApi } from '@/lib/useApi';

export default function SpecialtiesTab() {
  const { data: specialties = [], loading, error, reload } = useApi('/api/specialties', { select: (r) => r.specialties || [] });
  const confirm = useConfirm();
  const [form, setForm] = useState({ name: '', description: '' });
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setBusy(true); setErr('');
    try {
      if (editingId) await api(`/api/specialties/${editingId}`, { method: 'PUT', body: JSON.stringify(form) });
      else await api('/api/specialties', { method: 'POST', body: JSON.stringify(form) });
      setForm({ name: '', description: '' });
      setEditingId(null);
      await reload();
    } catch (e2) {
      setErr(e2.message || 'Could not save specialty');
    } finally {
      setBusy(false);
    }
  }

  async function remove(s) {
    if (!await confirm(`Delete "${s.name}"? Doctors assigned to it will become unassigned.`, { confirmLabel: 'Delete', tone: 'danger' })) return;
    try { await api(`/api/specialties/${s.id}`, { method: 'DELETE' }); await reload(); }
    catch (e2) { setErr(e2.message || 'Could not delete'); }
  }

  function startEdit(s) { setEditingId(s.id); setForm({ name: s.name, description: s.description || '' }); setErr(''); }
  function cancel() { setEditingId(null); setForm({ name: '', description: '' }); setErr(''); }

  if (loading) return <Spinner />;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Specialties / Departments</h2>
        <p className="text-sm text-gray-500">
          Group doctors by specialty so patients can browse and book by department.
          Assign a doctor from <span className="font-medium">Team → edit a member</span>.
        </p>
      </div>

      {error && <ErrorBanner message="Could not load specialties." />}

      <form onSubmit={save} className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
        <TextInput
          label={editingId ? 'Edit specialty' : 'New specialty'}
          value={form.name}
          onChange={(v) => setForm({ ...form, name: v })}
          placeholder="e.g. Cardiology"
          required
        />
        <TextArea
          label="Description (optional)"
          value={form.description}
          onChange={(v) => setForm({ ...form, description: v })}
          maxLength={1000}
        />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex items-center gap-3">
          <PrimaryButton type="submit" loading={busy}>{editingId ? 'Save changes' : '+ Add specialty'}</PrimaryButton>
          {editingId && (
            <button type="button" onClick={cancel} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
          )}
        </div>
      </form>

      {specialties.length === 0 ? (
        <Empty text="No specialties yet. Add your first one above." />
      ) : (
        <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
          {specialties.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <p className="font-medium text-gray-900">{s.name}</p>
                {s.description ? <p className="truncate text-sm text-gray-500">{s.description}</p> : null}
                <p className="text-xs text-gray-400">{s._count?.doctors ?? 0} doctor{(s._count?.doctors ?? 0) === 1 ? '' : 's'}</p>
              </div>
              <div className="flex shrink-0 gap-3 text-sm">
                <button type="button" onClick={() => startEdit(s)} className="text-indigo-600 hover:text-indigo-800">Edit</button>
                <button type="button" onClick={() => remove(s)} className="text-red-600 hover:text-red-800">Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
