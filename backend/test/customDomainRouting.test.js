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

  // This used to assert that PENDING_SSL and FAILED domains route, which was the
  // behaviour a later security fix deliberately removed: routing an unverified
  // domain meant merely SAVING one would serve a tenant on it, before any
  // ownership or certificate proof — the squat-routes-immediately hole named in
  // customDomainRouting.js. src/core/__tests__/domain.test.js already asserts the
  // corrected rule ("exactly ['ACTIVE']") and passes, so this suite was the only
  // thing still demanding the insecure behaviour.
  test('only ACTIVE (verified) domains route — unverified ones must not', () => {
    expect(routableCustomDomainWhere('www.customer.com')).toEqual({
      customDomain: { in: ['www.customer.com', 'customer.com'] },
      OR: [
        { customDomainVerified: true },
        { customDomainStatus: { in: ROUTABLE_CUSTOM_DOMAIN_STATUSES } },
      ],
    });
    expect(ROUTABLE_CUSTOM_DOMAIN_STATUSES).toEqual(['ACTIVE']);
    expect(ROUTABLE_CUSTOM_DOMAIN_STATUSES).not.toContain('FAILED');
    expect(ROUTABLE_CUSTOM_DOMAIN_STATUSES).not.toContain('PENDING_SSL');
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
