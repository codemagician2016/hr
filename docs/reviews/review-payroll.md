# Adversarial Review — 04-payroll-engine-design.md

**Reviewer stance:** skeptic / adversarial senior reviewer.
**Date:** 2026-06-22.
**Verdict:** needs-fixes (now corrected in place — strong doc, real gaps closed).
**Target:** `/Users/kp/docs/04-payroll-engine-design.md`

---

## 1. What I verified

### Sitepresso reuse claims (READ-ONLY at `/Users/kp/sitepresso`) — all accurate
- `backend/prisma/schema.prisma` exists (6,235 lines). Cited line numbers are **exact**:
  - `PaddleWebhookEvent` @ **1622**, `StripeWebhookEvent` @ 1649, `RazorpayWebhookEvent` @ 1671 — confirmed `eventId @unique` + status machine = real exactly-once dedup-on-id pattern.
  - `InvoiceCounter { series @id, lastValue Int }` @ **1877** — exact match to the doc's atomic-counter claim.
  - `AdjustmentLedger` @ **1883** — append-only, `amountMinor Int`, `raw Json?`, `@@index([businessId, createdAt])` — exact match.
  - `PricingAuditLog` @ 2780, `BillingPurchase` @ 1792 — exist as cited.
- Middleware: `requireBusiness.js`, `requireVertical.js`, `auth.middleware.js` (with `requireRole`/`requireAnyRole`/`requirePermission`) all exist — grounds the RBAC/tenant-isolation claims.
- `backend/src/domains/fx.js`, `scheduler-worker.js`, `domains/renewalCron.js`, `i18n/translator.js`, `packages/{ui,admin-core,theme-engine}` all exist.

### Compliance figures (verified via web search, June 2026)
| Claim | Status |
|---|---|
| NZ PAYE brackets 15,600 / 53,500 / 78,100 / 180,000 (2026/27) | CONFIRMED |
| NZ ESCT brackets 16,800 / 57,600 / 84,000 / 216,000 | CONFIRMED |
| KiwiSaver default 3.5% EE+ER from 1 Apr 2026; temp opt-down 3–12 mo | CONFIRMED |
| ACC earners' levy 1.75% on first $156,641 (2026/27) | CONFIRMED |
| NZ student loan 12% above $24,128 | CONFIRMED |
| NZ adult minimum wage $23.95/hr from 1 Apr 2026 | CONFIRMED |
| IN new-regime slabs; 87A rebate ₹60,000; std deduction ₹75,000; nil ≤ ₹12L | CONFIRMED |
| EPF 12% EE; ER 3.67%+8.33%; EPS cap ₹1,250; EDLI 0.50%; admin 0.50% min ₹75; ceiling ₹15,000 (raise to ₹21k/25k ordered, not yet effective) | CONFIRMED |
| Maharashtra PT ₹200/mo + ₹300 Feb = ₹2,500/yr | CONFIRMED |
| Gratuity 15/26, ₹20L cap | CONFIRMED |

---

## 2. What was wrong / weak (and fixed in place)

