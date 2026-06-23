// RBAC permission registry. Pre-defined permission keys + system-role
// presets. Used by the controller to validate role payloads and by future
// middleware to enforce permissions on protected actions.
'use strict';

const { ROLES } = require('./roles');

// All permission keys we support. Adding a new one never requires a
// schema migration — the BusinessRole.permissions JSON just acquires
// new keys.
const PERMISSIONS = Object.freeze({
  // People
  canViewEmployees:     'View employee directory + profiles',
  canManageEmployees:   'Create/edit/terminate employees',
  canViewCompensation:  'View salary/CTC of others',
  canManageCompensation:'Edit pay structures + revisions',
  // Feature 5 — maker-checker SoD for comp revisions/cycles.
  canProposeCompensation:'Draft increment proposals for own team (maker)',
  canApproveCompensation:'Approve comp revisions/cycles (checker, distinct from maker)',
  // Time & leave
  canApproveLeave:      'Approve/decline leave requests',
  canManageAttendance:  'Edit attendance + regularisations',
  // Payroll
  canRunPayroll:        'Initiate + lock a pay run',
  canApprovePayroll:    'Approve a locked run for disbursement',
  canViewPayrollReports:'View payroll registers + cost reports',
  // Statutory / filing
  canManageStatutory:   'Edit PF/ESI/PT/KiwiSaver/PAYE config',
  canFileReturns:       'Generate + mark statutory filings (24Q, payday-filing)',
  // Settings
  canManageOrg:         'Edit org structure, departments, locations',
  canEditBilling:       'Manage subscription + payment method',
  canEditDomain:        'Connect/change white-label domain',
  canEditBranding:      'Logo, brand color, style, domain binding',
  // Company profile + business document vault + employee-numbering scheme
  // (additive; no migration). Gates the Company Profile settings page: edit the
  // business legal/registration profile, upload/delete company documents
  // (licences, tax reports, financials, GST/registration certificates), and set
  // the auto employee-number format.
  canManageCompanyProfile: 'Edit company profile, business documents + employee-number format',
  // Employee lifecycle (Feature 4)
  canManageOnboarding:  'Onboarding templates + run pipeline + provision',
  canRunSeparation:     'Initiate/run separation + FnF (distinct from terminate)',
  canGenerateLetters:   'Generate offer/relieving/experience letters',
  // Letters & Communication (Feature 9) — config/checker key (distinct from the
  // canGenerateLetters maker/issue key): letterhead + template CRUD, ref schemes, revoke.
  canManageLetters:     'Letters config: letterheads, templates, ref schemes, revoke (the admin/checker key)',
  // Performance & Goals (Feature 8) — additive; no migration. canViewTeamPerformance
  // is the Manager TEAM-band read key; canManagePerformanceCycle is HR-admin config
  // (cycles/templates/scales/reopen/release); canCalibrateRatings is the skip-level
  // calibration-participation grant. ESS USER self-access stays implicit (own goals +
  // own review when released) — no key needed, the scope band (SELF) carries it.
  canManagePerformanceCycle: 'Create/configure review cycles, templates, scales; reopen/calibrate',
  canCalibrateRatings:       'Participate in calibration sessions for own org sub-tree',
  canViewTeamPerformance:    "View reports' goals + reviews (TEAM band)",
  // Approval workflows + RBAC/hierarchy admin (Feature 10) — additive; no migration.
  // CONFIG keys: they gate the Workflow Builder / Role Manager / Org-Chart editor.
  // WHO may ACT on a given approval is NOT one of these — it is the engine's resolved
  // approver set (§6.3), with the F1 scope band as the SoD backstop.
  canManageApprovalWorkflows: 'Build approval chains (create/edit/publish workflows)',
  canManageRoles:             'Create/edit roles & permissions',
  canManageHierarchy:         'Edit the reporting tree (re-parent employees)',
  // Recruitment / ATS (Feature 12) — additive; no migration. canManageHiring is the
  // recruiter/HR write key (jobs, screening, scorecards, scheduling, offers);
  // canViewHiring is the TEAM/req-scoped read key (hiring managers, recruiters);
  // canScoreInterview gates the interviewer self-service scorecard submit (an
  // employee on a panel gets it scope-bound to THEIR interviews, not tenant-wide).
  // canManageEmployees remains a super-set (back-compat with the existing routes).
  canManageHiring:   'Create/configure jobs, screening, scorecards, schedule interviews, manage offers',
  canViewHiring:     'View jobs, candidates, applications, merit lists (TEAM/req-scoped)',
  canScoreInterview: 'Submit interview scorecards for assigned panels (interviewer self-service)',
  // Reimbursement/Claims + Travel (Feature 11) — additive; no migration.
  // canApproveExpense is the approver key for claims + trips: Finance (ALL band) and
  // Manager (TEAM band, self-dropped by the F1 SoD list) act on it; it is distinct from
  // canManageEmployees so the approve/reject/reimburse actions are F1-scoped, not the
  // old bare operator gate. canManageExpensePolicy gates the Travel & Expense Policy
  // builder (per-diem / hotel-by-level×tier / transport rules / city-tier editor) and
  // category CRUD — HR-Admin config, not a per-claim action.
  canApproveExpense:        'Approve/reject/reimburse expense claims + travel requests (scoped + SoD)',
  canManageExpensePolicy:   'Build the travel & expense policy (per-diem, hotel matrix, transport, city tiers)',
});

