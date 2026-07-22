'use strict';

// SCIM 2.0 /Users controller — maps the SCIM core User onto the Employee (+
// its dual portal identities: operator User and ESS Customer).
//
//   GET    /Users            list (filter userName/externalId/active eq, startIndex/count)
//   POST   /Users            create → provisioningBridge.mintEmployeeIdentity
//   GET    /Users/:id        Employee id IS the SCIM id
//   PUT    /Users/:id        full replace (tolerant: provided attrs only)
//   PATCH  /Users/:id        RFC 7644 PatchOp → patch.js reducer
//   DELETE /Users/:id        soft — deprovision (active=false on ALL THREE rows)
//
// Deactivation/reactivation runs through provisioningBridge.setIdentityActive,
// which mirrors the offboarding-settle access-revoke semantics WITHOUT a
// separation case (reversible by design).

const prisma = require('../../core/lib/prisma');
const { resolveApiBaseUrl } = require('../../core/utils/apiBaseUrl');
const { parseScimFilter, ScimFilterError } = require('./filter');
const { applyScimPatch, ScimPatchError, _internals: patchInternals } = require('./patch');
const {
  scimError, listResponse, employeeToScimUser, MAX_RESULTS,
} = require('./envelope');
const { mintEmployeeIdentity, setIdentityActive, BridgeError } = require('./provisioningBridge');

const { coerceBool, primaryEmail } = patchInternals;

function baseUrl() {
  return `${resolveApiBaseUrl()}/scim/v2`;
}

function sendScim(res, status, body) {
  return res.status(status).type('application/scim+json').json(body);
}

function sendErr(res, status, detail, scimType) {
  return sendScim(res, status, scimError(status, detail, scimType));
}

// The include that lets the projection carry `title` without an N+1.
const EMPLOYEE_INCLUDE = {
  employmentRecords: {
    where: { isCurrent: true },
    take: 1,
    select: { id: true, designationId: true, designation: { select: { title: true } } },
  },
};

function titleOf(employee) {
  const rec = employee.employmentRecords && employee.employmentRecords[0];
  return (rec && rec.designation && rec.designation.title) || null;
}

function project(employee, warnings) {
  return employeeToScimUser(employee, { baseUrl: baseUrl(), title: titleOf(employee), warnings });
}

async function loadEmployee(businessId, id) {
  if (!id) return null;
  return prisma.employee.findFirst({
    where: { id, businessId, deletedAt: null },
    include: EMPLOYEE_INCLUDE,
  });
}

// ── GET /Users ──────────────────────────────────────────────────────
async function list(req, res) {
  const { businessId } = req.scim;
  let parsed;
  try {
    parsed = parseScimFilter(req.query.filter);
  } catch (e) {
    if (e instanceof ScimFilterError) return sendErr(res, 400, e.message, 'invalidFilter');
    throw e;
  }

  const where = { businessId, deletedAt: null };
  if (parsed) {
    const value = parsed.value;
    switch (parsed.attribute) {
      case 'username':
      case 'emails.value': {
        const email = String(value || '').toLowerCase();
        where.OR = [{ workEmail: email }, { personalEmail: email }];
        break;
      }
      case 'externalid':
        where.externalId = String(value);
        break;
      case 'active': {
        const b = coerceBool(value);
        if (b === null) return sendErr(res, 400, 'active filter value must be a boolean', 'invalidFilter');
        where.isActive = b;
        break;
      }
      case 'id':
        where.id = String(value);
        break;
      default:
        return sendErr(res, 400, `Unsupported filter attribute: ${parsed.rawAttribute}`, 'invalidFilter');
    }
  }

  const startIndex = Math.max(1, parseInt(req.query.startIndex, 10) || 1);
  const countRaw = req.query.count === undefined ? 100 : parseInt(req.query.count, 10);
  const count = Math.min(MAX_RESULTS, Math.max(0, Number.isNaN(countRaw) ? 100 : countRaw));

  const [totalResults, rows] = await Promise.all([
    prisma.employee.count({ where }),
    count === 0
      ? Promise.resolve([])
      : prisma.employee.findMany({
          where,
          include: EMPLOYEE_INCLUDE,
          orderBy: { createdAt: 'asc' },
          skip: startIndex - 1,
          take: count,
        }),
  ]);

  return sendScim(res, 200, listResponse({
    resources: rows.map((r) => project(r)),
    totalResults,
    startIndex,
    itemsPerPage: rows.length,
  }));
}

