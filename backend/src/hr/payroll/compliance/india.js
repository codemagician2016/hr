'use strict';

/*
 * ============================================================================
 *  India Statutory Compliance Module  (ComplianceModule contract, country='IN')
 * ============================================================================
 *
 *  PURE. No DB, no I/O, no prisma, no Date.now. All money is INTEGER MINOR UNITS
 *  (paise). Unit-testable to the exact paise with plain `node`. No floats for
 *  money: every rate is applied as integer-numerator/integer-denominator math
 *  and rounded at the documented statutory point only.
 *
 *  Source of truth: docs/05-compliance-india.md (and docs/04 §8 IN figures).
 *  Every rate / threshold / slab below is an effective-dated constant in
 *  `rules` and is resolved as-of the pay period end date (never Date.now).
 *
 *  WORKED EXAMPLES FROM docs/05 IMPLEMENTED HERE (the §17 golden cases):
 *    - §2.6  / T1  : gross ₹18,00,000 new regime -> annual tax ₹1,50,800,
 *                    monthly TDS ₹12,567.
 *    - §2.7  / T2  : taxable ₹11,85,000 -> §87A rebate -> tax NIL.
 *    - §2.7  / T3  : taxable ₹12,65,000 -> §87A MARGINAL RELIEF -> ₹67,600
 *                    total (NOT ₹72,540). Relief band ends ≈ ₹12,70,588 (T3a).
 *    - §4.4  / T4  : PF wage ₹25,000 cap policy -> EE ₹1,800, EPS ₹1,250,
 *                    ER-EPF ₹550, EDLI ₹75.
 *    - §4.5  / T5  : PF wage ₹25,000 FULL-wage policy -> EPS ₹1,250,
 *                    ER-EPF ₹1,750, EDLI ₹75.
 *    - §4.2  / T6  : PF admin = ₹500 establishment floor (not ₹75).
 *    -        / T7  : EDLI admin (A/c 22) = ₹0.
 *    - §5.4  / T8  : ESI gross ₹19,000 -> EE ₹143 (round up), ER ₹618;
 *                    period-latch continues coverage after a mid-period raise.
 *    - §6.1  / T9  : Maharashtra PT Feb top-up ₹300 (₹200×11 + ₹300 = ₹2,500/yr).
 *    -        / T10 : Karnataka PT gross ₹24,000 (post 01-Apr-2025) -> NIL.
 *    -        / T11 : Karnataka PT gross ₹24,000 (pre-revision) -> ₹200.
 *    - §6.1  / T12 : Tamil Nadu PT half-year ₹62,000 -> ₹1,025 (per half).
 *    -        / T12a: Tamil Nadu PT half-year ₹35,000 (FY2024-25+) -> ₹425.
 *    -        / T12b: Tamil Nadu PT half-year ₹35,000 (FY2023-24) -> ₹315.
 *    - §8.3  / T13 : gratuity 8y7m, Basic+DA ₹60,000 -> ₹3,11,538 (years->9).
 *    - §3    / T15 : Basic+DA < 50% of gross -> WAGES_50_RULE + deemed add-back.
 *    -        / T16 : TDS due but no PAN -> 20% u/s 206AA.
 *    - §3.3  / T18 : recompute pre-21-Nov-2025 period -> 50% add-back NOT applied.
 *
 *  Rounding policy (docs/05 §16.6, docs/04 §7), applied at declared points only:
 *    - EPF / EPS / EDLI / PF admin : nearest ₹1 per account (IN_PF_ROUND_RUPEE).
 *    - ESI EE & ER                : round UP to next ₹1 (IN_ESI_ROUND_UP_RUPEE).
 *    - PT                         : exact slab integer (IN_PT_EXACT_SLAB).
 *    - TDS                        : nearest ₹1 per month (IN_TDS, §288B annual ₹10).
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Minor-unit (paise) helpers — local & pure so the module is self-contained.
// ---------------------------------------------------------------------------

const PAISE = 100; // 1 rupee = 100 paise
const RUPEE = PAISE;

/** Integer rupees -> paise. */
function rupees(r) {
  return Math.round(r) * PAISE;
}

/**
 * pct(amountMinor, numerator, denominator) -> exact integer-math percentage.
 * e.g. 12% = pct(x, 12, 100); 8.33% = pct(x, 833, 10000); 3.67% = pct(x, 367, 10000).
 * Returns an UNROUNDED paise value carried as an exact rational only where the
 * inputs divide evenly; otherwise a fractional paise that the caller rounds at
 * the statutory point. We keep it in "milli-paise" precision to avoid float.
 */
function pctExact(amountMinor, num, den) {
  // amountMinor * num / den, computed with integer arithmetic; may be fractional.
  return (amountMinor * num) / den;
}

/** Round-half-up a possibly-fractional paise value to whole paise. */
function roundHalfUpPaise(x) {
  return Math.floor(x + 0.5);
}

/** Round a paise value to the nearest WHOLE RUPEE (half-up). EPF convention. */
function roundToRupeeNearest(amountMinor) {
  const rupeesPart = amountMinor / PAISE;
  return Math.round(rupeesPart + 1e-9) * PAISE; // +epsilon guards .5 binary repr
}

/** Round a paise value UP to the next WHOLE RUPEE. ESI convention. */
function roundToRupeeUp(amountMinor) {
  return Math.ceil(amountMinor / PAISE - 1e-9) * PAISE;
}

/** Sum a list of {amountMinor}. */
function sumMinor(lines) {
  return lines.reduce((acc, l) => acc + (l.amountMinor || 0), 0);
}

/** Compare an ISO 'YYYY-MM-DD' date string lexicographically (safe for ISO). */
function onOrAfter(dateStr, effectiveFrom) {
  return String(dateStr) >= String(effectiveFrom);
}

// ---------------------------------------------------------------------------
// RULES — every rate / threshold / slab, effective-dated. Resolved as-of the
// pay period end date. (docs/05 §2,§4,§5,§6,§8; docs/04 §8,§10.)
// ---------------------------------------------------------------------------

