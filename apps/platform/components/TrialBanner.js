'use client';

// Trial countdown banner. Renders at the top of the admin shell when the
// tenant's subscription is in a trial state. Drives the customer toward
// adding payment before the trial expires.
//
// 4 visual states matching backend/src/lib/trial.js summarise():
//   TRIAL_ACTIVE  — green, "X days left"
//   TRIAL_EXPIRED — red, "trial ended, renew to continue"
//   CONVERTED     — never shown (paid customer; no banner needed)
//   NONE          — never shown (never started a trial)

import Link from 'next/link';

export default function TrialBanner({ trial, slug }) {
  if (!trial || !trial.state) return null;
  const { state, daysRemaining, planSlug } = trial;

  if (state === 'TRIAL_ACTIVE') {
    const urgent = (daysRemaining ?? 0) <= 3;
    return (
      <div className={`px-4 py-2.5 text-sm flex items-center justify-center gap-3 ${
        urgent
          ? 'bg-amber-50 border-b border-amber-200 text-amber-900'
          : 'bg-indigo-50 border-b border-indigo-200 text-indigo-900'
      }`}>
        <span className="font-medium">
          {daysRemaining > 0 ? (
            <>
              <strong>{daysRemaining} day{daysRemaining === 1 ? '' : 's'} left</strong> on your {planSlug ? planSlug.charAt(0).toUpperCase() + planSlug.slice(1) : ''} trial.
            </>
          ) : (
            <>Your trial ends today.</>
          )}
        </span>
        <Link
          href={slug ? `/${slug}/admin?tab=subscription` : '#'}
          className={`text-xs font-semibold px-3 py-1 rounded-full transition-colors ${
            urgent
              ? 'bg-amber-600 text-white hover:bg-amber-700'
              : 'bg-indigo-600 text-white hover:bg-indigo-700'
          }`}
        >
          Add payment to continue →
        </Link>
      </div>
    );
  }

  if (state === 'TRIAL_EXPIRED') {
    return (
      <div className="px-4 py-2.5 text-sm bg-red-50 border-b border-red-200 text-red-900 flex items-center justify-center gap-3">
        <span className="font-medium">
          Your trial ended. Renew billing to keep paid features active.
        </span>
        <Link
          href={slug ? `/${slug}/admin?tab=subscription` : '#'}
          className="text-xs font-semibold px-3 py-1 rounded-full bg-red-600 text-white hover:bg-red-700 transition-colors"
        >
          Renew →
        </Link>
      </div>
    );
  }

  return null;
}
