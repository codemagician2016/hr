'use strict';

/**
 * probes.js — "is this step actually done?" answered against REAL tenant data.
 *
 * One probe per checklist key. Every probe is a cheap count / findFirst / distinct
 * scan on a businessId-indexed column, and every probe is individually try/catch'ed
 * by runProbes: a probe that throws reports `{ ok:false }` → the step renders
 * "Couldn't check", counts in the denominator but never the numerator, and is never
 * offered as the next action. One broken probe must never 500 the setup page.
 *
 * TENANT SCOPING is absolute: every query below is filtered by ctx.businessId,
 * which comes from the session (req.user.businessId) and never from the client.
 *
 * HONESTY over generosity. Several probes deliberately reject "a row exists":
 *   employee_number   allocateCode() auto-creates the EMPLOYEE NumberSequence row
 *                     at the first hire, so existence means "someone was hired",
 *                     not "someone chose a format" — we compare against the
 *                     SCOPE_DEFAULTS instead.
 *   comp_off          ensureCompOffType() auto-seeds the type + a NONE-accrual
 *                     policy on the first manual grant, so we require a
 *                     compOffConfig that a human wrote.
 *   hr_team_roles     six SYSTEM_ROLES are seeded at Business creation, so a bare
 *                     businessRole.count is always > 0.
 *   company_profile   read the RAW Business.companyProfile column, never the GET
 *                     endpoint — that one prefills legalName/address/contact from
 *                     Business columns and would report green on an empty profile.
 *   branding          every TenantBrand column is nullable, so row existence alone
 *                     proves nothing.
 *   restricted_holidays / payslip_settings
 *                     probe the PRESENCE of the featureFlags key, not its value —
 *                     the key is only ever written by its own PATCH endpoint, so
 *                     "absent" genuinely means "never decided".
 *
 * `prisma` is read off the context so the unit tests can inject a fake client.
 */

const realPrisma = require('../../core/lib/prisma');
const payrollService = require('../payroll/service');
const { SCOPE_DEFAULTS } = require('../lifecycle/lib/codes');

// Employment states that mean "on the payroll today". PRE_HIRE is deliberately
// excluded — an accepted offer is not yet a person you pay — as are TERMINATED /
// RETIRED / SUSPENDED.
const ACTIVE_SET = Object.freeze(['ACTIVE', 'PROBATION', 'ON_LEAVE', 'NOTICE_PERIOD']);

const EMP_DEFAULTS = SCOPE_DEFAULTS.EMPLOYEE || { prefix: 'EMP-', padding: 6 };

const filled = (v) => !!(typeof v === 'string' && v.trim());
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

