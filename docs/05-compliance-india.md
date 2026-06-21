# 05 — India Statutory & Payroll Compliance (the definitive IN rule spec)

> **Document status:** Canonical for all India statutory payroll logic. This is the source of truth that the payroll engine (`30-payroll-engine.md`), the data model (`20-data-model.md`), the super-admin compliance-rules console (`60-super-admin.md`), and the tenant payroll-run UI (`40-tenant-admin.md`) all bind to. Where this contradicts a downstream doc, **this file wins** for IN statutory rules.
>
> **Audience:** Experienced technical founder + the engineers building the IN compliance module. CA-level depth; opinionated; production-grade. No "TBD".
>
> **Sibling docs:** `00-vision-and-principles.md` (principles, the "compliance is a versioned data asset" rule), `30-payroll-engine.md` (the generic country-agnostic engine this plugs into), `32-compliance-NZ.md` / `06-compliance-nz.md` (the NZ counterpart), `20-data-model.md` (schemas), `70-billing.md` (we bill in INR via Razorpay for IN tenants).
>
> **Author role:** India Payroll Compliance Specialist (CA-level).
>
> **Last verified against live sources:** 2026-06-22. Every rate, threshold, and date below carries an effective date inline. Verification sources are listed in §20.

---

## 0. How to read this document

Three layers, kept rigorously separate because **principle #7.1 of `00-vision-and-principles.md` mandates that compliance is a *versioned data asset, not code***:

1. **The law** (what the statute says, with effective dates) — §§2–14.
2. **The data model** (how we encode the law as versioned, country-scoped rule rows the super-admin edits without a deploy) — §15.
3. **The engine contract** (the deterministic calculation order, state machines, APIs, validations, edge cases) — §§16–19.

> **The cardinal architecture decision (founder, read this):** *No statutory rate, slab, threshold, or due date is ever a constant in code.* Everything in §§2–14 is seeded as rows in versioned `InComplianceRule*` tables (§15), keyed by `(country='IN', ruleType, effectiveFrom, effectiveTo)`. The payroll engine resolves the correct version **as-of the pay period's end date**, never `Date.now()`. This is what lets us recompute a June-2024 payslip in 2027 and get a byte-identical result, and what lets us absorb a mid-year Budget without shipping a build. The 2025 Labour-Code transition (§3) and the Form 16→130 transition (§7.6) are the proof that this was the right call.

---

## 1. Scope, jurisdiction & the entity model

### 1.1 What "India payroll compliance" covers here

| Pillar | Statute / authority | Section |
|---|---|---|
| Income tax on salary (TDS u/s 192) | Income-tax Act 1961 → **Income-tax Act 2025** (Tax Year 2026-27 onward) | §2, §7 |
| Provident Fund (EPF/EPS/EDLI) | EPF & MP Act 1952 → **Code on Social Security 2020** | §4 |
| Employees' State Insurance (ESI) | ESI Act 1948 → **Code on Social Security 2020** | §5 |
| Professional Tax (PT) | State Acts (Art. 276 Constitution) | §6 |
| Gratuity | Payment of Gratuity Act 1972 → **Code on Social Security 2020** | §8 |
| Statutory Bonus | Payment of Bonus Act 1965 → **Code on Wages 2019** | §9 |
| Labour Welfare Fund (LWF) | State LWF Acts | §10 |
| Minimum wages | Minimum Wages Act 1948 → **Code on Wages 2019** | §11 |
| Uniform "wages" definition + the 50% rule | **Code on Wages 2019** (live 21 Nov 2025) | §3 |
| Registers, payslips, returns | Multiple + Code rules | §12 |
| Deadlines & penalties | All of the above | §13 |

### 1.2 The tenant/entity hierarchy we must support (this is non-trivial)

India compliance is **establishment-scoped, not company-scoped**. One legal entity (one PAN) can have many establishments across states, each with its own PT registration, its own ESI/EPF sub-code, its own state LWF, its own minimum-wage schedule. Our data model must mirror that or we will mis-file.

```
Tenant (Business)                      ← billing & login boundary (Sitepresso `Business`)
 └─ LegalEntity (PAN, TAN)             ← the income-tax / TDS filing unit
     └─ Establishment (per state)      ← PT reg, EPF sub-code, ESIC sub-code, LWF, MW schedule
         └─ EmployeePosting            ← which establishment an employee is posted to in a period
```

- **TDS / Form 24Q (Form 138)** is filed at the **TAN** level (a LegalEntity may hold multiple TANs; one TAN = one quarterly return).
- **PF/ESI** is filed at the **establishment sub-code** level (ECR per EPF establishment, Return of Contributions per ESIC code).
- **PT** is filed at the **state registration** level (one PTRC per state of operation).
- An employee who **transfers states mid-month** generates split PT, possibly split MW, and a posting change — a real edge case handled in §16.7.

> **Reuse note:** Sitepresso already gives us the outer two layers cleanly. `backend/prisma/schema.prisma` defines `Business` (the tenant) with row-level `businessId` isolation enforced in `backend/src/core/middleware/requireBusiness.js` and `auth.middleware.js`. We **add** `LegalEntity` and `Establishment` as child tables under `businessId` (see §15.1), inheriting the same isolation pattern — every IN compliance row carries `businessId` + `establishmentId` and is filtered by the existing middleware. No new tenancy mechanism is invented.

---

## 2. Income tax on salary — the two regimes (FY 2025-26 / AY 2026-27, unchanged for FY 2026-27 / AY 2027-28)

> **Confirmed 2026-06-22:** Budget 2026 made **no changes** to the slabs introduced in Budget 2025. The figures below hold for FY 2025-26 and FY 2026-27. (cleartax.in, incometax.gov.in)

### 2.1 New Tax Regime (§115BAC) — **DEFAULT** from FY 2023-24

This is the default. An employee must **actively opt out** to use the old regime (and a non-business taxpayer may switch each year; a business-income taxpayer who opts out can return to default only once).

**Slabs (FY 2025-26 & FY 2026-27, resident individual, any age — new regime has no age-based exemption uplift):**

| Slab (₹ taxable income) | Rate | Effective |
|---|---|---|
| 0 – 4,00,000 | **Nil** | 1 Apr 2025 |
| 4,00,001 – 8,00,000 | 5% | 1 Apr 2025 |
| 8,00,001 – 12,00,000 | 10% | 1 Apr 2025 |
| 12,00,001 – 16,00,000 | 15% | 1 Apr 2025 |
| 16,00,001 – 20,00,000 | 20% | 1 Apr 2025 |
| 20,00,001 – 24,00,000 | 25% | 1 Apr 2025 |
| Above 24,00,000 | 30% | 1 Apr 2025 |

- **Standard deduction:** ₹75,000 (salaried; new regime) — effective FY 2024-25 onward.
- **§87A rebate (new regime):** up to **₹60,000**, fully extinguishing tax where **total income ≤ ₹12,00,000**. Combined with the ₹75,000 standard deduction, a salaried employee with **gross salary ≤ ₹12,75,000 pays nil income tax**.
- **Allowed under new regime:** standard deduction (₹75,000), employer NPS contribution u/s 80CCD(2) (**14%** of basic+DA in new regime), transport allowance for disabled, conveyance for duties, gratuity/leave-encashment exemptions on exit. **Disallowed:** 80C, 80D, HRA exemption, LTA, home-loan interest on self-occupied, most chapter-VIA.

### 2.2 §87A marginal-relief edge case (the one everyone gets wrong)

The rebate makes tax nil at exactly ₹12,00,000 taxable. **Without** marginal relief, a taxable income of ₹12,00,100 would jump to a tax of **~₹60,015 (₹62,416 with 4% cess)** — i.e. ₹100 more income → ₹60k+ more tax. **Marginal relief u/s 87A** caps the tax at **the amount by which taxable income exceeds ₹12,00,000**.

- Taxable income ₹12,10,000 → tax before relief = ₹61,500; excess over 12L = ₹10,000 → **tax payable = ₹10,000** (plus 4% cess = ₹10,400). The relief band runs from a taxable income of **₹12,00,001** up to **≈ ₹12,70,588** (the crossover where normal slab tax first equals the excess-over-12L cap; verified by computation and by cleartax.in/s/income-tax-rebate-us-87a). Beyond ≈ ₹12,70,588 taxable, normal tax is lower than the cap and the relief no longer bites. *(Note: ₹12,70,588 is **taxable** income; with the ₹75,000 standard deduction that corresponds to ≈ ₹13,45,588 gross. The often-quoted "nil tax up to ₹12,75,000 gross" is the separate **rebate** ceiling — ₹12,75,000 gross − ₹75,000 = ₹12,00,000 taxable — not the top of the marginal-relief band.)*

