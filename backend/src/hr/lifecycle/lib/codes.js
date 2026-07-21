'use strict';

/**
 * codes.js — NumberSequence human-code allocator (Feature 4 §3.3).
 *
 * Mints zero-padded human codes (ONB-000123, OFB-000045, …) by atomically
 * incrementing the per-(business, entity, scope) NumberSequence row. MUST be
 * called inside the SAME `$transaction` as the parent insert so the allocated
 * value and the row that uses it commit together (the existing `nextValue`
 * increment pattern, §3.3).
 *
 * The unique key is (businessId, entityId, scope, periodKey); entityId/periodKey
 * are normalized to NULL for tenant-wide, non-resetting sequences. Concurrency:
 * the find-or-create + increment runs under the caller's tx; the
 * @@unique([businessId, entityId, scope, periodKey]) constraint is the backstop
 * against a duplicate create racing in (caller retries on P2002).
 */

const SCOPE_DEFAULTS = Object.freeze({
  ONBOARD: { prefix: 'ONB-', padding: 6 },
  OFFBOARD: { prefix: 'OFB-', padding: 6 },
  // Separation cases (Feature 4 §4.3 / §8 slice 4f) — SEP-000017 etc.
  SEP: { prefix: 'SEP-', padding: 6 },
  // Employee master human codes — EMP-000001 etc. The padding-6 default matches
  // the lifecycle provisionEmployee path (which already mints EMP- codes), so a
  // tenant that never configures a scheme keeps the existing format and the
  // provision tests stay green. The admin CAN override prefix/padding/next-start
  // per tenant via the Employee-number settings page (it edits the
  // (businessId, scope:'EMPLOYEE') NumberSequence row, and allocateCode reads the
  // stored prefix/padding once the row exists). India-first: a custom prefix like
  // "EMP-IN-" with padding 4 ("EMP-IN-0001") is a one-field change.
  EMPLOYEE: { prefix: 'EMP-', padding: 6 },
  // Letters & Communication (Feature 9 §6) — LTR-0001 etc. The caller passes a
  // periodKey (the tax year, e.g. "2026-27") so the sequence resets yearly via
  // the (businessId, entityId, scope, periodKey) NumberSequence row.
  LETTER: { prefix: 'LTR-', padding: 4 },
  // Feature 11 — Reimbursement/Claims + Travel. Claims carry a human reference
  // EXP-0001 (migrated off the legacy read-max nextClaimNumber loop onto this
  // atomic allocator); trips mint a travel id TRV-0001. Padding 4 matches the
  // historical EXP-#### format, so existing EXP-0001..EXP-9999 claims interoperate.
  EXP: { prefix: 'EXP-', padding: 4 },
  TRV: { prefix: 'TRV-', padding: 4 },
  // Cycle 1 — HR Helpdesk tickets carry a human reference HD-000219 (padding 6 to
  // match the schema-doc example). Tenant-wide, non-resetting (periodKey: null).
  HD: { prefix: 'HD-', padding: 6 },
  // Feature 24 — Form 16 TDS certificate numbers. Per-(entity, FY) resetting
  // (periodKey = financialYear). The orchestrator passes an explicit TAN-derived
  // prefix (FORM16/<TAN>/<FY>/) + padding 4 → FORM16/BLRX12345A/2026-27/0001.
  FORM16: { prefix: 'FORM16-', padding: 4 },
});

/**
 * P1.7 — token expansion in the stored prefix/pattern. A tenant prefix may now
 * embed {ENTITY} (entity code), {DEPT} (department code), {YYYY}/{YY} (year):
 * "EMP-{ENTITY}-{YY}-" + padding 4 → "EMP-BLR-26-0042". No tokens → identical
 * output to before (full back-compat). Unresolvable tokens collapse to '' so a
 * code NEVER fails to mint (an employee create must not die on a missing dept).
 */
function expandTokens(prefix, ctx = {}) {
  const year = ctx.year != null ? String(ctx.year) : String(new Date().getUTCFullYear());
  return String(prefix || '')
    .split('{ENTITY}').join(ctx.entityCode || '')
    .split('{DEPT}').join(ctx.deptCode || '')
    .split('{YYYY}').join(year)
    .split('{YY}').join(year.slice(-2));
}

function format(prefix, value, padding, tokenCtx) {
  return `${expandTokens(prefix, tokenCtx)}${String(value).padStart(padding, '0')}`;
}

/**
 * allocateCode(tx, { businessId, entityId?, scope, prefix?, padding?, periodKey? }) -> string
 * Increments the sequence and returns the formatted code. Defaults for the
 * lifecycle scopes (ONBOARD/OFFBOARD) are baked in; pass prefix/padding to override.
 *
 * `periodKey` (Feature 9) selects a resetting sub-sequence — e.g. the tax year
 * "2026-27" for LETTER, so the count resets each year. It defaults to null, so the
 * lifecycle scopes (ONBOARD/OFFBOARD/SEP) that pass no periodKey continue to use the
 * single tenant-wide, non-resetting (…, periodKey: null) row exactly as before.
 */
async function allocateCode(tx, { businessId, entityId = null, scope, prefix, padding, periodKey = null, tokenCtx = null }) {
  if (!tx || !businessId || !scope) {
    throw new Error('allocateCode requires (tx, { businessId, scope })');
  }
  const dflt = SCOPE_DEFAULTS[scope] || {};
  const pfx = prefix != null ? prefix : (dflt.prefix != null ? dflt.prefix : `${scope}-`);
  const pad = padding != null ? padding : (dflt.padding != null ? dflt.padding : 6);

  // Find-or-create the sequence row. periodKey === null → the tenant-wide,
  // non-resetting row (lifecycle scopes); a non-null periodKey → a per-period
  // resetting row (LETTER, keyed on the tax year).
  let seq = await tx.numberSequence.findFirst({
    where: { businessId, entityId, scope, periodKey },
  });
  if (!seq) {
    seq = await tx.numberSequence.create({
      data: { businessId, entityId, scope, prefix: pfx, padding: pad, nextValue: 1, periodKey },
    });
  }

  const value = seq.nextValue;
  await tx.numberSequence.update({
    where: { id: seq.id },
    data: { nextValue: { increment: 1 } },
  });

  return format(seq.prefix || pfx, value, seq.padding || pad, tokenCtx);
}

module.exports = { allocateCode, format, expandTokens, SCOPE_DEFAULTS };