// Midnight UTC today — the anchor for every effective-dated window below.
function utcToday(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
const isoDate = (d) => d.toISOString().slice(0, 10);

// The first day of the tax year that is currently running, for a tax year that
// starts in `startMonth` (April in both markets).
function taxYearStart(today, startMonth) {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  return new Date(Date.UTC(m >= startMonth ? y : y - 1, startMonth - 1, 1));
}

// A "X of Y people" verdict. `total === 0` is never complete — a ratio over an
// empty population would report 100% for a tenant with nobody in it.
function coverageVerdict(done, total, floor, unit = 'people') {
  return { completed: total > 0 && done / total >= floor, coverage: { done, total, unit } };
}

// Distinct-owner count without pulling rows: `distinct` + a one-column select.
async function distinctCount(delegate, where, field) {
  const rows = await delegate.findMany({ where, select: { [field]: true }, distinct: [field] });
  return rows.length;
}

/**
 * loadContext — the shared facts every probe needs, in ONE batched round-trip.
 *
 * Also computes the two `includeWhen` signals, because the conditional steps must
 * be resolved BEFORE we decide which probes to run: a greenfield tenant should
 * never even be asked about migrating its old leave balances.
 */
async function loadContext(businessId, { prisma = realPrisma, now = new Date() } = {}) {
  const today = utcToday(now);

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true, createdAt: true,
      hrCountry: true, hrCountrySetAt: true, hrCurrency: true,
      companyProfile: true, featureFlags: true, candidateCommsConfig: true,
    },
  });
  if (!business) return null;

  const activeEmployeeWhere = { businessId, deletedAt: null, status: { in: ACTIVE_SET } };
  const activeEntityWhere = { businessId, deletedAt: null, status: 'ACTIVE' };

  const [activeEmployees, activeEntities, activeInEntities, firstEntity, migratedEmployees] = await Promise.all([
    prisma.employee.count({ where: activeEmployeeWhere }),
    prisma.entity.count({ where: activeEntityWhere }),
    prisma.entity.count({ where: { ...activeEntityWhere, countryCode: 'IN' } }),
    prisma.entity.findFirst({
      where: activeEntityWhere,
      orderBy: { createdAt: 'asc' },
      select: { taxYearStartMonth: true },
    }),
    // "Did this tenant come from another system?" — a COMMITTED employee import is
    // the only honest signal we have, and it gates the two migration-only steps.
    prisma.importJob.count({ where: { businessId, deletedAt: null, kind: 'EMPLOYEE', status: 'COMMITTED' } }),
  ]);

  const taxYearStartMonth = (firstEntity && firstEntity.taxYearStartMonth) || 4;
  const fyStart = taxYearStart(today, taxYearStartMonth);
  const joinedBeforeTaxYearStart = await prisma.employee.count({
    where: { ...activeEmployeeWhere, hireDate: { lt: fyStart } },
  });

  return {
    prisma,
    businessId,
    business,
    today,
    country: business.hrCountry || null,
    currency: business.hrCurrency || null,
    featureFlags: asObject(business.featureFlags) || {},
    activeEmployeeWhere,
    activeEntityWhere,
    activeEmployees,
    activeEntities,
    activeInEntities,
    taxYearStartMonth,
    fyStart,
    // "2026-27" — the same helper payroll itself uses, so the setup guide and the
    // tax screens can never disagree about which FY is current.
    currentFy: payrollService._internal.taxYearFor(isoDate(today), taxYearStartMonth),
    // ── includeWhen inputs (leading underscore = never serialised) ──
    _migratedFromAnotherSystem: migratedEmployees > 0,
    _joinedBeforeTaxYearStart: joinedBeforeTaxYearStart,
  };
}

// ── The probes ────────────────────────────────────────────────────────────────
// Each returns a boolean, or { completed, coverage } when it can report progress.
const PROBES = Object.create(null);

// ═══ FOUNDATION ═══
// hrCountrySetAt is the lock marker written only by POST /api/hr/setup/country.
// hrCountry alone is not sufficient — it can be inherited/backfilled.
PROBES.country = (c) => c.business.hrCountrySetAt !== null;

PROBES.company_profile = (c) => {
  const cp = asObject(c.business.companyProfile);
  if (!cp || !filled(cp.legalName)) return false;
  return c.country === 'NZ'
    ? (filled(cp.irdEntityNumber) || filled(cp.nzbn))
    : (filled(cp.pan) && filled(cp.tan));
};

PROBES.entity = (c) => c.activeEntities > 0;

PROBES.locations = async (c) =>
  (await c.prisma.location.count({ where: { businessId: c.businessId, deletedAt: null, isActive: true } })) > 0;

PROBES.departments = async (c) =>
  (await c.prisma.department.count({ where: { businessId: c.businessId, deletedAt: null, isActive: true } })) > 0;

PROBES.designations = async (c) =>
  (await c.prisma.designation.count({ where: { businessId: c.businessId, deletedAt: null, isActive: true } })) > 0;

PROBES.grades = async (c) =>
  (await c.prisma.grade.count({ where: { businessId: c.businessId, deletedAt: null, isActive: true } })) > 0;

// Row existence is a FALSE POSITIVE (allocateCode auto-creates it at first hire),
// so only a deliberate divergence from the shipped default reads as done.
PROBES.employee_number = async (c) => {
  const row = await c.prisma.numberSequence.findFirst({
    where: { businessId: c.businessId, entityId: null, scope: 'EMPLOYEE', periodKey: null },
    select: { prefix: true, padding: true },
  });
  return !!row && (row.prefix !== EMP_DEFAULTS.prefix || row.padding !== EMP_DEFAULTS.padding);
};

PROBES.branding = async (c) => {
  const row = await c.prisma.tenantBrand.findFirst({
    where: { businessId: c.businessId, entityId: null, deletedAt: null },
    select: { logoUrl: true, primaryColor: true },
  });
  return !!(row && (row.logoUrl || row.primaryColor));
};

