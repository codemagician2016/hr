'use strict';

/**
 * templates.controller.js — Program P1.4: lifecycle TEMPLATE AUTHORING.
 *
 * Until now LifecycleTemplate/LifecycleTaskDef rows were writable only by the
 * per-tenant seeder (templates/seed.js) — checklists were effectively hardcoded
 * (master-plan hotlist item). This controller makes them tenant-authorable:
 *
 *   GET    /lifecycle/templates/meta          enums for the editor dropdowns
 *   GET    /lifecycle/templates?direction=    list (+taskDefs count)
 *   GET    /lifecycle/templates/:id           template + ordered taskDefs
 *   POST   /lifecycle/templates               create (optionally with tasks[])
 *   PATCH  /lifecycle/templates/:id           name/selectors/isDefault/isActive
 *   PUT    /lifecycle/templates/:id/tasks     REPLACE the task-def snapshot
 *   DELETE /lifecycle/templates/:id           soft-delete (never the default)
 *   POST   /lifecycle/templates/seed-defaults (re)seed the stock IN/NZ sets
 *
 * Editing task defs NEVER touches in-flight journeys — their tasks are
 * materialized snapshots (journeyEngine.seedJourneyTasks); a template change
 * affects only journeys created after it. That property is what makes
 * replace-all reconcile (delete-then-recreate, the seeder's own idiom) safe.
 */

const prisma = require('../../../core/lib/prisma');
const { seedOnboardingTemplates } = require('../templates/seed');

// ── enum surfaces (schema.prisma is the source of truth) ─────────────────────
const STAGES = {
  ONBOARDING: ['PRE_JOIN', 'SELF_ONBOARDING', 'DOCS_ESIGN', 'PROVISIONING', 'DAY_ONE', 'WEEK_ONE', 'PROBATION'],
  OFFBOARDING: ['SEPARATION_INITIATED', 'NOTICE', 'CLEARANCE', 'ASSET_RETURN', 'FNF', 'EXIT_DOCS', 'POST_EXIT'],
};
const TASK_KEYS = {
  ONBOARDING: ['COLLECT_PERSONAL', 'COLLECT_STATUTORY', 'COLLECT_BANK', 'COLLECT_EMERGENCY', 'UPLOAD_DOCS',
    'ESIGN_OFFER', 'ESIGN_CONTRACT', 'ESIGN_POLICIES', 'PROVISION_EMPLOYEE', 'ASSIGN_ASSET', 'VERIFY_DOCS', 'PROBATION_REVIEW'],
  OFFBOARDING: ['ACCEPT_RESIGNATION', 'KNOWLEDGE_TRANSFER', 'RETURN_ASSET', 'CLEARANCE_IT', 'CLEARANCE_FINANCE',
    'CLEARANCE_ADMIN', 'COMPUTE_FNF', 'GENERATE_RELIEVING', 'GENERATE_EXPERIENCE', 'EXIT_INTERVIEW', 'REVOKE_ACCESS'],
};
const OWNERS = ['NEW_HIRE', 'EMPLOYEE', 'MANAGER', 'HR', 'IT', 'FINANCE', 'ADMIN'];
const ANCHORS = ['OFFER_ACCEPT', 'JOIN_DATE', 'NOTICE_START', 'LWD', 'RELIEVING'];
const DOC_CATEGORIES = ['ID_PROOF', 'ADDRESS_PROOF', 'PAN', 'AADHAAR', 'PASSPORT', 'VISA', 'WORK_PERMIT',
  'EDUCATION', 'EXPERIENCE', 'OFFER_LETTER', 'CONTRACT', 'PAYSLIP_COPY', 'TAX_DECLARATION', 'FORM16', 'BANK_PROOF', 'OTHER'];
const ESIGN_KINDS = ['OFFER_LETTER', 'APPOINTMENT_LETTER', 'CONFIRMATION_LETTER', 'PROMOTION_LETTER',
  'RELIEVING_LETTER', 'EXPERIENCE_LETTER', 'SALARY_CERTIFICATE', 'WARNING_LETTER'];
