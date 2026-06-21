// Tests for the country-routing config used by the smart notification router.
//
// Two functions to verify:
//   detectCountryFromPhone(phone) — E.164 / raw digits → ISO-2 country
//   getRoute(country)             — country → { smsProvider, waProvider, status }
//
// The data table itself (COUNTRY_ROUTES) is exercised indirectly via
// these — if a row is malformed the lookup will misbehave.

const {
  PROVIDERS,
  COUNTRY_ROUTES,
  detectCountryFromPhone,
  getRoute,
  listCountries,
} = require('../../src/core/lib/notifications/countryRouting');

describe('countryRouting.detectCountryFromPhone', () => {
  test('detects India from +91 prefix', () => {
    expect(detectCountryFromPhone('+919876543210')).toBe('IN');
    expect(detectCountryFromPhone('919876543210')).toBe('IN');
  });

  test('detects US from +1 prefix', () => {
    expect(detectCountryFromPhone('+14155552671')).toBe('US');
  });

  test('detects UK from +44', () => {
    expect(detectCountryFromPhone('+447911123456')).toBe('GB');
  });

  test('longest-prefix wins for ambiguous codes (Bangladesh +880 vs not-+88)', () => {
    expect(detectCountryFromPhone('+8801712345678')).toBe('BD');
  });

  test('returns null for unparseable input', () => {
    expect(detectCountryFromPhone('')).toBeNull();
    expect(detectCountryFromPhone(null)).toBeNull();
    expect(detectCountryFromPhone('not a phone')).toBeNull();
  });

  test('returns null when no dial code matches', () => {
    // +999 isn't a valid country code prefix
    expect(detectCountryFromPhone('+9999999999')).toBeNull();
  });

  test('strips formatting characters', () => {
    expect(detectCountryFromPhone('+91 (987) 654-3210')).toBe('IN');
    expect(detectCountryFromPhone('+1-415-555-2671')).toBe('US');
  });
});

describe('countryRouting.getRoute', () => {
  test('India routes SMS via MSG91 (DLT-compliant)', () => {
    const r = getRoute('IN');
    expect(r.smsProvider).toBe(PROVIDERS.MSG91_SMS);
    expect(r.waProvider).toBe(PROVIDERS.TWILIO_WA);
    expect(r.status).toBe('live');
  });

  test('US routes SMS via Twilio', () => {
    const r = getRoute('US');
    expect(r.smsProvider).toBe(PROVIDERS.TWILIO_SMS);
    expect(r.waProvider).toBe(PROVIDERS.TWILIO_WA);
  });

  test('case-insensitive country code', () => {
    expect(getRoute('in').smsProvider).toBe(PROVIDERS.MSG91_SMS);
    expect(getRoute('us').smsProvider).toBe(PROVIDERS.TWILIO_SMS);
  });

  test('unmapped country falls back to Twilio (status=fallback)', () => {
    // FK is Falkland Islands — small country, not in our explicit routing.
    const r = getRoute('FK');
    expect(r.smsProvider).toBe(PROVIDERS.TWILIO_SMS);
    expect(r.waProvider).toBe(PROVIDERS.TWILIO_WA);
    expect(r.status).toBe('fallback');
  });

  test('null/empty/undefined input returns fallback (never crashes)', () => {
    expect(getRoute(null).status).toBe('fallback');
    expect(getRoute('').status).toBe('fallback');
    expect(getRoute(undefined).status).toBe('fallback');
  });
});

describe('countryRouting data integrity', () => {
  test('every route has both smsProvider and waProvider set', () => {
    for (const [country, route] of Object.entries(COUNTRY_ROUTES)) {
      expect(route.smsProvider).toBeTruthy();
      expect(route.waProvider).toBeTruthy();
      expect(['live', 'planned'].includes(route.status)).toBe(true);
    }
  });

  test('every route has at least one dial code', () => {
    for (const [country, route] of Object.entries(COUNTRY_ROUTES)) {
      expect(Array.isArray(route.dialCodes)).toBe(true);
      expect(route.dialCodes.length).toBeGreaterThan(0);
      route.dialCodes.forEach((code) => {
        expect(code).toMatch(/^\d+$/); // digits only, no '+'
      });
    }
  });

  test('listCountries returns all explicit routes (~50 countries)', () => {
    const list = listCountries();
    expect(list).toContain('IN');
    expect(list).toContain('US');
    expect(list).toContain('GB');
    expect(list.length).toBeGreaterThanOrEqual(40);
  });

  test('PROVIDERS enum is complete', () => {
    expect(PROVIDERS.MSG91_SMS).toBeDefined();
    expect(PROVIDERS.TWILIO_SMS).toBeDefined();
    expect(PROVIDERS.TWILIO_WA).toBeDefined();
  });
});
