const { z } = require('zod');
const { dateStringSchema, timeStringSchema } = require('./common');

// POST /api/booking/:slug — customer creates an appointment
// The controller still runs business-logic checks (staff availability,
// conflicts, timezone-aware past-check). This schema covers the easy
// shape-level validation so the controller can trust req.body.
const createBookingSchema = z.object({
  staffId: z.string().min(1, 'staffId is required'),
  serviceId: z.string().optional().nullable(),
  date: dateStringSchema,
  startTime: timeStringSchema,
  notes: z.string().max(500, 'Notes must be 500 characters or less').optional().nullable(),
  couponCode: z.string().max(50, 'Coupon code must be 50 characters or less').optional().nullable(),
  // Sprint 1.5b — multi-location: customer picks the branch when the
  // business has 2+ active locations. Optional (single-location
  // businesses skip the step) and validated against BusinessLocation in
  // the controller.
  locationId: z.string().min(1).optional().nullable(),
  // When the customer already has another appointment at this time with
  // a different staff, the first POST returns 409 with conflict info.
  // Re-POST with forceBook=true to acknowledge the warning and proceed.
  forceBook: z.boolean().optional(),
});

module.exports = { createBookingSchema };
