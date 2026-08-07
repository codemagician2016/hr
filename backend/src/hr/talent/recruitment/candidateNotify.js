'use strict';

/**
 * candidateNotify.js — Feature 36 candidate-side notification fan-out.
 *
 * The MIRROR of hr/approvals/notify.js, but for the CANDIDATE recipient — who is
 * NOT an Employee/User. There is no session, no notifyPrefs map, and no in-app
 * inbox: a candidate's only contact is Candidate.email / Candidate.phone, and the
 * only opt-out is the router's universal STOP list + the tenant budget engine
 * (candidateNotify can only suppress at the auto-send gate, never bypass those).
 *
 * It does NOT introduce a transport. Every candidate message rides the EXISTING
 * router via notifyHrEvent() → sendNotification(), exactly like approvals/notify.js,
 * and REUSES that module's atomic dedupe helpers (claimDedupe/releaseDedupe over
 * HrNotifyDedupe) + its dispatchOne verbatim for the stage-event path.
 *
 * Guarantees (identical to approvals/notify.js):
 *   - BEST-EFFORT / NON-BLOCKING: fanOutCandidateStage NEVER throws; call-sites
 *     fire-and-forget so a notify failure can never break an apply / stage-move /
 *     offer-send / interview-confirm transaction.
 *   - TENANT-SAFE: every read is scoped by businessId.
 *   - IDEMPOTENT: a deterministic dedupe token (CAND_<stage>:<appId>:<status>)
 *     makes a re-fired identical stage transition a no-op.
 *   - GATED: auto-send is governed by Job.commsConfig.autoSend[stage] ??
 *     Business.candidateCommsConfig.autoSend[stage] ?? a per-stage default
 *     (ON for applied/shortlisted/interview_invite/slot_request/offer; OFF for
 *     rejected). An explicit operator action (bulk message, propose-slots) passes
 *     force:true and bypasses the gate.
 */

const crypto = require('crypto');
const prisma = require('../../../core/lib/prisma');
const { adminAppBaseUrl } = require('../../../core/lib/appUrls');
const { notifyHrEvent } = require('../../integrations/notifications');
// REUSE the approvals fan-out internals verbatim: dispatchOne (contact → prefs →
// atomic dedupe → router) + the claimDedupe/releaseDedupe helpers over HrNotifyDedupe.
const approvals = require('../../approvals/notify')._internals;

// Optional careers-host resolver (tenant subdomain) — same helper the recruitment
// controller's public-link builder uses, so the status link tracks staging/prod.
let _hostForSlug;
try { ({ hostForSlug: _hostForSlug } = require('../../../core/lib/subdomainProvision')); } catch { _hostForSlug = null; }

// ── auto-send defaults (per stage) ────────────────────────────────────────────
// Default ON for the "good news / expected" touch-points; default OFF for the
// rejection message (HR opt-in — a bulk reject must never silently email 200
// candidates unless the tenant turned it on). §4.2 / §7.1.
const AUTO_SEND_DEFAULTS = Object.freeze({
  applied: true,
  shortlisted: true,
  interview_invite: true,
  slot_request: true,
  offer: true,
  rejected: false,
});

// event name → stage key (the token used in the gate + the dedupe token). Only
// `candidate.*` events are gated; interview.* events (panel/feedback) are not.
function stageKeyForEvent(event) {
  const e = String(event || '');
  if (e.startsWith('candidate.')) return e.slice('candidate.'.length);
  return null;
}

// PURE auto-send decision (unit-tested). Precedence: per-job override → tenant
// default → the hard-coded per-stage default. Only a real boolean overrides; a
// missing/typed-wrong entry falls through to the next level.
function autoSendDecision({ stage, jobConfig, bizConfig }) {
  const pick = (cfg) => {
    const m = cfg && cfg.autoSend;
    if (m && typeof m === 'object' && typeof m[stage] === 'boolean') return m[stage];
    return undefined;
  };
  const j = pick(jobConfig);
  if (j !== undefined) return j;
  const b = pick(bizConfig);
  if (b !== undefined) return b;
  return AUTO_SEND_DEFAULTS[stage] !== undefined ? AUTO_SEND_DEFAULTS[stage] : true;
}

// PURE dedupe-token builder (unit-tested). CAND_<stage>:<appId>:<status>[:<suffix>]
// — a re-fired identical transition (same stage, same app, same status) is a
// no-op; a deliberate different run (bulk) supplies a distinct suffix.
function buildCandidateDedupeToken({ event, applicationId, status, suffix }) {
  const stage = stageKeyForEvent(event) || String(event || 'EVENT').replace(/[^a-zA-Z0-9_]/g, '_');
  const base = `CAND_${stage}:${applicationId}:${status || ''}`;
  return suffix ? `${base}:${suffix}` : base;
}

function candidateName(cand) {
  if (!cand) return null;
  const n = `${cand.firstName || ''} ${cand.lastName || ''}`.trim();
  return n || cand.email || null;
}

