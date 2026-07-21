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
  { key: 'dashboard', label: 'Dashboard', href: '/', icon: 'dashboard' },
  // Guided setup hub (top-level, ungrouped → renders standalone near the top).
  // Shows live setup completion + ordered next steps. Visible to the people who
  // configure the workspace (Owner / HR-Admin); links inside are themselves gated.
  { key: 'setup', label: 'Setup guide', href: '/setup', permission: 'canManageCompanyProfile', icon: 'onboarding' },
  { key: 'people', label: 'People', href: '/people', feature: 'hr', permission: 'canViewEmployees', icon: 'people' },
  // Employee lifecycle (Feature 4). The onboarding pipeline + checklist tasks are
  // visible to anyone who can view employees (a Manager sees only their reporting
  // sub-tree, server-scoped); separations are gated on canRunSeparation (HR-Admin/
  // Owner). The server is the real enforcement boundary — this just hides nav.
  { key: 'onboarding', label: 'Onboarding', href: '/onboarding', feature: 'hr', permission: 'canViewEmployees', icon: 'onboarding' },
  { key: 'separations', label: 'Separations', href: '/separations', feature: 'hr', permission: 'canRunSeparation', icon: 'exit' },
  { key: 'org', label: 'Org', href: '/org', feature: 'hr', permission: 'canViewEmployees', icon: 'org' },
  // FLAG (Feature 13): the profile change-request approval queue (governed-field
  // edits awaiting HR) + the read-only field-policy view. The queue is gated on
  // canManageEmployees (the approver key); the policy view on canViewEmployees.
  { key: 'profile-changes', label: 'Profile changes', href: '/profile/change-requests', feature: 'hr', permission: 'canManageEmployees', icon: 'people' },
  { key: 'profile-policy', label: 'Field policy', href: '/profile/policy', feature: 'hr', permission: 'canViewEmployees', icon: 'shield' },
  { key: 'leave', label: 'Leave', href: '/leave', feature: 'leave', permission: 'canApproveLeave', icon: 'leaf' },
  { key: 'comp-off', label: 'Comp-off', href: '/comp-off-admin', feature: 'leave', permission: 'canApproveLeave', icon: 'calendar' },
  // Feature 31 — in-service leave encashment (approvals queue + register).
  { key: 'leave-encashment', label: 'Leave encashment', href: '/leave-encashment', feature: 'leave', permission: 'canApproveLeave', icon: 'coin' },
  { key: 'attendance', label: 'Attendance', href: '/attendance', feature: 'attendance', permission: 'canManageAttendance', icon: 'clock' },
  // FLAG (Feature 29 — shared edit): shift roster grid + rotation + swap queue.
  { key: 'roster', label: 'Roster', href: '/roster', feature: 'attendance', permission: 'canViewEmployees', icon: 'calendar' },
  { key: 'compensation', label: 'Compensation', href: '/compensation', feature: 'hr', permission: 'canViewCompensation', icon: 'coin' },
  // FLAG (Feature 17 — NEW nav item): the friendly CTC-policy builder workspace
  // (reusable salary templates). Gated on canViewCompensation (the read key; writes
  // are server-gated on canManageCompensation). The server is the real boundary.
  { key: 'ctc-policies', label: 'CTC policies', href: '/compensation/policies', feature: 'hr', permission: 'canViewCompensation', icon: 'coin' },
  // FLAG (Feature 25 — NEW nav items): the FBP / Flexi Basket plan builder + the
  // allocation console. Plan authoring shapes pay structure (like CTC policies) →
  // gated on canViewCompensation (writes server-gated on canManageCompensation). The
  // allocation roster surfaces who has declared + the per-employee drill-down/verify.
  { key: 'fbp-plans', label: 'FBP plans', href: '/compensation/fbp', feature: 'hr', permission: 'canViewCompensation', icon: 'coin' },
  { key: 'fbp-allocations', label: 'FBP allocations', href: '/compensation/fbp/allocations', feature: 'hr', permission: 'canViewEmployees', icon: 'coin' },
  { key: 'expenses', label: 'Reimbursements', href: '/expenses', feature: 'hr', permission: 'canViewEmployees', icon: 'receipt' },
  // Feature 11 — travel / outdoor-duty queue (pre-trip approvals). Same view perm.
  { key: 'travel', label: 'Travel', href: '/travel', feature: 'hr', permission: 'canViewEmployees', icon: 'wallet' },
  { key: 'loans', label: 'Loans', href: '/loans', feature: 'hr', permission: 'canViewEmployees', icon: 'loan' },
  { key: 'documents', label: 'Documents', href: '/documents', feature: 'hr', permission: 'canViewEmployees', icon: 'doc' },
  // FLAG (Cycle 1 — NEW nav item): HR Helpdesk agent console (ticket queue + thread).
  // Gated on the new canManageHelpdesk rbac key (seeded true for Owner + HR-Admin).
  // The server is the real boundary; this just hides the link from operators who lack it.
  { key: 'helpdesk', label: 'Helpdesk', href: '/helpdesk', feature: 'hr', permission: 'canManageHelpdesk', icon: 'support' },
  // FLAG (Engagement Cycle 1 — NEW nav item): the company announcements / news-feed
  // authoring workspace. Gated on the new canManageAnnouncements rbac key (seeded true
  // for Owner + HR-Admin). The server is the real boundary; this just hides the link.
  { key: 'announcements', label: 'Announcements', href: '/announcements', feature: 'hr', permission: 'canManageAnnouncements', icon: 'letter' },
  // Performance & Goals (Feature 8). Visible to Managers (TEAM band — their reports'
  // goals/reviews, server-scoped) + HR-Admin (cycle config behind
  // canManagePerformanceCycle, hidden via hasPermission on the page). Server is the
  // real boundary; this just shows the tab to anyone with team-performance read.
  { key: 'performance', label: 'Performance', href: '/performance', feature: 'hr', permission: 'canViewTeamPerformance', icon: 'chart' },
  // Feature 34 — 9-box talent grid + competency framework + talent pool/succession.
  // The board (performance × potential) is visible to anyone with team-performance read
  // (Manager TEAM band — server-scoped to their sub-tree; HR sees all). Competency config
  // is HR-Admin (canManagePerformanceCycle, hidden on the page for others); talent pool
  // writes need canManageSuccession. The server is the real boundary; nav just hides links.
  { key: 'nine-box', label: '9-box grid', href: '/performance/nine-box', feature: 'hr', permission: 'canViewTeamPerformance', icon: 'chart' },
  { key: 'competencies', label: 'Competencies', href: '/performance/competencies', feature: 'hr', permission: 'canManagePerformanceCycle', icon: 'chart' },
  { key: 'talent-pool', label: 'Talent pool', href: '/performance/talent-pool', feature: 'hr', permission: 'canViewTeamPerformance', icon: 'people' },
  // FLAG (Feature 37 — NEW nav item): LMS / Learning. Visible to L&D + HR-Admin
  // (canManageLearning — author/assign + full compliance) OR Managers (canViewTeamLearning
  // — TEAM-band training compliance for their reports). The server is the real boundary;
  // this just shows the link to anyone with either learning key.
  { key: 'learning', label: 'Learning', href: '/learning', feature: 'hr', anyPermission: ['canManageLearning', 'canViewTeamLearning'], icon: 'chart' },
  // Recruitment / ATS (Feature 12). Visible to anyone with the new canViewHiring
  // read key OR canManageHiring (recruiters/HR) OR the legacy canManageEmployees
  // super-set. The server is the real boundary; this just hides the nav link.
  { key: 'recruitment', label: 'Talent Acquisition', href: '/recruitment', feature: 'talent_acquisition', anyPermission: ['canViewHiring', 'canManageHiring', 'canManageEmployees'], icon: 'people' },
  { key: 'payroll', label: 'Payroll', href: '/payroll', feature: 'payroll', permission: 'canRunPayroll', icon: 'wallet' },
  // Feature 22 — Statutory Bonus (annual Payment of Bonus Act cycles) + the Feature 21
  // Labour Welfare Fund read panel (tab inside the page). Gated on canRunPayroll; the
  // server is the real boundary (India-only, RBAC per route).
  { key: 'bonus', label: 'Statutory Bonus', href: '/payroll/bonus', feature: 'payroll', permission: 'canRunPayroll', icon: 'coin' },
  // Feature 27 — Auto-Arrear engine (retro salary revision). India-only. Gated on
  // canRunPayroll; the server enforces maker-checker on approve + India-gate per route.
  { key: 'arrears', label: 'Arrears', href: '/payroll/arrears', feature: 'payroll', permission: 'canRunPayroll', icon: 'coin' },
  // Feature 24 — Year-end Form 16 (Part A + Part B) + Form 24Q. India-only. Read =
  // canViewPayrollReports; the server enforces maker-checker on approve + canManageLetters
  // on issue (the issue path is the letters engine). Mounted under /payroll/form16.
  { key: 'form16', label: 'Form 16 / 24Q', href: '/payroll/form16', feature: 'payroll', permission: 'canViewPayrollReports', icon: 'doc' },
  // Feature 23 — Statutory Compliance Calendar (PF/ESI/PT/TDS/24Q/Form16/LWF due
  // dates + reminders + mark-filed). Read = canViewPayrollReports (finance/HR can
  // see); mutations require canManageStatutory (server is the real boundary).
  { key: 'compliance', label: 'Compliance Calendar', href: '/payroll/compliance', feature: 'payroll', permission: 'canViewPayrollReports', icon: 'report' },
  // Feature 32 — Statutory Registers (muster roll + wage/overtime/leave/fines/
  // employee + PF-3A/ESI registers). READ-ONLY projection over the frozen
  // attendance + payroll + leave data. Read/export = canViewPayrollReports;
  // definition management = canManageStatutory (server is the real boundary).
  { key: 'registers', label: 'Statutory Registers', href: '/payroll/registers', feature: 'payroll', permission: 'canViewPayrollReports', icon: 'register' },
  // FLAG (India salary disbursement — NEW nav item): convert a FROZEN/APPROVED run
  // into a bank salary-advice file (+ UTR reconciliation). Visible to anyone who can
  // run payroll OR view reports (the create/file/reconcile actions are server-gated on
  // canRunPayroll; the batch/line reads on canViewPayrollReports). India-only — the
  // server 422s a non-IN run. The server is the real boundary; this just hides the link.
  { key: 'disbursement', label: 'Salary Disbursement', href: '/payroll/disbursement', feature: 'payroll', anyPermission: ['canRunPayroll', 'canViewPayrollReports'], icon: 'wallet' },
  { key: 'reports', label: 'Reports', href: '/reports', feature: 'payroll', permission: 'canViewPayrollReports', icon: 'report' },
  // FLAG (Feature 20 — NEW nav items): Investment-proof workflow (India year-end §192(2D)/
  // Rule 26C/Form 12BB). Two flat items in the Pay group. The window admin actions are
  // server-gated on canManageStatutory; the verify console on canManageEmployees (the
  // server is the real boundary). The proofDeadline is when TDS flips DECLARED→VERIFIED.
  { key: 'tax-declaration-window', label: 'Tax declaration window', href: '/tax/declaration-window', feature: 'payroll', anyPermission: ['canManageStatutory', 'canViewPayrollReports'], icon: 'doc' },
  { key: 'tax-proof-verification', label: 'Tax proof verification', href: '/tax/proof-verification', feature: 'payroll', permission: 'canViewEmployees', icon: 'shield' },
  // Feature 15/25 — income-tax REGIME election console: employer default + window + lock
  // + the per-employee elected/effective regime view. Read = canViewPayrollReports (the
  // server enforces canManageStatutory on policy/lock writes). FLAG: nav.js shared edit.
  { key: 'tax-regime', label: 'Tax regime', href: '/tax/regime', feature: 'payroll', anyPermission: ['canManageStatutory', 'canViewPayrollReports'], icon: 'coin' },
  // Letters & Communication (Feature 9). The group header is gated on EITHER key:
  // canGenerateLetters (the maker/issue key) OR canManageLetters (the config/
  // checker/revoke key), so both a maker-only HR-Admin and a config-only checker
  // see the section. The sub-links mirror the SERVER's per-route guard so the nav
  // never offers a link that 403s:
  //   - Templates + Letterheads routes are `requirePermission('canManageLetters')`
  //     → gate the nav on canManageLetters (a maker-only user would 403 there).
  //   - Issue + Register are `canGenerateLetters` → keep the maker-OR-checker gate.
  // The server is the real enforcement boundary; this just shows the right links.
  // FLAG (Letters overhaul): the Letters group + its Issue child carry a numeric
  // BADGE of pending ESS letter requests ("Letters ②"). The count is data-driven —
  // AdminShell fetches GET /api/hr/letters/requests/count once the section is
  // visible and passes a { letters, 'letters-issue': n } badge map to <Sidebar>,
  // which renders <NavBadge> on this group header (when collapsed) + the Issue link.
  // `badgeSource` documents which nav keys are badge-bearing (purely informational).
  { key: 'letters', label: 'Letters', href: '/letters', feature: 'hr', anyPermission: ['canGenerateLetters', 'canManageLetters'], group: true, icon: 'letter', badgeSource: 'lettersRequestCount' },
  { key: 'letters-templates', label: 'Templates', href: '/letters/templates', feature: 'hr', permission: 'canManageLetters', parent: 'letters', icon: 'doc' },
  { key: 'letters-letterheads', label: 'Letterheads', href: '/letters/letterheads', feature: 'hr', permission: 'canManageLetters', parent: 'letters', icon: 'letterhead' },
  { key: 'letters-issue', label: 'Issue', href: '/letters/issue', feature: 'hr', anyPermission: ['canGenerateLetters', 'canManageLetters'], parent: 'letters', icon: 'send', badgeSource: 'lettersRequestCount' },
  { key: 'letters-register', label: 'Register', href: '/letters/register', feature: 'hr', anyPermission: ['canGenerateLetters', 'canManageLetters'], parent: 'letters', icon: 'register' },
  // ── Feature 10 (slices 10d/10e) — Approvals & Access ────────────────────────
  // FLAG FOR MERGE: these three nav items are NEW in Feature 10. Each is gated on
  // one of the new rbac.js permission keys (canManageApprovalWorkflows /
  // canManageRoles / canManageHierarchy), seeded true for Owner + HR-Admin. The
  // server is the real boundary; this just hides the link from operators who lack
  // the key. They are arranged into a new "Approvals & Access" group below.
  { key: 'approvals', label: 'Approvals', href: '/approvals', permission: 'canManageApprovalWorkflows', icon: 'approvals' },
  { key: 'access-roles', label: 'Roles & access', href: '/approvals/roles', permission: 'canManageRoles', icon: 'shield' },
  { key: 'access-hierarchy', label: 'Reporting tree', href: '/approvals/org', permission: 'canManageHierarchy', icon: 'hierarchy' },
  // Settings groups Branding, Roles, Domain and Billing. Show it to anyone who
  // can manage ANY of those — a Finance role (canEditBilling, no canEditBranding)
  // must still reach the Billing tab. Per-tab/per-action gating happens inside.
  { key: 'settings', label: 'Settings', href: '/settings', anyPermission: ['canEditBranding', 'canEditBilling', 'canEditDomain', 'canManageCompanyProfile', 'canManageExpensePolicy', 'canManageImports', 'canManageAttendance', 'canManageOrg'], group: true, icon: 'settings' },
  // White-label Branding (self-service) — logo/favicon/colours/display-name so a
  // tenant's OWN brand shows on the console, the ESS portal, and both login pages
  // (never the DriftHR vendor mark). Mirrors the backend OR-gate: visible to
  // anyone who can edit branding OR the domain OR the company profile. The server
  // is the real boundary; the page shows read-only when the operator lacks the keys.
  { key: 'settings-branding', label: 'Branding', href: '/settings/branding', anyPermission: ['canEditBranding', 'canEditDomain', 'canManageCompanyProfile'], parent: 'settings', icon: 'palette' },
  // Domain — the custom-domain / subdomain console (Feature 3). It already exists
  // at /settings/domain but was never wired into the nav. Gated on canEditDomain
  // (Owner/Finance-scoped). The page itself shows a read-only banner for others.
  { key: 'settings-domain', label: 'Domain', href: '/settings/domain', permission: 'canEditDomain', parent: 'settings', icon: 'globe' },
  // Feature 42 — Settings → Payroll: the per-entity SALARY-DAY BASIS console
  // (Entity.prorationBasis: calendar / working-days / fixed-30 / fixed-26).
  // Gated on canManageOrg (entity writes); the page shows read-only for others.
  { key: 'settings-payroll', label: 'Payroll', href: '/settings/payroll', permission: 'canManageOrg', parent: 'settings', icon: 'coin' },
  // FLAG FOR MERGE: two NEW Settings sub-pages, gated on the new
  // canManageCompanyProfile rbac key (seeded true for Owner + HR-Admin). The
  // server is the real boundary; this just hides the links from operators who
  // lack the key. They render under the Settings section header (NAV_GROUPS).
  //   - Company profile : business legal/registration profile + optional document
  //     vault (licences, tax reports, financials, GST/registration certificates).
  //   - Employee number  : the auto employee-number format (prefix/padding/start).
  { key: 'settings-company-profile', label: 'Company profile', href: '/settings/company-profile', permission: 'canManageCompanyProfile', parent: 'settings', icon: 'building' },
  { key: 'settings-employee-number', label: 'Employee number', href: '/settings/employee-number', permission: 'canManageCompanyProfile', parent: 'settings', icon: 'hash' },
  // Feature 11 — the Travel & Expense Policy builder (per-diem / hotel matrix /
  // transport rules / city tiers). Gated on the new canManageExpensePolicy key.
  { key: 'settings-travel-policy', label: 'Travel & Expense policy', href: '/settings/travel-policy', permission: 'canManageExpensePolicy', parent: 'settings', icon: 'shield' },
  // FLAG FOR MERGE (Feature 18 — NEW nav item): the Data Migration / Import Center.
  // Gated on the new canManageImports rbac key (seeded true for Owner + HR-Admin).
  // The server is the real boundary; this just hides the link. It lives under
  // Settings because migration is a one-time setup/onboarding task, not daily work.
  { key: 'settings-import', label: 'Import / Migrate', href: '/settings/import', permission: 'canManageImports', parent: 'settings', icon: 'upload' },
  // FLAG FOR MERGE (Feature 28 — NEW nav item): Biometric / device punch ingestion.
  // Gated on canManageAttendance (Owner + HR-Admin). Lives under Settings →
  // Attendance: register devices, map enroll-no→employee, watch ingest activity,
  // triage parked rows. The push/poll ingest doors are device-secret/cron, not here.
  { key: 'settings-biometric', label: 'Biometric devices', href: '/settings/attendance/biometric', permission: 'canManageAttendance', parent: 'settings', icon: 'clock' },
  // Feature 2 — multi-mode attendance capture policy (geo-fence / IP / face) + the
  // office-CIDR allow-list + the flagged-punch review queue. canManageAttendance.
  { key: 'settings-attendance-capture', label: 'Attendance capture', href: '/settings/attendance/capture', permission: 'canManageAttendance', parent: 'settings', icon: 'clock' },
];

