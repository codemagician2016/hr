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
// Careers CMS — public projections (draft → null; only isPublished exposes content)
// + the leak-safe brand block (logo/colors/footer).
const { projectPublicPage, projectPublicBrand } = require('./careersPage.lib');
const { _internals: scoringInternals } = require('./scoring');
const scoringCtl = require('./recruitment.scoring.controller');
// Feature 36 — candidate fan-out + access-token minting (status link on apply),
// the friendly status/timeline projection, and the pure slot-proposal logic.
const candidateNotify = require('./candidateNotify');
const { serializeTimelineApplication } = require('./candidateTimeline');
const slotsLib = require('./slots');
const { notifyHrEvent } = require('../../integrations/notifications');
const { appBaseUrl } = require('../../approvals/notify')._internals;
const { buildIcs, careersOrganizer, parseInterviewerIds } = scoringCtl._internals;

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
    // Fetch the CMS page + the tenant's active brand alongside the jobs. Both are
    // OPTIONAL and best-effort — a missing/unpublished page or absent brand simply
    // yields null (the frontend falls back to today's hard-coded copy).
    const [total, jobs, pageRow, brand] = await Promise.all([
      prisma.job.count({ where }),
      prisma.job.findMany({
        where, orderBy: { publishedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        select: { id: true, title: true, publicSlug: true, countryCode: true, employmentType: true, openings: true, departmentId: true, locationId: true, publishedAt: true },
      }),
      prisma.careersPage.findUnique({ where: { businessId: biz.id } }).catch(() => null),
      prisma.tenantBrand.findFirst({
        where: { businessId: biz.id, entityId: null, isActive: true, deletedAt: null },
        orderBy: { isDefault: 'desc' },
      }).catch(() => null),
    ]);
    res.json({
      business: { name: biz.name, slug: biz.slug },
      // NEVER leak draft content — projectPublicPage returns null unless isPublished.
      page: projectPublicPage(pageRow),
      brand: projectPublicBrand(brand),
      items: jobs,
      jobs,
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

    // Feature 36 — mint the candidate's public access token (idempotent) so the
    // thank-you can carry a "track your application" status link, and fire the
    // "we received it" acknowledgement (candidate.applied, default auto-send ON).
    // Both are best-effort: a notify/token failure never breaks the apply.
    let trackUrl = null;
    try {
      const token = await candidateNotify.ensureCandidateToken(biz.id, application.candidateId);
      trackUrl = candidateNotify.candidateStatusLink(biz.slug, token);
    } catch { /* best-effort */ }
    candidateNotify.fanOutCandidateStage({
      businessId: biz.id,
      application: { id: application.id, status: application.status, candidateId: application.candidateId, jobId: application.jobId },
      event: 'candidate.applied',
    }).catch(() => { /* fire-and-forget */ });

    // thank-you only — no score, no knockout status leaked.
    return res.status(201).json({ ok: true, message: 'Thank you for applying. Our team will be in touch.', trackUrl });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'You have already applied to this role.' });
    next(e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature 36 — PUBLIC candidate status/timeline + slot confirm (tokenised, UNAUTH)
// Same disclosure + rate-limit posture as the apply endpoints: the tenant is
// resolved from :businessSlug, the candidate from :token (NEVER a client id), and
// no score / internal note / other candidate is ever serialised (§4.6, §6).
// ─────────────────────────────────────────────────────────────────────────────

// Rate-limit the candidate endpoints on the trusted IP + the token (reuses the
// apply limiter's window + per-IP / per-subject dimensions).
function candidateRateLimited({ ip, token }) {
  const now = Date.now();
  const overIp = hit(`ci:${coarseIpBucket(ip)}`, RL_PER_IP, now);
  const overTok = hit(`ct:${String(token || '')}`, RL_PER_APPLICANT, now);
  return overIp || overTok;
}

// Resolve a candidate from an access token, hard-scoped to the tenant. A token
// from another tenant, an unknown token, or an expired token all resolve to null
// (→ 404). Never accepts a client-supplied candidateId.
async function resolveCandidateToken(businessId, token) {
  if (!token) return null;
  const row = await prisma.candidateAccessToken.findFirst({
    where: { token: String(token), businessId },
    include: { candidate: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } } },
  }).catch(() => null);
  if (!row) return null;
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) return null;
  return row;
}

