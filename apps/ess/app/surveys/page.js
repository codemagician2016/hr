'use client';

// Surveys for you — Feature 33 ESS surface. Lists my open pulse/eNPS occurrences
// with a Pending / Done badge and drives the fill flow. Wired to the REAL ESS
// contract (customer/cookie session, subject resolved server-side):
//   GET  /api/hr/me/engagement/surveys                     → { items }
//   GET  /api/hr/me/engagement/surveys/:occurrenceId       → the fill view
//        (404 not-for-you, 409 SURVEY_CLOSED / ALREADY_SUBMITTED)
//   POST /api/hr/me/engagement/surveys/:occurrenceId/submit → { receiptToken }
//        (422 missing required — server message shown verbatim)
//   POST /api/hr/me/engagement/surveys/:occurrenceId/dismiss
// Anonymous surveys carry a lock badge + the plain-language guarantee line; the
// thank-you screen shows the receiptToken (participation proof, never a person
// link) and the list item flips to Done.

import { useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import InfoTip from '@/components/InfoTip';
import { apiGet, apiPost } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { formatDate } from '@/lib/format';

const ANON_LINE = "Your responses are anonymous and can't be traced to you.";
const ATTRIBUTED_LINE = 'Responses on this survey are attributed to you.';

const TYPE_TONE = {
  PULSE: { bg: '#ecfeff', fg: '#0e7490' },
  ENPS: { bg: '#eef2ff', fg: '#4338ca' },
  CUSTOM: { bg: '#f1f5f9', fg: '#475569' },
};

function TypeChip({ type }) {
  const t = TYPE_TONE[type] || TYPE_TONE.CUSTOM;
  return (
    <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: t.bg, color: t.fg }}>
      {type === 'ENPS' ? 'eNPS' : type}
    </span>
  );
}

function LockIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 11V7a5 5 0 0110 0v4M5 11h14v10H5z" />
    </svg>
  );
}

function AnonBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
      title={ANON_LINE}
    >
      <LockIcon /> Anonymous
    </span>
  );
}

function StateBadge({ state }) {
  if (state === 'SUBMITTED') {
    return (
      <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: '#ecfdf5', color: '#047857' }}>
        Done ✓
      </span>
    );
  }
  if (state === 'DISMISSED') {
    return (
      <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: '#f1f5f9', color: '#64748b' }}>
        Dismissed
      </span>
    );
  }
  return (
    <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: '#fef3c7', color: '#92400e' }}>
      Pending
    </span>
  );
}

function closesHint(closesAt) {
  const ms = new Date(closesAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'Closed';
  const days = Math.floor(ms / 86400000);
  if (days === 0) return 'Closes today';
  if (days === 1) return 'Closes tomorrow';
  return `Closes in ${days} days`;
}

// ── answer state helpers (mirror the server's checkAnswer semantics) ─────────
function emptyAnswer() {
  return { numeric: null, choices: [], otherText: '', text: '' };
}

function isAnswered(q, a) {
  if (!a) return false;
  if (q.type === 'NPS' || q.type === 'SCALE' || q.type === 'LIKERT') return a.numeric != null;
  if (q.type === 'SINGLE' || q.type === 'MULTI') {
    return a.choices.length > 0 || (q.allowOther && a.otherText.trim() !== '');
  }
  if (q.type === 'TEXT') return a.text.trim() !== '';
  return false;
}

function answerPayload(q, a) {
  if (q.type === 'NPS' || q.type === 'SCALE' || q.type === 'LIKERT') {
    return { questionId: q.id, numericValue: a.numeric };
  }
  if (q.type === 'SINGLE' || q.type === 'MULTI') {
    const out = { questionId: q.id, choiceValues: a.choices };
    if (q.allowOther && a.otherText.trim() !== '') out.textValue = a.otherText.trim();
    return out;
  }
  return { questionId: q.id, textValue: a.text.trim() };
}

// Tappable number pills for SCALE / LIKERT / NPS, with the min/max labels.
function NumberPills({ min, max, minLabel, maxLabel, value, onChange }) {
  const lo = Number.isInteger(min) ? min : 1;
  const hi = Number.isInteger(max) ? max : 5;
  const values = [];
  for (let v = lo; v <= hi; v += 1) values.push(v);
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => {
          const on = value === v;
          return (
            <button
              key={v}
              type="button"
              onClick={() => onChange(on ? null : v)}
              aria-pressed={on}
              className="min-w-[2.25rem] rounded-lg border px-2 py-1.5 text-sm font-medium"
              style={on
                ? { background: 'var(--theme-primary)', borderColor: 'var(--theme-primary)', color: '#fff' }
                : { borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
            >
              {v}
            </button>
          );
        })}
      </div>
      {(minLabel || maxLabel) && (
        <div className="mt-1 flex justify-between text-[11px]" style={{ color: 'var(--theme-muted)' }}>
          <span>{lo} = {minLabel || 'low'}</span>
          <span>{hi} = {maxLabel || 'high'}</span>
        </div>
      )}
    </div>
  );
}

