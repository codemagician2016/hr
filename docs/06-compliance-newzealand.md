# 06 — New Zealand Payroll Compliance Specification

> **Surface:** Tenant Admin (HR console) at `app.hr.com` + Employee Self-Service at `tenant.com` · **Engine:** `backend/src/hr/payroll` + `backend/src/hr/compliance/nz`
> **Owner discipline:** New Zealand Payroll Compliance Specialist
> **Status:** Production spec — no MVP shortcuts. Every figure carries an effective date.
> **Sibling docs:** `00-vision-and-principles.md`, `05-compliance-india.md` (PF/ESI/PT/TDS), `04-payroll-engine.md` (cross-country calc orchestration), `07-leave-and-attendance.md`, `08-data-model.md`, `09-super-admin-compliance-rules.md` (versioned rule tables), `11-notifications.md`, `12-reporting-and-statutory-filings.md`.

---

## 0. Document Purpose & Authoritative Sources

This is the **definitive statutory specification for running compliant New Zealand payroll** inside the platform. It covers PAYE, payday filing, KiwiSaver + ESCT, the ACC earners' levy, student loan, minimum wage, and — the flagship, hardest, highest-value module — a deep, worked treatment of the **Holidays Act 2003**.

**Design stance.** NZ payroll correctness is *not* a "calculate gross × rate" problem. The two genuinely hard things are (1) **payday filing** — a near-real-time reporting obligation to Inland Revenue (IRD) within **2 working days of every payday**, and (2) the **Holidays Act 2003**, where the same day of leave can be legally payable at four different rates (OWP, AWE, RDP, ADP), and where billions of dollars of NZ remediation liability exist precisely because payroll vendors got this wrong. **Provable correctness on the Holidays Act is our marquee NZ feature.** Every leave payment we produce must be explainable: which method, which inputs, which 4-week/52-week window, why this rate and not the other.

**Authoritative sources (all verified June 2026):**

| Source | Used for |
|---|---|
| IRD `ir-340` / `ir-335` (Apr 2026 editions) | PAYE deduction tables, employer's guide, **ND no-notification rate (45% + ACC = 46.75%)** |
| IRD payday filing guidance | EI return cadence, fields, file formats |
| IRD KiwiSaver changes page | 3.5% from 1 Apr 2026, 16–17yo employer contributions |
| IRD ESCT page + Calculate.co.nz ESCT 2026/27 | ESCT tier thresholds |
| IRD / Mercans / NZTaxTools (ACC 2026/27) | ACC earners' levy 1.75%, cap $156,641 |
| MBIE minimum wage 2026 release | $23.95 adult / $19.16 starting-out & training |
| Holidays Act 2003 (ss 8–9, 14–28, 49–73) + Employment NZ guidance | OWP/AWE/RDP/ADP, BAPS leave, public holidays |
| **Employment Leave Bill 2026** (introduced 9 Mar 2026) | Forward-compatibility — see §13 |

> ⚠️ **Forward-compat alert (read this first).** The **Employment Leave Bill** was introduced to Parliament on **9 March 2026** and is intended to **replace the Holidays Act 2003 entirely**, with commencement expected **~2028**. Our Holidays Act engine must be built behind a **versioned, country-and-effective-date-keyed rule set** (see §1.3 and `09-super-admin-compliance-rules.md`) so the eventual switch is a new rule version, not a rewrite. We build the Holidays Act 2003 *correctly* for 2026–2028, and we design the leave engine's interfaces to absorb the new accrual model (hours-based sick accrual at 0.0385 h/standard hour, day-one BAPS entitlements) without schema upheaval. §13 details this.

---

## 1. Reuse From Sitepresso & New-Build Boundary

### 1.1 What we reuse (real paths, READ-ONLY fork base)

The NZ compliance engine is a **new backend module** (`backend/src/hr/compliance/nz`) but it stands on Sitepresso's proven platform plumbing:

| Capability | Sitepresso path | How NZ payroll uses it |
|---|---|---|
| Prisma client singleton | `backend/src/core/lib/prisma.js` | All NZ payroll/leave models attach to the same client; tenant rows carry `businessId`. |
| Multi-currency money handling | `backend/src/core/lib/currency.js` | NZD formatting/rounding; we extend with banker's-rounding helpers (see §2.6). |
| RBAC + roles | `backend/src/core/lib/rbac.js`, `roles.js`, `backend/src/core/middleware/auth.middleware.js` | Gate "run pay run", "approve leave", "submit payday filing" permissions. |
| Tenant isolation | `backend/src/core/middleware/requireBusiness.js`, `requireVertical.js` | Every payroll/leave query is scoped to `businessId` (row-level). |
| Entitlements / plan feature flags | `backend/src/core/lib/entitlements.js`, `featuresCatalog.js`, `planCatalog.js` | "NZ payroll", "payday filing", "Holidays Act engine" are plan-gated features. |
| Webhook dispatch (for IRD callbacks/retries) | `backend/src/core/lib/webhookDispatcher.js` | Outbound gateway-event pattern reused for IRD submission retries. |
| Notifications | `backend/src/core/lib/notifications/` | Payday-filing-due, leave-approval, ACC-cap-reached alerts. |
| i18n | `backend/src/i18n/translator.js` | en-NZ payslip/ESS strings; te reo Māori labels where required (see §11). |
| Scheduler | `backend/src/core/lib/scheduler.js`, `backend/src/scheduler-worker.js` | Cron for "payday filing due in N hours", anniversary leave accrual. |
| Exporters | `backend/src/core/lib/exporters.js` | EI return file generation (CSV/JSON for myIR upload). |
| Reports | `backend/src/core/lib/reports.js` | Statutory registers, GL journal export. |

### 1.2 What we delete / ignore

Sitepresso's `backend/src/web`, `shop`, `booking`, profession themes, mailbox/domain resale — **none** of this is in the NZ compliance path.

### 1.3 New-build: versioned compliance rule tables

All NZ statutory numbers live in **versioned, effective-dated rule rows** owned by Super Admin (`admin.hr.com`), never hardcoded in calc code. This is the single most important architectural decision in this doc: rates change every 1 April; the Employment Leave Bill will change the leave model in ~2028; we must never ship code to change a number.

```
ComplianceRuleSet {
  id            uuid
  country       "NZ"
  domain        enum(PAYE, KIWISAVER, ESCT, ACC, STUDENT_LOAN, MINWAGE, HOLIDAYS, PARENTAL)
  version       int            // monotonic per (country, domain)
  effectiveFrom date           // inclusive, NZ tax year boundary = 1 Apr
  effectiveTo   date?          // null = current
  payload       jsonb          // the actual brackets/rates/thresholds
  publishedBy   userId
  publishedAt   datetime
  status        enum(DRAFT, PUBLISHED, SUPERSEDED)
  checksum      string         // SHA-256 of payload — tamper-evidence & audit
}
```

**Resolution rule:** for a pay run with payment date `D`, the engine selects, per domain, the rule row where `effectiveFrom <= D AND (effectiveTo IS NULL OR D <= effectiveTo)`. The **payment date** (not the period-worked date) governs which rates apply — IRD and ACC both key off payment date (confirmed: ACC 1.75% "effective for pay runs with a payment date on or after 1 April 2026"). A pay run straddling 31 Mar/1 Apr therefore uses the *new* rates if paid on/after 1 Apr.

> Cross-ref: the rule-set publishing workflow, draft→publish approval, and country tax-year clock live in `09-super-admin-compliance-rules.md`.

---

## 2. PAYE — Pay As You Earn

### 2.1 Income tax brackets (annual), effective 1 Apr 2025 → current (incl. 2026–27)

Confirmed unchanged for the **2026–27** tax year (no Budget change to brackets):

| Band | Taxable income (annual NZD) | Rate |
|---|---|---|
| 1 | $0 – $15,600 | 10.5% |
| 2 | $15,601 – $53,500 | 17.5% |
| 3 | $53,501 – $78,100 | 30% |
| 4 | $78,101 – $180,000 | 33% |
| 5 | $180,001 + | 39% |

There is **no tax-free threshold** — tax applies from the first dollar. These are **income tax only**; ACC earners' levy (§5) is a separate add-on collected through PAYE on the "M"/"ME" primary-code path.