// GET /careers/:businessSlug/c/:token — the candidate's own friendly timeline
// across their applications. Zero scores / internal notes / other candidates.
async function candidateTimeline(req, res, next) {
  try {
    const biz = await resolveBusiness(req.params.businessSlug);
    if (!biz) return res.status(404).json({ message: 'Careers page not found' });
    if (candidateRateLimited({ ip: req.ip, token: req.params.token })) {
      return res.status(429).json({ message: 'Too many requests. Please try again in a minute.' });
    }
    const tok = await resolveCandidateToken(biz.id, req.params.token);
    if (!tok) return res.status(404).json({ message: 'Not found' });

    const apps = await prisma.application.findMany({
      where: { businessId: biz.id, candidateId: tok.candidateId },
      // SELECT ONLY the leak-safe columns — never the score/reason/snapshot fields.
      select: { id: true, status: true, createdAt: true, updatedAt: true, job: { select: { title: true } } },
      orderBy: { createdAt: 'desc' },
    });
    // Surface any ACTIVE interview slot proposal so the candidate can reach the
    // picker straight from the status link (the slot_request message points at
    // the bare timeline). Leak-safe: only proposalId + slot {id,startAt,endAt},
    // never panel identities. Newest PROPOSED proposal per application wins.
    const appIds = apps.map((a) => a.id);
    const proposalByApp = new Map();
    if (appIds.length) {
      const proposals = await prisma.interviewSlotProposal.findMany({
        where: { businessId: biz.id, status: 'PROPOSED', interview: { applicationId: { in: appIds } } },
        select: { id: true, slots: true, expiresAt: true, createdAt: true, interview: { select: { applicationId: true } } },
        orderBy: { createdAt: 'desc' },
      });
      for (const p of proposals) {
        const aid = p.interview && p.interview.applicationId;
        if (aid && !proposalByApp.has(aid)) {
          const slots = Array.isArray(p.slots) ? p.slots.map((s) => ({ id: s.id, startAt: s.startAt, endAt: s.endAt })) : [];
          proposalByApp.set(aid, { proposalId: p.id, expiresAt: p.expiresAt, slots });
        }
      }
    }
    const applications = apps.map((a) => {
      const base = serializeTimelineApplication(a, { role: a.job && a.job.title });
      const active = proposalByApp.get(a.id) || null;
      return active ? { ...base, activeSlotProposal: active } : base;
    });
    res.json({ business: { name: biz.name, slug: biz.slug }, applications });
  } catch (e) { next(e); }
}

// GET /careers/:businessSlug/c/:token/slots/:proposalId — the proposed slots for
// the candidate to choose from (no panel identities, no other applications).
async function candidateSlotProposal(req, res, next) {
  try {
    const biz = await resolveBusiness(req.params.businessSlug);
    if (!biz) return res.status(404).json({ message: 'Careers page not found' });
    if (candidateRateLimited({ ip: req.ip, token: req.params.token })) {
      return res.status(429).json({ message: 'Too many requests. Please try again in a minute.' });
    }
    const tok = await resolveCandidateToken(biz.id, req.params.token);
    if (!tok) return res.status(404).json({ message: 'Not found' });

    const proposal = await prisma.interviewSlotProposal.findFirst({
      where: { id: req.params.proposalId, businessId: biz.id },
      include: { interview: { select: { application: { select: { candidateId: true, job: { select: { title: true } } } } } } },
    });
    // The proposal must belong to THIS candidate's application in THIS tenant.
    const app = proposal && proposal.interview && proposal.interview.application;
    if (!proposal || !app || app.candidateId !== tok.candidateId) {
      return res.status(404).json({ message: 'Not found' });
    }
    const view = slotsLib.publicSlotView(proposal);
    view.role = app.job ? app.job.title : 'the role';
    res.json(view);
  } catch (e) { next(e); }
}

