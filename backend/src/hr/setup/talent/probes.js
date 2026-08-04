'use strict';

/**
 * setup/talent/probes.js — "is this hiring step actually done?", against real data.
 *
 * A second PROBE MAP, not a second probe runner. `runProbes` is imported verbatim
 * from ../probes: it is already registry-agnostic and already insulates each probe
 * individually, so both tracks degrade the same way — a probe that throws reports
 * `{ ok:false }`, its step renders "Couldn't check", it counts in the denominator
 * but never the numerator, and the endpoint still answers 200.
 *
 * TENANT SCOPING is absolute: every query below is filtered by ctx.businessId,
 * which comes from the session (req.user.businessId) and never from the client.
 *
 * HONESTY over generosity, same as the core map:
 *   careers_content     a WYSIWYG that was opened and saved leaves '<p></p>' or
 *                       '<p>&nbsp;</p>' behind. Neither is a written page, so the
 *                       rich-text columns go through filledHtml() rather than a
 *                       truthiness test.
 *   careers_brand       every TenantBrand column is nullable, and the where-clause
 *                       is copied EXACTLY from publicCareers.publicBoard()'s own
 *                       brand lookup so this probe can never disagree with what a
 *                       candidate actually sees.
 *   candidate_autosend  STRICTER than the core probe it replaces: it requires the
 *                       `autoSend` key, which only PUT /recruitment/comms-config
 *                       ever writes, so its presence means a human decided.
 *   candidate_templates reads TenantMessageTemplate (the per-tenant BODY override),
 *                       never the global MessageTemplate row, which is shared
 *                       across every tenant and proves nothing about this one.
 *   job_public          the first four clauses ARE publicBoard()'s where-clause, so
 *                       "done" means literally "a candidate loading the board sees
 *                       a job".
 *
 * `prisma` is read off the context so the unit tests can inject a fake client.
 */

const realPrisma = require('../../../core/lib/prisma');
const { runProbes: runWithMap, filled, asObject } = require('../probes');
// The eight candidate-template keys, imported from the ONLY surface that writes
// them, so the list here can never drift from the list the operator edits.
const { F36_TEMPLATE_KEYS } = require('../../talent/recruitment/candidateComms.controller')._internals;

// Jobs a candidate can see on the public board. DRAFT is excluded on purpose — a
// draft requisition is a note to yourself, not a job you are hiring for.
const OPEN_JOB_STATUSES = Object.freeze(['OPEN', 'ON_HOLD']);

// Rich text that a human actually typed. Strips tags and the entities a WYSIWYG
// leaves behind, then asks whether anything is left.
function filledHtml(v) {
  if (typeof v !== 'string') return false;
  return v
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/\s+/g, '')
    .length > 0;
}

// Midnight UTC today — kept for parity with the core context so anything reading a
// track context can treat the two interchangeably.
function utcToday(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * loadContext — the shared facts every hiring probe needs, in ONE read.
 *
 * Deliberately thin next to the core one: there are no conditional (`includeWhen`)
 * rows in this track, so nothing has to be resolved before we decide which probes
 * to run. `slug` is here because the activation card prints a shareable careers URL
 * built from it — the same Business.slug publicCareers.resolveBusiness() looks the
 * tenant up by, so the link we print and the page that answers it agree by
 * construction.
 */
async function loadContext(businessId, { prisma = realPrisma, now = new Date() } = {}) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true, createdAt: true, slug: true,
      hrCountry: true, hrCurrency: true,
      candidateCommsConfig: true,
    },
  });
  if (!business) return null;

  return {
    prisma,
    businessId,
    business,
    today: utcToday(now),
    country: business.hrCountry || null,
    currency: business.hrCurrency || null,
    slug: business.slug || null,
  };
}

// ── The probes ────────────────────────────────────────────────────────────────
const PROBES = Object.create(null);

// ═══ YOUR EMPLOYER BRAND ═══
// businessId is @unique on CareersPage → findUnique, never findFirst.
PROBES.careers_content = async (c) => {
  const row = await c.prisma.careersPage.findUnique({
    where: { businessId: c.businessId },
    select: { headline: true, aboutHtml: true, cultureHtml: true },
  });
  if (!row) return false;
  return filled(row.headline) && (filledHtml(row.aboutHtml) || filledHtml(row.cultureHtml));
};

