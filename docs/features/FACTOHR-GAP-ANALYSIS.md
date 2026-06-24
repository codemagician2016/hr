# DriftHR vs factoHR — Gap & Maturity Roadmap

> **Purpose.** Honest, prioritized read of where DriftHR stands against factoHR (and the Indian peer set: greytHR, Keka, Darwinbox) across the full HRMS/payroll surface. Two distinct work-streams: (A) **close parity** on missing modules, (B) **deepen** what we already have so it survives a real demo and an RFP.
>
> **Verdict in one line.** Our *engines* are enterprise-grade (payroll statutory, attendance derivation, approvals, ATS, performance, lifecycle). Our *gaps* cluster in three places: **employee-facing engagement surfaces** (helpdesk, announcements, surveys, R&R, LMS), **last-mile wiring** of strong backends that never reach the user (loans→payroll, geofence, SLA cron, notifications, asset UI), and **India year-end/proof statutory** (Form 16, investment-proof workflow, FBP). The cheapest wins are wiring, not building.
>
> _Author: Head of Product · Date: 2026-06-24 · Source: 5 domain analyses (factoHR/peer vs current state)._

---

## 1. Module Maturity Scorecard (at a glance)

Rating key: **STRONG** = competitive, demo-ready · **OK** = works but shallow/partial · **SHALLOW** = stub/dead-schema/scaffold · **MISSING** = absent.

