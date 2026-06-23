/* eslint-disable no-console */
// =============================================================================
// seed-hr.js — DEMO tenant seed for the HRMS.
//
// Creates a realistic, self-contained DEMO tenant so the apps have data and a
// real pay run can execute end-to-end. Idempotent: every row is upserted on its
// natural key (the `@@unique` codes in schema.prisma) so re-running is safe.
//
// Run with:   node prisma/seed-hr.js
// Registered as the prisma seed (backend/package.json -> "prisma": { "seed" }).
//
// What it builds (counts):
//   1  Business (slug 'demo', region 'IN') + 1 Subscription (Growth, white-label
//                                                             theme + branding)
//   1  TenantBrand (tenant-wide default brand)
//   1  super-admin User + 1 tenant-admin (operator) User + 1 BusinessRole
//   3  Employee-portal Users (ESS logins, linked to 3 of the employees)
//   2  Entities  — IN (INR, monthly) and NZ (NZD, fortnightly)
//   per entity: 1 Location, 1 Department, 1 Designation, 1 Grade, 1 Band,
//               1 PayCalendar, statutory Registrations
//   5  Employees (3 IN + 2 NZ), each with:
//        - EmploymentRecord (current, effective-dated)
//        - StatutoryProfile  (IN: PAN/UAN/PF/ESI/PT-state; NZ: IRD/KiwiSaver/tax code)
//        - SalaryStructure   (per entity) + SalaryComponents (shared) + lines
//          (IN Basic >= 50% of CTC per Code-on-Wages; HRA; Special Allowance
//           as the BALANCING line; statutory employer-cost components)
//        - CompensationRevision (current, links the structure) + lines
//        - AttendancePayInput for the current period (payable days; some LOP)
//   LeaveType(s) + LeavePolicy(ies) + a LeaveBalance per employee
//   2  PayRun rows (DRAFT, one per entity) so the AttendancePayInputs attach and
//      `payrollService.computeRun` can run against frozen inputs immediately.
//
// All Decimal fields are passed as strings or plain numbers (never floats built
// from arithmetic) so Prisma's Decimal coercion is exact — see schema.prisma.
//
// The amounts are realistic INR (IN entity) / NZD (NZ entity) monthly figures.
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');

const prisma = new PrismaClient();

// All demo logins share the password:  Demo@12345
// Hash at runtime so it ALWAYS matches the password (the old precomputed hash
// did not, which silently broke every demo login).
const bcrypt = require('bcryptjs');
const DEMO_PASSWORD_HASH = bcrypt.hashSync('Demo@12345', 10);

// Deterministic UUID v5-ish helper so repeated runs produce stable ids for rows
// that have NO natural @@unique key we can upsert on (e.g. component lines). We
// key the id off a stable string so the seed stays idempotent via create+skip.
const NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
function det(seed) {
  const h = crypto.createHash('sha1').update(NS + seed).digest('hex');
  // shape into a uuid (set version 5 + variant bits — purely cosmetic here)
  return (
    h.slice(0, 8) + '-' + h.slice(8, 12) + '-5' + h.slice(13, 16) + '-' +
    ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) + h.slice(18, 20) + '-' +
    h.slice(20, 32)
  );
}

function d(s) {
  // Date helper — a @db.Date column wants a Date at UTC midnight.
  return new Date(s + 'T00:00:00.000Z');
}

