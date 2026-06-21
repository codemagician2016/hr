# Adversarial Review — 06-compliance-newzealand.md

**Reviewer:** Adversarial Senior Reviewer (skeptic)
**Date:** 2026-06-22
**Target:** `/Users/kp/docs/06-compliance-newzealand.md`
**Verdict:** needs-fixes (now corrected in place) — the doc was factually strong on the headline 1-Apr-2026 numbers but carried two real errors (IETC band, employee no-notification rate/code) plus a couple of gaps. All fixed in the target file.

---

## 1. What I verified against authoritative 2026 sources (all CONFIRMED CORRECT)

| Claim in doc | Verified value | Source |
|---|---|---|
| KiwiSaver default 3% → **3.5% from 1 Apr 2026** (employee + employer min) | Correct | IRD KiwiSaver changes |
| 16–17yo **employer contributions required from 1 Apr 2026** | Correct | IRD / Lockton / MAS |
| Electable rates 3.5/4/6/8/10% from 1 Apr 2026 | Correct | IRD |
| **ACC earners' levy 1.75%** ($1.75/$100), **cap $156,641**, **max levy $2,741.22** | Correct (rate is GST-inclusive) | IRD ACC earners' levy 2026/27; NZTaxTools; Calculate.co.nz |
| **Minimum wage $23.95 adult / $19.16 starting-out & training** from 1 Apr 2026 | Correct (prior $23.50 / $18.80) | MBIE; Employment NZ |
| **PAYE brackets** 10.5/17.5/30/33/39% at 15,600 / 53,500 / 78,100 / 180,000 | Correct, **unchanged for 2026–27** | IRD; Wolters Kluwer |
| **Student loan 12%**, annual threshold **$24,128**, weekly **$464** | Correct; worked example $600→$16.32 matches IRD's own example | IRD; Calculate.co.nz |
| Student-loan fortnightly $928 / four-weekly $1,856 / monthly $2,010.67 | Internally consistent with $24,128 (÷26/÷13/÷12) | derived |
| **ESCT tiers** 10.5/17.5/30/33/39% at 16,800 / 57,600 / 84,000 / 216,000 | Correct, unchanged 2026/27 | Calculate.co.nz ESCT 2026/27; IRD |
| **Payday filing within 2 working days**; electronic mandatory if PAYE+ESCT ≥ $50k; paper filers 10 working days | Correct | IRD Payday filing |
| **PAYE/deductions payment due 20th**; large employers (PAYE+ESCT ≥ **$500k**) twice-monthly **5th & 20th** | Correct | IRD; Calculate.co.nz |
| **Sick leave 10 days/yr after 6 months, max 20 days carryover**; **bereavement 3 days** | Correct | Holidays Act 2003 s 63; Employment NZ |
| **2026 public holidays** incl. ANZAC Sat 25 Apr → **Mon 27 Apr**, Boxing Day Sat 26 Dec → **Mon 28 Dec**, Matariki **Fri 10 Jul** | All dates and Mondayisation correct | govt.nz; Te Papa; timeanddate |
| **11 national public holidays + regional anniversary** | Correct | Employment NZ; Holidays Act 2003 |
| KiwiSaver **opt-out window days 14–56**, auto-enrol age **18–64** | Correct | IRD |
| **PPL max $788.66/wk (1 Jul 2025–30 Jun 2026) → $811.05/wk from 1 Jul 2026** | Correct, $811.05 announced | IRD; Beehive; 1News (Jun 2026) |
| **Employment Leave Bill introduced 9 Mar 2026**, sick accrual **0.0385 h/standard hour, cap 160 h**, commencement **~2028** | Correct | NZ Legislation; MBIE; Employment NZ |

## 2. Errors found and FIXED in place