// POST /careers/:businessSlug/c/:token/slots/:proposalId/confirm — the candidate
// picks a { slotId }. Conditional PROPOSED→CONFIRMED update wins the double-confirm
// race; the second confirm 409s. On success: stamp Interview.scheduledAt + fan the
// ICS to the panel + candidate (reuses buildIcs + the candidate fan-out).
async function candidateConfirmSlot(req, res, next) {
  try {
    const biz = await resolveBusiness(req.params.businessSlug);
    if (!biz) return res.status(404).json({ message: 'Careers page not found' });
    if (candidateRateLimited({ ip: req.ip, token: req.params.token })) {
      return res.status(429).json({ message: 'Too many requests. Please try again in a minute.' });
    }
    const tok = await resolveCandidateToken(biz.id, req.params.token);
    if (!tok) return res.status(404).json({ message: 'Not found' });

    const proposal = await prisma.interviewSlotProposal.findFirst({
      where: { id: req.params.proposalId, businessId: biz.id },
      include: { interview: { include: { application: { include: { candidate: true, job: true } } } } },
    });
    const iv = proposal && proposal.interview;
    const app = iv && iv.application;
    if (!proposal || !app || app.candidateId !== tok.candidateId) {
      return res.status(404).json({ message: 'Not found' });
    }

    const slotId = req.body && req.body.slotId;
    const decision = slotsLib.confirmDecision(proposal, slotId);
    if (!decision.ok) {
      if (decision.code === 'BAD_SLOT') {
        return res.status(422).json({ message: 'That time is not one of the proposed slots.' });
      }
      // NOT_CONFIRMABLE (already confirmed/withdrawn) or EXPIRED → 409 + current state.
      return res.status(409).json({
        message: proposal.status === 'CONFIRMED' ? 'This interview time is already confirmed.' : 'This slot request is no longer open.',
        status: proposal.status,
        confirmedSlot: proposal.confirmedSlot || null,
      });
    }

    const chosen = decision.slot;
    // Conditional update = the double-confirm race authority: only a still-PROPOSED
    // row flips. The loser gets count 0 → 409 with the winning slot.
    const upd = await prisma.interviewSlotProposal.updateMany({
      where: { id: proposal.id, status: 'PROPOSED' },
      data: { status: 'CONFIRMED', confirmedSlot: chosen },
    });
    if (upd.count === 0) {
      const fresh = await prisma.interviewSlotProposal.findUnique({ where: { id: proposal.id } }).catch(() => null);
      return res.status(409).json({
        message: 'This interview time was just confirmed.',
        status: fresh ? fresh.status : 'CONFIRMED',
        confirmedSlot: fresh ? fresh.confirmedSlot : null,
      });
    }

    // Stamp the interview's scheduledAt (+ derive duration from the slot when given).
    const startAt = new Date(chosen.startAt);
    const data = { scheduledAt: startAt, status: 'SCHEDULED' };
    if (chosen.endAt) {
      const mins = Math.round((new Date(chosen.endAt).getTime() - startAt.getTime()) / 60000);
      if (mins > 0) data.durationMins = mins;
    }
    const updatedIv = await prisma.interview.update({ where: { id: iv.id }, data });

    // Fan the calendar invite to the panel + candidate (best-effort).
    const ics = await fanConfirmedInvite(biz.id, updatedIv, app);
    res.json({ ok: true, status: 'CONFIRMED', confirmedSlot: chosen, ics });
  } catch (e) { next(e); }
}

// Build the ICS + fire the confirmed-interview invite to the candidate + panel.
// Returns the ICS string (best-effort; a notify failure never throws).
async function fanConfirmedInvite(businessId, interview, application) {
  const job = application && application.job;
  const cand = application && application.candidate;
  let ics = null;
  try {
    const biz = await prisma.business.findUnique({
      where: { id: businessId }, select: { name: true, slug: true, candidateCommsConfig: true },
    }).catch(() => null);
    ics = buildIcs(interview, job, cand, { organizer: careersOrganizer(biz) });

    // candidate — the confirmed interview invite (explicit flow → bypass the gate).
    const slotline = interview.scheduledAt
      ? `Confirmed time: ${new Date(interview.scheduledAt).toISOString()}.`
      : '';
    candidateNotify.fanOutCandidateStage({
      businessId,
      application: { id: application.id, status: application.status, candidateId: application.candidateId, jobId: application.jobId },
      event: 'candidate.interview_invite',
      force: true,
      candidate: cand,
      job,
      biz,
      extraVars: { MODE: interview.mode, SLOTLINE: slotline },
    }).catch(() => {});

    // panel — one HR_INTERVIEW_PANEL per interviewer who resolves to an Employee.
    const panel = parseInterviewerIds(interview.interviewerIds);
    if (panel.length) {
      const emps = await prisma.employee.findMany({
        where: { id: { in: panel }, businessId },
        select: { id: true, firstName: true, lastName: true, workEmail: true, personalEmail: true, phone: true, countryCode: true },
      });
      const scorecardLink = `${appBaseUrl()}/me/scorecards/${interview.id}`;
      const when = interview.scheduledAt ? new Date(interview.scheduledAt).toISOString() : 'TBD';
      for (const e of emps) {
        const email = e.workEmail || e.personalEmail || null;
        if (!email && !e.phone) continue;
        notifyHrEvent({
          businessId, event: 'interview.panel_notice',
          recipientEmail: email, recipientPhone: e.phone || null, recipientCountry: e.countryCode || undefined,
          variables: {
            NAME: `${e.firstName || ''} ${e.lastName || ''}`.trim() || 'there',
            ROLE: job ? job.title : 'the role', WHEN: when, LINK: scorecardLink,
          },
          triggeredBy: `HR_INTERVIEW_PANEL:${interview.id}:${e.id}`,
        }).catch(() => {});
      }
    }
  } catch { /* best-effort */ }
  return ics;
}

module.exports = {
  publicBoard, publicJobDetail, publicApply,
  // Feature 36 — public candidate status/timeline + slot confirm.
  candidateTimeline, candidateSlotProposal, candidateConfirmSlot,
  _internals: {
    validateResumeDataUrl, publicQuestion, applyRateLimited, coarseIpBucket,
    candidateRateLimited, resolveCandidateToken,
  },
};
