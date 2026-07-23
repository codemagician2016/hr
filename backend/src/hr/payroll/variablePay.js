'use strict';

/**
 * variablePay.js — Variable-Pay / Incentive math core (Feature 46, Phase 4).
 *
 * PURE: no DB, no I/O, no prisma, no `new Date()`. The caller (variablePay.service.js)
 * resolves every employee's basis amount + achievement% + proration, maps rows into
 * the plain args below, calls `computeAward`, persists the VariablePayCycle/
 * VariablePayAward snapshot, then injects a PayRunInputItem(kind=OTE) per award.
 *
 * MONEY: everything is INTEGER MINOR UNITS (paise). ₹1 = 100 paise. All rounding is
 * exact-rational HALF_UP via the shared payroll money core (money.js) — NEVER a float
 * for money. Conversion to Decimal happens only at the persistence edge (the service).
 *
 * Formula (per employee):
 *   basis = FIXED_AMOUNT →  targetMinor   = targetAmountMinor
 *   basis ≠ FIXED_AMOUNT →  targetMinor   = HALF_UP( basisMinor × targetPct% )     // percentOf
 *   achievedMinor  = HALF_UP( targetMinor × achievementPct% )                       // percentOf
 *   computedMinor  = HALF_UP( achievedMinor × prorationFactor )                     // rational scale
 *
 *   achievementPct = 100 ⇒ achievedMinor == targetMinor (percentOf(x,100) is exact).
 *   prorationFactor = 1   ⇒ computedMinor == achievedMinor.
 */

const { percentOf, roundRational, RoundingMode } = require('./money');

const BASIS = Object.freeze({
  GROSS: 'GROSS',
  BASIC: 'BASIC',
  CTC: 'CTC',
  FIXED_AMOUNT: 'FIXED_AMOUNT',
});

const PRORATION = Object.freeze({
  NONE: 'NONE',
  BY_ATTENDANCE: 'BY_ATTENDANCE',
  BY_TENURE: 'BY_TENURE',
});

// Proration factor is carried as a fraction with up to 6 decimals of precision.
const PRORATION_SCALE = 1_000_000;

function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/**
 * scaleByFactor — exact HALF_UP of `minor × factor` where `factor` is a
 * non-negative number in ~[0,1] (the proration fraction). Expressed as an integer
 * rational (num / PRORATION_SCALE) so there is no float in the rounding; falls back
 * to BigInt for astronomically large products. PURE.
 */
function scaleByFactor(minor, factor) {
  const m = toInt(minor);
  const num = Math.round(toNum(factor) * PRORATION_SCALE);
  if (num === PRORATION_SCALE) return m; // factor == 1 → identity
  const product = m * num;
  if (Number.isSafeInteger(product)) {
    return roundRational(product, PRORATION_SCALE, RoundingMode.HALF_UP);
  }
  // BigInt fallback (very large awards): exact HALF_UP of (m*num)/scale.
  const p = BigInt(m) * BigInt(num);
  const d = BigInt(PRORATION_SCALE);
  const neg = p < 0n;
  const a = neg ? -p : p;
  const q = a / d;
  const r = a - q * d;
  const up = r * 2n >= d;
  const mag = up ? q + 1n : q;
  return Number(neg ? -mag : mag);
}

/**
 * resolveProration — the proration factor (0..1) for a period. PURE.
 *   NONE                → 1 (full target)
 *   BY_TENURE / BY_ATTENDANCE → clamp(activeDays / periodDays, 0, 1)
 *     (v1 wires NONE + BY_TENURE; BY_ATTENDANCE reuses the same day-fraction.)
 * Guards: a zero/absent periodDays yields 1 (no proration data ⇒ full payout).
 */
function resolveProration({ method, activeDays, periodDays } = {}) {
  if (!method || method === PRORATION.NONE) return 1;
  const period = toInt(periodDays);
  if (period <= 0) return 1;
  const active = Math.max(0, toInt(activeDays));
  const f = active / period;
  if (f >= 1) return 1;
  if (f <= 0) return 0;
  return f;
}

/**
 * computeAward — the per-employee variable-pay computation. PURE, paise-exact.
 *
 * @param basisMinor          resolved gross/basic/ctc for the period (paise); ignored for FIXED_AMOUNT
 * @param targetPct           % of basis (e.g. 12.5); used when basis ≠ FIXED_AMOUNT
 * @param targetAmountMinor   flat target payout (paise); used when basis = FIXED_AMOUNT
 * @param basis               one of BASIS
 * @param achievementPct      per-employee performance % (default 100)
 * @param prorationFactor     0..1 proration fraction (default 1)
 * @returns { targetMinor, computedMinor } — integer paise
 */
function computeAward({
  basisMinor = 0,
  targetPct = null,
  targetAmountMinor = 0,
  basis = BASIS.GROSS,
  achievementPct = 100,
  prorationFactor = 1,
} = {}) {
  const targetMinor = basis === BASIS.FIXED_AMOUNT
    ? Math.max(0, toInt(targetAmountMinor))
    : percentOf(Math.max(0, toInt(basisMinor)), toNum(targetPct), RoundingMode.HALF_UP);

  // achievement% scaling (percentOf(x, 100) is exact → identity at the default).
  const achievedMinor = percentOf(targetMinor, toNum(achievementPct), RoundingMode.HALF_UP);
  // proration scaling (factor 1 → identity).
  const computedMinor = scaleByFactor(achievedMinor, prorationFactor);

  return { targetMinor, computedMinor };
}

/**
 * computeCycleTotals — roll per-award results into the frozen cycle totals. PURE.
 * @param awards  [{ targetMinor, computedMinor }]
 * @returns { headcount, totalTargetMinor, totalComputedMinor }
 */
function computeCycleTotals(awards = []) {
  let totalTargetMinor = 0;
  let totalComputedMinor = 0;
  for (const a of awards) {
    totalTargetMinor += toInt(a.targetMinor);
    totalComputedMinor += toInt(a.computedMinor);
  }
  return { headcount: awards.length, totalTargetMinor, totalComputedMinor };
}

module.exports = {
  BASIS,
  PRORATION,
  resolveProration,
  computeAward,
  computeCycleTotals,
  // exposed for tests
  _internals: { scaleByFactor, PRORATION_SCALE },
};
