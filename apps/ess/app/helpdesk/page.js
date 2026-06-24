'use client';

// Help & Support — HR Helpdesk Employee Self-Service (Cycle 1).
//
// SELF-SERVICE SURFACE: every call hits the customer-session /api/hr/me/helpdesk/*
// endpoints, which resolve the employee SERVER-SIDE from the session. The page NEVER
// sends an employeeId — a cross-employee read/write is structurally impossible.
//   Reference : GET  /api/hr/me/helpdesk/reference   (categories + priorities)
//   Mine      : GET  /api/hr/me/helpdesk/tickets
//   Raise     : POST /api/hr/me/helpdesk/tickets      { subject, description, priority, categoryId }
//   Detail    : GET  /api/hr/me/helpdesk/tickets/:id  (public thread; internal HR notes hidden)
//   Reply     : POST /api/hr/me/helpdesk/tickets/:id/reply   { body }
//   Reopen    : POST /api/hr/me/helpdesk/tickets/:id/reopen  { reason }
//   Rate      : POST /api/hr/me/helpdesk/tickets/:id/rate    { rating, comment }  (closes it)

import { useState } from 'react';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { apiPost } from '@/lib/api';
import InfoTip, { FieldLabel } from '@/components/InfoTip';

const PRIORITY_LABEL = { URGENT: 'Urgent', HIGH: 'High', NORMAL: 'Normal', LOW: 'Low' };

function fmtDateTime(v) {
  if (!v) return '';
  try { return new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(v); }
}

function StatusPill({ status }) {
  const s = String(status || '').toUpperCase();
  const map = {
    OPEN: 'bg-amber-100 text-amber-800',
    IN_PROGRESS: 'bg-blue-100 text-blue-800',
    WAITING_ON_EMPLOYEE: 'bg-purple-100 text-purple-800',
    RESOLVED: 'bg-emerald-100 text-emerald-800',
    CLOSED: 'bg-gray-100 text-gray-600',
    REOPENED: 'bg-orange-100 text-orange-800',
    CANCELLED: 'bg-gray-100 text-gray-400',
  };
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${map[s] || 'bg-gray-100 text-gray-700'}`}>{(status || '—').replace(/_/g, ' ')}</span>;
}

function PriorityPill({ priority }) {
  const p = String(priority || '').toUpperCase();
  const map = { URGENT: 'bg-red-100 text-red-800', HIGH: 'bg-amber-100 text-amber-800', NORMAL: 'bg-gray-100 text-gray-700', LOW: 'bg-blue-100 text-blue-800' };
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${map[p] || 'bg-gray-100 text-gray-700'}`}>{PRIORITY_LABEL[p] || priority}</span>;
}

export default function HelpdeskPage() {
  return (
    <AppShell>
      <Inner />
    </AppShell>
  );
}

