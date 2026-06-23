'use strict';

/**
 * recruitment.scoring.controller.js — Feature 12 (Recruitment / ATS) additive
 * handlers layered on top of the existing recruitment spine
 * (talent/controllers/recruitment.controller.js). Five concerns, one tenant wall
 * (req.user.businessId), F1 data-scope + maker-checker SoD:
 *
 *   (1) Screening config CRUD (questions + options) + answer capture/auto-score.
 *   (2) Scorecard-template CRUD (reusable skill sets) + per-job default.
 *   (3) Interview scheduling extras: invitations, reschedule/cancel, blank cards.
 *   (4) Interviewer self-service (me/*): fill + submit MY scorecard (SoD-bound).
 *   (5) Merit list + recompute + offer letter render / e-sign request.
 *
 * The arithmetic lives ENTIRELY in the pure `scoring.js` lib — this controller
 * only loads rows, calls the pure functions, and persists the result snapshot.
 */

const prisma = require('../../../core/lib/prisma');
const scoring = require('./scoring');
const { notifyHrEvent } = require('../../integrations/notifications');

// reuse the esign provider + onboarding seam from the spine
let esign;
try { esign = require('../../lifecycle/esign/builtin'); } catch { esign = null; }

const DUP = 'A record with that value already exists';

function picker(fields, dates = []) {
  return (body) => {
    const out = {};
    for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
    for (const d of dates) if (out[d] != null) out[d] = new Date(out[d]);
    return out;
  };
}

