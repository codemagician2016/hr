'use client';

// Per-employee letter history (Feature 9 §5.1). Lists every letter issued to one
// employee with the supersede chain + void state, via
//   GET /api/hr/letters/employees/:employeeId/letters
// (withEmployeeScope('canGenerateLetters') — an out-of-scope employee 404s).

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ErrorBanner, formatAdminDate } from '@hr/ui';
import { get } from '@/lib/api';
import { PageHeader, DataTable, StatusBadge, ActionButton, asList } from '@/lib/ui';
import { getPdf, downloadBlob } from '../../lib';

export default function EmployeeLettersPage() {
  const { employeeId } = useParams();
  const router = useRouter();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    get(`/api/hr/letters/employees/${employeeId}/letters`)
      .then((r) => setRows(asList(r)))
      .catch((e) => {
        setRows([]);
        // 404 from withEmployeeScope means out-of-band/out-of-scope — show a soft notice.
        setError(e.status === 404 ? 'No history available for this employee.' : (e.message || 'Failed to load history.'));
      });
  }, [employeeId]);

  async function onDownload(row) {
    setBusyId(row.id); setError('');
    try {
      const blob = await getPdf(`/api/hr/letters/${row.id}/download`);
      downloadBlob(blob, `${(row.referenceNo || 'letter').replace(/\//g, '-')}.pdf`);
    } catch (e) { setError(e.message || 'Download failed.'); }
    finally { setBusyId(''); }
  }

  const columns = [
    { key: 'referenceNo', header: 'Reference', render: (r) => <span className="font-mono text-xs">{r.referenceNo}</span> },
    { key: 'category', header: 'Type' },
    { key: 'subject', header: 'Subject', render: (r) => r.subject || '—' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'issuedAt', header: 'Date', render: (r) => <span className="text-gray-500 text-xs">{formatAdminDate(r.issuedAt || r.createdAt)}</span> },
    {
      key: 'chain', header: 'Chain', render: (r) => (
        <span className="text-xs text-gray-500">
          {r.supersedesLetterId ? 're-issue' : ''}{r.supersededByLetterId ? ' · superseded' : ''}{r.voidedAt ? ' · voided' : ''}
        </span>
      ),
    },
    {
      key: 'actions', header: '', className: 'text-right', cellClassName: 'text-right',
      render: (r) => <ActionButton onClick={() => onDownload(r)} disabled={busyId === r.id}>Download</ActionButton>,
    },
  ];

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Employee letter history"
        subtitle="Every letter issued to this person, with supersede chains and void state."
        actions={<button type="button" onClick={() => router.push('/letters/register')} className="text-sm text-gray-500 hover:text-gray-700">← Back to register</button>}
      />
      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}
      <DataTable
        columns={columns}
        rows={rows}
        loading={rows === null}
        emptyText="No letters issued to this employee yet."
        rowKey={(r) => r.id}
        caption="Employee letter history"
      />
    </div>
  );
}
