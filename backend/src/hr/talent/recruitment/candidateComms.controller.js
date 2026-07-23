'use strict';

/**
 * candidateComms.controller.js — Feature 36 authed recruiter surface:
 *   - interview slot-proposal handshake (propose / withdraw)   §4.5
 *   - bulk candidate messaging over the scoped/filtered set      §4.3
 *   - candidate-template library CRUD (per-tenant body override) §4.4
 *   - per-tenant candidate-comms config                          §4.4
 *
 * Every write is tenant-scoped (req.user.businessId) + F1 read-scope
 * (req.recruitmentScope) exactly like the rest of the recruitment surface.
 *
 * Template library REUSES the P1.6 tenant-override mechanism (TenantMessageTemplate
 * body override, token-validated) rather than mutating the GLOBAL MessageTemplate
 * row (which is shared across all tenants). The in-code HR_TEMPLATES registry stays
 * the authority for keys + declared variables + default copy + channel flags; an
 * override replaces the rendered BODY only, and the router already respects the
 * template's channel toggles. (See §4.4 deviation note.)
 */

const crypto = require('crypto');
const prisma = require('../../../core/lib/prisma');
const { scopeAllowsJob, accessibleJobIds } = require('./recruitmentScope');
const { fanOutCandidateStage } = require('./candidateNotify');
const slots = require('./slots');
const { HR_TEMPLATES } = require('../../integrations/notifications');
const recruitmentCtl = require('../controllers/recruitment.controller');
const { applicationFilterWhere, scopeApplicationWhere } = recruitmentCtl._internals;

// The Feature-36 candidate-template library: the 8 HR_CAND_*/HR_INTERVIEW_* keys.
const F36_TEMPLATE_KEYS = Object.freeze([
  'HR_CAND_APPLIED', 'HR_CAND_SHORTLISTED', 'HR_CAND_INTERVIEW_INVITE',
  'HR_CAND_SLOT_REQUEST', 'HR_CAND_REJECTED', 'HR_CAND_OFFER',
  'HR_INTERVIEW_PANEL', 'HR_INTERVIEW_FEEDBACK_NUDGE',
]);
// Only candidate-facing keys may be bulk-sent (panel/feedback go to employees).
const BULK_ALLOWED_KEYS = Object.freeze([
  'HR_CAND_APPLIED', 'HR_CAND_SHORTLISTED', 'HR_CAND_INTERVIEW_INVITE',
  'HR_CAND_SLOT_REQUEST', 'HR_CAND_REJECTED', 'HR_CAND_OFFER',
]);

const MAX_BODY = 2000;
const SLOT_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const tplByKey = new Map(HR_TEMPLATES.map((t) => [t.key, t]));

// Best-effort audit (never throws into the request path).
async function audit(businessId, actorId, action, entityType, entityId, meta) {
  try {
    await prisma.auditLog.create({ data: {
      businessId, action, entityType, entityId: entityId || null, actorId: actorId || null, meta: meta || undefined,
    } });
  } catch { /* audit is best-effort */ }
}

// Extract {TOKEN} placeholders from a body.
function tokensOf(body) {
  const out = new Set();
  const re = /\{([A-Za-z0-9_]+)\}/g;
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return [...out];
}

// ═══════════════════════════════════════════════════════════════════════════
// (A) INTERVIEW SLOT PROPOSAL — propose / withdraw (§4.5)
// ═══════════════════════════════════════════════════════════════════════════