| Module | Rating | Headline gap |
|---|---|---|
| **Employee master / 360 profile** | STRONG | No admin-defined **custom fields** (frozen code table) |
| **Effective-dated job history** | STRONG | — (enterprise temporal model; ahead of peers) |
| **Org & reporting tree** | STRONG | No master **export** (Excel/CSV) |
| **Multi-entity / multi-location** | STRONG | — (India group-co + branch PT modeled) |
| **Profile field governance** | STRONG | Engine is the foundation for custom fields but not yet extended to them |
| **Onboarding / pre-boarding** | STRONG | Asset auto-allocation + welcome feed not wired into journey |
| **Exit / Full & Final** | STRONG | Exit interview is a freeform JSON blob (no structured survey) |
| **Documents repository** | STRONG | — (SHA-256, expiry, visibility, e-sign) |
| **Letters & templates** | STRONG | — (versioned merge, letterhead PDF, register) |
| **Built-in e-sign** | OK | No Aadhaar eSign / DSC for legally-stronger contracts |
| **Asset management** | OK | **No UI**, no acknowledgement, no onboarding auto-allocation |
| **Employee directory** | OK (admin) / SHALLOW (ESS) | ESS directory is team-scoped only; no company-wide grid |
| **Manager self-service** | STRONG | — |
| **Bulk import / migration** | OK | Import only — **no export** |
| **Mobile ESS app** | SHALLOW | 6-screen Expo scaffold, not built/published, no geo/push |
| **Custom fields** | MISSING | Tenants cannot add org-specific fields without a migration |
| **HR helpdesk / ticketing** | MISSING (dead schema) | Full model exists, **zero** controller/route/UI |
| **Announcements / news feed** | MISSING | No model/route/UI — ESS home feels empty |
| **Surveys / pulse / eNPS** | MISSING | No survey primitive anywhere |
| **Celebration feed** | MISSING | DOB/hireDate stored, no feed |
| **Salary structure / CTC builder** | STRONG | — (reverse-derivation + fixed-point convergence) |
| **Pay calendars / run types** | STRONG | No employee→**pay-group** assignment within an entity |
| **Payroll run + maker-checker** | STRONG | — |
| **Payslip PDF / ESS publish** | STRONG | — |
| **EPF/ESI/PT/TDS/Code-on-Wages** | STRONG | — (golden-tested, effective-dated; genuinely strong) |
| **ECR/ESIC/24Q file generation** | STRONG | Stops at download — no portal push / challan |
| **Statutory remittance tracking** | OK | challanRef/paidDate never driven by a flow; no reminders |
| **Annual IT projection** | STRONG | — (HRA, Ch VI-A, Rule-3 perquisites) |
| **IT declaration** | SHALLOW | **No proof upload / HR verify / window lock** (§201 exposure) |
| **Salary revision / arrears** | OK | Arrears are manual input items — no auto-arrear engine |
| **Reimbursement-in-payroll** | OK | Not auto-pulled from approved ExpenseClaims |
| **Loans & advances** | OK (orphaned) | **Never deducts from payslip** — payRunId never written |
| **Gratuity** | STRONG | — |
| **Statutory Bonus (Bonus Act)** | MISSING | Only a PayRunType label; no computation/register |
| **Flexi Benefit Plan (FBP)** | MISSING | Cannot model the most common India CTC structures |
| **Form 16 (Part A+B)** | MISSING | Most-expected India year-end deliverable we lack |
| **Labour Welfare Fund (LWF)** | MISSING | Payslips in LWF states are statutorily incomplete |
| **Statutory registers / returns** | MISSING | No Form 5/10/3A/6A, PT/LWF returns, salary register |
| **Web punch + attendance derive** | STRONG | — (TZ-correct, night-shift, golden-tested) |
| **Shift master + assignment** | OK | One-at-a-time only — **no rosters/rotation/swap** |
| **Overtime policy engine** | OK | No OT approval gate (auto-credits without sign-off) |
| **Regularization workflow** | STRONG | — |
| **Holiday calendar** | OK | Restricted-holiday opt-in plumbed but no endpoint |
| **Leave types / accrual / apply** | STRONG | — (pure engines, ledger, FY-roll cron) |
| **Leave encashment** | OK | FnF only — no in-service encashment request |
| **Comp-off** | SHALLOW | No earn→credit→apply lifecycle; no balance to draw |
| **Geofence / GPS punch** | SHALLOW (dead code) | Fields + flag exist; service never enforces |
| **Biometric device integration** | MISSING | CSV import only; no live ESSL/ZKTeco/Matrix sync |
| **Face / selfie attendance** | MISSING | selfieUrl column never written |
| **Attendance/leave registers** | MISSING | No muster roll / Form 25 / OT register / exports |
| **Nightly attendance sweep** | MISSING | Absent days never materialize without an event |
| **ATS pipeline / scorecards / merit** | STRONG | — (screening, knockout, weighted merit) |
| **Careers page + public apply** | OK | — |
| **Offer mgmt + e-sign + handoff** | STRONG | Multi-level offer approval not wired to F10 engine |
| **Appraisal cycles / state machine** | STRONG | Cadence reminders/escalations operator-driven |
| **Goals / KRA / OKR** | STRONG | — |
| **360 feedback** | OK | Peer-only; no upward/subordinate nomination + threshold |
| **Calibration / normalization** | STRONG | — |
| **Merit → comp hand-off** | STRONG | — |
| **Competency framework** | SHALLOW | Only a weight % + free-text; no library/anchors/mapping |
| **9-box grid** | MISSING | No potential axis |
| **PIP** | SHALLOW | Freeform JSON blob, no lifecycle |
| **LMS / training** | MISSING | Entire domain absent (POSH/induction risk) |
| **Engagement surveys / eNPS** | MISSING | No listening at all |
| **Rewards & Recognition** | MISSING | No kudos/badges/points |
| **Succession / HiPo** | MISSING | No talent map |
| **Referral / agency / job-board** | MISSING | Enum values exist; no portals/syndication |
| **Candidate communication** | MISSING | No templated shortlist/reject/schedule comms |
| **Approval engine (no-code)** | STRONG | — (parallel, conditional, SoD, versioned) |
| **SLA escalation / delegation** | OK (dead in prod) | **sweepEscalations never scheduled** — SLA never fires |
| **Expense / travel policy engine** | STRONG | — (grade×city caps, immutable snapshot) |
| **Receipt handling** | SHALLOW | URL presence check only; no OCR |
| **Multi-channel notifications** | OK (2 events) | Router/providers exist; only 2 events fan out — rest IN_APP |
| **HR analytics / reports** | OK | 4 fixed JSON reports, no charts, **no export** |
| **Custom report builder** | MISSING | No field-picker / save / schedule / Excel |
| **Compliance calendar** | MISSING | Files generated on-demand; no due-date dashboard/reminders |
| **Audit log** | OK | Rows written; no unified cross-module viewer |

---

## 2. What factoHR Has That We Don't (parity gaps)

Grouped by domain. **Severity** = buyer/compliance impact. **Effort** = S (days) / M (1–2 weeks) / L (3+ weeks).

