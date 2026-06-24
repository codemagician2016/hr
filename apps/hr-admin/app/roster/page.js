'use client';

// Roster console (Feature 29 — shift management) against /api/hr/attendance/roster|rotations|swaps.
//
// Tabs:
//  - Grid:      GET /roster/grid?from&to (keyset-paginated BY EMPLOYEE). Rows = employees,
//               columns = days. Each cell = a colour-coded shift code (M/A/N/OFF) with a
//               tooltip (start–end, break, Night shift, source). Click a cell → set a shift
//               or OFF (PUT /roster/cell, writes a MANUAL DRAFT). Bulk publish a window.
//  - Rotations: GET/POST/PATCH/DELETE /rotations + POST /rotations/:id/apply (generate DRAFT
//               rows for the in-scope population/window → { written, violations }).
//  - Swaps:     GET /swaps queue; POST /swaps/:id/approve|reject (F10 SHIFT_SWAP decision).
//
// All reads/writes are cookie-authed and tenant- + F1-scoped server-side. DRAFT rows are
// hidden from derive/pay until Publish (the muster "exhibit").

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner, ErrorBanner, PrimaryButton } from '@hr/ui';
import { get, post, put } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton, employeeLabel } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';

const TABS = [
  { key: 'grid', label: 'Roster grid' },
  { key: 'rotations', label: 'Rotations' },
  { key: 'swaps', label: 'Swaps' },
];

function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function eachDayISO(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDaysISO(d, 1)) out.push(d);
  return out;
}
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); } catch { return String(d).slice(0, 10); }
}

// A short shift code + colour for a cell. Night = amber, OFF = grey, work = blue.
function cellChip(cell) {
  if (!cell) return { label: '·', title: 'No roster cell (falls back to assignment/default)', color: '#e5e7eb', fg: '#6b7280' };
  if (cell.dayType === 'OFF') return { label: 'OFF', title: `Weekly off (${cell.source})`, color: '#f3f4f6', fg: '#6b7280' };
  const s = cell.shift || {};
  const night = s.isNightShift;
  const code = (s.code || '?').slice(0, 3).toUpperCase();
  const title = `${s.name || s.code || 'Shift'} ${s.startTime || ''}–${s.endTime || ''}${s.breakMinutes != null ? ` · break ${s.breakMinutes}m` : ''}${night ? ' · Night shift' : ''} · ${cell.source}${cell.status === 'DRAFT' ? ' · DRAFT' : ''}`;
  return { label: code, title, color: night ? '#fef3c7' : '#dbeafe', fg: night ? '#92400e' : '#1e40af' };
}

