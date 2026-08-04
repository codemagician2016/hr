'use client';

// Settings → Roles & access (Feature 1, Phase D).
//
// Two surfaces:
//  (a) Roles & permissions — every BusinessRole with its 15-permission grid and
//      data-scope band (ALL/TEAM/SELF/…). System roles (Owner/HR-Admin/Finance/
//      Manager) are read-only; custom roles are editable (create/update/delete)
//      via the RBAC endpoints. The permission catalog comes from
//      GET /api/rbac/permissions; roles from GET /api/rbac/roles.
//  (b) People → role assignment — a table of the tenant's operator users with a
//      role dropdown that PATCHes /api/business/users/:id/role. The "last Owner"
//      guard surfaces as the backend 409.
//
// The server is the enforcement boundary; this screen is the self-serve console
// for it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Spinner,
  ErrorBanner,
  Empty,
  PrimaryButton,
  TextInput,
  Modal,
  ModalActions,
} from '@hr/ui';
import { get, post, patch, request } from '@/lib/api';
import { asList, PageHeader, Tabs } from '@/lib/ui';
import ModuleGuide from '@/components/ModuleGuide';

const SCOPE_BANDS = ['ALL', 'DEPARTMENT', 'TEAM', 'SELF', 'NONE'];

// Compensation visibility bands (persisted by rbac.controller on create/update).
const COMP_VISIBILITY = [
  { value: 'ABSOLUTE', label: 'Absolute', desc: 'sees full salary figures' },
  { value: 'RANGE_ONLY', label: 'Range only', desc: 'sees bands/compa-ratio, not amounts' },
  { value: 'SELF_ONLY', label: 'Self only', desc: 'own pay only' },
  { value: 'NONE', label: 'None', desc: 'no compensation access' },
];

function ScopeBadge({ band }) {
  const b = String(band || 'ALL').toUpperCase();
  const cls =
    b === 'ALL'
      ? 'bg-blue-50 text-blue-700 border-blue-200'
      : b === 'NONE'
      ? 'bg-gray-100 text-gray-500 border-gray-200'
      : 'bg-violet-50 text-violet-700 border-violet-200';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {b}
    </span>
  );
}

// ─── (a) Roles & permissions ────────────────────────────────────────────────

