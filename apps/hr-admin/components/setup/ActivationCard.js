'use client';

// The hiring track's finish line — and the one place on either setup surface
// that hands the operator something to walk away with.
//
// The core guide ends on "you're all set". Hiring ends on a LINK: a recruiter
// who has finished this track wants the URL they can paste into LinkedIn, a job
// ad or an email signature, not a percentage. So this card replaces
// NextActionCard's all-complete branch on /setup/hiring only.
//
// It is driven by `activation` — two DB facts (the careers page is published,
// and at least one job is visible on it) computed by the server independently of
// the checklist score. That is deliberate: a tenant who skipped scorecards and
// perks still sits below 100% while their page is genuinely live, and the
// candidate-facing reality is what this card is about. The proof line says so in
// words so QA (and the operator) can see the two are allowed to disagree.
//
// Three states:
//   live         — the page is published AND has a job on it. URL + copy + open.
//   almost       — exactly one of the two is true. Same URL, greyed, the missing
//                  half named in words, and the CTA for the step that fixes it.
//   not_started  — renders nothing. Handing out a link to a page that still shows
//                  our default copy is worse than showing no link at all; the
//                  page falls back to NextActionCard, which asks for the next step.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { formatAdminDate } from '@hr/ui';
import { ctaVerb, stepHref } from '@/lib/setup';
import { Confetti } from '@/components/setup/NextActionCard';

const CONFETTI_MS = 2600;

function CheckGlyph() {
  return (
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
  );
}

// State is carried by a SHAPE and a WORD, never by colour — the same vocabulary
// StepRow uses, so a hollow ring still reads as "not finished" in a screenshot,
// in print, or in a high-contrast theme where the brand colour is gone.
function RingGlyph() {
  return <span className="mt-0.5 inline-block h-8 w-8 shrink-0 rounded-full border-2 border-gray-700" />;
}

/** "3 roles open · 12 applications so far, the first on Aug 4, 2026." */
function proofLine({ liveJobs, applications, firstApplicationAt }) {
  const jobs = `${liveJobs} role${liveJobs === 1 ? '' : 's'} open`;
  if (!applications) {
    return `${jobs}. No applications yet — share the link and they'll land straight in your pipeline.`;
  }
  const count = `${applications} application${applications === 1 ? '' : 's'} so far`;
  const since = firstApplicationAt ? `, the first on ${formatAdminDate(firstApplicationAt)}` : '';
  return `${jobs} · ${count}${since}.`;
}

// The URL itself, selectable and wrapping — a recruiter reads it aloud to a
// colleague as often as they copy it, so it must never be truncated with an
// ellipsis. `break-all` keeps a long tenant slug inside the card on a phone.
function UrlBox({ url, muted }) {
  return (
    <span
      className={`block break-all rounded-lg border px-3 py-2 font-mono text-[13px] ${
        muted ? 'border-gray-200 bg-gray-50 text-gray-600' : 'border-gray-300 bg-gray-50 text-gray-900'
      }`}
    >
      {url}
    </span>
  );
}

function CopyLinkButton({ url }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 4000);
    } catch {
      // Clipboard denied (insecure context / permission) — surfacing the raw URL
      // in a prompt still lets them take it.
      window.prompt('Copy your careers page link:', url);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={copy}
        className="inline-flex min-h-[44px] items-center justify-center rounded-lg px-5 py-2.5 text-sm font-semibold"
        style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
      >
        Copy link
      </button>
      {/* The shell's live region owns progress speech, so this confirmation
          announces itself and nothing else. */}
      <span role="status" aria-live="polite" className="text-xs text-gray-600">
        {copied ? 'Link copied.' : ''}
      </span>
    </>
  );
}

