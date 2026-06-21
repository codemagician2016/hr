// Sprint 3.3 — Pages CMS v2. Validates the new placement + iconKey
// fields, block-page template content shape, and site-nav tree
// (drag-to-nest navbar). Pure-function + mocked-prisma units.

jest.mock('../src/core/lib/prisma', () => ({
  business: { findUnique: jest.fn(), update: jest.fn() },
  businessPage: { findMany: jest.fn(), count: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
}));

const prisma = require('../src/core/lib/prisma');
const tpl = require('../src/core/lib/pageTemplates');
const ctrl = require('../src/web/controllers/page.controller');

function mockReq({ params = {}, body = {}, user } = {}) {
  return { params, body, user };
}
function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

describe('PLACEMENTS + validatePlacement', () => {
  test('exposes the four placement values', () => {
    expect(tpl.PLACEMENTS).toEqual(['TOP', 'DROPDOWN', 'FOOTER', 'HIDDEN']);
  });
  test('accepts the four valid placements', () => {
    for (const p of tpl.PLACEMENTS) expect(tpl.validatePlacement(p)).toBe(true);
  });
  test('treats null/undefined as a no-op (no change)', () => {
    expect(tpl.validatePlacement(undefined)).toBe(true);
    expect(tpl.validatePlacement(null)).toBe(true);
  });
  test('rejects unknown values', () => {
    expect(tpl.validatePlacement('BANNER')).toBe(false);
    expect(tpl.validatePlacement('top')).toBe(false); // case-sensitive
  });
});

describe('page layout presets', () => {
  test('exposes production layout presets', () => {
    expect(tpl.PAGE_LAYOUT_PRESETS).toEqual(expect.arrayContaining([
      'service-premium',
      'editorial',
      'visual-story',
      'resource-hub',
      'document',
    ]));
  });

  test('validates block-page layout metadata when provided', () => {
    expect(tpl.validateContent('block-page', {
      layout: { preset: 'service-premium' },
      blocks: [{ id: 'h', type: 'header', enabled: true, props: { title: 'A' } }],
    }).ok).toBe(true);

    const bad = tpl.validateContent('block-page', {
      layout: { preset: 'tiny-purple-card' },
      blocks: [{ id: 'h', type: 'header', enabled: true, props: { title: 'A' } }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toMatch(/layout\.preset/);
  });
});

describe('block-page template', () => {
  test('is registered with isBlocks flag and broad parentNav set', () => {
    const t = tpl.getTemplate('block-page');
    expect(t).toBeTruthy();
    expect(t.isBlocks).toBe(true);
    expect(t.parentNavs).toEqual(expect.arrayContaining(['services', 'about', 'info']));
  });

  test('allows safe custom parent nav keys for vertical dropdowns', () => {
    expect(tpl.validateCustomParentNav('startup')).toBe(true);
    expect(tpl.validateCustomParentNav('goods-service-tax')).toBe(true);
    expect(tpl.validateCustomParentNav('MCA')).toBe(false);
    expect(tpl.validateCustomParentNav('bad nav')).toBe(false);
  });
});

describe('pages controller parent nav handling', () => {
  beforeEach(() => {
    prisma.businessPage.findMany.mockReset();
    prisma.businessPage.count.mockReset();
    prisma.businessPage.create.mockReset();
  });

  test('listPages returns actual tenant parent nav keys as choices', async () => {
    prisma.businessPage.findMany.mockResolvedValue([
      { id: 'p1', parentNav: 'startup', slug: 'partnership' },
      { id: 'p2', parentNav: 'services', slug: 'gst-registration' },
    ]);
    const res = mockRes();
    await ctrl.listPages(mockReq({ user: { businessId: 'biz1' } }), res);
    expect(res.body.parentNavs).toEqual(expect.arrayContaining(['startup', 'services', 'info']));
  });

  test('createPage accepts custom parentNav for block-page', async () => {
    prisma.businessPage.count.mockResolvedValue(0);
    prisma.businessPage.create.mockImplementation(async ({ data }) => ({ id: 'p1', ...data }));
    const res = mockRes();
    await ctrl.createPage(mockReq({
      user: { businessId: 'biz1' },
      body: {
        parentNav: 'startup',
        slug: 'partnership',
        title: 'Partnership',
        templateKey: 'block-page',
        content: {
          layout: { preset: 'visual-story' },
          blocks: [{ id: 'h', type: 'header', enabled: true, props: { title: 'Partnership' } }],
        },
        placement: 'DROPDOWN',
      },
    }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.page.parentNav).toBe('startup');
    expect(res.body.page.content.layout.preset).toBe('visual-story');
  });
});

describe('validateBlockPageContent', () => {
  test('rejects non-array blocks', () => {
    const r = tpl.validateContent('block-page', { blocks: 'oops' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/blocks must be an array/);
  });
  test('rejects empty object', () => {
    const r = tpl.validateContent('block-page', {});
    expect(r.ok).toBe(false);
  });
  test('rejects unknown block type', () => {
    const r = tpl.validateContent('block-page', {
      blocks: [{ id: 'x', type: 'video', enabled: true, props: {} }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/type must be one of/);
  });
  test('accepts premium media, link, FAQ, and process blocks', () => {
    const r = tpl.validateContent('block-page', {
      layout: { preset: 'resource-hub' },
      blocks: [
        { id: 'h1', type: 'header', enabled: true, props: { eyebrow: 'Guide', title: 'Partnership', primaryCtaText: 'Request consultation', primaryCtaLink: '/pages/info/contact' } },
        { id: 's1', type: 'steps', enabled: true, props: { heading: 'How it works', items: [{ title: 'Review', desc: 'Confirm scope.' }] } },
        { id: 'g1', type: 'gallery', enabled: true, props: { style: 'mosaic', items: [{ imageUrl: '/uploads/doc.jpg', title: 'Checklist', caption: 'Documents' }] } },
        { id: 'l1', type: 'linklist', enabled: true, props: { heading: 'Useful links', links: [{ label: 'Contact', href: '/pages/info/contact', desc: 'Send a brief.' }] } },
        { id: 'q1', type: 'faq', enabled: true, props: { heading: 'Questions', items: [{ q: 'Can this be done online?', a: 'Yes.' }] } },
      ],
    });
    expect(r.ok).toBe(true);
  });
  test('rejects duplicate block ids', () => {
    const r = tpl.validateContent('block-page', {
      blocks: [
        { id: 'h', type: 'header', enabled: true, props: { title: 'A' } },
        { id: 'h', type: 'cta',    enabled: true, props: { heading: 'B' } },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => /duplicated/i.test(e))).toBeTruthy();
  });
  test('header requires title', () => {
    const r = tpl.validateContent('block-page', {
      blocks: [{ id: 'h', type: 'header', enabled: true, props: {} }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/title/);
  });
  test('cta validates style + background enums', () => {
    const r = tpl.validateContent('block-page', {
      blocks: [{ id: 'c', type: 'cta', enabled: true, props: { heading: 'X', style: 'fancy' } }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/style/);
  });
  test('features.columns must be 2/3/4', () => {
    const r = tpl.validateContent('block-page', {
      blocks: [{ id: 'f', type: 'features', enabled: true, props: { columns: 5, items: [] } }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/columns/);
  });
  test('accepts a complete valid page', () => {
    const r = tpl.validateContent('block-page', {
      blocks: [
        { id: 'h1', type: 'header', enabled: true, props: { title: 'Couples Therapy' } },
        { id: 'r1', type: 'richtext', enabled: true, props: { body: 'A long-form description.' } },
        { id: 'f1', type: 'features', enabled: true, props: { columns: 3, items: [{ title: 'Evidence-based', desc: 'Gottman + EFT' }] } },
        { id: 'c1', type: 'cta', enabled: true, props: { heading: 'Start a conversation', buttonText: 'Book', buttonLink: '/book', style: 'primary' } },
      ],
    });
    expect(r.ok).toBe(true);
  });
  test('caps blocks at 50', () => {
    const blocks = Array.from({ length: 51 }, (_, i) => ({ id: `b${i}`, type: 'header', enabled: true, props: { title: 'x' } }));
    const r = tpl.validateContent('block-page', { blocks });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/at most 50/);
  });
});

describe('validateSiteNavTree', () => {
  const v = ctrl.validateSiteNavTree;
  test('null tree clears the override', () => {
    expect(v(null)).toEqual({ ok: true });
  });
  test('rejects non-array', () => {
    expect(v({}).ok).toBe(false);
  });
  test('rejects unknown system key', () => {
    const r = v([{ kind: 'system', key: 'admin' }]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/admin/);
  });
  test('accepts valid system + custom mix', () => {
    const r = v([
      { kind: 'system', key: 'home' },
      { kind: 'system', key: 'services', children: [{ kind: 'custom', pageId: 'p1' }] },
      { kind: 'custom', pageId: 'p2' },
    ]);
    expect(r.ok).toBe(true);
  });
  test('rejects nesting deeper than 1 level', () => {
    const r = v([
      { kind: 'system', key: 'services', children: [{ kind: 'custom', pageId: 'p1', children: [{ kind: 'custom', pageId: 'p2' }] }] },
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/deeper than 1/);
  });
  test('rejects a child that is not custom', () => {
    const r = v([{ kind: 'system', key: 'services', children: [{ kind: 'system', key: 'home' }] }]);
    expect(r.ok).toBe(false);
  });
  test('rejects duplicate top-level entries', () => {
    const r = v([{ kind: 'system', key: 'home' }, { kind: 'system', key: 'home' }]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/duplicate/i);
  });
  test('caps top-level at 30', () => {
    const tree = Array.from({ length: 31 }, (_, i) => ({ kind: 'custom', pageId: `p${i}` }));
    const r = v(tree);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/30/);
  });
});

describe('getSiteNav controller', () => {
  beforeEach(() => { prisma.business.findUnique.mockReset(); });
  test('returns null when not set', async () => {
    prisma.business.findUnique.mockResolvedValue({ siteNav: null });
    const req = mockReq({ user: { businessId: 'biz1' } });
    const res = mockRes();
    await ctrl.getSiteNav(req, res);
    expect(res.body).toEqual({ siteNav: null });
  });
  test('returns the saved tree', async () => {
    const tree = [{ kind: 'system', key: 'home' }];
    prisma.business.findUnique.mockResolvedValue({ siteNav: tree });
    const req = mockReq({ user: { businessId: 'biz1' } });
    const res = mockRes();
    await ctrl.getSiteNav(req, res);
    expect(res.body).toEqual({ siteNav: tree });
  });
  // Note: the no-business case is gated by the route-layer
  // requireBusiness middleware (Cleanup #7). Tests for that live in
  // test/tenantGuard.test.js — controllers can assume req.user.businessId
  // is set by the time they're called.
});

describe('getPublicPages controller', () => {
  beforeEach(() => {
    prisma.business.findUnique.mockReset();
    prisma.businessPage.findMany.mockReset();
  });

  test('falls back from semantic group URL to taxfixyGroupKey when parentNav misses', async () => {
    prisma.business.findUnique.mockResolvedValue({ id: 'biz1', isActive: true });
    prisma.businessPage.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'p1',
          parentNav: 'services',
          slug: 'partnership',
          title: 'Partnership',
          templateKey: 'block-page',
          content: { taxfixyGroupKey: 'startup', blocks: [{ id: 'h', type: 'header', props: { title: 'Partnership' } }] },
          placement: 'DROPDOWN',
          sortOrder: 1,
        },
      ]);
    const req = mockReq({ params: { slug: 'taxfixy' } });
    req.query = { parentNav: 'startup', pageSlug: 'partnership' };
    const res = mockRes();
    await ctrl.getPublicPages(req, res);
    expect(res.body.pages).toHaveLength(1);
    expect(res.body.pages[0].parentNav).toBe('services');
    expect(res.body.pages[0].content.taxfixyGroupKey).toBe('startup');
  });
});

describe('updateSiteNav controller', () => {
  beforeEach(() => {
    prisma.business.update.mockReset();
    prisma.businessPage.findMany.mockReset();
  });
  test('rejects bad shape', async () => {
    const req = mockReq({ user: { businessId: 'biz1' }, body: { siteNav: 'oops' } });
    const res = mockRes();
    await ctrl.updateSiteNav(req, res);
    expect(res.statusCode).toBe(400);
  });
  test('persists null (clears override) without touching pages', async () => {
    prisma.business.update.mockResolvedValue({});
    const req = mockReq({ user: { businessId: 'biz1' }, body: { siteNav: null } });
    const res = mockRes();
    await ctrl.updateSiteNav(req, res);
    expect(res.body).toEqual({ siteNav: null });
    expect(prisma.business.update).toHaveBeenCalledWith({
      where: { id: 'biz1' },
      data: { siteNav: null },
    });
    expect(prisma.businessPage.findMany).not.toHaveBeenCalled();
  });
  test('blocks references to other tenants pages', async () => {
    prisma.businessPage.findMany.mockResolvedValue([]); // none owned
    const req = mockReq({
      user: { businessId: 'biz1' },
      body: { siteNav: [{ kind: 'custom', pageId: 'foreign-page' }] },
    });
    const res = mockRes();
    await ctrl.updateSiteNav(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/foreign-page/);
    expect(prisma.business.update).not.toHaveBeenCalled();
  });
  test('persists when all custom pages are owned', async () => {
    prisma.businessPage.findMany.mockResolvedValue([{ id: 'mine' }]);
    prisma.business.update.mockResolvedValue({});
    const tree = [{ kind: 'custom', pageId: 'mine' }];
    const req = mockReq({ user: { businessId: 'biz1' }, body: { siteNav: tree } });
    const res = mockRes();
    await ctrl.updateSiteNav(req, res);
    expect(res.body).toEqual({ siteNav: tree });
    expect(prisma.business.update).toHaveBeenCalled();
  });
});

describe('PRESETS registry', () => {
  test('exposes a non-empty list', () => {
    expect(tpl.PRESETS.length).toBeGreaterThan(0);
  });
  test('every preset has the required fields', () => {
    for (const p of tpl.PRESETS) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.title).toBe('string');
      expect(typeof p.slug).toBe('string');
      expect(typeof p.description).toBe('string');
      expect(typeof p.defaultPlacement).toBe('string');
      expect(['TOP', 'DROPDOWN', 'FOOTER', 'HIDDEN']).toContain(p.defaultPlacement);
      expect(typeof p.defaultParentNav).toBe('string');
      expect(typeof p.blocks).toBe('function');
    }
  });
  test('all preset slugs are unique', () => {
    const slugs = tpl.PRESETS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
  test('every preset produces valid block-page content', () => {
    for (const p of tpl.PRESETS) {
      const r = tpl.validateContent('block-page', { blocks: tpl.clonePresetBlocks(p.id) });
      expect(r).toEqual({ ok: true });
    }
  });
  test('clonePresetBlocks generates fresh ids on each call', () => {
    const first = tpl.clonePresetBlocks('faq');
    const second = tpl.clonePresetBlocks('faq');
    expect(first[0].id).not.toBe(second[0].id);
  });
  test('listPresetsForVertical filters by vertical', () => {
    const staticOnly = tpl.listPresetsForVertical('STATIC');
    const appointmentOnly = tpl.listPresetsForVertical('APPOINTMENT');
    // Universal presets show in both; appointment-only ones drop out of STATIC.
    expect(appointmentOnly.length).toBeGreaterThanOrEqual(staticOnly.length);
    for (const p of staticOnly) {
      expect(!p.vertical || p.vertical.includes('STATIC')).toBe(true);
    }
  });
  test('getPreset returns null for unknown id', () => {
    expect(tpl.getPreset('does-not-exist')).toBeNull();
  });
});

describe('listPagePresets controller', () => {
  beforeEach(() => {
    prisma.business.findUnique.mockReset();
    prisma.businessPage.findMany.mockReset();
  });
  test('marks already-added presets', async () => {
    prisma.business.findUnique.mockResolvedValue({ vertical: 'APPOINTMENT' });
    prisma.businessPage.findMany.mockResolvedValue([
      { id: 'page1', slug: 'faq', parentNav: 'about', title: 'FAQ' },
    ]);
    const req = mockReq({ user: { businessId: 'biz1' } });
    const res = mockRes();
    await ctrl.listPagePresets(req, res);
    const faq = res.body.presets.find((p) => p.id === 'faq');
    expect(faq.alreadyAdded).toBe(true);
    expect(faq.existingPageId).toBe('page1');
    const privacy = res.body.presets.find((p) => p.id === 'privacy');
    expect(privacy.alreadyAdded).toBe(false);
  });
});

describe('addPagePreset controller', () => {
  beforeEach(() => {
    prisma.businessPage.count.mockReset();
    prisma.businessPage.findFirst.mockReset();
    prisma.businessPage.create.mockReset();
  });
  test('400 when presetId is missing', async () => {
    const req = mockReq({ user: { businessId: 'biz1' }, body: {} });
    const res = mockRes();
    await ctrl.addPagePreset(req, res);
    expect(res.statusCode).toBe(400);
  });
  test('404 when presetId is unknown', async () => {
    const req = mockReq({ user: { businessId: 'biz1' }, body: { presetId: 'mystery' } });
    const res = mockRes();
    await ctrl.addPagePreset(req, res);
    expect(res.statusCode).toBe(404);
  });
  test('409 when page cap reached', async () => {
    prisma.businessPage.count.mockResolvedValue(150);
    const req = mockReq({ user: { businessId: 'biz1' }, body: { presetId: 'faq' } });
    const res = mockRes();
    await ctrl.addPagePreset(req, res);
    expect(res.statusCode).toBe(409);
  });
  test('creates a new draft page from preset', async () => {
    prisma.businessPage.count.mockResolvedValue(2);
    prisma.businessPage.findFirst.mockResolvedValue(null); // slug free
    prisma.businessPage.create.mockResolvedValue({ id: 'new-page', slug: 'faq', title: 'FAQ' });
    const req = mockReq({ user: { businessId: 'biz1' }, body: { presetId: 'faq' } });
    const res = mockRes();
    await ctrl.addPagePreset(req, res);
    expect(res.statusCode).toBe(201);
    expect(prisma.businessPage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        businessId: 'biz1',
        slug: 'faq',
        title: 'FAQ',
        templateKey: 'block-page',
        isPublished: false,
      }),
    }));
  });
  test('auto-suffixes slug when one already exists', async () => {
    prisma.businessPage.count.mockResolvedValue(2);
    // First lookup returns a page with the base slug; second lookup (faq-2) returns null.
    prisma.businessPage.findFirst
      .mockResolvedValueOnce({ id: 'existing' })  // slug 'faq' taken
      .mockResolvedValueOnce(null);                // slug 'faq-2' free
    prisma.businessPage.create.mockResolvedValue({ id: 'p2', slug: 'faq-2' });
    const req = mockReq({ user: { businessId: 'biz1' }, body: { presetId: 'faq' } });
    const res = mockRes();
    await ctrl.addPagePreset(req, res);
    expect(res.statusCode).toBe(201);
    expect(prisma.businessPage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ slug: 'faq-2' }),
    }));
  });
});

describe('getPublicSiteNav controller', () => {
  beforeEach(() => { prisma.business.findUnique.mockReset(); });
  test('404 when business is missing or inactive', async () => {
    prisma.business.findUnique.mockResolvedValue(null);
    const req = mockReq({ params: { slug: 'unknown' } });
    const res = mockRes();
    await ctrl.getPublicSiteNav(req, res);
    expect(res.statusCode).toBe(404);
  });
  test('returns null when not set', async () => {
    prisma.business.findUnique.mockResolvedValue({ id: 'b', isActive: true, siteNav: null });
    const req = mockReq({ params: { slug: 'acme' } });
    const res = mockRes();
    await ctrl.getPublicSiteNav(req, res);
    expect(res.body).toEqual({ siteNav: null });
  });
});
