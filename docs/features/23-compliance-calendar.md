# Feature 23 — Statutory Compliance Calendar + Reminder Cron — India

> India-first. Express/Prisma/Postgres backend, `apps/hr-admin` + `apps/ess` (Next.js).
> Status enum, remittance tracker, per-tenant applicability, due-date rule engine,
> "mark filed + proof" action, and a reminder cron that **reuses** `scheduler.js`
> + `notifyHrEvent`. Effective-dated rules so the Income Tax Act 2025 transition
> (Form 16→130, 24Q→138) is data, not a code fork.

---

## 0. TL;DR — what this feature actually is

A **per-tenant calendar of India statutory due dates** with live status
(`UPCOMING → DUE → FILED/PAID → OVERDUE`), an HR "mark filed" action carrying a
**proof** (challan ref + uploaded receipt), and a **reminder cron** that nudges HR
at T-7 / T-3 / T-1 / due-day / overdue before each deadline.

The key realisation from the audit: **most of this already exists.** Today the
`StatutoryRemittance` table (`backend/prisma/schema.prisma:7827`) is written *only*
as a side-effect of `fileRun()` in `backend/src/hr/payroll/service.js:2063` — i.e.
an obligation only materialises **after** a pay run is FILED. That means:

- Tenants with **no pay run yet for the month** have **no PF/ESI row** to chase.
- **Tenant-wide / non-payrun obligations** (Form 16/130 by 15-Jun, half-yearly
  ESI return 11-Apr/11-Oct, LWF half-yearly, annual returns, gratuity/bonus
  events) have **no model at all** — they were never on a pay run.
- There is **no status lifecycle** (DUE never auto-advances to OVERDUE), **no
  reminder**, and **no calendar read API**.

So Feature 23 is the **superset tracker + due-date rule engine + reminder cron**
that sits *over* the existing remittance row, generated from a **per-tenant
obligation schedule** rather than only from pay runs. It reuses the existing
`StatutoryRemittance` row as the per-period instance, the existing
`StatutoryRegistration` rows as the **applicability** signal, the existing
`FILING_PLAN` due-date math as the seed for the rule engine, `notifyHrEvent` for
fan-out, and the `scheduler.js` + `escalationRunner.js` sweep pattern for the cron.

**Non-goals (explicit):** we do **not** auto-file with EPFO/ESIC/TRACES (no govt
API integration); we do **not** compute the *amount* for non-payrun obligations
beyond what payroll already books — the calendar **tracks dates + status + proof**,
the payroll engine remains the source of truth for amounts. NZ is out of scope for
the UI (gated off for IN tenants) but the model stays country-generic.

---

## 1. Code I studied (cite-first; reuse, don't duplicate)

| Area | File / symbol | What I reuse |
|---|---|---|
| **Tracker row** | `backend/prisma/schema.prisma:7827` `StatutoryRemittance` | The per-period obligation instance. Already has `kind/taxPeriod/amount/dueDate/filedDate/paidDate/challanRef/status/fileUrl/meta/version` and idempotency index `@@unique`-equivalent `@@index([businessId, entityId, kind, taxPeriod])`. **No new instance table needed** — I add a *definition* table + a few columns. |
| **Status enum** | `schema.prisma:7869` `RemittanceStatus {PENDING DUE FILED PAID OVERDUE WAIVED}` | Already models the lifecycle. I add a state machine + `OVERDUE` auto-advance + reminder bookkeeping. |
| **Kind enum** | `schema.prisma:7854` `RemittanceKind` | Already `IN_TDS, IN_PF, IN_ESI, IN_PT, IN_LWF, IN_FORM24Q, IN_FORM16` + NZ. I add `IN_FORM138/IN_FORM130/IN_ESI_RETURN/IN_PF_ANNUAL/IN_BONUS/IN_GRATUITY` (additive). |
| **Applicability** | `schema.prisma:7433` `StatutoryRegistration {kind, number, stateCode, effectiveFrom/To, isActive, meta}` + `RegistrationKind {EPF ESI PT_STATE TAN LWF SHOPS_ESTABLISHMENT …}` | **This is the per-tenant applicability source of truth.** A tenant only owes PF if it has an active `EPF` registration; PT obligations come from `PT_STATE` rows (per `stateCode`); LWF from `LWF` rows. The calendar generator iterates the entity's active registrations. |
| **Due-date math** | `backend/src/hr/payroll/service.js:2004` `FILING_PLAN`, `:2036` `remittanceDueDate`, `:2052` `remittanceTaxPeriod` | The seed of the **rule engine**. I lift this into a pure, effective-dated `compliance/india.calendar.js` so it serves BOTH the payrun path and the standalone schedule. `fileRun()` keeps calling it (no behaviour change). |
| **Remittance write** | `service.js:2063` `fileRun()` | I keep it. The generator becomes the *other* writer of the same table for non-payrun obligations + future-period stubs. Both writers stay idempotent on `(businessId, entityId, kind, taxPeriod)`. |
| **Notification fan-out** | `backend/src/hr/integrations/notifications.js:283` `notifyHrEvent`, `:34` event `'filing.due' → HR_FILING_DUE`, `:82` template | **Already wired.** I add `HR_COMPLIANCE_REMINDER` / `HR_COMPLIANCE_OVERDUE` templates next to it and emit via `notifyHrEvent`. |
| **Cron host** | `backend/src/core/lib/scheduler.js` (HR jobs at `:1103`, `:1119`, `:1148`, `:1175`) | I add **one** `cron.schedule('0 7 * * *', …)` block calling a tenant-loop sweep, copying the `escalationRunning`/`attendanceSweepRunning` in-process overlap guard verbatim. |
| **Sweep pattern** | `backend/src/hr/approvals/escalationRunner.js` | The canonical idempotent, version-guarded, tenant-safe, `--dry-run` runner shape. The compliance sweep is a near-clone. |
| **RBAC** | `backend/src/hr/payroll/payroll.routes.js` (`requirePermission`), permission catalog incl. **`canManageStatutory`** (already exists, grep-confirmed) | Calendar **read** = `canViewPayrollReports`; **mark-filed / waive / manage schedule** = `canManageStatutory`. No new permission needed. |
| **Route mount** | `backend/src/hr/routes/index.js:100` | New router mounts at `/api/hr/compliance` beside `/payroll`. |
| **Audit** | `service.js` `writeAudit(...)` (used at `:2113`) | Every mark-filed/waive/override writes an audit row, same helper. |
| **Money** | `backend/src/hr/payroll/money.js` (`fromMinor`, `decimalToMinor`) | Amounts stay `Decimal(18,2)`; no float math. |

