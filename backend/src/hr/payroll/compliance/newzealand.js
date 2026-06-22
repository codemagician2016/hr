'use strict';

/**
 * New Zealand statutory ComplianceModule — PURE, integer CENTS minor-units.
 * No DB, no I/O, no Date.now in the math. Unit-testable with plain `node`.
 *
 * Implements docs/06-compliance-newzealand.md:
 *   - PAYE: annualised periodic method (§2.2), tax codes M/ME/S/SH/ST/SB/SA/ND (§2.3),
 *           extra-pay/bonus method (§2.4), IETC for ME (§2.3 note).
 *   - KiwiSaver: employee + employer default 3.5% from 1 Apr 2026 (§4.1),
 *               ESCT tiers (§4.4), temporary rate reduction (§4.1), 16-17yo employer
 *               contributions, redundancy/lump-sum exclusions (kiwisaverLiable).
 *   - ACC earners' levy: 1.75% on first $156,641 (max $2,741.22), YTD cap (§5).
 *   - Student loan: 12% over the pay-period threshold; secondary codes = 12% no threshold;
 *               SLCIR / SLBOR extras (§6).
 *   - Minimum wage floor: $23.95/hr adult, $19.16 starting-out/training; MINWAGE_FLOOR (§8).
 *
 * Effective-dated rules: the payment date (period.paymentDate) governs which rate set
 * applies — IRD and ACC both key off payment date (§1.3). A pay run straddling
 * 31 Mar / 1 Apr therefore uses the NEW rates if paid on/after 1 Apr 2026.
 *
 * Worked examples reproduced exactly by the smoke tests / matching this module:
 *   §4.5  KiwiSaver+ESCT: $2,000/fn, 3.5%/3.5%, prior-year $52,000 → tier 17.5%:
 *         EE KS $70.00, ER gross $70.00, ESCT $12.25, ER net $57.75.
 *   §5.4  ACC cap: $13,200/mo, M code; month crossing cap charges 1.75% on $11,441
 *         = $200.22; total annual ACC = $2,741.22 (statutory max).
 *   §6.3  Student loan: M SL, $600/wk → (600-464)*12% = $16.32; +SLCIR $20 → $36.32.
 *
 * MONEY: all amounts are plain JS integers in CENTS (safe to 2^53). NEVER floats for money.
 * Rounding happens only at documented points (round-half-up, IRD convention, §2.6).
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Effective-dated rule sets. Keyed by NZ tax-year boundary (1 Apr). The resolver
 * picks the row whose effectiveFrom <= paymentDate (latest such row).
 * All money thresholds are stored in CENTS.
 * ──────────────────────────────────────────────────────────────────────────── */

const C = 100; // cents per dollar

// PAYE annual income-tax brackets (annual, NZD cents). Unchanged for 2025-26 & 2026-27.
const PAYE_BRACKETS = [
  { upToMinor: 15600 * C, rate: 0.105 },
  { upToMinor: 53500 * C, rate: 0.175 },
  { upToMinor: 78100 * C, rate: 0.30 },
  { upToMinor: 180000 * C, rate: 0.33 },
  { upToMinor: null, rate: 0.39 }, // 180,001+
];

// ESCT tiers (prior-year income thresholds, annual NZD cents). Unchanged 2025-26 & 2026-27.
const ESCT_TIERS = [
  { upToMinor: 16800 * C, rate: 0.105 },
  { upToMinor: 57600 * C, rate: 0.175 },
  { upToMinor: 84000 * C, rate: 0.30 },
  { upToMinor: 216000 * C, rate: 0.33 },
  { upToMinor: null, rate: 0.39 }, // 216,001+
];

