'use strict';

/**
 * bonus.service.js — Statutory Bonus orchestrator (Feature 22). The DB-touching,
 * thin layer over the PURE payroll/bonus.js core. Mirrors lifecycle/fnf.js →
 * offboarding.controller.js 1:1: load rows → call the pure core → persist the
 * BonusCycle/BonusAward snapshot → MINT a PayRun(type='BONUS') via the SAME persist
 * path the FnF controller uses, so the minted run rides the EXISTING payrun state
 * machine + service.js pay/file/close + maker-checker SoD + idempotency.
 *
 * India-only (assertCountry). All amounts are INTEGER MINOR UNITS (paise) through
 * bonus.js; conversion to Decimal happens only at the persistence edge.
 */

const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');
const { assertCountry } = require('../tenant/countryContext');
const { allocateCode } = require('../lifecycle/lib/codes');
const { notifyHrEvent } = require('../integrations/notifications');
const bonusCore = require('./bonus');
const { _internals: india } = require('./compliance/india');
// resolveCurrentCompensation lives under service.js's _internal export.
const { _internal: payrollService } = require('./service');
const resolveCurrentCompensation = payrollService.resolveCurrentCompensation;

// ── pure persistence helpers (integer minor ↔ Decimal; never floats for money) ──
function minorToDecimal(minor) {
  const n = Math.round(Number(minor) || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
function toDateOnly(x) {
  if (!x) return null;
  const d = x instanceof Date ? x : new Date(x);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

class BonusError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.reason = code;
  }
}

/**
 * Parse an accounting year "YYYY-YY" (e.g. "2025-26") into the Apr–Mar FY window.
 * Returns { startDate, endDate, fyStartYear }. Throws on a malformed value.
 */
function fyWindow(accountingYear) {
  const m = String(accountingYear || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new BonusError('BAD_ACCOUNTING_YEAR', `accountingYear must be "YYYY-YY" (got "${accountingYear}")`, 422);
  const startY = Number(m[1]);
  // Indian FY: 1 Apr startY → 31 Mar (startY+1).
  return {
    fyStartYear: startY,
    startDate: new Date(Date.UTC(startY, 3, 1)), // Apr 1
    endDate: new Date(Date.UTC(startY + 1, 2, 31)), // Mar 31
  };
}

/** Monthly Basic+DA (paise) from a resolved CompensationRevision's lines. */
function monthlyBasicDaMinorFromComp(comp) {
  if (!comp || !Array.isArray(comp.lines)) return 0;
  let minor = 0;
  for (const line of comp.lines) {
    const kind = line.component && line.component.kind;
    if (kind === 'BASIC' || kind === 'DEARNESS_ALLOWANCE') {
      const amt = line.amountMonthly != null ? line.amountMonthly : line.calcValue;
      minor += Math.round(Number(amt || 0) * 100);
    }
  }
  return minor;
}

// ── 1. createBonusCycle — exactly-once on (businessId, entityId, accountingYear) ──
async function createBonusCycle({ businessId, actorId, entityId, accountingYear, rateBasisPoints, minWageMonthlyMinor, allocableSurplusMinor, priorSetOnMinor, notes }) {
  if (!entityId || !accountingYear) throw new BonusError('MISSING_FIELDS', 'entityId and accountingYear are required', 400);
  const entity = await prisma.entity.findFirst({ where: { id: entityId, businessId } });
  if (!entity) throw new BonusError('ENTITY_NOT_FOUND', 'Entity not found', 404);
  // India-gate (same gate service.createRun uses): NZ has no statutory bonus.
  if (entity.countryCode) await assertCountry(businessId, entity.countryCode);
  if (entity.countryCode !== 'IN') throw new BonusError('COUNTRY_NOT_SUPPORTED', 'Statutory bonus applies to India only', 404);

  const { endDate } = fyWindow(accountingYear);
  const fyEndIso = toDateOnly(endDate).toISOString().slice(0, 10);
  // Effective-dated rule for the FY end (₹21,000/₹7,000 from FY2014-15; pre-2015 ₹10,000/₹3,500).
  const rule = india.resolveBonusRule(fyEndIso);
  if (!rule) throw new BonusError('NO_BONUS_RULE', `No bonus rule effective for FY ending ${fyEndIso}`, 422);

  // Rate band guard (§10/§11): reject < 8.33% / > 20% at create.
  const rate = rateBasisPoints == null ? rule.minRateNum : Math.round(Number(rateBasisPoints));
  if (rate < rule.minRateNum || rate > rule.maxRateNum) {
    throw new BonusError('RATE_OUT_OF_BAND', `rateBasisPoints must be ${rule.minRateNum}..${rule.maxRateNum} (8.33%..20%)`, 422);
  }
  // §12 calc ceiling = max(₹7,000-from-rule, applicable minimum wage).
  const minWage = Number(minWageMonthlyMinor) > 0 ? Math.round(Number(minWageMonthlyMinor)) : 0;
  const calcCeilingMinor = Math.max(rule.calcCeilingMinor, minWage);
  // §19 due date = FY end + 8 months (Apr–Mar FY → 30 Nov). Clamp the day to the
  // target month's last day so 31 Mar + 8 months resolves to 30 Nov (not 1 Dec).
  const dueY = endDate.getUTCFullYear();
  const dueMonth = endDate.getUTCMonth() + 8; // 0-based; may exceed 11 (year rolls)
  const lastDayOfDueMonth = new Date(Date.UTC(dueY, dueMonth + 1, 0)).getUTCDate();
  const due = new Date(Date.UTC(dueY, dueMonth, Math.min(endDate.getUTCDate(), lastDayOfDueMonth)));

  try {
    const cycle = await prisma.bonusCycle.create({
      data: {
        businessId, entityId, accountingYear,
        rateBasisPoints: rate,
        calcCeilingMinor: BigInt(calcCeilingMinor),
        minWageMonthlyMinor: minWage ? BigInt(minWage) : null,
        eligibilityCeilingMinor: BigInt(rule.eligibilityCeilingMinor),
        allocableSurplusMinor: allocableSurplusMinor != null ? BigInt(Math.round(Number(allocableSurplusMinor))) : null,
        priorSetOnMinor: priorSetOnMinor != null ? BigInt(Math.round(Number(priorSetOnMinor))) : BigInt(0),
        status: 'DRAFT',
        dueDate: toDateOnly(due),
        notes: notes || null,
      },
    });
    await writeAudit({ businessId, actorId, action: 'bonus.cycle.create', entityType: 'BonusCycle', entityId: cycle.id, meta: { entityId, accountingYear, rateBasisPoints: rate } });
    return cycle;
  } catch (e) {
    if (e && e.code === 'P2002') throw new BonusError('CYCLE_EXISTS', `A bonus cycle already exists for ${accountingYear}`, 409);
    throw e;
  }
}

// ── 2. computeBonusCycle — idempotent eligibility + capped-base for every employee ──
async function computeBonusCycle({ businessId, actorId, bonusCycleId, advances = {}, disqualified = {} }) {
  const cycle = await loadCycle(businessId, bonusCycleId);
  if (cycle.status === 'APPROVED' || cycle.status === 'PAID' || cycle.status === 'FILED') {
    throw new BonusError('IMMUTABLE_CYCLE', `Cycle is ${cycle.status}; recompute not allowed`, 409);
  }
  const { startDate, endDate } = fyWindow(cycle.accountingYear);
  const fyEndIso = toDateOnly(endDate).toISOString().slice(0, 10);

  // Scope: every employment whose window overlaps the FY (mirrors the MIGRATED run
  // scoping — separated-but-eligible employees are still owed bonus for worked months).
  const employments = await prisma.employmentRecord.findMany({
    where: {
      businessId, entityId: cycle.entityId,
      effectiveFrom: { lte: endDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: startDate } }],
    },
    select: { employeeId: true, effectiveFrom: true, effectiveTo: true },
  });
  const employeeIds = [...new Set(employments.map((e) => e.employeeId))];

  // Build the pure-core employee inputs.
  const empInputs = [];
  for (const empId of employeeIds) {
    const comp = await resolveCurrentCompensation(businessId, empId, fyEndIso);
    const monthlyBasicDaMinor = monthlyBasicDaMinorFromComp(comp);
    // Worked/eligible days from attendance pay inputs for the FY (deemed-worked days
    // — paid leave/maternity/lay-off/injury — already netted at freeze: payableDays).
    // CRITICAL: distinguish "no data" from a genuine ZERO. Aggregate BOTH the sum AND
    // the row COUNT: a count of 0 means attendance was never frozen (salaried-default
    // fallback to the calendar window); a count > 0 with sum 0 is a REAL zero — a
    // full-year LWP/AWOL employee — who must FAIL the §8 ≥30-day gate and earn ₹0.
    const attn = await prisma.attendancePayInput.aggregate({
      where: { businessId, employeeId: empId, periodStart: { gte: startDate }, periodEnd: { lte: endDate } },
      _sum: { payableDays: true },
      _count: { _all: true },
    });
    const hasAttendance = !!(attn && attn._count && Number(attn._count._all) > 0);
    const frozenWorkedDays = attn && attn._sum && attn._sum.payableDays != null ? Math.round(Number(attn._sum.payableDays)) : 0;
    // Resolve the employee's active employment window within the FY (the §13 ceiling).
    const emp = employments.filter((e) => e.employeeId === empId);
    const winStart = emp.reduce((min, e) => {
      const f = e.effectiveFrom > startDate ? e.effectiveFrom : startDate;
      return !min || f < min ? f : min;
    }, null) || startDate;
    const winEnd = emp.reduce((max, e) => {
      const t = e.effectiveTo && e.effectiveTo < endDate ? e.effectiveTo : endDate;
      return !max || t > max ? t : max;
    }, null) || endDate;
    const totalFyDays = Math.round((endDate - startDate) / 86400000) + 1;
    const activeDays = Math.round((winEnd - winStart) / 86400000) + 1;

    // §8 worked-days + §13 proration basis:
    //   • attendance frozen → trust the REAL summed worked/deemed days (a genuine 0
    //     stays 0 → §8 fails, eligibleMonths = 0; LWP/AWOL correctly cuts the payout).
    //   • no attendance frozen → salaried default: the active employment window is
    //     deemed worked (a present-all-year employee).
    const workedDays = hasAttendance ? frozenWorkedDays : activeDays;
    // §13 must prorate on actual worked + deemed days, NOT the raw employment calendar
    // window — so LWP/AWOL reduces the payout. Denominator is the full FY day-count;
    // a mid-year joiner's worked days already cap at their active window. Cap at the
    // active window's months so deemed-day rounding can't exceed the employed period.
    const activeMonths = Math.round((activeDays / totalFyDays) * 12 * 100) / 100; // 2dp
    const workedMonths = Math.round((workedDays / totalFyDays) * 12 * 100) / 100; // 2dp
    const eligibleMonths = Math.min(workedMonths, activeMonths);

    empInputs.push({
      employeeId: empId,
      monthlyBasicDaMinor,
      workedDays,
      eligibleMonths,
      advancePaidMinor: advances[empId] != null ? Math.round(Number(advances[empId])) : 0,
      disqualifiedS9: disqualified[empId] === true,
      entityCovered: true,
    });
  }

  // Pure compute (paise-exact).
  const result = bonusCore.computeBonusCycle({
    accountingYearEnd: fyEndIso,
    rateBasisPoints: cycle.rateBasisPoints,
    minWageMonthlyMinor: cycle.minWageMonthlyMinor != null ? Number(cycle.minWageMonthlyMinor) : null,
    allocableSurplusMinor: cycle.allocableSurplusMinor != null ? Number(cycle.allocableSurplusMinor) : null,
    priorSetOnMinor: cycle.priorSetOnMinor != null ? Number(cycle.priorSetOnMinor) : 0,
    currencyCode: 'INR',
  }, empInputs);

  // Persist: clear prior awards + rewrite (idempotent), freeze the cycle COMPUTED.
  const inputByEmp = Object.fromEntries(empInputs.map((e) => [e.employeeId, e]));
  await prisma.$transaction(async (tx) => {
    await tx.bonusAward.deleteMany({ where: { businessId, bonusCycleId } });
    for (const a of result.awards) {
      const inp = inputByEmp[a.employeeId] || {};
      await tx.bonusAward.create({
        data: {
          businessId, bonusCycleId, employeeId: a.employeeId,
          eligible: a.eligible,
          ineligibleReason: a.ineligibleReason || null,
          monthlyBasicDaMinor: BigInt(a.monthlyBasicDaMinor),
          cappedBaseMinor: BigInt(a.cappedBaseMinor),
          eligibleMonths: minorToDecimal(Math.round(a.eligibleMonths * 100)), // store 2dp
          workedDays: Math.round(inp.workedDays || 0),
          rateBasisPoints: a.rateBasisPoints,
          grossBonusMinor: BigInt(a.grossBonusMinor),
          advancePaidMinor: BigInt(a.advancePaidMinor),
          netBonusMinor: BigInt(a.netBonusMinor),
          computeTrace: a.trace || null,
        },
      });
    }
    await tx.bonusCycle.update({
      where: { id: bonusCycleId },
      data: { status: 'COMPUTED', computedAt: new Date(), computedBy: actorId, version: { increment: 1 } },
    });
  });

  await writeAudit({ businessId, actorId, action: 'bonus.cycle.compute', entityType: 'BonusCycle', entityId: bonusCycleId, meta: { eligible: result.totals.eligibleCount, ineligible: result.totals.ineligibleCount, totalNetMinor: result.totals.totalNetMinor } });
  // Operator notification (best-effort; never blocks the compute).
  try {
    await notifyHrEvent({ businessId, event: 'bonus.computed', triggeredBy: actorId, variables: { YEAR: cycle.accountingYear, COUNT: String(result.totals.eligibleCount), AMT: minorToDecimal(result.totals.totalNetMinor) } });
  } catch (_) { /* notification failure must not fail the compute */ }

  return getBonusCycle({ businessId, bonusCycleId });
}

