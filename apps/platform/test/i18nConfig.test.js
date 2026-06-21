// Pure unit tests for the locale registry + country→locale mapping.
// No DB, no network — fast and CI-safe.

import { describe, expect, test } from 'vitest';
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  COUNTRY_LOCALE_MAP,
  localeFromCountry,
} from '../i18n/config.js';

describe('SUPPORTED_LOCALES', () => {
  test('includes the seven launch locales', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'hi', 'es', 'fr', 'de', 'it', 'pt-BR']);
  });

  test('default locale is one of the supported locales', () => {
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });
});

describe('LOCALE_LABELS', () => {
  test('every supported locale has a native + english label', () => {
    for (const code of SUPPORTED_LOCALES) {
      expect(LOCALE_LABELS[code]).toBeDefined();
      expect(LOCALE_LABELS[code].native).toMatch(/\S/);
      expect(LOCALE_LABELS[code].english).toMatch(/\S/);
    }
  });

  test('Hindi label is in Devanagari script', () => {
    // If someone accidentally ASCII-fies it the picker becomes useless to
    // a Hindi-only reader.
    expect(LOCALE_LABELS.hi.native).toBe('हिन्दी');
  });
});

describe('localeFromCountry', () => {
  test('India maps to Hindi (post 2026-04-25)', () => {
    expect(localeFromCountry('IN')).toBe('hi');
  });

  test('Italy maps to Italian', () => {
    expect(localeFromCountry('IT')).toBe('it');
  });

  test('Germany, Austria, Switzerland and Liechtenstein all map to German', () => {
    for (const c of ['DE', 'AT', 'CH', 'LI']) {
      expect(localeFromCountry(c)).toBe('de');
    }
  });

  test('LatAm + Spain all map to Spanish', () => {
    for (const c of ['ES', 'MX', 'AR', 'CO', 'CL', 'PE']) {
      expect(localeFromCountry(c)).toBe('es');
    }
  });

  test('Brazil and Portugal both map to pt-BR (until pt-PT is added)', () => {
    expect(localeFromCountry('BR')).toBe('pt-BR');
    expect(localeFromCountry('PT')).toBe('pt-BR');
  });

  test('lower-case input still matches', () => {
    expect(localeFromCountry('de')).toBe('de');
  });

  test('null / undefined / empty input falls back to default', () => {
    expect(localeFromCountry(null)).toBe(DEFAULT_LOCALE);
    expect(localeFromCountry(undefined)).toBe(DEFAULT_LOCALE);
    expect(localeFromCountry('')).toBe(DEFAULT_LOCALE);
  });

  test('unknown country (e.g. NZ, JP) falls back to default', () => {
    // We don't ship Japanese / NZ-specific locales yet; safe fallback.
    expect(localeFromCountry('NZ')).toBe(DEFAULT_LOCALE);
    expect(localeFromCountry('JP')).toBe(DEFAULT_LOCALE);
    expect(localeFromCountry('ZZ')).toBe(DEFAULT_LOCALE);
  });
});

describe('COUNTRY_LOCALE_MAP integrity', () => {
  test('every mapped locale is a supported locale', () => {
    // Catches typos like accidentally writing "IT: 'ita'" — would
    // resolve to a missing message bundle and 500 the page.
    for (const [country, locale] of Object.entries(COUNTRY_LOCALE_MAP)) {
      expect(SUPPORTED_LOCALES).toContain(locale);
      expect(country).toMatch(/^[A-Z]{2}$/); // ISO-3166-1 alpha-2
    }
  });
});
