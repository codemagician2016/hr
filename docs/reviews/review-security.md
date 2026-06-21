# Adversarial Review — 14-security-privacy.md

**Reviewer role:** Adversarial Senior Reviewer (skeptic)
**Target:** `/Users/kp/docs/14-security-privacy.md`
**Date:** 2026-06-22
**Verdict:** needs-fixes (now corrected in place) → post-edit the doc is **solid** on factual accuracy; residual items are open questions the doc itself flags.
**Focus areas:** RBAC matrix completeness & enforcement, isolation guarantees, encryption, audit, and accuracy of India DPDP Act 2023 + DPDP Rules 2025 + NZ Privacy Act 2020 obligations and data-residency claims.

---

## 1. What I verified (with sources)

### Regulatory figures
- **DPDP Rules 2025 commencement dates.** Official Gazette publication **14 Nov 2025**; phased commencement **14 Nov 2025** (Board/commencement) → **14 Nov 2026** (consent managers) → **14 May 2027** (substantive obligations, 18 months post-notification). Sources: PIB/MeitY notification PDF; Shardul Amarchand Mangaldas; EY; India-Briefing. NOTE: a minority of secondary commentary cites the **13th** (signing date) — the binding Gazette/commencement dates are the **14th**.
- **DPDP Rule 7 (breach).** Affected principals notified *without delay*; DPB *initial intimation without delay* + *detailed report within 72 h* (extendable on Board approval). Verified against dpdpa.com Rule 7 + multiple law-firm summaries. Doc was already correct here.
- **DPDP Rule 8 (retention/erasure).** 3-year-from-last-interaction erasure applies only to specified large classes: **e-commerce ≥ 2 crore users, online gaming ≥ 50 lakh, social media ≥ 2 crore**; **48-hour pre-erasure notice** required. Verified. Doc's thresholds were correct; I made them explicit in the body note (previously only in prose).
- **DPDP penalty ₹250 crore.** Confirmed: Schedule to DPDP Act 2023, maximum for failure of reasonable security safeguards (s.8(5)). Correct.
- **DPDP cross-border (s.16).** Confirmed **negative-list/blocklist** model — opposite of GDPR adequacy; **no general data-localisation mandate**; no restricted-country list notified as of mid-2026. (This contradicted an implication in the doc — see fixes.)
- **DPDP processor/fiduciary.** Confirmed: platform = Data Processor on tenant instruction; tenant = Data Fiduciary; Fiduciary is **vicariously liable** for processor breaches; processor **cannot appoint sub-processor without authorisation**. Doc's role table was correct; I strengthened it.
- **CERT-In 2022 Directions.** Confirmed: report cyber incident **within 6 hours** of noticing; **ICT logs 180 days, stored in India**; in force since 28 Jun 2022. Correct.
- **NZ Privacy Act 2020 breach.** Confirmed: notify Commissioner + affected individuals **"as soon as practicable"** — **no statutory hour-count**; the 72 h is **OPC guidance/expectation**, not statute. Failure to notify the Commissioner is an **offence, fine up to NZD $10,000**. IPP 12 governs cross-border. Verified against legislation.govt.nz Part 6 + OPC + BreachRx.
- **NZ record retention.** Confirmed: Employment Relations Act 2000 (wages & time) + Holidays Act 2003 = **6 years**; IRD/tax (PAYE) = **7 years**. (Doc had conflated these — see fixes.)

### Sitepresso grounding (all 16 cited paths exist and claims check out)
- `crypto.js` **does** derive its AES-256-GCM key from `JWT_SECRET` via SHA-256 (lines 24–30). The doc's central §6.2 hardening argument (decouple to a KMS-backed per-tenant DEK) is factually grounded and correct.
- `generateToken.js`: `OPERATOR_COOKIE_NAME='ae_operator'`, `CUSTOMER_COOKIE_NAME='token'`, `usesSharedCookieDomain`, `buildScopedCookieName`, 15m access / 7d refresh defaults — all as claimed.
- `auth.middleware.js`: `type==='customer'` discriminator rejection at boundary (lines 141/145), cross-host `tenantBusinessId !== customer.businessId → 403` (line 245), `tokenPredatesPasswordChange`, `requirePermission`/`requireEcomPermission` — all as claimed.
- All other cited assets (`findOwned.js`, `rbac.js`, `roles.js`, `apiKey.middleware.js`, `accountDeletion.js`, `dataExport.controller.js`, `schema.prisma`, `apps/router/cloudflare-worker.js`, `index.js`, `nginx-hardening.conf`, `SECURITY.md`, `PADDLE_SECURITY_REVIEW.md`) exist.

