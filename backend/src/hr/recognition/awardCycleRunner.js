'use strict';

/**
 * awardCycleRunner.js — Feature 35 §4.4/§7 nightly award-cycle lifecycle:
 *   1. Flip OPEN cycles whose nomination window has passed → CLOSED (conditional
 *      updateMany — idempotent) and drop the cycle creator an in-app nudge to
 *      shortlist + declare winners.
 *   2. Certificate CATCH-UP: (re)issue the F9 certificate for any WON nomination
 *      that still lacks one (the consumer's deferred issue is best-effort; this
 *      makes it eventually consistent — never a stuck award).
 * Tenant-safe (rows carry businessId), per-row fail-soft.
 */

const prisma = require('../../core/lib/prisma');
const awards = require('./awards.service');

async function runAwardCycleLifecycle({ asOf = new Date() } = {}) {
  const out = { closed: 0, certificates: 0, errors: 0 };

  // 1) Close expired nomination windows.
  let toClose = [];
  try {
    toClose = await prisma.awardCycle.findMany({
      where: { status: 'OPEN', nominateCloseAt: { lte: asOf } },
      select: { id: true, businessId: true, name: true, createdByUserId: true },
    });
  } catch (e) {
    out.errors += 1;
    console.error('[award lifecycle] close scan failed:', e.message);
  }
  for (const cycle of toClose) {
    try {
      const flip = await prisma.awardCycle.updateMany({
        where: { id: cycle.id, status: 'OPEN' },
        data: { status: 'CLOSED' },
      });
      if (flip.count === 0) continue; // raced a manual close — fine
      out.closed += 1;
      if (cycle.createdByUserId) {
        await prisma.notification.create({
          data: {
            businessId: cycle.businessId,
            recipientUserId: cycle.createdByUserId,
            type: 'ONBOARDING_TASK',
            channel: 'IN_APP',
            title: `Nominations closed — ${cycle.name}`,
            body: 'Shortlist the nominations and declare the winner(s).',
            entityType: 'AwardCycle',
            entityId: cycle.id,
            dataJson: { kind: 'AWARD_CYCLE_CLOSED', cycleId: cycle.id },
          },
        }).catch(() => {});
      }
    } catch (e) {
      out.errors += 1;
      console.error('[award lifecycle] close failed for cycle', cycle.id, e.message);
    }
  }

  // 2) Certificate catch-up (WON + certificateLetterId null + cycle wants one).
  try {
    out.certificates = await awards.issueMissingCertificates({ limit: 25 });
  } catch (e) {
    out.errors += 1;
    console.error('[award lifecycle] certificate catch-up failed:', e.message);
  }

  return out;
}

module.exports = { runAwardCycleLifecycle };