function Inner() {
  const { data: ref } = useApi('/api/hr/me/helpdesk/reference');
  const { data: mine, loading, error, reload } = useApi('/api/hr/me/helpdesk/tickets');
  const [openId, setOpenId] = useState(null);

  const categories = ref?.categories || [];
  const priorities = ref?.priorities || ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
  const tickets = mine?.items || [];

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-1">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Help &amp; Support</h1>
        <p className="text-sm text-gray-500">Raise a request with HR and track it through to resolution.</p>
      </div>

      <RaiseTicket categories={categories} priorities={priorities} onCreated={() => reload()} />

      <section className="space-y-2">
        <h2 className="flex items-center text-sm font-semibold text-gray-700">My tickets<InfoTip text="Every request you have raised, newest first. Open one to read HR's replies and respond." /></h2>
        {error && <ErrorBanner message={error.message || 'Could not load your tickets.'} />}
        {loading ? <Centered><Spinner /></Centered> : tickets.length === 0 ? (
          <Empty text="You have not raised any tickets yet." />
        ) : (
          <ul className="space-y-2">
            {tickets.map((t) => (
              <li key={t.id} className="rounded-xl border border-gray-200 bg-white">
                <button onClick={() => setOpenId(openId === t.id ? null : t.id)} className="flex w-full items-center justify-between gap-3 p-3 text-left">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900">{t.code}</span>
                      <StatusPill status={t.status} />
                      <PriorityPill priority={t.priority} />
                      {t.breached && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">SLA breached</span>}
                    </div>
                    <div className="truncate text-sm text-gray-600">{t.subject}</div>
                    <div className="text-xs text-gray-400">{t.category?.name ? `${t.category.name} · ` : ''}raised {fmtDateTime(t.createdAt)}</div>
                  </div>
                  <span className="text-gray-400">{openId === t.id ? '▲' : '▼'}</span>
                </button>
                {openId === t.id && <TicketDetail id={t.id} onChanged={reload} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ── Raise ticket form ────────────────────────────────────────────────────────────
function RaiseTicket({ categories, priorities, onCreated }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const [categoryId, setCategoryId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [ok, setOk] = useState('');

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true); setError(null); setOk('');
    try {
      const t = await apiPost('/api/hr/me/helpdesk/tickets', { subject: subject.trim(), description: description.trim() || undefined, priority, categoryId: categoryId || undefined });
      setOk(`Raised ${t.code}. HR will respond shortly.`);
      setSubject(''); setDescription(''); setPriority('NORMAL'); setCategoryId('');
      setOpen(false);
      onCreated?.();
    } catch (err) {
      setError(err.message || 'Could not raise the ticket.');
    } finally {
      setSubmitting(false);
    }
  }

  const field = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm';

  if (!open) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-3">
        {ok && <div className="mb-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{ok}</div>}
        <button onClick={() => { setOpen(true); setOk(''); }} className="rounded-lg bg-[var(--theme-primary,#4f46e5)] px-4 py-2 text-sm font-medium text-white">+ Raise a ticket</button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
      {error && <ErrorBanner message={error} />}
      <div>
        <FieldLabel tip="A short summary of your issue (e.g. 'HRA missing from payslip').">Subject</FieldLabel>
        <input className={field} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} required placeholder="What do you need help with?" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel tip="The HR area your request belongs to. Each category may carry its own response SLA.">Category</FieldLabel>
          <select className={field} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">General</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel tip="How urgent is this? Urgent/High requests carry the tightest response SLA.">Priority</FieldLabel>
          <select className={field} value={priority} onChange={(e) => setPriority(e.target.value)}>
            {priorities.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p] || p}</option>)}
          </select>
        </div>
      </div>
      <div>
        <FieldLabel tip="Describe the issue in detail — dates, amounts, and anything HR needs to act.">Details</FieldLabel>
        <textarea className={field} rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Add any details that will help HR resolve this…" />
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={submitting || !subject.trim()} className="rounded-lg bg-[var(--theme-primary,#4f46e5)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{submitting ? 'Submitting…' : 'Submit ticket'}</button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">Cancel</button>
      </div>
    </form>
  );
}

// ── Ticket detail: thread + reply + reopen + rate ────────────────────────────────
function TicketDetail({ id, onChanged }) {
  const { data: ticket, loading, error, reload } = useApi(`/api/hr/me/helpdesk/tickets/${id}`);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState(null);
  const [rating, setRating] = useState(0);
  const [ratingComment, setRatingComment] = useState('');

  async function act(fn, after) {
    setBusy(true); setActErr(null);
    try { await fn(); after?.(); reload(); onChanged?.(); }
    catch (e) { setActErr(e.message || 'Action failed.'); }
    finally { setBusy(false); }
  }
  const sendReply = () => act(() => apiPost(`/api/hr/me/helpdesk/tickets/${id}/reply`, { body: reply.trim() }), () => setReply(''));
  const reopen = () => act(() => apiPost(`/api/hr/me/helpdesk/tickets/${id}/reopen`, {}));
  const rate = () => act(() => apiPost(`/api/hr/me/helpdesk/tickets/${id}/rate`, { rating, comment: ratingComment.trim() || undefined }), () => { setRating(0); setRatingComment(''); });

  if (loading) return <div className="border-t border-gray-100 p-3"><Spinner small /></div>;
  if (error || !ticket) return <div className="border-t border-gray-100 p-3"><ErrorBanner message="Could not load this ticket." /></div>;

  const canReply = !['CLOSED', 'CANCELLED'].includes(ticket.status);
  const canReopen = ['RESOLVED', 'CLOSED'].includes(ticket.status);
  const canRate = ['RESOLVED', 'CLOSED'].includes(ticket.status) && ticket.satisfactionRating == null;

  return (
    <div className="space-y-3 border-t border-gray-100 p-3">
      {actErr && <ErrorBanner message={actErr} />}

      {/* Thread (internal HR notes are never returned by the server) */}
      <div className="space-y-2">
        {ticket.description && (
          <div className="rounded-lg bg-gray-50 p-2 text-sm">
            <div className="text-xs text-gray-400">You · {fmtDateTime(ticket.createdAt)}</div>
            <div className="whitespace-pre-wrap text-gray-800">{ticket.description}</div>
          </div>
        )}
        {(ticket.messages || []).map((m) => (
          <div key={m.id} className="rounded-lg border border-gray-100 bg-white p-2 text-sm">
            <div className="text-xs text-gray-400">{fmtDateTime(m.createdAt)}</div>
            <div className="whitespace-pre-wrap text-gray-800">{m.body}</div>
          </div>
        ))}
        {(!ticket.messages || ticket.messages.length === 0) && !ticket.description && (
          <div className="py-2 text-center text-sm text-gray-400">No messages yet.</div>
        )}
      </div>

      {/* Reply */}
      {canReply && (
        <div className="space-y-2">
          <textarea className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply to HR…" />
          <button onClick={sendReply} disabled={busy || !reply.trim()} className="rounded-lg bg-[var(--theme-primary,#4f46e5)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Send reply</button>
        </div>
      )}

      {/* Reopen */}
      {canReopen && (
        <button onClick={reopen} disabled={busy} className="rounded-lg border border-orange-300 px-3 py-1.5 text-sm font-medium text-orange-700 hover:bg-orange-50 disabled:opacity-50">
          Reopen <InfoTip text="If the issue is not actually resolved, reopen the ticket so HR picks it back up." />
        </button>
      )}

      {/* Existing rating */}
      {ticket.satisfactionRating != null && (
        <div className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-800">
          You rated this {'★'.repeat(ticket.satisfactionRating)}{'☆'.repeat(5 - ticket.satisfactionRating)}{ticket.satisfactionComment ? ` — “${ticket.satisfactionComment}”` : ''}
        </div>
      )}

      {/* Rate (closes the ticket) */}
      {canRate && (
        <div className="space-y-2 rounded-lg border border-gray-100 bg-gray-50 p-2">
          <div className="flex items-center text-sm font-medium text-gray-700">Rate this resolution<InfoTip text="Tell HR how satisfied you are. Rating a resolved ticket closes it." /></div>
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" onClick={() => setRating(n)} className={`text-2xl leading-none ${n <= rating ? 'text-amber-400' : 'text-gray-300'}`} aria-label={`${n} star${n > 1 ? 's' : ''}`}>★</button>
            ))}
          </div>
          <textarea className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" rows={2} value={ratingComment} onChange={(e) => setRatingComment(e.target.value)} placeholder="Optional feedback…" />
          <button onClick={rate} disabled={busy || rating < 1} className="rounded-lg bg-[var(--theme-primary,#4f46e5)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Submit rating &amp; close</button>
        </div>
      )}
    </div>
  );
}
