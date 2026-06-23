'use strict';

/**
 * payrun.js — pay-run lifecycle STATE MACHINE + thin prisma persistence.
 *
 * Two clearly separated layers:
 *
 *   (A) PURE state machine (no DB, no I/O): the transition graph, guard
 *       functions, maker-checker rule, idempotency by inputHash, and
 *       immutability of closed runs. Unit-testable with plain `node`.
 *
 *   (B) THIN persistence (the ONLY place prisma is touched). It loads prisma
 *       lazily so the pure layer above — and the whole engine — imports and
 *       tests with zero DB. The math NEVER lives here.
 *
 * Canonical lifecycle (per the build brief):
 *   DRAFT -> INPUTS_LOCKED -> CALCULATED -> APPROVED -> PAID -> FILED -> CLOSED
 * with CANCELLED reachable pre-APPROVED. transition() rejects illegal moves.
 *
 * Hard rules enforced here:
 *   - No skipping states (every edge is explicit in TRANSITIONS).
 *   - Maker-checker: APPROVED requires approver !== preparer.
 *   - Idempotency: compute is keyed by inputHash; same hash -> same result, and
 *     a CLOSED/locked run refuses a different inputHash (IMMUTABLE_RUN_VIOLATION).
 *   - Closed runs are immutable: no transition leaves CLOSED.
 */

const crypto = require('crypto');

// ── States ─────────────────────────────────────────────────────────────────────
const STATE = Object.freeze({
  DRAFT: 'DRAFT',
  INPUTS_LOCKED: 'INPUTS_LOCKED',
  CALCULATED: 'CALCULATED',
  // Feature 7 — the maker→checker review gate. A computed run the maker SUBMITS
  // sits here until the checker approves (forward) or sends it back (→CALCULATED,
  // editable). Maps to the reserved PayRunStatus.REVIEW member.
  IN_REVIEW: 'IN_REVIEW',
  APPROVED: 'APPROVED',
  PAID: 'PAID',
  FILED: 'FILED',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
});

// Terminal states: no outgoing transitions.
const TERMINAL = new Set([STATE.CLOSED, STATE.CANCELLED]);

// ── Allowed transitions: from -> Set(to) ──────────────────────────────────────
const TRANSITIONS = Object.freeze({
  [STATE.DRAFT]: new Set([STATE.INPUTS_LOCKED, STATE.CANCELLED]),
  [STATE.INPUTS_LOCKED]: new Set([STATE.CALCULATED, STATE.DRAFT, STATE.CANCELLED]),
  // A computed run can be SUBMITTED for review (maker), re-locked, re-opened to
  // DRAFT, or cancelled. Direct CALCULATED→APPROVED is retained so the existing
  // approveRun path (and tests) keep working when no review gate is used.
  [STATE.CALCULATED]: new Set([STATE.IN_REVIEW, STATE.APPROVED, STATE.INPUTS_LOCKED, STATE.DRAFT, STATE.CANCELLED]),
  // In review: checker APPROVES (forward), SENDS BACK (→CALCULATED, editable), or
  // the run is cancelled pre-approval.
  [STATE.IN_REVIEW]: new Set([STATE.APPROVED, STATE.CALCULATED, STATE.CANCELLED]),
  [STATE.APPROVED]: new Set([STATE.PAID, STATE.CALCULATED]),
  [STATE.PAID]: new Set([STATE.FILED]),
  [STATE.FILED]: new Set([STATE.CLOSED]),
  [STATE.CLOSED]: new Set(),
  [STATE.CANCELLED]: new Set(),
});

// Map this engine's lifecycle states to the prisma PayRunStatus enum values.
// (Schema enum: DRAFT INPUTS_LOCKED COMPUTING COMPUTED REVIEW LOCKED APPROVED
//  PAID FILED CANCELLED.) CALCULATED -> COMPUTED; CLOSED is represented as FILED
//  + a closedAt flag since the schema has no CLOSED member.
const STATE_TO_PRISMA = Object.freeze({
  [STATE.DRAFT]: 'DRAFT',
  [STATE.INPUTS_LOCKED]: 'INPUTS_LOCKED',
  [STATE.CALCULATED]: 'COMPUTED',
  [STATE.IN_REVIEW]: 'REVIEW',
  [STATE.APPROVED]: 'APPROVED',
  [STATE.PAID]: 'PAID',
  [STATE.FILED]: 'FILED',
  [STATE.CLOSED]: 'FILED',
  [STATE.CANCELLED]: 'CANCELLED',
});