**Reuse verdict:** ~70% of the back-end primitives exist. Feature 23 is mostly a
**definition table + generator + status sweep + reminder cron + read/mark API + 2
screens**. It forks **nothing**.

---

## 2. India statutory framework (govt-rule-compliant) — the rules the engine encodes

All dates verified against current sources (June 2026). **Effective-dating matters**
because the **Income Tax Act 2025** takes effect **1 Apr 2026**, renumbering the TDS
salary section (192→392) and replacing **Form 24Q→Form 138** (quarterly) and **Form
16→Form 130** (annual certificate). Old forms still apply to transactions up to
31-Mar-2026; new forms from 1-Apr-2026. We encode both as **effective-dated rule
versions**, never a code branch.

### 2.1 Monthly, recurring (the spine of the calendar)

| Obligation | `RemittanceKind` | Rule | Due date | Applicability gate |
|---|---|---|---|---|
| **TDS on salary — deposit** | `IN_TDS` | Deposit by **7th of following month**. **Exception:** March deductions → **30 Apr**. | `dueDom 7`, period = wage month; March special-case | `TAN` registration active |
| **EPF ECR + challan** | `IN_PF` | ECR upload + remittance by **15th of following month** | `dueDom 15` | `EPF` registration active |
| **ESI contribution** | `IN_ESI` | Contribution by **15th of following month** | `dueDom 15` | `ESI` registration active |
| **Professional Tax** | `IN_PT` | **State-specific.** Most monthly-deposit states (e.g. MH, KA) due ~**20th–21st**; some states **annual** (e.g. lump-sum) | per-`stateCode` rule from `meta.ptPeriodicity` | `PT_STATE` row(s); one obligation **per state** the tenant has employees in |

### 2.2 Quarterly

| Obligation | Kind | Due | Notes |
|---|---|---|---|
| **TDS salary return — Form 24Q** (txns ≤ 31-Mar-2026) | `IN_FORM24Q` | Q1 **31 Jul**, Q2 **31 Oct**, Q3 **31 Jan**, Q4 **31 May** | Last 24Q = FY25-26 Q4, due **31 May 2026** |
| **TDS salary return — Form 138** (txns ≥ 1-Apr-2026) | `IN_FORM138` *(new)* | same Q1/Q2/Q3/Q4 cadence | First Form 138 = FY26-27 Q1, due **31 Jul 2026**. Effective-dated successor of 24Q. |

### 2.3 Half-yearly / annual

