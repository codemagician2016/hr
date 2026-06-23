'use strict';

/**
 * hireComp.js — the SINGLE source of "hire-pay math" (Feature 17 §4.2).
 *
 * Both hire paths funnel through `buildHireRevisionLines`:
 *   - ATS provisioning (lifecycle/provision.js STEP 8) — resolves lines from the
 *     offer's `structureId`.
 *   - Direct onboard-by-CTC (onboard.controller.js) — compiles a `CtcPolicy` to the
 *     same line shape.
 * Both then run the IDENTICAL `materializeRevisionLines` + the India 50% fail-closed
 * re-check on the DERIVED Basic+DA, so a direct hire and an ATS hire produce
 * BYTE-IDENTICAL CompensationRevision lines. Extracting this prevents the two paths
 * from silently drifting (the §4.1 hire-parity contract).
 *
 * PURE-ish: it touches the DB ONLY to load a structure's lines (when given a
 * structureId and no pre-resolved lines). The materialization + wage check are pure
 * (deriveBreakup). Callers pass their own `tx` so the load joins the same snapshot.
 */

const { materializeRevisionLines } = require('./deriveBreakup');
const { compilePolicyToStructureLines } = require('./ctcPolicy');
const money = require('../payroll/money');

/** Decimal|number|string → integer minor units (paise), reusing payroll money math. */
function toMinor(v, scale = 2) {
  if (v == null || v === '') return null;
  let s;
  if (typeof v === 'object' && typeof v.toFixed === 'function') s = v.toFixed(scale);
  else if (typeof v === 'number') s = v.toFixed(scale);
  else s = String(v);
  return money.toMinor(s, scale);
}

/** ISO YYYY-MM-DD from a Date|string (deriveBreakup asOf wants a date-only string). */
function isoDateOnly(d) {
  if (!d) return undefined;
  if (typeof d === 'string') return d.slice(0, 10);
  try { return new Date(d).toISOString().slice(0, 10); } catch (_e) { return undefined; }
}

/** A structured error the controllers map to an HTTP status (mirrors ProvisionError). */
class HireCompError extends Error {
  constructor(message, { status = 422, reason } = {}) {
    super(message);
    this.name = 'HireCompError';
    this.status = status;
    this.reason = reason;
  }
}

/**
 * buildHireRevisionLines — resolve a hire's salary lines + breakup from EITHER an
 * existing SalaryStructure OR a compiled CtcPolicy, materialize them at the target,
 * and FAIL CLOSED on the India 50% wage rule (on the DERIVED amounts).
 *
 * Exactly one of `structureId` / `policyId` (or pre-resolved `lines`) must resolve
 * to a non-empty line set, else `null` lines are returned (the caller may then write
 * a pay-less revision or refuse — provisioning historically allowed pay-less).
 *
 * @param {Object} p
 * @param {Object} p.tx            a Prisma tx/client handle (used only to LOAD).
 * @param {string} p.businessId
 * @param {string} p.countryCode   tenant country (drives basis + 50% gate).
 * @param {string} [p.structureId] ATS path — load this SalaryStructure's lines.
 * @param {string} [p.policyId]    onboard path — compile this CtcPolicy.
 * @param {Object} [p.policy]      onboard path — a pre-loaded policy (+lines), so the
 *                                 caller can load it once with its components.
 * @param {Array}  [p.policyComponents] the SalaryComponent rows the policy references.
 * @param {Array}  [p.lines]       pre-resolved deriveBreakup line shape (overrides load).
 * @param {number|string} [p.ctcAnnual]    target annual CTC (IN basis).
 * @param {number|string} [p.grossMonthly] target monthly gross (GROSS basis).
 * @param {Date|string}   p.joinDate       effective date (asOf for statutory rates).
 * @param {boolean} [p.esiApplicable=false]
 * @param {boolean} [p.capPfAtCeiling=true]
 * @returns {Promise<{ lineCreates: Array|null, breakup: Object|null, basis: string }>}
 */
