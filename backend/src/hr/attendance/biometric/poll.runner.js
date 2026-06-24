'use strict';

/**
 * poll.runner.js — Feature 28 Door 3: the SFTP / folder POLL (cron-driven).
 *
 * A cron tick (scheduler.js) iterates ACTIVE devices with `pollKind` set, pulls new
 * files since `pollCursor` (folder mtime / SFTP listing), and feeds each file through
 * the SAME adapter → RawPunchEvent → materialise path, wrapped in an
 * ImportJob(kind=BIOMETRIC) so the operator gets the same audit + annotated report.
 * `pollCursor` advances only AFTER a file is fully consumed (crash-safe; a re-poll
 * re-reads but the dedupKey makes it a no-op). Tenant-isolated, per-device-failure
 * skipped.
 *
 * Secrets (SFTP key/password) are stored BY REFERENCE in pollConfigJson.keyRef —
 * resolved from the secret store (env / process), NEVER inline in the DB.
 *
 * FOLDER poll uses fs (always available). SFTP poll needs the optional
 * `ssh2-sftp-client` dependency; when it is NOT installed we degrade gracefully (the
 * device is skipped with a clear, operator-visible reason — mirrors how F18 guards
 * the missing `xlsx` dep) rather than crashing the cron. INSTALL `ssh2-sftp-client`
 * to enable SFTP polling in production.
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../../../core/lib/prisma');
const ingest = require('./ingest.service');
const { getAdapter } = require('./adapters');
const csv = require('../../migration/parsers/csv');
const { stripCommentLines } = require('../../migration/imports.service');

// Resolve an SFTP secret BY REFERENCE (never inline). A keyRef of "ENV:FOO" reads
// process.env.FOO; anything else is treated as already-resolved (test injection).
function resolveSecretRef(ref) {
  if (!ref) return null;
  const s = String(ref);
  if (s.startsWith('ENV:')) return process.env[s.slice(4)] || null;
  return s;
}

/** Lazy SFTP client (optional dep). Returns null when the dep isn't installed. */
function loadSftpClient() {
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    return require('ssh2-sftp-client');
  } catch (_e) {
    return null;
  }
}

// ── list new files for a device since its cursor ──
async function listNewFolderFiles(dir, cursorIso) {
  const cursor = cursorIso ? new Date(cursorIso).getTime() : 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { error: `folder unreadable: ${e.message}`, files: [] };
  }
  const files = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!/\.(csv|dat|txt)$/i.test(ent.name)) continue;
    const full = path.join(dir, ent.name);
    const st = fs.statSync(full);
    if (st.mtimeMs > cursor) files.push({ name: ent.name, full, mtimeMs: st.mtimeMs, read: () => fs.readFileSync(full, 'utf8') });
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return { files };
}

async function listNewSftpFiles(device, cfg, cursorIso) {
  const SftpClient = loadSftpClient();
  if (!SftpClient) {
    return { error: 'SFTP polling needs the optional `ssh2-sftp-client` dependency (not installed). Install it or use FOLDER poll.', files: [], depMissing: true };
  }
  const cursor = cursorIso ? new Date(cursorIso).getTime() : 0;
  const client = new SftpClient();
  try {
    await client.connect({
      host: cfg.host, port: cfg.port || 22, username: cfg.user,
      password: resolveSecretRef(cfg.keyRef && cfg.keyRef.startsWith('ENV:PWD') ? cfg.keyRef : null) || undefined,
      privateKey: resolveSecretRef(cfg.keyRef) || undefined,
    });
    const dir = cfg.path || '.';
    const list = await client.list(dir);
    const files = [];
    for (const f of list) {
      if (f.type !== '-') continue;
      if (!/\.(csv|dat|txt)$/i.test(f.name)) continue;
      if (f.modifyTime > cursor) {
        files.push({ name: f.name, mtimeMs: f.modifyTime, read: async () => (await client.get(path.posix.join(dir, f.name))).toString('utf8') });
      }
    }
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    // Eagerly read while connected, then close.
    for (const f of files) { f._content = await f.read(); f.read = () => f._content; }
    return { files, _close: () => client.end() };
  } catch (e) {
    try { await client.end(); } catch (_e) { /* ignore */ }
    return { error: `SFTP error: ${e.message}`, files: [] };
  }
}

/**
 * consumeFileForDevice — parse one pulled file with the device's adapter and ingest
 * it, wrapped in an ImportJob(kind=BIOMETRIC) for the report. Returns the summary.
 */
