'use client';

// Separations + Full-and-Final settlement (Feature 4 §5.1, §6).
//
// Three surfaces in one screen:
//  (a) a scoped LIST of separation cases (GET /separations — HR=ALL, Manager=their
//      departing reports);
//  (b) an "Initiate separation" WIZARD (employee picker via GET /api/hr/employees?q=
//      → type/reason/notice/LWD → POST /separations);
//  (c) a case RUNNER (GET /separations/:id) with exit CLEARANCE lanes (IT/Finance/
//      Admin/Manager — PATCH clearance, each lane gated by the actor's permission),
//      a Compute-FnF step (renders the 422 blockers — un-cleared lanes / un-returned
//      assets — as a checklist; on success the FnF breakdown), Approve-FnF (SoD —
//      blocked if you initiated), Settle, and Generate letters (gated on SETTLED).
//
// Every destructive action is permission-gated: actions the operator lacks are
// hidden and a 🔒 read-only banner explains why; out-of-scope subjects resolve to
// 404 ("not found") and never leak another team's cases. The server is the real
// enforcement boundary — this is the self-serve console for it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, ErrorBanner, Modal, ModalActions, PrimaryButton, TextArea, DateField, formatAdminDate,
} from '@hr/ui';
import { get, post, patch } from '@/lib/api';
import { asList, DataTable, PageHeader, StatusBadge, moneyish } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import ManagerPicker from '@/components/ManagerPicker';

// SeparationType enum (mirrors the controller's SEPARATION_TYPES set).
const SEPARATION_TYPES = [
  'RESIGNATION', 'TERMINATION_FOR_CAUSE', 'RETRENCHMENT', 'REDUNDANCY', 'END_OF_CONTRACT',
  'RETIREMENT', 'DEATH', 'ABSCONDING', 'PROBATION_FAILURE', 'MUTUAL_SEPARATION',
];

// Clearance lanes + the permission each requires (mirrors the controller's
// CLEARANCE_LANES). Managers (TEAM band) may clear only the manager-allowed lanes.
const CLEARANCE_LANES = [
  { key: 'it', label: 'IT', permission: 'canManageStatutory', managerAllowed: false },
  { key: 'finance', label: 'Finance', permission: 'canApprovePayroll', managerAllowed: false },
  { key: 'admin', label: 'Admin', permission: 'canManageOrg', managerAllowed: false },
  { key: 'knowledge_transfer', label: 'Knowledge transfer', permission: 'canRunSeparation', managerAllowed: true },
  { key: 'assets', label: 'Asset return', permission: 'canRunSeparation', managerAllowed: true },
];

function empName(e) {
  if (!e) return '—';
  return [e.firstName, e.lastName].filter(Boolean).join(' ') || e.code || e.id;
}
function minorMoney(minor, currency) {
  if (minor == null) return '—';
  return moneyish(Number(minor) / 100, currency);
}

// ─── Initiate wizard ─────────────────────────────────────────────────────────
function InitiateModal({ onClose, onCreated }) {
  const [employeeId, setEmployeeId] = useState('');
  const [type, setType] = useState('RESIGNATION');
  const [reason, setReason] = useState('');
  const [resignationDate, setResignationDate] = useState('');
  const [lwd, setLwd] = useState('');
  const [relievingDate, setRelievingDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setBusy(true); setError('');
    try {
      const out = await post('/api/hr/separations', {
        employeeId,
        type,
        reason: reason.trim() || undefined,
        resignationDate: resignationDate || undefined,
        noticeDate: resignationDate || undefined,
        lwd: lwd || undefined,
        relievingDate: relievingDate || undefined,
      });
      onCreated(out?.separation?.id || null);
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to initiate the separation.');
      setBusy(false);
    }
  }

  return (
    <Modal title="Initiate separation" onClose={onClose} size="lg">
      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}
      <div className="space-y-4">
        <ManagerPicker
          label="Employee"
          value={employeeId}
          onChange={setEmployeeId}
          hint="Search the directory by name or code. The case is scoped to this person."
        />
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)} className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm bg-white">
              {SEPARATION_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <DateField label="Notice / resignation date" value={resignationDate} onChange={setResignationDate} />
          <DateField label="Last working day (LWD)" value={lwd} onChange={setLwd} />
          <DateField label="Relieving date" value={relievingDate} onChange={setRelievingDate} />
        </div>
        <TextArea label="Reason (optional)" value={reason} onChange={setReason} rows={2} />
      </div>
      <div className="mt-5">
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <PrimaryButton onClick={submit} loading={busy} disabled={!employeeId || !type}>Initiate</PrimaryButton>
        </ModalActions>
      </div>
    </Modal>
  );
}

