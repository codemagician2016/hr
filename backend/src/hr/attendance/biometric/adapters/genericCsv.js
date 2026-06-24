'use strict';

/**
 * genericCsv.js — DriftHR's own mapped CSV template adapter. The canonical column
 * set the F18 BIOMETRIC import template ships (employeeCode, localTime, direction?).
 * After the operator's column mapping, every row already carries the canonical
 * names, so this adapter is a thin pass-through normaliser. Use this for any device
 * whose export the operator hand-mapped, or for a hand-built test file.
 *
 * INPUT: parsed CSV rows array (already mapped to canonical headers by F18).
 *        { employeeCode, localTime, direction? } per row.
 * OUTPUT: NormalisedRawEvent[].
 */

const { normalizeLocalTime } = require('./normalizeTime');

function pick(row, keys) {
  const lc = {};
  for (const k of Object.keys(row || {})) lc[String(k).trim().toLowerCase()] = row[k];
  for (const want of keys) if (lc[want] != null && String(lc[want]).trim() !== '') return String(lc[want]).trim();
  return null;
}

const CODE_KEYS = ['employeecode', 'employee code', 'devicecode', 'device code', 'code', 'enrollno', 'pin', 'userid'];
const TIME_KEYS = ['localtime', 'local time', 'datetime', 'punchat', 'punch at', 'time', 'date'];
const DIR_KEYS = ['direction', 'inout', 'in/out', 'type', 'status'];

function parseRowsArray(rows) {
  const out = [];
  for (const row of rows) {
    const deviceCode = pick(row, CODE_KEYS);
    const timeRaw = pick(row, TIME_KEYS);
    if (!deviceCode && !timeRaw) continue;
    out.push({
      deviceCode: deviceCode || '',
      localTimeRaw: normalizeLocalTime(timeRaw) || (timeRaw || ''),
      rawDirection: pick(row, DIR_KEYS),
      rawPayload: { ...row },
    });
  }
  return out;
}

function parse(input, _device) {
  if (Array.isArray(input)) return parseRowsArray(input);
  if (input && Array.isArray(input.rows)) return parseRowsArray(input.rows);
  return [];
}

module.exports = { parse, _internals: { parseRowsArray } };