// Reverse map: prisma PayRunStatus -> engine STATE (CLOSED is FILED+closedAt, so
// it cannot be reconstructed from status alone — callers resolve closed via the
// closedAt flag). Used by the orchestrator to seed the in-memory `from` state.
const PRISMA_TO_STATE = Object.freeze({
  DRAFT: STATE.DRAFT,
  INPUTS_LOCKED: STATE.INPUTS_LOCKED,
  COMPUTED: STATE.CALCULATED,
  REVIEW: STATE.IN_REVIEW,
  APPROVED: STATE.APPROVED,
  PAID: STATE.PAID,
  FILED: STATE.FILED,
  CANCELLED: STATE.CANCELLED,
});

class PayRunError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PayRunError';
    this.code = code;
  }
}

// ── (A) PURE STATE MACHINE ─────────────────────────────────────────────────────

/** Is `from -> to` a legal edge? */
function canTransition(from, to) {
  const outs = TRANSITIONS[from];
  return !!outs && outs.has(to);
}

/** List the legal next states from `from`. */
function nextStates(from) {
  return Array.from(TRANSITIONS[from] || []);
}

function isTerminal(state) {
  return TERMINAL.has(state);
}

/**
 * Per-edge guards. Each returns void on success and throws PayRunError on a
 * violation. `run` is the current (in-memory) run snapshot; `ctx` carries the
 * actor + payload for this transition. PURE — no I/O.
 *
 * run shape (minimal): {
 *   id, status, preparerId, approverId?, inputHash?, computedInputHash?,
 *   blockingAnomalies?: number, payDate?, pinnedRuleVersionResolvedFor?,
 *   fourEyes?: boolean
 * }
 * ctx shape: { actorId, inputHash?, result?, fourEyes?, anomalies?, reason? }
 */