---

## 2. What was WRONG (and is now FIXED in place)

1. **DPDP enforcement dates off by one day (×8 occurrences).** Doc said "13 Nov 2025 / 13 Nov 2026 / 13 May 2027". The Gazette/commencement dates are the **14th**. Corrected throughout §8.2, §13.1, Appendix B, with an explicit note that some commentary cites the 13th (signing date) and that the delta is immaterial to our deadlines.

2. **NZ employment-record retention wrong (7 → 6 years).** Doc attributed **7 years** to the "NZ Employment/Holidays Act". The Employment Relations Act 2000 and Holidays Act 2003 mandate **6 years**; the **7-year** figure is **IRD tax law**, not employment law. Corrected §9.2 (split into two rows: 6 yr employment / 7 yr IRD) + added a correction note + tightened the §7.3 audit-retention parenthetical that referenced "NZ 7-year record-keeping". We still standardise NZ payroll retention to 7 (longer clock envelopes both) — but the statutes are now correctly distinguished.

3. **Overstated DPDP data-localisation mandate.** §9.1 implied the `IN` zone gave "data-localisation comfort for PF/ESI/PAN data" as if DPDP required localisation. DPDP s.16 is a **negative-list** model with **no general localisation mandate**. Added an accuracy note clarifying the `IN` zone is driven by the genuinely-mandatory **CERT-In in-India logs** and **RBI payment-data localisation**, not by DPDP, and contrasting with GDPR's whitelist model.

4. **NZ 72-hour breach framing risked reading as statutory.** §8.3 / §10.2 / Appendix B said "ideally ≤ 72 h". Reframed to state the legal standard is "as soon as practicable" with **no statutory hour-count**, and that 72 h is **OPC guidance** we adopt as an internal SLA. (The CERT-In 6 h and DPDP 72 h ARE real deadlines and were left intact.)

5. **Processor liability under-stated.** Added a note in §8.1 that the Fiduciary is vicariously liable for processor breaches and that a processor cannot appoint a sub-processor without authorisation — tying §9.4's sub-processor list and the DPA flow-down to the actual statutory hook.

---

## 3. Assessment of the focus areas (post-edit)

- **RBAC matrix & enforcement:** Strong. Four enforcement layers (edge → auth → authz → data) are coherent; super-admin narrowing + time-boxed support grants + impersonation watermarking are well above the Sitepresso baseline; SoD/step-up/cooling-window directly target the salary-diversion fraud. Minor non-blocking nit (not changed): the matrix grants scoped `audit.read` variants (HR-people / Finance-payroll) that aren't yet distinct keys in the §4.2 catalogue — worth reconciling in `03-data-model.md`, flagged but not a factual error.
- **Isolation guarantees:** Excellent. Three independent overlapping mechanisms (server-derived id → mandatory Prisma extension throwing without ctx → Postgres `FORCE` RLS with non-`BYPASSRLS` role), plus the often-forgotten vectors (Redis prefixes, job ctx, object-store prefixes, logs, exports). CI property tests + IDOR suite close the loop.
- **Encryption:** Correct and well-justified. The `JWT_SECRET`-coupling finding is real (verified in source) and the envelope/per-tenant-DEK + crypto-shred design is the right fix.
- **Audit:** Append-only + hash-chain + WORM anchoring + real-vs-effective actor is appropriate for payroll forensics/repudiation defence.
- **DPDP/Privacy-Act accuracy:** Now accurate after the four corrections above.

---

## 4. Residual / open (the doc already flags these — no fix needed)
- O-3 Aadhaar storage → UIDAI/Aadhaar Act obligations beyond DPDP ("avoid by default" is the right call).
- O-7 Form 16 vs "Form 130" naming under Income Tax Act 2025 — labels only, doesn't affect retention.
- SDF designation, KMS/HSM choice, residency hosting regions — correctly deferred to the founder.

**Net:** The document is detailed, well-grounded in real Sitepresso paths, and now factually accurate on every regulatory figure/date I could verify against 2026 authoritative sources. The errors found were real but bounded (date-by-one-day, one retention-year conflation, one localisation overstatement, one breach-clock framing) and are all corrected in place.
