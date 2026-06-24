'use strict';

/**
 * webhook.controller.js — Feature 28 Door 2: the PUSH webhook (ADMS / REST).
 *
 *   POST /api/hr/biometric/ingest/:deviceSerial
 *     Auth:  X-Device-Secret: <shared secret>  (per-device, constant-time verify)
 *     Body:  vendor-native (tab-separated ATTLOG for ZK; JSON for Cams/Matrix) — the
 *            route parses the body as TEXT so the adapter sees the literal payload.
 *     →  resolve device by serial + verify ingestSecretHash (the serial alone is NOT
 *        trusted; the SECRET both authenticates AND disambiguates the tenant);
 *     →  adapter.parse(body, device) → ingest.service.ingestBatch (dedup → map →
 *        direction → materialise → recompute);
 *     →  200 { received, materialised, duplicate, unmapped, locked, error }
 *     →  ZK ADMS expects a literal "OK" text body — we return that for zkteco.adms.
 *
 * Mounted OUTSIDE the operator-JWT `protect` (devices carry no JWT) — like the
 * existing publicV1 / webhooks surface, with its own secret-auth check here.
 * Idempotent by construction (dedupKey) — ZK retries on no-ACK are safe.
 *
 * Security: an unknown serial or a bad/missing secret → 401, and we DO NOT store the
 * unauthenticated body (no RawPunchEvent). A serial that authenticates but is
 * INACTIVE → events parked UNKNOWN_DEVICE for visibility. The per-serial rate limit
 * is applied by the route middleware.
 */

const prisma = require('../../../core/lib/prisma');
const { verifySecret } = require('./deviceSecret');
const { parseWithDevice } = require('./ingest.service');
const ingest = require('./ingest.service');
const { isPushAdapter } = require('./adapters');
const { writeAudit } = require('../../../core/lib/audit');

// Read the raw secret from the device's header (a couple of common spellings) or the
// ZK `?key=` query param some firmwares use.
function readSecret(req) {
  return (
    req.get('X-Device-Secret') ||
    req.get('x-device-secret') ||
    req.get('Authorization')?.replace(/^Bearer\s+/i, '') ||
    (req.query && (req.query.key || req.query.secret)) ||
    null
  );
}

// ZK ADMS firmware expects a plain-text "OK" ACK; everyone else gets JSON.
function ack(res, device, summary) {
  if (device && /\.adms$/.test(device.adapterKey || '')) {
    res.set('Content-Type', 'text/plain');
    return res.status(200).send(`OK: ${summary.materialised}`);
  }
  return res.status(200).json(summary);
}

async function ingestPunch(req, res) {
  const serial = req.params.deviceSerial;
  const presented = readSecret(req);
  if (!serial || !presented) {
    return res.status(401).type('text/plain').send('unauthorized');
  }

  // Resolve the device by serial across tenants; the SECRET disambiguates + auths.
  // We never trust the serial alone (a serial can be cloned). A device with no
  // ingestSecretHash configured can NEVER be pushed to.
  const candidates = await prisma.punchDevice.findMany({
    where: { serialNumber: serial, deletedAt: null, ingestSecretHash: { not: null } },
  });
  const device = candidates.find((d) => verifySecret(presented, d.ingestSecretHash)) || null;
  if (!device) {
    // No raw body stored for an unauthenticated hit (audit line only).
    await writeAudit({ businessId: candidates[0] ? candidates[0].businessId : null, actorId: 'SYSTEM:BIOMETRIC', action: 'biometric.ingest_rejected', entityType: 'PunchDevice', meta: { serial, reason: 'bad-secret-or-unknown-serial' } });
    return res.status(401).type('text/plain').send('unauthorized');
  }

  // Authed-but-inactive → park events UNKNOWN_DEVICE for operator visibility (still
  // landed for the muster-roll trail, never materialised).
  const body = typeof req.body === 'string' ? req.body : (req.body || '');

  const parsed = parseWithDevice(device, body);
  if (parsed.error) {
    await writeAudit({ businessId: device.businessId, actorId: 'SYSTEM:BIOMETRIC', action: 'biometric.ingest_error', entityType: 'PunchDevice', entityId: device.id, meta: { serial, error: parsed.error } });
    return res.status(400).json({ message: parsed.error });
  }

  if (!device.isActive) {
    // Land the raw events as UNKNOWN_DEVICE (visibility), no materialise.
    let parked = 0;
    const business = await prisma.business.findFirst({ where: { id: device.businessId }, select: { timezone: true } });
    const { landed } = await ingest.landRawEvents(prisma, { businessId: device.businessId, device, business, normalised: parsed.events });
    for (const l of landed) {
      if (l.isNew) { await prisma.rawPunchEvent.update({ where: { id: l.row.id }, data: { status: 'UNKNOWN_DEVICE', reason: 'device is deactivated' } }); parked += 1; }
    }
    return ack(res, device, { received: parsed.events.length, materialised: 0, duplicate: 0, unmapped: 0, locked: 0, error: 0, parked });
  }

  const summary = await ingest.ingestBatch({ businessId: device.businessId, device, normalised: parsed.events });
  await writeAudit({ businessId: device.businessId, actorId: 'SYSTEM:BIOMETRIC', action: 'biometric.ingest', entityType: 'PunchDevice', entityId: device.id, meta: { serial, ...summary, tz: undefined } });
  return ack(res, device, { received: summary.received, materialised: summary.materialised, duplicate: summary.duplicate, unmapped: summary.unmapped, locked: summary.locked, error: summary.error });
}

module.exports = { ingestPunch, readSecret, _internals: { isPushAdapter } };
