/* eslint-disable no-console */
// =============================================================================
// seedDemoData.js — RICH, idempotent, re-runnable demo-data seeder for DriftHR.
//
// Goal: make a demo tenant rich enough to exercise every module end-to-end:
//   Org (depts/designations/grades/locations/entity) · ~30 employees with a real
//   manager hierarchy (2-3 levels) · Compensation (CTC + current revision per
//   employee) · a month of Attendance for a sample · Leave types/balances + mixed
//   requests · at least one fully-PUBLISHED pay run (real payroll service, with a
//   safe direct-write fallback) · a Performance review cycle with goals + reviews ·
//   a couple of in-progress onboarding journeys + one separation + documents.
//
// DESIGN
//   * Idempotent: every row is keyed off a STABLE code/natural @@unique and
//     upserted (or find-or-create on a deterministic id). Re-running is a
//     no-op-then-pass — it never duplicates.
//   * Tenant-scoped: businessId on every write.
//   * Country-aware: --country IN  → INR / IN-HQ / IN statutory
//                    --country NZ  → NZD / NZ entity / NZ statutory
//   * Reuses REAL services where practical so data reconciles:
//       - payroll service (createRun → computeRun → approveRun → disburseRun)
//         to mint PUBLISHED payslips whose snapshotJson is engine-real.
//         Falls back to direct-write PUBLISHED Payslip rows (with a valid
//         snapshotJson) if the engine can't run in the seed context.
//       - seedOnboardingTemplates() for the lifecycle blueprint.
//       - deriveBreakup() (pure) available if needed to shape CTC splits.
//   * ADDS around the existing demo logins (operator@/aarav.sharma@/priya.nair@
//     etc.) — never clobbers them; the canonical demo employees are kept and the
//     hierarchy is layered on top.
//
// RUN
//   DATABASE_URL=... node backend/scripts/seedDemoData.js [--slug demo] [--country IN|NZ]
//
//   # develop/test against the hr_test schema:
//   DATABASE_URL="$(grep ^DATABASE_URL backend/.env | cut -d= -f2- | tr -d '\"')?schema=hr_test" \
//     node backend/scripts/seedDemoData.js --slug demo --country IN
//
// Decimal fields are passed as strings / plain ints (never floats from
// arithmetic) so Prisma's Decimal coercion is exact.
// =============================================================================

const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

