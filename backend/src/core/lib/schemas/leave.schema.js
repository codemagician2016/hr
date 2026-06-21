// Schema for the staff leave-request endpoint.

const { z } = require('zod');
const { dateStringSchema, timeStringSchema } = require('./common');

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

const requestLeaveSchema = z.object({
  date: dateStringSchema,
  startTime: timeStringSchema.optional(),
  endTime: timeStringSchema.optional(),
  isFullDay: z.coerce.boolean().optional().default(true),
  reason: z.string().max(500, 'Reason must be 500 characters or less').optional().nullable(),
}).superRefine((val, ctx) => {
  if (val.isFullDay) return;
  if (!val.startTime) {
    ctx.addIssue({ code: 'custom', path: ['startTime'], message: 'startTime required for partial day' });
    return;
  }
  if (!val.endTime) {
    ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'endTime required for partial day' });
    return;
  }
  if (toMinutes(val.startTime) >= toMinutes(val.endTime)) {
    ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'startTime must be before endTime' });
  }
});

module.exports = { requestLeaveSchema };
