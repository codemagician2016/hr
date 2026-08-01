'use strict';
// Recruitment / ATS controller. Five concerns, one tenant boundary
// (req.user.businessId), following the org/leave controller conventions
// (allow-listed picks, soft-delete where the model has deletedAt, P2002 -> 409):
//   (a) Job CRUD + publish (DRAFT -> OPEN) / close.
//   (b) Candidate CRUD (soft-deleted; unique per (businessId, email)).
//   (c) Application pipeline — create + stage transitions driven by the job's
//       JobStage rows; status mirrors the moved-to stage kind.
//   (d) Interview scheduling.
//   (e) Offer create / send / accept / decline. CRITICAL: offer create runs the
//       India Code-on-Wages 50% pre-flight by REUSING the payroll engine's wage
//       check (computeStatutoryWages from payroll/compliance/india.js) — never a
//       re-implementation. A breach blocks the offer with WAGES_50_RULE.
const prisma = require('../../../core/lib/prisma');
// Reuse the SAME wage check the payroll engine uses (do NOT re-implement the
// 50% rule). Exported via india.js `_internals.computeStatutoryWages`.
const indiaCompliance = require('../../payroll/compliance/india.js');
const { computeStatutoryWages } = indiaCompliance._internals;
// Feature 4: onboarding journey seeding (invoked inside the acceptOffer tx).
const { seedOnboardingJourney } = require('../../lifecycle/onboarding.service');
// Feature 12 — F1 recruitment read-scope (requisition-scoped reads, SoD).
const {
  jobScopeWhere, scopeAllowsJob, accessibleJobIds, assignedInterviewIds,
} = require('../recruitment/recruitmentScope');
const { resolveAccessibleEmployeeIds, scopeAllows } = require('../../lib/scopeResolver');
// Feature 36 — candidate stage messaging (best-effort, fire-and-forget). A move /
// bulk-move / offer-send fires the mapped candidate event through the gated fan-out.
const candidateNotify = require('../recruitment/candidateNotify');

const DUP_MSG = 'A record with that code already exists';

// Map the application's NEW status → the candidate stage event to fan out.
// SCREENING/INTERVIEWING → shortlisted; REJECTED → rejected (gated OFF by default).
// Everything else (APPLIED/ASSESSMENT/OFFERED/HIRED/WITHDRAWN/ON_HOLD) is silent
// here — offer messaging fires from sendOffer, and the rest have no candidate copy.
const STATUS_TO_CANDIDATE_EVENT = Object.freeze({
  SCREENING: 'candidate.shortlisted',
  INTERVIEWING: 'candidate.shortlisted',
  REJECTED: 'candidate.rejected',
});

function picker(fields, dates = []) {
  return (body) => {
    const out = {};
    for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
    for (const d of dates) if (out[d] != null) out[d] = new Date(out[d]);
    return out;
  };
}

// Decimal money (rupees) -> integer minor units (paise) for the pure engine.
// Accepts number or numeric string; null/undefined -> null.
function toMinor(rupees) {
  if (rupees == null || rupees === '') return null;
  const n = Number(rupees);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) JOB  — CRUD + publish/close
// ─────────────────────────────────────────────────────────────────────────────
const JOB_FIELDS = [
  'entityId', 'code', 'title', 'departmentId', 'designationId', 'locationId',
  'countryCode', 'employmentType', 'openings', 'description',
  'minSalary', 'maxSalary', 'currencyCode', 'hiringManagerId', 'status',
  // Feature 12 — public posting + merit-blend + scoring config.
  'publicSlug', 'isPublic', 'applicationWeightPct', 'interviewWeightPct',
  'scorecardTemplateId', 'hideCandidatePiiUntilStage',
  // Feature 36 — per-requisition candidate-comms overrides (auto-send + template keys).
  'commsConfig',
];
const JOB_REQUIRED = ['code', 'title', 'countryCode', 'employmentType'];
const pickJob = picker(JOB_FIELDS);

// Feature 12 — the application/interview merit weights must sum to 100 (§4.1).
// Returns an error message if a supplied pair is invalid, else null.
function validateMeritWeights(body) {
  const hasA = body.applicationWeightPct !== undefined && body.applicationWeightPct !== null;
  const hasB = body.interviewWeightPct !== undefined && body.interviewWeightPct !== null;
  if (!hasA && !hasB) return null; // unchanged → keep DB defaults (40/60)
  const a = Number(hasA ? body.applicationWeightPct : 40);
  const b = Number(hasB ? body.interviewWeightPct : 60);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) {
    return 'applicationWeightPct and interviewWeightPct must be non-negative numbers';
  }
  if (Math.round((a + b) * 100) / 100 !== 100) {
    return `applicationWeightPct (${a}) + interviewWeightPct (${b}) must total 100`;
  }
  return null;
}

// Slugify a public careers token (lowercase, hyphenated, ascii).
function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || null;
}

// ── Shareable public-link resolution ─────────────────────────────────────────
// A published, public job is shared as a candidate-facing LINK to give to job
// portals. The link points at the tenant's careers host (reuses the SAME
// hostForSlug helper subdomain provisioning uses, so it tracks staging/prod),
// e.g. https://acme-staging.drifthr.com/careers/acme/jobs/<publicSlug>. The API
// apply route (POST /api/public/careers/:businessSlug/jobs/:publicSlug/apply) is
// the same endpoint the public page submits to — no internal scores ever leak.
//
// Best-effort: if the host helper is unavailable we still return the relative
// path so the UI can render a copyable link from window.location.origin.
let _hostForSlug;
try { ({ hostForSlug: _hostForSlug } = require('../../../core/lib/subdomainProvision')); } catch { _hostForSlug = null; }

// Build the public link bundle for a job. `businessSlug` is the tenant's careers
// slug (Business.slug). Returns null when the job has no public slug yet.
function publicCareersLink(businessSlug, job) {
  if (!job || !job.publicSlug || !businessSlug) return null;
  // The shareable link points at the tenant careers HOST ({slug}-staging.drifthr.com
  // / {slug}.drifthr.com), which is served by the ESS app. ESS resolves the tenant
  // from the host, so its careers routes carry NO business-slug segment:
  //   board  /careers            (GET /api/careers/:slug/jobs)
  //   detail /careers/jobs/:pubS  (GET /api/careers/:slug/jobs/:publicSlug)
  //   apply  POST /api/careers/:slug/jobs/:publicSlug/apply
  // Emitting the old admin-host shape (/careers/:businessSlug/jobs/:pubS) 404'd on
  // the ESS host (no matching route), so every shared job link was dead.
  const careersPath = `/careers`;
  const jobPath = `${careersPath}/jobs/${job.publicSlug}`;
  // API apply path the public page (and any portal that wires a direct POST) hits.
  const apiApplyPath = `/api/careers/${businessSlug}/jobs/${job.publicSlug}/apply`;
  let host = null;
  try { host = _hostForSlug ? _hostForSlug(businessSlug) : null; } catch { host = null; }
  const origin = host ? `https://${host}` : null;
  return {
    businessSlug,
    publicSlug: job.publicSlug,
    careersPath,            // tenant careers board (relative)
    jobPath,                // candidate-facing JD + apply page (relative)
    apiApplyPath,           // the unauth apply endpoint (relative)
    careersUrl: origin ? `${origin}${careersPath}` : null,
    url: origin ? `${origin}${jobPath}` : null, // the shareable absolute link
    // only LIVE (OPEN + isPublic) jobs actually resolve on the public board.
    live: !!(job.isPublic && job.status === 'OPEN'),
  };
}

// Resolve the tenant careers slug for the caller's business (Business.slug).
async function businessSlug(businessId) {
  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { slug: true } });
  return biz ? biz.slug : null;
}

