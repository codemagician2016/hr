'use strict';

/**
 * survey.service.js — Feature 33 survey authoring + lifecycle + results assembly.
 * Pure-ish over Prisma; HTTP shaping lives in the controllers (announcement pattern).
 *
 * REUSE, not fork: audience columns are IDENTICAL to Announcement so
 * engagement/audience.js (SCOPE / resolveAudienceEmployees) is used verbatim;
 * normaliseAudience mirrors announcements.service.js (persist ONLY the id-array of
 * the active scope so a scope flip can't leak a stale wide audience); publish is the
 * announcement lifecycle (future-datable publishedAt + idempotent notifiedAt fan-out)
 * plus occurrence #1 (the response cohort).
 *
 * ANONYMITY invariants owned here:
 *   - `anonymous` is IMMUTABLE once any response exists (409 ANONYMITY_LOCKED).
 *   - every aggregate this module emits is k-suppressed via the pure enps.js module
 *     (total AND per-segment), verbatims are gated + label-free + shuffled (§6.5).
 */

const crypto = require('crypto');
const prisma = require('../../../core/lib/prisma');
const { SCOPE, resolveAudienceEmployees } = require('../audience');
const { notifyHrEvent } = require('../../integrations/notifications');
const { computeEnps, aggregateQuestion, segmentBreakdown } = require('./enps');

const SCOPES = new Set(['ALL', 'ENTITY', 'DEPARTMENT', 'SPECIFIC']);
const TYPES = new Set(['PULSE', 'ENPS', 'CUSTOM']);
const QUESTION_TYPES = new Set(['SCALE', 'LIKERT', 'NPS', 'SINGLE', 'MULTI', 'TEXT']);
const CADENCES = new Set(['WEEKLY', 'FORTNIGHTLY', 'MONTHLY', 'QUARTERLY']);
const ESS_SURVEYS_LINK = '/surveys';

// ── input normalisation (announcement pattern) ───────────────────────────────
function clampStr(v, max) {
  if (v == null) return v;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function normaliseAudience(input = {}) {
  const scope = SCOPES.has(input.audienceScope) ? input.audienceScope : SCOPE.ALL;
  const arr = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x))] : []);
  return {
    audienceScope: scope,
    // Persist ONLY the array relevant to the scope (scope-flip-safe, announcement rule).
    audienceEntityIds:   scope === SCOPE.ENTITY ? arr(input.audienceEntityIds) : [],
    audienceDeptIds:     scope === SCOPE.DEPARTMENT ? arr(input.audienceDeptIds) : [],
    audienceEmployeeIds: scope === SCOPE.SPECIFIC ? arr(input.audienceEmployeeIds) : [],
  };
}

// ── question validation (§5.1) ───────────────────────────────────────────────
function validateQuestions(surveyType, questions) {
  if (!Array.isArray(questions) || !questions.length) return { ok: false, error: 'At least one question is required' };
  let enpsDrivers = 0;
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i] || {};
    const at = `Question ${i + 1}`;
    if (!QUESTION_TYPES.has(q.type)) return { ok: false, error: `${at}: unknown type "${q.type}"` };
    if (!q.prompt || !String(q.prompt).trim()) return { ok: false, error: `${at}: prompt is required` };
    if (q.type === 'SCALE' || q.type === 'LIKERT') {
      const lo = Number(q.scaleMin); const hi = Number(q.scaleMax);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return { ok: false, error: `${at}: scaleMin and scaleMax are required` };
      if (lo >= hi) return { ok: false, error: `${at}: scaleMin must be < scaleMax` };
    }
    if (q.type === 'SINGLE' || q.type === 'MULTI') {
      const opts = q.options;
      if (!Array.isArray(opts) || !opts.length) return { ok: false, error: `${at}: options must be a non-empty array` };
      const values = new Set();
      for (const o of opts) {
        if (!o || typeof o.value !== 'string' || !o.value || typeof o.label !== 'string' || !o.label) {
          return { ok: false, error: `${at}: each option needs a { value, label }` };
        }
        if (values.has(o.value)) return { ok: false, error: `${at}: duplicate option value "${o.value}"` };
        values.add(o.value);
      }
    }
    if (q.isEnpsDriver) {
      if (q.type !== 'NPS') return { ok: false, error: `${at}: only an NPS question can be the eNPS driver` };
      enpsDrivers += 1;
    }
  }
  // eNPS computation only runs on the flagged driver — an ENPS survey needs EXACTLY one.
  if (surveyType === 'ENPS' && enpsDrivers !== 1) {
    return { ok: false, error: 'An ENPS survey requires exactly one NPS question flagged isEnpsDriver' };
  }
  if (enpsDrivers > 1) return { ok: false, error: 'Only one question may be flagged isEnpsDriver' };
  return { ok: true };
}

