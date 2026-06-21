// Schema for the GET /api/business/reports endpoint. Validates the
// date-range query string. Used via validateQuery (not validateBody).

const { z } = require('zod');
const { dateStringSchema } = require('./common');

const reportRangeSchema = z.object({
  from: dateStringSchema,
  to: dateStringSchema,
  staffId: z.string().min(1).optional(),
});

// Same range + an optional format. Default is 'csv' so a hand-typed
// ?format=… can be omitted from the URL.
const exportRangeSchema = z.object({
  from: dateStringSchema,
  to: dateStringSchema,
  staffId: z.string().min(1).optional(),
  format: z.enum(['csv', 'ical']).optional().default('csv'),
});

module.exports = { reportRangeSchema, exportRangeSchema };
