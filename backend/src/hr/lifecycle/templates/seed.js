'use strict';

/**
 * templates/seed.js — default ONBOARDING LifecycleTemplate + LifecycleTaskDef sets
 * for India (IN) and New Zealand (NZ) (Feature 4 §3.2, §8 slice 4a).
 *
 * IDEMPOTENT: each template is upserted by its stable code (ONBT-IN / ONBT-NZ);
 * its task defs are reconciled (delete-then-recreate the snapshot) so re-running
 * the seeder converges to exactly the blueprint below. Existing in-flight
 * journeys are NOT touched — their tasks are already materialized snapshots.
 *
 * The two markets share the onboarding skeleton (PRE_JOIN → SELF_ONBOARDING →
 * DOCS_ESIGN → PROVISIONING → DAY_ONE → WEEK_ONE → PROBATION); only the
 * statutory COLLECT_STATUTORY task differs (IN: PAN/Aadhaar/UAN/PF/tax-regime;
 * NZ: IRD/tax-code/KiwiSaver).
 *
 * Pure-ish: the blueprint builders below are exported for unit tests; the
 * `seedOnboardingTemplates(prisma, ...)` writer is the only DB-touching export.
 */

// Default starter ONBOARDING task blueprint. Owners/anchors/blocking per §3.2.
// `taskOrder` is per-stage; the engine sorts by (stage flow, taskOrder).
function onboardingTaskBlueprint(countryCode) {
  const isIN = countryCode === 'IN';
  const statutoryTitle = isIN
    ? 'Provide PAN, Aadhaar, UAN & tax-regime election'
    : 'Provide IRD number, tax code & KiwiSaver election';
  const statutoryDoc = isIN ? 'PAN' : 'OTHER'; // NZ has no IN-style PAN doc category
  const idProofTitle = isIN ? 'Upload PAN / Aadhaar (ID proof)' : 'Upload passport / visa / work-permit';
  const idProofDoc = isIN ? 'AADHAAR' : 'WORK_PERMIT';

  return [
    // ── PRE_JOIN — HR kicks the journey off; candidate gets their magic link.
    // taskKey null = manual/custom (no system action key fits a "send welcome").
    { stageKey: 'PRE_JOIN', taskKey: null,
      title: 'Send pre-join welcome & self-onboarding link', ownerRole: 'HR', taskOrder: 0,
      dueAnchor: 'OFFER_ACCEPT', dueOffsetDays: 1, isBlocking: false, isMandatory: true },

    // ── SELF_ONBOARDING — new hire fills their own details (ESS, 4b) ──
    { stageKey: 'SELF_ONBOARDING', taskKey: 'COLLECT_PERSONAL',
      title: 'Complete personal details', ownerRole: 'NEW_HIRE', taskOrder: 0,
      dueAnchor: 'JOIN_DATE', dueOffsetDays: -3, isBlocking: true, isMandatory: true },
    { stageKey: 'SELF_ONBOARDING', taskKey: 'COLLECT_STATUTORY',
      title: statutoryTitle, ownerRole: 'NEW_HIRE', taskOrder: 1,
      dueAnchor: 'JOIN_DATE', dueOffsetDays: -3, isBlocking: true, isMandatory: true,
      documentCategory: statutoryDoc },
    { stageKey: 'SELF_ONBOARDING', taskKey: 'COLLECT_BANK',
      title: 'Provide bank account for salary credit', ownerRole: 'NEW_HIRE', taskOrder: 2,
      dueAnchor: 'JOIN_DATE', dueOffsetDays: -3, isBlocking: true, isMandatory: true,
      documentCategory: 'BANK_PROOF' },
    { stageKey: 'SELF_ONBOARDING', taskKey: 'COLLECT_EMERGENCY',
      title: 'Add emergency contact & nominees', ownerRole: 'NEW_HIRE', taskOrder: 3,
      dueAnchor: 'JOIN_DATE', dueOffsetDays: -3, isBlocking: false, isMandatory: true },
    { stageKey: 'SELF_ONBOARDING', taskKey: 'UPLOAD_DOCS',
      title: idProofTitle, ownerRole: 'NEW_HIRE', taskOrder: 4,
      dueAnchor: 'JOIN_DATE', dueOffsetDays: -2, isBlocking: true, isMandatory: true,
      documentCategory: idProofDoc },

    // ── DOCS_ESIGN — offer/contract/policies signed (built-in e-sign, 4d) ──
    { stageKey: 'DOCS_ESIGN', taskKey: 'ESIGN_OFFER',
      title: 'E-sign offer letter', ownerRole: 'NEW_HIRE', taskOrder: 0,
      dueAnchor: 'JOIN_DATE', dueOffsetDays: -2, isBlocking: true, isMandatory: true,
      esignTemplateKind: 'OFFER_LETTER' },
    { stageKey: 'DOCS_ESIGN', taskKey: 'ESIGN_CONTRACT',
      title: 'E-sign employment contract', ownerRole: 'NEW_HIRE', taskOrder: 1,
      dueAnchor: 'JOIN_DATE', dueOffsetDays: -1, isBlocking: true, isMandatory: true,
      esignTemplateKind: 'APPOINTMENT_LETTER' },
    { stageKey: 'DOCS_ESIGN', taskKey: 'ESIGN_POLICIES',
      title: 'Acknowledge company policies', ownerRole: 'NEW_HIRE', taskOrder: 2,
      dueAnchor: 'JOIN_DATE', dueOffsetDays: 0, isBlocking: false, isMandatory: true,
      esignTemplateKind: 'POLICY_ACK' },
    { stageKey: 'DOCS_ESIGN', taskKey: 'VERIFY_DOCS',
      title: 'HR verify uploaded documents', ownerRole: 'HR', taskOrder: 3,
      dueAnchor: 'JOIN_DATE', dueOffsetDays: -1, isBlocking: true, isMandatory: true },

    // ── PROVISIONING — HR atomically provisions the employee (4c) ──
    { stageKey: 'PROVISIONING', taskKey: 'PROVISION_EMPLOYEE',
      title: 'Provision employee (account, role, comp, leave)', ownerRole: 'HR', taskOrder: 0,
      dueAnchor: 'JOIN_DATE', dueOffsetDays: 0, isBlocking: true, isMandatory: true },

    // ── DAY_ONE — IT/manager onboarding actions ──
    { stageKey: 'DAY_ONE', taskKey: 'ASSIGN_ASSET',
      title: 'Issue laptop & access', ownerRole: 'IT', taskOrder: 0,
      dueAnchor: 'JOIN_DATE', dueOffsetDays: 0, isBlocking: false, isMandatory: true,
      assetCategory: 'LAPTOP' },
    { stageKey: 'DAY_ONE', taskKey: 'CUSTOM',
      title: 'Day-1 welcome & buddy introduction', ownerRole: 'MANAGER', taskOrder: 1,
      dueAnchor: 'JOIN_DATE', dueOffsetDays: 0, isBlocking: false, isMandatory: false },

    // ── WEEK_ONE — settling-in check ──
    { stageKey: 'WEEK_ONE', taskKey: 'CUSTOM',
      title: 'First-week check-in with manager', ownerRole: 'MANAGER', taskOrder: 0,
      dueAnchor: 'JOIN_DATE', dueOffsetDays: 7, isBlocking: false, isMandatory: false },

    // ── PROBATION — confirmation review (4c cron PROBATION_REVIEW) ──
    { stageKey: 'PROBATION', taskKey: 'PROBATION_REVIEW',
      title: 'Probation confirmation review', ownerRole: 'MANAGER', taskOrder: 0,
      dueAnchor: 'JOIN_DATE', dueOffsetDays: 75, isBlocking: true, isMandatory: true },
  ];
}