// customDomain lives on Subscription, NOT on Business. An unverified domain is a
// half-finished DNS change, not a working sign-in address.
PROBES.custom_domain = async (c) => {
  const sub = await c.prisma.subscription.findUnique({
    where: { businessId: c.businessId },
    select: { customDomain: true, customDomainVerified: true },
  });
  return !!(sub && sub.customDomain && sub.customDomainVerified);
};

// Six SYSTEM_ROLES are seeded at Business creation, so "a role exists" proves
// nothing. Either a second operator holds a role, or the tenant authored one.
PROBES.hr_team_roles = async (c) => {
  const [operators, ownRoles] = await Promise.all([
    c.prisma.user.count({ where: { businessId: c.businessId, isActive: true, businessRoleId: { not: null } } }),
    c.prisma.businessRole.count({ where: { businessId: c.businessId, isSystem: false } }),
  ]);
  return operators >= 2 || ownRoles > 0;
};

// businessId is @unique on SsoConnection → findUnique. Never select the encrypted
// secret columns; the step only needs to know the connection is switched on.
PROBES.sso = async (c) => {
  const row = await c.prisma.ssoConnection.findUnique({
    where: { businessId: c.businessId },
    select: { isActive: true },
  });
  return !!row && row.isActive;
};

// ═══ PEOPLE ═══
PROBES.employees = (c) => c.activeEmployees > 0;

// One person may legitimately have no manager: the root of the org tree.
PROBES.managers = async (c) => {
  const noManager = await c.prisma.employee.count({
    where: { ...c.activeEmployeeWhere, managerEmployeeId: null },
  });
  return {
    completed: c.activeEmployees > 0 && noManager <= 1,
    coverage: { done: c.activeEmployees - noManager, total: c.activeEmployees, unit: 'people' },
  };
};

// Not an adoption metric: approverResolver.employeeUserIds filters userId != null,
// so a manager who was never invited cannot be resolved as an approver at all.
PROBES.portal_invites = async (c) => {
  const linked = await c.prisma.employee.count({ where: { ...c.activeEmployeeWhere, userId: { not: null } } });
  return coverageVerdict(linked, c.activeEmployees, 0.80);
};

PROBES.statutory_ids = async (c) => {
  const idField = c.country === 'NZ' ? 'irdNumber' : 'pan';
  const covered = await c.prisma.statutoryProfile.count({
    where: {
      businessId: c.businessId,
      [idField]: { not: null },
      employee: { deletedAt: null, status: { in: ACTIVE_SET } },
    },
  });
  return coverageVerdict(covered, c.activeEmployees, 0.90);
};

// Scoped through the employee relation so a leaver's stale account can never push
// the coverage line past the people who are actually on the payroll.
PROBES.bank_accounts = async (c) => {
  const withBank = await distinctCount(c.prisma.bankAccount, {
    businessId: c.businessId, deletedAt: null, isActive: true, isPrimary: true,
    employee: { deletedAt: null, status: { in: ACTIVE_SET } },
  }, 'employeeId');
  return coverageVerdict(withBank, c.activeEmployees, 0.90);
};

// isPublished is load-bearing: a draft chain never routes a real request. There is
// no deletedAt on this model.
PROBES.approval_workflows = async (c) =>
  (await c.prisma.workflowDefinition.count({ where: { businessId: c.businessId, isActive: true, isPublished: true } })) > 0;

// The column defaults to {} (fail-open write), so "never touched" and "deliberately
// wide open" are indistinguishable — hence this step is dismissible.
PROBES.field_access = async (c) => {
  const rows = await c.prisma.businessRole.findMany({
    where: { businessId: c.businessId },
    select: { fieldAccess: true },
  });
  return rows.some((r) => asObject(r.fieldAccess) && Object.keys(r.fieldAccess).length > 0);
};

PROBES.custom_fields = async (c) =>
  (await c.prisma.customFieldDefinition.count({
    where: { businessId: c.businessId, entityType: 'EMPLOYEE', isActive: true, deletedAt: null },
  })) > 0;

// MUST filter on direction — the same model holds the offboarding templates.
PROBES.onboarding_checklist = async (c) =>
  (await c.prisma.lifecycleTemplate.count({
    where: { businessId: c.businessId, deletedAt: null, isActive: true, direction: 'ONBOARDING' },
  })) > 0;

