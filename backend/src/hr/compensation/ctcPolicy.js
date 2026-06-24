'use strict';

/**
 * ctcPolicy.js — PURE compile/validate/seed for the friendly CTC-policy builder
 * (Feature 17). No DB, no I/O, no Date.now. Unit-testable with plain `node`.
 *
 * A `CtcPolicy` is a CTC-AGNOSTIC rule template (percent / flat / balancing /
 * statutory) authored once in the layman builder. It compiles to the
 * SalaryComponentLine shape `deriveBreakup` / `materializeRevisionLines` already
 * consume — this module does NO arithmetic and NO derivation. The policy builder
 * produces line shapes; the engine resolves them. Pass ordering is taken from each
 * component's stored `derivationPass` (or the per-line BALANCING method) exactly as
 * `deriveBreakup.passFor` already does — the policy never re-implements pass logic.
 *
 * Three exports:
 *   compilePolicyToStructureLines(policy, { components }) -> { lines, basis }
 *   validatePolicy(policy, { components })                -> { ok, errors[], advisories[] }
 *   policyDefaults('IN')                                  -> CtcPolicy draft (India starter)
 *
 * INDIA-ONLY: `policyDefaults` only knows IN. NZ tenants never reach it (the
 * caller country-gates). A policy's countryCode is always the tenant's.
 */

// ── calcMethod constants (DB ComponentCalcMethod) — the FRIENDLY subset only ──
const METHOD = Object.freeze({
  PERCENT_OF: 'PERCENT_OF',
  FLAT: 'FLAT',
  BALANCING: 'BALANCING',
  STATUTORY: 'STATUTORY',
});

// Reserved base tokens (everything else is a named component code reference).
const BASE_CTC = 'CTC';
const BASE_GROSS = 'GROSS';

/**
 * CompilePolicyError — a policy line could not be compiled because its referenced
 * SalaryComponent is missing or soft-deleted (callers load components with
 * `deletedAt: null`, so a head deleted between policy save and compile vanishes from
 * the set). Silently dropping such a line would UNDER-ALLOCATE the derived breakup
 * while the revision still persists the FULL CTC — a money leak (review MED finding
 * #2). We FAIL CLOSED instead. Controllers map this to 422 (mirrors HireCompError/
 * DeriveError).
 */
class CompilePolicyError extends Error {
  constructor(message, { status = 422, reason = 'policy-unresolved', componentId } = {}) {
    super(message);
    this.name = 'CompilePolicyError';
    this.status = status;
    this.reason = reason;
    this.componentId = componentId;
  }
}

/**
 * Coerce a Decimal | number | numeric-string | null to a JS number (for the
 * calcValue echoed onto the compiled line — deriveBreakup re-coerces it). Display
 * fidelity is the controller's job; here we only need a stable scalar.
 */
function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Upper-case a code/string defensively. */
function up(s) {
  return String(s == null ? '' : s).trim().toUpperCase();
}

/**
 * compilePolicyToStructureLines(policy, { components }) — join each CtcPolicyLine to
 * its SalaryComponent (passed in, already tenant-scoped by the caller) and emit the
 * deriveBreakup line shape:
 *   { component: {...joined SalaryComponent incl. derivationPass/calcBaseScope/
 *       calcBaseCode/kind/category/floorValue/capValue}, calcMethod, calcValue, sortOrder }
 *
 * `baseCode` resolves onto the joined component's `calcBaseScope` (CTC/GROSS) or
 * `calcBaseCode` (a named component) WITHOUT mutating the master row — we shallow
 * -clone the component and override only the base fields the policy declares, so a
 * percent-of-CTC line and a percent-of-BASIC line derive in the right pass. A
 * BALANCING / STATUTORY line carries no base.
 *
 * Pure. FAILS CLOSED — an unresolved component (missing/soft-deleted between save
 * and compile) throws CompilePolicyError; the derived breakup MUST reconcile to the
 * full CTC, never silently lose a line (review MED finding #2). The compiled line
 * count is asserted to equal the policy line count.
 *
 * @param {Object} policy            { basis?, lines:[CtcPolicyLine] }
 * @param {Object} ctx
 * @param {Array}  ctx.components    SalaryComponent rows (id + code + kind + category
 *                                   + derivationPass + calcBaseScope + calcBaseCode + …)
 * @returns {{ lines: Array, basis: string }}
 * @throws {CompilePolicyError} when a policy line's component does not resolve.
 */