async function listJobs(req, res, next) {
  try {
    const { businessId } = req.user;
    // F1 scope — a scoped recruiter sees only their own requisitions.
    const where = { businessId, deletedAt: null, ...jobScopeWhere(req.recruitmentScope) };
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.job.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({ items });
  } catch (e) { next(e); }
}

async function getJob(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.job.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: { stages: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!item) return res.status(404).json({ message: 'Not found' });
    // F1 scope — an out-of-requisition job 404s (IDOR-safe), not 403.
    if (!scopeAllowsJob(req.recruitmentScope, item)) return res.status(404).json({ message: 'Not found' });
    // Surface the shareable public-careers link so the job page can render a
    // copyable URL + Publish/Unpublish without guessing the tenant host.
    const slug = await businessSlug(businessId);
    res.json({ ...item, publicLink: publicCareersLink(slug, item) });
  } catch (e) { next(e); }
}

// GET /jobs/:id/share — the shareable public-link bundle on its own (used by the
// "Share / public link" panel). Returns the careers URL + slug + apply path and
// whether the link is LIVE (the job must be isPublic + OPEN to actually resolve).
async function shareJob(req, res, next) {
  try {
    const { businessId } = req.user;
    const job = await prisma.job.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      select: { id: true, title: true, status: true, isPublic: true, publicSlug: true, hiringManagerId: true },
    });
    if (!job) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllowsJob(req.recruitmentScope, job)) return res.status(404).json({ message: 'Not found' });
    const slug = await businessSlug(businessId);
    res.json({
      jobId: job.id, title: job.title, status: job.status, isPublic: job.isPublic,
      publicSlug: job.publicSlug,
      publicLink: publicCareersLink(slug, job),
    });
  } catch (e) { next(e); }
}

// POST /jobs/:id/set-public — the prominent Publish/Unpublish toggle for the
// careers board. body: { isPublic: bool }. Publishing auto-derives a stable
// publicSlug when one is missing (never regenerated on re-publish, so a shared
// link stays valid). Returns the fresh job + its public-link bundle. The job
// must be OPEN for the link to actually resolve on the public board, but we
// allow flagging a DRAFT public so HR can prepare the slug ahead of publishing.
async function setJobPublic(req, res, next) {
  try {
    const { businessId } = req.user;
    const job = await prisma.job.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!job) return res.status(404).json({ message: 'Not found' });
    // F1 scope — an out-of-requisition job 404s (IDOR-safe), not 403.
    if (!scopeAllowsJob(req.recruitmentScope, job)) return res.status(404).json({ message: 'Not found' });
    const isPublic = req.body.isPublic === undefined ? true : !!req.body.isPublic;
    const data = { isPublic };
    if (isPublic && !job.publicSlug) data.publicSlug = slugify(`${job.title}-${job.code}`);
    let updated;
    try {
      updated = await prisma.job.update({ where: { id: job.id }, data });
    } catch (e) {
      if (e.code === 'P2002') {
        // slug collided with another job — disambiguate with a short suffix.
        data.publicSlug = slugify(`${job.title}-${job.code}-${job.id.slice(0, 6)}`);
        updated = await prisma.job.update({ where: { id: job.id }, data });
      } else { throw e; }
    }
    const slug = await businessSlug(businessId);
    res.json({ ...updated, publicLink: publicCareersLink(slug, updated) });
  } catch (e) { next(e); }
}

async function createJob(req, res, next) {
  try {
    const { businessId } = req.user;
    for (const r of JOB_REQUIRED) {
      if (req.body[r] === undefined || req.body[r] === null || req.body[r] === '') {
        return res.status(400).json({ message: `${r} is required` });
      }
    }
    const weightErr = validateMeritWeights(req.body);
    if (weightErr) return res.status(400).json({ message: weightErr });
    const data = { ...pickJob(req.body), businessId };
    // auto-derive a public careers slug when made public without one
    if (data.isPublic && !data.publicSlug) data.publicSlug = slugify(`${data.title}-${data.code}`);
    const item = await prisma.job.create({ data });
    // Phase 4 (behaviour-additive) — if the tenant has a default pipeline template
    // and the caller didn't pass explicit stages, materialise the default onto the
    // fresh job. Best-effort: a failure here never blocks job creation.
    if (!Array.isArray(req.body.stages)) {
      try {
        const pt = require('./pipelineTemplates.controller');
        await pt.autoApplyDefaultTemplate(prisma, businessId, item.id);
      } catch { /* default-template seeding is best-effort */ }
    }
    res.status(201).json(item);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: DUP_MSG }); next(e); }
}

async function updateJob(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.job.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    // F1 scope — an out-of-requisition job 404s (IDOR-safe), not 403.
    if (!scopeAllowsJob(req.recruitmentScope, existing)) return res.status(404).json({ message: 'Not found' });
    const weightErr = validateMeritWeights(req.body);
    if (weightErr) return res.status(400).json({ message: weightErr });
    const data = pickJob(req.body);
    // Priv-esc guard: only an ALL-band caller (admin/HR) may reassign the hiring
    // manager. A scoped recruiter cannot set hiringManagerId to widen their own
    // read scope (they'd otherwise self-assign the req and gain its PII/candidates).
    const reassigning = data.hiringManagerId !== undefined
      && String(data.hiringManagerId ?? '') !== String(existing.hiringManagerId ?? '');
    const isAllBand = !req.recruitmentScope || req.recruitmentScope.kind === 'ALL';
    if (reassigning && !isAllBand) {
      return res.status(403).json({
        message: 'Only an admin/HR may reassign a requisition\'s hiring manager.',
        code: 'HIRING_MANAGER_REASSIGN_FORBIDDEN',
      });
    }
    if (data.isPublic && !data.publicSlug && !existing.publicSlug) data.publicSlug = slugify(`${existing.title}-${existing.code}`);
    const item = await prisma.job.update({ where: { id: req.params.id }, data });
    res.json(item);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: DUP_MSG }); next(e); }
}

async function removeJob(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.job.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    // F1 scope — an out-of-requisition job 404s (IDOR-safe), not 403.
    if (!scopeAllowsJob(req.recruitmentScope, existing)) return res.status(404).json({ message: 'Not found' });
    await prisma.job.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// POST /jobs/:id/publish — DRAFT -> OPEN, stamping publishedAt. Only a draft can
// be published; re-publishing an open/closed job is a 409.
async function publishJob(req, res, next) {
  try {
    const { businessId } = req.user;
    const job = await prisma.job.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!job) return res.status(404).json({ message: 'Not found' });
    // F1 scope — an out-of-requisition job 404s (IDOR-safe), not 403.
    if (!scopeAllowsJob(req.recruitmentScope, job)) return res.status(404).json({ message: 'Not found' });
    if (job.status !== 'DRAFT') {
      return res.status(409).json({ message: `Cannot publish a job in status ${job.status}` });
    }
    const item = await prisma.job.update({
      where: { id: job.id },
      data: { status: 'OPEN', publishedAt: new Date() },
    });
    res.json(item);
  } catch (e) { next(e); }
}

// POST /jobs/:id/close — OPEN/ON_HOLD -> CLOSED, stamping closedAt + an optional
// reason (FILLED | CANCELLED | ON_HOLD_INDEFINITELY | OTHER, free-text note). The
// reason is persisted on Job.closeReason and audited so the funnel summary can
// explain the outcome. F1 scope: a recruiter can only close a job they own.
async function closeJob(req, res, next) {
  try {
    const { businessId } = req.user;
    const job = await prisma.job.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!job) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllowsJob(req.recruitmentScope, job)) return res.status(404).json({ message: 'Not found' });
    if (!['OPEN', 'ON_HOLD'].includes(job.status)) {
      return res.status(409).json({ message: `Cannot close a job in status ${job.status}` });
    }
    // A filled requisition flips to FILLED; otherwise CLOSED. Caller can force
    // FILLED via outcome='FILLED' (e.g. all openings met).
    const outcome = String(req.body.outcome || '').toUpperCase();
    const status = outcome === 'FILLED' ? 'FILLED' : 'CLOSED';
    const reason = req.body.reason != null ? String(req.body.reason).slice(0, 2000) : null;
    const item = await prisma.job.update({
      where: { id: job.id },
      data: { status, closedAt: new Date(), closeReason: reason },
    });
    try {
      await prisma.auditLog.create({ data: {
        businessId, action: 'recruitment.job.close', entityType: 'Job', entityId: job.id,
        actorId: req.user.id || null, meta: { status, reason: reason || null },
      } });
    } catch { /* audit is best-effort */ }
    res.json(item);
  } catch (e) { next(e); }
}

