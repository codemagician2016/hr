'use strict';

/**
 * normalizeTime.js — PURE: coerce the many device timestamp shapes to the ONE
 * canonical local wall-clock string the core resolves via tz.js#zonedWallTimeToUtc:
 *
 *   'YYYY-MM-DD HH:MM:SS'   (24h, NO timezone — it is the SITE's local wall-clock)
 *
 * We deliberately do NOT call `new Date(string)` — that would treat the device's
 * local time as server-local/UTC and shift Indian punches by hours (the §2.1 hard
 * truth). We only RE-FORMAT the digits; the core applies the device-location TZ.
 *
 * Accepts (real-world device exports):
 *   '2026-06-24 09:01:33'      → as-is
 *   '2026-06-24T09:01:33'      → 'T' → space
 *   '2026-06-24 09:01'         → seconds defaulted to :00
 *   '24-06-2026 09:01:33'      → DD-MM-YYYY (eSSL India default) → ISO
 *   '24/06/2026 09:01:33'      → DD/MM/YYYY → ISO
 *   '2026/06/24 09:01:33'      → YYYY/MM/DD → ISO
 *   '24-06-2026 9:01 AM/PM'    → 12h → 24h
 * Returns null on anything unparseable (the core parks the event as ERROR).
 */
function normalizeLocalTime(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Unify the date/time separator.
  s = s.replace('T', ' ').replace(/\s+/g, ' ');

  // Split date and time halves.
  const sp = s.split(' ');
  let datePart = sp[0];
  let timePart = sp.slice(1).join(' ');

  // ── date: detect order ──
  let y, mo, d;
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(datePart))) {
    // YYYY-MM-DD
    y = m[1]; mo = m[2]; d = m[3];
  } else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(datePart))) {
    // DD-MM-YYYY (India device default; we treat the first field as day)
    d = m[1]; mo = m[2]; y = m[3];
  } else {
    return null;
  }
  const mi = Number(mo);
  const di = Number(d);
  if (mi < 1 || mi > 12 || di < 1 || di > 31) return null;

  // ── time: 12h (AM/PM) or 24h; default missing seconds to 00 ──
  let hh = 0; let mm = 0; let ss = 0;
  if (timePart) {
    const ampm = /\b(AM|PM)\b/i.exec(timePart);
    const tm = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(timePart);
    if (!tm) return null;
    hh = Number(tm[1]); mm = Number(tm[2]); ss = tm[3] ? Number(tm[3]) : 0;
    if (ampm) {
      const isPM = /PM/i.test(ampm[1]);
      if (isPM && hh < 12) hh += 12;
      if (!isPM && hh === 12) hh = 0;
    }
    if (hh > 23 || mm > 59 || ss > 59) return null;
  }

  const p2 = (n) => String(n).padStart(2, '0');
  return `${y}-${p2(mi)}-${p2(di)} ${p2(hh)}:${p2(mm)}:${p2(ss)}`;
}

module.exports = { normalizeLocalTime };