function questionRows(businessId, questions) {
  return questions.map((q, i) => ({
    businessId,
    section: q.section ? clampStr(String(q.section).trim(), 120) : null,
    orderIndex: Number.isInteger(q.orderIndex) ? q.orderIndex : i,
    type: q.type,
    prompt: clampStr(String(q.prompt).trim(), 2000),
    required: q.required !== false,
    // NPS bounds are PINNED 0..10 by the service regardless of client input.
    scaleMin: q.type === 'NPS' ? 0 : (Number.isInteger(q.scaleMin) ? q.scaleMin : null),
    scaleMax: q.type === 'NPS' ? 10 : (Number.isInteger(q.scaleMax) ? q.scaleMax : null),
    scaleMinLabel: q.scaleMinLabel ? clampStr(String(q.scaleMinLabel), 120) : null,
    scaleMaxLabel: q.scaleMaxLabel ? clampStr(String(q.scaleMaxLabel), 120) : null,
    options: (q.type === 'SINGLE' || q.type === 'MULTI')
      ? q.options.map((o) => ({ value: o.value, label: o.label }))
      : undefined,
    allowOther: !!q.allowOther,
    isEnpsDriver: !!q.isEnpsDriver,
  }));
}

// ── survey-level validation ──────────────────────────────────────────────────
function validate(input = {}, { partial = false } = {}) {
  if (!partial) {
    if (!input.title || !String(input.title).trim()) return { ok: false, error: 'title is required' };
  }
  if (input.type != null && !TYPES.has(input.type)) return { ok: false, error: `Unknown type "${input.type}"` };
  if (input.audienceScope != null && !SCOPES.has(input.audienceScope)) return { ok: false, error: `Unknown audienceScope "${input.audienceScope}"` };
  const scope = input.audienceScope;
  if (scope === SCOPE.ENTITY && !(Array.isArray(input.audienceEntityIds) && input.audienceEntityIds.length))
    return { ok: false, error: 'ENTITY audience requires audienceEntityIds' };
  if (scope === SCOPE.DEPARTMENT && !(Array.isArray(input.audienceDeptIds) && input.audienceDeptIds.length))
    return { ok: false, error: 'DEPARTMENT audience requires audienceDeptIds' };
  if (scope === SCOPE.SPECIFIC && !(Array.isArray(input.audienceEmployeeIds) && input.audienceEmployeeIds.length))
    return { ok: false, error: 'SPECIFIC audience requires audienceEmployeeIds' };
  if (input.cadence != null && input.cadence !== '' && !CADENCES.has(input.cadence))
    return { ok: false, error: `Unknown cadence "${input.cadence}"` };
  if (input.windowDays != null && !(Number.isInteger(input.windowDays) && input.windowDays >= 1 && input.windowDays <= 90))
    return { ok: false, error: 'windowDays must be an integer between 1 and 90' };
  if (input.minResponsesToShow != null && !(Number.isInteger(input.minResponsesToShow) && input.minResponsesToShow >= 1 && input.minResponsesToShow <= 100))
    return { ok: false, error: 'minResponsesToShow must be an integer between 1 and 100' };
  if (input.cadenceAnchorDay != null && !(Number.isInteger(input.cadenceAnchorDay) && input.cadenceAnchorDay >= 1 && input.cadenceAnchorDay <= 31))
    return { ok: false, error: 'cadenceAnchorDay must be an integer between 1 and 31' };
  for (const k of ['publishedAt', 'closesAt', 'recurrenceEndsAt']) {
    if (input[k] != null && input[k] !== '' && Number.isNaN(Date.parse(input[k])))
      return { ok: false, error: `${k} must be a valid ISO date` };
  }
  return { ok: true };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────
async function create({ businessId, author, input }) {
  const v = validate(input);
  if (!v.ok) return { error: v.error };
  const type = TYPES.has(input.type) ? input.type : 'PULSE';
  const qv = validateQuestions(type, input.questions);
  if (!qv.ok) return { error: qv.error };
  const aud = normaliseAudience(input);
  const survey = await prisma.survey.create({
    data: {
      businessId,
      authorUserId: author.id,
      authorName: author.name || null,
      title: clampStr(String(input.title).trim(), 300),
      description: input.description ? clampStr(String(input.description), 5000) : null,
      type,
      anonymous: input.anonymous !== false, // default TRUE — anonymity is the default posture
      minResponsesToShow: Number.isInteger(input.minResponsesToShow) ? input.minResponsesToShow : 5,
      ...aud,
      status: 'DRAFT',
      publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
      closesAt: input.closesAt ? new Date(input.closesAt) : null,
      cadence: CADENCES.has(input.cadence) ? input.cadence : null,
      cadenceAnchorDay: Number.isInteger(input.cadenceAnchorDay) ? input.cadenceAnchorDay : null,
      windowDays: Number.isInteger(input.windowDays) ? input.windowDays : 7,
      recurrenceEndsAt: input.recurrenceEndsAt ? new Date(input.recurrenceEndsAt) : null,
      questions: { create: questionRows(businessId, input.questions) },
    },
    include: { questions: { orderBy: { orderIndex: 'asc' } } },
  });
  return { survey };
}

async function update({ businessId, id, input }) {
  const existing = await prisma.survey.findFirst({ where: { id, businessId } });
  if (!existing) return { notFound: true };
  const v = validate(input, { partial: true });
  if (!v.ok) return { error: v.error };

  // Optimistic version lock — a stale editor loses (announcement `version` column).
  if (input.version != null && Number(input.version) !== existing.version) {
    return { conflict: 'VERSION_CONFLICT' };
  }

  const responseCount = await prisma.surveyResponse.count({ where: { surveyId: existing.id, businessId } });

  // ANONYMITY IMMUTABILITY (§5.1) — you can't publish anonymous, collect honest
  // answers, then flip to attributed. Locked the moment ANY response exists.
  if (input.anonymous != null && !!input.anonymous !== existing.anonymous && responseCount > 0) {
    return { conflict: 'ANONYMITY_LOCKED' };
  }

  const nextType = TYPES.has(input.type) ? input.type : existing.type;
  let replaceQuestions = null;
  if (input.questions !== undefined) {
    // Question-set edits are DRAFT-only: rewriting questions under collected ballots
    // would corrupt every aggregate the dashboard shows.
    if (existing.status !== 'DRAFT' || responseCount > 0) {
      return { error: 'Questions can only be edited while the survey is a DRAFT with no responses' };
    }
    const qv = validateQuestions(nextType, input.questions);
    if (!qv.ok) return { error: qv.error };
    replaceQuestions = questionRows(businessId, input.questions);
  } else if (input.type != null && input.type !== existing.type && input.type === 'ENPS') {
    // Type flip to ENPS must still satisfy the exactly-one-driver rule.
    const qs = await prisma.surveyQuestion.findMany({ where: { surveyId: existing.id }, select: { type: true, isEnpsDriver: true } });
    const drivers = qs.filter((q) => q.isEnpsDriver && q.type === 'NPS').length;
    if (drivers !== 1) return { error: 'An ENPS survey requires exactly one NPS question flagged isEnpsDriver' };
  }

  const data = {};
  if (input.title != null) data.title = clampStr(String(input.title).trim(), 300);
  if (input.description !== undefined) data.description = input.description ? clampStr(String(input.description), 5000) : null;
  if (input.type != null) data.type = nextType;
  if (input.anonymous != null) data.anonymous = !!input.anonymous;
  if (input.minResponsesToShow != null) data.minResponsesToShow = input.minResponsesToShow;
  if (input.audienceScope != null) Object.assign(data, normaliseAudience(input));
  if (input.publishedAt !== undefined) data.publishedAt = input.publishedAt ? new Date(input.publishedAt) : null;
  if (input.closesAt !== undefined) data.closesAt = input.closesAt ? new Date(input.closesAt) : null;
  if (input.cadence !== undefined) data.cadence = CADENCES.has(input.cadence) ? input.cadence : null;
  if (input.cadenceAnchorDay !== undefined) data.cadenceAnchorDay = Number.isInteger(input.cadenceAnchorDay) ? input.cadenceAnchorDay : null;
  if (input.windowDays != null) data.windowDays = input.windowDays;
  if (input.recurrenceEndsAt !== undefined) data.recurrenceEndsAt = input.recurrenceEndsAt ? new Date(input.recurrenceEndsAt) : null;
  data.version = { increment: 1 };

  const survey = await prisma.$transaction(async (tx) => {
    if (replaceQuestions) {
      await tx.surveyQuestion.deleteMany({ where: { surveyId: existing.id } });
      data.questions = { create: replaceQuestions };
    }
    return tx.survey.update({
      where: { id: existing.id },
      data,
      include: { questions: { orderBy: { orderIndex: 'asc' } } },
    });
  });
  return { survey };
}

// ── segment-label helpers (the ONLY identity→label bridge, used at submit time) ──
/** The survey's single coarse breakdown dimension. ENTITY-scoped surveys break down
 *  by entity; everything else by department (one dimension, never a tuple — §4.5). */
function breakdownDimension(survey) {
  return survey && survey.audienceScope === SCOPE.ENTITY ? 'ENTITY' : 'DEPARTMENT';
}

/** Resolve the coarse bucket NAME (a string, never an id) for an employee's current
 *  segment, per the survey's breakdown dimension. Null when unassigned. */
async function segmentLabelFor({ businessId, survey, segment }) {
  const dim = breakdownDimension(survey);
  if (dim === 'ENTITY') {
    if (!segment || !segment.entityId) return null;
    const e = await prisma.entity.findFirst({
      where: { id: segment.entityId, businessId },
      select: { tradeName: true, legalName: true, code: true },
    });
    return e ? (e.tradeName || e.legalName || e.code || null) : null;
  }
  if (!segment || !segment.departmentId) return null;
  const d = await prisma.department.findFirst({
    where: { id: segment.departmentId, businessId },
    select: { name: true },
  });
  return d ? (d.name || null) : null;
}

// ── lifecycle ────────────────────────────────────────────────────────────────
function addDaysMs(d, days) { return new Date(new Date(d).getTime() + days * 86400000); }

/**
 * Publish — DRAFT → PUBLISHED. Stamps publishedAt (may be FUTURE → scheduled go-live,
 * no cron needed to open); creates occurrence #1 (opensAt=publishedAt,
 * closesAt=opensAt+windowDays, invitedCount=|audience|); fans out invites ONLY when
 * live now, stamping notifiedAt in the same write (idempotent — never re-blasts).
 * Returns { survey, occurrence, notified, warning? }.
 */
async function publish({ businessId, id, now = new Date() }) {
  const existing = await prisma.survey.findFirst({ where: { id, businessId } });
  if (!existing) return { notFound: true };
  if (existing.status === 'CLOSED' || existing.status === 'ARCHIVED') {
    return { error: `A ${existing.status} survey cannot be published` };
  }
  const publishedAt = existing.publishedAt || now;

  // Occurrence #1 window: honour an explicit closesAt after go-live, else windowDays.
  const occCloses = (existing.closesAt && existing.closesAt > publishedAt)
    ? existing.closesAt
    : addDaysMs(publishedAt, existing.windowDays || 7);

  const audience = await resolveAudienceEmployees(existing).catch(() => []);
  const invitedCount = audience.length;

  // Occurrence #1 — idempotent via @@unique([surveyId, seq]).
  let occurrence = await prisma.surveyOccurrence.findFirst({ where: { surveyId: existing.id, seq: 1 } });
  if (!occurrence) {
    occurrence = await prisma.surveyOccurrence.create({
      data: {
        businessId, surveyId: existing.id, seq: 1,
        opensAt: publishedAt, closesAt: occCloses, status: 'OPEN', invitedCount,
      },
    }).catch(async (e) => {
      if (e && e.code === 'P2002') return prisma.surveyOccurrence.findFirst({ where: { surveyId: existing.id, seq: 1 } });
      throw e;
    });
  }

  // IDEMPOTENCY — fan out ONLY on the first go-live (announcement rule): prior state
  // not PUBLISHED and never notified. Future-dated publishes stay silent; the schedule
  // runner fires their invites when the time comes (edge case 4).
  const firstPublish = existing.status !== 'PUBLISHED' && existing.notifiedAt == null;
  const isLiveNow = publishedAt <= now;
  const willNotify = firstPublish && isLiveNow;

  const survey = await prisma.survey.update({
    where: { id: existing.id },
    data: {
      status: 'PUBLISHED',
      publishedAt,
      closesAt: existing.cadence ? existing.closesAt : occCloses,
      archivedAt: null,
      version: { increment: 1 },
      ...(willNotify ? { notifiedAt: now } : {}),
    },
  });

  let notified = 0;
  if (willNotify && occurrence) {
    notified = await fanOutInvites(survey, occurrence, audience).catch(() => 0);
  }

  const warning = (survey.anonymous && invitedCount < survey.minResponsesToShow)
    ? `Audience of ${invitedCount} is below the anonymity floor of ${survey.minResponsesToShow}; results will stay hidden`
    : undefined;
  return { survey, occurrence, notified, warning };
}

/** Manual close — PUBLISHED → CLOSED; closes any OPEN occurrence. */
async function close({ businessId, id, now = new Date() }) {
  const existing = await prisma.survey.findFirst({ where: { id, businessId } });
  if (!existing) return { notFound: true };
  if (existing.status !== 'PUBLISHED') return { error: 'Only a PUBLISHED survey can be closed' };
  await prisma.surveyOccurrence.updateMany({
    where: { surveyId: existing.id, status: 'OPEN' },
    data: { status: 'CLOSED', closesAt: now },
  });
  const survey = await prisma.survey.update({
    where: { id: existing.id },
    data: { status: 'CLOSED', closesAt: now, version: { increment: 1 } },
  });
  notifySurveyClosed(survey).catch(() => {});
  return { survey };
}

async function archive({ businessId, id }) {
  const existing = await prisma.survey.findFirst({ where: { id, businessId } });
  if (!existing) return { notFound: true };
  await prisma.surveyOccurrence.updateMany({
    where: { surveyId: existing.id, status: 'OPEN' },
    data: { status: 'CLOSED', closesAt: new Date() },
  });
  const survey = await prisma.survey.update({
    where: { id: existing.id },
    data: { status: 'ARCHIVED', archivedAt: new Date(), version: { increment: 1 } },
  });
  return { survey };
}

// ── operator list / detail ───────────────────────────────────────────────────
async function adminList({ businessId, status, type, page = 1, pageSize = 25 }) {
  const where = { businessId };
  if (status && ['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED'].includes(status)) where.status = status;
  if (type && TYPES.has(type)) where.type = type;
  const take = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;
  const [items, total] = await Promise.all([
    prisma.survey.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { questions: true, occurrences: true } } },
      skip, take,
    }),
    prisma.survey.count({ where }),
  ]);
  return { items, total, page: Math.max(1, Number(page) || 1), pageSize: take };
}