// ── 3. approveBonusCycle — maker-checker SoD; MINT PayRun(type=BONUS) ──
async function approveBonusCycle({ businessId, actorId, bonusCycleId }) {
  const cycle = await loadCycle(businessId, bonusCycleId);
  if (cycle.status !== 'COMPUTED') throw new BonusError('BAD_STATE', `Approve requires a COMPUTED cycle (current: ${cycle.status})`, 409);
  // SoD: the approver must differ from the maker (computedBy). Fail closed on unknown.
  if (!cycle.computedBy) throw new BonusError('SOD_MAKER_UNKNOWN', 'Cycle maker is unknown; cannot approve (fail-closed)', 403);
  if (cycle.computedBy === actorId) throw new BonusError('MAKER_CHECKER', 'Maker-checker: the approver must differ from the employee who computed the cycle', 403);
  if (cycle.payRunId) throw new BonusError('ALREADY_MINTED', 'Cycle already minted a bonus PayRun', 409);

  const awards = await prisma.bonusAward.findMany({ where: { businessId, bonusCycleId, eligible: true } });
  if (!awards.length) throw new BonusError('NO_ELIGIBLE', 'No eligible awards to disburse', 422);

  const cal = await prisma.payCalendar.findFirst({ where: { businessId, entityId: cycle.entityId, isActive: true } })
    || await prisma.payCalendar.findFirst({ where: { businessId, entityId: cycle.entityId } });
  if (!cal) throw new BonusError('NO_PAY_CALENDAR', 'No pay calendar configured for the entity; cannot mint the bonus PayRun', 422);

  const { startDate, endDate } = fyWindow(cycle.accountingYear);
  const grossMinor = awards.reduce((s, a) => s + Number(a.grossBonusMinor), 0);
  const totalDeductionsMinor = awards.reduce((s, a) => s + Number(a.advancePaidMinor), 0);
  const netMinor = awards.reduce((s, a) => s + Number(a.netBonusMinor), 0);

  let out;
  try {
    out = await prisma.$transaction(async (tx) => {
    const code = await allocateCode(tx, { businessId, entityId: cycle.entityId, scope: 'BONUS', prefix: 'BON-', padding: 6 });
    const payRun = await tx.payRun.create({
      data: {
        businessId, entityId: cycle.entityId, payCalendarId: cal.id, code,
        periodStart: toDateOnly(startDate), periodEnd: toDateOnly(endDate), payDate: toDateOnly(endDate),
        sequenceInYear: 0,
        taxYear: cycle.accountingYear,
        type: 'BONUS', status: 'DRAFT', currencyCode: 'INR',
        headcount: awards.length,
        totalGross: minorToDecimal(grossMinor),
        totalDeductions: minorToDecimal(totalDeductionsMinor),
        totalNet: minorToDecimal(netMinor),
        approvedAt: new Date(), approvedBy: actorId,
        notes: `Statutory bonus ${cycle.accountingYear} — ${awards.length} eligible employee(s)`,
      },
    });
    // Per-award PayRunLine + PayRunLineComponent (mirrors the FnF mint).
    for (const a of awards) {
      const emp = await tx.employee.findUnique({ where: { id: a.employeeId }, select: { currentCompensationId: true } });
      const line = await tx.payRunLine.create({
        data: {
          businessId, payRunId: payRun.id, employeeId: a.employeeId,
          compensationId: emp && emp.currentCompensationId ? emp.currentCompensationId : '',
          payableDays: 0,
          grossEarnings: minorToDecimal(Number(a.grossBonusMinor)),
          totalDeductions: minorToDecimal(Number(a.advancePaidMinor)),
          netPay: minorToDecimal(Number(a.netBonusMinor)),
          currencyCode: 'INR', status: 'COMPUTED',
        },
      });
      const comps = [{
        businessId, payRunLineId: line.id, componentId: 'STAT_BONUS', componentCode: 'STAT_BONUS',
        componentName: 'Statutory Bonus (Payment of Bonus Act 1965)', category: 'EARNING',
        amount: minorToDecimal(Number(a.grossBonusMinor)), isStatutory: true, sortOrder: 0,
      }];
      if (Number(a.advancePaidMinor) > 0) {
        comps.push({
          businessId, payRunLineId: line.id, componentId: 'BONUS_ADVANCE', componentCode: 'BONUS_ADVANCE',
          componentName: 'Bonus advance / interim already paid', category: 'DEDUCTION',
          amount: minorToDecimal(Number(a.advancePaidMinor)), isStatutory: false, sortOrder: 1,
        });
      }
      await tx.payRunLineComponent.createMany({ data: comps });
    }
    // ── Atomic single-mint guard (concurrency-safe) ──────────────────────────
    // The pre-tx status/payRunId checks above are advisory ONLY — two concurrent
    // approves both read COMPUTED + payRunId=null and would EACH mint a PayRun,
    // paying the bonus TWICE. Commit the transition with a CONDITIONAL updateMany
    // keyed on {status:'COMPUTED', payRunId:null}: the row lock serialises the two
    // transactions, so exactly ONE matches 1 row and commits its minted PayRun;
    // the loser matches 0 rows and we throw → its whole tx (PayRun + lines) rolls
    // back. Net effect: a second concurrent approve is a no-op, never a double-mint.
    const claim = await tx.bonusCycle.updateMany({
      where: { id: bonusCycleId, businessId, status: 'COMPUTED', payRunId: null },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: actorId, payRunId: payRun.id, version: { increment: 1 } },
    });
    if (claim.count !== 1) {
      throw new BonusError('ALREADY_MINTED', 'Cycle already minted a bonus PayRun (lost the concurrent approve race)', 409);
    }
    const updated = await tx.bonusCycle.findFirst({ where: { id: bonusCycleId, businessId } });
    return { payRun, cycle: updated };
    });
  } catch (e) {
    // Map every concurrent-approve LOSS to the SAME benign 409. The winner mints
    // exactly one PayRun; the loser can trip one of THREE guards, all of which
    // roll its tx back with NO PayRun persisted:
    //   • our conditional-update guard (BonusError ALREADY_MINTED), or
    //   • the PayRun unique (businessId,entityId,code) constraint on allocateCode
    //     racing the same next sequence (P2002), or
    //   • a serialization / write-conflict / deadlock (P2034) on the row lock.
    // Re-read: if the cycle is now minted by the winner, surface ALREADY_MINTED;
    // otherwise it's a genuine failure → rethrow.
    const isConcurrencyLoss =
      (e instanceof BonusError && e.code === 'ALREADY_MINTED') ||
      (e && (e.code === 'P2002' || e.code === 'P2034'));
    if (isConcurrencyLoss) {
      const now = await prisma.bonusCycle.findFirst({ where: { id: bonusCycleId, businessId }, select: { payRunId: true } });
      if (now && now.payRunId) {
        throw new BonusError('ALREADY_MINTED', 'Cycle already minted a bonus PayRun (lost the concurrent approve race)', 409);
      }
    }
    throw e;
  }

  await writeAudit({ businessId, actorId, action: 'bonus.cycle.approve', entityType: 'BonusCycle', entityId: bonusCycleId, meta: { payRunId: out.payRun.id, headcount: awards.length, netMinor } });
  return getBonusCycle({ businessId, bonusCycleId });
}

