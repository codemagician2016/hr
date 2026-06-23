// Sidebar navigation + a permission gate keyed to the backend RBAC catalog.
//
// Each nav item declares an optional `feature` (tenant subscription module) and
// `permission` (one of the 15 rbac.js permission keys, e.g. canViewCompensation).
// `visibleNavItems` resolves the operator's effective permissions from the
// session (the assigned BusinessRole's permissions JSON, or the legacy-role
// fallback) and hides items they lack. The server is the real enforcement
// boundary — this is UX so a Manager doesn't see Compensation/Payroll/Reports,
// and a non-Owner doesn't see Settings→Roles. A missing session degrades to
// "allow all" so the console stays usable before the session resolves.

export const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', href: '/' },
  { key: 'people', label: 'People', href: '/people', feature: 'hr', permission: 'canViewEmployees' },
  // Employee lifecycle (Feature 4). The onboarding pipeline + checklist tasks are
  // visible to anyone who can view employees (a Manager sees only their reporting
  // sub-tree, server-scoped); separations are gated on canRunSeparation (HR-Admin/
  // Owner). The server is the real enforcement boundary — this just hides nav.
  { key: 'onboarding', label: 'Onboarding', href: '/onboarding', feature: 'hr', permission: 'canViewEmployees' },
  { key: 'separations', label: 'Separations', href: '/separations', feature: 'hr', permission: 'canRunSeparation' },
  { key: 'org', label: 'Org', href: '/org', feature: 'hr', permission: 'canViewEmployees' },
  { key: 'leave', label: 'Leave', href: '/leave', feature: 'leave', permission: 'canApproveLeave' },
  { key: 'attendance', label: 'Attendance', href: '/attendance', feature: 'attendance', permission: 'canManageAttendance' },
  { key: 'compensation', label: 'Compensation', href: '/compensation', feature: 'hr', permission: 'canViewCompensation' },
  { key: 'expenses', label: 'Expenses', href: '/expenses', feature: 'hr', permission: 'canViewEmployees' },
  { key: 'loans', label: 'Loans', href: '/loans', feature: 'hr', permission: 'canViewEmployees' },
  { key: 'documents', label: 'Documents', href: '/documents', feature: 'hr', permission: 'canViewEmployees' },
  // Performance & Goals (Feature 8). Visible to Managers (TEAM band — their reports'
  // goals/reviews, server-scoped) + HR-Admin (cycle config behind
  // canManagePerformanceCycle, hidden via hasPermission on the page). Server is the
  // real boundary; this just shows the tab to anyone with team-performance read.
  { key: 'performance', label: 'Performance', href: '/performance', feature: 'hr', permission: 'canViewTeamPerformance' },
  { key: 'payroll', label: 'Payroll', href: '/payroll', feature: 'payroll', permission: 'canRunPayroll' },
  { key: 'reports', label: 'Reports', href: '/reports', feature: 'payroll', permission: 'canViewPayrollReports' },
  // Letters & Communication (Feature 9). The group header is gated on EITHER key:
  // canGenerateLetters (the maker/issue key) OR canManageLetters (the config/
  // checker/revoke key), so both a maker-only HR-Admin and a config-only checker
  // see the section. The sub-links mirror the SERVER's per-route guard so the nav
  // never offers a link that 403s:
  //   - Templates + Letterheads routes are `requirePermission('canManageLetters')`
  //     → gate the nav on canManageLetters (a maker-only user would 403 there).
  //   - Issue + Register are `canGenerateLetters` → keep the maker-OR-checker gate.
  // The server is the real enforcement boundary; this just shows the right links.
  { key: 'letters', label: 'Letters', href: '/letters', feature: 'hr', anyPermission: ['canGenerateLetters', 'canManageLetters'], group: true },
  { key: 'letters-templates', label: 'Templates', href: '/letters/templates', feature: 'hr', permission: 'canManageLetters', parent: 'letters' },
  { key: 'letters-letterheads', label: 'Letterheads', href: '/letters/letterheads', feature: 'hr', permission: 'canManageLetters', parent: 'letters' },
  { key: 'letters-issue', label: 'Issue', href: '/letters/issue', feature: 'hr', anyPermission: ['canGenerateLetters', 'canManageLetters'], parent: 'letters' },
  { key: 'letters-register', label: 'Register', href: '/letters/register', feature: 'hr', anyPermission: ['canGenerateLetters', 'canManageLetters'], parent: 'letters' },
  { key: 'settings', label: 'Settings', href: '/settings', permission: 'canEditBranding' },
];

