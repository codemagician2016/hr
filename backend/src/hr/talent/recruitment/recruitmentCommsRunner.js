'use strict';

/**
 * recruitmentCommsRunner.js — Feature 36 scheduled sweeps.
 *
 *   (1) sweepExpiredSlotProposals — flip stale PROPOSED slot proposals past their
 *       expiresAt → EXPIRED and notify HR (the proposer) in-app (§7.4). Slice 2.
 *   (2) runInterviewFeedbackNudge — nudge panellists with an un-submitted DRAFT
 *       scorecard after a COMPLETED interview, once per (interview, panellist,
 *       window), deep-linked to their scorecard (§4.7). Slice 4.
 *
 * Both are tenant-safe (every read scoped by businessId), idempotent, per-row
 * fail-soft (a bad row never aborts the sweep), and best-effort on the fan-out
 * (a notify failure is counted, never thrown). Structural copy of the other HR
 * runners (learning / compliance / comp-off).
 */

const prisma = require('../../../core/lib/prisma');
// REUSE the approvals fan-out internals: employee recipient resolver + dispatchOne
// (contact → prefs → atomic dedupe → router) + the deep-link base URL.
const approvals = require('../../approvals/notify')._internals;

function candidateNameOf(cand) {
  if (!cand) return 'the candidate';
  const n = `${cand.firstName || ''} ${cand.lastName || ''}`.trim();
  return n || 'the candidate';
}

// ── (1) Slot-proposal expiry sweep ────────────────────────────────────────────
async function sweepExpiredSlotProposals({ asOf = new Date() } = {}) {
  const summary = { expired: 0, notified: 0, errors: 0 };
  let stale = [];
  try {
    stale = await prisma.interviewSlotProposal.findMany({
      where: { status: 'PROPOSED', expiresAt: { not: null, lte: asOf } },
      take: 500,
      include: {
        interview: {
          select: {
            id: true,
            application: { select: { candidate: { select: { firstName: true, lastName: true } }, job: { select: { title: true } } } },
          },
        },
      },
    });
  } catch (e) { summary.errors += 1; return summary; }

  for (const p of stale) {
    try {
      // Conditional flip — only a still-PROPOSED row expires (a just-confirmed one
      // is left alone), so the sweep is idempotent + race-safe.
      const upd = await prisma.interviewSlotProposal.updateMany({
        where: { id: p.id, status: 'PROPOSED' },
        data: { status: 'EXPIRED' },
      });
      if (upd.count === 0) continue;
      summary.expired += 1;

      // Notify HR (the proposer) in-app — best-effort. No channel template exists
      // for this internal notice, so it rides the operator inbox, not the router.
      if (p.proposedById) {
        const app = p.interview && p.interview.application;
        const cand = candidateNameOf(app && app.candidate);
        const role = (app && app.job && app.job.title) || 'the role';
        const ok = await prisma.inboxNotification.create({
          data: {
            businessId: p.businessId,
            userId: p.proposedById,
            type: 'RECRUITMENT_SLOT_EXPIRED',
            title: 'Interview slot request expired',
            body: `The proposed interview slots for ${cand} (${role}) expired without a response. Re-propose new times to keep the candidate moving.`,
            ctaLabel: 'Reschedule',
            ctaUrl: `/recruitment/interviews/${p.interviewId}`,
          },
        }).then(() => true).catch(() => false);
        if (ok) summary.notified += 1;
      }
    } catch (e) { summary.errors += 1; }
  }
  return summary;
}

// ── (2) Interview-feedback nudge ──────────────────────────────────────────────
// COMPLETED interviews whose completion (updatedAt) is past the grace window and
// within the lookback, that still carry ≥1 DRAFT (un-submitted) scorecard → nudge
// each such panellist Employee, deduped one per (interview, panellist, window).
async function runInterviewFeedbackNudge({ asOf = new Date(), graceHours = 24, lookbackDays = 14 } = {}) {
  const summary = { interviews: 0, nudged: 0, skipped: 0, errors: 0 };
  const graceCutoff = new Date(asOf.getTime() - graceHours * 60 * 60 * 1000);
  const lookbackFloor = new Date(asOf.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  // Daily window key — one nudge per (interview, panellist) per calendar day until
  // the card is submitted (then the DRAFT filter naturally stops nudging).
  const windowKey = Math.floor(asOf.getTime() / (24 * 60 * 60 * 1000));

  let interviews = [];
  try {
    interviews = await prisma.interview.findMany({
      where: {
        status: 'COMPLETED',
        updatedAt: { lte: graceCutoff, gte: lookbackFloor },
        scorecards: { some: { status: 'DRAFT' } },
      },
      take: 1000,
      include: {
        scorecards: { where: { status: 'DRAFT' }, select: { id: true, interviewerEmployeeId: true } },
        application: { select: { candidate: { select: { firstName: true, lastName: true } }, job: { select: { title: true } } } },
      },
    });
  } catch (e) { summary.errors += 1; return summary; }

  for (const iv of interviews) {
    summary.interviews += 1;
    const app = iv.application;
    const candidate = candidateNameOf(app && app.candidate);
    const role = (app && app.job && app.job.title) || 'the role';
    const when = iv.scheduledAt ? new Date(iv.scheduledAt).toISOString() : new Date(iv.updatedAt).toISOString();
    const link = `${approvals.appBaseUrl()}/me/scorecards/${iv.id}`;
    // one nudge per panellist even if they somehow hold multiple DRAFT cards.
    const panellists = [...new Set(iv.scorecards.map((c) => c.interviewerEmployeeId).filter(Boolean))];
    for (const empId of panellists) {
      try {
        const recipient = await approvals.recipientByEmployeeId(iv.businessId, empId);
        if (!recipient) { summary.skipped += 1; continue; }
        const dedupeToken = `HR_FEEDBACK_NUDGE:${iv.id}:${empId}:w${windowKey}`;
        const r = await approvals.dispatchOne({
          businessId: iv.businessId,
          recipient,
          event: 'interview.feedback_nudge',
          variables: { CANDIDATE: candidate, ROLE: role, WHEN: when, LINK: link },
          dedupeToken,
        });
        if (r && r.ok && !r.deduped) summary.nudged += 1; else summary.skipped += 1;
      } catch (e) { summary.errors += 1; }
    }
  }
  return summary;
}

module.exports = { sweepExpiredSlotProposals, runInterviewFeedbackNudge };