async function getSurvey({ businessId, id }) {
  const survey = await prisma.survey.findFirst({
    where: { id, businessId },
    include: {
      questions: { orderBy: { orderIndex: 'asc' } },
      occurrences: { orderBy: { seq: 'desc' } },
    },
  });
  if (!survey) return { notFound: true };
  return { survey };
}

// ── notification fan-out ─────────────────────────────────────────────────────
async function bizNameOf(businessId) {
  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } }).catch(() => null);
  return (biz && biz.name) || 'your employer';
}

function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }

/**
 * Fan survey invitations out to the audience (survey.invited). Best-effort per
 * recipient; respects the per-employee notifyPrefs opt-out (announcement rule).
 * Returns the number of recipients notified. Never throws.
 */
async function fanOutInvites(survey, occurrence, recipients = null) {
  let audience = recipients;
  if (!audience) {
    try { audience = await resolveAudienceEmployees(survey); } catch (_e) { audience = []; }
  }
  if (!audience.length) return 0;
  const bizName = await bizNameOf(survey.businessId);
  const anonymityNote = survey.anonymous
    ? 'Your responses are anonymous and cannot be traced back to you.'
    : 'Responses on this survey are attributed to you.';
  let sent = 0;
  for (const emp of audience) {
    const prefs = emp.notifyPrefs || null;
    if (prefs && prefs.optOut === true) continue;
    const email = emp.workEmail || emp.personalEmail || null;
    const phone = emp.phone || null;
    if (!email && !phone) continue;
    notifyHrEvent({
      businessId: survey.businessId,
      event: 'survey.invited',
      recipientEmail: email,
      recipientPhone: phone,
      recipientCountry: emp.countryCode || undefined,
      variables: {
        employeeName: emp.firstName || 'there',
        businessName: bizName,
        surveyTitle: survey.title,
        closesOn: isoDay(occurrence.closesAt),
        anonymityNote,
        link: ESS_SURVEYS_LINK,
      },
      triggeredBy: `HR_SURVEY_INVITED:${occurrence.id}:${emp.id}`,
    }).catch(() => {});
    sent += 1;
  }
  return sent;
}

