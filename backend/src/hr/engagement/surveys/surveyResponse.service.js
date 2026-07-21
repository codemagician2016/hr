'use strict';

/**
 * surveyResponse.service.js — Feature 33 THE ANONYMITY FIREWALL (§5.2).
 *
 * The one collection path for survey ballots. The invariants this file owns:
 *   1. For an ANONYMOUS survey, SurveyResponse.employeeId is ALWAYS written null —
 *      there is no code path that sets it (and no relation to join back).
 *   2. Identity only ever touches SurveyParticipation (the "already answered" ledger)
 *      which holds ZERO answer content. Content and identity never share a row.
 *   3. The segment snapshot is a single coarse NAME string (dept OR entity), taken at
 *      submit time — never an id, never a tuple.
 *   4. The caller gets back ONLY { receiptToken } — stored content tied to identity
 *      is never echoed.
 *
 * The subject employee is ALWAYS resolved server-side from the customer session
 * (meEngagement rule) — this module receives it, never a client-supplied id.
 */

const prisma = require('../../../core/lib/prisma');
const { SCOPE, resolveEmployeeSegment, audienceMatchesEmployee } = require('../audience');
const { segmentLabelFor } = require('./survey.service');

// ── ESS feed where (feedWhereForEmployee-shaped, §7) ─────────────────────────
/**
 * Prisma `where` over SurveyOccurrence for ONE employee's fillable list: OPEN +
 * inside the response window + parent survey PUBLISHED/live + in-audience. Mirrors
 * audience.feedWhereForEmployee (same OR-over-scopes clause) but targets the
 * occurrence row and uses the survey's closesAt-per-occurrence window instead of
 * Announcement.expiresAt. Tenant-scoped by businessId, always.
 */
function occurrenceFeedWhere({ businessId, employeeId, segment, now = new Date() }) {
  const audienceOr = [{ audienceScope: SCOPE.ALL }];
  if (segment && segment.entityId) {
    audienceOr.push({ audienceScope: SCOPE.ENTITY, audienceEntityIds: { has: segment.entityId } });
  }
  if (segment && segment.departmentId) {
    audienceOr.push({ audienceScope: SCOPE.DEPARTMENT, audienceDeptIds: { has: segment.departmentId } });
  }
  if (employeeId) {
    audienceOr.push({ audienceScope: SCOPE.SPECIFIC, audienceEmployeeIds: { has: employeeId } });
  }
  return {
    businessId,
    status: 'OPEN',
    opensAt: { lte: now },
    closesAt: { gt: now },
    survey: {
      is: {
        businessId,
        status: 'PUBLISHED',
        publishedAt: { not: null, lte: now },
        AND: [{ OR: audienceOr }],
      },
    },
  };
}

/** The employee's open occurrences + their Done/Pending/Dismissed badge. */
async function listForEmployee({ businessId, employeeId, now = new Date() }) {
  const segment = await resolveEmployeeSegment(businessId, employeeId);
  const where = occurrenceFeedWhere({ businessId, employeeId, segment, now });
  const occurrences = await prisma.surveyOccurrence.findMany({
    where,
    orderBy: { closesAt: 'asc' },
    include: {
      survey: { select: { id: true, title: true, description: true, type: true, anonymous: true, cadence: true } },
    },
    take: 100,
  });
  const ids = occurrences.map((o) => o.id);
  const parts = ids.length
    ? await prisma.surveyParticipation.findMany({
        where: { businessId, employeeId, occurrenceId: { in: ids } },
        select: { occurrenceId: true, state: true, submittedAt: true },
      })
    : [];
  const byOcc = new Map(parts.map((p) => [p.occurrenceId, p]));
  return occurrences.map((o) => {
    const p = byOcc.get(o.id) || null;
    return {
      occurrenceId: o.id,
      seq: o.seq,
      opensAt: o.opensAt,
      closesAt: o.closesAt,
      survey: o.survey,
      state: p ? p.state : 'PENDING', // Done ✓ (SUBMITTED) / Pending / Dismissed
      submittedAt: p ? p.submittedAt : null,
    };
  });
}

