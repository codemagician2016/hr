# Feature 21 — Labour Welfare Fund (LWF)

**Status:** Spec / build-ready
**Author:** Payroll-compliance architecture
**Date:** 2026-06-24
**Country:** India (`IN`) only — the 4th statutory pillar alongside **EPF / ESI / PT / TDS**
**Reuse anchors:** `backend/src/hr/payroll/compliance/india.js` (`professionalTax` rule table + `computeProfessionalTax`), `backend/src/hr/payroll/engine.js` (the `complianceModule.compute()` seam), `backend/src/hr/payroll/service.js` (`FILING_PLAN` / `fileRun`), `backend/prisma/schema.prisma` (`RegistrationKind.LWF`, `RemittanceKind.IN_LWF` — **both already exist**).

---

## 0. One-paragraph summary

Labour Welfare Fund is a **state-specific, fixed-rupee (not %-of-salary) statutory contribution** with an **employee part and an employer part**, deducted in payroll, shown on the payslip, and remitted to the State Labour Welfare Board. Unlike PF/ESI/PT it is **not levied in every state** (≈16 states have an Act), the **amounts are flat per head** (e.g. Maharashtra ₹25 EE / ₹75 ER per half-year), and the **periodicity varies by state** — monthly (Haryana, Kerala), half-yearly (Maharashtra, Gujarat, MP, WB, deducted in the June & December payrolls), or annual (Karnataka, AP, deducted in the December payroll). The clean, codebase-native way to ship this is to **mirror `professionalTax` exactly**: add an effective-dated `labourWelfareFund.states` rule table to `india.js`, add a pure `computeLwf()` pillar, wire it into `compute()` as a **post-tax employee deduction + employer contribution that fires only in the state's prescribed deduction month(s)**, render an `LWF` payslip line, and let the **already-present** `RegistrationKind.LWF` / `RemittanceKind.IN_LWF` plumbing carry registration and remittance. No new engine; no fork.

---

## 1. Statutory research — the exact rule

### 1.1 What LWF is

LWF is levied under **state-specific Labour Welfare Fund Acts** (e.g. *The Maharashtra Labour Welfare Fund Act, 1953*; *The Karnataka Labour Welfare Fund Act, 1965*; etc.). Money funds welfare amenities (housing, education, medical, recreation) for workers in that state. It is administered by a **State Labour Welfare Board**, not a central body — so there is **no national rate, no national periodicity, no national cap**. Each state Act/rules fixes:

- a **flat employee contribution** (rupees per head per contribution period — NOT a % of wages),
- a **flat employer contribution** (usually 2×–3× the employee part),
- a **contribution period / periodicity** (monthly | half-yearly | annual),
- **prescribed deduction & remittance months**,
- an **eligibility carve-out** — most Acts **exclude employees in a managerial/supervisory capacity above a low wage threshold** (e.g. MP/Chhattisgarh exclude > ₹10,000/mo managerial; Gujarat > ₹3,500; Telangana/WB/Goa > ₹1,600). Below-threshold and all workmen are covered.

### 1.2 Why it cannot be folded into PT

| Dimension | Professional Tax (PT) | Labour Welfare Fund (LWF) |
|---|---|---|
| Basis | Slab on gross/half-year income | **Flat rupees per head** (income-independent) |
| Employer part | None (employee only) | **Yes — separate employer contribution** |
| Periodicity | Monthly / half-yearly | **Monthly / half-yearly / annual** (state-varying) |
| Deduction months | Every applicable month | **Only the prescribed contribution month(s)** (e.g. Jun & Dec) |
| National cap | ₹2,500/yr (Art. 276) | **None** |
| Eligibility | All earners above slab | **Excludes managerial above a wage threshold** |

So LWF is its **own pillar** with the same *shape* as PT (effective-dated per-state table, resolved as-of period end) but different *mechanics* (flat amount, employer side, fires only in deduction months).

### 1.3 Rate table (verified 2026-06-24)

Authoritative per-state EE/ER amounts, periodicity, deduction month(s), and the manager-exclusion wage ceiling. **Half-yearly states are universally deducted in the June & December payrolls; annual states in December; monthly states every month.** Where sources disagree on a flat amount the spec uses the **current state-board figure** and notes the prior value as a superseded effective-dated `version`.