1. **IETC band was stale/wrong (§2.3 note).** Doc said "$10/week for $24,001–$44,000, abating 13c/$1 to $48,000, nil at $48,000." Those are **pre-July-2024** figures. Correct 2026–27: **$520/yr ($10/wk) for $24,000–$66,000, abating 13c/$1 over $66,000, nil at $70,000.** Fixed, with an explicit note flagging the superseded values. (IRD IETC page.)

2. **Employee no-notification rate and code were wrong (§2.3 table, §2.3 rules, §3.3, edge case #4).** Doc invented a tax code **"NSW"** at a **flat 45%** for employees with no IR330. Two problems: (a) **"NSW" is not a NZ tax code** (it's an Australian state — a fabrication); the real EI-return code is **ND**. (b) The **45% flat is the contractor/schedular (WT) no-notification rate**; for an **employee** the no-notification rate is **45% income tax + ACC earners' levy = 46.75% total PAYE** (IR335 Apr 2026). Fixed everywhere: replaced NSW→ND, set 46.75% PAYE-inclusive, and added an explicit "do not confuse with the contractor 45%" caveat. Kept WT row showing the contractor 45%.

3. **M tax-code definition was wrong (§2.3 table).** Doc described **M** as "annual income $24,001–$48,000 and no entitlement adjustment" — that conflates the old IETC band with the M code. **M is the standard main-job code at any income**; **ME** is the IETC-entitled variant. Fixed the M and ME rows.

## 3. Gaps filled

4. **KiwiSaver temporary rate reduction (new 1 Apr 2026)** was missing. Employees may apply to keep contributing at **3%** for **3–12 months** instead of auto-stepping to 3.5%; the employer minimum stays 3.5%. Added to the §4.1 table and an engine rule (`temporaryRateReduction { rate, expiry }`).

5. **Government (member) contribution change** was only vaguely referenced. Added: **halved to 25c/$1, max $260.72 from 1 Jul 2025**, **nil if income > $180,000**, extended to 16–17yo **from 1 Jul 2025** — and clarified it is **IRD-paid, not through payroll** (so the engine doesn't compute it). Corrected the §4.1 table row that lumped the 16–17yo government-contribution eligibility under the wrong effective date (it was 1 Jul 2025, not 1 Apr 2026).

6. **ACC rate GST-inclusivity** was unstated. Added a note that the published $1.75/$100 is GST-inclusive and is the figure deducted/stored (no separate GST handling).

## 4. Spot-checked worked-example arithmetic (all CORRECT)

- ESCT example: $2,000 × 3.5% = $70; ESCT $70 × 17.5% = $12.25; net $57.75. ✓
- ACC cap example: remaining at month 12 = 156,641 − 145,200 = $11,441 → ×1.75% = $200.22; annual total $2,741.22. ✓
- Student loan: $600 − $464 = $136 × 12% = $16.32 (matches IRD's published example). ✓
- Holidays Act Example A: OWP formula 7,240/4 = $1,810; AWE 93,600/52 = $1,800; max = $1,810. ✓
- Examples B–E (public holiday worked/not-worked, ADP sick day, 8% PAYG) all arithmetically sound.

## 5. Not changed (judged correct or out-of-scope)

- The four-rate Holidays Act framework (OWP s8 / AWE / RDP s9 / ADP s9A), greater-of-OWP/AWE for annual holidays, otherwise-working-day test, alternative-day + time-and-a-half on worked public holidays, 8%-PAYG eligibility, and the s40 termination-spanning-public-holiday rule are all consistent with the Holidays Act 2003 and Employment NZ guidance.
- Minor section-number citations (e.g. AWE "s 5", the various ss ranges) were not exhaustively cross-checked against the Act's exact numbering; the substantive definitions are correct. Low risk; flagged for a legal pass at publish time.

**Overall:** Strong, genuinely production-oriented spec. The headline 2026 numbers were accurate; the two material defects (IETC band, employee no-notification rate/code "NSW"/45%) would have caused real mis-deductions and are now fixed. Recommend a final legal review of Holidays Act section citations before go-live.