| Obligation | Kind | Due | Applicability |
|---|---|---|---|
| **ESI half-yearly return** | `IN_ESI_RETURN` *(new)* | Apr–Sep return → **11 Oct**; Oct–Mar return → **11 Apr** | `ESI` |
| **Form 16** (FY ≤ 2025-26) | `IN_FORM16` | **15 Jun** following FY end. Last Form 16 = FY25-26 → due **15 Jun 2026** | `TAN` |
| **Form 130** (FY ≥ 2026-27) | `IN_FORM130` *(new)* | **15 Jun** of FY following the tax year. First Form 130 = FY26-27 → due **15 Jun 2027**. TRACES-only, post-Form-138. | `TAN`. Effective-dated successor of Form 16. |
| **EPF annual / form review** | `IN_PF_ANNUAL` *(optional)* | informational tracker | `EPF` |
| **LWF** | `IN_LWF` | **Per state, half-yearly/annual.** MH: deduct Jun & Dec, pay by **15 Jul** & **15 Jan**. KA: annual, pay by **15 Jan**. Many states inactive. | `LWF` row per `stateCode` |
| **Payment of Bonus** | `IN_BONUS` *(optional)* | Bonus payable within **8 months** of FY close (≈ **30 Nov**); Form D annual return | tenant flag (Bonus Act coverage) |
| **Gratuity** | `IN_GRATUITY` *(event, optional)* | Not date-recurring — **event-driven** (payable within **30 days** of separation). Tracked off offboarding, not the recurring calendar; surfaced as a *due item* with `dueDate = separation + 30d`. | tenant covered under Gratuity Act |

> **Penalty context the UX surfaces** (so HR feels the urgency): late TDS deposit
> → interest **1.5%/month** from deduction date; missed PF ECR → **12% p.a.**
> interest + damages up to **25%** of arrears; late ESI → **12% p.a.** interest.
> We store these as `meta.penaltyHint` strings on the definition; we do **not**
> compute penalties (out of scope).

### 2.4 The two hard problems this creates

1. **Per-state fan-out.** PT and LWF are **per-state**, with different periodicity
   and due days. A tenant operating in MH+KA owes **two** PT obligations and (maybe)
   **two** LWF obligations, each with its own rule. The engine keys off
   `StatutoryRegistration{kind:PT_STATE|LWF, stateCode}` rows.
2. **Effective-dated succession.** 24Q→138 and 16→130 flip on **1-Apr-2026**. The
   rule engine resolves the right `kind` by the obligation's **period**, mirroring
   the existing `complianceRegistry.js` effective-dating pattern
   (`backend/src/hr/payroll/complianceRegistry.js`).

---

## 3. Data model (Prisma sketches)

Two moves: **(a)** a small `ComplianceObligation` *definition* table (the rule
schedule, per entity), and **(b)** additive columns on the existing
`StatutoryRemittance` *instance* table. No instance table is created — we extend
the one that already exists.

### 3.1 `ComplianceObligation` — the per-tenant rule schedule (NEW)

The **definition** of *what this tenant owes and on what cadence*. One row per
(entity, kind, [stateCode]) the tenant is liable for. Seeded from
`StatutoryRegistration` on entity creation / registration change; editable by HR.

```prisma
model ComplianceObligation {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId      String
  entity        Entity   @relation(fields: [entityId], references: [id], onDelete: Cascade)

  kind          RemittanceKind          // reuse the SAME enum as the instance row
  stateCode     String?                 // PT / LWF: per-state; NULL = entity-wide
  cadence       ComplianceCadence       // MONTHLY | QUARTERLY | HALF_YEARLY | ANNUAL | EVENT
  // Due-date rule (interpreted by the pure engine — see §4):
  dueDom        Int?                    // day-of-month the filing is due
  dueMonths     Int[]    @default([])   // for HALF_YEARLY/ANNUAL: which calendar months it falls in (e.g. [4,10] for ESI return; [6] for Form16)
  offsetMonths  Int      @default(1)    // months after period end the due date lands (TDS=1, 24Q≈1)
  specialRules  Json?                   // e.g. {"marchDueDom":30,"marchDueMonth":4} for TDS; {"ptPeriodicity":"MONTHLY"}

  // Effective-dating (24Q→138, 16→130 succession). Same shape as StatutoryRegistration.
  effectiveFrom DateTime @db.Date
  effectiveTo   DateTime? @db.Date      // when superseded (e.g. 24Q effectiveTo 2026-03-31)
  supersededBy  String?                 // optional pointer to successor kind for UX ("becomes Form 138")

  isActive      Boolean  @default(true)
  autoGenerate  Boolean  @default(true) // generator materialises future instances for this
  reminderDays  Int[]    @default([7,3,1,0]) // T-minus days to nudge HR (0 = due day)
  meta          Json?    // penaltyHint, label, govtPortalUrl, form name
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  version       Int      @default(0)

  @@unique([businessId, entityId, kind, stateCode, effectiveFrom])
  @@index([businessId, entityId, isActive])
}

enum ComplianceCadence { MONTHLY QUARTERLY HALF_YEARLY ANNUAL EVENT }
```

### 3.2 `StatutoryRemittance` — extend the EXISTING instance row (additive only)

Add a back-link to the definition + reminder bookkeeping + proof + waiver fields.
**No type changes; all nullable** so existing `fileRun()`-written rows are valid.

