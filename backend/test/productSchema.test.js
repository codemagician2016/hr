// Tests for the Product + ProductCategory Zod schemas. Pure-function logic;
// no DB or network involved.

const {
  createCategorySchema,
  updateCategorySchema,
  createProductSchema,
  updateProductSchema,
} = require('../src/core/lib/schemas/product.schema');

describe('createCategorySchema', () => {
  test('passes with name + slug', () => {
    const r = createCategorySchema.safeParse({ name: 'Produce', slug: 'produce' });
    expect(r.success).toBe(true);
  });
  test('rejects missing name', () => {
    const r = createCategorySchema.safeParse({ slug: 'produce' });
    expect(r.success).toBe(false);
  });
  test('rejects bad slug (uppercase)', () => {
    const r = createCategorySchema.safeParse({ name: 'X', slug: 'Produce' });
    expect(r.success).toBe(false);
  });
  test('rejects bad slug (double dash)', () => {
    const r = createCategorySchema.safeParse({ name: 'X', slug: 'pro--duce' });
    expect(r.success).toBe(false);
  });
  test('accepts optional description + image', () => {
    const r = createCategorySchema.safeParse({
      name: 'Produce',
      slug: 'produce',
      description: 'Fresh vegetables and fruits',
      imageUrl: 'https://cdn.example.com/produce.jpg',
    });
    expect(r.success).toBe(true);
  });
  test('accepts uploader data URL fallback images', () => {
    const r = createCategorySchema.safeParse({
      name: 'X', slug: 'x', imageUrl: 'data:image/png;base64,aGVsbG8=',
    });
    expect(r.success).toBe(true);
  });
  test('rejects bad image URL (not http/https, /, or image data URL)', () => {
    const r = createCategorySchema.safeParse({
      name: 'X', slug: 'x', imageUrl: 'data:text/html;base64,PGgxPk5vPC9oMT4=',
    });
    expect(r.success).toBe(false);
  });
  test('accepts /uploads/...  relative URLs', () => {
    const r = createCategorySchema.safeParse({
      name: 'X', slug: 'x', imageUrl: '/uploads/cat.jpg',
    });
    expect(r.success).toBe(true);
  });
});

describe('updateCategorySchema (partial)', () => {
  test('all fields optional', () => {
    expect(updateCategorySchema.safeParse({}).success).toBe(true);
    expect(updateCategorySchema.safeParse({ name: 'New name' }).success).toBe(true);
  });
});

describe('createProductSchema', () => {
  const valid = {
    name: 'Wholewheat Bread',
    slug: 'wholewheat-bread',
    priceMinor: 5000, // ₹50
  };

  test('passes with name + slug + price', () => {
    expect(createProductSchema.safeParse(valid).success).toBe(true);
  });

  test('rejects negative price', () => {
    const r = createProductSchema.safeParse({ ...valid, priceMinor: -100 });
    expect(r.success).toBe(false);
  });

  test('rejects price over the sanity cap', () => {
    const r = createProductSchema.safeParse({ ...valid, priceMinor: 100_000_000_00 });
    expect(r.success).toBe(false);
  });

  test('rejects comparePrice <= price', () => {
    const r = createProductSchema.safeParse({ ...valid, comparePriceMinor: 5000 });
    expect(r.success).toBe(false);
    expect(r.error.issues[0].message).toMatch(/Compare price/);
  });

  test('accepts comparePrice > price', () => {
    const r = createProductSchema.safeParse({ ...valid, comparePriceMinor: 6000 });
    expect(r.success).toBe(true);
  });

  test('uppercases currency', () => {
    const r = createProductSchema.safeParse({ ...valid, currency: 'inr' });
    expect(r.success).toBe(true);
    expect(r.data.currency).toBe('INR');
  });

  test('rejects 4-letter currency', () => {
    const r = createProductSchema.safeParse({ ...valid, currency: 'INRA' });
    expect(r.success).toBe(false);
  });

  test('accepts up to 20 image URLs', () => {
    const imageUrls = Array(20).fill('https://x.com/i.jpg');
    expect(createProductSchema.safeParse({ ...valid, imageUrls }).success).toBe(true);
  });

  test('rejects 21+ image URLs', () => {
    const imageUrls = Array(21).fill('https://x.com/i.jpg');
    expect(createProductSchema.safeParse({ ...valid, imageUrls }).success).toBe(false);
  });

  test('rejects weight over 1000 kg (1M grams)', () => {
    const r = createProductSchema.safeParse({ ...valid, weightGrams: 1_000_001 });
    expect(r.success).toBe(false);
  });

  test('rejects negative stock', () => {
    const r = createProductSchema.safeParse({ ...valid, stockQty: -5 });
    expect(r.success).toBe(false);
  });

  test('null stock = unlimited (allowed)', () => {
    const r = createProductSchema.safeParse({ ...valid, stockQty: null });
    expect(r.success).toBe(true);
  });

  test('zero stock = out-of-stock (allowed)', () => {
    const r = createProductSchema.safeParse({ ...valid, stockQty: 0 });
    expect(r.success).toBe(true);
  });
});

describe('updateProductSchema (partial)', () => {
  test('all fields optional', () => {
    expect(updateProductSchema.safeParse({}).success).toBe(true);
    expect(updateProductSchema.safeParse({ priceMinor: 9900 }).success).toBe(true);
  });
});