> **Engine requirement:** §87A rebate AND its marginal relief are **two distinct steps** (§16.4 steps 7–8). Implementing only the rebate creates a cliff that will produce visibly wrong payslips for anyone earning ₹12L–₹12.75L — a common salary band. This is a mandatory test case (§17).

### 2.3 Old Tax Regime — opt-in only

| Slab (₹) | < 60 yrs | 60–79 (senior) | ≥ 80 (super-senior) | Effective |
|---|---|---|---|---|
| 0 – 2,50,000 | Nil | Nil (to 3,00,000) | Nil (to 5,00,000) | unchanged |
| 2,50,001 – 5,00,000 | 5% | 5% (3L–5L) | Nil | unchanged |
| 5,00,001 – 10,00,000 | 20% | 20% | 20% | unchanged |
| Above 10,00,000 | 30% | 30% | 30% | unchanged |

- **Standard deduction (old):** ₹50,000.
- **§87A (old):** up to **₹12,500**, nil tax where total income ≤ **₹5,00,000**. **No** marginal-relief band (it's a hard ₹5L threshold).
- **Deductions live:** 80C (₹1.5L), 80CCD(1B) NPS (₹50k), 80D, 24(b) home-loan interest (₹2L self-occupied), HRA (§2.4), LTA, etc.

### 2.4 HRA exemption (old regime only) — least of three

Exempt HRA u/s 10(13A) = **least of**:
1. Actual HRA received;
2. 50% of (basic+DA) for metro [Delhi, Mumbai, Kolkata, Chennai] / 40% non-metro;
3. Rent paid − 10% of (basic+DA).

Engine must hold the employee's **declared rent, city tier, and metro flag** to compute monthly; reconcile at year-end against proofs (the "investment proof" window, §16.5).

### 2.5 Surcharge (on income-tax, before cess) & cess

| Total income | Surcharge — old regime | Surcharge — new regime | Effective |
|---|---|---|---|
| > ₹50L ≤ ₹1cr | 10% | 10% | unchanged |
| > ₹1cr ≤ ₹2cr | 15% | 15% | unchanged |
| > ₹2cr ≤ ₹5cr | 25% | **25% (capped)** | unchanged |
| > ₹5cr | 37% | **25% (capped)** | unchanged |

- **Health & Education Cess:** **4%** on (tax + surcharge), all incomes, both regimes.
- **Marginal relief on surcharge** applies at each threshold (₹50L/₹1cr/₹2cr; ₹5cr old only): the incremental tax+surcharge cannot exceed the incremental income over the threshold. Engine step §16.4 step 11.

### 2.6 Worked example A — single salaried employee, new regime, ₹18,00,000 gross (FY 2025-26)

| Step | Amount (₹) |
|---|---|
| Gross salary | 18,00,000 |
| − Standard deduction | 75,000 |
| − 80CCD(2) employer NPS (assume 0 here) | 0 |
| **Taxable income** | **17,25,000** |
| Tax: 0–4L @0 | 0 |
| 4–8L @5% | 20,000 |
| 8–12L @10% | 40,000 |
| 12–16L @15% | 60,000 |
| 16–17.25L @20% (on 1,25,000) | 25,000 |
| **Tax before rebate** | **1,45,000** |
| §87A rebate (income > 12L → none) | 0 |
| Surcharge (≤50L → none) | 0 |
| **Tax + surcharge** | **1,45,000** |
| + 4% cess | 5,800 |
| **Total annual tax liability** | **1,50,800** |
| **Monthly TDS (÷12)** | **12,567** (rounded; see §7.2 rounding) |

### 2.7 Worked example B — the §87A marginal-relief band, ₹12,60,000 gross, new regime

| Step | Amount (₹) |
|---|---|
| Gross | 12,60,000 |
| − Standard deduction | 75,000 |
| **Taxable** | **11,85,000** → **≤ 12L ⇒ §87A nil** |
| **Total tax** | **0** |

Now nudge gross to ₹13,40,000 → taxable ₹12,65,000:

| Step | Amount (₹) |
|---|---|
| Tax (0/20k/40k + 15% on 65,000=9,750) | 69,750 |
| §87A rebate (>12L) | 0 |
| **Marginal relief:** cap at (12,65,000 − 12,00,000) | tax capped to **65,000** |
| + 4% cess | 2,600 |
| **Total** | **67,600** |

> Without marginal relief the engine would have charged ₹72,540 — a ₹4,940 over-deduction the employee would chase HR over every month. **This is why §16.4 step 8 is mandatory.**

---

## 3. The Labour-Code uniform "wages" definition and its cascade (the single most important 2026 change)

> **Confirmed 2026-06-22:** All four Labour Codes commenced **21 November 2025** (Code on Wages 2019, Code on Social Security 2020, Industrial Relations Code 2020, OSH Code 2020), replacing 29 legacy laws. Central + state **rules are still being notified**; the structural wage definition is in force but operational mechanics (registers formats, some thresholds) are settling state-by-state through 2026. (EY, KPMG, BDO, PwC India, payroll.org)

### 3.1 The uniform definition (Code on Wages §2(y))

"**Wages**" = all remuneration (salary, allowances, or otherwise) expressed in money, **including** basic pay, dearness allowance (DA), and retaining allowance, but **excluding** a closed list: HRA, conveyance, overtime, bonus, commission, PF/pension employer contribution, gratuity, retrenchment compensation, and certain others.

**The 50% rule (the cascade trigger):** the *sum of the excluded components* must **not exceed 50% of total remuneration**. **If exclusions exceed 50%, the excess is added back and deemed "wages."** Practically: **Basic + DA must be ≥ 50% of total remuneration.**

### 3.2 Why this detonates legacy CTC structures

Indian employers historically minimised "wages" (basic) to ~30–40% to suppress PF, gratuity, and bonus liability, inflating HRA/special allowance. Post-21-Nov-2025 that is **non-compliant**. Re-basing basic to ≥50% **mechanically increases** every wage-linked statutory liability:

| Liability | Base | Effect of 50% rule |
|---|---|---|
| EPF (12% + 12%) | Basic+DA (subject to ₹15k cap election) | ↑ where uncapped |
| Gratuity (15/26 × last drawn) | Basic+DA | ↑ accrual |
| Bonus | Basic+DA (capped ₹7,000/MW) | ↑ where below cap |
| Leave encashment | Basic+DA | ↑ |
| Retrenchment / notice pay | wages | ↑ |
| ESI | gross (unaffected by split) | neutral |
| Income tax | gross (unaffected by split) | neutral on tax, but HRA exemption ↓ in old regime |

### 3.3 What our product must DO about it (not just store)

This is a **feature**, per `00-vision-and-principles.md` §2.1 (the compliance reset is the GTM event):

1. **Structure validator (blocking):** On every salary-structure save AND every payroll run, compute `(Basic + DA) / TotalFixedRemuneration`. If `< 0.50`, **raise `WAGE_DEF_50PCT_BREACH`** — block payroll finalize until resolved or explicitly overridden by an authorised role with reason logged (audit). See §16.2, §16.9.
2. **Deemed-wages re-computation:** When exclusions > 50%, the engine adds the excess back into the "wages" base used for PF/gratuity/bonus **for that period**, even if the stored basic is lower — so we compute correctly even on a not-yet-restructured employee. The stored structure and the *effective statutory wage* are two different numbers; we persist both.
3. **CTC restructuring wizard (tenant-admin, configure-not-build):** Suggests a compliant split (basic = 50%, redistribute the rest into the allowed buckets) and previews the new employer cost (PF/gratuity uplift). Tenant **approves a generated structure**; they do not design fields — consistent with the "pre-built, not a builder" cardinal rule.
4. **Versioned effective date:** The 50% rule is itself a rule row effective `2025-11-21`; periods before resolve to the legacy behaviour (no add-back), periods after enforce it. Recomputing an Oct-2025 payslip must NOT apply the rule.

> **Open decision for founder (§19):** Should the validator be *hard-block* or *warn-and-allow-with-attestation* at launch? Hard-block is the correct compliance posture but will fail-closed on the (large) installed base of non-restructured employees during onboarding migration. Recommended: **warn during a configurable 90-day grace window per tenant, hard-block after**, with the grace window a super-admin feature flag.

---

## 4. EPF — Provident Fund (EPF + EPS + EDLI + admin)

> **Confirmed 2026-06-22:** rates and the ₹15,000 statutory wage ceiling unchanged into 2026. EPF interest **8.25% for FY 2024-25**. (epfindia.gov.in, cleartax.in, taxguru.in)

### 4.1 Applicability

- **Mandatory** for every establishment with **20+ employees** (some notified classes at 10+). Voluntary coverage below 20 is permitted.
- "**Excluded employee**" / **₹15,000 election:** an employee drawing PF wages **> ₹15,000/month who was never previously an EPF member** may be excluded. Once a member, they stay covered even above ₹15,000.
- **PF wages** = Basic + DA + Retaining Allowance (post-Code, harmonised with §3; HRA etc. excluded subject to the 50% add-back).
- **UAN** (Universal Account Number): one per employee for life, portable across employers; Aadhaar-seeded and verified. Our onboarding must capture/validate UAN (12-digit) and KYC seed status.

### 4.2 The exact split (this is the part everyone implements wrong)

Let **PFWage** = min(actual PF wage, **₹15,000**) *if the establishment caps at the ceiling* — OR actual PF wage if the establishment contributes on full wage (a per-establishment policy we must store, §15.5). EPS is **always** capped at ₹15,000.

| Account | Who pays | Rate | Base | Notes |
|---|---|---|---|---|
| **A/c 1 — EPF (employee)** | Employee | **12%** | PFWage | Whole 12% of employee share → EPF |
| **A/c 1 — EPF (employer)** | Employer | **3.67%** | PFWage | = 12% − EPS portion |
| **A/c 10 — EPS (employer)** | Employer | **8.33%** | **min(PFWage, ₹15,000)** | Pension; **capped at ₹1,250/mo** (8.33% × 15,000) |
| **A/c 21 — EDLI (employer)** | Employer | **0.50%** | min(PFWage, ₹15,000) | Insurance; **capped ₹75/mo**; cover up to ₹7,00,000 |
| **A/c 2 — EPF admin charges (employer)** | Employer | **0.50%** | PFWage | **Min ₹500/mo** per establishment (₹75 if no contributory member that month) |
| **A/c 22 — EDLI admin charges** | Employer | **0%** | — | **Abolished w.e.f. 01-Apr-2017** — do NOT charge |

**Employee deduction = 12% of PFWage.** **Employer cost = 3.67% + 8.33% + 0.50% (EDLI) + 0.50% (admin) ≈ 13.00%** of PFWage (plus the ₹500 admin floor effect).

> **Three traps to encode as test cases (§17):**
> 1. **EPS cap is on ₹15,000 even if PF is on full wage.** Employer 3.67% absorbs the remainder: if PFWage > 15,000, employer EPF = (12% × PFWage) − ₹1,250, NOT 3.67% × PFWage. Encode the **EPS = 1,250 then EPF = balance** logic, not two independent percentages.
> 2. **Admin charge ₹500 floor is per-establishment-per-month**, not per-employee.
> 3. EDLI admin (A/c 22) is **zero** — a stale 0.01% constant is a classic bug.

### 4.3 Rounding

EPFO rounds each account **to the nearest rupee** (₹0.50 rounds up), per employee, then sums for the ECR. The engine rounds at the account level, not the gross level (§16.6).

### 4.4 Worked example — PF wage ₹25,000, establishment caps at ceiling

PFWage(capped) = ₹15,000.
- Employee EPF (A/c1): 12% × 15,000 = **₹1,800**
- EPS (A/c10): 8.33% × 15,000 = ₹1,249.5 → **₹1,250**
- Employer EPF (A/c1): 1,800 − 1,250 = **₹550** (note: equals 3.67% × 15,000 = 550.5 → 550 by the balance method)
- EDLI (A/c21): 0.50% × 15,000 = **₹75**
- Admin (A/c2): 0.50% × 15,000 = ₹75 → but **min ₹500** applies at establishment level
- **Employee take-home deduction: ₹1,800.** **Employer outflow: 550 + 1,250 + 75 + admin.**

### 4.5 Worked example — PF wage ₹25,000, establishment contributes on FULL wage

PFWage = ₹25,000; EPS still capped at 15,000.
- Employee EPF: 12% × 25,000 = **₹3,000**
- EPS: **₹1,250** (cap)
- Employer EPF: 3,000 − 1,250 = **₹1,750**
- EDLI: 0.50% × 15,000 = **₹75** (EDLI follows the 15k cap)

### 4.6 ECR (Electronic Challan-cum-Return)

Monthly file uploaded to the EPFO Unified Portal. Per-member rows: UAN, name, gross/EPF/EPS wages, EPF/EPS/EDLI contributions, NCP days (non-contributory period), refund of advances. We generate the **ECR text file** (§12.4) + the challan. Due **15th** of following month.

---

## 5. ESI — Employees' State Insurance

> **Confirmed 2026-06-22:** employee 0.75% / employer 3.25% unchanged since 01-Jul-2019; wage ceiling ₹21,000 (₹25,000 for persons with disability). (tallysolutions.com, hrone.cloud, cleartax.in)

### 5.1 Applicability

- **Mandatory** for establishments with **10+ employees** (Maharashtra/Chandigarh notify shops at **20+**; store the threshold per state, §15.5).
- Covers employees with **gross monthly wages ≤ ₹21,000** (≤ **₹25,000** if a person with disability).
- **Gross wages for ESI** = nearly all components **except** employer's PF/ESI contribution, gratuity, and certain reimbursements; **includes** overtime *for the wage check ambiguity* — note: **OT is included for contribution but excluded when testing the ₹21,000 ceiling**. Encode that asymmetry (§16.3).

### 5.2 Rates

| Party | Rate | Base |
|---|---|---|
| Employee | **0.75%** | ESI gross |
| Employer | **3.25%** | ESI gross |
| **Total** | **4.00%** | |

- Employee contribution **rounded up to the next rupee**; employer to the next rupee.
- Employees earning **≤ ₹176/day average** are exempt from the **employee** share (employer still pays 3.25%).

### 5.3 Contribution periods & the "continue till period-end" rule (critical edge case)

ESI has two fixed **contribution periods**: **Apr–Sep** and **Oct–Mar** (benefit periods lag by ~3 months: Jan–Jun and Jul–Dec). **If an employee crosses ₹21,000 mid-period (e.g. a May raise), ESI continues to be deducted on the *full new gross* until the end of that contribution period (Sep).** They exit ESI only from the next period start. This is a frequent payroll error.

> **Engine rule (§16.3):** ESI eligibility is **latched at the start of each contribution period** and only re-evaluated at the period boundary (1 Apr / 1 Oct). Mid-period raises do NOT drop coverage; mid-period *new joiners* above ₹21,000 are simply never covered.

### 5.4 Worked example — gross ₹19,000

- Employee: 0.75% × 19,000 = ₹142.5 → **₹143** (round up)
- Employer: 3.25% × 19,000 = ₹617.5 → **₹618**
- If this employee gets a raise to ₹22,000 in July (Apr–Sep period): **ESI continues on ₹22,000 until 30 Sep**, exits 1 Oct.

---

## 6. Professional Tax (PT) — state-levied, capped ₹2,500/yr

> Art. 276 caps PT at **₹2,500 per person per year** nationally. Each state sets its own slabs, frequency, and due dates. **Not levied in:** Delhi, Haryana, UP, Uttarakhand, Rajasthan, J&K, and most of the north (no state PT). Levied in MH, KA, TN, WB, GJ, TS, AP, MP, KL, OR, AS, TR, MN, MEG, SK, NL, PB, BR, and others. We seed **per-state** rule sets.
>
> **Confirmed 2026-06-22:** Karnataka revised slabs **w.e.f. 01-Apr-2025** (Karnataka Act 33 of 2025, gazetted 15-Apr-2025) — exemption threshold raised ₹15,000 → ₹25,000, annual max now ₹2,500. (greytHR, cleartax.in, saral.pro, factohr, mahagst.gov.in, tn.gov.in, wbcomtax.gov.in)

### 6.1 The five launch-priority states

#### Maharashtra (MH) — monthly; **separate male/female slabs**; Feb top-up
| Monthly gross | Male PT/mo | Female PT/mo | Effective |
|---|---|---|---|
| ≤ ₹7,500 | Nil | Nil | current |
| ₹7,501 – ₹10,000 | ₹175 | Nil (female exempt ≤ ₹25,000) | current |
| ₹10,001 – ₹25,000 | ₹200 (₹300 in **Feb**) | Nil | current |
| > ₹25,000 | ₹200 (₹300 in Feb) | ₹200 (₹300 in Feb) | current |

Annual max: **₹2,500** (male), **₹2,500** (female above ₹25k). The **February ₹300** quirk (₹200 × 11 + ₹300 = ₹2,500) **must** be encoded as a month-specific rule, not a flat ₹200.

#### Karnataka (KA) — monthly; revised 01-Apr-2025
| Monthly gross | PT/mo | Effective |
|---|---|---|
| ≤ ₹25,000 | Nil | 01-Apr-2025 |
| > ₹25,000 | ₹200 (₹300 in **Feb**) | 01-Apr-2025 |

Annual max ₹2,500. **Pre-01-Apr-2025 periods** use the old ₹15,000 threshold / ₹200 (₹2,400/yr) — keep both versions.

#### Tamil Nadu (TN) — **half-yearly** (Apr–Sep, Oct–Mar), slab on half-year income
| Half-yearly income | PT (per half-year) | Effective |
|---|---|---|
| ≤ ₹21,000 | Nil | GCC revision, FY 2024-25 |
| ₹21,001 – ₹30,000 | **₹180** | FY 2024-25 |
| ₹30,001 – ₹45,000 | **₹425** | FY 2024-25 |
| ₹45,001 – ₹60,000 | **₹930** | FY 2024-25 |
| ₹60,001 – ₹75,000 | ₹1,025 | FY 2024-25 |
| > ₹75,000 | ₹1,250 | FY 2024-25 |

> **Corrected 2026-06-22:** These are the **revised Greater Chennai Corporation slabs effective FY 2024-25** (cleartax.in/s/professional-tax-tamil-nadu; tnswp.com GCC profession-tax schedule). The earlier figures (135/315/690 for the lower three bands) were the **pre-revision** values — they remain in the versioned table with `effectiveTo = 2024-03-31` so a recompute of an FY 2023-24 half-year still resolves the old amounts. The two upper bands (₹1,025 / ₹1,250) were unchanged by the revision.

Deducted/remitted **half-yearly** (commonly spread monthly in payroll, remitted by the corporation's due date — GCC remits in **September** for Apr–Sep and **March** for Oct–Mar). Greater Chennai Corporation slabs; other TN local bodies (municipalities/town panchayats) notify their own schedules under the same enabling Act — store per-local-body where a tenant operates outside GCC. Annual max ₹2,500 (₹1,250 × 2).

#### Gujarat (GJ) — monthly
| Monthly gross | PT/mo | Effective |
|---|---|---|
| ≤ ₹12,000 | Nil | current (₹0 below 12k after 2022 revision) |
| > ₹12,000 | ₹200 | current |

Annual max ₹2,400.

#### West Bengal (WB) — monthly
| Monthly gross | PT/mo |
|---|---|
| ≤ ₹10,000 | Nil |
| ₹10,001 – ₹15,000 | ₹110 |
| ₹15,001 – ₹25,000 | ₹130 |
| ₹25,001 – ₹40,000 | ₹150 |
| > ₹40,000 | ₹200 |

Annual max ₹2,500.

### 6.2 PT engine rules

- **State is determined by establishment, not residence.** Employee posted to MH → MH PT.
- **Mid-month state transfer:** PT charged by the state the employee was posted to on the **liability date** (typically last day worked in that state that month); a split-state month may incur PT in **two** states in the same month (rare but real; §16.7).
- **Frequency varies** (MH/KA/GJ/WB monthly; TN half-yearly). The engine deducts monthly for cash-flow smoothing but **remits per the state's filing frequency**; reconcile the half-yearly TN total to ≤ ₹1,250/half.
- **Directors/proprietors** may have separate PTEC (enrolment) vs employee PTRC (registration) — store both registration numbers per establishment.

---

## 7. TDS on salary (§192), monthly deposit, Form 24Q/138, annual certificate (Form 16/130)

> **Confirmed 2026-06-22 — the big 2026 transition:** Under the **Income-tax Act 2025** + **Income-tax Rules 2026** (effective 1-Apr-2026, applicable **Tax Year 2026-27** onward), the TDS form numbering is wholesale renumbered. The full verified mapping (caclubindia.com, cleartax.in/s/new-income-tax-forms, taxguru.in, scconline.com):
>
> | Old form (Rules 1962) | New form (Rules 2026) | What it is |
> |---|---|---|
> | Form 16 | **Form 130** | Salary TDS certificate (now 3 parts A/B/C) |
> | Form 16A | **Form 131** | Non-salary TDS certificate |
> | Form 16B/16C/16D/16E | **Form 132** | TDS certificate on property/rent/contractor/e-comm |
> | Form 24Q | **Form 138** | Quarterly salary TDS return (employer) |
> | Form 26Q | **Form 140** | Quarterly non-salary TDS return |
> | Form 27Q | **Form 144** | Quarterly TDS return (non-resident payees) |
> | Form 27D | **Form 133** | TCS certificate |
> | Form 26AS | **Form 168** | Annual tax statement / "tax passbook" |
>
> **Form 16 remains valid for FY 2025-26**, issued by **15-Jun-2026** (old forms continue for FY 2025-26 and earlier proceedings); **first Form 130 issued by 15-Jun-2027** for TY 2026-27. *(Note: an early circulating claim that Form 24Q → "Form 137" is wrong — Form 24Q maps to **138**; verified against two independent CA sources 2026-06-22.)*

### 7.1 The §192 averaging method

TDS on salary is **not** a flat slab cut each month — it's **estimated annual tax ÷ remaining months**:

```
1. Estimate annual gross (actual YTD + projected remaining months).
2. Apply chosen regime (default new) → taxable income.
3. Compute annual tax + surcharge + cess (with §87A + marginal relief).
4. Subtract TDS already deducted YTD.
5. Divide remainder by months remaining in FY → this month's TDS.
6. Recompute every month (raises, bonuses, declarations shift it).
```

This makes TDS **self-correcting**: a March bonus is spread, a mid-year raise re-levels future months. The engine recomputes the full annual projection **every run** (§16.4).

### 7.2 Rounding & nil cases

- TDS rounded to **nearest rupee** per the §288B rounding (round to nearest ₹10 for the *total tax* on the return, but per-month deduction commonly nearest ₹1; we deduct to ₹1 and reconcile at year-end).
- If projected annual tax is nil (e.g. income ≤ ₹12.75L new regime), **monthly TDS = 0** — and we must not deduct "just in case."

### 7.3 Deposit deadline

| What | Deadline | Effective |
|---|---|---|
| Monthly TDS deposit (Apr–Feb deductions) | **7th** of the following month | standing |
| **March** TDS deposit | **30 April** | standing |
| Challan | ITNS 281 / e-pay tax, via TAN | standing |

Late deposit: **interest 1.5%/month** (or part) from deduction date to deposit date u/s 201(1A); **1%/month** if *not deducted*. Plus possible §271C penalty and §40(a)(ia) disallowance.

### 7.4 Form 24Q / Form 138 — quarterly statement (per TAN)

| Quarter | Period | Due date | Effective |
|---|---|---|---|
| Q1 | Apr–Jun | **31 July** | standing |
| Q2 | Jul–Sep | **31 October** | standing |
| Q3 | Oct–Dec | **31 January** | standing |
| Q4 | Jan–Mar | **31 May** | standing |

- **Q4 carries Annexure II** — the full annual salary breakup per employee (this is what feeds Form 16/130 Part B). Q1–Q3 carry only Annexure I (deduction details).
- Filed via **TRACES**/protean (NSDL) RPU + FVU validation; we generate the **FVU-ready text file** (§12.4).
- Late filing: **₹200/day u/s 234E** (capped at the TDS amount) + possible §271H penalty (₹10,000–₹1,00,000).

### 7.5 Annual certificate — Form 16 (FY 2025-26) → Form 130 (TY 2026-27)

| Aspect | Form 16 (≤ FY 2025-26) | Form 130 (TY 2026-27 →) |
|---|---|---|
| Authority | §203 Act 1961 | §395(4)(b) Act 2025 |
| Parts | A (TRACES) + B | **A + B + C** (C = detailed salary computation) |
| Generated via | TRACES | TRACES (after **Form 138** filing) |
| First issue | by 15-Jun-2026 | by 15-Jun-2027 |
| Companion statement | Form 26AS | **Form 168** |

> **Engine requirement:** the certificate generator is **version-switched on tax year**. FY 2025-26 → Form 16 two-part template; TY 2026-27 → Form 130 three-part template. Both pull from the same `InTaxComputation` snapshot; only the **render template + form metadata** differ. This is exactly the versioned-data-asset pattern (§15) applied to output artefacts, not just rates.

### 7.6 Other inputs to §192

- **Form 12BB:** employee's declaration of HRA/LTA/80C/home-loan etc. (old regime) — captured in ESS (`50-employee-ess.md`), feeds the projection.
- **Form 12BAA (2024+):** lets an employee report **other-than-salary TDS/TCS** (e.g. car purchase TCS, FD TDS) to reduce salary TDS. We must accept and apply it.
- **Regime election:** captured once per FY (default = new); changing it mid-year retro-recomputes all prior months' TDS in the next run.

---

## 8. Gratuity (Payment of Gratuity Act 1972 → Code on Social Security 2020)

> **Confirmed 2026-06-22:** formula 15/26, **5-year** eligibility, **₹20,00,000** tax-exempt cap (private, §10(10)(ii)), 30-day pay window, 10% p.a. on delay. (cleartax.in, bankbazaar.com)

### 8.1 Rules

- **Eligibility:** **5 years** continuous service (waived on death/disablement). *Watch: Code on Social Security signals reduced thresholds for fixed-term employees (pro-rata, no 5-yr bar) — rules being notified; store the FTC carve-out as a flag.*
- **Formula (covered, Act applies):** `Gratuity = (last drawn Basic+DA) × 15 × completed years ÷ 26`. **Years rounded:** ≥ 6 months rounds up (e.g. 7y 7m → 8). 240 days = a "year" for the 5th-year ambiguity (190 in mines/seasonal).
- **Non-covered establishments:** 15/30 (half month per year, on avg 10 months' salary) — store the establishment's coverage flag.
- **Tax exemption (§10(10)):** least of (actual gratuity / **₹20,00,000** lifetime / 15-days-formula amount). Excess is taxable salary in the exit month.

### 8.2 Accrual (the accounting feature, not just the payout)

Gratuity is a **defined-benefit liability** that accrues every period. Premium product behaviour: we **accrue monthly** (`gratuityLiability += monthly accrual`) and expose the **closing gratuity liability per employee and per establishment** — the number a CFO needs for provisioning / LIC-gratuity-fund funding. Actuarial valuation is out of scope but the running provision is in.

### 8.3 Worked example

Last drawn Basic+DA = ₹60,000; service 8 years 7 months → **9 years**.
`Gratuity = 60,000 × 15 × 9 / 26 = ₹3,11,538`. Below ₹20L → fully exempt.

---

## 9. Statutory Bonus (Payment of Bonus Act 1965 → Code on Wages)

> **Confirmed 2026-06-22:** eligibility ceiling **₹21,000** Basic+DA; calculation cap **₹7,000 or minimum wage (higher)**; min **8.33%**, max **20%**; pay within **8 months** of accounting-year close. (greythr, omnivoo, quikchex)

### 9.1 Rules

- **Eligible:** employee with Basic+DA ≤ **₹21,000/month** who worked **≥ 30 days** in the accounting year.
- **Calculation wage:** if Basic+DA ≤ ₹7,000 → on actual; if > ₹7,000 → **capped at max(₹7,000, applicable minimum wage for the scheduled employment)**.
- **Rate:** **min 8.33%** (mandatory even at a loss), **max 20%** (profit-linked via allocable surplus = 67% of available surplus, non-banking).
- **Set-on/set-off:** surplus beyond 20% carries **set-on** up to 4 years; shortfall below 8.33% is **set-off** against future years (employer still pays 8.33% in the deficit year). We maintain a 4-year set-on/set-off ledger per LegalEntity.
- **Pay by:** within **8 months** of accounting-year end (so by **30 Nov** for an Apr–Mar year).

### 9.2 Worked example

Basic+DA ₹18,000 (> ₹7,000 → cap ₹7,000, assume MW lower), rate 8.33%, 12 months:
`Bonus = 7,000 × 8.33% × 12 = ₹6,997 (≈ ₹7,000/yr)`. At 20%: `7,000 × 20% × 12 = ₹16,800`.

---

## 10. Labour Welfare Fund (LWF) — state-levied, small amounts, easy to miss

> **Confirmed 2026-06-22:** state-specific, half-yearly or annual. KA reduced applicability threshold 50 → **10 employees w.e.f. 07-Jan-2026**. (futurexsolutions, zoho payroll, omconsultants)

| State | Employee | Employer | Frequency | Deduct in |
|---|---|---|---|---|
| Maharashtra | ₹25 | ₹75 | Half-yearly | **Jun & Dec** |
| Karnataka | ₹50 | ₹100 | Annual | **Dec** (10+ employees from 07-Jan-2026) |
| Tamil Nadu | ₹10 | ₹20 | Annual | **Dec** (remit by 31 Jan) |
| Gujarat | ₹6 | ₹12 | Half-yearly | Jun & Dec |
| West Bengal | ₹3 | ₹6 | Half-yearly | Jun & Dec |

> Not levied in every state (no LWF in TN's neighbours uniformly; UP/Bihar differ). Seed per-state; **only deduct in the configured months** — a flat monthly LWF is wrong and a classic audit finding.

---

## 11. Minimum wages (Minimum Wages Act 1948 → Code on Wages 2019)

- **Dual jurisdiction:** Central sphere (railways, mines, oilfields, central PSUs…) vs **State** (everything else — the common case). Each state notifies MW per **scheduled employment**, **skill level** (unskilled/semi/skilled/highly-skilled), and **zone** (A/B/C by area), revised typically twice a year with **VDA** (variable dearness allowance) linked to CPI.
- **National Floor Wage** (advisory; the Code's statutory floor mechanism is being notified — store the floor as a versioned national rule once notified).
- **Engine duty:** for each employee, resolve `(state, scheduledEmployment, skillLevel, zone, asOfDate)` → minimum wage; **validate gross wages ≥ MW**; flag `MIN_WAGE_BREACH` (blocking, like the 50% rule). MW also sets the **bonus calculation-wage floor** (§9) and floors some other computations.
- This is the **highest-maintenance** IN table (hundreds of rows, revised twice yearly). It is a super-admin-curated dataset (§15.6), versioned by `effectiveFrom`. We will not crowdsource it from tenants.

---

## 12. Mandatory digital registers, payslips & returns (now explicitly digital under the Codes)

> The Labour Codes + their rules **explicitly permit/expect electronic registers and digital wage slips**, with **wages paid by bank transfer** the default. This is squarely in our favour — we generate them as artefacts.

### 12.1 Statutory payslip (must contain)

Gross wages; each allowance; **each statutory deduction itemised** (EPF, ESI, PT, TDS, LWF); net pay; days worked / LOP; OT; the period; employer name + establishment; employee code + UAN + ESIC IP number + PAN. Delivered digitally via ESS (`50-employee-ess.md`), downloadable PDF, white-labelled (tenant logo/brand color per `00-vision-and-principles.md` branding limits).

### 12.2 Registers (digital, retained ≥ 3 years, exportable on inspection)

| Register | Source | Statute |
|---|---|---|
| Register of wages | payroll run | Code on Wages rules |
| Register of employees / muster roll | HR + attendance | OSH Code rules |
| Register of deductions | payroll run | Code on Wages rules |
| Register of overtime | attendance | OSH/Wages rules |
| Register of fines/damages | disciplinary | Code on Wages |
| Loan/advance register | payroll | — |

All generated **on demand** from the immutable payroll ledger (§16.10) — never hand-maintained.

### 12.3 Statutory returns calendar (machine artefacts we produce)

| Return | Cadence | Channel | We produce |
|---|---|---|---|
| EPF **ECR** | Monthly (by 15th) | EPFO Unified Portal | ECR text file + challan |
| ESI **Return of Contributions** + monthly contribution | Monthly (by 15th) / half-yearly | ESIC portal | contribution file |
| **Form 24Q / 138** | Quarterly | TRACES/protean (FVU) | FVU text file |
| **Form 16 / 130** | Annual (by 15 Jun) | TRACES | merged PDF (Part A from TRACES + B/C from us) |
| **PT returns** | Per-state (monthly/annual) | State portals | state-format file/CSV |
| **LWF returns** | Half-yearly/annual | State LWF board | challan |
| Form 12BA (perquisites) | with Form 16/130 | — | statement |

### 12.4 Output-file generators (engineering scope)

We ship deterministic generators for: **ECR** (pipe-delimited, EPFO spec), **ESIC** contribution CSV, **FVU-input** flat file for 24Q/138 (then user runs the govt FVU, or we integrate a validated library), **Form 16/130 PDF**, **PT state CSVs**. Each is a pure function of the immutable payroll ledger for the period → byte-stable, testable against golden files (§17).

---

## 13. Consolidated deadline & penalty matrix

| Obligation | Due | Late consequence |
|---|---|---|
| TDS deposit (Apr–Feb) | **7th** next month | Interest 1.5%/mo (deducted-not-paid); 1%/mo (not deducted) |
| TDS deposit (March) | **30 Apr** | as above |
| EPF ECR + payment | **15th** next month | **Damages 1%/month of delay (uniform, w.e.f. 14-Jun-2024)** + interest **12% p.a.** (§7Q); was a 5%–25% slab pre-Jun-2024 |
| ESI contribution | **15th** next month | Interest **12% p.a.** + damages up to 25% |
| PT (MH/KA/GJ/WB monthly) | per-state (commonly by 20th/30th) | state interest + penalty |
| PT (TN half-yearly) | per corporation cycle | state penalty |
| Form 24Q/138 | **31 Jul / 31 Oct / 31 Jan / 31 May** | ₹200/day (§234E, capped at TDS) + §271H ₹10k–₹1L |
| Form 16/130 | **15 Jun** | ₹100/day per certificate (§272A), capped |
| Bonus payment | within **8 months** of yr-end (≈ 30 Nov) | recovery + prosecution |
| Gratuity payment | within **30 days** of becoming due | **10% p.a. simple interest** from due date |
| LWF | state Jun/Dec cycle | state penalty |

> **Engine duty:** a **compliance calendar service** materialises every due date above per tenant/establishment/TAN, drives reminders (reusing Sitepresso notifications, §14), and flags overdue items on the tenant dashboard. Effective dates of the *rules themselves* (e.g. the EPF damages change on 14-Jun-2024) are versioned so a recompute of an old penalty uses the old slab.

---

## 14. Reuse map — what we take from Sitepresso (real paths, read-only verified 2026-06-22)

| Need (IN compliance) | Sitepresso asset | Path | How we use it |
|---|---|---|---|
| Tenant isolation (every compliance row scoped) | `businessId` row-level isolation | `backend/prisma/schema.prisma` (`Business`, FK `businessId`) | `LegalEntity`/`Establishment`/`Employee` hang under `businessId`; same filter everywhere |
| Tenant guard middleware | `requireBusiness`, `requireVertical` | `backend/src/core/middleware/requireBusiness.js`, `requireVertical.js` | Gate all `/hr/*` compliance routes |
| Auth + JWT + password-change revocation | auth middleware | `backend/src/core/middleware/auth.middleware.js` | Reused unchanged |
| RBAC / roles | `rbac.js`, `roles.js` | `backend/src/core/lib/rbac.js`, `backend/src/core/lib/roles.js` | Extend `BUSINESS_ADMIN`/`STAFF` with HR roles (Payroll Admin, Finance, Approver); the 50%-rule override is a permissioned action |
| Custom business roles (granular perms) | `BusinessRole` model + controller | `backend/src/core/controllers/businessRoles.controller.js` | Payroll-specific permission sets |
| Versioned key-value settings | `SystemSetting` | `backend/prisma/schema.prisma` (`SystemSetting`) | Super-admin global toggles (e.g. 50%-grace flag); compliance *rules* get dedicated versioned tables (§15), not KV |
| Multi-currency (INR billing) | FX service | `backend/src/domains/fx.js` | We bill IN tenants in **INR** via Razorpay; payroll itself is single-currency INR so FX is billing-only |
| Scheduled jobs (cron) | `scheduler.js` + node-cron + worker | `backend/src/core/lib/scheduler.js`, `backend/src/scheduler-worker.js` | Compliance-calendar reminders, monthly accrual jobs, ECR-generation jobs |
| Notifications (email/webhook, i18n) | notifications subsystem | `backend/src/core/lib/notifications/`, `backend/src/core/controllers/notification.controller.js` | Payslip-ready, filing-due, regime-declaration reminders |
| i18n en/hi | translator + locale JSON | `backend/src/i18n/translator.js`, `backend/src/i18n/email/{en,hi}.json` | Hindi payslip/labels (a real differentiator in IN) |
| Super-admin shell | `admin-core` + platform app | `packages/admin-core/index.js`, `apps/platform/app/superadmin/` | The **compliance-rules editor** (§15) is a new admin-core module |
| Billing/promo/gateway routing | billing libs | `backend/src/core/lib/billing/gatewayRouter.js`, `subscriptionBilling.js`, `razorpay.controller.js` | Tenant subscription billing (per `70-billing.md`); **independent of payroll-run logic** |
| Tenant resolution / custom domain | router worker | `apps/router/cloudflare-worker.js` | White-label ESS at `tenant.com` |

> **What we DELETE / ignore** (per `00-vision-and-principles.md`): `backend/src/{web,shop,booking}`, `apps/{web,shop,booking}`, the profession themes, domain/mailbox resale. None of it touches IN compliance.

---

## 15. Data model — compliance as a versioned data asset

> All tables `country`-scoped and (where tenant-specific) `businessId`/`establishmentId`-scoped, inheriting Sitepresso isolation (§14). **Global rule tables** (slabs, rates) are super-admin-owned, **not** tenant-editable; **tenant tables** (structures, runs) are tenant-owned. Prisma/PostgreSQL, consistent with Sitepresso.

### 15.1 Entity backbone (new)

```prisma
model LegalEntity {
  id            String   @id @default(uuid())
  businessId    String                                   // Sitepresso tenant isolation
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  legalName     String
  pan           String                                   // 10-char, validated
  tans          Tan[]                                    // 1..n TANs
  establishments Establishment[]
  bonusLedger   BonusSetOnSetOff[]
  createdAt     DateTime @default(now())
  @@index([businessId])
}

model Tan {
  id            String @id @default(uuid())
  legalEntityId String
  tan           String                                   // 10-char TAN, validated
  // Form 24Q/138 filed per TAN
}

model Establishment {
  id              String  @id @default(uuid())
  businessId      String
  legalEntityId   String
  name            String
  stateCode       String                                 // 'MH','KA','TN','GJ','WB'...
  // statutory registrations
  pfEstablishmentCode String?                            // EPFO code
  esicSubCode         String?
  ptrcNumber          String?                            // PT registration (employer)
  ptecNumber          String?                            // PT enrolment (entity)
  lwfRegNumber        String?
  // per-establishment policy elections
  pfOnFullWage        Boolean @default(false)            // §4.2: cap at 15k vs full wage
  pfRestrictAdminFloor Boolean @default(true)            // apply ₹500 admin floor
  gratuityActCovered  Boolean @default(true)             // 15/26 vs 15/30
  esiThreshold        Int     @default(10)               // 10 vs 20 (MH/CH shops)
  @@index([businessId])
  @@index([legalEntityId])
}
```

### 15.2 Versioned rule tables (super-admin owned, the core asset)

```prisma
// Generic versioned-rule envelope; one concrete table per rule family for type-safety.
model InTaxSlab {
  id           String   @id @default(uuid())
  country      String   @default("IN")
  regime       String                                    // 'NEW' | 'OLD'
  ageBand      String   @default("DEFAULT")              // OLD: 'DEFAULT'|'SENIOR'|'SUPER_SENIOR'
  lowerInr     Int                                       // inclusive
  upperInr     Int?                                      // null = no upper bound
  ratePct      Decimal  @db.Decimal(5,2)
  effectiveFrom DateTime
  effectiveTo   DateTime?                                // null = current
  source        String                                  // citation/notification ref
  @@index([country, regime, effectiveFrom])
}

model InStatutoryRate {                                  // EPF/ESI/cess/surcharge/87A etc.
  id            String  @id @default(uuid())
  ruleType      String                                  // 'EPF_EE','EPF_ER','EPS','EDLI','PF_ADMIN','ESI_EE','ESI_ER','CESS','SURCHARGE','REBATE_87A','STD_DEDUCTION'...
  ratePct       Decimal? @db.Decimal(6,4)
  flatInr       Int?                                    // e.g. STD_DEDUCTION 75000, REBATE_87A 60000
  capWageInr    Int?                                    // e.g. EPS/EDLI cap 15000, ESI ceiling 21000
  capAmountInr  Int?                                    // e.g. EPS ₹1,250, EDLI ₹75
  minAmountInr  Int?                                    // e.g. PF admin floor 500
  thresholdInr  Int?                                    // surcharge bands, 87A 1200000
  regime        String?                                 // where regime-specific
  effectiveFrom DateTime
  effectiveTo   DateTime?
  source        String
  @@index([ruleType, effectiveFrom])
}

model InPtSlab {
  id            String  @id @default(uuid())
  stateCode     String
  gender        String  @default("ANY")                 // MH male/female
  frequency     String                                  // 'MONTHLY'|'HALF_YEARLY'
  lowerInr      Int
  upperInr      Int?
  amountInr     Int
  specialMonth  Int?                                    // 2 = Feb top-up (₹300)
  specialAmtInr Int?
  effectiveFrom DateTime
  effectiveTo   DateTime?
  source        String
  @@index([stateCode, frequency, effectiveFrom])
}

model InLwfRule {
  id            String  @id @default(uuid())
  stateCode     String
  employeeInr   Int
  employerInr   Int
  frequency     String                                  // 'HALF_YEARLY'|'ANNUAL'
  deductMonths  Int[]                                   // e.g. [6,12] or [12]
  minEmployees  Int                                     // applicability threshold
  effectiveFrom DateTime
  effectiveTo   DateTime?
  source        String
}

model InMinimumWage {
  id            String  @id @default(uuid())
  stateCode     String
  scheduledEmployment String
  skillLevel    String                                  // UNSKILLED|SEMI|SKILLED|HIGHLY
  zone          String                                  // A|B|C
  monthlyInr    Int
  vdaInr        Int     @default(0)
  effectiveFrom DateTime
  effectiveTo   DateTime?
  source        String
  @@index([stateCode, scheduledEmployment, skillLevel, zone, effectiveFrom])
}
```

### 15.3 Tenant salary structure (configure, not build)

```prisma
model SalaryStructure {
  id            String @id @default(uuid())
  businessId    String
  establishmentId String
  employeeId    String
  effectiveFrom DateTime
  ctcAnnualInr  Decimal @db.Decimal(14,2)
  components    SalaryComponent[]                        // basic, da, hra, special, lta...
  // derived & persisted for audit/recompute
  basicPlusDaPct Decimal @db.Decimal(5,2)               // §3 validator result
  wageDef50Compliant Boolean
  @@index([businessId, employeeId, effectiveFrom])
}

model SalaryComponent {
  id            String @id @default(uuid())
  structureId   String
  code          String                                  // 'BASIC','DA','HRA','SPECIAL','CONVEYANCE','LTA'...
  monthlyInr    Decimal @db.Decimal(12,2)
  isWageForCode Boolean                                 // included in statutory 'wages' (§3)
  taxable       Boolean
}
```

### 15.4 Payroll run + immutable computation snapshot

```prisma
model PayrollRun {
  id            String @id @default(uuid())
  businessId    String
  establishmentId String
  periodMonth   Int                                     // 1..12 (Apr=1? store calendar month; FY derived)
  periodYear    Int
  state         String                                  // DRAFT|CALCULATED|APPROVED|FINALIZED|PAID|FILED|LOCKED
  runAt         DateTime @default(now())
  rulesAsOf     DateTime                                // = period end; the version pin
  computations  InTaxComputation[]
  @@unique([establishmentId, periodMonth, periodYear])
  @@index([businessId, state])
}

model InTaxComputation {                                // one immutable row per employee per run
  id            String @id @default(uuid())
  runId         String
  employeeId    String
  // snapshot of every input + every output (so recompute is reproducible)
  grossInr      Decimal @db.Decimal(12,2)
  wagesForPfInr Decimal @db.Decimal(12,2)               // post-50%-add-back
  esiGrossInr   Decimal @db.Decimal(12,2)
  // outputs
  epfEeInr Decimal @db.Decimal(10,2); epfErInr Decimal @db.Decimal(10,2)
  epsInr Decimal @db.Decimal(10,2); edliInr Decimal @db.Decimal(10,2); pfAdminInr Decimal @db.Decimal(10,2)
  esiEeInr Decimal @db.Decimal(10,2); esiErInr Decimal @db.Decimal(10,2)
  ptInr Decimal @db.Decimal(8,2); lwfEeInr Decimal @db.Decimal(8,2); lwfErInr Decimal @db.Decimal(8,2)
  tdsInr Decimal @db.Decimal(10,2)
  // tax projection snapshot (for §192 averaging + Form 16/130)
  projAnnualTaxInr Decimal @db.Decimal(12,2)
  regime String
  rebate87aInr Decimal @db.Decimal(10,2); marginalReliefInr Decimal @db.Decimal(10,2)
  surchargeInr Decimal @db.Decimal(10,2); cessInr Decimal @db.Decimal(10,2)
  rulesAsOf DateTime
  @@index([runId])
  @@unique([runId, employeeId])
}
```

### 15.5 / 15.6 Notes
- **15.5 — per-establishment policy** (PF full-wage vs cap, ESI threshold, gratuity coverage) lives on `Establishment` (§15.1) and is read at run time.
- **15.6 — minimum-wage dataset** is the largest super-admin-curated table; loaded via a versioned import pipeline with source citations, surfaced in the super-admin compliance console (`60-super-admin.md`).

---

## 16. Engine contract — deterministic calculation order & state machines

> Plugs into the country-agnostic engine in `30-payroll-engine.md` as the **IN strategy**. The engine never reads a constant; it calls `resolveRule(country, ruleType, asOf=run.rulesAsOf)`.

### 16.1 Per-employee, per-period pipeline (strict order)

```
0.  Resolve effective salary structure + posting (which establishment) as-of period end.
1.  Compute gross + per-component split.
2.  WAGE DEFINITION (§3): compute statutory 'wages' = Basic+DA (+retaining);
    if Σexclusions > 50% → add back excess → effective wages.  Set 50%-flag.
3.  EPF (§4): PFWage = full or min(wage,15000) per establishment policy;
    EE 12%; EPS = min(8.33%×min(PFWage,15000), 1250); ER-EPF = 12%×PFWage − EPS;
    EDLI = 0.50%×min(PFWage,15000) cap 75; admin = max(0.50%×PFWage, floor at est level).
4.  ESI (§5): if latched-eligible this contribution period → EE 0.75%, ER 3.25% on ESI gross (round up).
5.  PT (§6): resolve state slab by establishment+frequency+month (Feb top-up; TN half-yearly).
6.  LWF (§10): if period month ∈ deductMonths for state → EE/ER flat.
7.  TDS (§7/§192 averaging): project annual → tax → §87A rebate → marginal relief →
    surcharge (+marginal relief) → 4% cess → minus YTD TDS → ÷ months remaining.
8.  Net pay = gross − (EE EPF + EE ESI + PT + LWF EE + TDS + other deductions − LOP etc.).
9.  Accruals: gratuity monthly accrual; bonus provision.
10. Persist immutable InTaxComputation snapshot (rulesAsOf pinned).
```

Steps 3–6 are **order-independent** (parallelisable); step 7 depends on 2 only; step 8 depends on 3–7. The engine is a **pure function** `(structure, attendance, rules@asOf) → computation`.

### 16.2 Validation gates (block FINALIZE)

| Code | Trigger | Severity |
|---|---|---|
| `WAGE_DEF_50PCT_BREACH` | Basic+DA < 50% (post grace) | Block (or warn in grace, §3.3) |
| `MIN_WAGE_BREACH` | gross < resolved MW | Block |
| `PF_WAGE_NEGATIVE` / `MISSING_UAN` | bad PF inputs | Block PF file, warn payslip |
| `MISSING_PAN` | TDS > 0 and no PAN → 20% TDS u/s 206AA | Warn + apply 20% |
| `ESI_LATCH_CONFLICT` | mid-period eligibility change attempted | Auto-resolve per §5.3 |
| `REGIME_NOT_ELECTED` | default to NEW, log assumption | Info |

### 16.3 ESI latch state machine
`UNEVALUATED → (period start) EVALUATE → COVERED | NOT_COVERED → (next period start) re-EVALUATE`. Mid-period gross changes never transition; only the 1-Apr/1-Oct boundary does (§5.3).

### 16.4 TDS step detail (the 12 sub-steps)
1 project annual gross · 2 regime select · 3 deductions (regime-aware) · 4 taxable · 5 slab tax · 6 surcharge · 7 §87A rebate · 8 §87A marginal relief · 9 surcharge marginal relief · 10 +4% cess · 11 − YTD deducted · 12 ÷ months remaining → round.

### 16.5 Declaration/proof window
Apr–Dec: provisional (declared) regime/deductions. **Jan–Mar:** lock to **submitted proofs**; recompute remaining months to true-up. Excess deducted is carried/refunded via lower Q4 deductions; shortfall is recovered (capped so net ≥ 0 unless employee consents).

### 16.6 Rounding policy (per pillar — they differ, deliberately)
EPF: nearest ₹1 per account. ESI: **round up** per party. PT: exact slab integer. TDS: nearest ₹1 monthly, nearest ₹10 (§288B) on the annual return. Persist both raw and rounded.

### 16.7 Mid-month state transfer
Split posting → PT possibly in 2 states; MW re-resolved per state-days; PF/ESI continue under the original sub-code unless the establishment changes. Generates two register lines.

### 16.8 LOP / new joiner / leaver
Pro-rate by paid days / 26 or calendar days per the establishment's convention; EPS/EDLI caps still on (capped) monthly wage; gratuity eligibility checks 5-yr/240-day; final settlement triggers gratuity + leave encashment + bonus-to-date + Form 16/130 part for the stub period.

### 16.9 50%-rule override path
`WAGE_DEF_50PCT_BREACH` → requires `payroll.override.wagedef` permission (RBAC, §14) → reason captured → `AuditLog` row → run may proceed with **deemed-wages add-back still applied** (override permits the *structure*, never suppresses the *correct statutory computation*).

### 16.10 Immutability / recompute
FINALIZED runs are append-only; corrections create an **adjustment run** (delta), never an edit. Recompute uses `rulesAsOf` → byte-identical reproduction years later. This is the auditability principle from `00-vision-and-principles.md` §7.3.

### 16.11 PayrollRun state machine
`DRAFT → CALCULATED → APPROVED → FINALIZED → PAID → FILED → LOCKED`. Backward only `DRAFT↔CALCULATED`. `FINALIZED` freezes computations; `FILED` records return acknowledgements (ECR TRRN, 24Q token, challan CIN).

---

## 17. Mandatory golden test cases (CI gate)

| # | Scenario | Asserts |
|---|---|---|
| T1 | Gross ₹18L new regime | §2.6 = ₹1,50,800 annual |
| T2 | Taxable ₹11,85,000 | §87A → tax **nil** |
| T3 | Taxable ₹12,65,000 | marginal relief → **₹67,600** total (not ₹72,540) |
| T4 | PF wage ₹25k, cap policy | EPS=₹1,250, ER-EPF=₹550, EDLI=₹75 |
| T5 | PF wage ₹25k, full-wage policy | EPS=₹1,250, ER-EPF=₹1,750 |
| T6 | PF admin, single contributory member | admin = **₹500 floor** not ₹75 |
| T7 | EDLI admin (A/c 22) | **₹0** |
| T8 | ESI ₹19k → raise to ₹22k in July | ESI continues to 30 Sep, exits 1 Oct |
| T9 | MH PT, Feb | ₹300 (not ₹200); FY total ₹2,500 |
| T10 | KA PT, gross ₹24,000, May 2025 | **Nil** (post 01-Apr-2025 ₹25k threshold) |
| T11 | KA PT, gross ₹24,000, Jan 2025 (old rule) | ₹200 (pre-revision version resolves) |
| T12 | TN PT, half-year ₹62,000 | ₹1,025 for the half |
| T13 | Gratuity 8y7m, Basic+DA ₹60k | ₹3,11,538 (years→9) |
| T14 | Bonus, Basic+DA ₹18k, 8.33% | ₹6,997/yr (capped ₹7,000) |
| T15 | 50% breach: basic 35% | `WAGE_DEF_50PCT_BREACH` + deemed add-back to PF base |
| T16 | No PAN, TDS due | 20% u/s 206AA |
| T17 | March TDS | deposit due **30 Apr** |
| T18 | Recompute Oct-2025 payslip in 2027 | 50% add-back **NOT** applied (effective 21-Nov-2025) |
| T19 | FY2025-26 cert | **Form 16** template; FY2026-27 → **Form 130** |

---

## 18. API surface (representative; under `/api/hr/in/...`, tenant-scoped)

| Method & path | Purpose |
|---|---|
| `POST /api/hr/in/structures/:employeeId/validate` | run §3 50%-rule + MW check, return flags & suggested compliant split |
| `POST /api/hr/payroll/runs` | create DRAFT run for establishment+period |
| `POST /api/hr/payroll/runs/:id/calculate` | execute §16.1 pipeline → CALCULATED |
| `GET  /api/hr/payroll/runs/:id/preview` | per-employee computation + flags |
| `POST /api/hr/payroll/runs/:id/approve` / `/finalize` | state transitions (RBAC-gated) |
| `GET  /api/hr/payroll/runs/:id/payslips/:employeeId.pdf` | white-labelled statutory payslip |
| `GET  /api/hr/payroll/runs/:id/files/ecr` | EPF ECR file |
| `GET  /api/hr/payroll/runs/:id/files/esic` | ESIC contribution CSV |
| `GET  /api/hr/filings/24q?tan=&quarter=` | Form 24Q/138 FVU file |
| `GET  /api/hr/filings/form16?employeeId=&fy=` | Form 16/130 PDF (version-switched) |
| `GET  /api/hr/registers/:type?period=` | digital statutory registers |
| `GET  /api/hr/compliance/calendar?establishmentId=` | due-date list + status |
| `--- super-admin (admin.hr.com) ---` | |
| `GET/POST/PUT /api/admin/in/rules/:family` | CRUD versioned rule rows (slabs/rates/PT/LWF/MW) with effectiveFrom + source |
| `POST /api/admin/in/rules/:family/import` | bulk versioned import (MW dataset) |
| `GET  /api/admin/in/rules/:family/diff?asOf1=&asOf2=` | version diff (audit) |

Rule-edit endpoints are **super-admin only**, write `AuditLog`, and **never** allow `effectiveFrom` in the past relative to a FILED run (would corrupt filed periods) — enforced server-side.

---

## 19. Open decisions for the founder

1. **50%-rule enforcement at launch** (§3.3): hard-block vs 90-day per-tenant grace window (super-admin flag). *Recommendation: grace window, default 90 days, surfaced loudly.*
2. **PF on full wage vs ₹15,000 cap** is a per-establishment **policy we store** — but do we **default** new tenants to cap (lower cost, common) or full-wage (more generous)? *Recommendation: default cap; make it a one-click establishment policy with cost preview.*
3. **Form 24Q/138 & Form 16/130 filing**: do we generate **FVU-input files only** (tenant runs govt FVU / their TRACES), or pursue a **TRACES/protean API integration** (premium, higher build + KYC)? *Recommendation: files at launch (v1), API integration as a paid add-on (v2) — gated behind a plan feature flag per `60-super-admin.md`.*
4. **Minimum-wage dataset ownership**: we curate centrally (hundreds of rows, twice-yearly VDA). *Recommendation: yes — it is a moat and a liability we must own, not crowdsource; budget an ops cadence.*
5. **States at launch**: ship PT/LWF/MW for **MH, KA, TN, GJ, WB** fully; everything else PT-nil/flag-for-config. Confirm this 5-state priority matches the sales pipeline.
6. **Fixed-term-employee gratuity pro-rata** under the Social Security Code: rules still notifying. *Recommendation: implement the flag now, leave the pro-rata multiplier as a versioned rule row to flip when notified.*
7. **PAN/UAN/Aadhaar validation depth** at onboarding: format-only vs live verification (NSDL PAN verify / EPFO UAN). *Recommendation: format + checksum at launch; live verify as add-on.*

---

## 20. Sources (verified 2026-06-22)

- Income tax slabs / §87A / std deduction / surcharge / cess (FY 2025-26 & 2026-27): cleartax.in/s/income-tax-slabs; incometax.gov.in (AY 2026-27); cleartax.in/s/marginal-relief-surcharge; bajajfinserv.in income-tax-slabs.
- EPF/EPS/EDLI/admin split, ₹15,000 cap, interest 8.25%, damages 1%/mo (14-Jun-2024) & 12% §7Q: epfindia.gov.in (ContributionRate.pdf, 237th CBT press release); taxguru.in rates-contribution-epf; cleartax.in/s/edli; lexology.com (revised damages).
- ESI 0.75%/3.25%, ₹21,000 ceiling, 10/20-employee threshold, contribution periods: tallysolutions.com; hrone.cloud; cleartax.in/s/esi-rate.
- Professional Tax MH/KA/TN/GJ/WB + KA Act 33 of 2025 (01-Apr-2025): greythr.freshdesk.com (KA April-2025); cleartax.in/s/professional-tax-{karnataka,maharashtra,tamil-nadu,west-bengal}; mahagst.gov.in; tn.gov.in/dtp; wbcomtax.gov.in; saral.pro; factohr.com.
- Labour Codes live 21-Nov-2025 + 50% wage definition: ey.com (21-Nov-2025 alert PDF); kpmg.com (flash-alert-2025-267); bdo.in; pwc.in/tax-knowledge-hub/new-labour-codes; payroll.org (2025/12/17).
- Gratuity 15/26, ₹20L cap, 30-day/10%: cleartax.in/s/gratuity-calculator; bankbazaar.com/tax/gratuity.
- Bonus ₹21,000 / ₹7,000 cap / 8.33–20% / set-on-set-off / 8 months: greythr.com; omnivoo.com/blog/statutory-bonus-india; quikchex.in.
- LWF state rates + KA 10-employee (07-Jan-2026): futurexsolutions.com; zoho.com/in/payroll (LWF); omconsultants.in.
- TDS deposit 7th / March 30 Apr; Form 24Q due 31 Jul/Oct/Jan/May; §234E ₹200/day: cleartax.in/s/tds-payment-due-dates-and-penalties; onlinetds.com; kredily.com (Form 24Q).
- Form 16 → Form 130, 24Q → 138, 26AS → 168 (Income-tax Act 2025; Form 16 valid FY2025-26 issued 15-Jun-2026; Form 130 from TY2026-27 issued 15-Jun-2027): caclubindia.com (form-130-income-tax-act-2025); cleartax.in/s/form-130-income-tax; taxguru.in; scconline.com (2026/06/15 comparison).
- Sitepresso reuse paths: read-only inspection of `/Users/kp/sitepresso` on 2026-06-22 (paths cited inline in §14).

> **Maintenance note:** every figure above is also a row in the §15 tables with `effectiveFrom`/`source`. When a Budget or notification lands, the super-admin edits a versioned row — **this doc and the running system stay in lockstep without a deploy.** That is the whole point.