async function buildHireRevisionLines({
  tx,
  businessId,
  countryCode,
  structureId,
  policyId,
  policy,
  policyComponents,
  lines: preLines,
  ctcAnnual,
  grossMonthly,
  joinDate,
  esiApplicable = false,
  capPfAtCeiling,
}) {
  const cc = String(countryCode || '').toUpperCase();
  const basis = cc === 'IN' ? 'CTC' : 'GROSS';

  // ── 1. Resolve the deriveBreakup line shape (structure | policy | pre-resolved). ──
  let lines = Array.isArray(preLines) ? preLines : null;

  if (!lines && policy) {
    // Onboard path with a pre-loaded policy + its components.
    const compiled = compilePolicyToStructureLines(policy, { components: policyComponents || [] });
    lines = compiled.lines;
  } else if (!lines && policyId) {
    // Onboard path — load the policy + its lines (+ joined components) here.
    const pol = await tx.ctcPolicy.findFirst({
      where: { id: policyId, businessId, deletedAt: null },
      include: { lines: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!pol) throw new HireCompError('CTC policy not found for this company.', { status: 404, reason: 'policy-not-found' });
    const componentIds = [...new Set((pol.lines || []).map((l) => l.componentId))];
    const comps = componentIds.length
      ? await tx.salaryComponent.findMany({ where: { id: { in: componentIds }, businessId, deletedAt: null } })
      : [];
    const compiled = compilePolicyToStructureLines(pol, { components: comps });
    lines = compiled.lines;
  } else if (!lines && structureId) {
    // ATS path — load the structure's lines joined to their component (the exact
    // shape provision.js STEP 8 used before extraction).
    const structure = await tx.salaryStructure.findFirst({
      where: { id: structureId, businessId },
      include: { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } },
    });
    if (structure && Array.isArray(structure.lines) && structure.lines.length) {
      lines = structure.lines;
    }
  }

  if (!lines || !lines.length) {
    // No resolvable structure/policy — a pay-less hire (the historical provision.js
    // behaviour). The caller decides whether to allow it.
    return { lineCreates: null, breakup: null, basis };
  }

  // ── 2. Build the target (CTC for IN, gross for NZ) in minor units. ──
  const target = {};
  const ctcMinor = toMinor(ctcAnnual);
  const grossMinor = toMinor(grossMonthly);
  if (basis === 'CTC' && ctcMinor != null) target.ctcAnnualMinor = ctcMinor;
  else if (grossMinor != null) target.grossMonthlyMinor = grossMinor;
  else if (ctcMinor != null) target.ctcAnnualMinor = ctcMinor; // last-resort CTC

  // ── 3. Materialize (the ONE place CTC→amounts is computed). ──
  let matLines;
  let breakup;
  try {
    const out = materializeRevisionLines(
      { lines, basis },
      {
        target,
        basis,
        countryCode: cc,
        asOf: isoDateOnly(joinDate),
        esiApplicable: esiApplicable === true,
        capPfAtCeiling,
      },
    );
    matLines = out.lines;
    breakup = out.breakup;
  } catch (err) {
    // A structurally-infeasible structure is a hard hire failure (never silently
    // write a zero-line revision). Preserve the deriveBreakup code for the client.
    throw new HireCompError(
      `Cannot build the salary breakup for this hire: ${err.message}`,
      { status: 422, reason: err.code === 'STRUCTURE_INFEASIBLE' ? 'structure-infeasible' : 'comp-structure' },
    );
  }

  // ── 4. FAIL CLOSED on the India 50% wage rule — on the DERIVED Basic+DA. ──
  // The nominal policy/structure may look compliant, but percent-of-CTC after the
  // employer-cost subtraction shrinks gross, hence Basic. Re-check the amounts that
  // actually get persisted (verbatim from the original provision.js:606 guard).
  if (breakup && breakup.wagesVerdict && breakup.wagesVerdict.applies && !breakup.wagesVerdict.ok) {
    throw new HireCompError(
      'The derived salary structure violates the India 50% wage rule (Basic + DA below 50% of gross after CTC materialization).',
      { status: 422, reason: 'wage-rule' },
    );
  }

  const lineCreates = (matLines && matLines.length)
    ? matLines.map((l) => ({ ...l, businessId }))
    : null;

  return { lineCreates, breakup, basis };
}

module.exports = { buildHireRevisionLines, HireCompError, _internal: { toMinor, isoDateOnly } };
