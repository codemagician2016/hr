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
import { ErrorBanner, Empty, Spinner, Centered, RatingScale, GoalCard, GapBar, Modal, ModalActions, PrimaryButton, TextInput, TextArea, DateField } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { apiGet, apiPost } from '@/lib/api';

function GrowthInner() {
  useSession();
  const [tab, setTab] = useState('hub');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selfRating, setSelfRating] = useState(0);
  const [selfComments, setSelfComments] = useState('');

  const { data: overview, loading: ovLoading, reload: reloadOverview } = useApi('/api/hr/ess/performance/overview');
  const { data: goals, loading: goalsLoading, reload: reloadGoals } = useApi('/api/hr/ess/performance/goals', {
    select: (b) => (Array.isArray(b) ? b : b?.items || []),
  });
  // Feedback the employee OWES as a rater (own only; requester sees status elsewhere).
  const { data: feedback, loading: fbLoading, reload: reloadFeedback } = useApi('/api/hr/ess/performance/feedback/requests', {
    enabled: tab === 'feedback',
    select: (b) => (Array.isArray(b) ? b : b?.items || []),
  });
  const [goalModal, setGoalModal] = useState(false);
  const [activeGoal, setActiveGoal] = useState(null); // goal object opened for KR detail
  const [requestFb, setRequestFb] = useState(false);
  const [respondFb, setRespondFb] = useState(null); // feedback request being answered
  const { data: reviewWrap, loading: reviewLoading, reload: reloadReview } = useApi('/api/hr/ess/performance/review', {
    select: (b) => b?.review ?? null,
  });
  const review = reviewWrap;
  // Feature 34 — development surface: own competency gaps + shared IDP only. The box,
  // potential rating, and any talent tag are NEVER in this payload (server-stripped).
  const { data: dev, loading: devLoading } = useApi('/api/hr/ess/performance/development', { enabled: tab === 'development' });

  async function submitSelf() {
    if (!selfRating) { setError('Please choose your self-rating before submitting.'); return; }
    setBusy(true); setError('');
    try {
      await apiPost('/api/hr/ess/performance/review/self', {
        selfRating,
        selfComments: selfComments.trim() || undefined,
      });
      reloadReview();
    } catch (e) { setError(e.message || 'Failed to submit self-review.'); }
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
        {[['hub', 'Overview'], ['goals', 'My Goals'], ['review', 'My Review'], ['feedback', 'Feedback'], ['development', 'Development']].map(([k, label]) => {
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
        <div className="space-y-3">
          <div className="flex justify-end">
            <button onClick={() => setGoalModal(true)}
              className="rounded-lg px-3.5 py-2 text-sm font-semibold transition"
              style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
              New goal
            </button>
          </div>
          {goalsLoading ? <Spinner /> : (
            (goals || []).length === 0 ? <Empty text="No goals yet." /> : (
              <div className="space-y-2">
                {goals.map((g) => <GoalCard key={g.id} goal={g} onClick={() => setActiveGoal(g)} />)}
              </div>
            )
          )}
        </div>
      ) : null}

      {tab === 'feedback' ? (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button onClick={() => setRequestFb(true)}
              className="rounded-lg px-3.5 py-2 text-sm font-semibold transition"
              style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
              Request feedback
            </button>
          </div>
          <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>
            Feedback colleagues have asked you to give. Your response stays confidential to the reviewer.
          </p>
          {fbLoading ? <Spinner /> : (
            (feedback || []).length === 0 ? <Empty text="No feedback is owed by you right now." /> : (
              <div className="space-y-2">
                {feedback.map((f) => (
                  <div key={f.id} className="flex items-center justify-between rounded-2xl border bg-white px-4 py-3 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
                    <div>
                      <div className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>Feedback request</div>
                      <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>
                        {f.dueDate ? `Due ${new Date(f.dueDate).toLocaleDateString()}` : 'No due date'} · {f.status}
                      </div>
                    </div>
                    <button onClick={() => setRespondFb(f)}
                      className="rounded-lg px-3 py-1.5 text-sm font-semibold transition"
                      style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
                      Respond
                    </button>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
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
            {review.status === 'NOT_STARTED' ? (
              <div className="space-y-3 pt-3 border-t" style={{ borderColor: 'var(--theme-border)' }}>
                <div>
                  <p className="text-sm font-medium mb-1.5" style={{ color: 'var(--theme-text)' }}>Your self-rating</p>
                  <div className="flex gap-2">
                    {[1, 2, 3, 4, 5].map((n) => {
                      const on = selfRating === n;
                      return (
                        <button key={n} type="button" onClick={() => setSelfRating(n)}
                          className="h-9 w-9 rounded-lg text-sm font-semibold transition"
                          style={on
                            ? { background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }
                            : { background: 'var(--theme-primary-soft)', color: 'var(--theme-text)' }}>
                          {n}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-xs mt-1" style={{ color: 'var(--theme-muted)' }}>1 = Needs improvement · 5 = Outstanding</p>
                </div>
                <div>
                  <p className="text-sm font-medium mb-1.5" style={{ color: 'var(--theme-text)' }}>Your comments <span style={{ color: 'var(--theme-muted)' }}>(optional)</span></p>
                  <textarea value={selfComments} onChange={(e) => setSelfComments(e.target.value)} rows={3}
                    placeholder="What went well, what you're proud of, where you want to grow…"
                    className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                    style={{ borderColor: 'var(--theme-border)' }} />
                </div>
                <button disabled={busy || !selfRating} onClick={submitSelf}
                  className="rounded-lg px-3.5 py-2 text-sm font-semibold transition disabled:opacity-60"
                  style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
                  {busy ? 'Submitting…' : 'Submit self-review'}
                </button>
              </div>
            ) : null}
            <div className="flex gap-2 pt-2">
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

      {goalModal ? (
        <NewGoalModal
          onClose={() => setGoalModal(false)}
          onSaved={() => { setGoalModal(false); reloadGoals(); reloadOverview(); }}
          onError={setError}
        />
      ) : null}

      {activeGoal ? (
        <GoalDetailModal
          goal={activeGoal}
          onClose={() => setActiveGoal(null)}
          onChanged={() => { reloadGoals(); reloadOverview(); }}
          onError={setError}
        />
      ) : null}

      {requestFb ? (
        <RequestFeedbackModal
          onClose={() => setRequestFb(false)}
          onSaved={() => { setRequestFb(false); reloadOverview(); }}
          onError={setError}
        />
      ) : null}

      {respondFb ? (
        <RespondFeedbackModal
          request={respondFb}
          onClose={() => setRespondFb(null)}
          onSaved={() => { setRespondFb(null); reloadFeedback(); reloadOverview(); }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

// ── New goal: POST /goals { title, level, weight, dueDate } (self-owned) ────────
function NewGoalModal({ onClose, onSaved, onError }) {
  const [title, setTitle] = useState('');
  const [level, setLevel] = useState('INDIVIDUAL');
  const [weight, setWeight] = useState('1');
  const [dueDate, setDueDate] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!title.trim() || !dueDate) { onError('Title and due date are required.'); return; }
    setBusy(true); onError('');
    try {
      await apiPost('/api/hr/ess/performance/goals', {
        title: title.trim(),
        level,
        weight: Number(weight) || 0,
        dueDate,
        description: description.trim() || undefined,
      });
      onSaved();
    } catch (e) { onError(e.message || 'Failed to create goal.'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="New goal" onClose={onClose}>
      <div className="space-y-4">
        <TextInput label="Title" value={title} onChange={setTitle} required />
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Level</label>
          <select value={level} onChange={(e) => setLevel(e.target.value)}
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm">
            <option value="INDIVIDUAL">Individual</option>
            <option value="TEAM">Team</option>
            <option value="COMPANY">Company</option>
          </select>
        </div>
        <TextInput label="Weight" value={weight} onChange={setWeight} type="number" min="0" step="1" hint="Relative importance of this goal." />
        <DateField label="Due date" value={dueDate} onChange={setDueDate} required />
        <TextArea label="Description (optional)" value={description} onChange={setDescription} rows={3} />
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 rounded-lg hover:bg-gray-100">Cancel</button>
          <PrimaryButton onClick={save} loading={busy}>Create goal</PrimaryButton>
        </ModalActions>
      </div>
    </Modal>
  );
}

// ── Goal detail: list KRs, add a KR (POST /goals/:id/key-results), and check in
//    on a KR (POST /key-results/:id/check-ins { newValue }). Own goal only. ──────
function GoalDetailModal({ goal, onClose, onChanged, onError }) {
  const { data: krs, loading, reload } = useApi(`/api/hr/ess/performance/goals`, {
    select: (b) => {
      const items = Array.isArray(b) ? b : b?.items || [];
      const fresh = items.find((g) => g.id === goal.id) || goal;
      return fresh.keyResults || [];
    },
  });
  const [addKr, setAddKr] = useState(false);
  const [checkInKr, setCheckInKr] = useState(null);

  return (
    <Modal title={goal.title} onClose={onClose} size="lg">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>Key results</span>
          <button onClick={() => setAddKr(true)}
            className="rounded-lg px-3 py-1.5 text-sm font-semibold transition"
            style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
            Add key result
          </button>
        </div>
        {loading ? <Spinner /> : (
          (krs || []).length === 0 ? <Empty text="No key results yet." /> : (
            <div className="space-y-2">
              {krs.map((kr) => (
                <div key={kr.id} className="flex items-center justify-between rounded-xl border bg-white px-4 py-3 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{kr.title}</div>
                    <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>
                      {kr.currentValue}{kr.unit ? ` ${kr.unit}` : ''} / {kr.targetValue}{kr.unit ? ` ${kr.unit}` : ''} · {kr.confidence}
                    </div>
                  </div>
                  <button onClick={() => setCheckInKr(kr)}
                    className="rounded-lg px-3 py-1.5 text-sm font-semibold transition"
                    style={{ background: 'var(--theme-primary-soft)', color: 'var(--theme-text)' }}>
                    Check in
                  </button>
                </div>
              ))}
            </div>
          )
        )}
      </div>

      {addKr ? (
        <AddKeyResultModal
          goalId={goal.id}
          onClose={() => setAddKr(false)}
          onSaved={() => { setAddKr(false); reload(); onChanged(); }}
          onError={onError}
        />
      ) : null}
      {checkInKr ? (
        <CheckInModal
          kr={checkInKr}
          onClose={() => setCheckInKr(null)}
          onSaved={() => { setCheckInKr(null); reload(); onChanged(); }}
          onError={onError}
        />
      ) : null}
    </Modal>
  );
}

// POST /goals/:id/key-results { title, metricType, startValue, targetValue, weight }
function AddKeyResultModal({ goalId, onClose, onSaved, onError }) {
  const [title, setTitle] = useState('');
  const [metricType, setMetricType] = useState('NUMBER');
  const [startValue, setStartValue] = useState('0');
  const [targetValue, setTargetValue] = useState('');
  const [unit, setUnit] = useState('');
  const [weight, setWeight] = useState('1');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!title.trim() || targetValue === '') { onError('Title and target value are required.'); return; }
    setBusy(true); onError('');
    try {
      await apiPost(`/api/hr/ess/performance/goals/${goalId}/key-results`, {
        title: title.trim(),
        metricType,
        startValue: Number(startValue) || 0,
        targetValue: Number(targetValue),
        unit: unit.trim() || undefined,
        weight: Number(weight) || 0,
      });
      onSaved();
    } catch (e) { onError(e.message || 'Failed to add key result.'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Add key result" onClose={onClose}>
      <div className="space-y-4">
        <TextInput label="Title" value={title} onChange={setTitle} required />
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Metric type</label>
          <select value={metricType} onChange={(e) => setMetricType(e.target.value)}
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm">
            <option value="NUMBER">Number</option>
            <option value="PERCENT">Percent</option>
            <option value="CURRENCY">Currency</option>
            <option value="BOOLEAN">Done / not done</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <TextInput label="Start value" value={startValue} onChange={setStartValue} type="number" />
          <TextInput label="Target value" value={targetValue} onChange={setTargetValue} type="number" required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <TextInput label="Unit (optional)" value={unit} onChange={setUnit} />
          <TextInput label="Weight" value={weight} onChange={setWeight} type="number" min="0" step="1" />
        </div>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 rounded-lg hover:bg-gray-100">Cancel</button>
          <PrimaryButton onClick={save} loading={busy}>Add key result</PrimaryButton>
        </ModalActions>
      </div>
    </Modal>
  );
}

// POST /key-results/:id/check-ins { newValue, confidence?, note? }
function CheckInModal({ kr, onClose, onSaved, onError }) {
  const [newValue, setNewValue] = useState(String(kr.currentValue ?? ''));
  const [confidence, setConfidence] = useState(kr.confidence || 'ON_TRACK');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (newValue === '') { onError('A new value is required to check in.'); return; }
    setBusy(true); onError('');
    try {
      await apiPost(`/api/hr/ess/performance/key-results/${kr.id}/check-ins`, {
        newValue: Number(newValue),
        confidence,
        note: note.trim() || undefined,
      });
      onSaved();
    } catch (e) { onError(e.message || 'Failed to record check-in.'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`Check in · ${kr.title}`} onClose={onClose}>
      <div className="space-y-4">
        <TextInput label="New value" value={newValue} onChange={setNewValue} type="number"
          hint={`Target ${kr.targetValue}${kr.unit ? ` ${kr.unit}` : ''}`} required />
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Confidence</label>
          <select value={confidence} onChange={(e) => setConfidence(e.target.value)}
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm">
            <option value="ON_TRACK">On track</option>
            <option value="AT_RISK">At risk</option>
            <option value="OFF_TRACK">Off track</option>
          </select>
        </div>
        <TextArea label="Note (optional)" value={note} onChange={setNote} rows={3} />
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 rounded-lg hover:bg-gray-100">Cancel</button>
          <PrimaryButton onClick={save} loading={busy}>Record check-in</PrimaryButton>
        </ModalActions>
      </div>
    </Modal>
  );
}

// ── Request feedback about ME: POST /feedback/requests { raterEmployeeId, dueDate? }
//    The rater is picked from the SELF-scoped colleague directory (employee ids). ─
function RequestFeedbackModal({ onClose, onSaved, onError }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(null); // { id, name }
  const [dueDate, setDueDate] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);

  async function search() {
    setSearching(true); onError('');
    try {
      const body = await apiGet(`/api/hr/me/directory?pageSize=20${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      setResults(Array.isArray(body) ? body : body?.items || []);
    } catch (e) { onError(e.message || 'Failed to search colleagues.'); }
    finally { setSearching(false); }
  }

  async function save() {
    if (!picked) { onError('Choose a colleague to request feedback from.'); return; }
    setBusy(true); onError('');
    try {
      await apiPost('/api/hr/ess/performance/feedback/requests', {
        raterEmployeeId: picked.id,
        dueDate: dueDate || undefined,
      });
      onSaved();
    } catch (e) { onError(e.message || 'Failed to request feedback.'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Request feedback" onClose={onClose}>
      <div className="space-y-4">
        {picked ? (
          <div className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2">
            <span className="text-sm font-medium text-gray-900">{picked.name}</span>
            <button type="button" onClick={() => setPicked(null)} className="text-xs text-gray-500 hover:text-gray-800">Change</button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } }}
                placeholder="Search colleagues by name…"
                className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm" />
              <button type="button" onClick={search} disabled={searching}
                className="rounded-lg px-3.5 py-2 text-sm font-semibold transition disabled:opacity-60"
                style={{ background: 'var(--theme-primary-soft)', color: 'var(--theme-text)' }}>
                {searching ? '…' : 'Search'}
              </button>
            </div>
            {results.length > 0 ? (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
                {results.map((r) => (
                  <button key={r.id} type="button" onClick={() => { setPicked({ id: r.id, name: r.name }); setResults([]); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50">
                    <span className="font-medium text-gray-900">{r.name}</span>
                    {r.designation ? <span className="text-gray-500"> · {r.designation}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
        <DateField label="Due date (optional)" value={dueDate} onChange={setDueDate} />
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 rounded-lg hover:bg-gray-100">Cancel</button>
          <PrimaryButton onClick={save} loading={busy} disabled={!picked}>Send request</PrimaryButton>
        </ModalActions>
      </div>
    </Modal>
  );
}

// POST /feedback/requests/:id/respond { narrative?, isAnonymous? }
function RespondFeedbackModal({ request, onClose, onSaved, onError }) {
  const [narrative, setNarrative] = useState('');
  const [isAnonymous, setIsAnonymous] = useState(true);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!narrative.trim()) { onError('Please write your feedback before submitting.'); return; }
    setBusy(true); onError('');
    try {
      await apiPost(`/api/hr/ess/performance/feedback/requests/${request.id}/respond`, {
        narrative: narrative.trim(),
        isAnonymous,
      });
      onSaved();
    } catch (e) { onError(e.message || 'Failed to submit feedback.'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Give feedback" onClose={onClose}>
      <div className="space-y-4">
        <TextArea label="Your feedback" value={narrative} onChange={setNarrative} rows={5} />
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={isAnonymous} onChange={(e) => setIsAnonymous(e.target.checked)} />
          Keep my response anonymous
        </label>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 rounded-lg hover:bg-gray-100">Cancel</button>
          <PrimaryButton onClick={save} loading={busy}>Submit feedback</PrimaryButton>
        </ModalActions>
      </div>
    </Modal>
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
