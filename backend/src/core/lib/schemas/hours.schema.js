// Schemas for the business-hours and holiday endpoints. Both write to
// the BusinessHours / BusinessHoliday tables.

const { z } = require('zod');
const { dateStringSchema, timeStringSchema } = require('./common');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

const dayEntrySchema = z.object({
  dayOfWeek: z
    .number({ required_error: 'dayOfWeek is required', invalid_type_error: 'dayOfWeek must be 0–6' })
    .int()
    .min(0, 'dayOfWeek must be 0–6')
    .max(6, 'dayOfWeek must be 0–6'),
  openTime: timeStringSchema.optional(),
  closeTime: timeStringSchema.optional(),
  isClosed: z.coerce.boolean().optional().default(false),
}).superRefine((val, ctx) => {
  if (val.isClosed) return;
  if (!val.openTime) {
    ctx.addIssue({ code: 'custom', path: ['openTime'], message: `Invalid openTime for ${DAY_NAMES[val.dayOfWeek]}` });
    return;
  }
  if (!val.closeTime) {
    ctx.addIssue({ code: 'custom', path: ['closeTime'], message: `Invalid closeTime for ${DAY_NAMES[val.dayOfWeek]}` });
    return;
  }
  if (toMinutes(val.openTime) >= toMinutes(val.closeTime)) {
    ctx.addIssue({ code: 'custom', path: ['closeTime'], message: `Close time must be after open time for ${DAY_NAMES[val.dayOfWeek]}` });
  }
});

const setHoursSchema = z.object({
  hours: z.array(dayEntrySchema)
    .min(1, 'hours must be a non-empty array of up to 7 day entries')
    .max(7, 'hours must be a non-empty array of up to 7 day entries')
    .superRefine((arr, ctx) => {
      const seen = new Set();
      for (const h of arr) {
        if (seen.has(h.dayOfWeek)) {
          ctx.addIssue({ code: 'custom', path: [], message: `Duplicate dayOfWeek entry: ${DAY_NAMES[h.dayOfWeek]}` });
          return;
        }
        seen.add(h.dayOfWeek);
      }
    }),
});

const addHolidaySchema = z.object({
  date: dateStringSchema,
  name: z.string().trim().min(1, 'date and name are required').max(100, 'Holiday name must be 100 characters or less'),
  // Optional branch scope: null / 'GLOBAL' = all branches, a uuid = one branch.
  locationId: z.string().nullable().optional(),
});

module.exports = { setHoursSchema, addHolidaySchema };