// Full-access permission map for the legacy operator enum (mirrors
// backend rbac.js LEGACY_ROLE_PERMS: SUPER_ADMIN/BUSINESS_ADMIN → all true).
const PERMISSION_KEYS = [
  'canViewEmployees', 'canManageEmployees', 'canViewCompensation', 'canManageCompensation',
  'canApproveLeave', 'canManageAttendance', 'canRunPayroll', 'canApprovePayroll',
  'canViewPayrollReports', 'canManageStatutory', 'canFileReturns', 'canManageOrg',
  'canEditBilling', 'canEditDomain', 'canEditBranding',
  // Feature 8
  'canManagePerformanceCycle', 'canCalibrateRatings', 'canViewTeamPerformance',
  // Feature 9 — Letters
  'canGenerateLetters', 'canManageLetters',
];
const ALL_TRUE = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true]));

// Resolve the operator's effective permission map from the /api/auth/me session.
// Mirrors backend effectivePermissions(): an assigned BusinessRole's permissions
// JSON wins; otherwise SUPER_ADMIN/BUSINESS_ADMIN get everything, others nothing.
export function permissionsFromSession(session) {
  if (!session) return null; // unknown → allow-all (handled by hasPermission)
  const rolePerms = session.businessRole?.permissions;
  if (rolePerms && typeof rolePerms === 'object') return rolePerms;
  if (session.role === 'SUPER_ADMIN' || session.role === 'BUSINESS_ADMIN') return ALL_TRUE;
  if (session.permissions && typeof session.permissions === 'object') return session.permissions;
  return {}; // authenticated but no permissions resolved → hide gated items
}

export function hasFeature(features, feature) {
  if (!feature) return true;
  if (!features) return true; // stub: undefined → allow
  if (Array.isArray(features)) return features.includes(feature);
  if (features instanceof Set) return features.has(feature);
  if (typeof features === 'object') return Boolean(features[feature]);
  return true;
}

export function hasPermission(permissions, permission) {
  if (!permission) return true;
  if (!permissions) return true; // null/undefined → allow (session not yet resolved)
  if (Array.isArray(permissions)) return permissions.includes('*') || permissions.includes(permission);
  if (permissions instanceof Set) return permissions.has('*') || permissions.has(permission);
  if (typeof permissions === 'object') return Boolean(permissions['*'] || permissions[permission]);
  return true;
}

// `permissions` may be a resolved rbac permission map (preferred), or undefined
// (allow-all). Pass `session` to have it resolved here from the raw /me payload.
// True when ANY of the listed permission keys is granted (OR-gate). Used by the
// Letters group, which is visible to a maker (canGenerateLetters) OR a config/
// checker (canManageLetters). Mirrors hasPermission's null/undefined = allow-all
// posture so the section stays visible before the session resolves.
export function hasAnyPermission(permissions, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return true;
  if (!permissions) return true; // session not yet resolved → allow
  return keys.some((k) => hasPermission(permissions, k));
}

export function visibleNavItems({ features, permissions, session } = {}) {
  const perms = permissions !== undefined ? permissions : permissionsFromSession(session);
  return NAV_ITEMS.filter(
    (item) =>
      hasFeature(features, item.feature)
      && hasPermission(perms, item.permission)
      && hasAnyPermission(perms, item.anyPermission)
  );
}