> JSON payload shape stored in `ComplianceRuleSet(domain=PAYE)`:
> ```json
> { "brackets": [
>   {"upTo": 1560000, "rate": 0.105},
>   {"upTo": 5350000, "rate": 0.175},
>   {"upTo": 7810000, "rate": 0.30},
>   {"upTo": 18000000, "rate": 0.33},
>   {"upTo": null, "rate": 0.39}
> ], "amountsInCents": true }
> ```
> **We store all money in integer cents.** Float dollars are forbidden in the calc path (see §2.6).

### 2.2 PAYE computation method — annualised, not table-lookup

IRD publishes `IR340/IR341` weekly/fortnightly deduction tables, but production payroll engines compute PAYE **algorithmically** (the tables are derived from the same formula). Our method, per pay run line:

1. **Annualise** the taxable pay for the period: `annualised = periodTaxableGross × periodsPerYear` (52 weekly, 26 fortnightly, 24 semi-monthly, 12 monthly).
2. Apply the **progressive bracket function** to `annualised` → annual income tax.
3. Add **annual ACC earners' levy** = `min(annualLiableEarnings, 156641) × 0.0175` (only on M/ME primary codes; §5).
4. **De-annualise**: `periodPAYE = round(annualTaxPlusACC ÷ periodsPerYear)`.
5. **Extra pays / lump sums** (bonuses, back-pay, retros, redundancy) use the **extra-pay method** (§2.4), *not* annualisation, to avoid over-taxing.

> **Why annualise rather than table-lookup?** Tables only cover standard frequencies and round to whole dollars; annualising handles arbitrary frequencies, mid-period start/stop, and gives exact cents. We unit-test our bracket function against the published IR340 (Apr 2026) tables for weekly/fortnightly to prove parity (golden-file tests; §12).

### 2.3 Tax codes

The employee's **tax code** is the master switch. It encodes (a) primary vs secondary income, (b) student-loan flag, and (c) special-rate codes. Stored on `NzEmployeeTaxProfile`.

| Code | Meaning | PAYE behaviour |
|---|---|---|
| **M** | Main/highest-income job; **standard main code at any income level**, employee **not** claiming IETC | Bracket method + ACC |
| **M SL** | Main job, has student loan | M + 12% SL deduction over threshold (§6) |
| **ME** | Main job, **entitled to IETC** (income $24,000–$70,000, not on Working for Families / main benefit / NZ Super) | M + IETC built into the code (§2.3 note) |
| **ME SL** | ME + student loan | ME + SL |
| **SB / SB SL** | Secondary, *total* income from all sources ≤ $15,600 | Flat 10.5% (+ ACC; see note) |
| **S / S SL** | Secondary, $15,601–$53,500 | Flat 17.5% |
| **SH / SH SL** | Secondary, $53,501–$78,100 | Flat 30% |
| **ST / ST SL** | Secondary, $78,101–$180,000 | Flat 33% |
| **SA / SA SL** | Secondary, $180,001+ | Flat 39% |
| **WT** | Schedular payments (contractors) | Rate per IR330C; **no-notification = 45%** if no IR330C; payday-filed too |
| **CAE** | Casual agricultural employee | Special flat rate |
| **EDW** | Election-day worker | Special |
| **ND** | **No-notification** (employee gave no completed IR330) | **Income tax 45% + ACC earners' levy = 46.75% total PAYE** (the EI-return tax code is **ND**, *not* a 45% flat — that 45% flat is the *schedular/contractor* WT no-notification rate). Verified IR335 (Apr 2026). |
| **STC** | Special tax code (IRD-issued certificate) | Rate/amount per certificate |

**Critical rules the engine enforces:**
- **ACC earners' levy is added on primary codes (M/ME and the SL variants)** but the secondary flat-rate codes already bake ACC into the published secondary rates — the engine must apply ACC exactly once. We model this as `taxCode.includesAccInFlatRate: boolean` in the rule payload to avoid double-levying.
- **No-notification (ND) = 45% income tax + ACC = 46.75% total PAYE.** If an employee has no completed IR330 on file, the engine *must* fall to the **ND** code (income tax 45% + ACC earners' levy, reported as **ND** in the EI return) and flag the employee record red in ESS/HR until rectified. Validation gate, not a silent default. **Do not confuse this with the contractor/schedular WT no-notification rate of a flat 45%** — these are distinct rates and distinct codes (ND for employees, WT for schedular). Verified against IR335 (Apr 2026).
- **Secondary codes ignore the SL threshold** — student loan on secondary income is 12% of *every* dollar (§6).
- Tax code changes are **effective-dated**; a mid-period change splits the period at the effective date.

> **IETC (Independent Earner Tax Credit), 2026–27 figures (verified IRD, Jun 2026):** **$520/year ($10/week)** for income **$24,000–$66,000**, abating **13c per $1 over $66,000**, reaching **nil at $70,000**. Only on **ME-type primary** codes where the employee isn't receiving Working for Families, a main benefit, NZ Super, or an overseas equivalent. We compute it annualised and de-annualise like PAYE. Stored as a rule sub-payload. *(Correction: the previously-cited $24,001–$44,000 / nil-at-$48,000 band is the pre-July-2024 IETC and is no longer in force.)*

### 2.4 Extra pays & lump sums (the "extra-pay method")

Bonuses, commissions paid irregularly, back-pay, retiring/redundancy payments, and similar **extra pays** are taxed at a **flat rate determined by grossed-up annual income**, not annualised into a single period (which would over-tax):

1. Compute the employee's **estimated annual income** = (last 4 weeks' gross × 13) — i.e. grossed up to a year — *plus* the extra pay itself.
2. The marginal bracket that the **extra pay** falls into determines its flat rate (10.5 / 17.5 / 30 / 33 / 39%).
3. Add **ACC earners' levy (1.75%)** to the extra-pay rate **if** annual liable earnings haven't yet hit the $156,641 cap (the engine tracks YTD liable earnings and stops adding ACC once the cap is reached — see §5.3).
4. **Student loan** at 12% applies to extra pays too (no threshold relief on the extra-pay portion if the employee already exceeds the annual threshold).

**Redundancy / retiring allowances:** taxed as extra pays (lump-sum method); **not** liable for ACC earners' levy on the redundancy portion (ACC applies to "earnings as an employee" — redundancy is excluded). KiwiSaver: redundancy payments are **not** salary/wages for KiwiSaver, so no employee/employer contribution on them — engine flags these line types `kiwisaverLiable=false, accLiable=false`.

### 2.5 Schedular payments (contractors — WT)

Contractors who receive **schedular payments** (e.g. labour-only building, commission agents) have **withholding tax** deducted at a rate they nominate on **IR330C** (with statutory minimums by activity) and are **included in payday filing** (§3). They are **not** employees: no KiwiSaver, no ACC earners' levy through us (they pay ACC separately), no leave. The engine models them as `WorkerType.SCHEDULAR` with a distinct, slimmer calc path.

### 2.6 Rounding & money discipline (engine-wide)

- **Storage:** all monetary values are **integer cents** (`Int`/`BigInt`), never floats.
- **PAYE/levy rounding:** computed annual figures are de-annualised then **rounded to the nearest cent** using **round-half-up** for tax (IRD convention); we expose a single `roundTax(cents)` helper. Some statutory outputs (final PAYE per period) IRD rounds to whole cents — we follow IR340 conventions and pin them in golden tests.
- **Holidays Act rates** (OWP, AWE, RDP, ADP) are computed to **4 dp internally**, rounded to cents only at the payable-amount boundary, to avoid compounding rounding error across multi-day leave.
- Reuse: extend `backend/src/core/lib/currency.js` with `nzdRound`, `toCents`, `fromCents`. No new currency lib.

---

## 3. Payday Filing (the hard, near-real-time obligation)

### 3.1 What it is & the cadence

Since 1 Apr 2019, NZ employers **must file employment information (the "EI return") with IRD on or before the day, and within 2 working days of, every payday** — not monthly. This is the defining operational constraint of NZ payroll: **the filing is coupled to the pay event**, so our pay-run state machine (§3.4) must produce a filing artefact every single time.