// ── 4. publishBonusSlips — fan out bonus.published per eligible employee ──
async function publishBonusSlips({ businessId, actorId, bonusCycleId }) {
  const cycle = await loadCycle(businessId, bonusCycleId);
  if (cycle.status !== 'APPROVED' && cycle.status !== 'PAID' && cycle.status !== 'FILED') {
    throw new BonusError('BAD_STATE', `Publish requires an APPROVED cycle (current: ${cycle.status})`, 409);
  }
  const awards = await prisma.bonusAward.findMany({ where: { businessId, bonusCycleId, eligible: true }, include: { employee: { select: { firstName: true, workEmail: true, personalEmail: true, phone: true } } } });
  let sent = 0;
  for (const a of awards) {
    try {
      await notifyHrEvent({
        businessId, event: 'bonus.published', triggeredBy: actorId,
        recipientEmail: a.employee.workEmail || a.employee.personalEmail || undefined,
        recipientPhone: a.employee.phone || undefined,
        variables: { NAME: a.employee.firstName || 'there', YEAR: cycle.accountingYear, AMT: minorToDecimal(Number(a.netBonusMinor)) },
      });
      sent += 1;
    } catch (_) { /* per-recipient failure must not abort the batch */ }
  }
  await writeAudit({ businessId, actorId, action: 'bonus.cycle.publish', entityType: 'BonusCycle', entityId: bonusCycleId, meta: { notified: sent } });
  return { bonusCycleId, published: awards.length, notified: sent };
}

