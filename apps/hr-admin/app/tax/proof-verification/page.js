'use client';

/**
 * Tax → Proof Verification (Feature 20). The HR queue of PENDING investment proofs
 * across the team/tenant. Accept (verifiedAmount, pre-filled = declared, trim down) or
 * reject (mandatory reason). SoD + F1 scope are enforced server-side; this is the
 * console. Each verdict drives what feeds TDS at the proof deadline.
 */

import { useCallback, useEffect, useState } from 'react';
import { get, post } from '@/lib/api';
import { PageHeader, DataTable, StatusBadge, ActionButton, ServerPagination } from '@/lib/ui';
import { Spinner, ErrorBanner, PrimaryButton, TextInput, TextArea, Modal, ModalActions } from '@hr/ui';
import ModuleGuide from '@/components/ModuleGuide';

const API = '/api/hr/proofs';

export default function ProofVerificationPage() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [statusFilter, setStatusFilter] = useState('PENDING');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [verdict, setVerdict] = useState(null); // { proof, mode: 'accept'|'reject' }

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get(API, { status: statusFilter, page, pageSize })
      .then((res) => { setItems(res.items || []); setTotal(res.total || 0); })
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load the queue.'))
      .finally(() => setLoading(false));
  }, [statusFilter, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  const money = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const columns = [
    { key: 'employee', header: 'Employee', render: (p) => p.employee ? <span>{p.employee.name} <span className="text-xs text-gray-400">({p.employee.code})</span></span> : '—' },
    { key: 'claim', header: 'Claim', render: (p) => <span>{p.claimLabel}{p.subSection ? <span className="text-xs text-gray-400"> · {p.subSection}</span> : null}</span> },
    { key: 'fy', header: 'FY', render: (p) => p.financialYear },
    { key: 'declared', header: 'Declared', render: (p) => money(p.declaredAmount) },
    { key: 'verified', header: 'Verified', render: (p) => p.verifiedAmount != null ? money(p.verifiedAmount) : '—' },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
    {
      key: 'file',
      header: 'Proof',
      render: (p) => (
        <a
          href={`${API}/employees/${p.employeeId}/proofs/${p.id}/file`}
          target="_blank" rel="noreferrer"
          className="text-xs text-blue-600 hover:underline"
        >View</a>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (p) => p.status === 'PENDING' ? (
        <div className="flex items-center gap-2 justify-end">
          <ActionButton tone="positive" onClick={() => setVerdict({ proof: p, mode: 'accept' })}>Accept</ActionButton>
          <ActionButton tone="danger" onClick={() => setVerdict({ proof: p, mode: 'reject' })}>Reject</ActionButton>
        </div>
      ) : (
        p.status === 'REJECTED' && p.rejectReason ? <span className="text-xs text-gray-500" title={p.rejectReason}>Rejected: {p.rejectReason.slice(0, 40)}</span> : null
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Proof verification"
        subtitle="Accept or reject each uploaded investment proof. After the proof deadline, only the accepted amounts reduce the employee's TDS."
      />
      <ModuleGuide
        id="tax-proof-verification"
        title="Verify investment proofs before they cut TDS"
        what="This is the HR queue of uploaded investment proofs (80C, 80D, HRA rent, home-loan interest, and more) for the financial year. Each verdict you record here decides what feeds into the employee's TDS — only ACCEPTED amounts reduce tax at the proof deadline; declared-but-unverified amounts are dropped and TDS is recomputed on the higher taxable income."
        steps={[
          "Open a proof: click View to see the uploaded document, then check it matches the declared claim, amount and financial year.",
          "Accept it: the Verified amount pre-fills to the declared amount — trim it down if the proof supports less (it can never exceed declared), then confirm.",
          "Reject it: choose Reject and enter a mandatory reason (e.g. blurred, amount mismatch, wrong FY) so the employee can re-upload before the deadline.",
          "Use the PENDING / ACCEPTED / REJECTED tabs to work the queue and review past verdicts.",
        ]}
        example={<>Aarav Sharma (EMP-1042) declared <b>₹1,50,000</b> under 80C but his uploaded ELSS + PPF statements total only <b>₹1,20,000</b>. You set Verified amount to <b>₹1,20,000</b> and Accept. At the proof deadline only ₹1,20,000 reduces his taxable income, so his TDS for the remaining months of FY 2025-26 is recomputed upward.</>}
        tips={[
          "Verified amount can never exceed the declared amount — if the proof shows more, the employee must revise the declaration, not you.",
          "Rejections need a clear reason: it is shown to the employee and is their only cue to re-upload before the proof-submission deadline.",
        ]}
      />
      <div className="flex items-center gap-2">
        {['PENDING', 'ACCEPTED', 'REJECTED'].map((s) => (
          <button
            key={s}
            onClick={() => { setStatusFilter(s); setPage(1); }}
            className={`rounded-full px-3 py-1 text-xs font-medium ${statusFilter === s ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700'}`}
          >{s}</button>
        ))}
      </div>
      {error && <ErrorBanner message={error} />}
      {loading ? <Spinner /> : (
        <>
          <DataTable columns={columns} rows={items} rowKey={(p) => p.id} emptyText="No proofs in this state." />
          <ServerPagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} onPageSizeChange={(ps) => { setPageSize(ps); setPage(1); }} />
        </>
      )}
      {verdict && (
        <VerdictModal
          verdict={verdict}
          onClose={() => setVerdict(null)}
          onDone={() => { setVerdict(null); load(); }}
          onError={setError}
        />
      )}
    </div>
  );
}

function VerdictModal({ verdict, onClose, onDone, onError }) {
  const { proof, mode } = verdict;
  const [verifiedAmount, setVerifiedAmount] = useState(String(proof.declaredAmount ?? ''));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      if (mode === 'accept') {
        await post(`${API}/employees/${proof.employeeId}/proofs/${proof.id}/accept`, { verifiedAmount: Number(verifiedAmount) });
      } else {
        if (!reason.trim()) { setFormError('A rejection reason is required.'); setSaving(false); return; }
        await post(`${API}/employees/${proof.employeeId}/proofs/${proof.id}/reject`, { rejectReason: reason.trim() });
      }
      onDone();
    } catch (err) {
      setFormError(err.data?.message || err.message || 'Failed to record the verdict.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={mode === 'accept' ? 'Accept proof' : 'Reject proof'} onClose={onClose} size="sm">
      <form onSubmit={submit} className="space-y-3">
        {formError && <ErrorBanner message={formError} />}
        <div className="text-sm text-gray-600">
          {proof.employee?.name} · {proof.claimLabel} · declared ₹{Number(proof.declaredAmount).toLocaleString('en-IN')}
        </div>
        {mode === 'accept' ? (
          <TextInput
            label="Verified amount (₹)"
            type="number"
            value={verifiedAmount}
            onChange={setVerifiedAmount}
            required
            min={0}
            max={Number(proof.declaredAmount)}
            hint="Cannot exceed the declared amount. Trim down if the proof supports less."
          />
        ) : (
          <TextArea label="Reason (required)" value={reason} onChange={setReason} maxLength={1000} rows={3} hint="e.g. blurred, amount mismatch, wrong FY." />
        )}
        <ModalActions>
          <button type="button" onClick={onClose} className="text-sm text-gray-600">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>{mode === 'accept' ? 'Accept' : 'Reject'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}