### A. Employee engagement & ESS surfaces (the "feels empty" cluster)
| Gap | Severity | Effort | Note |
|---|---|---|---|
| **HR Helpdesk / ticketing** | HIGH | **M** | *Highest-leverage gap.* Full schema (Category/Ticket/Message, SLA, priority, assignee, satisfaction) already designed and **orphaned** — only service+routes+UI remain. Most cost already paid. |
| **Announcements / company news feed** | HIGH | M | Home-screen engagement surface every Indian HRMS ships (org/dept/location targeting + acknowledgement). We have nothing. Most visible empty-ESS gap. |
| **Engagement / pulse surveys + eNPS** | HIGH | M | No listening primitive. Anonymity-threshold + manager heatmaps are the differentiators; feeds attrition narratives that close deals. Also unlocks structured exit interviews. |
| **Rewards & Recognition (kudos/badges/points)** | MEDIUM | M | Daily-visible stickiness driver. Praise wall + points/redemption is the common ask. |
| **Company-wide ESS directory** | MEDIUM | S | Today team-scoped only. Admin list query exists — needs a tenant-wide, comp-masked endpoint + filters + grid UI. |
| **Celebration feed (birthday/anniversary/new-joiner)** | LOW | S | Data already present (DOB/hireDate). High warmth, low cost; bundle with announcements. |

### B. India statutory & payroll (year-end + last-mile)
| Gap | Severity | Effort | Note |
|---|---|---|---|
| **Investment-proof submission + HR verification + window lock** | HIGH | L | We persist only a self-declared provisional figure. **§201 employer liability** if deductions granted on unverified declarations. Needs TaxProofSubmission model, upload/review endpoints, declaration/proof window hard-locks. |
| **Form 16 (Part A + Part B) + bulk sign/distribute** | HIGH | L | Most-expected India year-end deliverable. Build Part-B on the same annual aggregation already powering 24Q Annexure II + projectAnnualIncomeTax; bulk-sign/distribute via existing letters+e-sign pipeline. |
| **Flexi Benefit Plan (FBP)** | HIGH | L | Cannot model the most common India CTC structures or their §10 exemptions without a flexi basket + bill-backed claim. |
| **Loan/advance recovery wired into pay run** | HIGH | M | *Feature is non-functional end-to-end.* LoanInstallment.payRunId never written; engine has no loan-deduction path. Approved/disbursed loans never deduct. Pure wiring. |
| **Statutory Bonus (Bonus Act 8.33–20%)** | MEDIUM | M | Only a PayRunType. No computation (₹21k eligibility, ₹7k/min-wage ceiling, set-on/set-off) and no Form C/D register. |
| **Labour Welfare Fund (LWF)** | MEDIUM | M | Standard deduction in ~16 states. RegistrationKind.LWF exists; add an LWF pillar to compute() following the PT pattern (per-state effective-dated EE+ER, half-yearly/annual). |
| **Auto-arrear engine for back-dated revisions** | MEDIUM | M | Replay computePayslip per affected closed period at new structure, diff vs paid, auto-book ARREAR with statutory re-incidence. Today HR hand-calculates the rupee figure. |
| **Reimbursement auto-pull from approved claims** | MEDIUM | M | ExpenseClaim + REIMBURSEMENT engine category both exist but disconnected. "Pay via payroll" action carrying taxable/exempt flag. |
| **TDS challan (ITNS-281/CRN) + portal e-filing push** | MEDIUM | L | We stop at file download. No challan numbering, no portal submission/ack capture. |
| **Statutory registers + PF/ESI joiner-exit forms + annual returns** | LOW | L | Form 5/10/3A/6A, PT/LWF returns, salary register. Table-stakes for compliance-grade payroll but lower urgency than run-blocking gaps. |
| **Pay groups (multiple schedules within one entity)** | LOW | M | No employee→pay-group assignment for mixed fortnightly/monthly cohorts. |

