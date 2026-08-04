'use strict';

/**
 * setup/talent/activation.js — the hiring track's finish line, as a fact.
 *
 * THE MOMENT is `careers_live` AND `job_public`: the page is published and at least
 * one job is visible on it. It is computed from the two DB facts that actually make
 * the public board work, NEVER from the track percentage — a tenant sitting at 73%
 * because they skipped scorecards and perks still gets its live state, because the
 * activation moment belongs to the candidate-facing reality rather than to our
 * checklist. (The corollary is that `state` can read 'live' below 100%. That is
 * intended; the card's proof line says so in words.)
 *
 * Wired in as the talent track descriptor's `extras` hook, so nothing
 * hiring-specific leaks into the shared controller code path: it is handed the same
 * context the probes ran against, and returns fields that are merged into the
 * payload. The core track passes null and gains nothing.
 *
 * NEVER THROWS. Activation is a decoration on an advisory page; a wobble here
 * returns null and the client falls back to the ordinary next-action card, exactly
 * as a failed probe degrades one row rather than the response.
 */

const { careersBoardUrl } = require('../../talent/recruitment/candidateNotify')._internals;

// A live job is one a candidate loading the board can actually see and apply to —
// publicBoard()'s own where-clause, plus the publicSlug that makes its link resolve.
const liveJobWhere = (businessId) => ({
  businessId, deletedAt: null, isPublic: true, status: 'OPEN', publicSlug: { not: null },
});

// Applications that PROVE the careers page is working. A MANUAL row a recruiter
// typed in from an emailed CV is not evidence of that, so the count is restricted
// to the two sources the public apply flow writes.
const PUBLIC_SOURCES = Object.freeze(['PUBLIC', 'CAREER_PORTAL']);
const publicApplicationWhere = (businessId) => ({
  businessId, appliedSource: { in: PUBLIC_SOURCES },
});

/**
 * activationFor(ctx) → { activation } | {}
 *
 * @param {object} ctx  the talent probe context (carries the injected prisma client,
 *                      the tenant id and the tenant slug)
 */
async function activationFor(ctx) {
  if (!ctx || !ctx.prisma || !ctx.businessId) return {};
  const { prisma, businessId } = ctx;

  try {
    const appWhere = publicApplicationWhere(businessId);
    const [page, liveJobs, applications, firstApp, latestApp] = await Promise.all([
      prisma.careersPage.findUnique({
        where: { businessId },
        select: { isPublished: true },
      }),
      prisma.job.count({ where: liveJobWhere(businessId) }),
      prisma.application.count({ where: appWhere }),
      prisma.application.findFirst({
        where: appWhere, orderBy: { createdAt: 'asc' }, select: { createdAt: true },
      }),
      prisma.application.findFirst({
        where: appWhere, orderBy: { createdAt: 'desc' }, select: { createdAt: true },
      }),
    ]);

    const published = !!(page && page.isPublished === true);
    const hasJobs = liveJobs > 0;
    let state;
    if (published && hasJobs) state = 'live';
    else if (published || hasJobs) state = 'almost';
    else state = 'not_started';

    return {
      activation: {
        state,
        careersUrl: careersBoardUrl(ctx.slug || (ctx.business && ctx.business.slug) || null),
        published,
        liveJobs,
        applications,
        firstApplicationAt: firstApp ? new Date(firstApp.createdAt).toISOString() : null,
        latestApplicationAt: latestApp ? new Date(latestApp.createdAt).toISOString() : null,
      },
    };
  } catch (err) {
    console.warn(`setup-checklist: hiring activation unreadable for business ${businessId} — ${err.message}`);
    return { activation: null };
  }
}

module.exports = {
  activationFor,
  // exported for tests
  liveJobWhere,
  publicApplicationWhere,
  PUBLIC_SOURCES,
};
