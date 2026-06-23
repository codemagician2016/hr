'use strict';

/**
 * publicCareers.controller.js — Feature 12 (Recruitment / ATS) PUBLIC careers
 * surface. UNAUTHENTICATED, rate-limited, tenant-resolved from a :businessSlug.
 *
 * Hard rules (§7, §9.2, §9.5):
 *  - Every read/write is hard-scoped to the resolved businessId; a public apply
 *    can NEVER reference another tenant's job.
 *  - Screening POINTS and KNOCKOUT VALUES are NEVER serialised to a public
 *    response (only prompts + option labels). The score is never returned.
 *  - Resume upload caps: 10 MB decoded + a PDF/PNG/JPG MIME allow-list (reuses the
 *    F4 pre-join upload caps).
 *  - Consent is mandatory; the candidate is deduped by (businessId, email).
 */

const prisma = require('../../../core/lib/prisma');
const s3 = require('../../../core/lib/s3');
const { _internals: scoringInternals } = require('./scoring');
const scoringCtl = require('./recruitment.scoring.controller');

// ── resume upload guards (reuse F4 pre-join caps) ─────────────────────────────
const MAX_RESUME_BYTES = 10 * 1024 * 1024; // 10 MB decoded
const ALLOWED_RESUME_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']);

function validateResumeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return { ok: false, status: 400, message: 'A resume (base64 data URL) is required' };
  const m = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(dataUrl);
  if (!m || !m[2]) return { ok: false, status: 422, message: 'Only base64 data URLs are supported for the resume' };
  const mime = m[1].toLowerCase();
  if (!ALLOWED_RESUME_MIME.has(mime)) return { ok: false, status: 422, message: `Unsupported resume type: ${mime}. Allowed: PDF, PNG, JPG.` };
  const b64 = m[3] || '';
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const decodedBytes = Math.floor((b64.length * 3) / 4) - padding;
  if (decodedBytes > MAX_RESUME_BYTES) return { ok: false, status: 413, message: `Resume exceeds the ${MAX_RESUME_BYTES / (1024 * 1024)} MB limit` };
  return { ok: true, mime, bytes: decodedBytes };
}

// ── rate-limit (DoS dampener for the UNAUTH apply endpoint) ───────────────────
// The previous key was `${leftmost-XFF}:${email}` — both halves are fully client-
// controlled (the leftmost X-Forwarded-For token is never stripped behind a single
// trusted proxy hop, and the email rotates per request), so it was trivially
// bypassable. We now key on THREE independent, harder-to-spoof dimensions, and a
// request is throttled if ANY of them is exceeded:
//   (1) per (tenant, job, normalized-email) — caps one applicant rotating IPs.
//   (2) per coarse trusted-IP bucket          — caps one source rotating emails.
//   (3) per (tenant, job) global ceiling      — bounds total writes for a job.
// `req.ip` is used (NOT raw XFF): with `app.set('trust proxy', 1)` Express resolves
// it to the real client across the single trusted hop, so it cannot be spoofed by
// prepending tokens. A real deployment still fronts this with the edge rate-limit;
// this is the process-local backstop and a shared store is the production upgrade.
const RL_WINDOW_MS = 60 * 1000;          // 1-minute sliding window
const RL_PER_APPLICANT = 5;              // (tenant,job,email) per window
const RL_PER_IP = 10;                    // coarse-IP bucket per window
const RL_PER_JOB = 60;                   // (tenant,job) global ceiling per window
const rlBucket = new Map();

// Bucketise the trusted client IP coarsely so an attacker who only controls the
// host portion of a /24 (or a /48 of v6) cannot defeat the IP dimension by walking
// neighbouring addresses. IPv4 → /24; IPv6 → first 3 hextets (~/48).
function coarseIpBucket(ip) {
  const s = String(ip || '').replace(/^::ffff:/i, ''); // unwrap v4-mapped v6
  if (s.includes('.')) return s.split('.').slice(0, 3).join('.') + '.0/24';
  if (s.includes(':')) return s.split(':').slice(0, 3).join(':') + '::/48';
  return s || 'unknown';
}