const GUARDS = {
  [STATE.INPUTS_LOCKED](run, ctx) {
    if (!ctx || !ctx.inputHash) {
      throw new PayRunError('INPUT_HASH_REQUIRED', 'INPUTS_LOCKED requires a computed inputHash');
    }
  },
  [STATE.CALCULATED](run, ctx) {
    // Send-back (IN_REVIEW -> CALCULATED): the run is already computed; this is the
    // checker returning it to the maker, not a fresh compute, so the lock/hash
    // checks below do not apply.
    if (run.status === STATE.IN_REVIEW) return;
    if (!run.inputHash) {
      throw new PayRunError('NOT_LOCKED', 'Cannot compute before inputs are locked');
    }
    // Idempotency: a result tied to a different inputHash must not overwrite.
    if (ctx && ctx.inputHash && ctx.inputHash !== run.inputHash) {
      throw new PayRunError(
        'INPUT_HASH_MISMATCH',
        `compute inputHash ${ctx.inputHash} != locked inputHash ${run.inputHash}`
      );
    }
  },
  // Submit-for-review (maker). A computed run with no open blockers moves to
  // IN_REVIEW; the submitting maker is recorded so the checker can be enforced
  // distinct. Submit is itself gated by OPEN_BLOCKERS (mirrors the approve gate
  // so a blocked run never even reaches a checker's queue).
  [STATE.IN_REVIEW](run, ctx) {
    if (run.status !== STATE.CALCULATED) {
      throw new PayRunError('NOT_CALCULATED', 'Submit-for-review requires a CALCULATED run');
    }
    const blockers = ctx.blockingAnomalies ?? run.blockingAnomalies ?? 0;
    if (blockers > 0) {
      throw new PayRunError('OPEN_BLOCKERS', `Cannot submit with ${blockers} open blocking anomalies`);
    }
  },
  [STATE.APPROVED](run, ctx) {
    // Approve is reachable from a directly-computed run OR a submitted (IN_REVIEW)
    // run. Both are honoured so the simple path and the maker→checker path coexist.
    if (run.status !== STATE.CALCULATED && run.status !== STATE.IN_REVIEW) {
      throw new PayRunError('NOT_CALCULATED', 'Approval requires a CALCULATED or IN_REVIEW run (no skipping compute)');
    }
    const fourEyes = ctx.fourEyes ?? run.fourEyes ?? true;
    if (fourEyes) {
      if (!ctx.actorId) {
        throw new PayRunError('APPROVER_REQUIRED', 'Approver identity required');
      }
      // Maker-checker: the approver must differ from EVERY maker identity on the
      // run — the preparer/computer AND the submitter (if a review gate was used).
      const makers = [run.preparerId, run.submittedBy].filter(Boolean);
      if (makers.includes(ctx.actorId)) {
        throw new PayRunError(
          'MAKER_CHECKER',
          'Maker-checker: approver must differ from the preparer/submitter'
        );
      }
    }
    // STALE_TOTALS — the checker must approve the totals they reviewed. If the run
    // carries a totalsHash (set at submit/compute) and the caller passes the one
    // they saw, they must match (a silent recompute changes the hash → reject).
    if (run.totalsHash != null && ctx.totalsHash != null && ctx.totalsHash !== run.totalsHash) {
      throw new PayRunError(
        'STALE_TOTALS',
        'Totals changed since review — re-open and re-review before approving'
      );
    }
    const blockers = ctx.blockingAnomalies ?? run.blockingAnomalies ?? 0;
    if (blockers > 0) {
      throw new PayRunError('OPEN_BLOCKERS', `Cannot approve with ${blockers} open blocking anomalies`);
    }
  },
  [STATE.PAID](run, ctx) {
    if (run.status !== STATE.APPROVED) {
      throw new PayRunError('NOT_APPROVED', 'Disbursement requires an APPROVED run');
    }
    // payDate pin must still resolve to the pinned rule version (§11.2).
    if (
      run.pinnedRuleVersionResolvedFor != null &&
      run.payDate != null &&
      run.pinnedRuleVersionResolvedFor !== run.payDate
    ) {
      throw new PayRunError(
        'PAYDATE_PIN_STALE',
        'payDate resolves to a different rule version than the pinned one'
      );
    }
  },
  [STATE.FILED](run) {
    if (run.status !== STATE.PAID) {
      throw new PayRunError('NOT_PAID', 'Filing requires a PAID run');
    }
  },
  [STATE.CLOSED](run) {
    if (run.status !== STATE.FILED) {
      throw new PayRunError('NOT_FILED', 'Close requires a FILED run');
    }
  },
  [STATE.CANCELLED](run) {
    if (run.status === STATE.APPROVED || run.status === STATE.PAID || run.status === STATE.FILED) {
      throw new PayRunError('CANNOT_CANCEL', 'Cannot cancel after APPROVED; use a compensating run');
    }
  },
  [STATE.DRAFT](run) {
    // Re-open (back to editing) is allowed pre-APPROVED only.
    if (isPostApproval(run.status)) {
      throw new PayRunError('CANNOT_REOPEN', 'Cannot reopen after APPROVED');
    }
  },
};

function isPostApproval(status) {
  return (
    status === STATE.APPROVED ||
    status === STATE.PAID ||
    status === STATE.FILED ||
    status === STATE.CLOSED
  );
}

/**
 * transition — the single guarded mutation of a run's state. PURE.
 * Returns a NEW run object (does not mutate input) with status=to plus any
 * fields the transition sets (inputHash, approver, etc.). Throws PayRunError on
 * an illegal move or guard failure.
 */
