'use client';

// My Learning (Feature 37 ESS) — the learner home. Three sections (Required/due,
// In progress, Completed + certificate) and a Catalog tab for optional self-enrol.
// Everything is self-derived from the customer session — no employeeId in any path.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import AppShell, { useSession } from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { apiPost } from '@/lib/api';

function Pill({ on, onClick, children }) {
  return (
    <button onClick={onClick} className="rounded-full px-3.5 py-1.5 text-sm font-medium transition"
      style={on ? { background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' } : { background: 'var(--theme-primary-soft)', color: 'var(--theme-text)' }}>
      {children}
    </button>
  );
}

function ProgressBar({ pct }) {
  return (
    <div className="h-2 w-full rounded" style={{ background: 'var(--theme-border)' }}>
      <div className="h-2 rounded" style={{ width: `${pct || 0}%`, background: 'var(--theme-primary)' }} />
    </div>
  );
}

function CourseRow({ item, onOpen }) {
  return (
    <div className="rounded-xl border bg-white px-4 py-3 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{item.course.title}</div>
          <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>
            {item.course.category}
            {item.dueAt ? ` · due ${new Date(item.dueAt).toLocaleDateString()}` : ''}
            {item.overdue ? <span className="ml-1 rounded bg-red-100 px-1.5 text-red-700">overdue</span> : null}
            {item.isMandatory ? <span className="ml-1 text-amber-700">mandatory</span> : null}
          </div>
        </div>
        <button onClick={() => onOpen(item.enrollmentId)} className="rounded-md px-3 py-1.5 text-sm font-medium"
          style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
          {item.status === 'COMPLETED' ? 'Review' : item.status === 'IN_PROGRESS' ? 'Resume' : 'Start'}
        </button>
      </div>
      {item.status !== 'COMPLETED' ? <div className="mt-2"><ProgressBar pct={item.progressPct} /></div> : null}
      {item.status === 'COMPLETED' && item.certificate ? (
        <div className="mt-1 text-xs" style={{ color: 'var(--theme-muted)' }}>
          Certificate {item.certificate.referenceNo} — also in <a href="/documents" className="underline">Documents</a>.
        </div>
      ) : null}
    </div>
  );
}

function LearningInner() {
  useSession();
  const router = useRouter();
  const [tab, setTab] = useState('mine');
  const [error, setError] = useState('');
  const { data: overview, loading } = useApi('/api/hr/ess/learning/overview');
  const { data: catalog, loading: catLoading, reload: reloadCatalog } = useApi('/api/hr/ess/learning/catalog', {
    select: (b) => b?.items || [],
  });

  function open(enrollmentId) { router.push(`/learning/${enrollmentId}`); }
  async function enroll(courseId) {
    setError('');
    try { const r = await apiPost(`/api/hr/ess/learning/catalog/${courseId}/enroll`, {}); reloadCatalog(); router.push(`/learning/${r.enrollmentId}`); }
    catch (e) { setError(e.message || 'Failed to enrol.'); }
  }

  if (loading) return <Centered><Spinner /></Centered>;

  const required = overview?.required || [];
  const inProgress = overview?.inProgress || [];
  const completed = overview?.completed || [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>My Learning</h1>
        <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>Your required + optional training, and your certificates.</p>
      </div>
      {error ? <ErrorBanner message={error} /> : null}

      <div className="flex gap-2">
        <Pill on={tab === 'mine'} onClick={() => setTab('mine')}>My courses</Pill>
        <Pill on={tab === 'catalog'} onClick={() => setTab('catalog')}>Catalog</Pill>
      </div>

      {tab === 'mine' ? (
        <div className="space-y-5">
          <section>
            <h2 className="mb-2 text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>Required</h2>
            {required.length === 0 ? <Empty text="Nothing required right now." /> : (
              <div className="space-y-2">{required.map((i) => <CourseRow key={i.enrollmentId} item={i} onOpen={open} />)}</div>
            )}
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>In progress</h2>
            {inProgress.length === 0 ? <Empty text="No courses in progress." /> : (
              <div className="space-y-2">{inProgress.map((i) => <CourseRow key={i.enrollmentId} item={i} onOpen={open} />)}</div>
            )}
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>Completed</h2>
            {completed.length === 0 ? <Empty text="No completed courses yet." /> : (
              <div className="space-y-2">{completed.map((i) => <CourseRow key={i.enrollmentId} item={i} onOpen={open} />)}</div>
            )}
          </section>
        </div>
      ) : (
        <section>
          {catLoading ? <Spinner /> : (catalog || []).length === 0 ? <Empty text="No optional courses available to you right now." /> : (
            <div className="space-y-2">
              {catalog.map((c) => (
                <div key={c.id} className="flex items-center justify-between rounded-xl border bg-white px-4 py-3 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{c.title}</div>
                    <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>{c.category}{c.estMinutes ? ` · ~${c.estMinutes} min` : ''}</div>
                  </div>
                  <button onClick={() => enroll(c.id)} className="rounded-md px-3 py-1.5 text-sm font-medium" style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>Enrol</button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export default function LearningPage() {
  return <AppShell><LearningInner /></AppShell>;
}
