'use client';

// Employees list: search (q) + status filter + pagination against the
// paginated GET /api/hr/employees envelope {items,total,page,pageSize}.
// URL is the source of truth for q/status/page so links (from dashboard
// tiles) and back/forward work. @hr/ui has no Table primitive, so we render
// a styled <table> here and reuse Spinner/ErrorBanner/Empty/TextInput.

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Spinner, ErrorBanner, Empty, Modal, ModalActions, PrimaryButton } from '@hr/ui';
import { get, post } from '@/lib/api';
import { ServerPagination } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';
import ModuleGuide from '@/components/ModuleGuide';

const STATUSES = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'on_leave', label: 'On leave' },
  { value: 'terminated', label: 'Terminated' },
];

const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZES = [20, 50, 100];

// Backend stores the EmployeeStatus enum in UPPER_SNAKE (ACTIVE, ON_LEAVE…).
// Normalise before matching so badges/labels render regardless of casing.
function statusBadgeClass(status) {
  switch (String(status || '').toUpperCase()) {
    case 'ACTIVE':
      return 'bg-green-50 text-green-700 border-green-200';
    case 'PROBATION':
      return 'bg-blue-50 text-blue-700 border-blue-200';
    case 'ON_LEAVE':
      return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'NOTICE_PERIOD':
      return 'bg-orange-50 text-orange-700 border-orange-200';
    case 'SUSPENDED':
      return 'bg-red-50 text-red-700 border-red-200';
    case 'TERMINATED':
    case 'RETIRED':
      return 'bg-gray-100 text-gray-600 border-gray-200';
    default:
      return 'bg-gray-50 text-gray-600 border-gray-200';
  }
}