// ── Per-job funnel SUMMARY (applied → … → accepted) + time-to-fill ───────────
// The hire funnel maps every live application onto an ordered set of milestone
// buckets derived from ApplicationStatus, plus rejected/withdrawn/on-hold tallies.
// time-to-fill = days from the job opening (publishedAt ?? createdAt) to the
// first accepted offer (or to now if still open). Reuses the F1 read-scope.
const FUNNEL_STEPS = [
  { key: 'applied', label: 'Applied', statuses: ['APPLIED', 'SCREENING', 'ASSESSMENT', 'INTERVIEWING', 'OFFERED', 'HIRED'] },
  { key: 'screened', label: 'Screened', statuses: ['SCREENING', 'ASSESSMENT', 'INTERVIEWING', 'OFFERED', 'HIRED'] },
  { key: 'shortlisted', label: 'Shortlisted', statuses: ['ASSESSMENT', 'INTERVIEWING', 'OFFERED', 'HIRED'] },
  { key: 'interview', label: 'Interview', statuses: ['INTERVIEWING', 'OFFERED', 'HIRED'] },
  { key: 'offer', label: 'Offer', statuses: ['OFFERED', 'HIRED'] },
  { key: 'accepted', label: 'Accepted', statuses: ['HIRED'] },
];

async function jobSummary(req, res, next) {
  try {
    const { businessId } = req.user;
    const job = await prisma.job.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      select: {
        id: true, title: true, code: true, status: true, openings: true,
        publishedAt: true, createdAt: true, closedAt: true, closeReason: true,
        isPublic: true, publicSlug: true, hiringManagerId: true,
      },
    });
    if (!job) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllowsJob(req.recruitmentScope, job)) return res.status(404).json({ message: 'Not found' });

    // group all of this job's applications by status (one query).
    const grouped = await prisma.application.groupBy({
      by: ['status'],
      where: { businessId, jobId: job.id },
      _count: { _all: true },
    });
    const countByStatus = {};
    let total = 0;
    for (const g of grouped) { countByStatus[g.status] = g._count._all; total += g._count._all; }

    const at = (s) => countByStatus[s] || 0;
    // cumulative funnel — a candidate at a later step counted every earlier step.
    const funnel = FUNNEL_STEPS.map((step) => ({
      key: step.key, label: step.label,
      count: step.statuses.reduce((n, s) => n + at(s), 0),
    }));

    // count offers SENT (not just OFFERED status) for the "offer sent" line.
    const offerSent = await prisma.offer.count({ where: { businessId, application: { is: { jobId: job.id } }, status: { in: ['SENT', 'ACCEPTED', 'DECLINED'] } } });

    const outcomes = {
      rejected: at('REJECTED'),
      withdrawn: at('WITHDRAWN'),
      onHold: at('ON_HOLD'),
      knockedOut: await prisma.application.count({ where: { businessId, jobId: job.id, knockedOut: true } }),
      hired: at('HIRED'),
    };
    // "waiting" = active applicants not yet rejected/withdrawn/hired.
    const waiting = total - outcomes.rejected - outcomes.withdrawn - outcomes.hired;

    // time-to-fill — opening anchor → first accepted offer (or open-for N days).
    const openedAt = job.publishedAt || job.createdAt;
    let firstHireAt = null;
    if (outcomes.hired > 0) {
      const firstAccepted = await prisma.offer.findFirst({
        where: { businessId, application: { is: { jobId: job.id } }, status: 'ACCEPTED', respondedAt: { not: null } },
        orderBy: { respondedAt: 'asc' }, select: { respondedAt: true },
      });
      firstHireAt = firstAccepted ? firstAccepted.respondedAt : job.closedAt;
    }
    const DAY = 24 * 60 * 60 * 1000;
    const endAt = firstHireAt || (job.status === 'CLOSED' || job.status === 'FILLED' ? job.closedAt : new Date());
    const timeToFillDays = openedAt && endAt ? Math.max(0, Math.round((new Date(endAt) - new Date(openedAt)) / DAY)) : null;

    const slug = await businessSlug(businessId);
    res.json({
      job: {
        id: job.id, title: job.title, code: job.code, status: job.status, openings: job.openings,
        openedAt, closedAt: job.closedAt, closeReason: job.closeReason,
        isPublic: job.isPublic, publicLink: publicCareersLink(slug, job),
      },
      totals: { total, ...outcomes, offerSent, waiting },
      funnel,
      timeToFill: {
        days: timeToFillDays,
        filled: firstHireAt != null,
        openSince: openedAt,
        asOf: endAt,
      },
    });
  } catch (e) { next(e); }
}

// ── JobStage config (the pipeline an application moves through) ───────────────
const STAGE_FIELDS = ['name', 'kind', 'sortOrder'];

async function listStages(req, res, next) {
  try {
    const { businessId } = req.user;
    const job = await prisma.job.findFirst({ where: { id: req.params.jobId, businessId, deletedAt: null }, select: { id: true, hiringManagerId: true } });
    if (!job || !scopeAllowsJob(req.recruitmentScope, job)) return res.status(404).json({ message: 'Job not found' });
    const items = await prisma.jobStage.findMany({
      where: { businessId, jobId: req.params.jobId },
      orderBy: { sortOrder: 'asc' },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

async function createStage(req, res, next) {
  try {
    const { businessId } = req.user;
    const job = await prisma.job.findFirst({ where: { id: req.params.jobId, businessId, deletedAt: null }, select: { id: true } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    for (const r of ['name', 'kind', 'sortOrder']) {
      if (req.body[r] === undefined || req.body[r] === null || req.body[r] === '') {
        return res.status(400).json({ message: `${r} is required` });
      }
    }
    const data = { businessId, jobId: req.params.jobId };
    for (const f of STAGE_FIELDS) if (req.body[f] !== undefined) data[f] = req.body[f];
    const item = await prisma.jobStage.create({ data });
    res.status(201).json(item);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: 'A stage with that sortOrder already exists for this job' }); next(e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) CANDIDATE — CRUD (soft-deleted; unique per (businessId, email))
// ─────────────────────────────────────────────────────────────────────────────
const CANDIDATE_FIELDS = [
  'firstName', 'lastName', 'email', 'phone', 'resumeUrl', 'source',
  'linkedinUrl', 'consentAt', 'consentExpiresAt',
];
const CANDIDATE_DATES = ['consentAt', 'consentExpiresAt'];
const pickCandidate = picker(CANDIDATE_FIELDS, CANDIDATE_DATES);

async function listCandidates(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId, deletedAt: null };
    if (req.query.email) where.email = req.query.email;
    // F1 scope — a scoped recruiter sees only candidates who applied to one of
    // their requisitions (a candidate with no in-scope application is invisible).
    const reach = await accessibleJobIds(businessId, req.recruitmentScope);
    if (!reach.all) where.applications = { some: { jobId: { in: reach.ids } } };
    const items = await prisma.candidate.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({ items });
  } catch (e) { next(e); }
}

async function getCandidate(req, res, next) {
  try {
    const { businessId } = req.user;
    const reach = await accessibleJobIds(businessId, req.recruitmentScope);
    const where = { id: req.params.id, businessId, deletedAt: null };
    // F1 scope — 404 a candidate with no application to an in-scope job.
    if (!reach.all) where.applications = { some: { jobId: { in: reach.ids } } };
    // Feature 38 — include the candidate's rich portal profile so HR can decide on
    // the resume (education / experience / skills), not just contact details.
    const profileInclude = {
      educations: { orderBy: { endYear: 'desc' } },
      experiences: { orderBy: { startDate: 'desc' } },
      skills: { orderBy: { name: 'asc' } },
    };
    const item = await prisma.candidate.findFirst({
      where,
      include: reach.all
        ? { applications: true, ...profileInclude }
        : { applications: { where: { jobId: { in: reach.ids } } }, ...profileInclude },
    });
    if (!item) return res.status(404).json({ message: 'Not found' });
    res.json(item);
  } catch (e) { next(e); }
}

async function createCandidate(req, res, next) {
  try {
    const { businessId } = req.user;
    for (const r of ['firstName', 'lastName', 'email']) {
      if (req.body[r] === undefined || req.body[r] === null || req.body[r] === '') {
        return res.status(400).json({ message: `${r} is required` });
      }
    }
    const item = await prisma.candidate.create({ data: { ...pickCandidate(req.body), businessId } });
    res.status(201).json(item);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: 'A candidate with that email already exists' }); next(e); }
}

async function updateCandidate(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.candidate.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    const item = await prisma.candidate.update({ where: { id: req.params.id }, data: pickCandidate(req.body) });
    res.json(item);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: 'A candidate with that email already exists' }); next(e); }
}

