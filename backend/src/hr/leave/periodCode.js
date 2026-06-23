'use strict';

/**
 * periodCode.js — the single source of truth for a leave PERIOD code.
 *
 * A LeaveBalance row is scoped to a `periodCode` (the financial-year "YYYY-YY"
 * with an Apr-start default, or an anniversary "YYYY-ANNIV"). provision.js and
 * accrualRunner.js already mint balances under this scheme; leaveContext (the
 * apply path) and offboarding (encashment + FnF valuation) must resolve a
 * balance for the SAME period, not the arbitrary newest-created row (findings
 * #2/#4). This module centralises that derivation so every caller agrees.
 *
 * PURE: no DB.
 */

/**
 * fyPeriodCode(date, startMonth=4) — the financial-year code containing `date`.
 * Mirrors provision.js#periodCodeFor exactly (Apr-start default, "YYYY-YY").
 */
function fyPeriodCode(date, startMonth = 4) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const startY = m >= startMonth ? y : y - 1;
  return `${startY}-${String((startY + 1) % 100).padStart(2, '0')}`;
}

module.exports = { fyPeriodCode };
