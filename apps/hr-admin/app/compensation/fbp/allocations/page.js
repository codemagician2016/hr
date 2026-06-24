'use client';

// Feature 25 — FBP allocation console. The roster: who has/hasn't declared, envelope
// vs allocated vs unallocated, status. Drill-down per employee shows the per-head
// allocated/exempt/taxable with the live cap. FBP bills are verified through the same
// F20 proof console (Tax proof verification). Reads canViewEmployees (F1-scoped).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ErrorBanner } from '@hr/ui';
import { get } from '@/lib/api';
import { PageHeader, DataTable, StatusBadge } from '@/lib/ui';

const FY_DEFAULT = '2026-27';
const inr = (v) => (v == null ? '—' : `₹${Number(v).toLocaleString('en-IN')}`);

export default function FbpAllocationsPage() {
  const [fy, setFy] = useState(FY_DEFAULT);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drill, setDrill] = useState(null); // { employeeId } drill-down

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await get(`/api/hr/fbp/allocations?fy=${encodeURIComponent(fy)}`);
      setRows(res.items || []);
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to load the allocation roster.');
    } finally {
      setLoading(false);
    }
  }, [fy]);

  useEffect(() => { load(); }, [load]);

  const openDrill = useCallback(async (employeeId) => {
    setError('');
    try {
      const res = await get(`/api/hr/employees/${employeeId}/fbp?fy=${encodeURIComponent(fy)}`);
      setDrill({ employeeId, ...res });
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to load the employee allocation.');
    }
  }, [fy]);

  const columns = [
    { key: 'employeeName', header: 'Employee' },
    { key: 'envelopeAnnual', header: 'Envelope', render: (r) => inr(r.envelopeAnnual) },
    { key: 'allocated', header: 'Allocated', render: (r) => inr(r.allocated) },
    { key: 'unallocated', header: 'Unallocated', render: (r) => inr(r.unallocated) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'actions', header: '', render: (r) => <button className="text-sm text-[var(--theme-primary)]" onClick={() => openDrill(r.employeeId)}>View</button> },
  ];

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="FBP allocations"
        subtitle="Who has declared their flexi benefits — envelope vs allocated vs unallocated, with the per-head exempt/taxable drill-down."
      />
      {error && <ErrorBanner message={error} />}

      <div className="mt-3 flex items-center gap-2">
        <label className="text-sm text-gray-600">Financial year</label>
        <input className="rounded-lg border border-gray-300 px-2 py-1 text-sm" value={fy} onChange={(e) => setFy(e.target.value)} />
      </div>

      <div className="mt-4">
        <DataTable columns={columns} rows={rows} loading={loading} rowKey="id" emptyText="No allocations for this year yet." />
      </div>

      {drill && (
        <div className="mt-6 rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Allocation detail · {drill.regime} regime · {drill.status}</h3>
            <button className="text-sm text-gray-500" onClick={() => setDrill(null)}>Close</button>
          </div>
          <div className="mt-1 text-xs text-gray-500">
            Envelope {inr(drill.envelopeAnnual)} · Total exempt {inr(drill.totalExempt)} · basis {drill.basis}
          </div>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-gray-400">
                <th className="py-1">Head</th><th>§</th><th>Allocated</th><th>Cap</th><th>Verified</th><th>Exempt</th><th>Unverified</th>
              </tr>
            </thead>
            <tbody>
              {(drill.lines || []).map((l) => (
                <tr key={l.headType} className="border-t border-gray-100">
                  <td className="py-1">{l.label}</td>
                  <td>{l.taxSection ? `§${l.taxSection}` : '—'}</td>
                  <td>{inr(l.allocated)}</td>
                  <td>{l.cap == null ? '—' : inr(l.cap)}</td>
                  <td>{inr(l.verified)}</td>
                  <td className="font-medium">{inr(l.exempt)}</td>
                  <td className={l.unverified > 0 ? 'text-amber-600' : ''}>{inr(l.unverified)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-gray-400">
            Verify FBP bills in <Link href="/tax/proof-verification" className="underline">Tax proof verification</Link> (the FBP_* claim types appear in the same queue).
          </p>
        </div>
      )}
    </div>
  );
}