// Sliding-window counter for a single key. Returns true when the key is at/over
// `max` for the current window (and does NOT record the over-limit hit).
function hit(key, max, now) {
  const arr = (rlBucket.get(key) || []).filter((t) => now - t < RL_WINDOW_MS);
  if (arr.length >= max) { rlBucket.set(key, arr); return true; }
  arr.push(now); rlBucket.set(key, arr);
  return false;
}

// Throttle an apply across all three dimensions. Trusted IP comes from req.ip; the
// email is tenant+job scoped and normalised so case/rotation can't fork the key.
function applyRateLimited({ ip, businessId, jobId, email }) {
  const now = Date.now();
  const bucket = coarseIpBucket(ip);
  const lcEmail = String(email || '').trim().toLowerCase();
  // evaluate all three so each window-counter is advanced consistently.
  const overApplicant = hit(`a:${businessId}:${jobId}:${lcEmail}`, RL_PER_APPLICANT, now);
  const overIp = hit(`i:${bucket}`, RL_PER_IP, now);
  const overJob = hit(`j:${businessId}:${jobId}`, RL_PER_JOB, now);
  return overApplicant || overIp || overJob;
}

async function resolveBusiness(slug) {
  if (!slug) return null;
  return prisma.business.findFirst({ where: { slug }, select: { id: true, name: true, slug: true } });
}

// Strip points / knockout internals from a question before it goes public.
function publicQuestion(q) {
  return {
    id: q.id, prompt: q.prompt, kind: q.kind, required: q.required, sortOrder: q.sortOrder,
    options: (q.options || []).map((o) => ({ id: o.id, label: o.label, value: o.value, sortOrder: o.sortOrder })),
  };
}

