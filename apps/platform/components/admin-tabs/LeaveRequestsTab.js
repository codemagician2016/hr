'use client';

// Staff leave-requests admin tab. Approvals + denials.
// Extracted from [slug]/admin/page.js 2026-04-29.

import { useEffect, useState } from 'react';
import { useConfirm } from '@/components/ConfirmDialog';
import { api } from '@/lib/adminApi';
import { Spinner } from '@/components/admin-ui';

function LeaveRequestsTab() {
  const [leaves, setLeaves] = useState([]);
  const [loading, setLoading] = useState(true);
  const [autoApprove, setAutoApprove] = useState(false);
  const [conflicts, setConflicts] = useState(null); // { leaveId, conflicts[], staffList }
  const confirm = useConfirm();
  const [actionPending, setActionPending] = useState(null);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [lRes, bRes, sRes] = await Promise.all([
        api('/api/business/leave-requests'),
        api('/api/business/me'),
        api('/api/business/staff'),
      ]);
      setLeaves(lRes.leaves || []);
      setAutoApprove(bRes.business?.autoApproveLeave || false);
    } catch {} finally { setLoading(false); }
  }

  async function toggleAuto() {
    try {
      const data = await api('/api/business/settings/auto-approve-leave', {
        method: 'PUT', body: JSON.stringify({ enabled: !autoApprove }),
      });
      setAutoApprove(data.autoApproveLeave);
    } catch (err) { alert(err.message); }
  }

  async function approve(id, conflictAction, transferStaffId) {
    setActionPending(id);
    try {
      const body = {};
      if (conflictAction) body.conflictAction = conflictAction;
      if (transferStaffId) body.transferStaffId = transferStaffId;

      const data = await api(`/api/business/leave-requests/${id}/approve`, {
        method: 'PUT', body: JSON.stringify(body),
      });

      if (data.status === 'conflicts_found') {
        // Show conflict modal
        const staffRes = await api('/api/business/staff');
        setConflicts({ leaveId: id, conflicts: data.conflicts, staff: staffRes.staff || [] });
        setActionPending(null);
        return;
      }

      setConflicts(null);
      await loadAll();
    } catch (err) { alert(err.message); }
    finally { setActionPending(null); }
  }

  async function reject(id) {
    if (!await confirm('Reject this leave request?', { confirmLabel: 'Reject', tone: 'danger' })) return;
    setActionPending(id);
    try {
      await api(`/api/business/leave-requests/${id}/reject`, { method: 'PUT' });
      await loadAll();
    } catch (err) { alert(err.message); }
    finally { setActionPending(null); }
  }

  const pending = leaves.filter(l => l.status === 'PENDING');
  const processed = leaves.filter(l => l.status !== 'PENDING');

  const STATUS_BADGE = {
    PENDING: 'bg-amber-100 text-amber-700 border-amber-200',
    APPROVED: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    REJECTED: 'bg-red-100 text-red-700 border-red-200',
  };

  return (
    <div className="space-y-5">
      {/* Auto-approve toggle */}
      <div className="rounded-2xl border p-5 flex items-center justify-between" style={{ backgroundColor: 'var(--theme-surface)', borderColor: 'var(--theme-border)' }}>
        <div>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>Auto-approve leave requests</h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--theme-muted)' }}>
            When enabled, staff leave requests are approved instantly without your review.
          </p>
        </div>
        <button onClick={toggleAuto}
          className={`relative w-11 h-6 rounded-full transition-colors ${autoApprove ? '' : 'bg-gray-300'}`}
          style={autoApprove ? { backgroundColor: 'var(--theme-primary)' } : {}}>
          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${autoApprove ? 'translate-x-5' : ''}`} />
        </button>
      </div>

      {/* Pending requests */}
      <div className="rounded-2xl border p-6" style={{ backgroundColor: 'var(--theme-surface)', borderColor: 'var(--theme-border)' }}>
        <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--theme-text)', fontFamily: 'var(--font-heading)' }}>
          Pending requests {pending.length > 0 && <span className="text-xs font-normal ml-2 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">{pending.length}</span>}
        </h2>

        {loading ? (
          <div className="py-8 flex justify-center"><Spinner /></div>
        ) : pending.length === 0 ? (
          <div className="border border-dashed rounded-xl py-8 text-center text-sm" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
            No pending leave requests.
          </div>
        ) : (
          <div className="space-y-3">
            {pending.map(l => (
              <div key={l.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border"
                style={{ borderColor: 'var(--theme-border)' }}>
                <div>
                  <p className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>
                    {l.staff?.name} — {new Date(l.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--theme-muted)' }}>
                    {l.isFullDay ? 'Full day' : `${l.startTime} – ${l.endTime}`}
                    {l.reason && ` · ${l.reason}`}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button onClick={() => approve(l.id)} disabled={actionPending === l.id}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white disabled:opacity-50"
                    style={{ backgroundColor: 'var(--theme-primary)' }}>
                    {actionPending === l.id ? '...' : 'Approve'}
                  </button>
                  <button onClick={() => reject(l.id)} disabled={actionPending === l.id}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg text-red-600 border border-red-300 hover:bg-red-50 disabled:opacity-50">
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Processed */}
      {processed.length > 0 && (
        <div className="rounded-2xl border p-6" style={{ backgroundColor: 'var(--theme-surface)', borderColor: 'var(--theme-border)' }}>
          <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--theme-muted)' }}>History</h3>
          <div className="space-y-2">
            {processed.slice(0, 20).map(l => (
              <div key={l.id} className="flex items-center justify-between py-2 text-sm">
                <span style={{ color: 'var(--theme-text)' }}>
                  {l.staff?.name} · {new Date(l.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  {!l.isFullDay && ` (${l.startTime}–${l.endTime})`}
                </span>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_BADGE[l.status]}`}>
                  {l.status}{l.autoApproved ? ' (auto)' : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Conflict resolution modal */}
      {conflicts && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setConflicts(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900">Booking conflicts</h3>
            <p className="text-sm text-gray-500 mt-1">
              {conflicts.conflicts.length} appointment(s) overlap with this leave. Choose how to handle them:
            </p>

            <div className="mt-4 space-y-2">
              {conflicts.conflicts.map(c => (
                <div key={c.id} className="p-3 rounded-lg border border-gray-200 text-sm">
                  <p className="font-medium">{c.customerName} · {c.service?.name}</p>
                  <p className="text-xs text-gray-500">{c.startTime}–{c.endTime}</p>
                </div>
              ))}
            </div>

            <div className="mt-6 space-y-2">
              <button onClick={() => approve(conflicts.leaveId, 'cancel')}
                className="w-full py-2.5 text-sm font-semibold rounded-lg text-white bg-red-600 hover:bg-red-700">
                Cancel all conflicting bookings
              </button>
              <p className="text-xs text-gray-500 text-center">Customers will be notified via email</p>

              {conflicts.staff.length > 1 && (
                <>
                  <p className="text-xs text-gray-500 text-center pt-2">— or transfer to another staff member —</p>
                  {conflicts.staff.filter(s => s.id !== conflicts.conflicts[0]?.staffId).map(s => (
                    <button key={s.id} onClick={() => approve(conflicts.leaveId, 'transfer', s.id)}
                      className="w-full py-2.5 text-sm font-semibold rounded-lg border border-gray-300 hover:bg-gray-50">
                      Transfer to {s.name}
                    </button>
                  ))}
                </>
              )}

              <button onClick={() => approve(conflicts.leaveId, 'notify')}
                className="w-full py-2.5 text-sm font-semibold rounded-lg border border-gray-300 hover:bg-gray-50">
                Notify customers (let them decide)
              </button>

              <button onClick={() => setConflicts(null)}
                className="w-full py-2 text-xs text-gray-500 hover:text-gray-900">
                Cancel — don't approve yet
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default LeaveRequestsTab;