/** Tell the author their survey (occurrence) closed, with the response tally. */
async function notifySurveyClosed(survey, occurrence = null) {
  const author = await prisma.user.findUnique({
    where: { id: survey.authorUserId },
    select: { email: true, name: true },
  }).catch(() => null);
  if (!author || !author.email) return 0;
  const occ = occurrence
    || await prisma.surveyOccurrence.findFirst({ where: { surveyId: survey.id }, orderBy: { seq: 'desc' } });
  const responseCount = occ
    ? await prisma.surveyParticipation.count({ where: { occurrenceId: occ.id, state: 'SUBMITTED' } })
    : 0;
  const invited = occ ? occ.invitedCount : 0;
  await notifyHrEvent({
    businessId: survey.businessId,
    event: 'survey.closed',
    recipientEmail: author.email,
    variables: {
      surveyTitle: survey.title,
      occurrenceSeq: String(occ ? occ.seq : 1),
      responseCount: String(responseCount),
      responseRate: String(invited > 0 ? Math.round((responseCount / invited) * 100) : 0),
      invitedCount: String(invited),
      link: `/hr/surveys/${survey.id}/results`,
    },
    triggeredBy: `HR_SURVEY_CLOSED:${survey.id}${occ ? `:${occ.id}` : ''}`,
  }).catch(() => {});
  return 1;
}

