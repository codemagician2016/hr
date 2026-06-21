'use strict';

// ECOMMERCE Path B Phase 3b (2026-05-01) — activity-event recorder.
//
// Helper that controllers call to drop an EcomActivityEvent row whenever
// a mutation completes. Drives the Activity Log panel.
//
// Usage from a controller:
//   await logActivity(req, {
//     eventKey: 'inventory.adjusted',
//     area: 'inventory',
//     targetType: 'inventoryStock',
//     targetId: stock.id,
//     targetCode: `${product.name} @ ${location.name}`,
//     locationId: stock.locationId,
//     payload: { delta, reason },
//   });
//
// Failures are swallowed and logged — we never want activity logging to
// fail a real mutation. The activity log is a read-side feature; if it
// drops a row, the audit gap is logged but the user-facing flow succeeds.

const prisma = require('./prisma');

const VALID_AREAS = new Set([
  'orders', 'catalogue', 'inventory', 'customers',
  'finance', 'auth', 'system', 'marketing',
]);

const VALID_SEVERITIES = new Set(['INFO', 'WARNING', 'CRITICAL', 'SECURITY']);
const VALID_OUTCOMES = new Set(['SUCCESS', 'DENIED', 'FAILED']);
const VALID_SOURCES = new Set(['ADMIN', 'CUSTOMER', 'WEBHOOK', 'CRON', 'SYSTEM', 'SUPER_ADMIN']);

/**
 * Record an activity event. Best-effort — never throws.
 *
 * @param {object} req - Express request (used for actor + IP + UA)
 * @param {object} opts
 * @param {string} opts.eventKey - dot.notation, e.g. 'inventory.adjusted'
 * @param {string} opts.area - one of VALID_AREAS
 * @param {string} [opts.severity] - 'INFO' | 'WARNING' | 'CRITICAL' | 'SECURITY'
 * @param {string} [opts.targetType]
 * @param {string} [opts.targetId]
 * @param {string} [opts.targetCode]
 * @param {string} [opts.locationId]
 * @param {string} [opts.message]
 * @param {object} [opts.payload]
 * @param {string} [opts.outcome] - 'SUCCESS' | 'DENIED' | 'FAILED'
 * @param {string} [opts.actorSource] - override req.user (for cron/webhook callers)
 * @param {string} [opts.businessId] - override req.user.businessId (for cron callers)
 */
async function logActivity(req, opts) {
  try {
    const businessId = opts.businessId || req?.user?.businessId || null;
    if (!businessId) return null; // can't scope, skip

    const area = opts.area;
    if (!VALID_AREAS.has(area)) {
      console.warn(`[ecomActivity] invalid area "${area}" — event "${opts.eventKey}" skipped`);
      return null;
    }
    const severity = VALID_SEVERITIES.has(opts.severity) ? opts.severity : 'INFO';
    const outcome = VALID_OUTCOMES.has(opts.outcome) ? opts.outcome : 'SUCCESS';
    const actorSource = VALID_SOURCES.has(opts.actorSource) ? opts.actorSource : 'ADMIN';

    return await prisma.ecomActivityEvent.create({
      data: {
        businessId,
        eventKey: opts.eventKey,
        area,
        severity,
        actorUserId: req?.user?.id || null,
        actorName: req?.user?.name || null,
        actorRole: req?.user?.role || null,
        actorSource,
        targetType: opts.targetType || null,
        targetId: opts.targetId || null,
        targetCode: opts.targetCode || null,
        locationId: opts.locationId || null,
        message: opts.message || null,
        payload: opts.payload || null,
        ipAddress: req?.ip || req?.headers?.['x-forwarded-for'] || null,
        userAgent: req?.headers?.['user-agent'] || null,
        outcome,
      },
    });
  } catch (err) {
    console.error('[ecomActivity] log failed:', err.message, 'event:', opts?.eventKey);
    return null;
  }
}

module.exports = {
  logActivity,
  VALID_AREAS,
  VALID_SEVERITIES,
  VALID_OUTCOMES,
};