/**
 * The fill view — questions for one open occurrence. Rejects closed (SURVEY_CLOSED),
 * out-of-audience (notFound — no cross-audience existence leak), and already-submitted
 * (ALREADY_SUBMITTED). Lazily seeds the PENDING participation row on first view
 * (mirrors AnnouncementRead per-employee-on-demand).
 */
async function getForFill({ businessId, employeeId, occurrenceId, now = new Date() }) {
  const occ = await prisma.surveyOccurrence.findFirst({
    where: { id: occurrenceId, businessId },
    include: { survey: { include: { questions: { orderBy: { orderIndex: 'asc' } } } } },
  });
  if (!occ || !occ.survey) return { notFound: true };
  const survey = occ.survey;

  const segment = await resolveEmployeeSegment(businessId, employeeId);
  if (!audienceMatchesEmployee(survey, segment, employeeId)) return { notFound: true };

  if (survey.status !== 'PUBLISHED' || !survey.publishedAt || survey.publishedAt > now
    || occ.status !== 'OPEN' || occ.opensAt > now || occ.closesAt <= now) {
    return { conflict: 'SURVEY_CLOSED' };
  }

  const part = await prisma.surveyParticipation.findUnique({
    where: { occurrenceId_employeeId: { occurrenceId: occ.id, employeeId } },
  }).catch(() => null);
  if (part && part.state === 'SUBMITTED') return { conflict: 'ALREADY_SUBMITTED' };
  if (!part) {
    // Lazy PENDING seed (never eager fan-out) — powers reminders + the badge.
    await prisma.surveyParticipation.create({
      data: { businessId, occurrenceId: occ.id, employeeId, state: 'PENDING' },
    }).catch(() => {}); // unique race — fine, someone else seeded it
  }

  return {
    occurrence: {
      occurrenceId: occ.id,
      seq: occ.seq,
      opensAt: occ.opensAt,
      closesAt: occ.closesAt,
      survey: {
        id: survey.id, title: survey.title, description: survey.description,
        type: survey.type, anonymous: survey.anonymous,
      },
      questions: survey.questions.map((q) => ({
        id: q.id, section: q.section, orderIndex: q.orderIndex, type: q.type,
        prompt: q.prompt, required: q.required,
        scaleMin: q.type === 'NPS' ? 0 : q.scaleMin,
        scaleMax: q.type === 'NPS' ? 10 : q.scaleMax,
        scaleMinLabel: q.scaleMinLabel, scaleMaxLabel: q.scaleMaxLabel,
        options: q.options || null, allowOther: q.allowOther,
      })),
    },
  };
}

// ── answer validation (pure over the fetched questions) ──────────────────────
function trimmed(v) { return v == null ? '' : String(v).trim(); }

