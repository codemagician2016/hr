'use strict';

/*
 * careersPortal.controller.js — Feature 38 candidate CAREERS PORTAL.
 *
 * Layers a candidate ACCOUNT (passwordless magic-link) + rich PROFILE + a smart
 * APPLY flow on top of the Feature 12 public careers board. The whole surface is
 * gated by the tenant's `talent_acquisition` add-on entitlement (a non-owning tenant
 * has no public careers page → 404).
 *
 * Smart apply: enter email → dedupe. New email → apply as guest (account auto-created
 * + magic link emailed to return). Existing email → we email a link to continue with
 * the saved profile ("already registered → continue & apply", resume swap per job).
 */

const prisma = require('../../../core/lib/prisma');
const s3 = require('../../../core/lib/s3');
const { booleanEntitlement } = require('../../../core/lib/entitlements');
const { sendEmail } = require('../../../core/utils/email');
const scoringCtl = require('../recruitment/recruitment.scoring.controller');
const { _internals: pub } = require('../recruitment/publicCareers.controller');
const auth = require('./candidateAuth');

const ENTITLEMENT = 'talent_acquisition';

// Resolve a tenant by careers slug AND assert the add-on entitlement. Returns null
// when the tenant is unknown OR doesn't own Talent Acquisition (→ caller 404s, so a
// non-owning tenant's careers page is simply "not found").
async function resolveEntitledBusiness(slug) {
  if (!slug) return null;
  const biz = await prisma.business.findFirst({ where: { slug }, select: { id: true, name: true, slug: true } });
  if (!biz) return null;
  const ent = await booleanEntitlement(biz.id, ENTITLEMENT);
  if (!ent.enabled) return null;
  return biz;
}

function careersOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

async function emailMagicLink(req, biz, email, token) {
  const link = `${careersOrigin(req)}/api/careers/${biz.slug}/auth/verify?token=${encodeURIComponent(token)}`;
  const html = `<p>Hi,</p><p>Use the secure link below to continue on the <b>${biz.name}</b> careers portal — review your profile and apply. It expires in 30 minutes.</p>`
    + `<p><a href="${link}">Continue to ${biz.name} careers</a></p>`
    + `<p>If you didn't request this, you can ignore this email.</p>`;
  try { await sendEmail(email, `Continue on the ${biz.name} careers portal`, html); } catch (_e) { /* email best-effort */ }
}

// ── auth ──────────────────────────────────────────────────────────────────────
// POST /careers/:slug/auth/request  { email }  → email a magic link (dedupe-aware).
async function requestMagicLink(req, res, next) {
  try {
    const biz = await resolveEntitledBusiness(req.params.slug);
    if (!biz) return res.status(404).json({ message: 'Careers page not found' });
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ message: 'A valid email is required' });
    const existing = await prisma.candidate.findFirst({ where: { businessId: biz.id, email, deletedAt: null }, select: { id: true } });
    await emailMagicLink(req, biz, email, auth.signMagicToken({ businessId: biz.id, email }));
    // Do not leak which emails exist beyond the "returning" hint the UI uses.
    return res.json({ sent: true, existing: !!existing });
  } catch (e) { next(e); }
}

// GET /careers/:slug/auth/verify?token=  → set the candidate session cookie + redirect.
async function verifyMagicLink(req, res, next) {
  try {
    const biz = await resolveEntitledBusiness(req.params.slug);
    if (!biz) return res.status(404).json({ message: 'Careers page not found' });
    let decoded;
    try { decoded = auth.verifyTyped(String(req.query.token || ''), 'candidate_magic'); } catch (_e) {
      return res.redirect(302, '/careers?authError=expired');
    }
    if (decoded.businessId !== biz.id) return res.status(400).json({ message: 'Invalid link' });
    // find or create the candidate for this verified email.
    let candidate = await prisma.candidate.findFirst({ where: { businessId: biz.id, email: decoded.email, deletedAt: null } });
    if (!candidate) {
      candidate = await prisma.candidate.create({
        data: { businessId: biz.id, email: decoded.email, firstName: '', lastName: '', source: 'careers-portal', consentAt: new Date() },
      });
    }
    await prisma.candidate.update({ where: { id: candidate.id }, data: { emailVerifiedAt: candidate.emailVerifiedAt || new Date(), lastLoginAt: new Date() } });
    auth.setCandidateCookie(res, auth.signSessionToken({ candidateId: candidate.id, businessId: biz.id }));
    return res.redirect(302, '/careers/profile');
  } catch (e) { next(e); }
}

