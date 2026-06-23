'use client';

// My Team — Manager Self-Service (Feature 13). A manager runs their team from ESS
// without the operator console: Roster (photo|name|position|today's status),
// Attendance (today's board), Approvals (merged leave + reimbursement inbox, decide
// inline), Directory (search, contact cards, comp masked), Org (the reporting tree
// rooted at the manager). All data is scoped SERVER-SIDE to the manager's reporting
// sub-tree (/api/hr/me/team/*); a non-manager simply sees empty tabs.

import { useState } from 'react';
import AppShell from '@/components/AppShell';
import { Spinner, Centered, ErrorBanner, Empty } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { apiPost } from '@/lib/api';
import { formatDate } from '@/lib/format';
import OrgTree from '@/components/OrgTree';

const TABS = [
  { key: 'roster', label: 'Roster' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'directory', label: 'Directory' },
  { key: 'org', label: 'Org' },
];

function Avatar({ name, url }) {
  const initials = String(name || '?').trim().split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-bold" style={{ background: 'var(--theme-primary-soft)', color: 'var(--theme-primary)' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : initials}
    </div>
  );
}

const STATUS_COLOR = {
  PRESENT: '#16a34a', WORK_FROM_HOME: '#0ea5e9', ON_DUTY: '#0ea5e9',
  ON_LEAVE: '#d97706', ABSENT: '#dc2626', HALF_DAY: '#d97706', WEEKLY_OFF: '#6b7280', HOLIDAY: '#6b7280', MISSING_PUNCH: '#dc2626',
};

