'use strict';

// resolveIdentity — the single decision point that turns a VERIFIED IdP
// identity ({subject, email, name}) into a session principal for the requested
// target:
//
//   target ESS      → a Customer id (find-or-JIT via the social-login
//                     upsertCustomerFromIdentity seam; CustomerIdentity rows
//                     with provider 'sso-oidc' | 'sso-saml' record the linkage)
//   target OPERATOR → a User id (must already exist in the tenant — operator
//                     accounts are never JIT-minted from an assertion)
//
// The EMPLOYEE is the anchor either way: the assertion email must match an
// existing Employee (workEmail/personalEmail) in the tenant, unless the
// connection opted into jitProvision — then a minimal Employee (+ portal
// identities) is minted through the shared provisioning bridge (the same
// invariants SCIM create uses; see hr/scim/provisioningBridge.js).
//
// Dependencies are injectable for unit tests (fake prisma / fake bridge).

const { SsoError } = require('./attributes');

function providerFor(protocol) {
  return String(protocol || '').toUpperCase() === 'SAML' ? 'sso-saml' : 'sso-oidc';
}

function splitName(identity) {
  const first = identity.firstName
    || String(identity.name || '').trim().split(/\s+/)[0]
    || String(identity.email || '').split('@')[0];
  const rest = identity.lastName
    || String(identity.name || '').trim().split(/\s+/).slice(1).join(' ');
  return { firstName: first, lastName: rest || '' };
}

async function resolveIdentity({ business, connection, identity, target, protocol }, deps = {}) {
  const prisma = deps.prisma || require('../prisma');
  const businessId = business.id;
  const email = String(identity.email || '').toLowerCase().trim();
  if (!email) throw new SsoError('No email in the SSO assertion', { code: 'no-email', status: 400 });

  // ── 1. Anchor on the Employee ─────────────────────────────────────
  let employee = await prisma.employee.findFirst({
    where: {
      businessId,
      deletedAt: null,
      OR: [{ workEmail: email }, { personalEmail: email }],
    },
  });

  let jitProvisioned = false;
  if (!employee) {
    if (!connection.jitProvision) {
      throw new SsoError(
        `No employee with the email ${email} exists in this organisation. Ask your HR admin to add you (or enable just-in-time provisioning).`,
        { code: 'no-employee-match', status: 403 },
      );
    }
    // JIT — mint a minimal Employee + portal identities through the SHARED
    // provisioning bridge (same invariants as SCIM create; lazy require so a
    // no-JIT login never loads the HR provisioning graph).
    const mint = deps.mintEmployeeIdentity
      || require('../../../hr/scim/provisioningBridge').mintEmployeeIdentity;
    const { firstName, lastName } = splitName(identity);
    const minted = await mint({
      businessId,
      email,
      firstName,
      lastName,
      departmentId: connection.jitDefaultDepartmentId || null,
      source: 'sso-jit',
    });
    employee = minted.employee;
    jitProvisioned = true;
  }

  if (employee.isActive === false) {
    throw new SsoError('This employee account is no longer active.', { code: 'employee-inactive', status: 403 });
  }

  // ── 2. Mint the target principal ──────────────────────────────────
  if (String(target).toUpperCase() === 'OPERATOR') {
    let user = null;
    if (employee.userId) {
      user = await prisma.user.findFirst({ where: { id: employee.userId, businessId } });
    }
    if (!user) {
      const byEmail = await prisma.user.findUnique({ where: { email } });
      if (byEmail && byEmail.businessId === businessId) user = byEmail;
    }
    if (!user) {
      throw new SsoError('No operator (console) account exists for this employee.', { code: 'no-operator-account', status: 403 });
    }
    if (user.isActive === false) {
      throw new SsoError('This operator account is deactivated.', { code: 'operator-inactive', status: 403 });
    }
    return {
      kind: 'operator', userId: user.id, businessId, employeeId: employee.id, jitProvisioned,
    };
  }

  // ESS — reuse the social-login find-or-link-or-create seam so SSO logins and
  // Google logins converge on the SAME Customer + CustomerIdentity invariants.
  const upsert = deps.upsertCustomerFromIdentity
    || require('../../controllers/social.controller').upsertCustomerFromIdentity;
  const { customer, created } = await upsert({
    businessId,
    identity: {
      provider: providerFor(protocol),
      subject: String(identity.subject),
      email,
      name: identity.name || null,
    },
  });
  if (!created && (customer.isActive === false || customer.anonymisedAt)) {
    throw new SsoError('This account is no longer active.', { code: 'customer-inactive', status: 403 });
  }
  return {
    kind: 'customer', customerId: customer.id, businessId, employeeId: employee.id, jitProvisioned,
  };
}

module.exports = { resolveIdentity, providerFor, splitName };