// The where-clause is publicBoard()'s brand lookup, verbatim.
PROBES.careers_brand = async (c) => {
  const row = await c.prisma.tenantBrand.findFirst({
    where: { businessId: c.businessId, entityId: null, isActive: true, deletedAt: null },
    select: { logoUrl: true, primaryColor: true },
  });
  return !!(row && filled(row.logoUrl) && filled(row.primaryColor));
};

// Both columns are normalised on write by careersPage.lib.js (normalizePerks drops
// label-less entries, normalizeSocialLinks drops anything that is not an http(s)
// URL), so a stored non-empty value is already a value that will render.
PROBES.careers_extras = async (c) => {
  const row = await c.prisma.careersPage.findUnique({
    where: { businessId: c.businessId },
    select: { perksJson: true, socialLinksJson: true },
  });
  if (!row) return false;
  if (Array.isArray(row.perksJson) && row.perksJson.length > 0) return true;
  const social = asObject(row.socialLinksJson);
  return !!social && Object.keys(social).length > 0;
};

// ═══ HOW YOU HIRE ═══
// isDefault is not decoration: createJob applies the DEFAULT template onto a new
// job's stages, so a template that is not the default is never used by anything.
// PipelineTemplate has no isActive column — deletedAt plus the flag is the filter.
PROBES.pipeline_template = async (c) =>
  (await c.prisma.pipelineTemplate.count({
    where: { businessId: c.businessId, deletedAt: null, isDefault: true },
  })) > 0;

// ScreeningFormTemplate has no isActive column — deletedAt is the only marker.
PROBES.screening_form = async (c) =>
  (await c.prisma.screeningFormTemplate.count({
    where: { businessId: c.businessId, deletedAt: null },
  })) > 0;

// ScorecardTemplate carries BOTH isActive and deletedAt, so both are filtered.
PROBES.scorecard_template = async (c) =>
  (await c.prisma.scorecardTemplate.count({
    where: { businessId: c.businessId, deletedAt: null, isActive: true },
  })) > 0;

// ═══ THE CANDIDATE EXPERIENCE ═══
// The KEY's presence is the signal, not its contents: PUT /recruitment/comms-config
// is the only writer of this column and it only ever writes `autoSend` when the
// operator submitted booleans.
PROBES.candidate_autosend = (c) => {
  const cfg = asObject(c.business.candidateCommsConfig);
  return !!cfg && Object.prototype.hasOwnProperty.call(cfg, 'autoSend');
};

PROBES.candidate_templates = async (c) =>
  (await c.prisma.tenantMessageTemplate.count({
    where: { businessId: c.businessId, isActive: true, templateKey: { in: F36_TEMPLATE_KEYS } },
  })) > 0;

// ═══ GO LIVE ═══
// Job has no isActive column — deletedAt plus the JobStatus enum is the filter.
PROBES.first_job = async (c) =>
  (await c.prisma.job.count({
    where: { businessId: c.businessId, deletedAt: null, status: { in: OPEN_JOB_STATUSES } },
  })) > 0;

// publicSlug is added to publicBoard()'s clause because publicCareersLink() returns
// null without one and the board's link would be dead. setJobPublic auto-derives a
// stable slug on first publish, so in practice this only catches legacy rows.
PROBES.job_public = async (c) =>
  (await c.prisma.job.count({
    where: {
      businessId: c.businessId, deletedAt: null,
      isPublic: true, status: 'OPEN', publicSlug: { not: null },
    },
  })) > 0;

// Saving edits never flips isPublished — only POST /careers-page/publish and
// /unpublish do — so this reads as "someone deliberately made it live".
PROBES.careers_live = async (c) => {
  const row = await c.prisma.careersPage.findUnique({
    where: { businessId: c.businessId },
    select: { isPublished: true },
  });
  return row ? row.isPublished === true : false;
};

// The core RUNNER bound to this track's map. The concurrency, the per-probe
// try/catch and the `{ ok, completed, coverage }` envelope are the core
// implementation verbatim — only the lookup table is ours.
const runProbes = (ctx, keys) => runWithMap(ctx, keys, PROBES);

module.exports = {
  PROBES,
  loadContext,
  runProbes,
  // exported for tests
  filledHtml,
  OPEN_JOB_STATUSES,
  F36_TEMPLATE_KEYS,
};
