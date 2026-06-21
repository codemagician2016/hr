# Adversarial Review — `05-compliance-india.md` (India Statutory & Payroll Compliance)

**Reviewer role:** Adversarial Senior Reviewer (skeptic).
**Date:** 2026-06-22.
**Target:** `/Users/kp/docs/05-compliance-india.md`
**Verdict:** **needs-fixes** (one real factual error in a launch-priority state's tax table + several precision/clarity gaps; all fixed in place). The doc is otherwise unusually strong and accurate.

---

## Method

Every rate, threshold, slab, deadline and worked example was independently re-derived (Python) and/or cross-checked against authoritative 2026 sources via WebSearch/WebFetch:
- Income-tax: cleartax.in, incometax.gov.in, tax2win, canarahsbclife (87A FY25-26/26-27).
- EPF/EDLI/admin/damages: epfindia.gov.in, fintaxblog, lexology, businesstoday (14-Jun-2024 damages), business-standard (8.25% FY24-25 interest).
- ESI: tallysolutions, cleartax, futurexsolutions (2026).
- Professional Tax: cleartax.in/s/professional-tax-{maharashtra,karnataka,tamil-nadu,west-bengal}, tnswp.com GCC schedule.
- Bonus / Labour Code 50%: omnivoo, greythr, prsindia, numericaconsulting, Code on Wages §2(y).
- Gratuity / LWF: cleartax, adityabirlacapital, ksandk, ascent-hr (KA LWF amendment).
- Form renumbering (Income-tax Act 2025): caclubindia, cleartax/s/new-income-tax-forms, taxguru, scconline.

---

## What I verified as CORRECT (no change needed)

| Area | Claim in doc | Verdict |
|---|---|---|
| New-regime slabs FY25-26/26-27 | 0/5/10/15/20/25/30 at 4/8/12/16/20/24L | Correct; Budget 2026 made no change |
| Standard deduction | ₹75,000 new / ₹50,000 old | Correct |
| §87A new regime | ₹60,000 rebate, nil ≤ ₹12L taxable | Correct |
| 80CCD(2) new regime | 14% of Basic+DA (private, from FY25-26) | Correct (was 10% pre-FY25-26) |
| Worked Example A | ₹18L gross → ₹1,50,800 annual, ₹12,567/mo | Re-derived to the rupee — exact |
| Worked Example B | Taxable ₹12,65,000 → ₹67,600 (vs ₹72,540 w/o relief) | Re-derived — exact |
| EPF split | EE 12%, EPS 8.33% cap ₹1,250, EDLI 0.5% cap ₹75, admin 0.5% min ₹500, A/c22 = ₹0 | Correct, incl. the "EPS-then-balance" logic and ₹500 floor |
| EPF interest / damages | 8.25% FY24-25; damages uniform 1%/mo w.e.f. 14-Jun-2024; §7Q 12% | Correct |
| ESI | 0.75% / 3.25%, ceiling ₹21,000 (₹25,000 disability), ₹176/day EE exemption, period-latch rule | Correct |
| PT — Maharashtra | Men ₹175 (7,501–10k) / ₹200 (>10k) / ₹300 Feb; women exempt ≤₹25,000 | Correct |
| PT — Karnataka | Nil ≤₹25,000, ₹200 (₹300 Feb) >₹25,000, eff. 01-Apr-2025 | Correct |
| PT — Gujarat / West Bengal | GJ Nil ≤12k/₹200; WB 110/130/150/200, cap ₹2,500 | Correct |
| Gratuity | 15/26, 5-yr, ₹20L exempt cap, 30-day/10% | Correct |
| Bonus | Eligibility ₹21,000, calc cap max(₹7,000, MW), 8.33–20%, 8 months | Correct |
| LWF Karnataka | ₹50/₹100, threshold 50→10 w.e.f. 07-Jan-2026 | Correct |
| Labour Code 50% rule | Basic+DA ≥ 50%, exclusions>50% added back, live 21-Nov-2025 | Correct |
| Form renumbering | 16→130, 24Q→138, 26AS→168 | Correct (despite some web summaries claiming "137") |
| TDS deadlines | 7th / 30-Apr March / 24Q 31 Jul-Oct-Jan-May | Correct |

---

## ERRORS FOUND & FIXED

### 1. CRITICAL — Tamil Nadu PT slabs were STALE (§6.1)
The doc carried the **pre-revision** GCC half-yearly amounts for the lower three bands:
- ₹21,001–30,000: doc said **₹135** → correct is **₹180**
- ₹30,001–45,000: doc said **₹315** → correct is **₹425**
- ₹45,001–60,000: doc said **₹690** → correct is **₹930**

The revised Greater Chennai Corporation schedule has been effective **FY 2024-25**. The two upper bands (₹1,025 / ₹1,250) were unchanged. This is a real per-payslip error for any TN employee in those income bands — and TN is a launch-priority state. **Fixed** the table, added an effective-date column, a correction note, and golden tests **T12a/T12b** (new band + pre-revision version resolution).

### 2. Marginal-relief band upper bound overstated (§2.2)
Doc said the §87A marginal-relief band runs "₹12,00,000 → ~₹12,75,000". The true crossover (where slab tax first equals the excess-over-₹12L cap) is taxable income **₹12,70,588.24** — derived exactly: `60,000 + 0.15x > x ⇒ x < 70,588.24 ⇒ taxable < 12,70,588`. The doc also conflated **taxable** vs **gross** at this point (the ₹12,75,000 figure is the *gross* nil-tax **rebate** ceiling, not the top of the relief band). **Fixed** with the exact figure, the taxable-vs-gross clarification, and golden test **T3a**.

### 3. Illustrative tax figure wrong (§2.2)
Doc said taxable ₹12,00,100 "would jump to a tax of ~₹61,510". Correct is **₹60,015** (before cess) / **₹62,416** (with 4% cess). **Fixed.**

---

## GAPS FILLED / TIGHTENED

- **§7 form renumbering** expanded from 3 forms to the full verified mapping (16→130, 16A→131, 16B/C/D/E→132, 27D→133, 24Q→138, 26Q→140, 27Q→144, 26AS→168) in a table, with an explicit note debunking the "24Q→137" claim that appears in some secondary summaries.
- **§9 Bonus** — added the **20-employee establishment-applicability** threshold for the Payment of Bonus Act (the doc had eligibility/calc ceilings but not when the Act applies at all), with a storage flag recommendation.
- **§6.1 TN** — added remittance months (GCC Sep/Mar) and a note that non-GCC TN local bodies notify their own schedules.
- **§20 Sources** — updated to record the TN re-verification, the MH male/WB cap re-verification, and the full form-mapping cross-check.

---

## NOT CHANGED (judged correct as written, flagged here for the record)

- "Nil tax up to ₹12,75,000 gross" (§2.1) — correct: ₹12,75,000 − ₹75,000 std = ₹12,00,000 taxable = rebate nil. Distinct from the marginal-relief band; clarified rather than changed.
- WB annual cap stated as ₹2,500 — correct (statutory cap is ₹2,500 even though 12×₹200 = ₹2,400; the cap is the right number to cite).
- MH ₹175 male slab — correct current value; not a typo for ₹200.
- T12 (TN half-year ₹62,000 → ₹1,025) — still correct (60,001–75,000 band unchanged by the revision).

---

## Residual risks the founder should own (not doc errors)

1. **Minimum-wage dataset (§11)** is asserted, not enumerated — correctly out of scope for this doc, but it is the highest-maintenance liability (twice-yearly VDA per state/employment/skill/zone). Confirm the ops cadence (§19.4).
2. **Labour Code operational rules** (register formats, some thresholds) are still notifying state-by-state through 2026 — the doc correctly treats these as versioned rule rows; revisit ECR/register-format generators once central + state rules settle.
3. **TN sub-GCC local bodies** — if any launch tenant operates outside Greater Chennai Corporation, their municipal PT schedule must be seeded separately.
