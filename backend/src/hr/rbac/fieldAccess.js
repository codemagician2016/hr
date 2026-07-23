'use strict';

/**
 * fieldAccess.js — Phase 5c field-level permissions (pure, no DB/IO).
 *
 * Generalises the F5 `compVisibility` idea (a role-scoped visibility level for the
 * compensation field-group) to an arbitrary, tenant-authored map of field-GROUPS →
 * access level on the Employee record. It governs what an OPERATOR ROLE may see /
 * edit on OTHER employees, on top of the module-level RBAC:
 *
 *   HIDDEN  — the group's fields are OMITTED from the read (server-side field
 *             omission, exactly like maskCompensation — never a CSS blur) and any
 *             write to them is refused 403.
 *   READ    — visible, but writes to them are refused 403.
 *   WRITE   — full access (the DEFAULT for any group with no rule).
 *
 * FAIL-OPEN CONTRACT: a role with no `fieldAccess` map (the overwhelming default,
 * incl. every existing role) gets WRITE on every group → the read/write paths are
 * byte-for-byte unchanged. A rule only ever RESTRICTS, never grants — so it is safe
 * to configure even on a system role (it cannot escalate privilege, so it does not
 * violate the "system roles are clone-to-edit" permission invariant).
 *
 * The map lives on BusinessRole.fieldAccess (Json) and rides req.user.businessRole
 * (auth.middleware select), so enforcement is a pure function of the request's role.
 */

// The governable field-groups + how they surface on the two admin employee reads
// (GET /employees/:id  and  GET /profile/employees/:id/full — which nest scalars
// under `employee` and name the sub-objects differently, hence responseKeys is a
// list of candidates and only the ones present are acted on).
const FIELD_GROUPS = Object.freeze([
  {
    key: 'personal',
    label: 'Personal & demographic',
    scalars: ['dateOfBirth', 'gender', 'maritalStatus', 'nationality', 'bloodGroup', 'religion',
      'community', 'motherTongue', 'placeOfBirth', 'stateOfBirthCode', 'identificationMark',
      'heightCm', 'weightKg', 'fatherName', 'fatherOccupation', 'motherName', 'motherOccupation',
      'disabilityStatus'],
    writables: ['dateOfBirth', 'gender', 'maritalStatus', 'nationality'],
  },
  {
    key: 'contact',
    label: 'Contact & address',
    scalars: ['personalEmail', 'phone', 'homePhone', 'officePhone', 'addressLine1', 'addressLine2',
      'city', 'stateCode', 'postalCode', 'countryCode', 'preferredLanguage'],
    responseKeys: ['addresses'],
    writables: ['personalEmail', 'workEmail', 'phone', 'addressLine1', 'addressLine2', 'city',
      'stateCode', 'postalCode', 'countryCode', 'preferredLanguage'],
  },
  {
    key: 'identity',
    label: 'Statutory identifiers (PAN / Aadhaar / PF / ESI)',
    responseKeys: ['statutoryProfile', 'statutory'],
    writables: [],
  },
  {
    key: 'bank',
    label: 'Bank account',
    responseKeys: ['bankAccounts', 'bank'],
    writables: [],
  },
  {
    key: 'custom',
    label: 'Custom fields',
    responseKeys: ['customFields'],
    writables: [],
  },
]);

const GROUP_KEYS = Object.freeze(FIELD_GROUPS.map((g) => g.key));
const ACCESS_SET = Object.freeze(new Set(['HIDDEN', 'READ', 'WRITE']));

// Reverse index: writable Employee field → the group that governs it.
const WRITABLE_GROUP = (() => {
  const m = {};
  for (const g of FIELD_GROUPS) for (const f of (g.writables || [])) m[f] = g.key;
  return m;
})();

// The map is stored as Prisma Json (already parsed to an object). Be defensive: a
// string (older row) is parsed; anything non-object → no rules (fail-open).
function resolveMap(viewer) {
  let raw = viewer && viewer.businessRole ? viewer.businessRole.fieldAccess : null;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_e) { raw = null; } }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

