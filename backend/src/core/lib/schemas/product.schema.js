// Zod schemas for Product + ProductCategory CRUD endpoints.
// Used by validateBody middleware on /api/business/products + /categories.

const { z } = require('zod');

// Slug: lowercase letters/numbers/dashes, 1-80 chars.
const slugSchema = z
  .string()
  .trim()
  .min(1, 'Slug is required')
  .max(80, 'Slug must be 80 characters or less')
  .regex(
    /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/,
    'Slug must be lowercase letters, numbers, single dashes',
  );

// Image URL: http(s), relative path, or the admin uploader's inline data URL
// fallback when S3/image hosting is not configured.
const imageUrlSchema = z
  .string()
  .trim()
  .max(2_500_000, 'Image too large (max ~2MB)')
  .refine(
    (v) => v === ''
      || /^https?:\/\//.test(v)
      || v.startsWith('/')
      || /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,/i.test(v),
    'Image URL must be http(s), start with /, or be an image data URL',
  );

const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema,
  description: z.string().max(500).optional().nullable(),
  imageUrl: imageUrlSchema.optional().nullable(),
  sortOrder: z.number().int().optional(),
  isPublished: z.boolean().optional(),
  // One-level nesting: top-level category has parentId === null,
  // sub-category points at its parent. Schema enforces only one level
  // (controller rejects parentId of a category that already has a parent).
  parentId: z.string().uuid().optional().nullable(),
});

const updateCategorySchema = createCategorySchema.partial();

const productBaseShape = z.object({
  name: z.string().trim().min(1).max(240),
  slug: slugSchema,
  brand: z.string().trim().max(120).optional().nullable(),
  brandId: z.string().uuid().optional().nullable(),
  categoryId: z.string().uuid().optional().nullable(),
  description: z.string().max(10000).optional().nullable(),
  shortDescription: z.string().max(500).optional().nullable(),
  sku: z.string().max(120).optional().nullable(),
  barcode: z.string().trim().max(180).optional().nullable(),
  qrCode: z.string().trim().max(2048).optional().nullable(),
  priceMinor: z.number().int().min(0).max(99_999_999_99), // < ~₹100 crore — sanity cap
  comparePriceMinor: z.number().int().min(0).max(99_999_999_99).optional().nullable(),
  currency: z.string().trim().toUpperCase().length(3).optional(),
  stockQty: z.number().int().min(0).optional().nullable(),
  weightGrams: z.number().int().min(0).max(1_000_000).optional().nullable(), // 1000kg max
  weightDisplay: z.string().max(80).optional().nullable(),
  imageUrls: z.array(imageUrlSchema).max(20).optional(),
  isPublished: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  metaTitle: z.string().max(200).optional().nullable(),
  metaDescription: z.string().max(500).optional().nullable(),
  // Storefront discount badge: '24% OFF' (PERCENTAGE) vs '₹23 OFF' (FLAT).
  // Without this field in the schema, Zod silently strips it from the
  // request body on create + update, so the seller's choice never reached
  // Prisma — that's why "FLAT" kept reverting to the PERCENTAGE default.
  discountDisplayMode: z.enum(['PERCENTAGE', 'FLAT']).optional(),
  // Admin ecommerce products can be created while a store/warehouse is
  // selected. The controller uses this only to create the matching zero-stock
  // InventoryStock row; it is not stored on Product.
  locationId: z.string().uuid().optional().nullable(),
});

// Create requires all required fields + cross-field comparePrice check.
const createProductSchema = productBaseShape.refine(
  (data) => data.comparePriceMinor === null
    || data.comparePriceMinor === undefined
    || data.comparePriceMinor > data.priceMinor,
  { message: 'Compare price (the strikethrough "was X" price) must be higher than current price', path: ['comparePriceMinor'] },
);

// Update is partial on the base shape (so any subset of fields can change).
// We re-apply the cross-field check on whatever happens to be set.
const updateProductSchema = productBaseShape.partial().refine(
  (data) => data.comparePriceMinor === null
    || data.comparePriceMinor === undefined
    || data.priceMinor === undefined
    || data.comparePriceMinor > data.priceMinor,
  { message: 'Compare price must be higher than current price', path: ['comparePriceMinor'] },
);

module.exports = {
  createCategorySchema,
  updateCategorySchema,
  createProductSchema,
  updateProductSchema,
};