// One question block in the fill form.
function QuestionField({ q, answer, onChange, missing }) {
  const a = answer || emptyAnswer();
  const set = (patch) => onChange({ ...a, ...patch });
  return (
    <div
      className="rounded-xl border p-4"
      style={{ borderColor: missing ? '#f59e0b' : 'var(--theme-border)' }}
    >
      <p className="mb-3 text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
        {q.prompt}
        {q.required && <span className="ml-1" style={{ color: '#dc2626' }} title="Required">*</span>}
      </p>

      {(q.type === 'SCALE' || q.type === 'LIKERT' || q.type === 'NPS') && (
        <NumberPills
          min={q.type === 'NPS' ? 0 : q.scaleMin}
          max={q.type === 'NPS' ? 10 : q.scaleMax}
          minLabel={q.scaleMinLabel}
          maxLabel={q.scaleMaxLabel}
          value={a.numeric}
          onChange={(v) => set({ numeric: v })}
        />
      )}

      {q.type === 'SINGLE' && (
        <div className="space-y-2">
          {(q.options || []).map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm" style={{ color: 'var(--theme-text)' }}>
              <input
                type="radio"
                name={`q-${q.id}`}
                checked={a.choices[0] === o.value}
                onChange={() => set({ choices: [o.value], otherText: '' })}
              />
              {o.label}
            </label>
          ))}
          {q.allowOther && (
            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--theme-text)' }}>
              <input
                type="radio"
                name={`q-${q.id}`}
                checked={a.choices.length === 0 && a.otherText !== ''}
                onChange={() => set({ choices: [], otherText: a.otherText || ' ' })}
              />
              Other:
              <input
                value={a.otherText.trim() === '' ? '' : a.otherText}
                onChange={(e) => set({ choices: [], otherText: e.target.value })}
                className="flex-1 rounded-lg border px-2 py-1 text-sm"
                style={{ borderColor: 'var(--theme-border)' }}
                placeholder="Say it in your own words…"
                aria-label="Other answer"
              />
            </label>
          )}
        </div>
      )}

      {q.type === 'MULTI' && (
        <div className="space-y-2">
          {(q.options || []).map((o) => {
            const on = a.choices.includes(o.value);
            return (
              <label key={o.value} className="flex items-center gap-2 text-sm" style={{ color: 'var(--theme-text)' }}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => set({ choices: on ? a.choices.filter((c) => c !== o.value) : [...a.choices, o.value] })}
                />
                {o.label}
              </label>
            );
          })}
          {q.allowOther && (
            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--theme-text)' }}>
              <span>Other:</span>
              <input
                value={a.otherText}
                onChange={(e) => set({ otherText: e.target.value })}
                className="flex-1 rounded-lg border px-2 py-1 text-sm"
                style={{ borderColor: 'var(--theme-border)' }}
                placeholder="Anything else…"
                aria-label="Other answer"
              />
            </label>
          )}
        </div>
      )}

      {q.type === 'TEXT' && (
        <textarea
          value={a.text}
          onChange={(e) => set({ text: e.target.value })}
          rows={3}
          className="w-full rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--theme-border)' }}
          placeholder="Write as much or as little as you like…"
          aria-label={q.prompt}
        />
      )}

      {missing && (
        <p className="mt-2 text-xs font-medium" style={{ color: '#b45309' }}>This question is required.</p>
      )}
    </div>
  );
}

