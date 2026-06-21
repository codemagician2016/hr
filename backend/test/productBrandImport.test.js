const {
  normalizeBrandInput,
  resolveOrCreateProductBrand,
} = require('../src/shop/lib/productBrandImport');

describe('product bulk import brand resolution', () => {
  test('normalizes brand_slug and brand_name input', () => {
    expect(normalizeBrandInput({ brand_slug: 'Local Bakery', brand_name: 'Local Bakery' })).toEqual({
      slug: 'local-bakery',
      name: 'Local Bakery',
      countryCode: null,
    });
  });

  test('creates a missing independent product brand and caches it', async () => {
    const created = { id: 'brand-1', slug: 'local-bakery', name: 'Local Bakery' };
    const prisma = {
      productBrand: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(created),
      },
    };
    const cache = new Map();
    const summary = { brands: { created: 0 } };

    const first = await resolveOrCreateProductBrand({
      prisma,
      businessId: 'biz-1',
      input: { brand_slug: 'local-bakery', brand_name: 'Local Bakery' },
      cache,
      summary,
    });
    const second = await resolveOrCreateProductBrand({
      prisma,
      businessId: 'biz-1',
      input: { brand_slug: 'local-bakery', brand_name: 'Local Bakery' },
      cache,
      summary,
    });

    expect(first).toBe(created);
    expect(second).toBe(created);
    expect(summary.brands.created).toBe(1);
    expect(prisma.productBrand.create).toHaveBeenCalledTimes(1);
    expect(prisma.productBrand.create).toHaveBeenCalledWith({
      data: {
        businessId: 'biz-1',
        name: 'Local Bakery',
        slug: 'local-bakery',
        countryCode: null,
      },
      select: { id: true, slug: true, name: true },
    });
  });

  test('derives a readable brand name when only brand_slug is supplied', async () => {
    const prisma = {
      productBrand: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'brand-2', slug: data.slug, name: data.name })),
      },
    };

    const brand = await resolveOrCreateProductBrand({
      prisma,
      businessId: 'biz-1',
      input: { brand_slug: 'farm-fresh' },
      cache: new Map(),
      summary: { brands: { created: 0 } },
    });

    expect(brand).toEqual({ id: 'brand-2', slug: 'farm-fresh', name: 'Farm Fresh' });
  });
});
