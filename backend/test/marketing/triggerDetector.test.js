// Pure-function tests for the trigger detector. Full DB-driven detection
// is integration-tested in production.

const {
  computeScheduledFor,
} = require('../../src/core/lib/marketing/triggerDetector');

describe('computeScheduledFor', () => {
  test('BIRTHDAY: 0 hour delay → same as triggeredAt', () => {
    const trig = new Date('2026-04-29T12:00:00Z');
    const sched = computeScheduledFor({ campaignKey: 'BIRTHDAY', triggeredAt: trig });
    expect(sched.toISOString()).toBe('2026-04-29T12:00:00.000Z');
  });

  test('POST_VISIT: 24 hour delay', () => {
    const trig = new Date('2026-04-29T12:00:00Z');
    const sched = computeScheduledFor({ campaignKey: 'POST_VISIT', triggeredAt: trig });
    expect(sched.toISOString()).toBe('2026-04-30T12:00:00.000Z');
  });

  test('NO_SHOW_WINBACK: 7 day delay (168h)', () => {
    const trig = new Date('2026-04-29T12:00:00Z');
    const sched = computeScheduledFor({ campaignKey: 'NO_SHOW_WINBACK', triggeredAt: trig });
    expect(sched.toISOString()).toBe('2026-05-06T12:00:00.000Z');
  });

  test('customDelayHours overrides campaign default', () => {
    const trig = new Date('2026-04-29T12:00:00Z');
    const sched = computeScheduledFor({
      campaignKey: 'POST_VISIT',
      customDelayHours: 48, // override 24h default
      triggeredAt: trig,
    });
    expect(sched.toISOString()).toBe('2026-05-01T12:00:00.000Z');
  });

  test('unknown campaign falls back to triggeredAt', () => {
    const trig = new Date('2026-04-29T12:00:00Z');
    const sched = computeScheduledFor({ campaignKey: 'NOPE', triggeredAt: trig });
    expect(sched.toISOString()).toBe('2026-04-29T12:00:00.000Z');
  });
});
