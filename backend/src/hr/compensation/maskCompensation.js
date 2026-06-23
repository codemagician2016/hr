'use strict';

/**
 * maskCompensation.js — field-level salary-masking shaper (docs/05 §4.5).
 *
 * Runs on EVERY comp read before serialization. Access is the intersection of
 * three gates, all reused from F1:
 *   (1) permission  — canViewCompensation (→ ABSOLUTE) — checked upstream/here.
 *   (2) scope band  — ALL/TEAM/SELF + withEmployeeScope 404 for out-of-subtree.
 *   (3) visibility  — the compVisibility level (ABSOLUTE | RANGE_ONLY | SELF_ONLY | NONE).
 *
 * ANTI-LEAK RULE (explicit): masking is SERVER-SIDE FIELD OMISSION, not a CSS
 * blur. A RANGE_ONLY row's JSON contains NO ctcAnnual/grossMonthly/netMonthly key
 * (and no per-line amounts). The •••  the client renders is the render of an
 * ABSENT field. A 403 is reserved for true ownership/scope boundaries and its
 * body carries ZERO salary data.
 *
 * PURE: no DB, no I/O. The caller resolves the viewer's level (via
 * rbac.effectiveCompVisibility) and the target's grade range, and passes them in.
 */

const { effectiveCompVisibility } = require('../../core/lib/rbac');