async function removeCandidate(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.candidate.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    await prisma.candidate.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// (c) APPLICATION — create + stage-transition pipeline
// Status mirrors the moved-to JobStage.kind so the application status and the
// pipeline stage never drift apart.
// ─────────────────────────────────────────────────────────────────────────────

// Map a JobStage.kind to the ApplicationStatus the application takes on arrival.
const STAGE_KIND_TO_STATUS = {
  SOURCED: 'APPLIED',
  SCREENING: 'SCREENING',
  INTERVIEW: 'INTERVIEWING',
  ASSESSMENT: 'ASSESSMENT',
  OFFER: 'OFFERED',
  HIRED: 'HIRED',
  REJECTED: 'REJECTED',
  WITHDRAWN: 'WITHDRAWN',
};

// Build the Prisma `where` for the candidate-list filters. Pure + reused by both
// the list endpoint and the bulk-action endpoint so "select-all-within-filter"
// acts on EXACTLY the same server-side subset the UI is showing (no client trust).
//   stage     — currentStageId
//   status    — ApplicationStatus
//   source    — appliedSource (PUBLIC/REFERRAL/AGENCY/MANUAL/IMPORT)
//   knockout  — 'true' | 'false' (knockedOut flag)
//   minScore/maxScore — meritScore range (inclusive)
//   from/to   — createdAt date range (ISO)
//   skill     — candidate name/email contains (free-text quick search)
function applicationFilterWhere(q) {
  const where = {};
  if (q.jobId) where.jobId = q.jobId;
  if (q.candidateId) where.candidateId = q.candidateId;
  if (q.status) where.status = q.status;
  if (q.stageId) where.currentStageId = q.stageId;
  if (q.source) where.appliedSource = q.source;
  if (q.knockout === 'true') where.knockedOut = true;
  else if (q.knockout === 'false') where.knockedOut = false;
  const min = q.minScore !== undefined && q.minScore !== '' ? Number(q.minScore) : null;
  const max = q.maxScore !== undefined && q.maxScore !== '' ? Number(q.maxScore) : null;
  if (Number.isFinite(min) || Number.isFinite(max)) {
    where.meritScore = {};
    if (Number.isFinite(min)) where.meritScore.gte = min;
    if (Number.isFinite(max)) where.meritScore.lte = max;
  }
  const from = q.from ? new Date(q.from) : null;
  const to = q.to ? new Date(q.to) : null;
  if ((from && !Number.isNaN(+from)) || (to && !Number.isNaN(+to))) {
    where.createdAt = {};
    if (from && !Number.isNaN(+from)) where.createdAt.gte = from;
    if (to && !Number.isNaN(+to)) where.createdAt.lte = to;
  }
  // free-text "skill"/search across candidate name + email (case-insensitive).
  const term = (q.skill || q.q || '').trim();
  if (term) {
    where.candidate = { is: { OR: [
      { firstName: { contains: term, mode: 'insensitive' } },
      { lastName: { contains: term, mode: 'insensitive' } },
      { email: { contains: term, mode: 'insensitive' } },
    ] } };
  }
  return where;
}

// Apply the F1 read-scope onto a filter `where`, intersecting any caller-supplied
// jobId with the accessible set. Mutates + returns `where` (or a match-nothing
// where when the caller is fully out of scope). Centralised so list + bulk share it.
function scopeApplicationWhere(where, reach, callerJobId) {
  if (reach.all) return where;
  if (callerJobId) {
    where.jobId = reach.ids.includes(callerJobId) ? callerJobId : { in: [] };
  } else {
    where.jobId = { in: reach.ids };
  }
  return where;
}

async function listApplications(req, res, next) {
  try {
    const { businessId } = req.user;
    const q = req.query || {};
    const where = { businessId, ...applicationFilterWhere(q) };
    // F1 scope — applications under in-scope requisitions only.
    const reach = await accessibleJobIds(businessId, req.recruitmentScope);
    scopeApplicationWhere(where, reach, q.jobId);

    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize, 10) || 100));
    // sort: meritScore desc | createdAt desc (default). The merit sort puts the
    // strongest candidates first (knockouts/unscored fall to the bottom).
    const orderBy = q.sort === 'merit'
      ? [{ meritScore: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }]
      : { createdAt: 'desc' };

    const [total, items] = await Promise.all([
      prisma.application.count({ where }),
      prisma.application.findMany({
        where, orderBy, skip: (page - 1) * pageSize, take: pageSize,
        // hydrate the candidate so the pipeline/list renders names without N+1.
        include: { candidate: { select: { id: true, firstName: true, lastName: true, email: true, source: true } } },
      }),
    ]);
    res.json({
      items,
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (e) { next(e); }
}

// ── Bulk actions over the CURRENT FILTER (or an explicit id allow-list) ───────
// POST /applications/bulk-action
//   body: { action: 'reject'|'shortlist'|'set-status', status?, stageId?, reason?,
//           filter?: {jobId,status,stageId,source,knockout,minScore,maxScore,from,to,skill},
//           ids?: string[] }  — when `ids` is given they are INTERSECTED with the
//           scoped filter set (never a blind id list), so a client can never act
//           on an out-of-scope / cross-tenant candidate. Returns the changed count.
//
// SoD-safe: bulk acts on PIPELINE STAGE/STATUS only (reject/shortlist/status) —
// it never sends/accepts offers, so the offer-approval SoD is untouched. Each
// change is scoped to the caller's businessId + F1 reach and audited.
const BULK_TERMINAL = new Set(['HIRED', 'REJECTED', 'WITHDRAWN']);

async function bulkApplicationAction(req, res, next) {
  try {
    const { businessId } = req.user;
    const body = req.body || {};
    const action = String(body.action || '').toLowerCase();
    if (!['reject', 'shortlist', 'set-status'].includes(action)) {
      return res.status(400).json({ message: "action must be one of 'reject', 'shortlist', 'set-status'" });
    }

    // resolve the scoped, filtered target set on the SERVER (never trust the client).
    const filter = body.filter || {};
    const reach = await accessibleJobIds(businessId, req.recruitmentScope);
    const where = { businessId, ...applicationFilterWhere(filter) };
    scopeApplicationWhere(where, reach, filter.jobId);
    // when an explicit id allow-list is supplied, intersect it with the scoped set.
    if (Array.isArray(body.ids) && body.ids.length) {
      where.id = { in: body.ids.map(String) };
    }

    // load the candidate rows in-scope; we only ever touch THESE ids.
    const targets = await prisma.application.findMany({ where, select: { id: true, status: true, jobId: true, candidateId: true } });
    if (!targets.length) return res.json({ changed: 0, skipped: 0, total: 0, ids: [] });

    // a bulk reject/shortlist/status move is a pipeline move; terminal apps are
    // ALWAYS skipped (a HIRED/REJECTED/WITHDRAWN candidate is never silently
    // resurrected — matching the single-app moveApplication terminal guard). This
    // applies to set-status too: bulk cannot reopen a hired/rejected/withdrawn app.
    const actionable = targets.filter((a) => !BULK_TERMINAL.has(a.status));
    const skipped = targets.length - actionable.length;
    if (!actionable.length) return res.json({ changed: 0, skipped, total: targets.length, ids: [] });

    // group target jobIds so we can resolve the right destination stage per job
    // (each job has its own JobStage rows; the kind is shared).
    const jobIds = [...new Set(actionable.map((a) => a.jobId))];
    const stages = await prisma.jobStage.findMany({ where: { businessId, jobId: { in: jobIds } } });
    const stageByJobKind = new Map();
    for (const st of stages) stageByJobKind.set(`${st.jobId}:${st.kind}`, st);

    // resolve the target (status, stageKind) for the action.
    let targetStatus = null; let targetKind = null;
    if (action === 'reject') { targetStatus = 'REJECTED'; targetKind = 'REJECTED'; }
    else if (action === 'shortlist') { targetStatus = 'INTERVIEWING'; targetKind = 'INTERVIEW'; }
    else if (action === 'set-status') {
      targetStatus = String(body.status || '').toUpperCase();
      // HIRED/ACCEPTED are NOT bulk-settable: a hire must go through the offer
      // accept SoD path (acceptOffer), which enforces maker ≠ checker and seeds the
      // onboarding journey atomically. Bulk only moves apps across non-terminal
      // pipeline stages. REJECTED/WITHDRAWN remain reachable (legitimate bulk
      // reject/withdraw of an OPEN candidate), but a TERMINAL source app is skipped
      // above so a terminal app can never be flipped to another status either.
      const VALID = ['APPLIED', 'SCREENING', 'INTERVIEWING', 'ASSESSMENT', 'OFFERED', 'REJECTED', 'WITHDRAWN', 'ON_HOLD'];
      if (!VALID.includes(targetStatus)) {
        return res.status(400).json({ message: `status must be one of ${VALID.join(', ')}` });
      }
      // map status → stage kind so the pipeline card follows the status.
      const S2K = { APPLIED: 'SOURCED', SCREENING: 'SCREENING', INTERVIEWING: 'INTERVIEW', ASSESSMENT: 'ASSESSMENT', OFFERED: 'OFFER', REJECTED: 'REJECTED', WITHDRAWN: 'WITHDRAWN' };
      targetKind = S2K[targetStatus] || null;
    }
    const reason = body.reason != null ? String(body.reason).slice(0, 500) : null;

    // apply each move (per-app so we can land it on that job's stage of the kind).
    const changedIds = [];
    await prisma.$transaction(async (tx) => {
      for (const a of actionable) {
        const data = { status: targetStatus };
        if (targetKind) {
          const st = stageByJobKind.get(`${a.jobId}:${targetKind}`);
          if (st) data.currentStageId = st.id;
        }
        if (targetStatus === 'REJECTED') data.rejectReason = reason || 'Bulk reject';
        await tx.application.update({ where: { id: a.id }, data });
        changedIds.push(a.id);
      }
    });

    try {
      await prisma.auditLog.create({ data: {
        businessId, action: `recruitment.application.bulk.${action}`, entityType: 'Application',
        entityId: null, actorId: req.user.id || null,
        meta: { action, targetStatus, changed: changedIds.length, skipped, jobIds, filter },
      } });
    } catch { /* audit is best-effort */ }

    // Feature 36 — fan out the mapped candidate stage message per changed id
    // (best-effort, fire-and-forget). A bulk reject → candidate.rejected, which is
    // auto-send OFF by default, so it sends NOTHING unless the tenant opted in
    // (§7.1). Each send is deduped on CAND_<stage>:<appId>:<status>.
    const bulkCandEvent = STATUS_TO_CANDIDATE_EVENT[targetStatus];
    if (bulkCandEvent) {
      for (const a of actionable) {
        candidateNotify.fanOutCandidateStage({
          businessId,
          application: { id: a.id, status: targetStatus, candidateId: a.candidateId, jobId: a.jobId },
          event: bulkCandEvent,
        }).catch(() => { /* never breaks the bulk action */ });
      }
    }

    res.json({ changed: changedIds.length, skipped, total: targets.length, ids: changedIds });
  } catch (e) { next(e); }
}

async function getApplication(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.application.findFirst({
      where: { id: req.params.id, businessId },
      include: {
        interviews: { include: { scorecards: { select: { id: true, status: true } } } },
        offers: true,
        candidate: {
          select: {
            id: true, firstName: true, lastName: true, email: true, phone: true, resumeUrl: true, source: true, linkedinUrl: true,
            // Feature 38 — the rich candidate profile so HR can decide on the resume.
            headline: true, location: true, totalExperienceMonths: true,
            educations: { orderBy: { endYear: 'desc' } },
            experiences: { orderBy: { startDate: 'desc' } },
            skills: { orderBy: { name: 'asc' } },
          },
        },
        job: { select: { hiringManagerId: true, title: true, countryCode: true } },
      },
    });
    if (!item) return res.status(404).json({ message: 'Not found' });
    // F1 scope — 404 an application on an out-of-requisition job.
    if (!scopeAllowsJob(req.recruitmentScope, item.job)) return res.status(404).json({ message: 'Not found' });
    // keep the job title/country for the UI but drop the internal scope field.
    item.jobTitle = item.job ? item.job.title : null;
    item.jobCountryCode = item.job ? item.job.countryCode : null;
    delete item.job;
    res.json(item);
  } catch (e) { next(e); }
}