const PERMISSION_KEYS = Object.freeze(Object.keys(PERMISSIONS));

// System role presets — seeded into BusinessRole on Business creation
// (and on first operator login, see ensureDefaultHrRole). Tenants can
// customize or add new roles.
const SYSTEM_ROLES = Object.freeze({
  // Owner — all true.
  Owner: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true])),
  // HR-Admin — everything except billing, domain, and payroll approval.
  'HR-Admin': {
    canViewEmployees: true, canManageEmployees: true,
    canViewCompensation: true, canManageCompensation: true,
    // Feature 5 — HR-Admin is the comp MAKER (propose), NOT the approver, so SoD
    // holds (approval routes to Finance/Owner). canApproveCompensation off.
    canProposeCompensation: true,
    canApproveLeave: true, canManageAttendance: true,
    canRunPayroll: true, canViewPayrollReports: true,
    canManageStatutory: true, canFileReturns: true,
    canManageOrg: true, canEditBranding: true,
    // Company profile / business docs / employee-number format — HR-Admin owns it.
    canManageCompanyProfile: true,
    // Feature 4 — HR-Admin owns the lifecycle (onboarding/separation/letters).
    canManageOnboarding: true, canRunSeparation: true, canGenerateLetters: true,
    // Feature 9 — HR-Admin owns letters config + revoke (the checker key).
    canManageLetters: true,
    // Feature 8 — HR-Admin owns performance config + calibration + team visibility.
    canManagePerformanceCycle: true, canCalibrateRatings: true, canViewTeamPerformance: true,
    // Feature 10 — HR-Admin owns approval-chain config, role management + the org tree.
    canManageApprovalWorkflows: true, canManageRoles: true, canManageHierarchy: true,
    // Feature 12 — HR-Admin owns the full recruitment/ATS surface.
    canManageHiring: true, canViewHiring: true, canScoreInterview: true,
    // Feature 11 — HR-Admin owns the travel & expense policy builder + can approve.
    canManageExpensePolicy: true, canApproveExpense: true,
    // No canEditBilling / canEditDomain / canApprovePayroll — Owner/Finance only
  },
  // Finance — payroll + compensation + statutory + billing.
  Finance: {
    canRunPayroll: true, canApprovePayroll: true, canViewPayrollReports: true,
    canViewCompensation: true,
    // Feature 5 — Finance is a comp CHECKER (approve), view-only on structures.
    canApproveCompensation: true,
    canManageStatutory: true, canFileReturns: true,
    canEditBilling: true,
    // Feature 11 — Finance approves + reimburses expense claims (the settle action).
    canApproveExpense: true,
  },
  // Manager — view directory + approve leave + manage attendance
  // (scoped to direct reports — see §6.3 for the location/team-scoped
  // grant pattern lifted from EcomRolePermissionGrant).
  Manager: {
    canViewEmployees: true,
    canApproveLeave: true,
    canManageAttendance: true,
    // Feature 5 — Manager proposes increments for their team (maker). They do
    // NOT get canViewCompensation by default → compVisibility floors to RANGE_ONLY.
    canProposeCompensation: true,
    // Feature 8 — a Manager sees their reports' goals + reviews (TEAM band carries the
    // sub-tree scope); calibration/cycle-config stay HR-only. Manager review-submit is
    // gated by canViewTeamPerformance + the reviewer≠reviewee SoD (APPROVAL_ACTIONS).
    canViewTeamPerformance: true,
    // Feature 12 — a Manager who is also a hiring manager scores interviews for their
    // panels (scope-bound) and views their requisitions' pipelines/merit lists.
    canViewHiring: true, canScoreInterview: true,
    // Feature 11 — a Manager approves their TEAM's claims/trips. The F1 TEAM band +
    // the APPROVAL_ACTIONS self-drop (scopeResolver) enforce "team only, never own".
    canApproveExpense: true,
  },
  // Recruiter — Feature 12 preset. Owns the recruitment/ATS surface (jobs,
  // screening, scorecards, scheduling, offers) and the read keys, but nothing
  // else (no comp/payroll/org). TEAM band keeps a recruiter scoped to their reqs.
  Recruiter: {
    canViewEmployees: true,
    canManageHiring: true,
    canViewHiring: true,
    canScoreInterview: true,
  },
});

