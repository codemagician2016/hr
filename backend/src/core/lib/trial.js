// Paddle Billing trial helpers. Public trials are card-required and created by
// Paddle checkout; these columns mirror Paddle's trialing period for UI and
// historical reporting. They must never be used to grant access without a real
// Paddle subscription/webhook confirmation.
//
// Storage on Subscription:
//   trialPlanSlug    = tier they're trialing (e.g. 'professional')
//   trialStartedAt   = when trial began
//   trialEndsAt      = when Paddle says the trial period ends
//   trialConvertedAt = when they paid (locks; can't re-trial after this)

const DEFAULT_TRIAL_DAYS = 30;

function now() {
  return new Date();
}

// Is this subscription currently in an active (unexpired, unconverted) trial?
function isInTrial(sub) {
  if (!sub) return false;
  if (sub.trialConvertedAt) return false;             // already paid → no longer "in trial"
  if (!sub.trialEndsAt) return false;                  // never started a trial
  return new Date(sub.trialEndsAt) > now();
}

// Has the trial expired without conversion? Used by the daily downgrade cron.
function isTrialExpired(sub) {
  if (!sub) return false;
  if (sub.trialConvertedAt) return false;
  if (!sub.trialEndsAt) return false;
  return new Date(sub.trialEndsAt) <= now();
}

// Historical helper only. Feature gates must use the subscription tier/status
// synced from Paddle, not this app-level trial override.
function effectiveTierSlug(sub, fallbackTier) {
  if (isInTrial(sub) && sub.trialPlanSlug) return sub.trialPlanSlug;
  return fallbackTier?.slug || sub?.tier?.slug || 'free';
}

// Days remaining in the trial. Returns 0 if expired or not in trial.
function daysRemaining(sub) {
  if (!isInTrial(sub)) return 0;
  const ms = new Date(sub.trialEndsAt).getTime() - now().getTime();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

// Compute trial start/end dates for internal/test migrations only. Public
// signup trials are created by Paddle price configuration + checkout.
function newTrialDates({ trialDays = DEFAULT_TRIAL_DAYS } = {}) {
  const startedAt = now();
  const endsAt = new Date(startedAt.getTime() + trialDays * 24 * 60 * 60 * 1000);
  return { startedAt, endsAt };
}

// Can this subscription start a NEW trial? Only if they've never converted
// (we don't allow trial-shopping by re-creating subscriptions). Also blocks
// re-trialing if they're already in or have completed a previous trial.
function canStartTrial(sub) {
  if (!sub) return true;
  if (sub.trialConvertedAt) return false;     // already a paying customer
  if (sub.trialStartedAt) return false;        // already used their trial slot
  return true;
}

// Status object for admin UI / API responses. Idempotent — safe to call.
function summarise(sub) {
  if (!sub) return { state: 'NONE' };
  if (sub.trialConvertedAt) {
    return { state: 'CONVERTED', convertedAt: sub.trialConvertedAt, planSlug: sub.trialPlanSlug };
  }
  if (isInTrial(sub)) {
    return {
      state: 'TRIAL_ACTIVE',
      planSlug: sub.trialPlanSlug,
      startedAt: sub.trialStartedAt,
      endsAt: sub.trialEndsAt,
      daysRemaining: daysRemaining(sub),
    };
  }
  if (isTrialExpired(sub)) {
    return {
      state: 'TRIAL_EXPIRED',
      planSlug: sub.trialPlanSlug,
      startedAt: sub.trialStartedAt,
      endsAt: sub.trialEndsAt,
    };
  }
  return { state: 'NONE' };
}

module.exports = {
  DEFAULT_TRIAL_DAYS,
  isInTrial,
  isTrialExpired,
  effectiveTierSlug,
  daysRemaining,
  newTrialDates,
  canStartTrial,
  summarise,
};
