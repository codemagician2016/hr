'use strict';

/*
 * ============================================================================
 *  India Statutory Compliance CALENDAR — pure due-date rule engine (Feature 23)
 * ============================================================================
 *
 *  PURE. No DB, no I/O, no prisma, no Date.now. Every function takes the as-of /
 *  period as an argument and returns a value — unit-testable with plain `node`.
 *
 *  This is the effective-dated due-date math LIFTED + generalised from
 *  service.js:remittanceDueDate / remittanceTaxPeriod / indianQuarter so it can
 *  serve BOTH the payroll fileRun() path (which keeps calling the same math via
 *  the thin adapter in service.js) AND the standalone compliance calendar
 *  generator (calendarRunner.js).
 *
 *  An "obligation" here is the §3.1 ComplianceObligation definition shape
 *  (cadence/dueDom/dueMonths/offsetMonths/specialRules/effectiveFrom/effectiveTo).
 *  A "period" is identified by a `taxPeriod` string:
 *      MONTHLY      → "YYYY-MM"   (the WAGE month the obligation covers)
 *      QUARTERLY    → "YYYY-Qn"   (Indian fiscal quarter; taxYear-prefixed FY)
 *      HALF_YEARLY  → "YYYY-Hn"   (calendar-half latch; n ∈ {1,2})
 *      ANNUAL       → "YYYY-YY"   (Indian FY, e.g. "2025-26") OR "YYYY" calendar
 *      EVENT        → no schedule (instance minted on the trigger, dueDate given)
 *
 *  Dates are all UTC midnight (Date.UTC) — matching the @db.Date columns and the
 *  existing service.js convention (no TZ drift).
 *
 *  See docs/features/23-compliance-calendar.md §2 (the statutory rules) and §4
 *  (the engine contract).
 */

// ── small date helpers (UTC, pure) ──────────────────────────────────────────

/** Build a UTC-midnight Date. month is 1-based here (humane); Date.UTC is 0-based. */
function utcDate(year, month1, day) {
  // Date.UTC normalises overflow: month1=13 → next year's Jan; day=0 → prev month
  // last day. We rely on that for "dom 30/31 of a short month" clamping below.
  return new Date(Date.UTC(year, month1 - 1, day));
}

