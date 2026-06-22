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
    canApproveLeave: true, canManageAttendance: true,
    canRunPayroll: true, canViewPayrollReports: true,
    canManageStatutory: true, canFileReturns: true,
    canManageOrg: true, canEditBranding: true,
    // No canEditBilling / canEditDomain / canApprovePayroll — Owner/Finance only
  },
  // Finance — payroll + compensation + statutory + billing.
  Finance: {
    canRunPayroll: true, canApprovePayroll: true, canViewPayrollReports: true,
    canViewCompensation: true,
    canManageStatutory: true, canFileReturns: true,
    canEditBilling: true,
  },
  // Manager — view directory + approve leave + manage attendance
  // (scoped to direct reports — see §6.3 for the location/team-scoped
  // grant pattern lifted from EcomRolePermissionGrant).
  Manager: {
    canViewEmployees: true,
    canApproveLeave: true,
    canManageAttendance: true,
  },
});

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
  LEGACY_ROLE_SCOPE,
  LEGACY_ROLE_PERMS,
  validatePermissions,
  hasPermission,
  effectivePermissions,
  effectiveScope,
};