// ── Sidebar grouping ─────────────────────────────────────────────────────────
// The flat NAV_ITEMS above are the source of truth for routes + permission
// gating (visibleNavItems). For the polished sidebar we ALSO arrange the visible
// items into collapsible sections (like the ESS portal). Grouping is purely
// presentational — it never adds/removes a route and never changes who can see
// what; it just decides which section header a visible item lives under.
//
// Each group lists the item `key`s it owns, in display order. A key that isn't
// in any group renders as a top-level item (e.g. Dashboard). Letters keeps its
// own native parent/child structure (group:true + parent:'letters') and is
// emitted as its own expandable section, so it is intentionally omitted here.
export const NAV_GROUPS = [
  { key: 'people-org', label: 'People & Org', icon: 'people', items: ['people', 'org', 'profile-changes', 'profile-policy', 'helpdesk', 'announcements'] },
  { key: 'talent', label: 'Talent', icon: 'onboarding', items: ['recruitment', 'onboarding', 'separations', 'performance'] },
  { key: 'time', label: 'Time', icon: 'calendar', items: ['leave', 'comp-off', 'leave-encashment', 'attendance'] },
  { key: 'pay', label: 'Pay', icon: 'wallet', items: ['compensation', 'ctc-policies', 'fbp-plans', 'fbp-allocations', 'payroll', 'bonus', 'arrears', 'form16', 'compliance', 'registers', 'tax-declaration-window', 'tax-proof-verification', 'tax-regime', 'expenses', 'travel', 'loans', 'reports'] },
  // FLAG FOR MERGE: new Feature 10 group — approval chains + RBAC + reporting tree.
  { key: 'approvals-access', label: 'Approvals & Access', icon: 'approvals', items: ['approvals', 'access-roles', 'access-hierarchy'] },
];

