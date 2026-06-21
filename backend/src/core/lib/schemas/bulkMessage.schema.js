// Schema for the admin-side bulk-message endpoint. Lets the business
// admin send a custom subject + body to every selected appointment's
// customer in one call.

const { z } = require('zod');

const bulkMessageSchema = z.object({
  ids: z.array(z.string().min(1, 'appointment id required'))
    .min(1, 'select at least one appointment')
    .max(200, 'cannot send to more than 200 at once'),
  subject: z.string().trim().min(1, 'subject is required').max(200, 'subject must be 200 characters or less'),
  body: z.string().trim().min(1, 'message body is required').max(4000, 'message must be 4000 characters or less'),
});

module.exports = { bulkMessageSchema };
