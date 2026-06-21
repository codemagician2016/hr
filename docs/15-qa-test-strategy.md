# 15 — QA & Test Strategy (Production-Grade)

> **Author:** Senior QA Lead
> **Status:** Authoritative. This document defines how *correctness is proven, not assumed* for a multi-tenant, white-label HRMS & Payroll SaaS launching in **India (IN)** and **New Zealand (NZ)**.
> **Cross-references:** `02-system-architecture.md`, `03-data-model.md`, `04-payroll-engine-design.md`, `05-compliance-india.md`, `06-compliance-newzealand.md`, `07-modules-core-hr.md`, `08-modules-time.md`, `09-modules-pay-adjacent.md`. The compliance-rule-table editor and versioning live in Super Admin (`04-payroll-engine-design.md` §10).
> **Reuse base:** Sitepresso at `/Users/kp/sitepresso` (read-only fork). Real paths cited throughout.

---

## 0. Philosophy & the non-negotiables

Payroll is a domain where a single-cent error, repeated across an employer's workforce and a tax year, becomes a statutory breach, a remediation programme, and a churned tenant. New Zealand's Holidays Act 2003 alone has produced **billions of dollars** in industry remediation because vendors shipped plausible-looking but wrong leave maths. We treat QA not as a phase but as the **load-bearing wall** of the product.

Five non-negotiables that everything else in this document serves:

1. **No payroll code merges without passing the Golden Dataset.** The golden-dataset harness (§3) is the gate. Every IN and NZ scenario has an **expected output computed to the minor unit (paise / cents)** and a human-readable provenance. A diff of even ₹0.01 / $0.01 fails the build.
2. **Compliance is data, and data is tested too.** Rule-table versions (`ComplianceRuleVersion`, `04-payroll-engine-design.md` §10) are first-class artifacts that pass a **compliance regression** (§4) before they can be `PUBLISHED`. A wrong rate published silently is the same class of incident as a wrong line of code.
3. **Determinism is testable.** The engine is content-addressed and idempotent (`04` §11). We assert determinism directly: same `inputHash` ⇒ byte-identical result and byte-identical output artifacts.
4. **Tenant isolation is proven adversarially, not assumed.** Every test layer includes a cross-tenant negative assertion. We reuse Sitepresso's hard-won isolation regression tests (which encode real production leak incidents) as the pattern.
5. **Tests describe the law, with citations.** Each golden scenario and each compliance fixture carries a `legalRef` (statute section, IRD/EPFO publication, effective date). When the law changes, the failing test *is* the changelog.

### 0.1 Definition of "proven correct"

| Claim | How we prove it (not assume it) |
|---|---|
| A pay run computes the right net | Golden dataset: expected to the cent, byte-diff gate in CI (§3) |
| A rule-table change is safe | Compliance regression replays all golden runs against old+new version, diffs deltas, requires sign-off (§4) |
| Re-running doesn't drift | Determinism property test: `compute(inputHash) == compute(inputHash)` byte-identical (§3.7) |
| Tenant A can't see tenant B | Isolation matrix test at every layer; adversarial e2e with two seeded tenants (§6.4, §9) |
| White-label branding is correct & bounded | Visual regression on the 5 fixed styles × brand color × logo; "no builder" invariants asserted (§6.3) |
| Billing entitlements gate features | Gateway-agnostic entitlement tests across Razorpay/Stripe/Paddle (§6.5) |
| Integrations behave under their real contract | Consumer-driven contract tests + recorded-cassette replays (§7) |
| A pay run for N employees finishes in budget | Load/perf harness with explicit SLOs per N (§8) |
| No injection / authz / PII leak | SAST + DAST + dependency + secret scanning + manual threat-model tests (§10) |

---

## 1. The test pyramid (shape, ratios, ownership)

We deliberately run a **wide-base pyramid with a hardened apex of domain-truth tests**. The golden dataset is technically integration-level but is treated as a first-class, blocking apex.

```
                 ┌───────────────────────────────┐
                 │  Manual exploratory & UAT      │  ~weekly, release sign-off
                 ├───────────────────────────────┤
                 │  E2E (Playwright)              │  ~120 specs   (~3–6 min)
                 │  tenancy · white-label ·       │
                 │  billing · ESS · payroll UI    │
            ┌────┴───────────────────────────────┴────┐
            │  GOLDEN DATASET (payroll truth)          │  ~400+ scenarios (IN+NZ)
            │  + COMPLIANCE REGRESSION (rule versions) │  blocking apex, ~30–90s
            ├──────────────────────────────────────────┤
            │  Contract tests (integrations)           │  ~40 pacts/cassettes
            ├──────────────────────────────────────────┤
            │  Integration (API + DB + worker)         │  ~300 specs
        ┌───┴──────────────────────────────────────────┴───┐
        │  Unit tests (calc primitives, validators,         │  ~3,000+ tests
        │  OWD function, rounding, slab lookups, Zod)        │  < 5s total
        └───────────────────────────────────────────────────┘
```

| Layer | What lives here | Tooling | Runtime budget | Owner |
|---|---|---|---|---|
| **Unit** | Component formulas, slab/bracket lookups, rounding policy, OWD function, RDP/ADP/OWP/AWE primitives, Zod schemas, money (BigInt minor) arithmetic, date/work-pattern math | Jest (backend), Vitest (frontends) — same as Sitepresso `backend/jest.config.js`, `business/vitest.config.js` | < 5 s | Eng (per-PR) |
| **Integration** | API route + DB + worker + rule-version resolution; pay-run state machine transitions; filing generation; YTD ledger commits | Jest + ephemeral Postgres (Testcontainers) + mocked Redis | < 90 s | Eng |
| **Contract** | Razorpay/Stripe/Paddle webhooks & APIs; IRD payday filing; EPFO ECR; bank-advice formats; email/SMS/WhatsApp providers | Pact (consumer-driven) + recorded cassettes | < 60 s | Eng + QA |
| **Golden dataset** | Curated IN/NZ payroll scenarios, expected-to-the-cent | Custom harness (§3) on Jest | < 90 s | **QA owns; Eng cannot edit expecteds without QA approval** |
| **Compliance regression** | Rule-version diffs, replay-all-golden-against-new-version | Custom harness (§4) | < 120 s | QA + Compliance |
| **E2E** | Cross-surface user journeys, white-label, billing, isolation | Playwright (multi-project, multi-host) | < 6 min (sharded) | QA |
| **Load/perf** | Pay-run for N employees; router/edge; concurrent pay runs | k6 (reuse `loadtest/k6-router.js` pattern) + custom pay-run harness | nightly / pre-release | QA + SRE |
| **Security** | SAST, DAST, deps, secrets, authz/tenant fuzzing | Semgrep, CodeQL, OWASP ZAP, gitleaks, npm audit/Snyk | per-PR (fast) + nightly (deep) | Security + QA |
| **Manual/UAT** | Exploratory, accessibility, compliance officer sign-off | Scripted charters + qa-portal | per-release | QA Lead |

### 1.1 Reuse map from Sitepresso

