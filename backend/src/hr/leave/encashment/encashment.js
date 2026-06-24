'use strict';

/**
 * encashment.js — Feature 31 IN-SERVICE leave-encashment validation + money math.
 *
 * PURE: no DB, no I/O, no prisma — the house style of `ledger.js` / `fnf.js`,
 * unit-testable with plain `node`. The DB-bound callers (the ESS request controller,
 * the approval consumer, the pay pass) supply already-resolved figures.
 *
 * Two responsibilities:
 *   1. validateEncashRequest(...) — the policy gate (caps / window / min-balance-after /
 *      requests-per-year), returning a structured { ok, reason?, code? }.
 *   2. computeEncashAmount(...) — the per-day money basis. BASIC_DA_26 DELEGATES to
 *      fnf.computeLeaveEncashment so an in-service payout agrees with an exit (F&F)
 *      payout to the paise; only the TAXABILITY differs downstream (we never call the
 *      §10(10AA) exempt path — in-service encashment is fully taxable under §17).
 *
 * The balance debit itself is NOT here — it is the existing ENCASHMENT LeaveTransaction
 * + encashed+/closing− move in the leave ledger (ledger.js scores ENCASHMENT as −|q|,
 * computeClosing subtracts the `encashed` bucket), so the §4.2 reconcile invariant holds
 * with ZERO ledger changes once one ENCASHMENT row is posted.
 */

const ledger = require('../ledger');
const fnf = require('../../lifecycle/fnf');

