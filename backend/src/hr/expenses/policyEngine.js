'use strict';

/**
 * policyEngine.js — Feature 11 §4. THE pure travel-&-expense policy validator.
 *
 * A single pure function (no DB, no I/O — fully unit-testable), mirroring the
 * scopeResolver / approvalRouting chokepoint pattern. Given a bill line + the
 * resolved context (the active policy with its rule tables, the employee's level,
 * the destination city tier, the per-diem duration band, the journey hours and
 * distance), it returns a verdict the approver + employee can both reason about:
 *
 *   evaluateLine(line, ctx) -> { verdict, appliedCap, reason }
 *
 *     verdict  : 'OK' | 'FLAGGED' | 'AUTO_REJECTED' | 'NO_POLICY'
 *     appliedCap : the numeric cap the engine checked against (null when none)
 *     reason   : a human one-liner ("Hotel ₹6,500 > TIER_2 L3 cap ₹5,000")
 *
 * Money is compared as plain Numbers HERE (the engine is pure arithmetic on values
 * the caller has already pulled off Prisma Decimals via Number()); the persisted
 * amounts stay Decimal end-to-end in the service. Comparisons are explicit.
 *
 * The line "kind" is inferred from the line: a `transportMode` ⇒ transport; a
 * `nights`>0 with a HOTEL-ish category ⇒ hotel; a `durationBand` ⇒ per-diem; else
 * the folded per-category ExpensePolicy rules (maxPerClaim / dailyCap / monthly /
 * requireReceipt). No matching rule ⇒ NO_POLICY (passes, advisory) — never a silent
 * block.
 *
 * Enforcement: `policy.enforcement === 'HARD'` turns a breach into AUTO_REJECTED
 * (the service blocks submit); 'FLAG' turns it into FLAGGED (submit succeeds, the
 * approver must acknowledge). A disallowed transport mode (allowed:false) or a
 * flight under the minimum journey hours is ALWAYS AUTO_REJECTED regardless of the
 * enforcement mode — those are eligibility rules, not soft caps.
 */

const VERDICT = Object.freeze({ OK: 'OK', FLAGGED: 'FLAGGED', AUTO_REJECTED: 'AUTO_REJECTED', NO_POLICY: 'NO_POLICY' });

// Verdict severity for the claim rollup: AUTO_REJECTED > FLAGGED > OK > NO_POLICY.
const SEVERITY = Object.freeze({ NO_POLICY: 0, OK: 1, FLAGGED: 2, AUTO_REJECTED: 3 });

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// Pretty-print money with the currency symbol/code for the reason string.
function money(v, currency) {
  if (v === null || v === undefined) return '';
  const sym = { INR: '₹', NZD: 'NZ$', USD: '$' }[currency] || '';
  const n = Number(v);
  const s = sym ? `${sym}${n.toLocaleString('en-IN')}` : `${n.toLocaleString('en-IN')} ${currency || ''}`.trim();
  return s;
}

// FLAG vs HARD → which over-limit verdict applies.
function overVerdict(policy) {
  return policy && policy.enforcement === 'HARD' ? VERDICT.AUTO_REJECTED : VERDICT.FLAGGED;
}