// The public careers base URL for a tenant (subdomain host if resolvable, else
// the platform URL). Trailing slash trimmed.
function careersBaseUrl(slug) {
  try {
    if (_hostForSlug && slug) {
      const h = _hostForSlug(slug);
      if (h) return `https://${h}`;
    }
  } catch { /* fall through */ }
  const base = process.env.NEXT_PUBLIC_PLATFORM_URL || process.env.FRONTEND_URL;
  if (base) return String(base).replace(/\/$/, '');
  return `https://${process.env.PLATFORM_DOMAIN || 'drifthr.com'}`;
}

/**
 * The tenant's public careers BOARD — the one link a recruiter shares.
 *
 * Two shapes, both shipped and resolvable, and the caller must render exactly ONE:
 *   hostForSlug resolves → https://<slug>-staging.drifthr.com/careers (staging) or
 *     https://<slug>.drifthr.com/careers (prod). The tenant is resolved FROM THE
 *     HOST, which is why the ESS careers routes carry no slug segment.
 *   hostForSlug unavailable (env unset on a box) → <platformBase>/careers/<slug>,
 *     the admin-app board, which carries the slug explicitly because the shared
 *     platform host cannot resolve a tenant on its own.
 * careersBaseUrl(null) is deliberate in the fallback: passing the slug would send
 * it back through hostForSlug, which we already know did not resolve.
 */
function careersBoardUrl(slug) {
  if (!slug) return null;
  try {
    if (_hostForSlug) {
      const h = _hostForSlug(slug);
      if (h) return `https://${h}/careers`;
    }
  } catch { /* fall through to the platform-host shape */ }
  return `${careersBaseUrl(null)}/careers/${encodeURIComponent(slug)}`;
}

// The candidate status/timeline link carried as {LINK} in every candidate message.
//
// DRIFTHR-1002. This used careersBaseUrl(slug) — the TENANT host — and ALSO kept
// the /<slug>/ segment, mixing the two shapes careersBoardUrl documents above as
// mutually exclusive. The result, https://<slug>.drifthr.com/careers/<slug>/c/…,
// 404'd: the tenant host serves the ESS careers routes, which carry no slug
// segment AND have no /c/<token> page at all. Only the admin app has it. Measured:
//
//   demo.drifthr.com/careers/demo/c/<tok>      404   <- what we were sending
//   demo.drifthr.com/careers/c/<tok>           404   (no such ESS route)
//   drifthr.com/careers/demo/c/<tok>           404   (platform host)
//   app.drifthr.com/careers/demo/c/<tok>       200   <- the page that exists
//
// The BOARD link is unaffected and still correctly tenant-hosted
// (demo.drifthr.com/careers → 200) — only this per-candidate page moves.
function candidateStatusLink(slug, token) {
  if (!slug || !token) return '';
  return `${adminAppBaseUrl()}/careers/${encodeURIComponent(slug)}/c/${encodeURIComponent(token)}`;
}

// Mint (or return the existing) single-candidate public access token. One live
// token per candidate (unique candidateId). Best-effort: on any error returns null
// so a missing token degrades the {LINK} rather than breaking the fan-out.
async function ensureCandidateToken(businessId, candidateId) {
  if (!businessId || !candidateId) return null;
  try {
    const existing = await prisma.candidateAccessToken.findUnique({ where: { candidateId } });
    if (existing && existing.token) return existing.token;
    const token = crypto.randomBytes(24).toString('hex');
    const row = await prisma.candidateAccessToken.create({ data: { businessId, candidateId, token } });
    return row.token;
  } catch (_e) {
    // race (unique candidateId) — re-read the winner.
    const again = await prisma.candidateAccessToken.findUnique({ where: { candidateId } }).catch(() => null);
    return again ? again.token : null;
  }
}

// Build the merge variables for a candidate template. A superset with safe
// defaults (unused tokens are ignored by the renderer); extraVars overrides.
function buildVars({ cand, job, bizName, link, extraVars }) {
  const base = {
    NAME: candidateName(cand) || 'there',
    ROLE: (job && job.title) || 'the role',
    BIZ: bizName || 'the company',
    LINK: link || '',
    MODE: '',
    SLOTLINE: '',
    EXPIRY: '',
  };
  return { ...base, ...(extraVars || {}) };
}

