'use strict';

/**
 * Holidays Act 2003 — PURE leave-valuation engine, integer CENTS minor-units.
 * No DB, no I/O, no Date.now in the math. Unit-testable with plain `node`.
 *
 * Implements docs/06-compliance-newzealand.md §9 (the flagship NZ module):
 *   - The four pay rates (§9.1): OWP (s8), AWE (s5), RDP (s9), ADP (s9A).
 *   - Gross earnings (s14, §9.2) — flag-driven inclusion (grossEarningsForHolidaysAct,
 *     owpOrdinary, discretionary). Discretionary payments are EXCLUDED.
 *   - OWP — ordinary weekly pay (§9.3): s8(1) specified / s8(2) formula (a-b)/c, greater-of.
 *   - AWE — average weekly earnings (§9.4): 52-week gross ÷ 52 (or weeks employed if <52).
 *   - Annual holidays (§9.5): paid at GREATER OF OWP and AWE; unit is WEEKS, apportioned
 *     to agreed working days/week (never silently "4 weeks = 20 days").
 *   - 8% pay-as-you-go (s28, §9.6): PAYG = gross × 8%; FORBIDDEN for permanent staff
 *     (validation gate raises PAYG_FORBIDDEN). Also pre-entitlement / termination 8%.
 *   - Public holidays + OWD test (§9.7): the "otherwise working day" test gating four
 *     entitlements; time-and-a-half (1.5×) for hours worked + alternative (lieu) day.
 *   - RDP (s9, §9.8) and ADP (s9A, §9.9): RDP preferred; ADP only when RDP not
 *     possible/practicable OR pay varies in the period (the s9A trigger is enforced).
 *   - Alternative/lieu days (§9.7): valued at RDP (or ADP) — full day regardless of hours.
 *   - Mondayisation (§9.7): NY/Day-after/Waitangi/ANZAC/Christmas/Boxing observed on the
 *     next working day when they fall on a weekend that is NOT an OWD. ONE entitlement only.
 *   - Leave-valuation router (§9.12): valueLeave(...) → {method, ratePerUnit, amount,
 *     window, inputs, reasonCodes}, fully explainable for audit.
 *
 * Worked examples reproduced exactly (smoke tests assert these; docs/06 §9.13):
 *   A  Annual holiday greater-of: base $1,500/wk + commission; OWP(formula)=$1,810.00,
 *      AWE=$1,800.00 → pay max = $1,810.00 for the week.
 *   B  Public holiday worked, OWD: $30/hr, 8h on Labour Day → 1.5×30×8 = $360.00 now
 *      PLUS an alternative day banked (worth RDP $240.00 for an 8h day).
 *   C  Public holiday not worked, OWD: RDP = 30×8 = $240.00 (paid day off), no alt day.
 *   D  Sick day, variable hours (ADP): 52-wk gross $36,400 ÷ 182 paid days = $200.00/day.
 *   E  8% PAYG genuine short fixed-term: gross $2,000 × 8% = $160.00 separate line.
 *
 * RATE PRECISION (§2.6): OWP/AWE/RDP/ADP computed to 4 dp INTERNALLY (we keep rates in
 * HUNDREDTHS-OF-A-CENT = 1/10000 dollar units to avoid compounding rounding error across
 * multi-day leave), rounded to whole cents only at the payable-amount boundary.
 *
 * MONEY: amounts are plain JS integers in CENTS. Rates are integer "micro-cents"
 * (1/10000 of a dollar = 1/100 of a cent) to hold 4 dp without floats-as-money.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Precision units.
 *   CENTS:      integer dollars × 100        (the payable boundary)
 *   RATE_SCALE: integer dollars × 10000      (4-dp internal rates: OWP/AWE/RDP/ADP)
 * 1 cent = 100 rate-units. We round rate-units → cents (half-up) only at payment.
 * ──────────────────────────────────────────────────────────────────────────── */

const CENTS = 100;
const RATE_SCALE = 10000; // 4 decimal places of a dollar
const RATE_PER_CENT = RATE_SCALE / CENTS; // 100 rate-units per cent

