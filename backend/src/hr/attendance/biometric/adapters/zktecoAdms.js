'use strict';

/**
 * zktecoAdms.js — ZKTeco / eSSL ADMS (PUSH) protocol adapter.
 *
 * Domain (cite): an ADMS terminal POSTs to `/iclock/cdata?SN=<serial>&table=ATTLOG`
 * with a body of TAB-SEPARATED attendance-log lines, one per punch:
 *
 *   PIN \t YYYY-MM-DD HH:MM:SS \t Status \t Verify \t WorkCode \t Reserved...
 *
 * - PIN     = the enroll number (our deviceCode).
 * - DateTime= the device LOCAL wall-clock (no TZ) — passed through verbatim.
 * - Status  = the punch state: 0=check-in, 1=check-out, 2=break-out, 3=break-in,
 *             4=overtime-in, 5=overtime-out. But on a VERY large share of India
 *             installs every row is Status=0 (device not configured for direction),
 *             so the device's default mode is DERIVE and we IGNORE Status unless the
 *             device is explicitly set to TRUST_DEVICE. We still pass Status through
 *             as `rawDirection` so a correctly-configured device keeps its direction.
 *
 * The server is expected to reply with a literal "OK" text body (handled by the
 * route, not here). This adapter only NORMALISES the body lines.
 *
 * INPUT: the raw request body STRING (tab-separated ATTLOG). Tolerates a JSON array
 * of arrays / objects too (some gateways re-wrap). OUTPUT: NormalisedRawEvent[].
 */

const { normalizeLocalTime } = require('./normalizeTime');

// A line that is clearly an OPERLOG / other table (not ATTLOG) is skipped — we only
// ingest attendance punches here.
function parseAttlogString(text) {
  const out = [];
  const lines = String(text).split(/\r\n|\r|\n/);
  for (const line of lines) {
    const t = line.replace(/\s+$/, '');
    if (!t || t.startsWith('#')) continue;
    const cols = t.split('\t');
    // A genuine ATTLOG line has at least PIN + DateTime.
    if (cols.length < 2) continue;
    const pin = String(cols[0]).trim();
    const timeRaw = String(cols[1]).trim();
    if (!pin && !timeRaw) continue;
    const status = cols.length >= 3 ? String(cols[2]).trim() : null;
    out.push({
      deviceCode: pin,
      localTimeRaw: normalizeLocalTime(timeRaw) || timeRaw,
      rawDirection: status, // ZK Status token; only honoured in TRUST_DEVICE mode
      rawPayload: {
        pin,
        dateTime: timeRaw,
        status,
        verify: cols[3] != null ? String(cols[3]).trim() : null,
        workCode: cols[4] != null ? String(cols[4]).trim() : null,
        raw: t,
      },
    });
  }
  return out;
}

function parse(input, _device) {
  if (typeof input === 'string') return parseAttlogString(input);
  // Some PUSH gateways wrap the body — accept { body } or a pre-split array.
  if (input && typeof input.body === 'string') return parseAttlogString(input.body);
  if (Array.isArray(input)) {
    // Array of objects already shaped → tolerate { pin/PIN, dateTime, status }.
    const out = [];
    for (const r of input) {
      const pin = String(r.pin || r.PIN || r.deviceCode || '').trim();
      const timeRaw = String(r.dateTime || r.DateTime || r.localTime || '').trim();
      if (!pin && !timeRaw) continue;
      out.push({
        deviceCode: pin,
        localTimeRaw: normalizeLocalTime(timeRaw) || timeRaw,
        rawDirection: r.status != null ? String(r.status) : (r.Status != null ? String(r.Status) : null),
        rawPayload: { ...r },
      });
    }
    return out;
  }
  return [];
}

module.exports = { parse, _internals: { parseAttlogString } };