```prisma
// additions to model StatutoryRemittance (schema.prisma:7827):
  obligationId     String?   // FK → ComplianceObligation (NULL for legacy/ad-hoc rows)
  obligation       ComplianceObligation? @relation(fields: [obligationId], references: [id], onDelete: SetNull)
  stateCode        String?   // mirror for PT/LWF per-state instances
  // proof of filing (mark-filed action):
  proofUrl         String?   @db.Text   // uploaded challan / receipt (reuse S3 helper)
  proofUploadedAt  DateTime?
  filedByUserId    String?              // who marked it filed (audit + SoD)
  // reminder bookkeeping (idempotent nudges — never spam):
  lastReminderAt   DateTime?
  remindersSent    Int       @default(0)
  reminderStage    String?              // "T-7" | "T-3" | "T-1" | "DUE" | "OVERDUE" — last stage nudged
  // waiver / not-applicable for a period:
  waivedReason     String?
  @@index([businessId, status, dueDate]) // already present — reused by the sweep
```

> **Why reuse `StatutoryRemittance` as the instance and not a new table:** the
> payroll `fileRun()` path already creates exactly the row the calendar needs
> (kind/taxPeriod/dueDate/amount/status/challanRef/fileUrl). A second table would
> fork the truth and require reconciliation. The calendar **owns the definition**;
> the **instance** is shared. Both writers use the same idempotency key
> `(businessId, entityId, kind, taxPeriod)` (+ `stateCode` for PT/LWF).

### 3.3 Enum additions (additive — safe migration)

```prisma
// RemittanceKind += :
  IN_FORM138       // 24Q successor (txns ≥ 2026-04-01)
  IN_FORM130       // Form 16 successor (FY ≥ 2026-27)
  IN_ESI_RETURN    // ESI half-yearly return (11 Apr / 11 Oct)
  IN_PF_ANNUAL     // optional EPF annual tracker
  IN_BONUS         // Payment of Bonus Act (optional)
  IN_GRATUITY      // event-driven, off offboarding (optional)
// RemittanceStatus already has all states we need; add ON-TRACK semantics via:
//   UPCOMING ⇒ we MAP UI label "Upcoming" onto existing PENDING (no new enum value),
//   so the state machine is PENDING→DUE→(FILED|PAID|WAIVED), with OVERDUE a sweep result.
```

> Decision: **do not** add a `UPCOMING` enum value — reuse `PENDING` and render it
> as "Upcoming" until `dueDate - reminderWindow`. Keeps the enum stable and the
> existing payroll rows' `DUE` semantics intact.

### 3.4 Migration

`backend/prisma/migrations/20260624_feature23_compliance_calendar/` — additive:
create `ComplianceObligation` + `ComplianceCadence` enum, `ALTER TABLE
"StatutoryRemittance" ADD COLUMN` (all nullable / defaulted), extend
`RemittanceKind`. No backfill required; legacy remittance rows simply have
`obligationId = NULL` and are still tracked by the calendar (read joins on
kind/period).

---

## 4. The due-date rule engine (pure, effective-dated)

New module `backend/src/hr/payroll/compliance/india.calendar.js` — **PURE** (no DB,
no `Date.now`), mirroring the contract style of `compliance/india.js` and the
effective-dating of `complianceRegistry.js`.

```
nextDueDate({ cadence, dueDom, dueMonths, offsetMonths, specialRules }, periodKey)
   → Date (UTC)            // the statutory due date for a given period instance
periodsBetween(obligation, fromDate, toDate)
   → [ { taxPeriod, periodStart, periodEnd, dueDate, kind } ]  // instances to generate
resolveKindForPeriod(obligationFamily, periodEnd)
   → RemittanceKind        // 24Q vs 138, Form16 vs 130 by effective date
adjustForHolidaysAndWeekends(dueDate, country)
   → Date                  // optional: push to next working day (reuse holidaysAct.js if present)
```

Rules encoded (lifted + generalised from `service.js:2036` `remittanceDueDate`):

- **MONTHLY**: due = `dueDom` of month `periodMonth + offsetMonths`. `specialRules.marchDueDom`
  overrides for the March wage month (TDS → 30 Apr).
- **QUARTERLY**: period = Indian fiscal quarter (reuse existing `indianQuarter()`);
  due = `dueDom` of the month following quarter end.
- **HALF_YEARLY / ANNUAL**: due = `dueDom` of the configured `dueMonths` (e.g. ESI
  return `[4,10]`@11; Form 16/130 `[6]`@15; LWF MH `[1,7]`@15).
- **EVENT** (gratuity): no schedule — instance created on the trigger (separation)
  with `dueDate = triggerDate + N days`; the calendar just displays + reminds.
- **Effective-dated kind**: `resolveKindForPeriod` returns `IN_FORM24Q` for periods
  ending ≤ 2026-03-31 else `IN_FORM138`; `IN_FORM16` for FY ≤ 2025-26 else `IN_FORM130`.
  Driven by the obligation's `effectiveFrom/effectiveTo` + the period — **never** a
  hard-coded country/year branch.

**Working-day adjustment** is a flag (`meta.shiftToWorkingDay`), default **off** for
v1 (govt due dates are statutory calendar dates; many portals accept the calendar
date). When on, it reuses `compliance/holidaysAct.js` if a holiday calendar exists.

