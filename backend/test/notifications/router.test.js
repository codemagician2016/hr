// Unit tests for the smart channel router's pure helpers (no DB).
//
// Full integration paths (sendNotification → DB writes + provider calls)
// are covered in batch 9's integration tests.

const {
  buildCascade,
  channelToCacheKey,
  pickProvider,
} = require('../../src/core/lib/notifications/router');
const { CHANNELS } = require('../../src/core/lib/notifications/priceCache');
const { PROVIDERS, getRoute } = require('../../src/core/lib/notifications/countryRouting');

describe('buildCascade', () => {
  test('returns default cascade when no eventChannels prefs set', () => {
    const r = buildCascade({ notificationConfig: null, templateKey: 'BOOKING_CONFIRMED' });
    expect(r).toEqual(['whatsapp', 'sms', 'email']);
  });

  test('returns default when config has no entry for this template', () => {
    const r = buildCascade({
      notificationConfig: { eventChannels: { OTHER_KEY: { sms: true } } },
      templateKey: 'BOOKING_CONFIRMED',
    });
    expect(r).toEqual(['whatsapp', 'sms', 'email']);
  });

  test('respects per-event prefs — only enabled channels in default order', () => {
    const r = buildCascade({
      notificationConfig: {
        eventChannels: {
          BOOKING_CONFIRMED: { sms: true, whatsapp: false, email: true },
        },
      },
      templateKey: 'BOOKING_CONFIRMED',
    });
    expect(r).toEqual(['sms', 'email']);
  });

  test('email is appended as fallback unless explicitly disabled', () => {
    const r = buildCascade({
      notificationConfig: {
        eventChannels: { BOOKING_CONFIRMED: { whatsapp: true } },
      },
      templateKey: 'BOOKING_CONFIRMED',
    });
    expect(r).toEqual(['whatsapp', 'email']);
  });

  test('email NOT auto-added when explicitly disabled', () => {
    const r = buildCascade({
      notificationConfig: {
        eventChannels: { BOOKING_CONFIRMED: { whatsapp: true, email: false } },
      },
      templateKey: 'BOOKING_CONFIRMED',
    });
    expect(r).toEqual(['whatsapp']);
  });

  test('all-channels-enabled gives full cascade', () => {
    const r = buildCascade({
      notificationConfig: {
        eventChannels: {
          BOOKING_CONFIRMED: { sms: true, whatsapp: true, email: true },
        },
      },
      templateKey: 'BOOKING_CONFIRMED',
    });
    expect(r).toEqual(['whatsapp', 'sms', 'email']);
  });

  test('returns empty cascade if customer disabled everything', () => {
    // (Edge case: customer wants no notifications for this event.)
    const r = buildCascade({
      notificationConfig: {
        eventChannels: {
          BOOKING_CONFIRMED: { sms: false, whatsapp: false, email: false },
        },
      },
      templateKey: 'BOOKING_CONFIRMED',
    });
    expect(r).toEqual([]);
  });
});

describe('channelToCacheKey', () => {
  test('sms → SMS', () => {
    expect(channelToCacheKey('sms')).toBe(CHANNELS.SMS);
  });

  test('whatsapp → WHATSAPP_UTILITY (default category for templated sends)', () => {
    expect(channelToCacheKey('whatsapp')).toBe(CHANNELS.WHATSAPP_UTILITY);
  });

  test('email → null (not cost-tracked)', () => {
    expect(channelToCacheKey('email')).toBeNull();
  });

  test('unknown channel → null', () => {
    expect(channelToCacheKey('xyz')).toBeNull();
  });
});

describe('pickProvider', () => {
  test('IN sms → MSG91_SMS via country route', () => {
    const route = getRoute('IN');
    expect(pickProvider('sms', route)).toBe(PROVIDERS.MSG91_SMS);
  });

  test('US sms → TWILIO_SMS', () => {
    const route = getRoute('US');
    expect(pickProvider('sms', route)).toBe(PROVIDERS.TWILIO_SMS);
  });

  test('any country whatsapp → TWILIO_WA', () => {
    expect(pickProvider('whatsapp', getRoute('IN'))).toBe(PROVIDERS.TWILIO_WA);
    expect(pickProvider('whatsapp', getRoute('US'))).toBe(PROVIDERS.TWILIO_WA);
    expect(pickProvider('whatsapp', getRoute('DE'))).toBe(PROVIDERS.TWILIO_WA);
  });

  test('email → SES_EMAIL', () => {
    expect(pickProvider('email', getRoute('US'))).toBe('SES_EMAIL');
  });

  test('unknown channel → null', () => {
    expect(pickProvider('xyz', getRoute('US'))).toBeNull();
  });

  test('unmapped country falls back to Twilio for sms (status=fallback)', () => {
    const route = getRoute('FK'); // Falkland Islands
    expect(pickProvider('sms', route)).toBe(PROVIDERS.TWILIO_SMS);
    expect(pickProvider('whatsapp', route)).toBe(PROVIDERS.TWILIO_WA);
  });
});
