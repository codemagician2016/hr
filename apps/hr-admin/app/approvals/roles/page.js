'use client';

// Feature 10 slice 10e — Role Manager (the user-friendly RBAC surface).
//
// Two modes over the SAME BusinessRole/grant rows (no fork):
//   • SIMPLE (default): five preset cards (Owner / HR-Admin / Manager / Finance /
//     Employee) with a plain-English "what can they do" summary, and a one-click
//     "assign to a person". The entire RBAC UI a 3–20-person tenant needs.
//   • ADVANCED (toggle): a granular role builder — clone a preset → rename → a
//     grouped checkbox permission list → a scope picker (in words) → comp-
//     visibility → optional time-bound grants. Lockout guards surfaced from the
//     server's 400/403/409.
//
// Gated on canManageRoles (server enforces; this also hides the nav item).

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Spinner, ErrorBanner, Empty, PrimaryButton, TextInput, Modal, ModalActions } from '@hr/ui';
import { get, post, request } from '@/lib/api';
import { PageHeader, Tabs } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import { InfoTip, FieldLabel, SectionTitle, usePagination, Pagination } from '@/lib/widgets';
import ModuleGuide from '@/components/ModuleGuide';

// ─── plain-language metadata ─────────────────────────────────────────────────

// Permission groups (group the rbac.js PERMISSIONS into human buckets). Any key
// the catalog has that isn't listed here falls into "Other".
const PERM_GROUPS = [
  { key: 'people', label: 'People', keys: ['canViewEmployees', 'canManageEmployees', 'canManageOrg', 'canManageOnboarding', 'canRunSeparation'] },
  { key: 'time', label: 'Time & Leave', keys: ['canApproveLeave', 'canManageAttendance'] },
  { key: 'pay', label: 'Pay & Payroll', keys: ['canViewCompensation', 'canManageCompensation', 'canProposeCompensation', 'canApproveCompensation', 'canRunPayroll', 'canApprovePayroll', 'canViewPayrollReports', 'canManageStatutory', 'canFileReturns'] },
  { key: 'performance', label: 'Performance', keys: ['canManagePerformanceCycle', 'canCalibrateRatings', 'canViewTeamPerformance'] },
  { key: 'lifecycle', label: 'Letters & Documents', keys: ['canGenerateLetters', 'canManageLetters'] },
  { key: 'settings', label: 'Settings & Access', keys: ['canEditBilling', 'canEditDomain', 'canEditBranding', 'canManageApprovalWorkflows', 'canManageRoles', 'canManageHierarchy'] },
];

const SCOPE_OPTIONS = [
  { band: 'ALL', label: 'Everyone', hint: 'Sees and acts across the whole company.' },
  { band: 'DEPARTMENT', label: 'Their department', hint: 'Sees only people in their own department.' },
  { band: 'TEAM', label: 'Their team', hint: 'Sees only their own reporting sub-tree (their reports).' },
  { band: 'SELF', label: 'Only themselves', hint: 'Sees only their own record.' },
  { band: 'NONE', label: 'Nothing extra', hint: 'No broadened data access.' },
];

const COMP_OPTIONS = [
  { v: 'ABSOLUTE', label: 'Exact salary figures', hint: 'Can see precise pay numbers.' },
  { v: 'RANGE_ONLY', label: 'Pay bands only', hint: 'Sees a range, never the exact figure.' },
  { v: 'SELF_ONLY', label: 'Only their own pay', hint: 'Can see their own salary, nobody else’s.' },
  { v: 'NONE', label: 'No pay visibility', hint: 'Cannot see salary at all.' },
];

const PRESET_BLURB = {
  Owner: 'Full control of everything — people, pay, settings, approvals and access.',
  'HR-Admin': 'Runs HR day-to-day: people, onboarding, leave, letters and approvals — but not billing.',
  Manager: 'Looks after their own team: approves their reports’ leave, edits attendance, sees team performance.',
  Finance: 'Owns payroll and money: runs and approves pay, statutory filings and billing.',
  Employee: 'A regular employee — sees only their own information.',
};

function scopeWords(band) {
  return SCOPE_OPTIONS.find((s) => s.band === band)?.label || band;
}

function permsOf(role) {
  const p = role?.permissions;
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}
function grantedKeys(role) {
  const p = permsOf(role);
  return Object.keys(p).filter((k) => p[k]);
}

