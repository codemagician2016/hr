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
});

function format(prefix, value, padding) {
  return `${prefix}${String(value).padStart(padding, '0')}`;
}

/**
 * allocateCode(tx, { businessId, entityId?, scope, prefix?, padding? }) -> string
 * Increments the sequence and returns the formatted code. Defaults for the
 * lifecycle scopes (ONBOARD/OFFBOARD) are baked in; pass prefix/padding to override.
 */
async function allocateCode(tx, { businessId, entityId = null, scope, prefix, padding }) {
  if (!tx || !businessId || !scope) {
    throw new Error('allocateCode requires (tx, { businessId, scope })');
  }
  const dflt = SCOPE_DEFAULTS[scope] || {};
  const pfx = prefix != null ? prefix : (dflt.prefix != null ? dflt.prefix : `${scope}-`);
  const pad = padding != null ? padding : (dflt.padding != null ? dflt.padding : 6);

  // Find-or-create the sequence row (tenant-wide, non-resetting → periodKey null).
  let seq = await tx.numberSequence.findFirst({
    where: { businessId, entityId, scope, periodKey: null },
  });
  if (!seq) {
    seq = await tx.numberSequence.create({
      data: { businessId, entityId, scope, prefix: pfx, padding: pad, nextValue: 1 },
    });
  }

  const value = seq.nextValue;
  await tx.numberSequence.update({
    where: { id: seq.id },
    data: { nextValue: { increment: 1 } },
  });

  return format(seq.prefix || pfx, value, seq.padding || pad);
}

module.exports = { allocateCode, format, SCOPE_DEFAULTS };