// ── results assembly (all k-suppressed via the pure module) ──────────────────
async function resolveOccurrence({ businessId, surveyId, occurrenceId }) {
  if (occurrenceId) {
    return prisma.surveyOccurrence.findFirst({ where: { id: occurrenceId, surveyId, businessId } });
  }
  return prisma.surveyOccurrence.findFirst({ where: { surveyId, businessId }, orderBy: { seq: 'desc' } });
}

function publicQuestion(q) {
  return {
    id: q.id, section: q.section, orderIndex: q.orderIndex, type: q.type,
    prompt: q.prompt, required: q.required,
    scaleMin: q.scaleMin, scaleMax: q.scaleMax,
    scaleMinLabel: q.scaleMinLabel, scaleMaxLabel: q.scaleMaxLabel,
    options: q.options || null, allowOther: q.allowOther, isEnpsDriver: q.isEnpsDriver,
  };
}

/**
 * Dashboard JSON for one occurrence (default: latest): per-question aggregates
 * (k-suppressed), response rate (§6.4 — participation, never content), and the
 * anonymity floor so the UI can render the "hidden to protect anonymity" tooltips.
 */
async function getResults({ businessId, id, occurrenceId = null }) {
  const survey = await prisma.survey.findFirst({
    where: { id, businessId },
    include: { questions: { orderBy: { orderIndex: 'asc' } } },
  });
  if (!survey) return { notFound: true };
  const occ = await resolveOccurrence({ businessId, surveyId: survey.id, occurrenceId });
  if (!occ) return { survey: { id: survey.id, title: survey.title, type: survey.type, anonymous: survey.anonymous, minResponsesToShow: survey.minResponsesToShow }, occurrence: null, questions: [] };

  const k = survey.minResponsesToShow;
  const [responses, submitted] = await Promise.all([
    prisma.surveyResponse.findMany({
      where: { businessId, occurrenceId: occ.id },
      select: { id: true, answers: { select: { questionId: true, numericValue: true, choiceValues: true, textValue: true } } },
    }),
    prisma.surveyParticipation.count({ where: { occurrenceId: occ.id, state: 'SUBMITTED' } }),
  ]);
  const answersByQuestion = new Map();
  for (const r of responses) {
    for (const a of r.answers) {
      if (!answersByQuestion.has(a.questionId)) answersByQuestion.set(a.questionId, []);
      answersByQuestion.get(a.questionId).push(a);
    }
  }
  return {
    survey: {
      id: survey.id, title: survey.title, type: survey.type,
      anonymous: survey.anonymous, minResponsesToShow: k,
      status: survey.status, cadence: survey.cadence,
    },
    occurrence: {
      id: occ.id, seq: occ.seq, opensAt: occ.opensAt, closesAt: occ.closesAt,
      status: occ.status, invitedCount: occ.invitedCount,
      responseCount: submitted,
      responseRate: occ.invitedCount > 0 ? Math.round((submitted / occ.invitedCount) * 100) : 0,
    },
    questions: survey.questions.map((q) => ({
      ...publicQuestion(q),
      aggregate: aggregateQuestion(q, answersByQuestion.get(q.id) || [], { k }),
    })),
  };
}