// ── 5. getFormCRegister — per-employee Form C + Form D summary (from awards) ──
async function getFormCRegister({ businessId, bonusCycleId }) {
  const cycle = await loadCycle(businessId, bonusCycleId);
  const awards = await prisma.bonusAward.findMany({
    where: { businessId, bonusCycleId },
    include: { employee: { select: { code: true, firstName: true, lastName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const rows = awards.map((a) => ({
    employeeCode: a.employee.code,
    employeeName: `${a.employee.firstName || ''} ${a.employee.lastName || ''}`.trim(),
    eligible: a.eligible,
    ineligibleReason: a.ineligibleReason || null,
    monthlyBasicDa: minorToDecimal(Number(a.monthlyBasicDaMinor)),
    cappedBase: minorToDecimal(Number(a.cappedBaseMinor)),
    eligibleMonths: Number(a.eligibleMonths),
    rate: `${(a.rateBasisPoints / 100).toFixed(2)}%`,
    grossBonus: minorToDecimal(Number(a.grossBonusMinor)),
    advancePaid: minorToDecimal(Number(a.advancePaidMinor)),
    netBonus: minorToDecimal(Number(a.netBonusMinor)),
  }));
  const eligibleRows = awards.filter((a) => a.eligible);
  const summary = {
    accountingYear: cycle.accountingYear,
    rate: `${(cycle.rateBasisPoints / 100).toFixed(2)}%`,
    eligibleCount: eligibleRows.length,
    ineligibleCount: awards.length - eligibleRows.length,
    totalGross: minorToDecimal(eligibleRows.reduce((s, a) => s + Number(a.grossBonusMinor), 0)),
    totalNet: minorToDecimal(eligibleRows.reduce((s, a) => s + Number(a.netBonusMinor), 0)),
    dueDate: cycle.dueDate,
  };
  return { formC: rows, formDSummary: summary };
}

// ── reads ──
async function loadCycle(businessId, bonusCycleId) {
  const cycle = await prisma.bonusCycle.findFirst({ where: { id: bonusCycleId, businessId, deletedAt: null } });
  if (!cycle) throw new BonusError('NOT_FOUND', 'Bonus cycle not found', 404);
  return cycle;
}

function serializeCycle(cycle) {
  const big = (v) => (v == null ? null : Number(v));
  return {
    ...cycle,
    calcCeilingMinor: big(cycle.calcCeilingMinor),
    minWageMonthlyMinor: big(cycle.minWageMonthlyMinor),
    eligibilityCeilingMinor: big(cycle.eligibilityCeilingMinor),
    allocableSurplusMinor: big(cycle.allocableSurplusMinor),
    priorSetOnMinor: big(cycle.priorSetOnMinor),
  };
}

async function getBonusCycle({ businessId, bonusCycleId }) {
  const cycle = await loadCycle(businessId, bonusCycleId);
  const awards = await prisma.bonusAward.findMany({
    where: { businessId, bonusCycleId },
    include: { employee: { select: { id: true, code: true, firstName: true, lastName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const ser = awards.map((a) => ({
    ...a,
    monthlyBasicDaMinor: Number(a.monthlyBasicDaMinor),
    cappedBaseMinor: Number(a.cappedBaseMinor),
    eligibleMonths: Number(a.eligibleMonths),
    grossBonusMinor: Number(a.grossBonusMinor),
    advancePaidMinor: Number(a.advancePaidMinor),
    netBonusMinor: Number(a.netBonusMinor),
  }));
  const eligible = ser.filter((a) => a.eligible);
  return {
    cycle: serializeCycle(cycle),
    awards: ser,
    totals: {
      eligibleCount: eligible.length,
      ineligibleCount: ser.length - eligible.length,
      totalGrossMinor: eligible.reduce((s, a) => s + a.grossBonusMinor, 0),
      totalNetMinor: eligible.reduce((s, a) => s + a.netBonusMinor, 0),
    },
  };
}

async function listBonusCycles({ businessId, entityId, status, page = 1, pageSize = 25 }) {
  const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const where = { businessId, deletedAt: null };
  if (entityId) where.entityId = entityId;
  if (status) where.status = status;
  const [items, total] = await Promise.all([
    prisma.bonusCycle.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { entity: { select: { id: true, code: true, legalName: true } } } }),
    prisma.bonusCycle.count({ where }),
  ]);
  return { items: items.map(serializeCycle), total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take };
}

async function updateBonusCycle({ businessId, actorId, bonusCycleId, rateBasisPoints, minWageMonthlyMinor, allocableSurplusMinor, priorSetOnMinor, notes }) {
  const cycle = await loadCycle(businessId, bonusCycleId);
  if (cycle.status !== 'DRAFT') throw new BonusError('BAD_STATE', 'Only a DRAFT cycle can be edited', 409);
  const { endDate } = fyWindow(cycle.accountingYear);
  const rule = india.resolveBonusRule(toDateOnly(endDate).toISOString().slice(0, 10));
  const data = {};
  if (rateBasisPoints != null) {
    const rate = Math.round(Number(rateBasisPoints));
    if (rate < rule.minRateNum || rate > rule.maxRateNum) throw new BonusError('RATE_OUT_OF_BAND', `rateBasisPoints must be ${rule.minRateNum}..${rule.maxRateNum}`, 422);
    data.rateBasisPoints = rate;
  }
  if (minWageMonthlyMinor != null) {
    const mw = Math.round(Number(minWageMonthlyMinor));
    data.minWageMonthlyMinor = mw > 0 ? BigInt(mw) : null;
    data.calcCeilingMinor = BigInt(Math.max(rule.calcCeilingMinor, mw > 0 ? mw : 0));
  }
  if (allocableSurplusMinor !== undefined) data.allocableSurplusMinor = allocableSurplusMinor != null ? BigInt(Math.round(Number(allocableSurplusMinor))) : null;
  if (priorSetOnMinor != null) data.priorSetOnMinor = BigInt(Math.round(Number(priorSetOnMinor)));
  if (notes !== undefined) data.notes = notes;
  data.version = { increment: 1 };
  await prisma.bonusCycle.update({ where: { id: bonusCycleId }, data });
  await writeAudit({ businessId, actorId, action: 'bonus.cycle.update', entityType: 'BonusCycle', entityId: bonusCycleId, meta: data });
  return getBonusCycle({ businessId, bonusCycleId });
}

module.exports = {
  BonusError,
  createBonusCycle,
  computeBonusCycle,
  approveBonusCycle,
  publishBonusSlips,
  getFormCRegister,
  getBonusCycle,
  listBonusCycles,
  updateBonusCycle,
  // exposed for tests
  _internals: { fyWindow, monthlyBasicDaMinorFromComp, minorToDecimal },
};
