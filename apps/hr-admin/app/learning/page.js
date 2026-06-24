'use client';

// Learning ▸ Courses (Feature 37). The course catalogue (list + create) and the entry
// point to the 3-pane builder. Mirrors the announcements/performance list pattern:
// server-paginated DataTable, status/category filters, create modal. Authoring is gated
// on canManageLearning (server is the real boundary; this hides the create button).

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { get, post } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton, ServerPagination } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import { InfoTip, FieldLabel } from '@/lib/widgets';
import { ErrorBanner, PrimaryButton, TextInput, TextArea, Modal, ModalActions } from '@hr/ui';

const CATEGORIES = ['POSH', 'SAFETY', 'COMPLIANCE', 'ONBOARDING', 'SKILL', 'CODE_OF_CONDUCT', 'GENERAL'];
const STATUSES = ['', 'DRAFT', 'PUBLISHED', 'ARCHIVED'];

export default function LearningCoursesPage() {
  const router = useRouter();
  const [perms, setPerms] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [showNew, setShowNew] = useState(false);
  const [draft, setDraft] = useState({ code: '', title: '', category: 'POSH', description: '' });
  const [saving, setSaving] = useState(false);

  const canManage = hasPermission(perms, 'canManageLearning');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await get('/api/auth/me').catch(() => null);
      setPerms(permissionsFromSession(me?.user || me));
      const res = await get('/api/hr/learning/courses', { status: status || undefined, page, pageSize });
      setData(res);
      setError('');
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to load courses.');
    } finally {
      setLoading(false);
    }
  }, [status, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  async function createCourse() {
    if (!draft.code.trim() || !draft.title.trim()) { setError('Code and title are required.'); return; }
    setSaving(true);
    try {
      const c = await post('/api/hr/learning/courses', {
        code: draft.code.trim(), title: draft.title.trim(), category: draft.category, description: draft.description || null,
      });
      setShowNew(false);
      setDraft({ code: '', title: '', category: 'POSH', description: '' });
      router.push(`/learning/${c.id}`);
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to create course.');
    } finally {
      setSaving(false);
    }
  }

  const columns = [
    { key: 'title', header: 'Course', render: (c) => (
      <button className="text-left font-medium text-gray-900 hover:underline" onClick={() => router.push(`/learning/${c.id}`)}>{c.title}</button>
    ) },
    { key: 'code', header: 'Code', render: (c) => <span className="text-gray-600">{c.code}</span> },
    { key: 'category', header: 'Category', render: (c) => <span className="text-xs text-gray-500">{c.category}</span> },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
    { key: 'modules', header: 'Modules', render: (c) => c.moduleCount ?? 0 },
    { key: 'enrolled', header: 'Enrolled', render: (c) => c.enrolledCount ?? 0 },
    { key: 'completion', header: 'Completed', render: (c) => {
      const en = c.enrolledCount || 0; const done = c.completedCount || 0;
      return en ? `${done}/${en} (${Math.round((100 * done) / en)}%)` : '—';
    } },
    { key: 'actions', header: '', render: (c) => (
      <div className="flex justify-end gap-1.5">
        <ActionButton onClick={() => router.push(`/learning/${c.id}`)}>{canManage ? 'Edit' : 'View'}</ActionButton>
      </div>
    ) },
  ];

  const items = asList(data);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Learning"
        subtitle="Author training courses, assign them (POSH, safety, ISMS…), and track compliance."
        actions={canManage ? <PrimaryButton onClick={() => setShowNew(true)}>New course</PrimaryButton> : null}
      />

      <div className="flex items-center gap-3">
        <label className="text-sm text-gray-600">Status
          <InfoTip text="Draft courses are hidden from learners; publish a course before assigning it." label="Status" />
        </label>
        <select className="rounded-md border border-gray-300 px-2 py-1 text-sm" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          {STATUSES.map((s) => <option key={s || 'all'} value={s}>{s || 'All'}</option>)}
        </select>
        <a href="/learning/compliance" className="ml-auto text-sm font-medium text-blue-600 hover:underline">Compliance dashboard →</a>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      <DataTable columns={columns} rows={items} loading={loading} rowKey={(r) => r.id} emptyText="No courses yet. Create your first training course." />

      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={data?.pagination?.total ?? items.length}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        sizes={[25, 50, 100]}
        noun="courses"
      />

      {showNew ? (
        <Modal title="New course" onClose={() => setShowNew(false)} size="sm">
          <div className="space-y-3">
            <TextInput label="Course code" value={draft.code} onChange={(v) => setDraft({ ...draft, code: v })} required hint="A short, unique code, e.g. POSH-2026." />
            <TextInput label="Title" value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} required />
            <div>
              <FieldLabel tip="Drives the calendar grouping + the certificate category. POSH is the India compliance anchor.">Category</FieldLabel>
              <select className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <TextArea label="Description" value={draft.description} onChange={(v) => setDraft({ ...draft, description: v })} rows={3} />
          </div>
          <ModalActions>
            <button className="rounded-md px-3 py-1.5 text-sm text-gray-600" onClick={() => setShowNew(false)}>Cancel</button>
            <PrimaryButton onClick={createCourse} loading={saving}>Create &amp; build</PrimaryButton>
          </ModalActions>
        </Modal>
      ) : null}
    </div>
  );
}
