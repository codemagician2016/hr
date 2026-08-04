'use strict';

/*
 * probes.test.js — probe semantics against an INJECTED fake Prisma client.
 *
 * No DB and no DATABASE_URL: every probe reads its client off the context, so we can
 * feed it exactly the row shapes that matter and assert the judgement calls the real
 * schema forces on us. The cases below are all the ones where "a row exists" is the
 * WRONG answer — those are the probes that would otherwise report a tenant as set up
 * when nobody has set anything up.
 *
 *   node src/hr/setup/__tests__/probes.test.js
 */

const { PROBES, runProbes, ACTIVE_SET, taxYearStart, coverageVerdict } = require('../probes');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const D = (iso) => new Date(`${iso}T00:00:00Z`);

// A minimal delegate stub: count/findFirst/findUnique/findMany all answer from a
// canned value, and record the `where` they were called with so we can prove the
// tenant filter is present.
function delegate(value, sink) {
  const record = (args) => { if (sink) sink.push(args && args.where); return value; };
  return {
    count: async (a) => (record(a), typeof value === 'number' ? value : 0),
    findFirst: async (a) => (record(a), value),
    findUnique: async (a) => (record(a), value),
    findMany: async (a) => (record(a), Array.isArray(value) ? value : []),
  };
}

function ctx(overrides = {}, prismaOverrides = {}) {
  const today = D('2026-08-04');
  return {
    prisma: prismaOverrides,
    businessId: 'biz-1',
    business: { id: 'biz-1', createdAt: D('2026-01-01'), hrCountry: 'IN', hrCountrySetAt: D('2026-01-02'), hrCurrency: 'INR', companyProfile: null, featureFlags: {}, candidateCommsConfig: null },
    today,
    country: 'IN',
    currency: 'INR',
    featureFlags: {},
    activeEmployeeWhere: { businessId: 'biz-1', deletedAt: null, status: { in: ACTIVE_SET } },
    activeEntityWhere: { businessId: 'biz-1', deletedAt: null, status: 'ACTIVE' },
    activeEmployees: 10,
    activeEntities: 1,
    activeInEntities: 1,
    taxYearStartMonth: 4,
    fyStart: D('2026-04-01'),
    currentFy: '2026-27',
    _migratedFromAnotherSystem: false,
    _joinedBeforeTaxYearStart: 0,
    ...overrides,
  };
}