const ASSET_CATEGORIES = ['LAPTOP', 'DESKTOP', 'MOBILE', 'MONITOR', 'ACCESSORY', 'SIM', 'VEHICLE',
  'FURNITURE', 'ID_CARD', 'ACCESS_CARD', 'OTHER'];
const MAX_TASKS = 100;

function meta(req, res) {
  res.json({
    stages: STAGES, taskKeys: TASK_KEYS, owners: OWNERS, anchors: ANCHORS,
    documentCategories: DOC_CATEGORIES, esignTemplateKinds: ESIGN_KINDS, assetCategories: ASSET_CATEGORIES,
    maxTasks: MAX_TASKS,
  });
}

/** Validate one task-def payload for a direction. Returns error string | null. */
function validateTask(t, direction, i) {
  const n = `Task ${i + 1}`;
  if (!t || typeof t !== 'object') return `${n} must be an object.`;
  if (!STAGES[direction].includes(t.stageKey)) return `${n}: stageKey must be one of the ${direction.toLowerCase()} stages.`;
  if (t.taskKey != null && !TASK_KEYS[direction].includes(t.taskKey)) return `${n}: unknown taskKey "${t.taskKey}" for ${direction} (leave empty for a manual task).`;
  if (!t.title || typeof t.title !== 'string' || !t.title.trim()) return `${n}: title is required.`;
  if (t.title.length > 200) return `${n}: title too long (200 max).`;
  if (!OWNERS.includes(t.ownerRole)) return `${n}: ownerRole must be one of ${OWNERS.join(', ')}.`;
  if (t.dueAnchor != null && !ANCHORS.includes(t.dueAnchor)) return `${n}: bad dueAnchor.`;
  if (t.dueOffsetDays != null && (!Number.isInteger(t.dueOffsetDays) || Math.abs(t.dueOffsetDays) > 365)) return `${n}: dueOffsetDays must be an integer within ±365.`;
  if (t.taskOrder != null && !Number.isInteger(t.taskOrder)) return `${n}: taskOrder must be an integer.`;
  if (t.documentCategory != null && !DOC_CATEGORIES.includes(t.documentCategory)) return `${n}: bad documentCategory.`;
  if (t.esignTemplateKind != null && !ESIGN_KINDS.includes(t.esignTemplateKind)) return `${n}: bad esignTemplateKind.`;
  if (t.assetCategory != null && !ASSET_CATEGORIES.includes(t.assetCategory)) return `${n}: bad assetCategory.`;
  return null;
}

function pickTask(t, businessId, templateId, i) {
  return {
    businessId, templateId,
    stageKey: t.stageKey,
    taskKey: t.taskKey || null,
    title: String(t.title).trim(),
    description: t.description ? String(t.description) : null,
    ownerRole: t.ownerRole,
    taskOrder: Number.isInteger(t.taskOrder) ? t.taskOrder : i,
    dueOffsetDays: Number.isInteger(t.dueOffsetDays) ? t.dueOffsetDays : 0,
    dueAnchor: t.dueAnchor || 'JOIN_DATE',
    isBlocking: t.isBlocking !== false,
    isMandatory: t.isMandatory !== false,
    documentCategory: t.documentCategory || null,
    esignTemplateKind: t.esignTemplateKind || null,
    assetCategory: t.assetCategory || null,
  };
}

/** Validate applicability selectors reference tenant rows. Returns err|null. */
async function checkSelectors(businessId, body) {
  if (body.entityId) {
    const e = await prisma.entity.findFirst({ where: { id: body.entityId, businessId, deletedAt: null }, select: { id: true } });
    if (!e) return 'entityId is not an entity of this tenant.';
  }
  if (body.departmentId) {
    const d = await prisma.department.findFirst({ where: { id: body.departmentId, businessId, deletedAt: null }, select: { id: true } });
    if (!d) return 'departmentId is not a department of this tenant.';
  }
  if (body.designationId) {
    const d = await prisma.designation.findFirst({ where: { id: body.designationId, businessId, deletedAt: null }, select: { id: true } });
    if (!d) return 'designationId is not a designation of this tenant.';
  }
  return null;
}

