'use strict';

/**
 * consumers.award.js — Feature 35. The AWARD (nomination committee) consumer bundle.
 *
 * awards.service.decideCycle opens ONE AWARD request per shortlisted nominee and pins
 * the per-cycle committee as the parallel all-of level; the engine decides WHEN the
 * committee has fully approved. These callbacks carry the domain effect INSIDE the
 * engine transaction:
 *
 *   onApprove(req, tx) — SHORTLISTED → WON: grant cycle.pointsToWinner to the
 *     winner's wallet (ledgerEntryId-guarded, reason=AWARD), project a celebratory
 *     feed post, flip the cycle CLOSED → DECIDED once no SHORTLISTED nominations
 *     remain. The F9 certificate + winner notification run AFTER the tx settles
 *     (deferred + WON-guarded; the nightly award-cycle runner re-tries any
 *     certificate that slipped — eventual consistency, never a stuck award).
 *   onReject(req, tx)  — SHORTLISTED → NOT_SELECTED (no points, no certificate).
 *   onCancel(req, tx)  — HR withdrew the committee request → back to SHORTLISTED
 *     minus the request link, so the cycle can be re-decided.
 */

const consumers = require('./consumers');
const notify = require('./notify');
const prismaDefault = require('../../core/lib/prisma');
const pointsLedger = require('../recognition/pointsLedger');
const { getConfig } = require('../recognition/config');
const { issueAwardCertificate } = require('../recognition/certificate');
const { notifyHrEvent } = require('../integrations/notifications');

const DEFER_MS = 2000;

function fullName(emp) { return emp ? ([emp.firstName, emp.lastName].filter(Boolean).join(' ') || emp.code || 'A colleague') : 'A colleague'; }
function emailOf(emp) { return emp ? (emp.workEmail || emp.personalEmail || null) : null; }

async function loadNomination(tx, approvalRequest) {
  return tx.awardNomination.findFirst({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId },
    include: { cycle: true, nominee: { select: { id: true, code: true, firstName: true, lastName: true, userId: true } } },
  });
}

// onApprove — SHORTLISTED → WON + points + feed post (+ deferred cert/notify).
async function onApprove(approvalRequest, tx) {
  const nom = await loadNomination(tx, approvalRequest);
  if (!nom || nom.status !== 'SHORTLISTED') return; // no-op on a re-fire / stale hook
  const now = new Date();
  const flip = await tx.awardNomination.updateMany({
    where: { id: nom.id, status: 'SHORTLISTED' },
    data: { status: 'WON', decidedByUserId: approvalRequest.decidedBy || null, decidedAt: now },
  });
  if (flip.count === 0) return;

  const cycle = nom.cycle;

  // Prize points (config-gated: a ₹-disabled program grants zero — spec §8).
  const config = await getConfig(nom.businessId, { tx });
  if (cycle && cycle.pointsToWinner > 0 && config.pointsEnabled && !nom.ledgerEntryId) {
    const { entry } = await pointsLedger.credit(tx, {
      businessId: nom.businessId,
      employeeId: nom.nomineeEmployeeId,
      points: cycle.pointsToWinner,
      reason: 'AWARD',
      refType: 'AwardNomination',
      refId: nom.id,
    });
    const stamped = await tx.awardNomination.updateMany({
      where: { id: nom.id, ledgerEntryId: null },
      data: { ledgerEntryId: entry.id },
    });
    if (stamped.count === 0) {
      await pointsLedger.debit(tx, {
        businessId: nom.businessId,
        employeeId: nom.nomineeEmployeeId,
        points: cycle.pointsToWinner,
        reason: 'REVERSAL',
        refType: 'AwardNomination',
        refId: nom.id,
        note: 'Duplicate award-grant reversal',
      });
    }
  }

  // Celebratory feed post (tenant-wide). Guarded by the conditional WON flip above,
  // so a re-fired hook can never double-post. notifiedAt stamped — no announcement
  // fan-out blast; the winner gets the dedicated award.won event below.
  if (cycle) {
    await tx.announcement.create({
      data: {
        businessId: nom.businessId,
        authorUserId: 'SYSTEM',
        authorName: 'Rewards & Recognition',
        title: `🏆 ${fullName(nom.nominee)} wins ${cycle.name}`.slice(0, 300),
        bodyRichText: `${nom.citation ? `“${nom.citation.slice(0, 1000)}”\n\n` : ''}Congratulations, ${fullName(nom.nominee)}! 🎉`,
        category: 'CELEBRATION',
        audienceScope: 'ALL',
        status: 'PUBLISHED',
        publishedAt: now,
        notifiedAt: now,
      },
    });
    // Cycle → DECIDED once nothing is left for the committee.
    const remaining = await tx.awardNomination.count({
      where: { businessId: nom.businessId, cycleId: cycle.id, status: 'SHORTLISTED', id: { not: nom.id } },
    });
    if (remaining === 0) {
      await tx.awardCycle.updateMany({
        where: { id: cycle.id, status: 'CLOSED' },
        data: { status: 'DECIDED' },
      });
    }
  }

  // Certificate + winner notification AFTER the tx settles (WON-guarded re-reads).
  setTimeout(() => { finalizeWinSideEffects(nom.id).catch(() => {}); }, DEFER_MS);
}