/** Decimal|number|string → number (display only; never further math). */
function n(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/**
 * Bucket a signed percentage change into a coarse band so RANGE_ONLY viewers see
 * the direction/magnitude without an exact number that reverse-derives absolute
 * pay. Bands key off |pct|: <5%, 5-10%, >10% (sign preserved for decrease).
 */
function bucketPct(pct) {
  const x = Number(pct);
  if (!Number.isFinite(x)) return null;
  const mag = Math.abs(x);
  const sign = x < 0 ? '-' : '';
  if (mag < 5) return `${sign}<5%`;
  if (mag <= 10) return `${sign}5-10%`;
  return `${sign}>10%`;
}

/**
 * Resolve the effective level for THIS read: a viewer looking at their OWN
 * compensation always gets at least SELF_ONLY (full own breakup), even if their
 * role band is NONE — "you can always see your own pay".
 */
function resolveLevel(viewer, target) {
  const isSelf = !!(viewer && target && viewer.employeeId && target.employeeId
    && viewer.employeeId === target.employeeId);
  const base = effectiveCompVisibility(viewer);
  if (isSelf) {
    // Own pay: ABSOLUTE if they already have it, else SELF_ONLY (full own).
    return base === 'ABSOLUTE' ? 'ABSOLUTE' : 'SELF_ONLY';
  }
  return base;
}

/**
 * Compute the band view (compa-ratio / range-penetration) from the target's
 * Grade.min/mid/max. mid falls back to (min+max)/2. Returns null when no range.
 *
 * compaRatio        = actualCtc / mid
 * rangePenetration  = (actualCtc − min) / (max − min)
 */
function bandView(grade, actualAnnual) {
  if (!grade) return null;
  const min = n(grade.minSalary);
  const max = n(grade.maxSalary);
  let mid = n(grade.midSalary);
  if (mid == null && min != null && max != null) mid = (min + max) / 2;
  if (min == null && max == null && mid == null) return null;
  const out = {
    gradeId: grade.id || null,
    bandId: grade.bandId || null,
    min, mid, max,
  };
  if (actualAnnual != null) {
    if (mid && mid > 0) out.compaRatio = Math.round((actualAnnual / mid) * 10000) / 10000;
    if (min != null && max != null && max > min) {
      out.rangePenetration = Math.round(((actualAnnual - min) / (max - min)) * 10000) / 10000;
    }
  }
  return out;
}

/**
 * maskCompensation(payload, viewer, opts) → visibility envelope.
 *
 * @param {Object} payload  the FULL (unmasked) comp record:
 *        { employeeId, ctcAnnual, grossMonthly, netMonthly?, lines?[], history?[],
 *          delta?:{ pct, absolute? }, ... }
 * @param {Object} viewer   req.user (carries businessRole.compVisibility + perms + employeeId)
 * @param {Object} [opts]   { grade?, level? }  grade = target Grade for the band view;
 *        level overrides the resolved level (tests / cycle worksheet rows).
 * @returns {Object} {
 *   visibility,
 *   absolute?: { ctcAnnual, grossMonthly, netMonthly },  // ABSOLUTE | SELF_ONLY
 *   lines?,                                               // ABSOLUTE | SELF_ONLY
 *   range?:    { gradeId, bandId, min, mid, max, compaRatio, rangePenetration }, // RANGE_ONLY | ABSOLUTE
 *   delta?,
 *   history?,
 * }
 *
 * Invariants:
 *   - RANGE_ONLY: NO absolute money key (ctcAnnual/grossMonthly/netMonthly), NO
 *     per-line amounts, NO exact delta.pct (only a coarse delta.band). Names may
 *     appear; absolute-reconstructable numbers never.
 *   - NONE: only { visibility:'NONE' }. (Caller decides whether NONE → 404/empty.)
 *   - SELF_ONLY is only legitimate when viewer === target (the caller enforces the
 *     route shape; here we still emit a full breakup for the SELF case).
 */
// Record identity + workflow-state fields. These are NOT salary data (no money),
// so they ride alongside EVERY visibility level — a RANGE_ONLY checker still needs
// to see { id, status, isCurrent } to drive the maker-checker UI/flow without ever
// learning an amount. Only stamped when present on the payload.
function identityEnvelope(payload) {
  const out = {};
  if (!payload) return out;
  if (payload.id != null) out.id = payload.id;
  if (payload.employeeId != null) out.employeeId = payload.employeeId;
  if (payload.status != null) out.status = payload.status;
  if (payload.effectiveFrom != null) out.effectiveFrom = payload.effectiveFrom;
  if (payload.effectiveTo != null) out.effectiveTo = payload.effectiveTo;
  if (payload.isCurrent != null) out.isCurrent = payload.isCurrent;
  return out;
}

function maskCompensation(payload, viewer, opts = {}) {
  const level = opts.level || resolveLevel(viewer, payload || {});
  const grade = opts.grade || (payload && payload.grade) || null;

  if (level === 'NONE') {
    return { visibility: 'NONE', ...identityEnvelope(payload) };
  }

  const ctcAnnual = n(payload && payload.ctcAnnual);

  if (level === 'RANGE_ONLY') {
    const env = { visibility: 'RANGE_ONLY', ...identityEnvelope(payload) };
    const range = bandView(grade, ctcAnnual);
    if (range) env.range = range;
    // Component NAMES (no amounts) may show — strip every amount field.
    if (Array.isArray(payload && payload.lines)) {
      env.lines = payload.lines.map((l) => ({
        code: l.code || (l.component && l.component.code) || null,
        name: l.name || (l.component && l.component.name) || null,
        category: l.category || (l.component && l.component.category) || null,
        // NO amountMonthly / amountAnnual / calcValue — server-side omission.
      }));
    }
    // NO delta under RANGE_ONLY. An exact pct is a number that, combined with any
    // one absolute anchor (a prior CTC learned elsewhere, a leaked band midpoint,
    // or range penetration over a tight band), algebraically reverse-derives the
    // new absolute CTC (new = prior*(1+pct/100)). Bucket it to a coarse band
    // ('<5%','5-10%','>10%') so the magnitude reads without leaking the number.
    if (payload && payload.delta && payload.delta.pct != null) {
      env.delta = { band: bucketPct(payload.delta.pct) }; // coarse band only — never an exact pct/absolute
    }
    return env;
  }

  // ABSOLUTE | SELF_ONLY → full money pass-through.
  const env = {
    visibility: level,
    ...identityEnvelope(payload),
    absolute: {
      ctcAnnual,
      grossMonthly: n(payload && payload.grossMonthly),
      netMonthly: n(payload && payload.netMonthly),
    },
  };
  if (Array.isArray(payload && payload.lines)) env.lines = payload.lines;
  const range = bandView(grade, ctcAnnual);
  if (range) env.range = range; // band shown alongside absolute when available
  if (payload && payload.delta) env.delta = payload.delta;
  if (Array.isArray(payload && payload.history)) env.history = payload.history;
  if (Array.isArray(payload && payload.letters)) env.letters = payload.letters;
  return env;
}

module.exports = { maskCompensation, resolveLevel, bandView, bucketPct };
