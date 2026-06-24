'use client';

// Learning ▸ Compliance (Feature 37). The audit-ready training compliance matrix
// (per-course coverage %, overdue, not-started) + the overdue learner drill-in with
// Nudge/Waive actions, and a POSH-style CSV audit export. F1-scoped on the server: a
// Manager (TEAM band) sees only their reports; HR-Admin (ALL band) sees the tenant.

import { useCallback, useEffect, useState } from 'react';
import { get, post } from '@/lib/api';
import { DataTable, PageHeader, ServerPagination } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import { InfoTip } from '@/lib/widgets';
import { ErrorBanner } from '@hr/ui';

export default function LearningCompliancePage() {
  const [perms, setPerms] = useState(null);
  const [matrix, setMatrix] = useState([]);
  const [overdue, setOverdue] = useState(null);
  const [tab, setTab] = useState('matrix');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const canManage = hasPermission(perms, 'canManageLearning');

  const loadMatrix = useCallback(async () => {
    setLoading(true);
    try {
      const me = await get('/api/auth/me').catch(() => null);
      setPerms(permissionsFromSession(me?.user || me));
      const r = await get('/api/hr/learning/dashboard/compliance');
      setMatrix(r.items || []);
      setError('');
    } catch (e) { setError(e.data?.message || e.message); }
    finally { setLoading(false); }
  }, []);

  const loadOverdue = useCallback(async () => {
    try { const r = await get('/api/hr/learning/dashboard/overdue', { page, pageSize }); setOverdue(r); }
    catch (e) { setError(e.data?.message || e.message); }
  }, [page, pageSize]);

  useEffect(() => { loadMatrix(); }, [loadMatrix]);
  useEffect(() => { if (tab === 'overdue') loadOverdue(); }, [tab, loadOverdue]);

  async function nudge(enrollmentId) {
    try { await post(`/api/hr/learning/dashboard/overdue/${enrollmentId}/nudge`, {}); }
    catch (e) { setError(e.data?.message || e.message); }
  }
  async function waive(enrollmentId) {
    const reason = prompt('Reason for waiving this training (required):');
    if (!reason) return;
    try { await post(`/api/hr/learning/enrollments/${enrollmentId}/waive`, { reason }); await loadOverdue(); await loadMatrix(); }
    catch (e) { setError(e.data?.message || e.message); }
  }

  const matrixColumns = [
    { key: 'course', header: 'Course', render: (r) => <span className="font-medium text-gray-900">{r.course.title}</span> },
    { key: 'category', header: 'Category', render: (r) => <span className="text-xs text-gray-500">{r.course.category}</span> },
    { key: 'assigned', header: 'Assigned', render: (r) => r.assigned },
    { key: 'completed', header: 'Completed', render: (r) => r.completed },
    { key: 'inProgress', header: 'In progress', render: (r) => r.inProgress },
    { key: 'notStarted', header: 'Not started', render: (r) => r.notStarted },
    { key: 'overdue', header: 'Overdue', render: (r) => r.overdue > 0 ? <span className="font-medium text-red-600">{r.overdue}</span> : 0 },
    { key: 'coverage', header: 'Coverage', render: (r) => (
      <div className="flex items-center gap-2">
        <div className="h-2 w-24 rounded bg-gray-100"><div className="h-2 rounded bg-green-500" style={{ width: `${r.coveragePct}%` }} /></div>
        <span className="text-xs text-gray-600">{r.coveragePct}%</span>
      </div>
    ) },
  ];

  const overdueColumns = [
    { key: 'emp', header: 'Employee', render: (r) => `${r.employee.firstName} ${r.employee.lastName} (${r.employee.code})` },
    { key: 'course', header: 'Course', render: (r) => r.course.title },
    { key: 'due', header: 'Due', render: (r) => r.dueAt ? new Date(r.dueAt).toLocaleDateString() : '—' },
    { key: 'days', header: 'Days overdue', render: (r) => <span className="text-red-600">{r.daysOverdue}</span> },
    { key: 'progress', header: 'Progress', render: (r) => `${r.progressPct}%` },
    { key: 'actions', header: '', render: (r) => canManage ? (
      <div className="flex justify-end gap-2 text-xs">
        <button className="text-blue-600 hover:underline" onClick={() => nudge(r.enrollmentId)}>Nudge</button>
        <button className="text-amber-600 hover:underline" onClick={() => waive(r.enrollmentId)}>Waive</button>
      </div>
    ) : null },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Training compliance"
        subtitle="Who's done, who's overdue, who never started — audit-ready (POSH)."
        actions={canManage ? <a className="rounded-md border border-gray-300 px-3 py-1.5 text-sm" href="/api/hr/learning/reports/export.csv">Export CSV</a> : null}
      />
      <div className="flex items-center gap-2">
        <a href="/learning" className="text-sm text-gray-500 hover:underline">← Courses</a>
        <span className="ml-3 text-xs text-gray-400">Scoped to your team if you are a manager</span>
        <InfoTip text="Managers see only their reporting sub-tree; HR-Admin sees the whole tenant." label="Scope" />
      </div>

      <div className="flex gap-1 border-b border-gray-200">
        {[['matrix', 'By course'], ['overdue', 'Overdue learners']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${tab === k ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500'}`}>{label}</button>
        ))}
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      {tab === 'matrix' ? (
        <DataTable columns={matrixColumns} rows={matrix} loading={loading} rowKey={(r) => r.course.id} emptyText="No published courses yet." />
      ) : (
        <>
          <DataTable columns={overdueColumns} rows={overdue?.items || []} loading={!overdue} rowKey={(r) => r.enrollmentId} emptyText="No overdue learners — nice." />
          <ServerPagination
            page={page} pageSize={pageSize}
            total={overdue?.pagination?.total ?? 0}
            onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
            sizes={[25, 50, 100]} noun="learners"
          />
        </>
      )}
    </div>
  );
}
