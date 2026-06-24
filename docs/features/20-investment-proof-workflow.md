# Feature 20 — Investment-Proof Submission + HR Verification Workflow (India, year-end)

> **One-liner.** F15 already captures the year-start **declaration** (intent: 80C / HRA / 80D /
> home-loan interest on `StatutoryProfile`). This feature adds the year-end half: employees
> **upload proofs** (LIC/PPF/ELSS, rent receipts, home-loan interest cert), **HR verifies each
> proof** (accept / reject + verified amount + reason), and an admin-set **declaration window
> locks** per FY. After the proof deadline the TDS / IT-projection consumes **VERIFIED** amounts;
> before it, the **DECLARED / provisional** amounts (today's behaviour). This is the **Form 12BB /
> Rule 26C / §192(2D)** evidence-collection control that protects the employer from a **§201
> assessee-in-default** short-deduction liability.

---

## 1. Statutory basis (research — cite the Act, not vibes)

| Rule | What it requires | Where it lands in this feature |
|---|---|---|
| **§192(2D), Income-tax Act 1961** | The person paying salary **shall obtain** evidence/particulars of the employee's deductions/exemptions/set-offs **before** computing TDS. | The whole feature: proofs are the "evidence"; verified amounts are what TDS must use. |
| **Rule 26C, Income-tax Rules 1962** | The employee **shall furnish** the evidence of claims in **Form 12BB**. Rule 26C prescribes the *nature of evidence* per claim (below). | Proof categories + the per-claim evidence checklist (§5). |
| **Rule 26C evidence table** | HRA → **name+address+PAN of landlord** if aggregate rent > ₹1,00,000/yr + rent receipts; LTA → travel evidence; **§24(b) home-loan interest** → interest cert with lender name/address/PAN; Chapter VI-A (80C/80D/…) → the deduction evidence. | `ProofClaimType` enum + landlord-PAN gate (§7 edge cases). |
| **Form 12BB (Rule 26C(1))** | The standard return-of-particulars the employee submits to the employer. We *generate* it from the verified record (§5 ESS, §10 slice 5). | Form 12BB PDF (reuse `taxProjectionPdf` render pattern). |
| **§201(1)/(1A)** | If the employer **fails to deduct / short-deducts** (e.g. relied on an unproven declaration), it is **assessee-in-default**: liable for the tax + **1.5%/month interest** (deduction date → deposit date), plus penalty u/s 271C. | **Why** the window-lock must flip TDS to verified-only. This is the liability we are controlling. |
| **CBDT practice** | Declaration = April estimate (no proof). **Proof/verification window = Jan–Feb**; whatever is unverified by the deadline is dropped and **March TDS** is computed as if not invested. | The window model (open/close/proofDeadline) + the "verified-after-deadline" switch (§6). |

> **Net rule we implement:** *Before* the proof deadline → TDS uses the **declared** figures (provisional,
> as F15 does today, so April–Dec TDS isn't punitive). *On/after* the proof deadline (window closed) →
> TDS uses **only the HR-VERIFIED amount per claim**; anything `PENDING`/`REJECTED` counts as **₹0**.
> This is the single behavioural switch the entire feature exists to deliver.

Sources: [Rule 26C — evidence of claims u/s 192 (TaxHeal)](https://www.taxheal.com/rule-26c-evidence-of-claims-by-employee-for-tds-us-192.html) · [Form 12BB CBDT notification (TaxGuru)](https://taxguru.in/income-tax/cbdt-notifies-form-deduction-claim-salary-employees.html) · [§201 assessee-in-default penalty (finstory)](https://finstoryconsultants.com/blog/section-201-penalty-for-tds-defaults/) · [Form 12BB guide / Jan–Feb proof deadline (Tax2win)](https://tax2win.in/guide/form-12bb-investment-declaration) · [Investment declaration timeline (Groww)](https://groww.in/blog/heres-what-you-need-to-know-about-investment-declaration)

---

## 2. What already exists (AUDIT — reuse, do not fork)

Every dependency this feature needs is already built and battle-tested in the codebase. We add **one
spine table + one window table** and **wire the assembler's regime input** — nothing else is new.

| Need | Reuse this | File |
|---|---|---|
| Year-start declaration (80C/HRA/80D/24b/regime) | `StatutoryProfile.section80CDeclared`, `sec80DDeclared`, `sec80CCD1BDeclared`, `sec80TTADeclared`, `sec24BHomeLoanInterest`, `hraAnnualRentPaid`, `hraMetroCity` | `prisma/schema.prisma` `model StatutoryProfile` (L7334) |
| ESS declaration write (validates regime, zeroes-under-NEW, audit elections) | `saveDeclaration` / `getDeclaration` | `backend/src/hr/controllers/meTax.controller.js` |
| The pure TDS / IT engine (where verified vs declared is consumed) | `projectAnnualIncomeTax`, `chapterVIADeductions`, `hraExemption`, `monthlyTaxRecoverable` | `backend/src/hr/payroll/compliance/india.js` (`_internals`) |
| The read-only projection assembler that feeds the engine the declaration bag | `readDeclaration` → `buildEngineInput` → `buildTaxProjection` | `backend/src/hr/tax/projectionAssembler.js` |
| Proof file storage (S3/R2, base64 data-URL, SHA-256, 10MB+MIME guards) | `s3.uploadDataUrl`, `validateDocDataUrl`, `sha256`, `EmployeeDocument` model | `backend/src/core/lib/s3.js`, `backend/src/hr/controllers/documents.controller.js`, schema `model EmployeeDocument` (L9180) |
| HR verify pattern (accept + `verifiedAt`/`verifiedBy`) | `verifyDocument` route + controller | `documents.routes.js` L47, `documents.controller.js` |
| Per-line verdict + reason (the accept/reject + reason shape) | `ExpenseClaimLine.policyStatus` (`PolicyVerdict`) + `policyReason` + `appliedCap` | schema `model ExpenseClaimLine` (L8478) — **the closest analog** |
| Notifications fan-out (proof verified/rejected, window opening/closing) | `notifyHrEvent({ businessId, event, recipientEmail, variables })` | `backend/src/hr/integrations/notifications.js` (L283) |
| Audit trail of material changes | `StatutoryElectionHistory` append rows (already used by `saveDeclaration`) | schema `model StatutoryElectionHistory` (L7416) |
| Window-close / deadline-flip / reminders cron | `node-cron` registry | `backend/src/core/lib/scheduler.js` (`*/15`, `0 9 * * *` patterns) |
| RBAC (HR-only verify, scoped per employee, IDOR→404) | `requirePermission('canManageEmployees')` + `withEmployeeScope` | `documents.routes.js` |
| ESS self-only surface (resolve employee from session, never client) | `resolveSelfEmployee` / `requireCustomer` discipline | `meTax.routes.js`, `meTaxProjection.controller.js` |

**Critical reuse seam.** `projectionAssembler.readDeclaration(sp)` currently maps `StatutoryProfile`
fields → `sec80cGrossMinor`, `hraRentPaidMinor`, etc. That is the *only* place the projection learns
the declared numbers. We make **that one function** window-aware: after the proof deadline it reads the
**verified** amount from the new spine table instead of the declared column. Every downstream consumer
(monthly TDS run, ESS projection page, projection PDF, regime comparison) inherits the switch **for
free** — no fork, no second engine.

---

## 3. Data model (Prisma sketch — additive only)

Two new models. Neither touches existing columns; `StatutoryProfile` declaration columns stay as the
**declared** snapshot (intent), the new `InvestmentProof` rows carry the **evidence + verified** state.

```prisma
// The per-FY declaration window for a tenant. Admin (HR/Finance) sets open/close + proof deadline.
// Resolved as-of the FY; the proofDeadline is the date the TDS engine flips to verified-only.
model InvestmentDeclarationWindow {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  financialYear String   @db.VarChar(7)   // "2026-27" (matches StatutoryProfile.prevEmployerFY format)
  countryCode   String   @db.Char(2) @default("IN")
  opensAt       DateTime @db.Date          // declaration editable from
  closesAt      DateTime @db.Date          // declaration locks (no more edits/uploads after)
  proofDeadline DateTime @db.Date          // TDS flips to VERIFIED-only on/after this date (Jan–Feb)
  status        DeclarationWindowStatus @default(DRAFT) // DRAFT|OPEN|CLOSED|LOCKED
  notes         String?  @db.Text
  createdBy     String?
  updatedBy     String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  version       Int      @default(0)
  proofs        InvestmentProof[]

  @@unique([businessId, financialYear, countryCode]) // one window per FY per country
  @@index([businessId, status])
  @@index([businessId, proofDeadline])
}

// One uploaded proof for one claim line, with its verify verdict + the verified amount.
// The "declared amount" stays on StatutoryProfile; this row is the EVIDENCE + the VERIFIED truth.
model InvestmentProof {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  employeeId    String
  employee      Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  windowId      String
  window        InvestmentDeclarationWindow @relation(fields: [windowId], references: [id], onDelete: Cascade)
  financialYear String   @db.VarChar(7)

  claimType     ProofClaimType                 // SEC_80C | SEC_80D | SEC_80CCD1B | SEC_80TTA | SEC_24B_HOME_LOAN | HRA_RENT | OTHER_VIA
  subSection    String?  @db.VarChar(16)        // e.g. "LIC","PPF","ELSS","ULIP" — for the 80C bucket breakdown
  declaredAmount  Decimal @db.Decimal(15, 2)    // what the employee CLAIMS this proof supports (annual ₹)
  verifiedAmount  Decimal? @db.Decimal(15, 2)   // what HR ACCEPTS (≤ declared; capped by HR). NULL until verified.

  // The evidence file — same storage contract as EmployeeDocument (S3/R2 key + SHA-256).
  fileUrl       String   @db.Text
  fileHash      String?                          // SHA-256 of decoded bytes (server-computed, integrity anchor)
  mimeType      String?
  sizeBytes     Int?
  originalName  String?

  // HRA-only evidence (Rule 26C: landlord PAN required when annual rent > ₹1,00,000).
  landlordName  String?
  landlordPan   String?  @db.Char(10)
  rentMonthsCovered Int?                         // sanity: a 12-month rent claim needs ~12 months of receipts

  status        ProofStatus @default(PENDING)    // PENDING | ACCEPTED | REJECTED
  rejectReason  String?  @db.Text                // mandatory when REJECTED ("blurred","amount mismatch","wrong FY")
  verifiedById  String?                          // operator User id (SoD: ≠ a self-verify)
  verifiedAt    DateTime?

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime?                        // soft-delete (re-upload supersedes)
  version       Int      @default(0)

  @@index([businessId, employeeId, financialYear])
  @@index([businessId, windowId, status])
  @@index([businessId, employeeId, claimType])
}

enum DeclarationWindowStatus { DRAFT OPEN CLOSED LOCKED }
enum ProofStatus { PENDING ACCEPTED REJECTED }
enum ProofClaimType { SEC_80C SEC_80D SEC_80CCD1B SEC_80TTA SEC_24B_HOME_LOAN HRA_RENT OTHER_VIA }
```

**Why a separate `InvestmentProof` table (not columns on `StatutoryProfile`)?** A claim can have *many*
proofs (12 rent receipts, 3 LIC policies + 1 PPF for the 80C bucket); each needs its own verdict, file,
and verified amount. `StatutoryProfile` is one row per employee and holds the *declared aggregate* — we
keep it as the declared truth and let proofs aggregate up. The **`OTHER_VIA`** claim type + `subSection`
keep it extensible (matches the existing `StatutoryProfile.otherChapterVIADeclared` Json escape hatch).

**Verified aggregation rule (pure, lives in india.js or a small `proofAggregator.js`):**
`verifiedFor(claimType) = Σ verifiedAmount of ACCEPTED proofs of that claimType` (PENDING/REJECTED → 0),
then **capped at the declared aggregate** for that section so a fat-fingered verify can never *exceed*
the declaration. The statutory section cap (80C ₹1.5L etc.) is still applied by the existing engine
`chapterVIADeductions` — proofs only ever *reduce* below the declaration, never raise above it.

---

## 4. API surface + RBAC

All routes are tenant-scoped. Operator routes use `protect` + `requirePermission`; ESS routes use
`requireCustomer` + self-resolution (never a client-supplied employeeId).

### 4a. Admin — declaration window (HR/Finance; `canManagePayroll` or a new `canManageTaxWindow`)
| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/api/hr/tax-windows?fy=2026-27` | `canViewPayroll` | List/show the window for an FY (status + dates). |
| `POST` | `/api/hr/tax-windows` | `canManagePayroll` | Create/upsert a window (`fy`, `opensAt`, `closesAt`, `proofDeadline`). Guards: open ≤ close ≤ deadline; one per FY. |
| `POST` | `/api/hr/tax-windows/:id/open` | `canManagePayroll` | DRAFT→OPEN (employees can now upload). |
| `POST` | `/api/hr/tax-windows/:id/close` | `canManagePayroll` | OPEN→CLOSED (no more uploads; HR keeps verifying). |
| `POST` | `/api/hr/tax-windows/:id/lock` | `canManagePayroll` | CLOSED→LOCKED (verification frozen; verified amounts final). |

### 4b. HR — verification console (scoped per employee, IDOR→404)
| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/api/hr/proofs?fy=&status=PENDING&page=` | `canViewEmployees` | The verify queue (tenant-wide for HR ALL band; team for managers via scope). |
| `GET` | `/api/hr/employees/:employeeId/proofs?fy=` | `canViewEmployees` + `withEmployeeScope` | All proofs for one employee, grouped by claimType, declared vs Σverified. |
| `POST` | `/api/hr/employees/:employeeId/proofs/:id/accept` | `canManageEmployees` + scope | Body `{ verifiedAmount }`. Sets ACCEPTED, `verifiedAmount`, `verifiedById`, `verifiedAt`. **SoD:** operator User ≠ the proof's own employee. |
| `POST` | `/api/hr/employees/:employeeId/proofs/:id/reject` | `canManageEmployees` + scope | Body `{ rejectReason }` (**mandatory**). Sets REJECTED, reason. |
| `GET` | `/api/hr/employees/:employeeId/proofs/:id/file` | `canViewEmployees` + scope | Streamed/redirect to the proof file (SSRF-guarded to our bucket via `s3.isOurUrl`). |

### 4c. ESS — employee upload (customer session, SELF_ONLY)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/hr/me/proofs?fy=2026-27` | `requireCustomer` | The employee's proofs + the window status + per-claim declared/verified/pending rollup. |
| `POST` | `/api/hr/me/proofs` | `requireCustomer` | Upload one proof: `{ claimType, subSection?, declaredAmount, fileBase64, landlordName?, landlordPan? }`. **Gated:** window must be `OPEN`; reuses `validateDocDataUrl` (10MB, PDF/PNG/JPG) + `sha256`. |
| `DELETE` | `/api/hr/me/proofs/:id` | `requireCustomer` | Withdraw an own **PENDING** proof while window OPEN (soft-delete; can't delete an ACCEPTED/REJECTED one). |
| `GET` | `/api/hr/me/proofs/form12bb.pdf?fy=` | `requireCustomer` | Generate **Form 12BB** from the verified record (reuse `taxProjectionPdf` render style). |

**RBAC notes.** Verify is **`canManageEmployees`** (the same gate the existing `verifyDocument` uses).
Window admin is **`canManagePayroll`** (it directly moves TDS money). SoD is enforced exactly as
`consumers.profileChange.js` does: the engine/controller asserts *operator User ≠ the subject
employee's linked User* so an employee can't self-verify their own proof. Cross-employee access is
**404, never 403** (IDOR-safe), via `withEmployeeScope` — identical to `documents.routes.js`.

---

## 5. UX in plain language

### hr-admin (operator console)
- **Tax → Declaration Window** (new page). HR/Finance sets the FY, opens-at, closes-at, and **proof
  deadline** dates, then clicks **Open** (employees get the "declare your investments" nudge), later
  **Close**, finally **Lock**. A banner shows the live status ("OPEN — 142 of 380 employees have
  uploaded proofs; deadline 15 Feb 2027").
- **Tax → Proof Verification queue** (new page). A table of `PENDING` proofs across the team/tenant:
  *Employee · Claim (80C/HRA/24b…) · Declared ₹ · Proof (thumbnail/PDF link) · [Accept ▸ verified ₹]
  [Reject ▸ reason]*. Accept pre-fills `verifiedAmount = declaredAmount` (HR can trim it down). Reject
  forces a reason. A per-employee drill-down shows **Declared vs Verified vs Pending** per section with
  the running 80C/24b cap, so HR sees exactly what will feed TDS at the deadline.
- The existing **Employee → Documents** tab gets a read-only "Tax Proofs (FY)" sub-section linking here.

### ESS (employee portal)
- The **Tax Declaration** page (already exists) gains a second step after "Declare": **"Upload Proofs"**
  — visible only when the window is `OPEN`. For each thing they declared (80C, 80D, 24b home-loan, HRA
  rent) the employee sees a row: *declared ₹X · status (Not uploaded / Pending / Accepted ₹Y / Rejected
  — reason)* with an **Upload** button (camera/file → base64, same control as the documents uploader).
  HRA rows additionally collect **landlord name + PAN** when annual rent > ₹1,00,000.
- A clear **deadline countdown** ("Submit proofs by 15 Feb — after that, only verified investments
  reduce your TDS and your March salary may have higher tax").
- A **"Download Form 12BB"** button once the window closes.
- The **Tax Projection** page (already exists) shows a quiet badge per line: *"using declared
  (provisional)"* before the deadline, flipping to *"using verified"* after — so the employee
  understands why their projected TDS moved.

---

## 6. The wiring (declared → verified switch) — the heart of the feature

This is **one function change**, fully reuse-aligned. In `projectionAssembler.js`, `readDeclaration(sp)`
becomes `readDeclaration(sp, { window, proofs, asOf })`:

```
const useVerified = window && asOf >= window.proofDeadline;   // on/after deadline (CLOSED/LOCKED)
function amountFor(section, declaredColumnMinor) {
  if (!useVerified) return declaredColumnMinor;               // pre-deadline = today's behaviour
  // post-deadline: Σ ACCEPTED verifiedAmount for this section, capped at the declared aggregate
  return Math.min(declaredColumnMinor, sumAcceptedVerifiedMinor(proofs, section));
}
sec80cGrossMinor = amountFor('SEC_80C', rupeesToMinor(sp.section80CDeclared));
sec24bGrossMinor = amountFor('SEC_24B_HOME_LOAN', rupeesToMinor(sp.sec24BHomeLoanInterest));
hraRentPaidMinor = amountFor('HRA_RENT', rupeesToMinor(sp.hraAnnualRentPaid));  // …80D, 80CCD1B, 80TTA
```

Because `buildTaxProjection` already loads the `StatutoryProfile` and is the **single** path the
**monthly payroll TDS run** *and* the ESS projection both reconcile against (the golden parity test
asserts the monthly TDS line == projection to the paise), making `readDeclaration` window-aware flips
**both** consumers atomically. No change to `india.js` math; no second engine. The assembler additionally
loads the window (`InvestmentDeclarationWindow` for the FY) and the employee's `ACCEPTED` proofs.

**Statement annotations.** `buildTaxProjection` adds `proofBasis: 'DECLARED' | 'VERIFIED'` and per-line
`{ declared, verified, used, basis }` plus an anomaly when `verified < declared` after the deadline
("₹40,000 of declared 80C is unverified and excluded from TDS — upload proof or it stays excluded").

---

## 7. Statutory edge cases (the ones that bite)

1. **NEW regime declares investments.** Under NEW there are no Chapter-VI-A/HRA deductions — the engine
   already structurally zeroes them. Proofs are **only collected/consumed under OLD regime**; for NEW we
   skip the proof step entirely (show "Not applicable under the new regime"). Mirror `saveDeclaration`'s
   `isOld` gate.
2. **Verified < Declared after deadline.** The unverified portion silently → ₹0 for TDS; surface it loudly
   (anomaly + March-TDS spike warning). This is the *§201 protection working as intended.*
3. **Verified can never exceed declared / statutory cap.** `min(declared, Σverified)` then the existing
   80C ₹1.5L / 24b ₹2L caps in `chapterVIADeductions`. A double-counted proof can't inflate relief.
4. **HRA landlord-PAN rule (Rule 26C).** When annual rent > ₹1,00,000, **landlord PAN is mandatory** on
   the proof; reject (or block submit) without it. Below the threshold, receipts suffice.
5. **PF auto-80C.** The assembler already *derives* employee PF (12% of capped Basic+DA) as auto-80C
   (`derivePfAnnualMinor`). That derived PF needs **no proof** (it's in our own payslips) — it's
   always "verified". Only the *declared-over-PF* 80C portion needs proof. Keep that split.
6. **Regime switch after proofs uploaded.** If an employee flips OLD→NEW after uploading, proofs become
   moot for TDS (NEW ignores them) but are retained (audit / they may flip back). Don't delete.
7. **Window not configured.** Fail **open-but-provisional**: with no window row, behave exactly like
   today (declared figures, no lock) — the feature must never *break* a tenant that hasn't set a window.
8. **Mid-year joiner / prev-employer.** Untouched: prev-employer income/TDS (Form 12B) stays the
   existing `prevEmployerFY == taxYear` gate; it is not a "proof" claim.
9. **Re-upload / supersede.** A new proof for the same claim soft-deletes the prior PENDING one; an
   already-ACCEPTED proof is immutable (re-verify requires HR to reject-then-accept the new file).
10. **Cap on 80D / senior-citizen variants** are roadmap in `india.js`; proof model already carries
    `subSection` so the breakdown is ready when those caps land.

---

## 8. Lifecycle automation (scheduler)

Register in `backend/src/core/lib/scheduler.js` (reuse the `node-cron` registry; idempotent like the
trial-expiry sweep):

- **Daily 09:00** — for each tenant window: if `today == opensAt` → status OPEN + `notifyHrEvent`
  fan-out to all OLD-regime employees ("declaration window open"). If `today == closesAt` → CLOSED.
  If `today == proofDeadline` → LOCKED + notify employees with `verified < declared` ("unverified
  investments will be excluded from TDS"). The TDS switch itself is **date-driven in the assembler**
  (`asOf >= proofDeadline`), so even if the cron misses a beat, the math is still correct on the next
  payroll run — the cron only drives *notifications/status*, never correctness.
- **Reminder nudges** (T-14, T-3 days before deadline) to employees with PENDING/missing proofs, via
  `notifyHrEvent`.

---

## 9. Testing (golden + live, matching existing harness)

- **Pure (DB-free):** `proofAggregator` — Σ ACCEPTED, PENDING/REJECTED→0, `min(declared, Σverified)`,
  cap interplay with 80C ₹1.5L. Assert pre-deadline vs post-deadline `readDeclaration` outputs.
- **Golden parity:** extend `india.golden.test.js` — a worked case where declared 80C ₹1.5L but only
  ₹90k verified → post-deadline taxable rises by ₹60k → monthly TDS rises by the exact slab delta, and
  the **payroll run TDS line == projection** to the paise (the existing parity invariant must hold).
- **Live (`hr_test`):** ESS upload (window-gated, self-only, 404 cross-employee), HR accept/reject
  (SoD: can't self-verify; reject needs reason), window open/close/lock transitions, and the assembler
  flipping DECLARED→VERIFIED at the deadline boundary.

---

## 10. Build plan — 5 slices

**Slice 20a — Window model + admin API.** `InvestmentDeclarationWindow` + `DeclarationWindowStatus`
migration; CRUD + open/close/lock routes (`canManagePayroll`); date-ordering guards; one-per-FY unique.
hr-admin "Declaration Window" page. *Ships the lock primitive.*

**Slice 20b — Proof model + ESS upload.** `InvestmentProof` + enums migration; `/me/proofs` upload
(reuse `validateDocDataUrl`/`sha256`/`s3.uploadDataUrl`), window-OPEN gate, self-only, withdraw-PENDING;
ESS "Upload Proofs" step with declared-vs-status rows. *Employees can submit evidence.*

**Slice 20c — HR verification console.** Verify queue + per-employee drill-down; accept (verifiedAmount)
/ reject (mandatory reason) with SoD + scope (IDOR→404); `notifyHrEvent` on each verdict; proof-file
stream (SSRF-guarded). *HR can verify per proof.*

**Slice 20d — The TDS switch (assembler wiring).** Make `readDeclaration` window-aware
(`min(declared, Σverified)` after `proofDeadline`); add `proofBasis`/per-line `{declared,verified,used}`
+ unverified anomaly to the statement; golden parity test (run TDS == projection). *The §201 control
goes live — verified amounts drive TDS after the deadline.*

**Slice 20e — Form 12BB + automation.** Form 12BB PDF from the verified record (reuse `taxProjectionPdf`
pattern); scheduler cron for open/close/lock status + deadline + reminder notifications; ESS deadline
countdown + "using declared/verified" projection badges. *Compliance paperwork + the nudges.*