/** Last day-of-month for a 1-based month. */
function lastDom(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Clamp a requested day-of-month to the month's real length (e.g. dom 31 in Apr → 30). */
function clampDom(year, month1, dom) {
  const max = lastDom(year, month1);
  return Math.min(dom, max);
}

/** Add N months to a (year, month1) pair → { year, month1 } (1-based, wraps years). */
function addMonths(year, month1, n) {
  const zero = month1 - 1 + n;
  return { year: year + Math.floor(zero / 12), month1: ((zero % 12) + 12) % 12 + 1 };
}

// ── taxPeriod parsing (pure) ────────────────────────────────────────────────

/** Indian fiscal quarter (Q1=Apr-Jun … Q4=Jan-Mar) for a 1-based calendar month. */
function indianQuarterForMonth(month1) {
  if (month1 >= 4 && month1 <= 6) return 'Q1';
  if (month1 >= 7 && month1 <= 9) return 'Q2';
  if (month1 >= 10 && month1 <= 12) return 'Q3';
  return 'Q4';
}

// Default half-year anchor months = the LAST month of H1 and H2 (calendar halves).
// ESI's statutory return halves are FISCAL (Apr-Sep / Oct-Mar) → anchors [9, 3].
const DEFAULT_HALF_ANCHORS = [6, 12];

/**
 * parseHalfPeriod(year, h, anchorMonths) → parsed half window. `year` is the
 * calendar year the half's ANCHOR (last) month falls in. anchorMonths = the two
 * last-months, e.g. [6,12] calendar or [9,3] fiscal-ESI. A half whose start month
 * is numerically AFTER its anchor month (e.g. Oct-Mar: start 10, anchor 3) spans
 * the year boundary — start is in the PRIOR calendar year.
 */
function parseHalfPeriod(year, h, anchorMonths) {
  const anchors = Array.isArray(anchorMonths) && anchorMonths.length === 2 ? anchorMonths : DEFAULT_HALF_ANCHORS;
  const endMonth = anchors[h - 1];
  const startMonth = ((endMonth - 5 + 12 - 1) % 12) + 1; // 6-month INCLUSIVE window ending at endMonth (start = end-5)
  const startYear = startMonth <= endMonth ? year : year - 1;
  return {
    kind: 'half', anchorYear: year, anchorMonth1: endMonth,
    periodStart: utcDate(startYear, startMonth, 1),
    periodEnd: utcDate(year, endMonth, lastDom(year, endMonth)),
    fyLabel: indianFyLabel(year, endMonth),
  };
}

/** The Indian FY label ("2025-26") that a 1-based (year, month) falls in. */
function indianFyLabel(year, month1) {
  // FY starts 1 Apr. Jan-Mar belongs to the FY that STARTED the prior April.
  const startYear = month1 >= 4 ? year : year - 1;
  const endYY = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endYY}`;
}

/**
 * Parse a taxPeriod string into the calendar window it covers + its FY context.
 * Returns { kind:'month'|'quarter'|'half'|'fyear'|'cyear', periodStart, periodEnd,
 *           anchorYear, anchorMonth1, fyLabel } — anchor = the LAST month of the
 * window (the month the due-date offset is measured from), all UTC.
 */
function parseTaxPeriod(taxPeriod) {
  const s = String(taxPeriod || '').trim();
  let m;

  // "YYYY-YY" — Indian FY (e.g. "2025-26"). MUST be tested before "YYYY-MM" because
  // both match /\d{4}-\d{2}/; an FY is disambiguated by the second field being > 12.
  if ((m = /^(\d{4})-(\d{2})$/.exec(s)) && +m[2] > 12) {
    const fyStart = +m[1];
    // FY runs 1 Apr fyStart → 31 Mar fyStart+1.
    return {
      kind: 'fyear', anchorYear: fyStart + 1, anchorMonth1: 3,
      periodStart: utcDate(fyStart, 4, 1),
      periodEnd: utcDate(fyStart + 1, 3, 31),
      fyLabel: s,
    };
  }

  // "YYYY-MM"
  if ((m = /^(\d{4})-(\d{2})$/.exec(s)) && +m[2] >= 1 && +m[2] <= 12) {
    const year = +m[1];
    const month1 = +m[2];
    return {
      kind: 'month', anchorYear: year, anchorMonth1: month1,
      periodStart: utcDate(year, month1, 1),
      periodEnd: utcDate(year, month1, lastDom(year, month1)),
      fyLabel: indianFyLabel(year, month1),
    };
  }

  // "YYYY-YY-Qn" — payroll-compatible FY-prefixed fiscal quarter (the form
  // service.js fileRun() writes, e.g. "2025-26-Q4"). The first YYYY is the FY
  // START year. Accepted so the engine and the payroll writer share ONE key.
  if ((m = /^(\d{4})-\d{2}-Q([1-4])$/.exec(s))) {
    const fyStart = +m[1];
    const q = +m[2];
    const startMonth = 4 + (q - 1) * 3;
    const start = addMonths(fyStart, startMonth, 0);
    const endP = addMonths(start.year, start.month1, 2);
    return {
      kind: 'quarter', anchorYear: endP.year, anchorMonth1: endP.month1,
      periodStart: utcDate(start.year, start.month1, 1),
      periodEnd: utcDate(endP.year, endP.month1, lastDom(endP.year, endP.month1)),
      fyLabel: `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`,
    };
  }

  // "YYYY-Qn" — n is the FISCAL quarter; the YYYY is the FY START year (Apr).
  if ((m = /^(\d{4})-Q([1-4])$/.exec(s))) {
    const fyStart = +m[1];
    const q = +m[2];
    // Q1 → Apr-Jun of fyStart; Q4 → Jan-Mar of fyStart+1.
    const startMonth = 4 + (q - 1) * 3; // 4,7,10,13
    const start = addMonths(fyStart, startMonth, 0);
    const endP = addMonths(start.year, start.month1, 2); // last month of quarter
    return {
      kind: 'quarter', anchorYear: endP.year, anchorMonth1: endP.month1,
      periodStart: utcDate(start.year, start.month1, 1),
      periodEnd: utcDate(endP.year, endP.month1, lastDom(endP.year, endP.month1)),
      fyLabel: `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`,
    };
  }

  // "YYYY-Hn" — half-year latch. n encodes WHICH half via the obligation's anchor
  // months (default calendar: H1=Jan-Jun anchor Jun, H2=Jul-Dec anchor Dec). The
  // ESI return uses fiscal halves (Apr-Sep / Oct-Mar) — see parseHalfPeriod which
  // the caller passes anchorMonths into. Bare parse defaults to calendar halves.
  if ((m = /^(\d{4})-H([12])$/.exec(s))) {
    return parseHalfPeriod(+m[1], +m[2], DEFAULT_HALF_ANCHORS);
  }

  // "YYYY" — calendar year (rare; LWF-annual latch).
  if ((m = /^(\d{4})$/.exec(s))) {
    const year = +m[1];
    return {
      kind: 'cyear', anchorYear: year, anchorMonth1: 12,
      periodStart: utcDate(year, 1, 1),
      periodEnd: utcDate(year, 12, 31),
      fyLabel: indianFyLabel(year, 12),
    };
  }

  const err = new Error(`Unparseable taxPeriod "${taxPeriod}"`);
  err.code = 'BAD_TAX_PERIOD';
  throw err;
}

// The "YYYY-YY" FY form collides with the month regex; disambiguate by month value.
function isFyLabel(s) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(s || ''));
  return !!(m && +m[2] > 12); // "2025-26" → 26 > 12 ; "2026-05" → 05 <= 12
}

// ── nextDueDate — the core rule ─────────────────────────────────────────────

/**
 * nextDueDate(obligation, taxPeriod) → Date (UTC midnight).
 *
 * obligation: { cadence, dueDom, dueMonths, offsetMonths, specialRules }
 *   MONTHLY: due = dueDom of (period month + offsetMonths). specialRules.marchDueDom
 *            (+ optional marchDueMonth) overrides the MARCH wage month (TDS → 30 Apr).
 *   QUARTERLY: due = dueDom of the month following the fiscal quarter end
 *            (offsetMonths after the quarter's last month).
 *   HALF_YEARLY / ANNUAL: due = dueDom of the configured dueMonths slot that follows
 *            the period (e.g. ESI return [4,10]@11; Form16/130 [6]@15; LWF-MH [1,7]@15).
 *   EVENT: throws — event obligations carry their dueDate explicitly (separation+N).
 */
function nextDueDate(obligation, taxPeriod) {
  const ob = obligation || {};
  const cadence = ob.cadence;
  const sr0 = ob.specialRules || {};
  // Honour an obligation's custom half anchors (ESI = fiscal halves [9,3]) when the
  // period is a half — re-parse with the obligation's anchors so the window/anchor
  // month is correct before we compute the due slot.
  let parsed;
  const hm = /^(\d{4})-H([12])$/.exec(String(taxPeriod || '').trim());
  if (hm && cadence === 'HALF_YEARLY' && Array.isArray(sr0.halfAnchorMonths)) {
    parsed = parseHalfPeriod(+hm[1], +hm[2], sr0.halfAnchorMonths);
  } else {
    parsed = parseTaxPeriod(taxPeriod);
  }
  const offset = Number.isInteger(ob.offsetMonths) ? ob.offsetMonths : 1;
  const dueDom = ob.dueDom != null ? ob.dueDom : 15;

  if (cadence === 'EVENT') {
    const err = new Error('EVENT obligations supply dueDate explicitly (no schedule)');
    err.code = 'EVENT_HAS_NO_SCHEDULE';
    throw err;
  }

  if (cadence === 'MONTHLY') {
    // March special-case (TDS): wage month == March → due 30 Apr (configurable).
    const sr = ob.specialRules || {};
    if (parsed.anchorMonth1 === 3 && sr.marchDueDom) {
      const marchMonth = sr.marchDueMonth || 4; // April
      const t = addMonths(parsed.anchorYear, 3, marchMonth - 3); // → that calendar month
      return utcDate(t.year, t.month1, clampDom(t.year, t.month1, sr.marchDueDom));
    }
    const t = addMonths(parsed.anchorYear, parsed.anchorMonth1, offset);
    return utcDate(t.year, t.month1, clampDom(t.year, t.month1, dueDom));
  }

  if (cadence === 'QUARTERLY') {
    // Due `offset` months after the quarter's LAST month. The Indian TDS-salary
    // return (24Q/138) Q4 (period ends 31-Mar) is due 31-May — a +2 offset — while
    // Q1-Q3 are +1. Honour specialRules.q4OffsetMonths for that single exception.
    const sr = ob.specialRules || {};
    const isQ4 = parsed.anchorMonth1 === 3; // fiscal Q4 ends in March
    const eff = (isQ4 && Number.isInteger(sr.q4OffsetMonths)) ? sr.q4OffsetMonths : offset;
    const t = addMonths(parsed.anchorYear, parsed.anchorMonth1, eff);
    return utcDate(t.year, t.month1, clampDom(t.year, t.month1, dueDom));
  }

  if (cadence === 'HALF_YEARLY' || cadence === 'ANNUAL') {
    // dueMonths lists the calendar month(s) the filing lands in. Pick the FIRST
    // listed month that is >= (period end month) within the next 14 months — i.e.
    // the slot that closes THIS period. If the slot month <= the anchor month, it
    // rolls into the next year.
    const months = (Array.isArray(ob.dueMonths) && ob.dueMonths.length)
      ? [...ob.dueMonths].sort((a, b) => a - b)
      : [parsed.anchorMonth1]; // degenerate fallback
    // The due slot is the configured month that comes strictly AFTER the period
    // end (offset semantics for half/annual is "the next listed dueMonth"). For
    // ANNUAL forms keyed off an FY (Form 16/130), the dueMonth (Jun) of the year
    // AFTER the FY-end year is the certificate deadline.
    const anchorY = parsed.anchorYear;
    const anchorM = parsed.anchorMonth1;
    let best = null;
    // search this year and next for the earliest dueMonth strictly after anchor
    for (const candYear of [anchorY, anchorY + 1]) {
      for (const dm of months) {
        if (candYear === anchorY && dm <= anchorM) continue; // must be after the period
        best = { year: candYear, month1: dm };
        break;
      }
      if (best) break;
    }
    if (!best) best = { year: anchorY + 1, month1: months[0] };
    return utcDate(best.year, best.month1, clampDom(best.year, best.month1, dueDom));
  }

  const err = new Error(`Unknown cadence "${cadence}"`);
  err.code = 'BAD_CADENCE';
  throw err;
}

// ── periodsBetween — enumerate the instances to generate over a window ───────

/**
 * periodsBetween(obligation, fromDate, toDate) → [{ taxPeriod, periodStart,
 *   periodEnd, dueDate, kind }]  — every period whose DUE DATE falls within
 *   [fromDate, toDate] (inclusive), gated by the obligation's effectiveFrom/To.
 *
 * obligation adds: { kind (family/base kind), cadence, effectiveFrom, effectiveTo }
 * `kind` returned per-instance is resolved via resolveKindForPeriod so the 24Q→138
 * / 16→130 succession is applied per period, never as a code branch.
 *
 * The window is DUE-DATE-driven (we want to materialise an obligation when its
 * deadline is approaching), so we walk candidate periods and keep those whose
 * computed dueDate lands in range.
 */
function periodsBetween(obligation, fromDate, toDate) {
  const ob = obligation || {};
  const from = toUtc(fromDate);
  const to = toUtc(toDate);
  if (ob.cadence === 'EVENT') return []; // event obligations are minted on trigger
  const effFrom = ob.effectiveFrom ? toUtc(ob.effectiveFrom) : null;
  const effTo = ob.effectiveTo ? toUtc(ob.effectiveTo) : null;

  const out = [];
  // Walk candidate periods by stepping a cursor month from a little before `from`
  // to a little after `to`, generating the taxPeriod for the cadence, computing
  // its dueDate, and keeping in-range ones. We dedupe by taxPeriod.
  const seen = new Set();
  // start the cursor ~2 months before `from` (a due date can lag its period end)
  // and run until ~14 months past `to` (annual due dates lag up to a year).
  const startCursor = addMonths(from.getUTCFullYear(), from.getUTCMonth() + 1, -3);
  const endCursor = addMonths(to.getUTCFullYear(), to.getUTCMonth() + 1, 14);
  let { year, month1 } = startCursor;
  const endAbs = endCursor.year * 12 + (endCursor.month1 - 1);
  let guard = 0;
  const halfAnchors = (ob.specialRules && Array.isArray(ob.specialRules.halfAnchorMonths))
    ? ob.specialRules.halfAnchorMonths : DEFAULT_HALF_ANCHORS;
  while (year * 12 + (month1 - 1) <= endAbs && guard < 600) {
    guard += 1;
    const tp = taxPeriodForMonth(ob.cadence, year, month1, halfAnchors);
    if (tp && !seen.has(tp)) {
      seen.add(tp);
      let parsed;
      try {
        const hm = ob.cadence === 'HALF_YEARLY' ? /^(\d{4})-H([12])$/.exec(tp) : null;
        parsed = hm ? parseHalfPeriod(+hm[1], +hm[2], halfAnchors) : parseTaxPeriod(tp);
      } catch (_e) { parsed = null; }
      if (parsed) {
        // applicability window: the PERIOD must overlap the obligation's effective range.
        const periodEndMs = parsed.periodEnd.getTime();
        const periodStartMs = parsed.periodStart.getTime();
        const okFrom = !effFrom || periodEndMs >= effFrom.getTime();
        const okTo = !effTo || periodStartMs <= effTo.getTime();
        if (okFrom && okTo) {
          let dueDate;
          try { dueDate = nextDueDate(ob, tp); } catch (_e) { dueDate = null; }
          if (dueDate && dueDate.getTime() >= from.getTime() && dueDate.getTime() <= to.getTime()) {
            out.push({
              taxPeriod: tp,
              periodStart: parsed.periodStart,
              periodEnd: parsed.periodEnd,
              dueDate,
              kind: resolveKindForPeriod(ob, parsed.periodEnd),
            });
          }
        }
      }
    }
    const nxt = addMonths(year, month1, 1);
    year = nxt.year; month1 = nxt.month1;
  }
  out.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  return out;
}

/** Build the canonical taxPeriod string for a cadence anchored at a calendar month. */
function taxPeriodForMonth(cadence, year, month1, halfAnchors = DEFAULT_HALF_ANCHORS) {
  if (cadence === 'MONTHLY') return `${year}-${String(month1).padStart(2, '0')}`;
  if (cadence === 'QUARTERLY') {
    // Only emit a quarter once, anchored at its LAST fiscal month (Jun/Sep/Dec/Mar).
    if (![6, 9, 12, 3].includes(month1)) return null;
    const fyStart = month1 >= 4 ? year : year - 1; // FY start year
    // FY-prefixed form ("2025-26-Q4") — IDENTICAL to the key service.js fileRun()
    // writes, so the generator's stub and the payroll-filed row are ONE row.
    const fyLabel = `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
    return `${fyLabel}-${indianQuarterForMonth(month1)}`;
  }
  if (cadence === 'HALF_YEARLY') {
    // Emit once per half, anchored at the LAST month of each half. Anchors default
    // to calendar halves [6,12]; ESI uses fiscal halves [9,3].
    if (month1 === halfAnchors[0]) return `${year}-H1`;
    if (month1 === halfAnchors[1]) return `${year}-H2`;
    return null;
  }
  if (cadence === 'ANNUAL') {
    // Indian-FY annual (Form 16/130, PF annual): emit once, anchored at the FY end
    // month (March), labelled by the FY that just CLOSED.
    if (month1 !== 3) return null;
    const fyStart = year - 1;
    return `${fyStart}-${String(year % 100).padStart(2, '0')}`;
  }
  return null;
}