function compilePolicyToStructureLines(policy, { components } = {}) {
  const policyLines = Array.isArray(policy && policy.lines) ? policy.lines : [];
  const byId = new Map((components || []).map((c) => [c.id, c]));

  const lines = [];
  policyLines
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .forEach((pl, i) => {
      const master = byId.get(pl.componentId);
      if (!master) {
        // Unresolved (missing or soft-deleted) component — FAIL CLOSED. Dropping it
        // would persist the full CTC against under-allocated line items.
        throw new CompilePolicyError(
          `A pay component on this CTC policy no longer exists (it may have been deleted). Fix the policy before onboarding.`,
          { componentId: pl.componentId },
        );
      }
      const method = up(pl.calcMethod);

      // Shallow-clone the master so we never mutate the shared row; override only
      // the base scope/code the policy line declares for a PERCENT_OF rule.
      const component = { ...master };
      let calcValue = null;

      if (method === METHOD.PERCENT_OF) {
        calcValue = num(pl.pct);
        const base = up(pl.baseCode);
        if (base === BASE_CTC) {
          component.calcBaseScope = 'CTC';
          component.calcBaseCode = null;
        } else if (base === BASE_GROSS || base === '') {
          component.calcBaseScope = 'GROSS';
          component.calcBaseCode = null;
        } else {
          // Named component base ("BASIC") — a literal/component PERCENT_OF (pass 1).
          component.calcBaseScope = 'SINGLE';
          component.calcBaseCode = base;
        }
      } else if (method === METHOD.FLAT) {
        calcValue = num(pl.flatMonthly);
      }
      // BALANCING / STATUTORY carry no calcValue (residual / engine-owned at runtime).

      lines.push({
        component,
        calcMethod: method,
        calcValue,
        // FLAT earnings also accept amountMonthly; calcValue is enough (deriveBreakup
        // reads calcValue when amountMonthly is absent), so we keep the shape minimal.
        sortOrder: pl.sortOrder != null ? pl.sortOrder : i,
      });
    });

  // Belt-and-suspenders reconciliation: every policy line must have compiled. If the
  // counts diverge a line was lost (e.g. a duplicate/missing id slipped past) — the
  // derived breakup would no longer reconcile to the full CTC, so refuse.
  if (lines.length !== policyLines.length) {
    throw new CompilePolicyError(
      `This CTC policy did not fully compile (${lines.length}/${policyLines.length} lines). A pay component is missing or deleted.`,
    );
  }

  return { lines, basis: (policy && policy.basis) || 'CTC' };
}

/**
 * validatePolicy(policy, { components }) — the friendly-builder save/compile gate.
 *   - exactly one BASIC earning component;
 *   - at most one BALANCING line;
 *   - every PERCENT_OF baseCode resolves to CTC/GROSS or an EARLIER component code
 *     present in the policy (no forward/unknown reference);
 *   - every componentId resolves to a passed-in (tenant-scoped) SalaryComponent;
 *   - advisory (does NOT block): Basic %-of-CTC < 50 (the layman 50% chip — the
 *     HARD fail-closed gate is on the DERIVED amounts at preview/onboard, via
 *     deriveBreakup.wagesVerdict, not on the nominal policy here).
 *
 * @returns {{ ok:boolean, errors:string[], advisories:string[] }}
 */