PROBES.offboarding_checklist = async (c) =>
  (await c.prisma.lifecycleTemplate.count({
    where: { businessId: c.businessId, deletedAt: null, isActive: true, direction: 'OFFBOARDING' },
  })) > 0;

PROBES.probation_policy = async (c) =>
  (await c.prisma.probationPolicy.count({ where: { businessId: c.businessId, isActive: true } })) > 0;

// ═══ TIME & ATTENDANCE ═══
// Year-scoped: last year's calendar must not read as this year's setup. Holiday
// carries NEITHER isActive NOR deletedAt.
PROBES.holidays = async (c) => {
  const y = c.today.getUTCFullYear();
  const n = await c.prisma.holiday.count({
    where: { businessId: c.businessId, date: { gte: new Date(Date.UTC(y, 0, 1)), lt: new Date(Date.UTC(y + 1, 0, 1)) } },
  });
  return n > 0;
};

PROBES.shifts = async (c) =>
  (await c.prisma.shiftPattern.count({ where: { businessId: c.businessId, deletedAt: null, isActive: true } })) > 0;

// No isActive/deletedAt here — currency IS the effectiveFrom/effectiveTo window.
PROBES.shift_assignment = async (c) => {
  const assigned = await distinctCount(c.prisma.shiftAssignment, {
    businessId: c.businessId,
    effectiveFrom: { lte: c.today },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: c.today } }],
    employee: { deletedAt: null, status: { in: ACTIVE_SET } },
  }, 'employeeId');
  return coverageVerdict(assigned, c.activeEmployees, 0.90);
};

// Nothing is seeded at tenant creation, so the whole Leave module is inert until
// this exists. (Permission surprise: leave type/policy CRUD is canManageOrg.)
PROBES.leave_types = async (c) =>
  (await c.prisma.leaveType.count({ where: { businessId: c.businessId, deletedAt: null, isActive: true } })) > 0;

PROBES.leave_policies = async (c) =>
  (await c.prisma.leavePolicy.count({ where: { businessId: c.businessId, deletedAt: null, isActive: true } })) > 0;

// Deliberately NOT a per-employee coverage ratio: scope resolution
// (ENTITY|DEPARTMENT|GRADE|EMPLOYMENT_TYPE|EMPLOYEE) is engine logic, and
// re-implementing it in a probe would drift away from the engine.
PROBES.leave_assignments = async (c) =>
  (await c.prisma.leavePolicyAssignment.count({
    where: {
      businessId: c.businessId,
      effectiveFrom: { lte: c.today },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: c.today } }],
    },
  })) > 0;

// Only COMMITTED means the data actually landed.
PROBES.leave_opening_balances = async (c) =>
  (await c.prisma.importJob.count({
    where: { businessId: c.businessId, deletedAt: null, kind: 'LEAVE_BALANCE', status: 'COMMITTED' },
  })) > 0;

// A policy row with all three require* false is a no-op, hence the OR.
PROBES.attendance_capture = async (c) =>
  (await c.prisma.attendanceCapturePolicy.count({
    where: {
      businessId: c.businessId, isActive: true,
      OR: [{ requireGeo: true }, { requireIp: true }, { requireFace: true }],
    },
  })) > 0;

PROBES.biometric_devices = async (c) =>
  (await c.prisma.punchDevice.count({ where: { businessId: c.businessId, deletedAt: null, isActive: true } })) > 0;

// Either door counts — overtime and late-coming are one product decision to the
// user, and neither model has a deletedAt.
PROBES.work_policies = async (c) => {
  const [ot, late] = await Promise.all([
    c.prisma.overtimeRule.count({ where: { businessId: c.businessId, isActive: true } }),
    c.prisma.lateComingRule.count({ where: { businessId: c.businessId, isActive: true } }),
  ]);
  return ot > 0 || late > 0;
};

// Probe the KEY's PRESENCE, not its value: the key only exists once PATCH
// /attendance/rh-settings wrote it, so presence is a genuine "someone decided this".
PROBES.restricted_holidays = (c) => Number.isInteger(c.featureFlags?.leave?.restrictedHolidayAllowance);

