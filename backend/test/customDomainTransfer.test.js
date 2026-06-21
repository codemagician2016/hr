const {
  customDomainClaimDomains,
  customDomainOwnershipChallenge,
  customDomainStatusFrom,
  deleteCloudflareCustomHostname,
  ensureCloudflareCustomHostname,
} = require('../src/core/controllers/subscription.controller');

describe('custom domain transfer helpers', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV, CUSTOM_DOMAIN_TRANSFER_SECRET: 'test-secret' };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('claims apex and www together for root domains', () => {
    expect(customDomainClaimDomains('example.com')).toEqual(['example.com', 'www.example.com']);
    expect(customDomainClaimDomains('www.example.com')).toEqual(['www.example.com', 'example.com']);
    expect(customDomainClaimDomains('shop.example.com')).toEqual(['shop.example.com']);
  });

  test('uses apex TXT record for www transfer verification', () => {
    const challenge = customDomainOwnershipChallenge({
      domain: 'www.example.com',
      businessId: 'business_123',
    });

    expect(challenge).toMatchObject({
      type: 'TXT',
      name: '_sitepresso-verify.example.com',
      host: '_sitepresso-verify',
      baseDomain: 'example.com',
    });
    expect(challenge.value).toMatch(/^sitepresso-verify=[a-f0-9]{40}$/);
  });

  test('uses subdomain TXT record for non-www subdomain transfer verification', () => {
    const challenge = customDomainOwnershipChallenge({
      domain: 'shop.example.com',
      businessId: 'business_123',
    });

    expect(challenge).toMatchObject({
      type: 'TXT',
      name: '_sitepresso-verify.shop.example.com',
      host: '_sitepresso-verify',
      baseDomain: 'shop.example.com',
    });
  });

  test('treats active Cloudflare custom hostname as live even when DNS inspection misses the CNAME', () => {
    expect(customDomainStatusFrom({
      dnsState: { matches: false },
      cloudflareState: {
        configured: true,
        result: { status: 'active', ssl: { status: 'active' } },
      },
    })).toEqual({
      verified: true,
      status: 'ACTIVE',
      message: 'DNS and HTTPS are active.',
    });
  });

  test('registers www and apex Cloudflare hostnames for root-domain pairs', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
    process.env.CLOUDFLARE_CUSTOM_HOSTNAME_ZONE_ID = 'zone_123';
    process.env.CUSTOM_DOMAIN_TARGET_CNAME = 'custom.sitepresso.com';
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = jest.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/fallback_origin')) {
        return {
          ok: true,
          json: async () => ({ success: true, result: { origin: 'custom.sitepresso.com', status: 'active' } }),
        };
      }
      if (String(url).includes('/custom_hostnames?hostname=')) {
        return { ok: true, json: async () => ({ success: true, result: [] }) };
      }
      if (String(url).endsWith('/custom_hostnames') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            success: true,
            result: { id: `ch_${body.hostname.replace(/[^a-z0-9]/g, '_')}`, hostname: body.hostname, status: 'pending', ssl: { status: 'pending_validation' } },
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    try {
      const result = await ensureCloudflareCustomHostname({
        domain: 'www.example.com',
        business: { id: 'biz_1', slug: 'demo', vertical: 'STATIC' },
      });
      const postHostnames = calls
        .filter((call) => call.options?.method === 'POST' && call.url.endsWith('/custom_hostnames'))
        .map((call) => JSON.parse(call.options.body).hostname);

      expect(postHostnames).toEqual(['www.example.com', 'example.com']);
      expect(result.result.hostname).toBe('www.example.com');
      expect(result.hostnames.map((item) => item.hostname)).toEqual(['www.example.com', 'example.com']);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('disconnect cleanup removes the paired apex hostname too', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
    process.env.CLOUDFLARE_CUSTOM_HOSTNAME_ZONE_ID = 'zone_123';
    const originalFetch = global.fetch;
    const deleted = [];
    global.fetch = jest.fn(async (url, options = {}) => {
      const textUrl = String(url);
      if (textUrl.includes('/custom_hostnames?hostname=www.example.com')) {
        return { ok: true, json: async () => ({ success: true, result: [{ id: 'ch_www', hostname: 'www.example.com' }] }) };
      }
      if (textUrl.includes('/custom_hostnames?hostname=example.com')) {
        return { ok: true, json: async () => ({ success: true, result: [{ id: 'ch_apex', hostname: 'example.com' }] }) };
      }
      if (options.method === 'DELETE') {
        deleted.push(textUrl.split('/').pop());
        return { ok: true, json: async () => ({ success: true, result: { id: textUrl.split('/').pop() } }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    try {
      const result = await deleteCloudflareCustomHostname('ch_www', { domain: 'www.example.com' });
      expect(result.deleted).toBe(true);
      expect(deleted).toEqual(['ch_www', 'ch_apex']);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
