const { z } = require('zod');

// Doctor v2 — POST /api/specialties + PUT /api/specialties/:id
const specialtyFieldsSchema = z.object({
  name: z.string().trim().min(1, 'Specialty name is required').max(120, 'Name must be 120 characters or less'),
  description: z.string().max(1000, 'Description is too long').nullish(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
  isActive: z.coerce.boolean().optional(),
});

const createSpecialtySchema = specialtyFieldsSchema;
const updateSpecialtySchema = specialtyFieldsSchema.partial();

module.exports = { createSpecialtySchema, updateSpecialtySchema };
