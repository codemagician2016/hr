'use strict';

/**
 * adapters/index.js — Feature 28 per-vendor adapter REGISTRY.
 *
 * The ONLY per-vendor code in the feature. Each adapter exports a PURE
 * `parse(input, device) → NormalisedRawEvent[]`, where a NormalisedRawEvent is:
 *
 *   { deviceCode: string, localTimeRaw: 'YYYY-MM-DD HH:MM:SS',
 *     rawDirection: string|null, rawPayload: object }
 *
 * The core ingest service (../ingest.service.js) is the ONLY consumer; it never
 * branches on vendor — it looks up `device.adapterKey` here, calls `.parse`, then
 * does the identical resolve-tz → dedup → map → direction → materialise pipeline
 * for EVERY source. Adding a vendor = drop a new adapter file + one registry entry.
 *
 * `input` is the parsed CSV rows array (file door) for *.csv adapters, OR the raw
 * request body STRING / parsed JSON (push door) for *.adms / *.rest adapters — each
 * adapter documents what it expects. Adapters NEVER touch the DB and NEVER resolve
 * timezones (that's the core's job, via the device's location TZ).
 *
 * Domain sources (cited per-adapter): ZKTeco ADMS/PUSH `/iclock/cdata` ATTLOG
 * (tab-separated PIN/DateTime/Status/Verify); eSSL eTimeTrackLite CSV/.dat export;
 * Cams Biometric Web API; Matrix COSEC event API.
 */

const esslCsv = require('./esslCsv');
const genericCsv = require('./genericCsv');
const zktecoAdms = require('./zktecoAdms');
const camsRest = require('./camsRest');
const matrixCosec = require('./matrixCosec');

// adapterKey → adapter module. The key is stored on PunchDevice.adapterKey.
const REGISTRY = Object.freeze({
  'essl.csv': esslCsv,
  'generic.csv': genericCsv,
  'zkteco.adms': zktecoAdms,
  'cams.rest': camsRest,
  'matrix.cosec': matrixCosec,
  // eSSL-compatible CSV exports — Mantra / Realtime / Biomax all ship the
  // eTimeTrackLite-style (EnrollNo, DateTime[, Direction]) layout, so they reuse
  // the eSSL adapter. A site can still override per-device.
  'mantra.csv': esslCsv,
  'realtime.csv': esslCsv,
  'biomax.csv': esslCsv,
});

// Sensible default adapterKey per vendor (the device form auto-suggests it).
const VENDOR_DEFAULT_ADAPTER = Object.freeze({
  ESSL: 'essl.csv',
  ZKTECO: 'zkteco.adms',
  MATRIX: 'matrix.cosec',
  MANTRA: 'mantra.csv',
  CAMS: 'cams.rest',
  REALTIME: 'realtime.csv',
  BIOMAX: 'biomax.csv',
  GENERIC: 'generic.csv',
});

function getAdapter(adapterKey) {
  return REGISTRY[adapterKey] || null;
}

/** Adapters that consume a pushed body (push door) vs a parsed CSV (file door). */
function isPushAdapter(adapterKey) {
  return /\.(adms|rest|cosec)$/.test(String(adapterKey || ''));
}

module.exports = {
  REGISTRY,
  VENDOR_DEFAULT_ADAPTER,
  getAdapter,
  isPushAdapter,
  adapterKeys: Object.keys(REGISTRY),
};