// ensureCompOffType() auto-seeds the type plus a NONE-accrual policy on the first
// HR manual grant, so mere existence is a false positive — require a written config.
PROBES.comp_off = async (c) => {
  const type = await c.prisma.leaveType.findFirst({
    where: { businessId: c.businessId, category: 'COMP_OFF', deletedAt: null, isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!type) return false;
  const policy = await c.prisma.leavePolicy.findFirst({
    where: { businessId: c.businessId, leaveTypeId: type.id, isActive: true, deletedAt: null },
    select: { compOffConfig: true },
  });
  return !!(policy && policy.compOffConfig !== null && policy.compOffConfig !== undefined);
};

// Distinct from encashOnExit, which is the full-and-final path.
PROBES.leave_encashment = async (c) =>
  (await c.prisma.leavePolicy.count({
    where: { businessId: c.businessId, deletedAt: null, isActive: true, encashInService: true },
  })) > 0;

// ═══ PAY & TAX ═══
// Either door counts — CtcPolicy is the friendly builder, SalaryStructure the
// legacy per-entity one.
PROBES.ctc_policy = async (c) => {
  const [policies, structures] = await Promise.all([
    c.prisma.ctcPolicy.count({ where: { businessId: c.businessId, deletedAt: null, isActive: true } }),
    c.prisma.salaryStructure.count({ where: { businessId: c.businessId, deletedAt: null, isActive: true } }),
  ]);
  return policies > 0 || structures > 0;
};

PROBES.pay_components = async (c) =>
  (await c.prisma.salaryComponent.count({ where: { businessId: c.businessId, deletedAt: null, isActive: true } })) > 0;

// PROPOSED/APPROVED are the maker-checker path and must NOT read as payable.
PROBES.salary_assigned = async (c) => {
  const paid = await distinctCount(c.prisma.compensationRevision, {
    businessId: c.businessId, isCurrent: true, status: 'EFFECTIVE',
    employee: { deletedAt: null, status: { in: ACTIVE_SET } },
  }, 'employeeId');
  return coverageVerdict(paid, c.activeEmployees, 0.95);
};

// HARD structural dependency: PayRun.payCalendarId is non-nullable, so a company
// without a calendar can never have a pay run. PayCalendar has no deletedAt.
PROBES.pay_calendar = async (c) => {
  const withCal = await distinctCount(c.prisma.payCalendar, { businessId: c.businessId, isActive: true }, 'entityId');
  return {
    completed: c.activeEntities > 0 && withCal >= c.activeEntities,
    coverage: { done: Math.min(withCal, c.activeEntities), total: c.activeEntities, unit: 'companies' },
  };
};

// NULL means the engine default (CALENDAR_DAYS), which is a legitimate production
// choice — so this is a "you looked at it" signal, hence Recommended.
PROBES.salary_day_basis = async (c) => {
  const unset = await c.prisma.entity.count({ where: { ...c.activeEntityWhere, prorationBasis: null } });
  return {
    completed: c.activeEntities > 0 && unset === 0,
    coverage: { done: c.activeEntities - unset, total: c.activeEntities, unit: 'companies' },
  };
};

PROBES.statutory_registrations = async (c) => {
  const covered = await distinctCount(c.prisma.statutoryRegistration, {
    businessId: c.businessId, isActive: true,
    entity: { deletedAt: null, status: 'ACTIVE', countryCode: 'IN' },
  }, 'entityId');
  return {
    completed: c.activeInEntities > 0 && covered >= c.activeInEntities,
    coverage: { done: Math.min(covered, c.activeInEntities), total: c.activeInEntities, unit: 'companies' },
  };
};

// Key PRESENCE is the signal — written only by PATCH /payroll/payslip-settings.
PROBES.payslip_settings = (c) => ['NONE', 'DOB'].includes(c.featureFlags?.payroll?.payslipPdfPassword);

// businessId is @unique → findUnique. Absent means DEFAULT_THRESHOLDS apply, which
// is a working state, so this is Recommended.
PROBES.variance_thresholds = async (c) =>
  (await c.prisma.varianceThreshold.findUnique({ where: { businessId: c.businessId }, select: { id: true } })) !== null;

// Either the import landed, or someone back-filled runs directly as type MIGRATED.
PROBES.payroll_history_import = async (c) => {
  const [imported, migratedRuns] = await Promise.all([
    c.prisma.importJob.count({
      where: { businessId: c.businessId, deletedAt: null, kind: 'PAYROLL_HISTORY', status: 'COMMITTED' },
    }),
    c.prisma.payRun.count({ where: { businessId: c.businessId, deletedAt: null, type: 'MIGRATED' } }),
  ]);
  return imported > 0 || migratedRuns > 0;
};

// @@unique([businessId, fy]) — MUST be FY-scoped; the field is `fy`.
PROBES.tax_regime_policy = async (c) =>
  (await c.prisma.taxRegimePolicy.count({ where: { businessId: c.businessId, fy: c.currentFy } })) > 0;

// MUST filter on purpose — the same table also holds FBP_ALLOCATION windows.
// DRAFT means created-but-never-opened and does not count.
PROBES.tax_declaration_window = async (c) =>
  (await c.prisma.investmentDeclarationWindow.count({
    where: {
      businessId: c.businessId, financialYear: c.currentFy,
      purpose: 'INVESTMENT_PROOF', status: { in: ['OPEN', 'CLOSED', 'LOCKED'] },
    },
  })) > 0;

// A plan with no heads is inert — nobody can allocate anything into it.
PROBES.fbp_plan = async (c) => {
  const plan = await c.prisma.fbpPlan.findFirst({
    where: { businessId: c.businessId, deletedAt: null, isActive: true, financialYear: c.currentFy },
    select: { id: true },
  });
  if (!plan) return false;
  return (await c.prisma.fbpPlanHead.count({ where: { businessId: c.businessId, planId: plan.id } })) > 0;
};

// type MIGRATED is excluded so an import-generated back-run never counts as the
// activation moment. A DRAFT/COMPUTED run is started, not done.
PROBES.first_payroll = async (c) =>
  (await c.prisma.payRun.count({
    where: {
      businessId: c.businessId, deletedAt: null, type: 'REGULAR',
      status: { in: ['APPROVED', 'PAID', 'FILED'] },
    },
  })) > 0;

PROBES.disbursement_bank = async (c) =>
  (await c.prisma.entity.count({ where: { ...c.activeEntityWhere, defaultPayoutBank: { not: null } } })) > 0;

PROBES.first_disbursement = async (c) =>
  (await c.prisma.payoutBatch.count({ where: { businessId: c.businessId } })) > 0;

PROBES.compliance_calendar = async (c) =>
  (await c.prisma.complianceObligation.count({ where: { businessId: c.businessId, isActive: true } })) > 0;

PROBES.statutory_registers = async (c) =>
  (await c.prisma.registerDefinition.count({ where: { businessId: c.businessId, isActive: true } })) > 0;

PROBES.expense_categories = async (c) =>
  (await c.prisma.expenseCategory.count({ where: { businessId: c.businessId, deletedAt: null, isActive: true } })) > 0;

// Either door counts — per-category caps and the travel per-diem/hotel matrix are
// the same product decision to the user.
PROBES.expense_policy = async (c) => {
  const [expense, travel] = await Promise.all([
    c.prisma.expensePolicy.count({ where: { businessId: c.businessId, deletedAt: null, isActive: true } }),
    c.prisma.travelPolicy.count({ where: { businessId: c.businessId, deletedAt: null, isActive: true } }),
  ]);
  return expense > 0 || travel > 0;
};

PROBES.variable_pay_scheme = async (c) =>
  (await c.prisma.variablePayScheme.count({ where: { businessId: c.businessId, deletedAt: null, isActive: true } })) > 0;

PROBES.report_schedule = async (c) =>
  (await c.prisma.reportSchedule.count({ where: { businessId: c.businessId, isActive: true } })) > 0;

// ═══ ENGAGE & GROW ═══
// Require the tenant DEFAULT specifically: the resolution chain at issue time is
// category-specific letterhead → tenant default, so a category-only letterhead
// leaves most letters unstyled.
PROBES.letterheads = async (c) =>
  (await c.prisma.companyLetterhead.count({
    where: { businessId: c.businessId, deletedAt: null, isActive: true, isDefault: true, letterCategory: null },
  })) > 0;

// isActive TRUE means PUBLISHED (false = DRAFT/ARCHIVED); isSystem:false excludes
// the seeded IN/NZ templates so this reads "the tenant authored one".
PROBES.letter_templates = async (c) =>
  (await c.prisma.letterTemplate.count({
    where: { businessId: c.businessId, deletedAt: null, isActive: true, isSystem: false },
  })) > 0;

PROBES.helpdesk_categories = async (c) =>
  (await c.prisma.helpdeskCategory.count({ where: { businessId: c.businessId, isActive: true } })) > 0;

// publishedAt may be a FUTURE timestamp (a scheduled go-live), hence the lte.
PROBES.first_announcement = async (c) =>
  (await c.prisma.announcement.count({
    where: { businessId: c.businessId, status: 'PUBLISHED', archivedAt: null, publishedAt: { lte: new Date() } },
  })) > 0;

// A seed-defaults endpoint exists, so "exists" may mean "clicked seed" — that is
// acceptable, the tenant still made the choice.
PROBES.recognition_setup = async (c) => {
  const [values, badges] = await Promise.all([
    c.prisma.recognitionValue.count({ where: { businessId: c.businessId, isActive: true } }),
    c.prisma.recognitionBadge.count({ where: { businessId: c.businessId, isActive: true } }),
  ]);
  return values > 0 && badges > 0;
};

// Never join SurveyResponse back to an employee — anonymous ballots carry no
// employeeId by design, and this probe has no business looking.
PROBES.first_survey = async (c) =>
  (await c.prisma.survey.count({ where: { businessId: c.businessId, status: { in: ['PUBLISHED', 'CLOSED'] } } })) > 0;

PROBES.competency_framework = async (c) =>
  (await c.prisma.competency.count({ where: { businessId: c.businessId, isActive: true } })) > 0;

// ReviewCycle has NEITHER isActive NOR deletedAt — the status enum is the filter.
// DRAFT is excluded so this reads "launched".
PROBES.performance_cycle = async (c) =>
  (await c.prisma.reviewCycle.count({
    where: {
      businessId: c.businessId,
      status: { in: ['ACTIVE', 'SELF_REVIEW', 'MANAGER_REVIEW', 'CALIBRATION', 'CLOSED'] },
    },
  })) > 0;

PROBES.first_course = async (c) =>
  (await c.prisma.course.count({ where: { businessId: c.businessId, deletedAt: null, status: 'PUBLISHED' } })) > 0;

// No isActive on PipelineTemplate — deletedAt plus the default flag.
PROBES.hiring_pipeline = async (c) =>
  (await c.prisma.pipelineTemplate.count({ where: { businessId: c.businessId, deletedAt: null, isDefault: true } })) > 0;

// businessId is @unique → findUnique. An unpublished row falls back to hard-coded
// copy on the public board, so it is not "done".
PROBES.careers_page = async (c) => {
  const row = await c.prisma.careersPage.findUnique({
    where: { businessId: c.businessId },
    select: { isPublished: true },
  });
  return row ? row.isPublished === true : false;
};

PROBES.candidate_messages = (c) => {
  const cfg = asObject(c.business.candidateCommsConfig);
  return !!cfg && Object.keys(cfg).length > 0;
};

// No isActive on Job — deletedAt plus the status enum.
PROBES.first_job = async (c) =>
  (await c.prisma.job.count({
    where: { businessId: c.businessId, deletedAt: null, status: { in: ['OPEN', 'ON_HOLD'] } },
  })) > 0;

/**
 * runProbes — evaluate `keys` CONCURRENTLY, each individually insulated.
 *
 * Roughly thirty indexed count/findFirst queries fired in one batch. A rejection
 * is contained to its own step: `{ ok:false }` degrades that row to "Couldn't
 * check" and the endpoint still answers 200. Nothing here rethrows.
 */
async function runProbes(ctx, keys) {
  const entries = await Promise.all(keys.map(async (key) => {
    const probe = PROBES[key];
    // A declared step with no probe is a registry bug, not a tenant problem —
    // report it as unknown rather than silently scoring it incomplete.
    if (!probe) {
      console.warn(`setup-checklist: no probe registered for step "${key}"`);
      return [key, { ok: false, completed: false, coverage: null }];
    }
    try {
      const out = await probe(ctx);
      if (out && typeof out === 'object') {
        return [key, { ok: true, completed: !!out.completed, coverage: out.coverage || null }];
      }
      return [key, { ok: true, completed: !!out, coverage: null }];
    } catch (err) {
      console.warn(`setup-checklist: probe "${key}" failed for business ${ctx.businessId} — ${err.message}`);
      return [key, { ok: false, completed: false, coverage: null }];
    }
  }));
  return Object.fromEntries(entries);
}

module.exports = {
  ACTIVE_SET,
  PROBES,
  loadContext,
  runProbes,
  // exported for tests
  taxYearStart,
  coverageVerdict,
};
