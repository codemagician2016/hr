'use strict';

/**
 * screeningFormTemplates.controller.js — REUSABLE application-form (screening)
 * templates. Mirrors pipelineTemplates.controller.js (the proven "template → apply
 * to job" pattern) but for the candidate-facing screening questions rather than the
 * interview stages.
 *
 *   - CRUD a library of named form templates (each a set of screening questions with
 *     the same 6 kinds, knockout + scoring + options as a per-job question).
 *   - POST /jobs/:id/apply-screening-template stamps a template's questions onto a
 *     job as its ScreeningQuestion rows (COPIES — snapshot semantics; editing the
 *     template later never mutates a job already built from it). A different template
 *     can be applied to each job.
 *
 * Everything is hard-scoped to req.user.businessId.
 */

const prisma = require('../../../core/lib/prisma');
const { writeAudit } = require('../../../core/lib/audit');

const TEMPLATE_INCLUDE = {
  questions: {
    orderBy: { sortOrder: 'asc' },
    include: { options: { orderBy: { sortOrder: 'asc' } } },
  },
};

const KINDS = new Set(['BOOLEAN', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'NUMBER', 'TEXT', 'QUALIFICATION', 'FILE']);
const NEEDS_OPTIONS = new Set(['SINGLE_CHOICE', 'MULTI_CHOICE', 'QUALIFICATION']);
// A FILE answer is an uploaded document's URL. There is nothing to compare it
// against, so it can be neither a knockout nor points-scored — forcing those off
// here rather than trusting the client keeps a mis-built form from silently
// auto-rejecting every applicant.
const NEVER_SCORED = new Set(['FILE']);
// Only choice kinds can carry an "Other (please specify)" option; a free-text
// flag on anything else would render a box the answer model has no slot for.
const CAN_FREE_TEXT = new Set(['SINGLE_CHOICE', 'MULTI_CHOICE']);

async function audit(businessId, actorId, action, entityId, meta) {
  return writeAudit({ businessId, actorId, action, entityType: 'ScreeningFormTemplate', entityId, meta }).catch(() => {});
}

// Normalise + validate the questions payload. Returns { ok, questions } | { ok:false, error }.
// Mirrors the per-job screening-question rules: prompt + valid kind required; choice/
// qualification kinds need at least one option; options carry label/value/points.
function validateQuestions(input) {
  if (input == null) return { ok: true, questions: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'questions must be an array' };
  const questions = [];
  const seenSort = new Set();
  input.forEach((q, i) => {
    if (!q || typeof q !== 'object') throw { error: `question[${i}] must be an object` };
    const prompt = String(q.prompt || '').trim();
    if (!prompt) throw { error: `question[${i}].prompt is required` };
    const kind = String(q.kind || '').toUpperCase();
    if (!KINDS.has(kind)) throw { error: `question[${i}].kind must be one of ${[...KINDS].join('/')}` };
    const rawOpts = Array.isArray(q.options) ? q.options : [];
    if (NEEDS_OPTIONS.has(kind) && rawOpts.length === 0) throw { error: `question[${i}] (${kind}) needs at least one option` };
    const options = rawOpts.map((o, oi) => ({
      label: String(o.label || '').trim() || String(o.value ?? '').trim(),
      value: String(o.value ?? o.label ?? '').trim(),
      points: Number.isFinite(Number(o.points)) ? Number(o.points) : 0,
      sortOrder: Number.isInteger(o.sortOrder) ? o.sortOrder : oi,
      allowsFreeText: CAN_FREE_TEXT.has(kind) ? !!o.allowsFreeText : false,
    }));
    if (options.some((o) => !o.value)) throw { error: `question[${i}] has an option with an empty value` };
    const sortOrder = Number.isInteger(q.sortOrder) ? q.sortOrder : i;
    if (seenSort.has(sortOrder)) throw { error: `duplicate sortOrder ${sortOrder}` };
    seenSort.add(sortOrder);
    questions.push({
      prompt,
      kind,
      required: q.required !== undefined ? !!q.required : true,
      isKnockout: NEVER_SCORED.has(kind) ? false : !!q.isKnockout,
      knockoutValue: NEVER_SCORED.has(kind) ? null : (q.knockoutValue !== undefined ? q.knockoutValue : null),
      maxPoints: NEVER_SCORED.has(kind)
        ? null
        : (q.maxPoints != null && Number.isFinite(Number(q.maxPoints)) ? Number(q.maxPoints) : null),
      sortOrder,
      options,
    });
  });
  questions.sort((a, b) => a.sortOrder - b.sortOrder);
  return { ok: true, questions };
}