/** Validate one submitted answer against its question. Returns { ok, answered, error? , row? }. */
function checkAnswer(question, input) {
  const q = question;
  const numeric = input && input.numericValue;
  const choices = (input && Array.isArray(input.choiceValues)) ? input.choiceValues : [];
  const text = input ? trimmed(input.textValue) : '';

  if (q.type === 'NPS') {
    if (numeric == null) return { ok: true, answered: false };
    // NPS is PINNED 0..10 no matter what the stored bounds say.
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 10) {
      return { ok: false, error: `"${q.prompt}": NPS answer must be an integer 0–10` };
    }
    return { ok: true, answered: true, row: { numericValue: numeric } };
  }
  if (q.type === 'SCALE' || q.type === 'LIKERT') {
    if (numeric == null) return { ok: true, answered: false };
    if (!Number.isInteger(numeric)) return { ok: false, error: `"${q.prompt}": answer must be an integer` };
    const lo = Number.isInteger(q.scaleMin) ? q.scaleMin : null;
    const hi = Number.isInteger(q.scaleMax) ? q.scaleMax : null;
    if ((lo != null && numeric < lo) || (hi != null && numeric > hi)) {
      return { ok: false, error: `"${q.prompt}": answer must be between ${lo} and ${hi}` };
    }
    return { ok: true, answered: true, row: { numericValue: numeric } };
  }
  if (q.type === 'SINGLE' || q.type === 'MULTI') {
    const known = new Set((Array.isArray(q.options) ? q.options : []).map((o) => o.value));
    for (const c of choices) {
      if (!known.has(c)) return { ok: false, error: `"${q.prompt}": unknown option "${c}"` };
    }
    if (q.type === 'SINGLE' && choices.length > 1) {
      return { ok: false, error: `"${q.prompt}": pick exactly one option` };
    }
    const hasOther = q.allowOther && text !== '';
    if (!hasOther && text !== '') return { ok: false, error: `"${q.prompt}": free text is not allowed here` };
    const answered = choices.length > 0 || hasOther;
    if (!answered) return { ok: true, answered: false };
    return { ok: true, answered: true, row: { choiceValues: choices, textValue: hasOther ? text.slice(0, 2000) : null } };
  }
  if (q.type === 'TEXT') {
    if (text === '') return { ok: true, answered: false };
    return { ok: true, answered: true, row: { textValue: text.slice(0, 5000) } };
  }
  return { ok: false, error: `"${q.prompt}": unsupported question type` };
}

/**
 * submitResponse — §5.2 exactly.
 *   1. occurrence OPEN + inside window            → else 409 SURVEY_CLOSED
 *   2. audience gate (audience.js, reused)        → else 403
 *   3. participation double-submit guard          → else 409 ALREADY_SUBMITTED
 *      (@@unique([occurrenceId, employeeId]) is the race backstop)
 *   4. segmentLabel = coarse bucket NAME snapshot (never an id)
 *   5. $transaction: participation SUBMITTED (the guard row FIRST, so a race dies
 *      on the unique) → SurveyResponse with employeeId = anonymous ? null : id →
 *      SurveyAnswer rows (validated per type; required questions enforced → 422)
 *   6. return { receiptToken } ONLY.
 */
