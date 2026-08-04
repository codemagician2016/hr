'use client';

// Zone 2: the single next-best action, and the only filled button on the page.
//
// Everything else on /setup is a list you may browse; this is the one thing we
// are asking for. The server ranks it (most-unblocking first, required before
// recommended, declared order last) so it is stable across sessions — an
// operator who leaves and comes back is asked for the same thing.
//
// Three shapes:
//   • normal   — eyebrow, the step label verbatim, cost/owner meta, one button
//   • delegate — the highest-ranked step is out of this operator's reach, so we
//                offer a copyable link for whoever CAN do it, plus a "meanwhile"
//                step they can do themselves. We never render a dead button.
//   • done     — replaces the card entirely at 100%, with three ways into real
//                work rather than a dead end.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { formatAdminDate } from '@hr/ui';
import { ctaVerb, permissionPhrase, stepHref } from '@/lib/setup';
import StepExplainer from '@/components/setup/StepExplainer';

// Where "you're all set" sends people: the three things a live workspace does.
const DONE_LINKS = [
  { href: '/payroll', label: 'Run payroll' },
  { href: '/people', label: 'Invite your team' },
  { href: '/reports', label: 'See reports' },
];

const CONFETTI_MS = 2600;
const CONFETTI_PIECES = 18;

function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Purely decorative, aria-hidden, self-destructs. Suppressed wholesale under
// prefers-reduced-motion — a celebration nobody asked for must never be a
// vestibular problem.
function Confetti() {
  const pieces = Array.from({ length: CONFETTI_PIECES }, (_, i) => ({
    left: `${(i * 100) / CONFETTI_PIECES + (i % 3) * 1.5}%`,
    delay: `${(i % 6) * 0.09}s`,
    duration: `${1.5 + (i % 4) * 0.3}s`,
    color: i % 3 === 0 ? 'var(--theme-primary)' : i % 3 === 1 ? 'var(--theme-accent)' : '#F5C542',
  }));
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
      <style>{`@keyframes drifthr-setup-confetti {
        0%   { transform: translateY(-14px) rotate(0deg); opacity: 1; }
        100% { transform: translateY(150px) rotate(320deg); opacity: 0; }
      }`}</style>
      {pieces.map((p, i) => (
        <span
          key={i}
          className="absolute top-0 block h-2 w-1.5 rounded-[1px]"
          style={{
            left: p.left,
            backgroundColor: p.color,
            animation: `drifthr-setup-confetti ${p.duration} ease-in ${p.delay} forwards`,
          }}
        />
      ))}
    </div>
  );
}

