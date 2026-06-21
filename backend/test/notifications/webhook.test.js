// Webhook controller tests — pure helper coverage. Full HTTP flow tests
// (which write to DB) are exercised in production.

const {
  STOP_WORDS,
  normalizePhone,
} = require('../../src/core/controllers/notificationWebhook.controller');

describe('notificationWebhook.STOP_WORDS', () => {
  test('contains the canonical English STOP terms', () => {
    expect(STOP_WORDS.has('STOP')).toBe(true);
    expect(STOP_WORDS.has('STOPALL')).toBe(true);
    expect(STOP_WORDS.has('UNSUBSCRIBE')).toBe(true);
    expect(STOP_WORDS.has('CANCEL')).toBe(true);
    expect(STOP_WORDS.has('END')).toBe(true);
    expect(STOP_WORDS.has('QUIT')).toBe(true);
    expect(STOP_WORDS.has('OPT-OUT')).toBe(true);
    expect(STOP_WORDS.has('OPTOUT')).toBe(true);
  });

  test('non-stop words are not in the set', () => {
    expect(STOP_WORDS.has('YES')).toBe(false);
    expect(STOP_WORDS.has('CONFIRM')).toBe(false);
    expect(STOP_WORDS.has('OK')).toBe(false);
  });
});

describe('notificationWebhook.normalizePhone', () => {
  test('converts E.164 to canonical +digits format', () => {
    expect(normalizePhone('+91 98765-43210')).toBe('+919876543210');
    expect(normalizePhone('+1 (415) 555-2671')).toBe('+14155552671');
  });

  test('accepts raw digits', () => {
    expect(normalizePhone('919876543210')).toBe('+919876543210');
  });

  test('returns null for empty / invalid', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('not a phone')).toBeNull();
  });

  test('strips all non-digit characters', () => {
    expect(normalizePhone('++91 98 76 54 32 10')).toBe('+919876543210');
  });
});