// ── GET /Users/:id ──────────────────────────────────────────────────
async function getOne(req, res) {
  const employee = await loadEmployee(req.scim.businessId, req.params.id);
  if (!employee) return sendErr(res, 404, `User ${req.params.id} not found`);
  return sendScim(res, 200, project(employee));
}

// ── POST /Users ─────────────────────────────────────────────────────
async function create(req, res) {
  const { businessId } = req.scim;
  const body = req.body || {};

  const userName = typeof body.userName === 'string' ? body.userName.toLowerCase().trim() : null;
  const email = primaryEmail(body.emails) || (userName && userName.includes('@') ? userName : null);
  if (!email) {
    return sendErr(res, 400, 'A userName (email format) or emails[].value is required', 'invalidValue');
  }
  const active = body.active === undefined ? true : coerceBool(body.active);
  if (active === null) return sendErr(res, 400, 'active must be a boolean', 'invalidValue');

  const name = body.name && typeof body.name === 'object' ? body.name : {};
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  const firstName = (name.givenName && String(name.givenName).trim())
    || displayName.split(/\s+/)[0]
    || email.split('@')[0];
  const lastName = (name.familyName && String(name.familyName).trim())
    || displayName.split(/\s+/).slice(1).join(' ')
    || '';

  let minted;
  try {
    minted = await mintEmployeeIdentity({
      businessId,
      email,
      firstName,
      lastName,
      externalId: body.externalId ? String(body.externalId) : null,
      active,
      scimManaged: true,
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null,
    });
  } catch (e) {
    if (e instanceof BridgeError) {
      const scimType = e.code === 'employee-exists' ? 'uniqueness' : undefined;
      return sendErr(res, e.status, e.message, scimType);
    }
    throw e;
  }

  const employee = await loadEmployee(businessId, minted.employee.id);
  res.set('Location', `${baseUrl()}/Users/${employee.id}`);
  return sendScim(res, 201, project(employee, minted.warnings));
}

// ── Shared field application (PUT full-ish replace + PATCH) ─────────
// `changes`: { active?, givenName?, familyName?, title?, externalId?,
//              userName?, email? } — the patch.js reducer output shape.
async function applyChanges({ businessId, employee, changes }) {
  const warnings = [];
  const data = {};

  if (changes.givenName !== undefined && String(changes.givenName || '').trim()) {
    data.firstName = String(changes.givenName).trim();
  }
  if (changes.familyName !== undefined) {
    data.lastName = String(changes.familyName || '').trim() || '-';
  }
  if (changes.externalId !== undefined) {
    data.externalId = changes.externalId === null ? null : String(changes.externalId);
  }

  // Email / userName move → Employee.workEmail. The operator User's email is
  // NOT renamed (User.email is globally unique across tenants — a rename can
  // collide out-of-tenant; HR does it deliberately from the console instead).
  const newEmail = changes.userName || changes.email || undefined;
  if (newEmail && newEmail !== employee.workEmail) {
    const clash = await prisma.employee.findFirst({
      where: {
        businessId,
        deletedAt: null,
        id: { not: employee.id },
        OR: [{ workEmail: newEmail }, { personalEmail: newEmail }],
      },
      select: { id: true },
    });
    if (clash) {
      const err = new BridgeError(`Another employee already uses the email ${newEmail}`, { code: 'employee-exists', status: 409 });
      throw err;
    }
    data.workEmail = newEmail;
    warnings.push('The employee work email was updated; the operator console login email is unchanged (globally unique) — update it from the DriftHR console if needed.');
  }

  if (Object.keys(data).length) {
    data.version = { increment: 1 };
    await prisma.employee.update({ where: { id: employee.id }, data });
  }

  // title → current EmploymentRecord.designationId (only when a matching
  // Designation exists — SCIM must not invent org structure).
  if (changes.title !== undefined) {
    const rec = employee.employmentRecords && employee.employmentRecords[0];
    if (!rec) {
      warnings.push('title was ignored: the employee has no current employment record.');
    } else if (changes.title === null) {
      await prisma.employmentRecord.update({ where: { id: rec.id }, data: { designationId: null } });
    } else {
      const desig = await prisma.designation.findFirst({
        where: { businessId, deletedAt: null, title: { equals: String(changes.title), mode: 'insensitive' } },
        select: { id: true },
      });
      if (desig) {
        await prisma.employmentRecord.update({ where: { id: rec.id }, data: { designationId: desig.id } });
      } else {
        warnings.push(`title was ignored: no designation named "${changes.title}" exists in this organisation.`);
      }
    }
  }

  // active flip LAST (it touches all three identity rows atomically).
  if (changes.active !== undefined && changes.active !== employee.isActive) {
    await setIdentityActive({ businessId, employeeId: employee.id, active: changes.active });
  }

  return warnings;
}