// ── the fill flow (one occurrence) ───────────────────────────────────────────
function FillView({ occurrenceId, onDone, onBack }) {
  const [occ, setOcc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [answers, setAnswers] = useState({});
  const [missing, setMissing] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    apiGet(`/api/hr/me/engagement/surveys/${occurrenceId}`)
      .then((body) => { if (alive) setOcc(body); })
      .catch((e) => { if (alive) setLoadError(e); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [occurrenceId]);

  const questions = occ?.questions || [];
  // Group into sections preserving question order (section only prints when it changes).
  const rows = useMemo(() => {
    const out = [];
    let last = null;
    for (const q of questions) {
      const section = q.section || null;
      if (section !== last) {
        if (section) out.push({ kind: 'section', key: `s-${q.id}`, label: section });
        last = section;
      }
      out.push({ kind: 'question', key: q.id, q });
    }
    return out;
  }, [questions]);

  async function submit() {
    setSubmitError('');
    // Client-side required check (the server's 422 is the backstop).
    const miss = {};
    for (const q of questions) {
      if (q.required && !isAnswered(q, answers[q.id])) miss[q.id] = true;
    }
    setMissing(miss);
    if (Object.keys(miss).length) {
      setSubmitError('Please answer the required questions highlighted below.');
      return;
    }
    const payload = {
      answers: questions
        .filter((q) => isAnswered(q, answers[q.id]))
        .map((q) => answerPayload(q, answers[q.id])),
    };
    setSubmitting(true);
    try {
      const res = await apiPost(`/api/hr/me/engagement/surveys/${occurrenceId}/submit`, payload);
      onDone({ receiptToken: res.receiptToken, title: occ?.survey?.title, anonymous: !!occ?.survey?.anonymous });
    } catch (e) {
      // 422 (missing required / bad value) and 409 (closed / already submitted):
      // show the server's message verbatim.
      setSubmitError(e.message || 'Could not submit your answers.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <Centered><Spinner /></Centered>;

  if (loadError) {
    return (
      <div className="space-y-4">
        <ErrorBanner message={loadError.message || 'Could not open this survey.'} />
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg border px-3 py-2 text-xs font-medium"
          style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
        >
          ← Back to surveys
        </button>
      </div>
    );
  }

  const survey = occ?.survey || {};

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="text-xs font-medium"
        style={{ color: 'var(--theme-muted)' }}
      >
        ← Back to surveys
      </button>

      <div className="rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <TypeChip type={survey.type} />
          {occ?.seq > 1 && (
            <span className="text-xs" style={{ color: 'var(--theme-muted)' }}>Pulse #{occ.seq}</span>
          )}
          {survey.anonymous && <AnonBadge />}
          <span className="ml-auto text-xs" style={{ color: 'var(--theme-muted)' }}>{closesHint(occ?.closesAt)}</span>
        </div>
        <h1 className="text-xl font-semibold" style={{ color: 'var(--theme-text)' }}>{survey.title}</h1>
        {survey.description && (
          <p className="mt-1 whitespace-pre-wrap text-sm" style={{ color: 'var(--theme-muted)' }}>{survey.description}</p>
        )}
        <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: survey.anonymous ? '#047857' : 'var(--theme-muted)' }}>
          {survey.anonymous && <LockIcon />}
          {survey.anonymous ? ANON_LINE : ATTRIBUTED_LINE}
          {survey.anonymous && (
            <InfoTip text="Your ballot is stored with no link to your name or employee record — not even HR or IT can trace it back. Only the fact THAT you took part is recorded (so you aren't asked twice)." />
          )}
        </p>
      </div>

      {submitError && <ErrorBanner message={submitError} />}

      <div className="space-y-3">
        {rows.map((row) => row.kind === 'section' ? (
          <h2 key={row.key} className="pt-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>
            {row.label}
          </h2>
        ) : (
          <QuestionField
            key={row.key}
            q={row.q}
            answer={answers[row.q.id]}
            missing={!!missing[row.q.id]}
            onChange={(a) => {
              setAnswers((prev) => ({ ...prev, [row.q.id]: a }));
              setMissing((prev) => (prev[row.q.id] ? { ...prev, [row.q.id]: false } : prev));
            }}
          />
        ))}
      </div>

      <div className="flex items-center justify-end gap-3">
        <span className="text-xs" style={{ color: 'var(--theme-muted)' }}>
          <span style={{ color: '#dc2626' }}>*</span> required
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--theme-primary)' }}
        >
          {submitting ? 'Submitting…' : 'Submit answers'}
        </button>
      </div>
    </div>
  );
}

// ── the thank-you / receipt screen ───────────────────────────────────────────
function ReceiptView({ receipt, onBack }) {
  return (
    <div className="rounded-2xl border bg-white p-8 text-center shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      <div
        className="mx-auto flex h-12 w-12 items-center justify-center rounded-full"
        style={{ background: '#ecfdf5', color: '#047857' }}
        aria-hidden="true"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </div>
      <h1 className="mt-4 text-xl font-semibold" style={{ color: 'var(--theme-text)' }}>Thank you!</h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--theme-muted)' }}>
        Your answers to “{receipt.title}” have been recorded{receipt.anonymous ? ' anonymously' : ''}.
      </p>
      {receipt.receiptToken && (
        <div className="mt-4">
          <code
            className="inline-block rounded-lg border px-3 py-1.5 font-mono text-[11px]"
            style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
          >
            {receipt.receiptToken}
          </code>
          <p className="mt-1 inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--theme-muted)' }}>
            your participation receipt
            <InfoTip text="A random token proving you took part. It is not linked to your answers or your identity — keep it if you ever need to show you responded." />
          </p>
        </div>
      )}
      <div className="mt-6">
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg px-4 py-2 text-sm font-medium text-white"
          style={{ background: 'var(--theme-primary)' }}
        >
          Back to surveys
        </button>
      </div>
    </div>
  );
}

