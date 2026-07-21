'use strict';

/**
 * surveysAdmin.controller.js — Feature 33 operator authoring + results surface,
 * mounted at /api/hr/surveys. OPERATOR session (req.user); every route is
 * requirePermission('canManageSurveys') (Owner + HR-Admin). Tenant isolation:
 * businessId from req.user on every service call (no cross-tenant read/write).
 *
 * HTTP status mapping (service → wire):
 *   { notFound }                    → 404
 *   { error }                       → 400
 *   { conflict: 'VERSION_CONFLICT'
 *            | 'ANONYMITY_LOCKED' } → 409
 *   { ackRequired }                 → 400 VERBATIM_ACK_REQUIRED (§6.5 gate)
 */

const svc = require('../surveys/survey.service');

function publicSurvey(s) {
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    type: s.type,
    anonymous: s.anonymous,
    minResponsesToShow: s.minResponsesToShow,
    audienceScope: s.audienceScope,
    audienceEntityIds: s.audienceEntityIds || [],
    audienceDeptIds: s.audienceDeptIds || [],
    audienceEmployeeIds: s.audienceEmployeeIds || [],
    status: s.status,
    publishedAt: s.publishedAt,
    closesAt: s.closesAt,
    cadence: s.cadence,
    cadenceAnchorDay: s.cadenceAnchorDay,
    windowDays: s.windowDays,
    recurrenceEndsAt: s.recurrenceEndsAt,
    archivedAt: s.archivedAt,
    authorName: s.authorName,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    version: s.version,
    ...(s.questions ? {
      questions: s.questions.map((q) => ({
        id: q.id, section: q.section, orderIndex: q.orderIndex, type: q.type,
        prompt: q.prompt, required: q.required,
        scaleMin: q.scaleMin, scaleMax: q.scaleMax,
        scaleMinLabel: q.scaleMinLabel, scaleMaxLabel: q.scaleMaxLabel,
        options: q.options || null, allowOther: q.allowOther, isEnpsDriver: q.isEnpsDriver,
      })),
    } : {}),
    ...(s.occurrences ? {
      occurrences: s.occurrences.map((o) => ({
        id: o.id, seq: o.seq, opensAt: o.opensAt, closesAt: o.closesAt,
        status: o.status, invitedCount: o.invitedCount,
      })),
    } : {}),
    ...(s._count ? { questionCount: s._count.questions, occurrenceCount: s._count.occurrences } : {}),
  };
}

function sendConflict(res, out) {
  if (out.conflict === 'ANONYMITY_LOCKED') {
    return res.status(409).json({ code: 'ANONYMITY_LOCKED', message: 'Anonymity cannot be changed once responses exist' });
  }
  return res.status(409).json({ code: out.conflict, message: 'The survey changed under you — reload and retry' });
}

// GET /surveys — list (paginated, status/type filter).
async function list(req, res, next) {
  try {
    const { businessId } = req.user;
    const { status, type, page, pageSize } = req.query || {};
    const out = await svc.adminList({ businessId, status, type, page, pageSize });
    return res.json({ items: out.items.map(publicSurvey), total: out.total, page: out.page, pageSize: out.pageSize });
  } catch (e) { return next(e); }
}

// GET /surveys/:id — detail with questions + occurrences.
async function get(req, res, next) {
  try {
    const { businessId } = req.user;
    const out = await svc.getSurvey({ businessId, id: req.params.id });
    if (out.notFound) return res.status(404).json({ message: 'Survey not found' });
    return res.json({ survey: publicSurvey(out.survey) });
  } catch (e) { return next(e); }
}

// POST /surveys — create a DRAFT (template + questions + audience + schedule).
async function create(req, res, next) {
  try {
    const { businessId } = req.user;
    const author = { id: req.user.id, name: req.user.name || null };
    const out = await svc.create({ businessId, author, input: req.body || {} });
    if (out.error) return res.status(400).json({ message: out.error });
    return res.status(201).json({ survey: publicSurvey(out.survey) });
  } catch (e) { return next(e); }
}

// PATCH /surveys/:id — edit (version-locked; anonymity-locked once responses exist).
async function update(req, res, next) {
  try {
    const { businessId } = req.user;
    const out = await svc.update({ businessId, id: req.params.id, input: req.body || {} });
    if (out.notFound) return res.status(404).json({ message: 'Survey not found' });
    if (out.conflict) return sendConflict(res, out);
    if (out.error) return res.status(400).json({ message: out.error });
    return res.json({ survey: publicSurvey(out.survey) });
  } catch (e) { return next(e); }
}

