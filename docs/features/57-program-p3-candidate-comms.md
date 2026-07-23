# Feature 57 — Master Program Phase 3 wave 5: Candidate Communication (ATS polish)

Completes the F12 ATS spine per docs/features/36-candidate-comms.md (all 4
slices). The pipeline was mostly silent; this makes every stage speak, adds an
interview scheduling handshake + a no-login candidate status page, and fixes a
latent bug where interview invites failed the router silently.

## What shipped

### Stage messaging (slice 1) + the latent-bug fix
- 8 new HR templates (HR_CAND_APPLIED/SHORTLISTED/INTERVIEW_INVITE/SLOT_REQUEST/
  REJECTED/OFFER, HR_INTERVIEW_PANEL, HR_INTERVIEW_FEEDBACK_NUDGE) + event keys;
  seedHrTemplates picks them up; tenant copy edited via TenantMessageTemplate
  (the P1.6 override — MessageTemplate.templateKey is globally unique, so a
  direct edit would change copy for every tenant).
- `candidateNotify.fanOutCandidateStage` mirrors approvals/notify.js
  (dispatchOne + HrNotifyDedupe) with a candidate-contact resolver (no
  notifyPrefs); autoSend gate Job.commsConfig ?? Business.candidateCommsConfig
  (default ON for applied/shortlisted/interview_invite/offer, **OFF for
  rejected** — opt-in); dedupe token `CAND_<event>:<appId>:<status>` so a
  bounced stage move never re-messages.
- Wired: publicApply → candidate.applied (+ mints CandidateAccessToken,
  returns trackUrl); moveApplication + bulkApplicationAction → mapped event;
  sendOffer → candidate.offer (also fires the long-dead HR_OFFER_SENT).
- **BUG FIX**: `inviteInterview` referenced `interview_invitation` /
  `interview_panel_notice` — templates that were never registered, so every
  interview invite hit the router's UNKNOWN_TEMPLATE and was silently
  swallowed. Repointed to the real HR_CAND_INTERVIEW_INVITE + HR_INTERVIEW_
  PANEL; buildIcs gained METHOD:REQUEST + ORGANIZER + ATTENDEE so the ICS is a
  real calendar invite.

### Interview scheduling handshake (slice 2)
`InterviewSlotProposal` model. `POST /interviews/:id/propose-slots` (fires
candidate.slot_request with the status link) + `/withdraw-slots`. Public,
token-resolved, rate-limited: `GET .../c/:token/slots/:proposalId` (no panel
identities) + `POST .../confirm` — conditional PROPOSED→CONFIRMED (double-
confirm 409), stamps Interview.scheduledAt, fans the ICS to panel + candidate.
Slot-expiry sweep cron (every 30 min).

### Candidate status page + bulk comms (slice 3)
`CandidateAccessToken` (opaque per-candidate, tenant-scoped). Public
`GET /careers/:slug/c/:token` — friendly timeline (APPLIED→"Application
received", SCREENING→"Under review", … REJECTED→"Not selected this time"),
projection asserts every score/PII/interviewer field is absent.
`POST /applications/bulk-message` reuses bulkApplicationAction's
accessibleJobIds+filter+scope resolution (client can't message out of scope),
audited. Comms-template library CRUD + comms-config endpoints.

### Feedback nudge (slice 4)
Cron (09:10 daily): COMPLETED interviews with un-submitted DRAFT scorecards
past a grace window → nudge each panellist Employee via
HR_INTERVIEW_FEEDBACK_NUDGE (deep link to their scorecard), deduped one per
(interview, panellist, window).

### UI
hr-admin recruiter cockpit: per-candidate Message drawer, propose-slots flow
("Awaiting candidate" → scheduled), bulk "Message N", Settings → Candidate
messages (template editor + auto-send toggles, reject-off note). Public
careers: "Track your application" link + tokenised timeline + slot picker.
ESS: "Feedback pending" badge on interviewer scorecards.

## Manual test (staging)
1. Careers → apply to a public job → thank-you shows "Track your application";
   the timeline shows "Application received".
2. Move the candidate to Screening → they get a shortlisted message; move back
   and forth → no duplicate messages.
3. Recruiter → Propose slots → candidate picks one on the no-login link →
   panel + candidate get a calendar invite; the interview shows scheduled.
4. Settings → Candidate messages → turn reject-messaging ON; a bulk reject now
   messages the filtered set (audited).

## E2E evidence
`qa/e2e/e2e-p3-candcomms.js` on live staging: template list + unknown-token
422, public apply → token, stage-move shortlisted, propose-slots → public
timeline (friendly + no score leak) → slot list → confirm → double-confirm
409, bulk-message, and the interview-invite bug fix (invite now succeeds
through the router). Units: candidateTimeline 42 + candidateNotify 27 +
slots 26 = 95.
