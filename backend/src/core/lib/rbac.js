// RBAC permission registry. Pre-defined permission keys + system-role
// presets. Used by the controller to validate role payloads and by future
// middleware to enforce permissions on protected actions.
'use strict';

const { ROLES } = require('./roles');

// All permission keys we support. Adding a new one never requires a
// schema migration — the BusinessRole.permissions JSON just acquires
// new keys.
const PERMISSIONS = Object.freeze({
  // Customer management
  canManageCustomers:     'View, edit, delete customers',
  canExportCustomers:     'Download CSV of customer list',
  // Appointments
  canReceiveAppointments: 'Receive bookings as an assignable provider',
  canViewOwnAppointments: 'See appointments assigned to self',
  canViewAllAppointments: 'See appointments across all staff (not just own)',
  canManageOwnAppointments: 'Confirm, reschedule, complete, and note own appointments',
  canManageAllAppointments: 'Confirm, reschedule, complete, and note appointments across staff',
  canManageWalkIns:       'Create walk-in appointments for the front desk',
  canRecordPayments:      'Record and update appointment payments',
  canWriteClinicalDocuments: 'Write prescriptions and appointment documents',
  canCancelAppointments:  'Cancel any appointment',
  canRefundAppointments:  'Process refunds on bookings',
  // Services / pricing
  canEditServices:        'Add/edit/delete services + prices',
  canEditCoupons:         'Manage coupon codes',
  // Staff management
  canManageStaff:         'Add/edit staff + permissions',
  canEditOwnSchedule:     'Update own weekly availability',
  canEditSchedules:       'Modify staff working hours',
  // Reports
  canViewReports:         'See revenue and analytics',
  canExportReports:       'Download reports as CSV/PDF',
  // E-commerce
  canManageProducts:      'Add/edit/delete products',
  canManageOrders:        'Update order status, mark paid',
  canRefundOrders:        'Process e-commerce refunds',
  // Marketing
  canManageMarketing:     'Edit + toggle marketing automation campaigns',
  canSendBulkSms:         'Send bulk SMS / WhatsApp blasts',
  // Settings
  canEditBusinessProfile: 'Update business name, address, hours',
  canEditBilling:         'Manage subscription + payment method',
  canEditDomain:          'Connect / change custom domain',
  canEditWebsite:         'Edit storefront content + theme',
});

const PERMISSION_KEYS = Object.freeze(Object.keys(PERMISSIONS));

// System role presets — seeded into BusinessRole on Business creation.
// Tenants can customize or add new roles.
const SYSTEM_ROLES = Object.freeze({
  Owner: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true])), // all
  Manager: {
    canManageCustomers: true, canExportCustomers: true,
    canViewAllAppointments: true, canCancelAppointments: true, canRefundAppointments: true,
    canManageAllAppointments: true,
    canManageWalkIns: true, canRecordPayments: true,
    canEditServices: true, canEditCoupons: true,
    canManageStaff: true, canEditSchedules: true,
    canViewReports: true, canExportReports: true,
    canManageProducts: true, canManageOrders: true, canRefundOrders: true,
    canManageMarketing: true,
    canEditBusinessProfile: true, canEditWebsite: true,
    // No billing or domain — owner only
  },
  Doctor: {
    canReceiveAppointments: true,
    canViewOwnAppointments: true,
    canManageOwnAppointments: true,
    canWriteClinicalDocuments: true,
    canEditOwnSchedule: true,
  },
  FrontDesk: {
    canManageCustomers: true,
    canViewAllAppointments: true, canCancelAppointments: true,
    canManageAllAppointments: true,
    canManageWalkIns: true,
    canRecordPayments: true,
    // Read-only on services/pricing/reports/staff/marketing/clinical docs
  },
});

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
// full Owner preset; STAFF inherits the Doctor/provider preset so legacy
// booking staff keep the old "own appointments only" behaviour; USER is a
// customer-facing fallback with nothing.
const ALL_TRUE = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true]));
const LEGACY_ROLE_PERMS = Object.freeze({
  [ROLES.SUPER_ADMIN]: ALL_TRUE,
  [ROLES.BUSINESS_ADMIN]: ALL_TRUE,
  [ROLES.STAFF]: SYSTEM_ROLES.Doctor,
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
  LEGACY_ROLE_PERMS,
  validatePermissions,
  hasPermission,
  effectivePermissions,
};
