// Sidebar navigation + a simple feature/permission gate stub.
//
// Each nav item declares an optional `feature` (tenant subscription module)
// and `permission` (operator role capability). `visibleNavItems` filters
// the list against the resolved session/business. Real enforcement lives
// in the backend; this is presentation gating so HR users only see what
// their plan + role allow. The stub treats a missing features/permissions
// set as "allow all" so the console is usable before those wire up.

export const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', href: '/' },
  { key: 'people', label: 'People', href: '/people', feature: 'hr', permission: 'people.read' },
  { key: 'org', label: 'Org', href: '/org', feature: 'hr', permission: 'org.read' },
  { key: 'leave', label: 'Leave', href: '/leave', feature: 'leave', permission: 'leave.read' },
  { key: 'attendance', label: 'Attendance', href: '/attendance', feature: 'attendance', permission: 'attendance.read' },
  { key: 'payroll', label: 'Payroll', href: '/payroll', feature: 'payroll', permission: 'payroll.read' },
  { key: 'settings', label: 'Settings', href: '/settings', permission: 'settings.read' },
];

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
  if (!permissions) return true; // stub: undefined → allow
  if (Array.isArray(permissions)) return permissions.includes('*') || permissions.includes(permission);
  if (permissions instanceof Set) return permissions.has('*') || permissions.has(permission);
  if (typeof permissions === 'object') return Boolean(permissions['*'] || permissions[permission]);
  return true;
}

export function visibleNavItems({ features, permissions } = {}) {
  return NAV_ITEMS.filter(
    (item) => hasFeature(features, item.feature) && hasPermission(permissions, item.permission)
  );
}
