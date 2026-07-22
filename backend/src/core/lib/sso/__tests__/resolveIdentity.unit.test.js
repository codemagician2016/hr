'use strict';

/*
 * resolveIdentity.unit.test.js — the SSO identity-resolution decision table
 * (match / no-match / jit / inactive / operator variants) against a FAKE
 * prisma, plus the provisioning-bridge H2 email-collision table against a
 * fake tx. Plain-node, NO DB:
 *   JWT_SECRET=test node backend/src/core/lib/sso/__tests__/resolveIdentity.unit.test.js
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const assert = require('assert');
const { resolveIdentity, providerFor, splitName } = require('../resolveIdentity');
const { SsoError } = require('../attributes');
const { mintEmployeeIdentity, BridgeError } = require('../../../../hr/scim/provisioningBridge');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }
async function rejects(name, fn, check) {
  try {
    await fn();
    assert.fail(`${name}: expected a throw`);
  } catch (e) {
    assert.ok(check(e), `${name}: wrong error — ${e.code || e.name}: ${e.message}`);
    passed += 1;
  }
}

const BIZ = 'biz-1';
const business = { id: BIZ, slug: 'acme', name: 'Acme' };
const baseConn = { protocol: 'OIDC', loginTarget: 'BOTH', jitProvision: false, jitDefaultDepartmentId: null };
const identity = {
  subject: 'sub-1', email: 'jane@acme.com', emailVerified: true, name: 'Jane Doe', firstName: 'Jane', lastName: 'Doe',
};

// A tiny scriptable prisma fake: pass row maps; records calls.
function fakePrisma({ employee = null, userById = null, userByEmail = null } = {}) {
  const calls = [];
  return {
    calls,
    employee: {
      findFirst: async (q) => { calls.push(['employee.findFirst', q]); return employee; },
    },
    user: {
      findFirst: async (q) => { calls.push(['user.findFirst', q]); return userById; },
      findUnique: async (q) => { calls.push(['user.findUnique', q]); return userByEmail; },
    },
  };
}

async function main() {
  /* ══ decision table: ESS ════════════════════════════════════════ */

  // 1. MATCH → customer (upsert seam invoked with the sso provider key)
  {
    const emp = { id: 'emp-1', businessId: BIZ, isActive: true, userId: null };
    let upsertArgs = null;
    const out = await resolveIdentity(
      { business, connection: baseConn, identity, target: 'ESS', protocol: 'OIDC' },
      {
        prisma: fakePrisma({ employee: emp }),
        upsertCustomerFromIdentity: async (args) => { upsertArgs = args; return { customer: { id: 'cust-1', isActive: true, anonymisedAt: null }, created: false }; },
      },
    );
    ok('ESS match → kind customer', out.kind === 'customer' && out.customerId === 'cust-1');
    ok('employeeId carried', out.employeeId === 'emp-1');
    ok('not jit', out.jitProvisioned === false);
    ok('upsert got provider sso-oidc', upsertArgs.identity.provider === 'sso-oidc');
    ok('upsert got subject + email', upsertArgs.identity.subject === 'sub-1' && upsertArgs.identity.email === 'jane@acme.com');
    ok('upsert scoped to tenant', upsertArgs.businessId === BIZ);
  }

  // 2. SAML protocol → provider key sso-saml
  {
    let upsertArgs = null;
    await resolveIdentity(
      { business, connection: baseConn, identity, target: 'ESS', protocol: 'SAML' },
      {
        prisma: fakePrisma({ employee: { id: 'e', businessId: BIZ, isActive: true } }),
        upsertCustomerFromIdentity: async (args) => { upsertArgs = args; return { customer: { id: 'c', isActive: true }, created: true }; },
      },
    );
    ok('SAML → provider sso-saml', upsertArgs.identity.provider === 'sso-saml');
    ok('providerFor helper agrees', providerFor('SAML') === 'sso-saml' && providerFor('OIDC') === 'sso-oidc');
  }

  // 3. NO MATCH + jit OFF → clean no-employee-match error
  await rejects(
    'no employee + !jit → no-employee-match 403',
    () => resolveIdentity(
      { business, connection: baseConn, identity, target: 'ESS', protocol: 'OIDC' },
      { prisma: fakePrisma({ employee: null }), upsertCustomerFromIdentity: async () => assert.fail('must not upsert') },
    ),
    (e) => e instanceof SsoError && e.code === 'no-employee-match' && e.status === 403,
  );

  // 4. NO MATCH + jit ON → bridge mints; login proceeds
  {
    let mintArgs = null;
    const out = await resolveIdentity(
      {
        business,
        connection: { ...baseConn, jitProvision: true, jitDefaultDepartmentId: 'dept-9' },
        identity,
        target: 'ESS',
        protocol: 'OIDC',
      },
      {
        prisma: fakePrisma({ employee: null }),
        mintEmployeeIdentity: async (args) => { mintArgs = args; return { employee: { id: 'emp-jit', businessId: BIZ, isActive: true }, userId: 'u-jit', customerId: 'c-jit', warnings: [] }; },
        upsertCustomerFromIdentity: async () => ({ customer: { id: 'c-jit', isActive: true }, created: false }),
      },
    );
    ok('jit → customer minted + resolved', out.kind === 'customer' && out.customerId === 'c-jit');
    ok('jit flag set', out.jitProvisioned === true);
    ok('jit passes names from assertion', mintArgs.firstName === 'Jane' && mintArgs.lastName === 'Doe');
    ok('jit passes default department', mintArgs.departmentId === 'dept-9');
    ok('jit scoped to tenant', mintArgs.businessId === BIZ && mintArgs.email === 'jane@acme.com');
  }

  // 5. INACTIVE employee → blocked before any identity minting
  await rejects(
    'inactive employee → employee-inactive 403',
    () => resolveIdentity(
      { business, connection: baseConn, identity, target: 'ESS', protocol: 'OIDC' },
      { prisma: fakePrisma({ employee: { id: 'e', businessId: BIZ, isActive: false } }), upsertCustomerFromIdentity: async () => assert.fail('must not upsert') },
    ),
    (e) => e instanceof SsoError && e.code === 'employee-inactive' && e.status === 403,
  );

  // 6. ESS customer deactivated (offboarded) → customer-inactive
  await rejects(
    'deactivated customer → customer-inactive 403',
    () => resolveIdentity(
      { business, connection: baseConn, identity, target: 'ESS', protocol: 'OIDC' },
      {
        prisma: fakePrisma({ employee: { id: 'e', businessId: BIZ, isActive: true } }),
        upsertCustomerFromIdentity: async () => ({ customer: { id: 'c', isActive: false, anonymisedAt: null }, created: false }),
      },
    ),
    (e) => e instanceof SsoError && e.code === 'customer-inactive',
  );

  /* ══ decision table: OPERATOR ═══════════════════════════════════ */

  // 7. linked operator user in tenant → operator principal
  {
    const out = await resolveIdentity(
      { business, connection: baseConn, identity, target: 'OPERATOR', protocol: 'OIDC' },
      {
        prisma: fakePrisma({
          employee: { id: 'emp-1', businessId: BIZ, isActive: true, userId: 'user-7' },
          userById: { id: 'user-7', businessId: BIZ, isActive: true },
        }),
      },
    );
    ok('operator match → kind operator', out.kind === 'operator' && out.userId === 'user-7');
  }

  // 8. unlinked employee, User found by email in SAME tenant → operator
  {
    const out = await resolveIdentity(
      { business, connection: baseConn, identity, target: 'OPERATOR', protocol: 'OIDC' },
      {
        prisma: fakePrisma({
          employee: { id: 'emp-1', businessId: BIZ, isActive: true, userId: null },
          userByEmail: { id: 'user-8', businessId: BIZ, isActive: true },
        }),
      },
    );
    ok('operator via email lookup', out.kind === 'operator' && out.userId === 'user-8');
  }

  // 9. COLLISION: the email's User belongs to ANOTHER tenant → refused
  await rejects(
    'cross-tenant user collision → no-operator-account',
    () => resolveIdentity(
      { business, connection: baseConn, identity, target: 'OPERATOR', protocol: 'OIDC' },
      {
        prisma: fakePrisma({
          employee: { id: 'emp-1', businessId: BIZ, isActive: true, userId: null },
          userByEmail: { id: 'user-x', businessId: 'OTHER-TENANT', isActive: true },
        }),
      },
    ),
    (e) => e instanceof SsoError && e.code === 'no-operator-account' && e.status === 403,
  );

  // 10. deactivated operator → refused
  await rejects(
    'inactive operator user → operator-inactive',
    () => resolveIdentity(
      { business, connection: baseConn, identity, target: 'OPERATOR', protocol: 'OIDC' },
      {
        prisma: fakePrisma({
          employee: { id: 'emp-1', businessId: BIZ, isActive: true, userId: 'user-7' },
          userById: { id: 'user-7', businessId: BIZ, isActive: false },
        }),
      },
    ),
    (e) => e instanceof SsoError && e.code === 'operator-inactive',
  );

  // splitName sanity (JIT name derivation)
  {
    ok('splitName from parts', splitName({ firstName: 'A', lastName: 'B' }).firstName === 'A');
    const s = splitName({ name: 'Mary Jane Watson', email: 'mj@x.co' });
    ok('splitName from full name', s.firstName === 'Mary' && s.lastName === 'Jane Watson');
    const s2 = splitName({ email: 'solo@x.co' });
    ok('splitName from email', s2.firstName === 'solo' && s2.lastName === '');
  }

  /* ══ provisioning bridge: H2 email-collision table (fake tx) ════ */

  function fakeTx({ existingUser = null, linkedEmployee = null, dupEmployee = null, existingCustomer = null } = {}) {
    const created = { user: null, customer: null, employee: null, employmentRecord: null };
    const updates = [];
    let seq = 0;
    const tx = {
      created,
      updates,
      employee: {
        findFirst: async (q) => {
          // first call = dup check; later = linked-employee check
          if (q.where.OR) return dupEmployee;
          if (q.where.userId) return linkedEmployee;
          return null;
        },
        create: async (q) => { created.employee = { id: 'emp-new', ...q.data }; return created.employee; },
        update: async (q) => { updates.push(['employee', q.data]); created.employee = { ...created.employee, ...q.data }; return created.employee; },
      },
      user: {
        findUnique: async () => existingUser,
        create: async (q) => { created.user = { id: 'user-new', ...q.data }; return created.user; },
        update: async (q) => { updates.push(['user', q.where, q.data]); return { id: q.where.id, ...q.data }; },
      },
      customer: {
        findUnique: async () => existingCustomer,
        create: async (q) => { created.customer = { id: 'cust-new', ...q.data }; return created.customer; },
        update: async (q) => { updates.push(['customer', q.where, q.data]); return { id: q.where.id, ...q.data }; },
      },
      entity: { findFirst: async () => ({ id: 'ent-1' }) },
      designation: { findFirst: async () => null },
      businessRole: { findFirst: async () => ({ id: 'role-emp' }) },
      employmentRecord: {
        create: async (q) => { created.employmentRecord = { id: 'rec-1', ...q.data }; return created.employmentRecord; },
      },
      numberSequence: {
        findFirst: async () => null,
        create: async (q) => { seq += 1; return { id: `seq-${seq}`, nextValue: 42, prefix: q.data.prefix, padding: q.data.padding }; },
        update: async () => ({}),
      },
    };
    return tx;
  }

  // A. clean create → Employee + User + Customer + EmploymentRecord, no warnings
  {
    const tx = fakeTx();
    const out = await mintEmployeeIdentity({
      businessId: BIZ, email: 'new@acme.com', firstName: 'New', lastName: 'Hire', scimManaged: true, externalId: 'okta-1', countryCode: 'IN',
    }, tx);
    ok('bridge: employee created', tx.created.employee && tx.created.employee.workEmail === 'new@acme.com');
    ok('bridge: EMP code from shared sequence', tx.created.employee.code === 'EMP-000042');
    ok('bridge: scimManaged + externalId stamped', tx.created.employee.scimManaged === true && tx.created.employee.externalId === 'okta-1');
    ok('bridge: user created', tx.created.user && tx.created.user.email === 'new@acme.com' && tx.created.user.role === 'USER');
    ok('bridge: customer created (hasPassword false)', tx.created.customer && tx.created.customer.hasPassword === false);
    ok('bridge: employment record on the entity', tx.created.employmentRecord && tx.created.employmentRecord.entityId === 'ent-1' && tx.created.employmentRecord.changeReason === 'HIRE');
    ok('bridge: no warnings', out.warnings.length === 0);
    ok('bridge: userId + customerId returned', out.userId === 'user-new' && out.customerId === 'cust-new');
  }

  // B. COLLISION: email's User in ANOTHER tenant → Employee + Customer created, User SKIPPED + warning
  {
    const tx = fakeTx({ existingUser: { id: 'u-other', businessId: 'OTHER', email: 'new@acme.com' } });
    const out = await mintEmployeeIdentity({
      businessId: BIZ, email: 'new@acme.com', firstName: 'New', countryCode: 'IN',
    }, tx);
    ok('collision: employee still created', tx.created.employee !== null);
    ok('collision: user NOT created', tx.created.user === null);
    ok('collision: customer still created', tx.created.customer !== null);
    ok('collision: warning mentions another tenant', out.warnings.some((w) => w.includes('another tenant')));
    ok('collision: userId null in result', out.userId === null);
  }

  // C. same-tenant UNLINKED user → REUSED (updated, not created)
  {
    const tx = fakeTx({ existingUser: { id: 'u-same', businessId: BIZ, email: 'new@acme.com' } });
    const out = await mintEmployeeIdentity({
      businessId: BIZ, email: 'new@acme.com', firstName: 'New', countryCode: 'IN',
    }, tx);
    ok('reuse: no new user created', tx.created.user === null);
    ok('reuse: existing user updated + linked', out.userId === 'u-same');
    ok('reuse: employee linked to reused user', tx.updates.some(([kind, ...rest]) => kind === 'employee' && rest.some((d) => d && d.userId === 'u-same')));
  }

  // D. same-tenant user ALREADY LINKED to another employee → skip + warning
  {
    const tx = fakeTx({
      existingUser: { id: 'u-linked', businessId: BIZ, email: 'new@acme.com' },
      linkedEmployee: { id: 'emp-other' },
    });
    const out = await mintEmployeeIdentity({
      businessId: BIZ, email: 'new@acme.com', firstName: 'New', countryCode: 'IN',
    }, tx);
    ok('linked-collision: user skipped', out.userId === null);
    ok('linked-collision: warning mentions linked', out.warnings.some((w) => w.includes('already linked')));
  }

  // E. duplicate employee email in tenant → 409 employee-exists
  await rejects(
    'duplicate employee → BridgeError 409',
    () => mintEmployeeIdentity(
      { businessId: BIZ, email: 'dup@acme.com', countryCode: 'IN' },
      fakeTx({ dupEmployee: { id: 'emp-dup' } }),
    ),
    (e) => e instanceof BridgeError && e.code === 'employee-exists' && e.status === 409,
  );

  // F. anonymised customer NEVER un-anonymised
  {
    const tx = fakeTx({ existingCustomer: { id: 'c-anon', anonymisedAt: new Date() } });
    const out = await mintEmployeeIdentity({
      businessId: BIZ, email: 'new@acme.com', firstName: 'N', countryCode: 'IN',
    }, tx);
    ok('anonymised customer untouched', tx.created.customer === null
      && !tx.updates.some(([kind]) => kind === 'customer'));
    ok('anonymised warning surfaced', out.warnings.some((w) => w.includes('anonymised')));
  }

  console.log(`resolveIdentity.unit.test.js — ${passed} assertions passed`);
}

main().then(
  () => process.exit(0),
  (e) => { console.error(e); process.exit(1); },
);