| Obligation | Rule | Effective |
|---|---|---|
| EI return filing deadline | **Within 2 working days of payday** (electronic filers) | current |
| "Working day" definition | Mon–Fri excluding national public holidays | current |
| Electronic filing mandatory | If annual PAYE + ESCT **≥ $50,000** | current |
| Paper filing window | New employers <6 months OR PAYE+ESCT < $50k may file paper within 10 working days | current |
| New & departing employee details | Filed via the **"New and departing employees"** return (a.k.a. employee details), separate from EI | on hire/termination |
| PAYE/deductions **payment** to IRD | **20th** of the following month (small employers, monthly); **5th & 20th** (large employers, twice-monthly, PAYE+ESCT ≥ $500k/yr) | current |

> **Note the two separate deadlines.** *Filing* the EI return (the data) is within 2 working days of payday. *Paying* the deducted PAYE/KiwiSaver/SL/ESCT to IRD is on the **20th** (or **5th & 20th** for large employers). The platform must surface both as distinct obligations in the compliance calendar (`12-reporting-and-statutory-filings.md`).

### 3.2 EI return — field set (per pay-run, per employee line)

The EI return is filed per pay period; each employee appears as a line. Fields the engine must produce (mapped to IRD's EI schema):

| Field | Source | Notes |
|---|---|---|
| Employee name | `NzEmployee` | As registered |
| **IRD number** | `NzEmployeeTaxProfile.irdNumber` | 8–9 digits; **IRD-number checksum validated** on entry (§3.3) |
| **Tax code** | tax profile | One of §2.3 |
| **Pay period start / end** | pay run | |
| **Payday (payment) date** | pay run | Drives the 2-working-day clock |
| **Gross earnings** (incl. PAYE-able allowances) | calc | |
| **Earnings not liable for ACC** | calc | e.g. redundancy, certain lump sums |
| **PAYE / tax** | calc | Income tax + ACC earners' levy combined as "PAYE" |
| **Employee KiwiSaver deduction** | calc | 3.5% (or chosen 4/6/8/10%) |
| **Employer KiwiSaver (gross) contribution** | calc | 3.5% min, before ESCT |
| **ESCT** | calc | Per-employee tier (§4.4) |
| **Net KiwiSaver employer contribution** | calc | gross − ESCT |
| **Student loan deductions** | calc | Standard + any SLCIR/SLBOR (§6) |
| **Student loan additional deductions (SLCIR/SLBOR)** | calc | Commissioner/borrower extra |
| **Child support deductions** | deductions | Court/IRD-ordered |
| **Payroll giving donations** | deductions | With **tax credit** computed (§3.5) |
| **Family violence / other court deductions** | deductions | |
| **Start date / End date** | employment | When new/departing in period |
| **Prior period adjustments** | calc | Corrections to a previously filed period (amended return) |

### 3.3 Validation gates (must pass before a pay run can be "filed")

- **IRD number checksum.** NZ IRD numbers use a modulus-11 check digit. Engine validates on entry and at file time; invalid → hard block. (Algorithm: weighted sum of first 7/8 digits with weights [3,2,7,6,5,4,3,2], mod 11, etc. — implemented in `nz/validators/irdNumber.js`.) New employees without a valid IRD number must be put on the **no-notification (ND) code — 45% income tax + ACC = 46.75% PAYE** — until resolved (see §2.3).
- **Tax code present & valid** for worker type (no secondary code on a sole employer relationship without justification; WT only for schedular).
- **KiwiSaver status resolved** (active / opted-out / on savings-suspension / not-eligible) before filing — never "unknown".
- **Negative net pay guard.** If deductions exceed gross (e.g. over-deducted SL + child support), the engine blocks and routes to HR for a deduction-priority decision (§7).
- **Payday date not in the future beyond policy**, and the **2-working-day filing window** is computed from it and shown as a countdown.

### 3.4 Pay-run + filing state machine

```
DRAFT ──validate──▶ CALCULATED ──HR approve──▶ APPROVED ──pay──▶ PAID
                                                   │
                                                   └──generate EI──▶ FILING_PENDING
FILING_PENDING ──submit to IRD──▶ FILING_SUBMITTED ──IRD ack──▶ FILED
FILING_SUBMITTED ──IRD reject──▶ FILING_ERROR ──fix──▶ FILING_PENDING
FILED ──correction needed──▶ AMENDMENT_DRAFT ──submit──▶ AMENDMENT_FILED
```

- Transitions are **append-only audit events** (who/when/checksum), reusing the audit pattern from `backend/src/core/`.
- **Submission channel:** v1 we support **myIR file upload** (engine generates the EI return file via `exporters.js`) and **manual confirmation**; v2 adds **gateway (direct API) filing** via IRD's gateway services (requires IRD software registration, digital certificates). The state machine is identical; only the transport differs. Behind a `nzPaydayFilingMode` setting.
- **Retry/backoff** for API submission reuses `webhookDispatcher.js` semantics (idempotency key = pay-run id + version).
- **Amendments:** correcting a filed period creates an **amended EI return** referencing the original; never mutate a filed artefact (immutability for audit).

### 3.5 Payroll giving (donations) tax credit

If the employer offers payroll giving, donations to approved donee organisations earn an **immediate PAYE tax credit of 33⅓% (1/3) of the donation**, applied in the same pay. Engine: `credit = round(donationCents / 3)`, reduces PAYE payable (not below zero), reported as a distinct EI field.

---

## 4. KiwiSaver & ESCT

### 4.1 KiwiSaver contribution rates — the 1 Apr 2026 change

| Element | Before 1 Apr 2026 | **From 1 Apr 2026** | From 1 Apr 2028 |
|---|---|---|---|
| **Default employee rate** | 3% | **3.5%** | 4% |
| **Default minimum employer rate (matching)** | 3% | **3.5%** | 4% |
| Employee-electable rates | 3, 4, 6, 8, 10% | 3.5, 4, 6, 8, 10% | 4, 6, 8, 10% |
| **16–17 year olds: employer contributions** | Not required | **Required (employer must contribute & match) — from 1 Apr 2026** | continues |
| Government (member) contribution — 16–17yo eligibility | Extended to 16–17yo **from 1 Jul 2025** (IRD-paid, not payroll) | continues | continues |
| Government contribution rate / cap | 50c per $1, max $521.43 | **25c per $1, max $260.72 — from 1 Jul 2025**; **nil if income > $180,000** | continues |
| **Temporary rate reduction** | n/a | Employee may apply to keep contributing at **3%** for **3–12 months** from 1 Apr 2026 | — |

**Engine rules:**
- **Employee rate** comes from the employee's election (`NzKiwiSaverProfile.employeeRate`), defaulting to the rule-set default (3.5% from 1 Apr 2026). Valid values are constrained to the rule-set's allowed set for the payment date.
- **Employer rate** = `max(electedEmployerRate, ruleSet.minEmployerRate)` (3.5% from 1 Apr 2026). Employers may *exceed* the minimum but never go below for eligible members.
- **16–17yo handling.** Before 1 Apr 2026, employees aged 16–17 received employee deductions if they opted in but **no compulsory employer contribution**. From **1 Apr 2026**, the engine **must** start employer contributions for eligible 16–17yo members on the first payday on/after their 16th birthday-rule date. This is age-and-date-sensitive logic: we compute age at payment date and consult the rule set's `employerContribMinAge` (drops to 16 from 1 Apr 2026; was effectively 18). **Eligibility for employer contribution ends at NZ Super age (65)** unless the member is within their 5-year lock-in.
- **Contributions base = "salary or wages"** for KiwiSaver, which **excludes** redundancy, certain allowances, and some lump sums — engine line-types carry `kiwisaverLiable`.
- **Temporary rate reduction (new 1 Apr 2026).** An employee may apply to IRD to keep contributing at **3%** (the pre-1-Apr-2026 default) for a chosen period of **3–12 months** rather than auto-stepping to 3.5%. The engine models this as `NzKiwiSaverProfile.temporaryRateReduction { rate: 3.0, expiry: date }`; while active, `employeeRate = 3.0` and `min employer rate still 3.5%` (the *employer* minimum is **not** reduced by an employee's temporary reduction). Auto-reverts to the rule-set default at `expiry`. This is an explicit, dated override — not a permanent election.
- **Government (member) contribution** (25c/$1, max $260.72 from 1 Jul 2025; nil over $180,000 income) is **paid by IRD directly to the member's scheme, not through payroll** — the engine does **not** calculate or remit it. It is noted here only because it bears on member messaging in ESS.

### 4.2 Enrolment, opt-out, savings suspension (state machine)

```
NOT_MEMBER ──auto-enrol (new employee, eligible)──▶ AUTO_ENROLLED (deductions start day 1)
AUTO_ENROLLED ──opt-out (days 14–56 window)──▶ OPTED_OUT (refund employee deductions)
AUTO_ENROLLED ──no opt-out by day 56──▶ ACTIVE
NOT_MEMBER ──opt-in (employee elects)──▶ ACTIVE
ACTIVE ──savings suspension (≥12 months membership, IRD-approved)──▶ SUSPENDED (deductions stop, expiry date set)
SUSPENDED ──expiry / employee resumes──▶ ACTIVE
ACTIVE ──reaches NZ Super age + 5yr lock-in passed──▶ ELIGIBLE_TO_WITHDRAW (employer contrib optional)
```

- **Auto-enrolment** applies to **new employees aged 18–64** starting a new job who are eligible (NZ/residence + work eligibility). Deductions start from the **first pay**; the **opt-out window is days 14–56** of employment. If the employee opts out in window, the engine **refunds employee deductions** and reverses any employer contribution per rules.
- **Savings suspension** (formerly "contributions holiday"): available after **12 months** of membership (or earlier on financial-hardship grounds via IRD); minimum 3 months, max 12 months, renewable. While `SUSPENDED`, employee deductions stop; **employer is not required to contribute** during a valid suspension. Engine stores `suspensionStart`, `suspensionExpiry` and auto-resumes.
- **Existing members** joining a new employer: deductions resume at their last/known rate; employer must contribute (subject to age rules). No new opt-out window.
- **Eligibility flags** the engine must persist: `nzResidentOrEligible`, `dateOfBirth`, `firstAutoEnrolDate`, `optOutDeadline`, `membershipStartDate`.

### 4.3 Employer contribution & ESCT relationship

The **employer KiwiSaver contribution is itself taxed** via **ESCT (Employer Superannuation Contribution Tax)**, deducted from the employer contribution before it's paid to the scheme. So:

```
employerGrossContribution = kiwiSaverWages × employerRate(≥3.5%)
esct                      = employerGrossContribution × esctRate(employee tier)
employerNetContribution   = employerGrossContribution − esct
```

Both **gross employer contribution** and **ESCT** are reported in payday filing (§3.2). The **net** goes to the employee's KiwiSaver provider; **ESCT goes to IRD** with PAYE.

> **Important:** the *employee* 3.5% deduction is from **after-tax** pay conceptually but computed on **gross salary/wages** and deducted alongside PAYE; it is **not** reduced by ESCT. ESCT applies **only** to the *employer* contribution. A frequent vendor bug is applying ESCT to the employee side — our engine has an explicit invariant test forbidding it.

### 4.4 ESCT tiers (effective 1 Apr 2025 → current, incl. 2026–27)

The ESCT rate is set **per employee, per tax year ("set and forget")** based on the employee's **prior-year total taxable salary/wages + employer KiwiSaver contributions** (or, for employees employed <1 prior year, an estimated annualised figure):

| ESCT rate | Prior-year income threshold (NZD) |
|---|---|
| 10.5% | $0 – $16,800 |
| 17.5% | $16,801 – $57,600 |
| 30% | $57,601 – $84,000 |
| 33% | $84,001 – $216,000 |
| 39% | $216,001 + |

**Engine rules:**
- ESCT tier is computed **once at the start of each NZ tax year (1 Apr)** per employee and stored on `NzKiwiSaverProfile.esctRateForYear` with the year stamp. We recompute on 1 Apr (scheduler job) and on first-pay for new hires (using estimated annualised income = current-period KiwiSaver-liable wages × periodsPerYear + employer contrib).
- For **new employees** with no prior-year history, use the **estimated annual** salary + employer contributions for the **current** year.
- Employer may **alternatively** voluntarily agree the contribution is treated under the employee's marginal rate via a "complying fund" — out of scope v1; we implement the standard ESCT tier method.

### 4.5 Worked example — KiwiSaver + ESCT (post-1 Apr 2026)

Employee earns **$2,000 gross/fortnight** (KiwiSaver-liable wages = $2,000), employee rate **3.5%**, employer rate **3.5%**, prior-year income **$52,000** → ESCT tier **17.5%**.

```
Employee KiwiSaver deduction = 2000.00 × 3.5%  = $70.00   (deducted from pay, to provider)
Employer gross contribution  = 2000.00 × 3.5%  = $70.00
ESCT                         = 70.00 × 17.5%   = $12.25   (to IRD)
Employer net contribution    = 70.00 − 12.25   = $57.75   (to provider)
```

Payday filing line: employee KS deduction **$70.00**, employer gross KS **$70.00**, ESCT **$12.25**.

---

## 5. ACC Earners' Levy

### 5.1 Rate & cap — the 1 Apr 2026 change

| Element | 2025–26 | **2026–27 (from 1 Apr 2026)** |
|---|---|---|
| Earners' levy rate | 1.67% ($1.67 per $100) | **1.75% ($1.75 per $100)** |
| Maximum liable earnings | $152,790 | **$156,641** |
| **Maximum annual levy** | — | **$2,741.22** (= 156,641 × 1.75%) |

The earners' levy funds ACC's cover for non-work injuries and is collected **through PAYE** on **primary tax codes (M/ME and SL variants)**. Secondary flat-rate codes have ACC embedded in the published secondary rate.

> **Note on the published rate.** IRD/ACC publish the earners' levy as **$1.75 per $100 of liable earnings, GST-inclusive** — that GST-inclusive figure *is* the rate deducted through PAYE and the one we store. No separate GST handling is required in the calc path. (Verified: ACC earners' levy 2026/27, IRD.)

### 5.2 What's liable

- **Liable:** salary, wages, most regular taxable earnings, taxable allowances, overtime, bonuses/commissions (as earnings).
- **Not liable:** redundancy/retiring payments, certain lump sums, schedular payments (contractors pay ACC separately), employer KiwiSaver contributions, non-taxable reimbursements.
- Engine line-types carry `accLiable: boolean`; "Earnings not liable for ACC" is a distinct EI field (§3.2).

### 5.3 Annual cap tracking (YTD)

The levy is charged **per dollar up to the annual cap of $156,641**. The engine maintains **YTD liable earnings per employee per tax year** (`NzEmployeeYtd.accLiableEarnings`). Each pay run:

```
remainingCap   = max(0, 156641_00 − ytdAccLiableEarnings)
accThisPeriod  = min(periodAccLiableEarnings, remainingCap) × 1.75%
```

Once YTD liable earnings reach the cap, **no further earners' levy** is deducted for the rest of the tax year. This must be tracked even across **extra pays** (§2.4). On **1 Apr** the YTD resets. **Employee changing jobs mid-year:** each employer applies the levy to the cap independently (employee may over-pay and reconcile via IR3 — not our concern, but we must *not* try to net across employers).

### 5.4 Worked example — ACC cap reached

Employee paid **$13,200 gross/month**, M tax code, all ACC-liable.

```
Annual liable = 13,200 × 12 = $158,400  > cap $156,641
Months Apr–Dec (9 months): 9 × 13,200 = $118,800  (under cap, full levy each)
By month 12 cumulative liable would be $158,400.
The engine charges 1.75% on each month until YTD hits $156,641, then stops.
Month in which cap is crossed: 156,641 − (11 × 13,200=145,200) = $11,441 remaining
   → ACC on $11,441 only = $200.22 that month; $0 thereafter.
Total annual ACC = 156,641 × 1.75% = $2,741.22 (the statutory max).
```

---

## 6. Student Loan Deductions

### 6.1 Rate & thresholds

| Element | Value (2025–26 / 2026–27) |
|---|---|
| Standard repayment rate | **12%** of every dollar **over** the pay-period threshold |
| Annual repayment threshold | **$24,128** (2026 tax year) |
| Weekly threshold | **$464** |
| Fortnightly threshold | **$928** |
| Four-weekly threshold | **$1,856** |
| Monthly threshold | **$2,010.67** |
| **Secondary income (SL on S/SH/ST/SA SL codes)** | **12% of every dollar, no threshold** |

> Threshold figures are stored in `ComplianceRuleSet(domain=STUDENT_LOAN)` per frequency; verify exact weekly/monthly cents against IR340 Apr 2026 at publish time. The 12% rate and $24,128 annual / $464 weekly are confirmed for the 2026 tax year.

### 6.2 Deduction types

| Type | Code | Meaning |
|---|---|---|
| Standard | `SL` | 12% over threshold (primary) / 12% flat (secondary) |
| **SLCIR** | Commissioner deduction | IRD instructs **extra** deductions to clear arrears — added on top of standard |
| **SLBOR** | Borrower deduction | Employee **voluntarily** asks for extra deductions |
| Special deduction rate (SDR) | IRD certificate | Replaces the standard rate when IRD issues one |

The engine supports all four, each a distinct EI field. **Repayment threshold applies once per pay period** on the standard portion only.

### 6.3 Worked example

Employee, **M SL** tax code, **$600/week** gross:

```
Over threshold = 600.00 − 464.00 = $136.00
Standard SL    = 136.00 × 12%    = $16.32
```

If IRD has issued an **SLCIR of $20/week** (arrears), total SL = $16.32 + $20.00 = **$36.32**, reported split (standard $16.32, SLCIR $20.00).

---

## 7. Deduction Priority & Net-Pay Protection

When gross can't cover all statutory + voluntary deductions, NZ law sets a priority. The engine applies deductions in this order, never letting later items push net pay below zero (and flagging if a higher-priority item itself can't be fully met):