/** eNPS trend — one point per occurrence for the driver question; a thin occurrence
 *  inherits k-suppression (a gap, never a fabricated number). */
async function getTrend({ businessId, id }) {
  const survey = await prisma.survey.findFirst({
    where: { id, businessId },
    include: { questions: { where: { isEnpsDriver: true }, take: 1 } },
  });
  if (!survey) return { notFound: true };
  const driver = survey.questions[0] || null;
  if (!driver) return { surveyId: survey.id, driverQuestionId: null, points: [] };

  const occurrences = await prisma.surveyOccurrence.findMany({
    where: { surveyId: survey.id, businessId },
    orderBy: { seq: 'asc' },
  });
  const k = survey.minResponsesToShow;
  const points = [];
  for (const occ of occurrences) {
    const answers = await prisma.surveyAnswer.findMany({
      where: { questionId: driver.id, response: { is: { occurrenceId: occ.id } } },
      select: { numericValue: true },
    });
    const scores = answers.map((a) => a.numericValue).filter((v) => v != null);
    const e = computeEnps(scores, k);
    points.push({
      occurrenceId: occ.id, seq: occ.seq, opensAt: occ.opensAt, closesAt: occ.closesAt,
      status: occ.status,
      ...(e.suppressed ? { suppressed: true } : { enps: e.enps, promoters: e.promoters, passives: e.passives, detractors: e.detractors, total: e.total }),
    });
  }
  return { surveyId: survey.id, driverQuestionId: driver.id, points };
}

