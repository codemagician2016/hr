'use strict';

/**
 * accrual.js — Leave accrual engine (Feature 6).
 *
 * PURE: no DB, no I/O, no prisma, no Date.now in the math. The caller
 * (accrualRunner / carry-forward endpoint) loads the policy, AccrualRule tiers,
 * join date and current balance and passes them in; this module computes the
 * units to grant / carry / lapse / encash. Mirrors `attendance/derive.js` and
 * `payroll/compliance/holidaysAct.js` — node --test-able to the unit.
 *
 * Precision discipline (§4.2): scale to integer thousandths internally; round to
 * the policy grain only at the period boundary. We reuse ledger.js's helpers so
 * the whole vertical scales identically.
 */

const {
  toThousandths,
  fromThousandths,
  roundToGrain,
} = require('./ledger');

function num(v, dflt = 0) {
  const n = v == null ? dflt : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// Periods per year for an AccrualFrequency.
const PERIODS_PER_YEAR = {
  MONTHLY: 12,
  QUARTERLY: 4,
  ANNUAL: 1,
  PER_PAY_PERIOD: 12, // assume monthly pay periods unless the caller overrides
};

function periodsPerYear(policy) {
  if (policy && policy.periodsPerYearOverride) return num(policy.periodsPerYearOverride, 12);
  return PERIODS_PER_YEAR[(policy && policy.accrualFrequency) || 'MONTHLY'] || 12;
}

// ── tenure-tiered rate ───────────────────────────────────────────────────────
/**
 * tieredRate(rules, tenureMonths) — the AccrualRule whose [minTenureMonths,
 * maxTenureMonths] window covers `tenureMonths`, most-specific wins (narrowest
 * window, then highest minTenureMonths). Returns the ratePerPeriod, or null when
 * no tier matches (caller falls back to entitlementPerYear / periodsPerYear).
 */
function tieredRate(rules, tenureMonths) {
  const t = num(tenureMonths);
  const matches = (rules || []).filter((r) => {
    if (r == null) return false;
    const min = num(r.minTenureMonths, 0);
    const max = r.maxTenureMonths == null ? Infinity : num(r.maxTenureMonths);
    return t >= min && t <= max;
  });
  if (!matches.length) return null;
  matches.sort((a, b) => {
    const wa = (a.maxTenureMonths == null ? Infinity : num(a.maxTenureMonths)) - num(a.minTenureMonths);
    const wb = (b.maxTenureMonths == null ? Infinity : num(b.maxTenureMonths)) - num(b.minTenureMonths);
    if (wa !== wb) return wa - wb; // narrower window first
    return num(b.minTenureMonths) - num(a.minTenureMonths); // then higher floor
  });
  return num(matches[0].ratePerPeriod);
}

// ── pro-rata on join ─────────────────────────────────────────────────────────
function utcDay(d) {
  const x = d instanceof Date ? d : new Date(d);
  return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
}
function daysInclusive(from, to) {
  return Math.round((utcDay(to) - utcDay(from)) / 86400000) + 1;
}

/**
 * prorataOnJoin(policy, joinDate, periodStart, periodEnd, { grain }) — the
 * opening grant for an employee who joins mid-period.
 *   UPFRONT_ANNUAL : entitlement × (remainingDays / totalDays)
 *   MONTHLY_ACCRUAL: 0 on join unless joinDay ≤ cutoff (IN convention ≤15th ⇒
 *                    the join month counts as one accrual tick)
 *   ANNIVERSARY_GRANT / CONTINUOUS_NZ / WORKED_HOURS_RATIO: 0 (accrue per tick)
 * The join effectively clamps to periodStart when earlier.
 */
function prorataOnJoin(policy, joinDate, periodStart, periodEnd, { grain = 0.5 } = {}) {
  const p = policy || {};
  if (p.accrualProrateOnJoin === false) {
    // No proration: an UPFRONT policy still grants the full entitlement.
    if (p.accrualMethod === 'UPFRONT_ANNUAL') return roundToGrain(num(p.entitlementPerYear), grain);
    return 0;
  }
  const join = utcDay(joinDate) > utcDay(periodStart) ? joinDate : periodStart;
  const totalDays = daysInclusive(periodStart, periodEnd);
  if (totalDays <= 0) return 0;

  switch (p.accrualMethod) {
    case 'UPFRONT_ANNUAL': {
      const remainingDays = daysInclusive(join, periodEnd);
      const entitlement = num(p.entitlementPerYear);
      const milli = Math.round((toThousandths(entitlement) * remainingDays) / totalDays);
      return roundToGrain(fromThousandths(milli), grain);
    }
    case 'MONTHLY_ACCRUAL': {
      const cutoff = num(p.joinCutoffDay, 15); // IN convention
      const joinDom = new Date(utcDay(join)).getUTCDate();
      if (joinDom <= cutoff) {
        const rate = num(p.entitlementPerYear) / periodsPerYear(p);
        return roundToGrain(rate, grain);
      }
      return 0;
    }
    default:
      return 0;
  }
}

// ── per-tick accrual ─────────────────────────────────────────────────────────
/**
 * accrueForPeriod(policy, accrualRules, ctx) — units granted for ONE accrual
 * tick.
 *   rate = tieredRate(rules, ctx.tenureMonths) ?? entitlementPerYear/periodsPerYear
 *   raw  = rate × eligibilityFactor       (LWP months may zero/scale a tick)
 *   WORKED_HOURS_RATIO: raw = workedDays / workedDaysPerUnit   (IN factory §79 = 20)
 *   CONTINUOUS_NZ annual: notional 4/52 week per worked week; DOES NOT vest
 *     before 12 months (vesting is enforced by validators at apply time, but the
 *     engine still flags vested:false so the caller never lets it be taken).
 *   capToBalance: never let closing exceed maxBalanceCap.
 *
 * Returns { units, vested, rate, capped } — `units` is the accruable grant
 * AFTER the maxBalanceCap clamp; `vested` is false for CONTINUOUS_NZ < 12mo.
 */
function accrueForPeriod(policy, accrualRules, ctx = {}) {
  const p = policy || {};
  const grain = num(ctx.grain, 0.5) || 0.5;
  const tenureMonths = num(ctx.tenureMonths);
  const eligibilityFactor = ctx.eligibilityFactor == null ? 1 : num(ctx.eligibilityFactor, 1);
  const currentClosing = num(ctx.currentClosing);

  let rate = tieredRate(accrualRules, tenureMonths);
  if (rate == null) rate = num(p.entitlementPerYear) / periodsPerYear(p);

  let rawMilli;
  let vested = true;

  switch (p.accrualMethod) {
    case 'WORKED_HOURS_RATIO': {
      const per = num(p.workedDaysPerUnit, 20); // IN Factories Act §79: 1 per 20
      const worked = num(ctx.workedDays);
      rawMilli = per > 0 ? Math.round((toThousandths(worked)) / per) : 0;
      break;
    }
    case 'CONTINUOUS_NZ': {
      // notional 4 weeks / 52 worked weeks (entitlementPerYear is in weeks)
      const weeks = ctx.workedWeeks == null ? 1 : num(ctx.workedWeeks);
      const annualWeeks = num(p.entitlementPerYear, 4);
      rawMilli = Math.round((toThousandths(annualWeeks) * weeks) / 52);
      vested = tenureMonths >= num(p.minTenureMonths, 12);
      break;
    }
    case 'ANNIVERSARY_GRANT': {
      // a full year's entitlement granted on the anniversary tick only
      rawMilli = ctx.isAnniversaryTick === false ? 0 : toThousandths(num(p.entitlementPerYear));
      break;
    }
    case 'UPFRONT_ANNUAL':
      // granted as the opening; a recurring tick contributes nothing
      rawMilli = ctx.isPeriodOpenTick ? toThousandths(num(p.entitlementPerYear)) : 0;
      break;
    case 'MONTHLY_ACCRUAL':
    default:
      rawMilli = toThousandths(rate);
      break;
  }

  // eligibility factor (e.g. an LWP-dominated month accrues nothing)
  rawMilli = Math.round(rawMilli * eligibilityFactor);
  let raw = roundToGrain(fromThousandths(rawMilli), grain);

  // cap to balance: never exceed maxBalanceCap on closing
  let capped = false;
  if (p.maxBalanceCap != null) {
    const headroomMilli = toThousandths(p.maxBalanceCap) - toThousandths(currentClosing);
    const grantMilli = toThousandths(raw);
    if (grantMilli > headroomMilli) {
      raw = roundToGrain(fromThousandths(Math.max(0, headroomMilli)), grain);
      capped = true;
    }
  }

  return { units: raw, vested, rate, capped };
}

// ── year-end roll (carry-forward + lapse) ────────────────────────────────────
/**
 * yearEndRoll(policy, closing, { grain }) → { carried, lapsed }
 *   carried = min(closing, carryForwardCap ?? closing)   // null cap = unbounded
 *   lapsed  = closing − carried
 * NZ annual leave never lapses ⇒ carryForwardCap=null. CL typically cap=0 ⇒ all
 * closing lapses. Carried units fold into the NEXT period's `opening`.
 */
function yearEndRoll(policy, closing, { grain = 0.5 } = {}) {
  const p = policy || {};
  const closeMilli = toThousandths(closing);
  if (closeMilli <= 0) return { carried: 0, lapsed: 0 };
  const capMilli = p.carryForwardCap == null ? closeMilli : toThousandths(p.carryForwardCap);
  const carriedMilli = Math.min(closeMilli, Math.max(0, capMilli));
  const carried = roundToGrain(fromThousandths(carriedMilli), grain);
  const lapsed = roundToGrain(fromThousandths(closeMilli - toThousandths(carried)), grain);
  return { carried, lapsed: lapsed < 0 ? 0 : lapsed };
}

/**
 * carriedLotExpiry(lots, asOf, expiryMonths, { grain }) — FIFO carried-lot
 * expiry (§4.5). `lots` = [{ remaining, openedAt }] oldest-first; a lot unused
 * within `carryForwardExpiryMonths` of its open date lapses on the residual.
 * Returns { lapsed, perLot:[{ openedAt, lapsed }] }. expiryMonths null ⇒ never.
 */
function carriedLotExpiry(lots, asOf, expiryMonths, { grain = 0.5 } = {}) {
  if (expiryMonths == null) return { lapsed: 0, perLot: [] };
  const now = utcDay(asOf);
  let lapsedMilli = 0;
  const perLot = [];
  for (const lot of lots || []) {
    const opened = new Date(utcDay(lot.openedAt));
    const expiry = Date.UTC(opened.getUTCFullYear(), opened.getUTCMonth() + num(expiryMonths), opened.getUTCDate());
    if (now >= expiry) {
      const rem = Math.max(0, toThousandths(lot.remaining));
      if (rem > 0) {
        lapsedMilli += rem;
        perLot.push({ openedAt: lot.openedAt, lapsed: roundToGrain(fromThousandths(rem), grain) });
      }
    }
  }
  return { lapsed: roundToGrain(fromThousandths(lapsedMilli), grain), perLot };
}

// ── encashable units ─────────────────────────────────────────────────────────
/**
 * encashableUnits(policy, balance, { type, grain }) — units the FnF settle may
 * encash. `type.isEncashable` OR `policy.encashOnExit` gates it; capped by
 * `policy.maxEncashCap` when present (§3.2 optional). Never exceeds closing.
 */
function encashableUnits(policy, balance, { type, grain = 0.5 } = {}) {
  const p = policy || {};
  const t = type || {};
  const encashable = t.isEncashable === true || p.encashOnExit === true || p.isEncashable === true;
  if (!encashable) return 0;
  let milli = Math.max(0, toThousandths((balance || {}).closing));
  if (p.maxEncashCap != null) milli = Math.min(milli, toThousandths(p.maxEncashCap));
  return roundToGrain(fromThousandths(milli), grain);
}

// ── tenure helper (months between two dates, completed) ──────────────────────
function tenureMonthsBetween(from, to) {
  const a = from instanceof Date ? from : new Date(from);
  const b = to instanceof Date ? to : new Date(to);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1; // not yet completed this month
  return Math.max(0, months);
}

module.exports = {
  prorataOnJoin,
  accrueForPeriod,
  tieredRate,
  yearEndRoll,
  carriedLotExpiry,
  encashableUnits,
  tenureMonthsBetween,
  periodsPerYear,
  _internals: { daysInclusive, utcDay },
};