| Sitepresso asset | Real path | How we reuse it for HR |
|---|---|---|
| Backend Jest harness | `backend/jest.config.js` (testEnvironment node, `test/**/*.test.js`, ioredis mock at `test/__mocks__/ioredis.js`, 10s timeout) | Same config; add `test/hr/**` and a separate **golden** project with a higher timeout |
| Pure-unit test discipline (no DB/network/secrets) | CI note in `.github/workflows/ci.yml` `backend-tests` job | Keep unit layer pure; push DB-touching tests to the integration project with Testcontainers |
| Syntax gate (every `.js` must `node --check`) | `.github/workflows/ci.yml` `backend-syntax` job | Reuse verbatim for `backend/src/hr/**` |
| Frontend Vitest suites | `apps/platform` (46 tests), `business` (27 tests) per `CONTRIBUTING.md` | Pattern for `apps/hr` admin + employee Vitest suites |
| Pre-commit auto-runs changed suites | `CONTRIBUTING.md` §"pre-commit hook" | Extend hook to run golden dataset when `backend/src/hr/payroll/**` or rule tables change |
| **Regression-encodes-real-incident** convention | `backend/test/customerOrUser-vertical-isolation.test.js` (cites prod incident commits `baab6f4` + 2026-05-12) | Every payroll/compliance prod bug becomes a permanent golden scenario tagged with the incident id |
| Gateway-agnostic entitlement test | `backend/test/entitlements-multigateway.test.js` (SUB-001: paid access for all 3 gateways) | Reuse directly for HR plan entitlements (per-seat) |
| Tenant/cookie isolation tests | `backend/test/auth-cookie-isolation.test.js`, `customerOrUser-vertical-isolation.test.js` | Reuse the isolation harness shape for HR row-level `businessId` checks |
| Subscription/billing tests | `backend/test/subscriptionBilling.test.js` | Reuse for seat-based HR billing math |
| Load testing | `loadtest/k6-router.js`, `loadtest/k6-staging.js` (ramping VUs, cache-hit/miss counters, p95 thresholds) | Reuse router LT; add pay-run LT (§8) |
| qa-portal (issue tracking, insights, access matrix) | `apps/qa-portal/` | Reuse as the QA command centre for HR: scenario coverage, flake dashboard, release sign-off |

> **CI posture note.** Sitepresso's `.github/workflows/ci.yml` is currently `workflow_dispatch`-only ("git is a record/rollback ledger; tests run locally via the pre-commit hook"). **For the HRMS we re-enable CI as a blocking gate** (§11). Payroll correctness is too high-liability to depend solely on a local hook. The local hook stays as a fast first line; CI is the merge gate.

---

## 2. Test data strategy (the foundation everything stands on)

Garbage fixtures produce garbage confidence. We invest heavily in **deterministic, legally-annotated, reusable** fixtures.

### 2.1 Seed tenants

Two canonical tenants are seeded for every integration/e2e/load run, plus an adversary:

| Tenant | Country | Purpose | Domain (white-label) |
|---|---|---|---|
| `acme-in` | IN | Primary IN scenarios; PF+ESI+PT (MH); new+old regime employees | `payroll.acme.example` |
| `kiwi-nz` | NZ | Primary NZ scenarios; KiwiSaver, ESCT, Holidays Act, payday filing | `people.kiwi.example` |
| `adversary` | IN | **Negative tenant** — every isolation test asserts this tenant can never read/write `acme-in`/`kiwi-nz` data | `evil.example` |

Each carries plan tiers (free / professional / enterprise) so entitlement gating is exercised.

### 2.2 Money & determinism rules for fixtures

- **All money is `BigInt` minor units** (paise/cents) + `currencyCode`, matching `04` §7 and the data model. Fixtures **never** use floats. Expected values are stored as minor-unit integers and as a formatted string for human review.
- **Time is frozen.** Every scenario pins `payDate`, `periodStart`, `periodEnd`, and the system clock (libfaketime / injected `clock`). Holidays Act windows (4-week, 52-week) are deterministic only if "now" is fixed.
- **Rule version is pinned explicitly** in each scenario (e.g. `IN-FY2026-27.r1`, `NZ-FY2026-27.r1`) so a later rule edit can't silently move an expected.
- **No randomness** in golden tests. Property/fuzz tests (which *do* use randomness) live in a separate, seeded suite (§3.8) and never gate on a specific cent — they gate on invariants.

### 2.3 Fixture provenance & legal annotation

Every golden scenario file carries a header:

```jsonc
{
  "id": "NZ-HA-PUBHOL-WORKED-OWD-001",
  "country": "NZ",
  "title": "Public holiday worked, is an otherwise-working-day → 1.5x + alt day",
  "legalRef": ["Holidays Act 2003 s 46, s 50, s 56-57", "employment.govt.nz public-holidays"],
  "effectiveFrom": "2026-04-01",
  "ruleVersion": "NZ-FY2026-27.r1",
  "sourceVerifiedOn": "2026-06-22",
  "incidentRef": null,            // set to a bug id when this scenario was born from a defect
  "author": "qa-lead",
  "lastReviewedBy": "compliance"  // dual sign-off
}
```

### 2.4 PII discipline in test data

- Synthetic identities only. **No real PAN, UAN, ESIC IP, Aadhaar, IRD number, or bank account** ever enters a fixture or CI log.
- IN identifiers use the official **test/validation algorithms** (PAN regex `[A-Z]{5}[0-9]{4}[A-Z]`, valid checksum where applicable; UAN length; IFSC format) so validators are exercised without real data.
- NZ **IRD number test values** use IRD's published checksum algorithm so the validator passes structurally but the number is non-issued.
- Fixtures are scrubbed by a pre-commit secret scan (gitleaks) tuned with custom rules for PAN/IRD/Aadhaar patterns.

---

## 3. The PAYROLL GOLDEN-DATASET harness (the gate)

> **This is the single most important quality control in the product.** It is the line between "we believe the payroll is correct" and "we have proven it to the cent and will be alerted the instant it changes."

### 3.1 What it is

A curated, version-pinned, legally-annotated corpus of **end-to-end payroll scenarios**, each with:

- a fully-specified **input** (employee comp structure, attendance/leave, one-time adjustments, work pattern, prior YTD),
- a pinned **rule version**,
- an **expected output computed independently to the minor unit** — every component, every statutory line, gross, net, employer cost, YTD deltas, and the **expected `calc_explain` trace shape**,
- the **expected output artifacts' content hashes** (payslip PDF text layer, ECR/EI line, bank-advice row).

The harness executes the **real engine** (`backend/src/hr/payroll/`) on each input and asserts byte/cent equality against the expected. Any deviation fails the build and blocks merge.

### 3.2 Where the expected numbers come from (independence is the point)

A test that asserts the engine equals the engine proves nothing. Expecteds are derived **independently of the engine code path**:

1. **Hand-computed worked examples** lifted from the compliance docs (`05` §2.6/2.7/4.4/4.5/5.4; `06` §4.5, §5.4, §6.3, §9.x) — these already carry step-by-step arithmetic and citations. We transcribe them as expecteds and add the cited source.
2. **Government calculators** cross-check: IRD PAYE/KiwiSaver/student-loan calculators (NZ), Income Tax Dept calculator + EPFO/ESIC examples (IN). The calculator output and its retrieval date are stored next to the expected.
3. **A second, deliberately-separate "oracle" implementation** for the gnarliest maths (Holidays Act OWP/AWE/RDP/ADP, §192 TDS averaging, ESI period-lock): a small, dependency-free reference written by a *different engineer* from the engine author, reviewed line-by-line against the statute. The golden harness asserts **engine == oracle == hand-computed** (three-way agreement). Divergence between any two halts release.

