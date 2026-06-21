const { z } = require('zod');

// Doctor v2 — reviews
const submitReviewSchema = z.object({
  appointmentId: z.string().min(1, 'appointmentId is required'),
  rating: z.coerce.number().int().min(1, 'Rating must be 1–5').max(5, 'Rating must be 1–5'),
  body: z.string().max(2000, 'Review is too long').nullish(),
});

const moderateReviewSchema = z.object({
  status: z.enum(['PUBLISHED', 'HIDDEN', 'PENDING']),
});

module.exports = { submitReviewSchema, moderateReviewSchema };
