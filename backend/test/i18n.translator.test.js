const { t, tFor, resolveLocale, SUPPORTED_LOCALES, DEFAULT_LOCALE } = require('../src/i18n/translator');

describe('i18n translator', () => {
  describe('resolveLocale', () => {
    test('returns exact match', () => {
      for (const locale of SUPPORTED_LOCALES) {
        expect(resolveLocale(locale)).toBe(locale);
      }
    });

    test('is case-insensitive', () => {
      expect(resolveLocale('HI')).toBe('hi');
      expect(resolveLocale('PT-br')).toBe('pt-BR');
    });

    test('falls back to prefix match (pt → pt-BR)', () => {
      expect(resolveLocale('pt')).toBe('pt-BR');
    });

    test('falls back to default for unknown locale', () => {
      expect(resolveLocale('zh')).toBe(DEFAULT_LOCALE);
      expect(resolveLocale('xx-YY')).toBe(DEFAULT_LOCALE);
    });

    test('handles null / empty / non-string', () => {
      expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
      expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
      expect(resolveLocale('')).toBe(DEFAULT_LOCALE);
      expect(resolveLocale('  ')).toBe(DEFAULT_LOCALE);
      expect(resolveLocale(123)).toBe(DEFAULT_LOCALE);
    });
  });

  describe('t()', () => {
    test('returns translated string for known key', () => {
      expect(t('customerSignupOtp.subject', 'en')).toMatch(/verify/i);
      expect(t('customerSignupOtp.subject', 'hi')).toContain('वेरिफाई');
      expect(t('customerSignupOtp.subject', 'es')).toMatch(/verifica/i);
      expect(t('customerSignupOtp.subject', 'fr')).toMatch(/vérifiez/i);
      expect(t('customerSignupOtp.subject', 'de')).toMatch(/bestätige/i);
      expect(t('customerSignupOtp.subject', 'it')).toMatch(/verifica/i);
      expect(t('customerSignupOtp.subject', 'pt-BR')).toMatch(/verifique/i);
    });

    test('falls back to English for unknown locale', () => {
      const en = t('customerSignupOtp.subject', 'en');
      expect(t('customerSignupOtp.subject', 'zh')).toBe(en);
      expect(t('customerSignupOtp.subject', null)).toBe(en);
    });

    test('returns key string for missing key', () => {
      expect(t('this.key.does.not.exist', 'en')).toBe('this.key.does.not.exist');
      expect(t('this.key.does.not.exist', 'hi')).toBe('this.key.does.not.exist');
    });

    test('interpolates {var} placeholders', () => {
      expect(t('common.greeting', 'en', { name: 'Alice' })).toBe('Hi Alice');
      expect(t('common.greeting', 'es', { name: 'Alicia' })).toBe('Hola Alicia');
      expect(t('common.greeting', 'hi', { name: 'राकेश' })).toContain('राकेश');
    });

    test('leaves placeholder unchanged when var is missing', () => {
      expect(t('common.greeting', 'en')).toBe('Hi {name}');
      expect(t('common.greeting', 'en', {})).toBe('Hi {name}');
    });

    test('handles nested keys (4 deep) without crashing', () => {
      expect(typeof t('appointmentBooked.detailsHeader', 'en')).toBe('string');
    });
  });

  describe('tFor()', () => {
    test('binds locale once', () => {
      const tHi = tFor('hi');
      expect(tHi('common.signOff')).toContain('DriftHR');
      expect(tHi('appointmentStatus.eyebrowConfirmed')).toContain('कन्फर्म');
    });

    test('still interpolates vars', () => {
      const tFr = tFor('fr');
      expect(tFr('common.greeting', { name: 'Pierre' })).toBe('Bonjour Pierre');
    });

    test('fallback path works through bound locale', () => {
      const tBad = tFor('zh');
      // Falls through to en
      expect(tBad('customerSignupOtp.subject')).toMatch(/verify/i);
    });
  });

  describe('coverage — every locale has every top-level namespace', () => {
    const en = require('../src/i18n/email/en.json');
    const namespaces = Object.keys(en);

    test.each(SUPPORTED_LOCALES)('locale %s has all namespaces', (locale) => {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const bundle = require(`../src/i18n/email/${locale}.json`);
      for (const ns of namespaces) {
        expect(bundle).toHaveProperty(ns);
        // Same keys within each namespace
        for (const key of Object.keys(en[ns])) {
          expect(bundle[ns]).toHaveProperty(key);
        }
      }
    });
  });
});