// Match fnf's basicDa kinds resolver: figures arrive already in integer paise.
function int(v) {
  const n = Math.round(Number(v) || 0);
  return Number.isFinite(n) ? n : 0;
}
function num(v, dflt = 0) {
  const n = v == null ? dflt : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * validateEncashRequest — the pure gate. Returns { ok:true } or { ok:false, code, reason }.
 * Checks, IN ORDER (first failure wins), exactly per spec §5.1:
 *   1. policy.encashInService === true AND leaveType.isEncashable     → ENCASH_NOT_ALLOWED
 *   2. days > 0 (and a number)                                         → INVALID_DAYS
 *   3. days >= encashMinDaysPerRequest                                 → BELOW_MIN_DAYS
 *   4. requestsThisYear < encashMaxRequestsPerYear                     → MAX_REQUESTS_REACHED
 *   5. alreadyEncashedThisYearDays + days <= encashMaxDaysPerYear      → YEARLY_CAP_EXCEEDED
 *   6. window open: encashWindowOpenMonth..CloseMonth covers asOfMonth → WINDOW_CLOSED
 *   7. available(balance, policy) − days >= (encashMinBalanceAfter??0) → INSUFFICIENT_BALANCE
 *
 * The available-balance check REUSES ledger.available so the encashment hold is
 * consistent with what a leave-apply would see (closing − pendingApproval, ± negativeCap).
 *
 * @param {object} args
 * @param {object} args.balance     LeaveBalance row { closing, pendingApproval }
 * @param {object} args.policy      resolved LeavePolicy { encashInService, encash* caps, allowNegative, negativeCap }
 * @param {object} args.leaveType   { isEncashable }
 * @param {object} args.request     { days }
 * @param {number} args.alreadyEncashedThisYearDays  Σ days on this employee's APPROVED/PAID requests this period
 * @param {number} args.requestsThisYear             count of non-terminal-rejected requests this period
 * @param {number} args.asOfMonth   1–12 (the request month) for the window gate
 * @returns {{ ok:boolean, code?:string, reason?:string }}
 */
function validateEncashRequest({
  balance,
  policy,
  leaveType,
  request,
  alreadyEncashedThisYearDays = 0,
  requestsThisYear = 0,
  asOfMonth,
} = {}) {
  const p = policy || {};
  const lt = leaveType || {};
  const days = num((request || {}).days, 0);

  // 1) Master gates — the coarse LeaveType flag AND the fine resolved-policy flag.
  if (p.encashInService !== true || lt.isEncashable !== true) {
    return { ok: false, code: 'ENCASH_NOT_ALLOWED', reason: 'In-service encashment is not enabled for this leave type.' };
  }

  // 2) Days must be a positive number (guard zero/negative/NaN).
  if (!(days > 0)) {
    return { ok: false, code: 'INVALID_DAYS', reason: 'Days to encash must be greater than zero.' };
  }

  // 3) Per-request floor (e.g. must encash >= 5 days).
  if (p.encashMinDaysPerRequest != null && days < num(p.encashMinDaysPerRequest)) {
    return { ok: false, code: 'BELOW_MIN_DAYS', reason: `You must encash at least ${num(p.encashMinDaysPerRequest)} day(s) per request.` };
  }

  // 4) Requests-per-year cap (typically once/year).
  const maxRequests = p.encashMaxRequestsPerYear == null ? 1 : int(p.encashMaxRequestsPerYear);
  if (num(requestsThisYear) >= maxRequests) {
    return { ok: false, code: 'MAX_REQUESTS_REACHED', reason: `You have reached the limit of ${maxRequests} encashment request(s) this year.` };
  }

  // 5) Days-per-year cap (separate from the exit maxEncashCap).
  if (p.encashMaxDaysPerYear != null) {
    const cap = num(p.encashMaxDaysPerYear);
    if (num(alreadyEncashedThisYearDays) + days > cap + 1e-9) {
      return { ok: false, code: 'YEARLY_CAP_EXCEEDED', reason: `This exceeds your ${cap}-day encashment limit for the year.` };
    }
  }

  // 6) Encashment window. NULL open-month ⇒ always open. A window that wraps the
  //    year-end (open=11, close=2) is supported.
  if (p.encashWindowOpenMonth != null && asOfMonth != null) {
    const open = int(p.encashWindowOpenMonth);
    const close = p.encashWindowCloseMonth == null ? open : int(p.encashWindowCloseMonth);
    const m = int(asOfMonth);
    const inWindow = open <= close
      ? (m >= open && m <= close)
      : (m >= open || m <= close); // wraps year-end
    if (!inWindow) {
      return { ok: false, code: 'WINDOW_CLOSED', reason: 'The encashment window is not open right now.' };
    }
  }

  // 7) Available-after-debit must respect the min-balance-after floor (statutory carry intent).
  //    REUSE ledger.available so the gate matches the leave-apply availability exactly.
  const avail = ledger.available(balance || {}, p);
  const minAfter = p.encashMinBalanceAfter == null ? 0 : num(p.encashMinBalanceAfter);
  if (avail - days < minAfter - 1e-9) {
    return { ok: false, code: 'INSUFFICIENT_BALANCE', reason: `Not enough balance — you must keep at least ${minAfter} day(s) after encashing.` };
  }

  return { ok: true };
}

/**
 * computeEncashAmount — the per-day money for a settled set of days. Rounds ONCE off
 * the unrounded monthly figure (the fnf rule), never per-day×days (avoids double-rounding).
 *
 *   BASIC_DA_26 → DELEGATE to fnf.computeLeaveEncashment (byte-identical to F&F exit).
 *   BASIC_30    → floor(basicMonthlyMinor × days / 30 + 0.5)
 *   GROSS_30    → floor(grossMonthlyMinor × days / 30 + 0.5)
 *
 * Note: BASIC_DA_26 uses Basic+DA; BASIC_30 uses Basic ONLY (the caller passes the
 * basic-only figure as basicDaMonthlyMinor when basis=BASIC_30 per spec §5.2), GROSS_30
 * uses gross. We keep one param (basicDaMonthlyMinor) for the "basic-ish" figure and a
 * separate grossMonthlyMinor for GROSS_30 to avoid ambiguity.
 *
 * @returns {{ days:number, perDayMinor:number, amountMinor:number }}
 */
function computeEncashAmount({ basis, basicDaMonthlyMinor = 0, grossMonthlyMinor = 0, days = 0 } = {}) {
  const d = num(days, 0);
  if (!(d > 0)) return { days: 0, perDayMinor: 0, amountMinor: 0 };

  switch (basis) {
    case 'BASIC_30': {
      const basic = int(basicDaMonthlyMinor);
      const perDayMinor = Math.floor(basic / 30 + 0.5);
      const amountMinor = Math.floor((basic * d) / 30 + 0.5);
      return { days: d, perDayMinor, amountMinor };
    }
    case 'GROSS_30': {
      const gross = int(grossMonthlyMinor);
      const perDayMinor = Math.floor(gross / 30 + 0.5);
      const amountMinor = Math.floor((gross * d) / 30 + 0.5);
      return { days: d, perDayMinor, amountMinor };
    }
    case 'BASIC_DA_26':
    default: {
      // Delegate to F&F so in-service == exit to the paise (only taxability differs).
      const res = fnf._internals.computeLeaveEncashment({
        basicDaMonthlyMinor: int(basicDaMonthlyMinor),
        encashableLeaveDays: d,
      });
      return { days: res.days, perDayMinor: res.perDayMinor, amountMinor: res.amountMinor };
    }
  }
}

module.exports = {
  validateEncashRequest,
  computeEncashAmount,
};