// Build the grouped sidebar tree from the already-permission-filtered flat list.
// Input: the array returned by visibleNavItems (so gating is already applied).
// Output: an ordered array of nodes, each either
//   { type: 'item', ...navItem }                          — a standalone link
//   { type: 'group', key, label, icon, children: [item] } — a collapsible section
// Empty groups (every child gated away) are dropped, so a Manager who can't see
// any Pay item never sees an empty "Pay" header.
export function buildNavTree(visibleItems) {
  const byKey = new Map(visibleItems.map((i) => [i.key, i]));
  const consumed = new Set();
  const tree = [];

  // Dashboard (or any ungrouped, non-Letters top-level item) stays standalone
  // and renders first — but we walk groups in declared order and interleave
  // standalone items by their original position. Simplest faithful approach:
  // emit Dashboard first if present, then the groups, then Letters, then any
  // leftover standalone items in original order.
  const dash = byKey.get('dashboard');
  if (dash) { tree.push({ type: 'item', ...dash }); consumed.add('dashboard'); }

  for (const g of NAV_GROUPS) {
    const children = g.items.map((k) => byKey.get(k)).filter(Boolean);
    if (children.length === 0) continue;
    children.forEach((c) => consumed.add(c.key));
    tree.push({ type: 'group', key: g.key, label: g.label, icon: g.icon, children });
  }

  // Letters — native parent/child section (header + its sub-links).
  const lettersParent = byKey.get('letters');
  if (lettersParent) {
    const children = visibleItems.filter((i) => i.parent === 'letters');
    consumed.add('letters');
    children.forEach((c) => consumed.add(c.key));
    tree.push({
      type: 'group',
      key: 'letters',
      label: lettersParent.label,
      icon: lettersParent.icon || 'letter',
      // The section header is itself a destination (/letters); expose it so the
      // group toggle also offers the overview link via the first child.
      href: lettersParent.href,
      children,
    });
  }

  // Settings — native parent/child section (header + its sub-links: Company
  // profile, Employee number). Mirrors the Letters group handling above so the
  // new sub-pages render under the Settings header instead of as loose items.
  const settingsParent = byKey.get('settings');
  if (settingsParent) {
    const children = visibleItems.filter((i) => i.parent === 'settings');
    consumed.add('settings');
    children.forEach((c) => consumed.add(c.key));
    tree.push({
      type: 'group',
      key: 'settings',
      label: settingsParent.label,
      icon: settingsParent.icon || 'settings',
      href: settingsParent.href,
      children,
    });
  }

  // Any remaining standalone visible items (e.g. Documents) in their original
  // flat order, so nothing a user is entitled to ever disappears.
  for (const item of visibleItems) {
    if (consumed.has(item.key) || item.parent) continue;
    consumed.add(item.key);
    tree.push({ type: 'item', ...item });
  }

  return tree;
}

