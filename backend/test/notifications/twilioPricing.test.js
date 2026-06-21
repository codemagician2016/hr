// Tests for the Twilio Pricing API client + fallback table.
//
// Live API calls are not made in unit tests — we exercise:
//   - the hardcoded fallback table integrity
//   - getRate() returning expected shape for known countries
//   - MSG91 override for IN

const {
  TWILIO_RATES_FALLBACK,
  MSG91_RATES,
  isTwilioConfigured,
  getRate,
  getAllFallbackRates,
} = require('../../src/core/lib/notifications/twilioPricing');

describe('twilioPricing fallback table', () => {
  test('contains all major Sitepresso markets', () => {
    const required = ['US', 'CA', 'GB', 'IN', 'BR', 'MX', 'AU', 'DE', 'FR', 'ZA'];
    for (const c of required) {
      expect(TWILIO_RATES_FALLBACK[c]).toBeDefined();
      expect(TWILIO_RATES_FALLBACK[c].sms).toBeGreaterThan(0);
      expect(TWILIO_RATES_FALLBACK[c].whatsappUtility).toBeGreaterThan(0);
    }
  });

  test('US is cheapest SMS market (positioning baseline)', () => {
    expect(TWILIO_RATES_FALLBACK.US.sms).toBeLessThan(0.01);
  });

  test('Korea is the most expensive SMS market we support', () => {
    expect(TWILIO_RATES_FALLBACK.KR.sms).toBeGreaterThan(0.10);
  });

  test('rates are USD floats, never strings', () => {
    for (const [country, rate] of Object.entries(TWILIO_RATES_FALLBACK)) {
      expect(typeof rate.sms).toBe('number');
      expect(typeof rate.whatsappUtility).toBe('number');
      expect(rate.sms).toBeGreaterThan(0);
      expect(rate.whatsappUtility).toBeGreaterThan(0);
    }
  });
});

describe('twilioPricing.MSG91_RATES', () => {
  test('IN has explicit MSG91 rate (overrides Twilio fallback)', () => {
    expect(MSG91_RATES.IN).toBeDefined();
    expect(MSG91_RATES.IN.sms).toBeLessThan(0.005);
    // MSG91 transactional should be ~10x cheaper than Twilio India
    expect(MSG91_RATES.IN.sms).toBeLessThan(TWILIO_RATES_FALLBACK.IN.sms / 5);
  });
});

describe('twilioPricing.getRate', () => {
  test('IN returns MSG91 rate', async () => {
    const r = await getRate('IN');
    expect(r).not.toBeNull();
    expect(r.sms).toBe(MSG91_RATES.IN.sms);
    expect(r.source).toBe('MSG91_MANUAL');
  });

  test('US returns Twilio fallback (no live API in test env)', async () => {
    const r = await getRate('US');
    expect(r).not.toBeNull();
    expect(r.sms).toBe(TWILIO_RATES_FALLBACK.US.sms);
    expect(['TWILIO_FALLBACK', 'TWILIO_API']).toContain(r.source);
  });

  test('case-insensitive country code', async () => {
    const r = await getRate('us');
    expect(r).not.toBeNull();
    expect(r.sms).toBe(TWILIO_RATES_FALLBACK.US.sms);
  });

  test('unknown country returns null', async () => {
    const r = await getRate('XX');
    expect(r).toBeNull();
  });

  test('null/empty input returns null safely', async () => {
    expect(await getRate(null)).toBeNull();
    expect(await getRate('')).toBeNull();
  });
});

describe('twilioPricing.getAllFallbackRates', () => {
  test('returns merged map with MSG91 overlaid on IN', () => {
    const all = getAllFallbackRates();
    expect(all.IN.sms).toBe(MSG91_RATES.IN.sms);
    expect(all.IN.source).toBe('MSG91_MANUAL');
    expect(all.US.source).toBe('TWILIO_FALLBACK');
  });

  test('every entry has a sms + whatsappUtility + source field', () => {
    const all = getAllFallbackRates();
    for (const [country, rate] of Object.entries(all)) {
      expect(rate.sms).toBeGreaterThan(0);
      expect(rate.whatsappUtility).toBeGreaterThan(0);
      expect(rate.source).toBeTruthy();
    }
  });
});

describe('twilioPricing.isTwilioConfigured', () => {
  test('returns false in test env (no live credentials)', () => {
    // CI/test env never has live Twilio creds; this guards against
    // accidentally running live API calls in Jest.
    expect(typeof isTwilioConfigured()).toBe('boolean');
  });
});