function normAccess(v) {
  return ACCESS_SET.has(v) ? v : 'WRITE';
}

// The resolved access for one group under this viewer's role (WRITE when unset).
function accessFor(viewer, groupKey) {
  const map = resolveMap(viewer);
  return map ? normAccess(map[groupKey]) : 'WRITE';
}

// Shortcut used by the custom-fields controller.
function customAccess(viewer) { return accessFor(viewer, 'custom'); }

/**
 * Apply the viewer role's field-access to an employee read payload.
 * FAIL-OPEN: no map → returns the payload unchanged (identity). With a map, returns
 * a shallow clone with HIDDEN groups omitted and a `_fieldAccess` hint attached so
 * the client can render read-only / hidden affordances.
 *
 * @param {Object} payload  the response object
 * @param {Object} viewer   req.user
 * @param {Object} [opts]   { scalarHost } — the key under which scalar fields live
 *        (e.g. 'employee' for the rich profile); omit when scalars are top-level.
 */
function applyFieldAccess(payload, viewer, opts = {}) {
  const map = resolveMap(viewer);
  // Empty map == no rules → return the payload UNCHANGED (byte-for-byte fail-open;
  // the column defaults to "{}", so every existing role hits this path).
  if (!map || Object.keys(map).length === 0 || !payload || typeof payload !== 'object') return payload;
  const out = { ...payload };
  const host = opts.scalarHost;
  const scalarHost = host ? { ...(out[host] || {}) } : out;
  const access = {};
  for (const g of FIELD_GROUPS) {
    const a = normAccess(map[g.key]);
    access[g.key] = a;
    if (a !== 'HIDDEN') continue;
    for (const f of (g.scalars || [])) delete scalarHost[f];
    for (const rk of (g.responseKeys || [])) {
      if (rk in out) out[rk] = Array.isArray(out[rk]) ? [] : null;
    }
  }
  if (host) out[host] = scalarHost;
  out._fieldAccess = access;
  return out;
}

/**
 * First changed key the viewer's role may NOT write (group access READ/HIDDEN), or
 * null when every changed key is writable. FAIL-OPEN: no map → null. Keys outside
 * every governed group (name/org/status/…) are always allowed.
 */
function firstDeniedWrite(viewer, changedKeys) {
  const map = resolveMap(viewer);
  if (!map || Object.keys(map).length === 0) return null;
  for (const k of (changedKeys || [])) {
    const group = WRITABLE_GROUP[k];
    if (!group) continue;
    const a = normAccess(map[group]);
    if (a !== 'WRITE') return { field: k, group, access: a };
  }
  return null;
}

/**
 * Validate a tenant-supplied field-access map. Returns { ok, map, error }.
 * Keys must be known groups; values must be HIDDEN/READ/WRITE. WRITE entries are
 * kept as-is (harmless, and explicit is clearer in the console).
 */
function validateFieldAccessMap(input) {
  if (input == null) return { ok: true, map: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'fieldAccess must be an object of { group: access }' };
  }
  const map = {};
  for (const [k, v] of Object.entries(input)) {
    if (!GROUP_KEYS.includes(k)) return { ok: false, error: `unknown field group "${k}"` };
    if (!ACCESS_SET.has(v)) return { ok: false, error: `access for "${k}" must be one of HIDDEN/READ/WRITE` };
    map[k] = v;
  }
  return { ok: true, map };
}

module.exports = {
  FIELD_GROUPS,
  GROUP_KEYS,
  ACCESS_SET,
  WRITABLE_GROUP,
  resolveMap,
  accessFor,
  customAccess,
  applyFieldAccess,
  firstDeniedWrite,
  validateFieldAccessMap,
  publicGroups: () => FIELD_GROUPS.map((g) => ({ key: g.key, label: g.label })),
};