const RULES = [
  {
    effectiveFrom: '2025-04-01',
    label: 'NZ-FY2025-26',
    payeBrackets: PAYE_BRACKETS,
    esctTiers: ESCT_TIERS,
    // ACC earners' levy
    accLevyRate: 0.0167, // $1.67 / $100
    accMaxLiableMinor: 152790 * C,
    // KiwiSaver
    ksDefaultEmployeeRate: 0.03,
    ksDefaultEmployerRate: 0.03,
    ksAllowedEmployeeRates: [0.03, 0.04, 0.06, 0.08, 0.10],
    ksEmployerContribMinAge: 18, // employer compulsory contributions from 18 (16-17 not required pre-1 Apr 2026)
    ksEmployerContribMaxAge: 65,
    // Student loan
    studentLoanRate: 0.12,
    studentLoanThresholds: {
      WEEKLY: 46400, FORTNIGHTLY: 92800, FOUR_WEEKLY: 185600, MONTHLY: 201067,
    },
    // Minimum wage (cents/hr)
    minWageAdultMinor: 2350, // $23.50
    minWageStartingOutMinor: 1880, // $18.80
    minWageTrainingMinor: 1880,
    // No-notification (ND) income-tax rate
    ndIncomeTaxRate: 0.45,
    // IETC (Independent Earner Tax Credit) — annual figures
    ietc: { amountMinor: 520 * C, lowerMinor: 24000 * C, abateStartMinor: 66000 * C, abateRate: 0.13, upperMinor: 70000 * C },
  },
  {
    effectiveFrom: '2026-04-01',
    label: 'NZ-FY2026-27',
    payeBrackets: PAYE_BRACKETS,
    esctTiers: ESCT_TIERS,
    accLevyRate: 0.0175, // $1.75 / $100 (GST-inclusive published rate)
    accMaxLiableMinor: 156641 * C, // $156,641 → max annual levy $2,741.22
    ksDefaultEmployeeRate: 0.035,
    ksDefaultEmployerRate: 0.035,
    ksAllowedEmployeeRates: [0.035, 0.04, 0.06, 0.08, 0.10, 0.03], // 3% allowed via temporary rate reduction
    ksEmployerContribMinAge: 16, // 16-17yo employer contributions REQUIRED from 1 Apr 2026
    ksEmployerContribMaxAge: 65,
    studentLoanRate: 0.12,
    studentLoanThresholds: {
      WEEKLY: 46400, FORTNIGHTLY: 92800, FOUR_WEEKLY: 185600, MONTHLY: 201067,
    },
    minWageAdultMinor: 2395, // $23.95
    minWageStartingOutMinor: 1916, // $19.16 (80% of adult)
    minWageTrainingMinor: 1916,
    ndIncomeTaxRate: 0.45,
    ietc: { amountMinor: 520 * C, lowerMinor: 24000 * C, abateStartMinor: 66000 * C, abateRate: 0.13, upperMinor: 70000 * C },
  },
];

const rules = { effectiveFrom: '2026-04-01' }; // current default exposed on the module

// Periods per year per frequency (for annualise / de-annualise, §2.2).
const PERIODS_PER_YEAR = {
  WEEKLY: 52, FORTNIGHTLY: 26, FOUR_WEEKLY: 13, SEMI_MONTHLY: 24, MONTHLY: 12,
};

/* ────────────────────────────────────────────────────────────────────────────
 * Pure helpers
 * ──────────────────────────────────────────────────────────────────────────── */

// Round-half-up to a whole integer of cents (IRD convention for tax, §2.6).
// Operates on a fractional cents value; ties (.5) go away from zero.
function roundHalfUp(value) {
  if (value < 0) return -Math.round(-value);
  return Math.round(value);
}

// Apply a rate to an integer-cents base and round-half-up to whole cents.
function applyRate(baseMinor, rate) {
  return roundHalfUp(baseMinor * rate);
}

// Resolve the effective rule set for a payment date (YYYY-MM-DD). Latest
// effectiveFrom that is <= paymentDate. Defaults to the latest if none given.
function resolveRules(paymentDate) {
  let chosen = RULES[0];
  for (const r of RULES) {
    if (!paymentDate || r.effectiveFrom <= paymentDate) chosen = r;
  }
  return chosen;
}

// Progressive bracket tax over an annual taxable amount (cents) → annual tax (cents, unrounded).
function progressiveTax(annualMinor, brackets) {
  let tax = 0;
  let lower = 0;
  for (const b of brackets) {
    const upper = b.upToMinor == null ? Infinity : b.upToMinor;
    if (annualMinor > lower) {
      const slice = Math.min(annualMinor, upper) - lower;
      tax += slice * b.rate;
    }
    lower = upper;
    if (annualMinor <= upper) break;
  }
  return tax;
}

// Marginal rate that an annual income falls into (for the extra-pay method, §2.4).
function marginalRate(annualMinor, brackets) {
  for (const b of brackets) {
    if (b.upToMinor == null || annualMinor <= b.upToMinor) return b.rate;
  }
  return brackets[brackets.length - 1].rate;
}

