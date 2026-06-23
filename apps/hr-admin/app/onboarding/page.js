'use client';

// Onboarding pipeline board (Feature 4 §5.1, §6).
//
// A Kanban of onboarding journeys grouped by their LifecycleStage. Each card is
// one hire: name/role/join-date + a blocking-tasks-remaining badge + due flags.
// Clicking a card opens a detail drawer with the journey's checklist (tasks
// grouped by stage, owner, status — complete/skip a task), an "Advance" action
// (disabled while blocking tasks at the current stage are open, with a tooltip),
// the one-click "Provision employee" action (409 already-provisioned / 403 SoD
// surfaced as friendly messages) and "Confirm probation".
//
// Scope: GET /onboarding/journeys is server-scoped — HR-Admin (ALL band) sees the
// whole tenant pipeline; a Manager (TEAM band) sees only their reporting sub-tree
// and gets a "your team" banner. Out-of-scope single targets resolve to 404
// ("not found"), never leaking another team's subjects. canManageOnboarding gates
// the provision/confirm actions (hidden + read-only banner when absent).

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Spinner, ErrorBanner, Empty, Modal, ModalActions, PrimaryButton, TextArea, formatAdminDate,
} from '@hr/ui';
import { get, post } from '@/lib/api';
import { PageHeader } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';

// Ordered onboarding stages — mirrors journeyEngine.ONBOARDING_STAGES. The board
// renders one column per stage; the final "Completed" column buckets terminal
// journeys (COMPLETED/CANCELLED/RESCINDED/NO_SHOW) regardless of currentStage so
// finished hires don't linger in PROBATION.
const STAGE_COLUMNS = [
  { key: 'PRE_JOIN', label: 'Pre-join' },
  { key: 'SELF_ONBOARDING', label: 'Self-onboarding' },
  { key: 'DOCS_ESIGN', label: 'Docs / e-sign' },
  { key: 'PROVISIONING', label: 'Provisioning' },
  { key: 'DAY_ONE', label: 'Day one' },
  { key: 'WEEK_ONE', label: 'Week one' },
  { key: 'PROBATION', label: 'Probation' },
];
const DONE_COLUMN = { key: '__DONE__', label: 'Completed' };

const TERMINAL_STATUS = new Set(['COMPLETED', 'CANCELLED', 'RESCINDED', 'NO_SHOW']);
const OPEN_BLOCKING = new Set(['PENDING', 'IN_PROGRESS', 'WAITING_APPROVAL', 'BLOCKED', 'OVERDUE', 'FAILED']);
const TERMINAL_TASK = new Set(['DONE', 'SKIPPED', 'NOT_APPLICABLE']);

function journeyName(j) {
  const s = j.selfServiceJson || {};
  const p = s.personal || {};
  const name = [p.firstName, p.lastName].filter(Boolean).join(' ');
  return name || j.code || 'New hire';
}
function journeyRole(j) {
  const s = j.selfServiceJson || {};
  return s.designation || s.role || (j.meta && (j.meta.designation || j.meta.role)) || '—';
}

// Count of OPEN blocking+mandatory tasks at the journey's CURRENT stage — this is
// the gate that holds a card back from Advance.
function currentStageBlockers(j) {
  const tasks = j.tasks || [];
  return tasks.filter(
    (t) => t.stageKey === j.currentStage && t.isBlocking && t.isMandatory && OPEN_BLOCKING.has(t.status),
  );
}
function totalOpenBlockers(j) {
  return (j.tasks || []).filter((t) => t.isBlocking && t.isMandatory && OPEN_BLOCKING.has(t.status)).length;
}
function isOverdue(t) {
  if (!t.dueDate || TERMINAL_TASK.has(t.status)) return false;
  return new Date(t.dueDate).getTime() < Date.now();
}

function StatusPill({ status }) {
  const s = String(status || '').toUpperCase();
  let cls = 'bg-gray-100 text-gray-600 border-gray-200';
  if (s === 'COMPLETED' || s === 'DONE') cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  else if (s === 'BLOCKED' || s === 'FAILED' || s === 'OVERDUE') cls = 'bg-red-50 text-red-700 border-red-200';
  else if (s === 'IN_PROGRESS' || s === 'PENDING' || s === 'WAITING_APPROVAL' || s === 'NOT_STARTED') cls = 'bg-amber-50 text-amber-700 border-amber-200';
  else if (s === 'SKIPPED' || s === 'NOT_APPLICABLE' || s === 'CANCELLED' || s === 'RESCINDED' || s === 'NO_SHOW') cls = 'bg-gray-100 text-gray-500 border-gray-200';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status || '—'}
    </span>
  );
}