async function main() {
  log('\n=== Setup checklist — probe semantics (fake prisma) ===\n');

  // ── A) The "a row exists" false positives ───────────────────────────────────
  log('A) Probes that deliberately reject mere row-existence\n');

  // employee_number: allocateCode auto-creates the row at the first hire.
  {
    const shipped = await PROBES.employee_number(ctx({}, { numberSequence: delegate({ prefix: 'EMP-', padding: 6 }) }));
    const chosen = await PROBES.employee_number(ctx({}, { numberSequence: delegate({ prefix: 'ACME-IN-', padding: 4 }) }));
    const absent = await PROBES.employee_number(ctx({}, { numberSequence: delegate(null) }));
    ok(shipped === false, 'employee_number: the auto-created EMP-/6 row does NOT read as configured');
    ok(chosen === true, 'employee_number: a deliberate prefix/padding change reads as done');
    ok(absent === false, 'employee_number: no row at all is not done');
  }

  // hr_team_roles: six SYSTEM_ROLES are seeded at Business creation.
  {
    const seededOnly = await PROBES.hr_team_roles(ctx({}, {
      user: delegate(1), businessRole: delegate(0),
    }));
    const secondOperator = await PROBES.hr_team_roles(ctx({}, {
      user: delegate(2), businessRole: delegate(0),
    }));
    const ownRole = await PROBES.hr_team_roles(ctx({}, {
      user: delegate(1), businessRole: delegate(1),
    }));
    ok(seededOnly === false, 'hr_team_roles: one operator + only seeded system roles is NOT done');
    ok(secondOperator === true, 'hr_team_roles: a second operator counts');
    ok(ownRole === true, 'hr_team_roles: a tenant-authored (non-system) role counts');
  }

  // branding: every TenantBrand column is nullable.
  {
    const empty = await PROBES.branding(ctx({}, { tenantBrand: delegate({ logoUrl: null, primaryColor: null }) }));
    const logo = await PROBES.branding(ctx({}, { tenantBrand: delegate({ logoUrl: 'https://x/y.png', primaryColor: null }) }));
    ok(empty === false, 'branding: an all-null brand row is NOT done');
    ok(logo === true, 'branding: a logo alone is enough');
  }

  // comp_off: ensureCompOffType auto-seeds a NONE-accrual policy on first grant.
  {
    const seeded = await PROBES.comp_off(ctx({}, {
      leaveType: delegate({ id: 'lt-1' }), leavePolicy: delegate({ compOffConfig: null }),
    }));
    const configured = await PROBES.comp_off(ctx({}, {
      leaveType: delegate({ id: 'lt-1' }), leavePolicy: delegate({ compOffConfig: { expiryDays: 60 } }),
    }));
    const noType = await PROBES.comp_off(ctx({}, { leaveType: delegate(null), leavePolicy: delegate(null) }));
    ok(seeded === false, 'comp_off: the auto-seeded type with a null compOffConfig is NOT done');
    ok(configured === true, 'comp_off: a written compOffConfig is done');
    ok(noType === false, 'comp_off: no COMP_OFF leave type is not done');
  }

  // company_profile: the RAW column, and the country decides which ids count.
  {
    const inDone = PROBES.company_profile(ctx({ business: { companyProfile: { legalName: 'Acme Pvt Ltd', pan: 'AAMCP6969N', tan: 'MUMC12345D' } } }));
    const inNoTan = PROBES.company_profile(ctx({ business: { companyProfile: { legalName: 'Acme Pvt Ltd', pan: 'AAMCP6969N' } } }));
    const nzDone = PROBES.company_profile(ctx({ country: 'NZ', business: { companyProfile: { legalName: 'Acme NZ Ltd', nzbn: '9429000000000' } } }));
    const blank = PROBES.company_profile(ctx({ business: { companyProfile: { legalName: '   ' } } }));
    ok(inDone === true, 'company_profile (IN): legal name + PAN + TAN is done');
    ok(inNoTan === false, 'company_profile (IN): PAN without TAN is NOT done');
    ok(nzDone === true, 'company_profile (NZ): legal name + NZBN is done');
    ok(blank === false, 'company_profile: a whitespace-only legal name is not "filled"');
  }

  // featureFlags key PRESENCE, not value.
  {
    ok(PROBES.restricted_holidays(ctx({ featureFlags: {} })) === false, 'restricted_holidays: an absent key means "never decided"');
    ok(PROBES.restricted_holidays(ctx({ featureFlags: { leave: { restrictedHolidayAllowance: 0 } } })) === true, 'restricted_holidays: an allowance of ZERO still counts (a decision was made)');
    ok(PROBES.payslip_settings(ctx({ featureFlags: { payroll: {} } })) === false, 'payslip_settings: absent key is not done');
    ok(PROBES.payslip_settings(ctx({ featureFlags: { payroll: { payslipPdfPassword: 'NONE' } } })) === true, 'payslip_settings: an explicit NONE is a real choice');
  }

  // ── B) Coverage ratios ──────────────────────────────────────────────────────
  log('\nB) Coverage ratios and their thresholds\n');

  {
    // managers: exactly one root is fine; two roots is not.
    const oneRoot = await PROBES.managers(ctx({ activeEmployees: 48 }, { employee: delegate(1) }));
    const twoRoots = await PROBES.managers(ctx({ activeEmployees: 48 }, { employee: delegate(2) }));
    ok(oneRoot.completed === true, 'managers: a single org root is complete');
    ok(oneRoot.coverage.done === 47 && oneRoot.coverage.total === 48, `managers emits coverage 47/48 (${oneRoot.coverage.done}/${oneRoot.coverage.total})`);
    ok(twoRoots.completed === false, 'managers: two people with no manager is NOT complete');

    // Empty population never scores — a ratio over zero would report 100%.
    const nobody = await PROBES.managers(ctx({ activeEmployees: 0 }, { employee: delegate(0) }));
    ok(nobody.completed === false, 'managers: a tenant with nobody in it is never "complete"');
  }

  {
    const at80 = await PROBES.portal_invites(ctx({ activeEmployees: 10 }, { employee: delegate(8) }));
    const at79 = await PROBES.portal_invites(ctx({ activeEmployees: 100 }, { employee: delegate(79) }));
    ok(at80.completed === true, 'portal_invites: exactly 80% invited is complete');
    ok(at79.completed === false, 'portal_invites: 79% is not');
  }

  {
    // statutory_ids reads a different column per country.
    const seen = [];
    await PROBES.statutory_ids(ctx({ country: 'IN' }, { statutoryProfile: delegate(9, seen) }));
    await PROBES.statutory_ids(ctx({ country: 'NZ' }, { statutoryProfile: delegate(9, seen) }));
    ok(seen[0].pan && !seen[0].irdNumber, 'statutory_ids (IN) filters on pan');
    ok(seen[1].irdNumber && !seen[1].pan, 'statutory_ids (NZ) filters on irdNumber');
    const v = await PROBES.statutory_ids(ctx({ activeEmployees: 10 }, { statutoryProfile: delegate(9) }));
    ok(v.completed === true, 'statutory_ids: 90% coverage is complete');
  }

  {
    // salary_assigned needs 95% and must not count PROPOSED/APPROVED.
    const seen = [];
    const rows = Array.from({ length: 19 }, (_, i) => ({ employeeId: `e${i}` }));
    const v = await PROBES.salary_assigned(ctx({ activeEmployees: 20 }, { compensationRevision: delegate(rows, seen) }));
    ok(v.completed === true, 'salary_assigned: 19 of 20 (95%) is complete');
    ok(seen[0].status === 'EFFECTIVE' && seen[0].isCurrent === true, 'salary_assigned only counts isCurrent + EFFECTIVE revisions');
    const v2 = await PROBES.salary_assigned(ctx({ activeEmployees: 20 }, { compensationRevision: delegate(rows.slice(0, 18)) }));
    ok(v2.completed === false, 'salary_assigned: 18 of 20 (90%) is not enough');
  }

  {
    // pay_calendar is per COMPANY, not per person, and is a hard structural need.
    const covered = await PROBES.pay_calendar(ctx({ activeEntities: 2 }, { payCalendar: delegate([{ entityId: 'a' }, { entityId: 'b' }]) }));
    const partial = await PROBES.pay_calendar(ctx({ activeEntities: 2 }, { payCalendar: delegate([{ entityId: 'a' }]) }));
    ok(covered.completed === true && covered.coverage.unit === 'companies', 'pay_calendar: every company covered → complete, unit "companies"');
    ok(partial.completed === false && partial.coverage.done === 1, 'pay_calendar: one of two companies is not complete');
  }

  // ── C) Scoping filters that would otherwise mis-report ──────────────────────
  log('\nC) Filters that keep the answer honest\n');

  {
    const seen = [];
    const y = new Date().getUTCFullYear();
    await PROBES.holidays(ctx({}, { holiday: delegate(3, seen) }));
    ok(seen[0].date.gte.getUTCFullYear() === new Date(D('2026-08-04')).getUTCFullYear(), 'holidays is year-scoped (last year\'s calendar does not count)');
    ok(!('isActive' in seen[0]) && !('deletedAt' in seen[0]), 'holidays does not invent isActive/deletedAt (the model has neither)');
    void y;
  }

  {
    const seen = [];
    await PROBES.bank_accounts(ctx({}, { bankAccount: delegate([], seen) }));
    ok(!!seen[0].employee, 'bank_accounts is scoped through the employee relation (a leaver cannot inflate coverage)');
    ok(seen[0].isPrimary === true, 'bank_accounts only counts the PRIMARY (salary) account');
  }

  {
    const seen = [];
    await PROBES.shift_assignment(ctx({}, { shiftAssignment: delegate([], seen) }));
    ok(!!seen[0].effectiveFrom && Array.isArray(seen[0].OR), 'shift_assignment uses the effective window as its currency test');
  }

  {
    const seen = [];
    await PROBES.approval_workflows(ctx({}, { workflowDefinition: delegate(1, seen) }));
    ok(seen[0].isPublished === true, 'approval_workflows requires isPublished (a draft never routes a request)');
  }

  {
    const seen = [];
    await PROBES.onboarding_checklist(ctx({}, { lifecycleTemplate: delegate(1, seen) }));
    await PROBES.offboarding_checklist(ctx({}, { lifecycleTemplate: delegate(1, seen) }));
    ok(seen[0].direction === 'ONBOARDING' && seen[1].direction === 'OFFBOARDING', 'lifecycle templates filter on direction (one model holds both)');
  }

  {
    const seen = [];
    await PROBES.tax_declaration_window(ctx({}, { investmentDeclarationWindow: delegate(1, seen) }));
    ok(seen[0].purpose === 'INVESTMENT_PROOF', 'tax_declaration_window filters on purpose (the table also holds FBP windows)');
    ok(!seen[0].status.in.includes('DRAFT'), 'a DRAFT window is created-but-never-opened and does not count');
    ok(seen[0].financialYear === '2026-27', 'tax_declaration_window is FY-scoped');
  }

  {
    const seen = [];
    await PROBES.first_payroll(ctx({}, { payRun: delegate(1, seen) }));
    ok(seen[0].type === 'REGULAR', 'first_payroll excludes MIGRATED runs (an imported back-run is not the activation moment)');
    ok(!seen[0].status.in.includes('COMPUTED'), 'a COMPUTED run is started, not done');
  }

  {
    const seen = [];
    await PROBES.letterheads(ctx({}, { companyLetterhead: delegate(1, seen) }));
    ok(seen[0].isDefault === true && seen[0].letterCategory === null, 'letterheads requires the TENANT DEFAULT, not a category-only one');
    const seen2 = [];
    await PROBES.letter_templates(ctx({}, { letterTemplate: delegate(1, seen2) }));
    ok(seen2[0].isSystem === false, 'letter_templates excludes the seeded IN/NZ system templates');
  }

  {
    const seen = [];
    await PROBES.first_announcement(ctx({}, { announcement: delegate(1, seen) }));
    ok(!!seen[0].publishedAt.lte, 'first_announcement ignores a future scheduled go-live');
  }

  // Every probe must carry the tenant filter. This is the single most important
  // invariant in the file — one missing businessId leaks another tenant's progress.
  {
    const leaky = [];
    for (const [key, probe] of Object.entries(PROBES)) {
      const seen = [];
      // Answer every delegate with something harmless; we only care about `where`.
      const fake = new Proxy({}, { get: () => delegate(0, seen) });
      try { await probe(ctx({ business: { companyProfile: null, candidateCommsConfig: null, hrCountrySetAt: null } }, fake)); } catch (_e) { /* shape mismatch is fine */ }
      const scoped = seen.every((w) => !w || w.businessId === 'biz-1');
      // Probes that answer purely from the already-tenant-scoped context issue no
      // query at all, which is trivially scoped.
      if (!scoped) leaky.push(key);
    }
    ok(leaky.length === 0, `every probe query is scoped to businessId${leaky.length ? ` (LEAKY: ${leaky})` : ''}`);
  }

  // ── D) Resilience: one broken probe must not take the page down ─────────────
  log('\nD) Resilience\n');
  {
    const saved = PROBES.holidays;
    PROBES.holidays = () => { throw new Error('column does not exist'); };
    try {
      const status = await runProbes(ctx({}, { shiftPattern: delegate(1) }), ['holidays', 'shifts']);
      ok(status.holidays.ok === false && status.holidays.completed === false, 'a throwing probe degrades to { ok:false, completed:false }');
      ok(status.shifts.ok === true && status.shifts.completed === true, 'its neighbours still resolve normally');
    } finally { PROBES.holidays = saved; }
  }
  {
    const status = await runProbes(ctx(), ['not_a_real_step']);
    ok(status.not_a_real_step.ok === false, 'an unregistered key reports unknown rather than scoring incomplete');
  }

  // ── E) Small pure helpers ──────────────────────────────────────────────────
  log('\nE) Helpers\n');
  {
    ok(taxYearStart(D('2026-08-04'), 4).toISOString().slice(0, 10) === '2026-04-01', 'taxYearStart: August 2026 sits in the FY that began 1 Apr 2026');
    ok(taxYearStart(D('2026-02-04'), 4).toISOString().slice(0, 10) === '2025-04-01', 'taxYearStart: February 2026 sits in the FY that began 1 Apr 2025');
    ok(coverageVerdict(0, 0, 0.9).completed === false, 'coverageVerdict: an empty population is never complete');
    ok(coverageVerdict(9, 10, 0.9).completed === true, 'coverageVerdict: exactly the floor passes');
  }

  log(`\n=== ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} ===\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
