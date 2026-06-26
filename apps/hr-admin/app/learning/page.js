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
import ModuleGuide from '@/components/ModuleGuide';
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
  // Certificate recovery: a completed enrollment whose certificate failed to mint sits
  // on "being prepared…" forever. This modal wires the documented recovery endpoint
  // POST /enrollments/:id/reissue-cert (server gates on canManageLearning) so an admin
  // can re-mint it. We can't list enrollments here (this page lists courses), so the
  // admin pastes the stuck enrollment id; the server validates + returns a clear 409
  // ("No certificate has been issued for this enrollment") which we surface verbatim.
  const [reissue, setReissue] = useState(null); // { enrollmentId, reason } | null
  const [reissuing, setReissuing] = useState(false);
  const [reissueErr, setReissueErr] = useState('');
  const [reissueOk, setReissueOk] = useState('');

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

  async function reissueCert() {
    const id = String(reissue?.enrollmentId || '').trim();
    if (!id) { setReissueErr('Enrollment id is required.'); return; }
    setReissuing(true);
    setReissueErr('');
    setReissueOk('');
    try {
      const r = await post(`/api/hr/learning/enrollments/${id}/reissue-cert`, { reason: reissue.reason || undefined });
      setReissueOk(r?.referenceNo ? `Certificate re-issued (${r.referenceNo}).` : 'Certificate re-issued.');
      await load();
    } catch (e) {
      setReissueErr(e.data?.message || e.message || 'Failed to re-issue certificate.');
    } finally {
      setReissuing(false);
    }
  }

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
        {canManage ? (
          <ActionButton onClick={() => { setReissueErr(''); setReissueOk(''); setReissue({ enrollmentId: '', reason: '' }); }}>Reissue cert</ActionButton>
        ) : null}
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

      <ModuleGuide
        id="learning"
        title="Build & track training courses"
        what="This is your training catalogue. Author courses (POSH, safety, ISMS, onboarding), publish them, assign them to employees, and track who has completed each one — the evidence you need for India compliance audits like annual POSH training."
        steps={[
          'Click New course, give it a unique code (e.g. POSH-2026), a title, and a category — POSH is the India compliance anchor.',
          'On the 3-pane builder, add modules and content, then change status from Draft to Published — drafts stay hidden from learners.',
          'Assign the published course to employees or departments so it appears on their learning queue.',
          'Use the Status filter to find Draft / Published / Archived courses, and open the Compliance dashboard to see who is overdue.',
        ]}
        example={<>Acme India Pvt Ltd creates course <b>POSH-2026</b> (category <b>POSH</b>), publishes it in <b>June 2026</b>, and assigns it to all 240 staff. The catalogue row shows <b>Enrolled 240</b>, <b>Completed 188/240 (78%)</b> — so Aarav Sharma and 51 others still need a nudge before the annual deadline.</>}
        tips={[
          'A course must be Published before you can assign it — a Draft is invisible to learners.',
          'The course code drives the certificate category and calendar grouping, so keep it stable; archive instead of deleting old versions to preserve completion records.',
        ]}
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

      {canManage && reissue ? (
        <Modal title="Reissue certificate" onClose={() => setReissue(null)} size="sm">
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              When a completed learner is stuck on &ldquo;certificate being prepared…&rdquo;, the original mint failed.
              Paste the stuck enrollment id to re-mint the certificate into the learner&rsquo;s document vault.
            </p>
            <TextInput
              label="Enrollment id"
              value={reissue.enrollmentId}
              onChange={(v) => setReissue({ ...reissue, enrollmentId: v })}
              required
              hint="The enrollment that completed but is missing its certificate."
            />
            <TextInput
              label="Reason (optional)"
              value={reissue.reason}
              onChange={(v) => setReissue({ ...reissue, reason: v })}
              hint="Logged on the reissued certificate for the audit trail."
            />
            {reissueErr ? <ErrorBanner message={reissueErr} /> : null}
            {reissueOk ? <p className="text-sm font-medium text-emerald-700">{reissueOk}</p> : null}
          </div>
          <ModalActions>
            <button className="rounded-md px-3 py-1.5 text-sm text-gray-600" onClick={() => setReissue(null)}>Close</button>
            <PrimaryButton onClick={reissueCert} loading={reissuing}>Reissue certificate</PrimaryButton>
          </ModalActions>
        </Modal>
      ) : null}
    </div>
  );
}