async function submitResponse({ businessId, occurrenceId, employee, answers, now = new Date() }) {
  const employeeId = employee && employee.id;
  if (!employeeId) return { forbidden: true };

  const occ = await prisma.surveyOccurrence.findFirst({
    where: { id: occurrenceId, businessId },
    include: { survey: { include: { questions: true } } },
  });
  if (!occ || !occ.survey) return { notFound: true };
  const survey = occ.survey;

  // 1. Window gate.
  if (survey.status !== 'PUBLISHED' || !survey.publishedAt || survey.publishedAt > now
    || occ.status !== 'OPEN' || occ.opensAt > now || occ.closesAt <= now) {
    return { conflict: 'SURVEY_CLOSED' };
  }

  // 2. Audience gate (reuse audience.js verbatim).
  const segment = await resolveEmployeeSegment(businessId, employeeId);
  if (!audienceMatchesEmployee(survey, segment, employeeId)) return { forbidden: true };

  // 3. Clean double-submit check (the tx below is the hard backstop).
  const prior = await prisma.surveyParticipation.findUnique({
    where: { occurrenceId_employeeId: { occurrenceId: occ.id, employeeId } },
  }).catch(() => null);
  if (prior && prior.state === 'SUBMITTED') return { conflict: 'ALREADY_SUBMITTED' };

  // Validate every answer + enforce required questions (422 on violation).
  const byQuestion = new Map();
  for (const a of (Array.isArray(answers) ? answers : [])) {
    if (a && a.questionId) byQuestion.set(a.questionId, a);
  }
  const answerRows = [];
  for (const q of survey.questions) {
    const res = checkAnswer(q, byQuestion.get(q.id));
    if (!res.ok) return { invalid: res.error };
    if (!res.answered) {
      if (q.required) return { invalid: `"${q.prompt}" is required` };
      continue;
    }
    answerRows.push({ questionId: q.id, ...res.row });
  }
  // Unknown questionIds (not on this survey) are rejected, not silently dropped.
  const knownIds = new Set(survey.questions.map((q) => q.id));
  for (const qid of byQuestion.keys()) {
    if (!knownIds.has(qid)) return { invalid: 'Unknown questionId in answers' };
  }
  if (!answerRows.length) return { invalid: 'No answers submitted' };

  // 4. Coarse segment snapshot — a NAME string (dept OR entity), never the id.
  let segmentLabel = null;
  try { segmentLabel = await segmentLabelFor({ businessId, survey, segment }); } catch (_e) { segmentLabel = null; }

  // 5. The firewall transaction.
  let receiptToken = null;
  try {
    receiptToken = await prisma.$transaction(async (tx) => {
      // Guard row first — under a race the second writer dies here on the @@unique
      // (or the in-tx re-read) BEFORE any content is written.
      const fresh = await tx.surveyParticipation.findUnique({
        where: { occurrenceId_employeeId: { occurrenceId: occ.id, employeeId } },
      });
      if (fresh && fresh.state === 'SUBMITTED') {
        const err = new Error('ALREADY_SUBMITTED'); err.code = 'ALREADY_SUBMITTED'; throw err;
      }
      if (fresh) {
        await tx.surveyParticipation.update({
          where: { id: fresh.id },
          data: { state: 'SUBMITTED', submittedAt: now },
        });
      } else {
        await tx.surveyParticipation.create({
          data: { businessId, occurrenceId: occ.id, employeeId, state: 'SUBMITTED', submittedAt: now },
        });
      }
      // THE invariant: anonymous → employeeId is null. No other write path exists.
      const response = await tx.surveyResponse.create({
        data: {
          businessId,
          surveyId: survey.id,
          occurrenceId: occ.id,
          employeeId: survey.anonymous ? null : employeeId,
          segmentLabel,
          submittedAt: now,
          answers: { create: answerRows },
        },
        select: { receiptToken: true },
      });
      return response.receiptToken;
    });
  } catch (e) {
    if (e && (e.code === 'ALREADY_SUBMITTED' || e.code === 'P2002')) return { conflict: 'ALREADY_SUBMITTED' };
    throw e;
  }

  // 6. The receipt is a random token — proof of participation, NOT a person link.
  return { receiptToken };
}

/** Dismiss — "don't ask me again" for this occurrence. Counts as a non-response,
 *  stops reminders. A submitted ballot can't be dismissed away. */
async function dismiss({ businessId, employeeId, occurrenceId, now = new Date() }) {
  const occ = await prisma.surveyOccurrence.findFirst({
    where: { id: occurrenceId, businessId },
    include: { survey: true },
  });
  if (!occ || !occ.survey) return { notFound: true };
  const segment = await resolveEmployeeSegment(businessId, employeeId);
  if (!audienceMatchesEmployee(occ.survey, segment, employeeId)) return { notFound: true };

  const prior = await prisma.surveyParticipation.findUnique({
    where: { occurrenceId_employeeId: { occurrenceId: occ.id, employeeId } },
  }).catch(() => null);
  if (prior && prior.state === 'SUBMITTED') return { conflict: 'ALREADY_SUBMITTED' };
  await prisma.surveyParticipation.upsert({
    where: { occurrenceId_employeeId: { occurrenceId: occ.id, employeeId } },
    create: { businessId, occurrenceId: occ.id, employeeId, state: 'DISMISSED' },
    update: { state: 'DISMISSED' },
  });
  return { dismissed: true };
}

module.exports = {
  occurrenceFeedWhere,
  listForEmployee,
  getForFill,
  submitResponse,
  dismiss,
  _internals: { checkAnswer },
};
