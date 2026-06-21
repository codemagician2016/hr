// Schemas for the enquiry / contact-form endpoints.

const { z } = require('zod');

const ENQUIRY_STATUSES = ['NEW', 'READ', 'REPLIED', 'ARCHIVED'];

const submitEnquirySchema = z.object({
  name: z.string({ required_error: 'Name is required' }).trim().min(1, 'Name is required').max(120),
  email: z.string().trim().max(200).optional().nullable().transform((v) => (v ? v : '')),
  phone: z.string().trim().max(40).optional().nullable().transform((v) => (v ? v : '')),
  subject: z.string().trim().max(200).optional().nullable().transform((v) => (v ? v : '')),
  message: z.string({ required_error: 'Message is required' }).trim().min(1, 'Message is required').max(4000),
}).superRefine((val, ctx) => {
  if (!val.email && !val.phone) {
    ctx.addIssue({
      code: 'custom',
      path: [],
      message: 'Please provide at least an email or phone so we can reply',
    });
  }
});

const updateEnquiryStatusSchema = z.object({
  status: z
    .string({ required_error: 'status must be NEW, READ, REPLIED or ARCHIVED' })
    .transform((v) => v.toUpperCase())
    .pipe(z.enum(ENQUIRY_STATUSES, { errorMap: () => ({ message: 'status must be NEW, READ, REPLIED or ARCHIVED' }) })),
});

module.exports = { submitEnquirySchema, updateEnquiryStatusSchema, ENQUIRY_STATUSES };
