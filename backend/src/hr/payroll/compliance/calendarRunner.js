'use strict';

/*
 * calendarRunner.js — Feature 23 §5. The compliance-calendar runtime: a near-clone
 * of approvals/escalationRunner.js (tenant-safe, idempotent, version-guarded,
 * --dry-run, CLI-runnable). Three responsibilities, each its own exported fn, all
 * hosted by ONE scheduler.js cron block:
 *
 *   generateUpcomingObligations({ businessId?, horizonDays=120, asOf, dryRun })
 *     For each ACTIVE ComplianceObligation gated by an active matching
 *     StatutoryRegistration, enumerate periodsBetween([asOf, asOf+horizon]) and
 *     UPSERT a StatutoryRemittance stub per period — idempotent on the natural key
 *     (businessId, entityId, kind, taxPeriod[, stateCode]). NEVER clobbers a row
 *     that is FILED/PAID/WAIVED or one carrying a payroll amount (fileRun's writer).
 *
 *   sweepComplianceStatus({ businessId?, asOf, dryRun })
 *     Advance the lifecycle (version-guarded): non-terminal rows past due → OVERDUE;
 *     PENDING rows inside the reminder window → DUE. Terminal states untouched.
 *
 *   sendComplianceReminders({ businessId?, asOf, dryRun })
 *     For each reminder-eligible / overdue row, compute the stage from the
 *     obligation's reminderDays; if reminderStage already equals it → skip (no spam);
 *     else fan out via notifyHrEvent to canManageStatutory users, version-guarded.
 *
 *   seedObligationsForEntity({ businessId, entityId, asOf, dryRun })
 *     Derive ComplianceObligation rows from the entity's active StatutoryRegistration
 *     rows (india.calendar.seed.js). Idempotent upsert on the natural key. Used by
 *     POST /compliance/obligations/seed + entity provisioning.
 *
 * CLI: node src/hr/payroll/compliance/calendarRunner.js [--dry-run] [--business=<id>]
 *
 * NO-COLLISION GUARANTEE with service.js fileRun(): both writers key on
 * (businessId, entityId, kind, taxPeriod[, stateCode]); the generator's taxPeriod
 * format is IDENTICAL to fileRun's (monthly "YYYY-MM"; quarterly FY-prefixed
 * "YYYY-YY-Qn"; LWF "YYYY-Hn"). The generator writes a PENDING amount-0 STUB and
 * declines to write/clobber a row that already exists with a non-PENDING status or
 * a non-zero amount — so fileRun's authoritative amount + DUE status always win.
 */

const prisma = require('../../../core/lib/prisma');
const { writeAudit } = require('../../../core/lib/audit');
const { usersWithPermission } = require('../../approvals/approverResolver');
const { notifyHrEvent } = require('../../integrations/notifications');
const cal = require('./india.calendar');
const seed = require('./india.calendar.seed');

const SYSTEM_ACTOR = 'SYSTEM';
const TERMINAL = new Set(['FILED', 'PAID', 'WAIVED']);

// The RegistrationKind that gates each obligation kind (the applicability source
// of truth). PT/LWF are per-state; others are entity-wide.
const REG_FOR_KIND = Object.freeze({
  IN_TDS: 'TAN', IN_FORM24Q: 'TAN', IN_FORM138: 'TAN', IN_FORM16: 'TAN', IN_FORM130: 'TAN',
  IN_PF: 'EPF', IN_PF_ANNUAL: 'EPF',
  IN_ESI: 'ESI', IN_ESI_RETURN: 'ESI',
  IN_PT: 'PT_STATE',
  IN_LWF: 'LWF',
});