| State | EE (₹) | ER (₹) | Periodicity | Deduction month(s) | Remit due | Mgr-exclusion ceiling |
|---|---|---|---|---|---|---|
| **Maharashtra (MH)** | 25 | 75 | Half-yearly | Jun, Dec | 15 Jul, 15 Jan | excl. managerial/supervisory (per Act) |
| **Karnataka (KA)** | 50 | 100 | Annual | Dec | 15 Jan | none (all employees; revised 2024 Act) |
| **Gujarat (GJ)** | 6 | 12 | Half-yearly | Jun, Dec | 15 Jul, 15 Jan | > ₹3,500/mo managerial |
| **Tamil Nadu (TN)** | 20 | 40 | Annual | Dec | 31 Jan | > ₹15,000/mo managerial/supervisory |
| **Madhya Pradesh (MP)** | 10 | 30 | Half-yearly | Jun, Dec | 15 Jul, 15 Jan | > ₹10,000/mo managerial |
| **Chhattisgarh (CG)** | 15 | 45 | Half-yearly | Jun, Dec | 15 Jul, 15 Jan | > ₹10,000/mo managerial |
| **West Bengal (WB)** | 3 | 15 | Half-yearly | Jun, Dec | 15 Jul, 15 Jan | > ₹1,600/mo managerial |
| **Andhra Pradesh (AP)** | 30 | 70 | Annual | Dec | 31 Jan | excl. managerial / part-time |
| **Telangana (TS)** | 2 | 5 | Annual | Dec | 31 Jan | > ₹1,600/mo managerial |
| **Goa (GA)** | 60 | 180 | Half-yearly | Jun, Dec | 15 Jul, 15 Jan | > ₹1,600/mo managerial |
| **Haryana (HR)** | 31 | 62 | Monthly | every month | 15th next month | none (incl. contractors) |
| **Punjab (PB)** | 5 | 20 | Monthly | every month | 15 Apr, 15 Oct (board cycle) | none |
| **Kerala (KL)** | 20 | 20 | Monthly | every month | 5th next month | under KS&CE Act 1960 |
| **Delhi (DL)** | 0.75 | 2.25 | Half-yearly | Jun, Dec | 15 Jul, 15 Jan | > ₹2,500/mo managerial |
| **Odisha (OR)** | 10 | 20 | Half-yearly | Jun, Dec | 15 Jul, 15 Jan | > ₹1,600/mo managerial |

**No LWF (deduction = ₹0, `configured:false`):** Uttar Pradesh, Rajasthan, Bihar, Jharkhand, Assam, Uttarakhand, Himachal, J&K, and the rest. The table is **allow-list**: an unmapped state returns nil, exactly like `computeProfessionalTax` returning `{ amountMinor: 0, configured: false }` for a no-PT state.

> **Note on amounts.** LWF flat figures change by gazette amendment (Maharashtra ₹12/₹36 → ₹25/₹75 in Mar-2024; Karnataka ₹20/₹40 → ₹50/₹100 in the 2024 Act). They are therefore **effective-dated `versions[]`** in the table — never hard-coded constants — so a recompute of a closed prior period uses the figure that was law *then*. Tenants verify with their State Welfare Board before filing (the admin config exposes an override; see §6).