// The deferred, idempotent side-effects: F9 certificate + award.won notification.
async function finalizeWinSideEffects(nominationId) {
  const nom = await prismaDefault.awardNomination.findFirst({
    where: { id: nominationId, status: 'WON' },
    include: {
      cycle: true,
      nominee: { select: { id: true, firstName: true, lastName: true, code: true, workEmail: true, personalEmail: true, phone: true, countryCode: true, userId: true } },
    },
  });
  if (!nom) return; // rolled back / not visible — the nightly runner catches up

  let certIssued = false;
  try {
    const r = await issueAwardCertificate({ nomination: nom, cycle: nom.cycle });
    certIssued = !!r;
  } catch (e) {
    console.error('[award consumer] certificate issue failed:', e.message);
  }

  // In-app + multi-channel winner notification (deduped by triggeredBy).
  if (nom.nominee && nom.nominee.userId) {
    try {
      await prismaDefault.notification.create({
        data: {
          businessId: nom.businessId,
          recipientUserId: nom.nominee.userId,
          type: 'ONBOARDING_TASK',
          channel: 'IN_APP',
          title: `🏆 You won ${nom.cycle ? nom.cycle.name : 'an award'}!`,
          body: 'Congratulations! Check My Letters for your certificate.',
          entityType: 'AwardNomination',
          entityId: nom.id,
          dataJson: { kind: 'AWARD_WON', nominationId: nom.id, cycleId: nom.cycleId },
        },
      });
    } catch (_e) { /* best-effort */ }
  }
  const email = emailOf(nom.nominee);
  if (email || (nom.nominee && nom.nominee.phone)) {
    notifyHrEvent({
      businessId: nom.businessId,
      event: 'award.won',
      recipientEmail: email,
      recipientPhone: (nom.nominee && nom.nominee.phone) || undefined,
      recipientCountry: (nom.nominee && nom.nominee.countryCode) || undefined,
      variables: {
        NAME: (nom.nominee && nom.nominee.firstName) || 'there',
        AWARD: nom.cycle ? nom.cycle.name : 'an award',
        POINTS: nom.cycle && nom.cycle.pointsToWinner > 0 ? ` with ${nom.cycle.pointsToWinner} points` : '',
        CERT: certIssued || nom.certificateLetterId ? 'Your certificate is in My Letters.' : '',
        BIZ: '',
        LINK: '/letters',
      },
      triggeredBy: `HR_AWARD_WON:${nom.id}`,
    }).catch(() => {});
  }
}

// onReject — SHORTLISTED → NOT_SELECTED.
async function onReject(approvalRequest, tx) {
  const nom = await loadNomination(tx, approvalRequest);
  if (!nom || nom.status !== 'SHORTLISTED') return;
  await tx.awardNomination.updateMany({
    where: { id: nom.id, status: 'SHORTLISTED' },
    data: { status: 'NOT_SELECTED', decidedByUserId: approvalRequest.decidedBy || null, decidedAt: new Date() },
  });
  notify.fanOutApprovalDecided({ businessId: approvalRequest.businessId, request: approvalRequest, outcome: 'REJECTED' }).catch(() => {});
}

// onCancel — HR withdrew the committee request: stay SHORTLISTED, unlink the request
// so decideCycle can route it again.
async function onCancel(approvalRequest, tx) {
  await tx.awardNomination.updateMany({
    where: { id: approvalRequest.entityId, businessId: approvalRequest.businessId, status: 'SHORTLISTED' },
    data: { approvalRequestId: null },
  });
}

const bundle = { onApprove, onReject, onCancel };

function registerAwardConsumer() {
  return consumers.register('AWARD', bundle);
}

// Self-register on module load (idempotent), mirroring consumers.expense.js.
registerAwardConsumer();

module.exports = { registerAwardConsumer, bundle, finalizeWinSideEffects };