function permsOf(role) {
  const p = role?.permissions;
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

function RoleEditor({ permCatalog, role, onClose, onSaved }) {
  // role === null → creating a new custom role.
  const isNew = !role;
  const [name, setName] = useState(role?.name || '');
  const [perms, setPerms] = useState(() => ({ ...permsOf(role) }));
  const [scope, setScope] = useState(role?.defaultScope || 'TEAM');
  const [compVisibility, setCompVisibility] = useState(role?.compVisibility || 'NONE');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const readOnly = !isNew && role?.isSystem;

  function toggle(key) {
    if (readOnly) return;
    setPerms((p) => ({ ...p, [key]: !p[key] }));
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      // Only send true permissions; the backend validates against the catalog.
      const payload = { name: name.trim(), permissions: perms, defaultScope: scope, compVisibility };
      if (isNew) await post('/api/rbac/roles', payload);
      else await request(`/api/rbac/roles/${role.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      onSaved();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to save role.');
      setSaving(false);
    }
  }

  return (
    <Modal title={isNew ? 'New role' : readOnly ? `${role.name} (system role)` : `Edit ${role.name}`} onClose={onClose} size="lg">
      {error && (
        <div className="mb-3">
          <ErrorBanner message={error} />
        </div>
      )}
      {readOnly && (
        <p className="mb-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          System roles are read-only. Duplicate the permission set into a custom role to customize it.
        </p>
      )}

      <div className="grid sm:grid-cols-2 gap-4 mb-5">
        <TextInput label="Role name" value={name} onChange={readOnly ? () => {} : setName} required />
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Data scope</label>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={readOnly}
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm bg-white disabled:bg-gray-50 disabled:text-gray-500"
          >
            {SCOPE_BANDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-400 mt-1">TEAM = reporting sub-tree · SELF = own record · ALL = whole tenant.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Compensation visibility</label>
          <select
            value={compVisibility}
            onChange={(e) => setCompVisibility(e.target.value)}
            disabled={readOnly}
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm bg-white disabled:bg-gray-50 disabled:text-gray-500"
          >
            {COMP_VISIBILITY.map((c) => (
              <option key={c.value} value={c.value}>
                {c.value} — {c.desc}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-400 mt-1">
            {COMP_VISIBILITY.find((c) => c.value === compVisibility)?.desc || 'no compensation access'}.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 divide-y divide-gray-100 mb-5 max-h-72 overflow-y-auto">
        {Object.entries(permCatalog).map(([key, desc]) => (
          <label
            key={key}
            className={`flex items-start gap-3 px-4 py-2.5 ${readOnly ? '' : 'cursor-pointer hover:bg-gray-50'}`}
          >
            <input
              type="checkbox"
              checked={!!perms[key]}
              onChange={() => toggle(key)}
              disabled={readOnly}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-gray-900">{key}</span>
              <span className="block text-xs text-gray-500">{desc}</span>
            </span>
          </label>
        ))}
      </div>

      <ModalActions>
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          {readOnly ? 'Close' : 'Cancel'}
        </button>
        {!readOnly && (
          <PrimaryButton loading={saving} onClick={save} disabled={!name.trim()}>
            {isNew ? 'Create role' : 'Save changes'}
          </PrimaryButton>
        )}
      </ModalActions>
    </Modal>
  );
}

function RolesTab() {
  const [roles, setRoles] = useState(null);
  const [permCatalog, setPermCatalog] = useState({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(undefined); // undefined = closed; null = new; obj = edit
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [r, p] = await Promise.all([
        get('/api/rbac/roles'),
        get('/api/rbac/permissions'),
      ]);
      setRoles(asList(r?.roles ? { items: r.roles } : r));
      setPermCatalog(p?.permissions && typeof p.permissions === 'object' ? p.permissions : {});
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to load roles.');
      setRoles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const permKeys = useMemo(() => Object.keys(permCatalog), [permCatalog]);

  async function confirmDelete() {
    try {
      await request(`/api/rbac/roles/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to delete role.');
      setDeleting(null);
    }
  }

  if (loading) return <Spinner />;

  return (
    <div>
      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">
          {permKeys.length} permissions across {roles?.length || 0} roles. System roles are read-only; create custom roles for anything else.
        </p>
        <PrimaryButton onClick={() => setEditing(null)}>New role</PrimaryButton>
      </div>

      {!roles || roles.length === 0 ? (
        <Empty text="No roles defined yet." />
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-100">
                <th scope="col" className="px-4 py-3 font-medium">Role</th>
                <th scope="col" className="px-4 py-3 font-medium">Type</th>
                <th scope="col" className="px-4 py-3 font-medium">Scope</th>
                <th scope="col" className="px-4 py-3 font-medium">Comp</th>
                <th scope="col" className="px-4 py-3 font-medium">Permissions</th>
                <th scope="col" className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => {
                const p = permsOf(role);
                const granted = permKeys.filter((k) => p[k]);
                return (
                  <tr key={role.id} className="border-b border-gray-50 last:border-0 align-top hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{role.name}</td>
                    <td className="px-4 py-3 text-gray-600">{role.isSystem ? 'System' : 'Custom'}</td>
                    <td className="px-4 py-3">
                      <ScopeBadge band={role.defaultScope} />
                    </td>
                    <td
                      className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap"
                      title={COMP_VISIBILITY.find((c) => c.value === (role.compVisibility || 'NONE'))?.desc}
                    >
                      {role.compVisibility || 'NONE'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1 max-w-md">
                        {granted.length === 0 ? (
                          <span className="text-xs text-gray-400">No permissions</span>
                        ) : (
                          granted.map((k) => (
                            <span
                              key={k}
                              className="inline-flex items-center rounded-md bg-gray-100 text-gray-700 px-1.5 py-0.5 text-[11px]"
                            >
                              {k}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => setEditing(role)}
                        className="px-2.5 py-1 text-xs font-medium border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
                      >
                        {role.isSystem ? 'View' : 'Edit'}
                      </button>
                      {!role.isSystem && (
                        <button
                          type="button"
                          onClick={() => setDeleting(role)}
                          className="ml-2 px-2.5 py-1 text-xs font-medium border border-red-300 rounded-md text-red-700 hover:bg-red-50"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing !== undefined && (
        <RoleEditor
          permCatalog={permCatalog}
          role={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            load();
          }}
        />
      )}

      {deleting && (
        <Modal title={`Delete ${deleting.name}?`} onClose={() => setDeleting(null)}>
          <p className="text-sm text-gray-600 mb-5">
            This role will be removed. Users currently assigned to it fall back to their default access. Reassign them
            first if you need them to keep elevated permissions.
          </p>
          <ModalActions>
            <button
              type="button"
              onClick={() => setDeleting(null)}
              className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg bg-red-600 hover:bg-red-700"
            >
              Delete role
            </button>
          </ModalActions>
        </Modal>
      )}
    </div>
  );
}

// ─── (b) People → role assignment ───────────────────────────────────────────

function AssignmentsTab() {
  const [users, setUsers] = useState(null);
  const [roles, setRoles] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [rowError, setRowError] = useState({}); // userId → message

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [u, r] = await Promise.all([
        get('/api/business/users'),
        get('/api/rbac/roles'),
      ]);
      setUsers(asList(u?.users ? { items: u.users } : u));
      setRoles(asList(r?.roles ? { items: r.roles } : r));
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to load users.');
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function assign(user, businessRoleId) {
    setSavingId(user.id);
    setRowError((m) => ({ ...m, [user.id]: '' }));
    try {
      const res = await patch(`/api/business/users/${user.id}/role`, { businessRoleId: businessRoleId || null });
      const updated = res?.user || res;
      setUsers((list) => list.map((x) => (x.id === user.id ? { ...x, ...updated } : x)));
    } catch (err) {
      // Surfaces the "last Owner" 409 and any 404/validation message inline.
      setRowError((m) => ({ ...m, [user.id]: err.data?.message || err.message || 'Failed to assign role.' }));
    } finally {
      setSavingId(null);
    }
  }

  if (loading) return <Spinner />;

  return (
    <div>
      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}
      <p className="text-sm text-gray-500 mb-4">
        Assign each operator a role. The role&apos;s permissions and data scope take effect on their next request — no
        re-login needed.
      </p>

      {!users || users.length === 0 ? (
        <Empty text="No operator users in this tenant yet." />
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-100">
                <th scope="col" className="px-4 py-3 font-medium">User</th>
                <th scope="col" className="px-4 py-3 font-medium">Account role</th>
                <th scope="col" className="px-4 py-3 font-medium">Assigned role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{u.name || u.email}</div>
                    {u.name && <div className="text-xs text-gray-500">{u.email}</div>}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{u.role}</td>
                  <td className="px-4 py-3">
                    <select
                      value={u.businessRoleId || ''}
                      onChange={(e) => assign(u, e.target.value)}
                      disabled={savingId === u.id}
                      className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white disabled:opacity-50"
                    >
                      <option value="">— Default ({u.role})</option>
                      {roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                          {r.isSystem ? '' : ' (custom)'}
                        </option>
                      ))}
                    </select>
                    {rowError[u.id] && <p className="text-xs text-red-600 mt-1">{rowError[u.id]}</p>}
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

const TABS = [
  { key: 'roles', label: 'Roles & permissions' },
  { key: 'assignments', label: 'Assign roles' },
];

export default function RolesPage() {
  const [tab, setTab] = useState('roles');
  return (
    <div>
      <PageHeader
        title="Roles & access"
        subtitle="Define roles, their permissions and data scope, and assign them to people"
        actions={
          <Link
            href="/settings"
            className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 inline-flex items-center"
          >
            ← Settings
          </Link>
        }
      />
      <ModuleGuide
        id="settings-roles"
        title="Decide who can see and do what"
        what="A role is a job description for the software. It answers two separate questions: WHICH ACTIONS someone can take (the permission grid — run payroll, approve leave, edit people) and WHOSE RECORDS they can act on (the data scope — everyone, their department, just their own team, or only themselves). A third setting, compensation visibility, controls whether they see real salary figures at all. Your built-in roles already cover the common cases, so most businesses only add a role when a real job doesn't fit one."
        steps={[
          'On Roles & permissions, open a role to see its permission grid and its data scope.',
          'Built-in roles (Owner, HR-Admin, Finance, Manager) are read-only — they stay correct as new features ship. To change one, copy it into a custom role instead.',
          'Create a custom role only when a real job needs a mix the built-ins don\'t have. Start from the closest built-in and adjust.',
          'Set the data scope deliberately: ALL sees every employee, TEAM sees only that manager\'s reports, SELF sees only their own record.',
          'Set compensation visibility separately — a manager can approve leave without ever seeing salaries.',
          'Switch to the People tab and give each person their role.',
        ]}
        example={<>Your payroll executive needs to prepare pay runs but must not approve them (that’s separation of duties). Copy <b>Finance</b> to a custom role <b>Payroll Executive</b>, keep <b>Run payroll</b>, remove <b>Approve payroll</b>, set scope to <b>ALL</b> and compensation visibility to <b>Absolute</b>. Then assign <b>Meera</b> to it on the People tab.</>}
        tips={[
          'Separation of duties is deliberate: whoever prepares payroll should not be the one who approves it. Keep those two permissions in different roles.',
          'Data scope is the stronger control. A permission with SELF scope still only ever touches that one person\'s record.',
          'Every business needs at least one Owner — the system will not let you remove the last one.',
          'New features add new permissions. Your built-in roles pick those up automatically on release; custom roles may need a quick review after a big update.',
        ]}
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'roles' && <RolesTab />}
      {tab === 'assignments' && <AssignmentsTab />}
    </div>
  );
}