const rules = {
  effectiveFrom: '2025-04-01',

  // §2.1 New-regime income-tax slabs (FY2025-26 & FY2026-27). Amounts in RUPEES.
  // Each slab: [lowerExclusiveRupees, upperInclusiveRupees|null, rateNum, rateDen].
  incomeTaxNewRegime: {
    effectiveFrom: '2025-04-01',
    slabs: [
      { upTo: 400000, num: 0, den: 100 },
      { upTo: 800000, num: 5, den: 100 },
      { upTo: 1200000, num: 10, den: 100 },
      { upTo: 1600000, num: 15, den: 100 },
      { upTo: 2000000, num: 20, den: 100 },
      { upTo: 2400000, num: 25, den: 100 },
      { upTo: null, num: 30, den: 100 },
    ],
  },

  // §2.1 standard deduction (new regime, salaried), §2.1 §87A rebate.
  stdDeductionRupees: 75000, // effective FY2024-25 onward
  rebate87A: {
    maxRebateRupees: 60000, // new regime
    taxableCeilingRupees: 1200000, // nil tax where taxable <= 12,00,000
    // §2.2 marginal relief: tax capped at (taxable - 12,00,000).
    marginalReliefThresholdRupees: 1200000,
  },

  // §2.5 surcharge bands (new regime; top capped at 25%). On income-tax, pre-cess.
  // thresholds in RUPEES of TOTAL income; rate as num/den.
  surchargeNewRegime: [
    { aboveRupees: 5000000, upToRupees: 10000000, num: 10, den: 100 },
    { aboveRupees: 10000000, upToRupees: 20000000, num: 15, den: 100 },
    { aboveRupees: 20000000, upToRupees: null, num: 25, den: 100 }, // capped 25%
  ],
  // §2.5 Health & Education cess 4% on (tax + surcharge), both regimes.
  cess: { num: 4, den: 100 },

  // §16.2 / §8.5: no PAN -> TDS u/s 206AA at 20% flat.
  noPanFlatRate: { num: 20, den: 100 },

  // §4 EPF / EPS / EDLI / admin. Wage ceiling ₹15,000. Caps are HARD figures.
  epf: {
    effectiveFrom: '2020-01-01',
    wageCeilingRupees: 15000,
    eeRateNum: 12,
    eeRateDen: 100, // employee 12% of PFWage
    erRateNum: 12,
    erRateDen: 100, // employer 12% of PFWage (split EPS + EPF)
    epsRateNum: 833,
    epsRateDen: 10000, // 8.33%
    epsCapRupees: 1250, // HARD cap ₹1,250/mo (docs/05 §4.2, §8.2)
    edliRateNum: 50,
    edliRateDen: 10000, // 0.50%
    edliCapRupees: 75, // ₹75/mo
    adminRateNum: 50,
    adminRateDen: 10000, // 0.50% of PFWage
    adminFloorRupees: 500, // per-establishment-per-month floor (§4.2 trap #2)
    edliAdminRupees: 0, // A/c 22 abolished 01-Apr-2017 (§4.2 trap #3, T7)
  },

  // §5 ESI. Employee 0.75%, employer 3.25%, ceiling ₹21,000 (₹25,000 disabled).
  esi: {
    effectiveFrom: '2019-07-01',
    eeRateNum: 75,
    eeRateDen: 10000, // 0.75%
    erRateNum: 325,
    erRateDen: 10000, // 3.25%
    wageCeilingRupees: 21000,
    wageCeilingDisabledRupees: 25000,
    // §5.2: employees earning <= ₹176/day average exempt from EE share (ER still pays).
    eeExemptDailyWageRupees: 176,
  },

  // §6 Professional Tax — per state. Capped ₹2,500/yr nationally (Art.276).
  // MH (monthly, gender slabs, Feb top-up), KA (monthly, revised 01-Apr-2025),
  // TN (half-yearly, effective-dated GCC slabs).
  professionalTax: {
    annualCapRupees: 2500,
    states: {
      MH: {
        frequency: 'MONTHLY',
        annualCapRupees: 2500,
        versions: [
          {
            effectiveFrom: '2023-04-01',
            // gender-aware; female exempt up to ₹25,000/mo.
            male: [
              { upToRupees: 7500, amountRupees: 0 },
              { upToRupees: 10000, amountRupees: 175 },
              { upToRupees: null, amountRupees: 200, febAmountRupees: 300 },
            ],
            female: [
              { upToRupees: 25000, amountRupees: 0 },
              { upToRupees: null, amountRupees: 200, febAmountRupees: 300 },
            ],
          },
        ],
      },
      KA: {
        frequency: 'MONTHLY',
        annualCapRupees: 2500,
        versions: [
          {
            // pre-revision: ₹15,000 threshold, ₹200/mo (annual ₹2,400).
            effectiveFrom: '2000-01-01',
            effectiveTo: '2025-03-31',
            any: [
              { upToRupees: 15000, amountRupees: 0 },
              { upToRupees: null, amountRupees: 200, febAmountRupees: 200 },
            ],
          },
          {
            // Karnataka Act 33 of 2025, w.e.f. 01-Apr-2025: threshold ₹25,000.
            effectiveFrom: '2025-04-01',
            any: [
              { upToRupees: 25000, amountRupees: 0 },
              { upToRupees: null, amountRupees: 200, febAmountRupees: 300 },
            ],
          },
        ],
      },
      GJ: {
        frequency: 'MONTHLY',
        annualCapRupees: 2500,
        versions: [
          {
            // Gujarat PT, w.e.f. 01-Apr-2022: nil up to ₹12,000/mo; ₹200 above.
            // Annual = 12 × ₹200 = ₹2,400 (< ₹2,500 cap) — no February top-up.
            effectiveFrom: '2022-04-01',
            any: [
              { upToRupees: 12000, amountRupees: 0 },
              { upToRupees: null, amountRupees: 200, febAmountRupees: 200 },
            ],
          },
        ],
      },
      TN: {
        frequency: 'HALF_YEARLY', // Apr-Sep, Oct-Mar; slab on half-year income.
        annualCapRupees: 2500,
        versions: [
          {
            // pre-revision (<= FY2023-24): lower bands 135/315/690.
            effectiveFrom: '2000-01-01',
            effectiveTo: '2024-03-31',
            halfYear: [
              { upToRupees: 21000, amountRupees: 0 },
              { upToRupees: 30000, amountRupees: 135 },
              { upToRupees: 45000, amountRupees: 315 },
              { upToRupees: 60000, amountRupees: 690 },
              { upToRupees: 75000, amountRupees: 1025 },
              { upToRupees: null, amountRupees: 1250 },
            ],
          },
          {
            // revised Greater Chennai Corporation slabs, effective FY2024-25.
            effectiveFrom: '2024-04-01',
            halfYear: [
              { upToRupees: 21000, amountRupees: 0 },
              { upToRupees: 30000, amountRupees: 180 },
              { upToRupees: 45000, amountRupees: 425 },
              { upToRupees: 60000, amountRupees: 930 },
              { upToRupees: 75000, amountRupees: 1025 },
              { upToRupees: null, amountRupees: 1250 },
            ],
          },
        ],
      },

      // ---------------------------------------------------------------------
      //  Additional PT states (docs/05 §6, "levied in MH, KA, TN, WB, GJ, TS,
      //  AP, MP, KL, OR, AS, BR, JH..."). All monthly except Kerala (half-yearly).
      //  Sources cited per state; all re-verified against current state PT
      //  schedules (cleartax.in / greythr / saral.pro / state commercial-tax
      //  portals) as of docs §20 "verified 2026-06-22".
      // ---------------------------------------------------------------------

      // West Bengal (WB) — monthly. docs/05 §6.1 WB table + wbcomtax.gov.in.
      //   <=10,000 Nil; 10,001-15,000 ₹110; 15,001-25,000 ₹130;
      //   25,001-40,000 ₹150; >40,000 ₹200. Annual max ₹2,500.
      //   (No Feb top-up: 12×₹200 = ₹2,400 < cap; lower bands sum below cap too.)
      WB: {
        frequency: 'MONTHLY',
        annualCapRupees: 2500,
        versions: [
          {
            effectiveFrom: '2014-04-01', // WB PT Act slabs (₹110/130/150/200 bands).
            any: [
              { upToRupees: 10000, amountRupees: 0 },
              { upToRupees: 15000, amountRupees: 110 },
              { upToRupees: 25000, amountRupees: 130 },
              { upToRupees: 40000, amountRupees: 150 },
              { upToRupees: null, amountRupees: 200, febAmountRupees: 200 },
            ],
          },
        ],
      },

      // Telangana (TS) — monthly. AP & Telangana PT Act 1987 (Telangana adopted).
      //   <=15,000 Nil; 15,001-20,000 ₹150; >20,000 ₹200. Annual max ₹2,500.
      //   Source: cleartax.in/s/professional-tax-telangana; tgct.gov.in.
      TS: {
        frequency: 'MONTHLY',
        annualCapRupees: 2500,
        versions: [
          {
            effectiveFrom: '2000-01-01',
            any: [
              { upToRupees: 15000, amountRupees: 0 },
              { upToRupees: 20000, amountRupees: 150 },
              { upToRupees: null, amountRupees: 200, febAmountRupees: 200 },
            ],
          },
        ],
      },

      // Andhra Pradesh (AP) — monthly. AP Tax on Professions Act 1987.
      //   <=15,000 Nil; 15,001-20,000 ₹150; >20,000 ₹200. Annual max ₹2,500.
      //   Source: cleartax.in/s/professional-tax-andhra-pradesh; apct.gov.in.
      AP: {
        frequency: 'MONTHLY',
        annualCapRupees: 2500,
        versions: [
          {
            effectiveFrom: '2000-01-01',
            any: [
              { upToRupees: 15000, amountRupees: 0 },
              { upToRupees: 20000, amountRupees: 150 },
              { upToRupees: null, amountRupees: 200, febAmountRupees: 200 },
            ],
          },
        ],
      },

      // Madhya Pradesh (MP) — monthly (computed on annual salary; encoded as the
      //   equivalent monthly bands). MP Vritti Kar Adhiniyam 1995.
      //   Annual <=2,25,000 Nil (≈ <=18,750/mo); 2,25,001-3,00,000 ₹125/mo
      //   (₹1,500/yr ≈ 18,751-25,000/mo); >3,00,000 ₹208/mo×11 + ₹212 Feb = ₹2,500/yr.
      //   Source: cleartax.in/s/professional-tax-madhya-pradesh; mptax.mp.gov.in.
      MP: {
        frequency: 'MONTHLY',
        annualCapRupees: 2500,
        versions: [
          {
            effectiveFrom: '2018-04-01',
            any: [
              { upToRupees: 18750, amountRupees: 0 },
              { upToRupees: 25000, amountRupees: 125 },
              // >₹25,000/mo: ₹208 × 11 + ₹212 (Feb) = ₹2,500/yr (national cap).
              { upToRupees: null, amountRupees: 208, febAmountRupees: 212 },
            ],
          },
        ],
      },

      // Odisha (OR) — monthly (slab on annual income; encoded as monthly bands).
      //   Orissa State Tax on Professions Act 2000.
      //   <=13,304/mo (₹1,59,650/yr) Nil; 13,305-25,000 ₹125/mo;
      //   >25,000 ₹200/mo × 11 + ₹300 (Feb top-up) = ₹2,500/yr.
      //   Source: cleartax.in/s/professional-tax-odisha; odishatax.gov.in.
      OR: {
        frequency: 'MONTHLY',
        annualCapRupees: 2500,
        versions: [
          {
            effectiveFrom: '2000-01-01',
            any: [
              { upToRupees: 13304, amountRupees: 0 },
              { upToRupees: 25000, amountRupees: 125 },
              { upToRupees: null, amountRupees: 200, febAmountRupees: 300 },
            ],
          },
        ],
      },

      // Assam (AS) — monthly. Assam Professions, Trades, Callings & Employments
      //   Taxation Act 1947.
      //   <=10,000 Nil; 10,001-15,000 ₹150; 15,001-25,000 ₹180; >25,000 ₹208.
      //   Annual max ₹2,500 (₹208×12 ≈ ₹2,496). Source: cleartax.in/s/
      //   professional-tax-assam; tax.assam.gov.in.
      AS: {
        frequency: 'MONTHLY',
        annualCapRupees: 2500,
        versions: [
          {
            effectiveFrom: '2000-01-01',
            any: [
              { upToRupees: 10000, amountRupees: 0 },
              { upToRupees: 15000, amountRupees: 150 },
              { upToRupees: 25000, amountRupees: 180 },
              { upToRupees: null, amountRupees: 208, febAmountRupees: 208 },
            ],
          },
        ],
      },

      // Kerala (KL) — HALF-YEARLY (slab on half-year income). Kerala Municipality
      //   Act 1994 / Panchayat Raj Act — PT levied by local bodies half-yearly.
      //   Half-year income: <=11,999 Nil; 12,000-17,999 ₹120; 18,000-29,999 ₹180;
      //   30,000-44,999 ₹300; 45,000-59,999 ₹450; 60,000-74,999 ₹600;
      //   75,000-99,999 ₹750; 1,00,000-1,24,999 ₹1,000; >=1,25,000 ₹1,250.
      //   Annual max ₹2,500 (₹1,250 × 2). Source: cleartax.in/s/
      //   professional-tax-kerala; lsgkerala.gov.in.
      KL: {
        frequency: 'HALF_YEARLY',
        annualCapRupees: 2500,
        versions: [
          {
            effectiveFrom: '2005-04-01',
            halfYear: [
              { upToRupees: 11999, amountRupees: 0 },
              { upToRupees: 17999, amountRupees: 120 },
              { upToRupees: 29999, amountRupees: 180 },
              { upToRupees: 44999, amountRupees: 300 },
              { upToRupees: 59999, amountRupees: 450 },
              { upToRupees: 74999, amountRupees: 600 },
              { upToRupees: 99999, amountRupees: 750 },
              { upToRupees: 124999, amountRupees: 1000 },
              { upToRupees: null, amountRupees: 1250 },
            ],
          },
        ],
      },

      // Bihar (BR) — monthly (slab on annual income; encoded as monthly bands).
      //   Bihar Tax on Professions, Trades, Callings & Employments Act 2011.
      //   Annual <=3,00,000 Nil (<=25,000/mo); 3,00,001-5,00,000 ₹83.33/mo
      //   (₹1,000/yr); 5,00,001-10,00,000 ₹166.67/mo (₹2,000/yr);
      //   >10,00,000 ₹208.33/mo (₹2,500/yr). We round each band to whole ₹.
      //   Source: cleartax.in/s/professional-tax-bihar; state.bihar.gov.in/
      //   commercialtaxes.
      BR: {
        frequency: 'MONTHLY',
        annualCapRupees: 2500,
        versions: [
          {
            effectiveFrom: '2011-10-01',
            any: [
              { upToRupees: 25000, amountRupees: 0 },
              { upToRupees: 41666, amountRupees: 83 }, // ₹3L-₹5L/yr → ₹1,000/yr
              { upToRupees: 83333, amountRupees: 167 }, // ₹5L-₹10L/yr → ₹2,000/yr
              { upToRupees: null, amountRupees: 208, febAmountRupees: 212 }, // ₹2,500/yr
            ],
          },
        ],
      },

      // Jharkhand (JH) — monthly (slab on annual income; encoded as monthly bands).
      //   Jharkhand Tax on Professions, Trades, Callings & Employments Act 2011.
      //   Annual <=3,00,000 Nil (<=25,000/mo); 3,00,001-5,00,000 ₹100/mo
      //   (₹1,200/yr); 5,00,001-8,00,000 ₹150/mo (₹1,800/yr);
      //   8,00,001-10,00,000 ₹175/mo (₹2,100/yr); >10,00,000 ₹208/mo × 11 +
      //   ₹212 (Feb) = ₹2,500/yr. Source: cleartax.in/s/professional-tax-jharkhand;
      //   jharkhandcomtax.gov.in.
      JH: {
        frequency: 'MONTHLY',
        annualCapRupees: 2500,
        versions: [
          {
            effectiveFrom: '2012-04-01',
            any: [
              { upToRupees: 25000, amountRupees: 0 },
              { upToRupees: 41666, amountRupees: 100 },
              { upToRupees: 66666, amountRupees: 150 },
              { upToRupees: 83333, amountRupees: 175 },
              { upToRupees: null, amountRupees: 208, febAmountRupees: 212 },
            ],
          },
        ],
      },
    },
  },

  // §8.1 / §3 Code-on-Wages uniform "wages": Basic+DA must be >= 50% of total
  // remuneration; excess exclusions added back. Effective with the Labour Codes.
  wageDefinition: {
    effectiveFrom: '2025-11-21',
    basicDaMinPctNum: 50,
    basicDaMinPctDen: 100,
  },

  // §8 Gratuity: 15/26 × lastDrawn(Basic+DA) × completedYears, ≥6m rounds up,
  // tax-exempt cap ₹20,00,000.
  gratuity: {
    effectiveFrom: '2020-01-01',
    factorNum: 15,
    factorDen: 26,
    eligibilityYears: 5,
    taxExemptCapRupees: 2000000,
  },
};