async function logout(req, res) { auth.clearCandidateCookie(res); res.json({ ok: true }); }

// ── profile (candidate-authed) ──────────────────────────────────────────────────
function publicCandidate(c) {
  return {
    id: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone,
    headline: c.headline, location: c.location, linkedinUrl: c.linkedinUrl,
    totalExperienceMonths: c.totalExperienceMonths, resumeUrl: c.resumeUrl,
    emailVerifiedAt: c.emailVerifiedAt,
  };
}

async function me(req, res, next) {
  try {
    const [educations, experiences, skills] = await Promise.all([
      prisma.candidateEducation.findMany({ where: { candidateId: req.candidate.id }, orderBy: { endYear: 'desc' } }),
      prisma.candidateExperience.findMany({ where: { candidateId: req.candidate.id }, orderBy: { startDate: 'desc' } }),
      prisma.candidateSkill.findMany({ where: { candidateId: req.candidate.id }, orderBy: { name: 'asc' } }),
    ]);
    res.json({ candidate: publicCandidate(req.candidate), educations, experiences, skills });
  } catch (e) { next(e); }
}

async function updateMe(req, res, next) {
  try {
    const b = req.body || {};
    const data = {};
    for (const k of ['firstName', 'lastName', 'phone', 'headline', 'location', 'linkedinUrl']) {
      if (b[k] !== undefined) data[k] = b[k] === null ? null : String(b[k]);
    }
    if (b.totalExperienceMonths !== undefined) data.totalExperienceMonths = b.totalExperienceMonths == null ? null : Math.max(0, parseInt(b.totalExperienceMonths, 10) || 0);
    const c = await prisma.candidate.update({ where: { id: req.candidate.id }, data });
    res.json({ candidate: publicCandidate(c) });
  } catch (e) { next(e); }
}

// Generic child-collection CRUD (education / experience / skill), scoped to the
// authed candidate. `model` is the prisma delegate; `fields` the allowed columns.
function childHandlers(modelName, fields) {
  const delegate = () => prisma[modelName];
  return {
    async create(req, res, next) {
      try {
        const data = { candidateId: req.candidate.id };
        for (const [k, coerce] of Object.entries(fields)) if (req.body && req.body[k] !== undefined) data[k] = coerce(req.body[k]);
        const row = await delegate().create({ data });
        res.status(201).json(row);
      } catch (e) { next(e); }
    },
    async update(req, res, next) {
      try {
        const owned = await delegate().findFirst({ where: { id: req.params.id, candidateId: req.candidate.id } });
        if (!owned) return res.status(404).json({ message: 'Not found' });
        const data = {};
        for (const [k, coerce] of Object.entries(fields)) if (req.body && req.body[k] !== undefined) data[k] = coerce(req.body[k]);
        const row = await delegate().update({ where: { id: owned.id }, data });
        res.json(row);
      } catch (e) { next(e); }
    },
    async remove(req, res, next) {
      try {
        const owned = await delegate().findFirst({ where: { id: req.params.id, candidateId: req.candidate.id } });
        if (!owned) return res.status(404).json({ message: 'Not found' });
        await delegate().delete({ where: { id: owned.id } });
        res.json({ ok: true });
      } catch (e) { next(e); }
    },
  };
}
const str = (v) => (v == null ? null : String(v));
const intOrNull = (v) => (v == null || v === '' ? null : parseInt(v, 10));
const boolOf = (v) => !!v;
const dateOrNull = (v) => (v ? new Date(v) : null);