// ── one list card ────────────────────────────────────────────────────────────
function SurveyCard({ item, onFill, onDismiss, busy }) {
  const s = item.survey || {};
  const done = item.state === 'SUBMITTED';
  return (
    <article className="rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <TypeChip type={s.type} />
        {(s.cadence || item.seq > 1) && (
          <span className="text-xs" style={{ color: 'var(--theme-muted)' }}>Pulse #{item.seq}</span>
        )}
        {s.anonymous && <AnonBadge />}
        <span className="ml-auto"><StateBadge state={item.state} /></span>
      </div>
      <h3 className="text-base font-semibold" style={{ color: 'var(--theme-text)' }}>{s.title}</h3>
      {s.description && (
        <p className="mt-0.5 line-clamp-2 text-sm" style={{ color: 'var(--theme-muted)' }}>{s.description}</p>
      )}
      {s.anonymous && (
        <p className="mt-1.5 inline-flex items-center gap-1 text-xs" style={{ color: '#047857' }}>
          <LockIcon /> {ANON_LINE}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className="text-xs" style={{ color: 'var(--theme-muted)' }}>
          {closesHint(item.closesAt)} · {formatDate(item.closesAt)}
        </span>
        <span className="ml-auto inline-flex items-center gap-3">
          {done ? (
            <span className="text-xs" style={{ color: 'var(--theme-muted)' }}>
              Answered {item.submittedAt ? formatDate(item.submittedAt) : ''}
            </span>
          ) : (
            <>
              {item.state !== 'DISMISSED' && (
                <button
                  type="button"
                  onClick={() => onDismiss(item.occurrenceId)}
                  disabled={busy}
                  className="text-xs font-medium underline-offset-2 hover:underline disabled:opacity-50"
                  style={{ color: 'var(--theme-muted)' }}
                >
                  Dismiss
                </button>
              )}
              <button
                type="button"
                onClick={() => onFill(item.occurrenceId)}
                disabled={busy}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--theme-primary)' }}
              >
                {item.state === 'DISMISSED' ? 'Answer anyway' : 'Fill survey'}
              </button>
            </>
          )}
        </span>
      </div>
    </article>
  );
}

function SurveysInner() {
  const [fillId, setFillId] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  const { data: items, loading, error, reload } = useApi('/api/hr/me/engagement/surveys', {
    select: (b) => b?.items || [],
  });

  async function dismiss(occurrenceId) {
    setBusy(true);
    setActionError('');
    try {
      await apiPost(`/api/hr/me/engagement/surveys/${occurrenceId}/dismiss`);
      await reload();
    } catch (e) {
      setActionError(e.message || 'Could not dismiss the survey.');
    } finally {
      setBusy(false);
    }
  }

  if (receipt) {
    return <ReceiptView receipt={receipt} onBack={() => { setReceipt(null); reload(); }} />;
  }

  if (fillId) {
    return (
      <FillView
        occurrenceId={fillId}
        onBack={() => { setFillId(null); reload(); }}
        onDone={(r) => { setFillId(null); setReceipt(r); reload(); }}
      />
    );
  }

  const list = items || [];
  const pending = list.filter((i) => i.state === 'PENDING').length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>
          Surveys for you
          <InfoTip text="Short pulse and eNPS surveys addressed to you. Anonymous ones (the lock badge) are stored with no link to your identity — answer honestly." />
        </h1>
        <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
          {pending > 0
            ? `${pending} survey${pending === 1 ? '' : 's'} waiting for your voice.`
            : 'Your voice, a couple of minutes at a time.'}
        </p>
      </header>

      {actionError && <ErrorBanner message={actionError} />}

      {loading ? (
        <Centered><Spinner /></Centered>
      ) : error ? (
        // A not-yet-deployed route (404) degrades to a friendly empty state.
        error.status === 404 ? (
          <Empty text="No surveys right now. Check back soon." />
        ) : (
          <ErrorBanner message={error.message || 'Could not load your surveys.'} />
        )
      ) : list.length === 0 ? (
        <Empty text="No surveys right now. Check back soon." />
      ) : (
        <div className="space-y-3">
          {list.map((item) => (
            <SurveyCard
              key={item.occurrenceId}
              item={item}
              busy={busy}
              onFill={setFillId}
              onDismiss={dismiss}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function SurveysPage() {
  return (
    <AppShell>
      <SurveysInner />
    </AppShell>
  );
}
