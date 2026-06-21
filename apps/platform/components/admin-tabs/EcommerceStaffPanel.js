'use client';

// ECOMMERCE Path B Phase 5 (2026-05-01) — real EcommerceStaffPanel.
// Backend: existing /api/business/staff (no new controller needed) +
// /api/ecom/roles for role assignment context.

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  KpiCard, KpiGrid,
  StatusBadge,
  PageHeader, EmptyState, ErrorBanner, PrimaryButton, SecondaryButton,
  fmtNumber, timeAgo as fmtTimeAgo,
} from '@/components/ecom-ui';

function getInitials(name) {
  if (!name) return '?';
  return name.split(/\s+/).map((w) => w[0] || '').slice(0, 2).join('').toUpperCase();
}

// Stable color tints based on name hash so each staff member's avatar
// is consistent + visually distinct.
function avatarTint(name) {
  if (!name) return 'bg-gray-500';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const tints = ['bg-emerald-500', 'bg-blue-500', 'bg-indigo-500', 'bg-purple-500', 'bg-pink-500', 'bg-amber-500', 'bg-teal-500'];
  return tints[Math.abs(h) % tints.length];
}

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

function staffAssignableRoles(roles) {
  return roles.filter((role) => role.name !== 'Owner');
}

function InviteForm({ roles, onCancel, onSaved }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const assignableRoles = staffAssignableRoles(roles);
  const managerRole = assignableRoles.find((role) => role.name === 'Manager');
  const [businessRoleId, setBusinessRoleId] = useState(managerRole?.id || assignableRoles[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!businessRoleId && assignableRoles.length > 0) {
      setBusinessRoleId(managerRole?.id || assignableRoles[0].id);
    }
  }, [assignableRoles, businessRoleId, managerRole]);

  async function submit(e) {
    e.preventDefault();
    if (!email.trim() || !name.trim()) { setError('Name and email are required'); return; }
    setBusy(true); setError('');
    try {
      await api('/api/business/staff', {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          name: name.trim(),
          businessRoleId: businessRoleId || undefined,
        }),
      });
      onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Full name *</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus
          className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Email *</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500" />
        <p className="text-[10px] text-gray-500 mt-1">Invitation will be emailed with a sign-in link.</p>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Operational role *</label>
        <select
          value={businessRoleId}
          onChange={(e) => setBusinessRoleId(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500 bg-white"
        >
          {assignableRoles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name} · {role.grantedKeys?.length || 0} permissions
            </option>
          ))}
        </select>
        <p className="text-[10px] text-gray-500 mt-1">Controls what this staff member can see and operate after login.</p>
      </div>
      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} disabled={busy}
          className="px-4 py-2 text-sm font-semibold rounded-lg border border-gray-300 text-gray-700">Cancel</button>
        <button type="submit" disabled={busy}
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
          {busy ? 'Sending…' : 'Send invite'}
        </button>
      </div>
    </form>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-gray-200 shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 mb-4">
          <h3 className="text-lg font-bold text-gray-900">{title}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function EcommerceStaffPanel() {
  const [staff, setStaff] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [inviting, setInviting] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [staffRes, rolesRes] = await Promise.all([
        api('/api/business/staff'),
        api('/api/ecom/roles').catch(() => ({ rows: [] })), // tolerate failure if RBAC isn't seeded yet
      ]);
      setStaff(staffRes.staff || []);
      setRoles(rolesRes.rows || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function remove(member) {
    if (member.role === 'BUSINESS_ADMIN') return;
    if (!window.confirm(`Remove ${member.name} from the team?`)) return;
    try {
      await api(`/api/business/staff/${member.id}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      setError(err.message);
    }
  }

  async function changeRole(member, businessRoleId) {
    if (member.role === 'BUSINESS_ADMIN') return;
    try {
      await api(`/api/business/staff/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ businessRoleId }),
      });
      reload();
    } catch (err) {
      setError(err.message);
    }
  }

  const stats = useMemo(() => {
    const active = staff.filter((s) => s.isActive !== false).length;
    const owners = staff.filter((s) => s.role === 'BUSINESS_ADMIN').length;
    const twoFAEnabled = staff.filter((s) => s.twoFactorEnabled).length;
    return {
      total: staff.length,
      active, owners,
      regular: staff.length - owners,
      twoFAEnabled,
    };
  }, [staff]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Staff"
        subtitle={`${stats.total} ${stats.total === 1 ? 'member' : 'members'} · ${stats.owners} owner${stats.owners === 1 ? '' : 's'} · ${roles.length} role${roles.length === 1 ? '' : 's'} defined`}
        actions={<PrimaryButton onClick={() => setInviting(true)}>+ Invite staff</PrimaryButton>}
      />

      <KpiGrid cols={4}>
        <KpiCard label="Total members" value={fmtNumber(stats.total)} />
        <KpiCard label="Active" value={fmtNumber(stats.active)} tone="success" hint="Currently on the team" />
        <KpiCard label="Owners" value={fmtNumber(stats.owners)} hint="Full admin access" />
        <KpiCard label="2FA enabled"
          value={fmtNumber(stats.twoFAEnabled)}
          tone={stats.total > 0 && stats.twoFAEnabled === stats.total ? 'success' : stats.total > 0 && stats.twoFAEnabled === 0 ? 'warning' : null}
          hint={stats.total > 0 ? `${Math.round((stats.twoFAEnabled / stats.total) * 100)}% coverage` : 'No data'} />
      </KpiGrid>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        {loading && staff.length === 0 ? (
          <div className="p-12 text-center text-sm text-gray-500">Loading…</div>
        ) : staff.length === 0 ? (
          <EmptyState
            title="No team members yet"
            message="Invite warehouse pickers, delivery riders, customer-support agents, and store managers. Each gets their own login and inherits the role you assign."
            action={<PrimaryButton onClick={() => setInviting(true)}>+ Invite first member</PrimaryButton>}
          />
        ) : (
          <div className="divide-y divide-gray-100">
            {staff.map((m) => {
              const isOwner = m.role === 'BUSINESS_ADMIN';
              const assignableRoles = staffAssignableRoles(roles);
              const lastLogin = m.lastLoginAt ? new Date(m.lastLoginAt) : null;
              const lastLoginDays = lastLogin ? (Date.now() - lastLogin.getTime()) / 86400000 : null;
              const lastLoginStale = lastLoginDays !== null && lastLoginDays > 30;
              return (
                <div key={m.id} className="px-5 py-4 flex items-center gap-4 hover:bg-gray-50/60 transition-colors">
                  <span className={`w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0 ${avatarTint(m.name)}`}>
                    {getInitials(m.name)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-gray-900 truncate">{m.name}</p>
                      {isOwner ? <StatusBadge tone="success">owner</StatusBadge> : <StatusBadge tone="neutral">staff</StatusBadge>}
                      {m.twoFactorEnabled
                        ? <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                            🔒 2FA on
                          </span>
                        : <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                            ⚠ 2FA off
                          </span>
                      }
                      {m.isActive === false && <StatusBadge tone="neutral">inactive</StatusBadge>}
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5 font-mono truncate">{m.email}</p>
                    <div className="flex items-center gap-3 text-[11px] text-gray-500 mt-1 flex-wrap">
                      <span>Joined {m.createdAt ? new Date(m.createdAt).toLocaleDateString('en-GB') : '—'}</span>
                      {lastLogin && (
                        <>
                          <span className="text-gray-300">·</span>
                          <span className={lastLoginStale ? 'text-amber-700' : ''}>
                            Last login {fmtTimeAgo ? fmtTimeAgo(m.lastLoginAt) : lastLogin.toLocaleDateString('en-GB')}
                            {lastLoginStale && ' (stale)'}
                          </span>
                        </>
                      )}
                      {!lastLogin && (
                        <>
                          <span className="text-gray-300">·</span>
                          <span className="text-gray-400">Never logged in — invite pending</span>
                        </>
                      )}
                    </div>
                  </div>
                  {!isOwner && (
                    <div className="flex items-center gap-3 shrink-0">
                      <select
                        value={m.businessRoleId || ''}
                        onChange={(e) => changeRole(m, e.target.value)}
                        className="px-3 py-2 rounded-lg border border-gray-200 bg-white text-xs font-semibold text-gray-700"
                        aria-label={`Role for ${m.name}`}
                      >
                        <option value="" disabled>No role</option>
                        {assignableRoles.map((role) => (
                          <option key={role.id} value={role.id}>{role.name}</option>
                        ))}
                      </select>
                      <button type="button" onClick={() => remove(m)}
                        className="text-xs font-semibold text-gray-500 hover:text-red-700 hover:underline">Remove</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Reminder about Roles panel for assigning permissions */}
      {roles.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 text-sm text-blue-800">
          <p className="font-semibold mb-1">Assign granular permissions in <a href="?tab=roles" className="underline">Roles &amp; permissions</a></p>
          <p className="text-xs">
            Pick a role on each staff row. For fine-grained control over what each person can do
            (for example refunds, stock adjustments, price edits, delivery operations), tune the role in the Roles panel.
          </p>
        </div>
      )}

      {inviting && (
        <Modal title="Invite a new team member" onClose={() => setInviting(false)}>
          <InviteForm roles={roles} onCancel={() => setInviting(false)} onSaved={() => { setInviting(false); reload(); }} />
        </Modal>
      )}
    </div>
  );
}