const education = childHandlers('candidateEducation', {
  level: str, institution: str, fieldOfStudy: str, startYear: intOrNull, endYear: intOrNull, grade: str, isHighest: boolOf,
});
const experience = childHandlers('candidateExperience', {
  company: str, title: str, employmentType: str, location: str, startDate: dateOrNull, endDate: dateOrNull, isCurrent: boolOf, description: str,
});
const skill = childHandlers('candidateSkill', { name: str, level: str });

// Resume upload (candidate-authed) → S3 → candidate.resumeUrl.
async function uploadResume(req, res, next) {
  try {
    const dataUrl = (req.body && (req.body.resumeDataUrl || req.body.fileBase64)) || '';
    const chk = pub.validateResumeDataUrl(dataUrl);
    if (!chk.ok) return res.status(chk.status).json({ message: chk.message });
    if (!s3.isConfigured()) return res.status(503).json({ message: 'Resume uploads are temporarily unavailable.' });
    const up = await s3.uploadDataUrl({ dataUrl, businessId: req.candidate.businessId, scope: 'resume' });
    const c = await prisma.candidate.update({ where: { id: req.candidate.id }, data: { resumeUrl: up.url } });
    res.json({ resumeUrl: c.resumeUrl });
  } catch (e) { next(e); }
}

// ── careers board (entitlement-gated wrappers over the F12 public reads) ─────────
async function board(req, res, next) {
  try {
    const biz = await resolveEntitledBusiness(req.params.slug);
    if (!biz) return res.status(404).json({ message: 'Careers page not found' });
    const jobs = await prisma.job.findMany({
      where: { businessId: biz.id, deletedAt: null, isPublic: true, status: 'OPEN' },
      orderBy: { publishedAt: 'desc' },
      select: { id: true, title: true, publicSlug: true, countryCode: true, employmentType: true, openings: true, publishedAt: true },
    });
    res.json({ business: { name: biz.name, slug: biz.slug }, items: jobs });
  } catch (e) { next(e); }
}

async function jobDetail(req, res, next) {
  try {
    const biz = await resolveEntitledBusiness(req.params.slug);
    if (!biz) return res.status(404).json({ message: 'Careers page not found' });
    const job = await prisma.job.findFirst({
      where: { businessId: biz.id, publicSlug: req.params.publicSlug, deletedAt: null, isPublic: true, status: 'OPEN' },
      select: { id: true, title: true, description: true, countryCode: true, employmentType: true, openings: true, publicSlug: true },
    });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    res.json({ business: { name: biz.name, slug: biz.slug }, job });
  } catch (e) { next(e); }
}