A second module `backend/src/hr/payroll/compliance/india.calendar.seed.js` exports
the **default IN obligation set** (the §2 table as data) so entity provisioning can
seed `ComplianceObligation` rows from a tenant's `StatutoryRegistration`s.

---

## 5. The generator + status sweep + reminder cron (the runtime)

New runner `backend/src/hr/payroll/compliance/calendarRunner.js` — a **near-clone of
`escalationRunner.js`**: tenant-safe, idempotent, version-guarded, `--dry-run`,
CLI-runnable. Three responsibilities, each its own exported fn:

### 5.1 `generateUpcomingObligations({ businessId?, horizonDays=120, asOf, dryRun })`

For each active `ComplianceObligation` (gated by an **active matching
`StatutoryRegistration`** — the applicability check), call `periodsBetween()` over
`[asOf, asOf+horizon]` and **upsert** a `StatutoryRemittance` stub per period —
idempotent on `(businessId, entityId, kind, taxPeriod[, stateCode])`. Stub =
`status PENDING`, `amount 0` (real amount lands when `fileRun()` updates the same
row), `dueDate` from the engine, `obligationId` set. **Never clobbers** a row already
`FILED/PAID/WAIVED` or one carrying a payroll amount.

### 5.2 `sweepComplianceStatus({ businessId?, asOf, dryRun })`

Advance lifecycle (version-guarded writes, exactly like the escalation sweep):

- `PENDING` whose `dueDate - reminderWindow ≤ asOf < dueDate` → stays PENDING but
  is **reminder-eligible** (UI shows "Due soon").
- any non-terminal row with `dueDate < asOf` and not `FILED/PAID/WAIVED` → **`OVERDUE`**.
- terminal states (`FILED/PAID/WAIVED`) are never touched.

### 5.3 `sendComplianceReminders({ businessId?, asOf, dryRun })`

For each reminder-eligible / overdue row, compute the **stage** from `obligation.reminderDays`
(`T-7/T-3/T-1/DUE/OVERDUE`). If `reminderStage` already equals the current stage →
**skip** (idempotent, no spam). Else resolve recipients (users with
`canManageStatutory` in the tenant — via `approverResolver.usersWithPermission`, the
same helper the escalation runner uses) and fan out via **`notifyHrEvent`**:

```js
await notifyHrEvent({
  businessId,
  event: 'compliance.reminder',          // → HR_COMPLIANCE_REMINDER (or _OVERDUE)
  recipientEmail, recipientPhone, recipientCountry: 'IN',
  variables: { BIZ, FORM: 'EPF ECR', PERIOD: '2026-05', DUE: '15 Jun 2026',
               DAYS: 3, AMT: '₹2,14,500', LINK },
  triggeredBy: 'HR_COMPLIANCE_REMINDER',
});
```

Then stamp `lastReminderAt`, `reminderStage`, `remindersSent++` in a version-guarded
update so a re-run in the same window is a no-op.

### 5.4 Scheduler wiring (the ONE new cron block)

In `backend/src/core/lib/scheduler.js`, beside the existing HR jobs (`:1103`,
`:1148`, `:1175`), add — copying the in-process overlap guard verbatim:

```js
// HR Statutory Compliance (Feature 23) — daily 07:00 IST-ish window:
// (1) generate upcoming obligation stubs, (2) advance OVERDUE, (3) fan out
// T-7/T-3/T-1/due/overdue reminders to canManageStatutory users. Tenant-safe,
// idempotent, version-guarded; in-process flag prevents tick overlap.
let complianceSweepRunning = false;
cron.schedule('0 7 * * *', async () => {
  if (complianceSweepRunning) { console.log('[Scheduler] compliance sweep still running — skipping tick'); return; }
  complianceSweepRunning = true;
  try {
    const r = require('../../hr/payroll/compliance/calendarRunner');
    const g = await r.generateUpcomingObligations({ asOf: new Date() });
    const s = await r.sweepComplianceStatus({ asOf: new Date() });
    const n = await r.sendComplianceReminders({ asOf: new Date() });
    if (g.created || s.overdue || n.sent || g.errors || s.errors || n.errors) {
      console.log(`[Scheduler] compliance: gen=${JSON.stringify(g)} sweep=${JSON.stringify(s)} remind=${JSON.stringify(n)}`);
    }
  } catch (err) {
    console.error('[Scheduler] compliance sweep failed:', err.message);
  } finally {
    complianceSweepRunning = false;
  }
});
```

> Cron is **UTC** in `scheduler.js` (other jobs run on `cron.schedule` UTC). `0 7`
> UTC ≈ 12:30 IST — a sane working-hours nudge for India. If a tenant-TZ-aware
> window is wanted later, the per-tenant loop can gate on `nowInTimezone(entity.timezone)`
> exactly as the booking-reminder job already does (`scheduler.js` `nowInTimezone`).