// GET /careers/:businessSlug — published, public, open jobs.
async function publicBoard(req, res, next) {
  try {
    const biz = await resolveBusiness(req.params.businessSlug);
    if (!biz) return res.status(404).json({ message: 'Careers page not found' });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const where = { businessId: biz.id, deletedAt: null, isPublic: true, status: 'OPEN' };
    const [total, jobs] = await Promise.all([
      prisma.job.count({ where }),
      prisma.job.findMany({
        where, orderBy: { publishedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        select: { id: true, title: true, publicSlug: true, countryCode: true, employmentType: true, openings: true, departmentId: true, locationId: true, publishedAt: true },
      }),
    ]);
    res.json({
      business: { name: biz.name, slug: biz.slug },
      items: jobs,
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (e) { next(e); }
}

// GET /careers/:businessSlug/jobs/:publicSlug — job detail + screening questions
// (NO points / knockout values).
async function publicJobDetail(req, res, next) {
  try {
    const biz = await resolveBusiness(req.params.businessSlug);
    if (!biz) return res.status(404).json({ message: 'Careers page not found' });
    const job = await prisma.job.findFirst({
      where: { businessId: biz.id, publicSlug: req.params.publicSlug, deletedAt: null, isPublic: true, status: 'OPEN' },
      select: { id: true, title: true, description: true, countryCode: true, employmentType: true, openings: true, publicSlug: true },
    });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    const questions = await prisma.screeningQuestion.findMany({
      where: { businessId: biz.id, jobId: job.id, deletedAt: null }, include: { options: { orderBy: { sortOrder: 'asc' } } }, orderBy: { sortOrder: 'asc' },
    });
    res.json({ business: { name: biz.name, slug: biz.slug }, job, screeningQuestions: questions.map(publicQuestion) });
  } catch (e) { next(e); }
}

// POST /careers/:businessSlug/jobs/:publicSlug/apply — create/dedupe candidate,
// create application (appliedSource=PUBLIC), accept resume + screening answers +
// consent, run scoreScreening. Returns a thank-you ONLY (never the score).
async function publicApply(req, res, next) {
  try {
    const biz = await resolveBusiness(req.params.businessSlug);
    if (!biz) return res.status(404).json({ message: 'Careers page not found' });
    const job = await prisma.job.findFirst({
      where: { businessId: biz.id, publicSlug: req.params.publicSlug, deletedAt: null, isPublic: true, status: 'OPEN' }, select: { id: true },
    });
    if (!job) return res.status(404).json({ message: 'Job not found' });

    const { firstName, lastName, email, phone, consent, resumeDataUrl, answers } = req.body || {};
    if (!firstName || !lastName || !email) return res.status(400).json({ message: 'firstName, lastName and email are required' });
    if (!consent) return res.status(422).json({ message: 'Consent to data processing is required to apply' });

    // Rate-limit on the TRUSTED client IP (req.ip, resolved across the single proxy
    // hop) + tenant/job/email + a per-job ceiling — never the spoofable raw XFF.
    if (applyRateLimited({ ip: req.ip, businessId: biz.id, jobId: job.id, email })) {
      return res.status(429).json({ message: 'Too many applications. Please try again in a minute.' });
    }

    // resume upload (optional) — validate caps BEFORE storing.
    let resumeUrl = null;
    if (resumeDataUrl) {
      const chk = validateResumeDataUrl(resumeDataUrl);
      if (!chk.ok) return res.status(chk.status).json({ message: chk.message });
      if (!s3.isConfigured()) {
        // NEVER inline the raw base64 data URL into Candidate.resumeUrl (@db.Text,
        // unbounded): an unauthenticated caller rotating emails would write an
        // unbounded stream of ~10MB blobs and exhaust DB storage. Require a bounded
        // external store for public uploads; reject (not inline) when it is absent.
        return res.status(503).json({ message: 'Resume uploads are temporarily unavailable. Please apply without a resume, or try again later.' });
      }
      try {
        const up = await s3.uploadDataUrl({ dataUrl: resumeDataUrl, businessId: biz.id, scope: 'resume' });
        resumeUrl = up.url;
      } catch {
        return res.status(503).json({ message: 'Resume upload failed. Please apply without a resume, or try again later.' });
      }
    }

    const lcEmail = String(email).toLowerCase();
    const application = await prisma.$transaction(async (tx) => {
      // dedupe candidate by (businessId, email)
      let candidate = await tx.candidate.findFirst({ where: { businessId: biz.id, email: lcEmail } });
      if (candidate) {
        await tx.candidate.update({
          where: { id: candidate.id },
          data: {
            firstName, lastName, phone: phone || candidate.phone,
            resumeUrl: resumeUrl || candidate.resumeUrl,
            consentAt: new Date(), deletedAt: null,
          },
        });
      } else {
        candidate = await tx.candidate.create({
          data: { businessId: biz.id, firstName, lastName, email: lcEmail, phone: phone || null, resumeUrl, source: 'job-board', consentAt: new Date() },
        });
      }
      // application — unique (businessId, jobId, candidateId); a re-apply is a 409
      const firstStage = await tx.jobStage.findFirst({ where: { businessId: biz.id, jobId: job.id }, orderBy: { sortOrder: 'asc' } });
      const app = await tx.application.create({
        data: {
          businessId: biz.id, jobId: job.id, candidateId: candidate.id,
          currentStageId: firstStage ? firstStage.id : null,
          status: 'APPLIED', appliedSource: 'PUBLIC',
        },
      });
      return app;
    });

    // auto-score the screening answers (knockout → auto-reject), reusing the shared
    // engine. The score is computed + persisted but NEVER returned to the public.
    const ansList = Array.isArray(answers) ? answers : [];
    try {
      const appRow = await prisma.application.findFirst({ where: { id: application.id, businessId: biz.id }, include: { job: true } });
      await scoringCtl._internals.recordAnswersAndScore(biz.id, appRow, ansList);
    } catch { /* scoring failures never block the candidate's apply */ }

    // thank-you only — no score, no knockout status leaked.
    return res.status(201).json({ ok: true, message: 'Thank you for applying. Our team will be in touch.' });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'You have already applied to this role.' });
    next(e);
  }
}

module.exports = {
  publicBoard, publicJobDetail, publicApply,
  _internals: { validateResumeDataUrl, publicQuestion, applyRateLimited, coarseIpBucket },
};
