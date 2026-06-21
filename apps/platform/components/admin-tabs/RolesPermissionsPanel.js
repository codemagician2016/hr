'use client';

// ECOMMERCE Path B Phase 5 (2026-05-01) — real RolesPermissionsPanel.
// Backend: /api/ecom/roles + /api/ecom/permissions.

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  KpiCard, KpiGrid,
  StatusBadge,
  PageHeader, ErrorBanner, PrimaryButton, SecondaryButton,
  fmtNumber,
} from '@/components/ecom-ui';

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `${res.status}`);
  return body;
}

const AREA_LABELS = {
  orders:    'Orders & fulfilment',
  catalogue: 'Catalogue',
  inventory: 'Inventory',
  customers: 'Customers',
  finance:   'Finance',
  system:    'System',
};

export default function RolesPermissionsPanel() {
  const [roles, setRoles] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [locations, setLocations] = useState([]);
  const [systemPresets, setSystemPresets] = useState({});
  const [selectedRoleId, setSelectedRoleId] = useState(null);
  const [pendingGrants, setPendingGrants] = useState(null); // null = no edits
  const [pendingLocationScope, setPendingLocationScope] = useState(null); // null = no edits
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [newRolePreset, setNewRolePreset] = useState('Manager');

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [data, locData] = await Promise.all([
        api('/api/ecom/roles'),
        api('/api/locations').catch(() => ({ locations: [] })),
      ]);
      setRoles(data.rows || []);
      setCatalog(data.catalog || []);
      setLocations(locData.locations || []);
      setSystemPresets(data.systemRolePresets || {});
      setSelectedRoleId((prev) => prev || (data.rows[0]?.id || null));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const selectedRole = roles.find((r) => r.id === selectedRoleId) || null;
  const baseGrants = useMemo(() => new Set(selectedRole?.grantedKeys || []), [selectedRole]);
  const baseLocationScope = useMemo(() => {
    const grants = selectedRole?.grants || [];
    const scoped = Array.from(new Set(grants.map((g) => g.locationId || '').filter(Boolean)));
    return scoped.length === 1 ? scoped[0] : '';
  }, [selectedRole]);
  const currentGrants = pendingGrants ?? baseGrants;
  const currentLocationScope = pendingLocationScope !== null ? pendingLocationScope : baseLocationScope;
  const isDirty = pendingGrants !== null || pendingLocationScope !== null;

  function togglePermission(key) {
    const next = new Set(pendingGrants ?? baseGrants);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPendingGrants(next);
  }

  function discard() {
    setPendingGrants(null);
    setPendingLocationScope(null);
  }

  async function save() {
    if (!selectedRole || !isDirty) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/ecom/roles/${selectedRole.id}/grants`, {
        method: 'PUT',
        body: JSON.stringify({
          permissionKeys: Array.from(currentGrants),
          locationId: currentLocationScope || null,
        }),
      });
      setPendingGrants(null);
      setPendingLocationScope(null);
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function createRole(e) {
    e.preventDefault();
    if (!newRoleName.trim()) return;
    setBusy(true);
    setError('');
    try {
      const created = await api('/api/ecom/roles', {
        method: 'POST',
        body: JSON.stringify({ name: newRoleName.trim(), basePreset: newRolePreset }),
      });
      setNewRoleName('');
      setCreating(false);
      await reload();
      setSelectedRoleId(created.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteRole() {
    if (!selectedRole || selectedRole.isSystem) return;
    if (selectedRole.memberCount > 0) {
      setError(`Role has ${selectedRole.memberCount} member(s). Reassign before deleting.`);
      return;
    }
    if (!window.confirm(`Delete role "${selectedRole.name}"?`)) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/ecom/roles/${selectedRole.id}`, { method: 'DELETE' });
      setSelectedRoleId(null);
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Group catalog by area for the matrix UI
  const byArea = useMemo(() => {
    const out = {};
    for (const p of catalog) {
      if (!out[p.area]) out[p.area] = [];
      out[p.area].push(p);
    }
    Object.values(out).forEach((arr) => arr.sort((a, b) => a.weight - b.weight));
    return out;
  }, [catalog]);

  // Bulk grant/revoke for an area — saves the seller from clicking 6 boxes
  // when they want "everyone with finance access can do everything in
  // finance."
  function toggleArea(area, grant) {
    const next = new Set(pendingGrants ?? baseGrants);
    for (const p of (byArea[area] || [])) {
      if (grant) next.add(p.key); else next.delete(p.key);
    }
    setPendingGrants(next);
  }

  function changeLocationScope(value) {
    setPendingLocationScope(value || '');
  }

  async function duplicateRole() {
    if (!selectedRole) return;
    const name = window.prompt('New role name:', `${selectedRole.name} (copy)`);
    if (!name?.trim()) return;
    setBusy(true); setError('');
    try {
      // Create with the same preset, then explicitly set grants to the
      // current role's grant set so it's a faithful clone.
      const created = await api('/api/ecom/roles', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), basePreset: 'Manager' }),
      });
      await api(`/api/ecom/roles/${created.id}/grants`, {
        method: 'PUT',
        body: JSON.stringify({
          permissionKeys: selectedRole.grantedKeys || [],
          locationId: baseLocationScope || null,
        }),
      });
      await reload();
      setSelectedRoleId(created.id);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const grantsAsSet = currentGrants instanceof Set ? currentGrants : new Set(currentGrants);
  const totalPerms = catalog.length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Roles & permissions"
        subtitle={`${roles.length} role${roles.length === 1 ? '' : 's'} · ${catalog.length} permissions across ${Object.keys(byArea).length} areas`}
        actions={<PrimaryButton onClick={() => setCreating((v) => !v)}>+ New role</PrimaryButton>}
      />

      {creating && (
        <form onSubmit={createRole}
          className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-gray-700 mb-1">Role name</label>
            <input type="text" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)}
              autoFocus required maxLength={80}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Start from preset</label>
            <select value={newRolePreset} onChange={(e) => setNewRolePreset(e.target.value)}
              className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500">
              {Object.keys(systemPresets).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <button type="submit" disabled={busy}
            className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? 'Creating…' : 'Create'}
          </button>
          <button type="button" onClick={() => setCreating(false)}
            className="px-3 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700">Cancel</button>
        </form>
      )}

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {loading && roles.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-sm text-gray-500">Loading…</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          {/* Role list */}
          <aside className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <p className="text-[10px] font-mono tracking-[0.2em] uppercase text-gray-500">Roles</p>
            </div>
            <ul className="divide-y divide-gray-100">
              {roles.map((r) => {
                const granted = r.grantedKeys?.length || 0;
                const pct = totalPerms > 0 ? Math.round((granted / totalPerms) * 100) : 0;
                const barTone = granted === totalPerms ? 'bg-emerald-500' : granted >= totalPerms * 0.6 ? 'bg-indigo-500' : 'bg-gray-400';
                return (
                  <li key={r.id}>
                    <button type="button" onClick={() => { setSelectedRoleId(r.id); setPendingGrants(null); setPendingLocationScope(null); }}
                      className={`w-full text-left px-4 py-3 transition-colors ${selectedRoleId === r.id ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-gray-900">{r.name}</span>
                        {r.isSystem && <StatusBadge tone="neutral">system</StatusBadge>}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {r.memberCount} {r.memberCount === 1 ? 'member' : 'members'}
                      </p>
                      {Array.from(new Set((r.grants || []).map((g) => g.locationId).filter(Boolean))).length === 1 && (
                        <p className="text-[11px] text-indigo-700 mt-0.5">
                          Store scoped
                        </p>
                      )}
                      <div className="mt-1.5">
                        <div className="flex items-center justify-between text-[10px] mb-0.5">
                          <span className="font-mono text-gray-500">{granted}/{totalPerms} perms</span>
                          <span className="font-semibold text-gray-500">{pct}%</span>
                        </div>
                        <div className="h-1 rounded-full bg-gray-100 overflow-hidden">
                          <div className={`h-full ${barTone}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          {/* Matrix */}
          <div className="lg:col-span-3 bg-white rounded-2xl border border-gray-200 overflow-hidden">
            {!selectedRole ? (
              <div className="p-12 text-center text-sm text-gray-500">Select a role to edit permissions.</div>
            ) : (
              <>
                <div className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-base font-semibold text-gray-900">{selectedRole.name}</h3>
                      {selectedRole.isSystem && <StatusBadge tone="neutral">system preset</StatusBadge>}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {selectedRole.memberCount} member{selectedRole.memberCount === 1 ? '' : 's'} · <strong className="text-gray-900 tabular-nums">{grantsAsSet.size}/{totalPerms}</strong> permissions granted
                      {currentLocationScope && (
                        <span className="ml-2 text-indigo-700 font-semibold">
                          Store: {locations.find((l) => l.id === currentLocationScope)?.name || 'Selected store'}
                        </span>
                      )}
                      {isDirty && <span className="text-amber-700 font-semibold ml-2">UNSAVED CHANGES</span>}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {isDirty && (
                      <>
                        <SecondaryButton type="button" onClick={discard} disabled={busy}>Discard</SecondaryButton>
                        <PrimaryButton type="button" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</PrimaryButton>
                      </>
                    )}
                    {!isDirty && (
                      <SecondaryButton type="button" onClick={duplicateRole} disabled={busy}>Duplicate role</SecondaryButton>
                    )}
                    {!selectedRole.isSystem && !isDirty && (
                      <button type="button" onClick={deleteRole}
                        className="text-xs font-semibold text-red-700 hover:underline px-3 py-1.5">Delete role</button>
                    )}
                  </div>
                </div>

                <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/70">
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Location scope</label>
                  <select value={currentLocationScope} onChange={(e) => changeLocationScope(e.target.value)}
                    disabled={selectedRole.isSystem}
                    className="w-full sm:w-80 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-60">
                    <option value="">All locations</option>
                    {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Store-scoped roles can only use location-filtered operations for that store. All-location dashboards require tenant-wide permissions.
                  </p>
                </div>

                <div className="divide-y divide-gray-100">
                  {Object.keys(byArea).sort().map((area) => {
                    const areaPerms = byArea[area];
                    const grantedInArea = areaPerms.filter((p) => grantsAsSet.has(p.key)).length;
                    const allGranted = grantedInArea === areaPerms.length;
                    const noneGranted = grantedInArea === 0;
                    return (
                      <div key={area} className="px-6 py-4">
                        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                          <div className="flex items-center gap-2">
                            <p className="text-[10px] font-mono tracking-[0.2em] uppercase text-gray-500">
                              {AREA_LABELS[area] || area}
                            </p>
                            <span className={`text-[11px] font-mono px-1.5 py-0.5 rounded ${
                              allGranted ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : noneGranted ? 'bg-gray-50 text-gray-500 border border-gray-200'
                              : 'bg-amber-50 text-amber-700 border border-amber-200'
                            }`}>
                              {grantedInArea}/{areaPerms.length}
                            </span>
                          </div>
                          {!selectedRole.isSystem && (
                            <div className="flex gap-1">
                              <button type="button" onClick={() => toggleArea(area, true)} disabled={allGranted}
                                className="text-[11px] font-mono uppercase tracking-wider text-emerald-700 hover:text-emerald-900 disabled:opacity-30 hover:underline">
                                Grant all
                              </button>
                              <span className="text-gray-300">·</span>
                              <button type="button" onClick={() => toggleArea(area, false)} disabled={noneGranted}
                                className="text-[11px] font-mono uppercase tracking-wider text-gray-500 hover:text-red-700 disabled:opacity-30 hover:underline">
                                Revoke all
                              </button>
                            </div>
                          )}
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          {areaPerms.map((p) => {
                            const isGranted = grantsAsSet.has(p.key);
                            const disabled = selectedRole.isSystem;
                            return (
                              <label key={p.key}
                                className={`flex items-start gap-2 p-2 rounded-lg border ${
                                  isGranted ? 'border-indigo-200 bg-indigo-50/40' : 'border-transparent'
                                } ${disabled ? 'opacity-60' : 'hover:bg-gray-50 cursor-pointer'}`}>
                                <input type="checkbox" checked={isGranted}
                                  disabled={disabled}
                                  onChange={() => togglePermission(p.key)}
                                  className="mt-0.5 rounded text-indigo-600 focus:ring-indigo-500 disabled:opacity-50" />
                                <div className="min-w-0">
                                  <p className="text-sm font-semibold text-gray-900">{p.label}</p>
                                  <p className="text-xs text-gray-500 font-mono">{p.key}</p>
                                  {p.description && <p className="text-xs text-gray-600 mt-0.5">{p.description}</p>}
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