function RosterTab() {
  const { data, loading, error } = useApi('/api/hr/me/team/roster');
  if (loading) return <Centered><Spinner /></Centered>;
  if (error) return <ErrorBanner message={error.message} />;
  const items = data?.items || [];
  if (!items.length) return <Empty text="You don't have any reports yet." />;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((e) => (
        <div key={e.id} className="flex items-center gap-3 rounded-2xl border bg-white p-3 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
          <Avatar name={e.name} url={e.photoUrl} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>{e.name}</div>
            <div className="truncate text-xs" style={{ color: 'var(--theme-muted)' }}>{e.designation || '—'}{e.department ? ` · ${e.department}` : ''}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px]">
              <span style={{ color: STATUS_COLOR[e.status] || 'var(--theme-muted)' }}>{e.status}</span>
              {e.isDirectReport && <span style={{ color: 'var(--theme-muted)' }}>· direct report</span>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function AttendanceTab() {
  const [date] = useState(() => new Date().toISOString().slice(0, 10));
  const { data, loading, error } = useApi(`/api/hr/me/team/attendance?date=${date}`);
  if (loading) return <Centered><Spinner /></Centered>;
  if (error) return <ErrorBanner message={error.message} />;
  const items = data?.items || [];
  if (!items.length) return <Empty text="No attendance recorded for your team today." />;
  return (
    <div className="overflow-hidden rounded-2xl border bg-white shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      <table className="w-full text-sm">
        <thead><tr className="text-left" style={{ color: 'var(--theme-muted)' }}><th className="px-4 py-2">Employee</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">In</th><th className="px-4 py-2">Out</th></tr></thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.employeeId} className="border-t" style={{ borderColor: 'var(--theme-border)' }}>
              <td className="px-4 py-2 font-medium" style={{ color: 'var(--theme-text)' }}>{a.name}</td>
              <td className="px-4 py-2"><span style={{ color: STATUS_COLOR[a.status] || 'var(--theme-muted)' }}>{a.status}</span></td>
              <td className="px-4 py-2" style={{ color: 'var(--theme-muted)' }}>{a.firstIn ? new Date(a.firstIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
              <td className="px-4 py-2" style={{ color: 'var(--theme-muted)' }}>{a.lastOut ? new Date(a.lastOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApprovalsTab() {
  const { data, loading, error, reload } = useApi('/api/hr/me/team/approvals');
  const [busyId, setBusyId] = useState(null);
  if (loading) return <Centered><Spinner /></Centered>;
  if (error) return <ErrorBanner message={error.message} />;
  const leave = data?.leave || [];
  const reimb = data?.reimbursements || [];
  if (!leave.length && !reimb.length) return <Empty text="Nothing awaiting your decision. Nice — your team is all caught up." />;

  async function decide(kind, id, decision) {
    setBusyId(id);
    try { await apiPost(`/api/hr/me/team/${kind}/${id}/decide`, { decision }); await reload(); }
    catch (e) { alert(e.message || 'Could not record decision'); }
    finally { setBusyId(null); }
  }
  function Row({ id, kind, title, sub }) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border bg-white p-3 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <div className="min-w-0"><div className="truncate text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>{title}</div><div className="truncate text-xs" style={{ color: 'var(--theme-muted)' }}>{sub}</div></div>
        <div className="flex shrink-0 gap-2">
          <button disabled={busyId === id} onClick={() => decide(kind, id, 'approve')} className="rounded px-3 py-1 text-xs font-semibold text-white" style={{ background: '#16a34a' }}>Approve</button>
          <button disabled={busyId === id} onClick={() => decide(kind, id, 'decline')} className="rounded border px-3 py-1 text-xs font-semibold" style={{ borderColor: '#dc2626', color: '#dc2626' }}>Decline</button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {leave.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>Leave requests</h3>
          {leave.map((l) => <Row key={l.id} id={l.id} kind="leave" title={`${l.name} · ${l.leaveType || 'Leave'}`} sub={`${formatDate(l.startDate)} → ${formatDate(l.endDate)} · ${l.days} day(s)`} />)}
        </div>
      )}
      {reimb.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>Reimbursements</h3>
          {reimb.map((r) => <Row key={r.id} id={r.id} kind="reimbursements" title={`${r.name} · ${r.currencyCode} ${r.amount}`} sub={r.description || 'Expense claim'} />)}
        </div>
      )}
    </div>
  );
}

function DirectoryTab() {
  const [q, setQ] = useState('');
  const { data, loading, error } = useApi(`/api/hr/me/team/directory${q ? `?q=${encodeURIComponent(q)}` : ''}`, { deps: [q] });
  return (
    <div className="space-y-3">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your team…" className="w-full rounded-lg border px-3 py-2 text-sm sm:max-w-xs" style={{ borderColor: 'var(--theme-border)' }} />
      {loading ? <Centered><Spinner /></Centered> : error ? <ErrorBanner message={error.message} /> : (
        (data?.items || []).length === 0 ? <Empty text="No one matches." /> : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.items.map((e) => (
              <div key={e.id} className="flex items-center gap-3 rounded-2xl border bg-white p-3 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
                <Avatar name={e.name} url={e.photoUrl} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>{e.name}</div>
                  <div className="truncate text-xs" style={{ color: 'var(--theme-muted)' }}>{e.designation || '—'}{e.department ? ` · ${e.department}` : ''}</div>
                  <div className="truncate text-xs" style={{ color: 'var(--theme-muted)' }}>{e.email || ''}{e.phone ? ` · ${e.phone}` : ''}</div>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function OrgTab() {
  const { data, loading, error } = useApi('/api/hr/me/team/org?root=me');
  if (loading) return <Centered><Spinner /></Centered>;
  if (error) return <ErrorBanner message={error.message} />;
  return <OrgTree nodes={data?.items || []} />;
}

function TeamInner() {
  const [tab, setTab] = useState('roster');
  // Show the "My Team" page even to non-managers; the tabs just render empty.
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>My Team</h1>
        <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>Everyone who reports to you — run the daily loop without leaving your portal.</p>
      </div>
      <div className="flex gap-1 overflow-x-auto border-b" style={{ borderColor: 'var(--theme-border)' }}>
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} aria-current={tab === t.key ? 'page' : undefined}
                  className="whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium"
                  style={tab === t.key ? { borderColor: 'var(--theme-primary)', color: 'var(--theme-primary)' } : { borderColor: 'transparent', color: 'var(--theme-muted)' }}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'roster' && <RosterTab />}
      {tab === 'attendance' && <AttendanceTab />}
      {tab === 'approvals' && <ApprovalsTab />}
      {tab === 'directory' && <DirectoryTab />}
      {tab === 'org' && <OrgTab />}
    </div>
  );
}

export default function TeamPage() {
  return <AppShell><TeamInner /></AppShell>;
}