### Factual errors corrected
1. **ESI base-shift over-hedged (§8.3).** Doc said the gross→Basic+DA shift's effective date was "to VERIFY." It is **confirmed effective 21 Nov 2025** (ESIC notifications 10 & 11 Dec 2025) — same date as the wages definition. Rewrote the row to state the date firmly, set `esiBaseMode effectiveFrom=2025-11-21`, downgraded the anomaly to a boundary-only WARNING.
2. **Form 16 / 24Q rename conflated (§0.8, §8.5).** Doc wrote "Form 16 → Form 130/138" as if 130 and 138 were alternative names for Form 16. They are **distinct forms**: **Form 16 → 130**, **Form 16A → 131**, **24Q → 138**, **27D → 133**, TDS-on-salary section 192 → **392**, all under the Income-tax Act 2025 effective **TY 2026-27** (FY 2025-26 still prints "Form 16"). Replaced the muddled note with a correct mapping table and pinned the effective tax year.
3. **Gratuity eligibility incomplete (§8.6).** Doc said "≥ 5 years" only. Under the Code on Social Security 2020 (live 21 Nov 2025), **fixed-term employees are eligible pro-rata after 1 year**. Added; also clarified `lastDrawnWages` now uses the Code's Basic+DA + ≥50% add-back base, and that the ₹20L cap bounds the statutory/tax-exempt amount, not voluntary pay.
4. **EPS cap presented as a rounding artifact (§8.2).** "8.33% of ₹15,000 = ₹1,250" — actually 8.33% × 15,000 = ₹1,249.50; ₹1,250 is a **hard statutory cap**, not rounding. Made the rule-table store an absolute `epsCapMinor` and apply `min(8.33%×wages, ₹1,250)` as a `CAP` trace node. Also corrected EDLI to its ₹75/mo cap and flagged that **EDLI admin charges have been ₹0 since 2017** (the doc's vague "₹500 EDLI-admin nuance" was obsolete).

### Type/architecture inconsistency corrected
5. **`BigInt` vs Sitepresso `Int` (§0.3).** Doc claimed money is `BigInt` AND that this "mirrors Sitepresso's `amountMinor Int`." Verified: Sitepresso has **zero BigInt fields** — it uses `Int` (32-bit, overflow ≈ ₹2.14 cr). For payroll YTD buckets and employer-level filing aggregates that **overflows**. Rewrote §0.3 to document this as a **deliberate divergence**: HR payroll uses Prisma/Postgres `bigint`, reusing Sitepresso's naming + rounding discipline but not its column type — and flagged it so `02-data-model` doesn't copy `Int`.

### Engine-correctness gaps closed (the primary review focus)
6. **YTD concurrency / lost-update race (NEW §11.1).** The four idempotency mechanisms make a *single* run deterministic but did **not** prevent two different runs touching the *same* employee from racing on YTD — and TDS annual-projection + NZ student-loan/ACC-cap both read-and-write YTD, so a race yields a *wrong tax figure*, not a benign duplicate. Added: per-employee `YtdLedger … FOR UPDATE` at LOCK, a `ytdVersion` read-set revalidation that forces idempotent recompute (`YTD_DRIFT` blocker), and a no-overlapping-parallel-LOCK constraint.
7. **`payDate` mutation invalidates the rule-version pin (NEW §11.2).** §4 allows editing pay calendars; §10 pins the rule version by `payDate` at INPUTS_LOCKED. Moving `payDate` across a FY boundary post-lock (e.g. 31 Mar → 1 Apr crossing every NZ 2026/27 change) silently files under the wrong year. Added a block + `PAYDATE_PIN_STALE` blocker forcing REOPEN→re-pin.
8. **`DUP_PAYMENT` checked only at VALIDATED (§5.2, §14).** Anomalies run pre-LOCK; a parallel run can LOCK in the VALIDATED→LOCK window. Added re-check of `DUP_PAYMENT` + `YTD_DRIFT` **inside the LOCK transaction**.
9. **Arrear recompute determinism (§6.3).** "Recompute past period at the new rates" was ambiguous and non-deterministic. Clarified: recompute uses the **revised compensation** but the **rule version pinned for the source period** (resolved by that period's original payDate) — a Dec-2025 arrear applies Dec-2025 PF/ESI/PT/TDS rules, not today's. Each source period carries its own `ruleVersionRef`.

### Minor tightenings
- §12 trace example "EPF 12% of ₹50,000 = ₹6,000" contradicted the heavy ₹15,000-ceiling emphasis; annotated to show both the above-ceiling (voluntary) and ceiling-restricted (₹1,800) cases.
- §0.8 "Form 24Q→138" loose framing aligned with the corrected §8.5 table.

---

## 3. Residual notes (not blocking; for the founder)
- **§15 worked example** uses rule label `IN-FY2026-27.rN` while §5.1 example uses `IN-FY2025-26.r3` — cosmetic label drift, harmless.
- **PF wage ceiling ₹15,000→₹21k/₹25k** is under a Supreme Court directive (decision ordered "within months" as of mid-2026) but **not yet effective**; doc correctly leaves `effectiveTo` open and alerts on change. Keep watching — this is the single highest-impact pending IN change.
- The doc's strongest sections are the state machine (§5), idempotency framing (§11, now hardened), explainability (§12) and the country-agnostic `ComplianceModule` seam (§9) — these are genuinely production-grade.

**Overall:** the doc was already high quality and unusually well-grounded (Sitepresso line numbers exact, compliance figures ~95% correct). The real risk was in the engine-correctness edge cases — concurrency on YTD and rule-pin staleness — which were under-specified and are now closed. Verdict after fixes: **solid**.
