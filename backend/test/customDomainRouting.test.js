const {
  ROUTABLE_CUSTOM_DOMAIN_STATUSES,
  customDomainLookupHosts,
  normalizeCustomDomainHost,
  routableCustomDomainWhere,
} = require('../src/core/lib/customDomainRouting');

describe('custom domain routing helpers', () => {
  test('normalizes hostnames for lookup', () => {
    expect(normalizeCustomDomainHost('WWW.Example.COM:443.')).toBe('www.example.com');
  });

  test('allows connected domains that are not SEO-active yet', () => {
    expect(routableCustomDomainWhere('www.customer.com')).toEqual({
      customDomain: { in: ['www.customer.com', 'customer.com'] },
      OR: [
        { customDomainVerified: true },
        { customDomainStatus: { in: ROUTABLE_CUSTOM_DOMAIN_STATUSES } },
      ],
    });
    expect(ROUTABLE_CUSTOM_DOMAIN_STATUSES).toContain('FAILED');
    expect(ROUTABLE_CUSTOM_DOMAIN_STATUSES).toContain('PENDING_SSL');
  });

  test('looks up apex and www pairs for customer domains', () => {
    expect(customDomainLookupHosts('paperbyte.co.in')).toEqual(['paperbyte.co.in', 'www.paperbyte.co.in']);
    expect(customDomainLookupHosts('www.taxfixy.com')).toEqual(['www.taxfixy.com', 'taxfixy.com']);
    expect(customDomainLookupHosts('portal.customer.com')).toEqual(['portal.customer.com']);
  });

  test('returns null for empty hosts', () => {
    expect(routableCustomDomainWhere('')).toBeNull();
  });
});
