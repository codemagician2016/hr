# DriftHR MASTER PLAN — the "Fully Custom & Dynamic" Program

**Status: AWAITING OWNER LOCK** · Authored 2026-07-21 by the elite-team audit
(PM · UX Researcher · UI/UX Designer · Software Architect · Full-Stack Engineer · QA Lead).
Method: three very-thorough code audits (core HR/platform · talent/engagement/analytics ·
payroll/hardcode scan) + industry grounding (greytHR/Keka/Darwinbox/Zoho 2026 feature sets).
Every claim below carries file-level evidence in the audit transcripts; the plan is durable
here + in assistant memory (`master-custom-program` memory file) so no session loses it.

---

## 0. Where we already are (context, not work)

Features 39–45 (all LIVE on staging, E2E-verified): face+geo attendance controls ·
multi-tenant employee app + m-hosts · pay-days basis config (calendar/working/26/30) ·
all-India PT/LWF coverage + silent-gap guard · leave full-customisation + reconciliation ·
per-job-level reimbursement + configurable routing. Also fully implemented (audit-confirmed,
better than docs suggested): **performance (cycles/OKR/360/calibration/9-box/competencies),
full ATS + careers portal, LMS, statutory registers, Form16/24Q, GL export (Tally/Zoho/Xero),
6 bank file formats, roles UI with custom roles + data-scope bands, letters/e-sign,
onboarding/offboarding journeys, announcements+celebrations.**

**DOC-ONLY (specs with zero code): pulse surveys/eNPS (doc 33), rewards & recognition
(doc 35), most of candidate comms (doc 36).**

---

## 1. AUDIT — consolidated findings

### 1a. Hardcoded things a client will ask to change (the "bend to client policy" list)

| # | Area | Finding (evidence) |
|---|---|---|
| H1 | **Pay calendar** | Frequency/pay-day/cutoff seed-only — NO route/UI at all (PayCalendar model unused by any controller) |
| H2 | **Payslip branding** | Colors hardcoded in payslipPdf.js:97; TenantBrand logo/colors never read; no per-employee hold; no password PDF |
| H3 | **Salary component authoring** | Admin form exposes ~5 of 20 fields; SLAB method + 27 component kinds un-authorable from UI |
| H4 | **Onboarding/offboarding checklists** | Blueprints hardcoded in lifecycle/templates/seed.js; no template CRUD/UI |
| H5 | **Probation** | 90-day default + eligible-types hardcoded; review task +75d mismatch; NO auto-flip cron; NO confirmation letter |
| H6 | **OT / shift policies** | OvertimeRule has NO write endpoint or UI (multipliers schema-baked); no late-coming penalty rules |
| H7 | **Notification templates** | MessageTemplate is GLOBAL (no businessId) — tenants can't edit any wording; no employee prefs UI (notifyPrefs unwritable) |
| H8 | **Approval engine coverage** | Only 8 of 17 declared modules have consumers — COMPENSATION, LOAN, TIMESHEET, ATTENDANCE_REGULARIZATION, SEPARATION, ASSET, DOCUMENT_SIGN, PAYRUN, OFFER chains save but DON'T enforce (UI admits it) |
| H9 | **Workflow designer** | ChainBuilder edits ONE module-default chain; scoped defs (dept/level/location) have no UI; condition fields fixed at 4 |
| H10 | **Docs/holidays** | DocumentCategory fixed enum; doc-expiry reminder cron missing (type defined, no sender); restricted-holiday elections engine-ready but NO store/ESS screen; IN holiday seed + types hardcoded |
| H11 | **Dropdown drift** | Admin UI hardcodes enum copies that drifted (recruitment page invents TEMPORARY employment type; leave page copies enums) |
| H12 | **Disbursement** | India-only hard-gate; bank picked per-request (no entity default); RTGS floor hardcoded; live payout adapters are TODO stubs |
| H13 | **Multi-country** | REGISTRABLE_HR_COUNTRIES=['IN'] (NZ engine complete but unreachable); org UI India-only; binary INR/NZD fallbacks everywhere; no 3rd-country dispatch abstraction |
| H14 | **Misc constants** | notice-recovery /30 divisor; doc-expiring window; compliance reminder cadence; basicFloorPct 50; letter signatory 'hr@example.com' fallback; travel policy saves currency 'INR' |
| H15 | **RBAC edges** | Permission catalog frozen (OK by design) but compVisibility not editable in roles UI; no field-level permissions |
| H16 | **Review cycles / recruitment** | Cycle STAGE flow fixed enum (scales/templates/weights ARE config); pipeline stages per-job only (no tenant pipeline templates); announcement categories fixed |
| H17 | **Employee number** | Single tenant-wide prefix+padding; no tokens ({DEPT}/{YYYY}) or per-entity schemes |
| H18 | **Custom fields** | NO custom-field capability on any entity (zero EAV/UDF support) |

### 1b. Performance debt (Architect flags — matters at 1,000+ employee tenants)
Payroll compute: ~4 serial DB calls × headcount (N+1 in the hottest path). Attendance nightly
recompute: ~8 findMany × headcount. Silent take:500/1000/10000 caps on list endpoints without
cursors. Batch-prefetch + pagination pass required before enterprise clients.

### 1c. Missing must-have modules (market-grounded)
Surveys/eNPS · Rewards & Recognition · report BUILDER + CSV/XLSX export layer + scheduler +
real dashboards (current: 5 JSON endpoints + static tiles) · **SSO (SAML/OIDC) + SCIM** (zero
today — enterprise blocker) · candidate comms completion (stage auto-emails, self-scheduling,
status page) · feed social layer (reactions/comments/polls) · OT pre-approval + open-shift
claims · non-statutory variable-pay/incentive schemes · loan interest methods
(flat/reducing) · mobile parity (9 ESS modules absent: performance, learning, feed, comp-off,
shifts, helpdesk, FBP, tax proofs, directory/documents) · careers-page CMS · Slack/Teams
channels + richer webhooks + write-scope public API · asset management UI (module enum exists,
unenforced) · helpdesk SLA config.

