'use strict';

/*
 * india.calendar.seed.js — the DEFAULT India statutory obligation set (Feature 23
 * §2, as DATA) + the mapping from a tenant's active StatutoryRegistration rows to
 * the ComplianceObligation definitions it should own.
 *
 * PURE. No DB. `buildObligationsForRegistrations(registrations)` takes the plain
 * StatutoryRegistration rows (or {kind, stateCode, effectiveFrom, effectiveTo})
 * and returns the obligation DEFINITION objects to upsert — the calendarRunner /
 * seed route do the actual DB writes.
 *
 * Applicability is STRICTLY registration-driven (the spec's source of truth):
 *   EPF  registration  → IN_PF (monthly ECR), IN_PF_ANNUAL (informational)
 *   ESI  registration  → IN_ESI (monthly), IN_ESI_RETURN (half-yearly, fiscal halves)
 *   TAN  registration  → IN_TDS (monthly, March→30 Apr), IN_FORM24Q→138 (quarterly),
 *                        IN_FORM16→130 (annual certificate)
 *   PT_STATE row (per stateCode) → IN_PT for THAT state (periodicity from meta)
 *   LWF row (per stateCode)      → IN_LWF for THAT state (frequency from meta)
 *
 * The 24Q→138 / 16→130 succession is encoded as specialRules.successor* on a
 * SINGLE obligation family row (the engine flips the kind per period) — we do NOT
 * emit two rows. That keeps the schedule stable across the Income Tax Act 2025
 * boundary and the calendar shows "Form 24Q … becomes Form 138".
 */

// Penalty hints (advisory strings only — never computed). Surfaced in the UX.
const PENALTY = Object.freeze({
  TDS: 'Late deposit → interest 1.5%/month from the deduction date.',
  PF: 'Missed ECR → 12% p.a. interest + damages up to 25% of arrears.',
  ESI: 'Late contribution → 12% p.a. interest.',
  PT: 'State-specific interest + penalty on late deposit.',
  LWF: 'State-specific penalty on late remittance.',
  FORM24Q: 'Late return → ₹200/day (§234E) + penalty up to the TDS amount.',
  FORM16: 'Late issue → ₹100/day per certificate (§272A).',
});

const PORTAL = Object.freeze({
  PF: 'https://unifiedportal-emp.epfindia.gov.in/',
  ESI: 'https://www.esic.gov.in/',
  TDS: 'https://www.incometax.gov.in/',
  TRACES: 'https://www.tdscpc.gov.in/',
});

/**
 * Default per-state PT periodicity hints. The actual periodicity should come from
 * the registration's meta.ptPeriodicity / meta.dueDom when present; these are the
 * fallback defaults for the common states. States with NO PT (Delhi, Haryana, UP,
 * …) simply have no PT_STATE registration and therefore no obligation.
 */
const PT_STATE_DEFAULTS = Object.freeze({
  MH: { periodicity: 'MONTHLY', dueDom: 21 }, // Maharashtra ~21st (last day for some)
  KA: { periodicity: 'MONTHLY', dueDom: 20 }, // Karnataka ~20th
  WB: { periodicity: 'MONTHLY', dueDom: 21 },
  TN: { periodicity: 'HALF_YEARLY', dueDom: 30, dueMonths: [4, 10] }, // Tamil Nadu half-yearly
  GJ: { periodicity: 'MONTHLY', dueDom: 15 },
  AP: { periodicity: 'MONTHLY', dueDom: 10 },
  TG: { periodicity: 'MONTHLY', dueDom: 10 },
});

/** Default LWF frequency per state (fallback when registration meta absent). */
const LWF_STATE_DEFAULTS = Object.freeze({
  MH: { frequency: 'HALF_YEARLY', dueDom: 15, dueMonths: [1, 7] }, // 15 Jan / 15 Jul
  KA: { frequency: 'ANNUAL', dueDom: 15, dueMonths: [1] }, // 15 Jan
  TN: { frequency: 'ANNUAL', dueDom: 31, dueMonths: [1] },
  WB: { frequency: 'HALF_YEARLY', dueDom: 15, dueMonths: [1, 7] },
  GJ: { frequency: 'HALF_YEARLY', dueDom: 15, dueMonths: [1, 7] },
  AP: { frequency: 'ANNUAL', dueDom: 31, dueMonths: [1] },
  TG: { frequency: 'ANNUAL', dueDom: 31, dueMonths: [1] },
  MP: { frequency: 'HALF_YEARLY', dueDom: 15, dueMonths: [1, 7] },
});

