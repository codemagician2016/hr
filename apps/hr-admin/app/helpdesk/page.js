'use client';

// HR Helpdesk — agent console (Cycle 1). Reads /api/hr/helpdesk/tickets (paginated
// {items,total}, tenant-walled; canManageHelpdesk). The queue filters by status /
// priority / category / assignee + a code/subject search, and shows live SLA badges
// (a breached ticket goes red). Click a row to open the detail drawer: the full
// message thread (incl. internal notes), a reply box (public reply OR internal note),
// assign, and the status lifecycle. Every field carries an ⓘ tooltip.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, Modal, ModalActions, PrimaryButton, TextArea, Spinner, formatAdminDateTime } from '@hr/ui';
import { get, post, patch } from '@/lib/api';
import { DataTable, PageHeader, ServerPagination, employeeLabel } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';

const PAGE_SIZES = [25, 50, 100];
const STATUS_OPTIONS = ['', 'OPEN', 'IN_PROGRESS', 'WAITING_ON_EMPLOYEE', 'RESOLVED', 'CLOSED', 'REOPENED', 'CANCELLED'];
const PRIORITY_OPTIONS = ['', 'URGENT', 'HIGH', 'NORMAL', 'LOW'];
// The status transitions an HR agent may apply, mirrored from helpdesk.service (the
// server is the real gate — this just offers the legal next steps).
const NEXT_STATUS = {
  OPEN: ['IN_PROGRESS', 'WAITING_ON_EMPLOYEE', 'RESOLVED', 'CANCELLED'],
  IN_PROGRESS: ['WAITING_ON_EMPLOYEE', 'RESOLVED', 'CANCELLED'],
  WAITING_ON_EMPLOYEE: ['IN_PROGRESS', 'RESOLVED', 'CANCELLED'],
  RESOLVED: ['CLOSED', 'REOPENED'],
  REOPENED: ['IN_PROGRESS', 'WAITING_ON_EMPLOYEE', 'RESOLVED', 'CANCELLED'],
  CLOSED: ['REOPENED'],
  CANCELLED: [],
};