**Sources:** [Patron Accounting — LWF rates & due dates](https://www.patronaccounting.com/blog/labour-welfare-fund-india-contribution-rates-due-dates), [Zoho Payroll — Guide to LWF](https://www.zoho.com/in/payroll/academy/taxes-and-compliance/guide-to-lwf.html), [greytHR — revised Karnataka LWF](https://greythr.freshdesk.com/support/solutions/articles/1060000148594-what-is-the-revised-karnataka-labour-welfare-fund-lwf-contribution-as-per-the-recent-amendment-), [Simpliance — Maharashtra LWF](https://www.simpliance.in/labour-welfare-fund-detail/maharashtra), [factoHR — Maharashtra LWF](https://factohr.com/labour-welfare-fund/maharashtra/), [futurexsolutions — LWF state-wise 2026](https://futurexsolutions.com/labour-welfare-fund-india-2026-state-wise-guide/).

---

## 2. Codebase audit — what to reuse, what to add

### 2.1 What already exists (reuse, do not fork)

| Asset | File / location | Role for LWF |
|---|---|---|
| `professionalTax.states` table + `resolveVersion` | `india.js` §6, lines ~239–533, 619–627 | **Pattern to mirror** for `labourWelfareFund.states`. Same `{ effectiveFrom, effectiveTo, versions[] }` shape, same as-of-period-end resolution. |
| `computeProfessionalTax({stateCode, …})` | `india.js` lines ~852–895 | Template for the new `computeLwf()` — allow-list state lookup, nil for unconfigured. |
| `periodAsOf` / `periodMonth` | `india.js` lines ~681–698 | Reused verbatim — LWF needs **period end** (version resolution) and **calendar month** (does this month fire?). |
| `compute(ctx)` contract | `india.js` lines ~1578–1755 | The orchestrator. Add a **§4b LWF block** between PT (§4) and TDS (§5): push to `employeeDeductions` (EE) **and** `employerContributions` (ER). |
| Engine seam consumes `employeeDeductions[]` + `employerContributions[]` | `engine.js` lines 234–285 | **Zero change.** Already iterates both arrays, carries `code/label/amountMinor/baseMinor/explain/statutory`. LWF lines flow through untouched. |
| `entityArg.stateCode` resolution | `service.js` line 368 (`sp.ptStateCode || employee.stateCode || entity.stateCode`) | **Reused** — LWF resolves on the same state code. (Optional `lwfStateCode` override added later, §6.4.) |
| `RegistrationKind.LWF` | `schema.prisma` line 7459 | **Already present** — `StatutoryRegistration` for the LWF board number, periodicity in `meta`. No migration for the enum. |
| `RemittanceKind.IN_LWF` | `schema.prisma` (RemittanceKind enum) | **Already present** — the remittance row LWF writes. No migration for the enum. |
| `FILING_PLAN.IN` + `fileRun` | `service.js` lines 2005–2118 | Add one `IN_LWF` plan entry + an `amountForKind('IN_LWF')` case. (See §5.) |
| `countryContext.payrollStatutory` already lists `'LWF'` | `backend/src/hr/tenant/countryContext.js:46` | The country surface already advertises LWF — no change. |
| Payslip line render (statutory deduction loop) | `payslipPdf.js` (`snap.employeeDeductions`), `Payslip.snapshotJson` | LWF appears automatically as a deduction line; add ER LWF to the employer-cost block. |
| Gap-analysis prescription | `docs/features/FACTOHR-GAP-ANALYSIS.md:119` | Confirms the intended approach: *"RegistrationKind.LWF exists; add an LWF pillar to compute() following the PT pattern (per-state effective-dated EE+ER, half-yearly/annual)."* |

### 2.2 What is missing (this feature builds)

1. `labourWelfareFund` rule table + `computeLwf()` in `india.js`.
2. The §4b LWF block in `compute()` (EE deduction + ER contribution, gated on the deduction month).
3. Persistence: `PayRunLine.lwfEmployee` / `lwfEmployer` columns (mirroring `pt`, `pfEmployee`, `pfEmployer`) + a `PayRunLineComponent` row of code `LWF` (and `LWF_ER`). **Migration.**
4. The `IN_LWF` `FILING_PLAN` entry + `amountForKind` case + due-date logic for half-yearly/annual.
5. Admin config UX (registration + per-state amount override) and ESS payslip surfacing.
6. Golden tests.

---

## 3. The rule table & pure pillar (`india.js`)

### 3.1 `labourWelfareFund` rule table (mirror `professionalTax.states`)

Add to `rules` in `india.js`, immediately after `professionalTax`:

```js
// §LWF Labour Welfare Fund — per state, flat rupees/head, effective-dated.
// FLAT amounts (not %), with an EMPLOYER part, fired ONLY in the state's
// prescribed deduction month(s). Allow-list: unmapped state => nil. Mirrors
// professionalTax.states exactly (same versions[] + resolveVersion as-of).
//
//   frequency:        'MONTHLY' | 'HALF_YEARLY' | 'ANNUAL'
//   deductionMonths:  calendar months (1..12) the contribution is taken
//                     (MONTHLY => 1..12; HALF_YEARLY => [6,12]; ANNUAL => [12])
//   eeRupees/erRupees flat per-head contribution for the period
//   mgrExclusionRupees employees in a managerial/supervisory capacity earning
//                     ABOVE this monthly wage are EXEMPT (null => no exclusion).
labourWelfareFund: {
  states: {
    MH: {
      frequency: 'HALF_YEARLY', deductionMonths: [6, 12],
      versions: [
        { effectiveFrom: '2000-01-01', effectiveTo: '2024-02-29', eeRupees: 12, erRupees: 36, mgrExclusionRupees: null },
        { effectiveFrom: '2024-03-01', eeRupees: 25, erRupees: 75, mgrExclusionRupees: null }, // Amendment Mar-2024
      ],
    },
    KA: {
      frequency: 'ANNUAL', deductionMonths: [12],
      versions: [
        { effectiveFrom: '2000-01-01', effectiveTo: '2024-12-31', eeRupees: 20, erRupees: 40, mgrExclusionRupees: null },
        { effectiveFrom: '2025-01-01', eeRupees: 50, erRupees: 100, mgrExclusionRupees: null }, // 2024 Act, eff. 2025
      ],
    },
    GJ: { frequency: 'HALF_YEARLY', deductionMonths: [6, 12],
      versions: [{ effectiveFrom: '2000-01-01', eeRupees: 6, erRupees: 12, mgrExclusionRupees: 3500 }] },
    TN: { frequency: 'ANNUAL', deductionMonths: [12],
      versions: [{ effectiveFrom: '2000-01-01', eeRupees: 20, erRupees: 40, mgrExclusionRupees: 15000 }] },
    MP: { frequency: 'HALF_YEARLY', deductionMonths: [6, 12],
      versions: [{ effectiveFrom: '2000-01-01', eeRupees: 10, erRupees: 30, mgrExclusionRupees: 10000 }] },
    CG: { frequency: 'HALF_YEARLY', deductionMonths: [6, 12],
      versions: [{ effectiveFrom: '2000-01-01', eeRupees: 15, erRupees: 45, mgrExclusionRupees: 10000 }] },
    WB: { frequency: 'HALF_YEARLY', deductionMonths: [6, 12],
      versions: [{ effectiveFrom: '2000-01-01', eeRupees: 3, erRupees: 15, mgrExclusionRupees: 1600 }] },
    AP: { frequency: 'ANNUAL', deductionMonths: [12],
      versions: [{ effectiveFrom: '2000-01-01', eeRupees: 30, erRupees: 70, mgrExclusionRupees: null }] },
    TS: { frequency: 'ANNUAL', deductionMonths: [12],
      versions: [{ effectiveFrom: '2000-01-01', eeRupees: 2, erRupees: 5, mgrExclusionRupees: 1600 }] },
    GA: { frequency: 'HALF_YEARLY', deductionMonths: [6, 12],
      versions: [{ effectiveFrom: '2000-01-01', eeRupees: 60, erRupees: 180, mgrExclusionRupees: 1600 }] },
    HR: { frequency: 'MONTHLY', deductionMonths: [1,2,3,4,5,6,7,8,9,10,11,12],
      versions: [{ effectiveFrom: '2000-01-01', eeRupees: 31, erRupees: 62, mgrExclusionRupees: null }] },
    PB: { frequency: 'MONTHLY', deductionMonths: [1,2,3,4,5,6,7,8,9,10,11,12],
      versions: [{ effectiveFrom: '2000-01-01', eeRupees: 5, erRupees: 20, mgrExclusionRupees: null }] },
    KL: { frequency: 'MONTHLY', deductionMonths: [1,2,3,4,5,6,7,8,9,10,11,12],
      versions: [{ effectiveFrom: '2000-01-01', eeRupees: 20, erRupees: 20, mgrExclusionRupees: null }] },
    DL: { frequency: 'HALF_YEARLY', deductionMonths: [6, 12],
      // Delhi rupee-and-paise amounts — stored as paise-exact via fractional rupees.
      versions: [{ effectiveFrom: '2000-01-01', eeRupees: 0.75, erRupees: 2.25, mgrExclusionRupees: 2500 }] },
    OR: { frequency: 'HALF_YEARLY', deductionMonths: [6, 12],
      versions: [{ effectiveFrom: '2000-01-01', eeRupees: 10, erRupees: 20, mgrExclusionRupees: 1600 }] },
  },
},
```

> Delhi's ₹0.75 / ₹2.25 are sub-rupee — `rupees()` rounds, so use a **paise-exact helper** for LWF: `lwfRupeesToPaise(r) = Math.round(r * 100)` (no integer `Math.round(r)` first). The rest are whole rupees.

### 3.2 `computeLwf()` — the pure pillar (mirror `computeProfessionalTax`)

```js
/**
 * Resolve LWF for one period. State-aware, effective-dated, FLAT amount, with an
 * employer part. Fires ONLY in the state's prescribed deduction month(s). Honours
 * the managerial-exclusion wage ceiling. Allow-list: unmapped state => nil.
 *
 * @param stateCode      'MH'|'KA'|… (unmapped => not configured)
 * @param month          1..12 calendar month (does LWF fire this month?)
 * @param asOf           period end date 'YYYY-MM-DD' (version resolution)
 * @param monthlyGrossRupees  employee monthly wage (for the mgr-exclusion test)
 * @param isManagerial   true if the employee is in a managerial/supervisory role
 * @returns { eeMinor, erMinor, frequency, configured, fires, exemptReason }
 */
function computeLwf({ stateCode, month, asOf, monthlyGrossRupees = null, isManagerial = false }) {
  const cfg = rules.labourWelfareFund.states[stateCode];
  if (!cfg) return { eeMinor: 0, erMinor: 0, frequency: 'NONE', configured: false, fires: false };
  const version = resolveVersion(cfg.versions, asOf);
  if (!version) return { eeMinor: 0, erMinor: 0, frequency: cfg.frequency, configured: false, fires: false };

  // Managerial exclusion: above the ceiling AND in a managerial role => exempt.
  if (
    version.mgrExclusionRupees != null && isManagerial &&
    monthlyGrossRupees != null && monthlyGrossRupees > version.mgrExclusionRupees
  ) {
    return { eeMinor: 0, erMinor: 0, frequency: cfg.frequency, configured: true, fires: false,
             exemptReason: 'MANAGERIAL_ABOVE_CEILING' };
  }

  // Does LWF fire THIS calendar month? (HALF_YEARLY => Jun/Dec; ANNUAL => Dec; MONTHLY => every.)
  const fires = cfg.deductionMonths.includes(month);
  if (!fires) {
    return { eeMinor: 0, erMinor: 0, frequency: cfg.frequency, configured: true, fires: false };
  }

  const toPaise = (r) => Math.round(r * PAISE); // paise-exact (handles ₹0.75 etc.)
  return {
    eeMinor: toPaise(version.eeRupees),
    erMinor: toPaise(version.erRupees),
    frequency: cfg.frequency,
    configured: true,
    fires: true,
  };
}
```

Export `computeLwf` under `_internals` (for paise-exact unit tests) exactly like `computeProfessionalTax`.

### 3.3 Wire into `compute()` — new **§4b** block (after PT §4, before TDS §5)

```js
// ----- 4b. Labour Welfare Fund (LWF) — flat EE+ER, fires only in deduction months
const lwfStateCode = entity.lwfStateCode || stateCode; // reuse PT state unless overridden
if (lwfStateCode) {
  const lwf = computeLwf({
    stateCode: lwfStateCode,
    month,
    asOf,
    monthlyGrossRupees: periodGrossMinor / PAISE,
    isManagerial: employee.isManagerial === true,
  });
  if (lwf.configured && lwf.fires) {
    if (lwf.eeMinor > 0) {
      employeeDeductions.push({
        code: 'LWF',
        label: `Labour Welfare Fund (${lwfStateCode})`,
        amountMinor: lwf.eeMinor,
        explain: `${lwfStateCode} LWF employee share (${lwf.frequency.toLowerCase()}), deducted in month ${month}`,
      });
    }
    if (lwf.erMinor > 0) {
      employerContributions.push({
        code: 'LWF_ER',
        label: `Labour Welfare Fund — employer (${lwfStateCode})`,
        amountMinor: lwf.erMinor,
        explain: `${lwfStateCode} LWF employer share (${lwf.frequency.toLowerCase()})`,
      });
    }
  }
}
```

**Placement rationale:** LWF is a **post-tax** statutory deduction (it does not reduce taxable income for TDS), so it sits *after* PT and the §192 TDS projection is unaffected. It is income-independent, so it does not touch any wage base. `compute()`'s return shape is unchanged — `engine.js` already iterates both arrays.

---

## 4. Persistence (Prisma sketch)

`PayRunLine` currently carries `pt`, `pfEmployee`, `pfEmployer`, `esiEmployee`, `esiEmployer`, `tds`. Add two LWF columns mirroring the PF pair:

```prisma
model PayRunLine {
  // … existing statutory columns (pt, pfEmployee, pfEmployer, esiEmployee, esiEmployer, tds) …
  lwfEmployee   Decimal? @db.Decimal(15, 2)  // LWF employee share (period-incident; null in non-deduction months)
  lwfEmployer   Decimal? @db.Decimal(15, 2)  // LWF employer share
}
```

- The mapper that turns `employeeDeductions[]`/`employerContributions[]` into `PayRunLine` columns (the same one that maps `PT`→`pt`, `EPF`→`pfEmployee`, `EPF_ER`→`pfEmployer`) gets two cases: `LWF`→`lwfEmployee`, `LWF_ER`→`lwfEmployer`. The full breakdown also persists as `PayRunLineComponent` rows of `componentCode: 'LWF'` (category `STATUTORY_DEDUCTION`) and `'LWF_ER'` (category `EMPLOYER_COST`) — **no new component model**, the existing `PayRunLineComponent` (schema line 7760) already carries arbitrary statutory codes with `isStatutory`.
- `StatutoryRegistration` (line 7433): one row `kind: LWF`, `stateCode`, `number` = LWF board registration/establishment code, `meta: { frequency, deductionMonths }`. **Enum value already exists — no enum migration.**
- `StatutoryRemittance` (line ~7826): `kind: IN_LWF`, `taxPeriod` = the half-year/annual/month label, `amount` = Σ(EE+ER) for the period, `dueDate` per §5. **Enum value already exists.**

**Migration scope:** two nullable `Decimal` columns on `PayRunLine`. Nullable so historical runs/golden snapshots are untouched. No enum migrations (LWF / IN_LWF pre-exist).

---

## 5. Remittance & filing (`service.js`)

Add LWF to `FILING_PLAN.IN` and `amountForKind`. LWF is **not monthly-uniform** — its due date depends on the state frequency, so the plan entry carries a resolver rather than a fixed `dueDom`:

```js
// FILING_PLAN.IN — append:
{ kind: 'IN_LWF', fileKind: null, periodGranularity: 'lwf' },
```

```js
// amountForKind — add:
case 'IN_LWF': return sumDec('lwfEmployee') + sumDec('lwfEmployer');
```

```js
// remittanceDueDate — add an 'lwf' branch. Resolve the state's frequency from the
// LWF rule table for the run's state; half-yearly => 15 Jul / 15 Jan of the half
// just closed, annual => 15 Jan, monthly => 15th next month.
if (plan.periodGranularity === 'lwf') {
  return lwfDueDate(payRun);   // small helper reading labourWelfareFund.states[state].frequency
}
```

```js
// remittanceTaxPeriod — 'lwf' branch: "2026-H1" / "2026-H2" (half-yearly),
// "2026" (annual), or "2026-MM" (monthly).
```

`fileRun` is otherwise unchanged: it already finds-or-updates the remittance idempotently on `(entityId, kind, taxPeriod)`. Because LWF only *fires* in deduction months, the summed amount is `0` in non-deduction months — guard so a `0` LWF remittance row isn't written for a state/month with no incidence (skip when `amountForKind('IN_LWF') === 0`). This keeps `closeRun`'s "every due remittance exists" guard honest (no phantom ₹0 LWF row).

> **Compliance-calendar tie-in (roadmap, not this slice):** the gap analysis (line 160/177) wants a per-tenant statutory due-date dashboard; LWF's half-yearly/annual `dueDate` rows feed it for free once written. The `HR_FILING_DUE` notification template (already unused-but-present) can fan-out via `notifyHrEvent` on the LWF due date — reuse, no new notifier.

---

## 6. API + RBAC + admin config

### 6.1 No new compute API

LWF rides the existing run lifecycle — `POST /api/hr/payroll/runs/:id/compute|approve|pay|file`. No new endpoint to *calculate* LWF; it appears in the payslip snapshot and `PayRunLine`.

### 6.2 Statutory-framework read (mirror `resolveLeaveFramework` / PT inspect)

```
GET /api/hr/payroll/statutory/lwf?stateCode=MH&asOf=2026-06-30
→ 200 { stateCode, configured, frequency, deductionMonths,
        ee: 25.00, er: 75.00, mgrExclusionRupees: null, effectiveFrom: '2024-03-01' }
→ 200 { stateCode:'UP', configured:false }   // no-LWF state
```
India-only (404 for non-IN tenant, same gate as the leave-framework read). Read model resolves straight from `labourWelfareFund.states` via `resolveVersion(asOf)`. **RBAC:** any `payroll.read` role (HR_ADMIN, PAYROLL_MANAGER, FINANCE_VIEWER).

### 6.3 Registration config

```
GET/PUT /api/hr/payroll/entities/:entityId/registrations?kind=LWF
  body: { number, stateCode, effectiveFrom, meta:{ frequency, deductionMonths }, isActive }
```
Reuses the existing `StatutoryRegistration` CRUD (the one already serving `EPF`/`ESI`/`PT_STATE`/`TAN`). **RBAC:** `payroll.config.write` → HR_ADMIN / PAYROLL_ADMIN only; SoD: the registration editor cannot be a maker on the same run that files it (the existing maker-checker guard in `payrun.js:178` already enforces approver ≠ maker — LWF inherits it).

### 6.4 Per-state amount override (effective-dated, optional — slice 4)

A tenant whose board figure differs from the shipped default can override **without code change**, mirroring how PT slabs could be tenant-overridden:

```prisma
model LwfStateOverride {
  id              String   @id @default(uuid())
  businessId      String
  business        Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId        String?  // null = business-wide; set = entity-specific
  stateCode       String
  eeAmount        Decimal  @db.Decimal(9, 2)
  erAmount        Decimal  @db.Decimal(9, 2)
  frequency       String   // MONTHLY|HALF_YEARLY|ANNUAL
  deductionMonths Int[]    // [6,12] etc.
  mgrExclusionRupees Int?
  effectiveFrom   DateTime @db.Date
  effectiveTo     DateTime? @db.Date
  changedBy       String
  createdAt       DateTime @default(now())
  @@unique([businessId, entityId, stateCode, effectiveFrom])
}
```
When present and effective for `(state, asOf)`, the override supersedes the shipped table row (the service layer hands it to `computeLwf` as the resolved version — `india.js` stays pure: the *resolver* in `service.js` picks override-or-default, `computeLwf` just receives the chosen amounts). **RBAC:** `payroll.config.write`; every change writes an audit row (`writeAudit`), same as a PT/structure change.

---

## 7. UX (plain language)

### 7.1 hr-admin (`apps/hr-admin`)

- **Statutory → Labour Welfare Fund** panel (sibling of the PT panel): a per-state read-only table showing EE/ER, frequency, deduction months, and the manager-exclusion ceiling for the selected state and as-of date — driven by `GET /statutory/lwf`. A banner: *"LWF is a flat per-head contribution; amounts are set by the State Welfare Board and only deducted in the prescribed months (e.g. June & December for Maharashtra)."*
- **Entity → Registrations:** add LWF alongside EPF/ESI/PT — fields: board registration number, state, frequency (auto-filled from the table, editable), active. Validation: warn if the entity has employees in an LWF state but no active LWF registration (a soft "statutorily incomplete payslip" flag, matching the gap-analysis concern).
- **Override editor (slice 4):** "Use a custom LWF amount for this state" → EE/ER/frequency/deduction-months/effective-from, audit-logged.
- **Pay run review:** LWF shows as a statutory deduction line in the run's deduction summary; the employer LWF appears in the **employer cost** summary (alongside EPF-ER/ESI-ER). In non-deduction months the line is simply absent (with a tooltip on the LWF column header: *"deducted in Jun & Dec for this state"*).

### 7.2 ESS (`apps/ess`)

- **Payslip:** an `LWF` line under Deductions (e.g. *"Labour Welfare Fund (MH) — ₹25.00"*) only in deduction months; a "?" tooltip: *"A statutory state welfare contribution, deducted half-yearly. Your employer also contributes ₹75."* The employer share is **not** netted from pay; it shows in the optional "Employer contributions" / CTC view, never in the net-pay deduction total.
- **YTD / annual summary:** LWF EE total for the FY appears in the deduction breakdown; matches the sum of the (≤2 for half-yearly / 1 for annual / 12 for monthly) incident lines.

---

## 8. Statutory edge cases (the traps)

1. **Fires only in deduction months.** A half-yearly state's LWF must appear in **June & December payrolls only** — not spread across 6 months, not in every month. The `deductionMonths`/`fires` gate is the whole game; getting this wrong either double-charges or under-remits. (Golden: MH May = ₹0, MH June = ₹25 EE.)
2. **Mid-period joiner/leaver.** If an employee joins in August (a half-yearly MH state, deduction month = Dec), they are charged the **full half-year ₹25 in December** (LWF is flat per head per period, not pro-rated by days). A leaver who exits in October is charged in their **final settlement run if that run is in/after the deduction month**, else not at all for that half — encode the policy as: *charge the full flat amount in the first run on/after the deduction month in which the employee is active*. (Document; default = charge in the deduction-month run only.)
3. **Effective-dated amount change mid-year.** Karnataka ₹20→₹50 effective 2025: a recompute of a Dec-2024 closed period must use ₹20; Dec-2025 uses ₹50. `resolveVersion(asOf=periodEnd)` guarantees this — never `Date.now`.
4. **Sub-rupee amounts (Delhi ₹0.75/₹2.25).** Must be paise-exact — do **not** route through `rupees()` (which `Math.round`s the rupee first and would yield ₹1/₹2). Use `Math.round(r * 100)`.
5. **Managerial exclusion.** Several states exempt managerial/supervisory staff above a low wage ceiling. Needs `employee.isManagerial` (a profile/role flag) + the per-state `mgrExclusionRupees`. If the flag is unavailable, **fail-open to charging** (safer to over-collect a ₹2–₹60 welfare contribution than to under-remit and be liable) and surface a WARNING anomaly so HR can correct the role flag.
6. **No-LWF state.** Unmapped state ⇒ `configured:false`, no line, no remittance row, no error — exactly like a no-PT state (DL/UP for PT). Must not throw.
7. **State ≠ entity state.** An employee may work in a different state than the entity's registered state. LWF follows the **work state** — already handled by `sp.ptStateCode || employee.stateCode || entity.stateCode` (the same precedence PT uses); the optional `lwfStateCode` override is for the rare case LWF state ≠ PT state.
8. **Zero-incidence remittance.** Don't write a ₹0 `IN_LWF` remittance row in a non-deduction month (would pollute the compliance calendar and trip `closeRun`'s guard). Skip when the period amount is 0.
9. **Employer share is a cost, not a deduction.** `LWF_ER` must land in `employerContributions` (CTC / employer-cost), never in the employee net-pay deduction total. The engine's two-array split already enforces this; just push to the right array.
10. **Annual cap / national cap — none.** Unlike PT (₹2,500 Art. 276), LWF has **no cap**. Do not import the PT cap logic. The total is simply Σ of the (1–12) incident flat amounts.