### C. Time & attendance (factory/field-force cluster)
| Gap | Severity | Effort | Note |
|---|---|---|---|
| **Geofence enforcement at punch time** | HIGH | M | *Dead code.* We capture geoLat/geoLng + Location.geofenceM and derive.js reads ctx.flags.outOfGeofence, but service.js never sets it. Haversine check is contained. Payroll-fraud exposure. |
| **Biometric device integration (ESSL/ZKTeco/Matrix)** | HIGH | L | Indian factories/offices run on devices; factoHR advertises 200+. We have CSV import + BIOMETRIC enum only. Primary buying criterion for mid/large accounts. |
| **Shift rosters / rotation cycles / bulk schedule / swap** | HIGH | L | Manufacturing/BPO/retail need rotating rosters. We support one-at-a-time effective-dated assignment only; derive.js flags this as v2. |
| **Comp-off earn→credit→apply lifecycle + expiry** | HIGH | M | We derive HOLIDAY_WORKED and have COMP_OFF enum but never credit a balance; employees who work holidays cannot bank/redeem. |
| **In-service leave encashment request** | MEDIUM | M | Encashment logic exists (FnF only). Add ESS apply + admin approve reusing encashableUnits/maxEncashCap + payroll payout. |
| **Statutory & operational attendance/leave registers** | MEDIUM | M | Muster roll / Form 25 / late-coming / absenteeism / OT register + CSV/PDF. We only have JSON group-by. |
| **Nightly attendance recompute / auto-mark-absent sweep** | MEDIUM | S | Recompute is event-driven only; no-punch days never materialize. Mirror the leave-accrual cron block. |
| **Native mobile attendance (offline queue, selfie, push)** | MEDIUM | L | ESS punch forces source=WEB; selfieUrl never written. |
| **Restricted/optional-holiday opt-in endpoint** | LOW | S | Plumbed in derive; no store/endpoint, so floating holidays are never honored. |
| **Live who's-in/out board + exception alerts** | LOW | M | No real-time board or proactive late/absent alerts. |

### D. Talent (recruitment / performance / learning / engagement)
| Gap | Severity | Effort | Note |
|---|---|---|---|
| **Learning Management System (LMS)** | HIGH | L | Entire domain absent. **POSH Act 2013** + induction + skill training expected by Indian buyers; loses RFPs to integrated suites. New models (Course/Module/Enrollment/Assessment/Certification) + content storage. |
| **9-box grid (performance × potential)** | HIGH | M | Performance is otherwise STRONG but captures only the performance axis. Add a potential rating + NineBox endpoint on existing calibration infra — relatively cheap. |
| **Competency framework (library/anchors/role mapping)** | HIGH | L | Today only a weight % + free-text section. Powers credible appraisals, IDPs, skill-gap→LMS. Shallow vs Darwinbox/Keka without it. |
| **Candidate communication engine (email/SMS/WhatsApp templates)** | MEDIUM | M | ATS sends interview invites but no templated shortlist/reject/schedule comms. Indian recruiters live on WhatsApp; absence = manual work + poor candidate UX. |
| **Succession / HiPo / talent review** | MEDIUM | M | Builds on org-tree + potential rating + 9-box. Enterprise RFP expectation. |
| **PIP as a first-class entity** | MEDIUM | M | Freeform outcomeJson today. Compliance-sensitive (feeds termination defensibility); needs lifecycle + checkpoints. |
| **Multi-level offer approval wired to F10 engine** | MEDIUM | S | Offer.approvalRequestId + PENDING_APPROVAL exist but unused; only an SoD guard runs. Small wiring. |
| **Referral portal + agency portal + job-board syndication** | MEDIUM | L | Source enum names REFERRAL/AGENCY but no submission UI, bonus linkage, agency login, or Naukri/LinkedIn/Indeed posting. Referrals are #1 source-of-hire in India. |
| **Recruitment analytics (time/cost-per-hire, source effectiveness)** | LOW | M | Per-job funnel exists; no cross-requisition KPIs. |
| **Career path / IDP** | LOW | M | Depends on competency framework + LMS landing first. |