async function consumeFileForDevice({ businessId, device, fileName, content }) {
  const adapter = getAdapter(device.adapterKey);
  if (!adapter) return { received: 0, error: 1, reason: `no adapter for "${device.adapterKey}"` };

  // Parse: CSV adapters want the parsed rows; .dat/text adapters take the raw string.
  let input = content;
  if (/\.(csv)$/i.test(fileName) || device.adapterKey.endsWith('.csv')) {
    const parsed = csv.parseCsv(stripCommentLines(content));
    input = parsed.rows;
  }
  let normalised = [];
  try { normalised = adapter.parse(input, device) || []; } catch (e) { return { received: 0, error: 1, reason: `parse failed: ${e.message}` }; }

  // Wrap in an ImportJob so the operator sees the batch in Ingest Activity + report.
  const crypto = require('crypto');
  const fileHash = crypto.createHash('sha256').update(`${device.id}|${fileName}|${content}`).digest('hex');
  let job = await prisma.importJob.findFirst({ where: { businessId, kind: 'BIOMETRIC', fileHash, deletedAt: null } });
  if (!job) {
    job = await prisma.importJob.create({
      data: {
        businessId, entityId: device.entityId, kind: 'BIOMETRIC', status: 'COMMITTED',
        fileName, fileKey: `biometric-poll/${businessId}/${device.id}/${fileHash}.csv`, fileHash,
        mimeType: 'text/csv', rowCount: normalised.length, mappingJson: {}, optionsJson: { deviceId: device.id, source: 'POLL' },
        uploadedBy: 'SYSTEM:BIOMETRIC_POLL', committedBy: 'SYSTEM:BIOMETRIC_POLL', committedAt: new Date(),
      },
    });
  }

  const summary = await ingest.ingestBatch({ businessId, device, normalised, importJobId: job.id });
  await prisma.importJob.update({ where: { id: job.id }, data: { committedCount: summary.materialised, skippedCount: summary.duplicate, rowCount: summary.received } });
  return { ...summary, jobId: job.id };
}

/**
 * runPoll({ businessId?, now? }) — the cron entry. For each ACTIVE pollKind device,
 * list new files since pollCursor, consume them in order, advance the cursor only
 * after a file is fully consumed (crash-safe). Tenant-isolated; per-device failures
 * skipped. Returns a summary { devices, files, materialised, duplicate, unmapped,
 * locked, errors }.
 */
async function runPoll({ businessId = null, now = new Date() } = {}) {
  const summary = { devices: 0, files: 0, materialised: 0, duplicate: 0, unmapped: 0, locked: 0, errors: 0 };
  const where = { deletedAt: null, isActive: true, pollKind: { not: null } };
  if (businessId) where.businessId = businessId;
  const devices = await prisma.punchDevice.findMany({ where });

  for (const device of devices) {
    summary.devices += 1;
    try {
      const cfg = device.pollConfigJson || {};
      let listing;
      if (device.pollKind === 'FOLDER') {
        listing = await listNewFolderFiles(cfg.path || cfg.dir || '', device.pollCursor);
      } else if (device.pollKind === 'SFTP') {
        listing = await listNewSftpFiles(device, cfg, device.pollCursor);
      } else {
        continue;
      }
      if (listing.error) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error('[biometric poll]', device.id, listing.error);
        continue;
      }
      for (const f of listing.files) {
        const content = typeof f.read === 'function' ? await f.read() : f._content;
        const r = await consumeFileForDevice({ businessId: device.businessId, device, fileName: f.name, content });
        summary.files += 1;
        summary.materialised += r.materialised || 0;
        summary.duplicate += r.duplicate || 0;
        summary.unmapped += r.unmapped || 0;
        summary.locked += r.locked || 0;
        if (r.error) summary.errors += r.error;
        // Advance the cursor ONLY after the file is fully consumed (crash-safe).
        await prisma.punchDevice.update({ where: { id: device.id }, data: { pollCursor: new Date(f.mtimeMs).toISOString() } });
      }
      if (listing._close) await listing._close();
    } catch (e) {
      summary.errors += 1;
      // eslint-disable-next-line no-console
      console.error('[biometric poll] device', device.id, e.message);
    }
  }
  return summary;
}

module.exports = { runPoll, consumeFileForDevice, _internals: { listNewFolderFiles, resolveSecretRef, loadSftpClient } };