---

## 9. Slice plan (3–5 slices)

### Slice 1 — Rule table + pure pillar + golden tests
`labourWelfareFund.states` table (all 15 states, effective-dated) + `computeLwf()` + `_internals` export in `india.js`. Golden tests in `india.golden.test.js`: MH June ₹25/₹75, MH May ₹0, KA Dec-2024 ₹20 vs Dec-2025 ₹50 (effective-dating), DL paise-exact ₹0.75/₹2.25, TN annual Dec only, GJ managerial-above-₹3,500 exempt, UP unmapped ⇒ nil. **Pure, no DB — ships value/verifiable on its own.**

### Slice 2 — `compute()` integration + persistence
The §4b LWF block in `compute()`; the `LWF`/`LWF_ER` → `lwfEmployee`/`lwfEmployer` mapper + `PayRunLineComponent` rows; the `PayRunLine.lwfEmployee/lwfEmployer` migration. Run-orchestration live test: a MH June run produces an LWF EE deduction line, an LWF_ER employer line, net reduced by ₹25 only, employer cost up ₹75.

### Slice 3 — Remittance, filing & registration
`IN_LWF` `FILING_PLAN` entry + `amountForKind` + `lwfDueDate`/`taxPeriod` resolvers; zero-incidence skip; `StatutoryRegistration` LWF CRUD wired into the entity registrations API; `GET /statutory/lwf` read endpoint. Test: a filed MH June run writes one `IN_LWF` remittance (taxPeriod `2026-H1`, due 15 Jul, amount = Σ EE+ER), and a MH May run writes none.

