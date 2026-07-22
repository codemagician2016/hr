'use strict';

// SCIM 2.0 PATCH (RFC 7644 §3.5.2) Operations reducer — pure, no I/O.
//
// Reduces a PatchOp Operations array to a flat `changes` object the controller
// applies to the Employee/User/Customer trio:
//
//   { active?, givenName?, familyName?, formatted?, title?, externalId?,
//     userName?, email?, unsupported: [paths…] }
//
// Handles the shapes real IdPs send:
//   - Azure AD: op "Replace"/"Add" (capitalised), boolean-as-string "True"/"False",
//     no-path operations whose value is an object of attr→value pairs.
//   - Okta: path 'active' with real booleans, 'name.givenName', 'emails[type
//     eq "work"].value'.
// Unknown paths are collected in `unsupported` (SCIM servers MAY ignore
// attributes they don't recognise) — never a hard failure. A malformed
// PatchOp (no Operations, unknown op) throws ScimPatchError → 400.

class ScimPatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScimPatchError';
  }
}

function coerceBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return null;
}

function primaryEmail(value) {
  const arr = Array.isArray(value) ? value : [value];
  const objs = arr.filter((e) => e && typeof e === 'object');
  const strs = arr.filter((e) => typeof e === 'string');
  const pick = objs.find((e) => e.primary === true)
    || objs.find((e) => String(e.type || '').toLowerCase() === 'work')
    || objs[0];
  const raw = (pick && pick.value) || strs[0] || null;
  return typeof raw === 'string' && raw.includes('@') ? raw.toLowerCase().trim() : null;
}

function normalisePath(path) {
  // strip the core-User URN prefix + lowercase; keep bracket filters intact.
  let p = String(path || '').trim();
  const urn = 'urn:ietf:params:scim:schemas:core:2.0:User:';
  if (p.toLowerCase().startsWith(urn.toLowerCase())) p = p.slice(urn.length);
  return p.toLowerCase();
}

function assign(changes, key, value) {
  changes[key] = value;
}

function applyValueObject(changes, unsupported, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScimPatchError('A path-less patch operation requires an object value');
  }
  for (const [k, v] of Object.entries(value)) {
    applyOne(changes, unsupported, { op: 'replace', path: k, value: v });
  }
}

function applyOne(changes, unsupported, { op, path, value }) {
  const operation = String(op || '').toLowerCase();
  if (!['add', 'replace', 'remove'].includes(operation)) {
    throw new ScimPatchError(`Unsupported patch op: ${op}`);
  }
  const p = normalisePath(path);

  if (!p) {
    if (operation === 'remove') throw new ScimPatchError('remove requires a path');
    return applyValueObject(changes, unsupported, value);
  }

  const removing = operation === 'remove';

  if (p === 'active') {
    const b = removing ? true : coerceBool(value); // removing `active` = back to default true
    if (b === null) throw new ScimPatchError(`active must be a boolean (got ${JSON.stringify(value)})`);
    return assign(changes, 'active', b);
  }
  if (p === 'name') {
    if (removing) return undefined; // ignore — name is required on our side
    if (value && typeof value === 'object') {
      if (value.givenName !== undefined) assign(changes, 'givenName', value.givenName || null);
      if (value.familyName !== undefined) assign(changes, 'familyName', value.familyName || null);
      if (value.formatted !== undefined) assign(changes, 'formatted', value.formatted || null);
    }
    return undefined;
  }
  if (p === 'name.givenname') return assign(changes, 'givenName', removing ? null : value);
  if (p === 'name.familyname') return assign(changes, 'familyName', removing ? null : value);
  if (p === 'name.formatted') return assign(changes, 'formatted', removing ? null : value);
  if (p === 'displayname') return assign(changes, 'formatted', removing ? null : value);
  if (p === 'title') return assign(changes, 'title', removing ? null : (value == null ? null : String(value)));
  if (p === 'externalid') return assign(changes, 'externalId', removing ? null : (value == null ? null : String(value)));
  if (p === 'username') {
    if (removing) throw new ScimPatchError('userName cannot be removed');
    const email = typeof value === 'string' ? value.toLowerCase().trim() : null;
    if (!email) throw new ScimPatchError('userName must be a string');
    return assign(changes, 'userName', email);
  }
  if (p === 'emails' || /^emails\[.*\](\.value)?$/.test(p)) {
    if (removing) return assign(changes, 'email', null);
    const email = typeof value === 'string' && value.includes('@')
      ? value.toLowerCase().trim()
      : primaryEmail(value);
    if (email) return assign(changes, 'email', email);
    unsupported.push(String(path));
    return undefined;
  }

  unsupported.push(String(path));
  return undefined;
}

/**
 * applyScimPatch(operations) -> { changes, unsupported }
 * Throws ScimPatchError for malformed PatchOps.
 */
function applyScimPatch(operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new ScimPatchError('Operations must be a non-empty array');
  }
  const changes = {};
  const unsupported = [];
  for (const op of operations) {
    if (!op || typeof op !== 'object') throw new ScimPatchError('Each operation must be an object');
    applyOne(changes, unsupported, op);
  }
  return { changes, unsupported };
}

module.exports = { applyScimPatch, ScimPatchError, _internals: { coerceBool, primaryEmail, normalisePath } };
