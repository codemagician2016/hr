'use client';

// Settings → Field access (Phase 5c: field-level permissions).
// A per-role matrix of employee field-GROUP access. Each cell is HIDDEN / READ /
// WRITE; the employee read/write paths enforce it (HIDDEN → the group's fields are
// omitted from the record, READ → visible but not editable, WRITE → full — the
// default for any group with no rule). Unlike the roles console, field access MAY be
// set on system roles: it only ever RESTRICTS what a role sees, never escalates.
//
// REST:
//   GET /api/hr/field-access/roles  → { items:[{id,name,isSystem,fieldAccess}], actingRoleId, groups:[{key,label}] }
//   PUT /api/hr/field-access/roles/:id  body { fieldAccess:{ group: 'HIDDEN'|'READ'|'WRITE' } }
// Gated on canManageEmployees.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { get, request } from '@/lib/api';
import { PageHeader } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';

const LEVELS = [
  ['WRITE', 'Full access', 'text-emerald-700 border-emerald-200 bg-emerald-50'],
  ['READ', 'View only', 'text-amber-700 border-amber-200 bg-amber-50'],
  ['HIDDEN', 'Hidden', 'text-rose-700 border-rose-200 bg-rose-50'],
];
const LEVEL_KEYS = LEVELS.map((l) => l[0]);
const levelOf = (map, key) => (LEVEL_KEYS.includes(map?.[key]) ? map[key] : 'WRITE');

export default function FieldAccessPage() {
  const [items, setItems] = useState(null);
  const [groups, setGroups] = useState([]);
  const [actingRoleId, setActingRoleId] = useState(null);
  const [edits, setEdits] = useState({});      // { roleId: { group: level } }
  const [saving, setSaving] = useState(null);  // roleId currently saving
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [canManage, setCanManage] = useState(true);
  const [notice, setNotice] = useState('');
  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };

  const load = useCallback(() => {
    setLoading(true);
    get('/api/hr/field-access/roles')
      .then((res) => {
        const list = res?.items || (Array.isArray(res) ? res : []);
        setItems(list);
        setGroups(res?.groups || []);
        setActingRoleId(res?.actingRoleId || null);
        const seed = {};
        for (const r of list) seed[r.id] = { ...(r.fieldAccess && typeof r.fieldAccess === 'object' ? r.fieldAccess : {}) };
        setEdits(seed);
      })
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load field access.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    get('/api/auth/me')
      .then((res) => setCanManage(hasPermission(permissionsFromSession(res?.user || res), 'canManageEmployees')))
      .catch(() => {});
  }, [load]);

  const dirty = useMemo(() => {
    const d = {};
    for (const r of (items || [])) {
      const orig = r.fieldAccess && typeof r.fieldAccess === 'object' ? r.fieldAccess : {};
      const cur = edits[r.id] || {};
      d[r.id] = groups.some((g) => levelOf(orig, g.key) !== levelOf(cur, g.key));
    }
    return d;
  }, [items, edits, groups]);

  function setCell(roleId, groupKey, level) {
    setEdits((e) => ({ ...e, [roleId]: { ...(e[roleId] || {}), [groupKey]: level } }));
  }

  async function save(role) {
    setSaving(role.id);
    try {
      const map = {};
      for (const g of groups) map[g.key] = levelOf(edits[role.id], g.key);
      await request(`/api/hr/field-access/roles/${role.id}`, { method: 'PUT', body: JSON.stringify({ fieldAccess: map }) });
      flash(`Field access saved for "${role.name}".`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to save field access.');
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Field access" subtitle="Control which employee fields each role can see and edit." />
      <ModuleGuide title="How field access works">
        For each role, choose the access level per group of employee fields.
        <b> Full access</b> lets the role view and edit; <b>View only</b> shows the fields but blocks edits;
        <b> Hidden</b> removes the fields from the record entirely. Any group left at Full access behaves
        exactly as before, so existing roles are unaffected until you change something. This is on top of the
        module permissions — a role still needs “manage employees” to reach these fields at all.
      </ModuleGuide>

      {notice && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div>}
      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</div>}
      {!canManage && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          You don’t have permission to change field access. This view is read-only.
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !items || items.length === 0 ? (
        <p className="text-sm text-gray-500">No roles defined yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-3 py-2 font-medium">Role</th>
                {groups.map((g) => <th key={g.key} className="px-3 py-2 font-medium">{g.label}</th>)}
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((role) => (
                <tr key={role.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-3 py-2 align-middle">
                    <div className="font-medium text-gray-800">{role.name}</div>
                    <div className="text-[11px] text-gray-400">
                      {role.isSystem ? 'System role' : 'Custom role'}{role.id === actingRoleId ? ' · your role' : ''}
                    </div>
                  </td>
                  {groups.map((g) => {
                    const val = levelOf(edits[role.id], g.key);
                    const cls = (LEVELS.find((l) => l[0] === val) || LEVELS[0])[2];
                    return (
                      <td key={g.key} className="px-3 py-2">
                        <select
                          disabled={!canManage}
                          value={val}
                          onChange={(e) => setCell(role.id, g.key, e.target.value)}
                          className={`rounded-md border px-2 py-1 text-xs font-medium ${cls}`}
                        >
                          {LEVELS.map(([lv, label]) => <option key={lv} value={lv}>{label}</option>)}
                        </select>
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right">
                    <button
                      disabled={!canManage || !dirty[role.id] || saving === role.id}
                      onClick={() => save(role)}
                      className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 disabled:opacity-40"
                    >
                      {saving === role.id ? 'Saving…' : 'Save'}
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