// A short, human sentence describing a role from its top permissions.
function summarise(role, catalog) {
  if (PRESET_BLURB[role.name]) return PRESET_BLURB[role.name];
  const keys = grantedKeys(role).slice(0, 4);
  if (keys.length === 0) return 'No special permissions yet.';
  const phrases = keys.map((k) => (catalog[k] || k)).join('; ');
  return `Can: ${phrases}${grantedKeys(role).length > 4 ? '…' : ''}.`;
}

// ─── Simple mode — preset cards + assign ─────────────────────────────────────

function PresetCard({ role, catalog, onAssign, onClone }) {
  return (
    <div className="flex flex-col rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center text-base font-semibold text-gray-900">
          {role.name}
          {role.isSystem && (
            <span className="ml-2 inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-500">preset</span>
          )}
        </div>
        <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
          Sees: {scopeWords(role.defaultScope)}
        </span>
      </div>
      <p className="mt-2 flex-1 text-sm text-gray-500">{summarise(role, catalog)}</p>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={onAssign}
          className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white"
          style={{ backgroundColor: 'var(--theme-primary)' }}
        >
          Assign to a person
        </button>
        <button type="button" onClick={onClone} className="text-xs font-medium text-gray-600 hover:underline">
          Make a custom copy
        </button>
      </div>
    </div>
  );
}

