'use strict';

/**
 * profileFieldPolicy.js — Feature 13 §3.4. The per-field GOVERNANCE map: a frozen
 * table in CODE (no migration to retune a field — same philosophy as rbac.js
 * PERMISSIONS). Keyed by a stable `fieldKey` (the string stored in
 * ProfileChangeRequest.field).
 *
 *   policy ∈ 'self-edit'   — employee commits immediately
 *          | 'hr-approval' — FIXED: a change files a ProfileChangeRequest → HR
 *                            approves before it touches the row
 *          | 'read-only'   — HR/lifecycle owns it; ESS only displays
 *   model  — which Prisma model the commit writes to
 *            (employee | bankAccount | statutoryProfile | address | dependant |
 *             emergencyContact | education)
 *   optional:true  — "user may fill or not" (rendered as clearly optional)
 *   sensitive:true — @pii:sensitive; masked for operators lacking full detail,
 *                    returned only on the SELF read otherwise.
 *
 * fieldPolicy(fieldKey) resolves: exact key → wildcard ('address.*') → DEFAULT
 * 'read-only'. FAIL-CLOSED: an unknown field can never be self-edited NOR even
 * change-requested — the server is the sole classifier, so a malicious client cannot
 * smuggle a gated field through a self-edit endpoint (it routes to approval) nor
 * request-change a read-only field (it 400s).
 */

const POLICY = Object.freeze({
  // ── FIXED → HR approval (identity / statutory / money) ──────────────────────
  firstName:            { policy: 'hr-approval', model: 'employee', sensitive: true },
  lastName:             { policy: 'hr-approval', model: 'employee', sensitive: true },
  middleName:           { policy: 'hr-approval', model: 'employee' },
  dateOfBirth:          { policy: 'hr-approval', model: 'employee' },
  gender:               { policy: 'hr-approval', model: 'employee' },
  'bank.accountNumber': { policy: 'hr-approval', model: 'bankAccount' },
  'bank.accountName':   { policy: 'hr-approval', model: 'bankAccount' },
  'bank.ifsc':          { policy: 'hr-approval', model: 'bankAccount' },
  'bank.nzBankAccount': { policy: 'hr-approval', model: 'bankAccount' },
  'bank.bankName':      { policy: 'hr-approval', model: 'bankAccount' },
  'statutory.pan':      { policy: 'hr-approval', model: 'statutoryProfile' },
  'statutory.uan':      { policy: 'hr-approval', model: 'statutoryProfile' },
  'statutory.irdNumber':{ policy: 'hr-approval', model: 'statutoryProfile' },

  // ── FREE self-service ───────────────────────────────────────────────────────
  phone:         { policy: 'self-edit', model: 'employee' },
  homePhone:     { policy: 'self-edit', model: 'employee' },
  officePhone:   { policy: 'self-edit', model: 'employee' },
  personalEmail: { policy: 'self-edit', model: 'employee' },
  maritalStatus: { policy: 'self-edit', model: 'employee' },
  'address.*':   { policy: 'self-edit', model: 'address' },          // correspondence/permanent/office
  'emergency.*': { policy: 'self-edit', model: 'emergencyContact' },
  'education.*': { policy: 'self-edit', model: 'education' },
  'family.*':    { policy: 'self-edit', model: 'dependant' },

  // ── OPTIONAL self-service ("user may fill or not") ──────────────────────────
  religion:           { policy: 'self-edit', model: 'employee', optional: true, sensitive: true },
  community:          { policy: 'self-edit', model: 'employee', optional: true, sensitive: true },
  motherTongue:       { policy: 'self-edit', model: 'employee', optional: true },
  bloodGroup:         { policy: 'self-edit', model: 'employee', optional: true, sensitive: true },
  heightCm:           { policy: 'self-edit', model: 'employee', optional: true },
  weightKg:           { policy: 'self-edit', model: 'employee', optional: true },
  identificationMark: { policy: 'self-edit', model: 'employee', optional: true },
  placeOfBirth:       { policy: 'self-edit', model: 'employee', optional: true },
  stateOfBirthCode:   { policy: 'self-edit', model: 'employee', optional: true },
  nationality:        { policy: 'self-edit', model: 'employee', optional: true },
  fatherName:         { policy: 'self-edit', model: 'employee', optional: true },
  fatherOccupation:   { policy: 'self-edit', model: 'employee', optional: true },
  motherName:         { policy: 'self-edit', model: 'employee', optional: true },
  motherOccupation:   { policy: 'self-edit', model: 'employee', optional: true },

  // ── READ-ONLY (HR/lifecycle owns; ESS displays) ────────────────────────────
  code:                      { policy: 'read-only' },
  workEmail:                 { policy: 'read-only' }, // official email = login identity
  'employment.designation':  { policy: 'read-only' },
  'employment.department':    { policy: 'read-only' },
  'employment.dateOfJoining': { policy: 'read-only' },
  'employment.location':      { policy: 'read-only' },
  manager:                   { policy: 'read-only' },
  status:                    { policy: 'read-only' },
});

const DEFAULT = Object.freeze({ policy: 'read-only' });

// Resolve a fieldKey's policy: exact → wildcard (prefix '.*') → fail-closed read-only.
function fieldPolicy(fieldKey) {
  if (typeof fieldKey !== 'string' || !fieldKey) return DEFAULT;
  if (Object.prototype.hasOwnProperty.call(POLICY, fieldKey)) return POLICY[fieldKey];
  // wildcard: "address.line1" → "address.*"; "emergency.0.phone" → "emergency.*"
  const dot = fieldKey.indexOf('.');
  if (dot > 0) {
    const wild = `${fieldKey.slice(0, dot)}.*`;
    if (Object.prototype.hasOwnProperty.call(POLICY, wild)) return POLICY[wild];
  }
  return DEFAULT;
}

// Convenience predicates used by the write resolver / read shaping.
function isSelfEdit(fieldKey) { return fieldPolicy(fieldKey).policy === 'self-edit'; }
function isHrApproval(fieldKey) { return fieldPolicy(fieldKey).policy === 'hr-approval'; }
function isReadOnly(fieldKey) { return fieldPolicy(fieldKey).policy === 'read-only'; }

// Annotate a value object with its policy, for the sectioned read so the client needs
// ZERO policy guesswork: { value, policy, optional, sensitive }.
function annotate(fieldKey, value) {
  const p = fieldPolicy(fieldKey);
  return { value: value == null ? null : value, policy: p.policy, optional: !!p.optional, sensitive: !!p.sensitive };
}

module.exports = { POLICY, fieldPolicy, isSelfEdit, isHrApproval, isReadOnly, annotate };
