'use client';

// Competency framework config (Feature 34) — HR-Admin (canManagePerformanceCycle).
//   - Library tab: the org-wide Competency catalog (code, name, category, active).
//     Create/edit via a drawer. Categories render as colour-coded badges.
//   - Role map tab: pick a role key (designationId / grade / 'ALL'), add competencies
//     with an expected proficiency + optional weight. The map is read-locked once a
//     consuming cycle launches (same banner as the scale lock).
//   Competency ASSESSMENT is captured during the review (ReviewResponse rows); this
//   screen only manages the catalog + the expectations.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, PrimaryButton, Modal, ModalActions, TextInput, TextArea } from '@hr/ui';
import { GapBar } from '@hr/ui';
import { get, post, patch, del } from '@/lib/api';
import { asList, PageHeader, Tabs, DataTable, StatusBadge, ActionButton } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';

const CATEGORIES = ['CORE', 'LEADERSHIP', 'FUNCTIONAL', 'BEHAVIOURAL', 'TECHNICAL'];
const TABS = [{ key: 'library', label: 'Library' }, { key: 'rolemap', label: 'Role map' }];

function CompetencyDrawer({ initial, onClose, onSaved }) {
  const [draft, setDraft] = useState(initial || { code: '', name: '', category: 'BEHAVIOURAL', description: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editing = !!(initial && initial.id);
  async function save(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      if (editing) await patch(`/api/hr/ninebox/competencies/${initial.id}`, { name: draft.name, category: draft.category, description: draft.description, version: initial.version });
      else await post('/api/hr/ninebox/competencies', draft);
      onSaved();
    } catch (err) { setError(err.data?.message || err.message || 'Save failed.'); setSaving(false); }
  }
  return (
    <Modal title={editing ? 'Edit competency' : 'New competency'} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <div className="grid grid-cols-2 gap-3">
          <TextInput label="Code" value={draft.code} onChange={(v) => setDraft((d) => ({ ...d, code: v }))} required disabled={editing} />
          <label className="block text-sm">
            <span className="text-gray-700 font-medium">Category</span>
            <select value={draft.category} onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>
        <TextInput label="Name" value={draft.name} onChange={(v) => setDraft((d) => ({ ...d, name: v }))} required />
        <TextArea label="Description" value={draft.description || ''} onChange={(v) => setDraft((d) => ({ ...d, description: v }))} rows={2} />
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>{editing ? 'Save' : 'Create'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

function RoleMapTab({ canConfig, competencies }) {
  const [roleKey, setRoleKey] = useState('ALL');
  const [maps, setMaps] = useState(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ competencyId: '', expectedLevel: '3', weight: '' });
  const [locked, setLocked] = useState(false);

  const load = useCallback(() => {
    setError('');
    get('/api/hr/ninebox/role-competencies', { roleKey }).then((r) => setMaps(asList(r))).catch((e) => { setError(e.message || 'Failed to load.'); setMaps([]); });
  }, [roleKey]);
  useEffect(() => { load(); }, [load]);

  async function add(e) {
    e.preventDefault();
    setError('');
    try {
      await post('/api/hr/ninebox/role-competencies', { competencyId: draft.competencyId, roleKey, expectedLevel: Number(draft.expectedLevel), ...(draft.weight ? { weight: Number(draft.weight) } : {}) });
      setAdding(false); setDraft({ competencyId: '', expectedLevel: '3', weight: '' }); setLocked(false); load();
    } catch (err) {
      if (/locked/i.test(err.data?.message || '')) setLocked(true);
      setError(err.data?.message || err.message || 'Add failed.');
    }
  }
  async function remove(id) {
    setError('');
    try { await del(`/api/hr/ninebox/role-competencies/${id}`); load(); }
    catch (err) { setError(err.data?.message || err.message || 'Remove failed.'); }
  }

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} />}
      {locked && <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">A review cycle is active — the role-competency map is read-locked. Wait for the cycle to close (or clone) to edit.</div>}
      <div className="flex items-center gap-2">
        <label className="text-sm text-gray-700">Role key
          <input value={roleKey} onChange={(e) => setRoleKey(e.target.value)} className="ml-2 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" placeholder="ALL / designationId / grade" />
        </label>
        {canConfig && <ActionButton onClick={() => setAdding((a) => !a)}>{adding ? 'Cancel' : 'Add competency'}</ActionButton>}
      </div>
      <p className="text-xs text-gray-500">These are the competencies everyone in this role is rated against. Expected level is the bar; the gap is target minus actual.</p>

      {adding && (
        <form onSubmit={add} className="flex flex-wrap items-end gap-2 rounded-xl border border-gray-200 bg-gray-50 p-3">
          <label className="text-sm">Competency
            <select value={draft.competencyId} onChange={(e) => setDraft((d) => ({ ...d, competencyId: e.target.value }))} required className="ml-2 rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
              <option value="">Select…</option>
              {competencies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select>
          </label>
          <label className="text-sm">Expected<input type="number" step="0.5" value={draft.expectedLevel} onChange={(e) => setDraft((d) => ({ ...d, expectedLevel: e.target.value }))} className="ml-2 w-20 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" /></label>
          <label className="text-sm">Weight<input type="number" value={draft.weight} onChange={(e) => setDraft((d) => ({ ...d, weight: e.target.value }))} className="ml-2 w-20 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" placeholder="opt" /></label>
          <PrimaryButton type="submit">Add</PrimaryButton>
        </form>
      )}

      <DataTable
        columns={[
          { key: 'competency', header: 'Competency', render: (m) => <span className="font-medium text-gray-900">{m.competency ? `${m.competency.code} · ${m.competency.name}` : m.competencyId}</span> },
          { key: 'category', header: 'Category', render: (m) => m.competency ? <StatusBadge status={m.competency.category} /> : '—' },
          { key: 'expected', header: 'Expected', render: (m) => <div className="w-40"><GapBar expected={Number(m.expectedLevel)} actual={null} /></div> },
          { key: 'weight', header: 'Weight', render: (m) => (m.weight != null ? m.weight : '—') },
          { key: 'actions', header: '', render: (m) => canConfig ? <ActionButton tone="danger" onClick={() => remove(m.id)}>Remove</ActionButton> : null },
        ]}
        rows={maps} loading={maps === null} emptyText="No competencies mapped to this role yet." />
    </div>
  );
}

export default function CompetenciesPage() {
  const [tab, setTab] = useState('library');
  const [perms, setPerms] = useState(null);
  const [competencies, setCompetencies] = useState(null);
  const [error, setError] = useState('');
  const [drawer, setDrawer] = useState(null); // null | {} | competency

  const canConfig = hasPermission(perms, 'canManagePerformanceCycle');

  const load = useCallback(async () => {
    setError('');
    const me = await get('/api/auth/me').catch(() => null);
    setPerms(permissionsFromSession(me?.user || me));
    try { setCompetencies(asList(await get('/api/hr/ninebox/competencies'))); }
    catch (e) { setError(e.message || 'Failed to load competencies.'); setCompetencies([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <PageHeader
        title="Competency framework"
        subtitle="The library + role expectations behind the 9-box and review competency scores"
        actions={tab === 'library' && canConfig ? <PrimaryButton onClick={() => setDrawer({})}>New competency</PrimaryButton> : null}
      />
      {error ? <ErrorBanner message={error} /> : null}
      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'library' && (
        <DataTable
          columns={[
            { key: 'code', header: 'Code', render: (c) => <span className="font-medium text-gray-900">{c.code}</span> },
            { key: 'name', header: 'Name', render: (c) => c.name },
            { key: 'category', header: 'Category', render: (c) => <StatusBadge status={c.category} /> },
            { key: 'active', header: 'Active', render: (c) => (c.isActive ? 'Yes' : 'No') },
            { key: 'actions', header: '', render: (c) => canConfig ? <ActionButton onClick={() => setDrawer(c)}>Edit</ActionButton> : null },
          ]}
          rows={competencies} loading={competencies === null} emptyText="No competencies yet — create your first to build a role map." />
      )}

      {tab === 'rolemap' && <RoleMapTab canConfig={canConfig} competencies={competencies || []} />}

      {drawer && <CompetencyDrawer initial={drawer.id ? drawer : null} onClose={() => setDrawer(null)} onSaved={() => { setDrawer(null); load(); }} />}
    </div>
  );
}