// Real services we reuse (resolved relative to backend/src).
const SRC = path.resolve(__dirname, '..', 'src');
const payrollService = require(path.join(SRC, 'hr/payroll/service'));
const { seedOnboardingTemplates } = require(path.join(SRC, 'hr/lifecycle/templates/seed'));
let SYSTEM_ROLES = null;
try { ({ SYSTEM_ROLES } = require(path.join(SRC, 'core/lib/rbac'))); } catch { /* optional */ }

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { slug: 'demo', country: 'IN' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--slug') out.slug = argv[++i];
    else if (a === '--country') out.country = String(argv[++i] || '').toUpperCase();
    else if (a.startsWith('--slug=')) out.slug = a.slice(7);
    else if (a.startsWith('--country=')) out.country = a.slice(10).toUpperCase();
  }
  if (!['IN', 'NZ'].includes(out.country)) {
    throw new Error(`--country must be IN or NZ (got "${out.country}")`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const DEMO_PASSWORD = 'Demo@12345';
const DEMO_PASSWORD_HASH = bcrypt.hashSync(DEMO_PASSWORD, 10);

// Deterministic uuid for rows with no natural @@unique (component lines, goals…)
const NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
function det(seed) {
  const h = crypto.createHash('sha1').update(NS + seed).digest('hex');
  return (
    h.slice(0, 8) + '-' + h.slice(8, 12) + '-5' + h.slice(13, 16) + '-' +
    ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) + h.slice(18, 20) + '-' +
    h.slice(20, 32)
  );
}
function d(s) { return new Date(s + 'T00:00:00.000Z'); }
const ymd = (y, m, day) => `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const money = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);
const dec4 = (n) => (Math.round(Number(n) * 10000) / 10000).toFixed(4);

// Tally of what we created vs updated (for the summary).
const tally = {};
function bump(kind, mode) {
  tally[kind] = tally[kind] || { created: 0, updated: 0 };
  tally[kind][mode] += 1;
}

// find-or-create + repair on a deterministic id.
async function ensure(model, id, create, update) {
  const existing = await prisma[model].findUnique({ where: { id } }).catch(() => null);
  if (existing) {
    if (update && Object.keys(update).length) {
      await prisma[model].update({ where: { id }, data: update });
    }
    bump(model, 'updated');
    return existing;
  }
  const row = await prisma[model].create({ data: { id, ...create } });
  bump(model, 'created');
  return row;
}

// upsert on a natural where-key, tracking created/updated.
async function up(model, where, create, update = {}) {
  const existing = await prisma[model].findUnique({ where }).catch(() => null);
  const row = await prisma[model].upsert({ where, create: { ...create }, update });
  bump(model, existing ? 'updated' : 'created');
  return row;
}

// Period anchors (current month).
const NOW = new Date();
const PY = NOW.getUTCFullYear();
const PM = NOW.getUTCMonth() + 1;
const taxYearFor = (y, m, startMonth = 4) => {
  const sy = m >= startMonth ? y : y - 1;
  return `${sy}-${String((sy + 1) % 100).padStart(2, '0')}`;
};

// =============================================================================
// MAIN
// =============================================================================
async function main() {
  const args = parseArgs(process.argv);
  const COUNTRY = args.country;
  const SLUG = args.slug;
  const isIN = COUNTRY === 'IN';
  const CUR = isIN ? 'INR' : 'NZD';
  const TZ = isIN ? 'Asia/Kolkata' : 'Pacific/Auckland';
  const TAX_YEAR = taxYearFor(PY, PM, 4);

  console.log('────────────────────────────────────────────────────────');
  console.log(`▶ Seeding RICH demo data → slug="${SLUG}" country=${COUNTRY} (${CUR})`);
  console.log(`  period ${ymd(PY, PM, 1)} → ${ymd(PY, PM, lastDayOfMonth(PY, PM))}, taxYear ${TAX_YEAR}`);
  console.log('────────────────────────────────────────────────────────');

  // ═══════════════════════════════════════════════════════════════════════
  // 1. BUSINESS + SUBSCRIPTION + TENANT BRAND  (extend, never clobber)
  // ═══════════════════════════════════════════════════════════════════════
  const bizName = isIN ? 'Demo Corp' : 'Loominfo NZ';
  const business = await up('business',
    { slug: SLUG },
    {
      name: bizName, slug: SLUG,
      description: `Demo tenant for the HRMS — ${COUNTRY}.`,
      country: COUNTRY, region: COUNTRY, timezone: TZ,
      email: `admin@${SLUG}.test`, isActive: true,
    },
    // Don't downgrade an existing tenant's name/branding on re-run.
    {},
  );
  const businessId = business.id;
  console.log(`✓ Business "${business.name}" (${businessId})`);

  // Subscription needs a tier; reuse any HR tier, else mint one.
  let tier =
    (await prisma.pricingTier.findFirst({ where: { slug: 'growth' } })) ||
    (await prisma.pricingTier.findFirst({ where: { vertical: 'HR' }, orderBy: { sortOrder: 'asc' } })) ||
    (await prisma.pricingTier.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }));
  if (!tier) {
    tier = await prisma.pricingTier.upsert({
      where: { slug: 'growth' },
      update: {},
      create: { slug: 'growth', vertical: 'HR', name: 'Growth', sortOrder: 2, includedStaff: 50, isActive: true },
    });
  }
  const themeColors = JSON.stringify(isIN
    ? { primary: '#10b981', colorKey: 'emerald' }
    : { primary: '#6366f1', colorKey: 'indigo' });
  await up('subscription',
    { businessId },
    {
      businessId, tierId: tier.id, status: 'ACTIVE', seatsUsed: 30, billingCycle: 'MONTHLY',
      theme: 'hr', themeStyle: isIN ? 'emerald' : 'indigo', themeColors,
      gateway: 'RAZORPAY', activatedAt: new Date(),
    },
    { tierId: tier.id, status: 'ACTIVE' },
  );
  await up('tenantBrand',
    { businessId_code: { businessId, code: 'DEMO-DEFAULT' } },
    {
      businessId, code: 'DEMO-DEFAULT', name: business.name,
      primaryColor: isIN ? '#10b981' : '#6366f1',
      secondaryColor: isIN ? '#064e3b' : '#312e81',
      accentColor: isIN ? '#34d399' : '#818cf8',
      emailFromName: business.name, supportEmail: `support@${SLUG}.test`,
      isDefault: true, isActive: true,
    },
  );
  console.log('✓ Subscription + TenantBrand');

  // ═══════════════════════════════════════════════════════════════════════
  // 2. TENANT-ADMIN ROLE + SUPER-ADMIN + OPERATOR  (keep existing demo logins)
  // ═══════════════════════════════════════════════════════════════════════
  const ownerPerms = SYSTEM_ROLES ? SYSTEM_ROLES.Owner : ['*'];
  const adminRole = await up('businessRole',
    { businessId_name: { businessId, name: 'HR Administrator' } },
    { businessId, name: 'HR Administrator', isSystem: true, permissions: ownerPerms },
    { permissions: ownerPerms, isSystem: true },
  );
  // Manager role (TEAM scope) so the manager demo login sees only their reports.
  const managerRole = await up('businessRole',
    { businessId_name: { businessId, name: 'Manager' } },
    {
      businessId, name: 'Manager', isSystem: true,
      permissions: SYSTEM_ROLES && SYSTEM_ROLES.Manager ? SYSTEM_ROLES.Manager : ownerPerms,
      defaultScope: 'TEAM', compVisibility: 'RANGE_ONLY',
    },
    {},
  );

  const adminEmail = isIN ? 'operator@demo.test' : `operator@${SLUG}.test`;
  await up('user',
    { email: 'superadmin@demo.test' },
    {
      email: 'superadmin@demo.test', password: DEMO_PASSWORD_HASH, name: 'Platform Super Admin',
      role: 'SUPER_ADMIN', emailVerified: true, isActive: true,
    },
    { role: 'SUPER_ADMIN' },
  );
  const operator = await up('user',
    { email: adminEmail },
    {
      email: adminEmail, password: DEMO_PASSWORD_HASH, name: 'HR Operator',
      role: 'BUSINESS_ADMIN', businessId, businessRoleId: adminRole.id, emailVerified: true, isActive: true,
    },
    { role: 'BUSINESS_ADMIN', businessId, businessRoleId: adminRole.id },
  );
  // A SECOND admin user so the payroll maker≠checker (four-eyes) gate is
  // satisfiable with real users.
  const checkerEmail = isIN ? 'payroll.checker@demo.test' : `payroll.checker@${SLUG}.test`;
  const checker = await up('user',
    { email: checkerEmail },
    {
      email: checkerEmail, password: DEMO_PASSWORD_HASH, name: 'Payroll Checker',
      role: 'BUSINESS_ADMIN', businessId, businessRoleId: adminRole.id, emailVerified: true, isActive: true,
    },
    { role: 'BUSINESS_ADMIN', businessId, businessRoleId: adminRole.id },
  );
  console.log(`✓ Roles + admins (operator=${operator.email}, checker=${checker.email})`);

  // ═══════════════════════════════════════════════════════════════════════
  // 3. ENTITY + ORG SCAFFOLDING (country-specific)
  // ═══════════════════════════════════════════════════════════════════════
  const entityCode = isIN ? 'IN-HQ' : 'NZ-AKL';
  const entity = await up('entity',
    { businessId_code: { businessId, code: entityCode } },
    isIN ? {
      businessId, code: 'IN-HQ', legalName: `${bizName} Private Limited`, tradeName: bizName,
      countryCode: 'IN', payCurrency: 'INR', timezone: TZ, taxYearStartMonth: 4,
      addressLine1: '1 MG Road', city: 'Bengaluru', stateCode: 'KA', postalCode: '560001',
      pan: 'AAACD1234E', tan: 'BLRD12345F', gstin: '29AAACD1234E1Z5', cin: 'U72900KA2020PTC100001',
      status: 'ACTIVE', activeFrom: d('2020-04-01'),
    } : {
      businessId, code: 'NZ-AKL', legalName: `${bizName} Limited`, tradeName: bizName,
      countryCode: 'NZ', payCurrency: 'NZD', timezone: TZ, taxYearStartMonth: 4,
      addressLine1: '1 Queen Street', city: 'Auckland', stateCode: 'AUK', postalCode: '1010',
      nzbn: '9429000000001', irdEntityNumber: '012-345-678',
      status: 'ACTIVE', activeFrom: d('2021-04-01'),
    },
  );

  // Statutory registrations (best-effort).
  if (isIN) {
    await up('statutoryRegistration',
      { businessId_entityId_kind_stateCode: { businessId, entityId: entity.id, kind: 'EPF', stateCode: '' } },
      { businessId, entityId: entity.id, kind: 'EPF', number: 'KABLR0012345000', stateCode: '', effectiveFrom: d('2020-04-01') },
    ).catch(() => {});
    await up('statutoryRegistration',
      { businessId_entityId_kind_stateCode: { businessId, entityId: entity.id, kind: 'PT_STATE', stateCode: 'KA' } },
      { businessId, entityId: entity.id, kind: 'PT_STATE', number: 'PT-KA-0012345', stateCode: 'KA', effectiveFrom: d('2020-04-01') },
    ).catch(() => {});
  } else {
    await up('statutoryRegistration',
      { businessId_entityId_kind_stateCode: { businessId, entityId: entity.id, kind: 'IRD_PAYE', stateCode: '' } },
      { businessId, entityId: entity.id, kind: 'IRD_PAYE', number: '012-345-678', stateCode: '', effectiveFrom: d('2021-04-01') },
    ).catch(() => {});
  }

  const location = await up('location',
    { businessId_entityId_code: { businessId, entityId: entity.id, code: 'LOC-HQ' } },
    {
      businessId, entityId: entity.id, code: 'LOC-HQ',
      name: isIN ? 'Bengaluru HQ' : 'Auckland Office',
      city: entity.city, stateCode: entity.stateCode, postalCode: entity.postalCode,
      countryCode: COUNTRY, timezone: TZ, isPrimary: true, isActive: true,
    },
  );
  const location2 = await up('location',
    { businessId_entityId_code: { businessId, entityId: entity.id, code: 'LOC-2' } },
    {
      businessId, entityId: entity.id, code: 'LOC-2',
      name: isIN ? 'Pune Office' : 'Wellington Office',
      city: isIN ? 'Pune' : 'Wellington', stateCode: isIN ? 'MH' : 'WGN',
      postalCode: isIN ? '411001' : '6011', countryCode: COUNTRY, timezone: TZ, isActive: true,
    },
  );

  // Departments (6) — a small tree (Engineering parents Platform).
  const deptDefs = [
    { code: 'ENG', name: 'Engineering' },
    { code: 'PLAT', name: 'Platform', parent: 'ENG' },
    { code: 'SALES', name: 'Sales' },
    { code: 'PEOPLE', name: 'People & Culture' },
    { code: 'FIN', name: 'Finance' },
    { code: 'OPS', name: 'Operations' },
  ];
  const depts = {};
  for (const dd of deptDefs) {
    depts[dd.code] = await up('department',
      { businessId_code: { businessId, code: dd.code } },
      { businessId, code: dd.code, name: dd.name, costCenter: `CC-${dd.code}` },
      {},
    );
  }
  await prisma.department.update({ where: { id: depts.PLAT.id }, data: { parentId: depts.ENG.id } }).catch(() => {});

  // Bands → Grades → Designations.
  const bands = {};
  for (const b of [{ code: 'B-IC', name: 'Individual Contributor' }, { code: 'B-MGR', name: 'Management' }, { code: 'B-EXEC', name: 'Executive' }]) {
    bands[b.code] = await up('band', { businessId_code: { businessId, code: b.code } }, { businessId, code: b.code, name: b.name }, {});
  }
  const gradeDefs = [
    { code: 'L1', name: 'Level 1 — Associate', rank: 1, band: 'B-IC', min: isIN ? '400000' : '50000', max: isIN ? '900000' : '75000' },
    { code: 'L2', name: 'Level 2 — Engineer', rank: 2, band: 'B-IC', min: isIN ? '800000' : '70000', max: isIN ? '1600000' : '100000' },
    { code: 'L3', name: 'Level 3 — Senior', rank: 3, band: 'B-IC', min: isIN ? '1400000' : '95000', max: isIN ? '2600000' : '140000' },
    { code: 'L4', name: 'Level 4 — Lead/Manager', rank: 4, band: 'B-MGR', min: isIN ? '2200000' : '130000', max: isIN ? '4000000' : '190000' },
    { code: 'L5', name: 'Level 5 — Director', rank: 5, band: 'B-EXEC', min: isIN ? '3800000' : '180000', max: isIN ? '7000000' : '280000' },
  ];
  const grades = {};
  for (const g of gradeDefs) {
    grades[g.code] = await up('grade',
      { businessId_code: { businessId, code: g.code } },
      { businessId, code: g.code, name: g.name, rank: g.rank, bandId: bands[g.band].id, minSalary: g.min + '.00', maxSalary: g.max + '.00', currencyCode: CUR },
      {},
    );
  }
  const desigDefs = [
    { code: 'DSG-ASSOC', title: 'Associate', grade: 'L1' },
    { code: 'DSG-ENG', title: 'Software Engineer', grade: 'L2' },
    { code: 'DSG-SR-ENG', title: 'Senior Engineer', grade: 'L3' },
    { code: 'DSG-EM', title: 'Engineering Manager', grade: 'L4' },
    { code: 'DSG-SALES', title: 'Account Executive', grade: 'L2' },
    { code: 'DSG-SALES-MGR', title: 'Sales Manager', grade: 'L4' },
    { code: 'DSG-HRBP', title: 'HR Business Partner', grade: 'L3' },
    { code: 'DSG-PEOPLE-HEAD', title: 'Head of People', grade: 'L5' },
    { code: 'DSG-FIN', title: 'Finance Analyst', grade: 'L2' },
    { code: 'DSG-DIRECTOR', title: 'Director', grade: 'L5' },
  ];
  const desigs = {};
  for (const ds of desigDefs) {
    desigs[ds.code] = await up('designation',
      { businessId_code: { businessId, code: ds.code } },
      { businessId, code: ds.code, title: ds.title, gradeId: grades[ds.grade].id },
      {},
    );
  }
  console.log(`✓ Org: 1 entity, 2 locations, ${deptDefs.length} departments, ${gradeDefs.length} grades, ${desigDefs.length} designations`);

  // Pay calendar.
  const calCode = isIN ? 'IN-MONTHLY' : 'NZ-FORTNIGHTLY';
  const payCalendar = await up('payCalendar',
    { businessId_entityId_code: { businessId, entityId: entity.id, code: calCode } },
    isIN ? {
      businessId, entityId: entity.id, code: 'IN-MONTHLY', name: 'India Monthly',
      frequency: 'MONTHLY', payDayRule: 'LAST_WORKING_DAY', cutoffDayRule: 'FIXED_DOM', cutoffDayValue: 25,
      prorationMethod: 'CALENDAR_DAYS', isActive: true,
    } : {
      businessId, entityId: entity.id, code: 'NZ-FORTNIGHTLY', name: 'NZ Fortnightly',
      frequency: 'FORTNIGHTLY', payDayRule: 'N_DAYS_AFTER_PERIOD_END', payDayValue: 3,
      cutoffDayRule: 'N_DAYS_AFTER_PERIOD_END', cutoffDayValue: 0, prorationMethod: 'CALENDAR_DAYS', isActive: true,
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // 4. SALARY COMPONENTS + STRUCTURE (country-specific)
  // ═══════════════════════════════════════════════════════════════════════
  async function component(code, data) {
    return up('salaryComponent', { businessId_code: { businessId, code } }, { businessId, code, ...data }, {});
  }
  let cBasic; let cHra; let cSpecial; let cPfEr; let cNzSalary; let cNzKsEr; let structure;
  if (isIN) {
    cBasic = await component('BASIC', { name: 'Basic', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT', isWageForPF: true, isWageForESI: true, isWageForPT: true, isWageForGratuity: true, isTaxable: true, prorationMethod: 'CALENDAR_DAYS', sortOrder: 1 });
    cHra = await component('HRA', { name: 'House Rent Allowance', kind: 'HRA', category: 'EARNING', calcMethod: 'PERCENT_OF', calcValue: '50.0000', calcBaseCode: 'BASIC', calcBaseScope: 'SINGLE', isWageForESI: true, isWageForPT: true, isTaxable: true, taxSection: '10(13A)', prorationMethod: 'CALENDAR_DAYS', sortOrder: 2 });
    cSpecial = await component('SPECIAL', { name: 'Special Allowance', kind: 'SPECIAL_ALLOWANCE', category: 'EARNING', calcMethod: 'BALANCING', isWageForESI: true, isWageForPT: true, isTaxable: true, prorationMethod: 'CALENDAR_DAYS', sortOrder: 3 });
    cPfEr = await component('EPF_ER', { name: 'Provident Fund (Employer)', kind: 'PF_EMPLOYER', category: 'EMPLOYER_COST', calcMethod: 'STATUTORY', isTaxable: false, isRecurring: true, sortOrder: 20 });
    structure = await up('salaryStructure',
      { businessId_entityId_code: { businessId, entityId: entity.id, code: 'IN-STAFF-CTC' } },
      { businessId, entityId: entity.id, code: 'IN-STAFF-CTC', name: 'IN Staff CTC', countryCode: 'IN', currencyCode: 'INR', basis: 'CTC', isActive: true },
      {},
    );
    await ensure('salaryComponentLine', det(`${SLUG}:sline:in-basic`), { businessId, structureId: structure.id, componentId: cBasic.id, calcMethod: 'FLAT', amountMonthly: '50000.00', sortOrder: 1 }, {});
    await ensure('salaryComponentLine', det(`${SLUG}:sline:in-hra`), { businessId, structureId: structure.id, componentId: cHra.id, calcMethod: 'PERCENT_OF', calcValue: '50.0000', sortOrder: 2 }, {});
    await ensure('salaryComponentLine', det(`${SLUG}:sline:in-special`), { businessId, structureId: structure.id, componentId: cSpecial.id, calcMethod: 'BALANCING', amountMonthly: '20000.00', sortOrder: 3 }, {});
  } else {
    cNzSalary = await component('NZ_SALARY', { name: 'Salary', kind: 'BASIC', category: 'EARNING', calcMethod: 'FLAT', isKiwiSaverable: true, isPayeable: true, isTaxable: true, prorationMethod: 'CALENDAR_DAYS', sortOrder: 1 });
    cNzKsEr = await component('KIWISAVER_ER', { name: 'KiwiSaver (Employer)', kind: 'KIWISAVER_EMPLOYER', category: 'EMPLOYER_COST', calcMethod: 'STATUTORY', isTaxable: false, isRecurring: true, sortOrder: 20 });
    structure = await up('salaryStructure',
      { businessId_entityId_code: { businessId, entityId: entity.id, code: 'NZ-SALARIED' } },
      { businessId, entityId: entity.id, code: 'NZ-SALARIED', name: 'NZ Salaried Gross', countryCode: 'NZ', currencyCode: 'NZD', basis: 'GROSS', isActive: true },
      {},
    );
    await ensure('salaryComponentLine', det(`${SLUG}:sline:nz-salary`), { businessId, structureId: structure.id, componentId: cNzSalary.id, calcMethod: 'FLAT', amountMonthly: '3000.00', sortOrder: 1 }, {});
  }
  console.log('✓ Salary components + structure');

  // ═══════════════════════════════════════════════════════════════════════
  // 5. LEAVE TYPES + POLICIES
  // ═══════════════════════════════════════════════════════════════════════
  const leaveTypes = {};
  if (isIN) {
    leaveTypes.EL = await up('leaveType', { businessId_code: { businessId, code: 'EL' } }, { businessId, code: 'EL', name: 'Earned Leave', countryCode: 'IN', category: 'ANNUAL', unit: 'DAYS', isPaid: true, isStatutory: true, isEncashable: true, color: '#10b981' }, {});
    leaveTypes.SL = await up('leaveType', { businessId_code: { businessId, code: 'SL' } }, { businessId, code: 'SL', name: 'Sick Leave', countryCode: 'IN', category: 'SICK', unit: 'DAYS', isPaid: true, color: '#f59e0b' }, {});
    leaveTypes.CL = await up('leaveType', { businessId_code: { businessId, code: 'CL' } }, { businessId, code: 'CL', name: 'Casual Leave', countryCode: 'IN', category: 'CASUAL', unit: 'DAYS', isPaid: true, color: '#3b82f6' }, {});
    await up('leavePolicy', { businessId_code: { businessId, code: 'EL-STD' } }, { businessId, leaveTypeId: leaveTypes.EL.id, entityId: entity.id, code: 'EL-STD', name: 'Earned Leave (Standard)', accrualMethod: 'MONTHLY_ACCRUAL', entitlementPerYear: '18.0000', accrualFrequency: 'MONTHLY', carryForwardCap: '45.0000', maxBalanceCap: '60.0000', minNoticeDays: 3, isActive: true }, {});
    await up('leavePolicy', { businessId_code: { businessId, code: 'SL-STD' } }, { businessId, leaveTypeId: leaveTypes.SL.id, entityId: entity.id, code: 'SL-STD', name: 'Sick Leave (Standard)', accrualMethod: 'UPFRONT_ANNUAL', entitlementPerYear: '12.0000', accrualFrequency: 'ANNUAL', isActive: true }, {});
    await up('leavePolicy', { businessId_code: { businessId, code: 'CL-STD' } }, { businessId, leaveTypeId: leaveTypes.CL.id, entityId: entity.id, code: 'CL-STD', name: 'Casual Leave (Standard)', accrualMethod: 'UPFRONT_ANNUAL', entitlementPerYear: '12.0000', accrualFrequency: 'ANNUAL', isActive: true }, {});
  } else {
    leaveTypes.ANNUAL = await up('leaveType', { businessId_code: { businessId, code: 'ANNUAL' } }, { businessId, code: 'ANNUAL', name: 'Annual Holidays', countryCode: 'NZ', category: 'ANNUAL', unit: 'WEEKS', isPaid: true, isStatutory: true, nzPayBasis: 'AWE_8PCT', color: '#6366f1' }, {});
    leaveTypes.SICK = await up('leaveType', { businessId_code: { businessId, code: 'NZ-SICK' } }, { businessId, code: 'NZ-SICK', name: 'Sick Leave', countryCode: 'NZ', category: 'SICK', unit: 'DAYS', isPaid: true, color: '#f59e0b' }, {});
    await up('leavePolicy', { businessId_code: { businessId, code: 'NZ-ANNUAL' } }, { businessId, leaveTypeId: leaveTypes.ANNUAL.id, entityId: entity.id, code: 'NZ-ANNUAL', name: 'Annual Holidays (NZ)', accrualMethod: 'CONTINUOUS_NZ', entitlementPerYear: '4.0000', accrualFrequency: 'PER_PAY_PERIOD', minTenureMonths: 12, isActive: true }, {});
    await up('leavePolicy', { businessId_code: { businessId, code: 'NZ-SICK' } }, { businessId, leaveTypeId: leaveTypes.SICK.id, entityId: entity.id, code: 'NZ-SICK', name: 'Sick Leave (NZ)', accrualMethod: 'UPFRONT_ANNUAL', entitlementPerYear: '10.0000', accrualFrequency: 'ANNUAL', isActive: true }, {});
  }
  console.log(`✓ Leave types (${Object.keys(leaveTypes).join('/')}) + policies`);

  // ═══════════════════════════════════════════════════════════════════════
  // 6. PEOPLE — a real hierarchy (Director → Managers → ICs), ~30 employees.
  // ═══════════════════════════════════════════════════════════════════════
  const inFirst = ['Aarav', 'Priya', 'Rohan', 'Ananya', 'Vikram', 'Sneha', 'Arjun', 'Diya', 'Karan', 'Isha', 'Aditya', 'Meera', 'Rahul', 'Pooja', 'Sanjay', 'Nisha', 'Raj', 'Kavya', 'Manish', 'Tara', 'Dev', 'Riya', 'Gaurav', 'Sana', 'Amit', 'Neha', 'Varun', 'Lata', 'Suresh', 'Anita'];
  const inLast = ['Sharma', 'Nair', 'Verma', 'Iyer', 'Singh', 'Gupta', 'Mehta', 'Patel', 'Reddy', 'Bose', 'Kapoor', 'Joshi', 'Rao', 'Das', 'Khanna', 'Menon', 'Chopra', 'Pillai', 'Bhat', 'Sinha', 'Malhotra', 'Shetty', 'Agarwal', 'Kaur', 'Naidu', 'Banerjee', 'Saxena', 'Dubey', 'Pandey', 'Yadav'];
  const nzFirst = ['Olivia', 'Liam', 'Charlotte', 'Noah', 'Amelia', 'Jack', 'Isla', 'Oliver', 'Mia', 'James', 'Ella', 'William', 'Sophie', 'Lucas', 'Ruby', 'Mason', 'Grace', 'Leo', 'Maia', 'Henry', 'Aroha', 'George', 'Lily', 'Cooper', 'Zoe', 'Hunter', 'Ava', 'Finn', 'Harper', 'Tane'];
  const nzLast = ['Williams', 'Brown', 'Smith', 'Wilson', 'Taylor', 'Thompson', 'White', 'Walker', 'Harris', 'Martin', 'Clark', 'Anderson', 'Ngata', 'Wright', 'King', 'Scott', 'Green', 'Baker', 'Adams', 'Hall', 'Te Rangi', 'Young', 'Allen', 'Mitchell', 'Carter', 'Roberts', 'Phillips', 'Evans', 'Cooper', 'Reweti'];
  const first = isIN ? inFirst : nzFirst;
  const last = isIN ? inLast : nzLast;

  // Roster: index 0 is the Director (top). managerIdx points at the reporting
  // manager's roster index → 2-3 levels deep.
  const roster = [];
  function emp(o) { roster.push(o); return roster.length - 1; }

  const iDir = emp({ dept: 'OPS', desig: 'DSG-DIRECTOR', grade: 'L5', ctc: isIN ? 5200000 : 220000, manager: null, gender: 'MALE', portal: false });
  const iEM = emp({ dept: 'ENG', desig: 'DSG-EM', grade: 'L4', ctc: isIN ? 3400000 : 170000, manager: iDir, gender: 'MALE', portal: true, demoManager: true }); // Aarav — manager demo login
  const iSalesMgr = emp({ dept: 'SALES', desig: 'DSG-SALES-MGR', grade: 'L4', ctc: isIN ? 3000000 : 160000, manager: iDir, gender: 'FEMALE', portal: false });
  const iPeopleHead = emp({ dept: 'PEOPLE', desig: 'DSG-PEOPLE-HEAD', grade: 'L5', ctc: isIN ? 4200000 : 190000, manager: iDir, gender: 'FEMALE', portal: false });
  const iSr1 = emp({ dept: 'PLAT', desig: 'DSG-SR-ENG', grade: 'L3', ctc: isIN ? 2200000 : 130000, manager: iEM, gender: 'FEMALE', portal: true }); // Priya
  const iSr2 = emp({ dept: 'ENG', desig: 'DSG-SR-ENG', grade: 'L3', ctc: isIN ? 2000000 : 125000, manager: iEM, gender: 'MALE', portal: false });
  const iHrbp = emp({ dept: 'PEOPLE', desig: 'DSG-HRBP', grade: 'L3', ctc: isIN ? 1800000 : 115000, manager: iPeopleHead, gender: 'FEMALE', portal: false });
  const iFin = emp({ dept: 'FIN', desig: 'DSG-FIN', grade: 'L2', ctc: isIN ? 1200000 : 95000, manager: iDir, gender: 'MALE', portal: false });

  const icManagers = [iEM, iSr1, iSr2, iSalesMgr, iHrbp];
  for (let i = roster.length; i < 30; i += 1) {
    const mgr = icManagers[i % icManagers.length];
    const m = roster[mgr];
    let desig = 'DSG-ENG'; let grade = 'L2'; let dept = m.dept;
    if (mgr === iSalesMgr) { desig = 'DSG-SALES'; grade = 'L2'; dept = 'SALES'; }
    else if (mgr === iHrbp) { desig = 'DSG-HRBP'; grade = 'L3'; dept = 'PEOPLE'; }
    else if (i % 3 === 0) { desig = 'DSG-ASSOC'; grade = 'L1'; }
    emp({ dept, desig, grade, ctc: isIN ? (700000 + (i % 6) * 150000) : (60000 + (i % 6) * 8000), manager: mgr, gender: i % 2 === 0 ? 'MALE' : 'FEMALE', portal: i < 12 });
  }

  // Demo emails for the first few IN employees match the historical demo logins
  // (aarav.sharma@/priya.nair@). For ANY OTHER tenant (incl. the NZ loominfo
  // tenant) emails are tenant-scoped so a portal User is never shared across
  // tenants — Employee.userId is @unique, so a shared User would brick the seed.
  const knownEmails = (isIN && SLUG === 'demo')
    ? { 0: 'platform.director@demo.test', 1: 'aarav.sharma@demo.test', 4: 'priya.nair@demo.test' }
    : {};

  const employees = []; // parallel to roster
  let portalUserCount = 0;
  const empPrefix = isIN ? 'EMP-IN' : 'EMP-NZ';
  const joinBase = 2020;

  // Pass 1: create employees (+ portal users for the demo-visible ones).
  for (let i = 0; i < roster.length; i += 1) {
    const r = roster[i];
    const fn = first[i % first.length];
    const ln = last[i % last.length];
    const code = `${empPrefix}-${String(i + 1).padStart(4, '0')}`;
    const email = knownEmails[i] || (`${fn}.${ln}.${i + 1}`.toLowerCase().replace(/[^a-z0-9.]/g, '') + `@${SLUG}.test`);
    const joinYear = joinBase + (i % 5);
    const hireDate = ymd(joinYear, ((i % 11) + 1), ((i % 27) + 1));

    let userId = null;
    if (r.portal) {
      const name = `${fn} ${ln}`;
      const u = await up('user', { email },
        { email, password: DEMO_PASSWORD_HASH, name, role: 'USER', businessId, businessRoleId: r.demoManager ? managerRole.id : undefined, emailVerified: true, isActive: true },
        { businessId, role: 'USER', businessRoleId: r.demoManager ? managerRole.id : undefined },
      );
      await up('customer', { businessId_email: { businessId, email } },
        { businessId, email, password: DEMO_PASSWORD_HASH, name, emailVerified: true, isActive: true },
        { password: DEMO_PASSWORD_HASH, emailVerified: true, isActive: true, anonymisedAt: null },
      );
      // Employee.userId is @unique. Only link this User if it's free or already
      // bound to THIS tenant's employee with the same code — never steal a User
      // that another employee (e.g. a different tenant's demo login) owns.
      const claimed = await prisma.employee.findFirst({ where: { userId: u.id }, select: { code: true } }).catch(() => null);
      userId = (!claimed || claimed.code === code) ? u.id : null;
      portalUserCount += 1;
    }

    const employee = await up('employee', { businessId_code: { businessId, code } },
      {
        businessId, code, userId, firstName: fn, lastName: ln, gender: r.gender,
        dateOfBirth: d(ymd(1985 + (i % 12), ((i % 12) + 1), ((i % 26) + 1))),
        nationality: isIN ? 'Indian' : 'New Zealander',
        workEmail: email, personalEmail: email, countryCode: COUNTRY,
        stateCode: entity.stateCode, city: entity.city,
        isActive: true, status: 'ACTIVE', hireDate: d(hireDate), preferredLanguage: 'en',
      },
      // Only (re)link a non-null userId — never null out an already-good link.
      userId ? { userId } : {},
    );
    employees[i] = { ...employee, _r: r, _hireDate: hireDate, _email: email, _ctc: r.ctc };
  }

  // Pass 2: managers + employment record + statutory + comp + bank + leave bal.
  for (let i = 0; i < roster.length; i += 1) {
    const r = roster[i];
    const e = employees[i];
    const mgrEmp = r.manager != null ? employees[r.manager] : null;
    if (mgrEmp) {
      await prisma.employee.update({ where: { id: e.id }, data: { managerEmployeeId: mgrEmp.id } }).catch(() => {});
    }

    const empRec = await up('employmentRecord',
      { employeeId_effectiveFrom: { employeeId: e.id, effectiveFrom: d(e._hireDate) } },
      {
        businessId, employeeId: e.id, entityId: entity.id,
        locationId: (i % 4 === 0 ? location2 : location).id,
        departmentId: depts[r.dept].id, designationId: desigs[r.desig].id, gradeId: grades[r.grade].id,
        employmentType: 'FULL_TIME', workerCategory: 'STAFF', payCalendarId: payCalendar.id,
        fteRatio: '1.0000', effectiveFrom: d(e._hireDate), changeReason: 'HIRE', isCurrent: true,
      },
      { isCurrent: true },
    );
    await prisma.employee.update({ where: { id: e.id }, data: { currentEmploymentRecordId: empRec.id } }).catch(() => {});

    const spData = isIN
      ? { countryCode: 'IN', pan: `ABCP${String(1000 + i).slice(-4)}A`, uan: `1002003${String(10000 + i).slice(-5)}`, pfMemberId: `KABLR0012345${String(100000 + i).slice(-7)}`, pfOptIn: false, pfJoinDate: d(e._hireDate), esicIp: i % 4 === 0 ? `31001234${String(50 + i).slice(-2)}` : null, esiApplicable: false, ptStateCode: entity.stateCode, taxRegime: 'NEW', aadhaarVerified: true }
      : { countryCode: 'NZ', irdNumber: `0${String(12345670 + i).slice(-8)}`, taxCode: i % 5 === 0 ? 'M SL' : 'M', kiwiSaverStatus: 'ACTIVE', kiwiSaverEmployeeRate: '0.0300', esctRate: '0.1750', studentLoan: i % 5 === 0 };
    await up('statutoryProfile', { employeeId: e.id }, { businessId, employeeId: e.id, ...spData }, spData);

    // Compensation revision + lines (the real money the engine reads).
    const ctc = e._ctc;
    let basic; let special; let grossMonthly;
    if (isIN) {
      const grossAnnual = Math.round(ctc / 1.12); // CTC minus ~12% employer overhead
      grossMonthly = Math.round(grossAnnual / 12);
      basic = Math.round(grossMonthly * 0.5); // Basic = 50% of gross (Code on Wages floor)
      const hra = Math.round(basic * 0.5);
      special = grossMonthly - basic - hra; // balancing residual
    } else {
      grossMonthly = Math.round(ctc / 12);
    }
    const comp = await up('compensationRevision',
      { employeeId_effectiveFrom: { employeeId: e.id, effectiveFrom: d(e._hireDate) } },
      {
        businessId, employeeId: e.id, entityId: entity.id, structureId: structure.id,
        currencyCode: CUR, basis: isIN ? 'CTC' : 'GROSS',
        ctcAnnual: isIN ? money(ctc) : money(grossMonthly * 12),
        grossMonthly: money(grossMonthly),
        effectiveFrom: d(e._hireDate), isCurrent: true, revisionReason: 'HIRE', status: 'EFFECTIVE',
      },
      { isCurrent: true, structureId: structure.id, status: 'EFFECTIVE' },
    );
    await prisma.employee.update({ where: { id: e.id }, data: { currentCompensationId: comp.id } }).catch(() => {});
    employees[i].currentCompensationId = comp.id;

    if (isIN) {
      const hra = Math.round(basic * 0.5);
      await ensure('salaryComponentLine', det(`${SLUG}:cl:${e.code}:basic`), { businessId, compensationId: comp.id, componentId: cBasic.id, calcMethod: 'FLAT', amountMonthly: money(basic), amountAnnual: money(basic * 12), sortOrder: 1 }, {});
      await ensure('salaryComponentLine', det(`${SLUG}:cl:${e.code}:hra`), { businessId, compensationId: comp.id, componentId: cHra.id, calcMethod: 'PERCENT_OF', calcValue: '50.0000', amountMonthly: money(hra), sortOrder: 2 }, {});
      await ensure('salaryComponentLine', det(`${SLUG}:cl:${e.code}:special`), { businessId, compensationId: comp.id, componentId: cSpecial.id, calcMethod: 'BALANCING', amountMonthly: money(special), sortOrder: 3 }, {});
      await ensure('salaryComponentLine', det(`${SLUG}:cl:${e.code}:pfer`), { businessId, compensationId: comp.id, componentId: cPfEr.id, calcMethod: 'STATUTORY', sortOrder: 20 }, {});
    } else {
      await ensure('salaryComponentLine', det(`${SLUG}:cl:${e.code}:salary`), { businessId, compensationId: comp.id, componentId: cNzSalary.id, calcMethod: 'FLAT', amountMonthly: money(grossMonthly), sortOrder: 1 }, {});
      await ensure('salaryComponentLine', det(`${SLUG}:cl:${e.code}:kser`), { businessId, compensationId: comp.id, componentId: cNzKsEr.id, calcMethod: 'STATUTORY', sortOrder: 20 }, {});
    }

    await ensure('bankAccount', det(`${SLUG}:bank:${e.code}`), {
      businessId, employeeId: e.id, accountName: `${e.firstName} ${e.lastName}`,
      accountNumber: isIN ? `5012345${String(1000 + i)}` : `01-0123-012345${String(i % 10)}-0${i % 9}`,
      ifsc: isIN ? 'HDFC0001234' : null, nzBankAccount: isIN ? null : `01-0123-012345${String(i % 10)}-00`,
      bankName: isIN ? 'HDFC Bank' : 'ANZ', currencyCode: CUR, isPrimary: true,
    }, {});

    const balTypes = isIN ? [leaveTypes.EL, leaveTypes.SL, leaveTypes.CL] : [leaveTypes.ANNUAL, leaveTypes.SICK];
    for (const lt of balTypes) {
      const isWeeks = lt.unit === 'WEEKS';
      await up('leaveBalance',
        { businessId_employeeId_leaveTypeId_periodCode: { businessId, employeeId: e.id, leaveTypeId: lt.id, periodCode: TAX_YEAR } },
        {
          businessId, employeeId: e.id, leaveTypeId: lt.id, periodCode: TAX_YEAR, unit: lt.unit,
          opening: isWeeks ? '0.0000' : dec4(2 + (i % 4)),
          accrued: isWeeks ? '1.5000' : dec4(6 + (i % 6)),
          taken: isWeeks ? '0.0000' : dec4(i % 3),
          closing: isWeeks ? '1.5000' : dec4(8 + (i % 7) - (i % 3)),
        },
        {},
      );
    }
  }
  console.log(`✓ People: ${roster.length} employees with manager hierarchy (3 levels), comp, statutory, bank, leave balances`);
  console.log(`✓ ESS portal logins: ${portalUserCount}`);

  // ═══════════════════════════════════════════════════════════════════════
  // 7. ATTENDANCE — a month of daily rollups + punches for a sample (12 emp).
  // ═══════════════════════════════════════════════════════════════════════
  const attDays = lastDayOfMonth(PY, PM);
  const sample = employees.slice(0, 12);
  let attCount = 0; let punchCount = 0;
  for (const e of sample) {
    for (let day = 1; day <= attDays; day += 1) {
      const date = new Date(Date.UTC(PY, PM - 1, day));
      const dow = date.getUTCDay();
      let status = 'PRESENT';
      if (dow === 0 || dow === 6) status = 'WEEKLY_OFF';
      else if (day % 17 === 0) status = 'ON_LEAVE';
      else if (day % 23 === 0) status = 'WORK_FROM_HOME';
      const working = status === 'PRESENT' || status === 'WORK_FROM_HOME';
      // Attendance has a natural @@unique([businessId, employeeId, date]) — upsert
      // on it (not a det-id) so we never collide with pre-existing rows.
      await up('attendance',
        { businessId_employeeId_date: { businessId, employeeId: e.id, date } },
        {
          businessId, employeeId: e.id, date, status,
          workedMinutes: working ? 510 : 0,
          firstIn: working ? new Date(Date.UTC(PY, PM - 1, day, 3, 30)) : null,
          lastOut: working ? new Date(Date.UTC(PY, PM - 1, day, 12, 30)) : null,
          lopFraction: '0.0000',
        },
        { status },
      );
      attCount += 1;
      if (status === 'PRESENT') {
        await ensure('attendancePunch', det(`${SLUG}:punch:${e.code}:${ymd(PY, PM, day)}:in`), { businessId, employeeId: e.id, punchType: 'IN', punchAt: new Date(Date.UTC(PY, PM - 1, day, 3, 30)), source: 'WEB' }, {});
        await ensure('attendancePunch', det(`${SLUG}:punch:${e.code}:${ymd(PY, PM, day)}:out`), { businessId, employeeId: e.id, punchType: 'OUT', punchAt: new Date(Date.UTC(PY, PM - 1, day, 12, 30)), source: 'WEB' }, {});
        punchCount += 2;
      }
    }
  }
  console.log(`✓ Attendance: ${attCount} daily rollups + ${punchCount} punches across ${sample.length} employees`);

  // ═══════════════════════════════════════════════════════════════════════
  // 8. LEAVE REQUESTS — mixed states (pending/approved/rejected).
  // ═══════════════════════════════════════════════════════════════════════
  const primaryLeave = isIN ? leaveTypes.EL : leaveTypes.ANNUAL;
  const reqStates = ['PENDING', 'APPROVED', 'REJECTED', 'PENDING', 'APPROVED'];
  let leaveReqCount = 0;
  for (let k = 0; k < reqStates.length; k += 1) {
    const e = employees[5 + k];
    if (!e) continue;
    const st = reqStates[k];
    const startDay = 5 + k * 2;
    const decided = st !== 'PENDING';
    await ensure('leaveTransaction', det(`${SLUG}:leavereq:${e.code}:${k}`), {
      businessId, employeeId: e.id, leaveTypeId: primaryLeave.id, txnType: 'APPLICATION',
      unit: primaryLeave.unit, quantity: isIN ? '-2.0000' : '-0.4000',
      startDate: d(ymd(PY, PM, startDay)), endDate: d(ymd(PY, PM, startDay + 1)),
      reason: ['Family function', 'Medical', 'Personal', 'Travel', 'Vacation'][k],
      status: st, appliedAt: new Date(),
      decidedAt: decided ? new Date() : null,
      decidedBy: decided ? operator.id : null,
    }, { status: st });
    leaveReqCount += 1;
  }
  console.log(`✓ Leave requests: ${leaveReqCount} (mixed PENDING/APPROVED/REJECTED)`);

  // ═══════════════════════════════════════════════════════════════════════
  // 9. PAYROLL — one fully PUBLISHED pay run. Try the REAL service first,
  //    fall back to direct-write PUBLISHED Payslip rows with a valid snapshot.
  // ═══════════════════════════════════════════════════════════════════════
  const runMonthDate = new Date(Date.UTC(PY, PM - 2, 1)); // prior full month
  const RY = runMonthDate.getUTCFullYear();
  const RM = runMonthDate.getUTCMonth() + 1;
  const periodStart = ymd(RY, RM, 1);
  const periodEnd = isIN ? ymd(RY, RM, lastDayOfMonth(RY, RM)) : ymd(RY, RM, 14);
  const calDays = isIN ? lastDayOfMonth(RY, RM) : 14;
  const payDate = isIN ? periodEnd : ymd(RY, RM, 17);
  const runTaxYear = taxYearFor(RY, RM, 4);
  const runCode = `PR-${periodStart.slice(0, 7)}-${COUNTRY}`;

  // Four-eyes is PRESERVED on the demo tenant: we approve the seeded run as a
  // distinct `checker` user (maker=operator ≠ checker), so the demo keeps a real
  // maker-checker gate for testing. We deliberately do NOT set
  // allowSingleOperator — that would silently disable maker-checker for the tenant.
  const payEmployees = employees;
  let publishedPayslips = 0;
  let payrollMode = 'real-service';
  let payRun = null;

  try {
    payRun = await payrollService.createRun({
      businessId, actorId: operator.id, entityId: entity.id, payCalendarId: payCalendar.id,
      periodStart, periodEnd,
    });
    for (const e of payEmployees) {
      await up('attendancePayInput',
        { payRunId_employeeId: { payRunId: payRun.id, employeeId: e.id } },
        {
          businessId, payRunId: payRun.id, employeeId: e.id,
          periodStart: d(periodStart), periodEnd: d(periodEnd),
          calendarDays: dec4(calDays), payableDays: dec4(calDays),
          lopDays: '0.0000', paidLeaveDays: '0.0000', weeklyOffDays: '0.0000', holidayDays: '0.0000', overtimeHours: '0.00',
        },
        {},
      );
    }
    if (payRun.status === 'DRAFT' || payRun.status === 'INPUTS_LOCKED') {
      await payrollService.computeRun({ businessId, actorId: operator.id, payRunId: payRun.id, freezeAttendance: false });
    }
    let cur = await prisma.payRun.findUnique({ where: { id: payRun.id } });
    if (cur.status === 'COMPUTED' || cur.status === 'REVIEW') {
      // Approve as the CHECKER (≠ operator/maker) so the real maker-checker SoD
      // gate is satisfied legitimately and stays ENABLED for the tenant.
      await payrollService.approveRun({ businessId, actorId: checker.id, payRunId: payRun.id });
    }
    cur = await prisma.payRun.findUnique({ where: { id: payRun.id } });
    if (cur.status === 'APPROVED') {
      await payrollService.disburseRun({ businessId, actorId: operator.id, payRunId: payRun.id });
    }
    publishedPayslips = await prisma.payslip.count({ where: { businessId, payRunId: payRun.id, status: { in: ['PUBLISHED', 'VIEWED'] } } });
    if (publishedPayslips === 0) throw new Error('real service produced 0 published payslips');
    console.log(`✓ Payroll (REAL service): run ${runCode} → PAID, ${publishedPayslips} payslips PUBLISHED`);
  } catch (err) {
    // Fallback: direct-write a PAID PayRun + PUBLISHED Payslip rows.
    payrollMode = 'direct-write-fallback';
    console.log(`⚠ Real payroll service failed (${String(err.message).slice(0, 140)}). Falling back to direct payslip writes.`);
    publishedPayslips = 0;
    payRun = await up('payRun', { businessId_code: { businessId, code: runCode } },
      {
        businessId, entityId: entity.id, payCalendarId: payCalendar.id, code: runCode,
        periodStart: d(periodStart), periodEnd: d(periodEnd), payDate: d(payDate),
        sequenceInYear: ((RM - 4 + 12) % 12) + 1, taxYear: runTaxYear,
        type: 'REGULAR', status: 'PAID', currencyCode: CUR,
      },
      { status: 'PAID' },
    );
    for (const e of payEmployees) {
      const lines = await prisma.salaryComponentLine.findMany({
        where: { compensationId: e.currentCompensationId || undefined, businessId },
        include: { component: true },
      });
      let basic = 0; let hra = 0; let special = 0; let salary = 0;
      for (const l of lines) {
        const amt = Number(l.amountMonthly || 0);
        const code = l.component ? l.component.code : '';
        if (code === 'BASIC') basic = amt;
        else if (code === 'HRA') hra = amt;
        else if (code === 'SPECIAL') special = amt;
        else if (code === 'NZ_SALARY') salary = amt;
      }
      let earnings; let gross;
      if (isIN) {
        earnings = [
          { code: 'BASIC', label: 'Basic', amount: money(basic) },
          { code: 'HRA', label: 'House Rent Allowance', amount: money(hra) },
          { code: 'SPECIAL', label: 'Special Allowance', amount: money(special) },
        ];
        gross = basic + hra + special;
      } else {
        earnings = [{ code: 'NZ_SALARY', label: 'Salary', amount: money(salary) }];
        gross = salary;
      }
      let empDeductions; let erContrib; let totalDed;
      if (isIN) {
        const pfEe = Math.min(Math.round(basic * 0.12), 1800);
        const pt = 200;
        empDeductions = [
          { code: 'PF_EMPLOYEE', label: 'Provident Fund', amount: money(pfEe), statutory: true },
          { code: 'PT', label: 'Professional Tax', amount: money(pt), statutory: true },
        ];
        erContrib = [{ code: 'EPF_ER', label: 'Employer PF', amount: money(pfEe) }];
        totalDed = pfEe + pt;
      } else {
        const paye = Math.round(gross * 0.18);
        const ksEe = Math.round(gross * 0.03);
        empDeductions = [
          { code: 'PAYE', label: 'PAYE', amount: money(paye), statutory: true },
          { code: 'KIWISAVER_EMPLOYEE', label: 'KiwiSaver (Employee)', amount: money(ksEe), statutory: true },
        ];
        erContrib = [{ code: 'KIWISAVER_ER', label: 'KiwiSaver (Employer)', amount: money(ksEe) }];
        totalDed = paye + ksEe;
      }
      const net = gross - totalDed;
      const erCost = erContrib.reduce((s, x) => s + Number(x.amount), 0);
      const snapshotJson = {
        currencyCode: CUR, periodStart, periodEnd, payDate,
        earnings, employeeDeductions: empDeductions, employerContributions: erContrib, reimbursements: [],
        gross: money(gross), totalDeductions: money(totalDed),
        totalEmployerCost: money(erCost), net: money(net), anomalies: [],
      };
      const line = await ensure('payRunLine', det(`${SLUG}:prl:${runCode}:${e.code}`), {
        businessId, payRunId: payRun.id, employeeId: e.id, compensationId: e.currentCompensationId,
        payableDays: dec4(calDays), lopDays: '0.0000', overtimeHours: '0.00',
        grossEarnings: money(gross), totalDeductions: money(totalDed), netPay: money(net),
        employerCost: money(erCost), currencyCode: CUR, status: 'COMPUTED',
      }, {});
      await up('payslip',
        { businessId_payRunId_employeeId: { businessId, payRunId: payRun.id, employeeId: e.id } },
        {
          businessId, payRunId: payRun.id, payRunLineId: line.id, employeeId: e.id,
          code: `PS-${periodStart.slice(0, 7)}-${e.code}`,
          periodStart: d(periodStart), periodEnd: d(periodEnd), payDate: d(payDate), currencyCode: CUR,
          grossEarnings: money(gross), totalDeductions: money(totalDed), netPay: money(net),
          snapshotJson, status: 'PUBLISHED', publishedAt: new Date(),
        },
        { status: 'PUBLISHED', publishedAt: new Date(), snapshotJson },
      );
      publishedPayslips += 1;
    }
    console.log(`✓ Payroll (FALLBACK direct-write): run ${runCode} → PAID, ${publishedPayslips} payslips PUBLISHED`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 10. PERFORMANCE — active review cycle + goals/OKRs + reviews.
  // ═══════════════════════════════════════════════════════════════════════
  const cycleCode = `RC-${TAX_YEAR}`;
  const cycle = await up('reviewCycle', { businessId_code: { businessId, code: cycleCode } },
    {
      businessId, entityId: entity.id, code: cycleCode, name: `Annual Review ${TAX_YEAR}`,
      type: 'ANNUAL', periodStart: d(ymd(PY, 4, 1)), periodEnd: d(ymd(PY + 1, 3, 31)),
      status: 'MANAGER_REVIEW',
      ratingScaleJson: { min: 1, max: 5, labels: { 1: 'Needs Improvement', 3: 'Meets', 5: 'Exceptional' } },
      goalWeightPct: '60.00', competencyWeightPct: '40.00',
    },
    { status: 'MANAGER_REVIEW' },
  );

  let goalCount = 0;
  const orgGoalId = det(`${SLUG}:goal:org`);
  await ensure('goal', orgGoalId, { businessId, employeeId: employees[iDir].id, reviewCycleId: cycle.id, title: 'Grow ARR by 40%', description: 'Company-wide revenue objective', category: 'ORGANIZATION', weight: '100.00', progress: '45.00', status: 'ON_TRACK', dueDate: d(ymd(PY + 1, 3, 31)) }, {});
  goalCount += 1;
  const goalTitles = ['Ship platform v2', 'Improve uptime to 99.9%', 'Close 20 enterprise deals', 'Reduce attrition to <8%', 'Launch NZ payroll', 'Cut cloud spend 15%', 'Hire 10 engineers', 'Improve eNPS to 50'];
  const goalEmps = [iEM, iSr1, iSalesMgr, iPeopleHead, iEM, iFin, iEM, iPeopleHead];
  for (let k = 0; k < goalTitles.length; k += 1) {
    const e = employees[goalEmps[k]];
    if (!e) continue;
    await ensure('goal', det(`${SLUG}:goal:${k}`), {
      businessId, employeeId: e.id, reviewCycleId: cycle.id, parentGoalId: orgGoalId,
      title: goalTitles[k], category: k % 2 === 0 ? 'TEAM' : 'INDIVIDUAL',
      weight: money(20 + (k % 4) * 10), progress: money(20 + ((k * 9) % 80)),
      status: ['ON_TRACK', 'AT_RISK', 'ACTIVE', 'ACHIEVED'][k % 4],
      dueDate: d(ymd(PY + 1, 3, 31)),
    }, {});
    goalCount += 1;
  }
  // Key results on the org OKR (best-effort — model shape may vary).
  for (let k = 0; k < 3; k += 1) {
    await ensure('keyResult', det(`${SLUG}:kr:${k}`), {
      businessId, goalId: orgGoalId, title: ['ARR $5M', 'NPS > 50', '3 new markets'][k],
      targetValue: ['5000000', '50', '3'][k], currentValue: ['2200000', '42', '1'][k], unit: ['USD', 'pts', 'count'][k],
      progress: money([44, 84, 33][k]),
    }, {}).catch(() => {});
  }

  let reviewCount = 0;
  const reviewSubjects = [iSr1, iSr2, iHrbp, iFin, 8, 9, 10, 11].filter((x) => x != null && employees[x]);
  for (let k = 0; k < reviewSubjects.length; k += 1) {
    const e = employees[reviewSubjects[k]];
    const mgrIdx = e._r.manager;
    const reviewer = mgrIdx != null ? employees[mgrIdx] : employees[iDir];
    const released = k < 2;
    await up('performanceReview',
      { businessId_reviewCycleId_employeeId: { businessId, reviewCycleId: cycle.id, employeeId: e.id } },
      {
        businessId, reviewCycleId: cycle.id, employeeId: e.id, reviewerId: reviewer.id,
        status: released ? 'ACKNOWLEDGED' : (k % 2 === 0 ? 'SELF_SUBMITTED' : 'MANAGER_SUBMITTED'),
        selfRating: '4.00', managerRating: released ? '4.00' : null, finalRating: released ? '4.00' : null,
        selfComments: 'Strong delivery this period.',
        managerComments: released ? 'Consistently exceeds expectations.' : null,
        releasedAt: released ? new Date() : null,
        acknowledgedAt: released ? new Date() : null,
      },
      {},
    );
    reviewCount += 1;
  }
  console.log(`✓ Performance: cycle ${cycleCode} (MANAGER_REVIEW), ${goalCount} goals/OKRs, ${reviewCount} reviews`);

  // ═══════════════════════════════════════════════════════════════════════
  // 11. LIFECYCLE — templates + onboarding journeys + a separation + documents.
  // ═══════════════════════════════════════════════════════════════════════
  let templates = [];
  try {
    templates = await seedOnboardingTemplates(prisma, businessId, { entityId: entity.id });
    console.log(`✓ Lifecycle templates seeded (${templates.length})`);
  } catch (e) {
    console.log(`⚠ seedOnboardingTemplates failed (${String(e.message).slice(0, 100)}) — continuing`);
  }

  const onbTemplate = templates.find((t) => t.direction === 'ONBOARDING' && t.countryCode === COUNTRY) || templates.find((t) => t.direction === 'ONBOARDING');
  let journeyCount = 0; let taskCount = 0;
  const newHires = [
    { fn: isIN ? 'Ishaan' : 'Hunter', ln: isIN ? 'Kulkarni' : 'Walsh', dept: 'ENG', desig: 'DSG-ENG' },
    { fn: isIN ? 'Aanya' : 'Maia', ln: isIN ? 'Desai' : 'Cooper', dept: 'SALES', desig: 'DSG-SALES' },
  ];
  for (let k = 0; k < newHires.length; k += 1) {
    const nh = newHires[k];
    const jcode = `ONB-DEMO-${String(k + 1).padStart(3, '0')}`;
    const journey = await up('lifecycleJourney', { businessId_code: { businessId, code: jcode } },
      {
        businessId, entityId: entity.id, code: jcode, direction: 'ONBOARDING',
        templateId: onbTemplate ? onbTemplate.id : null,
        joinDate: d(ymd(PY, PM, Math.min(28, attDays))), currentStage: 'SELF_ONBOARDING', status: 'IN_PROGRESS',
        selfServiceJson: { personal: { firstName: nh.fn, lastName: nh.ln }, completeness: { personal: true, statutory: false, bank: false } },
        meta: { newHire: { firstName: nh.fn, lastName: nh.ln, department: nh.dept, designation: nh.desig } },
      },
      { status: 'IN_PROGRESS' },
    );
    journeyCount += 1;
    const jtasks = [
      { stage: 'PRE_JOIN', title: 'Send welcome email', owner: 'HR', status: 'DONE' },
      { stage: 'SELF_ONBOARDING', title: 'Collect personal details', owner: 'NEW_HIRE', status: 'IN_PROGRESS' },
      { stage: 'SELF_ONBOARDING', title: 'Collect statutory details', owner: 'NEW_HIRE', status: 'PENDING' },
      { stage: 'DOCS_ESIGN', title: 'E-sign offer letter', owner: 'NEW_HIRE', status: 'PENDING' },
      { stage: 'PROVISIONING', title: 'Provision employee record', owner: 'HR', status: 'PENDING' },
    ];
    for (let t = 0; t < jtasks.length; t += 1) {
      const jt = jtasks[t];
      await ensure('lifecycleTask', det(`${SLUG}:jtask:${jcode}:${t}`), {
        businessId, journeyId: journey.id, stageKey: jt.stage, title: jt.title,
        ownerRole: jt.owner, status: jt.status, isBlocking: true, isMandatory: true,
        dueDate: d(ymd(PY, PM, Math.min(28, attDays))), completedAt: jt.status === 'DONE' ? new Date() : null,
      }, { status: jt.status });
      taskCount += 1;
    }
  }
  console.log(`✓ Onboarding journeys: ${journeyCount} in-progress (${taskCount} tasks)`);

  // One in-progress separation (a mid-roster IC resigns).
  const sepEmp = employees[14] || employees[employees.length - 1];
  let sepCount = 0;
  if (sepEmp) {
    const sepCode = 'SEP-DEMO-001';
    const existingSep = await prisma.separationCase.findFirst({ where: { businessId, code: sepCode } }).catch(() => null);
    const lwdMonth = PM + 1 > 12 ? 12 : PM + 1;
    if (!existingSep) {
      const initiatedAt = d(ymd(PY, PM, 1));
      await prisma.separationCase.create({
        data: {
          businessId, employeeId: sepEmp.id, entityId: entity.id, code: sepCode,
          type: 'RESIGNATION', initiatedAt, status: 'NOTICE_SERVING', currencyCode: CUR,
          resignationDate: initiatedAt, noticeShortfallDays: 0, initiatedByUserId: operator.id,
          lastWorkingDay: d(ymd(PY, lwdMonth, 28)), clearanceJson: {},
        },
      });
      bump('separationCase', 'created');
      await prisma.employee.update({ where: { id: sepEmp.id }, data: { status: 'NOTICE_PERIOD' } }).catch(() => {});
      await up('lifecycleJourney', { businessId_code: { businessId, code: 'OFB-DEMO-001' } },
        {
          businessId, entityId: entity.id, code: 'OFB-DEMO-001', direction: 'OFFBOARDING',
          employeeId: sepEmp.id, currentStage: 'NOTICE', status: 'IN_PROGRESS',
          noticeStartDate: initiatedAt, lastWorkingDay: d(ymd(PY, lwdMonth, 28)),
        },
        {},
      );
      sepCount = 1;
    } else {
      sepCount = 1;
      bump('separationCase', 'updated');
    }
  }
  console.log(`✓ Separation: ${sepCount} in-progress (NOTICE_SERVING)`);

  // Employee documents for the demo-visible employees.
  let docCount = 0;
  const docDefs = [
    { category: 'OFFER_LETTER', name: 'Offer Letter.pdf', vis: 'EMPLOYEE_VISIBLE' },
    { category: 'CONTRACT', name: 'Employment Contract.pdf', vis: 'EMPLOYEE_VISIBLE' },
    { category: isIN ? 'PAN' : 'ID_PROOF', name: isIN ? 'PAN Card.pdf' : 'Passport.pdf', vis: 'HR_ONLY' },
    { category: 'POLICY_ACK', name: 'Code of Conduct (signed).pdf', vis: 'EMPLOYEE_VISIBLE' },
  ];
  for (const e of employees.slice(0, 12)) {
    for (let di = 0; di < docDefs.length; di += 1) {
      const dd = docDefs[di];
      await ensure('employeeDocument', det(`${SLUG}:doc:${e.code}:${di}`), {
        businessId, employeeId: e.id, category: dd.category, name: dd.name,
        fileUrl: `https://demo.local/docs/${e.code}/${di}.pdf`, visibility: dd.vis,
        signatureStatus: dd.category === 'POLICY_ACK' ? 'SIGNED' : 'NOT_REQUIRED',
      }, {});
      docCount += 1;
    }
  }
  console.log(`✓ Employee documents: ${docCount}`);

  // ═══════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════
  const [empTotal, psTotal, lrTotal, attTotal, goalTotal, reviewTotal] = await Promise.all([
    prisma.employee.count({ where: { businessId } }),
    prisma.payslip.count({ where: { businessId, status: { in: ['PUBLISHED', 'VIEWED'] } } }),
    prisma.leaveTransaction.count({ where: { businessId, txnType: 'APPLICATION' } }),
    prisma.attendance.count({ where: { businessId } }),
    prisma.goal.count({ where: { businessId } }),
    prisma.performanceReview.count({ where: { businessId } }),
  ]);

  console.log('\n════════════════════════ SUMMARY ════════════════════════');
  console.log(`  Tenant ................ ${business.name} (slug=${SLUG}, ${COUNTRY}/${CUR})`);
  console.log(`  Employees ............. ${empTotal}`);
  console.log(`  Published payslips .... ${psTotal}  (payroll mode: ${payrollMode})`);
  console.log(`  Leave requests ........ ${lrTotal}`);
  console.log(`  Attendance rows ....... ${attTotal}`);
  console.log(`  Goals/OKRs ............ ${goalTotal}`);
  console.log(`  Perf reviews .......... ${reviewTotal}`);
  console.log('  ── created/updated by model ──');
  for (const k of Object.keys(tally).sort()) {
    console.log(`     ${k.padEnd(22)} created=${tally[k].created}  updated=${tally[k].updated}`);
  }
  console.log('  Demo logins (password Demo@12345):');
  console.log(`     superadmin@demo.test · ${operator.email} · ${checker.email}`);
  if (isIN) console.log('     aarav.sharma@demo.test (manager) · priya.nair@demo.test (employee)');
  console.log('══════════════════════════════════════════════════════════');
}

main()
  .catch((e) => { console.error('✖ Seed failed:', e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