// Effective-dated Holidays Act rule set (the Act's structural constants are stable;
// the Employment Leave Bill ~2028 will arrive as a NEW effective-dated version, §13).
const RULES = [
  {
    effectiveFrom: '2003-04-01',
    label: 'HolidaysAct2003',
    annualHolidayWeeks: 4,
    paygRate: 0.08, // 8% pay-as-you-go / pro-rata proxy (s28)
    publicHolidayWorkedMultiplier: 1.5, // time-and-a-half
    cashUpMaxWeeksPerYear: 1,
    // Public holidays that mondayise when they fall on a weekend that is not an OWD (§9.7).
    mondayisedHolidays: [
      'NEW_YEARS_DAY', 'DAY_AFTER_NEW_YEARS', 'WAITANGI_DAY', 'ANZAC_DAY',
      'CHRISTMAS_DAY', 'BOXING_DAY',
    ],
  },
];

const rules = { effectiveFrom: '2003-04-01' };

function resolveRules(date) {
  let chosen = RULES[0];
  for (const r of RULES) if (!date || r.effectiveFrom <= date) chosen = r;
  return chosen;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rounding: round-half-up rate-units (4 dp) → whole cents. Applied only at the
 * payable-amount boundary (§2.6).
 * ──────────────────────────────────────────────────────────────────────────── */

function roundHalfUp(value) {
  if (value < 0) return -Math.round(-value);
  return Math.round(value);
}

// Convert a 4-dp rate (in rate-units) to whole cents, half-up.
function rateToCents(rateUnits) {
  return roundHalfUp(rateUnits / RATE_PER_CENT);
}

function money(cents) {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  return `${neg ? '-' : ''}$${Math.floor(abs / 100).toLocaleString('en-NZ')}.${String(abs % 100).padStart(2, '0')}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Gross earnings (s14, §9.2) — flag-driven. A period entry:
 *   { weekStart, amountMinor, grossEarningsForHolidaysAct=true, owpOrdinary=true,
 *     discretionary=false }
 * Discretionary payments are excluded from gross earnings.
 * ──────────────────────────────────────────────────────────────────────────── */

function isGrossEarning(entry) {
  if (entry.discretionary) return false; // genuinely discretionary → excluded (s14)
  return entry.grossEarningsForHolidaysAct === undefined ? true : entry.grossEarningsForHolidaysAct;
}

function sumGrossEarnings(entries) {
  let total = 0;
  for (const e of entries || []) if (isGrossEarning(e)) total += e.amountMinor || 0;
  return total;
}

/* ────────────────────────────────────────────────────────────────────────────
 * OWP — Ordinary Weekly Pay (s8, §9.3)
 *   s8(1) specified/derivable: use specifiedWeeklyMinor if given.
 *   s8(2) formula: OWP = (a - b) / 4
 *     a = gross earnings in the 4 complete weeks before the holiday
 *     b = payments in 'a' the employer is NOT bound to pay (owpOrdinary=false)
 *     c = 4
 * Returns the rate in 4-dp rate-units. method = SPECIFIED | FORMULA | GREATER_OF.
 * ──────────────────────────────────────────────────────────────────────────── */

function computeOWP({ specifiedWeeklyMinor, last4WeeksEntries, method = 'GREATER_OF' }) {
  // s8(2) formula over the 4-week window.
  let formulaRate = null;
  let a = null;
  let b = null;
  if (Array.isArray(last4WeeksEntries)) {
    a = sumGrossEarnings(last4WeeksEntries);
    b = 0;
    for (const e of last4WeeksEntries) {
      if (isGrossEarning(e) && e.owpOrdinary === false) b += e.amountMinor || 0;
    }
    // (a - b) cents / 4 → rate-units (×RATE_PER_CENT then /4)
    formulaRate = roundHalfUp(((a - b) * RATE_PER_CENT) / 4);
  }

  const specifiedRate = (specifiedWeeklyMinor != null)
    ? specifiedWeeklyMinor * RATE_PER_CENT
    : null;

  let rate;
  let chosen;
  if (method === 'SPECIFIED') {
    rate = specifiedRate != null ? specifiedRate : formulaRate;
    chosen = specifiedRate != null ? 'SPECIFIED' : 'FORMULA';
  } else if (method === 'FORMULA') {
    rate = formulaRate != null ? formulaRate : specifiedRate;
    chosen = formulaRate != null ? 'FORMULA' : 'SPECIFIED';
  } else { // GREATER_OF
    const candidates = [specifiedRate, formulaRate].filter((x) => x != null);
    rate = candidates.length ? Math.max(...candidates) : 0;
    chosen = (rate === specifiedRate) ? 'SPECIFIED' : 'FORMULA';
  }

  return {
    rateUnits: rate || 0,
    method: chosen,
    inputs: { aMinor: a, bMinor: b, specifiedWeeklyMinor, formulaRateUnits: formulaRate, specifiedRateUnits: specifiedRate },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * AWE — Average Weekly Earnings (s5, §9.4)
 *   AWE = gross earnings over last 52 weeks ÷ 52 (or ÷ weeks employed if <52).
 * Returns rate in 4-dp rate-units.
 * ──────────────────────────────────────────────────────────────────────────── */

function computeAWE({ last52WeeksEntries, grossEarnings52Minor, weeksEmployed }) {
  const gross = grossEarnings52Minor != null
    ? grossEarnings52Minor
    : sumGrossEarnings(last52WeeksEntries);
  const divisor = (weeksEmployed != null && weeksEmployed > 0 && weeksEmployed < 52)
    ? weeksEmployed
    : 52;
  const rate = roundHalfUp((gross * RATE_PER_CENT) / divisor);
  return { rateUnits: rate, inputs: { grossEarnings52Minor: gross, divisor } };
}

/* ────────────────────────────────────────────────────────────────────────────
 * RDP — Relevant Daily Pay (s9, §9.8)
 *   "What the employee would have earned had they actually worked that day."
 * Provide either rdpDayMinor (cents, the day's would-have-earned pay) OR
 * { hoursThatDay, hourlyRateMinor, plusAllowancesMinor }. Returns rate-units.
 * ──────────────────────────────────────────────────────────────────────────── */

function computeRDP({ rdpDayMinor, hoursThatDay, hourlyRateMinor, plusAllowancesMinor = 0 }) {
  let cents;
  if (rdpDayMinor != null) {
    cents = rdpDayMinor;
  } else if (hoursThatDay != null && hourlyRateMinor != null) {
    cents = roundHalfUp(hoursThatDay * hourlyRateMinor) + plusAllowancesMinor;
  } else {
    return null; // RDP not determinable → caller must fall back to ADP (s9A)
  }
  return { rateUnits: cents * RATE_PER_CENT, inputs: { rdpDayMinor: cents, hoursThatDay, hourlyRateMinor, plusAllowancesMinor } };
}

/* ────────────────────────────────────────────────────────────────────────────
 * ADP — Average Daily Pay (s9A, §9.9) — only when RDP not possible/practicable
 *   OR pay varies in the pay period.
 *   ADP = gross earnings(52 wks) ÷ (paid days: worked + paid leave/holidays in 52 wks)
 * Returns rate-units.
 * ──────────────────────────────────────────────────────────────────────────── */

function computeADP({ grossEarnings52Minor, last52WeeksEntries, paidDays }) {
  const gross = grossEarnings52Minor != null
    ? grossEarnings52Minor
    : sumGrossEarnings(last52WeeksEntries);
  if (!paidDays || paidDays <= 0) return null;
  const rate = roundHalfUp((gross * RATE_PER_CENT) / paidDays);
  return { rateUnits: rate, inputs: { grossEarnings52Minor: gross, paidDays } };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Daily-rate router for BAPS / public-holiday-not-worked / alt days:
 * choose RDP unless the s9A trigger fires (rdpDeterminable === false OR payVaries),
 * in which case ADP. Returns { method, rateUnits, inputs, reasonCodes }.
 * The router ENFORCES the legal precondition: HR cannot pick ADP where RDP is
 * determinable (§9.9).
 * ──────────────────────────────────────────────────────────────────────────── */

function dailyRate(ctx) {
  const reasonCodes = [];
  const rdpDeterminable = ctx.rdpDeterminable === undefined ? true : ctx.rdpDeterminable;
  const payVaries = !!ctx.payVaries;

  if (rdpDeterminable && !payVaries) {
    const rdp = computeRDP(ctx);
    if (rdp) {
      reasonCodes.push('RDP_DETERMINABLE');
      return { method: 'RDP', rateUnits: rdp.rateUnits, inputs: rdp.inputs, reasonCodes };
    }
    reasonCodes.push('RDP_INPUTS_MISSING');
  } else {
    if (!rdpDeterminable) reasonCodes.push('S9A_RDP_NOT_PRACTICABLE');
    if (payVaries) reasonCodes.push('S9A_PAY_VARIES');
  }
  const adp = computeADP(ctx);
  if (adp) {
    reasonCodes.push('ADP_APPLIED');
    return { method: 'ADP', rateUnits: adp.rateUnits, inputs: adp.inputs, reasonCodes };
  }
  // Last resort: try RDP even if a trigger was set but ADP inputs absent.
  const rdp = computeRDP(ctx);
  if (rdp) {
    reasonCodes.push('RDP_FALLBACK');
    return { method: 'RDP', rateUnits: rdp.rateUnits, inputs: rdp.inputs, reasonCodes };
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Otherwise-Working-Day (OWD) test (s12, §9.7) — deterministic over work pattern,
 * roster, and history. Returns { isOWD, confidence, reason }.
 *   Priority: 1) agreement/roster explicit; 2) regular weekly pattern;
 *             3) work history fallback (worked this weekday in >50% of recent weeks).
 * ──────────────────────────────────────────────────────────────────────────── */

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// Day-of-week (0=Sun..6=Sat) for a YYYY-MM-DD via Zeller-free UTC arithmetic (pure).
function dayOfWeek(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  // Sakamoto's algorithm — pure, no Date object.
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  let yy = y;
  if (m < 3) yy -= 1;
  return (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[m - 1] + d) % 7;
}

function otherwiseWorkingDay({ date, workPattern, roster, history }) {
  const dow = dayOfWeek(date);
  const dayKey = WEEKDAYS[dow];

  // 1) Roster/agreement explicitly covers (or excludes) the day.
  if (roster && roster[date] !== undefined) {
    return { isOWD: !!roster[date], confidence: 'HIGH', reason: `Roster explicitly ${roster[date] ? 'rosters' : 'excludes'} ${date}` };
  }

  // 2) Regular weekly pattern (e.g. works every Tuesday).
  if (workPattern && Array.isArray(workPattern.daysOfWeek)) {
    const works = workPattern.daysOfWeek.includes(dayKey);
    return { isOWD: works, confidence: 'HIGH', reason: `Work pattern ${works ? 'includes' : 'excludes'} ${dayKey}` };
  }

  // 3) History fallback: worked this weekday in a majority of recent weeks.
  if (history && Array.isArray(history.workedDates)) {
    const sameDow = history.workedDates.filter((d) => dayOfWeek(d) === dow);
    const weeksObserved = history.weeksObserved || (history.workedDates.length ? 4 : 0);
    if (weeksObserved > 0) {
      const ratio = sameDow.length / weeksObserved;
      const works = ratio > 0.5;
      return {
        isOWD: works,
        confidence: ratio === 0 || ratio === 1 ? 'MEDIUM' : 'LOW',
        reason: `History: worked ${dayKey} in ${sameDow.length}/${weeksObserved} weeks (ratio ${ratio.toFixed(2)})`,
      };
    }
  }

  return { isOWD: false, confidence: 'LOW', reason: 'Insufficient data — flag to HR for recorded decision' };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Mondayisation (§9.7). Given an actual holiday date + its mondayisable flag +
 * the employee OWD picture, decide the OBSERVED date so the employee gets ONE
 * entitlement on their otherwise-working-day. (Simplified deterministic rule:
 * if the actual date is a weekend AND not an OWD for the employee, observe on the
 * next weekday Mon, or Tue if Mon is taken by another holiday.)
 * ──────────────────────────────────────────────────────────────────────────── */

function nextDate(dateStr, days) {
  // Pure date arithmetic via day-count from a fixed epoch (no Date object).
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dim = [31, (isLeap(y) ? 29 : 28), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let yy = y; let mm = m; let dd = d + days;
  while (dd > dim[mm - 1]) {
    dd -= dim[mm - 1];
    mm += 1;
    if (mm > 12) { mm = 1; yy += 1; dim[1] = isLeap(yy) ? 29 : 28; }
  }
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

function mondayiseObservedDate({ holidayCode, actualDate, isOWDonActual, takenMondays = [], ruleDate }) {
  const rs = resolveRules(ruleDate || actualDate);
  const dow = dayOfWeek(actualDate);
  const isWeekend = dow === 0 || dow === 6; // Sun or Sat
  const mondayisable = rs.mondayisedHolidays.includes(holidayCode);

  if (!mondayisable || !isWeekend || isOWDonActual) {
    // Entitlement stays on the actual date (incl. when the weekend day IS an OWD — §15.5).
    return { observedDate: actualDate, mondayised: false, reason: isOWDonActual ? 'Weekend day is an OWD — entitlement on the actual date, not Monday' : 'Not mondayised' };
  }
  // Move to next Monday; if Monday already taken by another holiday, use Tuesday.
  let observed = actualDate;
  // advance to Monday (dow 1)
  let cursor = actualDate;
  for (let i = 0; i < 3; i++) {
    cursor = nextDate(cursor, 1);
    if (dayOfWeek(cursor) === 1) { observed = cursor; break; }
  }
  if (takenMondays.includes(observed)) observed = nextDate(observed, 1); // Tuesday
  return { observedDate: observed, mondayised: true, reason: `Fell on weekend (non-OWD) → observed ${observed}` };
}

/* ────────────────────────────────────────────────────────────────────────────
 * PAYG 8% (s28, §9.6) — and its validation gate.
 * FORBIDDEN for permanent staff. Permitted only for genuine fixed-term <12 months
 * OR genuinely intermittent/irregular work, agreed in writing, shown separately.
 * ──────────────────────────────────────────────────────────────────────────── */

function computePAYG8({ grossEarningsThisPayMinor, employment, ruleDate }) {
  const rs = resolveRules(ruleDate);
  const anomalies = [];
  const emp = employment || {};
  const permitted = (
    (emp.type === 'FIXED_TERM' && emp.fixedTermMonths != null && emp.fixedTermMonths < 12)
    || emp.workPattern === 'INTERMITTENT'
    || emp.workPattern === 'IRREGULAR'
  ) && emp.agreedInWriting === true;

  if (!permitted) {
    anomalies.push({
      code: 'PAYG_FORBIDDEN',
      severity: 'BLOCKER',
      message: '8% pay-as-you-go annual holiday pay is not permitted for this employee (allowed only for genuine fixed-term <12 months or intermittent/irregular work, agreed in writing).',
    });
  }
  const amountMinor = roundHalfUp((grossEarningsThisPayMinor || 0) * rs.paygRate);
  return {
    amountMinor,
    permitted,
    anomalies,
    line: {
      code: 'ANNUAL_HOLIDAY_PAYG_8PCT',
      label: 'Annual holiday pay (8%)',
      amountMinor,
      explain: `8% of gross earnings ${money(grossEarningsThisPayMinor || 0)} = ${money(amountMinor)} (shown as a separate, identifiable amount per s28)`,
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Annual-holiday value (vested) — GREATER OF OWP and AWE (§9.5).
 * Unit is WEEKS; apportioned to agreed working days/week for part-week leave.
 * weeksTaken and/or daysTaken supported (days converted via workingDaysPerWeek).
 * ──────────────────────────────────────────────────────────────────────────── */

function valueAnnualHolidayVested({ owp, awe, weeksTaken = 0, daysTaken = 0, workingDaysPerWeek }) {
  const owpUnits = owp ? owp.rateUnits : 0;
  const aweUnits = awe ? awe.rateUnits : 0;
  const weeklyUnits = Math.max(owpUnits, aweUnits);
  const method = weeklyUnits === owpUnits ? 'OWP' : 'AWE';

  // Full weeks pay (round to cents at boundary).
  let amountMinor = rateToCents(weeklyUnits) * weeksTaken;
  let dailyUnits = null;
  if (daysTaken > 0) {
    const wdpw = workingDaysPerWeek || 5;
    dailyUnits = roundHalfUp(weeklyUnits / wdpw); // daily rate from weekly, 4-dp
    amountMinor += rateToCents(dailyUnits) * daysTaken;
  }

  return {
    method: `GREATER_OF_OWP_AWE→${method}`,
    weeklyRateUnits: weeklyUnits,
    weeklyRateMinor: rateToCents(weeklyUnits),
    dailyRateMinor: dailyUnits != null ? rateToCents(dailyUnits) : null,
    amountMinor,
    inputs: { owpUnits, aweUnits, weeksTaken, daysTaken, workingDaysPerWeek: workingDaysPerWeek || 5 },
    reasonCodes: ['ANNUAL_HOLIDAY_VESTED', method === 'OWP' ? 'OWP_GREATER' : 'AWE_GREATER_OR_EQUAL'],
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Public-holiday valuation (§9.7) keyed on the OWD test × worked/not-worked.
 * Returns the pay for the day + whether an alternative (lieu) day is accrued.
 * ──────────────────────────────────────────────────────────────────────────── */

function valuePublicHoliday({ isOWD, worked, hoursWorked = 0, hourlyRateMinor, dailyRateCtx, ruleDate }) {
  const rs = resolveRules(ruleDate);
  const result = { paymentMinor: 0, alternativeDayAccrued: false, reasonCodes: [], method: null };

  if (isOWD && !worked) {
    // Paid the day at RDP (or ADP) — a paid day off; no alternative day.
    const dr = dailyRate(dailyRateCtx || {});
    result.paymentMinor = dr ? rateToCents(dr.rateUnits) : 0;
    result.method = dr ? dr.method : null;
    result.reasonCodes = ['OWD_NOT_WORKED', ...(dr ? dr.reasonCodes : [])];
  } else if (isOWD && worked) {
    // Time-and-a-half for hours worked AND an alternative day.
    result.paymentMinor = roundHalfUp(hoursWorked * hourlyRateMinor * rs.publicHolidayWorkedMultiplier);
    result.alternativeDayAccrued = true;
    result.method = 'TIME_AND_HALF';
    result.reasonCodes = ['OWD_WORKED', 'ALT_DAY_ACCRUED'];
  } else if (!isOWD && worked) {
    // Time-and-a-half for hours worked; NO alternative day.
    result.paymentMinor = roundHalfUp(hoursWorked * hourlyRateMinor * rs.publicHolidayWorkedMultiplier);
    result.method = 'TIME_AND_HALF';
    result.reasonCodes = ['NOT_OWD_WORKED', 'NO_ALT_DAY'];
  } else {
    // Not OWD and didn't work → nothing.
    result.method = 'NONE';
    result.reasonCodes = ['NOT_OWD_NOT_WORKED'];
  }
  return result;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Alternative (lieu) day taken — valued at RDP (or ADP), full day regardless of
 * hours (§9.7).
 * ──────────────────────────────────────────────────────────────────────────── */

function valueAlternativeDay({ dailyRateCtx }) {
  const dr = dailyRate(dailyRateCtx || {});
  if (!dr) return null;
  return {
    method: dr.method,
    amountMinor: rateToCents(dr.rateUnits),
    reasonCodes: ['ALT_DAY_TAKEN', ...dr.reasonCodes],
    inputs: dr.inputs,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The leave-valuation ROUTER (§9.12).
 * valueLeave(leaveType, ctx) → { method, ratePerUnitMinor, amountMinor, window,
 *                                inputs, reasonCodes, anomalies }
 * leaveType ∈ ANNUAL_HOLIDAY_VESTED | ANNUAL_HOLIDAY_PAYG | ANNUAL_HOLIDAY_PRE_ENTITLE
 *           | PUBLIC_HOLIDAY | ALTERNATIVE_DAY | SICK | BEREAVEMENT | FAMILY_VIOLENCE
 * ──────────────────────────────────────────────────────────────────────────── */

function valueLeave(leaveType, ctx = {}) {
  const anomalies = [];
  switch (leaveType) {
    case 'ANNUAL_HOLIDAY_VESTED': {
      const owp = computeOWP(ctx.owp || {});
      const awe = computeAWE(ctx.awe || {});
      const v = valueAnnualHolidayVested({ owp, awe, weeksTaken: ctx.weeksTaken, daysTaken: ctx.daysTaken, workingDaysPerWeek: ctx.workingDaysPerWeek });
      return { leaveType, ...v, owp, awe, window: { owp: owp.inputs, awe: awe.inputs }, anomalies };
    }
    case 'ANNUAL_HOLIDAY_PAYG': {
      const r = computePAYG8({ grossEarningsThisPayMinor: ctx.grossEarningsThisPayMinor, employment: ctx.employment, ruleDate: ctx.ruleDate });
      return { leaveType, method: 'PAYG_8PCT', amountMinor: r.amountMinor, line: r.line, permitted: r.permitted, anomalies: r.anomalies };
    }
    case 'ANNUAL_HOLIDAY_PRE_ENTITLE': {
      // 8% of gross earnings since start (less advances) — termination / pre-anniversary (§9.6, §10).
      const rs = resolveRules(ctx.ruleDate);
      const baseMinor = Math.max(0, (ctx.grossEarningsSinceAnchorMinor || 0) - (ctx.advancesTakenMinor || 0));
      const amountMinor = roundHalfUp(baseMinor * rs.paygRate);
      return { leaveType, method: 'PRO_RATA_8PCT', amountMinor, inputs: { baseMinor, advancesTakenMinor: ctx.advancesTakenMinor || 0 }, reasonCodes: ['PRE_ENTITLEMENT_8PCT'], anomalies };
    }
    case 'PUBLIC_HOLIDAY': {
      const v = valuePublicHoliday(ctx);
      return { leaveType, method: v.method, amountMinor: v.paymentMinor, alternativeDayAccrued: v.alternativeDayAccrued, reasonCodes: v.reasonCodes, anomalies };
    }
    case 'ALTERNATIVE_DAY': {
      const v = valueAlternativeDay(ctx);
      if (!v) return { leaveType, method: null, amountMinor: 0, reasonCodes: ['DAILY_RATE_UNRESOLVED'], anomalies };
      return { leaveType, method: v.method, amountMinor: v.amountMinor, reasonCodes: v.reasonCodes, inputs: v.inputs, anomalies };
    }
    case 'SICK':
    case 'BEREAVEMENT':
    case 'FAMILY_VIOLENCE': {
      // BAPS leave paid at RDP (or ADP if s9A trigger). Whole-day consumption (§9.10).
      const dr = dailyRate(ctx.dailyRateCtx || ctx);
      if (!dr) return { leaveType, method: null, amountMinor: 0, reasonCodes: ['DAILY_RATE_UNRESOLVED'], anomalies };
      const days = ctx.daysTaken != null ? ctx.daysTaken : 1;
      return { leaveType, method: dr.method, ratePerUnitMinor: rateToCents(dr.rateUnits), amountMinor: rateToCents(dr.rateUnits) * days, reasonCodes: [`BAPS_${leaveType}`, ...dr.reasonCodes], inputs: dr.inputs, anomalies };
    }
    default:
      return { leaveType, method: null, amountMinor: 0, reasonCodes: ['UNKNOWN_LEAVE_TYPE'], anomalies: [{ code: 'UNKNOWN_LEAVE_TYPE', severity: 'BLOCKER', message: `Unknown leave type ${leaveType}` }] };
  }
}

module.exports = {
  country: 'NZ',
  rules,
  // Primary router
  valueLeave,
  // The four rate methods (pure, return 4-dp rate-units except payable functions)
  computeOWP,
  computeAWE,
  computeRDP,
  computeADP,
  dailyRate,
  // Annual holiday + public holiday + alt day + PAYG
  valueAnnualHolidayVested,
  valuePublicHoliday,
  valueAlternativeDay,
  computePAYG8,
  // OWD test + mondayisation
  otherwiseWorkingDay,
  mondayiseObservedDate,
  dayOfWeek,
  // helpers / units (for tests)
  _internal: {
    resolveRules, sumGrossEarnings, isGrossEarning, rateToCents, roundHalfUp, money,
    nextDate, isLeap, RATE_SCALE, RATE_PER_CENT, CENTS, RULES,
  },
};
