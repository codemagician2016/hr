'use client';

// Feature 10 slice 10e (ESS) — unified Approvals inbox.
//
// Everything awaiting ME, across all modules, newest first: a type icon, a one-
// line plain-language payload, age + SLA countdown, and inline Approve / Decline /
// Ask-for-changes with an optional note. Delegated items show "On behalf of …".
// A "Delegate while I'm away" panel lets the employee hand approvals to a stand-in
// for a date window. ⓘ tooltips + pagination per the owner's standing rules.
//
// Data: GET /api/hr/me/approvals (customer session; the caller's portal user is
// resolved server-side) and POST /api/hr/me/approvals/:id/decide.

import { useCallback, useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Spinner, ErrorBanner, Empty } from '@hr/ui';
import { fetchMyApprovals, decideApproval } from '@/lib/api';
import {
  InfoTip, usePagination, Pagination, moduleMeta, payloadLine, slaInfo, ageText,
} from '@/lib/approvals';
import DelegatePanel from './DelegatePanel';

function Icon({ d }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function SlaPill({ slaDueAt }) {
  const { text, tone } = slaInfo(slaDueAt);
  const cls =
    tone === 'over' ? 'bg-red-50 text-red-700 border-red-200'
    : tone === 'warn' ? 'bg-amber-50 text-amber-700 border-amber-200'
    : 'bg-gray-50 text-gray-500 border-gray-200';
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>{text}</span>;
}

const DECISIONS = [
  { key: 'APPROVED', label: 'Approve', tone: 'positive' },
  { key: 'REQUESTED_CHANGES', label: 'Ask for changes', tone: 'neutral' },
  { key: 'REJECTED', label: 'Decline', tone: 'danger' },
];

function ApprovalRow({ item, onDecided }) {
  const meta = moduleMeta(item.module);
  const [acting, setActing] = useState(null); // decision key in flight
  const [noteFor, setNoteFor] = useState(null); // decision awaiting a note
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(null); // final status text after acting

  async function decide(decision) {
    setActing(decision);
    setError('');
    try {
      const res = await decideApproval(item.id, { decision, comment: note || undefined });
      const label =
        decision === 'APPROVED' ? (res.terminal ? 'Approved' : 'Approved — moved to the next step')
        : decision === 'REJECTED' ? 'Declined'
        : 'Sent back for changes';
      setDone(label);
      onDecided?.(item.id);
    } catch (e) {
      setError(e.status === 403 ? 'You’re no longer an approver for this step.' : (e.message || 'Could not record your decision.'));
    } finally {
      setActing(null);
      setNoteFor(null);
    }
  }

  if (done) {
    return (
      <li className="rounded-2xl border bg-white p-4" style={{ borderColor: 'var(--theme-border)' }}>
        <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
          <span className="font-medium" style={{ color: 'var(--theme-text)' }}>{done}.</span> Thanks — this request has been updated.
        </p>
      </li>
    );
  }

  const tones = {
    positive: 'border-emerald-300 text-emerald-700 hover:bg-emerald-50',
    danger: 'border-red-300 text-red-700 hover:bg-red-50',
    neutral: 'border-gray-300 text-gray-700 hover:bg-gray-50',
  };

  return (
    <li className="rounded-2xl border bg-white p-4" style={{ borderColor: 'var(--theme-border)' }}>
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white" style={{ backgroundColor: 'var(--theme-primary)' }}>
          <Icon d={meta.icon} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>{meta.label}</span>
            <SlaPill slaDueAt={item.slaDueAt} />
            {Array.isArray(item.onBehalfOf) && item.onBehalfOf.length > 0 && (
              <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                On behalf of a colleague
              </span>
            )}
            <span className="text-xs" style={{ color: 'var(--theme-muted)' }}>{ageText(item.createdAt)}</span>
          </div>
          <p className="mt-0.5 truncate text-sm" style={{ color: 'var(--theme-muted)' }}>{payloadLine(item)}</p>

          {item.payload?.reason && (
            <p className="mt-1 text-xs italic" style={{ color: 'var(--theme-muted)' }}>“{item.payload.reason}”</p>
          )}

          {item.minApprovals > 1 && (
            <p className="mt-1 text-[11px]" style={{ color: 'var(--theme-muted)' }}>Needs {item.minApprovals} approvers at this step.</p>
          )}

          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

          {noteFor ? (
            <div className="mt-3">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder={noteFor === 'REQUESTED_CHANGES' ? 'What needs changing?' : 'Add a note (optional)…'}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                style={{ borderColor: 'var(--theme-border)' }}
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => decide(noteFor)}
                  disabled={!!acting}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  style={{ backgroundColor: 'var(--theme-primary)' }}
                >
                  {acting ? 'Saving…' : `Confirm — ${DECISIONS.find((d) => d.key === noteFor)?.label}`}
                </button>
                <button type="button" onClick={() => { setNoteFor(null); setNote(''); }} className="text-xs" style={{ color: 'var(--theme-muted)' }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {DECISIONS.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  disabled={!!acting}
                  onClick={() => (d.key === 'APPROVED' ? decide('APPROVED') : setNoteFor(d.key))}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${tones[d.tone]}`}
                >
                  {acting === d.key ? '…' : d.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function InboxInner() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [moduleFilter, setModuleFilter] = useState('');
  const [showDelegate, setShowDelegate] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetchMyApprovals();
      setItems(Array.isArray(res?.items) ? res.items : []);
    } catch (e) {
      setError(e.message || 'Failed to load your approvals.');
      setItems([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!items) return [];
    return moduleFilter ? items.filter((i) => i.module === moduleFilter) : items;
  }, [items, moduleFilter]);

  const pager = usePagination(filtered, { initialPageSize: 8 });
  const modulesPresent = useMemo(() => [...new Set((items || []).map((i) => i.module))], [items]);

  function removeFromList(id) {
    setItems((list) => (list || []).filter((i) => i.id !== id));
  }

  if (items === null) return <Spinner />;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>
            Approvals
            <InfoTip text="Everything across the company that’s waiting for your decision — leave, reimbursements, and more — in one place. Approve, decline, or ask for changes right here." />
          </h1>
          <p className="mt-0.5 text-sm" style={{ color: 'var(--theme-muted)' }}>
            {filtered.length === 0 ? 'You’re all caught up.' : `${filtered.length} waiting for you.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowDelegate(true)}
          className="rounded-lg border px-3 py-2 text-sm font-medium"
          style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
        >
          Going away? Delegate approvals
        </button>
      </div>

      {error && <ErrorBanner message={error} />}

      {modulesPresent.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setModuleFilter('')}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${moduleFilter === '' ? 'text-white' : ''}`}
            style={moduleFilter === '' ? { backgroundColor: 'var(--theme-primary)', borderColor: 'var(--theme-primary)' } : { borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
          >
            All
          </button>
          {modulesPresent.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setModuleFilter(m)}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${moduleFilter === m ? 'text-white' : ''}`}
              style={moduleFilter === m ? { backgroundColor: 'var(--theme-primary)', borderColor: 'var(--theme-primary)' } : { borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
            >
              {moduleMeta(m).label}
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <Empty text="Nothing is waiting for your approval right now." />
      ) : (
        <>
          <ul className="space-y-3">
            {pager.pageItems.map((item) => (
              <ApprovalRow key={item.id} item={item} onDecided={removeFromList} />
            ))}
          </ul>
          <Pagination pager={pager} />
        </>
      )}

      {showDelegate && <DelegatePanel onClose={() => setShowDelegate(false)} />}
    </div>
  );
}

export default function ApprovalsPage() {
  return (
    <AppShell>
      <InboxInner />
    </AppShell>
  );
}
