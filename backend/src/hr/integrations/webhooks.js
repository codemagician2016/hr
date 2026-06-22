'use strict';

/**
 * webhooks.js — emit HR domain events to a tenant's WebhookSubscription rows.
 *
 * Reuses the EXISTING core webhook dispatcher (core/lib/webhookDispatcher.js)
 * which already handles:
 *   - matching active subscriptions whose `events[]` include the event name
 *   - enqueueing WebhookDelivery rows
 *   - HMAC-SHA256 signing (X-Sitepresso-Signature-V2: t=..,v1=hmac(t.body))
 *   - retry/backoff via dispatchPendingRetries()
 *
 * We add nothing to that machinery — we only (a) declare the HR event names,
 * (b) build clean, stable payloads from the pay-run / leave aggregates, and
 * (c) expose emit helpers that call dispatcher.safeEmit (fire-and-forget on
 * hot paths) or emit (awaitable, for routes/tests).
 */

const dispatcher = require('../../core/lib/webhookDispatcher');

// HR events publishers can emit and subscribers can subscribe to.
const HR_EVENTS = Object.freeze([
  'payslip.published',
  'leave.approved',
  'payrun.computed',
]);

function isHrEvent(event) {
  return HR_EVENTS.includes(event);
}

// ---------------------------------------------------------------------------
//  Payload builders — deterministic, PII-light, money as fixed-scale strings.
// ---------------------------------------------------------------------------

function decStr(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'object' && typeof v.toString === 'function' ? v.toString() : String(v);
  return n;
}

function isoDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** payslip.published payload from a Payslip row (+ optional employee include). */
function payslipPublishedPayload(payslip) {
  if (!payslip) return null;
  const emp = payslip.employee || {};
  return {
    payslipId: payslip.id,
    code: payslip.code || null,
    payRunId: payslip.payRunId || null,
    employee: {
      id: payslip.employeeId || emp.id || null,
      code: emp.code || null,
      name: [emp.firstName, emp.lastName].filter(Boolean).join(' ') || null,
    },
    periodStart: isoDate(payslip.periodStart),
    periodEnd: isoDate(payslip.periodEnd),
    payDate: isoDate(payslip.payDate),
    currency: payslip.currencyCode || null,
    grossEarnings: decStr(payslip.grossEarnings),
    totalDeductions: decStr(payslip.totalDeductions),
    netPay: decStr(payslip.netPay),
    status: payslip.status || null,
  };
}

/** leave.approved payload from a LeaveRequest-ish row. */
function leaveApprovedPayload(leave) {
  if (!leave) return null;
  const emp = leave.employee || {};
  return {
    leaveRequestId: leave.id,
    employee: {
      id: leave.employeeId || emp.id || null,
      code: emp.code || null,
      name: [emp.firstName, emp.lastName].filter(Boolean).join(' ') || null,
    },
    leaveType: leave.leaveType || leave.type || leave.leaveTypeCode || null,
    startDate: isoDate(leave.startDate),
    endDate: isoDate(leave.endDate),
    days: decStr(leave.days != null ? leave.days : leave.totalDays),
    status: leave.status || 'APPROVED',
    approvedBy: leave.approvedBy || leave.decidedBy || null,
    approvedAt: isoDate(leave.approvedAt || leave.decidedAt),
  };
}

/** payrun.computed payload from a getRun() aggregate { payRun, totals }. */
function payrunComputedPayload(runAggregate) {
  if (!runAggregate) return null;
  const payRun = runAggregate.payRun || runAggregate;
  const totals = runAggregate.totals || {};
  return {
    payRunId: payRun.id || null,
    code: payRun.code || null,
    entityId: payRun.entityId || (payRun.entity && payRun.entity.id) || null,
    periodStart: isoDate(payRun.periodStart),
    periodEnd: isoDate(payRun.periodEnd),
    payDate: isoDate(payRun.payDate),
    status: payRun.status || null,
    currency: payRun.currencyCode || null,
    headcount: totals.headcount != null ? totals.headcount : (payRun.headcount != null ? payRun.headcount : null),
    totalGross: decStr(totals.totalGross != null ? totals.totalGross : payRun.totalGross),
    totalDeductions: decStr(totals.totalDeductions != null ? totals.totalDeductions : payRun.totalDeductions),
    totalNet: decStr(totals.totalNet != null ? totals.totalNet : payRun.totalNet),
    totalEmployerCost: decStr(totals.totalEmployerCost != null ? totals.totalEmployerCost : payRun.totalEmployerCost),
  };
}

const PAYLOAD_BUILDERS = Object.freeze({
  'payslip.published': payslipPublishedPayload,
  'leave.approved': leaveApprovedPayload,
  'payrun.computed': payrunComputedPayload,
});

// ---------------------------------------------------------------------------
//  Emit helpers — delegate to the core dispatcher (HMAC-signed delivery).
// ---------------------------------------------------------------------------

/** Build the payload for an event from its domain object. */
function buildPayload(event, source) {
  const fn = PAYLOAD_BUILDERS[event];
  return fn ? fn(source) : source;
}

/**
 * emitHrEvent — fire-and-forget enqueue to all subscribers of `event` for the
 * tenant. Safe to call on hot paths (controllers); never throws/blocks.
 *
 * @param {string} businessId
 * @param {string} event       one of HR_EVENTS
 * @param {object} source      the domain row/aggregate (payslip/leave/run)
 */
function emitHrEvent(businessId, event, source) {
  if (!isHrEvent(event)) return;
  const payload = buildPayload(event, source);
  dispatcher.safeEmit(event, payload, businessId);
}

/**
 * emitHrEventAwaitable — awaitable variant for routes/tests that want to
 * confirm enqueue + handle errors. Returns the dispatcher.emit() promise.
 */
async function emitHrEventAwaitable(businessId, event, source) {
  if (!isHrEvent(event)) {
    const err = new Error(`Not an HR webhook event: ${event}`);
    err.code = 'UNKNOWN_EVENT';
    throw err;
  }
  const payload = buildPayload(event, source);
  return dispatcher.emit(event, payload, businessId);
}

module.exports = {
  HR_EVENTS,
  isHrEvent,
  buildPayload,
  emitHrEvent,
  emitHrEventAwaitable,
  // payload builders (exposed for reuse/tests)
  payslipPublishedPayload,
  leaveApprovedPayload,
  payrunComputedPayload,
};