> **Rule:** an expected value is only admitted to the golden set when **at least two independent derivations agree** and a human with the `compliance` role signs off (`lastReviewedBy`).

### 3.3 Scenario taxonomy (coverage map)

Coverage is tracked in the qa-portal (`apps/qa-portal/components/insights`). The matrix must be **complete** before GA per country.

#### IN scenarios (selected — target ~220)

| Group | Representative scenarios | Key assertion |
|---|---|---|
| **Uniform-wages 50% rule** | Basic+DA exactly 50%; below 50% with add-back; allowance-heavy CTC restructured | `WAGES_50_RULE` enforced; PF/gratuity base cascades (`05` §3) |
| **EPF/EPS/EDLI** | Wage ₹25k capped at ceiling; same on full wage; EPS cap ₹1,250; ₹15k boundary; international worker (no EPS cap) | Exact split to the rupee (`05` §4.4/4.5); EPS = 8.33% of min(wage,₹15k) |
| **ESI** | Gross ₹19,000 (in); ₹21,000 boundary (in); ₹21,001 (out); **mid-period cross-out continues to period end** | 0.75% EE / 3.25% ER; period-lock edge (`05` §5.3) |
| **Professional Tax** | MH (male/female slabs + Feb top-up); KA; TN (half-yearly); GJ; WB; employee in PT-free state | State slab + annual ₹2,500 cap (`05` §6) |
| **TDS §192** | New regime ₹18L (worked ex. A); §87A marginal-relief band ₹12.6L (worked ex. B); old-regime opt-in + HRA least-of-three; surcharge bands; nil-tax ≤ ₹12.75L; mid-year joiner projection; bonus month swing | Annual projection − YTD; §87A marginal relief exact (`05` §2) |
| **Gratuity** | 15/26 × last drawn × years; <5yr (nil); rounding of years | Formula exact |
| **Proration / LOP / arrears** | Mid-month joiner; mid-month leaver→FnF; LOP days; back-pay arrears spanning a rule-version boundary | Proration & arrear-diff traces (`04` §6) |
| **Multi-entity** | Employee transferred between group entities mid-year; PT state change | YTD continuity, PT re-slab |

#### NZ scenarios (selected — target ~200, Holidays Act is the bulk)

| Group | Representative scenarios | Key assertion |
|---|---|---|
| **PAYE** | Each bracket boundary (15,600 / 53,500 / 78,100 / 180,000); `M`, `ME`, `S`, `SH`, `ST` tax codes; secondary income; extra-pay (bonus) method | Annualised periodic method (`06` §2) |
| **KiwiSaver** | 3% pre-1-Apr-2026 vs **3.5% from 1 Apr 2026**; opt-out window; savings suspension; **16–17 yo now employer-contrib eligible**; temp opt-down approved; rate mismatch warning | Rate change pinned by `payDate` (`06` §4.1); `KS_RATE_MISMATCH` |
| **ESCT** | Each tier boundary (16,800 / 57,600 / 84,000 / 216,000); new employee (no prior-year) default | Tier by prior-year remuneration (`06` §4.4) |
| **ACC earners' levy** | Below cap; **at $156,641 cap reached mid-year** (YTD stop); rate **1.75% from 1 Apr 2026** | Cap tracking & rate (`06` §5) |
| **Student loan** | 12% above $24,128; below threshold; `SL` vs no-SL code; extra deduction | Threshold & rate (`06` §6) |
| **Minimum wage** | Derived hourly < $23.95 → `MINWAGE_FLOOR` blocker; starting-out $19.16 | Floor enforced (`06` §8) |
| **Deduction priority / net protection** | Multiple deductions hitting net-pay protection floor | Priority order (`06` §7) |
| **HOLIDAYS ACT — the flagship** | see §3.4 below | Provable to the cent |

### 3.4 Holidays Act golden scenarios (the highest-value, hardest cases)

This is where vendors fail and where our differentiation is proven. Each scenario fixes the work pattern, the 4-week and 52-week windows, and the discretionary flags.

| Scenario id | Setup | Expected behaviour |
|---|---|---|
| `NZ-HA-OWP-AWE-GREATER-001` | Salaried, steady pay → OWP > AWE | Annual holiday paid at **OWP** (greater) |
| `NZ-HA-OWP-AWE-GREATER-002` | Variable pay w/ big commission in 52wk → AWE > OWP | Paid at **AWE** (greater); commission included in gross earnings (`06` §9.2) |
| `NZ-HA-OWP-FORMULA-003` | Variable, OWP via s 8(2) `(a−b)/4`; `b` = irregular bonus flagged `owpOrdinary=false` | Formula exact to 4dp; bonus excluded from `b` correctly |
| `NZ-HA-WEEKS-NOT-DAYS-004` | Works 4 days/week (not 5); takes "1 week" annual leave | Paid **1 week = 4 days at dailyRate = weeklyRate ÷ 4**; engine must NOT treat as 5 days (`06` §9.5) |
| `NZ-HA-WEEKS-NOT-DAYS-005` | Changing work pattern mid-year (5→3 days) | Recalc "what is a week"; pattern with effective dates recorded; flagged for OWP/ADP path |
| `NZ-HA-PUBHOL-OWD-NOTWORKED-006` | Public holiday is an OWD, employee doesn't work | Paid the day at **RDP** (paid day off) |
| `NZ-HA-PUBHOL-OWD-WORKED-007` | Public holiday is an OWD, employee works 6h | **1.5× hourly (RDP-derived) × 6h** **AND** an **alternative day** accrued |
| `NZ-HA-PUBHOL-NOTOWD-WORKED-008` | Not an OWD, employee works | **1.5×** for hours worked; **no** alternative day |
| `NZ-HA-PUBHOL-NOTOWD-NOTWORKED-009` | Not an OWD, doesn't work | **Nothing** |
| `NZ-HA-MONDAYISATION-010` | Christmas Day (Fri 25 Dec 2026 — works normally) vs Boxing Day (**Sat 26 Dec → observed Mon 28 Dec**) | **One** entitlement on the OWD date only; never double (`06` §9.7) |
| `NZ-HA-ANZAC-MONDAYISED-011` | ANZAC Sat 25 Apr 2026 → observed **Mon 27 Apr** for Mon-Fri worker | Entitlement on Mon 27 Apr |
| `NZ-HA-RDP-VS-ADP-012` | Pay varies within the pay period → RDP not practicable | Engine uses **ADP** = gross52wk ÷ paid-days; denominator counts paid leave days too (`06` §9.9) |
| `NZ-HA-ADP-DENOMINATOR-013` | 52wk includes paid annual/public/sick days | Denominator includes those paid days (not just worked) |
| `NZ-HA-ALTDAY-TAKEN-014` | Alternative day taken 3 months later | Valued at **RDP for the day taken** (full day, regardless of hours) |
| `NZ-HA-ALTDAY-CASHUP-015` | Alt day not taken within 12 months → cashed up | Cash-up = RDP; invariant respected |
| `NZ-HA-CASHUP-1WEEK-016` | Employee requests cash-up of 1.5 weeks annual leave | Engine caps at **1 week per entitlement year** (`cashUpWeeksThisYear ≤ 1`) |
| `NZ-HA-8PCT-PAYG-017` | Genuine fixed-term < 12mo, written agreement → 8% PAYG | **8% of gross each pay**, shown as separate identifiable line; forbidden for permanent staff (validation) |
| `NZ-HA-8PCT-FORBIDDEN-018` | Permanent employee configured for 8% PAYG | **Validation BLOCKER** — engine refuses (`06` §9.6) |
| `NZ-HA-TERMINATION-PRE-ANNIV-019` | Leaver before 12 months | Annual-holiday value = **8% of gross since start − advances taken** |
| `NZ-HA-TERMINATION-POST-ANNIV-020` | Leaver with vested + accrued | Vested at **greater of OWP/AWE**; accrued at **8%**; never mixed (`06` §9.6 design rule) |
| `NZ-HA-SICK-BEREAVEMENT-021` | Sick day, RDP knowable | Paid at **RDP**; sick-leave balance decremented |
| `NZ-HA-OWD-CONFIDENCE-022` | Irregular roster, OWD ambiguous | OWD function returns `confidence=low`; **flagged to HR for recorded decision** (audited) |
| `NZ-HA-CLOSEDOWN-023` | Annual closedown, employee < 12mo at closedown | 8% closedown pay; nominal anniversary handling |

