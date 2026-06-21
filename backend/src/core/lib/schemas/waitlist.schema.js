// Schemas for the customer-waitlist endpoints.

const { z } = require('zod');
const { emailSchema, phoneSchema, dateStringSchema, timeStringSchema } = require('./common');

// Customer-facing join form. Phone optional; logged-in customer joins
// won't supply name/email (the controller fills them from req.customer).
const joinWaitlistSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120).optional(),
  email: emailSchema.optional(),
  phone: phoneSchema.optional().nullable(),
  serviceId: z.string().min(1).optional().nullable(),
  staffId: z.string().min(1).optional().nullable(),
  preferredDate: dateStringSchema,
  preferredStartTime: timeStringSchema.optional().nullable(),
  preferredEndTime: timeStringSchema.optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
}).superRefine((val, ctx) => {
  if (val.preferredStartTime && val.preferredEndTime) {
    const [aH, aM] = val.preferredStartTime.split(':').map(Number);
    const [bH, bM] = val.preferredEndTime.split(':').map(Number);
    if (aH * 60 + aM > bH * 60 + bM) {
      ctx.addIssue({ code: 'custom', path: ['preferredEndTime'], message: 'preferredEndTime must be after preferredStartTime' });
    }
  }
});

// Admin status update — used to mark CONVERTED / DISMISSED / EXPIRED.
const updateWaitlistStatusSchema = z.object({
  status: z.enum(['PENDING', 'NOTIFIED', 'CONVERTED', 'DISMISSED', 'EXPIRED']),
});

module.exports = { joinWaitlistSchema, updateWaitlistStatusSchema };