// POST /surveys/:id/publish — DRAFT→PUBLISHED (+ occurrence #1 + invites when live).
async function publish(req, res, next) {
  try {
    const { businessId } = req.user;
    const out = await svc.publish({ businessId, id: req.params.id });
    if (out.notFound) return res.status(404).json({ message: 'Survey not found' });
    if (out.error) return res.status(400).json({ message: out.error });
    return res.json({
      survey: publicSurvey(out.survey),
      occurrence: out.occurrence ? { id: out.occurrence.id, seq: out.occurrence.seq, opensAt: out.occurrence.opensAt, closesAt: out.occurrence.closesAt, invitedCount: out.occurrence.invitedCount } : null,
      notified: out.notified,
      ...(out.warning ? { warning: out.warning } : {}),
    });
  } catch (e) { return next(e); }
}

// POST /surveys/:id/close — PUBLISHED→CLOSED (closes open occurrences too).
async function close(req, res, next) {
  try {
    const { businessId } = req.user;
    const out = await svc.close({ businessId, id: req.params.id });
    if (out.notFound) return res.status(404).json({ message: 'Survey not found' });
    if (out.error) return res.status(400).json({ message: out.error });
    return res.json({ survey: publicSurvey(out.survey) });
  } catch (e) { return next(e); }
}

// POST /surveys/:id/archive — retire.
async function archive(req, res, next) {
  try {
    const { businessId } = req.user;
    const out = await svc.archive({ businessId, id: req.params.id });
    if (out.notFound) return res.status(404).json({ message: 'Survey not found' });
    return res.json({ survey: publicSurvey(out.survey) });
  } catch (e) { return next(e); }
}

// GET /surveys/:id/results?occurrenceId= — the k-suppressed dashboard JSON.
async function results(req, res, next) {
  try {
    const { businessId } = req.user;
    const out = await svc.getResults({ businessId, id: req.params.id, occurrenceId: req.query.occurrenceId || null });
    if (out.notFound) return res.status(404).json({ message: 'Survey not found' });
    return res.json(out);
  } catch (e) { return next(e); }
}

// GET /surveys/:id/results/trend — eNPS per occurrence (k-suppressed points).
async function trend(req, res, next) {
  try {
    const { businessId } = req.user;
    const out = await svc.getTrend({ businessId, id: req.params.id });
    if (out.notFound) return res.status(404).json({ message: 'Survey not found' });
    return res.json(out);
  } catch (e) { return next(e); }
}

// GET /surveys/:id/results/segments?dimension=&occurrenceId=&questionId= —
// k-anonymised breakdown (+ complement-leak guard). `dimension` is advisory: the
// stored segmentLabel IS the survey's single configured dimension.
async function segments(req, res, next) {
  try {
    const { businessId } = req.user;
    const out = await svc.getSegments({
      businessId, id: req.params.id,
      occurrenceId: req.query.occurrenceId || null,
      questionId: req.query.questionId || null,
    });
    if (out.notFound) return res.status(404).json({ message: 'Survey or question not found' });
    if (out.error) return res.status(400).json({ message: out.error });
    return res.json(out);
  } catch (e) { return next(e); }
}

// GET /surveys/:id/results/verbatims?occurrenceId=&ack=1 — gated free text (§6.5):
// explicit acknowledgement required; label-free, shuffled, ≥k text responses only.
async function verbatims(req, res, next) {
  try {
    const { businessId } = req.user;
    const ack = req.query.ack === '1' || req.query.ack === 'true';
    const out = await svc.getVerbatims({
      businessId, id: req.params.id,
      occurrenceId: req.query.occurrenceId || null,
      acknowledged: ack,
    });
    if (out.notFound) return res.status(404).json({ message: 'Survey not found' });
    if (out.ackRequired) {
      return res.status(400).json({
        code: 'VERBATIM_ACK_REQUIRED',
        message: 'Pass ack=1 to confirm you understand free-text answers may reduce anonymity',
      });
    }
    return res.json(out);
  } catch (e) { return next(e); }
}

module.exports = { list, get, create, update, publish, close, archive, results, trend, segments, verbatims };
