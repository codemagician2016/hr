'use strict';

/**
 * direction.js — PURE direction resolution (Feature 28 §6.2).
 *
 * The §2.1 hard truth: device direction is UNRELIABLE. A large share of India
 * installs log every punch as a generic event (or all as ZK Status=0). So the
 * pipeline cannot trust device direction and must support a DERIVE mode. This
 * module assigns IN / OUT / BREAK_* labels to a set of events for ONE
 * (employee, civil-day) — it does NOT pair them for worked-minutes / OT (that stays
 * in derive.js). It only decides the `punchType` LABEL each AttendancePunch carries.
 *
 * Modes (PunchDevice.directionMode):
 *   - TRUST_DEVICE — map the device's rawDirection token via a per-vendor lookup.
 *     An unmappable token for an event falls that event back to alternation.
 *   - DERIVE (default) — ignore device direction; order events ascending by punchAt
 *     and assign ALTERNATING IN/OUT (1st IN, 2nd OUT, 3rd IN…). An odd final punch
 *     stays IN (an open day → derive.js raises MISSING_PUNCH). De-bounce: two events
 *     within dedupWindowSec collapse — the 2nd is flagged duplicate (not labelled).
 *   - ALL_IN — single-reader entry gate: every punch is IN (OUT inferred downstream
 *     by derive.js's shift-end / next-day logic).
 *
 * Input event shape (the core builds these from RawPunchEvent rows for the day):
 *   { id, punchAtMs:Number, rawDirection:String|null }
 * Output: an ARRAY aligned to the SORTED input, each:
 *   { id, punchType:'IN'|'OUT'|'BREAK_START'|'BREAK_END'|null, duplicate:Boolean }
 * (punchType=null only when duplicate=true — a de-bounced event is not materialised).
 */

// ── Per-vendor TRUST_DEVICE token → PunchType lookups ──
// ZK Status: 0=in,1=out,2=break-out(start),3=break-in(end),4=ot-in,5=ot-out.
const ZK_STATUS = { 0: 'IN', 1: 'OUT', 2: 'BREAK_START', 3: 'BREAK_END', 4: 'IN', 5: 'OUT' };

function mapTrustToken(token) {
  if (token == null) return null;
  const s = String(token).trim();
  if (s === '') return null;
  // Numeric ZK status.
  if (/^\d+$/.test(s)) {
    const t = ZK_STATUS[Number(s)];
    return t || null;
  }
  const u = s.toUpperCase().replace(/[\s._/\\-]+/g, '');
  // eSSL / Cams / Matrix textual tokens.
  if (['IN', 'CIN', 'CHECKIN', 'CHECKEDIN', 'ENTRY', 'DUTYIN', 'DUTYON', 'I'].includes(u)) return 'IN';
  if (['OUT', 'COUT', 'CHECKOUT', 'CHECKEDOUT', 'EXIT', 'DUTYOUT', 'DUTYOFF', 'O'].includes(u)) return 'OUT';
  if (['BREAKSTART', 'BREAKOUT', 'BREAKBEGIN', 'BSTART', 'LUNCHOUT', 'OUTBREAK'].includes(u)) return 'BREAK_START';
  if (['BREAKEND', 'BREAKIN', 'BFINISH', 'BEND', 'LUNCHIN', 'INBREAK'].includes(u)) return 'BREAK_END';
  if (['OVERTIMEIN', 'OTIN'].includes(u)) return 'IN';
  if (['OVERTIMEOUT', 'OTOUT'].includes(u)) return 'OUT';
  // 'AUTOLOG' / 'AUTO' / unknown → null (fall back to alternation for this event).
  return null;
}

/**
 * resolveDayDirections(events, { mode, dedupWindowSec }) → resolution[]
 *
 * `events` need NOT be pre-sorted; the result is aligned to the events SORTED by
 * punchAtMs ascending (stable on id as a tiebreak). The caller maps each result
 * back by `id`.
 */
function resolveDayDirections(events, opts = {}) {
  const mode = opts.mode || 'DERIVE';
  const dedupWindowSec = Number.isFinite(opts.dedupWindowSec) ? opts.dedupWindowSec : 60;
  const dedupMs = Math.max(0, dedupWindowSec) * 1000;

  const sorted = [...(events || [])].sort((a, b) => {
    if (a.punchAtMs !== b.punchAtMs) return a.punchAtMs - b.punchAtMs;
    return String(a.id).localeCompare(String(b.id));
  });

  const out = [];
  // Alternation cursor: next label to assign in DERIVE (and in TRUST when a token
  // is unmappable). true ⇒ next is IN.
  let nextIsIn = true;
  let lastKeptMs = null;

  for (const ev of sorted) {
    // De-bounce: an event within dedupWindowSec of the LAST KEPT event (same
    // employee-day) is a double-tap → duplicate, not materialised. Applies in every
    // mode (a reader double-read is noise regardless of direction handling).
    if (lastKeptMs != null && dedupMs > 0 && (ev.punchAtMs - lastKeptMs) < dedupMs) {
      out.push({ id: ev.id, punchType: null, duplicate: true });
      continue;
    }

    let punchType = null;
    if (mode === 'ALL_IN') {
      punchType = 'IN';
    } else if (mode === 'TRUST_DEVICE') {
      const mapped = mapTrustToken(ev.rawDirection);
      if (mapped) {
        punchType = mapped;
        // A device-asserted IN/OUT also advances the alternation cursor so a later
        // unmappable token continues sensibly.
        if (mapped === 'IN') nextIsIn = false;
        else if (mapped === 'OUT') nextIsIn = true;
      } else {
        // Unmappable token → alternation fallback for THIS event (don't guess wrong).
        punchType = nextIsIn ? 'IN' : 'OUT';
        nextIsIn = !nextIsIn;
      }
    } else {
      // DERIVE — pure alternation.
      punchType = nextIsIn ? 'IN' : 'OUT';
      nextIsIn = !nextIsIn;
    }

    out.push({ id: ev.id, punchType, duplicate: false });
    lastKeptMs = ev.punchAtMs;
  }

  return out;
}

module.exports = { resolveDayDirections, mapTrustToken, _internals: { ZK_STATUS } };