// Current period for the demo pay runs. The IN run is the calendar month; the
// NZ run is a fortnight inside it. Chosen relative to "today" so payslips look
// current, but pinned to month boundaries so proration math is clean.
const NOW = new Date();
const PERIOD_YEAR = NOW.getUTCFullYear();
const PERIOD_MONTH = NOW.getUTCMonth() + 1; // 1..12
const ymd = (y, m, day) => `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const IN_PERIOD_START = ymd(PERIOD_YEAR, PERIOD_MONTH, 1);
const IN_PERIOD_END = ymd(PERIOD_YEAR, PERIOD_MONTH, lastDayOfMonth(PERIOD_YEAR, PERIOD_MONTH));
const IN_PAY_DATE = IN_PERIOD_END; // last working day approximation
const IN_CAL_DAYS = lastDayOfMonth(PERIOD_YEAR, PERIOD_MONTH);

const NZ_PERIOD_START = ymd(PERIOD_YEAR, PERIOD_MONTH, 1);
const NZ_PERIOD_END = ymd(PERIOD_YEAR, PERIOD_MONTH, 14);
const NZ_PAY_DATE = ymd(PERIOD_YEAR, PERIOD_MONTH, 17);
const NZ_CAL_DAYS = 14;

// Tax-year strings (entity fiscal start = April).
const taxYearFor = (y, m, startMonth = 4) => {
  const startY = m >= startMonth ? y : y - 1;
  return `${startY}-${String((startY + 1) % 100).padStart(2, '0')}`;
};
const IN_TAX_YEAR = taxYearFor(PERIOD_YEAR, PERIOD_MONTH, 4);
const NZ_TAX_YEAR = taxYearFor(PERIOD_YEAR, PERIOD_MONTH, 4);

// ---------------------------------------------------------------------------
// Tiny idempotent helpers (create-if-absent on a deterministic id).
// ---------------------------------------------------------------------------
async function ensure(model, id, data) {
  // model: a prisma delegate; create the row at a deterministic id if missing,
  // otherwise update the mutable fields. Keeps the seed idempotent for models
  // without a usable natural @@unique.
  return prisma[model].upsert({ where: { id }, create: { id, ...data }, update: data });
}

async function main() {
  console.log('▶ Seeding DEMO HRMS tenant…');
  console.log(`  IN period ${IN_PERIOD_START} → ${IN_PERIOD_END} (pay ${IN_PAY_DATE}), tax year ${IN_TAX_YEAR}`);
  console.log(`  NZ period ${NZ_PERIOD_START} → ${NZ_PERIOD_END} (pay ${NZ_PAY_DATE}), tax year ${NZ_TAX_YEAR}`);

  // ═════════════════════════════════════════════════════════════════════════
  // 1. BUSINESS (demo tenant) + SUBSCRIPTION + TENANT BRAND
  // ═════════════════════════════════════════════════════════════════════════
  const business = await prisma.business.upsert({
    where: { slug: 'demo' },
    update: { name: 'Demo HR Co', region: 'IN', country: 'IN', timezone: 'Asia/Kolkata', isActive: true },
    create: {
      name: 'Demo HR Co',
      slug: 'demo',
      description: 'Demo tenant for the HRMS — IN + NZ entities.',
      country: 'IN',
      region: 'IN', // HR fork: deployment market (drives default statutory modules)
      timezone: 'Asia/Kolkata',
      email: 'admin@demo.test',
      isActive: true,
    },
  });
  const businessId = business.id;
  console.log(`✓ Business "${business.name}" (${businessId}) slug=${business.slug}`);

  // A Subscription needs a PricingTier. Prefer an HR-vertical tier (the pricing
  // seed creates Starter/Growth/Enterprise); fall back to any active tier so
  // this seed doesn't hard-depend on pricing.seed having run.
  let tier =
    (await prisma.pricingTier.findFirst({ where: { slug: 'growth' } })) ||
    (await prisma.pricingTier.findFirst({ where: { vertical: 'HR' }, orderBy: { sortOrder: 'asc' } })) ||
    (await prisma.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }));
  if (!tier) {
    // No catalog at all — mint a minimal HR Growth tier so the subscription FK resolves.
    tier = await prisma.pricingTier.upsert({
      where: { slug: 'growth' },
      update: {},
      create: { slug: 'growth', vertical: 'HR', name: 'Growth', sortOrder: 2, includedStaff: 50, isActive: true },
    });
    console.log('  (minted fallback PricingTier "growth")');
  }

  // themeColors is a String? JSON blob on Subscription — stringify it.
  const themeColors = JSON.stringify({ primary: '#10b981', colorKey: 'emerald' });
  await prisma.subscription.upsert({
    where: { businessId },
    update: { tierId: tier.id, theme: 'hr', themeStyle: 'emerald', themeColors, status: 'ACTIVE' },
    create: {
      businessId,
      tierId: tier.id,
      status: 'ACTIVE',
      seatsUsed: 5,
      billingCycle: 'MONTHLY',
      theme: 'hr',
      themeStyle: 'emerald', // one of slate/indigo/emerald/rose/mono
      themeColors,
      gateway: 'RAZORPAY',
      activatedAt: new Date(),
    },
  });
  console.log(`✓ Subscription on tier "${tier.slug}" (themeStyle=emerald, primary #10b981)`);

  await prisma.tenantBrand.upsert({
    where: { businessId_code: { businessId, code: 'DEMO-DEFAULT' } },
    update: { primaryColor: '#10b981', name: 'Demo HR Co' },
    create: {
      businessId,
      code: 'DEMO-DEFAULT',
      name: 'Demo HR Co',
      primaryColor: '#10b981',
      secondaryColor: '#064e3b',
      accentColor: '#34d399',
      emailFromName: 'Demo HR Co',
      supportEmail: 'support@demo.test',
      isDefault: true,
      isActive: true,
    },
  });
  console.log('✓ TenantBrand (tenant-wide default)');

  // ═════════════════════════════════════════════════════════════════════════
  // 2. USERS + BUSINESS ROLE
  // ═════════════════════════════════════════════════════════════════════════
  // Super-admin is platform-scoped (businessId null). Tenant-admin is the HR
  // operator. A BusinessRole gives the operator HR permissions.
  // Tenant-admin gets the full Owner preset (every permission key) — it's the
  // company's own administrator. Re-seeding repairs the permissions too.
  const { SYSTEM_ROLES } = require('../src/core/lib/rbac');
  const adminRole = await prisma.businessRole.upsert({
    where: { businessId_name: { businessId, name: 'HR Administrator' } },
    update: { permissions: SYSTEM_ROLES.Owner, isSystem: true },
    create: {
      businessId,
      name: 'HR Administrator',
      isSystem: true,
      permissions: SYSTEM_ROLES.Owner,
    },
  });

  // A second role — Finance — so the Segregation-of-Duties (SoD) maker/checker
  // path is exercisable end-to-end with TWO distinct operators. The HR Operator
  // (Owner) is the MAKER (proposes comp revisions, runs payroll, initiates
  // separations); the Finance user is the CHECKER (approves comp, approves the
  // locked PayRun, approves FnF). Self-approval is blocked by SoD, so a single
  // login can't demonstrate the happy path — this gives the demo a real checker.
  const financeRole = await prisma.businessRole.upsert({
    where: { businessId_name: { businessId, name: 'Finance' } },
    update: { permissions: SYSTEM_ROLES.Finance, isSystem: true },
    create: {
      businessId,
      name: 'Finance',
      isSystem: true,
      permissions: SYSTEM_ROLES.Finance,
    },
  });

  const superAdmin = await prisma.user.upsert({
    where: { email: 'superadmin@demo.test' },
    update: { role: 'SUPER_ADMIN' },
    create: {
      email: 'superadmin@demo.test',
      password: DEMO_PASSWORD_HASH,
      name: 'Platform Super Admin',
      role: 'SUPER_ADMIN',
      emailVerified: true,
      isActive: true,
    },
  });

  const operator = await prisma.user.upsert({
    where: { email: 'operator@demo.test' },
    update: { role: 'BUSINESS_ADMIN', businessId, businessRoleId: adminRole.id },
    create: {
      email: 'operator@demo.test',
      password: DEMO_PASSWORD_HASH,
      name: 'HR Operator',
      role: 'BUSINESS_ADMIN',
      businessId,
      businessRoleId: adminRole.id,
      emailVerified: true,
      isActive: true,
    },
  });

  // The SoD CHECKER login. BUSINESS_ADMIN role + the Finance BusinessRole so it
  // carries canApprovePayroll + canApproveCompensation but NOT the maker keys —
  // a clean second operator for approvals (payroll approve/pay/file/close, comp
  // checker, FnF approval) that the Owner-maker cannot self-approve.
  const finance = await prisma.user.upsert({
    where: { email: 'finance@demo.test' },
    update: { role: 'BUSINESS_ADMIN', businessId, businessRoleId: financeRole.id },
    create: {
      email: 'finance@demo.test',
      password: DEMO_PASSWORD_HASH,
      name: 'Finance Approver',
      role: 'BUSINESS_ADMIN',
      businessId,
      businessRoleId: financeRole.id,
      emailVerified: true,
      isActive: true,
    },
  });
  console.log(`✓ Users: super-admin (${superAdmin.email}) + operator (${operator.email}, ${adminRole.name}) + finance (${finance.email}, ${financeRole.name})`);

  // ═════════════════════════════════════════════════════════════════════════
  // 3. ENTITIES (IN + NZ) and their org scaffolding
  // ═════════════════════════════════════════════════════════════════════════
  const inEntity = await prisma.entity.upsert({
    where: { businessId_code: { businessId, code: 'IN-HQ' } },
    update: {},
    create: {
      businessId,
      code: 'IN-HQ',
      legalName: 'Demo HR Co Private Limited',
      tradeName: 'Demo HR Co',
      countryCode: 'IN',
      payCurrency: 'INR',
      timezone: 'Asia/Kolkata',
      taxYearStartMonth: 4,
      addressLine1: '1 MG Road',
      city: 'Bengaluru',
      stateCode: 'KA', // Karnataka — drives Professional Tax slab
      postalCode: '560001',
      pan: 'AAACD1234E',
      tan: 'BLRD12345F',
      gstin: '29AAACD1234E1Z5',
      cin: 'U72900KA2020PTC100001',
      status: 'ACTIVE',
      activeFrom: d('2020-04-01'),
    },
  });

  const nzEntity = await prisma.entity.upsert({
    where: { businessId_code: { businessId, code: 'NZ-AKL' } },
    update: {},
    create: {
      businessId,
      code: 'NZ-AKL',
      legalName: 'Demo HR Co NZ Limited',
      tradeName: 'Demo HR Co NZ',
      countryCode: 'NZ',
      payCurrency: 'NZD',
      timezone: 'Pacific/Auckland',
      taxYearStartMonth: 4,
      addressLine1: '1 Queen Street',
      city: 'Auckland',
      stateCode: 'AUK',
      postalCode: '1010',
      nzbn: '9429000000001',
      irdEntityNumber: '012-345-678',
      status: 'ACTIVE',
      activeFrom: d('2021-04-01'),
    },
  });
  console.log(`✓ Entities: ${inEntity.code} (IN/INR) + ${nzEntity.code} (NZ/NZD)`);

  // Statutory registrations (nice-to-have for filing aggregates).
  await prisma.statutoryRegistration.upsert({
    where: { businessId_entityId_kind_stateCode: { businessId, entityId: inEntity.id, kind: 'EPF', stateCode: '' } },
    update: {},
    create: { businessId, entityId: inEntity.id, kind: 'EPF', number: 'KABLR0012345000', stateCode: '', effectiveFrom: d('2020-04-01') },
  }).catch(() => {});
  await prisma.statutoryRegistration.upsert({
    where: { businessId_entityId_kind_stateCode: { businessId, entityId: inEntity.id, kind: 'PT_STATE', stateCode: 'KA' } },
    update: {},
    create: { businessId, entityId: inEntity.id, kind: 'PT_STATE', number: 'PT-KA-0012345', stateCode: 'KA', effectiveFrom: d('2020-04-01') },
  }).catch(() => {});
  await prisma.statutoryRegistration.upsert({
    where: { businessId_entityId_kind_stateCode: { businessId, entityId: nzEntity.id, kind: 'IRD_PAYE', stateCode: '' } },
    update: {},
    create: { businessId, entityId: nzEntity.id, kind: 'IRD_PAYE', number: '012-345-678', stateCode: '', effectiveFrom: d('2021-04-01') },
  }).catch(() => {});

  // --- Per-entity org rows (Band -> Grade -> Designation, Location, Department) ---
  async function buildOrg(entity, p) {
    const band = await prisma.band.upsert({
      where: { businessId_code: { businessId, code: `${p}-B1` } },
      update: {},
      create: { businessId, code: `${p}-B1`, name: `${p} Professional Band` },
    });
    const grade = await prisma.grade.upsert({
      where: { businessId_code: { businessId, code: `${p}-L3` } },
      update: {},
      create: {
        businessId, code: `${p}-L3`, name: `${p} Level 3`, rank: 3, bandId: band.id,
        minSalary: entity.countryCode === 'IN' ? '600000.00' : '60000.00',
        maxSalary: entity.countryCode === 'IN' ? '2400000.00' : '160000.00',
        currencyCode: entity.payCurrency,
      },
    });
    const designation = await prisma.designation.upsert({
      where: { businessId_code: { businessId, code: `${p}-SE` } },
      update: {},
      create: { businessId, code: `${p}-SE`, title: 'Senior Engineer', gradeId: grade.id },
    });
    const location = await prisma.location.upsert({
      where: { businessId_entityId_code: { businessId, entityId: entity.id, code: `${p}-LOC1` } },
      update: {},
      create: {
        businessId, entityId: entity.id, code: `${p}-LOC1`,
        name: entity.countryCode === 'IN' ? 'Bengaluru HQ' : 'Auckland Office',
        city: entity.city, stateCode: entity.stateCode, postalCode: entity.postalCode,
        countryCode: entity.countryCode, timezone: entity.timezone,
        isPrimary: true, isActive: true,
      },
    });
    const department = await prisma.department.upsert({
      where: { businessId_code: { businessId, code: `${p}-ENG` } },
      update: {},
      create: { businessId, code: `${p}-ENG`, name: 'Engineering', costCenter: `CC-${p}-ENG` },
    });
    return { band, grade, designation, location, department };
  }
  const inOrg = await buildOrg(inEntity, 'IN');
  const nzOrg = await buildOrg(nzEntity, 'NZ');
  console.log('✓ Org scaffolding per entity (Band/Grade/Designation/Location/Department)');

  // --- Pay calendars ---
  const inCalendar = await prisma.payCalendar.upsert({
    where: { businessId_entityId_code: { businessId, entityId: inEntity.id, code: 'IN-MONTHLY' } },
    update: {},
    create: {
      businessId, entityId: inEntity.id, code: 'IN-MONTHLY', name: 'India Monthly',
      frequency: 'MONTHLY', payDayRule: 'LAST_WORKING_DAY', payDayValue: null,
      cutoffDayRule: 'FIXED_DOM', cutoffDayValue: 25, prorationMethod: 'CALENDAR_DAYS', isActive: true,
    },
  });
  const nzCalendar = await prisma.payCalendar.upsert({
    where: { businessId_entityId_code: { businessId, entityId: nzEntity.id, code: 'NZ-FORTNIGHTLY' } },
    update: {},
    create: {
      businessId, entityId: nzEntity.id, code: 'NZ-FORTNIGHTLY', name: 'NZ Fortnightly',
      frequency: 'FORTNIGHTLY', payDayRule: 'N_DAYS_AFTER_PERIOD_END', payDayValue: 3,
      cutoffDayRule: 'N_DAYS_AFTER_PERIOD_END', cutoffDayValue: 0, prorationMethod: 'CALENDAR_DAYS', isActive: true,
    },
  });
  console.log('✓ Pay calendars: IN monthly + NZ fortnightly');

  // ═════════════════════════════════════════════════════════════════════════
  // 4. SALARY COMPONENTS (shared) — behaviour is driven by `kind` + flags
  // ═════════════════════════════════════════════════════════════════════════
  // The payroll engine reads component flags name-agnostically:
  //   kind BASIC/DEARNESS_ALLOWANCE => isBasic + isPfWages bases
  //   isWageForESI / isWageForPT     => ESI / PT bases
  //   calcMethod FLAT/PERCENT_OF/BALANCING are engine-evaluated;
  //   STATUTORY/SLAB are emitted by the compliance module (dropped from engine).
  async function component(code, data) {
    return prisma.salaryComponent.upsert({
      where: { businessId_code: { businessId, code } },
      update: {},
      create: { businessId, code, ...data },
    });
  }

  // India earning components
  const cBasic = await component('BASIC', {
    name: 'Basic', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT',
    isWageForPF: true, isWageForESI: true, isWageForPT: true, isWageForGratuity: true,
    isTaxable: true, prorationMethod: 'CALENDAR_DAYS', sortOrder: 1,
  });
  const cHra = await component('HRA', {
    name: 'House Rent Allowance', kind: 'HRA', category: 'EARNING', calcMethod: 'PERCENT_OF',
    calcValue: '50.0000', calcBaseCode: 'BASIC', calcBaseScope: 'SINGLE',
    isWageForESI: true, isWageForPT: true, isTaxable: true, taxSection: '10(13A)',
    prorationMethod: 'CALENDAR_DAYS', sortOrder: 2,
  });
  const cSpecial = await component('SPECIAL', {
    name: 'Special Allowance', kind: 'SPECIAL_ALLOWANCE', category: 'EARNING', calcMethod: 'BALANCING',
    isWageForESI: true, isWageForPT: true, isTaxable: true, prorationMethod: 'CALENDAR_DAYS', sortOrder: 3,
  });
  // India statutory employer-cost components (compliance module emits the
  // amounts; these exist so they show on CTC structures / payslip config).
  const cPfEr = await component('EPF_ER', {
    name: 'Provident Fund (Employer)', kind: 'PF_EMPLOYER', category: 'EMPLOYER_COST',
    calcMethod: 'STATUTORY', isTaxable: false, isRecurring: true, sortOrder: 20,
  });

  // NZ earning component (single gross salary line)
  const cNzSalary = await component('NZ_SALARY', {
    name: 'Salary', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT',
    isKiwiSaverable: true, isPayeable: true, isTaxable: true,
    prorationMethod: 'CALENDAR_DAYS', sortOrder: 1,
  });
  const cNzKsEr = await component('KIWISAVER_ER', {
    name: 'KiwiSaver (Employer)', kind: 'KIWISAVER_EMPLOYER', category: 'EMPLOYER_COST',
    calcMethod: 'STATUTORY', isTaxable: false, isRecurring: true, sortOrder: 20,
  });
  console.log('✓ Salary components (IN: BASIC/HRA/SPECIAL/EPF_ER ; NZ: NZ_SALARY/KIWISAVER_ER)');

  // ═════════════════════════════════════════════════════════════════════════
  // 5. SALARY STRUCTURES (per entity) + structure lines
  // ═════════════════════════════════════════════════════════════════════════
  const inStructure = await prisma.salaryStructure.upsert({
    where: { businessId_entityId_code: { businessId, entityId: inEntity.id, code: 'IN-STAFF-CTC' } },
    update: {},
    create: {
      businessId, entityId: inEntity.id, code: 'IN-STAFF-CTC', name: 'IN Staff CTC',
      countryCode: 'IN', currencyCode: 'INR', basis: 'CTC', isActive: true,
    },
  });
  const nzStructure = await prisma.salaryStructure.upsert({
    where: { businessId_entityId_code: { businessId, entityId: nzEntity.id, code: 'NZ-SALARIED' } },
    update: {},
    create: {
      businessId, entityId: nzEntity.id, code: 'NZ-SALARIED', name: 'NZ Salaried Gross',
      countryCode: 'NZ', currencyCode: 'NZD', basis: 'GROSS', isActive: true,
    },
  });

  // Template lines (amounts are illustrative; per-employee lines on the
  // CompensationRevision carry the real money). Basic >= 50% of monthly gross.
  async function structureLine(key, structureId, component, line) {
    return ensure('salaryComponentLine', det(`sline:${key}`), {
      businessId, structureId, componentId: component.id, ...line,
    });
  }
  await structureLine('in-basic', inStructure.id, cBasic, { calcMethod: 'FLAT', amountMonthly: '50000.00', sortOrder: 1 });
  await structureLine('in-hra', inStructure.id, cHra, { calcMethod: 'PERCENT_OF', calcValue: '50.0000', sortOrder: 2 });
  await structureLine('in-special', inStructure.id, cSpecial, { calcMethod: 'BALANCING', amountMonthly: '20000.00', sortOrder: 3 });
  await structureLine('nz-salary', nzStructure.id, cNzSalary, { calcMethod: 'FLAT', amountMonthly: '3000.00', sortOrder: 1 });
  console.log('✓ Salary structures (IN CTC + NZ Gross) with template lines');

  // ═════════════════════════════════════════════════════════════════════════
  // 6. LEAVE TYPES + POLICIES
  // ═════════════════════════════════════════════════════════════════════════
  const ltEL = await prisma.leaveType.upsert({
    where: { businessId_code: { businessId, code: 'EL' } },
    update: {},
    create: {
      businessId, code: 'EL', name: 'Earned Leave', countryCode: 'IN', category: 'ANNUAL',
      unit: 'DAYS', isPaid: true, isStatutory: true, isEncashable: true, color: '#10b981',
    },
  });
  const ltSL = await prisma.leaveType.upsert({
    where: { businessId_code: { businessId, code: 'SL' } },
    update: {},
    create: {
      businessId, code: 'SL', name: 'Sick Leave', countryCode: 'IN', category: 'SICK',
      unit: 'DAYS', isPaid: true, color: '#f59e0b',
    },
  });
  const ltNZAnnual = await prisma.leaveType.upsert({
    where: { businessId_code: { businessId, code: 'ANNUAL' } },
    update: {},
    create: {
      businessId, code: 'ANNUAL', name: 'Annual Holidays', countryCode: 'NZ', category: 'ANNUAL',
      unit: 'WEEKS', isPaid: true, isStatutory: true, nzPayBasis: 'AWE_8PCT', color: '#6366f1',
    },
  });

  const polEL = await prisma.leavePolicy.upsert({
    where: { businessId_code: { businessId, code: 'EL-STD' } },
    update: {},
    create: {
      businessId, leaveTypeId: ltEL.id, entityId: inEntity.id, code: 'EL-STD', name: 'Earned Leave (Standard)',
      accrualMethod: 'MONTHLY_ACCRUAL', entitlementPerYear: '18.0000', accrualFrequency: 'MONTHLY',
      carryForwardCap: '45.0000', maxBalanceCap: '60.0000', minNoticeDays: 3, isActive: true,
    },
  });
  await prisma.leavePolicy.upsert({
    where: { businessId_code: { businessId, code: 'SL-STD' } },
    update: {},
    create: {
      businessId, leaveTypeId: ltSL.id, entityId: inEntity.id, code: 'SL-STD', name: 'Sick Leave (Standard)',
      accrualMethod: 'UPFRONT_ANNUAL', entitlementPerYear: '12.0000', accrualFrequency: 'ANNUAL', isActive: true,
    },
  });
  const polNZ = await prisma.leavePolicy.upsert({
    where: { businessId_code: { businessId, code: 'NZ-ANNUAL' } },
    update: {},
    create: {
      businessId, leaveTypeId: ltNZAnnual.id, entityId: nzEntity.id, code: 'NZ-ANNUAL', name: 'Annual Holidays (NZ)',
      accrualMethod: 'CONTINUOUS_NZ', entitlementPerYear: '4.0000', accrualFrequency: 'PER_PAY_PERIOD',
      minTenureMonths: 12, isActive: true,
    },
  });
  console.log('✓ Leave types (EL/SL/ANNUAL) + policies');

  // ═════════════════════════════════════════════════════════════════════════
  // 7. PAY RUNS (DRAFT) — one per entity, so AttendancePayInputs attach and a
  //    real pay run can compute against frozen inputs.
  // ═════════════════════════════════════════════════════════════════════════
  const inRunCode = `PR-${IN_PERIOD_START.slice(0, 7)}-IN`;
  const nzRunCode = `PR-${NZ_PERIOD_START.slice(0, 7)}-NZ`;
  const inRun = await prisma.payRun.upsert({
    where: { businessId_code: { businessId, code: inRunCode } },
    update: {},
    create: {
      businessId, entityId: inEntity.id, payCalendarId: inCalendar.id, code: inRunCode,
      periodStart: d(IN_PERIOD_START), periodEnd: d(IN_PERIOD_END), payDate: d(IN_PAY_DATE),
      sequenceInYear: ((PERIOD_MONTH - 4 + 12) % 12) + 1, taxYear: IN_TAX_YEAR,
      type: 'REGULAR', status: 'DRAFT', currencyCode: 'INR',
    },
  });
  const nzRun = await prisma.payRun.upsert({
    where: { businessId_code: { businessId, code: nzRunCode } },
    update: {},
    create: {
      businessId, entityId: nzEntity.id, payCalendarId: nzCalendar.id, code: nzRunCode,
      periodStart: d(NZ_PERIOD_START), periodEnd: d(NZ_PERIOD_END), payDate: d(NZ_PAY_DATE),
      sequenceInYear: (((PERIOD_MONTH - 4 + 12) % 12) + 1) * 2, taxYear: NZ_TAX_YEAR,
      type: 'REGULAR', status: 'DRAFT', currencyCode: 'NZD',
    },
  });
  console.log(`✓ Pay runs (DRAFT): ${inRun.code}, ${nzRun.code}`);

  // ═════════════════════════════════════════════════════════════════════════
  // 8. EMPLOYEES — 3 IN + 2 NZ. Each gets the full payroll-ready bundle.
  // ═════════════════════════════════════════════════════════════════════════
  // Per-employee specs. monthlyBasic/HRA/special must satisfy IN Basic >= 50%
  // of monthly gross (Basic / (Basic+HRA+Special)). With HRA = 50% of Basic and
  // Special small, Basic is comfortably > 50%.
  const inEmployees = [
    {
      seq: 1, code: 'EMP-IN-0001', first: 'Aarav', last: 'Sharma', gender: 'MALE', dob: '1990-05-12',
      email: 'aarav.sharma@demo.test', portal: true,
      basic: 60000, special: 18000, ctcAnnual: 1500000,
      pan: 'ABCPS1234A', uan: '100200300401', pfMemberId: 'KABLR00123450000001', esicIp: '3100123456',
      esiApplicable: false, payable: IN_CAL_DAYS, lop: 0,
    },
    {
      seq: 2, code: 'EMP-IN-0002', first: 'Priya', last: 'Nair', gender: 'FEMALE', dob: '1993-11-02',
      email: 'priya.nair@demo.test', portal: true,
      basic: 30000, special: 9000, ctcAnnual: 780000,
      pan: 'ABCPN5678B', uan: '100200300402', pfMemberId: 'KABLR00123450000002', esicIp: '3100123457',
      esiApplicable: true, payable: IN_CAL_DAYS - 2, lop: 2, // 2 LOP days this period
    },
    {
      seq: 3, code: 'EMP-IN-0003', first: 'Rohan', last: 'Verma', gender: 'MALE', dob: '1988-02-20',
      email: 'rohan.verma@demo.test', portal: false,
      basic: 45000, special: 13500, ctcAnnual: 1170000,
      pan: 'ABCPV9012C', uan: '100200300403', pfMemberId: 'KABLR00123450000003', esicIp: null,
      esiApplicable: false, payable: IN_CAL_DAYS, lop: 0,
    },
  ];
  const nzEmployees = [
    {
      seq: 1, code: 'EMP-NZ-0001', first: 'Olivia', last: 'Williams', gender: 'FEMALE', dob: '1991-07-08',
      email: 'olivia.williams@demo.test', portal: true,
      salaryFortnight: 3200, ctcAnnual: 83200,
      irdNumber: '012345678', taxCode: 'M', ksRate: '0.0300', esct: '0.1750', payable: NZ_CAL_DAYS, lop: 0,
    },
    {
      seq: 2, code: 'EMP-NZ-0002', first: 'Liam', last: 'Brown', gender: 'MALE', dob: '1986-03-15',
      email: 'liam.brown@demo.test', portal: false,
      salaryFortnight: 2800, ctcAnnual: 72800,
      irdNumber: '098765432', taxCode: 'M SL', ksRate: '0.0400', esct: '0.1750', studentLoan: true,
      payable: NZ_CAL_DAYS - 1, lop: 1,
    },
  ];

  let portalUserCount = 0;

  // Create a portal (ESS) User and return its id, or null. Also create the
  // matching Customer record — the ESS employee login authenticates against the
  // per-tenant Customer (email+password), and resolveSelfEmployee maps that email
  // back to the Employee. Without this, employees can't sign in to self-service.
  async function portalUser(emp) {
    if (!emp.portal) return null;
    const name = `${emp.first} ${emp.last}`;
    const u = await prisma.user.upsert({
      where: { email: emp.email },
      update: { businessId, role: 'USER' },
      create: {
        email: emp.email, password: DEMO_PASSWORD_HASH, name,
        role: 'USER', businessId, emailVerified: true, isActive: true,
      },
    });
    await prisma.customer.upsert({
      where: { businessId_email: { businessId, email: emp.email } },
      update: { password: DEMO_PASSWORD_HASH, emailVerified: true, isActive: true, anonymisedAt: null },
      create: { businessId, email: emp.email, password: DEMO_PASSWORD_HASH, name, emailVerified: true, isActive: true },
    });
    portalUserCount += 1;
    return u.id;
  }

  async function makeEmployee(entity, org, structure, spec, country) {
    const userId = await portalUser(spec);
    const employee = await prisma.employee.upsert({
      where: { businessId_code: { businessId, code: spec.code } },
      update: { userId },
      create: {
        businessId, code: spec.code, userId,
        firstName: spec.first, lastName: spec.last, gender: spec.gender,
        dateOfBirth: d(spec.dob), nationality: country === 'IN' ? 'Indian' : 'New Zealander',
        workEmail: spec.email, personalEmail: spec.email,
        countryCode: country, stateCode: entity.stateCode, city: entity.city,
        isActive: true, status: 'ACTIVE',
        hireDate: d('2022-04-01'), preferredLanguage: 'en',
      },
    });

    // EmploymentRecord (current, effective-dated). @@unique(employeeId, effectiveFrom).
    const empRec = await prisma.employmentRecord.upsert({
      where: { employeeId_effectiveFrom: { employeeId: employee.id, effectiveFrom: d('2022-04-01') } },
      update: { isCurrent: true },
      create: {
        businessId, employeeId: employee.id, entityId: entity.id,
        locationId: org.location.id, departmentId: org.department.id, designationId: org.designation.id,
        gradeId: org.grade.id, employmentType: 'FULL_TIME', workerCategory: 'STAFF',
        payCalendarId: country === 'IN' ? inCalendar.id : nzCalendar.id,
        fteRatio: '1.0000', effectiveFrom: d('2022-04-01'), changeReason: 'HIRE', isCurrent: true,
      },
    });
    await prisma.employee.update({ where: { id: employee.id }, data: { currentEmploymentRecordId: empRec.id } });

    // StatutoryProfile (1:1).
    const spData = country === 'IN'
      ? {
          countryCode: 'IN', pan: spec.pan, uan: spec.uan, pfMemberId: spec.pfMemberId,
          pfOptIn: false, pfJoinDate: d('2022-04-01'), esicIp: spec.esicIp, esiApplicable: spec.esiApplicable,
          ptStateCode: entity.stateCode, taxRegime: 'NEW', aadhaarVerified: true,
        }
      : {
          countryCode: 'NZ', irdNumber: spec.irdNumber, taxCode: spec.taxCode,
          kiwiSaverStatus: 'ACTIVE', kiwiSaverEmployeeRate: spec.ksRate, esctRate: spec.esct,
          studentLoan: !!spec.studentLoan,
        };
    await prisma.statutoryProfile.upsert({
      where: { employeeId: employee.id },
      update: spData,
      create: { businessId, employeeId: employee.id, ...spData },
    });

    // CompensationRevision (current) + its lines. @@unique(employeeId, effectiveFrom).
    const comp = await prisma.compensationRevision.upsert({
      where: { employeeId_effectiveFrom: { employeeId: employee.id, effectiveFrom: d('2022-04-01') } },
      update: { isCurrent: true, structureId: structure.id },
      create: {
        businessId, employeeId: employee.id, entityId: entity.id, structureId: structure.id,
        currencyCode: entity.payCurrency, basis: country === 'IN' ? 'CTC' : 'GROSS',
        ctcAnnual: spec.ctcAnnual != null ? String(spec.ctcAnnual) + '.00' : null,
        grossMonthly: country === 'IN'
          ? String(spec.basic + Math.round(spec.basic * 0.5) + spec.special) + '.00'
          : String(spec.salaryFortnight) + '.00',
        effectiveFrom: d('2022-04-01'), isCurrent: true, revisionReason: 'HIRE',
      },
    });
    await prisma.employee.update({ where: { id: employee.id }, data: { currentCompensationId: comp.id } });

    // Compensation lines (the real money the engine reads).
    if (country === 'IN') {
      const hra = Math.round(spec.basic * 0.5); // HRA = 50% of Basic (PERCENT_OF base=BASIC)
      await ensure('salaryComponentLine', det(`compline:${spec.code}:basic`), {
        businessId, compensationId: comp.id, componentId: cBasic.id,
        calcMethod: 'FLAT', amountMonthly: String(spec.basic) + '.00', amountAnnual: String(spec.basic * 12) + '.00', sortOrder: 1,
      });
      await ensure('salaryComponentLine', det(`compline:${spec.code}:hra`), {
        businessId, compensationId: comp.id, componentId: cHra.id,
        calcMethod: 'PERCENT_OF', calcValue: '50.0000', amountMonthly: String(hra) + '.00', sortOrder: 2,
      });
      await ensure('salaryComponentLine', det(`compline:${spec.code}:special`), {
        businessId, compensationId: comp.id, componentId: cSpecial.id,
        calcMethod: 'BALANCING', amountMonthly: String(spec.special) + '.00', sortOrder: 3,
      });
      await ensure('salaryComponentLine', det(`compline:${spec.code}:pfer`), {
        businessId, compensationId: comp.id, componentId: cPfEr.id, calcMethod: 'STATUTORY', sortOrder: 20,
      });
    } else {
      await ensure('salaryComponentLine', det(`compline:${spec.code}:salary`), {
        businessId, compensationId: comp.id, componentId: cNzSalary.id,
        calcMethod: 'FLAT', amountMonthly: String(spec.salaryFortnight) + '.00', sortOrder: 1,
      });
      await ensure('salaryComponentLine', det(`compline:${spec.code}:kser`), {
        businessId, compensationId: comp.id, componentId: cNzKsEr.id, calcMethod: 'STATUTORY', sortOrder: 20,
      });
    }

    // AttendancePayInput for the current pay run (frozen days; some LOP).
    const run = country === 'IN' ? inRun : nzRun;
    const calDays = country === 'IN' ? IN_CAL_DAYS : NZ_CAL_DAYS;
    const pStart = country === 'IN' ? IN_PERIOD_START : NZ_PERIOD_START;
    const pEnd = country === 'IN' ? IN_PERIOD_END : NZ_PERIOD_END;
    await prisma.attendancePayInput.upsert({
      where: { payRunId_employeeId: { payRunId: run.id, employeeId: employee.id } },
      update: { payableDays: String(spec.payable) + '.0000', lopDays: String(spec.lop) + '.0000' },
      create: {
        businessId, payRunId: run.id, employeeId: employee.id,
        periodStart: d(pStart), periodEnd: d(pEnd),
        calendarDays: String(calDays) + '.0000',
        payableDays: String(spec.payable) + '.0000',
        lopDays: String(spec.lop) + '.0000',
        paidLeaveDays: '0.0000', weeklyOffDays: '0.0000', holidayDays: '0.0000', overtimeHours: '0.00',
      },
    });

    // Bank account (salary credit target).
    await ensure('bankAccount', det(`bank:${spec.code}`), {
      businessId, employeeId: employee.id,
      accountName: `${spec.first} ${spec.last}`,
      accountNumber: country === 'IN' ? '5012345678' + spec.seq : '01-0123-0123456-0' + spec.seq,
      ifsc: country === 'IN' ? 'HDFC0001234' : null,
      nzBankAccount: country === 'NZ' ? '01-0123-0123456-00' : null,
      bankName: country === 'IN' ? 'HDFC Bank' : 'ANZ', currencyCode: entity.payCurrency, isPrimary: true,
    });

    // LeaveBalance per employee (current period).
    const balType = country === 'IN' ? ltEL : ltNZAnnual;
    const period = country === 'IN' ? IN_TAX_YEAR : NZ_TAX_YEAR;
    await prisma.leaveBalance.upsert({
      where: { businessId_employeeId_leaveTypeId_periodCode: { businessId, employeeId: employee.id, leaveTypeId: balType.id, periodCode: period } },
      update: {},
      create: {
        businessId, employeeId: employee.id, leaveTypeId: balType.id, periodCode: period,
        unit: country === 'IN' ? 'DAYS' : 'WEEKS',
        opening: country === 'IN' ? '6.0000' : '0.0000',
        accrued: country === 'IN' ? '9.0000' : '1.5000',
        taken: country === 'IN' ? '2.0000' : '0.0000',
        closing: country === 'IN' ? '13.0000' : '1.5000',
      },
    });

    return employee;
  }

  let inCount = 0, nzCount = 0;
  for (const spec of inEmployees) { await makeEmployee(inEntity, inOrg, inStructure, spec, 'IN'); inCount += 1; }
  for (const spec of nzEmployees) { await makeEmployee(nzEntity, nzOrg, nzStructure, spec, 'NZ'); nzCount += 1; }
  console.log(`✓ Employees: ${inCount} IN + ${nzCount} NZ (with employment, statutory, compensation, attendance, bank, leave balance)`);
  console.log(`✓ ESS portal logins created: ${portalUserCount}`);

  // ═════════════════════════════════════════════════════════════════════════
  // 9. ONBOARDING JOURNEY — offer-linked, provisionable end-to-end.
  // ═════════════════════════════════════════════════════════════════════════
  // The /onboarding board needs at least one journey whose `Provision employee`
  // task can actually SUCCEED. That requires an ACCEPTED Offer (provision.js
  // precondition ~L272 fails 422 'no linked offer' otherwise). The Offer chain
  // is Candidate → Job → Application → Offer, so we seed the whole pre-hire
  // funnel for one IN new hire, then a LifecycleJourney that points at it.
  //
  // selfServiceJson carries:
  //   - personal/statutory/bank → so provisioning has real data to promote.
  //   - designation → so the board card shows a ROLE instead of '—' (#13).
  //   - comp.basicMonthly → the explicit Basic/DA split so the India 50% wage
  //     rule resolves cleanly at provision time (Basic 50000 of gross 90000 = 56%).
  const onbJoinDate = ymd(PERIOD_YEAR, PERIOD_MONTH, Math.min(28, IN_CAL_DAYS));

  const candidate = await prisma.candidate.upsert({
    where: { businessId_email: { businessId, email: 'ishaan.gupta@candidates.test' } },
    update: {},
    create: {
      businessId, firstName: 'Ishaan', lastName: 'Gupta', email: 'ishaan.gupta@candidates.test',
      phone: '+91 98000 12345', source: 'referral',
    },
  });

  const job = await prisma.job.upsert({
    where: { businessId_code: { businessId, code: 'JOB-DEMO-0001' } },
    update: {},
    create: {
      businessId, entityId: inEntity.id, code: 'JOB-DEMO-0001', title: 'Software Engineer',
      departmentId: inOrg.department.id, designationId: inOrg.designation.id, locationId: inOrg.location.id,
      countryCode: 'IN', employmentType: 'FULL_TIME', openings: 1, status: 'OPEN',
      minSalary: '600000.00', maxSalary: '1500000.00', currencyCode: 'INR',
      publishedAt: new Date(),
    },
  });

  const application = await prisma.application.upsert({
    where: { businessId_jobId_candidateId: { businessId, jobId: job.id, candidateId: candidate.id } },
    update: { status: 'OFFERED' },
    create: {
      businessId, jobId: job.id, candidateId: candidate.id, status: 'OFFERED',
    },
  });

  // ACCEPTED Offer — the source of truth provision.js reads (gross/structure/
  // joining date). structureId points at the IN CTC structure so the wage-rule
  // can read Basic from its lines too. Offer has no natural @@unique, so key it
  // on a deterministic id for idempotency.
  const offer = await ensure('offer', det('offer:demo-onb-1'), {
    businessId, applicationId: application.id,
    ctcAnnual: '1500000.00', grossMonthly: '90000.00', currencyCode: 'INR',
    joiningDate: d(onbJoinDate), structureId: inStructure.id,
    status: 'ACCEPTED', sentAt: new Date(), respondedAt: new Date(),
  });

  // The journey. offerId is @unique, and code is @@unique([businessId, code]) —
  // upsert on the business+code natural key so re-seeding is stable.
  const onbSelfService = {
    personal: {
      firstName: 'Ishaan', lastName: 'Gupta', gender: 'MALE', dateOfBirth: '1996-09-14',
      personalEmail: 'ishaan.gupta@candidates.test', workEmail: 'ishaan.gupta@demo.test',
      phone: '+91 98000 12345', employmentType: 'FULL_TIME',
    },
    statutory: { countryCode: 'IN', pan: 'ABCPG7777D', taxRegime: 'NEW' },
    bank: { accountName: 'Ishaan Gupta', accountNumber: '50123456789', ifsc: 'HDFC0001234', bankName: 'HDFC Bank' },
    // Drives the board card "Role" (#13) and the provisioned designation.
    designation: 'Software Engineer',
    role: 'Software Engineer',
    // Explicit Basic/DA split → India 50% wage rule resolves at provision time.
    comp: { basicMonthly: '50000', daMonthly: '0' },
    completeness: { personal: true, statutory: true, bank: true },
  };
  const journey = await prisma.lifecycleJourney.upsert({
    where: { businessId_code: { businessId, code: 'ONB-DEMO-0001' } },
    update: { offerId: offer.id, selfServiceJson: onbSelfService, meta: { designation: 'Software Engineer' } },
    create: {
      businessId, entityId: inEntity.id, code: 'ONB-DEMO-0001',
      direction: 'ONBOARDING', offerId: offer.id,
      offerAcceptedAt: new Date(), joinDate: d(onbJoinDate),
      currentStage: 'PROVISIONING', status: 'IN_PROGRESS',
      selfServiceJson: onbSelfService,
      meta: { designation: 'Software Engineer' },
    },
  });

  // Tasks. A realistic mix so the board is meaningful AND the skip-with-reason
  // flow is reachable: most are mandatory+blocking, but ONE is optional
  // (isMandatory:false) so the Skip button renders (#12). The PROVISION_EMPLOYEE
  // task is the one whose action provisions the employee from the offer above.
  const onbTasks = [
    { key: 'task:onb:collect',   stageKey: 'SELF_ONBOARDING', taskKey: 'COLLECT_PERSONAL', title: 'Collect personal & statutory details', ownerRole: 'NEW_HIRE', isMandatory: true,  isBlocking: true,  status: 'DONE' },
    { key: 'task:onb:esign',     stageKey: 'DOCS_ESIGN',      taskKey: 'ESIGN_CONTRACT',   title: 'E-sign employment contract',          ownerRole: 'NEW_HIRE', isMandatory: true,  isBlocking: true,  status: 'DONE' },
    { key: 'task:onb:provision', stageKey: 'PROVISIONING',    taskKey: 'PROVISION_EMPLOYEE', title: 'Provision employee from accepted offer', ownerRole: 'HR',      isMandatory: true,  isBlocking: true,  status: 'PENDING' },
    { key: 'task:onb:asset',     stageKey: 'DAY_ONE',         taskKey: 'ASSIGN_ASSET',     title: 'Issue laptop & access card',          ownerRole: 'IT',       isMandatory: true,  isBlocking: true,  status: 'PENDING' },
    // OPTIONAL task → the Skip (with reason) control is exercisable (#12).
    { key: 'task:onb:welcome',   stageKey: 'DAY_ONE',         taskKey: 'CUSTOM',           title: 'Send welcome kit (optional)',         ownerRole: 'HR',       isMandatory: false, isBlocking: false, status: 'PENDING' },
  ];
  for (const t of onbTasks) {
    await ensure('lifecycleTask', det(t.key), {
      businessId, journeyId: journey.id,
      stageKey: t.stageKey, taskKey: t.taskKey, title: t.title, ownerRole: t.ownerRole,
      isMandatory: t.isMandatory, isBlocking: t.isBlocking, status: t.status,
      dueDate: d(onbJoinDate),
    });
  }
  console.log(`✓ Onboarding journey ${journey.code} (offer ${offer.status}) with ${onbTasks.length} tasks (1 optional, provisionable)`);

  // ═════════════════════════════════════════════════════════════════════════
  // Summary
  // ═════════════════════════════════════════════════════════════════════════
  const [empTotal, attTotal] = await Promise.all([
    prisma.employee.count({ where: { businessId } }),
    prisma.attendancePayInput.count({ where: { businessId } }),
  ]);
  console.log('────────────────────────────────────────────────────────');
  console.log('✅ DEMO tenant seeded.');
  console.log(`   Business slug ......... demo`);
  console.log(`   Entities .............. IN-HQ (INR/monthly), NZ-AKL (NZD/fortnightly)`);
  console.log(`   Employees ............. ${empTotal}`);
  console.log(`   AttendancePayInputs ... ${attTotal}`);
  console.log(`   Pay runs (DRAFT) ...... ${inRun.code}, ${nzRun.code}`);
  console.log('');
  console.log('   Run a pay run with payrollService.computeRun, e.g.:');
  console.log(`     computeRun({ businessId: '${businessId}', actorId: '${operator.id}', payRunId: '${inRun.id}' })`);
  console.log('   Logins (password: Demo@12345):');
  console.log('     superadmin@demo.test  operator@demo.test (Owner/maker)  finance@demo.test (Finance/checker)');
  console.log('     ESS: aarav.sharma@demo.test  priya.nair@demo.test  olivia.williams@demo.test');
  console.log('────────────────────────────────────────────────────────');
}

main()
  .catch((e) => {
    console.error('✖ Seed failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
