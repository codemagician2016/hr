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

const DUP_MSG = 'A record with that code already exists';

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
];
const JOB_REQUIRED = ['code', 'title', 'countryCode', 'employmentType'];
const pickJob = picker(JOB_FIELDS);

async function listJobs(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId, deletedAt: null };
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
    res.json(item);
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
    const item = await prisma.job.create({ data: { ...pickJob(req.body), businessId } });
    res.status(201).json(item);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: DUP_MSG }); next(e); }
}

async function updateJob(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.job.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    const item = await prisma.job.update({ where: { id: req.params.id }, data: pickJob(req.body) });
    res.json(item);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: DUP_MSG }); next(e); }
}

async function removeJob(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.job.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
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

// POST /jobs/:id/close — OPEN/ON_HOLD -> CLOSED, stamping closedAt.
async function closeJob(req, res, next) {
  try {
    const { businessId } = req.user;
    const job = await prisma.job.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!job) return res.status(404).json({ message: 'Not found' });
    if (!['OPEN', 'ON_HOLD'].includes(job.status)) {
      return res.status(409).json({ message: `Cannot close a job in status ${job.status}` });
    }
    const item = await prisma.job.update({
      where: { id: job.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    res.json(item);
  } catch (e) { next(e); }
}

// ── JobStage config (the pipeline an application moves through) ───────────────
const STAGE_FIELDS = ['name', 'kind', 'sortOrder'];

async function listStages(req, res, next) {
  try {
    const { businessId } = req.user;
    const job = await prisma.job.findFirst({ where: { id: req.params.jobId, businessId, deletedAt: null }, select: { id: true } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
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
    const items = await prisma.candidate.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({ items });
  } catch (e) { next(e); }
}

async function getCandidate(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.candidate.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: { applications: true },
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

async function listApplications(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId };
    if (req.query.jobId) where.jobId = req.query.jobId;
    if (req.query.candidateId) where.candidateId = req.query.candidateId;
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.application.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({ items });
  } catch (e) { next(e); }
}

async function getApplication(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.application.findFirst({
      where: { id: req.params.id, businessId },
      include: { interviews: true, offers: true },
    });
    if (!item) return res.status(404).json({ message: 'Not found' });
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
    res.json(item);
  } catch (e) { next(e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// (d) INTERVIEW — schedule + record feedback
// ─────────────────────────────────────────────────────────────────────────────
const INTERVIEW_FIELDS = [
  'round', 'scheduledAt', 'mode', 'interviewerIds', 'feedbackJson',
  'recommendation', 'status',
];
const INTERVIEW_DATES = ['scheduledAt'];
const pickInterview = picker(INTERVIEW_FIELDS, INTERVIEW_DATES);

async function listInterviews(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId };
    if (req.query.applicationId) where.applicationId = req.query.applicationId;
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
    const app = await prisma.application.findFirst({ where: { id: applicationId, businessId }, select: { id: true } });
    if (!app) return res.status(404).json({ message: 'Application not found' });
    const item = await prisma.interview.create({
      data: { ...pickInterview(req.body), applicationId, businessId },
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
    const items = await prisma.offer.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({ items });
  } catch (e) { next(e); }
}

async function getOffer(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.offer.findFirst({ where: { id: req.params.id, businessId } });
    if (!item) return res.status(404).json({ message: 'Not found' });
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
      include: { job: { select: { countryCode: true } } },
    });
    if (!app) return res.status(404).json({ message: 'Application not found' });

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

// POST /offers/:id/send — DRAFT/APPROVED -> SENT, stamping sentAt.
async function sendOffer(req, res, next) {
  try {
    const { businessId } = req.user;
    const offer = await prisma.offer.findFirst({ where: { id: req.params.id, businessId } });
    if (!offer) return res.status(404).json({ message: 'Not found' });
    if (!['DRAFT', 'APPROVED', 'PENDING_APPROVAL'].includes(offer.status)) {
      return res.status(409).json({ message: `Cannot send an offer in status ${offer.status}` });
    }
    const item = await prisma.offer.update({
      where: { id: offer.id },
      data: { status: 'SENT', sentAt: new Date() },
    });
    res.json(item);
  } catch (e) { next(e); }
}

// POST /offers/:id/accept — SENT -> ACCEPTED, stamping respondedAt. Also marks
// the linked application HIRED so the pipeline reflects the outcome.
async function acceptOffer(req, res, next) {
  try {
    const { businessId } = req.user;
    const offer = await prisma.offer.findFirst({ where: { id: req.params.id, businessId } });
    if (!offer) return res.status(404).json({ message: 'Not found' });
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
      return updated;
    });
    res.json(item);
  } catch (e) { next(e); }
}

// POST /offers/:id/decline — SENT -> DECLINED, stamping respondedAt.
async function declineOffer(req, res, next) {
  try {
    const { businessId } = req.user;
    const offer = await prisma.offer.findFirst({ where: { id: req.params.id, businessId } });
    if (!offer) return res.status(404).json({ message: 'Not found' });
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

module.exports = {
  // jobs
  listJobs, getJob, createJob, updateJob, removeJob, publishJob, closeJob,
  listStages, createStage,
  // candidates
  listCandidates, getCandidate, createCandidate, updateCandidate, removeCandidate,
  // applications
  listApplications, getApplication, createApplication, moveApplication,
  // interviews
  listInterviews, createInterview, updateInterview,
  // offers
  listOffers, getOffer, createOffer, sendOffer, acceptOffer, declineOffer,
  // exported for unit-testing the pure 50% pre-flight
  _internals: { offerWageCheck, toMinor },
};