### E. Platform: workflow, notifications, analytics, mobile, compliance ops
| Gap | Severity | Effort | Note |
|---|---|---|---|
| **SLA escalation cron not scheduled** | HIGH | **S** | *Cheapest high-impact fix in the codebase.* escalationRunner.js is complete; scheduler.js wires only leave accrual. **The engine's headline SLA feature is dead in prod.** One scheduler block. |
| **HR events fan out to email/SMS/WhatsApp/push** | HIGH | M | Router+providers+templates exist; only 2 events call notifyHrEvent. Approval-pending, leave-approved/rejected, reimbursement-status, regularization, offer all stay IN_APP. Needs a dispatcher. |
| **Custom/ad-hoc report builder + Excel export** | HIGH | L | 4 fixed JSON reports, no export, no charts. Frequent finance/HR-ops deal-blocker. |
| **Compliance calendar / statutory due-date dashboard** | HIGH | M | PF/ESI 15th, TDS 7th, PT/LWF per-state, 24Q quarterly, Form-16 mid-June. HR_FILING_DUE template unused. Per-tenant calendar + reminder cron. |
| **Mobile app: approvals + expense + push + geo** | HIGH | L | 6-screen scaffold; missing approvals inbox, expense+camera, documents, tax, push. Cannot replace web for managers/field staff. |
| **Receipt OCR / auto-extract** | MEDIUM | L | URL presence only. Reduces friction + fraud; competitive expectation, not statutory. |
| **Unified audit-log viewer** | MEDIUM | M | Rows + immutable ApprovalAction exist; no admin search-by actor/entity/date/module. Expected for SOC2/IT-audit demos. |
| **Asset/loan/regularization routed through approval engine** | LOW | M | Engine is module-agnostic; only LEAVE/EXPENSE/TRAVEL/PROFILE_CHANGE consumers exist. |

---

## 3. Make Existing Features More Mature (deepenings)

Concrete upgrades to STRONG/OK features — these turn good engines into demo-winning, audit-grade products. Most reuse infrastructure already built.

### Highest-leverage deepenings (mostly wiring of done work)
1. **Custom fields on the governance engine (L).** Extend profileFieldPolicy to classify admin-defined fields (CustomFieldDef row carrying policy/sensitive/model) so custom fields inherit self-edit/hr-approval/read-only + PII masking. Turns our strongest primitive into the foundation for the missing custom-fields module — *do this and the "Custom fields MISSING" gap collapses into it.*
2. **Loan recovery in the run (M).** Engine deduction pass: select PENDING installments due in period → emit LOAN_REPAYMENT line → stamp installment.payRunId + paidAt → increment Loan.amountRepaid / decrement outstanding, in-tx, with a "do not deduct beyond net" guard (mirror FnF loan-recovery discipline).
3. **Geofence wiring (M).** Punch-time Haversine against Location.geoLat/geoLng/geofenceM in service.js, setting ctx.flags so the already-built OUT_OF_GEOFENCE / IP_BLOCKED / selfieFailed exceptions actually fire. Surface punch location on the team board.
4. **Notification fan-out (M).** Route engine.notifyApprovers + escalationRunner + leave/expense consumers through notifyHrEvent so approver/employee gets email/WhatsApp/push with a deep-link; add per-employee channel prefs respecting the existing budget/opt-out engine; add APPROVAL_PENDING / APPROVAL_DECIDED / REMINDER templates.
5. **Remittance lifecycle + reminders (M).** Drive challanRef/paidDate/filedDate via a mark-paid/mark-filed flow; per-entity remittance calendar (PF/ESI 15th, TDS 7th, PT/LWF per-state) + overdue alerts. Fields already exist — only the workflow is missing. Persist generated files to StatutoryRemittance.fileUrl for audit (stop regenerating on each GET).

