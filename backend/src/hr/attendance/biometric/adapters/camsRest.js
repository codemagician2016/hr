'use strict';

/**
 * camsRest.js — Cams Biometric Web API (JSON REST webhook) adapter.
 *
 * Domain (cite): Cams Biometric Web API posts JSON attendance logs shaped like:
 *   { EmployeeCode, AttendanceLogTime, AttendanceType }   (one object, or an array,
 *   or { data: [...] } / { logs: [...] }).
 * - EmployeeCode      → deviceCode
 * - AttendanceLogTime → device LOCAL wall-clock (no TZ) → passed through verbatim
 * - AttendanceType    → 'IN' | 'OUT' | 'AutoLog' (AutoLog = unknown direction →
 *                       DERIVE handles it). Passed through as rawDirection.
 *
 * INPUT: a parsed JSON object/array (the push route JSON-parses the body), or a JSON
 * string. OUTPUT: NormalisedRawEvent[].
 */

const { normalizeLocalTime } = require('./normalizeTime');

function get(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
    // case-insensitive fallback
    const found = Object.keys(obj).find((kk) => kk.toLowerCase() === k.toLowerCase());
    if (found && obj[found] != null && String(obj[found]).trim() !== '') return String(obj[found]).trim();
  }
  return null;
}

function oneRecord(r) {
  const deviceCode = get(r, ['EmployeeCode', 'employeeCode', 'EmpCode', 'UserId', 'PIN', 'Code']);
  const timeRaw = get(r, ['AttendanceLogTime', 'attendanceLogTime', 'LogTime', 'PunchTime', 'DateTime', 'Time']);
  if (!deviceCode && !timeRaw) return null;
  const dir = get(r, ['AttendanceType', 'attendanceType', 'Type', 'Direction', 'Status']);
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
    : Array.isArray(body.data) ? body.data
      : Array.isArray(body.logs) ? body.logs
        : Array.isArray(body.records) ? body.records
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