### Slice 4 — Admin + ESS UX
hr-admin LWF statutory panel + registration UI + "statutorily-incomplete" soft warning; ESS payslip LWF line + tooltip + YTD; the per-state `LwfStateOverride` editor (effective-dated, audited). The `HR_FILING_DUE` reminder hook on the LWF due date via `notifyHrEvent` (reuse).

### Slice 5 (optional) — Returns & registers
Per-state LWF return forms (Form A-1 etc.) generated from the remittance + member list, persisted to `StatutoryRemittance.fileUrl` (mirrors the ECR/24Q file generators in `filing/india.js`). Lower priority (gap analysis rates statutory registers "LOW/L"); deferrable.

---

## 10. What to reuse — checklist

- [x] `india.js` `professionalTax` table shape + `resolveVersion` → `labourWelfareFund` table (don't invent a new resolver).
- [x] `india.js` `compute()` two-array contract → push `LWF`/`LWF_ER` (no new engine surface).
- [x] `engine.js` deduction/contribution loops (lines 234–285) → **zero change**.
- [x] `service.js` `entityArg.stateCode` precedence (line 368) → reuse for LWF state.
- [x] `schema.prisma` `RegistrationKind.LWF` + `RemittanceKind.IN_LWF` → **already present, no enum migration**.
- [x] `service.js` `FILING_PLAN` / `fileRun` / `StatutoryRemittance` → one plan entry + one amount case.
- [x] `PayRunLineComponent` (arbitrary statutory codes) → `LWF`/`LWF_ER` rows, no new model.
- [x] `countryContext.payrollStatutory` already lists `'LWF'` → no change.
- [x] `notifyHrEvent` + `HR_FILING_DUE` template → LWF due-date reminders (reuse).
- [x] PT golden-test scaffolding in `india.golden.test.js` → LWF golden cases.

**Net new code:** ~1 rule table + 1 pure function (`computeLwf`) + 1 `compute()` block + 1 mapper case + 2 nullable columns + 1 filing-plan entry + 1 read endpoint + UX. No fork of payroll, approval, or notification engines.