### 5.5 Notification templates (add beside `HR_FILING_DUE`)

In `backend/src/hr/integrations/notifications.js`, add to `HR_EVENT_TEMPLATES` +
`HR_TEMPLATES` (same shape as the existing entries):

```js
'compliance.reminder': 'HR_COMPLIANCE_REMINDER',
'compliance.overdue':  'HR_COMPLIANCE_OVERDUE',
// templates:
{ key:'HR_COMPLIANCE_REMINDER', vertical:'HR', category:'SERVICE',
  body:'{BIZ}: {FORM} for {PERIOD} is due on {DUE} ({DAYS} day(s) left). Mark filed: {LINK}',
  variables:['BIZ','FORM','PERIOD','DUE','DAYS','LINK'],
  channels:{ sms:true, whatsapp:true, email:true } },
{ key:'HR_COMPLIANCE_OVERDUE', vertical:'HR', category:'SERVICE',
  body:'{BIZ}: {FORM} for {PERIOD} is OVERDUE (was due {DUE}). Interest/penalty accrues. File now: {LINK}',
  variables:['BIZ','FORM','PERIOD','DUE','LINK'],
  channels:{ sms:true, whatsapp:true, email:true } },
```

`seedHrTemplates()` (already idempotent, preserves super-admin DLT/provider IDs)
picks them up on the next seed — no new transport, no new seeder.

---

## 6. API + RBAC

New router `backend/src/hr/payroll/compliance/compliance.routes.js`, mounted at
`/api/hr/compliance` in `routes/index.js:100`-area. `protect` first; permissions
reuse the existing catalog (`canViewPayrollReports`, `canManageStatutory`).

| Method + path | Permission | Purpose |
|---|---|---|
| `GET /compliance/calendar?from=&to=&entityId=&kind=&status=` | `canViewPayrollReports` | The calendar feed: joins `ComplianceObligation` × `StatutoryRemittance`, returns each obligation-period with derived status (UPCOMING/DUE/OVERDUE/FILED). Includes future stubs not yet generated (computed on the fly so the UI is complete even before the cron runs). |
| `GET /compliance/calendar/:remittanceId` | `canViewPayrollReports` | Detail: amount, due date, proof, audit trail, penalty hint, govt portal link. |
| `POST /compliance/remittances/:id/mark-filed` | `canManageStatutory` | Body `{ challanRef, filedDate, proofUrl?, paidDate? }`. `DUE/OVERDUE → FILED` (and `PAID` if `paidDate`). Version-guarded; writes audit + stamps `filedByUserId`. |
| `POST /compliance/remittances/:id/proof` | `canManageStatutory` | Upload challan/receipt → S3 (`core/lib/s3.js`, reuse the existing 10MB+MIME caps from the lifecycle PDF upload), set `proofUrl/proofUploadedAt`. |
| `POST /compliance/remittances/:id/waive` | `canManageStatutory` | `{ reason }` → `WAIVED` (e.g. nil filing / not applicable this period). Audited. |
| `GET /compliance/obligations?entityId=` | `canManageStatutory` | List the tenant's rule schedule (definitions). |
| `POST /compliance/obligations` / `PATCH /:id` | `canManageStatutory` | Add/edit a per-state PT/LWF rule or toggle `isActive` / `reminderDays`. |
| `POST /compliance/obligations/seed` | `canManageStatutory` | (Re)derive default obligations from the entity's active `StatutoryRegistration`s using `india.calendar.seed.js`. Idempotent. |
| `POST /compliance/sweep` (admin/debug) | `canManageStatutory` | Manual trigger of generate+sweep+remind for this tenant (`dryRun` supported) — the same fns the cron calls. |

**RBAC / SoD notes**
- Read is the broad payroll-reports permission so finance/HR can *see* the calendar.
- Every **mutation** requires `canManageStatutory` (the dedicated permission already
  in the catalog) — never inferred from `canRunPayroll`.
- **Tenant isolation**: every query is `businessId`-scoped from `req.user.businessId`;
  `:id` lookups are `findFirst({ where:{ id, businessId } })` (never `findUnique` by
  id alone), matching the payroll controllers.
- **Mark-filed SoD (optional, config-flag):** can require the filer ≠ the payroll
  approver for the run, reusing the maker-checker guard already in `service.js`. Off
  by default (most SMB tenants have one compliance person); on for enterprise.

---

## 7. hr-admin + ESS UX (plain language)

### hr-admin — "Compliance Calendar" (under Payroll, gated `canViewPayrollReports`)

- **Calendar / list toggle.** A month grid **and** a sortable list. Each obligation
  shows a **status chip**: grey *Upcoming*, amber *Due soon*, blue *Due today*, red
  *Overdue*, green *Filed*, slate *Waived*. Columns: Form (EPF ECR / ESI / TDS 7th /
  Form 24Q / PT-MH / LWF-MH …), Entity, State (for PT/LWF), Period, Amount, Due date,
  Days left, Status, Proof.
