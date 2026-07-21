'use strict';

/**
 * pulseScheduleRunner.js — Feature 33 §5.4 recurrence + close + reminders.
 * Modelled on compOffExpiryRunner/proofWindowRunner: scan → pure check → guarded
 * write → per-row fail-soft; the in-process overlap flag lives in scheduler.js.
 *
 * Daily tick (06:20 UTC), three passes per tenant:
 *   CLOSE  — flip SurveyOccurrence OPEN→CLOSED where closesAt < now; when the parent
 *            survey is one-shot (or its recurrence has ended) flip Survey
 *            PUBLISHED→CLOSED and fire survey.closed to the author.
 *   SPAWN  — for each PUBLISHED recurring Survey that is live, whose latest
 *            occurrence has CLOSED and whose next cadence tick has arrived (and
 *            recurrenceEndsAt not passed) → create seq+1 (idempotent on
 *            @@unique([surveyId, seq])), fan out invites, stamp notifiedAt.
 *            ALSO the go-live catch-up: a future-dated publish whose time has come
 *            (survey live, occurrence #1 open, notifiedAt still null) gets its
 *            invite fan-out HERE (edge case 4) — publishing never re-blasts.
 *   REMIND — OPEN occurrences past ~50% of their window with response-rate < 75%:
 *            survey.reminder to audience − {SUBMITTED/DISMISSED participations}.
 *            Fired only on the tick right after the midpoint (once per occurrence
 *            for a daily cron) — there is deliberately no reminder-stamp column.
 *
 * A missed tick is safe: opening is date-driven (the ESS feed filters live
 * occurrences itself), closing/spawning catch up idempotently on the next run.
 *
 * CLI: node src/hr/engagement/surveys/pulseScheduleRunner.js [--business=<id>] [--asOf=<iso>] [--dry]
 */

const prisma = require('../../../core/lib/prisma');
const { resolveAudienceEmployees } = require('../audience');
const { notifyHrEvent } = require('../../integrations/notifications');
const surveyService = require('./survey.service');

const DAY_MS = 86400000;
const REMINDER_RATE_THRESHOLD = 0.75; // skip the nag when ≥75% already responded

function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }

/** Pure: when is the NEXT occurrence due to open, given the latest one? */
function nextOpensAt(survey, latest) {
  const from = new Date(latest.opensAt);
  const cadence = survey.cadence;
  let next;
  if (cadence === 'WEEKLY') next = new Date(from.getTime() + 7 * DAY_MS);
  else if (cadence === 'FORTNIGHTLY') next = new Date(from.getTime() + 14 * DAY_MS);
  else if (cadence === 'MONTHLY' || cadence === 'QUARTERLY') {
    // Add months on the FIRST of the month (a day-31 start must not roll Feb→Mar),
    // then anchor to the configured day-of-month, clamped to the month's length.
    const months = cadence === 'MONTHLY' ? 1 : 3;
    next = new Date(Date.UTC(
      from.getUTCFullYear(), from.getUTCMonth() + months, 1,
      from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(),
    ));
    const daysInMonth = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    const anchor = Number.isInteger(survey.cadenceAnchorDay) ? survey.cadenceAnchorDay : from.getUTCDate();
    next.setUTCDate(Math.min(Math.max(1, anchor), daysInMonth));
    return next;
  } else return null;
  // WEEKLY/FORTNIGHTLY: anchor to day-of-week (1=Mon…7=Sun) when configured.
  if (Number.isInteger(survey.cadenceAnchorDay) && survey.cadenceAnchorDay >= 1 && survey.cadenceAnchorDay <= 7) {
    const want = survey.cadenceAnchorDay % 7; // 7 (Sun) → 0 (JS Sunday)
    while (next.getUTCDay() !== want) next = new Date(next.getTime() + DAY_MS);
  }
  return next;
}

/**
 * runPulseScheduleSweep(opts) — spawn/close/remind per §5.4.
 * Returns { tenants, closedOccurrences, closedSurveys, spawned, invitesSent,
 *           goLiveNotified, remindersSent, skipped, errors }.
 */