function AssignModal({ role, users, employees, onClose, onAssigned }) {
  // People are assigned by employeeId via POST /api/hr/rbac/employees/:id/assign-role
  // (canManageRoles-gated) — the path a delegated HR-Admin can actually call. `users`
  // are the org-tree people ({ id: employeeId, name, code, businessRoleId }).
  const [savingId, setSavingId] = useState(null);
  const [rowError, setRowError] = useState({});
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (users || []).filter((u) => !ql || (u.name || '').toLowerCase().includes(ql) || (u.code || '').toLowerCase().includes(ql));
  }, [users, q]);
  const pager = usePagination(list, { initialPageSize: 6 });

  async function assign(u) {
    setSavingId(u.id);
    setRowError((m) => ({ ...m, [u.id]: '' }));
    try {
      await post(`/api/hr/rbac/employees/${u.id}/assign-role`, { businessRoleId: role.id });
      onAssigned?.(u.id, role.id);
    } catch (err) {
      setRowError((m) => ({ ...m, [u.id]: err.data?.message || err.message || 'Failed to assign.' }));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <Modal title={`Assign “${role.name}” to…`} onClose={onClose} size="lg">
      <p className="mb-3 flex items-center text-sm text-gray-500">
        Pick a person to give them this role’s permissions and data access.
        <InfoTip text="The new permissions take effect on the person’s next action — no logout needed. You can change it any time." />
      </p>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name or employee code…"
        className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
      />
      {list.length === 0 ? (
        <Empty text="No people match." />
      ) : (
        <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200">
          {pager.pageItems.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-gray-900">{u.name || u.code}</div>
                <div className="truncate text-xs text-gray-500">
                  {u.code}{u.businessRoleId === role.id ? ' · already has this role' : ''}
                </div>
                {rowError[u.id] && <div className="text-xs text-red-600">{rowError[u.id]}</div>}
              </div>
              <button
                type="button"
                onClick={() => assign(u)}
                disabled={savingId === u.id || u.businessRoleId === role.id}
                className="shrink-0 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
              >
                {u.businessRoleId === role.id ? 'Assigned' : savingId === u.id ? 'Assigning…' : 'Assign'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Pagination pager={pager} sizes={[6, 12, 24]} noun="people" />
      <ModalActions>
        <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50">Done</button>
      </ModalActions>
    </Modal>
  );
}

// ─── Advanced mode — granular role builder ───────────────────────────────────

function GrantsEditor({ role, catalog, onChanged }) {
  const [permissionKey, setPermissionKey] = useState('');
  const [entityId, setEntityId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [error, setError] = useState('');
  const grants = role.hrPermissionGrants || [];

  async function add() {
    if (!permissionKey) return;
    setSaving(true); setError('');
    try {
      await post(`/api/hr/rbac/roles/${role.id}/grants`, {
        permissionKey,
        ...(entityId ? { entityId } : {}),
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      });
      setPermissionKey(''); setEntityId(''); setExpiresAt('');
      onChanged?.();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to add grant.');
    } finally { setSaving(false); }
  }

  // Revoke a scoped/time-bound grant early (DELETE /rbac/roles/:id/grants/:grantId)
  // instead of waiting on its auto-expiry (entity-scoped grants with no expiry never
  // clear on their own).
  async function remove(grantId) {
    setRemovingId(grantId); setError('');
    try {
      await request(`/api/hr/rbac/roles/${role.id}/grants/${grantId}`, { method: 'DELETE' });
      onChanged?.();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to remove grant.');
    } finally { setRemovingId(null); }
  }

  return (
    <div className="rounded-xl border border-gray-200 p-3">
      <SectionTitle tip="A temporary or department-scoped extra permission, on top of the role — e.g. ‘acting Finance approver for Mumbai until 31 Aug’. It expires on its own; no need to remember to undo it — or remove it early with ✕.">
        Temporary / scoped grants
      </SectionTitle>
      {grants.length > 0 && (
        <ul className="mt-2 space-y-1">
          {grants.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-2 rounded-md bg-gray-50 px-2 py-1 text-xs text-gray-600">
              <span className="min-w-0 truncate">{catalog[g.permissionKey] || g.permissionKey}{g.entityId ? ` · scoped` : ''}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-gray-400">{g.expiresAt ? `until ${new Date(g.expiresAt).toLocaleDateString()}` : 'no expiry'}</span>
                <button
                  type="button"
                  onClick={() => remove(g.id)}
                  disabled={removingId === g.id}
                  title="Remove this grant"
                  aria-label={`Remove grant ${catalog[g.permissionKey] || g.permissionKey}`}
                  className="rounded px-1 font-semibold text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                >
                  {removingId === g.id ? '…' : '✕'}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <select value={permissionKey} onChange={(e) => setPermissionKey(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
          <option value="">Pick a permission…</option>
          {Object.keys(catalog).map((k) => (<option key={k} value={k}>{catalog[k] || k}</option>))}
        </select>
        <input value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="Scope (entity id, optional)" className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
        <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
      </div>
      <button type="button" onClick={add} disabled={saving || !permissionKey} className="mt-2 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
        {saving ? 'Adding…' : '+ Add grant'}
      </button>
    </div>
  );
}

function RoleBuilder({ catalog, role, cloneFrom, onClose, onSaved }) {
  // role !== null → editing; cloneFrom → starting a custom copy of a preset.
  const base = role || cloneFrom || null;
  const isNew = !role;
  const readOnly = !isNew && role?.isSystem;
  const [name, setName] = useState(role?.name || (cloneFrom ? `${cloneFrom.name} (copy)` : ''));
  const [perms, setPerms] = useState(() => ({ ...permsOf(base) }));
  const [scope, setScope] = useState(base?.defaultScope || 'TEAM');
  const [comp, setComp] = useState(base?.compVisibility || 'NONE');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const groups = useMemo(() => {
    const known = new Set(PERM_GROUPS.flatMap((g) => g.keys));
    const other = Object.keys(catalog).filter((k) => !known.has(k));
    return other.length ? [...PERM_GROUPS, { key: 'other', label: 'Other', keys: other }] : PERM_GROUPS;
  }, [catalog]);

  function toggle(key) {
    if (readOnly) return;
    setPerms((p) => ({ ...p, [key]: !p[key] }));
  }
  function toggleGroup(keys, on) {
    if (readOnly) return;
    setPerms((p) => { const n = { ...p }; for (const k of keys) if (catalog[k]) n[k] = on; return n; });
  }

  async function save() {
    setSaving(true); setError('');
    try {
      const payload = { name: name.trim(), permissions: perms, defaultScope: scope, compVisibility: comp };
      if (isNew) await post('/api/hr/rbac/roles', payload);
      else await request(`/api/hr/rbac/roles/${role.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      onSaved();
    } catch (err) {
      // Surfaces lockout guards (cannot strip your own canManageRoles), isSystem
      // immutability, and unique-name conflicts straight from the server.
      setError(err.data?.message || err.message || 'Failed to save role.');
      setSaving(false);
    }
  }

  const title = isNew ? (cloneFrom ? `Custom copy of ${cloneFrom.name}` : 'New role') : readOnly ? `${role.name} (preset — view only)` : `Edit ${role.name}`;

  return (
    <Modal title={title} onClose={onClose} size="lg">
      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}
      {readOnly && (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          Presets can’t be edited directly. Use “Make a custom copy” to build your own version.
        </p>
      )}

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-1">
          <FieldLabel tip="A short name your team will recognise, e.g. ‘Regional HR’ or ‘Travel approver’.">Role name</FieldLabel>
          <TextInput value={name} onChange={readOnly ? () => {} : setName} required />
        </div>
        <div>
          <FieldLabel tip="How much of the company this role can see. ‘Their team’ is the usual choice for a manager; ‘Everyone’ for HR/Owner.">What can they see?</FieldLabel>
          <select value={scope} onChange={(e) => setScope(e.target.value)} disabled={readOnly} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm disabled:bg-gray-50">
            {SCOPE_OPTIONS.map((s) => (<option key={s.band} value={s.band}>{s.label}</option>))}
          </select>
          <p className="mt-1 text-[11px] text-gray-400">{SCOPE_OPTIONS.find((s) => s.band === scope)?.hint}</p>
        </div>
        <div>
          <FieldLabel tip="How much salary detail this role can see. Pick the least they need.">Salary visibility</FieldLabel>
          <select value={comp} onChange={(e) => setComp(e.target.value)} disabled={readOnly} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm disabled:bg-gray-50">
            {COMP_OPTIONS.map((c) => (<option key={c.v} value={c.v}>{c.label}</option>))}
          </select>
          <p className="mt-1 text-[11px] text-gray-400">{COMP_OPTIONS.find((c) => c.v === comp)?.hint}</p>
        </div>
      </div>

      <SectionTitle tip="Tick exactly what this role is allowed to do. Hover any item for what it means. Use the group toggles to switch a whole section on or off.">
        What can they do?
      </SectionTitle>
      <div className="mt-2 max-h-80 space-y-4 overflow-y-auto rounded-xl border border-gray-200 p-3">
        {groups.map((g) => {
          const keys = g.keys.filter((k) => catalog[k] !== undefined);
          if (keys.length === 0) return null;
          const allOn = keys.every((k) => perms[k]);
          return (
            <div key={g.key}>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">{g.label}</span>
                {!readOnly && (
                  <button type="button" onClick={() => toggleGroup(keys, !allOn)} className="text-[11px] font-medium text-[color:var(--theme-primary)] hover:underline">
                    {allOn ? 'Turn all off' : 'Turn all on'}
                  </button>
                )}
              </div>
              <div className="space-y-0.5">
                {keys.map((k) => (
                  <label key={k} className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${readOnly ? '' : 'cursor-pointer hover:bg-gray-50'}`}>
                    <input type="checkbox" checked={!!perms[k]} onChange={() => toggle(k)} disabled={readOnly} className="mt-0.5" />
                    <span className="text-sm text-gray-700">{catalog[k] || k}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {!isNew && !readOnly && (
        <div className="mt-4">
          <GrantsEditor role={role} catalog={catalog} onChanged={onSaved} />
        </div>
      )}

      <ModalActions>
        <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50">{readOnly ? 'Close' : 'Cancel'}</button>
        {!readOnly && (
          <PrimaryButton loading={saving} onClick={save} disabled={!name.trim()}>
            {isNew ? 'Create role' : 'Save changes'}
          </PrimaryButton>
        )}
      </ModalActions>
    </Modal>
  );
}

// ─── Assignments tab (who has which role) ────────────────────────────────────

function AssignmentsTab({ users, roles, onReload }) {
  const [savingId, setSavingId] = useState(null);
  const [rowError, setRowError] = useState({});
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (users || []).filter((u) => !ql || (u.name || '').toLowerCase().includes(ql) || (u.code || '').toLowerCase().includes(ql));
  }, [users, q]);
  const pager = usePagination(list, { initialPageSize: 10 });

  // Assign by employeeId through the canManageRoles-gated rbac endpoint (works for a
  // delegated HR-Admin); passing null clears the role back to the person's default.
  async function assign(u, businessRoleId) {
    setSavingId(u.id);
    setRowError((m) => ({ ...m, [u.id]: '' }));
    try {
      await post(`/api/hr/rbac/employees/${u.id}/assign-role`, { businessRoleId: businessRoleId || null });
      onReload?.();
    } catch (err) {
      setRowError((m) => ({ ...m, [u.id]: err.data?.message || err.message || 'Failed to assign.' }));
    } finally { setSavingId(null); }
  }

  return (
    <div>
      <p className="mb-3 flex items-center text-sm text-gray-500">
        Give each person a role. Changes take effect on their next action — no re-login.
        <InfoTip text="The role you pick here layers a person’s day-to-day permissions + data access on top of their default access. Pick ‘Default’ to remove it." />
      </p>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or employee code…" className="mb-3 w-72 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      {list.length === 0 ? (
        <Empty text="No people yet." />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-4 py-3 font-medium">Person</th>
                <th className="px-4 py-3 font-medium">Employee</th>
                <th className="px-4 py-3 font-medium">Assigned role</th>
              </tr>
            </thead>
            <tbody>
              {pager.pageItems.map((u) => (
                <tr key={u.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{u.name || u.code}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{u.code || '—'}</td>
                  <td className="px-4 py-3">
                    <select
                      value={u.businessRoleId || ''}
                      onChange={(e) => assign(u, e.target.value)}
                      disabled={savingId === u.id}
                      className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-50"
                    >
                      <option value="">— Default access</option>
                      {roles.map((r) => (<option key={r.id} value={r.id}>{r.name}{r.isSystem ? '' : ' (custom)'}</option>))}
                    </select>
                    {rowError[u.id] && <p className="mt-1 text-xs text-red-600">{rowError[u.id]}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination pager={pager} noun="people" />
    </div>
  );
}

// ─── page ────────────────────────────────────────────────────────────────────

export default function RoleManagerPage() {
  const [roles, setRoles] = useState(null);
  const [catalog, setCatalog] = useState({});
  const [users, setUsers] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [canManage, setCanManage] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('simple');
  const [editing, setEditing] = useState(undefined); // undefined=closed; null=new; {role}|{cloneFrom}
  const [assignFor, setAssignFor] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      // The people list + role-assignment now run through canManageRoles/canViewEmployees-
      // gated HR endpoints (org-tree + /rbac/employees/:id/assign-role), keyed by
      // employeeId — NOT /api/business/users (BUSINESS_ADMIN-only), which 403'd for a
      // delegated HR-Admin and left every modal empty. The org tree carries every person
      // (id=employeeId, name, code, status + their current businessRoleId), which is all
      // the assign modal + the "who has which role" tab need.
      const [r, p, tree, me] = await Promise.all([
        get('/api/hr/rbac/roles'),
        get('/api/hr/rbac/permissions'),
        get('/api/hr/rbac/org-tree').catch(() => ({ nodes: [], orphans: [] })),
        get('/api/auth/me').catch(() => null),
      ]);
      setRoles(Array.isArray(r?.items) ? r.items : (r?.roles || []));
      // permissions arrive as items:[{key,description}] → fold to {key:description}.
      const cat = {};
      for (const it of (p?.items || [])) cat[it.key] = it.description || it.key;
      setCatalog(cat);
      // People = the org tree (every node carries the employeeId + current businessRoleId).
      // Both the assign modal and the "who has which role" tab render + assign against this,
      // by employeeId — so a delegated (non-owner) HR-Admin can see + assign everyone.
      const nodes = [...(tree?.nodes || []), ...(tree?.orphans || [])];
      const people = nodes.map((n) => ({
        id: n.id,                              // employeeId — the assign-role key
        name: n.name,
        code: n.code,
        status: n.status,
        businessRoleId: n.businessRoleId || null,
      }));
      setEmployees(people);
      setUsers(people);
      const session = me?.user || me;
      if (session) setCanManage(hasPermission(permissionsFromSession(session), 'canManageRoles'));
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to load roles.');
      setRoles([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function confirmDelete() {
    try {
      await request(`/api/hr/rbac/roles/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to delete role.');
      setDeleting(null);
    }
  }

  if (roles === null) return <Spinner />;

  if (!canManage) {
    return (
      <div>
        <PageHeader title="Roles & access" subtitle="Decide what each person can see and do" />
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          You don’t have permission to manage roles. Ask an Owner or HR-Admin for the
          <span className="font-medium"> “Create/edit roles &amp; permissions”</span> permission.
        </p>
      </div>
    );
  }

  const presets = roles.filter((r) => r.isSystem);
  const customRoles = roles.filter((r) => !r.isSystem);

  return (
    <div>
      <PageHeader
        title={<span className="inline-flex items-center">Roles &amp; access<InfoTip text="A role bundles ‘what they can do’ (permissions) with ‘what they can see’ (data scope). Assign a ready-made preset, or build a custom one in Advanced." /></span>}
        subtitle="Give people the right access — simple presets for small teams, a full builder when you need it."
        actions={<Link href="/approvals" className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-50">← Approvals</Link>}
      />

      <ModuleGuide
        id="approvals-roles"
        title="Set up who can see and do what"
        what="Roles bundle permissions (what a person can do) with data scope (how much of the company they can see) and salary visibility. Assign a ready-made preset for a small team, or build a custom role when you need finer control over EPF/payroll, leave and approvals access."
        steps={[
          "Stay on ‘Simple — presets’ to use the five built-ins: Owner, HR-Admin, Manager, Finance and Employee.",
          "On a preset card, click ‘Assign to a person’, search by name or employee code, and assign — it takes effect on their next action, no re-login.",
          "Need something custom? Click ‘Make a custom copy’ (or open Advanced → New custom role) to clone a preset.",
          "In the builder, set the role name, ‘What can they see?’ (scope), salary visibility, then tick exactly the permissions under People / Time & Leave / Pay & Payroll.",
          "Use ‘Who has which role’ to review every person’s assigned role and change or clear it.",
        ]}
        example={<>For Acme India Pvt Ltd, give <b>Aarav Sharma</b> (Mumbai payroll lead) the <b>Finance</b> preset so he can run and approve the June 2026 payroll, file <b>24Q</b> TDS returns and see exact salary figures (₹12,00,000 CTC). His manager <b>Priya Nair</b> gets the <b>Manager</b> preset — scoped to ‘Their team’, with pay bands only, so she approves her reports’ leave without seeing exact pay.</>}
        tips={[
          "Presets can’t be edited directly — clone to a custom copy so a stray click never breaks the built-in Owner/HR/Finance setups.",
          "Set salary visibility to the least each role needs: ‘Pay bands only’ for managers, ‘Exact figures’ only for Finance/Owner.",
          "Use a temporary scoped grant (in Advanced) for cover, e.g. ‘acting Finance approver for Mumbai until 31 Aug 2026’ — it expires on its own.",
        ]}
      />

      {error && <ErrorBanner message={error} />}

      <Tabs
        tabs={[
          { key: 'simple', label: 'Simple — presets' },
          { key: 'advanced', label: 'Advanced — custom roles' },
          { key: 'assign', label: 'Who has which role' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'simple' && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {presets.length === 0 ? (
            <Empty text="No preset roles found." />
          ) : (
            presets.map((role) => (
              <PresetCard
                key={role.id}
                role={role}
                catalog={catalog}
                onAssign={() => setAssignFor(role)}
                onClone={() => { setTab('advanced'); setEditing({ cloneFrom: role }); }}
              />
            ))
          )}
        </div>
      )}

      {tab === 'advanced' && (
        <div>
          <div className="mb-4 flex items-center justify-between">
            <p className="flex items-center text-sm text-gray-500">
              Custom roles you’ve built. Clone a preset to start, then fine-tune.
              <InfoTip text="Custom roles are fully editable. Presets are clone-to-edit so a stray click can never break the built-in Owner/HR/Manager/Finance setups." />
            </p>
            <PrimaryButton onClick={() => setEditing({ cloneFrom: presets.find((p) => p.name === 'Employee') || presets[0] || null })}>
              New custom role
            </PrimaryButton>
          </div>
          {customRoles.length === 0 ? (
            <Empty text="No custom roles yet. Clone a preset to make one." />
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs uppercase tracking-wide text-gray-500">
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Sees</th>
                    <th className="px-4 py-3 font-medium">Can do</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {customRoles.map((role) => (
                    <tr key={role.id} className="border-b border-gray-50 last:border-0 align-top hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{role.name}</td>
                      <td className="px-4 py-3"><span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">{scopeWords(role.defaultScope)}</span></td>
                      <td className="px-4 py-3 text-gray-600">{grantedKeys(role).length} permission{grantedKeys(role).length === 1 ? '' : 's'}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <button type="button" onClick={() => setEditing({ role })} className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50">Edit</button>
                        <button type="button" onClick={() => setDeleting(role)} className="ml-2 rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50">Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'assign' && <AssignmentsTab users={users} roles={roles} onReload={load} />}

      {assignFor && (
        <AssignModal
          role={assignFor}
          users={users}
          employees={employees}
          onClose={() => { setAssignFor(null); load(); }}
          onAssigned={() => load()}
        />
      )}

      {editing !== undefined && (
        <RoleBuilder
          catalog={catalog}
          role={editing?.role || null}
          cloneFrom={editing?.cloneFrom || null}
          onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); load(); }}
        />
      )}

      {deleting && (
        <Modal title={`Delete “${deleting.name}”?`} onClose={() => setDeleting(null)}>
          <p className="mb-5 text-sm text-gray-600">
            This role will be removed. Anyone using it falls back to their default access. Reassign them first if they need to keep elevated access.
          </p>
          <ModalActions>
            <button type="button" onClick={() => setDeleting(null)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={confirmDelete} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">Delete role</button>
          </ModalActions>
        </Modal>
      )}
    </div>
  );
}
