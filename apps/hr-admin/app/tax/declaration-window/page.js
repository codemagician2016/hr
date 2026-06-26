'use client';

/**
 * Tax → Declaration Window (Feature 20). HR/Finance sets the per-FY investment-proof
 * window (opens / closes / proof deadline) and drives DRAFT→OPEN→CLOSED→LOCKED. The
 * proofDeadline is the date the TDS engine flips DECLARED→VERIFIED — the §201 control.
 * Server-gated on canManageStatutory (write) / canViewPayrollReports (read).
 */

import { useCallback, useEffect, useState } from 'react';
import { get, post } from '@/lib/api';
import { PageHeader, DataTable, StatusBadge, ActionButton } from '@/lib/ui';
import { Spinner, ErrorBanner, PrimaryButton, TextInput, DateField, Modal, ModalActions, formatAdminDate } from '@hr/ui';
import ModuleGuide from '@/components/ModuleGuide';

// Default FY suggestion = the current India financial year.
function currentFy() {
  const now = new Date();
  const y = now.getUTCFullYear();
  // FY starts 1 April; before April we're still in the prior FY.
  const startYear = now.getUTCMonth() + 1 >= 4 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export default function DeclarationWindowPage() {
  const [windows, setWindows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/tax-windows')
      .then((res) => setWindows(res.windows || []))
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load windows.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function transition(id, action) {
    setBusyId(`${id}:${action}`);
    setError('');
    try {
      await post(`/api/hr/tax-windows/${id}/${action}`, {});
      load();
    } catch (e) {
      setError(e.data?.message || e.message || `Failed to ${action} window.`);
    } finally {
      setBusyId('');
    }
  }

  const columns = [
    { key: 'fy', header: 'Financial year', render: (w) => <span className="font-medium">{w.financialYear}</span> },
    { key: 'status', header: 'Status', render: (w) => <StatusBadge status={w.status} /> },
    { key: 'opensAt', header: 'Opens', render: (w) => formatAdminDate(w.opensAt) },
    { key: 'closesAt', header: 'Closes', render: (w) => formatAdminDate(w.closesAt) },
    { key: 'proofDeadline', header: 'Proof deadline (TDS flip)', render: (w) => <span className="font-medium">{formatAdminDate(w.proofDeadline)}</span> },
    {
      key: 'stats',
      header: 'Proofs',
      render: (w) => w.stats
        ? <span className="text-xs text-gray-600">{w.stats.uploaders} uploaders · {w.stats.pendingProofs} pending · {w.stats.acceptedProofs} accepted</span>
        : '—',
    },
    {
      key: 'actions',
      header: '',
      render: (w) => (
        <div className="flex items-center gap-2 justify-end">
          {w.status === 'DRAFT' && (
            <ActionButton tone="positive" disabled={busyId === `${w.id}:open`} onClick={() => transition(w.id, 'open')}>Open</ActionButton>
          )}
          {w.status === 'OPEN' && (
            <ActionButton tone="neutral" disabled={busyId === `${w.id}:close`} onClick={() => transition(w.id, 'close')}>Close</ActionButton>
          )}
          {w.status === 'CLOSED' && (
            <ActionButton tone="danger" disabled={busyId === `${w.id}:lock`} onClick={() => transition(w.id, 'lock')}>Lock</ActionButton>
          )}
          {w.status === 'LOCKED' && <span className="text-xs text-gray-400">Final</span>}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Declaration window"
        subtitle="Set the per-FY investment-proof window. After the proof deadline, only HR-verified amounts reduce TDS (Form 12BB / §192(2D) control)."
        actions={<PrimaryButton onClick={() => setShowForm(true)}>New / edit window</PrimaryButton>}
      />
      <ModuleGuide
        id="tax-declaration-window"
        title="Open the investment-proof window for the financial year"
        what="This screen sets the per-FY window in which employees declare and upload investment proofs (80C, HRA, home-loan interest, etc.). After the proof deadline, the TDS engine stops trusting unverified declarations and only HR-verified amounts reduce tax — the Form 12BB / §192(2D) control."
        steps={[
          "Click New / edit window and enter the financial year as YYYY-YY (e.g. 2026-27).",
          "Set Opens at — the date employees can start uploading proofs.",
          "Set Closes at — after this, no new uploads, but HR keeps verifying.",
          "Set Proof deadline (usually Jan–Feb) — on/after this date TDS counts only HR-verified amounts.",
          "Save, then use Open to go live; later Close, then Lock once verification is final.",
        ]}
        example={<>For FY <b>2026-27</b> at <b>Acme India Pvt Ltd</b>, HR opens the window on <b>1 Apr 2026</b>, closes uploads on <b>15 Jan 2027</b>, and sets the proof deadline to <b>31 Jan 2027</b>. <b>Aarav Sharma</b> (₹18,00,000 CTC) declares ₹1,50,000 under 80C but uploads proof for only ₹1,10,000 — after 31 Jan his TDS is recomputed on the verified ₹1,10,000.</>}
        tips={[
          "Statuses move one way: DRAFT → OPEN → CLOSED → LOCKED. Lock only after every proof is verified — it is final.",
          "Set the proof deadline a few days before your Feb payroll run so the TDS flip lands in the right month.",
        ]}
      />
      {error && <ErrorBanner message={error} />}
      {loading ? <Spinner /> : (
        <DataTable columns={columns} rows={windows} rowKey={(w) => w.id} emptyText="No windows configured yet. Create one to enable proof collection." />
      )}
      {showForm && (
        <WindowForm
          defaultFy={currentFy()}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); load(); }}
          onError={setError}
        />
      )}
    </div>
  );
}

function WindowForm({ defaultFy, onClose, onSaved, onError }) {
  const [fy, setFy] = useState(defaultFy);
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [proofDeadline, setProofDeadline] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const valid = /^\d{4}-\d{2}$/.test(fy) && opensAt && closesAt && proofDeadline;

  async function submit(e) {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    setFormError('');
    try {
      await post('/api/hr/tax-windows', { financialYear: fy, opensAt, closesAt, proofDeadline, notes: notes || undefined });
      onSaved();
    } catch (err) {
      setFormError(err.data?.message || err.message || 'Failed to save window.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Declaration window" onClose={onClose} size="sm">
      <form onSubmit={submit} className="space-y-3">
        {formError && <ErrorBanner message={formError} />}
        <TextInput label="Financial year (YYYY-YY)" value={fy} onChange={setFy} required hint="e.g. 2026-27" pattern="\d{4}-\d{2}" />
        <DateField label="Opens at" value={opensAt} onChange={setOpensAt} required hint="Employees can upload proofs from this date." />
        <DateField label="Closes at" value={closesAt} onChange={setClosesAt} required hint="No more uploads after this date (HR keeps verifying)." />
        <DateField label="Proof deadline" value={proofDeadline} onChange={setProofDeadline} required hint="TDS flips to verified-only on/after this date (Jan–Feb)." />
        <TextInput label="Notes (optional)" value={notes} onChange={setNotes} maxLength={500} />
        <ModalActions>
          <button type="button" onClick={onClose} className="text-sm text-gray-600">Cancel</button>
          <PrimaryButton type="submit" loading={saving} disabled={!valid}>Save window</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}
