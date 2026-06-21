const {
  DEFAULT_BASE_URLS,
  completePaidDomainRegistration,
  completePaidDomainRenewal,
  createDomainRegistrationCheckout,
  createDomainRenewalCheckout,
  DEFAULT_SEARCH_TLDS,
  getDomainResellerMode,
  getRegistrarConfig,
  handleDomainPaymentAdjustment,
  isProdBuyTransferPaused,
  listBusinessDomains,
  normalizeDomainName,
  parseDomainSearchQuery,
  quoteDomainAmountMinor,
  registerManagedDomain,
  renewDomain,
  resolveDomainTraffic,
  resolveRegistrarForTld,
  searchAvailableAcrossRegistrars,
  tldFromDomain,
  assertProdBuyTransferEnabled,
} = require('../src/domains');
const { OpenproviderAdapter, TOKEN_CACHE } = require('../src/domains/adapters/openprovider');
const { FEATURE_CATALOG } = require('../src/core/lib/featuresCatalog');

function opResponse(data, { ok = true, status = 200, code = 0, desc = '' } = {}) {
  return {
    ok,
    status,
    json: async () => ({ code, data, desc }),
  };
}

describe('domain reseller foundation', () => {
  test('Domain Studio is core infrastructure, not a seller feature toggle', () => {
    expect(FEATURE_CATALOG.domainReseller).toBeUndefined();
  });

  test('normalizes domain names and handles second-level TLDs', () => {
    expect(normalizeDomainName('HTTPS://WWW.MyShop.CO.NZ/path')).toBe('www.myshop.co.nz');
    expect(tldFromDomain('myshop.co.nz')).toBe('co.nz');
    expect(parseDomainSearchQuery('myshop.com')).toEqual({
      label: 'myshop',
      exactDomain: 'myshop.com',
      requestedTlds: ['com'],
    });
  });

  test('routes every supported TLD to Openprovider and restricts gov/edu/mil', () => {
    expect(resolveRegistrarForTld('.com')).toEqual({ tld: 'com', supported: true, registrar: 'OPENPROVIDER' });
    expect(resolveRegistrarForTld('co.nz')).toEqual({ tld: 'co.nz', supported: true, registrar: 'OPENPROVIDER' });
    expect(resolveRegistrarForTld('photography')).toEqual({ tld: 'photography', supported: true, registrar: 'OPENPROVIDER' });
    expect(resolveRegistrarForTld('gov')).toEqual({ tld: 'gov', supported: false, registrar: null, reason: 'restricted_tld' });
  });

  test('defaults to sandbox endpoints until credentials are supplied', () => {
    expect(getDomainResellerMode({})).toBe('sandbox');
    expect(getRegistrarConfig('OPENPROVIDER', {}).baseUrl).toBe(DEFAULT_BASE_URLS.OPENPROVIDER.sandbox);
    expect(getRegistrarConfig('OPENPROVIDER', { DOMAIN_RESELLER_MODE: 'live' }).baseUrl).toBe(DEFAULT_BASE_URLS.OPENPROVIDER.live);
  });

  test('Openprovider adapter sends documented v1beta payloads', async () => {
    TOKEN_CACHE.clear();
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(opResponse({ token: 'tok_test' }))
      .mockResolvedValueOnce(opResponse({ id: 123, expiration_date: '2027-06-06 00:00:00' }))
      .mockResolvedValueOnce(opResponse({ status: 'ACT' }))
      .mockResolvedValueOnce(opResponse({ auth_code: 'AUTH-123456' }))
      .mockResolvedValueOnce(opResponse({ success: true }))
      .mockResolvedValueOnce(opResponse({ success: true }));
    const adapter = new OpenproviderAdapter({
      fetchImpl,
      config: {
        mode: 'sandbox',
        baseUrl: 'https://api.example.test/v1beta',
        username: 'openprovider',
        password: 'secret',
        authIp: '0.0.0.0',
        customerHandle: 'XX123456-XX',
        nameservers: ['ns1.sitepresso.com', 'ns2.sitepresso.com'],
        hasCredentials: true,
      },
    });

    await expect(adapter.register({ domainName: 'myshop.com', years: 2, privacyEnabled: true })).resolves.toEqual(expect.objectContaining({
      registrarRef: '123',
      expiresAt: '2027-06-06 00:00:00',
    }));
    await adapter.renew('123', 1, { domainName: 'myshop.com' });
    await expect(adapter.getAuthCode('123', { domainName: 'myshop.com' })).resolves.toEqual(expect.objectContaining({
      authCode: 'AUTH-123456',
    }));
    await adapter.setPrivacy('123', false, { domainName: 'myshop.com' });
    await expect(adapter.setNameservers('123', ['NS1.Sitepresso.com', 'ns2.sitepresso.com'], { domainName: 'myshop.com' })).resolves.toEqual(expect.objectContaining({
      nameservers: ['ns1.sitepresso.com', 'ns2.sitepresso.com'],
    }));

    const calls = fetchImpl.mock.calls.map(([url, init]) => ({
      url,
      method: init.method,
      body: init.body ? JSON.parse(init.body) : null,
    }));
    expect(calls[0]).toEqual(expect.objectContaining({
      url: 'https://api.example.test/v1beta/auth/login',
      method: 'POST',
      body: { username: 'openprovider', password: 'secret', ip: '0.0.0.0' },
    }));
    expect(calls[1]).toEqual(expect.objectContaining({
      url: 'https://api.example.test/v1beta/domains',
      method: 'POST',
      body: expect.objectContaining({
        domain: { name: 'myshop', extension: 'com' },
        period: 2,
        unit: 'yearly',
        owner_handle: 'XX123456-XX',
        admin_handle: 'XX123456-XX',
        tech_handle: 'XX123456-XX',
        billing_handle: 'XX123456-XX',
        name_servers: [{ name: 'ns1.sitepresso.com' }, { name: 'ns2.sitepresso.com' }],
        is_private_whois_enabled: true,
      }),
    }));
    expect(calls[2]).toEqual(expect.objectContaining({
      url: 'https://api.example.test/v1beta/domains/123/renew',
      method: 'POST',
      body: { period: 1, id: 123, domain: { name: 'myshop', extension: 'com' } },
    }));
    expect(calls[3]).toEqual(expect.objectContaining({
      url: 'https://api.example.test/v1beta/domains/123/authcode?domain.name=myshop&domain.extension=com',
      method: 'GET',
    }));
    expect(calls[4]).toEqual(expect.objectContaining({
      url: 'https://api.example.test/v1beta/domains/123',
      method: 'PUT',
      body: { is_private_whois_enabled: false, domain: { name: 'myshop', extension: 'com' } },
    }));
    expect(calls[5]).toEqual(expect.objectContaining({
      url: 'https://api.example.test/v1beta/domains/123',
      method: 'PUT',
      body: {
        name_servers: [{ name: 'NS1.Sitepresso.com' }, { name: 'ns2.sitepresso.com' }],
        domain: { name: 'myshop', extension: 'com' },
      },
    }));
  });

  test('Openprovider auth-code lookup falls back to domain details if sandbox lacks the authcode endpoint', async () => {
    TOKEN_CACHE.clear();
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(opResponse({ token: 'tok_test' }))
      .mockResolvedValueOnce(opResponse({}, { ok: false, status: 404, code: 404, desc: 'not found' }))
      .mockResolvedValueOnce(opResponse({ auth_code: 'FALLBACK-CODE' }));
    const adapter = new OpenproviderAdapter({
      fetchImpl,
      config: {
        mode: 'sandbox',
        baseUrl: 'https://api.example.test/v1beta',
        username: 'openprovider',
        password: 'secret',
        customerHandle: 'XX123456-XX',
        nameservers: ['ns1.sitepresso.com', 'ns2.sitepresso.com'],
        hasCredentials: true,
      },
    });

    await expect(adapter.getAuthCode('123', { domainName: 'myshop.com' })).resolves.toEqual(expect.objectContaining({
      authCode: 'FALLBACK-CODE',
    }));
    expect(fetchImpl.mock.calls[1][0]).toBe('https://api.example.test/v1beta/domains/123/authcode?domain.name=myshop&domain.extension=com');
    expect(fetchImpl.mock.calls[2][0]).toBe('https://api.example.test/v1beta/domains/123?domain.name=myshop&domain.extension=com');
  });

  test('Openprovider adapter does not immediately retry API-level rate blocks', async () => {
    TOKEN_CACHE.clear();
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(opResponse({ token: 'tok_test' }))
      .mockResolvedValueOnce(opResponse({}, {
        code: 4007,
        desc: 'API access temporarily blocked because of excessive use',
      }));
    const adapter = new OpenproviderAdapter({
      fetchImpl,
      config: {
        mode: 'sandbox',
        baseUrl: 'https://api.example.test/v1beta',
        username: 'openprovider',
        password: 'secret',
        customerHandle: 'XX123456-XX',
        nameservers: ['ns1.sitepresso.com', 'ns2.sitepresso.com'],
        hasCredentials: true,
      },
    });

    await expect(adapter.register({ domainName: 'myshop.com', years: 1 })).rejects.toMatchObject({
      retryable: false,
      openprovider: expect.objectContaining({ code: 4007 }),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe('https://api.example.test/v1beta/domains');
  });

  test('pauses buy and transfer actions on the production domain until explicitly enabled', () => {
    expect(isProdBuyTransferPaused({ PLATFORM_DOMAIN: 'sitepresso.com' })).toBe(true);
    expect(isProdBuyTransferPaused({ PLATFORM_DOMAIN: 'app.sitepresso.com' })).toBe(true);
    expect(isProdBuyTransferPaused({ PLATFORM_DOMAIN: 'aapkatech.com' })).toBe(false);
    expect(isProdBuyTransferPaused({
      PLATFORM_DOMAIN: 'sitepresso.com',
      DOMAIN_RESELLER_PROD_BUY_TRANSFER_ENABLED: 'true',
    })).toBe(false);
    expect(() => assertProdBuyTransferEnabled({ PLATFORM_DOMAIN: 'sitepresso.com' })).toThrow(/temporarily unavailable/);
  });

  test('mock search merges registrar results with renewal prices and unsupported TLDs', async () => {
    const out = await searchAvailableAcrossRegistrars('myshop', {
      tlds: ['com', 'in', 'co.nz', 'photography', 'gov'],
    });

    expect(out.results.map((r) => r.domainName)).toEqual([
      'myshop.com',
      'myshop.in',
      'myshop.co.nz',
      'myshop.photography',
    ]);
    expect(out.results.every((r) => r.renewalPriceMinor && r.currency)).toBe(true);
    expect(out.results.find((r) => r.tld === 'com').registrar).toBe('OPENPROVIDER');
    expect(out.results.find((r) => r.tld === 'co.nz').registrar).toBe('OPENPROVIDER');
    expect(out.unsupported).toEqual([{ tld: 'gov', supported: false, registrar: null, reason: 'restricted_tld' }]);
  });

  test('default search list covers the first-screen TLD set', () => {
    expect(DEFAULT_SEARCH_TLDS).toEqual(expect.arrayContaining(['com', 'in', 'store', 'co.nz', 'com.au']));
  });

  test('multi-year domain quotes apply the advertised discount', () => {
    expect(quoteDomainAmountMinor({ priceMinor: 10000, renewalPriceMinor: 20000 }, 1)).toEqual({
      years: 1,
      subtotalMinor: 10000,
      discountMinor: 0,
      totalMinor: 10000,
    });
    expect(quoteDomainAmountMinor({ priceMinor: 10000, renewalPriceMinor: 20000 }, 3)).toEqual({
      years: 3,
      subtotalMinor: 50000,
      discountMinor: 5000,
      totalMinor: 45000,
    });
  });

  test('registers an available domain through the routed adapter and snapshots pricing', async () => {
    const createdRows = [];
    const prisma = {
      domain: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }) => {
          const row = {
            id: 'dom_1',
            createdAt: new Date('2026-05-30T00:00:00Z'),
            updatedAt: new Date('2026-05-30T00:00:00Z'),
            ...data,
          };
          createdRows.push(row);
          return row;
        }),
      },
    };

    const result = await registerManagedDomain({
      prisma,
      businessId: 'biz_1',
      domainName: 'myshop.com',
      privacyEnabled: true,
      bindDomain: false,
    });

    expect(result.domain).toEqual(expect.objectContaining({
      name: 'myshop.com',
      registrar: 'OPENPROVIDER',
      status: 'ACTIVE',
      privacyEnabled: true,
      retailMinor: 129900,
      renewalRetailMinor: 129900,
      currency: 'INR',
    }));
    expect(createdRows[0].registrarRef).toMatch(/^OP-MYSHOP-COM/);
  });

  test('business domain list marks primary and redirect aliases', async () => {
    const domains = [
      {
        id: 'dom_1',
        businessId: 'biz_1',
        name: 'myshop.com',
        tld: 'com',
        registrar: 'OPENPROVIDER',
        registrarRef: 'RC-MYSHOP-COM',
        status: 'ACTIVE',
        statusMessage: null,
        registeredAt: new Date('2026-05-30T00:00:00Z'),
        expiresAt: new Date(Date.now() + 5 * 86400000),
        autoRenew: false,
        privacyEnabled: true,
        trusteeEnabled: false,
        wholesaleMinor: 74000,
        retailMinor: 129900,
        renewalRetailMinor: 129900,
        currency: 'INR',
        customHostnameId: null,
        createdAt: new Date('2026-05-30T00:00:00Z'),
        updatedAt: new Date('2026-05-30T00:00:00Z'),
      },
      {
        id: 'dom_2',
        businessId: 'biz_1',
        name: 'myshop.in',
        tld: 'in',
        registrar: 'OPENPROVIDER',
        registrarRef: 'RC-MYSHOP-IN',
        status: 'ACTIVE',
        statusMessage: null,
        registeredAt: new Date('2026-05-30T00:00:00Z'),
        expiresAt: new Date(Date.now() + 200 * 86400000),
        autoRenew: true,
        privacyEnabled: true,
        trusteeEnabled: false,
        wholesaleMinor: 74000,
        retailMinor: 99900,
        renewalRetailMinor: 99900,
        currency: 'INR',
        customHostnameId: null,
        createdAt: new Date('2026-05-30T00:00:00Z'),
        updatedAt: new Date('2026-05-30T00:00:00Z'),
      },
    ];
    const prisma = {
      domain: {
        findMany: jest.fn().mockResolvedValue(domains),
      },
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          customDomain: 'myshop.com',
          customDomainVerified: true,
          customDomainStatus: 'ACTIVE',
          customDomainStatusMessage: null,
          customDomainCheckedAt: new Date('2026-05-30T00:00:00Z'),
        }),
      },
    };

    const result = await listBusinessDomains({ prisma, businessId: 'biz_1' });
    expect(result.domains[0]).toEqual(expect.objectContaining({
      name: 'myshop.com',
      primary: true,
      trafficRole: 'PRIMARY',
      displayStatus: 'EXPIRING',
      daysUntilExpiry: expect.any(Number),
    }));
    expect(result.domains[1]).toEqual(expect.objectContaining({
      name: 'myshop.in',
      primary: false,
      trafficRole: 'REDIRECT',
      trafficTarget: 'myshop.com',
    }));
    expect(result.summary).toEqual(expect.objectContaining({
      total: 2,
      primary: 1,
      redirects: 1,
      expiring: 1,
      autoRenew: 1,
    }));
  });

  test('domain traffic route redirects aliases and www variants to the primary host', async () => {
    const primaryBusiness = {
      slug: 'myshop',
      vertical: 'STATIC',
      subscription: {
        customDomain: 'myshop.com',
        customDomainVerified: true,
        customDomainStatus: 'ACTIVE',
      },
    };
    const aliasDomain = {
      name: 'myshop.in',
      business: {
        slug: 'myshop',
        vertical: 'STATIC',
        subscription: {
          customDomain: 'myshop.com',
          customDomainVerified: true,
          customDomainStatus: 'ACTIVE',
        },
      },
    };
    const prisma = {
      business: {
        findFirst: jest.fn()
          .mockResolvedValueOnce(primaryBusiness)
          .mockResolvedValueOnce(null),
      },
      domain: {
        findFirst: jest.fn().mockResolvedValue(aliasDomain),
      },
    };

    await expect(resolveDomainTraffic({ prisma, host: 'www.myshop.com' })).resolves.toEqual(expect.objectContaining({
      action: 'redirect',
      statusCode: 301,
      targetHost: 'myshop.com',
      vertical: 'web',
    }));
    await expect(resolveDomainTraffic({ prisma, host: 'myshop.in' })).resolves.toEqual(expect.objectContaining({
      action: 'redirect',
      statusCode: 301,
      targetHost: 'myshop.com',
      aliasHost: 'myshop.in',
    }));
  });

  test('live registration is payment-gated before registrar call', async () => {
    const originalMode = process.env.DOMAIN_RESELLER_MODE;
    process.env.DOMAIN_RESELLER_MODE = 'live';
    try {
      const prisma = {
        domain: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
      };

      await expect(registerManagedDomain({
        prisma,
        businessId: 'biz_1',
        domainName: 'myshop.com',
        bindDomain: false,
      })).rejects.toMatchObject({ code: 'DOMAIN_PAYMENT_REQUIRED', status: 402 });

      await expect(registerManagedDomain({
        prisma,
        businessId: 'biz_1',
        domainName: 'paidflag.com',
        paymentConfirmed: true,
        bindDomain: false,
      })).rejects.toMatchObject({ code: 'DOMAIN_PAYMENT_REQUIRED', status: 402 });

      expect(prisma.domain.create).not.toHaveBeenCalled();
    } finally {
      if (originalMode === undefined) delete process.env.DOMAIN_RESELLER_MODE;
      else process.env.DOMAIN_RESELLER_MODE = originalMode;
    }
  });

  test('live renewal is payment-gated before registrar call', async () => {
    const originalMode = process.env.DOMAIN_RESELLER_MODE;
    const originalPaddleKey = process.env.PADDLE_API_KEY;
    process.env.DOMAIN_RESELLER_MODE = 'live';
    delete process.env.PADDLE_API_KEY;
    try {
      const domain = {
        id: 'dom_renew',
        businessId: 'biz_1',
        name: 'myshop.com',
        tld: 'com',
        registrar: 'OPENPROVIDER',
        registrarRef: 'RC-MYSHOP-COM',
        status: 'ACTIVE',
        statusMessage: null,
        registeredAt: new Date('2026-05-30T00:00:00Z'),
        expiresAt: new Date('2026-06-30T00:00:00Z'),
        autoRenew: true,
        privacyEnabled: true,
        trusteeEnabled: false,
        wholesaleMinor: 74000,
        retailMinor: 129900,
        renewalRetailMinor: 129900,
        currency: 'INR',
        customHostnameId: null,
        createdAt: new Date('2026-05-30T00:00:00Z'),
        updatedAt: new Date('2026-05-30T00:00:00Z'),
      };
      const prisma = {
        domain: {
          findFirst: jest.fn().mockResolvedValue(domain),
          update: jest.fn(),
        },
      };
      const adapters = {
        OPENPROVIDER: {
          renew: jest.fn(),
        },
      };

      await expect(renewDomain({
        prisma,
        businessId: 'biz_1',
        id: 'dom_renew',
        adapters,
      })).rejects.toMatchObject({ code: 'DOMAIN_RENEWAL_PAYMENT_REQUIRED', status: 402 });

      await expect(createDomainRenewalCheckout({
        prisma,
        businessId: 'biz_1',
        id: 'dom_renew',
      })).rejects.toMatchObject({ code: 'PADDLE_REQUIRED_FOR_DOMAIN_RENEWAL', status: 503 });

      expect(adapters.OPENPROVIDER.renew).not.toHaveBeenCalled();
      expect(prisma.domain.update).not.toHaveBeenCalled();
    } finally {
      if (originalMode === undefined) delete process.env.DOMAIN_RESELLER_MODE;
      else process.env.DOMAIN_RESELLER_MODE = originalMode;
      if (originalPaddleKey === undefined) delete process.env.PADDLE_API_KEY;
      else process.env.PADDLE_API_KEY = originalPaddleKey;
    }
  });

  test('domain checkout falls back to direct sandbox registration when Paddle is not configured', async () => {
    const originalMode = process.env.DOMAIN_RESELLER_MODE;
    const originalPaddleKey = process.env.PADDLE_API_KEY;
    process.env.DOMAIN_RESELLER_MODE = 'sandbox';
    delete process.env.PADDLE_API_KEY;
    try {
      const prisma = {
        business: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'biz_1',
            slug: 'myshop',
            name: 'My Shop',
            email: 'owner@example.com',
            country: 'IN',
          }),
        },
        subscription: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
        domain: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(async ({ data }) => ({
            id: 'dom_1',
            createdAt: new Date('2026-05-30T00:00:00Z'),
            updatedAt: new Date('2026-05-30T00:00:00Z'),
            ...data,
          })),
        },
      };

      const result = await createDomainRegistrationCheckout({
        prisma,
        businessId: 'biz_1',
        domainName: 'myshop.com',
        privacyEnabled: true,
        bindDomain: false,
      });

      expect(result.action).toBe('registered');
      expect(result.domain).toEqual(expect.objectContaining({
        name: 'myshop.com',
        status: 'ACTIVE',
      }));
    } finally {
      if (originalMode === undefined) delete process.env.DOMAIN_RESELLER_MODE;
      else process.env.DOMAIN_RESELLER_MODE = originalMode;
      if (originalPaddleKey === undefined) delete process.env.PADDLE_API_KEY;
      else process.env.PADDLE_API_KEY = originalPaddleKey;
    }
  });

  test('live domain checkout requires Paddle before registrar registration', async () => {
    const originalMode = process.env.DOMAIN_RESELLER_MODE;
    const originalPaddleKey = process.env.PADDLE_API_KEY;
    process.env.DOMAIN_RESELLER_MODE = 'live';
    delete process.env.PADDLE_API_KEY;
    try {
      const prisma = {
        business: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'biz_1',
            slug: 'myshop',
            name: 'My Shop',
            email: 'owner@example.com',
          }),
        },
        subscription: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
        domain: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
      };

      await expect(createDomainRegistrationCheckout({
        prisma,
        businessId: 'biz_1',
        domainName: 'myshop.com',
      })).rejects.toMatchObject({ code: 'PADDLE_REQUIRED_FOR_DOMAIN_REGISTRATION', status: 503 });
      expect(prisma.domain.create).not.toHaveBeenCalled();
    } finally {
      if (originalMode === undefined) delete process.env.DOMAIN_RESELLER_MODE;
      else process.env.DOMAIN_RESELLER_MODE = originalMode;
      if (originalPaddleKey === undefined) delete process.env.PADDLE_API_KEY;
      else process.env.PADDLE_API_KEY = originalPaddleKey;
    }
  });

  test('paid Paddle webhook finalizes a pending domain registration', async () => {
    const pending = {
      id: 'dom_1',
      businessId: 'biz_1',
      name: 'paidshop.com',
      tld: 'com',
      registrar: 'OPENPROVIDER',
      registrarRef: 'PADDLE:txn_123',
      status: 'PENDING',
      statusMessage: 'Payment pending.',
      registeredAt: null,
      expiresAt: null,
      autoRenew: true,
      privacyEnabled: true,
      trusteeEnabled: false,
      wholesaleMinor: 74000,
      retailMinor: 129900,
      renewalRetailMinor: 129900,
      currency: 'INR',
      customHostnameId: null,
      createdAt: new Date('2026-05-30T00:00:00Z'),
      updatedAt: new Date('2026-05-30T00:00:00Z'),
    };
    const prisma = {
      domain: {
        findUnique: jest.fn().mockResolvedValue(pending),
        update: jest.fn(async ({ data }) => ({ ...pending, ...data, updatedAt: new Date('2026-05-30T01:00:00Z') })),
      },
      subscription: {
        findUnique: jest.fn().mockResolvedValue({ customDomain: null }),
      },
    };
    const adapters = {
      OPENPROVIDER: {
        register: jest.fn().mockResolvedValue({
          registrarRef: 'RC-PAIDSHOP-COM',
          expiresAt: '2027-05-30T00:00:00.000Z',
        }),
      },
    };

    const result = await completePaidDomainRegistration({
      prisma,
      adapters,
      bindDomain: false,
      entity: {
        id: 'txn_123',
        custom_data: {
          kind: 'domain_registration',
          businessId: 'biz_1',
          domainName: 'paidshop.com',
          registrar: 'OPENPROVIDER',
          years: 1,
          privacyEnabled: true,
          retailMinor: 129900,
          renewalRetailMinor: 129900,
          wholesaleMinor: 74000,
          currency: 'INR',
        },
      },
    });

    expect(result.handled).toBe(true);
    expect(result.domain).toEqual(expect.objectContaining({
      name: 'paidshop.com',
      status: 'ACTIVE',
      registrarRef: 'RC-PAIDSHOP-COM',
    }));
    expect(adapters.OPENPROVIDER.register).toHaveBeenCalledWith(expect.objectContaining({
      domainName: 'paidshop.com',
      privacyEnabled: true,
    }));
  });

  test('approved registration refund locks active domain by stored Paddle transaction id', async () => {
    const active = {
      id: 'dom_refund_1',
      businessId: 'biz_1',
      name: 'paidshop.com',
      tld: 'com',
      registrar: 'OPENPROVIDER',
      registrarRef: 'RC-PAIDSHOP-COM',
      status: 'ACTIVE',
      statusMessage: 'Domain registered.',
      registeredAt: new Date('2026-05-30T00:00:00Z'),
      expiresAt: new Date('2027-05-30T00:00:00Z'),
      autoRenew: true,
      privacyEnabled: true,
      trusteeEnabled: false,
      wholesaleMinor: 74000,
      retailMinor: 129900,
      renewalRetailMinor: 129900,
      currency: 'INR',
      customHostnameId: null,
      registrationPaddleTransactionId: 'txn_registration_123',
      renewalPaddleTransactionId: null,
      renewalPaymentStatus: null,
      createdAt: new Date('2026-05-30T00:00:00Z'),
      updatedAt: new Date('2026-05-30T01:00:00Z'),
    };
    const prisma = {
      domain: {
        findFirst: jest.fn().mockResolvedValue(active),
        update: jest.fn(async ({ data }) => ({ ...active, ...data })),
      },
    };

    const result = await handleDomainPaymentAdjustment({
      prisma,
      entity: {
        id: 'adj_1',
        transaction_id: 'txn_registration_123',
        action: 'refund',
        status: 'approved',
        type: 'full',
      },
    });

    expect(result).toEqual(expect.objectContaining({ handled: true, updated: 1 }));
    expect(prisma.domain.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'dom_refund_1' },
      data: expect.objectContaining({
        status: 'LOCKED',
        autoRenew: false,
      }),
    }));
  });

  test('paid Paddle webhook finalizes a pending domain renewal', async () => {
    const domain = {
      id: 'dom_renew_1',
      businessId: 'biz_1',
      name: 'paidshop.com',
      tld: 'com',
      registrar: 'OPENPROVIDER',
      registrarRef: 'RC-PAIDSHOP-COM',
      status: 'EXPIRING',
      statusMessage: 'Renewal payment pending.',
      registeredAt: new Date('2025-06-30T00:00:00Z'),
      expiresAt: new Date('2026-06-30T00:00:00Z'),
      autoRenew: true,
      privacyEnabled: true,
      trusteeEnabled: false,
      wholesaleMinor: 74000,
      retailMinor: 129900,
      renewalRetailMinor: 129900,
      currency: 'INR',
      customHostnameId: null,
      renewalPaddleTransactionId: 'txn_renew_123',
      renewalPaymentStatus: 'PENDING',
      renewalPaymentDueAt: new Date('2026-06-30T00:00:00Z'),
      renewalYears: 1,
      createdAt: new Date('2025-06-30T00:00:00Z'),
      updatedAt: new Date('2026-06-29T00:00:00Z'),
    };
    const prisma = {
      domain: {
        findFirst: jest.fn().mockResolvedValue(domain),
        update: jest.fn(async ({ data }) => ({ ...domain, ...data, updatedAt: new Date('2026-06-30T01:00:00Z') })),
      },
      subscription: {
        findUnique: jest.fn().mockResolvedValue({ customDomain: 'paidshop.com' }),
      },
    };
    const adapters = {
      OPENPROVIDER: {
        renew: jest.fn().mockResolvedValue({
          expiresAt: '2027-06-30T00:00:00.000Z',
        }),
      },
    };

    const result = await completePaidDomainRenewal({
      prisma,
      adapters,
      entity: {
        id: 'txn_renew_123',
        currency_code: 'INR',
        items: [{ price: { unit_price: { amount: '129900' } } }],
        custom_data: {
          kind: 'domain_renewal',
          businessId: 'biz_1',
          domainId: 'dom_renew_1',
          domainName: 'paidshop.com',
          registrar: 'OPENPROVIDER',
          years: 1,
          renewalRetailMinor: 129900,
          checkoutTotalMinor: 129900,
          currency: 'INR',
        },
      },
    });

    expect(result.handled).toBe(true);
    expect(result.domain).toEqual(expect.objectContaining({
      name: 'paidshop.com',
      status: 'ACTIVE',
      renewalPaymentStatus: 'COMPLETED',
      renewalPaddleTransactionId: 'txn_renew_123',
    }));
    expect(adapters.OPENPROVIDER.renew).toHaveBeenCalledWith('RC-PAIDSHOP-COM', 1, { domainName: 'paidshop.com' });
  });

  test('duplicate paid renewal webhook is idempotent', async () => {
    const domain = {
      id: 'dom_renew_done',
      businessId: 'biz_1',
      name: 'paidshop.com',
      tld: 'com',
      registrar: 'OPENPROVIDER',
      registrarRef: 'RC-PAIDSHOP-COM',
      status: 'ACTIVE',
      statusMessage: 'Domain renewed successfully.',
      registeredAt: new Date('2025-06-30T00:00:00Z'),
      expiresAt: new Date('2027-06-30T00:00:00Z'),
      autoRenew: true,
      privacyEnabled: true,
      trusteeEnabled: false,
      wholesaleMinor: 74000,
      retailMinor: 129900,
      renewalRetailMinor: 129900,
      currency: 'INR',
      customHostnameId: null,
      renewalPaddleTransactionId: 'txn_renew_123',
      renewalPaymentStatus: 'COMPLETED',
      renewalPaymentDueAt: null,
      renewalYears: 1,
      createdAt: new Date('2025-06-30T00:00:00Z'),
      updatedAt: new Date('2026-06-30T01:00:00Z'),
    };
    const prisma = {
      domain: {
        findFirst: jest.fn().mockResolvedValue(domain),
        update: jest.fn(),
      },
      subscription: {
        findUnique: jest.fn().mockResolvedValue({ customDomain: 'paidshop.com' }),
      },
    };
    const adapters = {
      OPENPROVIDER: {
        renew: jest.fn(),
      },
    };

    const result = await completePaidDomainRenewal({
      prisma,
      adapters,
      entity: {
        id: 'txn_renew_123',
        currency_code: 'INR',
        custom_data: {
          kind: 'domain_renewal',
          businessId: 'biz_1',
          domainId: 'dom_renew_done',
          domainName: 'paidshop.com',
          years: 1,
          checkoutTotalMinor: 129900,
          currency: 'INR',
        },
      },
    });

    expect(result).toEqual(expect.objectContaining({ handled: true, idempotent: true }));
    expect(adapters.OPENPROVIDER.renew).not.toHaveBeenCalled();
    expect(prisma.domain.update).not.toHaveBeenCalled();
  });
});
