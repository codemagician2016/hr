'use strict';

/**
 * esslCsv.js — eSSL eTimeTrackLite CSV / .dat export adapter (also reused for
 * Mantra / Realtime / Biomax, which ship the same eSSL-compatible layout).
 *
 * Domain (cite): eSSL eTimeTrackLite exports a row of `EnrollNo, DateTime[, …]`;
 * the fixed-width `.dat` variant is `EnrollNo  DateTime  ...` (whitespace-separated).
 * Direction is FREQUENTLY ABSENT on India installs (the device infers it / runs in
 * "auto" mode) — when present it's a token like 'C/In' / 'C/Out' / 'in' / 'out' or a
 * numeric state. We pass the token through verbatim as `rawDirection`; the core's
 * direction resolver (DERIVE by default) decides IN/OUT, so a header-less .dat still
 * works.
 *
 * INPUT: the file door passes the PARSED CSV rows (Array<Record<header,value>>) from
 * the F18 csv parser. We also tolerate a raw string (`.dat` whitespace columns) for
 * robustness. Column names are matched case-insensitively against common aliases so
 * an operator's mapping step is rarely needed.
 *
 * OUTPUT: [{ deviceCode, localTimeRaw, rawDirection, rawPayload }] — one per row.
 * A row that can't yield (code+time) is SKIPPED here only if structurally empty; a
 * malformed-but-present row is still emitted so the core parks it as ERROR (row
 * isolation, §12 #18) rather than silently dropping evidence.
 */

const { normalizeLocalTime } = require('./normalizeTime');

// Header aliases (lowercased) → canonical field.
const CODE_KEYS = ['enrollno', 'enroll no', 'enrollnumber', 'employeecode', 'employee code', 'empcode', 'userid', 'user id', 'pin', 'acno', 'ac-no', 'id', 'code'];
const TIME_KEYS = ['datetime', 'date time', 'punchtime', 'punch time', 'logdate', 'log date', 'time', 'attendancelogtime', 'date/time', 'date'];
const DIR_KEYS = ['direction', 'inout', 'in/out', 'status', 'state', 'mode', 'type', 'verifymode', 'attendancetype', 'c1'];

function pick(row, keys) {
  const lc = {};
  for (const k of Object.keys(row || {})) lc[String(k).trim().toLowerCase()] = row[k];
  for (const want of keys) if (lc[want] != null && String(lc[want]).trim() !== '') return String(lc[want]).trim();
  return null;
}

function parseRowsArray(rows) {
  const out = [];
  for (const row of rows) {
    const deviceCode = pick(row, CODE_KEYS);
    const timeRaw = pick(row, TIME_KEYS);
    // Structurally empty (no code AND no time) — skip; nothing to evidence.
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

// `.dat` fallback: whitespace/tab columns, no header. Heuristic: col0 = enroll-no,
// then a date + time (joined). e.g. "  1042  2026-06-24 09:01:33  0  1".
function parseDatString(text) {
  const out = [];
  const lines = String(text).split(/\r\n|\r|\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const cols = t.split(/[\t,]+|\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cols.length < 2) {
      // single-space columns fallback
      const sp = t.split(/\s+/);
      if (sp.length < 2) continue;
      const code = sp[0];
      const timeRaw = `${sp[1]} ${sp[2] || ''}`.trim();
      out.push({ deviceCode: code, localTimeRaw: normalizeLocalTime(timeRaw) || timeRaw, rawDirection: sp[3] || null, rawPayload: { raw: t } });
      continue;
    }
    const code = cols[0];
    const timeRaw = cols[1];
    out.push({ deviceCode: code, localTimeRaw: normalizeLocalTime(timeRaw) || timeRaw, rawDirection: cols[2] || null, rawPayload: { raw: t } });
  }
  return out;
}

/**
 * parse(input, _device) — input is either the parsed CSV rows array (file door) or a
 * raw `.dat` string. Returns NormalisedRawEvent[].
 */
function parse(input, _device) {
  if (Array.isArray(input)) return parseRowsArray(input);
  if (typeof input === 'string') return parseDatString(input);
  if (input && Array.isArray(input.rows)) return parseRowsArray(input.rows);
  return [];
}

module.exports = { parse, _internals: { pick, parseRowsArray, parseDatString } };