// POST /applications — a candidate applies to a job. Unique per (job, candidate).
// The application starts at the job's lowest-sortOrder stage if one exists.
async function createApplication(req, res, next) {
  try {
    const { businessId } = req.user;
    const { jobId, candidateId } = req.body;
    if (!jobId || !candidateId) {
      return res.status(400).json({ message: 'jobId and candidateId are required' });
    }
    const job = await prisma.job.findFirst({ where: { id: jobId, businessId, deletedAt: null }, select: { id: true } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    const candidate = await prisma.candidate.findFirst({ where: { id: candidateId, businessId, deletedAt: null }, select: { id: true } });
    if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

    const firstStage = await prisma.jobStage.findFirst({
      where: { businessId, jobId },
      orderBy: { sortOrder: 'asc' },
    });

    const data = {
      businessId,
      jobId,
      candidateId,
      currentStageId: firstStage ? firstStage.id : null,
      status: firstStage ? (STAGE_KIND_TO_STATUS[firstStage.kind] || 'APPLIED') : 'APPLIED',
    };
    if (req.body.rating !== undefined) data.rating = req.body.rating;
    const item = await prisma.application.create({ data });
    res.status(201).json(item);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: 'This candidate has already applied to this job' }); next(e); }
}

// POST /applications/:id/move — advance/return the application to a JobStage.
// The target stage must belong to the same job; the application status is
// derived from the stage kind. A REJECTED/WITHDRAWN move records rejectReason.
async function moveApplication(req, res, next) {
  try {
    const { businessId } = req.user;
    const { stageId } = req.body;
    if (!stageId) return res.status(400).json({ message: 'stageId is required' });

    const app = await prisma.application.findFirst({ where: { id: req.params.id, businessId } });
    if (!app) return res.status(404).json({ message: 'Application not found' });
    if (['HIRED', 'REJECTED', 'WITHDRAWN'].includes(app.status)) {
      return res.status(409).json({ message: `Application is in terminal status ${app.status}` });
    }

    const stage = await prisma.jobStage.findFirst({ where: { id: stageId, businessId, jobId: app.jobId } });
    if (!stage) return res.status(404).json({ message: 'Stage not found for this job' });

    const data = {
      currentStageId: stage.id,
      status: STAGE_KIND_TO_STATUS[stage.kind] || app.status,
    };
    if (stage.kind === 'REJECTED' && req.body.rejectReason) data.rejectReason = req.body.rejectReason;
    const item = await prisma.application.update({ where: { id: app.id }, data });
    // Feature 36 — fan out the mapped candidate stage message (best-effort,
    // fire-and-forget; auto-send config governs whether it actually leaves — reject
    // defaults OFF). The dedupe token makes a re-fired identical transition a no-op.
    const candEvent = STATUS_TO_CANDIDATE_EVENT[item.status];
    if (candEvent) {
      candidateNotify.fanOutCandidateStage({
        businessId,
        application: { id: item.id, status: item.status, candidateId: item.candidateId, jobId: item.jobId },
        event: candEvent,
      }).catch(() => { /* never breaks the move */ });
    }
    res.json(item);
  } catch (e) { next(e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// (d) INTERVIEW — schedule + record feedback
// ─────────────────────────────────────────────────────────────────────────────
const INTERVIEW_FIELDS = [
  'round', 'scheduledAt', 'mode', 'interviewerIds', 'feedbackJson',
  'recommendation', 'status',
  // Feature 12 — scorecard template + slot/invitation details.
  'scorecardTemplateId', 'durationMins', 'locationText', 'videoUrl',
];
const INTERVIEW_DATES = ['scheduledAt'];
const pickInterview = picker(INTERVIEW_FIELDS, INTERVIEW_DATES);

// Normalise a CSV / array of interviewer ids to a clean array.
function parsePanel(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function listInterviews(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId };
    if (req.query.applicationId) where.applicationId = req.query.applicationId;
    // F1 scope — interviews under in-scope requisitions OR ones the caller is
    // personally panelled onto (assigned-interviewer fallback for a panellist who
    // owns no requisition). ALL band keeps the tenant-wide view.
    const scope = req.recruitmentScope;
    if (scope && scope.kind !== 'ALL') {
      const reach = await accessibleJobIds(businessId, scope);
      const myIvIds = await assignedInterviewIds(businessId, req.user.employeeId);
      const ors = [];
      if (reach.ids && reach.ids.length) ors.push({ application: { jobId: { in: reach.ids } } });
      if (myIvIds.length) ors.push({ id: { in: myIvIds } });
      if (!ors.length) return res.json({ items: [] });
      where.OR = ors;
    }
    const items = await prisma.interview.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({ items });
  } catch (e) { next(e); }
}

async function createInterview(req, res, next) {
  try {
    const { businessId } = req.user;
    const { applicationId, round, mode } = req.body;
    if (!applicationId || round === undefined || round === null || !mode) {
      return res.status(400).json({ message: 'applicationId, round and mode are required' });
    }
    const app = await prisma.application.findFirst({ where: { id: applicationId, businessId, job: { deletedAt: null } }, include: { job: { select: { scorecardTemplateId: true } } } });
    if (!app) return res.status(404).json({ message: 'Application not found' });

    const data = pickInterview(req.body);
    // normalise the panel to a clean CSV
    if (req.body.interviewerIds !== undefined) data.interviewerIds = parsePanel(req.body.interviewerIds).join(',');
    // default the round's scorecard template to the job's default if unset
    if (!data.scorecardTemplateId && app.job && app.job.scorecardTemplateId) {
      data.scorecardTemplateId = app.job.scorecardTemplateId;
    }
    // validate the chosen template belongs to this tenant
    if (data.scorecardTemplateId) {
      const tpl = await prisma.scorecardTemplate.findFirst({ where: { id: data.scorecardTemplateId, businessId, deletedAt: null }, select: { id: true } });
      if (!tpl) return res.status(404).json({ message: 'Scorecard template not found' });
    }

    const panel = parsePanel(data.interviewerIds);
    const item = await prisma.$transaction(async (tx) => {
      const iv = await tx.interview.create({ data: { ...data, applicationId, businessId } });
      // pre-create one blank DRAFT scorecard per interviewer (the "remember each
      // candidate" cards) — bound to each panellist's own Employee id (SoD).
      for (const empId of panel) {
        try {
          await tx.scorecard.create({ data: { businessId, interviewId: iv.id, interviewerEmployeeId: empId, templateId: data.scorecardTemplateId || '', status: 'DRAFT' } });
        } catch (err) { if (err.code !== 'P2002') throw err; }
      }
      return iv;
    });
    res.status(201).json(item);
  } catch (e) { next(e); }
}

async function updateInterview(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.interview.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    const item = await prisma.interview.update({ where: { id: req.params.id }, data: pickInterview(req.body) });
    res.json(item);
  } catch (e) { next(e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// (e) OFFER — create (with 50% pre-flight) / send / accept / decline
// ─────────────────────────────────────────────────────────────────────────────
const OFFER_FIELDS = [
  'ctcAnnual', 'grossMonthly', 'currencyCode', 'joiningDate', 'structureId',
  'letterUrl', 'expiresAt',
];
const OFFER_DATES = ['joiningDate', 'expiresAt'];
const pickOffer = picker(OFFER_FIELDS, OFFER_DATES);

/**
 * India Code-on-Wages 50% pre-flight for an offer. Reuses the payroll engine's
 * computeStatutoryWages (NOT a re-implementation): Basic+DA must be >= 50% of
 * monthly gross. Returns { ok } or { ok:false, error } describing the breach.
 *
 * Only enforced for INR offers where a monthly gross + basic split is supplied
 * — non-India currencies fall outside the Code on Wages. The check is pure and
 * uses integer paise, matching the engine's money convention.
 */
function offerWageCheck({ countryCode, currencyCode, grossMonthly, basicMonthly, daMonthly, joiningDate }) {
  const isIndia = String(countryCode || '').toUpperCase() === 'IN'
    || String(currencyCode || '').toUpperCase() === 'INR';
  if (!isIndia) return { ok: true, applied: false };

  const grossMinor = toMinor(grossMonthly);
  const basicMinor = toMinor(basicMonthly);
  const daMinor = toMinor(daMonthly) || 0;
  if (grossMinor == null || basicMinor == null) {
    // Without a gross + basic split we cannot run the statutory check.
    return { ok: false, error: { code: 'WAGES_50_RULE', message: 'grossMonthly and basicMonthly are required to validate the India 50% wage rule for an INR offer.' } };
  }

  // As-of date: the joining date drives effective-dating of the wage rule
  // (the Labour Codes 50% add-back is effective 2025-11-21). ISO YYYY-MM-DD.
  const asOf = joiningDate ? new Date(joiningDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);

  const wages = computeStatutoryWages({
    periodGrossMinor: grossMinor,
    basicDaMinor: basicMinor + daMinor,
    asOf,
  });

  if (wages.breach) {
    return {
      ok: false,
      applied: true,
      error: {
        code: 'WAGES_50_RULE',
        message:
          `Basic+DA (₹${((basicMinor + daMinor) / 100).toFixed(2)}) is below 50% of monthly gross ` +
          `(₹${(grossMinor / 100).toFixed(2)}); the offer violates the India Code-on-Wages 50% rule. ` +
          `Increase Basic+DA to at least ₹${((wages.floorMinor || 0) / 100).toFixed(2)}.`,
      },
    };
  }
  return { ok: true, applied: wages.ruleApplied };
}

async function listOffers(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId };
    if (req.query.applicationId) where.applicationId = req.query.applicationId;
    if (req.query.status) where.status = req.query.status;
    // F1 scope — offers on in-scope requisitions only.
    const scope = req.recruitmentScope;
    if (scope && scope.kind !== 'ALL') {
      const reach = await accessibleJobIds(businessId, scope);
      where.application = { is: { jobId: { in: reach.ids } } };
    }
    const items = await prisma.offer.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({ items });
  } catch (e) { next(e); }
}

async function getOffer(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.offer.findFirst({
      where: { id: req.params.id, businessId },
      include: { application: { select: { job: { select: { hiringManagerId: true } } } } },
    });
    if (!item) return res.status(404).json({ message: 'Not found' });
    // F1 scope — 404 an offer on an out-of-requisition job.
    if (!scopeAllowsJob(req.recruitmentScope, item.application && item.application.job)) {
      return res.status(404).json({ message: 'Not found' });
    }
    delete item.application;
    res.json(item);
  } catch (e) { next(e); }
}

// POST /offers — draft an offer for an application. Runs the India 50% wage
// pre-flight: a breach is blocked with 422 WAGES_50_RULE before any row is
// written. basicMonthly/daMonthly are inputs to the check only (not persisted
// columns on Offer; the proposed structure lives in structureId).
async function createOffer(req, res, next) {
  try {
    const { businessId } = req.user;
    const { applicationId, currencyCode } = req.body;
    if (!applicationId || !currencyCode) {
      return res.status(400).json({ message: 'applicationId and currencyCode are required' });
    }
    const app = await prisma.application.findFirst({
      where: { id: applicationId, businessId },
      include: { job: { select: { countryCode: true, hiringManagerId: true } } },
    });
    if (!app) return res.status(404).json({ message: 'Application not found' });
    // F1 scope — a scoped recruiter cannot draft an offer on an out-of-requisition
    // application (404, IDOR-safe). Matches the read-side scope on getOffer/listOffers.
    if (!scopeAllowsJob(req.recruitmentScope, app.job)) return res.status(404).json({ message: 'Application not found' });

    // ── 50% pre-flight (reuses payroll engine wage check) ──
    const check = offerWageCheck({
      countryCode: app.job?.countryCode,
      currencyCode,
      grossMonthly: req.body.grossMonthly,
      basicMonthly: req.body.basicMonthly,
      daMonthly: req.body.daMonthly,
      joiningDate: req.body.joiningDate,
    });
    if (!check.ok) {
      return res.status(422).json(check.error);
    }

    const item = await prisma.offer.create({
      data: { ...pickOffer(req.body), applicationId, businessId, status: 'DRAFT' },
    });
    res.status(201).json(item);
  } catch (e) { next(e); }
}

// ── Offer-approval Separation-of-Duties (§9.4, acceptance criterion 7) ─────────
// An interviewer who scored — i.e. sat on the panel of, or submitted a scorecard
// on, ANY interview of this candidate's application — must not be the one who
// approves/extends (send) or finalises (accept) that candidate's offer. Maker ≠
// checker. Returns the conflicting employeeId when the actor is a panellist/scorer.
//
// SUPER_ADMIN / a caller with no linked Employee (a pure HR-admin who never sat on
// a panel) is structurally absent from every panel, so they always pass — the
// guard only ever fires on someone who actually scored the candidate.
async function offerApproverConflict(businessId, offer, actorEmployeeId) {
  if (!actorEmployeeId) return null; // no linked Employee → cannot be a panellist
  const interviews = await prisma.interview.findMany({
    where: { businessId, applicationId: offer.applicationId },
    select: { id: true, interviewerIds: true },
  });
  if (!interviews.length) return null;
  // panellist check — the actor appears as a token in any interview's CSV panel.
  const onPanel = interviews.some((iv) =>
    String(iv.interviewerIds || '').split(',').map((t) => t.trim()).includes(actorEmployeeId));
  if (onPanel) return actorEmployeeId;
  // scorer check — the actor owns a scorecard on any of those interviews (covers a
  // scorer who scored after being removed from the live panel CSV).
  const card = await prisma.scorecard.findFirst({
    where: { businessId, interviewId: { in: interviews.map((i) => i.id) }, interviewerEmployeeId: actorEmployeeId },
    select: { id: true },
  });
  return card ? actorEmployeeId : null;
}

const SOD_MSG = 'Separation of duties: an interviewer who scored this candidate cannot approve their offer. A different approver is required.';

// POST /offers/:id/send — DRAFT/APPROVED -> SENT, stamping sentAt.
async function sendOffer(req, res, next) {
  try {
    const { businessId } = req.user;
    const offer = await prisma.offer.findFirst({
      where: { id: req.params.id, businessId },
      include: { application: { select: { job: { select: { hiringManagerId: true } } } } },
    });
    if (!offer) return res.status(404).json({ message: 'Not found' });
    // F1 scope — a scoped recruiter cannot send an offer on an out-of-requisition
    // job (404, IDOR-safe). The SoD guard alone only blocks a panellist/scorer.
    if (!scopeAllowsJob(req.recruitmentScope, offer.application && offer.application.job)) {
      return res.status(404).json({ message: 'Not found' });
    }
    // SoD — the scorer/panellist of the candidate may not extend the offer.
    const conflict = await offerApproverConflict(businessId, offer, req.user.employeeId);
    if (conflict) return res.status(403).json({ message: SOD_MSG, code: 'OFFER_SOD' });
    if (!['DRAFT', 'APPROVED', 'PENDING_APPROVAL'].includes(offer.status)) {
      return res.status(409).json({ message: `Cannot send an offer in status ${offer.status}` });
    }
    // Wave 2B — internal approval gate. Pre-resolve: the built-in OFFER default
    // is AUTO_APPROVE (no gate — send proceeds exactly as before). A
    // tenant-authored chain with a real approver parks a DRAFT offer
    // PENDING_APPROVAL + opens the request; once APPROVED, send proceeds.
    if (offer.status === 'DRAFT') {
      const { resolveDefinition } = require('../../approvals/workflowResolver');
      const resolvedDef = await resolveDefinition(businessId, 'OFFER', { entityId: offer.id });
      const needsApproval = (resolvedDef.steps || []).some((st) => st.approverType !== 'AUTO_APPROVE');
      if (needsApproval) {
        const engine = require('../../approvals/engine');
        require('../../approvals/consumers.offer');
        const gated = await prisma.$transaction(async (tx) => {
          await tx.offer.update({ where: { id: offer.id }, data: { status: 'PENDING_APPROVAL' } });
          const opened = await engine.openRequest({
            businessId,
            module: 'OFFER',
            entityType: 'Offer',
            entityId: offer.id,
            requesterEmployeeId: req.user.employeeId || null,
            payload: { offerId: offer.id, applicationId: offer.applicationId || null },
            ctx: { entityId: offer.id },
          }, tx);
          await tx.offer.update({ where: { id: offer.id }, data: { approvalRequestId: opened.approvalRequest.id } });
          return opened;
        });
        if (!(gated.terminal && gated.approvalRequest.status === 'APPROVED')) {
          const pending = await prisma.offer.findFirst({ where: { id: offer.id, businessId } });
          return res.status(202).json({
            pendingApproval: true,
            approvalRequestId: gated.approvalRequest.id,
            offer: pending,
            message: 'Offer awaits internal approval per your OFFER workflow; send it once approved.',
          });
        }
        // Conditional steps all skipped → APPROVED in-tx; fall through to send.
      }
    }
    const item = await prisma.offer.update({
      where: { id: offer.id },
      data: { status: 'SENT', sentAt: new Date() },
    });
    // Feature 36 — fire the candidate.offer message (fixes HR_OFFER_SENT never
    // firing). Best-effort, fire-and-forget; auto-send default ON for offers. Carries
    // the offer EXPIRY + the status {LINK}. Never awaits into the response.
    (async () => {
      const appRow = await prisma.application.findFirst({
        where: { id: offer.applicationId, businessId },
        select: { id: true, status: true, candidateId: true, jobId: true },
      });
      if (!appRow) return;
      const expiry = offer.expiresAt ? new Date(offer.expiresAt).toISOString().slice(0, 10) : 'the stated date';
      await candidateNotify.fanOutCandidateStage({
        businessId,
        application: appRow,
        event: 'candidate.offer',
        extraVars: { EXPIRY: expiry },
      });
    })().catch(() => { /* never breaks the offer send */ });
    res.json(item);
  } catch (e) { next(e); }
}

// POST /offers/:id/accept — SENT -> ACCEPTED, stamping respondedAt. Also marks
// the linked application HIRED so the pipeline reflects the outcome, and seeds
// the onboarding LifecycleJourney (Feature 4 §4.1) INSIDE the same transaction
// so accept + journey commit atomically. The journey seeding is idempotent (the
// partial unique onb_one_active_per_offer is the backstop) so a retried accept
// never doubles the pipeline card.
async function acceptOffer(req, res, next) {
  try {
    const { businessId } = req.user;
    const offer = await prisma.offer.findFirst({
      where: { id: req.params.id, businessId },
      include: { application: { select: { job: { select: { hiringManagerId: true } } } } },
    });
    if (!offer) return res.status(404).json({ message: 'Not found' });
    // F1 scope — a scoped recruiter cannot finalise an offer on an out-of-requisition
    // job (404, IDOR-safe).
    if (!scopeAllowsJob(req.recruitmentScope, offer.application && offer.application.job)) {
      return res.status(404).json({ message: 'Not found' });
    }
    // SoD — the scorer/panellist may not finalise (provision the hire from) the
    // very offer they scored. Maker ≠ checker (§9.4, acceptance criterion 7).
    const conflict = await offerApproverConflict(businessId, offer, req.user.employeeId);
    if (conflict) return res.status(403).json({ message: SOD_MSG, code: 'OFFER_SOD' });
    if (offer.status !== 'SENT') {
      return res.status(409).json({ message: `Cannot accept an offer in status ${offer.status}` });
    }
    const item = await prisma.$transaction(async (tx) => {
      const updated = await tx.offer.update({
        where: { id: offer.id },
        data: { status: 'ACCEPTED', respondedAt: new Date() },
      });
      await tx.application.update({
        where: { id: offer.applicationId },
        data: { status: 'HIRED' },
      });
      // Feature 4: seed the onboarding journey from the default IN/NZ template.
      await seedOnboardingJourney(updated, tx);
      return updated;
    });
    res.json(item);
  } catch (e) {
    // The onb_one_active_per_offer partial unique → 409 if a concurrent accept
    // already seeded a journey for this offer (idempotency backstop).
    if (e.code === 'P2002') return res.status(409).json({ message: 'Offer already accepted' });
    next(e);
  }
}

// POST /offers/:id/decline — SENT -> DECLINED, stamping respondedAt.
async function declineOffer(req, res, next) {
  try {
    const { businessId } = req.user;
    const offer = await prisma.offer.findFirst({
      where: { id: req.params.id, businessId },
      include: { application: { select: { job: { select: { hiringManagerId: true } } } } },
    });
    if (!offer) return res.status(404).json({ message: 'Not found' });
    // F1 scope — a scoped recruiter cannot decline an offer on an out-of-requisition job.
    if (!scopeAllowsJob(req.recruitmentScope, offer.application && offer.application.job)) {
      return res.status(404).json({ message: 'Not found' });
    }
    if (offer.status !== 'SENT') {
      return res.status(409).json({ message: `Cannot decline an offer in status ${offer.status}` });
    }
    const item = await prisma.offer.update({
      where: { id: offer.id },
      data: { status: 'DECLINED', respondedAt: new Date() },
    });
    res.json(item);
  } catch (e) { next(e); }
}

// POST /offers/:id/render-letter — render the offer-letter PDF via the Letters
// service (Feature 9 issueLetter) → Offer.letterUrl. A candidate is not yet an
// Employee, so we render in a template-only mode using merge overrides; when a
// templateId is not supplied (or the Letters service cannot render without an
// employee context) we surface a clear 422 rather than 500. This is the optional
// slice-12e seam — the e-sign request reads Offer.letterUrl.
async function renderOfferLetter(req, res, next) {
  try {
    const { businessId } = req.user;
    const offer = await prisma.offer.findFirst({
      where: { id: req.params.id, businessId },
      include: { application: { include: { candidate: true, job: true } } },
    });
    if (!offer) return res.status(404).json({ message: 'Not found' });
    // F1 scope — a scoped recruiter cannot render a letter for an out-of-requisition offer.
    if (!scopeAllowsJob(req.recruitmentScope, offer.application && offer.application.job)) {
      return res.status(404).json({ message: 'Not found' });
    }
    const { templateId } = req.body || {};
    if (!templateId) {
      return res.status(422).json({ message: 'A Letters templateId is required to render the offer letter.' });
    }
    let letters;
    try { letters = require('../../letters/letters.service'); } catch { letters = null; }
    if (!letters || !letters.issueLetter) {
      return res.status(501).json({ message: 'Letters service unavailable' });
    }
    const cand = offer.application && offer.application.candidate;
    const job = offer.application && offer.application.job;
    try {
      const result = await letters.issueLetter(prisma, {
        businessId, actorUserId: req.user.id, templateId, employeeId: null,
        perms: { canGenerateLetters: true },
        mode: 'issue',
        overrides: {
          // candidate merge context for the offer letter
          candidateName: cand ? `${cand.firstName || ''} ${cand.lastName || ''}`.trim() : '',
          candidateEmail: cand ? cand.email : '',
          jobTitle: job ? job.title : '',
          joiningDate: offer.joiningDate ? new Date(offer.joiningDate).toISOString().slice(0, 10) : '',
          ctcAnnual: offer.ctcAnnual ? String(offer.ctcAnnual) : '',
        },
      });
      const url = (result && (result.fileUrl || result.url)) || (result && result.document && result.document.fileUrl) || null;
      const updated = await prisma.offer.update({ where: { id: offer.id }, data: { letterUrl: url, version: { increment: 1 } } });
      return res.json({ letterUrl: updated.letterUrl, referenceNo: result && result.referenceNo });
    } catch (err) {
      // The Letters template likely requires an employee context the candidate
      // lacks — return a clear, non-500 error so the UI can guide the user.
      return res.status(422).json({ message: `Could not render the offer letter from this template: ${err.message || 'template requires an employee context'}.` });
    }
  } catch (e) { next(e); }
}

module.exports = {
  // jobs
  listJobs, getJob, createJob, updateJob, removeJob, publishJob, closeJob,
  listStages, createStage,
  // jobs — share link + funnel summary (Feature 12 enhancement)
  shareJob, setJobPublic, jobSummary,
  // candidates
  listCandidates, getCandidate, createCandidate, updateCandidate, removeCandidate,
  // applications (+ server-side filters + bulk actions)
  listApplications, getApplication, createApplication, moveApplication, bulkApplicationAction,
  // interviews
  listInterviews, createInterview, updateInterview,
  // offers
  listOffers, getOffer, createOffer, sendOffer, acceptOffer, declineOffer, renderOfferLetter,
  // exported for unit-testing the pure 50% pre-flight + offer-approval SoD +
  // the public-link + filter helpers
  _internals: {
    offerWageCheck, toMinor, validateMeritWeights, slugify, parsePanel, offerApproverConflict,
    publicCareersLink, applicationFilterWhere, scopeApplicationWhere,
  },
};
