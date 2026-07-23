'use strict';

/*
 * otPreApproval.unit.test.js — the OT pre-approval GATE math (pure, no DB).
 *
 * The gate: when the resolved OvertimeRule requires pre-approval, credited OT is
 * capped at the day's APPROVED minutes (0 when none); when it does NOT, OT is
 * byte-for-byte unchanged from the pre-feature path. Plain-node, mirrors the
 * latePenalty.unit style:
 *   node backend/src/hr/attendance/__tests__/otPreApproval.unit.test.js
 */

const assert = require('assert');
const { derive, _internals } = require('../derive');
const { authorizedOt } = _internals;

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

// ── the pure helper ───────────────────────────────────────────────────────────
ok('no pre-approval → otRaw unchanged', authorizedOt(120, { requirePreApproval: false, authorizedMin: 30 }) === 120);
ok('flag absent (empty opts) → otRaw unchanged', authorizedOt(120, {}) === 120);
ok('flag absent (no opts) → otRaw unchanged', authorizedOt(120) === 120);
ok('pre-approval, auth < otRaw → capped to auth', authorizedOt(120, { requirePreApproval: true, authorizedMin: 30 }) === 30);
ok('pre-approval, auth >= otRaw → otRaw kept', authorizedOt(120, { requirePreApproval: true, authorizedMin: 200 }) === 120);
ok('pre-approval, none approved (0) → 0', authorizedOt(120, { requirePreApproval: true, authorizedMin: 0 }) === 0);
ok('pre-approval, authorizedMin missing → 0', authorizedOt(120, { requirePreApproval: true }) === 0);
ok('pre-approval, negative authorized → clamped to 0', authorizedOt(120, { requirePreApproval: true, authorizedMin: -50 }) === 0);
ok('zero otRaw stays 0 even with authorization', authorizedOt(0, { requirePreApproval: true, authorizedMin: 100 }) === 0);

// ── through derive.overtime() — real pipeline ─────────────────────────────────
const D = '2026-06-01';
const at = (hhmmss, day = D) => `${day}T${hhmmss}Z`;
const P = (t, a) => ({ punchType: t, punchAt: a });
const sched = (over = {}) => ({
  startTime: '09:00', endTime: '18:00', breakMinutes: 0, graceInMinutes: 10,
  fullDayMinutes: 480, halfDayThresholdMinutes: 240, requireBothPunches: true,
  otEligible: true, dailyOtThresholdMin: 480, ...over,
});
// worked 09:00→19:00 = 600 min, break 0 ⇒ otRaw = 600 − 480 = 120
const punches = [P('IN', at('09:00:00')), P('OUT', at('19:00:00'))];

// GOLDEN — no requirePreApproval on the rule (the historical path).
const golden = derive({ date: D, schedule: sched(), otRule: { weekdayMultiplier: 1.5, roundingMin: 0 }, punches });
ok('golden OT minutes = 120', golden.overtimeMinutes === 120);
ok('golden OT equiv hours = 3.0', golden.otEquivalentHours === 3);

// requirePreApproval EXPLICIT false — must be BYTE-FOR-BYTE identical to the golden,
// even with an authorized-minutes value present in ctx (it must be ignored).
const noReq = derive({
  date: D, schedule: sched(),
  otRule: { weekdayMultiplier: 1.5, roundingMin: 0, requirePreApproval: false },
  punches, otAuthorizedMin: 15,
});
ok('requirePreApproval=false is byte-for-byte vs golden', JSON.stringify(noReq) === JSON.stringify(golden));

// requirePreApproval=true, 45 approved ⇒ capped to 45; equiv = 45×1.5/60 = 1.125
const capped = derive({
  date: D, schedule: sched(),
  otRule: { weekdayMultiplier: 1.5, roundingMin: 0, requirePreApproval: true },
  punches, otAuthorizedMin: 45,
});
ok('pre-approval caps OT minutes to 45', capped.overtimeMinutes === 45);
ok('pre-approval caps OT equiv hours to 1.125', capped.otEquivalentHours === 1.125);

// requirePreApproval=true, NONE approved ⇒ 0 OT
const none = derive({
  date: D, schedule: sched(),
  otRule: { weekdayMultiplier: 1.5, roundingMin: 0, requirePreApproval: true },
  punches, otAuthorizedMin: 0,
});
ok('pre-approval + none approved → 0 OT minutes', none.overtimeMinutes === 0);
ok('pre-approval + none approved → 0 OT equiv hours', none.otEquivalentHours === 0);

// requirePreApproval=true, generous authorization (>= otRaw) ⇒ full OT (uncapped)
const full = derive({
  date: D, schedule: sched(),
  otRule: { weekdayMultiplier: 1.5, roundingMin: 0, requirePreApproval: true },
  punches, otAuthorizedMin: 300,
});
ok('pre-approval, authorization >= otRaw → full 120', full.overtimeMinutes === 120);

// Rounding-order safety: worked 610 ⇒ otRaw 130, rounding 15 ⇒ 135, then cap 100.
// The cap MUST apply AFTER rounding (135→100), not before (130→100→round 105).
const rounded = derive({
  date: D, schedule: sched(),
  otRule: { weekdayMultiplier: 1, roundingMin: 15, requirePreApproval: true },
  punches: [P('IN', at('09:00:00')), P('OUT', at('19:10:00'))],
  otAuthorizedMin: 100,
});
ok('cap applied AFTER rounding never exceeds authorized (610→round135→cap100)', rounded.overtimeMinutes === 100);

// HOLIDAY_WORKED path also honours the gate (otRaw = full worked minutes).
const holidayGated = derive({
  date: D, schedule: sched({ otEligible: true }),
  otRule: { holidayMultiplier: 2, roundingMin: 0, requirePreApproval: true },
  holiday: { isPaid: true },
  punches: [P('IN', at('09:00:00')), P('OUT', at('18:00:00'))], // worked 540
  otAuthorizedMin: 120,
});
ok('holiday-worked OT gated to authorized 120', holidayGated.overtimeMinutes === 120);

console.log(`otPreApproval.unit: ${passed} checks passed`);