// ── smart apply ─────────────────────────────────────────────────────────────────
// POST /careers/:slug/jobs/:publicSlug/apply
//   authed candidate → one-click reuse of the saved profile (optional resume swap).
//   guest email:  NEW → apply + auto-account + magic link; EXISTING → email a link to
//                 continue with the saved profile (don't create a blind duplicate).
async function apply(req, res, next) {
  try {
    const biz = await resolveEntitledBusiness(req.params.slug);
    if (!biz) return res.status(404).json({ message: 'Careers page not found' });
    const job = await prisma.job.findFirst({
      where: { businessId: biz.id, publicSlug: req.params.publicSlug, deletedAt: null, isPublic: true, status: 'OPEN' }, select: { id: true },
    });
    if (!job) return res.status(404).json({ message: 'Job not found' });

    const authed = await (async () => {
      const token = auth.readCandidateToken(req);
      if (!token) return null;
      try {
        const d = auth.verifyTyped(token, 'candidate');
        if (d.businessId !== biz.id) return null;
        return prisma.candidate.findFirst({ where: { id: d.candidateId, businessId: biz.id, deletedAt: null } });
      } catch (_e) { return null; }
    })();

    const b = req.body || {};
    // resume (optional): a per-application snapshot; authed swap or guest upload.
    let resumeUrl = authed ? authed.resumeUrl : null;
    if (b.resumeDataUrl) {
      const chk = pub.validateResumeDataUrl(b.resumeDataUrl);
      if (!chk.ok) return res.status(chk.status).json({ message: chk.message });
      if (!s3.isConfigured()) return res.status(503).json({ message: 'Resume uploads are temporarily unavailable.' });
      try { resumeUrl = (await s3.uploadDataUrl({ dataUrl: b.resumeDataUrl, businessId: biz.id, scope: 'resume' })).url; }
      catch { return res.status(503).json({ message: 'Resume upload failed — try again.' }); }
    }

    let candidate = authed;
    if (!candidate) {
      const email = String(b.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ message: 'A valid email is required' });
      if (!b.consent) return res.status(422).json({ message: 'Consent to data processing is required to apply' });
      if (pub.applyRateLimited({ ip: req.ip, businessId: biz.id, jobId: job.id, email })) {
        return res.status(429).json({ message: 'Too many applications. Please try again in a minute.' });
      }
      const existing = await prisma.candidate.findFirst({ where: { businessId: biz.id, email, deletedAt: null } });
      if (existing) {
        // returning candidate — don't create a blind duplicate; send them a link to
        // continue with their saved profile and apply in one click.
        await emailMagicLink(req, biz, email, auth.signMagicToken({ businessId: biz.id, email }));
        return res.status(200).json({ needsAuth: true, existing: true, message: 'Looks like you’ve applied before with this email. We’ve emailed you a secure link to continue with your saved details.' });
      }
      candidate = await prisma.candidate.create({
        data: {
          businessId: biz.id, email, firstName: b.firstName || '', lastName: b.lastName || '',
          phone: b.phone || null, resumeUrl, source: 'careers-portal', consentAt: new Date(),
        },
      });
    } else if (resumeUrl && resumeUrl !== authed.resumeUrl) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { resumeUrl } });
    }

    const firstStage = await prisma.jobStage.findFirst({ where: { businessId: biz.id, jobId: job.id }, orderBy: { sortOrder: 'asc' } });
    let application;
    try {
      application = await prisma.application.create({
        data: {
          businessId: biz.id, jobId: job.id, candidateId: candidate.id,
          currentStageId: firstStage ? firstStage.id : null,
          status: 'APPLIED', appliedSource: 'CAREER_PORTAL', resumeUrl: resumeUrl || candidate.resumeUrl || null,
        },
      });
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ message: 'You have already applied to this role. Sign in to track its status.' });
      throw e;
    }

    // auto-score screening answers (never leaked), same engine as the F12 public apply.
    if (Array.isArray(b.answers) && b.answers.length) {
      try {
        const appRow = await prisma.application.findFirst({ where: { id: application.id, businessId: biz.id }, include: { job: true } });
        await scoringCtl._internals.recordAnswersAndScore(biz.id, appRow, b.answers);
      } catch { /* scoring never blocks apply */ }
    }

    // guest apply → email a magic link so they can return + track status.
    if (!authed) await emailMagicLink(req, biz, candidate.email, auth.signMagicToken({ businessId: biz.id, email: candidate.email }));
    return res.status(201).json({ ok: true, applied: true, message: 'Thank you for applying. We’ll be in touch.' });
  } catch (e) { next(e); }
}

// GET /candidate/applications — the candidate's own application status timeline.
async function myApplications(req, res, next) {
  try {
    const apps = await prisma.application.findMany({
      where: { candidateId: req.candidate.id, businessId: req.candidate.businessId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, createdAt: true, updatedAt: true, job: { select: { title: true, publicSlug: true } } },
    });
    res.json({ items: apps });
  } catch (e) { next(e); }
}

module.exports = {
  requestMagicLink, verifyMagicLink, logout,
  me, updateMe, uploadResume, myApplications,
  education, experience, skill,
  board, jobDetail, apply,
};
