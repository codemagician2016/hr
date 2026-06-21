// Tests for resolveApiBaseUrl — the helper that builds .ics / OAuth /
// public-API URLs deterministically from env config (NOT from request
// headers, which is what caused the staff Notifications bug 2026-04-27).

const { resolveApiBaseUrl } = require('../src/core/utils/apiBaseUrl');

const SAVED = {
  PUBLIC_API_URL: process.env.PUBLIC_API_URL,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  PLATFORM_DOMAIN: process.env.PLATFORM_DOMAIN,
};

beforeEach(() => {
  delete process.env.PUBLIC_API_URL;
  delete process.env.NEXT_PUBLIC_API_URL;
  delete process.env.PLATFORM_DOMAIN;
});

afterAll(() => {
  Object.assign(process.env, SAVED);
});

describe('resolveApiBaseUrl', () => {
  test('prefers PUBLIC_API_URL when set', () => {
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    expect(resolveApiBaseUrl()).toBe('https://api.example.com');
  });

  test('falls back to NEXT_PUBLIC_API_URL when PUBLIC_API_URL is unset', () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.frontend-set.com';
    expect(resolveApiBaseUrl()).toBe('https://api.frontend-set.com');
  });

  test('PUBLIC_API_URL beats NEXT_PUBLIC_API_URL when both set', () => {
    process.env.PUBLIC_API_URL = 'https://api.canonical.com';
    process.env.NEXT_PUBLIC_API_URL = 'https://api.frontend.com';
    expect(resolveApiBaseUrl()).toBe('https://api.canonical.com');
  });

  test('strips trailing slash', () => {
    process.env.PUBLIC_API_URL = 'https://api.example.com/';
    expect(resolveApiBaseUrl()).toBe('https://api.example.com');
  });

  test('builds api.<PLATFORM_DOMAIN> from the tenant root when no explicit API URL', () => {
    process.env.PLATFORM_DOMAIN = 'aapkatech.com';
    expect(resolveApiBaseUrl()).toBe('https://api.aapkatech.com');
  });

  test('always uses HTTPS even if PLATFORM_DOMAIN is the only thing set (the staff-notifications bug)', () => {
    process.env.PLATFORM_DOMAIN = 'aapkatech.com';
    expect(resolveApiBaseUrl()).toMatch(/^https:\/\//);
  });

  test('defaults to api.sitepresso.com when nothing is set', () => {
    expect(resolveApiBaseUrl()).toBe('https://api.sitepresso.com');
  });
});