async function runPulseScheduleSweep({ businessId = null, asOf = new Date(), dryRun = false } = {}) {
  const now = asOf instanceof Date ? asOf : new Date(asOf);
  const summary = {
    tenants: 0, closedOccurrences: 0, closedSurveys: 0, spawned: 0,
    invitesSent: 0, goLiveNotified: 0, remindersSent: 0, skipped: 0, errors: 0,
  };

  const tenantIds = businessId
    ? [businessId]
    : (await prisma.survey.findMany({
        where: { status: 'PUBLISHED' },
        select: { businessId: true },
        distinct: ['businessId'],
        take: 10000,
      })).map((s) => s.businessId);

  for (const bId of tenantIds) {
    summary.tenants += 1;

    // ── CLOSE pass — lapse OPEN occurrences whose window ended. ──────────────
    const lapsed = await prisma.surveyOccurrence.findMany({
      where: { businessId: bId, status: 'OPEN', closesAt: { lt: now } },
      include: { survey: true },
      take: 5000,
    });
    for (const occ of lapsed) {
      try {
        if (dryRun) { summary.closedOccurrences += 1; continue; }
        await prisma.$transaction(async (tx) => {
          // In-tx re-guard (idempotent under a concurrent close/sweep).
          const fresh = await tx.surveyOccurrence.findUnique({ where: { id: occ.id }, select: { status: true } });
          if (!fresh || fresh.status !== 'OPEN') return;
          await tx.surveyOccurrence.update({ where: { id: occ.id }, data: { status: 'CLOSED' } });
        });
        summary.closedOccurrences += 1;

        const survey = occ.survey;
        const recurrenceOver = survey.recurrenceEndsAt && survey.recurrenceEndsAt <= now;
        if (survey.status === 'PUBLISHED' && (!survey.cadence || recurrenceOver)) {
          // One-shot's only window (or a finished recurrence) → the survey closes too.
          await prisma.survey.updateMany({
            where: { id: survey.id, status: 'PUBLISHED', version: survey.version },
            data: { status: 'CLOSED', version: { increment: 1 } },
          });
          summary.closedSurveys += 1;
          await surveyService.notifySurveyClosed({ ...survey, status: 'CLOSED' }, occ).catch(() => {});
        } else if (survey.status === 'PUBLISHED' && survey.cadence) {
          // A recurring run closed — tell the author this occurrence's tally.
          await surveyService.notifySurveyClosed(survey, occ).catch(() => {});
        }
      } catch (e) {
        if (e && e.code === 'P2025') { summary.skipped += 1; continue; }
        summary.errors += 1;
        console.error('[pulse sweep] close occurrence', occ.id, e && e.message);
      }
    }

    // ── SPAWN + GO-LIVE pass — live PUBLISHED surveys. ───────────────────────
    const liveSurveys = await prisma.survey.findMany({
      where: { businessId: bId, status: 'PUBLISHED', publishedAt: { not: null, lte: now } },
      take: 5000,
    });
    for (const survey of liveSurveys) {
      try {
        const latest = await prisma.surveyOccurrence.findFirst({
          where: { surveyId: survey.id },
          orderBy: { seq: 'desc' },
        });

        // GO-LIVE catch-up (edge 4): future-dated publish reached its time — the
        // publish action stayed silent, so the first invite blast happens here.
        // Guard: survey.notifiedAt null == never blasted.
        if (latest && latest.status === 'OPEN' && survey.notifiedAt == null) {
          if (!dryRun) {
            const stamped = await prisma.survey.updateMany({
              where: { id: survey.id, notifiedAt: null },
              data: { notifiedAt: now },
            });
            if (stamped.count > 0) {
              const sent = await surveyService.fanOutInvites(survey, latest).catch(() => 0);
              await prisma.surveyOccurrence.updateMany({
                where: { id: latest.id, notifiedAt: null }, data: { notifiedAt: now },
              });
              summary.goLiveNotified += 1;
              summary.invitesSent += sent;
            }
          } else summary.goLiveNotified += 1;
          continue; // freshly (or still) open — nothing to spawn yet
        }

        // Catch-up: a one-shot (or ended-recurrence) survey whose window already
        // closed but whose status flip was lost (crash between the two writes in a
        // prior sweep) → flip CLOSED now, idempotently. No re-notify (the close
        // pass owns the author notification).
        const recurrenceOver = survey.recurrenceEndsAt && survey.recurrenceEndsAt <= now;
        if ((!survey.cadence || recurrenceOver) && latest && latest.status === 'CLOSED') {
          if (!dryRun) {
            const r = await prisma.survey.updateMany({
              where: { id: survey.id, status: 'PUBLISHED' },
              data: { status: 'CLOSED', version: { increment: 1 } },
            });
            if (r.count > 0) summary.closedSurveys += 1;
          }
          continue;
        }

        // SPAWN — recurring, latest window closed, next cadence tick arrived.
        if (!survey.cadence) continue;
        if (recurrenceOver) continue; // edge 13
        if (!latest || latest.status !== 'CLOSED') continue;
        const due = nextOpensAt(survey, latest);
        if (!due || due > now) continue;

        if (dryRun) { summary.spawned += 1; continue; }
        const audience = await resolveAudienceEmployees(survey).catch(() => []);
        let occurrence;
        try {
          occurrence = await prisma.surveyOccurrence.create({
            data: {
              businessId: bId,
              surveyId: survey.id,
              seq: latest.seq + 1,
              opensAt: now,
              closesAt: new Date(now.getTime() + (survey.windowDays || 7) * DAY_MS),
              status: 'OPEN',
              invitedCount: audience.length,
            },
          });
        } catch (e) {
          if (e && e.code === 'P2002') { summary.skipped += 1; continue; } // raced; idempotent
          throw e;
        }
        summary.spawned += 1;
        // Per-occurrence idempotent invite stamp → fan out once.
        const stamped = await prisma.surveyOccurrence.updateMany({
          where: { id: occurrence.id, notifiedAt: null },
          data: { notifiedAt: now },
        });
        if (stamped.count > 0) {
          summary.invitesSent += await surveyService.fanOutInvites(survey, occurrence, audience).catch(() => 0);
        }
      } catch (e) {
        summary.errors += 1;
        console.error('[pulse sweep] spawn survey', survey.id, e && e.message);
      }
    }

    // ── REMIND pass — OPEN occurrences just past ~50% of their window. ───────
    const open = await prisma.surveyOccurrence.findMany({
      where: {
        businessId: bId, status: 'OPEN', opensAt: { lte: now }, closesAt: { gt: now },
        survey: { is: { status: 'PUBLISHED' } },
      },
      include: { survey: true },
      take: 5000,
    });
    for (const occ of open) {
      try {
        const mid = new Date((occ.opensAt.getTime() + occ.closesAt.getTime()) / 2);
        // Fire only on the first daily tick AFTER the midpoint (once per occurrence).
        if (now < mid || now.getTime() - mid.getTime() >= DAY_MS) continue;
        const submitted = await prisma.surveyParticipation.count({
          where: { occurrenceId: occ.id, state: 'SUBMITTED' },
        });
        const rate = occ.invitedCount > 0 ? submitted / occ.invitedCount : 0;
        if (rate >= REMINDER_RATE_THRESHOLD) continue;
        if (dryRun) continue;

        const audience = await resolveAudienceEmployees(occ.survey).catch(() => []);
        if (!audience.length) continue;
        const done = await prisma.surveyParticipation.findMany({
          where: { occurrenceId: occ.id, state: { in: ['SUBMITTED', 'DISMISSED'] } },
          select: { employeeId: true },
        });
        const doneSet = new Set(done.map((p) => p.employeeId));
        for (const emp of audience) {
          if (doneSet.has(emp.id)) continue;
          const prefs = emp.notifyPrefs || null;
          if (prefs && prefs.optOut === true) continue;
          const email = emp.workEmail || emp.personalEmail || null;
          const phone = emp.phone || null;
          if (!email && !phone) continue;
          notifyHrEvent({
            businessId: bId,
            event: 'survey.reminder',
            recipientEmail: email,
            recipientPhone: phone,
            recipientCountry: emp.countryCode || undefined,
            variables: {
              employeeName: emp.firstName || 'there',
              surveyTitle: occ.survey.title,
              closesOn: isoDay(occ.closesAt),
              link: '/surveys',
            },
            triggeredBy: `HR_SURVEY_REMINDER:${occ.id}:${emp.id}`,
          }).catch(() => {});
          summary.remindersSent += 1;
        }
      } catch (e) {
        summary.errors += 1;
        console.error('[pulse sweep] remind occurrence', occ.id, e && e.message);
      }
    }
  }
  return summary;
}

// ── CLI entry ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (p) => { const a = args.find((x) => x.startsWith(p)); return a ? a.split('=')[1] : null; };
  const businessId = get('--business=');
  const asOf = get('--asOf=') ? new Date(get('--asOf=')) : new Date();
  const dryRun = args.includes('--dry');
  runPulseScheduleSweep({ businessId, asOf, dryRun })
    .then((s) => { console.log('[pulse sweep] summary', JSON.stringify(s)); return prisma.$disconnect(); })
    .then(() => process.exit(0))
    .catch((e) => { console.error('[pulse sweep] fatal', e); process.exit(1); });
}

module.exports = { runPulseScheduleSweep, _internals: { nextOpensAt } };
