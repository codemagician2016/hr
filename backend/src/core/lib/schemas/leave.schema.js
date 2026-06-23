// Schema for the leave-request endpoint (Feature 6).
//
// Replaces the stale booking-era single-`date` `requestLeaveSchema` (which the
// route never imported and which did NOT match the controller's real shape).
// The live controller accepts { employeeId, leaveTypeId, startDate, endDate,
// startHalf?, endHalf?, reason? }; this validates exactly that and is wired into
// POST /api/hr/leave/requests (docs/features/06 §4.9).

const { z } = require('zod');
const { dateStringSchema } = require('./common');

const dayHalfSchema = z.enum(['FIRST_HALF', 'SECOND_HALF']);

const createLeaveRequestSchema = z
  .object({
    employeeId: z.string().min(1, 'employeeId is required'),
    leaveTypeId: z.string().min(1, 'leaveTypeId is required'),
    startDate: dateStringSchema,
    endDate: dateStringSchema,
    startHalf: dayHalfSchema.optional().nullable(),
    endHalf: dayHalfSchema.optional().nullable(),
    reason: z.string().max(1000, 'Reason must be 1000 characters or less').optional().nullable(),
    isAdvance: z.coerce.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.endDate < val.startDate) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'endDate must be on or after startDate' });
    }
  });

// Audited manual balance adjustment (POST /balances/adjust).
const adjustBalanceSchema = z.object({
  employeeId: z.string().min(1, 'employeeId is required'),
  leaveTypeId: z.string().min(1, 'leaveTypeId is required'),
  periodCode: z.string().min(1, 'periodCode is required'),
  delta: z.coerce.number().refine((n) => n !== 0, 'delta must be non-zero'),
  reason: z.string().min(1, 'reason is required').max(1000),
});

// Year-end carry-forward run (POST /runs/carry-forward).
const carryForwardRunSchema = z.object({
  periodCode: z.string().min(1, 'periodCode is required'),
  leaveTypeId: z.string().optional().nullable(),
  dryRun: z.coerce.boolean().optional().default(true),
});

module.exports = {
  createLeaveRequestSchema,
  adjustBalanceSchema,
  carryForwardRunSchema,
  // legacy export kept so any stray importer doesn't break (deprecated)
  requestLeaveSchema: createLeaveRequestSchema,
};