// Build the full template descriptor for one country (code is stable & idempotent).
function onboardingTemplateDescriptor(countryCode) {
  const cc = countryCode === 'NZ' ? 'NZ' : 'IN';
  return {
    code: `ONBT-${cc}`,
    name: `Default Onboarding (${cc})`,
    direction: 'ONBOARDING',
    countryCode: cc,
    isDefault: true,
    isActive: true,
    taskDefs: onboardingTaskBlueprint(cc),
  };
}

/**
 * seedOnboardingTemplates(prisma, businessId, { entityId } = {}) — idempotent.
 * Upserts the IN + NZ default onboarding templates for one tenant and reconciles
 * their task defs to the current blueprint. Returns the upserted templates.
 *
 * Accepts a prisma-like client (the live client or a `$transaction` tx handle).
 */
async function seedOnboardingTemplates(prisma, businessId, { entityId = null } = {}) {
  if (!prisma || !businessId) throw new Error('seedOnboardingTemplates requires (prisma, businessId)');
  const out = [];
  for (const cc of ['IN', 'NZ']) {
    const desc = onboardingTemplateDescriptor(cc);
    const { taskDefs, ...templateData } = desc;

    const template = await prisma.lifecycleTemplate.upsert({
      where: { businessId_code: { businessId, code: templateData.code } },
      create: { businessId, entityId, ...templateData },
      update: { ...templateData },
    });

    // Reconcile task defs: clear the old snapshot, write the current blueprint.
    await prisma.lifecycleTaskDef.deleteMany({ where: { businessId, templateId: template.id } });
    await prisma.lifecycleTaskDef.createMany({
      data: taskDefs.map((d) => ({ businessId, templateId: template.id, ...d })),
    });

    out.push(template);
  }
  return out;
}

/**
 * getDefaultOnboardingTemplate(prisma, businessId, countryCode) — the default
 * active ONBOARDING template for a country, with its task defs loaded. Falls
 * back to the IN template if the country has no specific one. Returns
 * { template, taskDefs } or null.
 */
async function getDefaultOnboardingTemplate(prisma, businessId, countryCode) {
  const cc = countryCode === 'NZ' ? 'NZ' : 'IN';
  let template = await prisma.lifecycleTemplate.findFirst({
    where: { businessId, direction: 'ONBOARDING', countryCode: cc, isDefault: true, isActive: true, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!template) {
    template = await prisma.lifecycleTemplate.findFirst({
      where: { businessId, direction: 'ONBOARDING', isDefault: true, isActive: true, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }
  if (!template) return null;
  const taskDefs = await prisma.lifecycleTaskDef.findMany({
    where: { businessId, templateId: template.id },
    orderBy: [{ stageKey: 'asc' }, { taskOrder: 'asc' }],
  });
  return { template, taskDefs };
}

module.exports = {
  seedOnboardingTemplates,
  getDefaultOnboardingTemplate,
  // exported pure for unit tests
  onboardingTaskBlueprint,
  onboardingTemplateDescriptor,
};