/** Coerce a YYYY-MM-DD effectiveFrom from a registration (defaults to its effectiveFrom). */
function effFromOf(reg, fallback) {
  const v = reg && reg.effectiveFrom;
  if (!v) return fallback;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return fallback;
}
function effToOf(reg) {
  const v = reg && reg.effectiveTo;
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return null;
}

/**
 * Obligation templates keyed by the RegistrationKind that gates them. Each fn
 * returns an array of obligation-definition objects (sans businessId/entityId,
 * which the caller stamps). `reg` is the active registration row.
 */
const TEMPLATES = Object.freeze({
  TAN(reg) {
    const ef = effFromOf(reg);
    const et = effToOf(reg);
    return [
      {
        kind: 'IN_TDS', stateCode: null, cadence: 'MONTHLY',
        dueDom: 7, offsetMonths: 1,
        specialRules: { marchDueDom: 30, marchDueMonth: 4 }, // March wage month → 30 Apr
        effectiveFrom: ef, effectiveTo: et,
        reminderDays: [7, 3, 1, 0],
        meta: { label: 'TDS on salary — deposit', penaltyHint: PENALTY.TDS, govtPortalUrl: PORTAL.TDS, form: 'Challan ITNS-281' },
      },
      {
        kind: 'IN_FORM24Q', stateCode: null, cadence: 'QUARTERLY',
        dueDom: 31, offsetMonths: 1,
        // Q4 (period ends 31-Mar) files by 31-May → offset 2 for Q4 only; the engine
        // uses offsetMonths=1 generally and we special-case Q4 via specialRules below.
        specialRules: {
          q4OffsetMonths: 2, // FY-Q4 TDS return is due 31 May (2 months after Mar)
          successorKind: 'IN_FORM138', successorFrom: '2026-04-01', // Income Tax Act 2025
          successorLabel: 'Form 138',
        },
        supersededBy: 'IN_FORM138',
        effectiveFrom: ef, effectiveTo: et,
        reminderDays: [14, 7, 3, 1, 0],
        meta: { label: 'TDS salary return — Form 24Q', penaltyHint: PENALTY.FORM24Q, govtPortalUrl: PORTAL.TRACES, form: 'Form 24Q' },
      },
      {
        kind: 'IN_FORM16', stateCode: null, cadence: 'ANNUAL',
        dueDom: 15, dueMonths: [6], offsetMonths: 0, // 15 Jun following FY end
        specialRules: { successorKind: 'IN_FORM130', successorFrom: '2026-04-01', successorLabel: 'Form 130' },
        supersededBy: 'IN_FORM130',
        effectiveFrom: ef, effectiveTo: et,
        reminderDays: [30, 14, 7, 1, 0],
        meta: { label: 'Form 16 — TDS certificate', penaltyHint: PENALTY.FORM16, govtPortalUrl: PORTAL.TRACES, form: 'Form 16' },
      },
    ];
  },

  EPF(reg) {
    const ef = effFromOf(reg);
    const et = effToOf(reg);
    return [
      {
        kind: 'IN_PF', stateCode: null, cadence: 'MONTHLY',
        dueDom: 15, offsetMonths: 1,
        effectiveFrom: ef, effectiveTo: et,
        reminderDays: [7, 3, 1, 0],
        meta: { label: 'EPF ECR + challan', penaltyHint: PENALTY.PF, govtPortalUrl: PORTAL.PF, form: 'ECR' },
      },
      {
        kind: 'IN_PF_ANNUAL', stateCode: null, cadence: 'ANNUAL',
        dueDom: 30, dueMonths: [4], offsetMonths: 0, // informational tracker (post FY)
        effectiveFrom: ef, effectiveTo: et,
        autoGenerate: false, // optional — off by default; HR can enable
        reminderDays: [14, 3, 0],
        meta: { label: 'EPF annual review (informational)', govtPortalUrl: PORTAL.PF },
      },
    ];
  },

  ESI(reg) {
    const ef = effFromOf(reg);
    const et = effToOf(reg);
    return [
      {
        kind: 'IN_ESI', stateCode: null, cadence: 'MONTHLY',
        dueDom: 15, offsetMonths: 1,
        effectiveFrom: ef, effectiveTo: et,
        reminderDays: [7, 3, 1, 0],
        meta: { label: 'ESI contribution', penaltyHint: PENALTY.ESI, govtPortalUrl: PORTAL.ESI },
      },
      {
        kind: 'IN_ESI_RETURN', stateCode: null, cadence: 'HALF_YEARLY',
        dueDom: 11, dueMonths: [4, 10], // Apr-Sep → 11 Oct ; Oct-Mar → 11 Apr
        specialRules: { halfAnchorMonths: [9, 3] }, // FISCAL halves (Apr-Sep / Oct-Mar)
        effectiveFrom: ef, effectiveTo: et,
        reminderDays: [14, 7, 1, 0],
        meta: { label: 'ESI half-yearly return', penaltyHint: PENALTY.ESI, govtPortalUrl: PORTAL.ESI },
      },
    ];
  },

  PT_STATE(reg) {
    const ef = effFromOf(reg);
    const et = effToOf(reg);
    const state = reg.stateCode || null;
    const m = (reg.meta && typeof reg.meta === 'object') ? reg.meta : {};
    const def = PT_STATE_DEFAULTS[state] || { periodicity: 'MONTHLY', dueDom: 21 };
    const periodicity = (m.ptPeriodicity || def.periodicity || 'MONTHLY').toUpperCase();
    const dueDom = m.dueDom || def.dueDom || 21;
    const cadence = periodicity === 'ANNUAL' ? 'ANNUAL'
      : periodicity === 'HALF_YEARLY' ? 'HALF_YEARLY' : 'MONTHLY';
    const base = {
      kind: 'IN_PT', stateCode: state, cadence,
      dueDom, offsetMonths: 1,
      effectiveFrom: ef, effectiveTo: et,
      reminderDays: [7, 3, 1, 0],
      meta: { label: `Professional Tax — ${state || 'state'}`, penaltyHint: PENALTY.PT, state },
    };
    if (cadence !== 'MONTHLY') {
      base.offsetMonths = 0;
      base.dueMonths = m.dueMonths || def.dueMonths || (cadence === 'ANNUAL' ? [4] : [4, 10]);
    }
    return [base];
  },

  LWF(reg) {
    const ef = effFromOf(reg);
    const et = effToOf(reg);
    const state = reg.stateCode || null;
    const m = (reg.meta && typeof reg.meta === 'object') ? reg.meta : {};
    const def = LWF_STATE_DEFAULTS[state] || { frequency: 'HALF_YEARLY', dueDom: 15, dueMonths: [1, 7] };
    const frequency = (m.lwfFrequency || m.frequency || def.frequency || 'HALF_YEARLY').toUpperCase();
    const cadence = frequency === 'ANNUAL' ? 'ANNUAL'
      : frequency === 'MONTHLY' ? 'MONTHLY' : 'HALF_YEARLY';
    const base = {
      kind: 'IN_LWF', stateCode: state, cadence,
      dueDom: m.dueDom || def.dueDom || 15, offsetMonths: cadence === 'MONTHLY' ? 1 : 0,
      effectiveFrom: ef, effectiveTo: et,
      reminderDays: [14, 7, 1, 0],
      meta: { label: `Labour Welfare Fund — ${state || 'state'}`, penaltyHint: PENALTY.LWF, state },
    };
    if (cadence !== 'MONTHLY') {
      base.dueMonths = m.dueMonths || def.dueMonths || (cadence === 'ANNUAL' ? [1] : [1, 7]);
    }
    return base ? [base] : [];
  },
});

/**
 * buildObligationsForRegistrations(registrations) → obligation-definition objects.
 * Only ACTIVE registrations of a supported kind contribute. Deduped on the natural
 * key (kind, stateCode, effectiveFrom) — the caller upserts on that key.
 */
function buildObligationsForRegistrations(registrations) {
  const out = [];
  const seen = new Set();
  for (const reg of registrations || []) {
    if (!reg || reg.isActive === false) continue;
    const tpl = TEMPLATES[reg.kind];
    if (!tpl) continue; // SHOPS_ESTABLISHMENT / IRD_PAYE / ACC have no IN calendar obligation here
    const defs = tpl(reg) || [];
    for (const d of defs) {
      const key = `${d.kind}|${d.stateCode || ''}|${d.effectiveFrom}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
  }
  return out;
}

module.exports = {
  buildObligationsForRegistrations,
  TEMPLATES,
  PT_STATE_DEFAULTS,
  LWF_STATE_DEFAULTS,
  PENALTY,
  PORTAL,
};
