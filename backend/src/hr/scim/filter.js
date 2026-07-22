'use strict';

// SCIM 2.0 filter parsing — the v1 subset (RFC 7644 §3.4.2.2):
//
//   attrPath SP "eq" SP compValue
//
// which is everything Okta / Azure AD / OneLogin actually send to a /Users
// endpoint during provisioning (`userName eq "jane@acme.com"`, plus the
// occasional `externalId eq "…"` / `active eq true`). Anything richer (and/or,
// pr, co, sw, groups) → ScimFilterError, which the controller maps to a 400
// invalidFilter SCIM error. Pure — no I/O.

class ScimFilterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScimFilterError';
  }
}

// attrPath: optional URN prefix (urn:…:2.0:User:userName), dotted sub-attrs.
const FILTER_RE = /^\s*(?<attr>[A-Za-z][\w:.$-]*)\s+(?<op>[A-Za-z]{2})\s+(?<value>"(?:[^"\\]|\\.)*"|true|false|null|[-+]?\d+(?:\.\d+)?)\s*$/;

function stripUrnPrefix(attr) {
  // urn:ietf:params:scim:schemas:core:2.0:User:userName → userName
  const idx = attr.lastIndexOf(':');
  return idx >= 0 ? attr.slice(idx + 1) : attr;
}

function unquote(raw) {
  if (raw.startsWith('"')) {
    // JSON-compatible escaping per the RFC.
    try {
      return JSON.parse(raw);
    } catch {
      throw new ScimFilterError(`Malformed quoted value in filter: ${raw}`);
    }
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const n = Number(raw);
  if (!Number.isNaN(n)) return n;
  throw new ScimFilterError(`Malformed value in filter: ${raw}`);
}

/**
 * parseScimFilter('userName eq "jane@acme.com"')
 *   -> { attribute: 'username', rawAttribute: 'userName', op: 'eq', value: 'jane@acme.com' }
 * Returns null for an empty/absent filter. Throws ScimFilterError otherwise.
 */
function parseScimFilter(filter) {
  if (filter === undefined || filter === null || String(filter).trim() === '') return null;
  const m = FILTER_RE.exec(String(filter));
  if (!m) {
    throw new ScimFilterError(`Unsupported filter syntax: ${filter}. Only 'attribute eq value' is supported.`);
  }
  const op = m.groups.op.toLowerCase();
  if (op !== 'eq') {
    throw new ScimFilterError(`Unsupported filter operator: ${m.groups.op}. Only 'eq' is supported.`);
  }
  const rawAttribute = stripUrnPrefix(m.groups.attr);
  return {
    attribute: rawAttribute.toLowerCase(),
    rawAttribute,
    op,
    value: unquote(m.groups.value),
  };
}

module.exports = { parseScimFilter, ScimFilterError };
