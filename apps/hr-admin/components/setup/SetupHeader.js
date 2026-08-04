'use client';

// Zone 1 of the setup page: the score, and nothing you can click.
//
// The percentage is never shown on its own — the denominator changes per tenant
// (locked add-ons, country-only steps, the operator's own permissions all move
// it), so "41%" is meaningless without "18 of 44". Two quiet lines explain the
// two ways the denominator shrinks, because an unexplained total reads as a bug.
//
// The bar is decoration over text that already says everything: it carries
// role="progressbar" with an aria-valuetext that repeats both facts, and
// deliberately no aria-live — the shared region in SetupProvider owns speech.

import { headline, subline } from '@/lib/setup';

// The brand hex is tenant-supplied, so we use the DARKENED brand token for the
// fill and a near-white track: that pairing clears 3:1 for the shipped palette,
// and the number beside it is the real guarantee that the value is readable.
const TRACK = '#EDF0F3';

export default function SetupHeader(props) {
  const {
    // Which guide this is. The hiring track scores a DIFFERENT denominator on a
    // different page, so its header must not also say "Setup guide" — two
    // percentages under one name is the one thing separate tracks must avoid.
    eyebrow = 'Setup guide',
    percent,
    completedCount,
    totalCount,
    requiredRemaining,
    lockedCount,
    probeDegraded,
    allComplete,
    stepsNeedingSomeoneElse,
  } = props;
  // `tenantAllComplete` is not read here but IS read by headline(props) below —
  // "You're all set" is a claim about the company, and an operator scored on
  // three permitted steps must not trigger it (see setupFullyComplete).

  const unknown = percent == null;
  const width = unknown ? 0 : Math.max(0, Math.min(100, percent));

  return (
    <header className="mb-6">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-gray-600">
            {eyebrow}
          </p>
          <h1 className="mt-1 text-2xl font-semibold leading-snug text-gray-900 sm:text-[28px]">
            {headline(props)}
          </h1>
          <p className="mt-1 text-sm text-gray-600">{subline(props)}</p>
        </div>

        <div className="shrink-0 text-right">
          <div
            className="text-[36px] font-bold leading-none tabular-nums"
            style={{ color: unknown ? '#4B5563' : 'var(--theme-primary-dark)' }}
          >
            {unknown ? '—' : `${percent}%`}
          </div>
          <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-gray-600">
            {unknown ? 'not checked' : 'complete'}
          </div>
        </div>
      </div>

      <div
        role="progressbar"
        aria-label={`${eyebrow} completion`}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(unknown ? {} : { 'aria-valuenow': percent })}
        aria-valuetext={
          unknown
            ? "Not checked — we couldn't read your setup just now"
            : `${percent} percent complete, ${completedCount} of ${totalCount} steps done`
        }
        className="mt-4 h-2.5 w-full overflow-hidden rounded-full"
        style={{ backgroundColor: TRACK, boxShadow: 'inset 0 0 0 1px rgba(22,36,59,0.14)' }}
      >
        {/* min-width keeps the very first completed step visible instead of a
            hairline nobody can see — we do NOT pre-tick a fake step to fake it. */}
        <div
          className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
          style={{
            width: `${width}%`,
            minWidth: width > 0 ? '4px' : 0,
            backgroundColor: 'var(--theme-primary-dark)',
          }}
        />
      </div>

      <div className="mt-2 space-y-1">
        {lockedCount > 0 && (
          <p className="text-xs text-gray-600">
            {lockedCount === 1 ? '1 step isn’t' : `${lockedCount} steps aren’t`} on your plan and
            {' '}{lockedCount === 1 ? 'doesn’t' : 'don’t'} count towards 100%.
          </p>
        )}
        {stepsNeedingSomeoneElse > 0 && (
          <p className="text-xs text-gray-600">
            {stepsNeedingSomeoneElse === 1 ? '1 step needs' : `${stepsNeedingSomeoneElse} steps need`}
            {' '}someone else’s access.
          </p>
        )}
        {probeDegraded && !unknown && (
          <p className="text-xs text-gray-600">
            We couldn’t check every step just now, so your real score may be higher.
          </p>
        )}
        {unknown && (
          <p className="text-xs text-gray-600">
            We couldn’t read your setup just now. Nothing is blocked — try again in a moment.
          </p>
        )}
        {allComplete && (
          <p className="text-xs text-gray-600">
            Everything you can reach is set up. This page stays here for whenever you want to review it.
          </p>
        )}
      </div>
    </header>
  );
}