// POST /interviews/:id/propose-slots — create a PROPOSED slot proposal + fan out
// candidate.slot_request (the pick-a-time link). canManage + scope.
async function proposeSlots(req, res, next) {
  try {
    const { businessId } = req.user;
    const iv = await prisma.interview.findFirst({
      where: { id: req.params.id, businessId },
      include: { application: { include: { candidate: true, job: true } } },
    });
    if (!iv) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllowsJob(req.recruitmentScope, iv.application && iv.application.job)) {
      return res.status(404).json({ message: 'Not found' });
    }
    const norm = slots.normalizeProposedSlots(req.body.slots);
    if (norm.error) return res.status(422).json({ message: norm.error });

    let expiresAt = new Date(Date.now() + SLOT_DEFAULT_TTL_MS);
    if (req.body.expiresAt) {
      const d = new Date(req.body.expiresAt);
      if (!Number.isNaN(+d)) expiresAt = d;
    }

    const proposal = await prisma.interviewSlotProposal.create({
      data: {
        businessId, interviewId: iv.id, slots: norm.slots,
        status: 'PROPOSED', proposedById: req.user.id || null, expiresAt,
      },
    });

    // Fire the "pick a slot" message — explicit operator action → bypass the gate.
    if (iv.application) {
      fanOutCandidateStage({
        businessId, application: iv.application, event: 'candidate.slot_request',
        force: true, candidate: iv.application.candidate, job: iv.application.job,
      }).catch(() => { /* fire-and-forget */ });
    }
    await audit(businessId, req.user.id, 'recruitment.interview.propose-slots', 'InterviewSlotProposal', proposal.id, { interviewId: iv.id, count: norm.slots.length });
    res.status(201).json({
      id: proposal.id, interviewId: proposal.interviewId, status: proposal.status,
      slots: proposal.slots, expiresAt: proposal.expiresAt, createdAt: proposal.createdAt,
    });
  } catch (e) { next(e); }
}

// POST /interviews/:id/withdraw-slots — mark the active PROPOSED proposal WITHDRAWN
// (optionally a specific :proposalId in the body). canManage + scope.
async function withdrawSlots(req, res, next) {
  try {
    const { businessId } = req.user;
    const iv = await prisma.interview.findFirst({
      where: { id: req.params.id, businessId },
      include: { application: { select: { job: { select: { hiringManagerId: true } } } } },
    });
    if (!iv) return res.status(404).json({ message: 'Not found' });
    if (!scopeAllowsJob(req.recruitmentScope, iv.application && iv.application.job)) {
      return res.status(404).json({ message: 'Not found' });
    }
    const where = { businessId, interviewId: iv.id, status: 'PROPOSED' };
    if (req.body && req.body.proposalId) where.id = String(req.body.proposalId);
    const upd = await prisma.interviewSlotProposal.updateMany({ where, data: { status: 'WITHDRAWN' } });
    await audit(businessId, req.user.id, 'recruitment.interview.withdraw-slots', 'Interview', iv.id, { withdrawn: upd.count });
    res.json({ withdrawn: upd.count });
  } catch (e) { next(e); }
}

// ═══════════════════════════════════════════════════════════════════════════
// (B) BULK CANDIDATE MESSAGING (§4.3) — reuses bulkApplicationAction's resolution
// ═══════════════════════════════════════════════════════════════════════════

// Derive a stable-per-run bulk id so an accidental double-submit within a ~10-min
// window dedupes, while a deliberate later run (or an explicit bulkRunId) re-sends.
function defaultBulkRunId(templateKey, filter, ids) {
  const win = Math.floor(Date.now() / (10 * 60 * 1000));
  const basis = JSON.stringify({ templateKey, filter: filter || {}, ids: ids || null });
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 12) + `:w${win}`;
}