// Core single-candidate dispatch. For the pure stage-event path we REUSE the
// approvals dispatchOne verbatim (candidate-shaped recipient; applyPrefs collapses
// to {email,phone} since prefs is null). For a one-off templateKey (bulk message)
// dispatchOne can't carry a templateKey, so we mirror it locally, reusing the SAME
// claimDedupe/releaseDedupe helpers. NEVER throws.
async function dispatchCandidate({ businessId, recipient, event, templateKey, variables, dedupeToken }) {
  if (!templateKey) {
    return approvals.dispatchOne({ businessId, recipient, event, variables, dedupeToken });
  }
  try {
    if (!recipient) return { ok: false, reason: 'NO_RECIPIENT' };
    if (!recipient.email && !recipient.phone) return { ok: false, reason: 'NO_CONTACT' };
    const claimed = await approvals.claimDedupe(businessId, dedupeToken);
    if (!claimed) return { ok: true, reason: 'ALREADY_SENT', deduped: true };
    const res = await notifyHrEvent({
      businessId,
      templateKey,
      recipientEmail: recipient.email || null,
      recipientPhone: recipient.phone || null,
      recipientCountry: recipient.country || undefined,
      variables,
      triggeredBy: dedupeToken,
    });
    if (dedupeToken && !(res && res.ok)) await approvals.releaseDedupe(businessId, dedupeToken);
    return res || { ok: false, reason: 'NO_RESULT' };
  } catch (e) {
    if (dedupeToken) await approvals.releaseDedupe(businessId, dedupeToken);
    return { ok: false, reason: 'DISPATCH_ERROR', error: e && e.message };
  }
}

/**
 * fanOutCandidateStage — send ONE candidate stage message, best-effort.
 *
 * @param {object} args
 *   businessId   — tenant
 *   application  — { id, status, candidateId, jobId } (may also carry .candidate/.job)
 *   event        — 'candidate.applied' | 'candidate.shortlisted' | … (see §4.1)
 *   extraVars    — extra merge vars (MODE/SLOTLINE/EXPIRY/…)
 *   force        — bypass the auto-send gate (explicit operator action)
 *   templateKey  — one-off template override (bulk message; skips the event→key map)
 *   dedupeSuffix — appended to the dedupe token (a bulk re-run supplies a runId)
 *   biz          — optional { slug, name, candidateCommsConfig } to avoid a re-read
 *   job          — optional pre-loaded job row
 *   candidate    — optional pre-loaded candidate row
 * @returns {Promise<{sent:number, skipped:number, gated?:boolean, reason?:string}>}
 */
async function fanOutCandidateStage({
  businessId, application, event, extraVars = {}, force = false,
  templateKey = null, dedupeSuffix = '', biz = null, job = null, candidate = null,
}) {
  const summary = { sent: 0, skipped: 0 };
  try {
    if (!businessId || !application || !application.id || !application.candidateId) {
      summary.skipped = 1; summary.reason = 'NO_APPLICATION'; return summary;
    }

    const cand = candidate || await prisma.candidate.findFirst({
      where: { businessId, id: application.candidateId },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true },
    });
    if (!cand) { summary.skipped = 1; summary.reason = 'NO_CANDIDATE'; return summary; }

    const jobRow = job || (application.job || await prisma.job.findFirst({
      where: { businessId, id: application.jobId },
      select: { id: true, title: true, countryCode: true, commsConfig: true },
    }));

    const bizRow = biz || await prisma.business.findUnique({
      where: { id: businessId },
      select: { slug: true, name: true, candidateCommsConfig: true },
    });

    // ── auto-send gate (candidate.* events only; interview.* + force bypass) ──
    const stage = stageKeyForEvent(event);
    if (!force && stage) {
      const allowed = autoSendDecision({
        stage,
        jobConfig: jobRow && jobRow.commsConfig,
        bizConfig: bizRow && bizRow.candidateCommsConfig,
      });
      if (!allowed) { summary.skipped = 1; summary.gated = true; return summary; }
    }

    // ── status link (mint the candidate token if needed) ──
    const token = await ensureCandidateToken(businessId, cand.id);
    const link = candidateStatusLink(bizRow && bizRow.slug, token);

    const variables = buildVars({
      cand, job: jobRow, bizName: bizRow && bizRow.name, link, extraVars,
    });

    const recipient = {
      employeeId: null,
      name: candidateName(cand),
      email: cand.email || null,
      phone: cand.phone || null,
      country: (jobRow && jobRow.countryCode) || null,
      prefs: null, // no candidate-side prefs; STOP-list + budget engine govern downstream
    };

    const dedupeToken = buildCandidateDedupeToken({
      event, applicationId: application.id, status: application.status, suffix: dedupeSuffix,
    });

    const r = await dispatchCandidate({ businessId, recipient, event, templateKey, variables, dedupeToken });
    if (r && r.ok) summary.sent = 1; else { summary.skipped = 1; summary.reason = r && r.reason; }
  } catch (_e) { /* best-effort — never throws into the caller's response */ }
  return summary;
}

module.exports = {
  fanOutCandidateStage,
  ensureCandidateToken,
  candidateStatusLink,
  // exported for reuse (controllers/runners) + unit tests
  _internals: {
    AUTO_SEND_DEFAULTS,
    stageKeyForEvent,
    autoSendDecision,
    buildCandidateDedupeToken,
    candidateName,
    buildVars,
    careersBaseUrl,
    careersBoardUrl,
    dispatchCandidate,
  },
};
