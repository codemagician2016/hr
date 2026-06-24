'use strict';

/**
 * matrixCosec.js — Matrix COSEC event API adapter (JSON REST, also CSV export).
 *
 * Domain (cite): Matrix COSEC emits events shaped like:
 *   { UserID, EventDateTime, EventType }   (one object, an array, or { events: [...] }).
 * - UserID        → deviceCode
 * - EventDateTime → device LOCAL wall-clock (no TZ) → passed through verbatim
 * - EventType     → 'IN' / 'OUT' / numeric event code. Passed through as rawDirection.
 *
 * INPUT: parsed JSON object/array (push door) OR a parsed CSV rows array (file door,
 * for a COSEC CSV export). OUTPUT: NormalisedRawEvent[].
 */

const { normalizeLocalTime } = require('./normalizeTime');

function get(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
    const found = Object.keys(obj).find((kk) => kk.toLowerCase() === k.toLowerCase());
    if (found && obj[found] != null && String(obj[found]).trim() !== '') return String(obj[found]).trim();
  }
  return null;
}

function oneRecord(r) {
  const deviceCode = get(r, ['UserID', 'userId', 'UserId', 'EmployeeCode', 'PIN', 'Code']);
  const timeRaw = get(r, ['EventDateTime', 'eventDateTime', 'EventTime', 'DateTime', 'Time']);
  if (!deviceCode && !timeRaw) return null;
  const dir = get(r, ['EventType', 'eventType', 'Type', 'Direction', 'Status', 'EventCode']);
  return {
    deviceCode: deviceCode || '',
    localTimeRaw: normalizeLocalTime(timeRaw) || (timeRaw || ''),
    rawDirection: dir,
    rawPayload: { ...r },
  };
}

function parse(input, _device) {
  let body = input;
  if (typeof input === 'string') {
    try { body = JSON.parse(input); } catch (_e) { return []; }
  }
  if (!body) return [];
  const list = Array.isArray(body)
    ? body
    : Array.isArray(body.events) ? body.events
      : Array.isArray(body.data) ? body.data
        : [body];
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const ev = oneRecord(r);
    if (ev) out.push(ev);
  }
  return out;
}

module.exports = { parse, _internals: { oneRecord } };