/**
 * k-anonymised segment breakdown (§6.3): group by the snapshotted segmentLabel,
 * aggregate ONE question per group (default: the eNPS driver, else the first
 * non-TEXT question), suppress below-k groups + the complement guard. TEXT
 * questions are never segmentable (free text is excluded from segment views).
 */
async function getSegments({ businessId, id, occurrenceId = null, questionId = null }) {
  const survey = await prisma.survey.findFirst({
    where: { id, businessId },
    include: { questions: { orderBy: { orderIndex: 'asc' } } },
  });
  if (!survey) return { notFound: true };
  const occ = await resolveOccurrence({ businessId, surveyId: survey.id, occurrenceId });
  if (!occ) return { dimension: breakdownDimension(survey), groups: [], suppressedGroups: 0, questionId: null };

  let question = null;
  if (questionId) {
    question = survey.questions.find((q) => q.id === questionId) || null;
    if (!question) return { notFound: true };
    if (question.type === 'TEXT') return { error: 'Free-text questions cannot be broken down by segment' };
  } else {
    question = survey.questions.find((q) => q.isEnpsDriver)
      || survey.questions.find((q) => q.type !== 'TEXT')
      || null;
  }
  if (!question) return { error: 'No segmentable question on this survey' };

  const responses = await prisma.surveyResponse.findMany({
    where: { businessId, occurrenceId: occ.id },
    select: {
      segmentLabel: true,
      answers: { where: { questionId: question.id }, select: { numericValue: true, choiceValues: true, textValue: true } },
    },
  });
  const k = survey.minResponsesToShow;
  const out = segmentBreakdown(
    responses,
    breakdownDimension(survey),
    k,
    (rows) => ({ aggregate: aggregateQuestion(question, rows.flatMap((r) => r.answers), { k }) }),
  );
  return { ...out, occurrenceId: occ.id, questionId: question.id, questionPrompt: question.prompt, minResponsesToShow: k };
}