// POST /applications/bulk-message — message the CURRENT filtered + scoped set.
async function bulkMessage(req, res, next) {
  try {
    const { businessId } = req.user;
    const body = req.body || {};
    const templateKey = String(body.templateKey || '');
    if (!BULK_ALLOWED_KEYS.includes(templateKey)) {
      return res.status(400).json({ message: `templateKey must be one of: ${BULK_ALLOWED_KEYS.join(', ')}` });
    }

    // SAME server-side resolution as bulkApplicationAction (never trust the client).
    const filter = body.filter || {};
    const reach = await accessibleJobIds(businessId, req.recruitmentScope);
    const where = { businessId, ...applicationFilterWhere(filter) };
    scopeApplicationWhere(where, reach, filter.jobId);
    if (Array.isArray(body.ids) && body.ids.length) where.id = { in: body.ids.map(String) };

    const targets = await prisma.application.findMany({
      where, select: { id: true, status: true, jobId: true, candidateId: true },
    });
    if (!targets.length) return res.json({ sent: 0, skipped: 0, total: 0 });

    const runId = body.bulkRunId ? String(body.bulkRunId) : defaultBulkRunId(templateKey, filter, body.ids);
    const extraVars = (body.vars && typeof body.vars === 'object') ? body.vars : {};

    let sent = 0; let skipped = 0;
    for (const a of targets) {
      // Explicit operator action → force past the auto-send gate; one-off templateKey.
      const r = await fanOutCandidateStage({
        businessId,
        application: { id: a.id, status: a.status, candidateId: a.candidateId, jobId: a.jobId },
        event: templateKey, // pseudo-event → distinct dedupe stage per template
        templateKey,
        force: true,
        dedupeSuffix: runId,
        extraVars,
      });
      if (r && r.sent) sent += 1; else skipped += 1;
    }

    await audit(businessId, req.user.id, 'recruitment.application.bulk.message', 'Application', null, {
      templateKey, sent, skipped, total: targets.length, jobIds: [...new Set(targets.map((t) => t.jobId))], filter, runId,
    });
    res.json({ sent, skipped, total: targets.length });
  } catch (e) { next(e); }
}

// ═══════════════════════════════════════════════════════════════════════════
// (C) CANDIDATE-TEMPLATE LIBRARY (§4.4) — per-tenant body overrides
// ═══════════════════════════════════════════════════════════════════════════

// GET /comms-templates — the 8 F36 keys ⋈ this tenant's overrides.
async function listCommsTemplates(req, res, next) {
  try {
    const { businessId } = req.user;
    const overrides = await prisma.tenantMessageTemplate.findMany({
      where: { businessId, templateKey: { in: F36_TEMPLATE_KEYS } },
    });
    const byKey = new Map(overrides.map((o) => [o.templateKey, o]));
    const items = F36_TEMPLATE_KEYS.map((key) => {
      const t = tplByKey.get(key);
      const o = byKey.get(key) || null;
      return {
        key,
        displayName: t.displayName,
        category: t.category,
        variables: t.variables,
        channels: t.channels,
        isSystem: true, // the 8 are system templates: editable copy, not deletable
        defaultBody: t.body,
        overrideBody: o && o.isActive ? o.body : null,
        overridden: !!(o && o.isActive),
        updatedAt: o ? o.updatedAt : null,
      };
    });
    res.json({ items });
  } catch (e) { next(e); }
}

// PUT /comms-templates/:key — upsert the tenant body override. Validates every
// {TOKEN} against the template's declared allow-list (an unknown token 422s so a
// send never fails at runtime mid-pipeline, §7.7).
async function updateCommsTemplate(req, res, next) {
  try {
    const { businessId, id: userId } = req.user;
    const key = req.params.key;
    const t = tplByKey.get(key);
    if (!t || !F36_TEMPLATE_KEYS.includes(key)) return res.status(404).json({ message: 'Unknown candidate template.' });

    const b = req.body || {};
    // Publish/archive flips the override's isActive (archived → falls back to stock).
    if (b.body === undefined && typeof b.isActive === 'boolean') {
      const row = await prisma.tenantMessageTemplate.upsert({
        where: { businessId_templateKey: { businessId, templateKey: key } },
        create: { businessId, templateKey: key, body: t.body, isActive: b.isActive, updatedByUserId: userId || null },
        update: { isActive: b.isActive, updatedByUserId: userId || null },
      });
      return res.json({ key, overrideBody: row.body, overridden: row.isActive });
    }

    const bodyText = typeof b.body === 'string' ? b.body : '';
    if (!bodyText.trim()) return res.status(400).json({ message: 'body is required' });
    if (bodyText.length > MAX_BODY) return res.status(400).json({ message: `body too long (${MAX_BODY} max).` });
    const unknown = tokensOf(bodyText).filter((tok) => !t.variables.includes(tok));
    if (unknown.length) {
      return res.status(422).json({
        message: `Unknown token(s) ${unknown.map((x) => `{${x}}`).join(', ')} — this template provides: ${t.variables.map((v) => `{${v}}`).join(', ')}.`,
        unknownTokens: unknown,
      });
    }
    const isActive = b.isActive === undefined ? true : !!b.isActive;
    const row = await prisma.tenantMessageTemplate.upsert({
      where: { businessId_templateKey: { businessId, templateKey: key } },
      create: { businessId, templateKey: key, body: bodyText.trim(), isActive, updatedByUserId: userId || null },
      update: { body: bodyText.trim(), isActive, updatedByUserId: userId || null },
    });
    await audit(businessId, userId, 'recruitment.comms-template.update', 'TenantMessageTemplate', row.id, { key });
    res.json({ key, overrideBody: row.body, overridden: row.isActive });
  } catch (e) { next(e); }
}

