'use client';

// Feature 10 slice 10e (ESS) — "Delegate while I'm away".
//
// "Going on leave? Let someone approve for you." Pick a stand-in + a date window
// + (optionally) limit it to certain request types. Shows a clear summary
// ("Ravi will approve Leave & Reimbursement for you, 10–18 Jul") and lists active
// delegations (both directions) with one-click revoke. ⓘ tooltips throughout.
//
// API: GET/POST/DELETE /api/hr/me/delegations + GET .../approvals/colleagues.

import { useEffect, useMemo, useState } from 'react';
import { Spinner, Empty } from '@hr/ui';
import { fetchMyDelegations, createDelegation, revokeDelegation, fetchColleagues } from '@/lib/api';
import { InfoTip, moduleMeta } from '@/lib/approvals';

// The request types a delegation can be limited to (the SME-relevant subset).
const LIMIT_MODULES = ['LEAVE', 'EXPENSE', 'TRAVEL', 'COMPENSATION', 'LOAN', 'PROFILE_CHANGE', 'ATTENDANCE_REGULARIZATION', 'SEPARATION'];

function fmtRange(a, b) {
  try {
    const d = (x) => new Date(x).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    return `${d(a)} – ${d(b)}`;
  } catch { return ''; }
}

export default function DelegatePanel({ onClose }) {
  const [colleagues, setColleagues] = useState([]);
  const [data, setData] = useState(null); // { outgoing, incoming }
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const [toUserId, setToUserId] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [limitOn, setLimitOn] = useState(false);
  const [modules, setModules] = useState([]);
  const [reason, setReason] = useState('');

  async function load() {
    setError('');
    try {
      const [d, col] = await Promise.all([fetchMyDelegations(), fetchColleagues().catch(() => ({ items: [] }))]);
      setData({ outgoing: d?.outgoing || [], incoming: d?.incoming || [] });
      setColleagues(Array.isArray(col?.items) ? col.items : []);
    } catch (e) {
      setError(e.message || 'Failed to load delegations.');
      setData({ outgoing: [], incoming: [] });
    }
  }
  useEffect(() => { load(); }, []);

  const standInName = useMemo(() => colleagues.find((c) => c.id === toUserId)?.name || 'They', [colleagues, toUserId]);
  const moduleSummary = useMemo(() => {
    if (!limitOn || modules.length === 0) return 'all requests';
    return modules.map((m) => moduleMeta(m).label).join(' & ');
  }, [limitOn, modules]);

  function toggleModule(m) {
    setModules((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!toUserId) { setError('Pick who should approve for you.'); return; }
    if (!startsAt || !endsAt) { setError('Choose the start and end dates.'); return; }
    if (new Date(startsAt) >= new Date(endsAt)) { setError('The end date must be after the start date.'); return; }
    setSaving(true);
    try {
      await createDelegation({
        toUserId,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        ...(limitOn && modules.length ? { modules } : {}),
        ...(reason ? { reason } : {}),
      });
      setToUserId(''); setStartsAt(''); setEndsAt(''); setLimitOn(false); setModules([]); setReason('');
      await load();
    } catch (e2) {
      setError(e2.message || 'Could not set up the delegation.');
    } finally {
      setSaving(false);
    }
  }

  async function revoke(id) {
    try { await revokeDelegation(id); await load(); }
    catch (e) { setError(e.message || 'Could not revoke.'); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: 'var(--theme-border)' }}>
          <h2 className="flex items-center text-base font-semibold" style={{ color: 'var(--theme-text)' }}>
            Delegate approvals
            <InfoTip text="While you’re away, your stand-in is ADDED as an approver — you can still approve too, and nothing is taken away from you. It switches off automatically at the end date." />
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-xl leading-none" style={{ color: 'var(--theme-muted)' }}>×</button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          <p className="mb-4 text-sm" style={{ color: 'var(--theme-muted)' }}>
            Going on leave? Let someone approve on your behalf for a few days.
          </p>

          {error && <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <form onSubmit={submit} className="space-y-3">
            <div>
              <label className="flex items-center text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
                Who approves for you?
                <InfoTip text="Pick a colleague you trust to handle approvals while you’re out." />
              </label>
              <select value={toUserId} onChange={(e) => setToUserId(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--theme-border)' }}>
                <option value="">Choose a person…</option>
                {colleagues.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
              </select>
              {colleagues.length === 0 && <p className="mt-1 text-xs" style={{ color: 'var(--theme-muted)' }}>No colleagues found to delegate to.</p>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>From</label>
                <input type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--theme-border)' }} />
              </div>
              <div>
                <label className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>To</label>
                <input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--theme-border)' }} />
              </div>
            </div>

            <div>
              <label className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
                <input type="checkbox" checked={limitOn} onChange={(e) => setLimitOn(e.target.checked)} />
                Limit to certain request types
                <InfoTip text="Leave this off and your stand-in can approve everything. Tick it to hand over only some kinds — e.g. just Leave and Reimbursement." />
              </label>
              {limitOn && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {LIMIT_MODULES.map((m) => {
                    const on = modules.includes(m);
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => toggleModule(m)}
                        className={`rounded-full border px-2.5 py-1 text-xs font-medium ${on ? 'text-white' : ''}`}
                        style={on ? { backgroundColor: 'var(--theme-primary)', borderColor: 'var(--theme-primary)' } : { borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
                      >
                        {moduleMeta(m).label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <label className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>Note (optional)</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Annual leave" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--theme-border)' }} />
            </div>

            {toUserId && startsAt && endsAt && (
              <p className="rounded-lg border bg-gray-50 px-3 py-2 text-sm" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}>
                <span className="font-medium">{standInName}</span> will approve {moduleSummary} for you, {fmtRange(startsAt, endsAt)}.
              </p>
            )}

            <button type="submit" disabled={saving} className="w-full rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ backgroundColor: 'var(--theme-primary)' }}>
              {saving ? 'Setting up…' : 'Set up delegation'}
            </button>
          </form>

          {/* Active delegations */}
          <div className="mt-6 border-t pt-4" style={{ borderColor: 'var(--theme-border)' }}>
            <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>Your active delegations</h3>
            {data === null ? (
              <Spinner small />
            ) : data.outgoing.length === 0 ? (
              <Empty text="You haven’t delegated to anyone." />
            ) : (
              <ul className="space-y-2">
                {data.outgoing.map((d) => (
                  <li key={d.id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--theme-border)' }}>
                    <span style={{ color: 'var(--theme-text)' }}>
                      <span className="font-medium">{d.toUser?.name || 'Someone'}</span> · {(d.modules && d.modules.length) ? d.modules.map((m) => moduleMeta(m).label).join(', ') : 'all requests'} · {fmtRange(d.startsAt, d.endsAt)}
                    </span>
                    <button type="button" onClick={() => revoke(d.id)} className="text-xs font-medium text-red-600 hover:underline">Revoke</button>
                  </li>
                ))}
              </ul>
            )}

            {data && data.incoming.length > 0 && (
              <>
                <h3 className="mb-2 mt-4 text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>Approving on behalf of</h3>
                <ul className="space-y-2">
                  {data.incoming.map((d) => (
                    <li key={d.id} className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
                      <span className="font-medium" style={{ color: 'var(--theme-text)' }}>{d.fromUser?.name || 'A colleague'}</span> — {fmtRange(d.startsAt, d.endsAt)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