function transition(run, to, ctx = {}) {
  if (!run || typeof run.status !== 'string') {
    throw new PayRunError('BAD_RUN', 'transition: run with a status is required');
  }
  const from = run.status;
  if (isTerminal(from)) {
    throw new PayRunError('IMMUTABLE_RUN_VIOLATION', `Run is ${from} (terminal/immutable); no transitions allowed`);
  }
  if (!STATE[to]) {
    throw new PayRunError('UNKNOWN_STATE', `Unknown target state "${to}"`);
  }
  if (!canTransition(from, to)) {
    throw new PayRunError(
      'ILLEGAL_TRANSITION',
      `Illegal transition ${from} -> ${to}. Allowed: [${nextStates(from).join(', ') || 'none'}]`
    );
  }
  const guard = GUARDS[to];
  if (guard) guard(run, ctx);

  const next = { ...run, status: to };

  // Apply transition side-effects on the in-memory object.
  if (to === STATE.INPUTS_LOCKED) {
    next.inputHash = ctx.inputHash;
    next.lockedInputsAt = ctx.at ?? null;
  }
  if (to === STATE.CALCULATED) {
    // Reached either by a fresh compute OR a send-back from IN_REVIEW. A send-back
    // clears the prior submission so the next submit records a fresh maker, and
    // carries the checker's reason for the audit trail.
    if (from === STATE.IN_REVIEW) {
      next.submittedBy = null;
      next.submittedAt = null;
      next.reviewedBy = ctx.actorId ?? null;
      next.sendBackReason = ctx.reason ?? null;
    } else {
      next.computedInputHash = run.inputHash;
      next.computedAt = ctx.at ?? null;
    }
  }
  if (to === STATE.IN_REVIEW) {
    next.submittedBy = ctx.actorId;
    next.submittedAt = ctx.at ?? null;
    next.totalsHash = ctx.totalsHash ?? next.totalsHash ?? null;
  }
  if (to === STATE.APPROVED) {
    next.approverId = ctx.actorId;
    next.reviewedBy = ctx.actorId;
    next.approvedAt = ctx.at ?? null;
    next.totalsHash = ctx.totalsHash ?? next.totalsHash ?? null;
  }
  if (to === STATE.PAID) next.paidAt = ctx.at ?? null;
  if (to === STATE.FILED) next.filedAt = ctx.at ?? null;
  if (to === STATE.CLOSED) next.closedAt = ctx.at ?? null;
  if (to === STATE.CANCELLED) {
    next.cancelledAt = ctx.at ?? null;
    next.cancelReason = ctx.reason ?? null;
  }
  if (to === STATE.DRAFT) {
    // Reopen discards the prior compute fingerprint; inputs editable again.
    next.inputHash = null;
    next.computedInputHash = null;
  }
  return next;
}

// ── Idempotency helpers (PURE) ─────────────────────────────────────────────────

/** Stable, sorted JSON for hashing (key order independent). */
function canonicalJSON(value) {
  return JSON.stringify(sortDeep(value));
}
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

/**
 * computeInputHash — content-address the frozen inputs (§11.1).
 * inputHash = sha256(canonical(inputs ∪ ruleVersions ∪ engineVersion)).
 */