> **The OWD function (`06` §9.7) is the single most unit-tested function in the codebase.** It gates four different entitlements. It is tested exhaustively as a pure function (§3.6) *and* end-to-end in these golden scenarios.

### 3.5 Expected-output structure (per scenario)

```jsonc
{
  "scenarioId": "NZ-HA-PUBHOL-OWD-WORKED-007",
  "expected": {
    "currency": "NZD",
    "components": [
      { "code": "ORD_WAGES",      "amountMinor": 96000, "display": "$960.00" },
      { "code": "PUBHOL_1_5X",    "amountMinor":  9450, "display":  "$94.50",
        "trace": { "op": "FORMULA", "note": "1.5 × hourlyRate $10.50 × 6h" } },
      { "code": "ALT_DAY_ACCRUE", "weeksOrDays": "+1 alt day", "amountMinor": 0 }
    ],
    "statutory": [
      { "code": "PAYE",       "amountMinor": 18234 },
      { "code": "ACC_LEVY",   "amountMinor":  1838, "note": "1.75% to cap" },
      { "code": "KIWISAVER_EE","amountMinor": 3700, "note": "3.5% from 1 Apr 2026" },
      { "code": "KIWISAVER_ER","amountMinor": 3700 },
      { "code": "ESCT",       "amountMinor":  648, "note": "tier by prior-yr remuneration" },
      { "code": "STUDENT_LOAN","amountMinor":    0 }
    ],
    "gross":        { "amountMinor": 105450 },
    "net":          { "amountMinor":  84016 },
    "employerCost": { "amountMinor": 110798 },
    "ytdDeltas": { "PAYE": 18234, "ACC_LEVY": 1838, "KIWISAVER_ER": 3700 },
    "artifacts": {
      "payslipTextHash": "sha256:…",
      "eiLine":          { /* IRD payday-filing line, field-by-field */ },
      "bankAdviceRow":   { /* beneficiary, amount, account */ }
    }
  }
}
```