function DoneCard({ completedAt, celebratedAt, onCelebrated }) {
  const [confetti, setConfetti] = useState(false);
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current || celebratedAt) return;
    fired.current = true;
    // Record the celebration even when we suppress the animation, so a reduced-
    // motion operator isn't offered confetti forever on every future load.
    if (!prefersReducedMotion()) {
      setConfetti(true);
      const t = setTimeout(() => setConfetti(false), CONFETTI_MS);
      if (onCelebrated) onCelebrated();
      return () => clearTimeout(t);
    }
    if (onCelebrated) onCelebrated();
    return undefined;
  }, [celebratedAt, onCelebrated]);

  return (
    <section
      className="relative mb-8 overflow-hidden rounded-2xl border border-gray-200 bg-white p-6"
      aria-labelledby="setup-done-heading"
    >
      {confetti && <Confetti />}
      <div className="relative flex items-start gap-3">
        <span
          className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden focusable="false">
            <path
              d="M4 10.5l4 4 8-8"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div className="min-w-0">
          <h2 id="setup-done-heading" className="text-xl font-semibold text-gray-900">
            You’re all set <span aria-hidden>🎉</span>
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Every step you can reach is done{completedAt ? ` — finished ${formatAdminDate(completedAt)}` : ''}.
            {' '}Here’s where the work actually happens.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {DONE_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="inline-flex min-h-[44px] items-center rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-gray-50"
              >
                {l.label} <span aria-hidden className="ml-1">→</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function BlockedNotice({ blocked }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = typeof window === 'undefined'
      ? stepHref(blocked)
      : `${window.location.origin}${stepHref(blocked)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 4000);
    } catch {
      // Clipboard denied (insecure context / permission) — surfacing the raw URL
      // in a prompt still lets them hand it over.
      window.prompt('Copy this link and send it to them:', url);
    }
  }

  return (
    <div className="mb-4 border-b border-gray-200 pb-4">
      <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-gray-600">
        Needs someone else
      </p>
      <p className="mt-1 text-sm font-semibold text-gray-900">{blocked.label}</p>
      <p className="mt-0.5 text-sm text-gray-600">
        This one needs someone who can {permissionPhrase(blocked.permission)}. Send them the link
        and carry on below.
      </p>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={copy}
          className="inline-flex min-h-[40px] items-center rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-900 hover:bg-gray-50"
        >
          Copy a link to send them
        </button>
        {/* Polite, non-intrusive: the shell's live region owns progress speech,
            so this confirmation announces itself and nothing else. */}
        <span role="status" aria-live="polite" className="text-xs text-gray-600">
          {copied ? 'Link copied.' : ''}
        </span>
      </div>
    </div>
  );
}

export default function NextActionCard({
  step,
  blocked,
  currency,
  country,
  totalCount,
  allComplete,
  completedAt,
  celebratedAt,
  onSkipToList,
  onCelebrated,
}) {
  const [explainOpen, setExplainOpen] = useState(false);

  if (allComplete) {
    return <DoneCard completedAt={completedAt} celebratedAt={celebratedAt} onCelebrated={onCelebrated} />;
  }
  if (!step) return null;

  const explainId = `setup-nba-explain-${step.key}`;
  const meta = [
    step.orderInScope && totalCount ? `Step ${step.orderInScope} of ${totalCount}` : null,
    step.minutes ? `about ${step.minutes} minute${step.minutes === 1 ? '' : 's'}` : null,
    step.doneBy ? `usually done by ${step.doneBy}` : null,
  ].filter(Boolean);

  return (
    <section
      className="mb-8 rounded-2xl border border-gray-200 bg-white p-5 sm:p-6"
      style={{ borderLeft: '4px solid var(--theme-primary)' }}
      aria-labelledby="setup-nba-heading"
    >
      {blocked && <BlockedNotice blocked={blocked} />}

      <p
        className={`text-[11px] font-bold uppercase tracking-[0.08em] ${
          step.required ? 'text-gray-900' : 'text-gray-600'
        }`}
      >
        {blocked ? 'Meanwhile — ' : ''}{step.required ? 'Do this next' : 'Nice to do next'}
      </p>

      <h2 id="setup-nba-heading" className="mt-1 text-lg font-semibold text-gray-900">
        {step.label}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-gray-600">{step.description}</p>
      {step.why && <p className="mt-1 text-sm leading-relaxed text-gray-600">{step.why}</p>}

      {meta.length > 0 && (
        <p className="mt-2 text-xs text-gray-600">{meta.join(' · ')}</p>
      )}

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Link
          href={stepHref(step)}
          className="inline-flex min-h-[44px] w-full items-center justify-center rounded-lg px-5 py-2.5 text-sm font-semibold sm:w-auto"
          style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
        >
          {ctaVerb(step)} <span aria-hidden className="ml-1">→</span>
        </Link>

        <div className="flex items-center gap-4">
          <button
            type="button"
            aria-expanded={explainOpen}
            aria-controls={explainId}
            onClick={() => setExplainOpen((v) => !v)}
            className="text-sm font-medium text-gray-700 underline decoration-gray-400 underline-offset-2 hover:text-gray-900"
          >
            {explainOpen ? 'Hide explanation' : 'What is this?'}
          </button>
          <button
            type="button"
            onClick={onSkipToList}
            className="text-sm font-medium text-gray-600 hover:text-gray-900"
          >
            Not now
          </button>
        </div>
      </div>

      {explainOpen && (
        <StepExplainer explain={step.explain} currency={currency} country={country} id={explainId} />
      )}
    </section>
  );
}
