'use strict';

/**
 * provisioningBridge.js — the SHARED "mint / flip an employee's portal
 * identities" seam used by BOTH:
 *
 *   - SCIM 2.0  POST /scim/v2/Users            (IdP-driven create)
 *   - SSO JIT   resolveIdentity({jitProvision}) (first-login auto-provision)
 *   - SCIM PATCH active=false / DELETE          (deactivate BOTH identities)
 *
 * It deliberately REUSES the lifecycle provision flow's invariants rather than
 * re-inventing them (provision.js cannot be called directly here — it is
 * journey+offer driven; a SCIM create has neither):
 *
 *   - EMP code minting through the SAME NumberSequence allocator + the SAME
 *     (businessId, entityId, 'EMPLOYEE') sequence row provision.js uses, so
 *     SCIM- and ATS-provisioned employees share ONE numbering line (no dupes).
 *   - The H2 portal-email rules: User.email is GLOBALLY unique → same-tenant
 *     unlinked User is REUSED; a cross-tenant (or already-linked) collision
 *     SKIPS the operator User with a warning (never a P2002 mid-write).
 *   - The STEP-2 Customer semantics: never un-anonymise, never clobber an
 *     unrelated live customer's password — SCIM create only refreshes
 *     name/isActive on an existing live row.
 *   - The default-role attach via provision.js's own resolveDefaultEmployeeRole
 *     (required lazily from its _internals export — one source of truth).
 *   - Deactivation mirrors the offboarding-settle access-revoke semantics
 *     (User.isActive=false + every matching Customer isActive=false +
 *     Employee.isActive=false) WITHOUT creating a SeparationCase and WITHOUT
 *     the terminal status flip — SCIM deactivation must stay reversible, so
 *     businessRoleId is kept (deviation from settle, which nulls it forever).
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const livePrisma = require('../../core/lib/prisma');
const { allocateCode } = require('../lifecycle/lib/codes');

class BridgeError extends Error {
  constructor(message, { code = 'bridge-error', status = 422 } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = status;
  }
}

// UTC-midnight date-only (matches provision.js toDateOnly).
function toDateOnly(x) {
  const d = x instanceof Date ? x : new Date(x || Date.now());
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// provision.js's own default-role resolver — lazy + guarded so requiring this
// bridge never drags the full ATS/talent module graph in until actually needed.
function getResolveDefaultEmployeeRole() {
  try {
    return require('../lifecycle/provision')._internals.resolveDefaultEmployeeRole;
  } catch (_e) {
    return null;
  }
}

// Tenant country (Feature 14 single source of truth) — best-effort.
async function bestEffortCountry(businessId) {
  try {
    const { tenantCountry } = require('../tenant/countryContext');
    return await tenantCountry(businessId);
  } catch (_e) {
    return null;
  }
}

/**
 * mintEmployeeIdentity(input, prismaOrTx) -> { employee, userId, customerId, warnings }
 *
 * Creates (atomically) a minimal Employee + portal User (unless the global
 * email uniqueness forbids it) + Customer ESS identity + (best-effort) a HIRE
 * EmploymentRecord on the tenant's first ACTIVE entity.
 *
 * input: { businessId, email, firstName?, lastName?, externalId?, active=true,
 *          scimManaged=false, departmentId?, title?, source?, countryCode? }
 * `countryCode` (tests / callers that already resolved it) skips the
 * tenantCountry lookup; omitted → best-effort Feature-14 resolution.
 */