- **Top banner**: "3 filings due this week · 1 overdue" with a one-click filter.
- **Mark filed** action on a row → modal: challan/CRN ref, filed date, paid date,
  drag-drop the challan PDF/receipt (proof). On save the chip flips to *Filed* and a
  ✓ proof icon appears; the reminder for that row stops.
- **Detail drawer**: amount breakdown (from the linked pay run if any), the statutory
  rule ("EPF ECR — due 15th of following month — 12% p.a. interest if late"), a
  **"Open EPFO portal"** deep link (`meta.govtPortalUrl`), proof preview, full audit
  trail (who filed, when, from what IP).
- **Schedule settings** (gated `canManageStatutory`): per-state PT/LWF rows, toggle
  obligations on/off, edit reminder days (default T-7/T-3/T-1/due), "Re-derive from
  registrations" button.
- **Empty/first-run state**: "No statutory registrations yet — add your EPFO/ESIC/PT
  numbers under Entity → Registrations to populate the calendar," linking to the
  existing `StatutoryRegistration` UI.

### ESS — minimal, read-only, role-gated

Most employees see **nothing** (compliance is HR-internal). For a tenant where a
non-admin **finance viewer** has `canViewPayrollReports`, the same calendar is
available read-only. **No** employee-facing surface in v1 (Form 16/130 *delivery* to
employees is a separate documents feature, out of scope here — we only track that the
employer **issued** it by 15-Jun).

### Notifications HR actually receives

- **Email/WhatsApp/SMS** (existing cascade) at **T-7/T-3/T-1/due/overdue**:
  *"DriftHR Pvt Ltd: EPF ECR for 2026-05 is due on 15 Jun 2026 (3 days left). Mark
  filed: <link>."* Overdue variant warns about interest accrual.
- Reminders are **deduped per stage** so HR is never spammed.

---

## 8. Build plan (slices — each independently shippable, test-gated)

### Slice 23a — Rule engine + schema (pure foundation, no UI)
- Migration: `ComplianceObligation` + `ComplianceCadence`, additive
  `StatutoryRemittance` columns, `RemittanceKind` additions.
- Pure `compliance/india.calendar.js` (`nextDueDate`, `periodsBetween`,
  `resolveKindForPeriod`, special-cases) + `india.calendar.seed.js` (default IN set).
- **Refactor** `service.js` `remittanceDueDate`/`remittanceTaxPeriod` to delegate to
  the new pure engine (no behaviour change; golden test parity with existing rows).
- Tests: **golden** due-date tables for every §2 obligation incl. TDS-March-30-Apr,
  24Q→138 and 16→130 effective-date flips, per-state PT/LWF.

### Slice 23b — Generator + applicability + tracker write
- `calendarRunner.generateUpcomingObligations` (gated by active
  `StatutoryRegistration`), idempotent upsert of `StatutoryRemittance` stubs.
- `POST /compliance/obligations/seed` derives obligations from registrations.
- Tests: applicability (no EPF reg ⇒ no PF obligation); per-state fan-out (MH+KA ⇒ 2
  PT rows); idempotent re-run; never clobbers a FILED row or a payroll-amount row.

### Slice 23c — Calendar read API + status sweep + mark-filed/proof/waive
- `GET /compliance/calendar` (+ detail), `sweepComplianceStatus` (OVERDUE advance),
  `mark-filed` / `proof` (S3) / `waive`, audit on every mutation, version guards,
  tenant-scope + RBAC tests.
- Tests: lifecycle PENDING→DUE→OVERDUE→FILED; proof upload caps; SoD flag; RBAC
  (read vs manage); cross-tenant isolation.

### Slice 23d — Reminder cron + notification fan-out
- `HR_COMPLIANCE_REMINDER` / `HR_COMPLIANCE_OVERDUE` templates; `sendComplianceReminders`
  (stage dedupe, `usersWithPermission('canManageStatutory')`); **one** `scheduler.js`
  cron block with the overlap guard.
- Tests: T-7/T-3/T-1/due/overdue staging; idempotent (re-run same window = 0 sends);
  recipient resolution; `notifyHrEvent` spy assertion (copy the helpdesk
  `notify.fanout` test pattern); overlap guard.

### Slice 23e — hr-admin UI (calendar grid/list + mark-filed + schedule settings)
- `apps/hr-admin` calendar/list views, status chips, mark-filed modal, proof
  upload/preview, detail drawer, schedule settings, govt portal deep links, empty
  state. Read-only finance variant.

*(Slice 23f, optional/roadmap: event-driven `IN_GRATUITY` off offboarding;
working-day shift via `holidaysAct.js`; NZ payday/PAYE surfacing for NZ tenants.)*

---

## 9. Statutory edge cases & invariants (the test matrix spine)

- **TDS March special**: wage month March → due **30 Apr** (not 7 Apr); the `IN_TDS`
  monthly rule must honour `specialRules.marchDueDom`.
