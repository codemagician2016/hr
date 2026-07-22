'use strict';

// SCIM 2.0 response envelopes + the Employee → SCIM User projection. Pure —
// no I/O; the controller supplies loaded rows and the request base URL.

const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCHEMA_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const SCHEMA_SPC = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';

const MAX_RESULTS = 200;

function toIso(d) {
  if (!d) return undefined;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * scimError(status, detail, scimType?) -> the SCIM error body (RFC 7644 §3.12).
 * `status` is a NUMBER here; serialised as the string the RFC requires.
 */
function scimError(status, detail, scimType) {
  const body = {
    schemas: [SCHEMA_ERROR],
    status: String(status),
    detail: String(detail || 'error'),
  };
  if (scimType) body.scimType = scimType;
  return body;
}

function listResponse({ resources, totalResults, startIndex, itemsPerPage }) {
  return {
    schemas: [SCHEMA_LIST],
    totalResults,
    startIndex,
    itemsPerPage,
    Resources: resources,
  };
}

/**
 * employeeToScimUser(employee, { baseUrl, title, warnings }) — the projection.
 * `employee` is a prisma Employee row (optionally with `user`); `title` is the
 * current designation title when the caller loaded it; `warnings` (create-time
 * email-collision notes etc.) ride a vendor extension + `detail` so IdP admin
 * consoles that surface either see them.
 */
function employeeToScimUser(employee, { baseUrl = '', title = null, warnings = null } = {}) {
  const userName = employee.workEmail || employee.personalEmail || undefined;
  const givenName = employee.firstName || undefined;
  const familyName = employee.lastName && employee.lastName !== '-' ? employee.lastName : undefined;
  const formatted = [givenName, familyName].filter(Boolean).join(' ') || givenName || userName;
  const emails = [];
  if (employee.workEmail) emails.push({ value: employee.workEmail, type: 'work', primary: true });
  if (employee.personalEmail && employee.personalEmail !== employee.workEmail) {
    emails.push({ value: employee.personalEmail, type: 'home', primary: emails.length === 0 });
  }
  const out = {
    schemas: [SCHEMA_USER],
    id: employee.id,
    externalId: employee.externalId || undefined,
    userName,
    name: { givenName, familyName, formatted },
    displayName: formatted,
    active: employee.isActive === true,
    emails: emails.length ? emails : undefined,
    title: title || undefined,
    meta: {
      resourceType: 'User',
      created: toIso(employee.createdAt),
      lastModified: toIso(employee.updatedAt),
      location: baseUrl ? `${baseUrl}/Users/${employee.id}` : undefined,
    },
  };
  if (warnings && warnings.length) {
    out['urn:drifthr:params:scim:warnings'] = warnings;
    out.detail = warnings.join(' ');
  }
  return out;
}

// ── Discovery documents (static; §4 of RFC 7644) ────────────────────
function serviceProviderConfig(baseUrl) {
  return {
    schemas: [SCHEMA_SPC],
    documentationUri: 'https://drifthr.com/docs/scim',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'Bearer token',
        description: 'Long-lived provisioning token minted in DriftHR Settings → SSO & Provisioning',
        primary: true,
      },
    ],
    meta: {
      resourceType: 'ServiceProviderConfig',
      location: baseUrl ? `${baseUrl}/ServiceProviderConfig` : undefined,
    },
  };
}

function resourceTypes(baseUrl) {
  return listResponse({
    totalResults: 1,
    startIndex: 1,
    itemsPerPage: 1,
    resources: [
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'User',
        name: 'User',
        endpoint: '/Users',
        description: 'Employee (with linked portal identities)',
        schema: SCHEMA_USER,
        meta: {
          resourceType: 'ResourceType',
          location: baseUrl ? `${baseUrl}/ResourceTypes/User` : undefined,
        },
      },
    ],
  });
}

function schemasDoc(baseUrl) {
  const attr = (name, type, opts = {}) => ({
    name,
    type,
    multiValued: opts.multiValued === true,
    required: opts.required === true,
    caseExact: false,
    mutability: opts.mutability || 'readWrite',
    returned: 'default',
    uniqueness: opts.uniqueness || 'none',
    ...(opts.subAttributes ? { subAttributes: opts.subAttributes } : {}),
  });
  return listResponse({
    totalResults: 1,
    startIndex: 1,
    itemsPerPage: 1,
    resources: [
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
        id: SCHEMA_USER,
        name: 'User',
        description: 'SCIM core User mapped onto the DriftHR Employee',
        attributes: [
          attr('userName', 'string', { required: true, uniqueness: 'server' }),
          attr('name', 'complex', {
            subAttributes: [attr('givenName', 'string'), attr('familyName', 'string'), attr('formatted', 'string')],
          }),
          attr('active', 'boolean'),
          attr('title', 'string'),
          attr('externalId', 'string'),
          attr('emails', 'complex', {
            multiValued: true,
            subAttributes: [attr('value', 'string'), attr('type', 'string'), attr('primary', 'boolean')],
          }),
        ],
        meta: {
          resourceType: 'Schema',
          location: baseUrl ? `${baseUrl}/Schemas/${SCHEMA_USER}` : undefined,
        },
      },
    ],
  });
}

module.exports = {
  SCHEMA_USER,
  SCHEMA_LIST,
  SCHEMA_ERROR,
  SCHEMA_PATCH,
  MAX_RESULTS,
  scimError,
  listResponse,
  employeeToScimUser,
  serviceProviderConfig,
  resourceTypes,
  schemasDoc,
};
