'use strict';

/**
 * watchdog.runner.js — Feature 28 §11: stale-device + high-unmapped notifications.
 *
 * A scheduler tick checks each ACTIVE device's lastSeenAt vs expectedSilenceMin; a
 * silent device fires notifyHrEvent('biometric.device_silent') to the tenant's
 * canManageAttendance ops recipients (so a dead gate terminal on payday is caught,
 * not discovered at lock). Reuses notifyHrEvent + usersWithPermission unchanged.
 *
 * Idempotent-per-window: a device that already alerted in the current silence window
 * is not re-alerted until it is seen again (tracked via pollConfigJson.lastAlertAt,
 * a benign provenance field). Tenant-isolated; per-device failures skipped.
 */

const prisma = require('../../../core/lib/prisma');
const { notifyHrEvent } = require('../../integrations/notifications');
const { usersWithPermission } = require('../../approvals/approverResolver');

async function resolveOpsRecipients(businessId, cache) {
  if (cache.has(businessId)) return cache.get(businessId);
  let out = [];
  try {
    const ids = await usersWithPermission(businessId, 'canManageAttendance');
    if (ids.length) {
      const users = await prisma.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true, email: true, name: true } });
      out = users.filter((u) => u.email).map((u) => ({ id: u.id, email: u.email, name: u.name }));
    }
  } catch (_e) { /* best-effort */ }
  cache.set(businessId, out);
  return out;
}

const _bizCache = new Map();
async function bizName(businessId) {
  if (_bizCache.has(businessId)) return _bizCache.get(businessId);
  let name = 'Your organisation';
  try { const b = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } }); if (b && b.name) name = b.name; } catch (_e) { /* default */ }
  _bizCache.set(businessId, name);
  return name;
}

/**
 * runDeviceWatchdog({ businessId?, now? }) — alert on silent devices. A device is
 * "silent" when expectedSilenceMin is set AND (now - lastSeenAt) > expectedSilenceMin
 * (a never-seen device with a configured threshold also alerts once registered).
 */
async function runDeviceWatchdog({ businessId = null, now = new Date() } = {}) {
  const summary = { scanned: 0, silent: 0, alerts: 0, errors: 0 };
  const where = { deletedAt: null, isActive: true, expectedSilenceMin: { not: null } };
  if (businessId) where.businessId = businessId;
  const devices = await prisma.punchDevice.findMany({ where });
  const recipCache = new Map();

  for (const d of devices) {
    summary.scanned += 1;
    try {
      const thresholdMs = (d.expectedSilenceMin || 0) * 60 * 1000;
      const lastSeenMs = d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0;
      const silentForMs = now.getTime() - lastSeenMs;
      if (lastSeenMs && silentForMs <= thresholdMs) continue; // healthy
      if (!lastSeenMs && thresholdMs === 0) continue;

      // De-dup the alert within the current silence window.
      const cfg = d.pollConfigJson || {};
      const lastAlertMs = cfg.__lastSilentAlertAt ? new Date(cfg.__lastSilentAlertAt).getTime() : 0;
      // Re-alert at most once per silence window (don't spam every tick).
      if (lastAlertMs && (now.getTime() - lastAlertMs) < thresholdMs) { summary.silent += 1; continue; }

      summary.silent += 1;
      const recipients = await resolveOpsRecipients(d.businessId, recipCache);
      const biz = await bizName(d.businessId);
      const minutes = lastSeenMs ? Math.round(silentForMs / 60000) : (d.expectedSilenceMin || 0);
      const vars = {
        BIZ: biz, DEVICE: d.name || d.serialNumber || d.id, SITE: d.locationId || d.entityId || '',
        MINUTES: String(minutes), LASTSEEN: d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : 'never',
        LINK: '/settings/attendance/biometric',
      };
      if (recipients.length) {
        for (const r of recipients) {
          await notifyHrEvent({ businessId: d.businessId, event: 'biometric.device_silent', recipientEmail: r.email || undefined, variables: { ...vars, NAME: r.name || 'there' }, triggeredBy: 'HR_BIOMETRIC_DEVICE_SILENT' });
          summary.alerts += 1;
        }
      }
      // Record the alert watermark (benign provenance write; never mutates a punch).
      await prisma.punchDevice.update({ where: { id: d.id }, data: { pollConfigJson: { ...cfg, __lastSilentAlertAt: now.toISOString() } } });
    } catch (e) {
      summary.errors += 1;
      // eslint-disable-next-line no-console
      console.error('[biometric watchdog] device', d.id, e.message);
    }
  }
  return summary;
}

/**
 * notifyHighUnmapped — called by the ingest doors after a batch: if the batch parked
 * > thresholdPct UNMAPPED rows (a likely enroll-no re-numbering or unmapped new
 * joiner), notify the ops recipients. Best-effort; never throws into the ingest path.
 */
async function notifyHighUnmapped({ businessId, device, received, unmapped, thresholdPct = 30 }) {
  try {
    if (!received || received < 5) return; // ignore tiny batches (noise)
    const pct = Math.round((unmapped / received) * 100);
    if (pct < thresholdPct) return;
    const recipients = await resolveOpsRecipients(businessId, new Map());
    const biz = await bizName(businessId);
    const vars = { BIZ: biz, DEVICE: device.name || device.serialNumber || device.id, PCT: String(pct), COUNT: String(unmapped), LINK: '/settings/attendance/biometric' };
    for (const r of recipients) {
      await notifyHrEvent({ businessId, event: 'biometric.high_unmapped', recipientEmail: r.email || undefined, variables: vars, triggeredBy: 'HR_BIOMETRIC_HIGH_UNMAPPED' });
    }
  } catch (_e) { /* best-effort */ }
}

module.exports = { runDeviceWatchdog, notifyHighUnmapped, _internals: { resolveOpsRecipients } };