// ── Feature 5: salary-masking visibility level per system role ──
// Intersected with canViewCompensation + the F1 scope band by maskCompensation.
// Manager (no canViewCompensation grant) → RANGE_ONLY (band/compa-ratio, no
// absolute money); HR/Finance/Owner → ABSOLUTE; Employee/ESS → SELF_ONLY.
const SYSTEM_ROLE_COMP_VISIBILITY = Object.freeze({
  Owner: 'ABSOLUTE',
  'HR-Admin': 'ABSOLUTE',
  Finance: 'ABSOLUTE',
  Manager: 'RANGE_ONLY',
});

// Resolve a viewer's effective comp-visibility level. Priority:
//   1. canViewCompensation grant → ABSOLUTE (full money) regardless of role band.
//   2. explicit BusinessRole.compVisibility (when not NONE).
//   3. system-role default.
//   4. SELF_ONLY for an ESS/USER session, else NONE.
function effectiveCompVisibility(user) {
  if (!user) return 'NONE';
  if (user.role === ROLES.SUPER_ADMIN) return 'ABSOLUTE';
  const perms = effectivePermissions(user);
  if (perms && perms.canViewCompensation) return 'ABSOLUTE';
  const explicit = user.businessRole && user.businessRole.compVisibility;
  if (explicit && explicit !== 'NONE') return explicit;
  const roleName = user.businessRole && user.businessRole.name;
  if (roleName && SYSTEM_ROLE_COMP_VISIBILITY[roleName]) return SYSTEM_ROLE_COMP_VISIBILITY[roleName];
  // A manager who can PROPOSE (maker) but lacks a view grant still sees ranges.
  if (perms && perms.canProposeCompensation) return 'RANGE_ONLY';
  if (user.role === ROLES.USER) return 'SELF_ONLY';
  return 'NONE';
}

// ── Feature 1: hierarchical data-scope bands ──
// Default scope per system role. Manager = TEAM (their reporting sub-tree) — the
// owner's "a manager manages only their own employees" requirement.
const SYSTEM_ROLE_SCOPES = Object.freeze({
  Owner: 'ALL',
  'HR-Admin': 'ALL',
  Finance: 'ALL',
  Manager: 'TEAM',
});

// Legacy User.role → scope when no custom BusinessRole.defaultScope is present.
const LEGACY_ROLE_SCOPE = Object.freeze({
  [ROLES.SUPER_ADMIN]: 'ALL',
  [ROLES.BUSINESS_ADMIN]: 'ALL',
  [ROLES.STAFF]: 'TEAM',
  [ROLES.USER]: 'SELF',
});

// Resolve a user's effective data-scope band: assigned BusinessRole.defaultScope
// wins; otherwise the legacy enum default (ESS USER floors at SELF).
function effectiveScope(user) {
  if (!user) return 'NONE';
  const band = user.businessRole && user.businessRole.defaultScope;
  if (band) return band;
  return LEGACY_ROLE_SCOPE[user.role] || 'SELF';
}

// Validate a permissions JSON object — only known keys with boolean values.
function validatePermissions(perms) {
  if (!perms || typeof perms !== 'object') return { ok: false, error: 'permissions must be an object' };
  for (const [k, v] of Object.entries(perms)) {
    if (!(k in PERMISSIONS)) return { ok: false, error: `Unknown permission "${k}"` };
    if (typeof v !== 'boolean') return { ok: false, error: `Permission "${k}" must be boolean` };
  }
  return { ok: true };
}

// Check whether a permissions object grants a specific permission.
function hasPermission(perms, key) {
  return !!(perms && perms[key]);
}

// Default permission set for the legacy `User.role` enum, used when a user
// has no `businessRoleId` assigned. SUPER_ADMIN + BUSINESS_ADMIN get the
// full Owner preset; STAFF inherits the Manager preset so legacy operator
// staff keep a sensible "view + approve own team" baseline; USER is an
// ESS/customer-facing fallback with nothing (employee permissions are
// implicit on the customer session, not a BusinessRole).
const ALL_TRUE = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true]));
const LEGACY_ROLE_PERMS = Object.freeze({
  [ROLES.SUPER_ADMIN]: ALL_TRUE,
  [ROLES.BUSINESS_ADMIN]: ALL_TRUE,
  [ROLES.STAFF]: SYSTEM_ROLES.Manager,
  [ROLES.USER]: {},
});

// Resolve a user's effective permissions. Custom BusinessRole assignment
// wins; otherwise fall back to the legacy enum.
function effectivePermissions(user) {
  if (!user) return {};
  if (user.businessRole?.permissions && typeof user.businessRole.permissions === 'object') {
    return user.businessRole.permissions;
  }
  return LEGACY_ROLE_PERMS[user.role] || {};
}

module.exports = {
  PERMISSIONS,
  PERMISSION_KEYS,
  SYSTEM_ROLES,
  SYSTEM_ROLE_SCOPES,
  SYSTEM_ROLE_COMP_VISIBILITY,
  LEGACY_ROLE_SCOPE,
  LEGACY_ROLE_PERMS,
  validatePermissions,
  hasPermission,
  effectivePermissions,
  effectiveScope,
  effectiveCompVisibility,
};