// ── resolveKindForPeriod — effective-dated 24Q→138 / 16→130 succession ───────

/**
 * resolveKindForPeriod(obligation, periodEnd) → RemittanceKind string.
 *
 * The obligation's BASE `kind` is the family; this returns the kind that applies
 * for the given period, switching to the configured successor once the period
 * crosses the Income Tax Act 2025 boundary (1-Apr-2026). The boundary + successor
 * are DATA on the obligation (specialRules.successor / successorFrom or the
 * canonical IN defaults), never a hard-coded year branch in the runner.
 */
function resolveKindForPeriod(obligation, periodEnd) {
  const ob = obligation || {};
  const base = ob.kind;
  const sr = ob.specialRules || {};
  const succ = sr.successorKind || DEFAULT_SUCCESSOR[base];
  if (!succ) return base;
  const boundary = toUtc(sr.successorFrom || succ.from);
  const successorKind = typeof succ === 'string' ? succ : succ.kind;
  const pe = toUtc(periodEnd);
  return pe.getTime() >= boundary.getTime() ? successorKind : base;
}

// Income Tax Act 2025 succession defaults (period-end ≥ boundary ⇒ successor):
//   24Q → 138 for transactions/periods ENDING on/after 2026-04-01
//   16  → 130 for FY ending on/after 2026-04-01 (FY26-27 → first Form 130)
const DEFAULT_SUCCESSOR = Object.freeze({
  IN_FORM24Q: { kind: 'IN_FORM138', from: '2026-04-01' },
  IN_FORM16: { kind: 'IN_FORM130', from: '2026-04-01' },
});

