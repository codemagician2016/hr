'use strict';

/**
 * variance.js — PURE variance / exception engine for a pay run (Feature 7 §5.1).
 *
 * Same discipline as engine.js / compliance/*: NO DB, NO I/O, NO Date.now.
 * Integer minor units in → sorted, structured findings out. Golden-testable like
 * india.golden.test.js: deterministic for a fixed (current, previous, thresholds).
 *
 * The orchestrator (service.computeVariance) does the only impure work — fetch
 * the prior period's lines, call runVarianceChecks(), then persist the per-line
 * findings to PayRunLine.errorJson (the array approveRun already re-reads for the
 * blockingAnomalies gate) and the run-level roll-up to PayRun.varianceReport.
 *
 *   Line shape (current + previous):
 *     { employeeId, status, grossMinor, netMinor,
 *       components: [{ code, amountMinor, statutory? }],
 *       payableDays?, lopDays?, isNewJoiner?, isLeaver?, hasBankDetail?,
 *       hasCompRevision?, hasArrear? }
 *
 *   Finding shape:
 *     { code, severity:'BLOCKER'|'WARNING'|'INFO', employeeId|null,
 *       scope:'EMPLOYEE'|'RUN', metric, baseline, observed, deltaMinor, deltaPct,
 *       message, suggestedAction }
 */

const SEV = Object.freeze({ BLOCKER: 'BLOCKER', WARNING: 'WARNING', INFO: 'INFO' });
const SEV_RANK = Object.freeze({ BLOCKER: 0, WARNING: 1, INFO: 2 });

// Default per-tenant tolerances. A tenant's VarianceThreshold.config overrides.
const DEFAULT_THRESHOLDS = Object.freeze({
  softNetPct: 0.25, // |Δ%(net)| >= this → WARNING outlier
  hardNetPct: 0.60, // |Δ%(net)| >= this → BLOCKER outlier (continuing employee)
  grossPct: 0.25, // |Δ%(gross)| >= this → WARNING
  componentPct: 0.30, // per-component |Δ%| >= this (or appear/vanish) → WARNING
  lopSpikeDays: 5, // lopDays jump >= this → WARNING
  absMinFloorMinor: 50_00, // outlier-math floor so ₹10→₹40 doesn't scream +300%
  statutoryRateTolerance: 0.005, // effective-rate drift band → WARNING
  newJoinerSuppressesOutliers: true,
  leaverSuppressesOutliers: true,
});

// Codes whose component is statutory (used by STATUTORY_DROP_TO_ZERO + rate drift).
const STATUTORY_CODES = Object.freeze([
  'EPF', 'EPF_EE', 'EPF_ER', 'EPS_ER', 'EDLI', 'ADMIN', 'ESI', 'ESI_EE', 'ESI_ER',
  'PT', 'TDS', 'PAYE', 'KIWISAVER', 'KIWISAVER_EE', 'KIWISAVER_ER', 'ESCT', 'ACC',
  'SLOAN', 'STUDENT_LOAN',
]);
const STATUTORY_SET = new Set(STATUTORY_CODES);

// ── helpers (pure) ──────────────────────────────────────────────────────────

function num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Integer-minor-unit Δ% with a floor so a tiny baseline can't blow up the ratio. */
function deltaPct(observedMinor, baselineMinor, floorMinor) {
  const o = num(observedMinor);
  const b = num(baselineMinor);
  const denom = Math.max(Math.abs(b), num(floorMinor, 1) || 1);
  return (o - b) / denom;
}

/** Map a line's components array to a { code → amountMinor } lookup. */
function componentMap(line) {
  const m = new Map();
  for (const c of (line && line.components) || []) {
    m.set(c.code, num(c.amountMinor));
  }
  return m;
}

function isActive(line) {
  // EXCLUDED / ON_HOLD lines are intentionally out of the run; skip input checks.
  const s = String(line.status || '').toUpperCase();
  return s !== 'EXCLUDED' && s !== 'ON_HOLD';
}

function roundPct(p) {
  // Stable display rounding (4 dp) so golden expecteds are exact.
  return Math.round(p * 10000) / 10000;
}