// "ON_LEAVE" → "On leave" — a human label from the enum.
function statusLabel(status) {
  if (!status) return 'Unknown';
  const s = String(status).replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Feature 4 — portal-access status pill (NOT_INVITED / INVITED / ACTIVE /
// EXPIRED / REVOKED) returned per employee by GET /api/hr/employees. ──
const PORTAL_META = {
  ACTIVE: { label: 'Active', cls: 'bg-green-50 text-green-700 border-green-200' },
  INVITED: { label: 'Invited', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  EXPIRED: { label: 'Invite expired', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  REVOKED: { label: 'Invite revoked', cls: 'bg-gray-100 text-gray-600 border-gray-200' },
  NOT_INVITED: { label: 'Not invited', cls: 'bg-gray-50 text-gray-500 border-gray-200' },
};
function portalMeta(state) {
  return PORTAL_META[String(state || 'NOT_INVITED').toUpperCase()] || PORTAL_META.NOT_INVITED;
}
// What action does this portal state offer? INVITED/EXPIRED/REVOKED/NOT_INVITED →
// "send/resend"; ACTIVE → only an explicit reset (handled separately).
function portalActionLabel(state) {
  const s = String(state || 'NOT_INVITED').toUpperCase();
  if (s === 'NOT_INVITED') return 'Send invite';
  if (s === 'ACTIVE') return 'Reset password';
  return 'Resend invite';
}

function PeopleInner() {
  const router = useRouter();
  const params = useSearchParams();

  const q = params.get('q') || '';
  const status = params.get('status') || '';
  const page = Math.max(1, parseInt(params.get('page') || '1', 10) || 1);
  const pageSize = PAGE_SIZES.includes(parseInt(params.get('pageSize') || '', 10))
    ? parseInt(params.get('pageSize'), 10)
    : DEFAULT_PAGE_SIZE;

  const [search, setSearch] = useState(q);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // Feature 4 — portal invite UI state.
  const [selected, setSelected] = useState(() => new Set()); // checkbox bulk-select
  const [inviteTarget, setInviteTarget] = useState(null); // single-row invite confirm { emp, isReset }
  const [bulkOpen, setBulkOpen] = useState(false); // bulk invite confirm
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState(null); // { msg, link? }
  const [copiedId, setCopiedId] = useState(null);
  // Per-employee fresh link + status overrides after an action (so the row
  // updates without a full refetch).
  const [linkById, setLinkById] = useState({}); // employeeId → copyable link
  const [statusOverride, setStatusOverride] = useState({}); // employeeId → portalStatus

  useEffect(() => {
    setSearch(q);
  }, [q]);

  // Reset transient selection/overrides whenever the page/filter changes.
  useEffect(() => {
    setSelected(new Set());
    setLinkById({});
    setStatusOverride({});
  }, [q, status, page, pageSize]);

  async function copyLink(employeeId, link) {
    if (!link) return;
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(link);
      else {
        const ta = document.createElement('textarea');
        ta.value = link; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      }
      setCopiedId(employeeId);
      setTimeout(() => setCopiedId((c) => (c === employeeId ? null : c)), 1800);
    } catch {
      setToast({ msg: 'Could not copy — select and copy the link manually.', link });
    }
  }

  async function sendSingleInvite(emp, isReset) {
    setSending(true);
    setError('');
    try {
      const res = await post(`/api/hr/employees/${emp.id}/invite`, isReset ? { reset: true } : {});
      setStatusOverride((m) => ({ ...m, [emp.id]: res.portalStatus || 'INVITED' }));
      if (res.link) setLinkById((m) => ({ ...m, [emp.id]: res.link }));
      const channelOk = res.notified && res.notified.ok;
      setToast({
        msg: channelOk
          ? `Invite sent to ${res.loginEmail || emp.workEmail}.`
          : `Invite created for ${res.loginEmail || emp.workEmail}. We couldn't send the email/WhatsApp — copy the link below and share it.`,
        link: res.link || null,
        employeeId: emp.id,
      });
      setInviteTarget(null);
    } catch (err) {
      setError(err.message || 'Could not send the invite.');
      setInviteTarget(null);
    } finally {
      setSending(false);
    }
  }

  async function sendBulkInvites() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setSending(true);
    setError('');
    try {
      const res = await post('/api/hr/employees/invite/bulk', { employeeIds: ids });
      const overrides = {};
      const links = {};
      for (const r of res.results || []) {
        if (r.ok) { overrides[r.employeeId] = 'INVITED'; if (r.link) links[r.employeeId] = r.link; }
      }
      setStatusOverride((m) => ({ ...m, ...overrides }));
      setLinkById((m) => ({ ...m, ...links }));
      const failed = (res.results || []).filter((r) => !r.ok).length;
      setToast({
        msg: `Sent ${res.sent} invite${res.sent === 1 ? '' : 's'}${failed ? `, ${failed} skipped (no work email / already active / out of scope)` : ''}.`,
      });
      setBulkOpen(false);
      setSelected(new Set());
    } catch (err) {
      setError(err.message || 'Could not send invites.');
      setBulkOpen(false);
    } finally {
      setSending(false);
    }
  }

  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    get('/api/hr/employees', { q, status, page, pageSize })
      .then((res) => {
        if (alive) setData(res);
      })
      .catch((err) => {
        if (alive) setError(err.message || 'Failed to load employees.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [q, status, page, pageSize]);

  function pushQuery(next) {
    const sp = new URLSearchParams();
    const merged = { q, status, page, pageSize, ...next };
    if (merged.q) sp.set('q', merged.q);
    if (merged.status) sp.set('status', merged.status);
    if (merged.page && merged.page > 1) sp.set('page', String(merged.page));
    if (merged.pageSize && merged.pageSize !== DEFAULT_PAGE_SIZE) sp.set('pageSize', String(merged.pageSize));
    router.push(`/people${sp.toString() ? `?${sp.toString()}` : ''}`);
  }

  const items = data?.items || [];
  const total = data?.total ?? items.length;

  const pageInfo = useMemo(() => {
    if (!total) return '0 employees';
    const from = (page - 1) * pageSize + 1;
    const to = Math.min(total, page * pageSize);
    return `${from}–${to} of ${total}`;
  }, [page, pageSize, total]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">People</h1>
          <p className="text-sm text-gray-500">{pageInfo}</p>
        </div>
        {/* FLAG (Feature 17): the default "Add employee" CTA is now the Onboard-by-CTC
            wizard (creates the person AND their pay in one step). The bare pay-less
            form stays as an explicit "Add without pay (advanced)" link. */}
        <div className="flex items-center gap-3">
          <Link href="/people/new" className="text-sm text-gray-500 hover:underline">Add without pay (advanced)</Link>
          <Link
            href="/people/onboard"
            className="px-4 py-2 text-white text-sm font-semibold rounded-lg"
            style={{ backgroundColor: 'var(--theme-primary)' }}
          >
            Add employee
          </Link>
        </div>
      </div>

      <ModuleGuide
        id="people"
        title="Find, onboard and give employees portal access"
        what="This is your master employee directory — every person on the payroll, searchable by name, code or email and filterable by status. From here you onboard new joiners and send each person their employee self-service portal login."
        steps={[
          'Search by name, employee code or email, or filter by status (Active, On leave, Terminated) to find a person.',
          'Click "Add employee" to onboard a new joiner with their CTC in one step, or use "Add without pay (advanced)" for a pay-less record.',
          'Click a name to open the full profile (pay, statutory IDs, documents).',
          'In the Portal column, use "Send invite" to email/WhatsApp a set-password link so the employee can log in.',
          'Tick the checkboxes and use "Send portal invites" to invite several people at once.',
        ]}
        example={<>You add <b>Aarav Sharma</b> (code <b>ACM-0142</b>) at Acme India Pvt Ltd on a <b>₹12,00,000 CTC</b> joining <b>June 2026</b>. He shows as <b>Active</b> with portal <b>Not invited</b>; you send the invite and he gets a link at his work email to set his password and view payslips.</>}
        tips={[
          'A person with no work email cannot be invited — add a work email on their profile first.',
          'Resending an invite invalidates the earlier link; if the email/WhatsApp fails, copy the link shown and share it manually.',
        ]}
      />

      <div className="flex flex-wrap gap-3 mb-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            pushQuery({ q: search.trim(), page: 1 });
          }}
          className="flex gap-2"
        >
          <label htmlFor="people-search" className="sr-only">
            Search employees by name, code, or email
          </label>
          <input
            id="people-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, code, email…"
            className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm w-72"
          />
          <button
            type="submit"
            className="px-4 py-2.5 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Search
          </button>
        </form>
        <label htmlFor="people-status" className="sr-only">
          Filter by status
        </label>
        <select
          id="people-status"
          value={status}
          onChange={(e) => pushQuery({ status: e.target.value, page: 1 })}
          className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm"
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {error && <ErrorBanner message={error} />}

      {/* Feature 4 — bulk portal invite bar (shown when rows are selected). */}
      {selected.size > 0 && (
        <div
          className="mb-3 flex items-center justify-between rounded-xl border px-4 py-2.5"
          style={{ borderColor: 'var(--theme-primary)', background: 'rgba(0,0,0,0.02)' }}
        >
          <span className="text-sm text-gray-700">
            {selected.size} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setBulkOpen(true)}
              className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white"
              style={{ backgroundColor: 'var(--theme-primary)' }}
            >
              Send portal invites
            </button>
          </div>
        </div>
      )}

      {/* Toast — invite result + the copyable link as a fallback for a failed send. */}
      {toast && (
        <div className="mb-3 rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm text-gray-800">{toast.msg}</p>
            <button type="button" onClick={() => setToast(null)} className="text-gray-400 hover:text-gray-600" aria-label="Dismiss">×</button>
          </div>
          {toast.link && (
            <div className="mt-2 flex items-center gap-2">
              <input
                readOnly
                value={toast.link}
                onFocus={(e) => e.target.select()}
                className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600"
              />
              <button
                type="button"
                onClick={() => copyLink(toast.employeeId || 'toast', toast.link)}
                className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                {copiedId === (toast.employeeId || 'toast') ? 'Copied!' : 'Copy'}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
        {loading ? (
          <div className="py-12 flex justify-center">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty text="No employees match your filters." />
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Employees</caption>
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-100">
                <th scope="col" className="px-3 py-3 font-medium">
                  <span className="sr-only">Select</span>
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={items.length > 0 && items.every((e) => selected.has(e.id))}
                    onChange={(e) => {
                      if (e.target.checked) setSelected(new Set(items.map((i) => i.id)));
                      else setSelected(new Set());
                    }}
                  />
                </th>
                <th scope="col" className="px-4 py-3 font-medium">Code</th>
                <th scope="col" className="px-4 py-3 font-medium">Name</th>
                <th scope="col" className="px-4 py-3 font-medium">Department</th>
                <th scope="col" className="px-4 py-3 font-medium">Email</th>
                <th scope="col" className="px-4 py-3 font-medium">Status</th>
                <th scope="col" className="px-4 py-3 font-medium">
                  <span className="inline-flex items-center">
                    Portal
                    <InfoTip text="Whether this person can sign in to their employee self-service portal. Not invited = no welcome link sent yet. Invited = link sent, awaiting them to set a password. Active = they've claimed their login." />
                  </span>
                </th>
                <th scope="col" className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((emp) => {
                const portalState = statusOverride[emp.id] || emp.portalStatus || (emp.portal && emp.portal.state) || 'NOT_INVITED';
                const meta = portalMeta(portalState);
                const freshLink = linkById[emp.id] || null;
                const isActive = portalState === 'ACTIVE';
                const hasEmail = !!emp.workEmail;
                return (
                  <tr key={emp.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${[emp.firstName, emp.lastName].filter(Boolean).join(' ')}`}
                        checked={selected.has(emp.id)}
                        onChange={() => toggleSelect(emp.id)}
                      />
                    </td>
                    <td className="px-4 py-3 text-gray-500">{emp.code}</td>
                    <td className="px-4 py-3">
                      <Link href={`/people/${emp.id}`} className="font-medium text-gray-900 hover:underline">
                        {[emp.firstName, emp.lastName].filter(Boolean).join(' ') || '—'}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {emp.department?.name || <span className="text-gray-400">Unassigned</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {emp.workEmail ? (
                        <a href={`mailto:${emp.workEmail}`} className="hover:underline">{emp.workEmail}</a>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadgeClass(
                          emp.status
                        )}`}
                      >
                        {statusLabel(emp.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {hasEmail ? (
                          <button
                            type="button"
                            onClick={() => setInviteTarget({ emp, isReset: isActive })}
                            className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                          >
                            {portalActionLabel(portalState)}
                          </button>
                        ) : (
                          <span className="text-xs text-gray-400" title="Add a work email before inviting">No work email</span>
                        )}
                        {freshLink && (
                          <button
                            type="button"
                            onClick={() => copyLink(emp.id, freshLink)}
                            className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                          >
                            {copiedId === emp.id ? 'Copied!' : 'Copy link'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={total}
        sizes={PAGE_SIZES}
        noun="employees"
        onPageChange={(p) => pushQuery({ page: p })}
        onPageSizeChange={(ps) => pushQuery({ pageSize: ps, page: 1 })}
      />

      {/* Single-row invite / resend / reset confirm. */}
      {inviteTarget && (
        <Modal
          title={inviteTarget.isReset ? 'Reset portal password' : portalActionLabel(statusOverride[inviteTarget.emp.id] || inviteTarget.emp.portalStatus)}
          onClose={() => (sending ? null : setInviteTarget(null))}
        >
          <p className="text-sm text-gray-600">
            {inviteTarget.isReset ? (
              <>
                Send a fresh set-password link to{' '}
                <strong>{inviteTarget.emp.workEmail}</strong>. This <strong>does not change</strong> their current
                password until they set a new one, and it invalidates any pending invite.
              </>
            ) : (
              <>
                Send a welcome email + WhatsApp to <strong>{inviteTarget.emp.workEmail}</strong> with a link to set
                their portal password. Their login is their work email. Resending invalidates any earlier link.
              </>
            )}
          </p>
          <ModalActions>
            <button
              type="button"
              onClick={() => setInviteTarget(null)}
              disabled={sending}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              Cancel
            </button>
            <PrimaryButton onClick={() => sendSingleInvite(inviteTarget.emp, inviteTarget.isReset)} loading={sending}>
              {inviteTarget.isReset ? 'Send reset link' : 'Send invite'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {/* Bulk invite confirm. */}
      {bulkOpen && (
        <Modal title="Send portal invites" onClose={() => (sending ? null : setBulkOpen(false))}>
          <p className="text-sm text-gray-600">
            Send a portal welcome + set-password link to the <strong>{selected.size}</strong> selected employee
            {selected.size === 1 ? '' : 's'}. People with no work email, an already-active login, or outside your
            access are skipped automatically.
          </p>
          <ModalActions>
            <button
              type="button"
              onClick={() => setBulkOpen(false)}
              disabled={sending}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              Cancel
            </button>
            <PrimaryButton onClick={sendBulkInvites} loading={sending}>
              Send {selected.size} invite{selected.size === 1 ? '' : 's'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </div>
  );
}

export default function PeoplePage() {
  // useSearchParams requires a Suspense boundary in the app router.
  return (
    <Suspense fallback={<Spinner />}>
      <PeopleInner />
    </Suspense>
  );
}