/**
 * Gated free-text verbatims (§6.5): requires the explicit acknowledgement flag,
 * shown WITHOUT segment labels, in RANDOMISED order, and only when the occurrence
 * has ≥k text responses. Includes TEXT answers + SINGLE/MULTI "Other" free text.
 */
async function getVerbatims({ businessId, id, occurrenceId = null, acknowledged = false }) {
  if (!acknowledged) return { ackRequired: true };
  const survey = await prisma.survey.findFirst({
    where: { id, businessId },
    include: { questions: { orderBy: { orderIndex: 'asc' } } },
  });
  if (!survey) return { notFound: true };
  const occ = await resolveOccurrence({ businessId, surveyId: survey.id, occurrenceId });
  if (!occ) return { suppressed: true, verbatims: [] };

  const answers = await prisma.surveyAnswer.findMany({
    where: {
      textValue: { not: null },
      response: { is: { businessId, occurrenceId: occ.id } },
    },
    select: { questionId: true, textValue: true, responseId: true },
  });
  const withText = answers.filter((a) => a.textValue && String(a.textValue).trim() !== '');
  // ≥k DISTINCT text respondents, else nothing (a lone comment is trivially identifying).
  const distinctResponses = new Set(withText.map((a) => a.responseId)).size;
  if (distinctResponses < survey.minResponsesToShow) return { suppressed: true, verbatims: [] };

  const promptById = new Map(survey.questions.map((q) => [q.id, q.prompt]));
  // Randomise (crypto Fisher–Yates) so output order can never correlate with
  // submission order — and return NO responseId, NO segment label, NO timestamps.
  const items = withText.map((a) => ({ questionId: a.questionId, prompt: promptById.get(a.questionId) || null, text: a.textValue }));
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return { suppressed: false, occurrenceId: occ.id, verbatims: items };
}

module.exports = {
  SCOPES, TYPES, QUESTION_TYPES, CADENCES,
  validate, validateQuestions, normaliseAudience,
  breakdownDimension, segmentLabelFor,
  create, update, publish, close, archive,
  adminList, getSurvey,
  fanOutInvites, notifySurveyClosed,
  getResults, getTrend, getSegments, getVerbatims,
  _internals: { questionRows, addDaysMs, isoDay },
};