// ── working-day shift (optional, flag-gated; off for v1) ─────────────────────

/**
 * adjustForHolidaysAndWeekends(dueDate, country, opts) → Date.
 * v1 default: returns the statutory calendar date unchanged (govt portals accept
 * the calendar due date). When opts.shift is true it pushes Sat/Sun forward to
 * Monday (holiday calendars can be layered later via holidaysAct.js).
 */
function adjustForHolidaysAndWeekends(dueDate, country, opts = {}) {
  if (!opts || !opts.shift) return toUtc(dueDate);
  const d = new Date(toUtc(dueDate).getTime());
  // 0 = Sun, 6 = Sat
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

// ── misc ─────────────────────────────────────────────────────────────────────

function toUtc(value) {
  if (value instanceof Date) {
    // normalise to UTC midnight to avoid TZ drift on @db.Date comparisons
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const s = String(value);
  // accept "YYYY-MM-DD"
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const d = new Date(s);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

module.exports = {
  nextDueDate,
  periodsBetween,
  resolveKindForPeriod,
  adjustForHolidaysAndWeekends,
  // exposed for the seed + the service.js adapter + tests
  parseTaxPeriod,
  parseHalfPeriod,
  taxPeriodForMonth,
  indianQuarterForMonth,
  indianFyLabel,
  isFyLabel,
  utcDate,
  clampDom,
  addMonths,
  DEFAULT_SUCCESSOR,
};