---

## 2. THE PROGRAM — five phases for lock

Definition of done for EVERY item (QA Lead): configurable from the console (no code for a
client policy change) · live-staging E2E suite green (self-contained, cleanup, the proven
pattern) · feature doc updated · memory updated · committed. No store uploads unless owner
asks. Ship train stays dev→staging; prod only on owner word.

### Phase 1 — "Nothing hardcoded a client will hit" (config-critical) — ~6–8 sessions
The H-list items that block real-client onboarding:
1. **Pay-calendar console** (frequency/pay-day/cutoff/attendance-offset per entity) [H1]
2. **Payslip branding + controls** (TenantBrand colors/logo applied; per-employee hold;
   optional PDF password; groundwork for templates) [H2]
3. **Full salary-component & structure authoring UI** (all calc methods incl. SLAB, all
   kinds, wage/tax flags, floor/cap, GL, payslip order) [H3]
4. **Lifecycle template editor** (onboarding/offboarding task CRUD: owners, offsets,
   blocking, applicability) + probation policy (window/types per tenant) + **auto-flip cron +
   confirmation letter** [H4, H5]
5. **OT & attendance-discipline policies console** (OvertimeRule CRUD UI; late-coming
   penalty rules: N-lates→half-day/deduction with grace) [H6]
6. **Tenant notification center** (per-tenant template overrides; employee prefs ESS/mobile
   screen; per-event channel grid for HR events) [H7]
7. **Sweep the H10/H11/H14/H17 small items**: tenant document types + expiry-reminder cron;
   restricted-holiday election store + ESS screen; enum-driven dropdowns from a /meta
   endpoint; entity default bank format; notice divisor + windows + cadence as settings;
   employee-number tokens + per-entity schemes; compVisibility in roles UI [H10,11,12,14,15,17]

### Phase 2 — Approval platform completion — ~3–4 sessions
1. **Consumers for the 9 unenforced modules** (COMPENSATION, LOAN, TIMESHEET,
   ATTENDANCE_REGULARIZATION, SEPARATION, ASSET, DOCUMENT_SIGN, PAYRUN, OFFER) so every
   configured chain actually enforces [H8]
2. **Scoped-workflow designer** (multi-definition per module; dept/grade/location scopes;
   priority ordering; preview) — the POLICY_BOUND + ctx plumbing from F44/45 is ready [H9]
3. Condition-field extension + approver-type extension points

### Phase 3 — Missing must-have modules — ~8–10 sessions
1. **Pulse surveys + eNPS** (doc 33 exists as spec — build it: schedules, anonymity floors,
   drivers, trends)
2. **Rewards & Recognition** (doc 35: kudos/points/badges/awards/leaderboard/redemption)
3. **Reports & analytics platform**: generic export layer (CSV/XLSX on every list),
   report builder over frozen facts, scheduler (emailed reports), admin dashboards with real
   charts (attrition/OT/comp/leave liability)
4. **SSO + SCIM** (SAML/OIDC for operators + ESS; SCIM provisioning) — enterprise gate
5. **Candidate comms completion** (stage auto-emails, interview self-scheduling handshake,
   candidate status page, feedback nudges) [doc 36]
6. Feed social layer (reactions/comments/polls) + announcement categories tenant-defined

### Phase 4 — Mobile parity + workforce extras — ~4–5 sessions
1. Mobile: performance/goals, learning, feed, comp-off, shifts, helpdesk, FBP, tax proofs,
   directory/documents (m-hosts get everything free)
2. OT pre-approval workflow + open-shift posting/claim
3. Careers-page CMS (banner/copy/branding) + reusable pipeline templates
4. Variable-pay scheme engine (non-statutory bonus/incentive/commission) + loan interest
   methods (flat/reducing)

### Phase 5 — Platform hardening & scale — ~4–6 sessions
1. **Custom fields** (tenant-defined fields on Employee first, then claims/candidates) [H18]
2. **Field-level permissions** (sensitive-field ACLs beyond comp bands)
3. **Multi-country abstraction**: unlock NZ end-to-end (it's built!), statutory-engine
   dispatch + currency plumbing for country #3, org UI country/currency from capabilities
4. **Performance pass**: batch-prefetch payroll + attendance recompute, cursor pagination on
   capped lists, live payout adapters (Razorpay/Cashfree) off TODO
5. Final program audit: fresh hardcode scan (target: zero client-facing constants), full
   regression E2E across all suites, bug-fix sweep — the closing audit the owner asked for

**Total: ~25–33 working sessions.** Recommended lock order: 1 → 2 → 3 → 4 → 5.
Phases 1–2 make every EXISTING feature bend to client policy; 3–4 close the market gaps;
5 makes it enterprise-grade. Items can be trimmed/reordered at lock.

---

## 3. Working agreement (how the team keeps quality + memory)

- Audit-agent → backend (lead) → UI-agent with verified contracts → full staging ship →
  self-contained live E2E (unique sandbox tags, cleanup, ~26s login spacing) → commit with
  E2E results in the message. (The loop that shipped 39–45.)
- **Memory protocol**: `master-custom-program` memory = program state (phase, item,
  next step) updated EVERY session; per-feature memories for durable gotchas; feature docs in
  docs/features/NN. A fresh session resumes from memory + this doc alone.
- Playbook/QA-portal stays RETIRED; manual QA checklists live in each feature doc.
- No prod deploys, no store uploads without explicit owner instruction.