function safeValidate(input) {
  try { return validateQuestions(input); } catch (e) { return { ok: false, error: e.error || 'invalid questions' }; }
}

async function listTemplates(req, res, next) {
  try {
    const { businessId } = req.user;
    const items = await prisma.screeningFormTemplate.findMany({
      where: { businessId, deletedAt: null },
      include: TEMPLATE_INCLUDE,
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

async function getTemplate(req, res, next) {
  try {
    const { businessId } = req.user;
    const tpl = await prisma.screeningFormTemplate.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: TEMPLATE_INCLUDE,
    });
    if (!tpl) return res.status(404).json({ message: 'Screening form template not found' });
    res.json(tpl);
  } catch (e) { next(e); }
}

async function createTemplate(req, res, next) {
  try {
    const { businessId } = req.user;
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'name is required' });
    const v = safeValidate(req.body.questions);
    if (!v.ok) return res.status(422).json({ message: v.error });
    const isDefault = !!req.body.isDefault;

    const created = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.screeningFormTemplate.updateMany({ where: { businessId, isDefault: true, deletedAt: null }, data: { isDefault: false } });
      }
      const tpl = await tx.screeningFormTemplate.create({
        data: { businessId, name, description: req.body.description != null ? String(req.body.description) : null, isDefault },
      });
      for (const q of v.questions) {
        await tx.screeningFormTemplateQuestion.create({
          data: {
            businessId, templateId: tpl.id, prompt: q.prompt, kind: q.kind, required: q.required,
            isKnockout: q.isKnockout, knockoutValue: q.knockoutValue, maxPoints: q.maxPoints, sortOrder: q.sortOrder,
            options: { create: q.options.map((o) => ({ businessId, label: o.label, value: o.value, points: o.points, sortOrder: o.sortOrder, allowsFreeText: o.allowsFreeText })) },
          },
        });
      }
      return tx.screeningFormTemplate.findUnique({ where: { id: tpl.id }, include: TEMPLATE_INCLUDE });
    });
    await audit(businessId, req.user.id, 'recruitment.screeningFormTemplate.create', created.id, { questions: created.questions.length });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A screening form template with that name already exists' });
    next(e);
  }
}

