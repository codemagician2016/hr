/**
 * Notification deep links must point at the app that actually serves the page.
 *
 * Links were built from NEXT_PUBLIC_PLATFORM_URL / PLATFORM_DOMAIN — the
 * MARKETING host — while every page they open is served by the HR ADMIN app.
 * Measured against production before the fix:
 *
 *   drifthr.com/approvals             404      app.drifthr.com/approvals             200
 *   drifthr.com/careers/demo/c/<tok>  404      app.drifthr.com/careers/demo/c/<tok>  200
 *   demo.drifthr.com/careers/demo/c/<tok>  404 (tenant host has no such route)
 *
 * Two QA bugs (DRIFTHR-1001/-1002) were separate symptoms of this one defect.
 */

const ORIGINAL_ENV = { ...process.env };

function freshAppUrls(env) {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV, ...env };
  // eslint-disable-next-line global-require
  return require('../src/core/lib/appUrls');
}

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('adminAppBaseUrl', () => {
  test('production resolves to the app. host, never the bare platform host', () => {
    const { adminAppBaseUrl } = freshAppUrls({
      NODE_ENV: 'production',
      PLATFORM_DOMAIN: 'drifthr.com',
      IS_STAGING: '',
      ADMIN_APP_URL: '',
    });
    expect(adminAppBaseUrl()).toBe('https://app.drifthr.com');
  });

  test('staging resolves to the hyphenated app-staging host', () => {
    const { adminAppBaseUrl } = freshAppUrls({
      NODE_ENV: 'production',
      IS_STAGING: 'true',
      PLATFORM_DOMAIN: 'staging.drifthr.com',
      SUBDOMAIN_ZONE: 'drifthr.com',
      ADMIN_APP_URL: '',
    });
    expect(adminAppBaseUrl()).toBe('https://app-staging.drifthr.com');
  });

  test('an explicit ADMIN_APP_URL wins and is trailing-slash trimmed', () => {
    const { adminAppBaseUrl } = freshAppUrls({ ADMIN_APP_URL: 'https://console.acme.com/' });
    expect(adminAppBaseUrl()).toBe('https://console.acme.com');
  });

  test('NEXT_PUBLIC_PLATFORM_URL must NOT be able to drag links back to the marketing host', () => {
    // This env var is exactly what produced the 404s. Setting it must not change
    // where an admin deep link points.
    const { adminAppBaseUrl } = freshAppUrls({
      NODE_ENV: 'production',
      IS_STAGING: '',
      PLATFORM_DOMAIN: 'drifthr.com',
      NEXT_PUBLIC_PLATFORM_URL: 'https://drifthr.com',
      ADMIN_APP_URL: '',
    });
    expect(adminAppBaseUrl()).toBe('https://app.drifthr.com');
    expect(adminAppBaseUrl()).not.toBe('https://drifthr.com');
  });
});

describe('tenantAppBaseUrl', () => {
  test('resolves the tenant host that serves the ESS pages', () => {
    const { tenantAppBaseUrl } = freshAppUrls({
      NODE_ENV: 'production', IS_STAGING: '', PLATFORM_DOMAIN: 'drifthr.com',
    });
    expect(tenantAppBaseUrl('demo')).toBe('https://demo.drifthr.com');
  });

  test('returns null without a slug so callers cannot silently get a wrong host', () => {
    const { tenantAppBaseUrl } = freshAppUrls({});
    expect(tenantAppBaseUrl('')).toBeNull();
    expect(tenantAppBaseUrl(null)).toBeNull();
  });
});

describe('the links that were reported broken', () => {
  test('DRIFTHR-1002 — the candidate status link is admin-hosted AND keeps the slug', () => {
    const { adminAppBaseUrl } = freshAppUrls({
      NODE_ENV: 'production', IS_STAGING: '', PLATFORM_DOMAIN: 'drifthr.com', ADMIN_APP_URL: '',
    });
    const link = `${adminAppBaseUrl()}/careers/${encodeURIComponent('demo')}/c/${encodeURIComponent('tok123')}`;
    expect(link).toBe('https://app.drifthr.com/careers/demo/c/tok123');
    // the shape that 404'd: tenant host WITH the slug segment
    expect(link).not.toContain('demo.drifthr.com/careers/demo');
  });

  test('DRIFTHR-1001 — the scorecard link uses the route that exists', () => {
    const { adminAppBaseUrl } = freshAppUrls({
      NODE_ENV: 'production', IS_STAGING: '', PLATFORM_DOMAIN: 'drifthr.com', ADMIN_APP_URL: '',
    });
    const link = `${adminAppBaseUrl()}/recruitment/interviews/iv1/score`;
    expect(link).toBe('https://app.drifthr.com/recruitment/interviews/iv1/score');
    // /me/scorecards exists in NO app — it 404'd on every host
    expect(link).not.toContain('/me/scorecards');
  });
});