function toUtcDate(value) {
  if (value instanceof Date) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isZeroAmount(amount) {
  if (amount == null) return true;
  try { return Number(amount.toString()) === 0; } catch (_e) { return false; }
}

// ── applicability: is there an ACTIVE matching registration for this obligation? ──
async function isApplicable(ob, asOf, regCache) {
  const regKind = REG_FOR_KIND[ob.kind];
  if (!regKind) return true; // kinds with no registration gate (e.g. ad-hoc) pass through
  const cacheKey = `${ob.businessId}|${ob.entityId}|${regKind}|${ob.stateCode || ''}`;
  if (regCache.has(cacheKey)) return regCache.get(cacheKey);
  const where = {
    businessId: ob.businessId, entityId: ob.entityId, kind: regKind, isActive: true,
  };
  // PT/LWF match on the obligation's stateCode; others ignore state.
  if (regKind === 'PT_STATE' || regKind === 'LWF') where.stateCode = ob.stateCode || null;
  const regs = await prisma.statutoryRegistration.findMany({ where });
  // also honour the registration's own effective window vs asOf
  const active = regs.some((r) => {
    const ef = r.effectiveFrom ? toUtcDate(r.effectiveFrom) : null;
    const et = r.effectiveTo ? toUtcDate(r.effectiveTo) : null;
    return (!ef || ef.getTime() <= asOf.getTime()) && (!et || et.getTime() >= asOf.getTime());
  });
  regCache.set(cacheKey, active);
  return active;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5.1 generateUpcomingObligations
// ─────────────────────────────────────────────────────────────────────────────
async function generateUpcomingObligations({ businessId = null, entityId = null, horizonDays = 120, asOf = new Date(), dryRun = false } = {}) {
  const now = toUtcDate(asOf);
  const horizon = new Date(now.getTime() + horizonDays * 24 * 3600 * 1000);
  const summary = { scanned: 0, created: 0, skipped: 0, errors: 0 };

  const where = {
    isActive: true, autoGenerate: true,
    ...(businessId ? { businessId } : {}),
    ...(entityId ? { entityId } : {}),
  };
  const obligations = await prisma.complianceObligation.findMany({ where, take: 5000 });
  const regCache = new Map();

  for (const ob of obligations) {
    summary.scanned += 1;
    try {
      if (ob.cadence === 'EVENT') { summary.skipped += 1; continue; } // event-driven, not generated here
      if (!(await isApplicable(ob, now, regCache))) { summary.skipped += 1; continue; }

      const periods = cal.periodsBetween(
        {
          kind: ob.kind, cadence: ob.cadence, dueDom: ob.dueDom,
          dueMonths: ob.dueMonths, offsetMonths: ob.offsetMonths,
          specialRules: ob.specialRules || undefined,
          effectiveFrom: ob.effectiveFrom, effectiveTo: ob.effectiveTo,
        },
        now, horizon,
      );

      for (const p of periods) {
        const created = await upsertStub(ob, p, dryRun);
        if (created === 'created') summary.created += 1;
        else summary.skipped += 1;
      }
    } catch (e) {
      summary.errors += 1;
      // eslint-disable-next-line no-console
      console.error('[compliance.generate] obligation', ob.id, e.message);
    }
  }
  return summary;
}

// Upsert a PENDING amount-0 stub for (entity, kind, taxPeriod[, stateCode]). Returns
// 'created' | 'exists'. NEVER clobbers a non-PENDING / non-zero-amount row.
async function upsertStub(ob, period, dryRun) {
  const where = {
    businessId: ob.businessId, entityId: ob.entityId,
    kind: period.kind, taxPeriod: period.taxPeriod,
    ...(ob.stateCode ? { stateCode: ob.stateCode } : {}),
  };
  // Match the existing instance, including PT/LWF per-state rows. A NULL stateCode
  // obligation must match a NULL-stateCode row; a per-state one matches its state.
  const existing = await prisma.statutoryRemittance.findFirst({
    where: ob.stateCode
      ? { businessId: ob.businessId, entityId: ob.entityId, kind: period.kind, taxPeriod: period.taxPeriod, stateCode: ob.stateCode }
      : { businessId: ob.businessId, entityId: ob.entityId, kind: period.kind, taxPeriod: period.taxPeriod },
  });

  if (existing) {
    // Reconciliation: only ever ENRICH a payroll-written row with the back-link to
    // its definition; never touch its status/amount/dueDate (fileRun owns those).
    if (!existing.obligationId && !dryRun) {
      await prisma.statutoryRemittance.updateMany({
        where: { id: existing.id, version: existing.version },
        data: { obligationId: ob.id, version: { increment: 1 } },
      });
    }
    return 'exists';
  }

  if (dryRun) return 'created';

  // Resolve the currency from the entity (default INR for IN).
  const currencyCode = await resolveCurrency(ob);
  try {
    await prisma.statutoryRemittance.create({
      data: {
        businessId: ob.businessId, entityId: ob.entityId,
        kind: period.kind, taxPeriod: period.taxPeriod,
        stateCode: ob.stateCode || null,
        amount: 0, currencyCode,
        dueDate: period.dueDate,
        status: 'PENDING',
        obligationId: ob.id,
        meta: { generated: true, cadence: ob.cadence, label: (ob.meta && ob.meta.label) || null },
      },
    });
    return 'created';
  } catch (e) {
    // A concurrent generator/fileRun may have created the same key between our
    // findFirst and create — the StatutoryRemittance natural-key UNIQUE now makes
    // this race lose with a P2002 (previously, with no DB unique, this guard was
    // DEAD CODE and BOTH inserts succeeded → a duplicate obligation). Treat the
    // race as idempotent "exists" and best-effort enrich the winner's back-link.
    const isDup = e && (e.code === 'P2002' || /unique|duplicate|P2002/i.test(e.message || e.code || ''));
    if (isDup) {
      try {
        const won = await prisma.statutoryRemittance.findFirst({ where });
        if (won && !won.obligationId) {
          await prisma.statutoryRemittance.updateMany({
            where: { id: won.id, version: won.version },
            data: { obligationId: ob.id, version: { increment: 1 } },
          });
        }
      } catch (_e) { /* best-effort reconcile; the row exists either way */ }
      return 'exists';
    }
    throw e;
  }
}

const _currencyCache = new Map();
async function resolveCurrency(ob) {
  if (_currencyCache.has(ob.entityId)) return _currencyCache.get(ob.entityId);
  let cc = 'INR';
  try {
    const ent = await prisma.entity.findFirst({ where: { id: ob.entityId, businessId: ob.businessId }, select: { payCurrency: true, countryCode: true } });
    if (ent && ent.payCurrency) cc = ent.payCurrency;
    else if (ent && ent.countryCode === 'NZ') cc = 'NZD';
  } catch (_e) { /* default INR */ }
  _currencyCache.set(ob.entityId, cc);
  return cc;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5.2 sweepComplianceStatus
// ─────────────────────────────────────────────────────────────────────────────
async function sweepComplianceStatus({ businessId = null, asOf = new Date(), dryRun = false } = {}) {
  const now = toUtcDate(asOf);
  const summary = { scanned: 0, overdue: 0, due: 0, skipped: 0, errors: 0 };

  // Only consider calendar-tracked rows (those linked to an obligation) plus any
  // non-terminal remittance with a dueDate — but never touch terminal states.
  const rows = await prisma.statutoryRemittance.findMany({
    where: {
      status: { in: ['PENDING', 'DUE'] },
      ...(businessId ? { businessId } : {}),
    },
    take: 10000,
    orderBy: { dueDate: 'asc' },
  });

  for (const r of rows) {
    summary.scanned += 1;
    if (TERMINAL.has(r.status)) { summary.skipped += 1; continue; }
    const due = toUtcDate(r.dueDate);
    try {
      if (due.getTime() < now.getTime()) {
        // past due → OVERDUE
        if (r.status === 'OVERDUE') { summary.skipped += 1; continue; }
        if (!dryRun) {
          const flip = await prisma.statutoryRemittance.updateMany({
            where: { id: r.id, version: r.version, status: { in: ['PENDING', 'DUE'] } },
            data: { status: 'OVERDUE', version: { increment: 1 } },
          });
          if (flip.count === 0) { summary.skipped += 1; continue; } // raced
        }
        summary.overdue += 1;
      } else {
        // within the reminder window (dueDate - maxReminderDays) → DUE
        const window = await maxReminderDays(r);
        const windowStart = new Date(due.getTime() - window * 24 * 3600 * 1000);
        if (r.status === 'PENDING' && now.getTime() >= windowStart.getTime()) {
          if (!dryRun) {
            const flip = await prisma.statutoryRemittance.updateMany({
              where: { id: r.id, version: r.version, status: 'PENDING' },
              data: { status: 'DUE', version: { increment: 1 } },
            });
            if (flip.count === 0) { summary.skipped += 1; continue; }
          }
          summary.due += 1;
        } else {
          summary.skipped += 1;
        }
      }
    } catch (e) {
      summary.errors += 1;
      // eslint-disable-next-line no-console
      console.error('[compliance.sweep] remittance', r.id, e.message);
    }
  }
  return summary;
}

const _obCache = new Map();
async function loadObligation(obligationId) {
  if (!obligationId) return null;
  if (_obCache.has(obligationId)) return _obCache.get(obligationId);
  const ob = await prisma.complianceObligation.findUnique({ where: { id: obligationId } });
  _obCache.set(obligationId, ob);
  return ob;
}

async function maxReminderDays(r) {
  const ob = await loadObligation(r.obligationId);
  const days = (ob && Array.isArray(ob.reminderDays) && ob.reminderDays.length) ? ob.reminderDays : [7, 3, 1, 0];
  return Math.max(...days);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5.3 sendComplianceReminders
// ─────────────────────────────────────────────────────────────────────────────

// The reminder stage for a row given asOf + the obligation's reminderDays. Returns
// the matching "T-7"/"T-3"/"T-1"/"DUE"/"OVERDUE" string, or null if not yet eligible.
function reminderStageFor(dueDate, asOf, reminderDays) {
  const due = toUtcDate(dueDate).getTime();
  const now = toUtcDate(asOf).getTime();
  const dayMs = 24 * 3600 * 1000;
  const daysLeft = Math.round((due - now) / dayMs);
  if (daysLeft < 0) return 'OVERDUE';
  const sorted = [...(reminderDays || [7, 3, 1, 0])].sort((a, b) => b - a); // desc
  // pick the smallest configured threshold that is >= daysLeft (we've reached it)
  let stage = null;
  for (const d of sorted) {
    if (daysLeft <= d) stage = d; // keep tightening as we approach
  }
  if (stage == null) return null; // not yet inside any reminder window
  return stage === 0 ? 'DUE' : `T-${stage}`;
}

async function sendComplianceReminders({ businessId = null, asOf = new Date(), dryRun = false } = {}) {
  const now = toUtcDate(asOf);
  const summary = { scanned: 0, sent: 0, skipped: 0, errors: 0 };

  // Candidate rows: non-terminal, obligation-linked (the calendar tracks these),
  // whose dueDate is within the next 60 days or already overdue.
  const horizon = new Date(now.getTime() + 60 * 24 * 3600 * 1000);
  const rows = await prisma.statutoryRemittance.findMany({
    where: {
      status: { in: ['PENDING', 'DUE', 'OVERDUE'] },
      obligationId: { not: null },
      dueDate: { lte: horizon },
      ...(businessId ? { businessId } : {}),
    },
    take: 5000,
    orderBy: { dueDate: 'asc' },
  });

  // Resolve recipients once per business (canManageStatutory users → emails).
  const recipientCache = new Map();

  for (const r of rows) {
    summary.scanned += 1;
    try {
      const ob = await loadObligation(r.obligationId);
      const reminderDays = (ob && Array.isArray(ob.reminderDays) && ob.reminderDays.length) ? ob.reminderDays : [7, 3, 1, 0];
      const stage = reminderStageFor(r.dueDate, now, reminderDays);
      if (!stage) { summary.skipped += 1; continue; }
      if (r.reminderStage === stage) { summary.skipped += 1; continue; } // already nudged this stage → no spam

      if (dryRun) { summary.sent += 1; continue; }

      // Version-guarded stamp FIRST so a concurrent tick can't double-send. Only if
      // we win the stamp do we fan out (a re-run in the same window is a no-op).
      const flip = await prisma.statutoryRemittance.updateMany({
        where: { id: r.id, version: r.version },
        data: { reminderStage: stage, lastReminderAt: new Date(), remindersSent: { increment: 1 } },
      });
      if (flip.count === 0) { summary.skipped += 1; continue; } // raced

      const recipients = await resolveRecipients(r.businessId, recipientCache);
      const overdue = stage === 'OVERDUE';
      const event = overdue ? 'compliance.overdue' : 'compliance.reminder';
      const daysLeft = Math.max(0, Math.round((toUtcDate(r.dueDate).getTime() - now.getTime()) / (24 * 3600 * 1000)));
      const biz = await resolveBizName(r.businessId);
      const form = (ob && ob.meta && ob.meta.label) || labelForKind(r.kind);
      const link = `/payroll/compliance?remittanceId=${r.id}`;
      const due = toUtcDate(r.dueDate).toISOString().slice(0, 10);

      const baseVars = { BIZ: biz, FORM: form, PERIOD: r.taxPeriod, DUE: due, LINK: link };
      const vars = overdue ? baseVars : { ...baseVars, DAYS: String(daysLeft) };

      let anySent = false;
      for (const rec of recipients) {
        try {
          await notifyHrEvent({
            businessId: r.businessId, event,
            recipientEmail: rec.email || undefined,
            recipientCountry: 'IN',
            variables: vars,
            triggeredBy: overdue ? 'HR_COMPLIANCE_OVERDUE' : 'HR_COMPLIANCE_REMINDER',
          });
          anySent = true;
        } catch (_e) { /* best-effort per recipient */ }
      }
      // If there were NO canManageStatutory users, still emit a tenant-level event
      // (the router resolves business notification settings) so the nudge isn't lost.
      if (!recipients.length) {
        try {
          await notifyHrEvent({ businessId: r.businessId, event, recipientCountry: 'IN', variables: vars, triggeredBy: overdue ? 'HR_COMPLIANCE_OVERDUE' : 'HR_COMPLIANCE_REMINDER' });
          anySent = true;
        } catch (_e) { /* best-effort */ }
      }
      if (anySent) summary.sent += 1; else summary.skipped += 1;
    } catch (e) {
      summary.errors += 1;
      // eslint-disable-next-line no-console
      console.error('[compliance.remind] remittance', r.id, e.message);
    }
  }
  return summary;
}

async function resolveRecipients(businessId, cache) {
  if (cache.has(businessId)) return cache.get(businessId);
  let out = [];
  try {
    const userIds = await usersWithPermission(businessId, 'canManageStatutory');
    if (userIds.length) {
      const users = await prisma.user.findMany({ where: { id: { in: userIds }, isActive: true }, select: { id: true, email: true, name: true } });
      out = users.filter((u) => u.email).map((u) => ({ id: u.id, email: u.email, name: u.name }));
    }
  } catch (_e) { /* best-effort */ }
  cache.set(businessId, out);
  return out;
}

const _bizCache = new Map();
async function resolveBizName(businessId) {
  if (_bizCache.has(businessId)) return _bizCache.get(businessId);
  let name = 'Your organisation';
  try {
    const b = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } });
    if (b && b.name) name = b.name;
  } catch (_e) { /* default */ }
  _bizCache.set(businessId, name);
  return name;
}

function labelForKind(kind) {
  const map = {
    IN_TDS: 'TDS deposit', IN_PF: 'EPF ECR', IN_ESI: 'ESI contribution', IN_PT: 'Professional Tax',
    IN_LWF: 'Labour Welfare Fund', IN_FORM24Q: 'Form 24Q', IN_FORM138: 'Form 138',
    IN_FORM16: 'Form 16', IN_FORM130: 'Form 130', IN_ESI_RETURN: 'ESI return',
    IN_PF_ANNUAL: 'EPF annual', IN_GRATUITY: 'Gratuity', IN_BONUS: 'Statutory bonus',
  };
  return map[kind] || kind;
}

// ─────────────────────────────────────────────────────────────────────────────
// seedObligationsForEntity — derive ComplianceObligation rows from registrations
// ─────────────────────────────────────────────────────────────────────────────
async function seedObligationsForEntity({ businessId, entityId, actorId = SYSTEM_ACTOR, dryRun = false } = {}) {
  if (!businessId || !entityId) throw new Error('seedObligationsForEntity requires businessId + entityId');
  const summary = { created: 0, updated: 0, skipped: 0 };

  const registrations = await prisma.statutoryRegistration.findMany({
    where: { businessId, entityId, isActive: true },
  });
  const defs = seed.buildObligationsForRegistrations(registrations);

  for (const d of defs) {
    const natural = {
      businessId, entityId, kind: d.kind, stateCode: d.stateCode || null,
      effectiveFrom: new Date(d.effectiveFrom + 'T00:00:00Z'),
    };
    const existing = await prisma.complianceObligation.findFirst({ where: natural });
    const data = {
      cadence: d.cadence, dueDom: d.dueDom ?? null,
      dueMonths: Array.isArray(d.dueMonths) ? d.dueMonths : [],
      offsetMonths: Number.isInteger(d.offsetMonths) ? d.offsetMonths : 1,
      specialRules: d.specialRules || null,
      effectiveTo: d.effectiveTo ? new Date(d.effectiveTo + 'T00:00:00Z') : null,
      supersededBy: d.supersededBy || null,
      isActive: true,
      autoGenerate: d.autoGenerate !== false,
      reminderDays: Array.isArray(d.reminderDays) ? d.reminderDays : [7, 3, 1, 0],
      meta: d.meta || null,
    };
    if (dryRun) { existing ? summary.updated += 1 : summary.created += 1; continue; }
    if (existing) {
      // Preserve HR edits to isActive / autoGenerate / reminderDays: only refresh the
      // RULE fields (cadence/dueDom/…) and meta; do NOT silently re-enable a toggle the
      // operator turned off.
      await prisma.complianceObligation.update({
        where: { id: existing.id },
        data: {
          cadence: data.cadence, dueDom: data.dueDom, dueMonths: data.dueMonths,
          offsetMonths: data.offsetMonths, specialRules: data.specialRules,
          effectiveTo: data.effectiveTo, supersededBy: data.supersededBy, meta: data.meta,
          version: { increment: 1 },
        },
      });
      summary.updated += 1;
    } else {
      await prisma.complianceObligation.create({ data: { ...natural, ...data } });
      summary.created += 1;
    }
  }

  await writeAudit({
    businessId, actorId, action: 'compliance.obligations.seed',
    entityType: 'Entity', entityId,
    meta: { derived: defs.length, ...summary },
  });
  return summary;
}

// ── CLI entry (mirrors escalationRunner usage) ──────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const bizArg = args.find((a) => a.startsWith('--business='));
  const businessId = bizArg ? bizArg.split('=')[1] : null;
  (async () => {
    const g = await generateUpcomingObligations({ businessId, dryRun });
    const s = await sweepComplianceStatus({ businessId, dryRun });
    const n = await sendComplianceReminders({ businessId, dryRun });
    console.log('[compliance] generate', JSON.stringify(g));
    console.log('[compliance] sweep', JSON.stringify(s));
    console.log('[compliance] remind', JSON.stringify(n));
  })()
    .then(() => prisma.$disconnect())
    .then(() => process.exit(0))
    .catch((e) => { console.error('[compliance] fatal', e); process.exit(1); });
}

module.exports = {
  generateUpcomingObligations,
  sweepComplianceStatus,
  sendComplianceReminders,
  seedObligationsForEntity,
  _internals: { reminderStageFor, isApplicable, upsertStub, REG_FOR_KIND, labelForKind },
};