async function updateTemplate(req, res, next) {
  try {
    const { businessId } = req.user;
    const tpl = await prisma.screeningFormTemplate.findFirst({ where: { id: req.params.id, businessId, deletedAt: null }, select: { id: true } });
    if (!tpl) return res.status(404).json({ message: 'Screening form template not found' });

    const hasQuestions = req.body.questions !== undefined;
    let v = { questions: [] };
    if (hasQuestions) { v = safeValidate(req.body.questions); if (!v.ok) return res.status(422).json({ message: v.error }); }
    const isDefault = req.body.isDefault;

    const updated = await prisma.$transaction(async (tx) => {
      if (isDefault === true) {
        await tx.screeningFormTemplate.updateMany({ where: { businessId, isDefault: true, deletedAt: null, id: { not: tpl.id } }, data: { isDefault: false } });
      }
      await tx.screeningFormTemplate.update({
        where: { id: tpl.id },
        data: {
          ...(req.body.name !== undefined ? { name: String(req.body.name).trim() } : {}),
          ...(req.body.description !== undefined ? { description: req.body.description != null ? String(req.body.description) : null } : {}),
          ...(isDefault !== undefined ? { isDefault: !!isDefault } : {}),
        },
      });
      if (hasQuestions) {
        // Replace the whole question set (options cascade on the question delete).
        await tx.screeningFormTemplateQuestion.deleteMany({ where: { businessId, templateId: tpl.id } });
        for (const q of v.questions) {
          await tx.screeningFormTemplateQuestion.create({
            data: {
              businessId, templateId: tpl.id, prompt: q.prompt, kind: q.kind, required: q.required,
              isKnockout: q.isKnockout, knockoutValue: q.knockoutValue, maxPoints: q.maxPoints, sortOrder: q.sortOrder,
              options: { create: q.options.map((o) => ({ businessId, label: o.label, value: o.value, points: o.points, sortOrder: o.sortOrder, allowsFreeText: o.allowsFreeText })) },
            },
          });
        }
      }
      return tx.screeningFormTemplate.findUnique({ where: { id: tpl.id }, include: TEMPLATE_INCLUDE });
    });
    await audit(businessId, req.user.id, 'recruitment.screeningFormTemplate.update', updated.id, {});
    res.json(updated);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A screening form template with that name already exists' });
    next(e);
  }
}

async function removeTemplate(req, res, next) {
  try {
    const { businessId } = req.user;
    const tpl = await prisma.screeningFormTemplate.findFirst({ where: { id: req.params.id, businessId, deletedAt: null }, select: { id: true } });
    if (!tpl) return res.status(404).json({ message: 'Screening form template not found' });
    await prisma.screeningFormTemplate.update({ where: { id: tpl.id }, data: { deletedAt: new Date() } });
    await audit(businessId, req.user.id, 'recruitment.screeningFormTemplate.delete', tpl.id, {});
    res.json({ ok: true, id: tpl.id });
  } catch (e) { next(e); }
}

// Stamp a template's questions onto a job as its ScreeningQuestion rows (copies).
async function applyCore({ businessId, templateId, jobId, replace }) {
  if (!jobId) return { status: 400, body: { message: 'jobId is required' } };
  if (!templateId) return { status: 400, body: { message: 'templateId is required' } };

  const template = await prisma.screeningFormTemplate.findFirst({
    where: { id: templateId, businessId, deletedAt: null }, include: TEMPLATE_INCLUDE,
  });
  if (!template) return { status: 404, body: { message: 'Screening form template not found' } };
  const job = await prisma.job.findFirst({ where: { id: jobId, businessId, deletedAt: null }, select: { id: true } });
  if (!job) return { status: 404, body: { message: 'Job not found' } };
  if (!template.questions.length) return { status: 422, body: { message: 'Template has no questions to apply' } };

  const existing = await prisma.screeningQuestion.count({ where: { businessId, jobId, deletedAt: null } });
  if (existing > 0 && !replace) {
    return { status: 409, body: { message: 'This job already has screening questions. Pass ?replace=true to replace them.', code: 'QUESTIONS_EXIST' } };
  }

  const questions = await prisma.$transaction(async (tx) => {
    if (existing > 0 && replace) {
      // Existing candidate answers snapshot their prompt and are keyed by application
      // (no FK to the question), so replacing the job's questions never orphans them.
      await tx.screeningQuestion.deleteMany({ where: { businessId, jobId } });
    }
    for (const q of template.questions) {
      await tx.screeningQuestion.create({
        data: {
          businessId, jobId, prompt: q.prompt, kind: q.kind, required: q.required,
          isKnockout: q.isKnockout, knockoutValue: q.knockoutValue, maxPoints: q.maxPoints, sortOrder: q.sortOrder,
          options: { create: q.options.map((o) => ({ businessId, label: o.label, value: o.value, points: o.points, sortOrder: o.sortOrder, allowsFreeText: o.allowsFreeText })) },
        },
      });
    }
    return tx.screeningQuestion.findMany({ where: { businessId, jobId }, include: { options: { orderBy: { sortOrder: 'asc' } } }, orderBy: { sortOrder: 'asc' } });
  });
  return { status: 200, body: { jobId, templateId, replaced: existing > 0 && !!replace, questions } };
}

