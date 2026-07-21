# Feature 43 — Multi-state statutory completeness (PT all-India, LWF, silent-gap guard)

Closes the "multi-state presence" compliance gap so a company with offices in ANY Indian state
computes correctly, jurisdiction resolved per employee from their WORK LOCATION (Feature 42).

## 1. Professional Tax — full coverage (22 levying jurisdictions)

Added 9 states to the effective-dated in-code rule tables (slabs verified 2026-07-20 against the
taxguru.in state-wise table cross-checked with the greytHR levy list; all bounded by the Art. 276
₹2,500/yr cap, asserted by a sweep test over every state):

| State | Shape | Notes |
|---|---|---|
| Chhattisgarh (CG) | annual slabs → monthly bands | every band divides by 12 exactly; max ₹2,400/yr |
| Punjab (PB) | flat | State Development Tax 2018: ₹200/mo above the ₹2.5L/yr proxy threshold |
| Sikkim (SK) | monthly slabs | max ₹200/mo |
| Tripura (TR) | monthly slabs | 2018 revision; max ₹208/mo |
| Mizoram (MZ) | monthly slabs | max ₹208/mo |
| Nagaland (NL) | monthly slabs | max ₹208/mo |
| Manipur (MN) | annual slabs → monthly + Feb true-up | e.g. ₹2,000/yr = 166×11 + 174 |
| Meghalaya (ML) | annual slabs → monthly + Feb true-up | 12 bands, each true-up sums to the exact statute annual |
| Puducherry (PY) | HALF-YEARLY (TN-style) | max ₹1,250/half-year |

Previously covered: MH, KA, GJ, TN, WB, TS, AP, MP, OR, AS, KL, BR, JH.

## 2. The silent-gap guard

`rules.professionalTax.noPtStates` — the explicit list of jurisdictions that levy NO PT
(AN, AR, CH, DN, DD, DL, GA, HR, HP, **JK** (act never operationalised — monitored), LA, LD, RJ,
UK, UP). At pay-run compute, a work-state in NEITHER table raises a **`PT_STATE_UNMAPPED` WARN
anomaly** riding the existing anomaly pipeline (persisted to the run's errorJson, visible in the
payroll console) — a coverage gap can never silently under-deduct again.

## 3. LWF — Chandigarh added (16 jurisdictions)

CH follows the Punjab rules: EE ₹5/mo, ER ₹20/mo, monthly (verified via simpliance.in +
greytHR). Existing: AP, CG, DL, GA, GJ, HR, KA, KL, MH, MP, OR, PB, TN, TS, WB.

## 4. Tests + verification

`backend/src/hr/payroll/__tests__/ptStates.golden.test.js` — 55 hand-derived checks: per-state
slabs, Feb true-ups summing to exact annual statute amounts, the Art. 276 cap sweep across ALL
22 states, anomaly fires for unmapped / stays silent for no-PT / absent for configured. Existing
`india.golden.test.js` (288 assertions) and LWP goldens unchanged-green. Deployed module verified
ON the staging box (states count, CG/PY computations, live anomaly output, full golden run).

## 5. Still-open roadmap (unchanged)

DB-driven rule tables + super-admin rates editor (deploy-free slab updates); establishment
sub-codes for enterprise ESI/PF filings; per-state PT return/challan output formats.