// Full-access permission map for the legacy operator enum (mirrors
// backend rbac.js LEGACY_ROLE_PERMS: SUPER_ADMIN/BUSINESS_ADMIN → all true).
const PERMISSION_KEYS = [
  'canViewEmployees', 'canManageEmployees', 'canViewCompensation', 'canManageCompensation',
  'canApproveLeave', 'canManageAttendance', 'canRunPayroll', 'canApprovePayroll',
  'canViewPayrollReports', 'canManageStatutory', 'canFileReturns', 'canManageOrg',
  'canEditBilling', 'canEditDomain', 'canEditBranding',
  // Company profile + business documents + employee-number format
  'canManageCompanyProfile',
  // Feature 8
  'canManagePerformanceCycle', 'canCalibrateRatings', 'canViewTeamPerformance',
  // Feature 9 — Letters
  'canGenerateLetters', 'canManageLetters',
  // Feature 10 — Approvals + RBAC + hierarchy (FLAG FOR MERGE)
  'canManageApprovalWorkflows', 'canManageRoles', 'canManageHierarchy',
  // Feature 12 — Recruitment / ATS (FLAG FOR MERGE)
  'canManageHiring', 'canViewHiring', 'canScoreInterview',
  // Cycle 1 — HR Helpdesk
  'canManageHelpdesk',
  // Engagement Cycle 1 — Announcements (FLAG FOR MERGE)
  'canManageAnnouncements',
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