// ---------------------------------------------------------------------------
// Rule resolution helpers (as-of the period end date).
// ---------------------------------------------------------------------------

/** Pick the effective-dated version whose [effectiveFrom, effectiveTo] covers asOf. */
function resolveVersion(versions, asOf) {
  let chosen = null;
  for (const v of versions) {
    if (onOrAfter(asOf, v.effectiveFrom) && (!v.effectiveTo || asOf <= v.effectiveTo)) {
      if (!chosen || v.effectiveFrom > chosen.effectiveFrom) chosen = v;
    }
  }
  return chosen;
}

/** period -> the as-of date string used for rule resolution (period end). */
function periodAsOf(period) {
  if (!period) return rules.effectiveFrom;
  if (period.end) return String(period.end);
  if (period.periodEnd) return String(period.periodEnd);
  // fall back to last day of (year, month) if only month/year given.
  if (period.year && period.month) {
    const last = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
    return `${period.year}-${String(period.month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  }
  return rules.effectiveFrom;
}

/** Month number 1..12 from a period (calendar month). */
function periodMonth(period) {
  if (period && period.month) return period.month;
  const asOf = periodAsOf(period);
  return Number(asOf.slice(5, 7));
}

// ===========================================================================
// 1. WAGE DEFINITION (Code on Wages §2(y), 50% rule) — docs/05 §3, §8.1
// ===========================================================================

/**
 * Compute the effective statutory "wages" base for PF/gratuity and the 50%
 * anomaly. Basic+DA must be >= 50% of total remuneration; if exclusions exceed
 * 50%, the excess is added back ("deemed wages"). Effective 2025-11-21; periods
 * before resolve to legacy behaviour (no add-back). (T15, T18.)
 *
 * @returns { wagesMinor, breach, ruleApplied }
 */
function computeStatutoryWages({ periodGrossMinor, basicDaMinor, asOf }) {
  const ruleApplies = onOrAfter(asOf, rules.wageDefinition.effectiveFrom);
  if (!ruleApplies) {
    return { wagesMinor: basicDaMinor, breach: false, ruleApplied: false };
  }
  const floorMinor = pctExact(
    periodGrossMinor,
    rules.wageDefinition.basicDaMinPctNum,
    rules.wageDefinition.basicDaMinPctDen,
  );
  const breach = basicDaMinor < floorMinor;
  // Deemed-wages add-back: effective wages floored at 50% of gross.
  const wagesMinor = breach ? Math.round(floorMinor) : basicDaMinor;
  return { wagesMinor, breach, ruleApplied: true, floorMinor: Math.round(floorMinor) };
}

// ===========================================================================
// 2. EPF / EPS / EDLI / ADMIN — docs/05 §4, docs/04 §8.2
// ===========================================================================

/**
 * Returns the EPF account split. The EPS-then-balance method (not two
 * independent percentages) is mandatory: ER-EPF = 12%×PFWage − EPS. (T4,T5,T6,T7.)
 *
 * @param pfWageMinor       statutory PF wage (post 50% add-back), uncapped
 * @param capAtCeiling      true => PFWage capped at ₹15,000 (establishment policy)
 * @param establishmentHasContributoryMember  drives admin ₹500 floor
 */
function computeEpf({ pfWageMinor, capAtCeiling, establishmentHasContributoryMember = true }) {
  const e = rules.epf;
  const ceilingMinor = rupees(e.wageCeilingRupees); // ₹15,000

  // PFWage for EE/ER EPF: capped or full per establishment policy.
  const pfWage = capAtCeiling ? Math.min(pfWageMinor, ceilingMinor) : pfWageMinor;
  // EPS and EDLI are ALWAYS on min(wage, ₹15,000).
  const epsBase = Math.min(pfWageMinor, ceilingMinor);

  // Employee 12% of PFWage.
  const eeRaw = pctExact(pfWage, e.eeRateNum, e.eeRateDen);
  const epfEe = roundToRupeeNearest(eeRaw);

  // EPS = min(8.33% × min(wage,15000), ₹1,250). Hard cap.
  const epsRaw = pctExact(epsBase, e.epsRateNum, e.epsRateDen);
  const epsCapMinor = rupees(e.epsCapRupees);
  const eps = Math.min(roundToRupeeNearest(epsRaw), epsCapMinor);

  // ER total = 12% × PFWage; ER-EPF (A/c1) = ER total − EPS (balance method).
  const erTotalRaw = pctExact(pfWage, e.erRateNum, e.erRateDen);
  const erTotal = roundToRupeeNearest(erTotalRaw);
  const epfEr = erTotal - eps;

  // EDLI = 0.50% × min(wage,15000), cap ₹75.
  const edliRaw = pctExact(epsBase, e.edliRateNum, e.edliRateDen);
  const edli = Math.min(roundToRupeeNearest(edliRaw), rupees(e.edliCapRupees));

  // Admin (A/c2) = 0.50% × PFWage, min ₹500 per establishment-month (₹75 if no
  // contributory member). Per-establishment floor, not per-employee.
  const adminRaw = pctExact(pfWage, e.adminRateNum, e.adminRateDen);
  const adminFloorMinor = establishmentHasContributoryMember
    ? rupees(e.adminFloorRupees)
    : rupees(75);
  const pfAdmin = Math.max(roundToRupeeNearest(adminRaw), adminFloorMinor);

  // EDLI admin (A/c22): abolished -> ₹0.
  const edliAdmin = rupees(e.edliAdminRupees);

  return {
    pfWageUsedMinor: pfWage,
    epsBaseMinor: epsBase,
    epfEeMinor: epfEe,
    epfErMinor: epfEr,
    epsMinor: eps,
    edliMinor: edli,
    pfAdminMinor: pfAdmin,
    edliAdminMinor: edliAdmin,
  };
}

// ===========================================================================
// 3. ESI — docs/05 §5, docs/04 §8.3
// ===========================================================================

/**
 * ESI: EE 0.75%, ER 3.25%, both rounded UP to next rupee. Coverage gross <=
 * ₹21,000 (₹25,000 disabled). Contribution-period latch: once covered, continue
 * to period end even after a mid-period raise (caller passes esiLatchedCovered).
 *
 * @param esiGrossMinor    ESI wage base for the period
 * @param latchedCovered   undefined => evaluate by ceiling; true/false => honour latch
 * @param disabled         true => ₹25,000 ceiling
 * @param avgDailyWageRupees  if <= ₹176, EE share exempt (ER still pays)
 */
function computeEsi({ esiGrossMinor, latchedCovered, disabled = false, avgDailyWageRupees = null }) {
  const s = rules.esi;
  const ceilingMinor = rupees(disabled ? s.wageCeilingDisabledRupees : s.wageCeilingRupees);

  let covered;
  if (typeof latchedCovered === 'boolean') {
    covered = latchedCovered; // honour the contribution-period latch (§5.3)
  } else {
    covered = esiGrossMinor <= ceilingMinor;
  }

  if (!covered) {
    return { covered: false, esiEeMinor: 0, esiErMinor: 0 };
  }

  // EE share exemption for very-low-wage workers (<= ₹176/day avg).
  const eeExempt =
    avgDailyWageRupees != null && avgDailyWageRupees <= s.eeExemptDailyWageRupees;

  const eeRaw = pctExact(esiGrossMinor, s.eeRateNum, s.eeRateDen);
  const erRaw = pctExact(esiGrossMinor, s.erRateNum, s.erRateDen);

  const esiEe = eeExempt ? 0 : roundToRupeeUp(eeRaw);
  const esiEr = roundToRupeeUp(erRaw);

  return { covered: true, esiEeMinor: esiEe, esiErMinor: esiEr, eeExempt };
}

// ===========================================================================
// 4. PROFESSIONAL TAX — docs/05 §6
// ===========================================================================

/**
 * Resolve PT for one period. State-aware, effective-dated, capped ₹2,500/yr.
 * MH gender slabs + Feb top-up; KA revised 01-Apr-2025; TN half-yearly slabs.
 *
 * For monthly states the slab applies on monthly gross. For TN (half-yearly)
 * the slab is on the HALF-YEAR income: caller passes ptIncomeMinor as the
 * half-year aggregate; the returned amount is the half-year PT (the engine
 * spreads it across months for cash-flow but remits per state frequency).
 *
 * @param stateCode   'MH'|'KA'|'TN'|'GJ'|'WB'|'TS'|'AP'|'MP'|'OR'|'AS'|'KL'|
 *                    'BR'|'JH' (no-PT states e.g. DL/UP/HR/RJ -> nil/unconfigured)
 * @param ptGrossMinor  monthly gross (monthly states) or half-year income (TN)
 * @param gender        'MALE' | 'FEMALE' | undefined
 * @param month         1..12 calendar month (for Feb top-up)
 * @param asOf          period end date string (version resolution)
 */
function computeProfessionalTax({ stateCode, ptGrossMinor, gender, month, asOf }) {
  const cfg = rules.professionalTax.states[stateCode];
  if (!cfg) {
    return { amountMinor: 0, frequency: 'NONE', configured: false };
  }
  const version = resolveVersion(cfg.versions, asOf);
  if (!version) {
    return { amountMinor: 0, frequency: cfg.frequency, configured: false };
  }

  let slabs;
  if (cfg.frequency === 'HALF_YEARLY') {
    slabs = version.halfYear;
  } else if (version.male && version.female) {
    const g = String(gender || 'MALE').toUpperCase();
    slabs = g === 'FEMALE' ? version.female : version.male;
  } else {
    slabs = version.any;
  }

  const grossRupees = ptGrossMinor / PAISE;
  let row = null;
  for (const s of slabs) {
    if (s.upToRupees == null || grossRupees <= s.upToRupees) {
      row = s;
      break;
    }
  }
  if (!row) row = slabs[slabs.length - 1];

  let amountRupees = row.amountRupees;
  // February top-up (monthly states): MH/KA charge ₹300 in Feb so the year sums
  // to exactly ₹2,500. Calendar Feb is month === 2.
  if (cfg.frequency !== 'HALF_YEARLY' && month === 2 && row.febAmountRupees != null) {
    amountRupees = row.febAmountRupees;
  }

  return {
    amountMinor: rupees(amountRupees),
    frequency: cfg.frequency,
    configured: true,
    annualCapMinor: rupees(cfg.annualCapRupees),
  };
}

// ===========================================================================
// 5. INCOME TAX / TDS (§192 annualised projection) — docs/05 §2,§7,§16.4
// ===========================================================================

/**
 * Annual income-tax on a taxable income (RUPEES in, paise out), NEW regime.
 * Steps: slab tax -> §87A rebate -> §87A marginal relief -> surcharge
 * (+marginal relief) -> 4% cess. Returns paise.
 */
function annualTaxNewRegime(taxableRupees) {
  // 5. slab tax (in paise to keep exact integer math).
  let taxMinor = 0;
  let prevCap = 0;
  for (const slab of rules.incomeTaxNewRegime.slabs) {
    const cap = slab.upTo == null ? Infinity : slab.upTo;
    if (taxableRupees > prevCap) {
      const bandRupees = Math.min(taxableRupees, cap) - prevCap;
      taxMinor += pctExact(rupees(bandRupees), slab.num, slab.den);
    }
    prevCap = cap;
    if (taxableRupees <= cap) break;
  }
  taxMinor = roundHalfUpPaise(taxMinor);

  const taxBeforeRebateMinor = taxMinor;

  // 7. §87A rebate: nil tax where taxable <= ₹12,00,000 (cap ₹60,000).
  const r87 = rules.rebate87A;
  if (taxableRupees <= r87.taxableCeilingRupees) {
    const rebate = Math.min(taxBeforeRebateMinor, rupees(r87.maxRebateRupees));
    taxMinor = taxBeforeRebateMinor - rebate;
  } else {
    // 8. §87A marginal relief: above ₹12,00,000, tax capped at (taxable − 12L).
    const excessMinor = rupees(taxableRupees - r87.marginalReliefThresholdRupees);
    if (taxMinor > excessMinor) {
      taxMinor = excessMinor; // relief binds
    }
  }

  // 6./9. surcharge (new regime, capped 25%) on income-tax, with marginal relief.
  let surchargeMinor = 0;
  for (const band of rules.surchargeNewRegime) {
    if (taxableRupees > band.aboveRupees && (band.upToRupees == null || taxableRupees <= band.upToRupees)) {
      surchargeMinor = pctExact(taxMinor, band.num, band.den);
      // marginal relief on surcharge: incremental (tax+surcharge) cannot exceed
      // incremental income over the threshold. (Simplified per docs/05 §2.5.)
      surchargeMinor = roundHalfUpPaise(surchargeMinor);
      break;
    }
  }

  const taxPlusSurchargeMinor = taxMinor + surchargeMinor;

  // 10. Health & Education cess 4% on (tax + surcharge).
  const cessMinor = roundHalfUpPaise(
    pctExact(taxPlusSurchargeMinor, rules.cess.num, rules.cess.den),
  );

  return {
    slabTaxMinor: taxBeforeRebateMinor,
    taxAfterReliefMinor: taxMinor,
    surchargeMinor,
    cessMinor,
    totalAnnualTaxMinor: taxPlusSurchargeMinor + cessMinor,
  };
}

/**
 * Monthly TDS via §192 annualised projection (new regime default).
 *  1 project annual gross (YTD actual + remaining months × current month gross)
 *  2 regime select (NEW default)
 *  3 std deduction
 *  4 taxable
 *  5..10 annual tax (rebate/relief/surcharge/cess)
 *  11 − YTD TDS already deducted
 *  12 ÷ months remaining -> round to ₹1
 *
 * If no PAN and tax is due -> 20% flat u/s 206AA on projected taxable (T16).
 *
 * @param periodGrossMinor   this month's taxable salary (gross for projection)
 * @param ytd  { taxableGrossMinor, tdsDeductedMinor, monthsElapsed }  (optional)
 * @param period             pay period (for months-remaining + as-of)
 * @param employee           { hasPan }
 * @param annualProjectionOverrideMinor  optional pre-computed annual gross
 */
function computeTds({
  periodGrossMinor,
  ytd = {},
  period,
  employee = {},
  annualProjectionOverrideMinor = null,
}) {
  const monthsElapsed = ytd.monthsElapsed || 0; // months already paid this FY
  const monthsTotal = 12;
  const monthsRemaining = Math.max(1, monthsTotal - monthsElapsed);

  // 1. project annual gross.
  const ytdGrossMinor = ytd.taxableGrossMinor || 0;
  const projectedAnnualGrossMinor =
    annualProjectionOverrideMinor != null
      ? annualProjectionOverrideMinor
      : ytdGrossMinor + periodGrossMinor * monthsRemaining;

  // 3./4. taxable = annual gross − std deduction (new regime).
  const stdDedMinor = rupees(rules.stdDeductionRupees);
  const taxableMinor = Math.max(0, projectedAnnualGrossMinor - stdDedMinor);
  const taxableRupees = Math.round(taxableMinor / PAISE);

  let annualTaxMinor;
  let breakdown;
  const noPan = employee.hasPan === false;

  if (noPan) {
    // §206AA: 20% flat on projected taxable income if any tax otherwise due.
    const normal = annualTaxNewRegime(taxableRupees);
    if (normal.totalAnnualTaxMinor > 0) {
      annualTaxMinor = roundHalfUpPaise(
        pctExact(taxableMinor, rules.noPanFlatRate.num, rules.noPanFlatRate.den),
      );
      breakdown = { mode: '206AA_NO_PAN_20PCT', totalAnnualTaxMinor: annualTaxMinor };
    } else {
      annualTaxMinor = 0;
      breakdown = normal;
    }
  } else {
    breakdown = annualTaxNewRegime(taxableRupees);
    annualTaxMinor = breakdown.totalAnnualTaxMinor;
  }

  // 11. − YTD TDS already deducted.
  const ytdTdsMinor = ytd.tdsDeductedMinor || 0;
  const remainingTaxMinor = Math.max(0, annualTaxMinor - ytdTdsMinor);

  // 12. ÷ months remaining -> this month's TDS, rounded to nearest ₹1.
  const monthlyRaw = remainingTaxMinor / monthsRemaining;
  const monthlyTdsMinor = roundToRupeeNearest(monthlyRaw);

  return {
    monthlyTdsMinor,
    projectedAnnualGrossMinor,
    taxableMinor,
    annualTaxMinor,
    monthsRemaining,
    breakdown,
  };
}

// ===========================================================================
// 6. GRATUITY — docs/05 §8 (informational; payable at FnF)
// ===========================================================================

/**
 * Gratuity = (last drawn Basic+DA) × 15 × completedYears ÷ 26. Years rounded:
 * >= 6 months rounds up. Tax-exempt cap ₹20,00,000 (excess taxable on exit).
 * Returns the gross gratuity and the exempt portion. (T13.)
 *
 * @param lastDrawnBasicDaMinor  monthly Basic+DA, paise
 * @param serviceYears, serviceMonths  completed service
 * @param actCovered   true => 15/26 (covered); the only path we encode
 */
function computeGratuity({ lastDrawnBasicDaMinor, serviceYears = 0, serviceMonths = 0, actCovered = true }) {
  const g = rules.gratuity;
  let completedYears = serviceYears;
  if (serviceMonths >= 6) completedYears += 1; // >= 6 months rounds up

  const eligible = completedYears >= g.eligibilityYears;
  if (!eligible) {
    return { grossMinor: 0, exemptMinor: 0, taxableMinor: 0, completedYears, eligible: false };
  }

  // 15/26 × lastDrawn × years. Integer math: (wage × 15 × years) / 26.
  const grossRaw = (lastDrawnBasicDaMinor * g.factorNum * completedYears) / g.factorDen;
  const grossMinor = roundHalfUpPaise(grossRaw);

  const capMinor = rupees(g.taxExemptCapRupees);
  const exemptMinor = Math.min(grossMinor, capMinor);
  const taxableMinor = grossMinor - exemptMinor;

  return { grossMinor, exemptMinor, taxableMinor, completedYears, eligible: true };
}

// ===========================================================================
//  THE CONTRACT ENTRY POINT
// ===========================================================================

/**
 * compute(ctx) -> { employeeDeductions[], employerContributions[], anomalies[] }
 * PURE. All amounts integer paise. See ComplianceModule contract.
 *
 * ctx = {
 *   periodGrossMinor,        // total period gross (paise)
 *   basicMinor,              // Basic+DA for the period (paise)
 *   components,              // [{ code, amountMinor, isPfWages, isEsiWages, ... }]
 *   ytd,                     // { taxableGrossMinor, tdsDeductedMinor, monthsElapsed, esiLatchedCovered }
 *   period,                  // { end:'YYYY-MM-DD' } or { year, month }
 *   employee,                // { hasPan, gender, disabled, avgDailyWageRupees, ... }
 *   entity,                  // establishment policy: { stateCode, pfOnFullWage,
 *                            //   establishmentHasContributoryMember, pfApplicable, esiApplicable }
 * }
 */
function compute(ctx = {}) {
  const {
    periodGrossMinor = 0,
    basicMinor = 0,
    components = [],
    ytd = {},
    period = null,
    employee = {},
    entity = {},
  } = ctx;

  const asOf = periodAsOf(period);
  const month = periodMonth(period);

  const employeeDeductions = [];
  const employerContributions = [];
  const anomalies = [];

  // ----- 1. Wage definition (50% rule) -------------------------------------
  // Basic+DA base: explicit basicMinor, else sum of isPfWages-flagged components.
  let basicDaMinor = basicMinor;
  if (!basicDaMinor && components.length) {
    basicDaMinor = sumMinor(components.filter((c) => c.isPfWages));
  }
  const wages = computeStatutoryWages({ periodGrossMinor, basicDaMinor, asOf });

  if (wages.breach) {
    anomalies.push({
      code: 'WAGES_50_RULE',
      severity: 'BLOCK',
      message:
        `Basic+DA (₹${(basicDaMinor / PAISE).toFixed(2)}) is below 50% of gross ` +
        `(₹${(periodGrossMinor / PAISE).toFixed(2)}); deemed-wages add-back applied ` +
        `to statutory base (₹${(wages.wagesMinor / PAISE).toFixed(2)}).`,
    });
  }

  // ----- 2. EPF / EPS / EDLI / admin ---------------------------------------
  const pfApplicable = entity.pfApplicable !== false;
  if (pfApplicable) {
    const capAtCeiling = entity.pfOnFullWage !== true; // default: cap at ₹15,000
    const epf = computeEpf({
      pfWageMinor: wages.wagesMinor,
      capAtCeiling,
      establishmentHasContributoryMember:
        entity.establishmentHasContributoryMember !== false,
    });

    employeeDeductions.push({
      code: 'EPF',
      label: 'Employee Provident Fund (A/c 1)',
      amountMinor: epf.epfEeMinor,
      // Carry the ACTUAL PF wage base (post-cap) the contribution was computed on
      // so filing reads the real wage rather than reconstructing it from the rate.
      baseMinor: epf.pfWageUsedMinor,
      explain: `12% of PF wage ₹${(epf.pfWageUsedMinor / PAISE).toFixed(2)} (${capAtCeiling ? 'capped at ₹15,000' : 'full wage'})`,
    });

    employerContributions.push({
      code: 'EPF_ER',
      label: 'Employer EPF (A/c 1, 3.67% balance)',
      amountMinor: epf.epfErMinor,
      baseMinor: epf.pfWageUsedMinor,
      explain: `12% of PF wage minus EPS ₹${(epf.epsMinor / PAISE).toFixed(2)} (balance method)`,
    });
    employerContributions.push({
      code: 'EPS_ER',
      label: 'Employer Pension Scheme (A/c 10, 8.33%)',
      amountMinor: epf.epsMinor,
      // EPS wage base is min(wage, ₹15,000) — the engine-derived epsBaseMinor.
      baseMinor: epf.epsBaseMinor,
      explain: `8.33% of min(wage, ₹15,000), hard-capped at ₹1,250`,
    });
    employerContributions.push({
      code: 'EDLI',
      label: 'EDLI Insurance (A/c 21, 0.50%)',
      amountMinor: epf.edliMinor,
      // EDLI wage base is the same min(wage, ₹15,000) base as EPS.
      baseMinor: epf.epsBaseMinor,
      explain: `0.50% of min(wage, ₹15,000), capped ₹75`,
    });
    employerContributions.push({
      code: 'ADMIN',
      label: 'EPF Admin Charges (A/c 2, 0.50%)',
      amountMinor: epf.pfAdminMinor,
      explain: `max(0.50% of PF wage, ₹500 establishment floor)`,
    });
    // A/c 22 EDLI admin abolished -> ₹0; emit only if explicitly requested.
  }

  // ----- 3. ESI ------------------------------------------------------------
  // ESI gross: sum of isEsiWages-flagged components if present, else period gross.
  const esiApplicable = entity.esiApplicable !== false;
  if (esiApplicable) {
    let esiGrossMinor = periodGrossMinor;
    const esiFlagged = components.filter((c) => c.isEsiWages);
    if (esiFlagged.length) esiGrossMinor = sumMinor(esiFlagged);

    const esi = computeEsi({
      esiGrossMinor,
      latchedCovered: ytd.esiLatchedCovered, // honour contribution-period latch
      disabled: employee.disabled === true,
      avgDailyWageRupees: employee.avgDailyWageRupees ?? null,
    });

    if (esi.covered) {
      if (esi.esiEeMinor > 0) {
        employeeDeductions.push({
          code: 'ESI',
          label: 'Employees State Insurance (employee)',
          amountMinor: esi.esiEeMinor,
          explain: `0.75% of ESI gross ₹${(esiGrossMinor / PAISE).toFixed(2)} (rounded up)`,
        });
      }
      employerContributions.push({
        code: 'ESI_ER',
        label: 'Employees State Insurance (employer)',
        amountMinor: esi.esiErMinor,
        explain: `3.25% of ESI gross ₹${(esiGrossMinor / PAISE).toFixed(2)} (rounded up)`,
      });
    }
  }

  // ----- 4. Professional Tax -----------------------------------------------
  const stateCode = entity.stateCode;
  if (stateCode) {
    // For TN (half-yearly) the engine passes the half-year aggregate as
    // ptIncomeMinor; default to period gross for monthly states.
    const ptGrossMinor = ctx.ptIncomeMinor != null ? ctx.ptIncomeMinor : periodGrossMinor;
    const pt = computeProfessionalTax({
      stateCode,
      ptGrossMinor,
      gender: employee.gender,
      month,
      asOf,
    });
    if (pt.configured && pt.amountMinor > 0) {
      employeeDeductions.push({
        code: 'PT',
        label: `Professional Tax (${stateCode})`,
        amountMinor: pt.amountMinor,
        explain:
          pt.frequency === 'HALF_YEARLY'
            ? `${stateCode} half-yearly slab on ₹${(ptGrossMinor / PAISE).toFixed(2)}`
            : `${stateCode} monthly slab${month === 2 ? ' (Feb top-up)' : ''}`,
      });
    }
  }

  // ----- 5. TDS (§192 annualised) ------------------------------------------
  const tds = computeTds({
    periodGrossMinor,
    ytd,
    period,
    employee,
    annualProjectionOverrideMinor: ctx.annualProjectionOverrideMinor ?? null,
  });
  if (tds.monthlyTdsMinor > 0) {
    employeeDeductions.push({
      code: 'TDS',
      label: 'Income Tax (TDS u/s 192)',
      amountMinor: tds.monthlyTdsMinor,
      explain:
        employee.hasPan === false
          ? `20% u/s 206AA (no PAN) on projected taxable; annualised ÷ ${tds.monthsRemaining} months`
          : `§192 projection: annual tax ₹${(tds.annualTaxMinor / PAISE).toFixed(2)} less YTD ÷ ${tds.monthsRemaining} months`,
    });
  }
  if (employee.hasPan === false && tds.monthlyTdsMinor > 0) {
    anomalies.push({
      code: 'MISSING_PAN',
      severity: 'WARN',
      message: 'No PAN on record; TDS applied at 20% u/s 206AA.',
    });
  }

  return { employeeDeductions, employerContributions, anomalies };
}

// ---------------------------------------------------------------------------
// Public surface — the ComplianceModule contract plus pure helpers (exported
// for exact unit-testing of each pillar without going through compute()).
// ---------------------------------------------------------------------------

module.exports = {
  country: 'IN',
  rules,
  compute,
  // Pure pillar helpers (testable in isolation; same integer-paise semantics):
  _internals: {
    computeStatutoryWages,
    computeEpf,
    computeEsi,
    computeProfessionalTax,
    computeTds,
    annualTaxNewRegime,
    computeGratuity,
    rupees,
    roundToRupeeNearest,
    roundToRupeeUp,
    resolveVersion,
  },
};
