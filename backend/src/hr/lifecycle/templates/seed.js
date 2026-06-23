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

// Default starter OFFBOARDING task blueprint (Feature 4 §4.3, §8 slice 4e/4f).
// The offboarding flow: SEPARATION_INITIATED → NOTICE → CLEARANCE → ASSET_RETURN
// → FNF → EXIT_DOCS → POST_EXIT. Owners drive the clearance lanes:
//   MANAGER → knowledge transfer + asset-return sign-off (the only lanes a manager
//             may clear for their reports, §6); IT/FINANCE/ADMIN → their own lanes;
//   HR      → compute/approve FnF + generate letters + revoke access.
// Due dates anchor on NOTICE_START / LWD / RELIEVING. `assetCategory` on the
// RETURN_ASSET task binds the asset-return lane to the checklist (slice 4e).
function offboardingTaskBlueprint(countryCode) {
  const isIN = countryCode === 'IN';
  return [
    // ── SEPARATION_INITIATED — HR accepts the resignation / opens the case ──
    { stageKey: 'SEPARATION_INITIATED', taskKey: 'ACCEPT_RESIGNATION',
      title: 'Accept resignation / confirm separation', ownerRole: 'HR', taskOrder: 0,
      dueAnchor: 'NOTICE_START', dueOffsetDays: 0, isBlocking: true, isMandatory: true },

    // ── NOTICE — knowledge transfer during the notice period (manager-owned) ──
    { stageKey: 'NOTICE', taskKey: 'KNOWLEDGE_TRANSFER',
      title: 'Complete knowledge transfer & handover', ownerRole: 'MANAGER', taskOrder: 0,
      dueAnchor: 'LWD', dueOffsetDays: -3, isBlocking: true, isMandatory: true },

    // ── CLEARANCE — per-lane sign-offs (each lane only its owner can clear) ──
    { stageKey: 'CLEARANCE', taskKey: 'CLEARANCE_IT',
      title: 'IT clearance (accounts, devices, access)', ownerRole: 'IT', taskOrder: 0,
      dueAnchor: 'LWD', dueOffsetDays: -1, isBlocking: true, isMandatory: true },
    { stageKey: 'CLEARANCE', taskKey: 'CLEARANCE_FINANCE',
      title: 'Finance clearance (advances, reimbursements)', ownerRole: 'FINANCE', taskOrder: 1,
      dueAnchor: 'LWD', dueOffsetDays: -1, isBlocking: true, isMandatory: true },
    { stageKey: 'CLEARANCE', taskKey: 'CLEARANCE_ADMIN',
      title: 'Admin clearance (ID card, library, premises)', ownerRole: 'ADMIN', taskOrder: 2,
      dueAnchor: 'LWD', dueOffsetDays: -1, isBlocking: true, isMandatory: true },

    // ── ASSET_RETURN — return company assets (manager signs off, slice 4e) ──
    { stageKey: 'ASSET_RETURN', taskKey: 'RETURN_ASSET',
      title: 'Return company assets (laptop, access, devices)', ownerRole: 'MANAGER', taskOrder: 0,
      dueAnchor: 'LWD', dueOffsetDays: 0, isBlocking: true, isMandatory: true,
      assetCategory: 'LAPTOP' },

    // ── FNF — HR computes + approves the settlement ──
    { stageKey: 'FNF', taskKey: 'COMPUTE_FNF',
      title: 'Compute full-and-final settlement', ownerRole: 'HR', taskOrder: 0,
      dueAnchor: 'LWD', dueOffsetDays: 3, isBlocking: true, isMandatory: true },

    // ── EXIT_DOCS — relieving + experience letters (HR, gated on SETTLED) ──
    { stageKey: 'EXIT_DOCS', taskKey: 'GENERATE_RELIEVING',
      title: 'Generate relieving letter', ownerRole: 'HR', taskOrder: 0,
      dueAnchor: 'RELIEVING', dueOffsetDays: 0, isBlocking: false, isMandatory: true,
      esignTemplateKind: 'RELIEVING_LETTER' },
    { stageKey: 'EXIT_DOCS', taskKey: 'GENERATE_EXPERIENCE',
      title: 'Generate experience / service certificate', ownerRole: 'HR', taskOrder: 1,
      dueAnchor: 'RELIEVING', dueOffsetDays: 0, isBlocking: false, isMandatory: isIN,
      esignTemplateKind: 'EXPERIENCE_LETTER' },
    { stageKey: 'EXIT_DOCS', taskKey: 'EXIT_INTERVIEW',
      title: 'Conduct exit interview', ownerRole: 'HR', taskOrder: 2,
      dueAnchor: 'LWD', dueOffsetDays: 0, isBlocking: false, isMandatory: false },

    // ── POST_EXIT — revoke access (system task, on settle) ──
    { stageKey: 'POST_EXIT', taskKey: 'REVOKE_ACCESS',
      title: 'Revoke system access & deactivate accounts', ownerRole: 'HR', taskOrder: 0,
      dueAnchor: 'RELIEVING', dueOffsetDays: 0, isBlocking: true, isMandatory: true },
  ];
}

function offboardingTemplateDescriptor(countryCode) {
  const cc = countryCode === 'NZ' ? 'NZ' : 'IN';
  return {
    code: `OFBT-${cc}`,
    name: `Default Offboarding (${cc})`,
    direction: 'OFFBOARDING',
    countryCode: cc,
    isDefault: true,
    isActive: true,
    taskDefs: offboardingTaskBlueprint(cc),
  };
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
  // Both directions: IN + NZ onboarding AND offboarding starter templates.
  const descriptors = [];
  for (const cc of ['IN', 'NZ']) {
    descriptors.push(onboardingTemplateDescriptor(cc));
    descriptors.push(offboardingTemplateDescriptor(cc));
  }
  for (const desc of descriptors) {
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
 * getDefaultOffboardingTemplate(prisma, businessId, countryCode) — the default
 * active OFFBOARDING template for a country, with its task defs loaded. Falls
 * back to the IN template if the country has no specific one. Returns
 * { template, taskDefs } or null. Mirrors getDefaultOnboardingTemplate.
 */
async function getDefaultOffboardingTemplate(prisma, businessId, countryCode) {
  const cc = countryCode === 'NZ' ? 'NZ' : 'IN';
  let template = await prisma.lifecycleTemplate.findFirst({
    where: { businessId, direction: 'OFFBOARDING', countryCode: cc, isDefault: true, isActive: true, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!template) {
    template = await prisma.lifecycleTemplate.findFirst({
      where: { businessId, direction: 'OFFBOARDING', isDefault: true, isActive: true, deletedAt: null },
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
  getDefaultOffboardingTemplate,
  // exported pure for unit tests
  onboardingTaskBlueprint,
  onboardingTemplateDescriptor,
  offboardingTaskBlueprint,
  offboardingTemplateDescriptor,
};