async function mintEmployeeIdentity(input, prismaOrTx) {
  const {
    businessId,
    externalId = null,
    active = true,
    scimManaged = false,
    departmentId = null,
    title = null,
  } = input || {};
  const email = String(input?.email || '').toLowerCase().trim();
  if (!businessId || !email || !email.includes('@')) {
    throw new BridgeError('businessId and a valid email are required', { code: 'bad-request', status: 400 });
  }
  const prisma = prismaOrTx || livePrisma;

  const run = async (tx) => {
    const warnings = [];

    // ── Duplicate guard: one employee per work email per tenant. ──
    const dup = await tx.employee.findFirst({
      where: { businessId, deletedAt: null, OR: [{ workEmail: email }, { personalEmail: email }] },
      select: { id: true },
    });
    if (dup) {
      throw new BridgeError(`An employee with the email ${email} already exists`, {
        code: 'employee-exists', status: 409,
      });
    }

    // ── H2 portal-email pre-check (User.email is GLOBALLY unique). ──
    let reusableUser = null;
    let skipUser = false;
    const existingUser = await tx.user.findUnique({ where: { email } });
    if (existingUser) {
      if (existingUser.businessId !== businessId) {
        skipUser = true;
        warnings.push(`Operator (console) login was NOT provisioned: the email ${email} already belongs to a user in another tenant.`);
      } else {
        const linked = await tx.employee.findFirst({
          where: { businessId, userId: existingUser.id, deletedAt: null },
          select: { id: true },
        });
        if (linked) {
          skipUser = true;
          warnings.push(`Operator (console) login was NOT provisioned: the email ${email} is already linked to another employee.`);
        } else {
          reusableUser = existingUser; // same tenant, unlinked → reuse (H2)
        }
      }
    }

    // ── Entity anchor (EmploymentRecord needs one; best-effort). ──
    const entity = await tx.entity.findFirst({
      where: { businessId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const countryCode = input.countryCode !== undefined
      ? input.countryCode
      : await bestEffortCountry(businessId);

    const firstName = String(input?.firstName || '').trim() || email.split('@')[0];
    const lastName = String(input?.lastName || '').trim() || '-';
    const today = toDateOnly(new Date());

    // ── Employee (same EMP- sequence line as lifecycle provisioning). ──
    const code = await allocateCode(tx, {
      businessId, entityId: entity ? entity.id : null, scope: 'EMPLOYEE', prefix: 'EMP-', padding: 6,
    });
    let employee = await tx.employee.create({
      data: {
        businessId,
        code,
        firstName,
        lastName,
        workEmail: email,
        personalEmail: email,
        countryCode: countryCode || null,
        isActive: active !== false,
        status: 'ACTIVE',
        hireDate: today,
        preferredLanguage: 'en',
        scimManaged: scimManaged === true,
        externalId: externalId || null,
      },
    });

    // ── EmploymentRecord (HIRE, current) when the tenant has an entity. ──
    if (entity) {
      let designationId = null;
      if (title) {
        const desig = await tx.designation.findFirst({
          where: { businessId, deletedAt: null, title: { equals: String(title), mode: 'insensitive' } },
          select: { id: true },
        });
        designationId = desig ? desig.id : null;
      }
      const empRec = await tx.employmentRecord.create({
        data: {
          businessId,
          employeeId: employee.id,
          entityId: entity.id,
          departmentId: departmentId || null,
          designationId,
          employmentType: 'FULL_TIME',
          workerCategory: 'STAFF',
          fteRatio: '1.0000',
          effectiveFrom: today,
          changeReason: 'HIRE',
          isCurrent: true,
        },
      });
      employee = await tx.employee.update({
        where: { id: employee.id },
        data: { currentEmploymentRecordId: empRec.id },
      });
    } else {
      warnings.push('No ACTIVE entity exists for this tenant — the employee was created without an employment record.');
    }

    // ── Portal User (operator identity) — mirrors provision STEP 2/H2. ──
    let userId = null;
    const tempPassword = crypto.randomBytes(18).toString('base64url');
    const passwordHash = bcrypt.hashSync(tempPassword, 10);
    const fullName = `${firstName} ${lastName}`.replace(/\s+-$/, '').trim();
    if (!skipUser) {
      if (reusableUser) {
        await tx.user.update({
          where: { id: reusableUser.id },
          data: { name: fullName, role: 'USER', businessId, isActive: active !== false },
        });
        userId = reusableUser.id;
      } else {
        const user = await tx.user.create({
          data: {
            email,
            password: passwordHash,
            name: fullName,
            role: 'USER',
            businessId,
            emailVerified: false,
            isActive: active !== false,
          },
        });
        userId = user.id;
      }
      employee = await tx.employee.update({ where: { id: employee.id }, data: { userId } });
      // Default employee BusinessRole (SELF band) — provision.js's own resolver.
      const resolveRole = getResolveDefaultEmployeeRole();
      if (resolveRole) {
        const role = await resolveRole(tx, businessId);
        if (role) await tx.user.update({ where: { id: userId }, data: { businessRoleId: role.id } });
      }
    }

    // ── Customer ESS identity — provision STEP-2 (M2) semantics. ──
    let customerId = null;
    const existingCustomer = await tx.customer.findUnique({
      where: { businessId_email: { businessId, email } },
      select: { id: true, anonymisedAt: true },
    });
    if (!existingCustomer) {
      const customer = await tx.customer.create({
        data: {
          businessId,
          email,
          password: passwordHash,
          name: fullName,
          emailVerified: false,
          isActive: active !== false,
          hasPassword: false, // provisioned, never chosen — the portal won't demand a "current password"
        },
      });
      customerId = customer.id;
    } else if (existingCustomer.anonymisedAt) {
      // GDPR-anonymised row — NEVER un-anonymise from a provisioning path.
      warnings.push('An anonymised portal account exists for this email; the ESS login was left untouched.');
    } else {
      // Live same-tenant ESS identity → refresh name/active only (no password clobber).
      await tx.customer.update({
        where: { id: existingCustomer.id },
        data: { name: fullName, isActive: active !== false },
      });
      customerId = existingCustomer.id;
    }

    return { employee, userId, customerId, warnings };
  };

  if (prismaOrTx && typeof prismaOrTx.$transaction !== 'function') return run(prismaOrTx);
  return prisma.$transaction(run, { timeout: 60000 });
}

/**
 * setIdentityActive({ businessId, employeeId, active }, prismaOrTx)
 *   -> { employee, changed }
 *
 * active=false → deactivate BOTH portal identities + the Employee (the
 * offboarding-settle access-revoke semantics, WITHOUT a SeparationCase and
 * WITHOUT the terminal TERMINATED status — reversible by design).
 * active=true → reactivate all three (anonymised customers stay untouched).
 */
async function setIdentityActive({ businessId, employeeId, active }, prismaOrTx) {
  if (!businessId || !employeeId) {
    throw new BridgeError('businessId and employeeId are required', { code: 'bad-request', status: 400 });
  }
  const prisma = prismaOrTx || livePrisma;

  const run = async (tx) => {
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, businessId, deletedAt: null },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!employee) throw new BridgeError('Employee not found', { code: 'not-found', status: 404 });

    const want = active !== false;
    const changed = employee.isActive !== want;

    // Same email-linkage set the offboarding settle uses (S8) — no live
    // session may keep resolving after a deactivate.
    const emails = [
      employee.workEmail,
      employee.personalEmail,
      employee.user && employee.user.email,
    ].filter(Boolean);

    if (employee.userId) {
      // NOTE: businessRoleId is intentionally KEPT (settle nulls it) so a
      // SCIM reactivate restores the exact prior console access.
      await tx.user.update({ where: { id: employee.userId }, data: { isActive: want } });
    }
    if (emails.length) {
      await tx.customer.updateMany({
        where: { businessId, email: { in: emails }, anonymisedAt: null },
        data: { isActive: want },
      });
    }
    const updated = await tx.employee.update({
      where: { id: employee.id },
      data: { isActive: want, version: { increment: 1 } },
    });
    return { employee: updated, changed };
  };

  if (prismaOrTx && typeof prismaOrTx.$transaction !== 'function') return run(prismaOrTx);
  return prisma.$transaction(run, { timeout: 30000 });
}

module.exports = { mintEmployeeIdentity, setIdentityActive, BridgeError, _internals: { toDateOnly } };