function validatePolicy(policy, { components } = {}) {
  const errors = [];
  const advisories = [];
  const policyLines = Array.isArray(policy && policy.lines) ? policy.lines : [];
  const byId = new Map((components || []).map((c) => [c.id, c]));

  if (!policyLines.length) {
    errors.push('A CTC policy needs at least one component line.');
    return { ok: false, errors, advisories };
  }

  let basicCount = 0;
  let balancingCount = 0;
  const seenCodes = new Set(); // component codes resolved so far (declared order)

  const ordered = policyLines
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  for (const pl of ordered) {
    const master = byId.get(pl.componentId);
    if (!master) {
      errors.push(`A component on this policy is not valid for your company (componentId ${pl.componentId || '?'}).`);
      continue;
    }
    const method = up(pl.calcMethod);
    const kind = up(master.kind);
    const category = up(master.category) || 'EARNING';

    if (kind === 'BASIC') basicCount += 1;
    if (method === METHOD.BALANCING) balancingCount += 1;

    if (method === METHOD.PERCENT_OF) {
      if (num(pl.pct) == null) {
        errors.push(`"${master.name || master.code}" is set to a percentage but has no percent value.`);
      }
      const base = up(pl.baseCode);
      if (base && base !== BASE_CTC && base !== BASE_GROSS && !seenCodes.has(base)) {
        errors.push(`"${master.name || master.code}" is a % of "${base}", which is not defined earlier in this policy.`);
      }
    } else if (method === METHOD.FLAT) {
      if (num(pl.flatMonthly) == null) {
        errors.push(`"${master.name || master.code}" is set to a fixed amount but has no monthly value.`);
      }
    }

    // Advisory 50% chip — a BASIC declared as a flat % of CTC below 50.
    if (kind === 'BASIC' && method === METHOD.PERCENT_OF && up(pl.baseCode) === BASE_CTC) {
      const p = num(pl.pct);
      if (p != null && p < 50) {
        advisories.push(`Basic is ${p}% of CTC. India requires Basic ≥ 50% of CTC — raise it or the package will be rejected at preview.`);
      }
    }

    if (category === 'EARNING' || up(master.code)) seenCodes.add(up(master.code));
  }

  if (basicCount === 0) errors.push('A CTC policy must include exactly one Basic Pay component.');
  if (basicCount > 1) errors.push('A CTC policy can have only one Basic Pay component.');
  if (balancingCount > 1) errors.push('A CTC policy can have at most one Auto-balance (balancing) line.');

  return { ok: errors.length === 0, errors, advisories };
}

/**
 * policyDefaults('IN') — the India starter policy the builder seeds. Rules only
 * (CTC-agnostic), referencing component CODES the tenant is expected to own
 * (BASIC/HRA/CONVEYANCE/SPECIAL + the statutory employer heads). The controller
 * resolves these codes → componentIds before persisting; an absent code is simply
 * omitted (the builder shows the rest). India compliance baked in: Basic = 50% of
 * CTC (the wage floor), HRA = 50% of Basic, Conveyance = ₹1,600/mo, Special =
 * BALANCING, plus the statutory employer cost view.
 *
 * NZ tenants never reach this (country-gated by the caller). Returns null for a
 * non-IN country so a mis-call fails closed rather than seeding IN rules into NZ.
 *
 * @param {string} countryCode
 * @returns {Object|null}  a CtcPolicy DRAFT { code,name,countryCode,currencyCode,
 *                          basis,esiApplicable,capPfAtCeiling, lines:[{ componentCode,
 *                          calcMethod, pct?, flatMonthly?, baseCode?, sortOrder }] }
 */
function policyDefaults(countryCode) {
  if (up(countryCode) !== 'IN') return null;
  return {
    code: 'STAFF-IN',
    name: 'India Staff CTC',
    countryCode: 'IN',
    currencyCode: 'INR',
    basis: 'CTC',
    esiApplicable: false,
    capPfAtCeiling: true,
    lines: [
      // Earnings — the friendly defaults. Codes are matched case-insensitively to
      // the tenant's SalaryComponent master by the controller.
      { componentCode: 'BASIC', calcMethod: METHOD.PERCENT_OF, pct: 50, baseCode: BASE_CTC, sortOrder: 0 },
      { componentCode: 'HRA', calcMethod: METHOD.PERCENT_OF, pct: 50, baseCode: 'BASIC', sortOrder: 1 },
      { componentCode: 'CONVEYANCE', calcMethod: METHOD.FLAT, flatMonthly: 1600, sortOrder: 2 },
      { componentCode: 'SPECIAL_ALLOWANCE', calcMethod: METHOD.BALANCING, sortOrder: 3 },
      // Statutory employer cost view (engine owns these at runtime; declared here
      // only so the cost waterfall is complete). STATUTORY → no user-set value.
      { componentCode: 'PF_EMPLOYER', calcMethod: METHOD.STATUTORY, sortOrder: 4 },
      { componentCode: 'GRATUITY_PROVISION', calcMethod: METHOD.STATUTORY, sortOrder: 5 },
    ],
  };
}

module.exports = {
  compilePolicyToStructureLines,
  validatePolicy,
  policyDefaults,
  CompilePolicyError,
  METHOD,
  _internal: { num, up },
};
