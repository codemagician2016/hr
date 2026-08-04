'use client';

// One step in a stage. The row informs, then gets out of the way: it never
// operates the feature, it just says what the thing is, what it costs, and
// sends you to the real screen — "Set up →" when pending, "Review →" when done.
//
// State is carried by a SHAPE and a WORD, never by colour: a drawn check for
// done, a hollow ring for to-do, a dash for a probe we couldn't run. That also
// means the row still reads correctly in a screenshot, a print, or a high-
// contrast theme where our brand colour has been replaced.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ctaVerb, permissionPhrase, stepHref } from '@/lib/setup';
import StepExplainer from '@/components/setup/StepExplainer';

function CheckGlyph() {
  return (
    <span
      className="inline-flex h-5 w-5 items-center justify-center rounded-full"
      style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
    >
      <svg viewBox="0 0 20 20" className="h-3 w-3" aria-hidden focusable="false">
        <path
          d="M4 10.5l4 4 8-8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function RingGlyph({ required }) {
  return (
    <span
      className={`inline-block h-5 w-5 rounded-full border-2 ${
        required ? 'border-gray-700' : 'border-gray-400'
      }`}
    />
  );
}

function DashGlyph() {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center">
      <span className="block h-0.5 w-3 rounded-full bg-gray-500" />
    </span>
  );
}

function glyphFor(step) {
  if (step.state === 'done') return <CheckGlyph />;
  if (step.state === 'unknown') return <DashGlyph />;
  return <RingGlyph required={step.required} />;
}

function wordFor(step) {
  if (step.state === 'done') return 'Done';
  if (step.state === 'unknown') return 'Couldn’t check';
  return 'To do';
}

function Chip({ children, bordered }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        bordered ? 'border border-gray-400 text-gray-700' : 'text-gray-600'
      }`}
    >
      {children}
    </span>
  );
}

// The 10-second grace window after "Not needed for us". The row stays exactly
// where it was rather than vanishing, so the operator can see what they did and
// take it back without hunting for it in the footer.
function UndoRow({ step, onRestore }) {
  const btn = useRef(null);
  useEffect(() => { btn.current?.focus(); }, []);
  return (
    <li className="flex items-center justify-between gap-3 py-3 pl-8 pr-1 text-sm">
      <span className="min-w-0 truncate text-gray-600">“{step.label}” hidden.</span>
      <button
        ref={btn}
        type="button"
        onClick={() => onRestore(step.key)}
        className="shrink-0 text-sm font-semibold text-gray-900 underline decoration-gray-400 underline-offset-2 hover:text-gray-900"
      >
        Undo
      </button>
    </li>
  );
}

export default function StepRow({ step, currency, country, onDismiss, onRestore, undo, labelOf }) {
  const [explainOpen, setExplainOpen] = useState(false);

  if (undo) return <UndoRow step={step} onRestore={onRestore} />;

  const done = step.state === 'done';
  const explainId = `setup-explain-${step.key}`;
  const descId = `setup-desc-${step.key}`;
  const prereqMissing = step.prerequisitesMet === false
    ? (step.dependsOn || []).filter((k) => labelOf && labelOf(k) && !labelOf(k).done)
    : [];

  const meta = [
    step.coverage ? `${step.coverage.done} of ${step.coverage.total} ${step.coverage.unit}` : null,
    !done && step.minutes ? `about ${step.minutes} min` : null,
    !done && step.doneBy ? `usually done by ${step.doneBy}` : null,
  ].filter(Boolean);

  return (
    <li
      id={`setup-step-${step.key}`}
      className="scroll-mt-28 border-b border-gray-100 py-3.5 last:border-0"
    >
      <div className="flex gap-3">
        <span className="mt-0.5 shrink-0" aria-hidden>{glyphFor(step)}</span>

        <div className="min-w-0 flex-1">
          {step.permitted === false ? (
            // No link: the destination would 403. Say who can do it instead of
            // offering a button that dead-ends.
            <p className={`text-sm font-medium ${done ? 'text-gray-600' : 'text-gray-700'}`}>
              {step.label}
            </p>
          ) : (
            <Link
              href={stepHref(step)}
              aria-describedby={descId}
              data-setup-step={step.key}
              data-setup-todo={done ? undefined : 'true'}
              className="flex items-start justify-between gap-3 rounded-sm"
            >
              <span
                className={`text-sm ${done ? 'font-medium text-gray-600' : 'font-semibold text-gray-900'}`}
              >
                {step.label}
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-gray-700">
                {ctaVerb(step)} <span aria-hidden>→</span>
              </span>
            </Link>
          )}

          <p id={descId} className="mt-0.5 text-sm leading-relaxed text-gray-600">
            {step.description}
          </p>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Chip>{wordFor(step)}</Chip>
            {step.required && !done && <Chip bordered>Required</Chip>}
            {meta.map((m) => (
              <span key={m} className="text-[11px] text-gray-600">· {m}</span>
            ))}
          </div>

          {step.permitted === false && (
            <p className="mt-1 text-xs text-gray-600">
              Needs someone who can {permissionPhrase(step.permission)}.
            </p>
          )}

          {prereqMissing.length > 0 && (
            <p className="mt-1 text-xs text-gray-600">
              Easier once you’ve finished{' '}
              {prereqMissing.map((k, i) => (
                <span key={k}>
                  {i > 0 ? ' and ' : ''}“{labelOf(k).label}”
                </span>
              ))}
              . You can still do it now.
            </p>
          )}

          {(step.explain || step.dismissible) && (
            <div className="mt-2 flex flex-wrap items-center gap-4">
              {step.explain && (
                <button
                  type="button"
                  aria-expanded={explainOpen}
                  aria-controls={explainId}
                  onClick={() => setExplainOpen((v) => !v)}
                  className="text-xs font-medium text-gray-700 underline decoration-gray-400 underline-offset-2 hover:text-gray-900"
                >
                  {explainOpen ? 'Hide explanation' : 'What is this?'}
                </button>
              )}
              {/* Required steps are never dismissible — the server rejects it, so
                  we never offer it. */}
              {step.dismissible && !step.required && !done && (
                <button
                  type="button"
                  onClick={() => onDismiss(step)}
                  className="text-xs font-medium text-gray-600 hover:text-gray-900"
                >
                  Not needed for us
                </button>
              )}
            </div>
          )}

          {explainOpen && (
            <StepExplainer
              explain={step.explain}
              currency={currency}
              country={country}
              id={explainId}
            />
          )}
        </div>
      </div>
    </li>
  );
}