// No "live since" date is printed here. The only stamp we hold is the TRACK's
// completedAt — the moment the last checklist row went green — and that is not
// when the page went live: a tenant can be live at 45% and only finish the
// recommended rows a month later, which would print a date a month late on the
// one card the whole track builds towards. CareersPage carries no publishedAt,
// so the honest facts are the ones in the proof line below.
function LiveCard({ activation, celebratedAt, onCelebrated }) {
  const [confetti, setConfetti] = useState(false);
  const fired = useRef(false);
  const { careersUrl } = activation;

  useEffect(() => {
    if (fired.current || celebratedAt) return;
    fired.current = true;
    // Record the celebration even when we suppress the animation, so a reduced-
    // motion operator isn't offered confetti forever on every future load.
    const reduce = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;
    if (onCelebrated) onCelebrated();
    if (reduce) return undefined;
    setConfetti(true);
    const t = setTimeout(() => setConfetti(false), CONFETTI_MS);
    return () => clearTimeout(t);
  }, [celebratedAt, onCelebrated]);

  return (
    <section
      className="relative mb-8 overflow-hidden rounded-2xl border border-gray-200 bg-white p-5 sm:p-6"
      style={{ borderLeft: '4px solid var(--theme-primary)' }}
      aria-labelledby="setup-activation-heading"
    >
      {confetti && <Confetti />}
      <div className="relative flex items-start gap-3">
        <CheckGlyph />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-gray-600">Live</p>
          <h2 id="setup-activation-heading" className="mt-1 text-xl font-semibold text-gray-900">
            Your careers page is live
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-gray-600">
            {proofLine(activation)}
          </p>

          {careersUrl ? (
            <>
              <p className="mt-4 text-xs font-semibold text-gray-700">Share this link</p>
              <div className="mt-1.5 max-w-xl">
                <UrlBox url={careersUrl} />
              </div>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                <CopyLinkButton url={careersUrl} />
                <a
                  href={careersUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-gray-50"
                >
                  Open careers page <span aria-hidden className="ml-1">↗</span>
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </div>
            </>
          ) : (
            <p className="mt-4 text-sm text-gray-600">
              Your page is live, but we couldn’t work out its web address just now. Open
              {' '}
              <Link href="/settings/careers-page" className="font-semibold text-gray-900 underline decoration-gray-400 underline-offset-2">
                Careers page
              </Link>
              {' '}and use Preview to reach it.
            </p>
          )}

          <p className="mt-4 text-sm">
            <Link
              href="/recruitment"
              className="font-semibold text-gray-700 underline decoration-gray-400 underline-offset-2 hover:text-gray-900"
            >
              Go to the hiring console <span aria-hidden>→</span>
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}

// Which half is missing, in the operator's words rather than ours. `published`
// and `liveJobs` are the same two facts the public board is built from, so this
// sentence can never contradict what a candidate sees.
function missingHalf(activation) {
  if (activation.published) {
    return {
      heading: 'Your page is live but there is no job on it yet',
      body: 'Candidates who open your link will find an empty board. Publish a role and it appears straight away.',
      stepKey: 'job_public',
    };
  }
  return {
    heading: 'You have a live job but the page is still a draft',
    body: 'Until you publish, anyone opening your link sees our default wording instead of yours.',
    stepKey: 'careers_live',
  };
}

function AlmostCard({ activation, stepFor }) {
  const { heading, body, stepKey } = missingHalf(activation);
  const step = stepFor ? stepFor(stepKey) : null;

  return (
    <section
      className="mb-8 rounded-2xl border border-gray-200 bg-white p-5 sm:p-6"
      style={{ borderLeft: '4px solid var(--theme-primary)' }}
      aria-labelledby="setup-activation-heading"
    >
      <div className="flex items-start gap-3">
        <RingGlyph />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-gray-900">One step from live</p>
          <h2 id="setup-activation-heading" className="mt-1 text-lg font-semibold text-gray-900">
            {heading}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-gray-600">{body}</p>

          {activation.careersUrl && (
            <div className="mt-4 max-w-xl">
              <p className="text-xs text-gray-600">The link you’ll share once it’s live:</p>
              <div className="mt-1.5">
                <UrlBox url={activation.careersUrl} muted />
              </div>
            </div>
          )}

          {step && (
            <div className="mt-4">
              <Link
                href={stepHref(step)}
                className="inline-flex min-h-[44px] w-full items-center justify-center rounded-lg px-5 py-2.5 text-sm font-semibold sm:w-auto"
                style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
              >
                {ctaVerb(step)} <span aria-hidden className="ml-1">→</span>
              </Link>
              <p className="mt-2 text-sm text-gray-600">{step.label} — {step.description}</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default function ActivationCard({ activation, stepFor, celebratedAt, onCelebrated }) {
  if (!activation) return null;
  if (activation.state === 'live') {
    return (
      <LiveCard
        activation={activation}
        celebratedAt={celebratedAt}
        onCelebrated={onCelebrated}
      />
    );
  }
  if (activation.state === 'almost') {
    return <AlmostCard activation={activation} stepFor={stepFor} />;
  }
  return null; // not_started — NextActionCard owns the page until there is a link worth giving out
}