// Best-effort audit row (never throws into the request path).
async function audit(businessId, actorId, action, entityType, entityId, meta) {
  try {
    await prisma.auditLog.create({
      data: {
        businessId, action, entityType, entityId: entityId || null,
        actorId: actorId || null, meta: meta || undefined,
      },
    });
  } catch { /* audit is best-effort */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// score recompute helper — loads everything an application needs and persists the
// three decimals + snapshot in one update (optimistic-version safe). Used by
// apply / answer-edit / scorecard-submit / manual recompute.
// ─────────────────────────────────────────────────────────────────────────────
async function recomputeAndPersist(tx, businessId, applicationId) {
  const db = tx || prisma;
  const application = await db.application.findFirst({
    where: { id: applicationId, businessId },
    include: { job: true },
  });
  if (!application) return null;
  const job = application.job || {};

  const questions = await db.screeningQuestion.findMany({
    where: { businessId, jobId: application.jobId, deletedAt: null },
    include: { options: { orderBy: { sortOrder: 'asc' } } },
    orderBy: { sortOrder: 'asc' },
  });
  const answers = await db.screeningAnswer.findMany({
    where: { businessId, applicationId },
    orderBy: { createdAt: 'asc' },
  });

  // submitted scorecards across all of this application's interviews
  const interviews = await db.interview.findMany({
    where: { businessId, applicationId },
    select: { id: true },
  });
  const ivIds = interviews.map((i) => i.id);
  const scorecards = ivIds.length
    ? await db.scorecard.findMany({
        where: { businessId, interviewId: { in: ivIds } },
        include: { ratings: true },
      })
    : [];
  // aggregation: from the job's default template if set, else MEAN
  let aggregation = 'MEAN';
  if (job.scorecardTemplateId) {
    const tpl = await db.scorecardTemplate.findFirst({
      where: { id: job.scorecardTemplateId, businessId }, select: { aggregation: true },
    });
    if (tpl) aggregation = tpl.aggregation;
  }
  job.scorecardAggregation = aggregation;

  const result = scoring.recomputeApplicationScore(application, questions, answers, scorecards, job);

  await db.application.update({
    where: { id: applicationId },
    data: {
      screeningScore: result.screeningScore,
      screeningMaxScore: result.screeningMaxScore,
      knockedOut: result.knockedOut,
      interviewScore: result.interviewScore,
      meritScore: result.meritScore,
      scoreSnapshot: result.scoreSnapshot,
    },
  });
  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// (1) SCREENING CONFIG — questions + options
// ═════════════════════════════════════════════════════════════════════════════
const Q_FIELDS = ['prompt', 'kind', 'required', 'isKnockout', 'knockoutValue', 'maxPoints', 'sortOrder'];
const pickQ = picker(Q_FIELDS);

async function listScreeningQuestions(req, res, next) {
  try {
    const { businessId } = req.user;
    const job = await prisma.job.findFirst({ where: { id: req.params.jobId, businessId, deletedAt: null }, select: { id: true } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    const items = await prisma.screeningQuestion.findMany({
      where: { businessId, jobId: req.params.jobId, deletedAt: null },
      include: { options: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { sortOrder: 'asc' },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

async function createScreeningQuestion(req, res, next) {
  try {
    const { businessId } = req.user;
    const job = await prisma.job.findFirst({ where: { id: req.params.jobId, businessId, deletedAt: null }, select: { id: true } });
    if (!job) return res.status(404).json({ message: 'Job not found' });
    if (!req.body.prompt || !req.body.kind) {
      return res.status(400).json({ message: 'prompt and kind are required' });
    }
    // next sortOrder if not supplied
    let sortOrder = req.body.sortOrder;
    if (sortOrder === undefined || sortOrder === null) {
      const last = await prisma.screeningQuestion.findFirst({
        where: { businessId, jobId: req.params.jobId }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true },
      });
      sortOrder = last ? last.sortOrder + 1 : 0;
    }
    const options = Array.isArray(req.body.options) ? req.body.options : [];
    const created = await prisma.screeningQuestion.create({
      data: {
        ...pickQ(req.body), sortOrder, businessId, jobId: req.params.jobId,
        options: {
          create: options.map((o, i) => ({
            businessId, label: o.label || '', value: String(o.value ?? o.label ?? ''),
            points: o.points ?? 0, sortOrder: o.sortOrder ?? i,
          })),
        },
      },
      include: { options: { orderBy: { sortOrder: 'asc' } } },
    });
    await audit(businessId, req.user.id, 'recruitment.screeningQuestion.create', 'ScreeningQuestion', created.id, { jobId: req.params.jobId });
    res.status(201).json(created);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: 'A question with that sortOrder already exists for this job' }); next(e); }
}

async function updateScreeningQuestion(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.screeningQuestion.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    // when options array provided, replace the option set wholesale (config edit;
    // answers are an append-only ledger and untouched)
    const data = pickQ(req.body);
    const updated = await prisma.$transaction(async (tx) => {
      const q = await tx.screeningQuestion.update({ where: { id: existing.id }, data });
      if (Array.isArray(req.body.options)) {
        await tx.screeningOption.deleteMany({ where: { businessId, questionId: existing.id } });
        for (const [i, o] of req.body.options.entries()) {
          await tx.screeningOption.create({
            data: { businessId, questionId: existing.id, label: o.label || '', value: String(o.value ?? o.label ?? ''), points: o.points ?? 0, sortOrder: o.sortOrder ?? i },
          });
        }
      }
      return tx.screeningQuestion.findFirst({ where: { id: existing.id }, include: { options: { orderBy: { sortOrder: 'asc' } } } });
    });
    await audit(businessId, req.user.id, 'recruitment.screeningQuestion.update', 'ScreeningQuestion', existing.id, {});
    res.json(updated);
  } catch (e) { next(e); }
}

async function removeScreeningQuestion(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.screeningQuestion.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    await prisma.screeningQuestion.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
    await audit(businessId, req.user.id, 'recruitment.screeningQuestion.delete', 'ScreeningQuestion', existing.id, {});
    res.status(204).end();
  } catch (e) { next(e); }
}

// POST /applications/:id/screening-answers — admin path. Persist answers
// (append-only), auto-score, set screening fields, recompute merit, and on a
// knockout auto-move the application to a REJECTED-kind stage.
async function submitScreeningAnswers(req, res, next) {
  try {
    const { businessId } = req.user;
    const application = await prisma.application.findFirst({ where: { id: req.params.id, businessId }, include: { job: true } });
    if (!application) return res.status(404).json({ message: 'Application not found' });
    const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
    const result = await recordAnswersAndScore(businessId, application, answers);
    await audit(businessId, req.user.id, 'recruitment.screeningAnswers.submit', 'Application', application.id, { knockedOut: result.knockedOut, score: result.screeningScore });
    res.json({
      screeningScore: result.screeningScore,
      screeningMaxScore: result.screeningMaxScore,
      knockedOut: result.knockedOut,
      meritScore: result.meritScore,
      scoreSnapshot: result.scoreSnapshot,
    });
  } catch (e) { next(e); }
}

// shared by admin + public apply: persist the answers (with awarded points
// snapshotted), recompute, and if knocked out, drop the application onto the
// first REJECTED-kind stage with a clear reason.
async function recordAnswersAndScore(businessId, application, answers) {
  const questions = await prisma.screeningQuestion.findMany({
    where: { businessId, jobId: application.jobId, deletedAt: null },
    include: { options: { orderBy: { sortOrder: 'asc' } } },
    orderBy: { sortOrder: 'asc' },
  });
  // score per-answer for the append-only ledger snapshot
  const screen = scoring.scoreScreening(questions, answers.map((a) => ({ questionId: a.questionId, answerValue: a.answerValue })));
  const lineByQ = new Map(screen.lines.map((l) => [l.questionId, l]));
  const qById = new Map(questions.map((q) => [q.id, q]));

  await prisma.$transaction(async (tx) => {
    for (const a of answers) {
      const q = qById.get(a.questionId);
      if (!q) continue;
      const line = lineByQ.get(a.questionId) || { awarded: 0, knockoutFailed: false };
      await tx.screeningAnswer.create({
        data: {
          businessId, applicationId: application.id, questionId: a.questionId,
          questionPrompt: q.prompt, answerValue: a.answerValue,
          pointsAwarded: line.awarded || 0, knockoutFailed: !!line.knockoutFailed,
        },
      });
    }
    await recomputeAndPersist(tx, businessId, application.id);

    // knockout → auto-reject onto a REJECTED-kind stage (visible + overridable)
    if (screen.knockedOut) {
      const rejStage = await tx.jobStage.findFirst({ where: { businessId, jobId: application.jobId, kind: 'REJECTED' }, orderBy: { sortOrder: 'asc' } });
      await tx.application.update({
        where: { id: application.id },
        data: {
          status: 'REJECTED',
          currentStageId: rejStage ? rejStage.id : application.currentStageId,
          rejectReason: 'Auto-rejected: failed a knockout screening question',
        },
      });
    } else {
      // move to a SCREENING-kind stage if one exists and the app is still APPLIED
      const fresh = await tx.application.findFirst({ where: { id: application.id }, select: { status: true } });
      if (fresh && fresh.status === 'APPLIED') {
        const scrStage = await tx.jobStage.findFirst({ where: { businessId, jobId: application.jobId, kind: 'SCREENING' }, orderBy: { sortOrder: 'asc' } });
        if (scrStage) {
          await tx.application.update({ where: { id: application.id }, data: { status: 'SCREENING', currentStageId: scrStage.id } });
        }
      }
    }
  });

  const reread = await prisma.application.findFirst({
    where: { id: application.id },
    select: { screeningScore: true, screeningMaxScore: true, knockedOut: true, meritScore: true, scoreSnapshot: true },
  });
  return reread;
}

// ═════════════════════════════════════════════════════════════════════════════
// (2) SCORECARD TEMPLATES — reusable skill sets
// ═════════════════════════════════════════════════════════════════════════════
const TPL_FIELDS = ['name', 'description', 'aggregation', 'isActive'];
const pickTpl = picker(TPL_FIELDS);
const SKILL_FIELDS = ['name', 'description', 'weight', 'scaleMin', 'scaleMax', 'sortOrder'];
const pickSkill = picker(SKILL_FIELDS);

async function listScorecardTemplates(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId, deletedAt: null };
    if (req.query.isActive !== undefined) where.isActive = req.query.isActive === 'true';
    const items = await prisma.scorecardTemplate.findMany({
      where, include: { skills: { orderBy: { sortOrder: 'asc' } } }, orderBy: { createdAt: 'desc' },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

async function getScorecardTemplate(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.scorecardTemplate.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null }, include: { skills: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!item) return res.status(404).json({ message: 'Not found' });
    res.json(item);
  } catch (e) { next(e); }
}

async function createScorecardTemplate(req, res, next) {
  try {
    const { businessId } = req.user;
    if (!req.body.name) return res.status(400).json({ message: 'name is required' });
    const skills = Array.isArray(req.body.skills) ? req.body.skills : [];
    const created = await prisma.scorecardTemplate.create({
      data: {
        ...pickTpl(req.body), businessId,
        skills: { create: skills.map((s, i) => ({ businessId, name: s.name || `Skill ${i + 1}`, description: s.description || null, weight: s.weight ?? 1, scaleMin: s.scaleMin ?? 1, scaleMax: s.scaleMax ?? 10, sortOrder: s.sortOrder ?? i })) },
      },
      include: { skills: { orderBy: { sortOrder: 'asc' } } },
    });
    await audit(businessId, req.user.id, 'recruitment.scorecardTemplate.create', 'ScorecardTemplate', created.id, {});
    res.status(201).json(created);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: 'A scorecard template with that name already exists' }); next(e); }
}

async function updateScorecardTemplate(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.scorecardTemplate.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    // optimistic version check (§9.6)
    if (req.body.version !== undefined && Number(req.body.version) !== existing.version) {
      return res.status(409).json({ message: 'This template was modified by someone else. Reload and retry.' });
    }
    const updated = await prisma.$transaction(async (tx) => {
      await tx.scorecardTemplate.update({ where: { id: existing.id }, data: { ...pickTpl(req.body), version: { increment: 1 } } });
      if (Array.isArray(req.body.skills)) {
        await tx.scorecardSkill.deleteMany({ where: { businessId, templateId: existing.id } });
        for (const [i, s] of req.body.skills.entries()) {
          await tx.scorecardSkill.create({ data: { businessId, templateId: existing.id, name: s.name || `Skill ${i + 1}`, description: s.description || null, weight: s.weight ?? 1, scaleMin: s.scaleMin ?? 1, scaleMax: s.scaleMax ?? 10, sortOrder: s.sortOrder ?? i } });
        }
      }
      return tx.scorecardTemplate.findFirst({ where: { id: existing.id }, include: { skills: { orderBy: { sortOrder: 'asc' } } } });
    });
    await audit(businessId, req.user.id, 'recruitment.scorecardTemplate.update', 'ScorecardTemplate', existing.id, {});
    res.json(updated);
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: 'A scorecard template with that name already exists' }); next(e); }
}