export default function RosterPage() {
  const [tab, setTab] = useState('grid');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [canManage, setCanManage] = useState(false);

  useEffect(() => {
    get('/api/auth/me')
      .then((me) => { const session = me?.user || me; setCanManage(hasPermission(permissionsFromSession(session), 'canManageAttendance')); })
      .catch(() => setCanManage(false));
  }, []);

  // ── Grid ──
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(addDaysISO(todayISO(), 13)); // a fortnight
  const [nodes, setNodes] = useState([]);
  const [gridLoading, setGridLoading] = useState(false);
  const [shifts, setShifts] = useState([]);
  const days = useMemo(() => eachDayISO(from, to), [from, to]);

  const loadShifts = useCallback(() => {
    get('/api/hr/attendance/shifts').then((res) => setShifts(asList(res) || [])).catch(() => {});
  }, []);
  const loadGrid = useCallback(() => {
    setGridLoading(true); setError('');
    get('/api/hr/attendance/roster/grid', { from, to, limit: 50 })
      .then((res) => setNodes((res && res.nodes) || []))
      .catch((e) => setError(e.message))
      .finally(() => setGridLoading(false));
  }, [from, to]);
  useEffect(() => { if (tab === 'grid') { loadShifts(); loadGrid(); } }, [tab, loadGrid, loadShifts]);

  const cellMap = useMemo(() => {
    const m = new Map();
    for (const n of nodes) for (const c of n.cells || []) m.set(`${n.employee.id}|${c.date}`, c);
    return m;
  }, [nodes]);

  async function setCell(employeeId, date, value) {
    setError(''); setNotice('');
    try {
      const body = value === 'OFF'
        ? { employeeId, date, dayType: 'OFF' }
        : { employeeId, date, dayType: 'WORK', shiftPatternId: value };
      await put('/api/hr/attendance/roster/cell', body);
      setNotice('Cell saved (DRAFT).');
      loadGrid();
    } catch (e) { setError(e.message); }
  }
  async function publishWindow() {
    setError(''); setNotice('');
    try {
      const res = await post(`/api/hr/attendance/roster/publish?from=${from}&to=${to}`, {});
      setNotice(`Published ${res.published || 0} cell(s).`);
      loadGrid();
    } catch (e) { setError(e.message); }
  }

  // ── Rotations ──
  const [rotations, setRotations] = useState([]);
  const [rotLoading, setRotLoading] = useState(false);
  const [applyResult, setApplyResult] = useState(null);
  const loadRotations = useCallback(() => {
    setRotLoading(true);
    get('/api/hr/attendance/rotations')
      .then((res) => setRotations(asList(res) || []))
      .catch((e) => setError(e.message))
      .finally(() => setRotLoading(false));
  }, []);
  useEffect(() => { if (tab === 'rotations') loadRotations(); }, [tab, loadRotations]);

  async function applyRotation(id) {
    setError(''); setNotice(''); setApplyResult(null);
    try {
      const res = await post(`/api/hr/attendance/rotations/${id}/apply`, { from, to });
      setApplyResult(res);
      setNotice(`Generated ${res.written || 0} DRAFT cell(s)${(res.violations || []).length ? ` · ${res.violations.length} violation(s)` : ''}.`);
    } catch (e) { setError(e.message); }
  }

  const rotationCols = useMemo(() => [
    { key: 'code', header: 'Code' },
    { key: 'name', header: 'Name' },
    { key: 'cycleLength', header: 'Cycle', render: (r) => `${r.cycleLength} days` },
    { key: 'anchorDate', header: 'Anchor', render: (r) => fmtDate(r.anchorDate) },
    { key: 'isActive', header: 'Active', render: (r) => <StatusBadge status={r.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    { key: 'actions', header: '', render: (r) => (canManage ? <ActionButton onClick={() => applyRotation(r.id)}>Apply</ActionButton> : null) },
  ], [canManage, from, to]);

  // ── Swaps ──
  const [swaps, setSwaps] = useState([]);
  const [swapLoading, setSwapLoading] = useState(false);
  const [swapStatus, setSwapStatus] = useState('PENDING');
  const loadSwaps = useCallback(() => {
    setSwapLoading(true);
    get('/api/hr/attendance/swaps', swapStatus ? { status: swapStatus } : {})
      .then((res) => setSwaps(asList(res) || []))
      .catch((e) => setError(e.message))
      .finally(() => setSwapLoading(false));
  }, [swapStatus]);
  useEffect(() => { if (tab === 'swaps') loadSwaps(); }, [tab, loadSwaps]);

  async function decideSwap(id, action) {
    setError(''); setNotice('');
    try {
      await post(`/api/hr/attendance/swaps/${id}/${action}`, {});
      setNotice(`Swap ${action === 'approve' ? 'approved' : 'rejected'}.`);
      loadSwaps();
    } catch (e) { setError(e.message); }
  }

  const swapCols = useMemo(() => [
    { key: 'requester', header: 'Requester', render: (r) => employeeLabel(r.requester) },
    { key: 'requesterDate', header: 'Gives', render: (r) => fmtDate(r.requesterDate) },
    { key: 'counterparty', header: 'Counterparty', render: (r) => employeeLabel(r.counterparty) },
    { key: 'counterpartyDate', header: 'Takes', render: (r) => fmtDate(r.counterpartyDate) },
    { key: 'counterpartyConsent', header: 'Consent', render: (r) => <StatusBadge status={r.counterpartyConsent} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: '', render: (r) => ((canManage && r.status === 'PENDING') ? (
        <div className="flex gap-2">
          <ActionButton tone="positive" disabled={r.counterpartyConsent !== 'ACCEPTED'} onClick={() => decideSwap(r.id, 'approve')}>Approve</ActionButton>
          <ActionButton tone="danger" onClick={() => decideSwap(r.id, 'reject')}>Reject</ActionButton>
        </div>
      ) : null),
    },
  ], [canManage]);

  return (
    <div className="space-y-4">
      <PageHeader title="Roster" subtitle="Shift rosters, rotation patterns & swaps. Published rosters drive attendance; drafts do not." />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {error ? <ErrorBanner message={error} onDismiss={() => setError('')} /> : null}
      {notice ? <div className="rounded bg-emerald-50 text-emerald-800 px-3 py-2 text-sm">{notice}</div> : null}

      {tab === 'grid' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">From<input type="date" className="block border rounded px-2 py-1" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="text-sm">To<input type="date" className="block border rounded px-2 py-1" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <PrimaryButton onClick={loadGrid}>Refresh</PrimaryButton>
            {canManage ? <ActionButton onClick={publishWindow}>Publish window</ActionButton> : null}
          </div>
          <div className="text-xs text-gray-500" title="Only published cells reach attendance derivation and pay. Click a cell to set a shift or OFF (writes a manual DRAFT). Night shifts are amber.">
            DRAFT cells are hidden from attendance/pay until you Publish. Click a cell to set a shift or OFF. Night shifts are amber.
          </div>
          {gridLoading ? <Spinner /> : (
            <div className="overflow-x-auto border rounded">
              <table className="text-xs border-collapse">
                <thead>
                  <tr>
                    <th className="sticky left-0 bg-gray-50 border px-2 py-1 text-left">Employee</th>
                    {days.map((d) => <th key={d} className="border px-1 py-1 whitespace-nowrap" title={d}>{fmtDate(d)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {nodes.length === 0 ? (
                    <tr><td colSpan={days.length + 1} className="px-3 py-4 text-center text-gray-400">No employees in scope.</td></tr>
                  ) : nodes.map((n) => (
                    <tr key={n.employee.id}>
                      <td className="sticky left-0 bg-white border px-2 py-1 whitespace-nowrap">{employeeLabel(n.employee)}</td>
                      {days.map((d) => {
                        const cell = cellMap.get(`${n.employee.id}|${d}`);
                        const chip = cellChip(cell);
                        return (
                          <td key={d} className="border p-0.5 text-center" style={{ background: chip.color }} title={chip.title}>
                            {canManage ? (
                              <select
                                className="bg-transparent text-center w-full cursor-pointer"
                                style={{ color: chip.fg }}
                                value={cell && cell.dayType === 'OFF' ? 'OFF' : (cell && cell.shift ? cell.shift.id : '')}
                                onChange={(e) => setCell(n.employee.id, d, e.target.value)}
                              >
                                <option value="">·</option>
                                <option value="OFF">OFF</option>
                                {shifts.map((s) => <option key={s.id} value={s.id}>{(s.code || '').slice(0, 3)}</option>)}
                              </select>
                            ) : <span style={{ color: chip.fg }}>{chip.label}</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'rotations' && (
        <div className="space-y-3">
          <div className="text-xs text-gray-500">Apply a rotation ring to the in-scope population for the grid window ({from} → {to}). Generates DRAFT cells; resolve violations (rest &lt;11h, night-consent) before publishing.</div>
          <DataTable columns={rotationCols} rows={rotations} loading={rotLoading} emptyText="No rotation templates yet." rowKey={(r) => r.id} />
          {applyResult ? (
            <div className="rounded border p-3 text-sm">
              <div>Written: <b>{applyResult.written || 0}</b> · Locked-skipped: {(applyResult.skippedLocked || []).length} · Violations: {(applyResult.violations || []).length}</div>
              {(applyResult.violations || []).length ? (
                <ul className="mt-2 list-disc list-inside text-amber-700">
                  {applyResult.violations.slice(0, 20).map((v, i) => <li key={i}>{v.code}{v.date ? ` · ${v.date}` : ''}{v.employeeId ? ` · emp ${String(v.employeeId).slice(0, 8)}` : ''}{v.restMinutes != null ? ` · ${v.restMinutes}m rest` : ''}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {tab === 'swaps' && (
        <div className="space-y-3">
          <div className="flex items-end gap-3">
            <label className="text-sm">Status
              <select className="block border rounded px-2 py-1" value={swapStatus} onChange={(e) => setSwapStatus(e.target.value)}>
                <option value="">All</option>
                <option value="PENDING">Pending</option>
                <option value="APPROVED">Approved</option>
                <option value="REJECTED">Rejected</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </label>
            <PrimaryButton onClick={loadSwaps}>Refresh</PrimaryButton>
          </div>
          <DataTable columns={swapCols} rows={swaps} loading={swapLoading} emptyText="No swap requests." rowKey={(r) => r.id} />
        </div>
      )}
    </div>
  );
}
