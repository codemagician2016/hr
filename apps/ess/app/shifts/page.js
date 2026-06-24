'use client';

// My Shifts (Feature 29) — the employee's PUBLISHED shift roster + shift-swap inbox.
//
// SELF-SERVICE SURFACE: every call goes to the customer-session endpoints, which
// resolve the employee SERVER-SIDE from the session. The page NEVER sends an
// employeeId (a cross-employee read/write is structurally impossible).
//   Roster  : GET  /api/hr/me/attendance/schedule?from=&to=  → { roster:[{date,dayType,shift}] }
//   Swaps   : GET  /api/hr/me/shifts/swaps                    → my sent + received requests
//             POST /api/hr/me/shifts/swaps                    file a swap
//             POST /api/hr/me/shifts/swaps/:id/consent        accept/decline (counterparty only)
//             POST /api/hr/me/shifts/swaps/:id/withdraw       requester withdraws
//
// Only PUBLISHED roster cells are shown — an employee never sees a draft plan.

import { useCallback, useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered, PrimaryButton } from '@hr/ui';
import { apiGet, apiPost } from '@/lib/api';
import InfoTip from '@/components/InfoTip';

function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }); } catch { return String(d).slice(0, 10); }
}

// A roster cell → label + colour. Night = amber, OFF = grey, work = blue.
function cellView(cell) {
  if (!cell || cell.dayType === 'OFF') return { label: 'OFF', sub: 'Weekly off', bg: '#F3F4F6', fg: '#6B7280' };
  const s = cell.shift || {};
  const night = s.isNightShift;
  return {
    label: s.code || 'Shift',
    sub: `${s.startTime || ''}–${s.endTime || ''}${night ? ' · Night' : ''}`,
    bg: night ? '#FEF3C7' : '#DBEAFE',
    fg: night ? '#92400E' : '#1E40AF',
  };
}

function StatusChip({ status }) {
  const map = {
    PENDING: ['#FEF9C3', '#854D0E'], APPROVED: ['#DCFCE7', '#166534'],
    REJECTED: ['#FEE2E2', '#991B1B'], CANCELLED: ['#E5E7EB', '#374151'],
    ACCEPTED: ['#DCFCE7', '#166534'], DECLINED: ['#FEE2E2', '#991B1B'],
  };
  const [bg, fg] = map[status] || ['#E5E7EB', '#374151'];
  return <span className="px-2 py-0.5 rounded text-xs font-medium" style={{ background: bg, color: fg }}>{status}</span>;
}