// DELETE /comms-templates/:key — reset the copy to the system default (the system
// key itself is never deleted — the 8 are editable-but-not-deletable, §4.4).
async function resetCommsTemplate(req, res, next) {
  try {
    const { businessId } = req.user;
    const key = req.params.key;
    if (!F36_TEMPLATE_KEYS.includes(key)) return res.status(404).json({ message: 'Unknown candidate template.' });
    await prisma.tenantMessageTemplate.deleteMany({ where: { businessId, templateKey: key } });
    await audit(businessId, req.user.id, 'recruitment.comms-template.reset', 'TenantMessageTemplate', null, { key });
    res.status(204).end();
  } catch (e) { next(e); }
}

// ═══════════════════════════════════════════════════════════════════════════
// (D) PER-TENANT CANDIDATE-COMMS CONFIG (§4.4)
// ═══════════════════════════════════════════════════════════════════════════
const STAGE_KEYS = ['applied', 'shortlisted', 'interview_invite', 'slot_request', 'offer', 'rejected'];

// GET /comms-config — the tenant's candidateCommsConfig (with the effective defaults).
async function getCommsConfig(req, res, next) {
  try {
    const { businessId } = req.user;
    const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { candidateCommsConfig: true } });
    const { AUTO_SEND_DEFAULTS } = require('./candidateNotify')._internals;
    res.json({
      config: (biz && biz.candidateCommsConfig) || {},
      defaults: { autoSend: AUTO_SEND_DEFAULTS },
    });
  } catch (e) { next(e); }
}

// PUT /comms-config — write the tenant's candidateCommsConfig (auto-send toggles,
// replyTo, senderName). Unknown stage keys are dropped; values coerced to bool.
async function updateCommsConfig(req, res, next) {
  try {
    const { businessId } = req.user;
    const b = req.body || {};
    const cfg = {};
    if (b.autoSend && typeof b.autoSend === 'object') {
      const autoSend = {};
      for (const k of STAGE_KEYS) if (typeof b.autoSend[k] === 'boolean') autoSend[k] = b.autoSend[k];
      cfg.autoSend = autoSend;
    }
    if (b.replyTo !== undefined) cfg.replyTo = b.replyTo ? String(b.replyTo).slice(0, 200) : null;
    if (b.senderName !== undefined) cfg.senderName = b.senderName ? String(b.senderName).slice(0, 120) : null;
    const updated = await prisma.business.update({
      where: { id: businessId }, data: { candidateCommsConfig: cfg }, select: { candidateCommsConfig: true },
    });
    await audit(businessId, req.user.id, 'recruitment.comms-config.update', 'Business', businessId, { autoSend: cfg.autoSend || null });
    res.json({ config: updated.candidateCommsConfig });
  } catch (e) { next(e); }
}

module.exports = {
  proposeSlots, withdrawSlots,
  bulkMessage,
  listCommsTemplates, updateCommsTemplate, resetCommsTemplate,
  getCommsConfig, updateCommsConfig,
  _internals: { F36_TEMPLATE_KEYS, BULK_ALLOWED_KEYS, tokensOf, defaultBulkRunId },
};
