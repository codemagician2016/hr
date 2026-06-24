// White-label Branding controller — unit tests (mocked prisma/s3/audit).
//
// Asserts the core white-label contract:
//   • saving a brand (logo + colour + name) PERSISTS to TenantBrand AND mirrors
//     logo→BusinessContent and primary→Subscription.themeColors (so the existing
//     readers + the theme engine pick it up),
//   • GET returns the resolved brand (TenantBrand merged with the BusinessContent
//     logo/favicon fallback + the legal business name),
//   • an invalid hex colour is rejected (never silently persisted),
//   • the asset uploader returns 501 (inline-fallback) when S3 isn't configured.

jest.mock('../src/core/lib/prisma', () => ({
  business: { findUnique: jest.fn() },
  businessContent: { findUnique: jest.fn(), upsert: jest.fn() },
  subscription: { update: jest.fn() },
  tenantBrand: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
}));
jest.mock('../src/core/lib/s3', () => ({
  isConfigured: jest.fn(() => false),
  uploadDataUrl: jest.fn(),
}));
jest.mock('../src/core/lib/audit', () => ({ writeAudit: jest.fn().mockResolvedValue(undefined) }));

const prisma = require('../src/core/lib/prisma');
const s3 = require('../src/core/lib/s3');
const c = require('../src/hr/controllers/branding.controller');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  return res;
}
const reqFor = (body = {}) => ({ user: { id: 'u1', businessId: 'biz-1' }, body });

describe('branding controller — validators', () => {
  const { normHex, normUrl, normStr } = c._private;
  test('normHex accepts valid hex (upcased), rejects junk, clears empty', () => {
    expect(normHex('#4f46e5')).toBe('#4F46E5');
    expect(normHex('#abc')).toBe('#ABC');
    expect(normHex('')).toBeNull();
    expect(normHex('not-a-color')).toBeUndefined(); // invalid → reject
    expect(normHex('4F46E5')).toBeUndefined(); // missing #
  });
  test('normUrl accepts http(s)/relative/data-image, rejects javascript:', () => {
    expect(normUrl('https://cdn.example.com/logo.png')).toBe('https://cdn.example.com/logo.png');
    expect(normUrl('/uploads/logo.png')).toBe('/uploads/logo.png');
    expect(normUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(normUrl('')).toBeNull();
    expect(normUrl('javascript:alert(1)')).toBeUndefined();
  });
  test('normStr trims, clears empty, caps length', () => {
    expect(normStr('  Acme  ')).toBe('Acme');
    expect(normStr('')).toBeNull();
    expect(normStr('x'.repeat(500), 10)).toHaveLength(10);
  });
});

describe('branding controller — GET /api/hr/branding', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns TenantBrand merged with content logo + business name fallback', async () => {
    prisma.business.findUnique.mockResolvedValue({ name: 'Acme Corp' });
    prisma.tenantBrand.findFirst.mockResolvedValue({
      logoUrl: null, faviconUrl: null, primaryColor: '#112233',
      name: null, supportEmail: 'hr@acme.com',
    });
    prisma.businessContent.findUnique.mockResolvedValue({ logoUrl: 'https://cdn/x.png', faviconUrl: null });

    const res = mockRes();
    await c.getBranding(reqFor(), res);

    expect(res.statusCode).toBe(200);
    // logo falls back to BusinessContent; name falls back to the business name.
    expect(res.body.brand.logoUrl).toBe('https://cdn/x.png');
    expect(res.body.brand.primaryColor).toBe('#112233');
    expect(res.body.brand.name).toBe('Acme Corp');
    expect(res.body.brand.supportEmail).toBe('hr@acme.com');
    expect(res.body.businessName).toBe('Acme Corp');
  });
});

