const { z } = require('zod');

// POST /api/services and PUT /api/services/:id
// create requires all of name/duration. update allows partials.
const serviceFieldsSchema = z.object({
  name: z.string().trim().min(1, 'Service name is required').max(120, 'Service name must be 120 characters or less'),
  description: z.string().max(2000, 'Description is too long').nullish(),
  duration: z.coerce
    .number({ invalid_type_error: 'Duration must be a number' })
    .int('Duration must be a whole number of minutes')
    .min(15, 'Duration must be at least 15 minutes')
    .max(480, 'Duration cannot exceed 8 hours (480 minutes)'),
  price: z.coerce
    .number({ invalid_type_error: 'Price must be a number' })
    .min(0, 'Price must be zero or more')
    .optional()
    .nullable(),
  imageUrl: z.string().max(2_500_000, 'Service image too large (max ~2MB)').nullish(),
  features: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .nullable(),
  highlighted: z.boolean().optional(),
  // Doctor v2 — collect the consult fee online at booking (Razorpay).
  requiresPrepayment: z.coerce.boolean().optional(),
  // Virtual / online consultation. virtualMeetingUrl must be a
  // http(s) URL when present so we don't email customers garbage
  // links. Provider-agnostic: any meeting URL the admin pastes works.
  isVirtual: z.coerce.boolean().optional(),
  virtualMeetingUrl: z
    .string()
    .trim()
    .max(2000, 'Meeting URL is too long')
    .refine((v) => v === '' || /^https?:\/\//i.test(v), { message: 'Meeting URL must start with http:// or https://' })
    .transform((v) => v || null)
    .optional()
    .nullable(),
});

const createServiceSchema = serviceFieldsSchema;
const updateServiceSchema = serviceFieldsSchema.partial();

module.exports = { createServiceSchema, updateServiceSchema };
