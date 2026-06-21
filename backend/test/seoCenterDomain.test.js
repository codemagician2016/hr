function loadSeoCenter(platformDomain = 'sitepresso.test') {
  jest.resetModules();
  process.env.PLATFORM_DOMAIN = platformDomain;
  return require('../src/core/lib/seoCenter');
}

function business(subscription = {}) {
  return {
    id: 'biz_123',
    slug: 'paperbyte',
    name: 'PaperByte',
    subscription,
  };
}

describe('SEO primary domain selection', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('active custom domain becomes the only canonical SEO domain', () => {
    process.env.SEO_INDEXING = 'on';
    const { publicBaseUrl, seoDomainState } = loadSeoCenter();
    const b = business({
      customDomain: 'www.customer.com',
      customDomainVerified: true,
      customDomainStatus: 'ACTIVE',
    });

    expect(publicBaseUrl(b, {}, 'paperbyte.sitepresso.test')).toBe('https://www.customer.com');
    expect(seoDomainState(b).status).toBe('active_custom_domain');
    expect(seoDomainState(b).usingCustomDomain).toBe(true);
    expect(seoDomainState(b).seoEnabled).toBe(true);
  });

  test('pending custom domain disables SEO instead of using the subdomain', () => {
    const { publicBaseUrl, seoDomainState } = loadSeoCenter();
    const b = business({
      customDomain: 'www.customer.com',
      customDomainVerified: false,
      customDomainStatus: 'PENDING_SSL',
    });

    expect(publicBaseUrl(b)).toBeNull();
    expect(seoDomainState(b)).toMatchObject({
      status: 'preparing',
      usingCustomDomain: false,
      seoEnabled: false,
      canonicalHost: null,
      fallbackHost: 'paperbyte.sitepresso.test',
      customDomain: 'www.customer.com',
    });
  });

  test('broken custom domain disables SEO instead of using the subdomain', () => {
    const { publicBaseUrl, seoDomainState } = loadSeoCenter();
    const b = business({
      customDomain: 'www.customer.com',
      customDomainVerified: false,
      customDomainStatus: 'FAILED',
    });

    expect(publicBaseUrl(b)).toBeNull();
    expect(seoDomainState(b)).toMatchObject({
      status: 'domain_issue',
      usingCustomDomain: false,
      seoEnabled: false,
      canonicalHost: null,
      fallbackHost: 'paperbyte.sitepresso.test',
    });
  });

  test('manual canonicalDomain cannot override domain safety', () => {
    const { publicBaseUrl, seoDomainState } = loadSeoCenter();
    const b = business();
    const settings = { canonicalDomain: 'wrong-customer.com' };

    expect(publicBaseUrl(b, settings)).toBeNull();
    expect(seoDomainState(b, settings)).toMatchObject({
      status: 'seo_disabled_subdomain',
      seoEnabled: false,
      canonicalHost: null,
      fallbackHost: 'paperbyte.sitepresso.test',
      configuredCanonicalDomain: 'wrong-customer.com',
    });
  });
});