export default function MyShiftsPage() {
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [from] = useState(todayISO());
  const to = useMemo(() => addDaysISO(from, 13), [from]); // a fortnight

  const [roster, setRoster] = useState([]);
  const [rosterLoading, setRosterLoading] = useState(true);
  const loadRoster = useCallback(() => {
    setRosterLoading(true);
    apiGet(`/api/hr/me/attendance/schedule?from=${from}&to=${to}`)
      .then((res) => setRoster((res && res.roster) || []))
      .catch((e) => setError(e.message))
      .finally(() => setRosterLoading(false));
  }, [from, to]);

  const [swaps, setSwaps] = useState([]);
  const [swapsLoading, setSwapsLoading] = useState(true);
  const loadSwaps = useCallback(() => {
    setSwapsLoading(true);
    apiGet('/api/hr/me/shifts/swaps')
      .then((res) => setSwaps((res && res.items) || []))
      .catch((e) => setError(e.message))
      .finally(() => setSwapsLoading(false));
  }, []);

  useEffect(() => { loadRoster(); loadSwaps(); }, [loadRoster, loadSwaps]);

  async function consent(id, decision) {
    setError(''); setNotice('');
    try {
      await apiPost(`/api/hr/me/shifts/swaps/${id}/consent`, { decision });
      setNotice(decision === 'ACCEPT' ? 'Accepted — sent to your manager for approval.' : 'Declined.');
      loadSwaps();
    } catch (e) { setError(e.message); }
  }
  async function withdraw(id) {
    setError(''); setNotice('');
    try {
      await apiPost(`/api/hr/me/shifts/swaps/${id}/withdraw`, {});
      setNotice('Withdrawn.');
      loadSwaps();
    } catch (e) { setError(e.message); }
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <h1 className="text-xl font-bold" style={{ color: 'var(--theme-text)' }}>My Shifts</h1>
        {error ? <ErrorBanner message={error} onDismiss={() => setError('')} /> : null}
        {notice ? <div className="rounded px-3 py-2 text-sm" style={{ background: '#DCFCE7', color: '#166534' }}>{notice}</div> : null}

        <section>
          <h2 className="text-base font-semibold mb-2 flex items-center gap-1">
            This fortnight
            <InfoTip text="Your published roster for the next two weeks. Only published shifts are shown; night shifts are amber." />
          </h2>
          {rosterLoading ? <Centered><Spinner /></Centered> : (
            roster.length === 0 ? <Empty text="No published shifts in this window yet." /> : (
              <div className="flex flex-wrap gap-2">
                {roster.map((c) => {
                  const v = cellView(c);
                  return (
                    <div key={c.date} className="rounded-lg border px-3 py-2 min-w-[92px]" style={{ background: v.bg }}>
                      <div className="text-xs" style={{ color: v.fg }}>{fmtDate(c.date)}</div>
                      <div className="font-semibold text-sm" style={{ color: v.fg }}>{v.label}</div>
                      <div className="text-[11px]" style={{ color: v.fg }}>{v.sub}</div>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </section>

        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-base font-semibold flex items-center gap-1">
              Swap requests
              <InfoTip text="Shift swaps you sent or received. A received swap needs your consent before it goes to a manager; the 11-hour rest rule is re-checked at approval." />
            </h2>
            <PrimaryButton onClick={loadSwaps}>Refresh</PrimaryButton>
          </div>
          {swapsLoading ? <Centered><Spinner /></Centered> : (
            swaps.length === 0 ? <Empty text="No swap requests." /> : (
              <div className="space-y-2">
                {swaps.map((s) => {
                  const youAreCounterparty = s.role === 'COUNTERPARTY';
                  const other = youAreCounterparty ? s.requester : s.counterparty;
                  return (
                    <div key={s.id} className="rounded-lg border px-3 py-2 flex items-center justify-between gap-3 flex-wrap">
                      <div className="text-sm">
                        <div className="font-medium">
                          {youAreCounterparty ? 'Received from ' : 'Sent to '}
                          {other ? `${other.firstName || ''} ${other.lastName || ''}`.trim() || other.code : '—'}
                        </div>
                        <div className="text-xs text-gray-500">
                          You work {fmtDate(youAreCounterparty ? s.counterpartyDate : s.requesterDate)} ↔ they work {fmtDate(youAreCounterparty ? s.requesterDate : s.counterpartyDate)} · {s.reason}
                        </div>
                        <div className="mt-1 flex gap-2 items-center">
                          <span className="text-xs text-gray-500">Consent:</span> <StatusChip status={s.counterpartyConsent} />
                          <span className="text-xs text-gray-500">Status:</span> <StatusChip status={s.status} />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {youAreCounterparty && s.counterpartyConsent === 'PENDING' && s.status === 'PENDING' ? (
                          <>
                            <button type="button" className="px-3 py-1 text-xs rounded border border-emerald-300 text-emerald-700" onClick={() => consent(s.id, 'ACCEPT')}>Accept</button>
                            <button type="button" className="px-3 py-1 text-xs rounded border border-red-300 text-red-700" onClick={() => consent(s.id, 'DECLINE')}>Decline</button>
                          </>
                        ) : null}
                        {!youAreCounterparty && s.status === 'PENDING' ? (
                          <button type="button" className="px-3 py-1 text-xs rounded border border-gray-300 text-gray-700" onClick={() => withdraw(s.id)}>Withdraw</button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </section>
      </div>
    </AppShell>
  );
}
