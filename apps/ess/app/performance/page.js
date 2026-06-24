'use client';

// Growth (Feature 8 ESS) — employee self-service performance.
//   Hub      : GET  /api/hr/ess/performance/overview
//   My Goals : GET  /api/hr/ess/performance/goals  (own objectives + KR rollup)
//   Review   : GET  /api/hr/ess/performance/review (RELEASE-GATED — finalRating is
//              null pre-release, server-side, never client-hidden) +
//              POST .../review/self (locks after submit) + .../review/acknowledge.
// Everything is self-derived from the session — there is no employeeId in any path,
// so a cross-employee read/write is impossible.

import { useState } from 'react';
import AppShell, { useSession } from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered, RatingScale, GoalCard, GapBar } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { apiPost } from '@/lib/api';

function GrowthInner() {
  useSession();
  const [tab, setTab] = useState('hub');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: overview, loading: ovLoading } = useApi('/api/hr/ess/performance/overview');
  const { data: goals, loading: goalsLoading } = useApi('/api/hr/ess/performance/goals', {
    select: (b) => (Array.isArray(b) ? b : b?.items || []),
  });
  const { data: reviewWrap, loading: reviewLoading, reload: reloadReview } = useApi('/api/hr/ess/performance/review', {
    select: (b) => b?.review ?? null,
  });
  const review = reviewWrap;
  // Feature 34 — development surface: own competency gaps + shared IDP only. The box,
  // potential rating, and any talent tag are NEVER in this payload (server-stripped).
  const { data: dev, loading: devLoading } = useApi('/api/hr/ess/performance/development', { enabled: tab === 'development' });

  async function submitSelf() {
    setBusy(true); setError('');
    try { await apiPost('/api/hr/ess/performance/review/self', { selfRating: 4 }); reloadReview(); }
    catch (e) { setError(e.message || 'Failed to submit self-review.'); }
    finally { setBusy(false); }
  }
  async function acknowledge() {
    setBusy(true); setError('');
    try { await apiPost('/api/hr/ess/performance/review/acknowledge', {}); reloadReview(); }
    catch (e) { setError(e.message || 'Failed to acknowledge.'); }
    finally { setBusy(false); }
  }

  if (ovLoading) return <Centered><Spinner /></Centered>;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>Performance</h1>
        <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>Your goals, reviews and growth.</p>
      </div>
      {error ? <ErrorBanner message={error} /> : null}

      <div className="flex gap-2 text-sm">
        {[['hub', 'Overview'], ['goals', 'My Goals'], ['review', 'My Review'], ['development', 'Development']].map(([k, label]) => {
          const on = tab === k;
          return (
            <button
              key={k}
              onClick={() => setTab(k)}
              className="rounded-full px-3.5 py-1.5 font-medium transition"
              style={on
                ? { background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }
                : { background: 'var(--theme-primary-soft)', color: 'var(--theme-text)' }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {tab === 'hub' ? (
        <div className="space-y-2">
          <Stat label="Cycle" value={overview?.cycle?.name || '—'} />
          <Stat label="My review" value={overview?.myReviewStatus || 'not started'} />
          <Stat label="Goals" value={`${overview?.goalStats?.onTrack || 0}/${overview?.goalStats?.total || 0} on track`} />
          <Stat label="Pending feedback" value={String(overview?.pendingFeedback || 0)} />
          <Stat label="Rating released" value={overview?.ratingReleased ? 'Yes' : 'Not yet'} />
        </div>
      ) : null}

      {tab === 'goals' ? (
        goalsLoading ? <Spinner /> : (
          (goals || []).length === 0 ? <Empty text="No goals yet." /> : (
            <div className="space-y-2">
              {goals.map((g) => <GoalCard key={g.id} goal={g} />)}
            </div>
          )
        )
      ) : null}

      {tab === 'review' ? (
        reviewLoading ? <Spinner /> : !review ? <Empty text="No review for you yet." /> : (
          <div className="space-y-3 rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
            <Row label="Status" value={<span>{review.status}</span>} />
            <Row label="Self rating" value={<RatingScale value={review.selfRating} scale={[]} />} />
            {/* finalRating/managerComments are ABSENT from the payload until release. */}
            {review.releasedAt ? (
              <>
                <Row label="Final rating" value={<RatingScale value={review.finalRating} scale={[]} />} />
                <Row label="Manager comments" value={<span>{review.managerComments || '—'}</span>} />
              </>
            ) : (
              <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>Your final rating is not yet released.</p>
            )}
            <div className="flex gap-2 pt-2">
              {review.status === 'NOT_STARTED' ? (
                <button disabled={busy} onClick={submitSelf}
                  className="rounded-lg px-3.5 py-2 text-sm font-semibold transition disabled:opacity-60"
                  style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
                  Submit self-review
                </button>
              ) : null}
              {review.status === 'CALIBRATED' && review.releasedAt ? (
                <button disabled={busy} onClick={acknowledge}
                  className="rounded-lg px-3.5 py-2 text-sm font-semibold transition disabled:opacity-60"
                  style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
                  Acknowledge
                </button>
              ) : null}
            </div>
          </div>
        )
      ) : null}

      {tab === 'development' ? (
        devLoading ? <Spinner /> : !dev || !dev.released ? (
          <Empty text="Your development view opens once your review is released." />
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
              <p className="text-xs mb-3" style={{ color: 'var(--theme-muted)' }}>
                This shows where you&apos;re strong and where to grow — it&apos;s a development tool, not a ranking.
              </p>
              <Row label="Overall competency score" value={<span className="font-semibold">{dev.scorePct == null ? '—' : `${dev.scorePct}%`}</span>} />
            </div>
            {(dev.gaps || []).length === 0 ? (
              <Empty text="No competencies are mapped to your role yet." />
            ) : (
              <div className="rounded-2xl border bg-white p-5 shadow-sm space-y-3" style={{ borderColor: 'var(--theme-border)' }}>
                <div className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>Your competency profile</div>
                {dev.gaps.map((g) => (
                  <div key={g.competencyId} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span style={{ color: 'var(--theme-text)' }}>{g.name || g.code || g.competencyId}</span>
                      {g.gap != null && <span className={g.gap < 0 ? 'text-rose-600' : 'text-emerald-600'}>{g.gap > 0 ? `+${g.gap}` : g.gap}</span>}
                    </div>
                    <GapBar expected={g.expected} actual={g.actual} />
                  </div>
                ))}
              </div>
            )}
            {dev.idpNote ? (
              <div className="rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
                <div className="text-sm font-semibold mb-1" style={{ color: 'var(--theme-text)' }}>Your development focus</div>
                <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>{dev.idpNote}</p>
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="flex items-center justify-between rounded-2xl border bg-white px-4 py-3 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      <span className="text-sm" style={{ color: 'var(--theme-muted)' }}>{label}</span>
      <span className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{value}</span>
    </div>
  );
}
function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm" style={{ color: 'var(--theme-muted)' }}>{label}</span>
      <span className="text-sm" style={{ color: 'var(--theme-text)' }}>{value}</span>
    </div>
  );
}

export default function GrowthPage() {
  return <AppShell><GrowthInner /></AppShell>;
}