function TicketStatusPill({ status }) {
  const s = String(status || '').toUpperCase();
  const map = {
    OPEN: 'bg-amber-50 text-amber-700 border-amber-200',
    IN_PROGRESS: 'bg-blue-50 text-blue-700 border-blue-200',
    WAITING_ON_EMPLOYEE: 'bg-purple-50 text-purple-700 border-purple-200',
    RESOLVED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    CLOSED: 'bg-gray-100 text-gray-600 border-gray-200',
    REOPENED: 'bg-orange-50 text-orange-700 border-orange-200',
    CANCELLED: 'bg-gray-100 text-gray-400 border-gray-200',
  };
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${map[s] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>{(status || '—').replace(/_/g, ' ')}</span>;
}

function PriorityPill({ priority }) {
  const p = String(priority || '').toUpperCase();
  const map = {
    URGENT: 'bg-red-50 text-red-700 border-red-200',
    HIGH: 'bg-amber-50 text-amber-700 border-amber-200',
    NORMAL: 'bg-gray-50 text-gray-600 border-gray-200',
    LOW: 'bg-blue-50 text-blue-700 border-blue-200',
  };
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${map[p] || 'bg-gray-50 text-gray-600 border-gray-200'}`}>{priority || '—'}</span>;
}

function SlaCell({ ticket }) {
  if (!ticket.slaDueAt) return <span className="text-xs text-gray-400">—</span>;
  if (ticket.breached) return <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 border border-red-200">SLA breached</span>;
  return <span className="text-xs text-gray-500" title={formatAdminDateTime(ticket.slaDueAt)}>due {formatAdminDateTime(ticket.slaDueAt)}</span>;
}

export default function HelpdeskPage() {
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [assignee, setAssignee] = useState(''); // '', 'UNASSIGNED', or a userId
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [categories, setCategories] = useState([]);
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/helpdesk/tickets', { status, priority, categoryId, assigneeId: assignee, q, page, pageSize })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    get('/api/hr/helpdesk/tickets/stats').then(setStats).catch(() => {});
  }, [status, priority, categoryId, assignee, q, page, pageSize]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    get('/api/hr/helpdesk/categories', { activeOnly: 'true' }).then((r) => setCategories(r.items || [])).catch(() => {});
    // The tenant's helpdesk-capable operators — powers the assignee filter + the drawer
    // assignee picker (so a ticket can be routed to any teammate, not just self).
    get('/api/hr/helpdesk/agents').then((r) => setAgents(r.items || [])).catch(() => {});
  }, []);

  // Reset to page 1 whenever a filter changes.
  useEffect(() => { setPage(1); }, [status, priority, categoryId, assignee, q]);

  const columns = [
    { key: 'code', header: 'Ticket', render: (t) => (
      <div>
        <button onClick={() => setOpenId(t.id)} className="font-medium text-gray-900 hover:underline">{t.code}</button>
        <div className="max-w-[22rem] truncate text-xs text-gray-500">{t.subject}</div>
      </div>
    ) },
    { key: 'employee', header: 'Requester', render: (t) => <span className="text-gray-700">{employeeLabel(t)}</span> },
    { key: 'category', header: 'Category', render: (t) => <span className="text-gray-500">{t.category?.name || '—'}</span> },
    { key: 'priority', header: 'Priority', render: (t) => <PriorityPill priority={t.priority} /> },
    { key: 'status', header: 'Status', render: (t) => <TicketStatusPill status={t.status} /> },
    { key: 'sla', header: 'SLA', render: (t) => <SlaCell ticket={t} /> },
    { key: 'createdAt', header: 'Raised', render: (t) => <span className="text-xs text-gray-500">{formatAdminDateTime(t.createdAt)}</span> },
  ];

  const sel = 'rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm';

  return (
    <div className="space-y-4">
      <PageHeader
        title="Helpdesk"
        subtitle="HR support ticket queue — assign, respond, and resolve employee cases against SLA."
        actions={<HelpdeskInfo />}
      />

      {stats && (
        <div className="flex flex-wrap gap-2 text-xs">
          {['OPEN', 'IN_PROGRESS', 'WAITING_ON_EMPLOYEE', 'RESOLVED'].map((s) => (
            <span key={s} className="rounded-full border border-gray-200 bg-white px-3 py-1 text-gray-600">
              {s.replace(/_/g, ' ')}: <span className="font-semibold text-gray-900">{stats.byStatus?.[s] || 0}</span>
            </span>
          ))}
          {stats.breached > 0 && (
            <span className="rounded-full border border-red-200 bg-red-50 px-3 py-1 text-red-700">SLA breached: <span className="font-semibold">{stats.breached}</span></span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1 text-sm text-gray-600">Status<InfoTip text="Filter the queue by ticket lifecycle state." />
          <select className={sel} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s ? s.replace(/_/g, ' ') : 'All'}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1 text-sm text-gray-600">Priority<InfoTip text="Urgent/High tickets carry the tightest SLA." />
          <select className={sel} value={priority} onChange={(e) => setPriority(e.target.value)}>
            {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{p || 'All'}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1 text-sm text-gray-600">Category<InfoTip text="The HR area the ticket belongs to (each can carry its own SLA)." />
          <select className={sel} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1 text-sm text-gray-600">Assignee<InfoTip text="Filter by the agent who owns the ticket. 'Unassigned' shows the tickets waiting for pickup." />
          <select className={sel} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">All</option>
            <option value="UNASSIGNED">Unassigned</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name || a.email}</option>)}
          </select>
        </label>
        <input className={`${sel} min-w-[12rem]`} placeholder="Search code or subject…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {error && <ErrorBanner message={error} />}

      <DataTable columns={columns} rows={data?.items || []} loading={loading} emptyText="No tickets match these filters." rowKey={(t) => t.id} />

      <ServerPagination
        page={page} pageSize={pageSize} total={data?.total || 0}
        onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        sizes={PAGE_SIZES} noun="tickets"
      />

      {openId && <TicketDrawer id={openId} agents={agents} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

function HelpdeskInfo() {
  return (
    <span className="inline-flex items-center text-sm text-gray-500">
      How it works
      <InfoTip text="Employees raise tickets from their portal. Assign one to yourself (or a teammate), reply (or add an internal note only HR sees), and move it through OPEN → IN PROGRESS → WAITING → RESOLVED → CLOSED. The employee rates it on close." />
    </span>
  );
}

// ── Detail drawer: thread + reply + assign + status ──────────────────────────────
function TicketDrawer({ id, agents = [], onClose, onChanged }) {
  const [ticket, setTicket] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [me, setMe] = useState(null);

  const reload = useCallback(() => {
    get(`/api/hr/helpdesk/tickets/${id}`).then(setTicket).catch((e) => setError(e.message));
  }, [id]);
  useEffect(() => { reload(); }, [reload]);
  // /api/auth/me nests the operator under `.user` ({ user: { id, ... } }) — unwrap it
  // so me.id is the real operator userId. Without this, assignToMe sent assigneeId:
  // undefined → null, which the backend reads as UNASSIGN (so "Assign to me" un-picked
  // the ticket instead of picking it up), and the "You" label never matched.
  useEffect(() => { get('/api/auth/me').then((r) => setMe(r?.user || r)).catch(() => {}); }, []);

  async function doAction(fn, okThen) {
    setBusy(true); setError('');
    try { await fn(); if (okThen) okThen(); reload(); onChanged?.(); }
    catch (e) { setError(e.data?.message || e.message); }
    finally { setBusy(false); }
  }

  const sendReply = () => doAction(
    () => post(`/api/hr/helpdesk/tickets/${id}/reply`, { body: reply.trim(), isInternal }),
    () => { setReply(''); setIsInternal(false); }
  );
  const assignToMe = () => doAction(() => post(`/api/hr/helpdesk/tickets/${id}/assign`, { assigneeId: me?.id || null }));
  const assignTo = (assigneeId) => doAction(() => post(`/api/hr/helpdesk/tickets/${id}/assign`, { assigneeId: assigneeId || null }));
  const unassign = () => doAction(() => post(`/api/hr/helpdesk/tickets/${id}/assign`, { assigneeId: null }));
  const changeStatus = (to) => doAction(() => post(`/api/hr/helpdesk/tickets/${id}/status`, { status: to }));

  // Resolve an assignee userId to a human label (so an assigned ticket shows a name,
  // not a raw UUID). 'You' for the current operator; falls back to the id if unknown.
  const agentName = (uid) => {
    if (!uid) return 'Unassigned';
    if (uid === me?.id) return 'You';
    const a = agents.find((x) => x.id === uid);
    return a ? (a.name || a.email) : uid;
  };

  const nextStates = ticket ? (NEXT_STATUS[ticket.status] || []) : [];

  return (
    <Modal title={ticket ? `${ticket.code} · ${ticket.subject}` : 'Ticket'} onClose={onClose} size="lg">
      {!ticket ? <div className="py-8"><Spinner /></div> : (
        <div className="space-y-4">
          {error && <ErrorBanner message={error} />}

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <TicketStatusPill status={ticket.status} />
            <PriorityPill priority={ticket.priority} />
            {ticket.category?.name && <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-600">{ticket.category.name}</span>}
            <span className="text-gray-500">Requester: <span className="text-gray-800">{employeeLabel(ticket)}</span></span>
            <SlaCell ticket={ticket} />
          </div>

          {/* Assign + status actions */}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 p-2">
            <span className="text-xs font-medium text-gray-500">Assignee<InfoTip text="Pick the ticket up yourself, or route it to a teammate. Assigning an OPEN ticket moves it to IN PROGRESS." /></span>
            <span className="text-xs text-gray-700">{agentName(ticket.assigneeId)}</span>
            <button onClick={assignToMe} disabled={busy} className="rounded-md border border-gray-300 px-2 py-0.5 text-xs hover:bg-white disabled:opacity-40">Assign to me</button>
            {agents.length > 0 && (
              <select
                value={agents.some((a) => a.id === ticket.assigneeId) ? ticket.assigneeId : ''}
                onChange={(e) => assignTo(e.target.value)}
                disabled={busy}
                className="rounded-md border border-gray-300 bg-white px-2 py-0.5 text-xs disabled:opacity-40"
                aria-label="Assign to a teammate"
              >
                <option value="">Assign to…</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.id === me?.id ? `${a.name || a.email} (you)` : (a.name || a.email)}</option>)}
              </select>
            )}
            {ticket.assigneeId && <button onClick={unassign} disabled={busy} className="rounded-md border border-gray-300 px-2 py-0.5 text-xs hover:bg-white disabled:opacity-40">Unassign</button>}
            <span className="ml-3 text-xs font-medium text-gray-500">Move to<InfoTip text="The lifecycle is enforced server-side; only legal next steps are offered." /></span>
            {nextStates.length === 0 ? <span className="text-xs text-gray-400">terminal</span> : nextStates.map((s) => (
              <button key={s} onClick={() => changeStatus(s)} disabled={busy} className="rounded-md border border-gray-300 px-2 py-0.5 text-xs hover:bg-white disabled:opacity-40">{s.replace(/_/g, ' ')}</button>
            ))}
          </div>

          {ticket.satisfactionRating != null && (
            <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-2 text-sm text-emerald-800">
              Satisfaction: {'★'.repeat(ticket.satisfactionRating)}{'☆'.repeat(5 - ticket.satisfactionRating)} {ticket.satisfactionComment ? `— “${ticket.satisfactionComment}”` : ''}
            </div>
          )}

          {/* Thread */}
          <div className="max-h-72 space-y-2 overflow-y-auto rounded-lg border border-gray-100 p-2">
            {ticket.description && (
              <div className="rounded-lg bg-gray-50 p-2 text-sm">
                <div className="text-xs text-gray-400">{employeeLabel(ticket)} · {formatAdminDateTime(ticket.createdAt)}</div>
                <div className="whitespace-pre-wrap text-gray-800">{ticket.description}</div>
              </div>
            )}
            {(ticket.messages || []).map((m) => (
              <div key={m.id} className={`rounded-lg p-2 text-sm ${m.isInternal ? 'border border-amber-200 bg-amber-50' : 'bg-white border border-gray-100'}`}>
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <span>{formatAdminDateTime(m.createdAt)}</span>
                  {m.isInternal && <span className="rounded-full bg-amber-200 px-1.5 text-[10px] font-medium text-amber-800">INTERNAL NOTE</span>}
                </div>
                <div className="whitespace-pre-wrap text-gray-800">{m.body}</div>
              </div>
            ))}
            {(!ticket.messages || ticket.messages.length === 0) && !ticket.description && (
              <div className="py-4 text-center text-sm text-gray-400">No messages yet.</div>
            )}
          </div>

          {/* Reply box */}
          <div className="space-y-2">
            <TextArea label="Reply" value={reply} onChange={setReply} rows={3} hint="Visible to the employee unless you mark it as an internal note." />
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={isInternal} onChange={(e) => setIsInternal(e.target.checked)} />
              Internal note (HR-only)
              <InfoTip text="Internal notes are never shown to the employee — use them for handoffs or context." />
            </label>
            <ModalActions>
              <PrimaryButton onClick={sendReply} loading={busy} disabled={!reply.trim()}>{isInternal ? 'Add internal note' : 'Send reply'}</PrimaryButton>
            </ModalActions>
          </div>
        </div>
      )}
    </Modal>
  );
}