// ESCT rate for an employee given prior-year (or estimated-annual) income (cents).
function esctRateFor(priorYearIncomeMinor, tiers) {
  for (const t of tiers) {
    if (t.upToMinor == null || priorYearIncomeMinor <= t.upToMinor) return t.rate;
  }
  return tiers[tiers.length - 1].rate;
}

// IETC annual credit (cents) for an annualised income, ME-type codes only (§2.3 note).
function ietcAnnual(annualMinor, ietc) {
  if (annualMinor < ietc.lowerMinor) return 0;
  if (annualMinor <= ietc.abateStartMinor) return ietc.amountMinor;
  if (annualMinor >= ietc.upperMinor) return 0;
  const overMinor = annualMinor - ietc.abateStartMinor;
  const abated = ietc.amountMinor - overMinor * ietc.abateRate;
  return Math.max(0, abated);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Tax-code classification
 * ──────────────────────────────────────────────────────────────────────────── */

// Secondary flat rates already include ACC in the published rate (don't double-levy, §2.3).
const SECONDARY_FLAT = {
  SB: 0.105, S: 0.175, SH: 0.30, ST: 0.33, SA: 0.39,
};

// Parse "M SL", "ME", "S SL", "ST", "ND" etc. → { base, hasSL }.
// Strips an optional trailing " SL" (student-loan flag) from the tax code.
function parseTaxCode(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  const hasSL = /\bSL$/.test(code);
  const base = hasSL ? code.replace(/\s*SL$/, '').trim() : code;
  return { base, hasSL };
}

function isPrimaryCode(base) {
  return base === 'M' || base === 'ME';
}

/* ────────────────────────────────────────────────────────────────────────────
 * Component helpers — line-type flags drive what is liable for what (§9.2 design rule).
 * Each component: { code, amountMinor, accLiable, kiwisaverLiable, discretionary,
 *                   payeable, extraPay } (all optional, sensible defaults).
 * ──────────────────────────────────────────────────────────────────────────── */

function liableSum(components, flag, dflt) {
  let total = 0;
  for (const c of components || []) {
    const amt = c.amountMinor || 0;
    const liable = c[flag] === undefined ? dflt : c[flag];
    if (liable) total += amt;
  }
  return total;
}

function extraPaySum(components) {
  let total = 0;
  for (const c of components || []) {
    if (c.extraPay && (c.payeable === undefined ? true : c.payeable)) total += c.amountMinor || 0;
  }
  return total;
}

/* ────────────────────────────────────────────────────────────────────────────
 * PAYE — annualised periodic method + extra-pay method (§2.2, §2.4)
 * ──────────────────────────────────────────────────────────────────────────── */

function computePaye({ rs, taxCode, frequency, ordinaryPayeMinor, extraPayMinor, accLiableMinor, ytdAccLiableMinor, employee }) {
  const { base, hasSL } = parseTaxCode(taxCode);
  const ppy = PERIODS_PER_YEAR[frequency] || PERIODS_PER_YEAR.FORTNIGHTLY;
  const explainParts = [];

  // ND — no notification: 45% income tax + ACC = 46.75% total PAYE (§2.3, §15.4).
  if (base === 'ND') {
    const incomeTax = applyRate(ordinaryPayeMinor + extraPayMinor, rs.ndIncomeTaxRate);
    // ACC still applies (subject to YTD cap) on the ND code (it's an employee/primary-style path).
    const acc = computeAcc({ rs, accLiableMinor, ytdAccLiableMinor });
    const total = incomeTax + acc.amountMinor;
    return {
      payeMinor: total,
      incomeTaxMinor: incomeTax,
      accMinor: acc.amountMinor,
      accThisPeriodLiableMinor: acc.liableThisPeriodMinor,
      explain: `ND no-notification: income tax 45% of ${money(ordinaryPayeMinor + extraPayMinor)} = ${money(incomeTax)} + ACC ${money(acc.amountMinor)} = ${money(total)} (46.75% total PAYE)`,
    };
  }

  // Secondary flat-rate codes (SB/S/SH/ST/SA): flat rate, ACC embedded — no separate levy (§2.3).
  if (SECONDARY_FLAT[base] !== undefined) {
    const rate = SECONDARY_FLAT[base];
    const incomeTax = applyRate(ordinaryPayeMinor + extraPayMinor, rate);
    return {
      payeMinor: incomeTax,
      incomeTaxMinor: incomeTax,
      accMinor: 0, // embedded in the secondary published rate
      accThisPeriodLiableMinor: 0,
      explain: `Secondary code ${base}: flat ${(rate * 100).toFixed(1)}% of ${money(ordinaryPayeMinor + extraPayMinor)} = ${money(incomeTax)} (ACC embedded in secondary rate)`,
    };
  }

  // Primary codes M / ME (+ SL handled separately): annualised periodic method.
  // 1. Annualise ordinary taxable pay.
  const annualised = ordinaryPayeMinor * ppy;
  // 2. Progressive bracket tax (annual).
  let annualTax = progressiveTax(annualised, rs.payeBrackets);
  // 3. IETC for ME codes (annualised, then de-annualised with PAYE).
  if (base === 'ME') {
    const credit = ietcAnnual(annualised, rs.ietc);
    annualTax = Math.max(0, annualTax - credit);
    explainParts.push(`IETC credit ${money(credit / ppy)}/period`);
  }
  // 4. De-annualise income tax.
  const periodIncomeTax = roundHalfUp(annualTax / ppy);

  // 5. ACC earners' levy on M/ME (primary) up to the YTD cap (§5.3). Added to PAYE.
  const acc = computeAcc({ rs, accLiableMinor, ytdAccLiableMinor });

  // 6. Extra pay (bonus/back-pay) taxed by the extra-pay method (§2.4), NOT annualised.
  let extraTax = 0;
  if (extraPayMinor > 0) {
    // Estimated annual income = grossed-up ordinary pay (period × ppy) + the extra pay.
    const estAnnual = annualised + extraPayMinor;
    const rate = marginalRate(estAnnual, rs.payeBrackets);
    extraTax = applyRate(extraPayMinor, rate);
    explainParts.push(`extra pay ${money(extraPayMinor)} @ marginal ${(rate * 100).toFixed(1)}% = ${money(extraTax)}`);
  }

  const total = periodIncomeTax + acc.amountMinor + extraTax;
  return {
    payeMinor: total,
    incomeTaxMinor: periodIncomeTax + extraTax,
    accMinor: acc.amountMinor,
    accThisPeriodLiableMinor: acc.liableThisPeriodMinor,
    explain: `${base}: income tax (annualised ${money(annualised)} → ${money(periodIncomeTax)}/period) + ACC ${money(acc.amountMinor)}${extraTax ? ' + ' + money(extraTax) + ' extra-pay' : ''} = ${money(total)}${explainParts.length ? ' [' + explainParts.join('; ') + ']' : ''}`,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * ACC earners' levy with YTD cap (§5.3)
 *   remainingCap   = max(0, maxLiable - ytdAccLiable)
 *   liableThis     = min(periodAccLiable, remainingCap)
 *   acc            = liableThis × rate
 * ──────────────────────────────────────────────────────────────────────────── */

function computeAcc({ rs, accLiableMinor, ytdAccLiableMinor }) {
  const remainingCap = Math.max(0, rs.accMaxLiableMinor - (ytdAccLiableMinor || 0));
  const liableThis = Math.min(accLiableMinor || 0, remainingCap);
  const amountMinor = applyRate(liableThis, rs.accLevyRate);
  return { amountMinor, liableThisPeriodMinor: liableThis, remainingCapMinor: remainingCap };
}

/* ────────────────────────────────────────────────────────────────────────────
 * KiwiSaver employee + employer + ESCT (§4)
 * ──────────────────────────────────────────────────────────────────────────── */

function computeKiwiSaver({ rs, ksWagesMinor, employee, ytd, period, anomalies }) {
  const ks = (employee && employee.kiwiSaver) || {};
  if (ks.status && ['OPTED_OUT', 'NOT_MEMBER', 'SUSPENDED'].includes(ks.status)) {
    return null; // no deductions / no employer contribution while opted-out, not a member, or on savings suspension
  }

  // Employee rate: election, or temporary rate reduction (3%), or rule-set default.
  let employeeRate = ks.employeeRate != null ? ks.employeeRate : rs.ksDefaultEmployeeRate;
  const trr = ks.temporaryRateReduction;
  if (trr && trr.rate != null) {
    const expiry = trr.expiry || '9999-12-31';
    if ((period && period.paymentDate ? period.paymentDate : '9999-12-31') <= expiry) {
      employeeRate = trr.rate; // typically 3%
    }
  }
  // KS_RATE_MISMATCH: employee below the current default without a valid opt-down (§14).
  if (employeeRate < rs.ksDefaultEmployeeRate && !(trr && trr.rate === employeeRate)) {
    anomalies.push({ code: 'KS_RATE_MISMATCH', severity: 'WARNING', message: `Employee KiwiSaver rate ${(employeeRate * 100).toFixed(2)}% below default ${(rs.ksDefaultEmployeeRate * 100).toFixed(2)}% without a valid temporary rate reduction` });
  }

  // Employer rate: max(elected, rule minimum). Employer minimum is NOT reduced by an
  // employee's temporary rate reduction (§4.1).
  const employerRate = Math.max(ks.employerRate != null ? ks.employerRate : rs.ksDefaultEmployerRate, rs.ksDefaultEmployerRate);

  // Age eligibility for compulsory employer contribution (16-65 from 1 Apr 2026, else 18-65).
  const age = ageAt(employee && employee.dateOfBirth, period && period.paymentDate);
  let employerEligible = true;
  if (age != null) {
    if (age < rs.ksEmployerContribMinAge || age > rs.ksEmployerContribMaxAge) employerEligible = false;
  }

  const employeeDeductionMinor = applyRate(ksWagesMinor, employeeRate);

  let employerGrossMinor = 0;
  let esctMinor = 0;
  let employerNetMinor = 0;
  if (employerEligible) {
    employerGrossMinor = applyRate(ksWagesMinor, employerRate);
    // ESCT tier from prior-year income (set-and-forget) or estimated annual for new hires.
    const priorYear = (ytd && ytd.priorYearTaxableIncomeMinor != null)
      ? ytd.priorYearTaxableIncomeMinor
      : estimateAnnualForEsct(ksWagesMinor, employerGrossMinor, period);
    const esctRate = (ks.esctRateForYear != null) ? ks.esctRateForYear : esctRateFor(priorYear, rs.esctTiers);
    esctMinor = applyRate(employerGrossMinor, esctRate); // ESCT on EMPLOYER contribution only (never employee side, §4.3)
    employerNetMinor = employerGrossMinor - esctMinor;
  }

  return {
    employeeRate,
    employerRate,
    employeeDeductionMinor,
    employerGrossMinor,
    esctMinor,
    employerNetMinor,
    employerEligible,
  };
}

function estimateAnnualForEsct(ksWagesMinor, employerGrossMinor, period) {
  const ppy = PERIODS_PER_YEAR[(period && period.frequency) || 'FORTNIGHTLY'] || 26;
  return ksWagesMinor * ppy + employerGrossMinor * ppy;
}

// Age in whole years at a date (both YYYY-MM-DD). Returns null if either missing.
function ageAt(dob, atDate) {
  if (!dob || !atDate) return null;
  const [by, bm, bd] = String(dob).split('-').map(Number);
  const [ay, am, ad] = String(atDate).split('-').map(Number);
  if (!by || !ay) return null;
  let age = ay - by;
  if (am < bm || (am === bm && ad < bd)) age -= 1;
  return age;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Student loan (§6)
 * ──────────────────────────────────────────────────────────────────────────── */

function computeStudentLoan({ rs, taxCode, frequency, slGrossMinor, employee }) {
  const { base, hasSL } = parseTaxCode(taxCode);
  if (!hasSL) return null;

  const sec = SECONDARY_FLAT[base] !== undefined;
  let standardMinor;
  if (sec) {
    // Secondary income: 12% of every dollar, no threshold (§6.1).
    standardMinor = applyRate(slGrossMinor, rs.studentLoanRate);
  } else {
    const threshold = rs.studentLoanThresholds[frequency] != null ? rs.studentLoanThresholds[frequency] : rs.studentLoanThresholds.WEEKLY;
    const over = Math.max(0, slGrossMinor - threshold);
    standardMinor = applyRate(over, rs.studentLoanRate);
  }

  // Extra deductions: SLCIR (Commissioner) and SLBOR (Borrower voluntary), on top of standard.
  const sl = (employee && employee.studentLoan) || {};
  const slcirMinor = sl.slcirPerPeriodMinor || 0;
  const slborMinor = sl.slborPerPeriodMinor || 0;

  return {
    standardMinor,
    slcirMinor,
    slborMinor,
    totalMinor: standardMinor + slcirMinor + slborMinor,
    secondary: sec,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Minimum wage floor (§8) — MINWAGE_FLOOR anomaly
 * ──────────────────────────────────────────────────────────────────────────── */

function checkMinWage({ rs, employee, period, ordinaryEarningsMinor, hoursWorked, anomalies }) {
  const hours = hoursWorked != null ? hoursWorked
    : (period && period.hoursWorked != null ? period.hoursWorked : null);
  if (!hours || hours <= 0) return;

  const category = (employee && employee.minWageCategory) || 'ADULT';
  let floorMinor = rs.minWageAdultMinor;
  if (category === 'STARTING_OUT') floorMinor = rs.minWageStartingOutMinor;
  else if (category === 'TRAINING') floorMinor = rs.minWageTrainingMinor;

  // effectiveHourlyRate = gross ordinary pay ÷ hours worked (cents/hr).
  const effectiveHourly = ordinaryEarningsMinor / hours;
  if (effectiveHourly < floorMinor) {
    anomalies.push({
      code: 'MINWAGE_FLOOR',
      severity: 'BLOCKER',
      message: `Effective rate ${money(roundHalfUp(effectiveHourly))}/hr below ${category} minimum wage ${money(floorMinor)}/hr (${hours}h worked, ${money(ordinaryEarningsMinor)} ordinary pay)`,
    });
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Formatting helper for explain strings ($X.XX from cents).
 * ──────────────────────────────────────────────────────────────────────────── */

function money(cents) {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const c = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}$${dollars.toLocaleString('en-NZ')}.${c}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The contract entrypoint.
 * compute({ periodGrossMinor, basicMinor, components, ytd, period, employee, entity })
 *   → { employeeDeductions[], employerContributions[], anomalies[] }
 * All amounts in CENTS.
 * ──────────────────────────────────────────────────────────────────────────── */

function compute(input) {
  const {
    periodGrossMinor = 0,
    basicMinor = 0,
    components = [],
    ytd = {},
    period = {},
    employee = {},
    entity = {},
  } = input || {};

  const anomalies = [];
  const employeeDeductions = [];
  const employerContributions = [];

  const paymentDate = period.paymentDate || (entity && entity.paymentDate) || null;
  const rs = resolveRules(paymentDate);
  const frequency = period.frequency || 'FORTNIGHTLY';
  const taxCode = (employee.taxCode) || 'M';

  // ── Build statutory bases from component flags (flag-driven, never name-driven). ──
  // Default: every component is PAYE-able, ACC-liable, KiwiSaver-liable unless flagged off.
  // If no components supplied, fall back to periodGrossMinor for all bases.
  const hasComponents = Array.isArray(components) && components.length > 0;

  const payeableMinor = hasComponents
    ? liableSum(components, 'payeable', true)
    : periodGrossMinor;
  const extraPayMinor = hasComponents ? extraPaySum(components) : 0;
  // Ordinary (non-extra-pay) PAYE-able earnings.
  const ordinaryPayeMinor = Math.max(0, payeableMinor - extraPayMinor);

  const accLiableMinor = hasComponents
    ? liableSum(components, 'accLiable', true)
    : periodGrossMinor;
  const ksWagesMinor = hasComponents
    ? liableSum(components, 'kiwisaverLiable', true)
    : periodGrossMinor;

  const ytdAccLiableMinor = ytd.accLiableEarningsMinor || 0;

  // ── PAYE (income tax + ACC, or flat secondary, or ND) ──
  const paye = computePaye({
    rs, taxCode, frequency, ordinaryPayeMinor, extraPayMinor,
    accLiableMinor, ytdAccLiableMinor, employee,
  });
  employeeDeductions.push({
    code: 'PAYE',
    label: 'PAYE (income tax + ACC earners’ levy)',
    amountMinor: paye.payeMinor,
    explain: paye.explain,
  });

  // ── KiwiSaver employee deduction + employer contribution + ESCT ──
  const ks = computeKiwiSaver({ rs, ksWagesMinor, employee, ytd, period, anomalies });
  if (ks) {
    employeeDeductions.push({
      code: 'KIWISAVER',
      label: 'KiwiSaver employee contribution',
      amountMinor: ks.employeeDeductionMinor,
      explain: `KiwiSaver employee ${(ks.employeeRate * 100).toFixed(2)}% of ${money(ksWagesMinor)} = ${money(ks.employeeDeductionMinor)}`,
    });
    if (ks.employerEligible) {
      employerContributions.push({
        code: 'KIWISAVER_ER',
        label: 'KiwiSaver employer contribution (gross)',
        amountMinor: ks.employerGrossMinor,
        explain: `KiwiSaver employer ${(ks.employerRate * 100).toFixed(2)}% of ${money(ksWagesMinor)} = ${money(ks.employerGrossMinor)} (gross, before ESCT)`,
      });
      employerContributions.push({
        code: 'ESCT',
        label: 'Employer Superannuation Contribution Tax',
        amountMinor: ks.esctMinor,
        explain: `ESCT on employer gross ${money(ks.employerGrossMinor)} = ${money(ks.esctMinor)} (to IRD); net to scheme ${money(ks.employerNetMinor)}`,
      });
    }
  }

  // ── ACC employer line: NZ ACC earners' levy is an EMPLOYEE deduction via PAYE.
  // The "ACC" employer-facing item in the contract list is the levy already folded into
  // PAYE; we also surface it as an explicit informational employer line so the EI return
  // and payslip can identify the ACC component (§3.2, §11). Amount = 0 here to avoid
  // double counting (the cash sits inside PAYE); the value is reported via explain.
  employerContributions.push({
    code: 'ACC',
    label: 'ACC earners’ levy (component of PAYE)',
    amountMinor: 0,
    explain: `ACC earners’ levy ${money(paye.accMinor)} is collected through PAYE (rate ${(rs.accLevyRate * 100).toFixed(2)}%, liable this period ${money(paye.accThisPeriodLiableMinor)}, YTD cap ${money(rs.accMaxLiableMinor)})`,
  });

  // ── Student loan ──
  const slr = computeStudentLoan({ rs, taxCode, frequency, slGrossMinor: ordinaryPayeMinor + extraPayMinor, employee });
  if (slr) {
    employeeDeductions.push({
      code: 'SLOAN',
      label: 'Student loan',
      amountMinor: slr.totalMinor,
      explain: slr.secondary
        ? `Student loan 12% of ${money(ordinaryPayeMinor + extraPayMinor)} (secondary, no threshold) = ${money(slr.standardMinor)}${slr.slcirMinor ? ' + SLCIR ' + money(slr.slcirMinor) : ''}${slr.slborMinor ? ' + SLBOR ' + money(slr.slborMinor) : ''} = ${money(slr.totalMinor)}`
        : `Student loan 12% over ${frequency} threshold = ${money(slr.standardMinor)}${slr.slcirMinor ? ' + SLCIR ' + money(slr.slcirMinor) : ''}${slr.slborMinor ? ' + SLBOR ' + money(slr.slborMinor) : ''} = ${money(slr.totalMinor)}`,
    });
  }

  // ── Minimum-wage floor check ──
  checkMinWage({
    rs, employee, period,
    ordinaryEarningsMinor: hasComponents ? liableSum(components, 'owpOrdinary', true) : (basicMinor || periodGrossMinor),
    hoursWorked: period.hoursWorked,
    anomalies,
  });

  // ── YTD deltas (informational, for the persistence layer to apply at LOCK) ──
  const ytdDeltas = {
    accLiableEarningsMinor: paye.accThisPeriodLiableMinor || 0,
  };

  return { employeeDeductions, employerContributions, anomalies, ytdDeltas };
}

module.exports = {
  country: 'NZ',
  rules,
  compute,
  // Exposed pure helpers for unit tests / the engine's parity (golden) tests.
  _internal: {
    resolveRules,
    progressiveTax,
    marginalRate,
    esctRateFor,
    ietcAnnual,
    computePaye,
    computeAcc,
    computeKiwiSaver,
    computeStudentLoan,
    parseTaxCode,
    roundHalfUp,
    applyRate,
    money,
    PERIODS_PER_YEAR,
    RULES,
  },
};
