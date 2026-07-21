'use strict';

/**
 * validators.js — Pre-apply policy gates (Feature 6).
 *
 * PURE: no DB. House style of `lifecycle/validators.js` — each check returns a
 * structured reason code; the caller maps codes → HTTP status. The controller
 * loads the policy, balance, employee + the existing PENDING/APPROVED leave and
 * passes them in.
 *
 * Reason codes (docs/features/06 §4.6):
 *   NOTICE_TOO_SHORT, EXCEEDS_MAX_CONSECUTIVE, INSUFFICIENT_BALANCE,
 *   NEGATIVE_CAP_EXCEEDED, NOT_VESTED, GENDER_INELIGIBLE, TYPE_INELIGIBLE,
 *   REASON_REQUIRED, OVERLAPPING_LEAVE, INVALID_RANGE
 */

const { available } = require('./ledger');
// Feature 30 — comp-off FIFO expiry math (pure). Used only by the COMP_OFF gate below.
const { earliestExpiryForUnits, firstDayPastExpiry } = require('./compoff/compOffLots');

function num(v, dflt = 0) {
  const n = v == null ? dflt : Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function utcDayMs(d) {
  const x = d instanceof Date ? d : new Date(d);
  return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
}

// Categories for which a back-dated application is permitted (the rest must give
// the policy's minNoticeDays of forward notice). HR overrides bypass entirely.
const BACKDATE_OK = new Set(['SICK', 'BEREAVEMENT', 'FAMILY_VIOLENCE']);

function fail(code, message, extra = {}) {
  return { code, message, ...extra };
}

/**
 * validateRequest(input) -> { ok, errors:[{code,message,...}] }
 *
 * input = {
 *   request: { startDate, endDate, startHalf?, endHalf?, reason? },
 *   units,                          // netted working-day units (calendar.js)
 *   consecutiveDays,                // raw calendar span (calendar.js)
 *   policy,                         // LeavePolicy (resolved) or null
 *   leaveType,                      // { category, requiresReason, ... }
 *   balance,                        // LeaveBalance row (or null when no balance)
 *   employee,                       // { gender, hireDate, employmentType }
 *   overlapping,                    // [{ startDate, endDate, status }] existing
 *   asOf,                           // "now" (the apply instant)
 *   isAdvance?,                     // caller already decided this is advance leave
 *   hrOverride?,                    // HR back-date / notice override
 * }
 */
function validateRequest(input = {}) {
  const errors = [];
  const req = input.request || {};
  const policy = input.policy || {};
  const type = input.leaveType || {};
  const employee = input.employee || {};
  const asOf = input.asOf ? utcDayMs(input.asOf) : utcDayMs(new Date());
  const startMs = req.startDate ? utcDayMs(req.startDate) : null;
  const units = num(input.units);

  // 0. range sanity
  if (startMs == null || req.endDate == null || units == null || units <= 0) {
    errors.push(fail('INVALID_RANGE', 'endDate must be on or after startDate and span at least one working day'));
    return { ok: false, errors };
  }

  // 1. requiresReason
  if (type.requiresReason && !req.reason) {
    errors.push(fail('REASON_REQUIRED', 'A reason is required for this leave type'));
  }

  // 2. minNoticeDays (forward notice; back-date only for SICK/BEREAVEMENT/FV or HR override)
  const minNotice = num(policy.minNoticeDays);
  if (minNotice > 0 && !input.hrOverride) {
    const noticeDays = Math.floor((startMs - asOf) / 86400000);
    const isBackdate = startMs < asOf;
    if (isBackdate) {
      if (!BACKDATE_OK.has(type.category)) {
        errors.push(fail('NOTICE_TOO_SHORT', 'This leave type cannot be back-dated', { minNoticeDays: minNotice }));
      }
    } else if (noticeDays < minNotice) {
      errors.push(fail('NOTICE_TOO_SHORT', `Requires at least ${minNotice} day(s) notice`, { minNoticeDays: minNotice, given: noticeDays }));
    }
  }

  // 3. maxConsecutive (raw calendar span)
  const maxConsec = policy.maxConsecutive == null ? null : num(policy.maxConsecutive);
  if (maxConsec != null && maxConsec > 0) {
    const consec = num(input.consecutiveDays, units);
    if (consec > maxConsec) {
      errors.push(fail('EXCEEDS_MAX_CONSECUTIVE', `Cannot exceed ${maxConsec} consecutive day(s)`, { maxConsecutive: maxConsec, requested: consec }));
    }
  }

  // 4/5. balance + negativeCap
  if (input.balance) {
    const avail = available(input.balance, policy);
    if (units > avail) {
      if (!policy.allowNegative && !input.isAdvance) {
        errors.push(fail('INSUFFICIENT_BALANCE', 'Insufficient leave balance', { available: avail, requested: units }));
      } else if (policy.allowNegative) {
        // advance allowed only within negativeCap
        const closing = num(input.balance.closing) - num(input.balance.pendingApproval);
        const projected = closing - units; // how negative we'd go
        const cap = policy.negativeCap == null ? 0 : -Math.abs(num(policy.negativeCap));
        if (projected < cap) {
          errors.push(fail('NEGATIVE_CAP_EXCEEDED', 'Advance leave exceeds the negative-balance cap', {
            negativeCap: num(policy.negativeCap), projected: Math.round(projected * 1e4) / 1e4,
          }));
        }
      }
    }
  } else if (type.affectsLOP !== true && type.category !== 'UNPAID') {
    // A non-LWP type with no balance row at all → nothing to draw from.
    errors.push(fail('INSUFFICIENT_BALANCE', 'No leave balance exists for this type', { available: 0, requested: units }));
  }

  // 6. minTenureMonths (NZ annual 12mo / sick 6mo)
  const minTenure = num(policy.minTenureMonths);
  if (minTenure > 0 && employee.hireDate) {
    const hire = utcDayMs(employee.hireDate);
    const monthsServed = monthsBetween(hire, startMs);
    if (monthsServed < minTenure) {
      errors.push(fail('NOT_VESTED', `This leave vests after ${minTenure} month(s) of service`, { minTenureMonths: minTenure, served: monthsServed }));
    }
  }

  // 6b. probation gate (leave-audit) — orthogonal to tenure months: a confirmed
  // employee with short tenure passes; a long-probation employee is blocked.
  if (policy.blockDuringProbation === true && employee.status === 'PROBATION') {
    errors.push(fail('PROBATION_BLOCKED', 'This leave type is not available during probation'));
  }

  // 7. genderRestriction (maternity/paternity)
  if (policy.genderRestriction && employee.gender && policy.genderRestriction !== employee.gender) {
    errors.push(fail('GENDER_INELIGIBLE', 'This leave type is restricted by gender', { required: policy.genderRestriction }));
  }

  // 8. appliesToEmploymentTypes (CSV)
  if (policy.appliesToEmploymentTypes) {
    const allowed = String(policy.appliesToEmploymentTypes).split(',').map((s) => s.trim()).filter(Boolean);
    if (allowed.length && employee.employmentType && !allowed.includes(employee.employmentType)) {
      errors.push(fail('TYPE_INELIGIBLE', 'This leave type does not apply to your employment type', { allowed }));
    }
  }

  // 9. overlap with existing PENDING/APPROVED leave
  const endMs = utcDayMs(req.endDate);
  for (const o of input.overlapping || []) {
    if (!o || !o.startDate || !o.endDate) continue;
    if (o.status && !['PENDING', 'APPROVED', 'AVAILED'].includes(o.status)) continue;
    const os = utcDayMs(o.startDate);
    const oe = utcDayMs(o.endDate);
    if (startMs <= oe && endMs >= os) {
      errors.push(fail('OVERLAPPING_LEAVE', 'Overlaps an existing leave request', { from: o.startDate, to: o.endDate }));
      break;
    }
  }

  // 10. COMP_OFF expiry gate (Feature 30 §4.3 + finding #4). For a comp-off avail, the
  // credits that FIFO-cover these units must not lapse BEFORE the day they're spent —
  // you can't spend a credit you'll lose first.
  //
  // The START-only check (startMs > earliestExpiryForUnits) MISSED a multi-day span
  // whose start is on/before expiry but whose LATER days fall after a lot lapses
  // (finding #4). When the caller supplies the per-day breakdown (`compOffDays =
  // [{ date, fraction }]`), we run the precise per-day FIFO check: each charged day's
  // covering lot must still be live ON that day. We fall back to the START gate when
  // no breakdown is supplied (keeps the gate inert/back-compatible).
  if (type.category === 'COMP_OFF' && Array.isArray(input.compOffLots)) {
    if (Array.isArray(input.compOffDays) && input.compOffDays.length) {
      const badDay = firstDayPastExpiry(input.compOffLots, input.compOffDays);
      if (badDay != null) {
        const neededExpiry = earliestExpiryForUnits(input.compOffLots, units);
        errors.push(fail('COMP_OFF_WOULD_BE_EXPIRED',
          'A comp-off credit needed for these days expires before the day it would be taken — apply earlier or for fewer days',
          {
            expiresOn: neededExpiry != null ? new Date(utcDayMs(neededExpiry)).toISOString().slice(0, 10) : null,
            firstExpiredDay: new Date(utcDayMs(badDay)).toISOString().slice(0, 10),
          }));
      }
    } else {
      const neededExpiry = earliestExpiryForUnits(input.compOffLots, units);
      if (neededExpiry != null && startMs > utcDayMs(neededExpiry)) {
        errors.push(fail('COMP_OFF_WOULD_BE_EXPIRED',
          'The comp-off credit needed for these days expires before your leave date — apply earlier or for fewer days',
          { expiresOn: new Date(utcDayMs(neededExpiry)).toISOString().slice(0, 10) }));
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function monthsBetween(fromMs, toMs) {
  const a = new Date(fromMs); const b = new Date(toMs);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

module.exports = { validateRequest, BACKDATE_OK, _internals: { monthsBetween } };