function makeFinding(f) {
  return {
    code: f.code,
    severity: f.severity,
    employeeId: f.employeeId == null ? null : f.employeeId,
    scope: f.scope || (f.employeeId == null ? 'RUN' : 'EMPLOYEE'),
    metric: f.metric == null ? null : f.metric,
    baseline: f.baseline == null ? null : f.baseline,
    observed: f.observed == null ? null : f.observed,
    deltaMinor: f.deltaMinor == null ? null : f.deltaMinor,
    deltaPct: f.deltaPct == null ? null : roundPct(f.deltaPct),
    message: f.message || f.code,
    suggestedAction: f.suggestedAction || null,
  };
}

// ── main ────────────────────────────────────────────────────────────────────

/**
 * runVarianceChecks — PURE. Deterministic. No I/O.
 *
 * @param {Object} args { current, previous|null, thresholds? }
 * @returns {{ findings: Finding[], summary, blockingAnomalies }}
 */
function runVarianceChecks({ current, previous = null, thresholds } = {}) {
  const T = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const findings = [];

  const curLines = (current && current.lines) || [];
  const prevLines = (previous && previous.lines) || [];
  const prevByEmp = new Map();
  for (const l of prevLines) prevByEmp.set(l.employeeId, l);

  const isFnf = current && String(current.type || '').toUpperCase() === 'FNF';
  const hasBaseline = !!previous && prevLines.length > 0;

  // ── 1. per-employee checks ──
  const seenEmp = new Set();
  for (const cur of curLines) {
    const empId = cur.employeeId;
    const prev = prevByEmp.get(empId) || null;

    // DUPLICATE_EMPLOYEE — two lines for the same employee in this run (BLOCKER).
    if (seenEmp.has(empId)) {
      findings.push(makeFinding({
        code: 'DUPLICATE_EMPLOYEE', severity: SEV.BLOCKER, employeeId: empId, scope: 'EMPLOYEE',
        metric: 'employeeId', message: `Employee ${empId} appears on more than one line in this run.`,
        suggestedAction: 'Remove the duplicate line before approving.',
      }));
      continue;
    }
    seenEmp.add(empId);

    const gross = num(cur.grossMinor);
    const net = num(cur.netMinor);
    const active = isActive(cur);

    // Context flags drive the INFO downgrades.
    const isJoiner = !!cur.isNewJoiner || (!prev && hasBaseline);
    const isLeaver = !!cur.isLeaver;
    const hasRevision = !!cur.hasCompRevision;
    const hasArrear = !!cur.hasArrear;
    const suppressOutlier =
      (isJoiner && T.newJoinerSuppressesOutliers) ||
      (isLeaver && T.leaverSuppressesOutliers) ||
      hasRevision || hasArrear;

    // INFO context findings (each downgrades a matching outlier to context).
    if (isJoiner) {
      findings.push(makeFinding({
        code: 'NEW_JOINER', severity: SEV.INFO, employeeId: empId, scope: 'EMPLOYEE',
        metric: 'net', observed: net, message: `New joiner — first appearance this period.`,
      }));
    }
    if (isLeaver) {
      findings.push(makeFinding({
        code: 'LEAVER', severity: SEV.INFO, employeeId: empId, scope: 'EMPLOYEE',
        metric: 'net', observed: net, message: `Leaver — final pay this period.`,
      }));
    }
    if (hasRevision) {
      findings.push(makeFinding({
        code: 'COMP_REVISION_APPLIED', severity: SEV.INFO, employeeId: empId, scope: 'EMPLOYEE',
        metric: 'net', observed: net, message: `A compensation revision is effective this period.`,
      }));
    }
    if (hasArrear) {
      findings.push(makeFinding({
        code: 'ARREAR_BOOKED', severity: SEV.INFO, employeeId: empId, scope: 'EMPLOYEE',
        metric: 'net', observed: net, message: `An arrear / one-time item is booked this period.`,
      }));
    }

    // NEGATIVE_NET (BLOCKER) — except FnF which legitimately allows recoverable negative.
    if (net < 0 && !isFnf) {
      findings.push(makeFinding({
        code: 'NEGATIVE_NET', severity: SEV.BLOCKER, employeeId: empId, scope: 'EMPLOYEE',
        metric: 'net', observed: net,
        message: `Net pay is negative (${net} minor units).`,
        suggestedAction: 'Cap recoveries to net or move the deduction to a CORRECTION run.',
      }));
    }

    // ZERO_NET_UNEXPECTED (BLOCKER) — net 0 while gross > 0 (and not a deliberate leaver/joiner with zero).
    if (net === 0 && gross > 0) {
      findings.push(makeFinding({
        code: 'ZERO_NET_UNEXPECTED', severity: SEV.BLOCKER, employeeId: empId, scope: 'EMPLOYEE',
        metric: 'net', observed: net, baseline: gross,
        message: `Net is zero while gross is ${gross} — deductions consumed the entire pay.`,
        suggestedAction: 'Review deductions; an employee should rarely net zero.',
      }));
    }

    // DEDUCTION_EXCEEDS_GROSS (BLOCKER) — total deductions strictly exceed gross.
    if (active && gross > 0 && (gross - net) > gross && !isFnf) {
      findings.push(makeFinding({
        code: 'DEDUCTION_EXCEEDS_GROSS', severity: SEV.BLOCKER, employeeId: empId, scope: 'EMPLOYEE',
        metric: 'deductions', observed: gross - net, baseline: gross,
        message: `Total deductions (${gross - net}) exceed gross (${gross}).`,
        suggestedAction: 'Cap recoveries; deductions cannot exceed gross outside FnF.',
      }));
    }

    // MISSING_INPUT (BLOCKER) — active employee with no payable-days input and no exclusion.
    // payableDays == null (not provided) on an active line ⇒ inputs were never frozen.
    if (active && (cur.payableDays == null) && gross === 0 && !isJoiner && !isLeaver) {
      findings.push(makeFinding({
        code: 'MISSING_INPUT', severity: SEV.BLOCKER, employeeId: empId, scope: 'EMPLOYEE',
        metric: 'payableDays', observed: null,
        message: `No attendance/payable-days input for an active employee with zero gross.`,
        suggestedAction: 'Freeze attendance or exclude the employee from this run.',
      }));
    }

    // NO_COMPENSATION (BLOCKER) — gross 0 and no components at all on an active line.
    if (active && gross === 0 && (!cur.components || cur.components.length === 0) && !isLeaver) {
      findings.push(makeFinding({
        code: 'NO_COMPENSATION', severity: SEV.BLOCKER, employeeId: empId, scope: 'EMPLOYEE',
        metric: 'gross', observed: 0,
        message: `No resolved compensation — the employee produced no earning lines.`,
        suggestedAction: 'Assign a current pay structure before computing.',
      }));
    }

    // BANK_DETAIL_MISSING (WARNING) — positive net but no valid payee on file.
    if (net > 0 && cur.hasBankDetail === false) {
      findings.push(makeFinding({
        code: 'BANK_DETAIL_MISSING', severity: SEV.WARNING, employeeId: empId, scope: 'EMPLOYEE',
        metric: 'net', observed: net,
        message: `Net ${net} payable but no valid bank account / payee on file.`,
        suggestedAction: 'Capture bank details before the bank file is generated.',
      }));
    }

    // ── period-over-period outliers (need a prior line) ──
    if (prev) {
      const prevNet = num(prev.netMinor);
      const prevGross = num(prev.grossMinor);

      // NET outlier.
      const netDp = deltaPct(net, prevNet, T.absMinFloorMinor);
      const absNetDp = Math.abs(netDp);
      if (absNetDp >= T.hardNetPct && !suppressOutlier) {
        findings.push(makeFinding({
          code: 'NET_PCT_OUTLIER_HARD', severity: SEV.BLOCKER, employeeId: empId, scope: 'EMPLOYEE',
          metric: 'net', baseline: prevNet, observed: net, deltaMinor: net - prevNet, deltaPct: netDp,
          message: `Net swung ${(netDp * 100).toFixed(1)}% vs last period with no revision/arrear reason.`,
          suggestedAction: 'Confirm the change is intended, or attach a revision/arrear.',
        }));
      } else if (absNetDp >= T.softNetPct) {
        findings.push(makeFinding({
          code: 'NET_PCT_OUTLIER', severity: suppressOutlier ? SEV.INFO : SEV.WARNING,
          employeeId: empId, scope: 'EMPLOYEE',
          metric: 'net', baseline: prevNet, observed: net, deltaMinor: net - prevNet, deltaPct: netDp,
          message: `Net moved ${(netDp * 100).toFixed(1)}% vs last period.`,
          suggestedAction: suppressOutlier ? null : 'Acknowledge or investigate the swing.',
        }));
      }

      // GROSS outlier.
      const grossDp = deltaPct(gross, prevGross, T.absMinFloorMinor);
      if (Math.abs(grossDp) >= T.grossPct) {
        findings.push(makeFinding({
          code: 'GROSS_PCT_OUTLIER', severity: suppressOutlier ? SEV.INFO : SEV.WARNING,
          employeeId: empId, scope: 'EMPLOYEE',
          metric: 'gross', baseline: prevGross, observed: gross, deltaMinor: gross - prevGross, deltaPct: grossDp,
          message: `Gross moved ${(grossDp * 100).toFixed(1)}% vs last period.`,
          suggestedAction: suppressOutlier ? null : 'Acknowledge or investigate the swing.',
        }));
      }

      // LOP_SPIKE (WARNING) — lopDays jumped by >= lopSpikeDays.
      const curLop = num(cur.lopDays);
      const prevLop = num(prev.lopDays);
      if (curLop - prevLop >= T.lopSpikeDays) {
        findings.push(makeFinding({
          code: 'LOP_SPIKE', severity: SEV.WARNING, employeeId: empId, scope: 'EMPLOYEE',
          metric: 'lopDays', baseline: prevLop, observed: curLop, deltaMinor: null, deltaPct: null,
          message: `Loss-of-pay days jumped from ${prevLop} to ${curLop}.`,
          suggestedAction: 'Confirm the unpaid leave / absence is correct.',
        }));
      }

      // Per-component checks (delta + appear/vanish + statutory drop + rate drift).
      const curC = componentMap(cur);
      const prevC = componentMap(prev);
      const codes = new Set([...curC.keys(), ...prevC.keys()]);
      for (const code of codes) {
        const cAmt = curC.has(code) ? curC.get(code) : null;
        const pAmt = prevC.has(code) ? prevC.get(code) : null;

        // STATUTORY_DROP_TO_ZERO (BLOCKER) — a statutory component >0 last period,
        // 0/absent now, with no leaver/exemption reason.
        if (STATUTORY_SET.has(code) && (pAmt || 0) > 0 && !(cAmt > 0) && !isLeaver && !suppressOutlier) {
          findings.push(makeFinding({
            code: 'STATUTORY_DROP_TO_ZERO', severity: SEV.BLOCKER, employeeId: empId, scope: 'EMPLOYEE',
            metric: code, baseline: pAmt, observed: cAmt || 0, deltaMinor: (cAmt || 0) - pAmt, deltaPct: -1,
            message: `Statutory component ${code} dropped from ${pAmt} to 0 with no leaver/exemption.`,
            suggestedAction: 'Confirm the statutory exemption, else fix the structure.',
          }));
          continue; // a hard drop already reported — don't also emit COMPONENT_DELTA
        }

        // COMPONENT_DELTA (WARNING) — appeared/vanished OR |Δ%| >= componentPct.
        if (cAmt == null || pAmt == null) {
          // appeared (prev null) or vanished (cur null) — skip noise for tiny amounts.
          const amt = cAmt == null ? pAmt : cAmt;
          if (Math.abs(num(amt)) >= T.absMinFloorMinor) {
            findings.push(makeFinding({
              code: 'COMPONENT_DELTA', severity: suppressOutlier ? SEV.INFO : SEV.WARNING,
              employeeId: empId, scope: 'EMPLOYEE',
              metric: code, baseline: pAmt, observed: cAmt,
              deltaMinor: num(cAmt) - num(pAmt), deltaPct: null,
              message: cAmt == null
                ? `Component ${code} disappeared this period (was ${pAmt}).`
                : `Component ${code} is new this period (${cAmt}).`,
              suggestedAction: suppressOutlier ? null : 'Confirm the component change is intended.',
            }));
          }
        } else {
          const dp = deltaPct(cAmt, pAmt, T.absMinFloorMinor);
          if (Math.abs(dp) >= T.componentPct) {
            findings.push(makeFinding({
              code: 'COMPONENT_DELTA', severity: suppressOutlier ? SEV.INFO : SEV.WARNING,
              employeeId: empId, scope: 'EMPLOYEE',
              metric: code, baseline: pAmt, observed: cAmt, deltaMinor: cAmt - pAmt, deltaPct: dp,
              message: `Component ${code} moved ${(dp * 100).toFixed(1)}% (${pAmt} → ${cAmt}).`,
              suggestedAction: suppressOutlier ? null : 'Confirm the component change is intended.',
            }));
          }

          // STATUTORY_RATE_DRIFT (WARNING) — effective rate of a statutory component
          // vs gross drifted outside tolerance (catches a mis-applied slab/rate).
          if (STATUTORY_SET.has(code) && gross > 0 && prevGross > 0) {
            const curRate = cAmt / gross;
            const prevRate = pAmt / prevGross;
            if (Math.abs(curRate - prevRate) > T.statutoryRateTolerance) {
              findings.push(makeFinding({
                code: 'STATUTORY_RATE_DRIFT', severity: SEV.WARNING, employeeId: empId, scope: 'EMPLOYEE',
                metric: code, baseline: Math.round(prevRate * 1e6), observed: Math.round(curRate * 1e6),
                deltaMinor: null, deltaPct: roundPct(curRate - prevRate),
                message: `${code} effective rate drifted ${(prevRate * 100).toFixed(2)}% → ${(curRate * 100).toFixed(2)}% of gross.`,
                suggestedAction: 'Confirm the statutory rate/slab change is correct.',
              }));
            }
          }
        }
      }
    }
  }

  // ── 2. leavers present last period, absent now (INFO context) ──
  if (hasBaseline) {
    for (const prev of prevLines) {
      if (!seenEmp.has(prev.employeeId)) {
        findings.push(makeFinding({
          code: 'LEAVER', severity: SEV.INFO, employeeId: prev.employeeId, scope: 'EMPLOYEE',
          metric: 'net', baseline: num(prev.netMinor), observed: null,
          message: `Present last period, absent now — likely a leaver.`,
        }));
      }
    }
  }

  // ── 3. run-level reconciliation (BLOCKER) ──
  const sumNet = curLines.reduce((s, l) => s + num(l.netMinor), 0);
  const totals = (current && current.totalsMinor) || {};
  if (totals.netMinor != null && sumNet !== num(totals.netMinor)) {
    findings.push(makeFinding({
      code: 'RECONCILIATION_MISMATCH', severity: SEV.BLOCKER, employeeId: null, scope: 'RUN',
      metric: 'net', baseline: num(totals.netMinor), observed: sumNet, deltaMinor: sumNet - num(totals.netMinor),
      message: `Σ line net (${sumNet}) ≠ run total net (${num(totals.netMinor)}).`,
      suggestedAction: 'Recompute — the persisted totals are out of sync with the lines.',
    }));
  }

  // ── sort: severity desc, then employeeId (RUN last), then code ──
  findings.sort((a, b) => {
    if (SEV_RANK[a.severity] !== SEV_RANK[b.severity]) return SEV_RANK[a.severity] - SEV_RANK[b.severity];
    const ae = a.employeeId == null ? '~' : a.employeeId;
    const be = b.employeeId == null ? '~' : b.employeeId;
    if (ae !== be) return ae < be ? -1 : 1;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });

  // ── summary ──
  const summary = { blocker: 0, warning: 0, info: 0, byCode: {} };
  for (const f of findings) {
    if (f.severity === SEV.BLOCKER) summary.blocker += 1;
    else if (f.severity === SEV.WARNING) summary.warning += 1;
    else summary.info += 1;
    summary.byCode[f.code] = (summary.byCode[f.code] || 0) + 1;
  }

  return { findings, summary, blockingAnomalies: summary.blocker };
}

/**
 * findingsByEmployee — split a flat findings array into per-employee buckets +
 * a run-scope bucket. Pure helper the orchestrator uses to write each line's
 * errorJson (only BLOCKER/WARNING go to errorJson; INFO is context-only there).
 */
function findingsByEmployee(findings) {
  const byEmp = new Map();
  const run = [];
  for (const f of findings || []) {
    if (f.employeeId == null) { run.push(f); continue; }
    if (!byEmp.has(f.employeeId)) byEmp.set(f.employeeId, []);
    byEmp.get(f.employeeId).push(f);
  }
  return { byEmployee: byEmp, run };
}

module.exports = {
  runVarianceChecks,
  findingsByEmployee,
  DEFAULT_THRESHOLDS,
  SEVERITY: SEV,
  STATUTORY_CODES,
  _internal: { deltaPct, componentMap, makeFinding },
};
