// Tests for the 14-day trial state machine helpers.

const trial = require('../src/core/lib/trial');

const FUTURE = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // +5d
const PAST = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);   // -1d
const FAR_FUTURE = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // +14d

describe('isInTrial', () => {
  test('false when null sub', () => {
    expect(trial.isInTrial(null)).toBe(false);
  });
  test('false when no trial fields', () => {
    expect(trial.isInTrial({ id: 'x' })).toBe(false);
  });
  test('true when trialEndsAt is future + not converted', () => {
    expect(trial.isInTrial({ trialEndsAt: FUTURE, trialPlanSlug: 'pro' })).toBe(true);
  });
  test('false when trialEndsAt is past', () => {
    expect(trial.isInTrial({ trialEndsAt: PAST })).toBe(false);
  });
  test('false when already converted (paid)', () => {
    expect(trial.isInTrial({
      trialEndsAt: FUTURE,
      trialConvertedAt: new Date(),
    })).toBe(false);
  });
});

describe('isTrialExpired', () => {
  test('true when trialEndsAt is past + not converted', () => {
    expect(trial.isTrialExpired({ trialEndsAt: PAST })).toBe(true);
  });
  test('false when still in trial (future)', () => {
    expect(trial.isTrialExpired({ trialEndsAt: FUTURE })).toBe(false);
  });
  test('false when converted (even if endsAt past)', () => {
    expect(trial.isTrialExpired({
      trialEndsAt: PAST,
      trialConvertedAt: new Date(),
    })).toBe(false);
  });
  test('false when never started a trial', () => {
    expect(trial.isTrialExpired({})).toBe(false);
  });
});

describe('effectiveTierSlug', () => {
  test('returns trial plan slug while in trial', () => {
    const sub = { trialEndsAt: FUTURE, trialPlanSlug: 'professional', tier: { slug: 'free' } };
    expect(trial.effectiveTierSlug(sub)).toBe('professional');
  });
  test('returns DB tier slug after trial expires', () => {
    const sub = { trialEndsAt: PAST, trialPlanSlug: 'professional', tier: { slug: 'free' } };
    expect(trial.effectiveTierSlug(sub)).toBe('free');
  });
  test('returns tier slug when never trialed', () => {
    const sub = { tier: { slug: 'starter' } };
    expect(trial.effectiveTierSlug(sub)).toBe('starter');
  });
  test('uses fallbackTier arg when provided', () => {
    const sub = { tier: null };
    expect(trial.effectiveTierSlug(sub, { slug: 'override' })).toBe('override');
  });
  test('defaults to free when nothing set', () => {
    expect(trial.effectiveTierSlug({})).toBe('free');
  });
});

describe('daysRemaining', () => {
  test('positive days when in trial', () => {
    const r = trial.daysRemaining({ trialEndsAt: FUTURE });
    expect(r).toBeGreaterThan(3);
    expect(r).toBeLessThanOrEqual(5);
  });
  test('0 when expired', () => {
    expect(trial.daysRemaining({ trialEndsAt: PAST })).toBe(0);
  });
  test('0 when no trial', () => {
    expect(trial.daysRemaining({})).toBe(0);
  });
  test('14 when fresh trial', () => {
    const r = trial.daysRemaining({ trialEndsAt: FAR_FUTURE });
    expect(r).toBeGreaterThanOrEqual(13);
    expect(r).toBeLessThanOrEqual(14);
  });
});

describe('newTrialDates', () => {
  test('default 30 days', () => {
    const { startedAt, endsAt } = trial.newTrialDates();
    const diffDays = (endsAt.getTime() - startedAt.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeCloseTo(30, 0);
  });
  test('custom trialDays from PricingTier', () => {
    const { startedAt, endsAt } = trial.newTrialDates({ trialDays: 7 });
    const diffDays = (endsAt.getTime() - startedAt.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeCloseTo(7, 0);
  });
});

describe('canStartTrial', () => {
  test('true for new subscription', () => {
    expect(trial.canStartTrial({})).toBe(true);
    expect(trial.canStartTrial(null)).toBe(true);
  });
  test('false if already in or completed a trial', () => {
    expect(trial.canStartTrial({ trialStartedAt: new Date() })).toBe(false);
  });
  test('false if already converted (paying)', () => {
    expect(trial.canStartTrial({ trialConvertedAt: new Date() })).toBe(false);
  });
});

describe('summarise', () => {
  test('NONE for null', () => {
    expect(trial.summarise(null)).toEqual({ state: 'NONE' });
  });
  test('TRIAL_ACTIVE with daysRemaining', () => {
    const r = trial.summarise({
      trialPlanSlug: 'pro',
      trialStartedAt: new Date(),
      trialEndsAt: FUTURE,
    });
    expect(r.state).toBe('TRIAL_ACTIVE');
    expect(r.planSlug).toBe('pro');
    expect(r.daysRemaining).toBeGreaterThan(0);
  });
  test('TRIAL_EXPIRED', () => {
    const r = trial.summarise({
      trialPlanSlug: 'pro',
      trialStartedAt: PAST,
      trialEndsAt: PAST,
    });
    expect(r.state).toBe('TRIAL_EXPIRED');
  });
  test('CONVERTED locks state', () => {
    const r = trial.summarise({
      trialPlanSlug: 'pro',
      trialEndsAt: FUTURE,        // even though endsAt would otherwise be active
      trialConvertedAt: new Date(),
    });
    expect(r.state).toBe('CONVERTED');
  });
});