1. **PAYE (income tax + ACC earners' levy)** — always first, non-negotiable.
2. **Student loan** (standard, then SLCIR, then SLBOR).
3. **Child support** (IRD-ordered) — subject to a **protected net earnings** rule: child support deductions cannot reduce net pay below **60% of after-tax pay** (the protected earnings provision). If hit, the engine deducts only up to the protected limit and carries the shortfall per IRD rules.
4. **KiwiSaver employee deduction.**
5. **Court fines / family violence / other statutory deductions.**
6. **Voluntary deductions** (union fees, social club, advances, payroll giving) — only with written consent (Wages Protection Act); engine requires a `consentRef` for each voluntary deduction.

**Minimum wage top-up interaction:** if applying deductions or low hours would take effective pay below minimum wage for hours worked, the engine raises a **minimum-wage breach** warning (§8) — but minimum wage is about *gross for hours worked*, not net after voluntary deductions, so we distinguish the two checks.

---

## 8. Minimum Wage

### 8.1 Rates (effective 1 Apr 2026)

| Type | Rate/hour (from 1 Apr 2026) | Prior (to 31 Mar 2026) |
|---|---|---|
| **Adult** | **$23.95** | $23.50 |
| **Starting-out** | **$19.16** (80% of adult) | $18.80 |
| **Training** | **$19.16** (80% of adult) | $18.80 |

- **Adult** applies to employees **16+** not on starting-out/training rates.
- **Starting-out**: 16–17yo in first 6 months, 18–19yo who've been on a benefit, and 16–19yo trainees in specified situations.
- **Training**: 20+ employees doing ≥60 credits/yr toward an industry qualification.
- There is **no minimum wage for under-16s** (but other protections apply).

### 8.2 Enforcement in engine

Minimum wage is a **per-hour-worked** test on **gross earnings for the period attributable to those hours** (excluding genuine overtime premium loadings from the test base in some interpretations — we test against base ordinary pay). Each pay run, for hourly/waged employees:

```
effectiveHourlyRate = grossOrdinaryPay ÷ hoursWorked
if effectiveHourlyRate < applicableMinWage(employee category, payment date):
    raise MIN_WAGE_BREACH (hard warning, requires HR override + reason; logged)
```

- Salaried employees: the engine annualises salary ÷ contracted hours and checks — particularly important for salaried staff working long hours (a salaried employee can breach minimum wage if hours are high).
- **Deductions cannot take pay below minimum wage** for the hours worked (Wages Protection Act + Minimum Wage Act interplay).

---

## 9. Holidays Act 2003 — The Flagship Module

> This is the most legally complex and highest-liability area in NZ payroll. The industry has paid out **billions** in remediation because vendors mis-implemented it. Our differentiator is **provable correctness**: every leave payment records its method, inputs, and the exact window used. This section is the engine spec.

### 9.1 The four pay rates — when each applies

The Act defines **four** ways to value a day/week of leave. The engine must pick the legally-correct one per leave type, and for annual holidays must compute **two and take the greater**.

| Rate | Definition | Used for |
|---|---|---|
| **OWP — Ordinary Weekly Pay** (s 8) | What the employee normally gets in a week | Annual holidays (compared with AWE) |
| **AWE — Average Weekly Earnings** (s 5) | 1/52 of **gross earnings** over the last 52 weeks | Annual holidays (compared with OWP) |
| **RDP — Relevant Daily Pay** (s 9) | What the employee **would have earned had they worked** that specific day | Public holidays, alternative (lieu) days, sick, bereavement, family violence |
| **ADP — Average Daily Pay** (s 9A) | Daily average of gross earnings over last 52 weeks | The above, **only when RDP not possible/practicable or pay varies** |

### 9.2 Gross earnings (s 14) — the master input

Almost everything turns on **gross earnings**. The engine maintains a per-employee, per-pay-period ledger of gross earnings classified by inclusion:

**Included in gross earnings (and therefore in AWE/ADP and the 4-week OWP average):**
- Salary and wages, including for annual/public/sick/bereavement/alternative holidays already paid
- Allowances (taxable) — productivity, shift, etc.
- Overtime
- Commission, piece rates, incentive/productivity payments
- The **cash value of board or lodgings**
- First-week ACC top-up paid by employer; payments for time off on public holidays/leave
- Bonuses that are part of the bargain (genuinely discretionary one-offs are **excluded** — and this distinction is litigated; we make it an explicit, auditable per-payment flag `discretionary: boolean`)

**Excluded from gross earnings:**
- **Discretionary** payments (genuinely at employer's sole discretion — e.g. a true ex-gratia bonus)
- Weekly compensation under ACC (paid by ACC, not employer)
- Reimbursements of actual costs
- Employer KiwiSaver contributions
- Payments on termination of leave not taken (to avoid double counting in some calcs)

> **Design rule.** Every earnings line type in the system carries explicit flags: `grossEarningsForHolidaysAct`, `owpOrdinary` (is it part of "normal" weekly pay), `accLiable`, `kiwisaverLiable`, `discretionary`. These flags — not free-text categories — drive every Holidays Act calculation. This is how we make correctness *provable* and *testable*.

### 9.3 OWP — Ordinary Weekly Pay (s 8)

**OWP is what the employee normally receives in a week.** Two routes:

- **s 8(1) — specified/derivable OWP:** if the employment agreement specifies a weekly pay, or it's readily derivable (fixed salary, fixed hours × rate + regular allowances/commissions that are part of normal pay), use that.
- **s 8(2) — the formula** (used when OWP isn't clear/derivable, e.g. variable pay):

```
OWP = (a − b) ÷ c

where:
  a = gross earnings for the 4 calendar weeks before the end of the pay period
      immediately before the calculation (i.e. before the holiday)
  b = the total of any payments in 'a' that the employer is NOT bound, by the
      agreement, to pay (one-off/irregular amounts not part of ordinary weekly pay)
  c = 4  (the number of weeks)
```

**Engine implementation:**
- Maintain a rolling 4-complete-week window ending at the last completed pay period before the holiday's start.
- `a` = sum of gross earnings (per §9.2) in that window.
- `b` = sum of lines flagged `owpOrdinary=false` within that window (irregular/non-bargained amounts).
- `OWP = (a − b) / 4`, to 4 dp.
- **Use the greater of s 8(1) and s 8(2)** where both can be computed (best-practice; some employers always use the formula for variable staff — configurable per `NzHolidaysPolicy.owpMethod = SPECIFIED | FORMULA | GREATER_OF`).

### 9.4 AWE — Average Weekly Earnings (s 5)

```
AWE = (gross earnings over the 52 weeks ending at the end of the last pay period
       before the annual holiday) ÷ 52
```

- If employed **< 52 weeks**, divide by the **number of whole or part weeks** employed.
- Uses **gross earnings** per §9.2 (so it captures commissions, overtime, etc. that OWP might miss).
- Computed to 4 dp.

### 9.5 Annual holidays — entitlement, accrual & payment (ss 16–28)

**Entitlement:** **4 weeks' paid annual holidays** after **12 months' continuous employment** (each anniversary). Accrual is *entitlement-based at the anniversary*, but the engine also tracks **pro-rata accrued (not yet entitled)** for termination pay-out and visibility.

**Two balances the engine maintains per employee:**
1. **`annualHolidayEntitledWeeks`** — weeks that have *vested* (post-anniversary), valued at **greater of OWP and AWE** when taken.
2. **`annualHolidayAccruedGrossEarnings`** — the running gross-earnings figure used for the **8% pro-rata** value of *not-yet-entitled* leave (for termination and for employees who agree to be paid annual holidays as 8% PAYG — see §9.6).

**Payment when a vested annual holiday is taken:**
```
weeklyRate   = max(OWP, AWE)        // computed at the start of the holiday
dailyRate    = weeklyRate ÷ agreedWorkingDaysPerWeek   // for part-week leave
payment      = weeklyRate × weeksTaken  (or dailyRate × daysTaken)
```

> **"Weeks" not "days" is the unit.** A core Act principle (and a major source of vendor bugs) is that annual holidays are measured in **weeks**, then apportioned to the employee's **agreed working days/week**. The engine stores leave in weeks and converts to days using the employee's work pattern — it must **never** silently treat 4 weeks as "20 days" for someone who works a different pattern. Variable/changing work patterns require recalculating the "what is a week" question; the engine flags employees with irregular patterns for the OWP/ADP path and records the pattern used (`NzWorkPattern` with effective dates).

**Cash-up:** an employee may request to **cash up up to 1 week** of annual holidays per entitlement year (employer may decline). Valued at greater of OWP/AWE. Engine: `cashUpWeeksThisYear ≤ 1` invariant.

### 9.6 8% Pay-As-You-Go (s 28) & "closedown" 8%

Two distinct 8% scenarios — the engine treats them separately:

1. **PAYG annual holiday pay (s 28)** — permitted **only** for employees on a **genuine fixed-term agreement < 12 months** OR whose **work is so intermittent/irregular it's impracticable to provide 4 weeks off**. They get **8% of gross earnings added to each pay** *instead of* taking annual holidays. Must be **agreed in writing**, **shown as a separate, identifiable amount** on the payslip, and the engine forbids it for ordinary permanent staff (validation gate). `8% = grossEarningsThisPay × 0.08`.

2. **Pro-rata / "8%" on termination & before first anniversary** — see §9.10. Before an employee reaches 12 months, their annual-holiday value is **8% of gross earnings since start (less any annual holidays already taken in advance)**. This 8% is the statutory proxy for "4 weeks/year" accrued pro-rata.

> **8% is not a substitute for the greater-of-OWP/AWE on vested leave.** Once an employee is entitled (post-anniversary), vested annual holidays are paid at **greater of OWP/AWE**, *not* 8%. The 8% method is only for PAYG, pre-entitlement, and termination of accrued-but-not-entitled balances. Mixing these up is a classic remediation cause; the engine's leave-valuation router (§9.12) encodes the decision explicitly.

### 9.7 Public holidays (ss 44–50) & the "otherwise working day" test

**11 national public holidays** + the relevant **regional anniversary day**. 2026 dates (engine seeds these per year into `NzPublicHoliday`):

| Holiday | 2026 date | Mondayised? |
|---|---|---|
| New Year's Day | Thu 1 Jan 2026 | — |
| Day after New Year's | Fri 2 Jan 2026 | — |
| Waitangi Day | Fri 6 Feb 2026 | — |
| Good Friday | Fri 3 Apr 2026 | — |
| Easter Monday | Mon 6 Apr 2026 | — |
| ANZAC Day | **Sat 25 Apr 2026 → observed Mon 27 Apr** | **Mondayised** |
| King's Birthday | Mon 1 Jun 2026 | — |
| Matariki | Fri 10 Jul 2026 | — |
| Labour Day | Mon 26 Oct 2026 | — |
| Christmas Day | Fri 25 Dec 2026 | — |
| Boxing Day | **Sat 26 Dec 2026 → observed Mon 28 Dec** | **Mondayised** |
| + Regional anniversary day | varies by region | per `business.region` |

**Mondayisation rule:** when New Year's, Day-after, Waitangi, ANZAC, Christmas, or Boxing Day falls on a **Saturday or Sunday** *and that weekend day is not an "otherwise working day"* for the employee, the holiday is **observed on the next Monday** (or Tuesday if Monday is already taken). **The employee gets ONE entitlement**, on whichever date is their otherwise-working-day — never two.

#### The "otherwise working day" (OWD) test — the crux

For **every** public-holiday and alternative-day decision, the engine must answer: **would this employee otherwise have worked on this day?** (s 12). The test, in priority order:

1. **Agreement says so** — roster/agreement explicitly covers the day.
2. **Regular pattern** — does the employee usually work this day of week? (e.g., works every Tuesday → a Tuesday public holiday is an OWD).
3. If unclear, consider: rosters, work history (look back over a representative period), nature of the work, whether the employee works only when work is available, what the parties would have agreed.

The engine implements OWD as a **deterministic function over the employee's `NzWorkPattern` + roster + N-week history**, returning `{isOWD: boolean, confidence, reason}`. Low-confidence cases are flagged to HR for a recorded human decision (stored, auditable). **This function is unit-tested exhaustively** — it gates four different entitlements:

| Scenario on a public holiday | Entitlement |
|---|---|
| OWD **and employee does NOT work** | Paid the day at **RDP** (or ADP if applicable) — a paid day off |
| OWD **and employee works** | Paid **time-and-a-half (1.5×) for hours worked** **AND** an **alternative (lieu) day** |
| **Not** OWD and employee works | Paid **time-and-a-half** for hours worked; **no** alternative day |
| **Not** OWD and doesn't work | **Nothing** (it wasn't a working day) |

- **Time-and-a-half base** = the greater of the portion of relevant daily pay / hourly equivalent, ×1.5, for actual hours worked. Engine computes `1.5 × hourlyRate × hoursWorked` where hourlyRate derives from RDP.
- **Alternative day value** when later taken = **RDP** for the day it's taken (or ADP if applicable) — full day's pay regardless of hours. Alternative days **don't expire** but employer/employee can agree to cash up one not taken within 12 months.

### 9.8 RDP — Relevant Daily Pay (s 9)

**RDP answers: "what would the employee have earned had they actually worked that day?"** Used for sick, bereavement, family violence, public holidays (not worked), and alternative days. Components:

```
RDP for a day =
    base salary/wages for the hours that would have been worked that day
  + regular taxable allowances for that day
  + productivity/incentive/commission/piece-rate that would have been earned
  + overtime that would have been worked (if it would have been)
  + cash value of board/lodgings for that day
  − (employer KiwiSaver, non-taxable reimbursements are NOT included)
```

If the employee's daily pay is **constant and knowable**, RDP is exact and preferred.

### 9.9 ADP — Average Daily Pay (s 9A) — when RDP can't be used

ADP may be used **only if**: (a) it is **not possible or practicable** to determine RDP (e.g. genuinely variable hours/pay), **OR** (b) the employee's **pay varies within the pay period** in question.

```
ADP = grossEarnings(last 52 weeks) ÷ (number of whole + part days the employee
      worked OR was on paid leave/holidays during those 52 weeks)
```

- The **denominator counts paid days** (worked + paid leave/holidays), not calendar days.
- Computed to 4 dp.
- The engine records, per leave payment, **which method (RDP vs ADP) and why** (the s 9A trigger). HR cannot pick ADP arbitrarily where RDP is determinable — the router enforces the legal precondition.

### 9.10 BAPS Leave — Sick, Bereavement, Family Violence (current Holidays Act regime)

| Leave | Entitlement | Qualifying period | Cap / carryover | Paid at |
|---|---|---|---|---|
| **Sick leave** | **10 days/year** | After **6 months** continuous employment (then each 12-month anniversary) | Unused carries over to **max 20 days** accrued | **RDP** (or ADP) |
| **Bereavement** | **3 days** per bereavement (immediate family: spouse/partner, parent, child, sibling, grandparent, grandchild, partner's parent); **1 day** for other bereavements at employer's discretion | After 6 months (or work test) | Per event | **RDP** (or ADP) |
| **Family violence leave** | **10 days/year** | After 6 months **or** work test (avg ≥10 h/week, ≥1 h every week or ≥40 h/month) | Does not carry over | **RDP** (or ADP) |

- **Sick leave is in days, not hours**, under the current Act (this changes under the Employment Leave Bill — §13). A "day" = an otherwise-working day; taking sick leave on a day you'd otherwise work consumes 1 day's entitlement and pays RDP for that day. **Part-day** sickness: taking part of an OWD as sick leave still consumes a full day's entitlement (Act treats it as a day) — engine flags this and lets policy allow part-day tracking, but the statutory floor is whole days.
- **Work test** for BAPS eligibility (the 6-month alternative): averaged ≥10 h/week over the period, working at least 1 h every week or 40 h every month. Engine evaluates from attendance/timesheet history.

### 9.11 Parental Leave (Parental Leave and Employment Protection Act 1987 — adjacent, IRD-paid)

- **Up to 26 weeks government-funded Paid Parental Leave (PPL)**, administered & **paid by IRD, not the employer**. The employer's payroll **does not pay PPL** but must (a) hold the job, (b) handle KiwiSaver implications, (c) record leave status, (d) handle "keeping-in-touch" hours.
- **PPL maximum weekly rate:** **$788.66/week** (1 Jul 2025–30 Jun 2026) → **$811.05/week from 1 Jul 2026** (annual AWE-indexed uplift). Stored in `ComplianceRuleSet(domain=PARENTAL)` with a **1 July** effective boundary (note: PPL indexes on **1 July**, not 1 April — the engine's effective-date resolver handles per-domain boundaries).
- **Effect on annual-holiday rate:** time on parental leave **reduces AWE** (gross earnings drop), so annual holidays taken in the **12 months after returning** from parental leave are paid at **AWE only is disadvantageous** → the Act provides that during that 12-month window the employee is paid the **greater of OWP and AWE**, but where AWE is depressed by the leave, employees often receive a lower rate. The engine must flag "post-parental-leave annual holiday" so HR understands the (lawful) lower AWE and the s 16(2)/(3) interaction. We surface this clearly rather than hide it.
- **KiwiSaver during parental leave:** no salary → no employee/employer contributions during unpaid portions; IRD PPL is not "salary or wages" for employer KiwiSaver. Engine pauses contributions, resumes on return.

### 9.12 Leave-valuation router (the decision engine)

The single function `valueLeave(employee, leaveType, date(s), context)` deterministically returns `{method, ratePerUnit, amount, window, inputs, reasonCodes}`:

```
switch(leaveType):
  ANNUAL_HOLIDAY (vested):       rate = max(OWP, AWE);  unit = week→days by work pattern
  ANNUAL_HOLIDAY (pre-entitle):  8% of gross earnings (termination/PAYG only)
  PUBLIC_HOLIDAY (OWD, not worked):  RDP (or ADP if s9A trigger)
  PUBLIC_HOLIDAY (worked):           1.5 × hourly(RDP) × hoursWorked  (+ ALT_DAY accrued)
  ALTERNATIVE_DAY (taken):           RDP (or ADP)  — full day
  SICK / BEREAVEMENT / FAMILY_VIOLENCE: RDP (or ADP if s9A trigger)
return result with: method, the exact 4-week/52-week window dates used,
       a/b/c or numerator/denominator values, reasonCodes, and a checksum.
```

**Every leave payment persists its full derivation** (`NzLeavePaymentDerivation` row) so an auditor — or the employee in ESS — can see *exactly* why they were paid what they were paid. This audit trail is the product's NZ compliance moat.

### 9.13 Worked examples — Holidays Act

**Example A — Annual holiday, greater of OWP vs AWE.**
Salaried employee, base $1,500/week, plus regular commission averaging $300/week over last 52 weeks, takes **1 week** annual holiday.
```
OWP (s8(1) specified base) = $1,500.00  (commission is variable → use formula too)
OWP (s8(2) formula): last 4 weeks gross = 4×1500 + (commissions 280+320+300+340=1240)
   a = 6000 + 1240 = 7240; b = 0 (all part of normal earnings); c = 4
   OWP = 7240 ÷ 4 = $1,810.00
AWE = 52-week gross (1500×52 + 300×52 = 78,000 + 15,600 = 93,600) ÷ 52 = $1,800.00
Pay = max(OWP 1810.00, AWE 1800.00) = $1,810.00 for the week.
```
The greater-of test gives **$1,810.00** — capturing the recent commission uplift. (Had we naively used base salary $1,500 we'd have **underpaid by $310** — exactly the kind of error that triggers remediation.)

**Example B — Public holiday worked, OWD.**
Hourly employee, $30/hr, normally works Mondays (OWD), works **8 hours** on Labour Day (Mon 26 Oct 2026).
```
Time-and-a-half for hours worked = 1.5 × 30 × 8 = $360.00
PLUS an Alternative Day accrued (taken later, valued at RDP = $240 for an 8h day).
Total for the day = $360.00 now + a lieu day worth $240.00 banked.
```

**Example C — Public holiday not worked, OWD.**
Same employee doesn't work Labour Day (an OWD).
```
Paid RDP for the day = 30 × 8 = $240.00 (a paid day off). No alternative day.
```

**Example D — Sick day, variable-hours employee (ADP).**
Casual with variable hours; RDP not practicable. Last 52 weeks gross = $36,400; paid days = 182.
```
ADP = 36,400 ÷ 182 = $200.00  → sick day paid $200.00. Method recorded: ADP (s9A: variable pay).
```

**Example E — 8% PAYG (genuine short fixed-term).**
3-month fixed-term, gross this pay $2,000.
```
Holiday pay added = 2,000 × 8% = $160.00, shown as a separate line "Annual holiday pay (8%)".
```

---

## 10. Termination / Final Pay

On termination the engine computes:

1. **Unused vested annual holidays** → paid at **greater of OWP and AWE** at termination.
2. **Pro-rata accrued (not-yet-entitled) annual holiday** → **8% of gross earnings since last anniversary (or start)**, *less* any annual holidays taken in advance.
3. **Unused alternative (lieu) days** → paid at **RDP** for the final pay day.
4. **Public holidays falling in the notice/holiday-pay-out period** — special rule: if an annual-holiday payout on termination *spans* a public holiday the employee would otherwise have worked, that public holiday is paid **in addition** (s 40). Engine checks the calendar.
5. **Sick/bereavement/family-violence** balances are **not** paid out (not statutory entitlements to cash).
6. **Outstanding deductions** (advances, etc.) netted per consent + Wages Protection Act.
7. **Final PAYE/KiwiSaver/SL/ACC** on all of the above; **redundancy** taxed as extra pay (§2.4), ACC-exempt, KiwiSaver-exempt.

Final pay is itself a **payday filing event** — the EI return with the employee's **end date** must be filed within 2 working days, and the **"departing employee" details** return submitted.

---

## 11. Localization, Payslips & ESS (NZ specifics)

- **Locale `en-NZ`** strings via `backend/src/i18n/translator.js`; **te reo Māori** labels available for ESS (e.g., "Hararei ā-tau" = annual holidays) — a meaningful trust signal in NZ; behind locale toggle.
- **Payslip (statutory expectations).** While NZ doesn't mandate a specific payslip format, employers **must** keep wage & time and holiday & leave records, and provide leave details on request. Our payslip always shows: gross, PAYE (with ACC component identified), KiwiSaver employee + employer + ESCT, student loan (incl. SLCIR/SLBOR split), child support, net pay, **leave balances (annual in weeks AND days, sick in days, alternative days)**, and **for each leave payment the method used** (OWP/AWE/RDP/ADP) — the transparency differentiator.
- **Holiday & wage-time records** retained per `Holidays Act s 81` and `Employment Relations Act` — **6 years** retention; immutable, exportable.

---

## 12. Testing, Audit & Provable Correctness

- **Golden-file PAYE parity:** unit tests assert our bracket function reproduces IRD **IR340 (Apr 2026)** weekly & fortnightly deduction tables to the cent for representative incomes and every tax code.
- **Holidays Act property tests:** for the leave router, property-based tests assert invariants — e.g. *annual holiday pay is always ≥ both OWP and AWE individually never less*; *ESCT never applied to employee side*; *ACC never exceeds $2,741.22/yr*; *no employee paid below applicable minimum wage*; *alternative day only when OWD ∧ worked*.
- **Derivation audit:** every leave/levy/tax line stores its inputs + method + checksum (`NzLeavePaymentDerivation`, `NzTaxLineDerivation`). Reproducibility: re-running the calc on stored inputs must yield byte-identical output.
- **Statutory calendar engine:** payday-filing-due, IRD payment-due (20th / 5th+20th), ESCT-tier-recompute (1 Apr), KiwiSaver rate-change (1 Apr 2026 → 3.5%), ACC rate-change (1 Apr 2026), minimum-wage-change (1 Apr), PPL rate-change (1 Jul) — all seeded as scheduled compliance events (`scheduler.js`).

---

## 13. Forward-Compatibility — Employment Leave Bill 2026

The **Employment Leave Bill** (introduced **9 March 2026**) will **replace the Holidays Act 2003**, with commencement expected **~2028**. Key changes we must absorb without re-architecture:

| Change under the Bill | Impact on our engine |
|---|---|
| **Sick leave becomes hours-based**, accruing at **0.0385 h per standard hour worked**, from **day one**, capped at **160 hours** | Our leave model already supports unit-agnostic balances (weeks/days/hours). We add an `accrualBasis = ANNIVERSARY_DAYS \| HOURLY` to the leave-type rule. Sick switches to `HOURLY` under the new rule version. |
| **BAPS leave from day one** (or 3 months for some), removing the 6-month wait | Eligibility predicate becomes rule-versioned (`qualifyingDays` per rule set), not hardcoded. |
| Bereavement/family-violence remain **day-based** but from day one | Router unchanged; eligibility date shifts. |
| Annual holidays / OWP/AWE/RDP/ADP | Expected to be **simplified**; we keep the four-method router pluggable so a new "simplified" method can be added as a fifth branch under the 2028 rule version. |

**Architectural commitment:** because all NZ statutory logic is **versioned and effective-dated** (§1.3), the 2028 transition is delivered as a **new `ComplianceRuleSet` version per domain**, plus a small number of new branches in the leave router — **not** a rewrite. We will publish the new rule sets in Super Admin ahead of commencement and let the **payment-date resolver** switch automatically on the commencement date.

---

## 14. API Surface (NZ compliance module)

All under `app.hr.com` tenant scope, RBAC-gated, `businessId`-isolated:

| Method · Path | Purpose | Permission |
|---|---|---|
| `POST /api/nz/payruns` | Create draft pay run | `payroll.run` |
| `POST /api/nz/payruns/:id/calculate` | Run PAYE/KS/ESCT/ACC/SL calc | `payroll.run` |
| `POST /api/nz/payruns/:id/approve` | Approve calculated run | `payroll.approve` |
| `POST /api/nz/payruns/:id/file` | Generate + submit EI return | `payroll.file` |
| `POST /api/nz/payruns/:id/amend` | Amended EI return | `payroll.file` |
| `GET  /api/nz/payruns/:id/derivation` | Full tax/leave derivation (audit) | `payroll.view` |
| `POST /api/nz/leave/value` | Preview a leave payment (router) | `leave.view` |
| `POST /api/nz/leave/requests` | Employee leave request (ESS) | `leave.request` |
| `POST /api/nz/leave/requests/:id/approve` | Approve, value & post | `leave.approve` |
| `GET  /api/nz/employees/:id/balances` | Annual(weeks/days), sick, alt days | `leave.view` |
| `POST /api/nz/kiwisaver/:empId/election` | Set employee/employer rate, opt-out/suspension | `payroll.config` |
| `GET  /api/nz/compliance/calendar` | Filing/payment due dates | `payroll.view` |
| `POST /api/nz/validate/ird-number` | IRD number checksum | `payroll.config` |
| `GET  /api/nz/owd-test` | Otherwise-working-day evaluation for a date | `leave.view` |

Rate tables themselves are **read** from Super Admin's published `ComplianceRuleSet` (no tenant write).

---

## 15. Edge Cases & Validation Catalogue (non-exhaustive but mandatory)

| # | Edge case | Engine behaviour |
|---|---|---|
| 1 | Pay run paid 1 Apr 2026 for period ending 31 Mar | **New** rates (KS 3.5%, ACC 1.75%, min wage $23.95) — payment-date governs |
| 2 | Employee turns 16 mid-period (from 1 Apr 2026) | Employer KS contributions begin on first payday on/after eligibility |
| 3 | Employee hits ACC cap mid-pay | Levy charged only on remaining-cap portion; $0 thereafter that year |
| 4 | No IR330 / no IRD number | Force **ND code (45% income tax + ACC = 46.75% PAYE)**, red-flag, block filing until fixed (contractor with no IR330C → WT flat 45%) |
| 5 | Mondayised public holiday where weekend day IS an OWD | Entitlement on the weekend day, **not** the Monday — never both |
| 6 | Sick leave taken on a non-OWD | Not a working day → no entitlement consumed, no pay |
| 7 | Annual holiday after parental leave (depressed AWE) | Pay greater of OWP/AWE; **flag** lawful lower AWE to HR/employee |
| 8 | Discretionary bonus vs bargained bonus | `discretionary` flag drives inclusion in gross earnings → AWE/ADP/OWP |
| 9 | Variable-hours casual, sick day | RDP not practicable → **ADP**, record s9A reason |
| 10 | Termination spanning a public holiday in the paid-out leave | Pay the public holiday **in addition** (s40) |
| 11 | Deductions exceed gross | Apply priority (§7); protect child-support 60% net floor; block negative net |
| 12 | Employee on savings suspension | Stop employee KS deduction; no employer contribution required; auto-resume at expiry |
| 13 | Redundancy payment | Extra-pay tax method; **no** ACC, **no** KiwiSaver |
| 14 | Secondary tax code (S/SH/ST/SA) | Flat rate; SL = 12% no threshold; ACC embedded — don't double-levy |
| 15 | Mid-year ESCT income jump | ESCT tier is **set at 1 Apr / on hire** — does **not** change mid-year (set-and-forget) |
| 16 | Cash-up > 1 week annual holiday | Block — statutory max 1 week/year cash-up |
| 17 | Part-week annual holiday for irregular pattern | Convert weeks→days via `NzWorkPattern`; never assume 5-day week |
| 18 | Payday filing missed within 2 working days | Compliance-calendar alert escalates; record late-filing risk; still file ASAP |

---

## 16. Open Items Requiring Founder Decision

These are surfaced to the founder (see StructuredOutput → openQuestions), not silently assumed:

1. **Payday filing transport for v1** — myIR file upload + manual confirm (fast to ship, no IRD software registration) vs direct **gateway/API filing** (requires IRD registration, digital certs, longer). Recommendation: ship upload, fast-follow gateway.
2. **PPL handling depth** — we record/hold-job/pause-KiwiSaver but PPL is paid by IRD. Do we want a "PPL top-up" feature (employer voluntary top-up to full salary), which *is* salary for KiwiSaver/PAYE?
3. **Te reo Māori** ESS coverage — full vs labels-only for v1.
4. **Complying superannuation funds** (non-KiwiSaver) — defer to v2 (engine assumes KiwiSaver)?

---

*End of NZ compliance specification. Cross-references: `04-payroll-engine.md` (orchestration), `05-compliance-india.md` (the IN counterpart), `07-leave-and-attendance.md`, `08-data-model.md`, `09-super-admin-compliance-rules.md`, `12-reporting-and-statutory-filings.md`.*