- **24Q → 138 boundary**: FY25-26 Q4 (period ends 31-Mar-2026) → `IN_FORM24Q` due 31
  May 2026; FY26-27 Q1 (period from 1-Apr-2026) → `IN_FORM138` due 31 Jul 2026.
- **Form 16 → 130 boundary**: FY25-26 → `IN_FORM16` due 15-Jun-2026; FY26-27 →
  `IN_FORM130` due 15-Jun-2027.
- **Per-state PT divergence**: MH monthly ~21st vs an annual-PT state vs a no-PT
  state (e.g. Delhi, Haryana have no PT) — applicability strictly from `PT_STATE`
  registration rows; no PT_STATE ⇒ no PT obligation.
- **LWF state matrix**: MH half-yearly (15-Jul/15-Jan), KA annual (15-Jan), many
  states none. KA threshold change (10+ employees from Jan-2026) handled by tenant
  *enabling* the `LWF` registration — calendar follows the registration, not a
  hard-coded threshold.
- **Mid-year registration**: a tenant that activates EPF on 2026-08-01 owes PF only
  from Aug → `effectiveFrom` gate; no retroactive Apr–Jul obligations generated.
- **De-registration**: `StatutoryRegistration.effectiveTo` set ⇒ generator stops
  emitting future periods past that date; existing open obligations remain trackable.
- **Nil / not-applicable period**: HR can **waive** with reason (e.g. zero employees
  that month) — terminal `WAIVED`, audited, reminders stop.
- **Idempotency**: generator + sweep + reminder are each safe to re-run; every write
  is version-guarded so two overlapping cron ticks can't double-advance or
  double-notify (same guarantee `escalationRunner.js` gives).
- **Payroll precedence**: when `fileRun()` later writes the same `(entity,kind,period)`
  row, it **updates** the calendar's stub (sets the real `amount` + `fileUrl`); the
  calendar never overwrites a payroll-sourced amount with `0`.
- **Reminder dedupe**: at most one notification per (row, stage); a missed cron day
  is caught next tick (stage compares against `dueDate`, not against "yesterday").
- **Penalty hints are advisory**: we display `1.5%/mo`, `12% p.a.`, `25% damages`
  context but never compute or post penalty amounts (out of scope).
- **Tenant isolation**: every read/write `businessId`-scoped; `:id` routes use
  `findFirst({ id, businessId })`; cross-tenant access returns 404.

---

## 10. What to reuse (one-screen checklist)

- **Instance row** → existing `StatutoryRemittance` (extend, don't fork).
- **Applicability** → existing `StatutoryRegistration` rows (the source of truth).
- **Due-date math** → lift `service.js` `FILING_PLAN`/`remittanceDueDate` into the
  pure `india.calendar.js`; `fileRun()` keeps working through it.
- **Effective-dating** → mirror `complianceRegistry.js` resolver shape.
- **Notifications** → `notifyHrEvent` + `seedHrTemplates` (`HR_FILING_DUE` already
  exists; add two reminder templates next to it). No new transport.
- **Cron** → one `scheduler.js` block, copying the `*Running` overlap guard.
- **Sweep shape** → clone `escalationRunner.js` (tenant loop, `--dry-run`,
  version-guarded, `usersWithPermission` recipient resolution).
- **RBAC** → `canViewPayrollReports` (read) + `canManageStatutory` (write) — both
  already in the catalog.
- **Uploads** → `core/lib/s3.js` with the lifecycle PDF caps (10MB + MIME allowlist).
- **Audit** → existing `writeAudit` helper on every mutation.
- **Money** → `Decimal(18,2)` + `money.js`; never floats.

---

### Sources (statutory rules, verified June 2026)

- [Compliance Calendar India 2026 — employer deadlines (PF/ESI/TDS/PT)](https://futurexsolutions.com/compliance-calendar-india-2026-employer-deadlines/)
- [SalaryBox — Statutory Compliance 2026: PF, ESI, TDS, PT, Labour Codes](https://salarybox.in/complete-guide-to-statutory-compliance-for-indian-businesses-2026-pf-esi-tds-professional-tax-labour-codes/)
- [ClearTax — TDS payment & return due dates and penalties](https://cleartax.in/s/tds-payment-due-dates-and-penalties)
- [ClearTax — Form 130: new salary TDS certificate under Income Tax Act 2025](https://cleartax.in/s/form-130-income-tax)
- [TaxGuru — Form 130 replaces Form 16 (Income Tax Act 2025)](https://taxguru.in/income-tax/form-130-tds-certificate-salary-replacing-form-16.html)
- [FutureX — Labour Welfare Fund India 2026 state-wise guide](https://futurexsolutions.com/labour-welfare-fund-india-2026-state-wise-guide/)
- [Patron Accounting — LWF state-wise rates & due dates](https://www.patronaccounting.com/blog/labour-welfare-fund-india-contribution-rates-due-dates)