/** Making this template the default clears the flag on same-scope siblings. */
async function clearOtherDefaults(tx, businessId, direction, countryCode, keepId) {
  await tx.lifecycleTemplate.updateMany({
    where: {
      businessId, direction, deletedAt: null, id: { not: keepId },
      // countryCode null = all-country default; a country-specific default only
      // displaces siblings of the SAME country (getDefault* prefers country match).
      countryCode: countryCode || null,
    },
    data: { isDefault: false },
  });
}

async function list(req, res, next) {
  try {
    const { businessId } = req.user;
    const { direction } = req.query;
    const where = { businessId, deletedAt: null };
    if (direction) where.direction = direction;
    const items = await prisma.lifecycleTemplate.findMany({
      where,
      orderBy: [{ direction: 'asc' }, { isDefault: 'desc' }, { createdAt: 'asc' }],
      include: { _count: { select: { taskDefs: true } } },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

async function get(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.lifecycleTemplate.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: { taskDefs: { orderBy: [{ stageKey: 'asc' }, { taskOrder: 'asc' }] } },
    });
    if (!item) return res.status(404).json({ message: 'Template not found' });
    res.json(item);
  } catch (e) { next(e); }
}

async function create(req, res, next) {
  try {
    const { businessId } = req.user;
    const { name, direction, countryCode, entityId, departmentId, designationId, isDefault, tasks } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'name is required' });
    if (direction !== 'ONBOARDING' && direction !== 'OFFBOARDING') {
      return res.status(400).json({ message: 'direction must be ONBOARDING or OFFBOARDING' });
    }
    if (countryCode != null && !/^[A-Z]{2}$/.test(countryCode)) return res.status(400).json({ message: 'countryCode must be a 2-letter code' });
    const selErr = await checkSelectors(businessId, req.body || {});
    if (selErr) return res.status(400).json({ message: selErr });
    const taskList = Array.isArray(tasks) ? tasks : [];
    if (taskList.length > MAX_TASKS) return res.status(400).json({ message: `At most ${MAX_TASKS} tasks per template.` });
    for (let i = 0; i < taskList.length; i += 1) {
      const err = validateTask(taskList[i], direction, i);
      if (err) return res.status(400).json({ message: err });
    }

    // Human code: <ONBT|OFBT>-C<seq>, unique per tenant (bounded retry on race).
    const prefix = direction === 'ONBOARDING' ? 'ONBT' : 'OFBT';
    const count = await prisma.lifecycleTemplate.count({ where: { businessId, direction } });
    let created = null;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      const code = `${prefix}-C${count + 1 + attempt}`;
      try {
        created = await prisma.$transaction(async (tx) => {
          const tpl = await tx.lifecycleTemplate.create({
            data: {
              businessId, code, name: String(name).trim(), direction,
              countryCode: countryCode || null,
              entityId: entityId || null, departmentId: departmentId || null, designationId: designationId || null,
              isDefault: isDefault === true, isActive: true,
            },
          });
          if (taskList.length) {
            await tx.lifecycleTaskDef.createMany({ data: taskList.map((t, i) => pickTask(t, businessId, tpl.id, i)) });
          }
          if (isDefault === true) await clearOtherDefaults(tx, businessId, direction, countryCode, tpl.id);
          return tpl;
        });
      } catch (e) {
        if (e.code !== 'P2002') throw e; // unique(code) race → try next suffix
      }
    }
    if (!created) return res.status(409).json({ message: 'Could not allocate a template code — retry.' });
    const full = await prisma.lifecycleTemplate.findFirst({
      where: { id: created.id }, include: { taskDefs: { orderBy: [{ stageKey: 'asc' }, { taskOrder: 'asc' }] } },
    });
    res.status(201).json(full);
  } catch (e) { next(e); }
}