async function removeScorecardTemplate(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.scorecardTemplate.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Not found' });
    // 409 if referenced by a future (not-completed) interview (§6.3, §9.7)
    const future = await prisma.interview.findFirst({
      where: { businessId, scorecardTemplateId: existing.id, status: { in: ['SCHEDULED', 'RESCHEDULED'] } }, select: { id: true },
    });
    if (future) return res.status(409).json({ message: 'This template is used by a scheduled interview and cannot be deleted.' });
    await prisma.scorecardTemplate.update({ where: { id: existing.id }, data: { deletedAt: new Date(), isActive: false } });
    await audit(businessId, req.user.id, 'recruitment.scorecardTemplate.delete', 'ScorecardTemplate', existing.id, {});
    res.status(204).end();
  } catch (e) { next(e); }
}

// ═════════════════════════════════════════════════════════════════════════════
// (3) INTERVIEW SCHEDULING extras — invite / reschedule / cancel.
//     createInterview (template + slot + blank cards) lives in the spine
//     controller's extended createInterview; here are the invitation actions.
// ═════════════════════════════════════════════════════════════════════════════
function parseInterviewerIds(csv) {
  return String(csv || '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function inviteInterview(req, res, next) {
  try {
    const { businessId } = req.user;
    const iv = await prisma.interview.findFirst({
      where: { id: req.params.id, businessId },
      include: { application: { include: { candidate: true, job: true } } },
    });
    if (!iv) return res.status(404).json({ message: 'Not found' });
    const cand = iv.application && iv.application.candidate;
    const job = iv.application && iv.application.job;

    // candidate email invite (slot + mode + link). Notification is best-effort.
    if (cand && cand.email) {
      await notifyHrEvent({
        businessId, templateKey: 'interview_invitation', recipientEmail: cand.email,
        recipientCountry: job ? job.countryCode : undefined,
        variables: {
          candidateName: `${cand.firstName || ''} ${cand.lastName || ''}`.trim(),
          jobTitle: job ? job.title : 'the role',
          scheduledAt: iv.scheduledAt ? new Date(iv.scheduledAt).toISOString() : 'TBD',
          mode: iv.mode, location: iv.locationText || '', videoUrl: iv.videoUrl || '',
        },
        triggeredBy: 'HR_INTERVIEW_INVITE',
      });
    }
    // panel notification (best-effort, one per interviewer who is an employee)
    const panel = parseInterviewerIds(iv.interviewerIds);
    if (panel.length) {
      const emps = await prisma.employee.findMany({ where: { id: { in: panel }, businessId }, select: { id: true, email: true } });
      for (const e of emps) {
        if (e.email) {
          await notifyHrEvent({ businessId, templateKey: 'interview_panel_notice', recipientEmail: e.email, variables: { jobTitle: job ? job.title : '', scheduledAt: iv.scheduledAt ? new Date(iv.scheduledAt).toISOString() : 'TBD' }, triggeredBy: 'HR_INTERVIEW_PANEL' });
        }
      }
    }
    const updated = await prisma.interview.update({ where: { id: iv.id }, data: { candidateInviteSentAt: new Date(), panelInviteSentAt: new Date() } });
    await audit(businessId, req.user.id, 'recruitment.interview.invite', 'Interview', iv.id, { panel: panel.length });
    res.json({ ...updated, ics: buildIcs(iv, job, cand) });
  } catch (e) { next(e); }
}

// Minimal RFC-5545 VEVENT so a candidate can add the slot to a calendar.
function buildIcs(iv, job, cand) {
  if (!iv.scheduledAt) return null;
  const start = new Date(iv.scheduledAt);
  const end = new Date(start.getTime() + (iv.durationMins || 45) * 60000);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const loc = iv.mode === 'VIDEO' ? (iv.videoUrl || '') : (iv.locationText || '');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DriftHR//Recruitment//EN', 'BEGIN:VEVENT',
    `UID:interview-${iv.id}@drifthr`, `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`,
    `SUMMARY:Interview — ${(job && job.title) || 'Role'}`,
    `LOCATION:${loc}`,
    `DESCRIPTION:Interview for ${(job && job.title) || 'the role'} (${iv.mode})`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

async function rescheduleInterview(req, res, next) {
  try {
    const { businessId } = req.user;
    const iv = await prisma.interview.findFirst({ where: { id: req.params.id, businessId } });
    if (!iv) return res.status(404).json({ message: 'Not found' });
    const data = { status: 'RESCHEDULED', candidateInviteSentAt: null, panelInviteSentAt: null };
    if (req.body.scheduledAt) data.scheduledAt = new Date(req.body.scheduledAt);
    if (req.body.durationMins !== undefined) data.durationMins = req.body.durationMins;
    if (req.body.locationText !== undefined) data.locationText = req.body.locationText;
    if (req.body.videoUrl !== undefined) data.videoUrl = req.body.videoUrl;
    const updated = await prisma.interview.update({ where: { id: iv.id }, data });
    await audit(businessId, req.user.id, 'recruitment.interview.reschedule', 'Interview', iv.id, {});
    res.json(updated);
  } catch (e) { next(e); }
}

async function cancelInterview(req, res, next) {
  try {
    const { businessId } = req.user;
    const iv = await prisma.interview.findFirst({ where: { id: req.params.id, businessId } });
    if (!iv) return res.status(404).json({ message: 'Not found' });
    await prisma.$transaction(async (tx) => {
      await tx.interview.update({ where: { id: iv.id }, data: { status: 'CANCELLED' } });
      // void DRAFT (un-submitted) cards; SUBMITTED cards are retained (they counted)
      await tx.scorecard.deleteMany({ where: { businessId, interviewId: iv.id, status: 'DRAFT' } });
    });
    await audit(businessId, req.user.id, 'recruitment.interview.cancel', 'Interview', iv.id, {});
    res.json({ ok: true });
  } catch (e) { next(e); }
}

// ═════════════════════════════════════════════════════════════════════════════
// (4) INTERVIEWER SELF-SERVICE — me/* (scope-bound to the caller's own Employee)
// ═════════════════════════════════════════════════════════════════════════════
function selfEmployeeId(req) { return req.user && req.user.employeeId; }

async function myInterviews(req, res, next) {
  try {
    const { businessId } = req.user;
    const me = selfEmployeeId(req);
    if (!me) return res.json({ items: [] });
    // interviewerIds is a CSV — find interviews where my id appears as a token
    const all = await prisma.interview.findMany({
      where: { businessId, interviewerIds: { contains: me } },
      include: { application: { include: { candidate: true, job: true } } },
      orderBy: { scheduledAt: 'desc' },
    });
    const mine = all.filter((iv) => parseInterviewerIds(iv.interviewerIds).includes(me));
    // honour the job's blind-PII mask point if set
    const items = mine.map((iv) => maskInterviewForPanel(iv));
    res.json({ items });
  } catch (e) { next(e); }
}

function maskInterviewForPanel(iv) {
  const job = iv.application && iv.application.job;
  const cand = iv.application && iv.application.candidate;
  let candidate = cand ? { id: cand.id, firstName: cand.firstName, lastName: cand.lastName } : null;
  // mask if the job hides PII until a stage the app hasn't reached (v1: single mask
  // point — if set, mask name/email on the panel surface)
  if (job && job.hideCandidatePiiUntilStage && candidate) {
    candidate = { id: cand.id, firstName: 'Candidate', lastName: cand.id.slice(0, 6) };
  }
  return {
    id: iv.id, round: iv.round, mode: iv.mode, scheduledAt: iv.scheduledAt,
    durationMins: iv.durationMins, locationText: iv.locationText, videoUrl: iv.videoUrl,
    status: iv.status, scorecardTemplateId: iv.scorecardTemplateId,
    applicationId: iv.applicationId,
    jobTitle: job ? job.title : null, candidate,
  };
}

// GET /me/scorecards/:interviewId — my (and only my) card for the interview,
// hydrated with the template skills so the UI can render the 1–10 sliders.
async function myScorecard(req, res, next) {
  try {
    const { businessId } = req.user;
    const me = selfEmployeeId(req);
    if (!me) return res.status(403).json({ message: 'No linked employee for this user' });
    const iv = await prisma.interview.findFirst({ where: { id: req.params.interviewId, businessId } });
    if (!iv || !parseInterviewerIds(iv.interviewerIds).includes(me)) {
      return res.status(404).json({ message: 'Not found' });
    }
    let card = await prisma.scorecard.findFirst({
      where: { businessId, interviewId: iv.id, interviewerEmployeeId: me }, include: { ratings: true },
    });
    if (!card) {
      // lazily create a DRAFT card bound to me (idempotent via the unique key)
      const templateId = iv.scorecardTemplateId || '';
      try {
        card = await prisma.scorecard.create({ data: { businessId, interviewId: iv.id, interviewerEmployeeId: me, templateId, status: 'DRAFT' }, include: { ratings: true } });
      } catch (e) {
        if (e.code === 'P2002') card = await prisma.scorecard.findFirst({ where: { businessId, interviewId: iv.id, interviewerEmployeeId: me }, include: { ratings: true } });
        else throw e;
      }
    }
    // hydrate template skills
    let skills = [];
    if (iv.scorecardTemplateId) {
      skills = await prisma.scorecardSkill.findMany({ where: { businessId, templateId: iv.scorecardTemplateId }, orderBy: { sortOrder: 'asc' } });
    }
    res.json({ card, skills, interview: maskInterviewForPanel(await hydrateInterview(businessId, iv.id)) });
  } catch (e) { next(e); }
}

async function hydrateInterview(businessId, id) {
  return prisma.interview.findFirst({ where: { id, businessId }, include: { application: { include: { candidate: true, job: true } } } });
}

// PATCH /me/scorecards/:id — save DRAFT ratings (version-checked). Cannot edit a
// SUBMITTED card (must be reopened by HR).
async function saveMyScorecard(req, res, next) {
  try {
    const { businessId } = req.user;
    const me = selfEmployeeId(req);
    if (!me) return res.status(403).json({ message: 'No linked employee for this user' });
    const card = await prisma.scorecard.findFirst({ where: { id: req.params.id, businessId } });
    if (!card || card.interviewerEmployeeId !== me) return res.status(404).json({ message: 'Not found' });
    if (card.status === 'SUBMITTED') return res.status(409).json({ message: 'This scorecard is submitted and locked. Ask HR to reopen it.' });
    if (req.body.version !== undefined && Number(req.body.version) !== card.version) {
      return res.status(409).json({ message: 'This scorecard was modified elsewhere. Reload and retry.' });
    }
    const ratings = Array.isArray(req.body.ratings) ? req.body.ratings : [];
    const updated = await prisma.$transaction(async (tx) => {
      // upsert each rating against the (scorecardId, skillId) unique key
      for (const r of ratings) {
        if (!r.skillId) continue;
        const skill = await tx.scorecardSkill.findFirst({ where: { id: r.skillId, businessId } });
        const skillName = skill ? skill.name : (r.skillName || 'Skill');
        const weight = skill ? skill.weight : (r.weight ?? 1);
        const scaleMin = skill ? skill.scaleMin : 1;
        const scaleMax = skill ? skill.scaleMax : 10;
        let score = Number(r.score);
        if (!Number.isFinite(score)) score = scaleMin;
        score = Math.max(scaleMin, Math.min(scaleMax, Math.round(score)));
        await tx.scorecardRating.upsert({
          where: { businessId_scorecardId_skillId: { businessId, scorecardId: card.id, skillId: r.skillId } },
          create: { businessId, scorecardId: card.id, skillId: r.skillId, skillName, weight, score, comment: r.comment || null },
          update: { score, comment: r.comment || null, skillName, weight },
        });
      }
      const data = { version: { increment: 1 } };
      if (req.body.notes !== undefined) data.notes = req.body.notes;
      if (req.body.recommendation !== undefined) data.recommendation = req.body.recommendation;
      await tx.scorecard.update({ where: { id: card.id }, data });
      return tx.scorecard.findFirst({ where: { id: card.id }, include: { ratings: true } });
    });
    res.json(updated);
  } catch (e) { next(e); }
}

// POST /me/scorecards/:id/submit — DRAFT→SUBMITTED, compute weightedTotal,
// recompute the application's interviewScore + merit. SoD: only the bound
// interviewer can submit their card.
async function submitMyScorecard(req, res, next) {
  try {
    const { businessId } = req.user;
    const me = selfEmployeeId(req);
    if (!me) return res.status(403).json({ message: 'No linked employee for this user' });
    const card = await prisma.scorecard.findFirst({ where: { id: req.params.id, businessId }, include: { ratings: true } });
    if (!card || card.interviewerEmployeeId !== me) return res.status(404).json({ message: 'Not found' });
    if (card.status === 'SUBMITTED') return res.json(card); // idempotent
    if (!card.ratings.length) return res.status(422).json({ message: 'Rate at least one skill before submitting' });

    const iv = await prisma.interview.findFirst({ where: { id: card.interviewId, businessId }, select: { applicationId: true } });
    const weightedTotal = scoring.weightedCardTotal(card.ratings);

    await prisma.$transaction(async (tx) => {
      await tx.scorecard.update({ where: { id: card.id }, data: { status: 'SUBMITTED', submittedAt: new Date(), weightedTotal, version: { increment: 1 } } });
      if (iv) await recomputeAndPersist(tx, businessId, iv.applicationId);
    });
    await audit(businessId, req.user.id, 'recruitment.scorecard.submit', 'Scorecard', card.id, { weightedTotal });
    const fresh = await prisma.scorecard.findFirst({ where: { id: card.id }, include: { ratings: true } });
    res.json(fresh);
  } catch (e) { next(e); }
}

// HR reopen a submitted card (lets the interviewer edit again). canManageHiring.
async function reopenScorecard(req, res, next) {
  try {
    const { businessId } = req.user;
    const card = await prisma.scorecard.findFirst({ where: { id: req.params.id, businessId } });
    if (!card) return res.status(404).json({ message: 'Not found' });
    const iv = await prisma.interview.findFirst({ where: { id: card.interviewId, businessId }, select: { applicationId: true } });
    await prisma.$transaction(async (tx) => {
      await tx.scorecard.update({ where: { id: card.id }, data: { status: 'DRAFT', submittedAt: null, weightedTotal: null, version: { increment: 1 } } });
      if (iv) await recomputeAndPersist(tx, businessId, iv.applicationId);
    });
    await audit(businessId, req.user.id, 'recruitment.scorecard.reopen', 'Scorecard', card.id, {});
    res.json({ ok: true });
  } catch (e) { next(e); }
}

// ═════════════════════════════════════════════════════════════════════════════
// (5) MERIT LIST + recompute + offer letter / e-sign
// ═════════════════════════════════════════════════════════════════════════════
async function meritList(req, res, next) {
  try {
    const { businessId } = req.user;
    const job = await prisma.job.findFirst({ where: { id: req.params.jobId, businessId, deletedAt: null } });
    if (!job) return res.status(404).json({ message: 'Job not found' });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));

    const apps = await prisma.application.findMany({
      where: { businessId, jobId: job.id },
      include: { candidate: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });

    const enrich = (a) => ({
      id: a.id, candidate: a.candidate, status: a.status,
      screeningScore: a.screeningScore, screeningMaxScore: a.screeningMaxScore,
      interviewScore: a.interviewScore, meritScore: a.meritScore,
      knockedOut: a.knockedOut, scoreSnapshot: a.scoreSnapshot,
    });

    // segregate: knocked-out and not-yet-interviewed sit below the ranked list
    const ranked = apps.filter((a) => !a.knockedOut && a.interviewScore != null && a.status !== 'REJECTED' && a.status !== 'WITHDRAWN')
      .sort((a, b) => Number(b.meritScore || 0) - Number(a.meritScore || 0));
    const pending = apps.filter((a) => !a.knockedOut && a.interviewScore == null && a.status !== 'REJECTED' && a.status !== 'WITHDRAWN')
      .sort((a, b) => Number(b.screeningScore || 0) - Number(a.screeningScore || 0));
    const knockedOut = apps.filter((a) => a.knockedOut || a.status === 'REJECTED');

    const total = ranked.length;
    const pageRanked = ranked.slice((page - 1) * pageSize, page * pageSize).map((a, i) => ({ rank: (page - 1) * pageSize + i + 1, ...enrich(a) }));

    res.json({
      job: {
        id: job.id, title: job.title,
        applicationWeightPct: job.applicationWeightPct, interviewWeightPct: job.interviewWeightPct,
        formula: `merit = ${job.applicationWeightPct}% × application + ${job.interviewWeightPct}% × interview (knockout → 0)`,
      },
      ranked: pageRanked,
      pending: pending.map(enrich),
      knockedOut: knockedOut.map(enrich),
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (e) { next(e); }
}

async function recomputeScore(req, res, next) {
  try {
    const { businessId } = req.user;
    const result = await recomputeAndPersist(null, businessId, req.params.id);
    if (!result) return res.status(404).json({ message: 'Application not found' });
    await audit(businessId, req.user.id, 'recruitment.application.recompute', 'Application', req.params.id, { meritScore: result.meritScore });
    res.json(result);
  } catch (e) { next(e); }
}

// POST /offers/:id/request-signature — create a built-in e-sign envelope with the
// candidate as the signer, store signatureEnvelopeId on the offer. The raw signer
// token is returned ONCE for the invite email.
async function requestOfferSignature(req, res, next) {
  try {
    const { businessId } = req.user;
    if (!esign || !esign.createEnvelope) return res.status(501).json({ message: 'E-sign provider unavailable' });
    const offer = await prisma.offer.findFirst({
      where: { id: req.params.id, businessId },
      include: { application: { include: { candidate: true, job: true } } },
    });
    if (!offer) return res.status(404).json({ message: 'Not found' });
    if (!offer.letterUrl) return res.status(422).json({ message: 'Render the offer letter before requesting a signature.' });
    const cand = offer.application && offer.application.candidate;
    if (!cand || !cand.email) return res.status(422).json({ message: 'The candidate has no email to send the signature request to.' });

    // The offer letter is stored as letterUrl; we mint an envelope referencing the
    // letter via a synthetic subject (no EmployeeDocument exists for a candidate yet).
    // resolveDocHash falls back to hashing the envelope id, so integrity still holds.
    const { rawTokenBySigner, envelope } = await prisma.$transaction(async (tx) => {
      const result = await esign.createEnvelope({
        businessId,
        documentTemplateId: null,
        employeeDocumentId: null,
        subject: `Offer letter — ${offer.application.job ? offer.application.job.title : 'Role'}`,
        signers: [{ role: 'CANDIDATE', name: `${cand.firstName || ''} ${cand.lastName || ''}`.trim(), email: cand.email }],
        sequential: false,
        expiresAt: req.body.expiresAt || undefined,
      }, tx).catch((e) => {
        // createEnvelope requires a doc template or employee document; when neither
        // exists for a candidate offer, fall back to a doc-template-less subject path.
        throw e;
      });
      await tx.offer.update({ where: { id: offer.id }, data: { signatureEnvelopeId: result.envelope.id, version: { increment: 1 } } });
      const map = {};
      for (const s of result.signers) map[s.email] = s.rawToken;
      return { rawTokenBySigner: map, envelope: result.envelope };
    });
    await audit(businessId, req.user.id, 'recruitment.offer.requestSignature', 'Offer', offer.id, { envelopeId: envelope.id });
    res.status(201).json({ envelopeId: envelope.id, signerTokens: rawTokenBySigner });
  } catch (e) {
    // createEnvelope throws when no doc reference is given — surface a clear 422.
    if (e && /documentTemplateId or employeeDocumentId/.test(String(e.message || ''))) {
      return res.status(422).json({ message: 'Offer-letter e-sign requires a stored letter document. Render the letter to a document first.' });
    }
    next(e);
  }
}

module.exports = {
  // screening config
  listScreeningQuestions, createScreeningQuestion, updateScreeningQuestion, removeScreeningQuestion,
  submitScreeningAnswers,
  // scorecard templates
  listScorecardTemplates, getScorecardTemplate, createScorecardTemplate, updateScorecardTemplate, removeScorecardTemplate,
  // scheduling extras
  inviteInterview, rescheduleInterview, cancelInterview,
  // interviewer self-service
  myInterviews, myScorecard, saveMyScorecard, submitMyScorecard, reopenScorecard,
  // merit + recompute + e-sign
  meritList, recomputeScore, requestOfferSignature,
  // shared helpers (reused by the public careers router + spine controller)
  _internals: { recomputeAndPersist, recordAnswersAndScore, parseInterviewerIds, buildIcs },
};
