# Feature 53 — Master Program Phase 3 wave 1: Pulse Surveys + eNPS (employee listening)

Implements the build-ready spec docs/features/33-pulse-surveys-enps.md
(slices 1–3 + the §6.3 complement-leak guard). The first Phase-3 "must-have
module": doc existed, code was zero.

## What shipped

### Data model (6 models + 7 enums, mirrors the Announcement engine)
Survey (audience columns identical to Announcement so `engagement/audience.js`
is reused verbatim; anonymous flag + k-floor `minResponsesToShow`; cadence /
windowDays / recurrenceEndsAt), SurveyQuestion (6 types incl. the eNPS driver
flag), SurveyOccurrence (per-run cohorts; `@@unique(surveyId, seq)`),
SurveyResponse + SurveyAnswer (THE ANONYMITY FIREWALL — no employeeId column
value for anonymous ballots, coarse `segmentLabel` NAME snapshot only),
SurveyParticipation (the double-submit ledger: records THAT you answered,
never WHAT — `@@unique(occurrenceId, employeeId)` backstop).

### Anonymity, defence in depth (spec §4)
No identity on content · content/identity split tables · `anonymous` immutable
once any ballot exists (409 ANONYMITY_LOCKED) · k-suppression on EVERY
aggregate incl. totals · complement-leak guard (exactly one suppressed group →
the next-smallest is suppressed too) · single coarse segment dimension,
snapshotted at submit · verbatims behind an explicit ack (400
VERBATIM_ACK_REQUIRED), label-free + crypto-shuffled + ≥k distinct authors.

### Services
- `survey.service.js` — announcement-style audience normalise, question
  validation (exactly one NPS driver for ENPS; scale bounds; options),
  version-locked update, publish → occurrence #1 + invitedCount + idempotent
  invite fan-out (only when live; future-dated go-live opens via the runner),
  tiny-audience publish warning, results/trend/segments/verbatims assembly.
- `surveyResponse.service.js` — the §5.2 firewall submit (window gate →
  audience gate → participation guard → segment snapshot → tx write with
  `employeeId = anonymous ? null : id` → `{receiptToken}` only), ESS list
  (Done/Pending via participations), fill view (out-of-audience = 404, no
  existence leak), dismiss.
- `enps.js` — PURE: classifyNps (9–10/7–8/0–6), computeEnps
  (round(promoterPct − detractorPct), −100…+100), aggregateQuestion per type,
  segmentBreakdown with k + complement guard. **82 unit checks.**
- `pulseScheduleRunner.js` — daily 06:20 cron: close lapsed occurrences,
  spawn next occurrence for recurring surveys (monthly/quarterly anchor-day
  clamped — Jan-31 → Feb-28), go-live invite catch-up for future-dated
  publishes, midpoint reminder to non-responders (skipped at ≥75% response).

### APIs
Operator `/api/hr/surveys` (new `canManageSurveys`, granted like
canManageAnnouncements): CRUD + publish/close/archive + results / trend /
segments / verbatims. ESS `/api/hr/me/engagement/surveys`: list / fill /
submit / dismiss (customer session, subject always server-resolved).
Notifications: `survey.invited` / `survey.reminder` / `survey.closed`
templates (tenant-editable like all templates since P1.6).

### UIs
- hr-admin `/surveys` (nav "Surveys & eNPS"): list; builder (type pills —
  eNPS pre-inserts the locked 0–10 driver; Anonymous card + k control;
  6-type question editor with sections/reorder; the announcements audience
  picker reused; schedule with recurring sentence preview); results dashboard
  (color-banded eNPS gauge, promoter/passive/detractor bars, response-rate
  ring, per-question cards, SVG trend with suppressed gaps, segments table
  with "Insufficient data" rows, ack-gated verbatims). Suppressed tiles all
  carry explanatory tooltips.
- ESS `/surveys` ("Surveys for you", sidebar entry): open pulses with the
  anonymity lock badge + explainer, Pending/Done ✓, closes-in hint, dismiss;
  sectioned fill form (number pills, NPS 0–10, radio/checkbox + Other, text);
  thank-you screen with the participation receipt token.

## Manual test (staging)
1. Surveys & eNPS → New → type eNPS (driver question appears locked) → add a
   text + scale question → audience Everyone → publish (audience-size warning
   if < 5) → ESS /surveys shows it with the lock badge → fill → receipt →
   badge flips Done → second attempt blocked.
2. Results: with < 5 responses everything reads "Insufficient data";
   verbatims tab demands the anonymity acknowledgement first.
3. Try flipping Anonymous on the published survey — blocked
   (ANONYMITY_LOCKED).

## E2E evidence
`qa/e2e/e2e-p3-surveys.js` on live staging: ENPS-driver validation, create +
publish, ESS list → fill view → 422 on missing required → submit through the
firewall (receipt only, no employeeId echo) → double-submit 409 → Done badge,
k-suppressed results at n=1, verbatims ack 400, anonymity-flip 409, close
(leaves ESS list) + archive cleanup. Unit: enps.unit 82/82.
