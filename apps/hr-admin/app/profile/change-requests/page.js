'use client';

// Profile change requests (Feature 13) — the HR approval queue for ESS-submitted
// changes to GOVERNED fields (name / DOB / bank / statutory IDs). The list is
// F1-scoped server-side (a Manager sees only their sub-tree's requests). Approve
// applies the new value atomically (drives the F10 PROFILE_CHANGE engine + the
// per-model consumer commit, version-guarded); reject leaves the row untouched.
// SoD: the server blocks approving a request for your own linked employee.

import { useCallback, useEffect, useState } from 'react';
import { Spinner, ErrorBanner, Empty } from '@hr/ui';
import { get, post } from '@/lib/api';
import { PageHeader, asList, ActionButton } from '@/lib/ui';
import ModuleGuide from '@/components/ModuleGuide';

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'ALL'];

export default function ProfileChangeRequestsPage() {
  const [status, setStatus] = useState('PENDING');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await get('/api/hr/profile/change-requests', { status });
      setRows(asList(res));
    } catch (e) { setError(e); } finally { setLoading(false); }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  async function decide(id, action) {
    setBusyId(id);
    try { await post(`/api/hr/profile/change-requests/${id}/${action}`, {}); await load(); }
    catch (e) { alert(e.message || `Could not ${action}`); }
    finally { setBusyId(null); }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Profile change requests" subtitle="Employee-requested changes to governed fields (name, date of birth, bank, statutory IDs). Approving applies the change; you cannot approve a request for your own profile." />

      <ModuleGuide
        id="profile-change-requests"
        title="Approve employee edits to governed profile fields"
        what="This is your approval queue for self-service (ESS) edits to locked, compliance-sensitive fields — legal name, date of birth, bank account, and statutory IDs like PAN, UAN/PF and Aadhaar. These can't be self-edited because they flow into payroll, Form 16/24Q and EPF/ESI filings, so HR must verify and approve each change before it takes effect."
        steps={[
          'Use the status pills (Pending / Approved / Rejected / All) to filter — start with Pending.',
          'For each row, compare the From and To values and the field, and verify the employee uploaded supporting proof (e.g. cancelled cheque for bank, PAN card for a name fix).',
          'Click Approve to apply the new value to the live profile, or Reject to leave the record untouched.',
          'Re-check the Approved tab to confirm the change landed before the next payroll run.',
        ]}
        example={<>Aarav Sharma (EMP-1042) at Acme India Pvt Ltd submits a bank-account change from <b>HDFC ...8821</b> to <b>ICICI ...4507</b> after switching banks. You confirm his cancelled cheque, click <b>Approve</b>, and the new account is used for his <b>June 2026</b> ₹1,04,500 net salary credit — no manual master-data edit needed.</>}
        tips={[
          'You cannot approve a request linked to your own employee profile (separation of duties) — ask another HR admin to action it.',
          'Bank and statutory-ID changes approved after payroll is locked will only apply from the next cycle, so action them before the cut-off.',
        ]}
      />

      <div className="flex gap-2">
        {STATUSES.map((s) => (
          <button key={s} onClick={() => setStatus(s)} className="rounded-full border px-3 py-1 text-sm"
                  style={status === s ? { background: 'var(--theme-primary, #4f46e5)', color: 'white', borderColor: 'transparent' } : { borderColor: '#e5e7eb', color: '#374151' }}>
            {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {loading ? <Spinner /> : error ? <ErrorBanner message={error.message || 'Could not load the queue'} /> : (
        rows.length === 0 ? <Empty text="No change requests in this view." /> : (
          <div className="overflow-hidden rounded-xl border" style={{ borderColor: '#e5e7eb' }}>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-gray-500">
                <tr><th className="px-4 py-2">Employee</th><th className="px-4 py-2">Field</th><th className="px-4 py-2">From</th><th className="px-4 py-2">To</th><th className="px-4 py-2">Status</th><th className="px-4 py-2 text-right">Action</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t" style={{ borderColor: '#f3f4f6' }}>
                    <td className="px-4 py-2 font-medium text-gray-900">{r.employee?.name} <span className="text-gray-400">{r.employee?.code}</span></td>
                    <td className="px-4 py-2"><code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">{r.field}</code></td>
                    <td className="px-4 py-2 text-gray-500">{r.oldValue ?? '—'}</td>
                    <td className="px-4 py-2 font-medium text-gray-900">{r.newValue}</td>
                    <td className="px-4 py-2"><span className="text-xs font-semibold" style={{ color: r.status === 'PENDING' ? '#d97706' : r.status === 'APPROVED' ? '#16a34a' : '#dc2626' }}>{r.status}</span></td>
                    <td className="px-4 py-2 text-right">
                      {r.status === 'PENDING' ? (
                        <span className="flex justify-end gap-2">
                          <ActionButton tone="positive" disabled={busyId === r.id} onClick={() => decide(r.id, 'approve')}>Approve</ActionButton>
                          <ActionButton tone="danger" disabled={busyId === r.id} onClick={() => decide(r.id, 'reject')}>Reject</ActionButton>
                        </span>
                      ) : <span className="text-xs text-gray-400">decided</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