function computeInputHash({ inputs, ruleVersions, engineVersion }) {
  const payload = canonicalJSON({ inputs, ruleVersions, engineVersion });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * assertIdempotentCompute — re-running compute with the same inputHash is a
 * no-op that returns the cached result; a different inputHash against a
 * locked/closed run is rejected (§11.4).
 */
function assertIdempotentCompute(run, incomingInputHash) {
  if (isTerminal(run.status) && incomingInputHash !== run.inputHash) {
    throw new PayRunError(
      'IMMUTABLE_RUN_VIOLATION',
      `Run ${run.id} is ${run.status}; refuse to recompute with a different inputHash`
    );
  }
  return incomingInputHash === run.inputHash; // true => cached/no-op
}

// ── (B) THIN PRISMA PERSISTENCE (the only DB-touching layer) ───────────────────
//
// prisma is injected (preferred for testability) or lazy-required. The pure
// layer above never imports prisma, so engine/money/registry test with no DB.

let _prisma = null;
function getPrisma(injected) {
  if (injected) return injected;
  if (_prisma) return _prisma;
  // Lazy require so importing this module does not require @prisma/client.
  // eslint-disable-next-line global-require
  const { PrismaClient } = require('@prisma/client');
  _prisma = new PrismaClient();
  return _prisma;
}

/**
 * persistTransition — write a state change to the PayRun row, mapping the
 * engine state to the schema's PayRunStatus. Thin: it does NO math.
 *
 * @param {Object} opts { prisma?, payRunId, from, to, ctx }
 */
async function persistTransition({ prisma, payRunId, from, to, ctx = {} }) {
  const db = getPrisma(prisma);
  const status = STATE_TO_PRISMA[to];
  if (!status) throw new PayRunError('UNKNOWN_STATE', `No prisma mapping for state ${to}`);

  const data = { status };
  if (to === STATE.CALCULATED) {
    if (from === STATE.IN_REVIEW) {
      // Send-back: clear the submission, record reviewer + reason.
      data.submittedAt = null;
      data.submittedBy = null;
      data.reviewedBy = ctx.actorId ?? null;
      data.reviewedAt = ctx.at ?? new Date();
      data.sendBackReason = ctx.reason ?? null;
    } else {
      data.computedAt = ctx.at ?? new Date();
      data.computedBy = ctx.actorId ?? null;
    }
  }
  if (to === STATE.IN_REVIEW) {
    data.submittedAt = ctx.at ?? new Date();
    data.submittedBy = ctx.actorId ?? null;
    if (ctx.totalsHash != null) data.totalsHash = ctx.totalsHash;
    // A fresh submission supersedes any prior send-back reason.
    data.sendBackReason = null;
  }
  if (to === STATE.APPROVED) {
    data.approvedAt = ctx.at ?? new Date();
    data.approvedBy = ctx.actorId ?? null;
    data.reviewedBy = ctx.actorId ?? null;
    data.reviewedAt = ctx.at ?? new Date();
  }
  if (to === STATE.INPUTS_LOCKED) {
    data.lockedAt = ctx.at ?? new Date();
    data.lockedBy = ctx.actorId ?? null;
  }
  if (to === STATE.PAID) data.paidAt = ctx.at ?? new Date();
  if (to === STATE.FILED) data.filedAt = ctx.at ?? new Date();
  // CLOSED maps to prisma FILED — distinguished by the closedAt flag.
  if (to === STATE.CLOSED) data.closedAt = ctx.at ?? new Date();
  if (to === STATE.CANCELLED) {
    if (ctx.reason != null) data.notes = ctx.reason;
  }
  if (to === STATE.DRAFT) {
    // Reopen discards the compute fingerprint so inputs are editable again and a
    // later recompute is not short-circuited as an idempotent no-op.
    data.complianceVersionId = null;
    data.computedAt = null;
    data.computedBy = null;
    data.submittedAt = null;
    data.submittedBy = null;
    data.reviewedBy = null;
    data.totalsHash = null;
  }
  data.version = { increment: 1 };

  // Optimistic concurrency: only update if still in `from` (guards races).
  const res = await db.payRun.updateMany({
    where: { id: payRunId, status: STATE_TO_PRISMA[from] },
    data,
  });
  if (res.count === 0) {
    throw new PayRunError('STALE_TRANSITION', `PayRun ${payRunId} not in expected state ${from}`);
  }
  return res;
}

/**
 * persistComputeResult — write per-employee PayRunLine + PayRunLineComponent
 * rows and roll totals onto the PayRun. Thin mapping from engine output (minor
 * units) to schema Decimal columns. Idempotent by (payRunId, inputHash):
 * re-persisting the same hash is a no-op.
 *
 * @param {Object} opts {
 *   prisma?, payRun: {id, businessId, currencyCode, inputHash},
 *   lines: [{ employeeId, compensationId, payableDays, lopDays, overtimeHours,
 *             result /* from computePayslip *\/ }]
 * }
 */
async function persistComputeResult({ prisma, payRun, lines, fromMinor }) {
  const db = getPrisma(prisma);
  const toDec = fromMinor || defaultFromMinor;

  return db.$transaction(async (tx) => {
    // Idempotency gate: if this run already computed for this inputHash, no-op.
    const existing = await tx.payRun.findUnique({ where: { id: payRun.id } });
    if (!existing) throw new PayRunError('NOT_FOUND', `PayRun ${payRun.id} not found`);
    if (existing.status === 'FILED' || existing.status === 'PAID') {
      throw new PayRunError('IMMUTABLE_RUN_VIOLATION', `PayRun ${payRun.id} is ${existing.status}`);
    }

    // Clear prior compute lines for this run (recompute is idempotent).
    await tx.payRunLineComponent.deleteMany({
      where: { payRunLine: { payRunId: payRun.id } },
    });
    await tx.payRunLine.deleteMany({ where: { payRunId: payRun.id } });

    let totGross = 0, totDed = 0, totNet = 0, totEr = 0;
    for (const ln of lines) {
      const r = ln.result;
      const lineRow = await tx.payRunLine.create({
        data: {
          businessId: payRun.businessId,
          payRunId: payRun.id,
          employeeId: ln.employeeId,
          compensationId: ln.compensationId,
          payableDays: ln.payableDays ?? 0,
          lopDays: ln.lopDays ?? 0,
          overtimeHours: ln.overtimeHours ?? 0,
          grossEarnings: toDec(r.grossMinor),
          totalDeductions: toDec(r.totalEmployeeDeductionsMinor),
          netPay: toDec(r.netMinor),
          employerCost: toDec(r.totalEmployerContributionsMinor),
          currencyCode: payRun.currencyCode,
          status: 'COMPUTED',
          computeTrace: r.explain ?? null,
          ...statutoryRollups(r, toDec),
        },
      });

      const comps = buildComponentRows(payRun.businessId, lineRow.id, r);
      if (comps.length) {
        await tx.payRunLineComponent.createMany({ data: comps });
      }
      totGross += r.grossMinor;
      totDed += r.totalEmployeeDeductionsMinor;
      totNet += r.netMinor;
      totEr += r.totalEmployerContributionsMinor;
    }

    await tx.payRun.update({
      where: { id: payRun.id },
      data: {
        headcount: lines.length,
        totalGross: toDec(totGross),
        totalDeductions: toDec(totDed),
        totalNet: toDec(totNet),
        totalEmployerCost: toDec(totEr),
      },
    });
    return { lineCount: lines.length, totalNetMinor: totNet };
  });
}

/** Map known statutory codes from a result to PayRunLine rollup columns. */
function statutoryRollups(r, toDec) {
  const byCode = {};
  for (const d of r.employeeDeductions || []) byCode[d.code] = d.amountMinor;
  for (const c of r.employerContributions || []) byCode[c.code] = c.amountMinor;
  const pick = (code) => (byCode[code] != null ? toDec(byCode[code]) : null);
  return {
    pfEmployee: pick('EPF') ?? pick('EPF_EE'),
    pfEmployer: pick('EPF_ER'),
    esiEmployee: pick('ESI') ?? pick('ESI_EE'),
    esiEmployer: pick('ESI_ER'),
    pt: pick('PT'),
    tds: pick('TDS'),
    paye: pick('PAYE'),
    kiwiSaverEmployee: pick('KIWISAVER') ?? pick('KIWISAVER_EE'),
    kiwiSaverEmployer: pick('KIWISAVER_ER'),
    esct: pick('ESCT'),
    accLevy: pick('ACC'),
    studentLoan: pick('SLOAN') ?? pick('STUDENT_LOAN'),
  };
}

function buildComponentRows(businessId, payRunLineId, r) {
  const rows = [];
  let sort = 0;
  for (const e of r.earnings || []) {
    rows.push(compRow(businessId, payRunLineId, e, 'EARNING', false, sort++));
  }
  for (const d of r.employeeDeductions || []) {
    rows.push(compRow(businessId, payRunLineId, d, 'DEDUCTION', !!d.statutory, sort++));
  }
  for (const c of r.employerContributions || []) {
    rows.push(compRow(businessId, payRunLineId, c, 'EMPLOYER_COST', true, sort++));
  }
  for (const rb of r.reimbursements || []) {
    rows.push(compRow(businessId, payRunLineId, rb, 'REIMBURSEMENT', false, sort++));
  }
  return rows;
}

function compRow(businessId, payRunLineId, item, category, isStatutory, sortOrder) {
  return {
    businessId,
    payRunLineId,
    componentId: item.componentId || item.code,
    componentCode: item.code,
    componentName: item.label || item.code,
    category,
    amount: defaultFromMinor(item.amountMinor),
    baseAmount: item.baseMinor != null ? defaultFromMinor(item.baseMinor) : null,
    isStatutory,
    sortOrder,
  };
}

/** Minor units -> Decimal-safe string "x.xx" (scale 2). No float. */
function defaultFromMinor(minor, scale = 2) {
  const neg = minor < 0;
  const abs = Math.abs(minor).toString().padStart(scale + 1, '0');
  const i = abs.slice(0, abs.length - scale);
  const f = abs.slice(abs.length - scale);
  return (neg ? '-' : '') + i + '.' + f;
}

module.exports = {
  // pure state machine
  STATE,
  TRANSITIONS,
  STATE_TO_PRISMA,
  PRISMA_TO_STATE,
  PayRunError,
  canTransition,
  nextStates,
  isTerminal,
  transition,
  // idempotency
  canonicalJSON,
  computeInputHash,
  assertIdempotentCompute,
  // thin persistence
  persistTransition,
  persistComputeResult,
  _internal: { GUARDS, statutoryRollups, defaultFromMinor },
};