The harness asserts **every** field. Trace `note` strings are asserted for the explainability-critical lines (so the employee-facing explainer can't silently change).

### 3.6 Pure-function micro-golden (below the run level)

Before a full pay run, the primitives themselves have golden tables. These run in the unit layer (< 5s) and catch regressions earlier and with sharper localisation:

| Function | Micro-golden table |
|---|---|
| `owp(window, flags)` | 30+ rows: specified, formula, greater-of, all-irregular `b` |
| `awe(grossEarnings52w, weeksEmployed)` | <52 weeks divisor; commission inclusion |
| `rdp(day, pattern, allowances)` | constant vs variable; board/lodging inclusion |
| `adp(gross52w, paidDays)` | paid-leave days in denominator |
| `isOtherwiseWorkingDay(employee, date)` | 50+ rows across pattern/roster/history; confidence levels |
| `mondayise(holiday, year, pattern)` | every 2026 public holiday × Sat/Sun fall |
| `paye(annualisedIncome, code, freq)` | every bracket boundary ± $1 |
| `esctTier(priorYearRemuneration)` | every tier boundary ± $1 |
| `tds192(projectedAnnual, ytdPaid, regime)` | §87A marginal band, surcharge bands |
| `epfSplit(pfWages, ceilingMode)` | ₹15k boundary, EPS cap ₹1,250 |
| `esiContribution(gross, periodLockState)` | ₹21,000 boundary, mid-period cross-out |
| `proRate(salary, calendarDays, paidDays, method)` | each proration method (`04` §6.1) |
| `round(amount, mode)` + `balanceRounding(components, net)` | `ROUNDING_UNBALANCED` cannot occur |

### 3.7 Determinism & idempotency assertions (built into the harness)

For every golden scenario the harness additionally asserts (mirroring `04` §11):

- **Re-compute determinism:** running `compute` twice with the same `inputHash` yields **byte-identical** result JSON and **identical artifact content hashes**.
- **Canonical-input hash stability:** reordering input arrays / key order does not change `inputHash` (canonical JSON).
- **Idempotency key respected:** a second enqueue with the same `(payRunId, inputHash)` returns the cached result, **does not recompute** (assert the compute counter didn't increment).
- **Refuse-to-clobber:** a compute against a `LOCKED` run with a different `inputHash` raises `IMMUTABLE_RUN_VIOLATION`.
- **Replay-from-snapshot (auditor view, `04` §12):** re-executing the persisted trace reproduces the locked figure to the minor unit.

### 3.8 Property-based / metamorphic tests (catch the unknown unknowns)

Golden tables prove the cases we thought of. Property tests prove **invariants** across thousands of generated inputs (fast-check / fuzzing), gating on relationships not specific cents:

| Property | Invariant |
|---|---|
| Conservation | `Σ earnings − Σ deductions − Σ statutory(EE) == net` (after balance-rounding), always |
| Monotonicity (TDS) | Higher taxable income ⇒ never lower annual tax (within a regime) |
| Non-negativity | No statutory contribution is negative; net < 0 ⇒ `NEGATIVE_NET` blocker (never silently shipped) |
| Cap respect | ACC YTD never exceeds levy-on-$156,641; EPS never exceeds 8.33% of ₹15k; PT never exceeds ₹2,500/yr |
| Metamorphic (proration) | Paying a full month == sum of two half-month proratas (within rounding tolerance, documented) |
| Metamorphic (Holidays Act) | OWP/AWE for identical inputs is order-independent of how earnings lines are entered |
| Idempotent rule pin | Same `payDate` + same rule corpus ⇒ same pinned version, always |

### 3.9 The gate (how it blocks a merge)

```
on: PR touching backend/src/hr/payroll/** OR rule-table seeds OR compliance modules
steps:
  1. npm run test:golden:in      # ~220 scenarios, fail on first cent diff (but report all)
  2. npm run test:golden:nz      # ~200 scenarios
  3. npm run test:golden:props   # property/metamorphic (seeded)
  4. assert: zero diffs, zero unreviewed expected changes
  5. if an expected value changed → require CODEOWNERS approval from @qa AND @compliance
```

- The golden runner emits a **diff report** (expected vs actual, per component, with the trace note) — not a bare pass/fail — so a failure is immediately diagnosable.
- **Expected files are CODEOWNED by QA + Compliance.** An engineer cannot "fix" a failing golden by editing the expected; that change is blocked at review.
- Output is published to the qa-portal coverage dashboard (`apps/qa-portal/components/insights/InsightsView.js` pattern).

---

## 4. Compliance regression on rule-table updates

> Rule tables are **data that behaves like code**. A wrong rate published in Super Admin is a production incident with no deploy. This pipeline makes a rule-version change as rigorously gated as a code change.

### 4.1 The trigger

A `ComplianceRuleVersion` (`04` §10) moves `DRAFT → PUBLISHED` only after passing the compliance regression. The Super Admin "Publish" button is disabled until the regression is green and dual-signed.

### 4.2 What the regression does

Given a candidate version `V_new` (e.g. `NZ-FY2026-27.r1`) vs the current `V_old`:

1. **Schema & invariant validation** of `V_new.tables` — every required table present, brackets monotonic and non-overlapping, caps positive, effective dates contiguous (no gap/overlap with neighbours), currency correct.
2. **Replay every relevant golden scenario** under **both** `V_old` and `V_new`, producing a **delta report** per scenario: which components/statutory lines changed and by how much.
3. **Expected-delta assertions.** The version's changelog declares the *intended* deltas (e.g. "KiwiSaver 3% → 3.5%, ACC 1.67% → 1.75%, min wage → $23.95"). The regression asserts that **only the declared lines moved** and **everything else is byte-identical**. An *unexpected* delta (e.g. PAYE changed when only KiwiSaver was meant to) is a **BLOCKER**.
4. **Boundary re-derivation.** For each changed rate/threshold, the harness regenerates the boundary micro-golden (§3.6) from the new table and requires fresh dual sign-off on the new expecteds.
5. **Effective-date pinning test.** Assert a run paying **28 Mar 2026** pins `V_old` and one paying **4 Apr 2026** pins `V_new` (the canonical `04` §10 example), and that a mid-year run cannot accidentally pick a future-effective version.
6. **Correction path test.** If `V_new` is a backdated **correction** (`correction` flag), assert affected *already-locked* runs are surfaced for **compensating runs** and are **never silently recomputed** (`04` §10).

### 4.3 The publish gate (state machine)

```
DRAFT
  │  edit tables in Super Admin
  ▼
VALIDATED        ── schema/invariant checks pass
  │  run compliance regression (replay all golden, diff)
  ▼
REGRESSION_GREEN ── only declared deltas; zero unexpected drift
  │  dual sign-off: Compliance officer + QA Lead (4-eyes)
  ▼
PUBLISHED        ── effectiveFrom armed; pinnable by runs
  │
  ▼
SUPERSEDED       ── when a later version covers the same range
```

A `DRAFT` that fails any step cannot advance. Publishing is **irreversible except by issuing a new version** (audit-preserving), reusing the immutable `PricingAuditLog` pattern (`backend/prisma/schema.prisma`, cited in `04` §10).

### 4.4 The annual rate-roll drill (rehearsed before each tax year)

Both markets roll on **1 April**. Each February we run a **rate-roll rehearsal** in staging:

1. Author next-year version from verified sources (with `sourceVerifiedOn` and citations).
2. Run compliance regression; eyeball the delta report against the published budget changes.
3. Cut a **cross-year pay run** (period straddling 31 Mar / 1 Apr) and assert correct version pinning per `payDate`.
4. Compliance officer signs the "ready for 1 April" checklist.

This is how "no code deploy to roll the year" (`04` §10) stays **true and proven**, not aspirational.

### 4.5 Known 2026 rate roll (the first one we'll execute) — verified

| Item | Old | New (from **1 Apr 2026**) | Verified source |
|---|---|---|---|
| NZ adult minimum wage | $23.50 | **$23.95/hr** | employment.govt.nz / MBIE (2026) |
| NZ starting-out/training | $18.80 | **$19.16/hr** | employment.govt.nz (2026) |
| KiwiSaver default min (EE & ER) | 3% | **3.5%** (→ 4% in 2028) | ird.govt.nz KiwiSaver changes |
| KiwiSaver 16–17 yo employer contrib | not eligible | **eligible** | ird.govt.nz |
| ACC earners' levy | 1.67% | **1.75%** on first **$156,641** | ird.govt.nz / calculate.co.nz |
| IN — Labour Codes live | — | **live 21 Nov 2025**; Basic+DA ≥ 50% | salarybox.in (2026) |
| IN — EPF | 12% EE + 12% ER; EPS 8.33% capped at ₹15k wage | unchanged 2026 | epfindia.gov.in / salarybox.in |
| IN — ESI | 0.75% EE + 3.25% ER, gross ≤ ₹21,000 | unchanged 2026 | cleartax.in (2026) |
| IN — new regime §87A nil up to ₹12L taxable; std deduction ₹75k (₹12.75L gross zero-tax) | — | unchanged FY2026-27 | incometax.gov.in / cleartax.in |

> These figures are transcribed into the rule-table seeds **and** the golden expecteds, each tagged `sourceVerifiedOn: 2026-06-22`. The watch item **Form 16 → "Form 130/138" rename under the Income Tax Act 2025** is handled as a *data* swap in `filingForms` (`04` §10) with its own form-layout golden, so no engine change is needed if/when it lands.

---

## 5. Integration & API-layer testing

The engine's correctness (§3) is necessary but not sufficient — it must be wired correctly through the API, the state machine, the worker, and the DB.

### 5.1 Pay-run state machine tests

Drive the full lifecycle (`04` §5, §15) and assert **every guard**:

```
DRAFT → INPUTS_OPEN → INPUTS_LOCKED → COMPUTED → VALIDATED → APPROVED → LOCKED
      → DISBURSEMENT_READY → PUBLISHED → FILED → CLOSED
```

| Test | Assertion |
|---|---|
| Lock inputs | snapshot taken, `inputHash` computed, rule version pinned at `INPUTS_LOCKED` |
| Compute on un-locked inputs | rejected |
| Approve by preparer (same user) | rejected — **4-eyes** (`PAYROLL_APPROVER` ≠ `PAYROLL_PREPARER`) |
| Validate with a blocker present | cannot advance to `APPROVED` |
| Validate with only warnings, acknowledged | advances |
| Lock | YTD committed in **one transaction**; payslip numbers allocated atomically (assert no half-commit under simulated crash) |
| Lock then recompute with changed inputs | `IMMUTABLE_RUN_VIOLATION` |
| Reverse | spawns a **compensating** run, original stays immutable |
| FnF | leaver routed to FnF run, not regular |
| Publish | white-labelled payslips appear in ESS; notifications fired |
| File (NZ) | EI dataset generated; **2-working-day** payday clock armed |
| File (IN) | ECR/ESIC/24Q artifacts; due-date clocks (PF/ESI 15th, TDS 7th) armed |

### 5.2 Validation/anomaly engine tests

Every code in the anomaly catalog (`04` §14) has a positive (fires) and negative (doesn't fire) integration test:

`NEGATIVE_NET`, `MISSING_BANK`, `MISSING_STAT_ID`, `WAGES_50_RULE`, `IN_ESI_BASE_CHANGE`, `PF_CEILING_DRIFT`, `TDS_SWING`, `NET_PAY_SWING`, `NEW_JOINER_FULL_MONTH`, `LEAVER_NOT_FNF`, `MINWAGE_FLOOR`, `KS_RATE_MISMATCH`, `DUP_PAYMENT`, `RULE_VERSION_DRIFT`, `ROUNDING_UNBALANCED`.

Each asserts **severity** (BLOCKER vs WARNING) and that BLOCKERs actually block the transition and WARNINGs require an acknowledgement audit row.

### 5.3 YTD ledger & idempotency (DB-level)

- YTD deltas commit **once** at LOCK (assert no double-apply on re-publish or re-file).
- Simulated mid-transaction crash → atomic rollback, **no half-committed YTD** (Testcontainers Postgres, kill the transaction).
- Payslip/run sequence counters are gap-free and collision-free under concurrency (reuse the `InvoiceCounter { series, lastValue }` atomic pattern cited in `04` §11).

### 5.4 Multi-tenant isolation at the data layer

Every HR API route is `businessId`-scoped (`requireBusiness`/`requireVertical`, `backend/src/core/middleware/`). Integration tests assert: a request authenticated as `adversary` returns **404/403** for `acme-in`/`kiwi-nz` resources — payslips, runs, employees, artifacts, explain traces. This reuses the isolation-test shape from `backend/test/customerOrUser-vertical-isolation.test.js` and `auth-cookie-isolation.test.js`.

### 5.5 Test infrastructure

- **Postgres:** ephemeral per-suite via Testcontainers; `prisma migrate deploy` then seed (§2.1). Schema validated with `prisma validate` in CI (Sitepresso already does this for chat in `ci.yml`).
- **Redis:** mocked at the unit layer (reuse `backend/test/__mocks__/ioredis.js`); real (Testcontainers) for worker/queue integration.
- **Worker:** the `payroll-worker` (pattern from `backend/src/scheduler-worker.js`, cited `04` §16) is driven in-process for deterministic compute tests.

---

## 6. End-to-end (E2E) testing across surfaces

Tooling: **Playwright**, multi-project (one per surface), multi-host (the four domains). Seeded tenants from §2.1. Sharded in CI.

### 6.1 The four surfaces under test

| Surface | Host | Critical journeys |
|---|---|---|
| Marketing + Onboarding | `hr.com` | Sign-up → guided company-setup wizard → first employee → first pay group |
| Super Admin | `admin.hr.com` | Create tenant, set plan/seats/promo, **publish a rule-table version** (gated by §4), impersonate, audit |
| Tenant Admin (HR console) | `app.hr.com` | Configure components, run a pay cycle end-to-end, approve (4-eyes), publish payslips, generate filings |
| Employee Self-Service (white-label) | `tenant.com` / `tenant.hr.com` | View payslip + explainer, request leave, view Holidays-Act balances in **weeks** |

### 6.2 The flagship E2E: a full pay cycle (per country)

A single spec drives the entire `04` §15 worked flow against the real stack:

**IN monthly:** create run → import attendance → add joiners (proration) → flag leaver (FnF) → lock inputs → compute → validate (ack a `TDS_SWING`) → approve as a *different* user → lock → generate HDFC NEFT CSV → publish payslips → assert ESS shows the bilingual explainer "EPF 12% of ₹50,000 = ₹6,000" → generate ECR/24Q → assert due-date clocks. **Asserts the published net equals the golden expected** (the e2e and golden share fixtures).

**NZ fortnightly:** waged hours × rate → Holidays-Act public-holiday-worked case → KiwiSaver 3.5% → ESCT → ACC to cap → student loan → payday-filing EI within 2 working days → ESS shows leave balances **in weeks**.

### 6.3 White-label / branding invariants ("configure, not build")

The CORE PRINCIPLE — *pre-built system, not a builder* — is enforced by tests, not just by code:

| Invariant | Test |
|---|---|
| Branding limited to logo + **one** brand color + **one of 5 fixed styles** + bound domain | Visual-regression matrix: 5 styles × {brand color A,B} × {logo present/absent}; pixel-diff baseline per combination |
| **No page/form/layout builder exists** | Negative test: no builder routes/components reachable in `apps/hr`; the deleted Sitepresso builder surfaces (`apps/{web,shop,booking}`) are absent from the HR build |
| Brand bleed isolation | Tenant A's color/logo never render on Tenant B's ESS (host-keyed theming via `packages/theme-engine`, slimmed to 5 styles per project brief) |
| Custom domain + SSL | `tenant.com` resolves to the right tenant's ESS with valid cert (reuse Cloudflare-for-SaaS custom-hostname flow; Sitepresso `.github/workflows/cloudflare-custom-hostname.yml`) |
| Payslip PDF branding | Generated payslip carries the tenant logo + brand color + chosen style; content hash stable (ties to golden artifact hash, §3.5) |

### 6.4 Tenancy & routing E2E

- Tenant resolution at the edge (reuse `apps/router`): the right `businessId` is resolved from host; an unknown host 404s; an adversary host cannot reach another tenant's data (end-to-end repeat of §5.4 through the real router).
- Impersonation (Super Admin → tenant) is **audited**, **scoped**, and **time-boxed**; the impersonation banner is present; the audit row exists.

### 6.5 Billing & entitlements E2E

- Per-seat plan: adding/removing employees changes the seat count and the invoice math (reuse `backend/test/subscriptionBilling.test.js`).
- **Gateway routing:** IN tenant → **Razorpay**, NZ tenant → **Stripe**, RoW → **Paddle**. Feature flags by plan gate HR modules. We reuse the **gateway-agnostic** entitlement guarantee proven by `backend/test/entitlements-multigateway.test.js` (regression SUB-001) — a paid subscriber on *any* gateway gets features; a lapsed one is gated.
- Promo codes apply correctly; downgrade revokes the right feature flags at period end.
- **Dunning/grace:** a failed renewal moves to grace then restricts — assert payroll *read* (statutory record access) is preserved even when *new runs* are restricted (we must never lock an employer out of their own legally-required records).

### 6.6 Accessibility & i18n

- WCAG 2.1 AA automated pass (axe-core) on every surface; manual screen-reader pass on ESS payslip per release.
- i18n: en/hi (IN) renders correctly; the explainer strings are localised (`backend/src/i18n/translator.js`, cited `04` §12); no untranslated keys; RTL not required for launch markets.

---

## 7. Contract testing for integrations

External systems break in production in ways unit tests can't see. We use **consumer-driven contract tests (Pact)** for request/response shape + **recorded cassettes** for replaying real provider responses, and we run **sandbox smoke tests** against provider test environments on a schedule.

| Integration | Contract test | Cassette / sandbox |
|---|---|---|
| **Razorpay** (IN billing) | Pact: subscription/webhook payloads | Replay recorded webhook events; **idempotency**: duplicate `RazorpayWebhookEvent` id is a no-op (reuse Sitepresso webhook-ledger pattern, `schema.prisma:1622–1690` cited in `04` §11) |
| **Stripe** (NZ billing) | Pact: subscription, invoice, webhook | `StripeWebhookEvent` dedup; signature verification negative test |
| **Paddle** (RoW billing) | Pact | `PaddleWebhookEvent` dedup; reuse Sitepresso Paddle security tests (`PADDLE_SECURITY_REVIEW.md`) |
| **IRD payday filing** (NZ) | Contract on the **EI dataset field set** (`06` §3.2) — every field, type, format | Validate generated EI against IRD schema; assert 2-working-day window logic; sandbox submission smoke (gw test env) |
| **EPFO ECR** (IN) | Contract on the ECR text layout | Byte-level fixture of a known-good ECR; round-trip |
| **ESIC contribution file** (IN) | Contract on file layout | Fixture round-trip |
| **Form 24Q (eTDS, FVU)** (IN) | Contract on the 24Q structure; **Form 16/130 layout swap** is data | FVU-validity check on generated file |
| **Bank advice** (NEFT/RTGS CSV per bank; NZ bank batch) | Contract per bank template (HDFC/ICICI/SBI…) — templates are **data**, so onboarding a bank is a new fixture, not code | Byte-level golden per template |
| **Email / SMS / WhatsApp** (notifications) | Pact on provider send API | Sandbox send; reuse Sitepresso `backend/test/sms.test.js` pattern |
| **Cloudflare-for-SaaS** (custom domains/SSL) | Contract on custom-hostname API | Reuse `.github/workflows/cloudflare-custom-hostname.yml` |
| **OpenProvider** (domain) | Contract | Reuse Sitepresso `OPENPROVIDER_HANDOVER.md` integration |

> **Provider drift alarm.** A nightly job runs the contract suite against each provider's **live sandbox**. A schema drift (e.g. IRD adds an EI field) fails the nightly and files a qa-portal issue **before** it breaks a real filing.

---

## 8. Performance & load testing

Tooling: **k6** (reuse `loadtest/k6-router.js`, `loadtest/k6-staging.js` — ramping-VUs, cache hit/miss counters, p95 thresholds) for HTTP surfaces; a **custom pay-run harness** for the compute-bound path.

### 8.1 The pay-run-for-N harness (the headline perf test)

The decisive payroll perf question: **how long to compute, validate, lock, and generate artifacts for a pay group of N employees?** Run for N ∈ {100, 1k, 5k, 10k, 50k}.

| Stage | What we measure | SLO (target, p95) |
|---|---|---|
| Compute (engine, per employee, parallelised on `payroll-worker`) | wall-clock for the whole group; per-employee p50/p95/p99; trace persistence cost | **10k employees ≤ 5 min**; linear-ish scaling, no quadratic blowups |
| Validate (anomaly suite over N) | wall-clock; per-rule cost | ≤ 60s for 10k |
| Lock (single-tx YTD commit + counter allocation) | tx duration; lock contention | ≤ 30s for 10k; no lock timeouts |
| Artifact gen (payslip PDFs, ECR/EI, bank advice) | throughput (PDFs/sec); memory | 10k payslips ≤ 5 min; bounded memory (streamed, not all-in-RAM) |
| **Concurrency** | M tenants running pay runs simultaneously (month-end thundering herd) | No cross-tenant slowdown beyond fair-share; worker autoscale behaves |

Assertions: **no memory leak** across a 50k run (heap returns to baseline); **DB connection pool** never exhausted; the compute is **CPU-bound and shardable** (the harness verifies adding workers reduces wall-clock).

### 8.2 Edge / HTTP load (reuse router LT)

- ESS payday spike: thousands of employees opening payslips within minutes of `PUBLISHED`. Reuse `k6-router.js` with per-tenant `Host` headers and Pareto-distributed tenants; assert microcache hit-rate and `p95 < 2000ms` (Sitepresso's existing threshold).
- Marketing/onboarding sign-up burst.

### 8.3 Soak & spike

- **Soak:** 8-hour steady load → no leak, no connection drift.
- **Spike:** instant 10× → graceful degradation (queue, not crash); pay-run compute jobs queue and complete, never drop.

### 8.4 Performance regression gate

Nightly perf run stores results; a **>15% p95 regression** on the pay-run-for-10k benchmark fails the nightly and files an issue. Perf budgets are version-controlled.

---

## 9. Security testing

Payroll holds the highest-sensitivity PII (salary, PAN/IRD/Aadhaar, bank, health-adjacent leave) across **multiple tenants on shared infrastructure**. Security testing is continuous, layered, and partly manual.

### 9.1 Automated (every PR / nightly)

| Class | Tool | Gate |
|---|---|---|
| SAST | Semgrep + CodeQL (HR rules: SQLi, SSRF, authz bypass, raw Prisma `$queryRaw` without param) | PR-blocking on high-severity |
| Dependency | `npm audit` + Snyk/Dependabot | PR-blocking on critical; weekly triage otherwise |
| Secret scanning | gitleaks (custom rules for PAN/IRD/Aadhaar/UAN/bank patterns) | PR-blocking |
| DAST | OWASP ZAP baseline against staging (all four surfaces) | nightly; high-severity files issue |
| Container/IaC | Trivy on images; config scan | nightly |
| Header/TLS | securityheaders + TLS scan per custom domain | nightly |

### 9.2 Tenant-isolation security tests (the crown jewels)

Beyond functional isolation (§5.4, §6.4), an adversarial suite attempts to **break** isolation:

- **IDOR sweep:** automated enumeration — `adversary` requests every `acme-in`/`kiwi-nz` resource id across every HR endpoint (runs, payslips, employees, artifacts, explain traces, filings). **Any 200 is a critical failure.**
- **JWT/cookie tampering:** alter `businessId` claim, swap signing key, replay another tenant's cookie — must reject. Reuse the `backend/test/auth-cookie-isolation.test.js` and `generateToken.js` test harness.
- **Cross-vertical/cross-cookie leak:** the exact class of incident encoded in `customerOrUser-vertical-isolation.test.js` (two real 2026-05-12 prod leaks) — port the assertions to HR (employee cookie must never surface HR-admin data and vice-versa).
- **Impersonation abuse:** a Super Admin impersonation cannot exceed scope, cannot be silent (always audited), cannot persist past time-box.
- **Row-level enforcement fuzz:** generate random `businessId` mismatches at the Prisma layer; the `requireBusiness` middleware must filter every read/write.

### 9.3 AuthZ / RBAC matrix

Every HR role × every action is enumerated in an **access matrix** (reuse the qa-portal `AccessMatrix.js` concept) and tested: `PAYROLL_PREPARER` cannot approve; `PAYROLL_APPROVER` cannot also prepare-and-approve the same run (4-eyes); auditor is read-only; an employee can read **only their own** payslip/explain (the `explain/:employeeId` route's self-scope, `04` §16).

### 9.4 Data protection

- **PII at rest/in transit:** encryption asserted; field-level handling of bank/statutory IDs.
- **Right-to-erasure vs statutory retention conflict:** test that erasure honours legal **retention** (IN digital wage/attendance registers + payslips; **NZ 7-year** wage/time records, `04` §12) — erasure of a still-retained payroll record is **refused with a lawful-basis reason**, not silently dropped. Reuse Sitepresso account-deletion lifecycle tests (`backend/test/accountDeletionLifecycle.test.js`, `accountDeletionCancel.test.js`).
- **Audit-log immutability:** the append-only payroll audit (`04` §12) cannot be edited/deleted via any API; tampering attempt is itself audited.

### 9.5 Manual / periodic

- **Threat-model review** per major feature; **penetration test** before GA and annually (external).
- **Compliance-officer sign-off** that statutory outputs (payslip mandatory fields, ECR, EI) meet legal content requirements — a *human* gate, recorded in qa-portal.

---

## 10. Manual, exploratory & UAT

Automation proves the known; humans find the rest.

- **Exploratory charters** per release (timeboxed, qa-portal-tracked): "break the pay-run state machine," "find a Holidays-Act edge we didn't encode," "abuse the onboarding wizard."
- **Compliance UAT:** an IN payroll professional and an NZ payroll professional run a real-shaped cycle each release and sign off. Their findings become **new golden scenarios** (the §0 convention: every bug becomes a permanent test).
- **White-label UAT:** verify the 5 styles, brand color, logo, and a real custom domain end-to-end on staging.
- **Accessibility manual pass** on ESS (screen reader, keyboard-only).

---

## 11. CI quality gates (the merge contract)

> We **re-enable CI as a blocking gate** for the HRMS (departing from Sitepresso's dispatch-only posture, `ci.yml`), because payroll liability demands it. The local pre-commit hook (`CONTRIBUTING.md`) remains the fast first line.

### 11.1 Pipeline (on every PR)

```
PR opened/updated
├── lint + typecheck (eslint, tsc --noEmit)                          [blocking]
├── syntax gate: node --check on all backend/src/hr/**.js            [blocking]  (reuse ci.yml backend-syntax)
├── unit (Jest backend + Vitest apps/hr, business, platform)         [blocking]  < 5s
├── prisma validate (HR schema)                                      [blocking]  (reuse ci.yml chat-v2 pattern)
├── integration (Testcontainers Postgres + worker)                   [blocking]  < 90s
├── contract (Pact + cassettes)                                      [blocking]  < 60s
├── IF payroll/compliance touched:
│     └── GOLDEN DATASET (IN + NZ + props)                           [blocking]  < 90s   ← the gate
│     └── COMPLIANCE REGRESSION (if rule tables touched)             [blocking]  < 120s
├── SAST (Semgrep/CodeQL) + secrets (gitleaks) + deps (audit)        [blocking on high/critical]
├── E2E smoke (Playwright, critical journeys, sharded)               [blocking]  < 6min
└── coverage report (informational pre-GA; enforced post-GA)
```

### 11.2 Coverage & thresholds

Sitepresso's `jest.config.js` notes *"no coverage gate yet — bootstrapping."* For the HRMS we **enforce coverage where it matters**:

| Area | Threshold |
|---|---|
| `backend/src/hr/payroll/**` (engine) | **100% line + branch** — non-negotiable for the calc core |
| Compliance modules (IN/NZ) | **100%** |
| OWD / Holidays-Act primitives | **100% branch** (it gates four entitlements) |
| Other HR backend | ≥ 85% line |
| Frontends (`apps/hr`) | ≥ 70% line; critical flows covered by E2E |

Coverage on the calc core is a **blocking gate**, not a report. A new branch in payroll without a test fails CI.

### 11.3 Merge-protection rules

- All blocking checks green.
- **CODEOWNERS:** changes to golden expecteds or rule-table seeds require **@qa AND @compliance** approval. Engine changes require @payroll-eng.
- **No expected-value edits without a paired law/source citation** in the PR description (enforced by a PR-template check).
- Flaky-test quarantine: a test that flakes is quarantined (still runs, doesn't block) and filed in qa-portal; quarantine has an SLA — chronic flakes are fixed or deleted, never ignored.

### 11.4 Nightly / scheduled

- Deep DAST (ZAP full), perf (pay-run-for-N + soak), provider-sandbox contract drift, full E2E matrix (all surfaces × IN/NZ), full golden + property fuzz with a larger seed budget.
- **Pre-release:** pen-test (before GA/annual), compliance-officer sign-off, accessibility manual, white-label UAT, rate-roll rehearsal (Feb, §4.4).

### 11.5 Release gate (Definition of Done for a release)

A release ships only when: all CI green on `main`; golden + compliance regression green; perf within budget; no open critical/high security issue; compliance-officer sign-off recorded; E2E full matrix green; coverage thresholds met; rate-roll rehearsal done if a tax-year boundary is near.

---

## 12. Observability of correctness in production (the last line)

Tests gate pre-merge; production must keep proving correctness:

- **Continuous anomaly telemetry:** the §14 validation engine's BLOCKER/WARNING rates are dashboards; a spike (e.g. `TDS_SWING` across many tenants) signals a possible rule/engine defect.
- **Filing acceptance monitoring:** IRD payday-filing acceptances/rejections and EPFO/ESIC challan acceptances are tracked; a rejection pattern files an incident.
- **Replay audits in prod:** sampled locked runs are re-replayed from snapshot (auditor view, `04` §12) on a schedule; any non-reproduction is a sev-1.
- **Per-tenant net-pay drift:** trailing-average net-pay monitors per tenant (`NET_PAY_SWING`) catch silent regressions a deploy might introduce.
- **Incident → golden loop:** every production payroll/compliance incident is reproduced as a **permanent golden scenario** before the fix merges (the §0 / Sitepresso `customerOrUser-vertical-isolation.test.js` convention), tagged with the incident id. The golden set only grows; correctness only ratchets up.

---

## 13. Sources (verified June 2026)

- NZ minimum wage $23.95 / starting-out $19.16 from 1 Apr 2026: employment.govt.nz "Minimum wage is increasing on 1 April 2026"; MBIE "Minimum wage set for 2026"; business.govt.nz.
- KiwiSaver 3% → **3.5%** (→4% 2028), 16–17 yo employer-contrib eligibility, temp opt-down: ird.govt.nz KiwiSaver changes.
- ACC earners' levy **1.75%** on first **$156,641** (2026/27); PAYE & ESCT brackets; student-loan threshold **$24,128**: calculate.co.nz nz-tax-rates / nz-esct-rates; ird.govt.nz.
- IN new tax regime default; **§87A nil up to ₹12L taxable, std deduction ₹75k (₹12.75L gross zero-tax)**: incometax.gov.in (AY 2026-27); cleartax.in income-tax-slabs / 87A.
- IN EPF 12%+12% (EPS 8.33% capped at ₹15k wage), **ESI 0.75%+3.25% on gross ≤ ₹21,000**: epfindia.gov.in; cleartax.in/s/esi-rate; salarybox.in (2026).
- IN **Labour Codes live 21 Nov 2025**, Basic+DA ≥ 50% uniform wages, mandatory digital registers/payslips: salarybox.in statutory-compliance-2026.
- Holidays Act 2003 (OWP/AWE/RDP/ADP, weeks-not-days, mondayisation, OWD, 8% PAYG): legislation.govt.nz Holidays Act 2003; employment.govt.nz calculating-holiday-and-leave-pay; ird.govt.nz payday-filing — as compiled and cited in `06-compliance-newzealand.md` §0 and §9.
- Reuse anchors are real Sitepresso paths verified in-repo (June 2026): `backend/jest.config.js`, `backend/test/*`, `.github/workflows/ci.yml`, `loadtest/k6-router.js`, `apps/qa-portal/`, `CONTRIBUTING.md`.
