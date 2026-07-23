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
import { apiGet, apiPost, fetchDirectory } from '@/lib/api';
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

// "Request a shift swap" form. The counterparty is chosen from the tenant-wide
// company directory (the same SELF-scoped /api/hr/me/directory read the Directory
// page uses); its `id` is the employee id the backend expects as
// counterpartyEmployeeId. We POST { counterpartyEmployeeId, requesterDate,
// counterpartyDate, reason } to /api/hr/me/shifts/swaps — the backend resolves the
// requester from the session, so we never send our own id. The "your day" picker is
// seeded from the published roster (only published cells are swappable); the
// counterparty's day is a free date input (the backend validates it is published).
function SwapForm({ roster, onCreated }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [counterparty, setCounterparty] = useState(null); // { id, name, code }
  const [requesterDate, setRequesterDate] = useState('');
  const [counterpartyDate, setCounterpartyDate] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Your own swappable days = the published WORK/OFF cells already on the roster.
  const myDays = useMemo(() => (roster || []).filter((c) => c && c.date), [roster]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!open || debouncedQ.length < 2) { setResults([]); return; }
    let alive = true;
    setSearching(true);
    fetchDirectory(`?page=1&pageSize=8&q=${encodeURIComponent(debouncedQ)}`)
      .then((res) => { if (alive) setResults((res && res.items) || []); })
      .catch(() => { if (alive) setResults([]); })
      .finally(() => { if (alive) setSearching(false); });
    return () => { alive = false; };
  }, [open, debouncedQ]);

  function reset() {
    setQ(''); setDebouncedQ(''); setResults([]); setCounterparty(null);
    setRequesterDate(''); setCounterpartyDate(''); setReason(''); setFormError('');
  }

  async function submit(e) {
    e.preventDefault();
    setFormError('');
    if (!counterparty) { setFormError('Pick a colleague to swap with.'); return; }
    if (!requesterDate || !counterpartyDate || !reason.trim()) {
      setFormError('Choose both days and add a reason.'); return;
    }
    setSubmitting(true);
    try {
      await apiPost('/api/hr/me/shifts/swaps', {
        counterpartyEmployeeId: counterparty.id,
        requesterDate,
        counterpartyDate,
        reason: reason.trim(),
      });
      reset();
      setOpen(false);
      onCreated();
    } catch (err) {
      setFormError(err.message || 'Could not file the swap request.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
              className="px-3 py-1.5 text-sm rounded border font-medium"
              style={{ borderColor: 'var(--theme-primary)', color: 'var(--theme-primary)' }}>
        Request a shift swap
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-lg border px-4 py-3 space-y-3" style={{ borderColor: 'var(--theme-border)' }}>
      {formError ? <div className="rounded px-3 py-2 text-sm" style={{ background: '#FEE2E2', color: '#991B1B' }}>{formError}</div> : null}

      {/* counterparty picker — search the company directory */}
      <div>
        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--theme-muted)' }}>Swap with</label>
        {counterparty ? (
          <div className="flex items-center justify-between rounded border px-3 py-2 text-sm" style={{ borderColor: 'var(--theme-border)' }}>
            <span>{counterparty.name || counterparty.code}{counterparty.code ? <span className="text-xs text-gray-500"> · {counterparty.code}</span> : null}</span>
            <button type="button" className="text-xs underline" style={{ color: 'var(--theme-primary)' }}
                    onClick={() => { setCounterparty(null); setQ(''); }}>Change</button>
          </div>
        ) : (
          <div className="relative">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search a colleague by name, code or email…"
              aria-label="Search a colleague to swap with"
              className="w-full rounded border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--theme-border)' }}
            />
            {debouncedQ.length >= 2 ? (
              <div className="mt-1 rounded border divide-y" style={{ borderColor: 'var(--theme-border)' }}>
                {searching ? (
                  <div className="px-3 py-2 text-xs text-gray-500">Searching…</div>
                ) : results.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-gray-500">No colleagues match.</div>
                ) : results.map((r) => (
                  <button key={r.id} type="button"
                          onClick={() => { setCounterparty(r); setResults([]); }}
                          className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-50">
                    {r.name || r.code}
                    <span className="text-xs text-gray-500"> · {r.code}{r.designation ? ` · ${r.designation}` : ''}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--theme-muted)' }}>
            Your day to give
          </label>
          {myDays.length > 0 ? (
            <select value={requesterDate} onChange={(e) => setRequesterDate(e.target.value)}
                    aria-label="Your day to swap"
                    className="w-full rounded border px-3 py-2 text-sm bg-white" style={{ borderColor: 'var(--theme-border)' }}>
              <option value="">Select a published day…</option>
              {myDays.map((c) => {
                const v = cellView(c);
                return <option key={c.date} value={c.date}>{fmtDate(c.date)} · {v.label}</option>;
              })}
            </select>
          ) : (
            <input type="date" value={requesterDate} onChange={(e) => setRequesterDate(e.target.value)}
                   aria-label="Your day to swap"
                   className="w-full rounded border px-3 py-2 text-sm" style={{ borderColor: 'var(--theme-border)' }} />
          )}
        </div>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--theme-muted)' }}>
            Their day to take
          </label>
          <input type="date" value={counterpartyDate} onChange={(e) => setCounterpartyDate(e.target.value)}
                 aria-label="Their day to swap"
                 className="w-full rounded border px-3 py-2 text-sm" style={{ borderColor: 'var(--theme-border)' }} />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--theme-muted)' }}>Reason</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)}
               placeholder="Why do you need this swap?"
               aria-label="Reason for the swap"
               className="w-full rounded border px-3 py-2 text-sm" style={{ borderColor: 'var(--theme-border)' }} />
      </div>

      <div className="flex gap-2">
        <PrimaryButton type="submit" disabled={submitting}>{submitting ? 'Sending…' : 'Send swap request'}</PrimaryButton>
        <button type="button" className="px-3 py-1.5 text-sm rounded border" style={{ borderColor: 'var(--theme-border)' }}
                onClick={() => { reset(); setOpen(false); }}>Cancel</button>
      </div>
    </form>
  );
}

// ─── Open shifts (claim an unassigned shift) ──────────────────────────────────
// A roster manager publishes unassigned shifts to a claim pool; any employee can
// claim one, which opens an OPEN_SHIFT_CLAIM manager-confirm approval. Mirrors the
// ESS overtime idiom (a claimable list + a "my claims" list with withdraw-while-pending).
//   GET  /api/hr/me/shifts/open                     → claimable open shifts { items }
//        each item: { ...shift, date, headcount, filledCount, remaining, note,
//        shiftPattern, myClaim:{ id, status }|null }
//   POST /api/hr/me/shifts/open/:id/claim           claim (409 already-claimed / not-OPEN / locked)
//   GET  /api/hr/me/shifts/open/claims              → my claims { items:[{ id, status,
//        openShift:{ ...shiftPattern, date } }] }
//   POST /api/hr/me/shifts/open/claims/:id/withdraw withdraw while PENDING
// Server 4xx (409 / 400) messages surface verbatim.
function patternLabel(sp) {
  if (!sp) return 'Shift';
  const t = sp.startTime ? ` · ${sp.startTime}–${sp.endTime}${sp.isNightShift ? ' · Night' : ''}` : '';
  return `${sp.name || sp.code || 'Shift'}${t}`;
}

function OpenShiftsSection() {
  const [shifts, setShifts] = useState([]);
  const [shiftsLoading, setShiftsLoading] = useState(true);
  const [claims, setClaims] = useState([]);
  const [claimsLoading, setClaimsLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState('');

  const loadShifts = useCallback(() => {
    setShiftsLoading(true);
    apiGet('/api/hr/me/shifts/open')
      .then((res) => setShifts((res && res.items) || []))
      .catch((e) => { if (e.status !== 404) setError(e.message); })
      .finally(() => setShiftsLoading(false));
  }, []);
  const loadClaims = useCallback(() => {
    setClaimsLoading(true);
    apiGet('/api/hr/me/shifts/open/claims')
      .then((res) => setClaims((res && res.items) || []))
      .catch((e) => { if (e.status !== 404) setError(e.message); })
      .finally(() => setClaimsLoading(false));
  }, []);
  useEffect(() => { loadShifts(); loadClaims(); }, [loadShifts, loadClaims]);

  async function claim(s) {
    setBusyId(s.id); setError(''); setNotice('');
    try {
      await apiPost(`/api/hr/me/shifts/open/${encodeURIComponent(s.id)}/claim`, {});
      setNotice('Claim sent — your manager will confirm it.');
      loadShifts(); loadClaims();
    } catch (e) {
      // 409 (already claimed / not OPEN / day locked) surfaces verbatim.
      setError(e.message || 'Could not claim this shift.');
    } finally { setBusyId(''); }
  }
  async function withdraw(c) {
    setBusyId(c.id); setError(''); setNotice('');
    try {
      await apiPost(`/api/hr/me/shifts/open/claims/${encodeURIComponent(c.id)}/withdraw`, {});
      setNotice('Claim withdrawn.');
      loadShifts(); loadClaims();
    } catch (e) {
      setError(e.message || 'Could not withdraw this claim.');
    } finally { setBusyId(''); }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-base font-semibold flex items-center gap-1">
          Open shifts
          <InfoTip text="Unassigned shifts your company has opened for claiming. Claim one and your manager confirms it; you can withdraw a claim while it is still pending." />
        </h2>
        <PrimaryButton onClick={() => { loadShifts(); loadClaims(); }}>Refresh</PrimaryButton>
      </div>
      {error ? <div className="mb-2"><ErrorBanner message={error} onDismiss={() => setError('')} /></div> : null}
      {notice ? <div className="mb-2 rounded px-3 py-2 text-sm" style={{ background: '#DCFCE7', color: '#166534' }}>{notice}</div> : null}

      {shiftsLoading ? <Centered><Spinner /></Centered> : (
        shifts.length === 0 ? <Empty text="No open shifts to claim right now." /> : (
          <div className="space-y-2">
            {shifts.map((s) => {
              const claimed = s.myClaim && (s.myClaim.status === 'PENDING' || s.myClaim.status === 'APPROVED');
              const slotsLeft = typeof s.remaining === 'number' ? s.remaining : Math.max(0, (s.headcount || 0) - (s.filledCount || 0));
              return (
                <div key={s.id} className="rounded-lg border px-3 py-2 flex items-center justify-between gap-3 flex-wrap" style={{ borderColor: 'var(--theme-border)' }}>
                  <div className="text-sm">
                    <div className="font-medium">{fmtDate(s.date)} · {patternLabel(s.shiftPattern)}</div>
                    <div className="text-xs text-gray-500">
                      {slotsLeft} slot{slotsLeft === 1 ? '' : 's'} left of {s.headcount}
                      {s.note ? ` · ${s.note}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {s.myClaim ? <StatusChip status={s.myClaim.status} /> : null}
                    {claimed ? (
                      <span className="text-xs text-gray-500">Claimed</span>
                    ) : (
                      <button type="button" onClick={() => claim(s)} disabled={busyId === s.id || slotsLeft <= 0}
                              className="px-3 py-1 text-xs rounded border font-medium disabled:opacity-50"
                              style={{ borderColor: 'var(--theme-primary)', color: 'var(--theme-primary)' }}>
                        {busyId === s.id ? 'Claiming…' : 'Claim'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      <h3 className="text-xs font-semibold uppercase tracking-wide mt-4 mb-2" style={{ color: 'var(--theme-muted)' }}>My open-shift claims</h3>
      {claimsLoading ? <Centered><Spinner small /></Centered> : (
        claims.length === 0 ? <Empty text="You haven't claimed any open shifts yet." /> : (
          <div className="space-y-2">
            {claims.map((c) => {
              const sp = c.openShift ? c.openShift.shiftPattern : null;
              return (
                <div key={c.id} className="rounded-lg border px-3 py-2 flex items-center justify-between gap-3 flex-wrap" style={{ borderColor: 'var(--theme-border)' }}>
                  <div className="text-sm font-medium">
                    {c.openShift ? fmtDate(c.openShift.date) : '—'} · {patternLabel(sp)}
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusChip status={c.status} />
                    {c.status === 'PENDING' ? (
                      <button type="button" onClick={() => withdraw(c)} disabled={busyId === c.id}
                              className="px-3 py-1 text-xs rounded border border-gray-300 text-gray-700 disabled:opacity-50">
                        {busyId === c.id ? 'Withdrawing…' : 'Withdraw'}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}
    </section>
  );
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
          <div className="mb-3">
            <SwapForm roster={roster} onCreated={() => { setNotice('Swap request sent — your colleague must consent before it goes to a manager.'); loadSwaps(); }} />
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

        <OpenShiftsSection />
      </div>
    </AppShell>
  );
}