// ─── FnF breakdown ───────────────────────────────────────────────────────────
function FnfBreakdown({ fnf }) {
  if (!fnf) return null;
  const earnings = fnf.lines?.earnings || fnf.payRunInput?.earnings || [];
  const deductions = fnf.lines?.deductions || fnf.payRunInput?.deductions || [];
  const cur = fnf.currencyCode || fnf.payRunInput?.currencyCode;
  const net = fnf.snapshot?.netSettlementMinor;
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-900">Full-and-final breakdown</h4>
        {fnf.recoverableBalance && (
          <span className="text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">Recoverable balance</span>
        )}
      </div>
      <div className="grid sm:grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-xs font-medium text-emerald-700 uppercase tracking-wide mb-1">Earnings</p>
          {earnings.length === 0 ? <p className="text-gray-400 text-xs">None</p> : (
            <ul className="divide-y divide-gray-50">
              {earnings.map((l) => (
                <li key={l.code} className="flex justify-between py-1">
                  <span className="text-gray-700">{l.label}</span>
                  <span className="text-gray-900 tabular-nums">{minorMoney(l.amountMinor, cur)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-xs font-medium text-red-700 uppercase tracking-wide mb-1">Deductions</p>
          {deductions.length === 0 ? <p className="text-gray-400 text-xs">None</p> : (
            <ul className="divide-y divide-gray-50">
              {deductions.map((l) => (
                <li key={l.code} className="flex justify-between py-1">
                  <span className="text-gray-700">{l.label}</span>
                  <span className="text-gray-900 tabular-nums">{minorMoney(l.amountMinor, cur)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="flex justify-between border-t border-gray-100 pt-2 text-sm font-semibold">
        <span className="text-gray-900">Net settlement</span>
        <span className={`tabular-nums ${Number(net) < 0 ? 'text-red-700' : 'text-gray-900'}`}>{minorMoney(net, cur)}</span>
      </div>
    </div>
  );
}

// ─── Clearance lanes ─────────────────────────────────────────────────────────
function ClearanceLanes({ sep, perms, isScoped, busy, onClear }) {
  const clearance = sep.clearanceJson || {};
  const locked = ['SETTLED', 'CANCELLED', 'FNF_APPROVED'].includes(sep.status);
  return (
    <div className="rounded-xl border border-gray-200 bg-white divide-y divide-gray-50">
      {CLEARANCE_LANES.map((lane) => {
        const state = clearance[lane.key];
        const cleared = state?.status === 'CLEARED';
        // A scoped (manager) actor may only act on manager-allowed lanes; an
        // ALL-band actor needs the lane's permission. The server re-checks.
        const canAct = !locked && !cleared && (isScoped ? lane.managerAllowed : hasPermission(perms, lane.permission));
        return (
          <div key={lane.key} className="flex items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-gray-900">{lane.label}</p>
              <p className="text-[11px] text-gray-500">
                {state ? `${state.status}${state.note ? ` · ${state.note}` : ''}` : 'Pending'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cleared ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                {cleared ? 'Cleared' : 'Open'}
              </span>
              {canAct && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onClear(lane.key)}
                  className="px-2.5 py-1 text-[11px] font-medium border border-emerald-300 text-emerald-700 rounded-md hover:bg-emerald-50 disabled:opacity-40"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Status timeline ─────────────────────────────────────────────────────────
const SEP_FLOW = ['INITIATED', 'NOTICE_SERVING', 'CLEARANCE_PENDING', 'FNF_PENDING', 'FNF_COMPUTED', 'FNF_APPROVED', 'SETTLED'];
function Timeline({ status }) {
  if (status === 'CANCELLED') {
    return <p className="text-sm text-gray-500">This case was cancelled.</p>;
  }
  const idx = SEP_FLOW.indexOf(status);
  return (
    <ol className="flex flex-wrap gap-1.5" aria-label="Separation progress">
      {SEP_FLOW.map((s, i) => {
        const done = idx >= 0 && i <= idx;
        return (
          <li key={s} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${done ? 'bg-[color:var(--theme-primary)] text-white border-transparent' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
            {s.replace(/_/g, ' ')}
          </li>
        );
      })}
    </ol>
  );
}

// ─── Case runner ─────────────────────────────────────────────────────────────
function CaseModal({ caseId, perms, isScoped, onClose, onChanged }) {
  const [data, setData] = useState(null); // { separation, journey }
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [blockers, setBlockers] = useState(null); // 422 compute blockers checklist
  const [fnf, setFnf] = useState(null);
  const [docs, setDocs] = useState([]); // generated letters this session

  const canRunSeparation = hasPermission(perms, 'canRunSeparation');
  const canApprovePayroll = hasPermission(perms, 'canApprovePayroll');
  const canGenerateLetters = hasPermission(perms, 'canGenerateLetters');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await get(`/api/hr/separations/${caseId}`);
      setData(res);
      const snap = res?.separation?.fnfSnapshotJson;
      if (snap && (snap.lines || snap.payRunInput)) setFnf(snap);
    } catch (e) {
      setError(e.status === 404 ? 'This case was not found (it may be outside your team).' : (e.data?.message || e.message || 'Failed to load the case.'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => { load(); }, [load]);

  const sep = data?.separation;

  async function act(fn, okMsg, { clearBlockers = true } = {}) {
    setBusy(true); setError(''); setNotice('');
    if (clearBlockers) setBlockers(null);
    try {
      const out = await fn();
      if (okMsg) setNotice(typeof okMsg === 'function' ? okMsg(out) : okMsg);
      await load();
      onChanged && onChanged();
      return out;
    } catch (e) {
      const reason = e.data?.reason;
      // Render the compute-FnF 422 blockers (un-cleared lanes / open assets) as a
      // checklist rather than a flat error.
      if (reason === 'clearance-open' && Array.isArray(e.data?.openLanes)) {
        setBlockers({ kind: 'lanes', lanes: e.data.openLanes, message: e.data.message });
      } else if (reason === 'assets-open') {
        setBlockers({ kind: 'assets', count: e.data?.unresolvedCount, message: e.data.message });
      } else {
        setError(e.data?.message || e.message || 'Action failed.');
      }
      return null;
    } finally {
      setBusy(false);
    }
  }

  function clearLane(lane) {
    return act(() => patch(`/api/hr/separations/${caseId}/clearance`, { lane, status: 'CLEARED' }), `${lane.replace(/_/g, ' ')} cleared.`);
  }
  function computeFnf() {
    return act(async () => {
      const out = await post(`/api/hr/separations/${caseId}/compute-fnf`);
      if (out?.fnf) setFnf(out.fnf);
      return out;
    }, 'FnF computed.');
  }
  function approveFnf() {
    return act(() => post(`/api/hr/separations/${caseId}/approve-fnf`), (o) => `FnF approved — PayRun ${o?.payRun?.code || ''} created.`);
  }
  function settle() {
    return act(() => post(`/api/hr/separations/${caseId}/settle`), (o) => `Settled. ${o?.reassignedReports ? `${o.reassignedReports} report(s) reassigned.` : ''}`);
  }
  function cancelCase() {
    return act(() => post(`/api/hr/separations/${caseId}/cancel`), 'Case cancelled.');
  }
  async function generateLetter(letterType) {
    const out = await act(() => post(`/api/hr/separations/${caseId}/letters`, { type: letterType }), `${letterType} letter generated.`);
    if (out?.document) setDocs((d) => [...d, out.document]);
  }

  // SoD: the initiator cannot approve. We can't read the session user id here
  // cheaply, but the server enforces it; we disable approve when canApprovePayroll
  // is absent and surface the SoD 403 inline if the initiator clicks it.
  const status = sep?.status;
  const fnfReady = status === 'FNF_COMPUTED';
  const settleReady = status === 'FNF_APPROVED';
  const lettersReady = status === 'SETTLED';
  const computeReady = ['FNF_PENDING', 'CLEARANCE_PENDING', 'NOTICE_SERVING', 'INITIATED', 'FNF_COMPUTED'].includes(status);
  const cancellable = sep && !['SETTLED', 'CANCELLED'].includes(status);

  return (
    <Modal title={sep ? `${empName(sep.employee)} · ${sep.code}` : 'Separation case'} onClose={onClose} size="lg">
      {loading ? (
        <div className="py-10 flex justify-center"><Spinner /></div>
      ) : error && !sep ? (
        <ErrorBanner message={error} />
      ) : sep ? (
        <div className="space-y-4">
          {error && <ErrorBanner message={error} />}
          {notice && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{notice}</p>}

          {/* Summary + timeline */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div><dt className="text-xs text-gray-500">Type</dt><dd className="text-gray-900">{String(sep.type || '').replace(/_/g, ' ')}</dd></div>
            <div><dt className="text-xs text-gray-500">Status</dt><dd><StatusBadge status={sep.status} /></dd></div>
            <div><dt className="text-xs text-gray-500">LWD</dt><dd className="text-gray-900">{sep.lastWorkingDay ? formatAdminDate(sep.lastWorkingDay) : '—'}</dd></div>
            <div><dt className="text-xs text-gray-500">Notice shortfall</dt><dd className="text-gray-900">{sep.noticeShortfallDays ?? 0} day(s)</dd></div>
          </div>
          <Timeline status={sep.status} />

          {/* Clearance lanes */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Exit clearance</h3>
            <ClearanceLanes sep={sep} perms={perms} isScoped={isScoped} busy={busy} onClear={clearLane} />
          </div>

          {/* Compute blockers (422 checklist) */}
          {blockers && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-800 mb-2">{blockers.message || 'FnF cannot be computed yet.'}</p>
              {blockers.kind === 'lanes' ? (
                <ul className="space-y-1 text-sm">
                  {blockers.lanes.map((l) => (
                    <li key={l} className="flex items-center gap-2 text-amber-800">
                      <span aria-hidden="true">○</span>
                      {(CLEARANCE_LANES.find((x) => x.key === l) || {}).label || l} lane still open
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-amber-800">{blockers.count} asset(s) still un-returned — return them or record a recovery on the asset, then retry.</p>
              )}
            </div>
          )}

          {/* FnF breakdown */}
          {fnf && <FnfBreakdown fnf={fnf} />}

          {/* FnF / settlement actions */}
          {canRunSeparation ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
              {!lettersReady && (
                <PrimaryButton onClick={computeFnf} loading={busy} disabled={!computeReady}>
                  {fnf ? 'Recompute FnF' : 'Compute FnF'}
                </PrimaryButton>
              )}
              <span title={canApprovePayroll ? 'Approve the FnF (separation of duties: not the initiator)' : 'Requires canApprovePayroll'}>
                <button
                  type="button"
                  disabled={busy || !fnfReady || !canApprovePayroll}
                  onClick={approveFnf}
                  className="px-4 py-2 text-sm font-semibold border border-emerald-300 text-emerald-700 rounded-lg hover:bg-emerald-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Approve FnF
                </button>
              </span>
              <button
                type="button"
                disabled={busy || !settleReady}
                onClick={settle}
                className="px-4 py-2 text-sm font-semibold border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Settle
              </button>
              {cancellable && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={cancelCase}
                  className="px-4 py-2 text-sm font-medium border border-red-300 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-40 ml-auto"
                >
                  Cancel case
                </button>
              )}
            </div>
          ) : (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
              <span aria-hidden="true">🔒 </span>You have read-only access to FnF actions. Computing, approving and settling require the canRunSeparation / canApprovePayroll permissions.
            </p>
          )}
          {!canApprovePayroll && canRunSeparation && fnfReady && (
            <p className="text-xs text-gray-500">FnF approval requires canApprovePayroll and a different person than the initiator (separation of duties).</p>
          )}

          {/* Letters (gated on SETTLED) */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Letters</h3>
            {canGenerateLetters ? (
              lettersReady ? (
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" disabled={busy} onClick={() => generateLetter('relieving')} className="px-3 py-1.5 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40">
                    Generate relieving letter
                  </button>
                  <button type="button" disabled={busy} onClick={() => generateLetter('experience')} className="px-3 py-1.5 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40">
                    Generate experience letter
                  </button>
                </div>
              ) : (
                <p className="text-sm text-gray-500">Relieving / experience letters become available once the case is settled.</p>
              )
            ) : (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                <span aria-hidden="true">🔒 </span>Generating letters requires the canGenerateLetters permission.
              </p>
            )}
            {docs.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm">
                {docs.map((d) => (
                  <li key={d.id} className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2">
                    <span className="text-gray-900">{d.name}</span>
                    <span className="text-[11px] text-emerald-600" title={d.fileHash}>✓ hash {String(d.fileHash || '').slice(0, 10)}…</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      <div className="mt-5">
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Close</button>
        </ModalActions>
      </div>
    </Modal>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function SeparationsPage() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [perms, setPerms] = useState(null);
  const [isScoped, setIsScoped] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [initiating, setInitiating] = useState(false);

  const canRunSeparation = hasPermission(perms, 'canRunSeparation');

  const load = useCallback(() => {
    setError('');
    setRows(null);
    get('/api/hr/separations', { status: statusFilter || undefined, pageSize: 200 })
      .then((r) => setRows(asList(r)))
      .catch((e) => { setError(e.data?.message || e.message || 'Failed to load separations.'); setRows([]); });
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    get('/api/auth/me')
      .then((me) => {
        const session = me?.user || me;
        const p = permissionsFromSession(session);
        setPerms(p);
        // A user without canRunSeparation acts in a scoped manager capacity.
        setIsScoped(!hasPermission(p, 'canRunSeparation'));
      })
      .catch(() => { setPerms(null); setIsScoped(false); });
  }, []);

  const columns = useMemo(() => [
    { key: 'employee', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{empName(r.employee)}</span> },
    { key: 'code', header: 'Case', render: (r) => <span className="font-mono text-xs text-gray-500">{r.code}</span> },
    { key: 'type', header: 'Type', render: (r) => String(r.type || '').replace(/_/g, ' ') },
    { key: 'lwd', header: 'LWD', render: (r) => (r.lastWorkingDay ? formatAdminDate(r.lastWorkingDay) : '—') },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'net', header: 'Net', render: (r) => (r.netSettlement != null ? moneyish(r.netSettlement, r.currencyCode) : '—') },
    {
      key: 'actions', header: '', className: 'text-right',
      render: (r) => (
        <button type="button" onClick={() => setOpenId(r.id)} className="px-2.5 py-1 text-xs font-medium border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50">
          Open
        </button>
      ),
    },
  ], []);

  return (
    <div>
      <PageHeader
        title="Separations"
        subtitle="Exit clearance, full-and-final settlement and letters"
        actions={
          canRunSeparation ? (
            <PrimaryButton onClick={() => setInitiating(true)}>Initiate separation</PrimaryButton>
          ) : null
        }
      />

      {isScoped && (
        <p className="mb-4 text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
          Showing separations for your reports only. HR sees the whole tenant and can initiate and settle cases.
        </p>
      )}

      <div className="flex flex-wrap gap-3 mb-4">
        <label htmlFor="sep-status" className="sr-only">Filter by status</label>
        <select id="sep-status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm bg-white">
          <option value="">All statuses</option>
          {SEP_FLOW.concat(['CANCELLED']).map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
      </div>

      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}

      <DataTable
        columns={columns}
        rows={rows}
        loading={rows === null}
        emptyText="No separation cases. Initiate one to begin an exit."
        caption="Separation cases"
      />

      {initiating && (
        <InitiateModal
          onClose={() => setInitiating(false)}
          onCreated={(id) => { setInitiating(false); load(); if (id) setOpenId(id); }}
        />
      )}

      {openId && (
        <CaseModal
          caseId={openId}
          perms={perms}
          isScoped={isScoped}
          onClose={() => setOpenId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
