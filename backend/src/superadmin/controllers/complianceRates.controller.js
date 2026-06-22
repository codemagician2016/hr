//
// complianceRates.controller.js — platform-owner (super-admin) compliance console.
//
// Read-only view of the EFFECTIVE statutory rates that the payroll engine binds
// to, sourced directly from the pure compliance modules' exported `rules`
// (and, for NZ, the effective-dated `RULES` rows). This is what the super-admin
// "compliance rules" console renders so an operator can eyeball the live rate
// set per country without touching code.
//
// NOTHING here mutates state. The compliance modules are pure (no DB, no I/O);
// we simply project their exported rule objects into a stable JSON shape.
//
// Mounted under /api/admin (requireAuth + requireSuperAdmin), so RBAC is
// SUPER_ADMIN by construction (see superadmin/routes/admin.routes.js).
//
const IN = require('../../hr/payroll/compliance/india');
const NZ = require('../../hr/payroll/compliance/newzealand');

// Display helper: a rate as a percentage, trimmed of binary-float noise (the
// engine itself uses exact integer math; this is presentation only).
function pct(value) {
  return Math.round(value * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// India projection — EPF / ESI / PT (per state) / TDS slabs / gratuity.
// All money figures are reported in RUPEES (the india.js `rules` object stores
// statutory thresholds/slabs in whole rupees; the engine converts to paise).
// ---------------------------------------------------------------------------
function indiaRates() {
  const r = IN.rules;

  // PT: flatten the per-state versioned slab config into a display-friendly map.
  const professionalTax = {
    annualCapRupees: r.professionalTax.annualCapRupees,
    states: Object.entries(r.professionalTax.states).map(([stateCode, cfg]) => ({
      stateCode,
      frequency: cfg.frequency,
      annualCapRupees: cfg.annualCapRupees,
      versions: cfg.versions.map((v) => ({
        effectiveFrom: v.effectiveFrom,
        effectiveTo: v.effectiveTo || null,
        // Expose whichever slab shape this version uses (any / male+female / halfYear).
        slabs: v.any || v.halfYear || null,
        male: v.male || null,
        female: v.female || null,
      })),
    })),
  };

  return {
    country: 'IN',
    effectiveFrom: r.effectiveFrom,
    currency: 'INR',
    incomeTax: {
      newRegime: {
        effectiveFrom: r.incomeTaxNewRegime.effectiveFrom,
        slabs: r.incomeTaxNewRegime.slabs.map((s) => ({
          upToRupees: s.upTo,
          ratePct: pct((s.num / s.den) * 100),
        })),
      },
      stdDeductionRupees: r.stdDeductionRupees,
      rebate87A: r.rebate87A,
      surchargeNewRegime: r.surchargeNewRegime.map((b) => ({
        aboveRupees: b.aboveRupees,
        upToRupees: b.upToRupees,
        ratePct: pct((b.num / b.den) * 100),
      })),
      cessPct: pct((r.cess.num / r.cess.den) * 100),
      noPanFlatRatePct: pct((r.noPanFlatRate.num / r.noPanFlatRate.den) * 100),
    },
    epf: {
      effectiveFrom: r.epf.effectiveFrom,
      wageCeilingRupees: r.epf.wageCeilingRupees,
      employeeRatePct: pct((r.epf.eeRateNum / r.epf.eeRateDen) * 100),
      employerRatePct: pct((r.epf.erRateNum / r.epf.erRateDen) * 100),
      epsRatePct: pct((r.epf.epsRateNum / r.epf.epsRateDen) * 100),
      epsCapRupees: r.epf.epsCapRupees,
      edliRatePct: pct((r.epf.edliRateNum / r.epf.edliRateDen) * 100),
      edliCapRupees: r.epf.edliCapRupees,
      adminRatePct: pct((r.epf.adminRateNum / r.epf.adminRateDen) * 100),
      adminFloorRupees: r.epf.adminFloorRupees,
      edliAdminRupees: r.epf.edliAdminRupees,
    },
    esi: {
      effectiveFrom: r.esi.effectiveFrom,
      employeeRatePct: pct((r.esi.eeRateNum / r.esi.eeRateDen) * 100),
      employerRatePct: pct((r.esi.erRateNum / r.esi.erRateDen) * 100),
      wageCeilingRupees: r.esi.wageCeilingRupees,
      wageCeilingDisabledRupees: r.esi.wageCeilingDisabledRupees,
      eeExemptDailyWageRupees: r.esi.eeExemptDailyWageRupees,
    },
    professionalTax,
    gratuity: {
      effectiveFrom: r.gratuity.effectiveFrom,
      factor: `${r.gratuity.factorNum}/${r.gratuity.factorDen}`,
      eligibilityYears: r.gratuity.eligibilityYears,
      taxExemptCapRupees: r.gratuity.taxExemptCapRupees,
    },
    wageDefinition: {
      effectiveFrom: r.wageDefinition.effectiveFrom,
      basicDaMinPct: pct((r.wageDefinition.basicDaMinPctNum / r.wageDefinition.basicDaMinPctDen) * 100),
    },
  };
}

// ---------------------------------------------------------------------------
// New Zealand projection — KiwiSaver / ACC / PAYE / student loan.
// NZ stores effective-dated rows in `_internal.RULES`; money figures are in
// NZD cents (we report both the raw cents and a dollars view where helpful).
// ---------------------------------------------------------------------------
function nzRates() {
  const C = 100; // cents per dollar
  const rows = (NZ._internal && NZ._internal.RULES) || [];

  return {
    country: 'NZ',
    effectiveFrom: NZ.rules.effectiveFrom,
    currency: 'NZD',
    versions: rows.map((rs) => ({
      effectiveFrom: rs.effectiveFrom,
      label: rs.label,
      paye: {
        brackets: rs.payeBrackets.map((b) => ({
          upToDollars: b.upToMinor == null ? null : b.upToMinor / C,
          ratePct: pct(b.rate * 100),
        })),
        ndIncomeTaxRatePct: pct(rs.ndIncomeTaxRate * 100),
        ietc: rs.ietc
          ? {
              amountDollars: rs.ietc.amountMinor / C,
              abateStartDollars: rs.ietc.abateStartMinor / C,
              abateRatePct: pct(rs.ietc.abateRate * 100),
              upperDollars: rs.ietc.upperMinor / C,
            }
          : null,
      },
      kiwiSaver: {
        defaultEmployeeRatePct: pct(rs.ksDefaultEmployeeRate * 100),
        defaultEmployerRatePct: pct(rs.ksDefaultEmployerRate * 100),
        allowedEmployeeRatesPct: rs.ksAllowedEmployeeRates.map((x) => pct(x * 100)),
        employerContribMinAge: rs.ksEmployerContribMinAge,
        employerContribMaxAge: rs.ksEmployerContribMaxAge,
        esctTiers: rs.esctTiers.map((t) => ({
          upToDollars: t.upToMinor == null ? null : t.upToMinor / C,
          ratePct: pct(t.rate * 100),
        })),
      },
      acc: {
        levyRatePct: pct(rs.accLevyRate * 100),
        maxLiableDollars: rs.accMaxLiableMinor / C,
      },
      studentLoan: {
        ratePct: pct(rs.studentLoanRate * 100),
        thresholds: rs.studentLoanThresholds, // per-frequency cents
      },
      minimumWage: {
        adultDollarsPerHour: rs.minWageAdultMinor / C,
        startingOutDollarsPerHour: rs.minWageStartingOutMinor / C,
        trainingDollarsPerHour: rs.minWageTrainingMinor / C,
      },
    })),
  };
}

const PROJECTORS = {
  IN: indiaRates,
  NZ: nzRates,
};

// GET /api/admin/compliance/rates?country=IN|NZ
// Read-only effective statutory rate set for the super-admin compliance console.
async function getComplianceRates(req, res) {
  const country = String(req.query.country || '').trim().toUpperCase();
  if (!country) {
    return res.status(400).json({ message: 'country query param is required (IN | NZ).' });
  }
  const projector = PROJECTORS[country];
  if (!projector) {
    return res.status(400).json({
      message: `Unsupported country '${country}'. Supported: ${Object.keys(PROJECTORS).join(', ')}.`,
    });
  }
  return res.json({ country, rates: projector() });
}

module.exports = { getComplianceRates, indiaRates, nzRates };