### Payroll & statutory depth
6. **IT declaration → proof states (L).** TaxDeclaration(window open/close) + TaxProofSubmission(section, fileUrl, status); recompute monthly TDS off VERIFIED actuals after lock; "declared vs verified vs derived-from-payslip" reconciliation (extend the projection's PF-from-payslip pattern to all sections).
7. **Form-16 Part-B (L).** Build on the same per-employee annual aggregation powering 24Q Annexure II + projectAnnualIncomeTax; emit signable salary-annexure PDF → bulk-sign + ESS-distribute via existing letters/e-sign.
8. **LWF pillar in compute() (M).** Per-state effective-dated EE+ER amounts, half-yearly/annual, following the professionalTax pattern with golden tests; keep pure no-DB design.
9. **Auto-arrear (M).** Replay engine.computePayslip per affected closed period at the new structure, diff vs paid PayRunLine, auto-create ARREAR items with sourcePeriod set + statutory re-incidence flagged.
10. **Reimbursement auto-pull (M).** "Pay via payroll" action creating REIMBURSEMENT input items from APPROVED claims carrying the taxable flag (FBP-bill = exempt) so engine keeps them out of statutory bases and TDS sees only the taxable portion.
11. **Filing maker-checker preview (S).** Use the meta header the generators already return (member/deductee counts, challan totals) for a finance reconciliation step before download.

### Attendance & leave depth
12. **Nightly attendance sweep (S).** Parallel cron recomputing the prior day for all active employees so absent/no-punch days auto-materialize (status + LOP) without an event — mirror the leave-accrual block.
13. **Bulk roster + rotation (L).** Bulk-assign endpoint (pattern → many employees / entity, date range) + a rotation model so a rotating-shift team schedules in one operation.
14. **OT approval gate (M).** Add weekly OT threshold + manager-approval step so only approved OT credits to payroll (today auto-credited per-day).
15. **In-service encashment endpoint (M).** ESS apply + admin approve reusing encashableUnits/maxEncashCap, posting the ENCASHMENT ledger txn + payroll payout input.
16. **Restricted-holiday opt-in (S).** Employee opt-in table/endpoint feeding optedRestrictedDates into recompute.
17. **Registers/exports (M).** Muster-roll + late-coming/absenteeism/OT-register CSV/PDF.
18. **Biometric webhook (L).** Promote the CSV import to an idempotent device webhook/sync (device registry + per-device dedupe + scheduled pull).

### Talent depth
19. **9-box on calibration (M).** Plot performance vs a new potential rating on the existing calibration roster + optional bell-curve helpers. Largely additive.
20. **Competency library first-class (L).** Library with proficiency levels/behavioral anchors + role→competency mapping (target vs assessed) — unlocks 9-box inputs, IDPs, skill-gap→LMS; bind EmployeeSkill + ScorecardSkill to one taxonomy.
21. **Cycle cadence automation (M).** Scheduled reminders/escalations (self-review due, manager-review due, calibration due) + bulk nudge.
22. **360 upward feedback + anonymity threshold (M).** Subordinate-feedback nomination + suppress aggregates below N=3; consolidated per-subject 360 report.
23. **Offer approval → F10 (S).** Wire Offer.approvalRequestId to the approval engine for grade/budget multi-level approval before SENT, keeping SoD as an additional check.
24. **Talent-pool / silver-medalist re-engagement (M).** Candidate status tracking + re-engagement (consentExpiresAt exists) + templated stage-move emails.

### Platform / asset / lifecycle depth
25. **Asset UI + acknowledgement + onboarding auto-allocation (M).** Admin register/assignment UI + employee e-sign handover (built-in esign) + wire createAsset/assign into onboarding LifecycleTask + AssetCategory config + warranty/AMC reminders (warrantyExpiry exists).
26. **Structured exit interview (M).** Replace the freeform exitInterviewJson with a reusable questionnaire template (reuse the survey model once built) so exit reasons aggregate into attrition analytics.
27. **Reports console upgrade (M).** Charts (attrition trend, headcount-by-dept, cost-by-month) + shared date/entity/dept filter bar + Excel/CSV per report + muster-roll/salary-register/reimbursement-spend reports.
28. **Unified audit-log viewer (M).** Admin search over a unified audit query (actor/entity/date/module); ensure expense/approval/comp-change writes land in AuditLog consistently.
29. **Onboarding ↔ asset ↔ announcements loop (M).** Asset-allocation + helpdesk-intro as first-class LifecycleTaskDef kinds + a pre-boarding welcome feed so new joiners see company news before day one.
30. **Aadhaar eSign / DSC provider (M).** Implement a real provider behind the existing esign/provider.js seam for legally-binding offers/contracts; keep built-in as default for internal acks.
31. **Master export (S).** Add departmentId/locationId/designationId/managerId server-side filters + an export-to-CSV endpoint + a photo contact-card grid on the admin people page (reuse LIST_SELECT join).

---

## 4. Recommended Sequence (India-first)

Strategy: **bank the wiring wins first** (high impact, low effort, mostly turning on work already built), then close the **engagement-surface void**, then the **India statutory year-end**, then the **field-force/factory** and **talent** modules. Each cycle is scoped to ~1–2 weeks of focused build.

### Cycle 0 — "Turn it on" (1 week, mostly S) — *do this immediately*
The platform already paid for these; they're just not wired. Disproportionate demo lift.
- **Schedule sweepEscalations cron (S)** — revives the entire SLA/auto-decision feature in prod.
- **Loan recovery in the pay run (M)** — makes a fully-built feature actually deduct.
- **Geofence Haversine at punch (M)** — activates dead exception flags; unblocks field-force story.
- **Nightly attendance sweep (S)** — absent days materialize; dashboards stop under-counting.
- **Master export to CSV + people filters (S)** — table-stakes; list query already exists.
- **Notification fan-out dispatcher (M)** — HR events reach phone/inbox, not just IN_APP.

### Cycle 1 — ESS engagement surfaces (1–2 weeks) — *kill the "feels empty" gap*
- **HR Helpdesk (M)** — wire the orphan schema (service+routes+UI). Highest leverage.
- **Announcements / news feed (M)** — home-screen surface + acknowledgement; layer on Notification model.
- **Company-wide ESS directory + celebration feed (S+S)** — comp-masked grid + birthday/anniversary/new-joiner from existing DOB/hireDate.

### Cycle 2 — India statutory completeness (2 weeks) — *RFP + compliance*
- **Investment-proof submission + HR verify + window lock (L)** — closes §201 exposure.
- **LWF pillar (M)** — completes payslips in LWF states.
- **Statutory Bonus computation + register (M)** — Bonus Act annual disbursement.
- **Compliance calendar + reminder cron (M)** — due-date dashboard (uses unused HR_FILING_DUE template).

### Cycle 3 — Year-end + flexi + claims-to-payroll (2 weeks)
- **Form 16 Part A+B + bulk sign/distribute (L)** — the marquee year-end deliverable, on existing aggregation + letters/e-sign.
- **Flexi Benefit Plan (FBP) (L)** — unlocks the most common India CTC structures.
- **Reimbursement auto-pull from approved claims (M)** + **auto-arrear engine (M)** — finish the payroll-input automation.

### Cycle 4 — Field-force & factory (2 weeks) — *unlock mid/large India accounts*
- **Biometric device integration (L)** — live ESSL/ZKTeco/Matrix sync (device registry + webhook/pull).
- **Shift rosters / rotation / bulk / swap (L)** — manufacturing/BPO/retail.
- **Comp-off earn→credit→apply lifecycle (M)** + **in-service encashment (M)**.
- **Attendance/leave registers + exports (M)**.

### Cycle 5 — Talent depth + engagement listening (2 weeks)
- **Engagement/pulse surveys + eNPS (M)** — also powers structured exit interviews.
- **9-box + competency framework (M+L)** — completes the performance story.
- **Rewards & Recognition (M)** + **candidate communication engine (M)**.
- **LMS (L)** — schedule as its own follow-on cycle given size; sequence after surveys/competency so POSH/induction tracking lands on a real framework.

### Parallel / continuous track (no dedicated cycle)
Asset UI + acknowledgement, unified audit-log viewer, reports-console charts+export, mobile-app surface build-out (approvals/expense/push/geo), Aadhaar eSign provider, offer-approval→F10. Slot these into capacity between the cycles above; each is independently shippable.

---

## 5. Appendix — Reading the gaps

Three patterns explain almost every gap:
1. **Built but not wired** (cheapest to fix): SLA cron, loan→payroll, geofence, notification fan-out, remittance lifecycle, helpdesk schema, offer-approval→F10, restricted-holiday opt-in. *These are "turn it on," not "build it."*
2. **Engagement-surface void** (cheap-to-medium, high demo lift): announcements, directory, celebration feed, R&R, surveys. *Buyers see these on the home screen first.*
3. **India year-end / proof statutory** (medium-to-large, RFP + legal): investment-proof workflow, Form 16, FBP, LWF, Bonus, compliance calendar. *These are the questions a CFO/payroll head asks in the demo.*

Our genuine strengths — effective-dated job history, the statutory compute pillars (EPF/ESI/PT/TDS + Code-on-Wages), the no-code approval engine, the ATS merit pipeline, calibration/merit hand-off, the temporal lifecycle/FnF engine — are at or above peer parity and should be **led with** in any competitive deal while the above gaps close.
