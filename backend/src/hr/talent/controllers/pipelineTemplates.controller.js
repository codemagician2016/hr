'use strict';
// Recruitment pipeline templates (Phase 4) — reusable, named sets of pipeline
// stages that materialise onto a Job's JobStage rows in one shot (instead of
// adding stages one-by-one). Tenant-scoped by req.user.businessId; soft-deleted
// via deletedAt; at most one template per tenant is the default.
//
// APPLY SEMANTICS (POST /:id/apply, POST /jobs/:id/apply-template):
//   • Job has NO stages → materialise the template's stages (append). 200.
//   • Job HAS stages and NO ?replace=true → 409 STAGES_EXIST (never silently
//     doubles a pipeline).
//   • Job HAS stages and ?replace=true → allowed ONLY when the job has no
//     applications. Application.currentStageId is a LOOSE column (no FK to
//     JobStage), so deleting stages under live applications would orphan their
//     pipeline position — that is refused with 409 STAGES_IN_USE. With no
//     applications, the existing stages are deleted and replaced atomically.
// This "append-if-empty, guarded-replace" rule is the safe choice: it can never
// orphan an in-flight candidate's stage pointer.
const prisma = require('../../../core/lib/prisma');

// Mirrors prisma enum StageKind (do NOT duplicate the enum — this is the value list).
const STAGE_KINDS = ['SOURCED', 'SCREENING', 'INTERVIEW', 'ASSESSMENT', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'];

const TEMPLATE_INCLUDE = { stages: { orderBy: { sortOrder: 'asc' } } };

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Validate an incoming stages[] payload. Each stage needs a non-empty name and a
// valid StageKind. undefined → ok (no stages supplied). Returns { ok, error?, stages }.
function validateStages(stages) {
  if (stages === undefined || stages === null) return { ok: true, stages: [] };
  if (!Array.isArray(stages)) return { ok: false, error: 'stages must be an array' };
  for (const s of stages) {
    if (!s || typeof s !== 'object') return { ok: false, error: 'each stage must be an object' };
    if (s.name == null || String(s.name).trim() === '') return { ok: false, error: 'each stage requires a name' };
    if (!STAGE_KINDS.includes(s.kind)) {
      return { ok: false, error: `each stage requires a valid kind (one of ${STAGE_KINDS.join(', ')})` };
    }
  }
  return { ok: true, stages };
}

// Order + re-sequence stages for materialisation. Sorts by the supplied sortOrder
// (missing → its original index), stable on original position for ties, then
// re-assigns a CONTIGUOUS 0-based sortOrder. This guarantees the JobStage /
// PipelineTemplateStage unique (…, sortOrder) constraint can never collide even
// if the caller supplied duplicate or gappy sortOrders. Pure — no DB.
function orderStagesForMaterialization(stages) {
  const arr = (stages || []).map((s, i) => ({
    name: String(s.name),
    kind: s.kind,
    _order: Number.isFinite(Number(s.sortOrder)) ? Number(s.sortOrder) : i,
    _idx: i,
  }));
  arr.sort((a, b) => (a._order - b._order) || (a._idx - b._idx));
  return arr.map((s, idx) => ({ name: s.name, kind: s.kind, sortOrder: idx }));
}

// ── Internal DB helpers ──────────────────────────────────────────────────────

// Materialise an ordered stage list onto a job as JobStage rows (within `db`,
// which may be a tx client). Returns the created count.
async function materializeStages(db, businessId, jobId, orderedStages) {
  if (!orderedStages.length) return 0;
  await db.jobStage.createMany({
    data: orderedStages.map((s) => ({ businessId, jobId, name: s.name, kind: s.kind, sortOrder: s.sortOrder })),
  });
  return orderedStages.length;
}

// createJob auto-seed hook: if the tenant has a default template with stages and
// the job has none, materialise the default onto the job. Best-effort — the
// caller wraps it so a failure never blocks job creation. Returns a small summary.
async function autoApplyDefaultTemplate(db, businessId, jobId) {
  const tpl = await db.pipelineTemplate.findFirst({
    where: { businessId, isDefault: true, deletedAt: null },
    include: TEMPLATE_INCLUDE,
  });
  if (!tpl || !tpl.stages.length) return { applied: false };
  const existing = await db.jobStage.count({ where: { businessId, jobId } });
  if (existing > 0) return { applied: false };
  const ordered = orderStagesForMaterialization(tpl.stages);
  const count = await materializeStages(db, businessId, jobId, ordered);
  return { applied: true, templateId: tpl.id, count };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

async function listTemplates(req, res, next) {
  try {
    const { businessId } = req.user;
    const items = await prisma.pipelineTemplate.findMany({
      where: { businessId, deletedAt: null },
      include: TEMPLATE_INCLUDE,
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    res.json({ items });
  } catch (e) { next(e); }
}

async function getTemplate(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.pipelineTemplate.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: TEMPLATE_INCLUDE,
    });
    if (!item) return res.status(404).json({ message: 'Pipeline template not found' });
    res.json(item);
  } catch (e) { next(e); }
}

async function createTemplate(req, res, next) {
  try {
    const { businessId } = req.user;
    const { name } = req.body;
    if (name == null || String(name).trim() === '') {
      return res.status(400).json({ message: 'name is required' });
    }
    const v = validateStages(req.body.stages);
    if (!v.ok) return res.status(422).json({ message: v.error });
    const ordered = orderStagesForMaterialization(v.stages);
    const isDefault = !!req.body.isDefault;

    const created = await prisma.$transaction(async (tx) => {
      // At most one default — flipping this one default unsets the others.
      if (isDefault) {
        await tx.pipelineTemplate.updateMany({
          where: { businessId, isDefault: true, deletedAt: null },
          data: { isDefault: false },
        });
      }
      const tpl = await tx.pipelineTemplate.create({
        data: {
          businessId,
          name: String(name).trim(),
          description: req.body.description != null ? String(req.body.description) : null,
          isDefault,
        },
      });
      if (ordered.length) {
        await tx.pipelineTemplateStage.createMany({
          data: ordered.map((s) => ({ businessId, templateId: tpl.id, name: s.name, kind: s.kind, sortOrder: s.sortOrder })),
        });
      }
      return tx.pipelineTemplate.findUnique({ where: { id: tpl.id }, include: TEMPLATE_INCLUDE });
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A pipeline template with that name already exists' });
    next(e);
  }
}

async function updateTemplate(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.pipelineTemplate.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Pipeline template not found' });

    const data = {};
    if (req.body.name !== undefined) {
      if (String(req.body.name).trim() === '') return res.status(400).json({ message: 'name cannot be empty' });
      data.name = String(req.body.name).trim();
    }
    if (req.body.description !== undefined) data.description = req.body.description != null ? String(req.body.description) : null;
    let setDefaultTrue = false;
    if (req.body.isDefault !== undefined) { data.isDefault = !!req.body.isDefault; setDefaultTrue = !!req.body.isDefault; }

    // Optional full stage replacement.
    let ordered = null;
    if (req.body.stages !== undefined) {
      const v = validateStages(req.body.stages);
      if (!v.ok) return res.status(422).json({ message: v.error });
      ordered = orderStagesForMaterialization(v.stages);
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (setDefaultTrue) {
        await tx.pipelineTemplate.updateMany({
          where: { businessId, isDefault: true, deletedAt: null, id: { not: existing.id } },
          data: { isDefault: false },
        });
      }
      if (Object.keys(data).length) await tx.pipelineTemplate.update({ where: { id: existing.id }, data });
      if (ordered !== null) {
        await tx.pipelineTemplateStage.deleteMany({ where: { businessId, templateId: existing.id } });
        if (ordered.length) {
          await tx.pipelineTemplateStage.createMany({
            data: ordered.map((s) => ({ businessId, templateId: existing.id, name: s.name, kind: s.kind, sortOrder: s.sortOrder })),
          });
        }
      }
      return tx.pipelineTemplate.findUnique({ where: { id: existing.id }, include: TEMPLATE_INCLUDE });
    });
    res.json(updated);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A pipeline template with that name already exists' });
    next(e);
  }
}

async function removeTemplate(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.pipelineTemplate.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Pipeline template not found' });
    // Soft-delete + clear the default flag (a deleted template is never the default).
    await prisma.pipelineTemplate.update({ where: { id: existing.id }, data: { deletedAt: new Date(), isDefault: false } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// ── Apply (materialise onto a job) ───────────────────────────────────────────

async function applyCore({ businessId, templateId, jobId, replace }) {
  if (!jobId) return { status: 400, body: { message: 'jobId is required' } };
  if (!templateId) return { status: 400, body: { message: 'templateId is required' } };

  const template = await prisma.pipelineTemplate.findFirst({
    where: { id: templateId, businessId, deletedAt: null },
    include: TEMPLATE_INCLUDE,
  });
  if (!template) return { status: 404, body: { message: 'Pipeline template not found' } };
  const job = await prisma.job.findFirst({ where: { id: jobId, businessId, deletedAt: null }, select: { id: true } });
  if (!job) return { status: 404, body: { message: 'Job not found' } };
  if (!template.stages.length) return { status: 422, body: { message: 'Template has no stages to apply' } };

  const existing = await prisma.jobStage.count({ where: { businessId, jobId } });
  if (existing > 0 && !replace) {
    return { status: 409, body: { message: 'Job already has pipeline stages. Pass ?replace=true to replace them.', code: 'STAGES_EXIST' } };
  }
  if (existing > 0 && replace) {
    // currentStageId is a loose reference (no FK); replacing under live
    // applications would orphan their pipeline position → refuse.
    const apps = await prisma.application.count({ where: { businessId, jobId } });
    if (apps > 0) {
      return { status: 409, body: { message: 'Cannot replace stages: this job has applications referencing existing stages (would orphan pipeline positions).', code: 'STAGES_IN_USE' } };
    }
  }

  const ordered = orderStagesForMaterialization(template.stages);
  const stages = await prisma.$transaction(async (tx) => {
    if (existing > 0 && replace) await tx.jobStage.deleteMany({ where: { businessId, jobId } });
    await materializeStages(tx, businessId, jobId, ordered);
    return tx.jobStage.findMany({ where: { businessId, jobId }, orderBy: { sortOrder: 'asc' } });
  });
  return { status: 200, body: { jobId, templateId, replaced: existing > 0 && !!replace, stages } };
}

function wantsReplace(req) {
  return req.query.replace === 'true' || req.query.replace === '1' || req.body.replace === true;
}

// POST /pipeline-templates/:id/apply  { jobId }
async function applyTemplate(req, res, next) {
  try {
    const { businessId } = req.user;
    const out = await applyCore({ businessId, templateId: req.params.id, jobId: req.body.jobId, replace: wantsReplace(req) });
    res.status(out.status).json(out.body);
  } catch (e) { next(e); }
}

// POST /jobs/:id/apply-template  { templateId }  — alias keyed by job.
async function applyTemplateToJob(req, res, next) {
  try {
    const { businessId } = req.user;
    const out = await applyCore({ businessId, templateId: req.body.templateId, jobId: req.params.id, replace: wantsReplace(req) });
    res.status(out.status).json(out.body);
  } catch (e) { next(e); }
}

// ── Seed standard templates (idempotent, also lazy-usable) ───────────────────
const DEFAULT_TEMPLATES = [
  {
    name: 'Standard hiring',
    description: 'Sourced → Screening → Interview → Offer → Hired (+ Rejected).',
    preferDefault: true,
    stages: [
      { name: 'Sourced', kind: 'SOURCED' },
      { name: 'Screening', kind: 'SCREENING' },
      { name: 'Interview', kind: 'INTERVIEW' },
      { name: 'Offer', kind: 'OFFER' },
      { name: 'Hired', kind: 'HIRED' },
      { name: 'Rejected', kind: 'REJECTED' },
    ],
  },
  {
    name: 'Technical hiring',
    description: 'Adds a take-home / assessment stage before the interview loop.',
    preferDefault: false,
    stages: [
      { name: 'Sourced', kind: 'SOURCED' },
      { name: 'Screening', kind: 'SCREENING' },
      { name: 'Assessment', kind: 'ASSESSMENT' },
      { name: 'Interview', kind: 'INTERVIEW' },
      { name: 'Offer', kind: 'OFFER' },
      { name: 'Hired', kind: 'HIRED' },
      { name: 'Rejected', kind: 'REJECTED' },
    ],
  },
];

async function seedDefaults(req, res, next) {
  try {
    const { businessId } = req.user;
    const created = [];
    const skipped = [];
    // Only claim the default flag if the tenant has none yet (never steal it).
    const hasDefault = (await prisma.pipelineTemplate.count({ where: { businessId, isDefault: true, deletedAt: null } })) > 0;
    let defaultTaken = hasDefault;

    for (const def of DEFAULT_TEMPLATES) {
      const exists = await prisma.pipelineTemplate.findFirst({ where: { businessId, name: def.name, deletedAt: null }, select: { id: true } });
      if (exists) { skipped.push(def.name); continue; }
      const isDefault = def.preferDefault && !defaultTaken;
      if (isDefault) defaultTaken = true;
      const ordered = orderStagesForMaterialization(def.stages);
      try {
        const tpl = await prisma.$transaction(async (tx) => {
          const t = await tx.pipelineTemplate.create({ data: { businessId, name: def.name, description: def.description, isDefault } });
          await tx.pipelineTemplateStage.createMany({
            data: ordered.map((s) => ({ businessId, templateId: t.id, name: s.name, kind: s.kind, sortOrder: s.sortOrder })),
          });
          return t;
        });
        created.push({ id: tpl.id, name: def.name, isDefault });
      } catch (e) {
        // A concurrent seed already created it → treat as skipped (idempotent).
        if (e.code === 'P2002') { skipped.push(def.name); continue; }
        throw e;
      }
    }
    res.json({ created, skipped });
  } catch (e) { next(e); }
}

module.exports = {
  listTemplates, getTemplate, createTemplate, updateTemplate, removeTemplate,
  applyTemplate, applyTemplateToJob, seedDefaults,
  // Reused by recruitment.controller.createJob (default auto-seed).
  autoApplyDefaultTemplate,
  // Pure helpers for unit testing + reuse.
  _internals: { STAGE_KINDS, validateStages, orderStagesForMaterialization, materializeStages, applyCore },
};