async function applyTemplateToJob(req, res, next) {
  try {
    const { businessId } = req.user;
    const replace = req.query.replace === 'true' || req.query.replace === '1' || req.body.replace === true;
    const out = await applyCore({ businessId, templateId: req.body.templateId, jobId: req.params.id, replace });
    if (out.status === 200) await audit(businessId, req.user.id, 'recruitment.screeningFormTemplate.apply', req.body.templateId, { jobId: req.params.id, replaced: out.body.replaced });
    res.status(out.status).json(out.body);
  } catch (e) { next(e); }
}

// Seed a couple of sensible starter templates (idempotent by name).
async function seedDefaults(req, res, next) {
  try {
    const { businessId } = req.user;
    const DEFAULTS = [
      {
        name: 'General screening', description: 'Baseline eligibility questions for any role.',
        questions: [
          { prompt: 'Are you legally authorised to work in this location?', kind: 'BOOLEAN', required: true, isKnockout: true, knockoutValue: true, sortOrder: 0 },
          { prompt: 'Total years of relevant experience', kind: 'NUMBER', required: true, maxPoints: 10, sortOrder: 1 },
          { prompt: 'Earliest available start date / notice period', kind: 'TEXT', required: true, sortOrder: 2 },
        ],
      },
      {
        name: 'Engineering screening', description: 'Screening for engineering roles.',
        questions: [
          { prompt: 'Highest relevant qualification', kind: 'QUALIFICATION', required: true, sortOrder: 0,
            options: [{ label: "Master's / PhD", value: 'MASTERS', points: 6 }, { label: "Bachelor's", value: 'BACHELORS', points: 4 }, { label: 'Diploma', value: 'DIPLOMA', points: 2 }] },
          { prompt: 'Primary language(s)', kind: 'MULTI_CHOICE', required: true, sortOrder: 1,
            options: [{ label: 'JavaScript/TypeScript', value: 'JS', points: 3 }, { label: 'Python', value: 'PY', points: 3 }, { label: 'Go', value: 'GO', points: 3 }, { label: 'Java', value: 'JAVA', points: 3 }] },
          { prompt: 'Comfortable with on-call rotation?', kind: 'BOOLEAN', required: true, sortOrder: 2 },
        ],
      },
    ];
    const created = [];
    for (const d of DEFAULTS) {
      const exists = await prisma.screeningFormTemplate.findFirst({ where: { businessId, name: d.name, deletedAt: null }, select: { id: true } });
      if (exists) continue;
      const v = validateQuestions(d.questions);
      const tpl = await prisma.$transaction(async (tx) => {
        const t = await tx.screeningFormTemplate.create({ data: { businessId, name: d.name, description: d.description, isDefault: false } });
        for (const q of v.questions) {
          await tx.screeningFormTemplateQuestion.create({
            data: {
              businessId, templateId: t.id, prompt: q.prompt, kind: q.kind, required: q.required, isKnockout: q.isKnockout,
              knockoutValue: q.knockoutValue, maxPoints: q.maxPoints, sortOrder: q.sortOrder,
              options: { create: q.options.map((o) => ({ businessId, label: o.label, value: o.value, points: o.points, sortOrder: o.sortOrder, allowsFreeText: o.allowsFreeText })) },
            },
          });
        }
        return t;
      });
      created.push(tpl.id);
    }
    res.json({ ok: true, created: created.length });
  } catch (e) { next(e); }
}

module.exports = {
  listTemplates, getTemplate, createTemplate, updateTemplate, removeTemplate, applyTemplateToJob, seedDefaults,
  _internals: { validateQuestions, applyCore },
};