// Most-specific-wins rule match: a rule whose nullable dimension (gradeRank/cityTier)
// is set must equal ctx; a null dimension is a wildcard. Score = number of matched
// non-null dimensions, so a (L3, TIER_1) rule beats a (any-level, TIER_1) rule.
function bestMatch(rules, dims) {
  let best = null;
  let bestScore = -1;
  for (const r of rules || []) {
    let score = 0;
    let ok = true;
    for (const [key, val] of Object.entries(dims)) {
      const rv = r[key];
      if (rv === null || rv === undefined) continue; // wildcard
      if (val === null || val === undefined || rv !== val) { ok = false; break; }
      score += 1;
    }
    if (ok && score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

// ── per-diem (food + incidentals) ────────────────────────────────────────────
function evalPerDiem(line, ctx) {
  const { policy } = ctx;
  const rules = (policy && policy.perDiemRules) || [];
  const rule = bestMatch(rules, { durationBand: line.durationBand, gradeRank: ctx.gradeRank, cityTier: ctx.cityTier });
  if (!rule) return { verdict: VERDICT.NO_POLICY, appliedCap: null, reason: 'No per-diem rule for this band — advisory only' };
  const cap = num(rule.foodCap) + num(rule.incidentalCap);
  const amount = num(line.amount);
  if (amount === null) return { verdict: VERDICT.NO_POLICY, appliedCap: cap, reason: 'No amount on line' };
  if (amount > cap) {
    return { verdict: overVerdict(policy), appliedCap: cap, reason: `Per-diem ${money(amount, ctx.currencyCode)} > ${line.durationBand} cap ${money(cap, ctx.currencyCode)}` };
  }
  return { verdict: VERDICT.OK, appliedCap: cap, reason: `Within ${line.durationBand} per-diem cap ${money(cap, ctx.currencyCode)}` };
}

// ── hotel (nightlyCap × nights, by level × tier) ─────────────────────────────
function evalHotel(line, ctx) {
  const { policy } = ctx;
  const rules = (policy && policy.hotelRules) || [];
  // Hotel rules are keyed on (gradeRank, cityTier) — both required (no wildcard).
  const rule = bestMatch(rules, { gradeRank: ctx.gradeRank, cityTier: ctx.cityTier });
  if (!rule) return { verdict: VERDICT.NO_POLICY, appliedCap: null, reason: `No hotel rule for level L${ctx.gradeRank ?? '?'} in ${ctx.cityTier || 'this tier'} — advisory only` };
  const nights = num(line.nights) || 1;
  const cap = num(rule.nightlyCap) * nights;
  const amount = num(line.amount);
  if (amount === null) return { verdict: VERDICT.NO_POLICY, appliedCap: cap, reason: 'No amount on line' };
  if (amount > cap) {
    return { verdict: overVerdict(policy), appliedCap: cap, reason: `Hotel ${money(amount, ctx.currencyCode)} > ${ctx.cityTier} L${ctx.gradeRank} cap ${money(num(rule.nightlyCap), ctx.currencyCode)}/night × ${nights} = ${money(cap, ctx.currencyCode)}` };
  }
  return { verdict: VERDICT.OK, appliedCap: cap, reason: `Within hotel cap ${money(cap, ctx.currencyCode)} (${nights} night(s))` };
}

// ── transport (by mode + level) ──────────────────────────────────────────────
function evalTransport(line, ctx) {
  const { policy } = ctx;
  const rules = (policy && policy.transportRules) || [];
  const rule = bestMatch(rules, { mode: line.transportMode, gradeRank: ctx.gradeRank });
  const amount = num(line.amount);
  if (!rule) return { verdict: VERDICT.NO_POLICY, appliedCap: null, reason: `No transport rule for ${line.transportMode} — advisory only` };

  // Eligibility (always hard): an outright-disallowed mode for this level.
  if (rule.allowed === false) {
    return { verdict: VERDICT.AUTO_REJECTED, appliedCap: 0, reason: `${line.transportMode} is not permitted for level L${ctx.gradeRank ?? '?'}` };
  }

  // FLIGHT min-journey-hours eligibility (always hard when configured + unmet).
  if (line.transportMode === 'FLIGHT' && rule.minJourneyHrs != null) {
    const jh = num(ctx.journeyHours);
    if (jh === null || jh < num(rule.minJourneyHrs)) {
      return { verdict: VERDICT.AUTO_REJECTED, appliedCap: rule.fareCap != null ? num(rule.fareCap) : null,
        reason: `Flight allowed only for journeys ≥ ${rule.minJourneyHrs}h (this journey: ${jh ?? '?'}h)` };
    }
  }

  // SELF_CAR: reimbursable = perKmRate × distanceKm; claimed over computed → flag.
  if (line.transportMode === 'SELF_CAR' && rule.perKmRate != null) {
    const dist = num(line.distanceKm) || 0;
    const cap = num(rule.perKmRate) * dist;
    if (amount !== null && amount > cap) {
      return { verdict: overVerdict(policy), appliedCap: cap, reason: `Self-drive ${money(amount, ctx.currencyCode)} > ${money(num(rule.perKmRate), ctx.currencyCode)}/km × ${dist}km = ${money(cap, ctx.currencyCode)}` };
    }
    return { verdict: VERDICT.OK, appliedCap: cap, reason: `Within mileage allowance ${money(cap, ctx.currencyCode)} (${dist}km)` };
  }

  // Everything else with a fareCap → cap at fareCap.
  if (rule.fareCap != null) {
    const cap = num(rule.fareCap);
    if (amount !== null && amount > cap) {
      return { verdict: overVerdict(policy), appliedCap: cap, reason: `${line.transportMode} ${money(amount, ctx.currencyCode)} > fare cap ${money(cap, ctx.currencyCode)}` };
    }
    return { verdict: VERDICT.OK, appliedCap: cap, reason: `Within ${line.transportMode} fare cap ${money(cap, ctx.currencyCode)}` };
  }

  // Allowed, no cap configured → OK (advisory).
  return { verdict: VERDICT.OK, appliedCap: null, reason: `${line.transportMode} permitted (no fare cap set)` };
}

// ── per-category (the folded ExpensePolicy: maxPerClaim / dailyCap / monthly /
//    requireReceipt). ctx.categoryPolicy is the matched ExpensePolicy row; ctx
//    .monthToDate is the running month-to-date total for this category (the service
//    computes + passes it). ──
function evalCategory(line, ctx) {
  const cp = ctx.categoryPolicy;
  const amount = num(line.amount);
  if (!cp) {
    // No per-category policy: only the receipt-presence advisory applies, and only
    // when the line itself is flagged as receipt-required by the category default.
    return { verdict: VERDICT.NO_POLICY, appliedCap: null, reason: 'No category policy — advisory only' };
  }
  // requireReceipt with no receipt → FLAGGED (a soft, fixable breach).
  if (cp.requireReceipt && !line.receiptUrl) {
    return { verdict: VERDICT.FLAGGED, appliedCap: null, reason: 'Receipt required for this category' };
  }
  // Feature 45 — per-JOB-LEVEL override: an exact gradeRank rule beats the
  // all-levels (null-rank) rule beats the policy's flat caps. A null field on
  // the winning rule falls back to the flat cap (partial overrides compose).
  const gradeRules = ctx.gradeRules || cp.gradeRules || [];
  let gr = null;
  if (gradeRules.length) {
    const exact = ctx.gradeRank != null ? gradeRules.find((r) => r.gradeRank === ctx.gradeRank) : null;
    gr = exact || gradeRules.find((r) => r.gradeRank == null) || null;
  }
  const capOf = (field) => (gr && gr[field] != null ? num(gr[field]) : num(cp[field]));
  const levelTag = gr && gr.gradeRank != null ? ` (level ${gr.gradeRank})` : '';
  const checks = [
    { cap: capOf('maxPerClaim'), label: `per-claim cap${levelTag}`, running: amount },
    { cap: capOf('dailyCap'), label: `daily cap${levelTag}`, running: amount },
    { cap: capOf('maxPerMonth'), label: `monthly cap${levelTag}`, running: (num(ctx.monthToDate) || 0) + (amount || 0) },
  ];
  for (const c of checks) {
    if (c.cap !== null && c.running !== null && c.running > c.cap) {
      return { verdict: overVerdict(cp.enforcement === 'HARD' ? { enforcement: 'HARD' } : ctx.policy || {}), appliedCap: c.cap,
        reason: `${money(c.running, ctx.currencyCode)} exceeds ${c.label} ${money(c.cap, ctx.currencyCode)}` };
    }
  }
  // pick the tightest cap that applied for appliedCap reporting
  const caps = checks.map((c) => c.cap).filter((x) => x !== null);
  const tightest = caps.length ? Math.min(...caps) : null;
  return { verdict: VERDICT.OK, appliedCap: tightest, reason: cp.requireReceipt ? 'Within category limits (receipt attached)' : 'Within category limits' };
}

// ── the public chokepoint ─────────────────────────────────────────────────────
/**
 * evaluateLine(line, ctx) -> { verdict, appliedCap, reason }
 *
 * line: { amount, transportMode?, distanceKm?, nights?, durationBand?, receiptUrl?, categoryId? }
 * ctx:  { policy, categoryPolicy?, gradeRank?, cityTier?, currencyCode?, journeyHours?, monthToDate? }
 *
 * If there is NO active policy AND no category policy at all → NO_POLICY.
 */
function evaluateLine(line, ctx = {}) {
  if (!line || typeof line !== 'object') {
    return { verdict: VERDICT.NO_POLICY, appliedCap: null, reason: 'No line to evaluate' };
  }
  const hasPolicy = ctx.policy && (
    (ctx.policy.perDiemRules && ctx.policy.perDiemRules.length) ||
    (ctx.policy.hotelRules && ctx.policy.hotelRules.length) ||
    (ctx.policy.transportRules && ctx.policy.transportRules.length)
  );

  // 1. Transport line (has a transportMode).
  if (line.transportMode) {
    if (!hasPolicy) return { verdict: VERDICT.NO_POLICY, appliedCap: null, reason: 'No active travel policy — advisory only' };
    return evalTransport(line, ctx);
  }
  // 2. Per-diem line (has a durationBand).
  if (line.durationBand) {
    if (!hasPolicy) return { verdict: VERDICT.NO_POLICY, appliedCap: null, reason: 'No active travel policy — advisory only' };
    return evalPerDiem(line, ctx);
  }
  // 3. Hotel line (nights set, or category explicitly marked hotel).
  if (line.nights != null && Number(line.nights) > 0) {
    if (!hasPolicy) return { verdict: VERDICT.NO_POLICY, appliedCap: null, reason: 'No active travel policy — advisory only' };
    return evalHotel(line, ctx);
  }
  // 4. Per-category fallback (the folded ExpensePolicy).
  return evalCategory(line, ctx);
}

// Claim rollup: the worst (highest severity) line verdict.
function rollupVerdict(lineVerdicts) {
  let worst = VERDICT.NO_POLICY;
  for (const v of lineVerdicts || []) {
    if (SEVERITY[v] > SEVERITY[worst]) worst = v;
  }
  return worst;
}

module.exports = {
  evaluateLine,
  rollupVerdict,
  bestMatch,
  VERDICT,
  SEVERITY,
  // exported for tests / reuse
  _internals: { evalPerDiem, evalHotel, evalTransport, evalCategory, money },
};
