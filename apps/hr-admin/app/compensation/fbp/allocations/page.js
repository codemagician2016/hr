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
import ModuleGuide from '@/components/ModuleGuide';
import CountryGate from '@/components/CountryGate';

const FY_DEFAULT = '2026-27';
const inr = (v) => (v == null ? '—' : `₹${Number(v).toLocaleString('en-IN')}`);

// India-only (Feature 14): the FBP allocation roster is the counterpart to the
// India-only FBP plan builder. Guard the deep link; IN tenants render exactly as
// before (CountryGate fails open while the tenant country is unresolved).
export default function FbpAllocationsPage() {
  return (
    <CountryGate label="FBP allocations">
      <FbpAllocationsPageInner />
    </CountryGate>
  );
}

function FbpAllocationsPageInner() {
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
      <ModuleGuide
        id="compensation-fbp-allocations"
        title="Track who's declared their flexi benefits and how much is exempt"
        what="The FBP allocation console shows, for each employee in the financial year, the Flexible Benefit Plan envelope versus what they've allocated versus what's still unallocated, plus a per-head exempt/taxable drill-down. It matters because correctly declared and bill-verified FBP heads (LTA, fuel, telephone, meal cards) cut an employee's taxable salary and your TDS/24Q liability."
        steps={[
          "Set the Financial year (e.g. 2026-27) to load that year's allocation roster.",
          "Scan the roster: Envelope is the annual FBP budget, Allocated is what the employee has declared across heads, Unallocated is what's still sitting in the envelope (and falls back to taxable special allowance).",
          "Click View on any employee to open the per-head detail — each FBP head with its tax section (§), allocated amount, statutory cap, verified amount and resulting exempt amount.",
          "Watch the Unverified column: amounts in amber are allocated but the supporting bill hasn't been proof-verified yet, so they stay taxable until cleared.",
          "Clear those by verifying the FBP bills in Tax proof verification, where the FBP_* claim types land in the same queue.",
        ]}
        example={<>For <b>Aarav Sharma</b> (CTC ₹18,00,000 at <b>Acme India Pvt Ltd</b>, FY <b>2026-27</b>) the FBP envelope is <b>₹1,20,000</b>. He allocates <b>₹80,000</b> to LTA (§10(5)) and <b>₹30,000</b> to fuel & telephone, leaving <b>₹10,000</b> unallocated. After bills are verified, <b>₹1,10,000</b> shows as exempt and drops out of his taxable salary for TDS.</>}
        tips={[
          "Unallocated envelope isn't a benefit — it usually pays out as fully taxable special allowance, so nudge employees to declare before the window closes.",
          "Exempt only counts after verification: a large Allocated figure with high amber Unverified means the bills are still pending in the proof queue.",
        ]}
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