// ─── Journey card ────────────────────────────────────────────────────────────
function JourneyCard({ journey, onOpen }) {
  const open = totalOpenBlockers(journey);
  const overdue = (journey.tasks || []).filter(isOverdue).length;
  return (
    <button
      type="button"
      onClick={() => onOpen(journey)}
      className="w-full text-left rounded-xl border border-gray-200 bg-white p-3 hover:border-gray-300 hover:shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)]"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-gray-900 text-sm truncate">{journeyName(journey)}</span>
        <StatusPill status={journey.status} />
      </div>
      <p className="text-xs text-gray-500 mt-0.5 truncate">{journeyRole(journey)}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-gray-500">Join {journey.joinDate ? formatAdminDate(journey.joinDate) : '—'}</span>
        {open > 0 ? (
          <span className="inline-flex items-center rounded-full bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5">
            {open} blocking
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5">
            clear
          </span>
        )}
        {overdue > 0 && (
          <span className="inline-flex items-center rounded-full bg-red-50 text-red-700 border border-red-200 px-1.5 py-0.5">
            {overdue} overdue
          </span>
        )}
      </div>
      <p className="mt-1 text-[11px] text-gray-400 font-mono">{journey.code}</p>
    </button>
  );
}

// ─── Task row (complete / skip) ──────────────────────────────────────────────
function TaskRow({ task, canAct, busy, onComplete, onSkip }) {
  const terminal = TERMINAL_TASK.has(task.status);
  const overdue = isOverdue(task);
  return (
    <li className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900">{task.title}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
          <span className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">{task.ownerRole}</span>
          {task.isBlocking && <span className="text-amber-600">blocking</span>}
          {task.dueDate && (
            <span className={overdue ? 'text-red-600 font-medium' : ''}>
              due {formatAdminDate(task.dueDate)}
            </span>
          )}
          {task.skippedReason && <span className="italic text-gray-400">skipped: {task.skippedReason}</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <StatusPill status={task.status} />
        {canAct && !terminal && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => onComplete(task)}
              className="px-2 py-1 text-[11px] font-medium border border-emerald-300 text-emerald-700 rounded-md hover:bg-emerald-50 disabled:opacity-40"
            >
              Complete
            </button>
            {!task.isMandatory && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onSkip(task)}
                className="px-2 py-1 text-[11px] font-medium border border-gray-300 text-gray-600 rounded-md hover:bg-gray-50 disabled:opacity-40"
              >
                Skip
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

// ─── Journey detail drawer ───────────────────────────────────────────────────
function JourneyDrawer({ journeyId, canManage, onClose, onChanged }) {
  const [journey, setJourney] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''); // friendly success/info banner
  const [skipping, setSkipping] = useState(null); // task pending a skip reason
  const [skipReason, setSkipReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const j = await get(`/api/hr/onboarding/journeys/${journeyId}`);
      setJourney(j);
    } catch (e) {
      // Out-of-scope subjects resolve to 404 server-side — show "not found".
      setError(e.status === 404 ? 'This journey was not found (it may be outside your team).' : (e.data?.message || e.message || 'Failed to load journey.'));
      setJourney(null);
    } finally {
      setLoading(false);
    }
  }, [journeyId]);

  useEffect(() => { load(); }, [load]);

  const blockers = journey ? currentStageBlockers(journey) : [];
  const canAdvance = journey && !TERMINAL_STATUS.has(journey.status) && blockers.length === 0;

  // Group tasks by stage in the canonical onboarding order for the checklist.
  const grouped = useMemo(() => {
    const tasks = (journey?.tasks) || [];
    const order = STAGE_COLUMNS.map((s) => s.key);
    const byStage = new Map();
    for (const t of tasks) {
      if (!byStage.has(t.stageKey)) byStage.set(t.stageKey, []);
      byStage.get(t.stageKey).push(t);
    }
    const keys = [...byStage.keys()].sort((a, b) => {
      const ia = order.indexOf(a); const ib = order.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    return keys.map((k) => ({ stage: k, label: (STAGE_COLUMNS.find((s) => s.key === k) || {}).label || k, tasks: byStage.get(k) }));
  }, [journey]);

  async function act(fn, okMsg) {
    setBusy(true); setError(''); setNotice('');
    try {
      const out = await fn();
      if (okMsg) setNotice(typeof okMsg === 'function' ? okMsg(out) : okMsg);
      await load();
      onChanged && onChanged();
    } catch (e) {
      // Surface 409/403/422 with their server reason as a friendly message.
      const msg = e.data?.message || e.message || 'Action failed.';
      setError(e.data?.employeeId ? `${msg} (employee ${e.data.employeeId})` : msg);
    } finally {
      setBusy(false);
    }
  }

  function completeTask(task) {
    return act(() => post(`/api/hr/onboarding/tasks/${task.id}/complete`), 'Task completed.');
  }
  function confirmSkip() {
    const task = skipping;
    const reason = skipReason.trim();
    if (!reason) return;
    setSkipping(null); setSkipReason('');
    return act(() => post(`/api/hr/onboarding/tasks/${task.id}/skip`, { reason }), 'Task skipped.');
  }
  function advance() {
    return act(() => post(`/api/hr/onboarding/journeys/${journeyId}/advance`), (o) => `Advanced to ${o?.currentStage || 'next stage'}.`);
  }
  function provision() {
    return act(() => post(`/api/hr/onboarding/journeys/${journeyId}/provision`), (o) => `Provisioned employee ${o?.employee?.code || ''}.`);
  }
  function confirmProbation() {
    return act(() => post(`/api/hr/onboarding/journeys/${journeyId}/confirm-probation`), 'Probation confirmed — employee is now active.');
  }

  return (
    <Modal title={journey ? `${journeyName(journey)} · ${journey.code}` : 'Journey'} onClose={onClose} size="lg">
      {loading ? (
        <div className="py-10 flex justify-center"><Spinner /></div>
      ) : error && !journey ? (
        <ErrorBanner message={error} />
      ) : journey ? (
        <div className="space-y-4">
          {error && <ErrorBanner message={error} />}
          {notice && (
            <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{notice}</p>
          )}

          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div><dt className="text-xs text-gray-500">Stage</dt><dd className="font-medium text-gray-900">{(STAGE_COLUMNS.find((s) => s.key === journey.currentStage) || {}).label || journey.currentStage}</dd></div>
            <div><dt className="text-xs text-gray-500">Status</dt><dd><StatusPill status={journey.status} /></dd></div>
            <div><dt className="text-xs text-gray-500">Role</dt><dd className="text-gray-900">{journeyRole(journey)}</dd></div>
            <div><dt className="text-xs text-gray-500">Join date</dt><dd className="text-gray-900">{journey.joinDate ? formatAdminDate(journey.joinDate) : '—'}</dd></div>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 border-y border-gray-100 py-3">
            <span
              title={canAdvance ? 'Advance to the next stage' : `Blocked: ${blockers.length} blocking task(s) open at this stage`}
            >
              <PrimaryButton onClick={advance} loading={busy} disabled={!canAdvance}>
                Advance stage
              </PrimaryButton>
            </span>
            {canManage ? (
              <>
                {journey.currentStage === 'PROVISIONING' && !journey.employeeId && (
                  <button type="button" disabled={busy} onClick={provision} className="px-4 py-2 text-sm font-semibold border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40">
                    Provision employee
                  </button>
                )}
                {journey.employeeId && journey.currentStage === 'PROBATION' && (
                  <button type="button" disabled={busy} onClick={confirmProbation} className="px-4 py-2 text-sm font-semibold border border-emerald-300 text-emerald-700 rounded-lg hover:bg-emerald-50 disabled:opacity-40">
                    Confirm probation
                  </button>
                )}
                {journey.employeeId && (
                  <Link href={`/people/${journey.employeeId}`} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">
                    View employee
                  </Link>
                )}
              </>
            ) : (
              <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                <span aria-hidden="true">🔒 </span>Provisioning requires the canManageOnboarding permission.
              </span>
            )}
          </div>
          {!canAdvance && blockers.length > 0 && (
            <p className="text-xs text-amber-700">
              {blockers.length} blocking task(s) at the current stage must be completed or skipped before this hire can advance.
            </p>
          )}

          {/* Checklist grouped by stage */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-1">Checklist</h3>
            {grouped.length === 0 ? (
              <Empty text="No tasks on this journey." />
            ) : (
              <div className="space-y-3">
                {grouped.map((g) => (
                  <section key={g.stage} className="rounded-xl border border-gray-200">
                    <header className="px-3 py-2 border-b border-gray-100 bg-gray-50 rounded-t-xl flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{g.label}</span>
                      {g.stage === journey.currentStage && (
                        <span className="text-[10px] font-medium text-[color:var(--theme-primary)]">current</span>
                      )}
                    </header>
                    <ul className="px-3 divide-y divide-gray-50">
                      {g.tasks.map((t) => (
                        <TaskRow
                          key={t.id}
                          task={t}
                          // Task complete/skip is offered to everyone — the server
                          // enforces ownership/scope (a manager can only touch their
                          // own manager-owned tasks; otherwise it 404s and we surface
                          // a friendly message). Provision/confirm stay canManage-gated.
                          canAct
                          busy={busy}
                          onComplete={completeTask}
                          onSkip={(task) => { setSkipping(task); setSkipReason(''); }}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      <div className="mt-5">
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">
            Close
          </button>
        </ModalActions>
      </div>

      {/* Skip-reason sub-prompt */}
      {skipping && (
        <Modal title={`Skip "${skipping.title}"`} onClose={() => setSkipping(null)}>
          <p className="text-sm text-gray-600 mb-3">A skip reason is recorded on the task audit trail.</p>
          <TextArea label="Reason" value={skipReason} onChange={setSkipReason} rows={3} />
          <div className="mt-4">
            <ModalActions>
              <button type="button" onClick={() => setSkipping(null)} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              <PrimaryButton onClick={confirmSkip} disabled={!skipReason.trim()}>Skip task</PrimaryButton>
            </ModalActions>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function OnboardingPage() {
  const [journeys, setJourneys] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [scoped, setScoped] = useState(false); // manager (no manage-onboarding) → "your team" banner
  const [canManage, setCanManage] = useState(false); // canManageOnboarding → provision/confirm actions

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await get('/api/hr/onboarding/journeys', { pageSize: 200 });
      setJourneys(Array.isArray(res?.items) ? res.items : []);
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to load the pipeline.');
      setJourneys([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Resolve the operator's band so a Manager (non-ALL) sees the "your team"
    // banner. The pipeline itself is server-scoped regardless.
    get('/api/auth/me')
      .then((me) => {
        const session = me?.user || me;
        const perms = permissionsFromSession(session);
        // canManageOnboarding gates the provision/confirm-probation actions. A user
        // without it (a Manager acting on their sub-tree) sees the "your team"
        // banner and a read-only provisioning note; they can still complete the
        // manager-owned tasks the server lets them touch.
        setCanManage(hasPermission(perms, 'canManageOnboarding'));
        setScoped(!hasPermission(perms, 'canManageOnboarding'));
      })
      .catch(() => {
        // Session not resolved → allow-all (matches hasPermission's null posture);
        // the server still enforces every action.
        setCanManage(true);
        setScoped(false);
      });
  }, [load]);

  // Bucket journeys into stage columns; terminal journeys collapse into Completed.
  const columns = useMemo(() => {
    const cols = [...STAGE_COLUMNS, DONE_COLUMN].map((c) => ({ ...c, items: [] }));
    const byKey = new Map(cols.map((c) => [c.key, c]));
    for (const j of journeys || []) {
      if (TERMINAL_STATUS.has(j.status)) { byKey.get(DONE_COLUMN.key).items.push(j); continue; }
      const target = byKey.get(j.currentStage) || byKey.get(DONE_COLUMN.key);
      target.items.push(j);
    }
    return cols;
  }, [journeys]);

  const total = journeys?.length || 0;

  return (
    <div>
      <PageHeader
        title="Onboarding"
        subtitle={`${total} ${total === 1 ? 'hire' : 'hires'} in the pipeline`}
        actions={
          <Link href="/people" className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 inline-flex items-center">
            ← People
          </Link>
        }
      />

      {scoped && (
        <p className="mb-4 text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
          Showing onboarding for your team only. HR sees the whole tenant.
        </p>
      )}

      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}

      {loading ? (
        <div className="py-16 flex justify-center"><Spinner /></div>
      ) : total === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white py-16 text-center">
          <p className="text-sm font-medium text-gray-700">No onboarding journeys yet.</p>
          <p className="text-sm text-gray-500 mt-1">A journey is created automatically when a candidate accepts an offer.</p>
        </div>
      ) : (
        <div className="overflow-x-auto pb-2">
          <ol className="flex gap-3 min-w-max" aria-label="Onboarding pipeline stages">
            {columns.map((col) => (
              <li key={col.key} className="w-64 shrink-0">
                <div className="flex items-center justify-between mb-2 px-1">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{col.label}</h2>
                  <span className="text-xs text-gray-400">{col.items.length}</span>
                </div>
                <div className="rounded-2xl border border-gray-200 bg-gray-50/60 p-2 min-h-[8rem] space-y-2">
                  {col.items.length === 0 ? (
                    <p className="text-xs text-gray-400 text-center py-6">—</p>
                  ) : (
                    col.items.map((j) => <JourneyCard key={j.id} journey={j} onOpen={(jj) => setOpenId(jj.id)} />)
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {openId && (
        <JourneyDrawer
          journeyId={openId}
          canManage={!scoped}
          onClose={() => setOpenId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
