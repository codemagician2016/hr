'use strict';

/**
 * audit.js — small, reusable, BEST-EFFORT audit-trail writer.
 *
 * writeAudit({ businessId, actorId, action, entityType, entityId, meta })
 *   - Persists one AuditLog row (see prisma/schema.prisma#AuditLog).
 *   - Tenant-scoped via `businessId` (nullable for platform actions).
 *   - NEVER throws into the request path: any DB/validation error is caught
 *     and logged to stderr, then swallowed. A sensitive action must succeed
 *     even if its audit row cannot be written, and an audit failure must not
 *     leak a 500 to the caller. Callers may `await` it (so the row is flushed
 *     before the response) without risking the request, or fire-and-forget.
 *
 * Only the documented sensitive HR actions call this:
 *   payrun.approve, compensation.change, employee.terminate,
 *   branding.change, domain.change, role.change.
 */

const prisma = require('./prisma');

// Coerce `meta` to a JSON-safe plain object. We never want a circular ref,
// a BigInt, or a Prisma Decimal to make the write throw — stringify defensively
// and fall back to a stub so the rest of the row still lands.
function safeMeta(meta) {
  if (meta == null) return undefined;
  try {
    return JSON.parse(
      JSON.stringify(meta, (_k, v) => {
        if (typeof v === 'bigint') return v.toString();
        // Prisma Decimal / Decimal.js render to a string.
        if (v && typeof v === 'object' && typeof v.toFixed === 'function' && typeof v.toNumber === 'function') {
          return v.toString();
        }
        return v;
      })
    );
  } catch (_err) {
    return { _meta: 'unserializable' };
  }
}

/**
 * Write one audit row. Best-effort: resolves to the created row's id on
 * success, or `null` on any failure (never rejects).
 *
 * @param {Object}  p
 * @param {string=} p.businessId  Owning tenant (null/undefined for platform actions).
 * @param {string=} p.actorId     User.id who performed the action.
 * @param {string}  p.action      Verb, e.g. 'payrun.approve'.
 * @param {string}  p.entityType  Target model, e.g. 'PayRun'.
 * @param {string=} p.entityId    Target row id.
 * @param {Object=} p.meta        Structured, non-sensitive context.
 * @returns {Promise<string|null>}
 */
async function writeAudit({ businessId, actorId, action, entityType, entityId, meta } = {}) {
  // An action + entityType are the minimum that make a row meaningful; if a
  // caller forgets them, skip silently rather than persist a useless row.
  if (!action || !entityType) return null;
  try {
    const row = await prisma.auditLog.create({
      data: {
        businessId: businessId || null,
        actorId: actorId || null,
        action: String(action),
        entityType: String(entityType),
        entityId: entityId != null ? String(entityId) : null,
        meta: safeMeta(meta),
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] writeAudit failed (swallowed):', err && err.message ? err.message : err);
    return null;
  }
}

module.exports = { writeAudit, safeMeta };