// ── PUT /Users/:id ──────────────────────────────────────────────────
async function replace(req, res) {
  const { businessId } = req.scim;
  const employee = await loadEmployee(businessId, req.params.id);
  if (!employee) return sendErr(res, 404, `User ${req.params.id} not found`);

  const body = req.body || {};
  const changes = {};
  const name = body.name && typeof body.name === 'object' ? body.name : null;
  if (name && name.givenName !== undefined) changes.givenName = name.givenName;
  if (name && name.familyName !== undefined) changes.familyName = name.familyName;
  if (body.title !== undefined) changes.title = body.title === null ? null : String(body.title);
  if (body.externalId !== undefined) changes.externalId = body.externalId === null ? null : String(body.externalId);
  if (body.active !== undefined) {
    const b = coerceBool(body.active);
    if (b === null) return sendErr(res, 400, 'active must be a boolean', 'invalidValue');
    changes.active = b;
  }
  const email = primaryEmail(body.emails)
    || (typeof body.userName === 'string' && body.userName.includes('@') ? body.userName.toLowerCase().trim() : null);
  if (email) changes.email = email;

  let warnings;
  try {
    warnings = await applyChanges({ businessId, employee, changes });
  } catch (e) {
    if (e instanceof BridgeError) {
      return sendErr(res, e.status, e.message, e.code === 'employee-exists' ? 'uniqueness' : undefined);
    }
    throw e;
  }

  const fresh = await loadEmployee(businessId, employee.id);
  return sendScim(res, 200, project(fresh, warnings.length ? warnings : null));
}

// ── PATCH /Users/:id ────────────────────────────────────────────────
async function patch(req, res) {
  const { businessId } = req.scim;
  const employee = await loadEmployee(businessId, req.params.id);
  if (!employee) return sendErr(res, 404, `User ${req.params.id} not found`);

  let reduced;
  try {
    reduced = applyScimPatch((req.body || {}).Operations);
  } catch (e) {
    if (e instanceof ScimPatchError) return sendErr(res, 400, e.message, 'invalidSyntax');
    throw e;
  }

  let warnings;
  try {
    warnings = await applyChanges({ businessId, employee, changes: reduced.changes });
  } catch (e) {
    if (e instanceof BridgeError) {
      return sendErr(res, e.status, e.message, e.code === 'employee-exists' ? 'uniqueness' : undefined);
    }
    throw e;
  }
  if (reduced.unsupported.length) {
    warnings.push(`Ignored unsupported patch path(s): ${reduced.unsupported.join(', ')}`);
  }

  const fresh = await loadEmployee(businessId, employee.id);
  return sendScim(res, 200, project(fresh, warnings.length ? warnings : null));
}

// ── DELETE /Users/:id — SCIM DELETE = deprovision (soft) ────────────
async function remove(req, res) {
  const { businessId } = req.scim;
  const employee = await loadEmployee(businessId, req.params.id);
  if (!employee) return sendErr(res, 404, `User ${req.params.id} not found`);
  await setIdentityActive({ businessId, employeeId: employee.id, active: false });
  return res.status(204).end();
}

module.exports = { list, getOne, create, replace, patch, remove, _internals: { applyChanges, titleOf } };