describe('branding controller — PUT /api/hr/branding', () => {
  beforeEach(() => jest.clearAllMocks());

  test('persists to TenantBrand AND mirrors logo→content + primary→subscription', async () => {
    // No existing brand → create path.
    prisma.tenantBrand.findFirst.mockResolvedValue(null);
    prisma.business.findUnique.mockResolvedValue({
      name: 'Acme Corp',
      subscription: { id: 'sub-1', themeColors: null },
    });
    prisma.tenantBrand.create.mockImplementation(({ data }) => Promise.resolve({ id: 'brand-1', ...data }));
    prisma.businessContent.upsert.mockResolvedValue({});
    prisma.subscription.update.mockResolvedValue({});
    prisma.businessContent.findUnique.mockResolvedValue({ logoUrl: 'https://cdn/logo.png', faviconUrl: null });

    const res = mockRes();
    await c.updateBranding(reqFor({
      logoUrl: 'https://cdn/logo.png',
      primaryColor: '#4f46e5',
      name: 'Acme Corp',
    }), res);

    expect(res.statusCode).toBe(200);

    // 1) TenantBrand created tenant-wide (entityId null, default code) with the fields.
    expect(prisma.tenantBrand.create).toHaveBeenCalledTimes(1);
    const created = prisma.tenantBrand.create.mock.calls[0][0].data;
    expect(created.businessId).toBe('biz-1');
    expect(created.entityId).toBeNull();
    expect(created.code).toBe('default');
    expect(created.logoUrl).toBe('https://cdn/logo.png');
    expect(created.primaryColor).toBe('#4F46E5'); // upcased
    expect(created.name).toBe('Acme Corp');

    // 2) logo mirrored → BusinessContent (so storefront/letters/resolve readers pick it up).
    expect(prisma.businessContent.upsert).toHaveBeenCalledTimes(1);
    const mirror = prisma.businessContent.upsert.mock.calls[0][0];
    expect(mirror.where).toEqual({ businessId: 'biz-1' });
    expect(mirror.update.logoUrl).toBe('https://cdn/logo.png');

    // 3) primary mirrored → Subscription.themeColors (so the theme engine re-themes).
    expect(prisma.subscription.update).toHaveBeenCalledTimes(1);
    const subUpd = prisma.subscription.update.mock.calls[0][0];
    expect(subUpd.where).toEqual({ id: 'sub-1' });
    expect(JSON.parse(subUpd.data.themeColors).primary).toBe('#4F46E5');
  });

  test('rejects an invalid hex colour (never persists)', async () => {
    const res = mockRes();
    await c.updateBranding(reqFor({ primaryColor: 'red' }), res);
    expect(res.statusCode).toBe(400);
    expect(prisma.tenantBrand.create).not.toHaveBeenCalled();
    expect(prisma.tenantBrand.update).not.toHaveBeenCalled();
  });

  test('updates the existing tenant-wide brand when one is present', async () => {
    prisma.tenantBrand.findFirst.mockResolvedValue({ id: 'brand-9' });
    prisma.business.findUnique.mockResolvedValue({ name: 'Acme', subscription: { id: 'sub-1', themeColors: '{"primary":"#000000"}' } });
    prisma.tenantBrand.update.mockResolvedValue({ id: 'brand-9', secondaryColor: '#64748B' });
    prisma.subscription.update.mockResolvedValue({});
    prisma.businessContent.findUnique.mockResolvedValue(null);

    const res = mockRes();
    await c.updateBranding(reqFor({ secondaryColor: '#64748b' }), res);

    expect(res.statusCode).toBe(200);
    expect(prisma.tenantBrand.update).toHaveBeenCalledTimes(1);
    expect(prisma.tenantBrand.update.mock.calls[0][0].where).toEqual({ id: 'brand-9' });
    expect(prisma.tenantBrand.create).not.toHaveBeenCalled();
    // No logo/favicon in the body → no content mirror.
    expect(prisma.businessContent.upsert).not.toHaveBeenCalled();
  });
});

describe('branding controller — POST /api/hr/branding/asset', () => {
  beforeEach(() => jest.clearAllMocks());

  test('501 when S3 is not configured (client inlines the data URL)', async () => {
    s3.isConfigured.mockReturnValue(false);
    const res = mockRes();
    await c.uploadAsset(reqFor({ dataUrl: 'data:image/png;base64,AAAA', kind: 'logo' }), res);
    expect(res.statusCode).toBe(501);
  });

  test('uploads and returns the hosted URL when S3 is configured', async () => {
    s3.isConfigured.mockReturnValue(true);
    s3.uploadDataUrl.mockResolvedValue({ url: 'https://cdn/brand-logo.png' });
    const res = mockRes();
    await c.uploadAsset(reqFor({ dataUrl: 'data:image/png;base64,AAAA', kind: 'logo' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.url).toBe('https://cdn/brand-logo.png');
    expect(s3.uploadDataUrl).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz-1', scope: 'brand-logo' }));
  });

  test('rejects a non-image dataUrl', async () => {
    const res = mockRes();
    await c.uploadAsset(reqFor({ dataUrl: 'data:text/html;base64,AAAA' }), res);
    expect(res.statusCode).toBe(400);
  });
});