async function update(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.lifecycleTemplate.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Template not found' });
    const b = req.body || {};
    const selErr = await checkSelectors(businessId, b);
    if (selErr) return res.status(400).json({ message: selErr });
    if (b.countryCode != null && b.countryCode !== '' && !/^[A-Z]{2}$/.test(b.countryCode)) {
      return res.status(400).json({ message: 'countryCode must be a 2-letter code' });
    }
    // Unsetting the ONLY default is blocked — journeys need a resolvable default.
    if (b.isDefault === false && existing.isDefault) {
      const other = await prisma.lifecycleTemplate.findFirst({
        where: { businessId, direction: existing.direction, isDefault: true, isActive: true, deletedAt: null, id: { not: existing.id } },
      });
      if (!other) return res.status(409).json({ message: 'This is the only default template for its direction — make another template the default first.' });
    }
    const data = {};
    for (const f of ['name', 'entityId', 'departmentId', 'designationId', 'isActive', 'isDefault']) {
      if (b[f] !== undefined) data[f] = b[f];
    }
    if (b.countryCode !== undefined) data.countryCode = b.countryCode || null;
    if (data.name != null) data.name = String(data.name).trim();
    const item = await prisma.$transaction(async (tx) => {
      const upd = await tx.lifecycleTemplate.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } });
      if (data.isDefault === true) {
        await clearOtherDefaults(tx, businessId, existing.direction, upd.countryCode, existing.id);
      }
      return upd;
    });
    res.json(item);
  } catch (e) { next(e); }
}

async function replaceTasks(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.lifecycleTemplate.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Template not found' });
    const tasks = req.body && Array.isArray(req.body.tasks) ? req.body.tasks : null;
    if (!tasks || tasks.length === 0) return res.status(400).json({ message: 'tasks[] (non-empty) is required — a template with no tasks cannot drive a journey.' });
    if (tasks.length > MAX_TASKS) return res.status(400).json({ message: `At most ${MAX_TASKS} tasks per template.` });
    for (let i = 0; i < tasks.length; i += 1) {
      const err = validateTask(tasks[i], existing.direction, i);
      if (err) return res.status(400).json({ message: err });
    }
    // Seeder idiom: reconcile = delete-then-recreate the snapshot. In-flight
    // journeys hold materialized copies — untouched by design.
    await prisma.$transaction([
      prisma.lifecycleTaskDef.deleteMany({ where: { businessId, templateId: existing.id } }),
      prisma.lifecycleTaskDef.createMany({ data: tasks.map((t, i) => pickTask(t, businessId, existing.id, i)) }),
      prisma.lifecycleTemplate.update({ where: { id: existing.id }, data: { version: { increment: 1 } } }),
    ]);
    const full = await prisma.lifecycleTemplate.findFirst({
      where: { id: existing.id }, include: { taskDefs: { orderBy: [{ stageKey: 'asc' }, { taskOrder: 'asc' }] } },
    });
    res.json(full);
  } catch (e) { next(e); }
}

async function remove(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.lifecycleTemplate.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Template not found' });
    if (existing.isDefault) {
      return res.status(409).json({ message: 'Cannot delete the default template — make another template the default first.' });
    }
    await prisma.lifecycleTemplate.update({ where: { id: existing.id }, data: { deletedAt: new Date(), isActive: false } });
    res.status(204).end();
  } catch (e) { next(e); }
}

async function seedDefaults(req, res, next) {
  try {
    const { businessId } = req.user;
    const entity = await prisma.entity.findFirst({ where: { businessId, deletedAt: null }, select: { id: true } });
    await seedOnboardingTemplates(prisma, businessId, { entityId: entity ? entity.id : null });
    const items = await prisma.lifecycleTemplate.findMany({
      where: { businessId, deletedAt: null },
      include: { _count: { select: { taskDefs: true } } },
      orderBy: [{ direction: 'asc' }, { createdAt: 'asc' }],
    });
    res.json({ seeded: true, items });
  } catch (e) { next(e); }
}

module.exports = { meta, list, get, create, update, replaceTasks, remove, seedDefaults };
