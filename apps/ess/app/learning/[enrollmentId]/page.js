'use client';

// Course player (Feature 37 ESS) — the learner runtime for one enrollment.
//   GET  /api/hr/ess/learning/enrollments/:id           → player payload (answer keys stripped)
//   POST .../enrollments/:id/lessons/:lessonId/progress → per-lesson progress (may complete)
//   GET  .../enrollments/:id/quiz/:quizId               → quiz questions (no answer key)
//   POST .../enrollments/:id/quiz/:quizId/attempt       → submit answers → server scores
// All self-derived from the session; the enrollment is re-asserted to be the learner's.

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import AppShell, { useSession } from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { apiGet, apiPost } from '@/lib/api';

function lessonDone(lp) { return lp && lp.status === 'COMPLETED'; }

function PlayerInner() {
  useSession();
  const { enrollmentId } = useParams();
  const router = useRouter();
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeLessonId, setActiveLessonId] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await apiGet(`/api/hr/ess/learning/enrollments/${enrollmentId}`);
      setPayload(p);
      setError('');
      if (!activeLessonId) {
        const first = (p.modules || []).flatMap((m) => m.lessons)[0];
        if (first) setActiveLessonId(first.id);
      }
    } catch (e) { setError(e.message || 'Failed to load course.'); }
    finally { setLoading(false); }
  }, [enrollmentId, activeLessonId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Centered><Spinner /></Centered>;
  if (!payload) return <div className="p-2"><ErrorBanner message={error || 'Not found'} /></div>;

  const lessons = (payload.modules || []).flatMap((m) => m.lessons.map((l) => ({ ...l, moduleTitle: m.title })));
  const active = lessons.find((l) => l.id === activeLessonId);
  const progressByLesson = payload.progressByLesson || {};

  async function markProgress(body) {
    setBusy(true);
    try {
      await apiPost(`/api/hr/ess/learning/enrollments/${enrollmentId}/lessons/${active.id}/progress`, body);
      await load();
    } catch (e) { setError(e.message || 'Failed to save progress.'); }
    finally { setBusy(false); }
  }

  const completed = payload.enrollment.status === 'COMPLETED';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button className="text-sm hover:underline" style={{ color: 'var(--theme-muted)' }} onClick={() => router.push('/learning')}>← My Learning</button>
        <h1 className="text-xl font-semibold" style={{ color: 'var(--theme-text)' }}>{payload.course.title}</h1>
        <span className="ml-auto text-sm" style={{ color: 'var(--theme-muted)' }}>{payload.enrollment.progressPct}% complete</span>
      </div>
      {error ? <ErrorBanner message={error} /> : null}

      {completed ? (
        <div className="rounded-xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
          <div className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>🎓 Course complete!</div>
          <CertificateLink enrollmentId={enrollmentId} />
        </div>
      ) : null}

      <div className="grid grid-cols-12 gap-4">
        {/* Lesson list */}
        <div className="col-span-4 rounded-xl border bg-white p-3 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
          {(payload.modules || []).map((m) => (
            <div key={m.id} className="mb-3">
              <div className="mb-1 text-xs font-semibold uppercase" style={{ color: 'var(--theme-muted)' }}>{m.title}</div>
              <ul className="space-y-1">
                {m.lessons.map((l) => {
                  const done = lessonDone(progressByLesson[l.id]);
                  return (
                    <li key={l.id}>
                      <button onClick={() => setActiveLessonId(l.id)} className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${activeLessonId === l.id ? 'font-medium' : ''}`}
                        style={activeLessonId === l.id ? { background: 'var(--theme-primary-soft)', color: 'var(--theme-text)' } : { color: 'var(--theme-text)' }}>
                        <span>{done ? '✓' : '○'}</span>
                        <span className="flex-1">{l.title}</span>
                        <span className="text-[10px] uppercase" style={{ color: 'var(--theme-muted)' }}>{l.kind}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        {/* Active lesson pane */}
        <div className="col-span-8 rounded-xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
          {!active ? <Empty text="No lessons." /> : (
            <LessonPane
              key={active.id}
              lesson={active}
              progress={progressByLesson[active.id]}
              enrollmentId={enrollmentId}
              attempts={(payload.attempts || []).filter((a) => active.quiz && a.quizId === active.quiz.id)}
              busy={busy}
              onProgress={markProgress}
              onQuizDone={load}
              setError={setError}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function LessonPane({ lesson, progress, enrollmentId, attempts, busy, onProgress, onQuizDone, setError }) {
  const done = lessonDone(progress);
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>{lesson.title}</h2>

      {lesson.kind === 'VIDEO' ? (
        <div className="space-y-2">
          {lesson.contentUrl ? (
            <video src={lesson.contentUrl} controls className="w-full rounded" style={{ maxHeight: 360 }} />
          ) : <Empty text="No video attached." />}
          <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>Completes at {lesson.minWatchPct}% watched.</p>
          {!done ? <button disabled={busy} onClick={() => onProgress({ watchedPct: 100, markComplete: true })} className="rounded-md px-3 py-1.5 text-sm font-medium" style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>Mark watched</button> : <span className="text-sm text-green-600">✓ Completed</span>}
        </div>
      ) : null}

      {lesson.kind === 'DOCUMENT' ? (
        <div className="space-y-2">
          {lesson.contentText ? <div className="prose prose-sm whitespace-pre-wrap rounded bg-gray-50 p-3 text-sm">{lesson.contentText}</div> : null}
          {lesson.contentUrl ? <a href={lesson.contentUrl} target="_blank" rel="noreferrer" className="text-sm underline" style={{ color: 'var(--theme-primary)' }}>Open document</a> : null}
          {!done ? <div><button disabled={busy} onClick={() => onProgress({ markRead: true })} className="rounded-md px-3 py-1.5 text-sm font-medium" style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>Mark as read</button></div> : <span className="text-sm text-green-600">✓ Read</span>}
        </div>
      ) : null}

      {(lesson.kind === 'LINK' || lesson.kind === 'SCORM') ? (
        <div className="space-y-2">
          {lesson.contentUrl ? <a href={lesson.contentUrl} target="_blank" rel="noreferrer" className="text-sm underline" style={{ color: 'var(--theme-primary)' }}>Open content ↗</a> : <Empty text="No link attached." />}
          {!done ? <div><button disabled={busy} onClick={() => onProgress({ acknowledge: true })} className="rounded-md px-3 py-1.5 text-sm font-medium" style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>I&apos;ve completed this</button></div> : <span className="text-sm text-green-600">✓ Acknowledged</span>}
        </div>
      ) : null}

      {lesson.kind === 'QUIZ' && lesson.quiz ? (
        <QuizRunner enrollmentId={enrollmentId} quizId={lesson.quiz.id} done={done} attempts={attempts} onDone={onQuizDone} setError={setError} />
      ) : null}
    </div>
  );
}

function QuizRunner({ enrollmentId, quizId, done, attempts, onDone, setError }) {
  const [quiz, setQuiz] = useState(null);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState({ attemptsUsed: 0, maxAttempts: null, alreadyPassed: false });

  const load = useCallback(async () => {
    try {
      const r = await apiGet(`/api/hr/ess/learning/enrollments/${enrollmentId}/quiz/${quizId}`);
      setQuiz(r.quiz); setMeta({ attemptsUsed: r.attemptsUsed, maxAttempts: r.maxAttempts, alreadyPassed: r.alreadyPassed });
    } catch (e) { setError(e.message); }
  }, [enrollmentId, quizId, setError]);
  useEffect(() => { load(); }, [load]);

  if (!quiz) return <Spinner />;

  function choose(qid, optId, kind) {
    if (kind === 'MULTI') {
      const cur = answers[qid] || [];
      setAnswers({ ...answers, [qid]: cur.includes(optId) ? cur.filter((x) => x !== optId) : [...cur, optId] });
    } else setAnswers({ ...answers, [qid]: [optId] });
  }

  async function submit() {
    setBusy(true);
    try {
      const r = await apiPost(`/api/hr/ess/learning/enrollments/${enrollmentId}/quiz/${quizId}/attempt`, { answers });
      setResult(r);
      if (r.completion) await onDone();
      await load();
    } catch (e) { setError(e.message || 'Failed to submit.'); }
    finally { setBusy(false); }
  }

  const passed = done || meta.alreadyPassed || (result && result.passed);
  const attemptsLeft = meta.maxAttempts == null ? '∞' : Math.max(0, meta.maxAttempts - meta.attemptsUsed);

  return (
    <div className="space-y-3">
      <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>Pass ≥ {quiz.passThreshold}% · attempts left: {attemptsLeft}</div>
      {passed ? <div className="rounded bg-green-50 px-3 py-2 text-sm text-green-700">✓ You passed this quiz{result ? ` (${result.scorePct}%)` : ''}.</div> : null}

      {!passed ? (
        <>
          {quiz.questions.map((q, i) => (
            <div key={q.id} className="rounded border p-3" style={{ borderColor: 'var(--theme-border)' }}>
              <div className="mb-2 text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{i + 1}. {q.prompt}</div>
              <div className="space-y-1">
                {q.options.map((o) => (
                  <label key={o.id} className="flex items-center gap-2 text-sm">
                    <input type={q.kind === 'MULTI' ? 'checkbox' : 'radio'} name={q.id} checked={(answers[q.id] || []).includes(o.id)} onChange={() => choose(q.id, o.id, q.kind)} />
                    {o.text}
                  </label>
                ))}
              </div>
            </div>
          ))}
          {result && !result.passed ? <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">Scored {result.scorePct}% — below the pass mark. {attemptsLeft !== 0 ? 'Try again.' : 'No attempts left — contact HR.'}</div> : null}
          {attemptsLeft !== 0 ? <button disabled={busy} onClick={submit} className="rounded-md px-3 py-1.5 text-sm font-medium" style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>Submit answers</button> : null}
        </>
      ) : null}
    </div>
  );
}

function CertificateLink({ enrollmentId }) {
  const [cert, setCert] = useState(null);
  useEffect(() => {
    apiGet(`/api/hr/ess/learning/enrollments/${enrollmentId}/certificate`).then(setCert).catch(() => setCert(null));
  }, [enrollmentId]);
  if (!cert) return <p className="mt-1 text-xs" style={{ color: 'var(--theme-muted)' }}>Your certificate is being prepared…</p>;
  return (
    <p className="mt-1 text-sm" style={{ color: 'var(--theme-text)' }}>
      Certificate <span className="font-medium">{cert.referenceNo}</span> issued — find it under <a href="/documents" className="underline" style={{ color: 'var(--theme-primary)' }}>Documents</a>.
    </p>
  );
}

export default function CoursePlayerPage() {
  return <AppShell><PlayerInner /></AppShell>;
}
