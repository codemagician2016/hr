# Feature 09 — Letters & Communication

> **Status:** spec / dev contract · **Module:** `backend/src/hr/letters/` (new) · **Apps:** `apps/hr-admin`, `apps/ess`
> **Markets:** India + New Zealand · **Builds on:** F1 RBAC/hierarchy/scope, F3 Branding (`TenantBrand`), F4 Lifecycle (`EmployeeDocument`, built-in e-sign, `NumberSequence`/`codes.js`), F5 Compensation (masking), F7 Payroll (`payslipPdf.js` pdfkit primitives)
> **Author note:** every schema field / RBAC key / file path / library claim below was verified against the live tree on 2026-06-24. Where a referenced helper does not yet exist it is flagged **build-new**; where it exists it is flagged **reuse** with the file anchor. The four research dossiers (reuse / pdf-overlay / datamodel / domain) are folded in and reconciled here — this file is the single source of truth for the build.

---

## 1. Summary & goals

DriftHR can already mint two letters — but only as a side-effect of separation, and only as hand-concatenated HTML embedded as a `data:text/html;base64` URL on an `EmployeeDocument` (`offboarding.controller.js:951-1037`, `LETTER_KINDS` is a 2-entry map). There is no template engine, no letterhead, no reference number, no PDF, no register, no re-issue, no employee-initiated request fulfilment, and no way to issue a bonafide / salary-proof / bank / employment-proof / contract / custom letter for an arbitrary employee outside an offboarding case.

This feature makes **letters a first-class, reusable module**: a template library (body + merge fields), a **letterhead manager with a visual position-picker** (upload an A4 PDF, drag the writing area + field anchors), a generic **issue-a-letter wizard** (pick type → pick employee → live-merge preview → issue), an atomic **per-tenant reference-number register**, **re-issue / revoke with audit**, optional **authority pre-signature or routed e-sign**, and an **ESS "My Letters"** surface. The offboarding relieving/experience path becomes one *caller* of this shared engine rather than its own bespoke HTML.

**Goals (v1):**
1. **Configure once:** HR uploads letterhead PDFs, places writing-area + field rects on a visual picker (stored normalized), authors versioned merge-field templates per letter type, sets a default + per-type letterhead binding, defines an authority pre-signature.
2. **Issue per employee:** pick type → pick employee (F1-scoped) → fields auto-merge from the employee record → editable live preview rendered onto the letterhead → mint reference number → render flattened PDF → store as an `EmployeeDocument` (`EMPLOYEE_VISIBLE`) → audit. Optionally route the contract/appointment through built-in e-sign.
3. **Govern the register:** tenant-wide letter register (ref no · type · employee · status · issuer), per-employee history with supersede chains, **revoke** (reason, audited, ESS notice) and **re-issue** (new ref no, supersede link, old record retained).
4. **ESS self-serve:** employee sees + downloads their own issued letters with a tamper badge; the existing `DocumentRequest` "ask HR for a letter" flow finally gets a fulfilment path.
5. **RBAC-correct:** reuse `canGenerateLetters` (the maker/issue key, already granted to HR-Admin and already wired into e-sign envelope creation); add `canManageLetters` (the config/checker/revoke key). Tenant + F1 scope enforced everywhere.

**Non-goals (v1):** bulk/CSV issuance + batch approval; a separate `canApproveLetters` maker/checker approval workflow (the SoD hook is reserved but the queue ships in v1.1); email/WhatsApp delivery + delivery tracking; block-based (no-HTML) template designer; multi-language bodies beyond the IN/NZ split; QR/public hash-verification page; vendor e-sign adapters; server-side letterhead rasterization (the visual picker rasterizes client-side via pdf.js).

---

## 2. Scope

### In scope (v1 — reuse-first)

**Reuse as-is (no change):**
- **F1 RBAC + scope chokepoint** — `rbac.js` `PERMISSIONS`/`SYSTEM_ROLES`, `scope.middleware.js` `withEmployeeScope` (IDOR-safe: out-of-band subject ⇒ 404, never 403), `requireEitherPermission` helper (`esign.routes.js:30`).
- **`EmployeeDocument`** (`schema.prisma:8671`) as the single file-of-record — generated letters become rows with `category`/`fileUrl`/`fileHash`/`mimeType`/`sizeBytes`/`visibility`/`signatureStatus`. ESS visibility + the tamper badge + expiry reminders come for free.
- **Built-in e-sign** (`esign/builtin.js`) — `createEnvelope({ employeeDocumentId, signers:[{role:'EMPLOYER'|'APPROVER',...}] })`, SHA-256 docHash→signatureHash chain, HMAC-sealed audit cert. `POST /api/hr/esign/envelopes` already gates on `canGenerateLetters` (`esign.routes.js:54`). No e-sign change needed for v1 letters.
- **`s3.uploadDataUrl`** (`s3.js:85`, `ALLOWED_EXT` already includes `application/pdf`) + inline-data-URL fallback when no bucket; `deleteByUrl`; `isOurUrl` SSRF allow-list.
- **`validateDocDataUrl`** (`documents.controller.js`) — 10MB cap + MIME allow-list (PDF/PNG/JPG) + server-side `sha256(buffer)`. Reused verbatim for letterhead upload (PDF) and signature-image upload (PNG/JPG).
- **`NumberSequence`** (`schema.prisma:9836`, `@@unique([businessId, entityId, scope, periodKey])`) + `allocateCode` allocator (`codes.js`). The reference-number generator — we add a `LETTER` scope with `periodKey` = tax year for yearly reset.
- **pdfkit `^0.19.1`** primitives in `payslipPdf.js` (header/footer/money/date/pagination) — reference pattern for from-scratch fallback rendering; the buffer-collection `→ Promise<Buffer>` wrapper and PDF-serving pattern (`payroll.controller.js:266-287`, `Content-Type`/`Content-Disposition`/`res.send(buffer)`).
- **`TenantBrand`** (`schema.prisma:9852`) — logo/colors/footer for the from-scratch fallback header and for default no-letterhead letters.
- **ESS documents page** (`apps/ess/app/documents/page.js`) reading `/api/hr/me/documents` — letters with `EMPLOYEE_VISIBLE` auto-surface; we add a filtered "My Letters" view on top.

**Reuse with extension:**
- **`codes.js` `SCOPE_DEFAULTS`** — add `LETTER: { prefix: 'LTR-', padding: 4 }`; extend `allocateCode` to honour `periodKey` (today it hardcodes `periodKey: null`; we pass the tax year — see §7).
- **`DocumentRequest`** (`schema.prisma:8789`) — finally populate `generatedDocumentId` when HR fulfils an ESS letter request by issuing a letter (the controller comment at `documents.controller.js:420` admits "generation lands in 4f" — it never did; we close it here).
- **`offboarding.controller.js` `generateLetters`** — **rewrite** to call the new `letters.service.issueLetter()` (delete the inline-HTML scaffolding; keep the SETTLED gate + elevated-override + `writeAudit`).

**Build net-new:**
- 3 Prisma models + 2 enums (`CompanyLetterhead`, `LetterTemplate`, `IssuedLetter`; `LetterCategory`, `IssuedLetterStatus`) + 3 back-relations + 1 `SignatureEnvelope.issuedLetterId` pointer (§3).
- `backend/src/hr/letters/` module: `renderLetter.js` (pure pdf-lib overlay), `mergeFields.js` (placeholder resolver + catalog), `letters.service.js` (orchestrator: resolve → render → ref-no → store → audit → optional e-sign), `letterheads.controller.js`, `templates.controller.js`, `issuance.controller.js`, `routes/*.js`, `templates/seed.js` (IN/NZ system templates), `fonts/` (one bundled Unicode TTF).
- pdf-lib install (`pdf-lib` + `@pdf-lib/fontkit`) — closes both the letterhead-overlay gap and the deferred e-sign re-stamp (`builtin.js:24-30`).
- hr-admin UX: template library, letterhead manager + visual picker, issue-a-letter wizard, letter register, per-employee history tab. ESS UX: "My Letters" filter + request-a-letter.
- New RBAC key `canManageLetters` (additive to the `permissions` JSON column — no migration).

### Out of scope (deferred — explicit)
- Bulk/CSV issuance + batch approval; `canApproveLetters` maker/checker queue (SoD hook reserved in the model via `status: PENDING_SIGNATURE`/`PENDING_APPROVAL` but the queue UI is v1.1).
- Email/WhatsApp delivery + delivery receipts (model carries `deliveredAt`/`deliveryChannel` for forward-compat; no sender in v1).
- Server-side preview thumbnail rasterization, QR/public verify page, vendor e-sign adapters, block-based designer, multi-language beyond IN/NZ.

---

## 3. Data model (Prisma — additive, no breaking migration)

Insert the new models near the existing `DocumentTemplate`/`EmployeeDocument` block (`schema.prisma:~8732`). Conventions matched exactly: uuid PK, `businessId` + `business Business @relation(onDelete: Cascade)`, `entityId String?`, `createdAt`/`updatedAt`, `version Int @default(0)`, `deletedAt DateTime?` **on config models only**. Issued letters are legal records — **never soft-deleted**; they get `voidedAt`/`voidReason` instead (mirrors `PayRun`/`SignatureEnvelope`).

### 3.1 Enums

```prisma
enum LetterCategory {
  EXPERIENCE          // experience / service certificate
  BONAFIDE            // bonafide / "To Whomsoever It May Concern"
  EMPLOYMENT_PROOF    // proof of employment (embassy/visa)
  SALARY_PROOF        // salary certificate / salary slip cover
  BANK                // bank-account / salary-routing confirmation
  CONTRACT            // appointment / employment agreement (e-sign route)
  CUSTOM              // free-form / tenant-defined
}

enum IssuedLetterStatus {
  DRAFT               // rendered preview saved, ref-no NOT yet committed
  PENDING_SIGNATURE   // routed to SignatureEnvelope, awaiting authority sign
  ISSUED              // finalized PDF minted, ref-no committed
  DELIVERED           // emailed/handed (optional milestone, v1.1 sets this)
  VOIDED              // legally retracted; supersededByLetterId chains a re-issue
}
```

> `LetterCategory` is the issuance-facing taxonomy. It maps onto the existing `EmployeeDocument.category` (`DocumentCategory`) when the letter lands in the vault: `EXPERIENCE→EXPERIENCE`, `CONTRACT→CONTRACT`, `BANK→BANK_PROOF`, the rest→`OTHER`. We do **not** reuse `TemplateKind` for letters (it is offer/payslip/form16-centric and overlapping); `LetterCategory` is the clean, letter-specific enum. `TemplateKind` `DocumentTemplate` rows remain for offer-letter/onboarding use.

### 3.2 `CompanyLetterhead` — uploaded A4 PDF + visual layout

```prisma
model CompanyLetterhead {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId      String?                                   // NULL = tenant-wide; else per legal entity / brand
  code          String                                    // "ACME-DEFAULT", "ACME-EXPERIENCE"
  name          String
  // Background single-page A4 PDF used as the stationery underlay (reuses EmployeeDocument storage convention)
  fileUrl       String   @db.Text                         // R2/S3 object key of the A4 PDF
  fileHash      String?                                   // SHA-256 integrity (server-computed)
  mimeType      String?  @default("application/pdf")
  sizeBytes     Int?
  pageWidthPt   Float?                                    // measured at upload via page.getSize() (non-A4 guard)
  pageHeightPt  Float?
  // Visual layout: normalized rects, origin TOP-LEFT, values 0..1. Schema-validated on save.
  // { writingArea:{x,y,w,h,align,fontSize,lineGap},
  //   fields:{ date:{x,y,w,...}, refNo:{...}, authority:{...}, signature:{x,y,w,h} },
  //   overflowPolicy:"repeat-letterhead"|"blank-continuation", signatureOnLastPage:bool }
  layoutJson    Json
  fontKey       String?  @default("noto-sans")            // which bundled Unicode TTF to embed (₹/non-Latin safe)
  // Binding: NULL category + isDefault=true → tenant fixed default.
  // category set → used only for that LetterCategory (overrides default). Resolution: category → default.
  letterCategory LetterCategory?
  isDefault     Boolean  @default(false)
  isActive      Boolean  @default(true)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime?
  version       Int      @default(0)

  templates     LetterTemplate[]
  issuedLetters IssuedLetter[]

  @@unique([businessId, code])
  @@index([businessId, entityId, isActive])
  @@index([businessId, letterCategory, isActive])
}
```

> **Partial-unique invariants (raw SQL in the migration — Prisma can't express partial uniques):**
> - one default per (tenant, entity): `CREATE UNIQUE INDEX uniq_letterhead_default ON "CompanyLetterhead"("businessId","entityId") WHERE "isDefault" AND "deletedAt" IS NULL;`
> - one letterhead per category per (tenant, entity): `CREATE UNIQUE INDEX uniq_letterhead_category ON "CompanyLetterhead"("businessId","entityId","letterCategory") WHERE "letterCategory" IS NOT NULL AND "deletedAt" IS NULL;`
> The codebase already runs raw-SQL minting (`codes.js`), so a raw-SQL partial index in the migration is consistent.

### 3.3 `LetterTemplate` — reusable body + merge fields (versioned)

```prisma
model LetterTemplate {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId      String?
  code          String                                    // tenant-unique, e.g. "EXP-STD-IN"
  name          String
  category      LetterCategory
  countryCode   String?  @db.Char(2)                      // "IN" / "NZ" (IN/NZ wording split)
  subject       String?                                   // "Re:" / subject line (mergeable)
  // Body with placeholders {{employee.name}}, {{comp.ctcAnnual}}, {{date.today}} — MERGE FIELDS ONLY, no raw HTML/script
  bodyMarkdown  String   @db.Text
  // Declared allow-list of merge fields → validation + UI palette
  // e.g. {"employee.name":{type:"string",required:true},"comp.ctcAnnual":{type:"money","gatedBy":"canViewCompensation"}}
  mergeFieldsJson Json?
  // Default letterhead for this template (else resolve by category at issue). SetNull keeps history.
  defaultLetterheadId String?
  defaultLetterhead   CompanyLetterhead? @relation(fields: [defaultLetterheadId], references: [id], onDelete: SetNull)
  requiresSignature Boolean @default(false)               // route minted letters through e-sign (CONTRACT)
  refNoPrefix   String?                                   // override sequence prefix, e.g. "ACME/HR"
  locale        String?                                   // BCP-47, e.g. "en-IN" / "en-NZ" (date/number format)
  isSystem      Boolean  @default(false)                  // seeded IN/NZ template (non-deletable)
  isActive      Boolean  @default(true)                   // PUBLISHED. false = DRAFT/ARCHIVED
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime?
  version       Int      @default(0)                      // bumped on edit; pinned onto IssuedLetter at issue

  issuedLetters IssuedLetter[]

  @@unique([businessId, code])
  @@index([businessId, category, isActive])
  @@index([businessId, countryCode, category])
}
```

> Versioning is value-pinned, not row-cloned: each edit bumps `version`; an `IssuedLetter` snapshots `renderedBody` + `templateVersionAtIssue`, so the issued letter is immutable even if the template later changes. (Avoids a separate `LetterTemplateVersion` table for v1; the issued snapshot *is* the frozen version.)

### 3.4 `IssuedLetter` — immutable issuance record (the register row)

```prisma
model IssuedLetter {
  id            String   @id @default(uuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  entityId      String?                                   // entity whose sequence/letterhead applied
  referenceNo   String                                    // "ACME/HR/2026/0001" — unique per tenant
  category      LetterCategory
  // Subject employee — NULL for generic/company-wide letters
  employeeId    String?
  employee      Employee? @relation(fields: [employeeId], references: [id], onDelete: SetNull)
  // Provenance (nullable SetNull — the rendered snapshot below is the immutable truth)
  templateId    String?
  template      LetterTemplate?    @relation(fields: [templateId], references: [id], onDelete: SetNull)
  letterheadId  String?
  letterhead    CompanyLetterhead? @relation(fields: [letterheadId], references: [id], onDelete: SetNull)
  // Content snapshot frozen at issue (what the recipient actually got)
  subject       String?
  renderedBody  String   @db.Text                         // merge fields resolved → final text
  mergeDataJson Json                                      // exact values fed to the template (audit/regen)
  templateVersionAtIssue Int?
  letterheadHash String?                                  // CompanyLetterhead.fileHash at issue
  // Rendered PDF (letterhead underlay + body composited, flattened)
  fileUrl       String?  @db.Text
  fileHash      String?                                   // SHA-256 of issued PDF (tamper anchor)
  mimeType      String?  @default("application/pdf")
  sizeBytes     Int?
  status        IssuedLetterStatus @default(DRAFT)
  // E-sign linkage (built-in) — set when requiresSignature
  signatureEnvelopeId String?
  // Lands in the employee's vault → ESS + expiry reminders (plain id link, mirrors DocumentRequest.generatedDocumentId)
  employeeDocumentId  String?
  // Fulfilment of an ESS letter request, when applicable
  documentRequestId   String?
  // Actors / milestones
  issuedBy      String                                    // userId of HR issuer
  issuedAt      DateTime?                                 // set when status → ISSUED (ref committed)
  deliveredAt   DateTime?
  deliveryChannel String?                                 // EMAIL | DOWNLOAD | PRINT (v1.1)
  // Sequence bookkeeping (audit / regeneration of the human ref string)
  seqScope      String   @default("LETTER")
  seqPeriodKey  String?                                   // taxYear "2026-27"
  seqValue      Int?                                      // raw number consumed (0001 → 1)
  // Re-issue / void chain (no soft-delete on legal records)
  supersedesLetterId   String?                            // this re-issues an older letter
  supersededByLetterId String?                            // an older letter retracted by a newer one
  voidedAt      DateTime?
  voidedBy      String?
  voidReason    String?
  notes         String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  version       Int      @default(0)

  @@unique([businessId, referenceNo])
  @@index([businessId, employeeId, category, issuedAt])
  @@index([businessId, category, status])
  @@index([businessId, entityId, seqScope, seqPeriodKey])
}
```

### 3.5 Back-relations + e-sign pointer (additive to existing models)

```prisma
// model Business { ... }
  letterheads     CompanyLetterhead[]
  letterTemplates LetterTemplate[]
  issuedLetters   IssuedLetter[]

// model Employee { ... }
  issuedLetters   IssuedLetter[]

// model SignatureEnvelope { ... }  (already has employeeDocumentId + documentTemplateId)
  issuedLetterId  String?     // letter routed through built-in e-sign; on COMPLETED → IssuedLetter.fileUrl/fileHash
```

### 3.6 Tie-ins & flow

- **EmployeeDocument is the file-of-record.** On ISSUED, write an `EmployeeDocument` (`category` mapped per §3.1, `visibility: 'EMPLOYEE_VISIBLE'`, `mimeType: 'application/pdf'`, `signatureStatus: NOT_REQUIRED` or `SIGNED`, `fileHash` = issued PDF hash) and set `IssuedLetter.employeeDocumentId`. ESS listing/download/tamper-badge/expiry all reuse F4 infra unchanged.
- **E-sign route (CONTRACT / `requiresSignature`):** create `IssuedLetter` `DRAFT` → render PDF → write `EmployeeDocument` → `provider.createEnvelope({ employeeDocumentId, signers:[{role:'EMPLOYER'/'APPROVER'},…], issuedLetterId })` → status `PENDING_SIGNATURE`. On `EnvelopeStatus.COMPLETED`, copy `finalFileUrl`/`fileHash` to the letter, **mint the ref-no**, status → `ISSUED`. (Pre-signature letters mint ref-no + PDF directly at issue with no envelope.)
- **DocumentRequest fulfilment:** when HR issues a letter from the ESS request queue, set `IssuedLetter.documentRequestId`, the letter's `employeeDocumentId` onto `DocumentRequest.generatedDocumentId`, and flip the request `status` to `FULFILLED`.

---

## 4. Backend

### 4.0 Module layout (`backend/src/hr/letters/`)

```
letters/
  renderLetter.js          # pure pdf-lib overlay → Promise<Buffer> (no DB/network)
  letterPdfFallback.js     # pure pdfkit from-scratch (no-letterhead branded letter), mirrors payslipPdf.js
  mergeFields.js           # placeholder catalog + resolver (employee/company/comp/date), masking-aware
  letters.service.js       # orchestrator: resolve → render → ref-no → store → EmployeeDocument → audit → e-sign
  controllers/
    letterheads.controller.js
    templates.controller.js
    issuance.controller.js
  routes/
    letterheads.routes.js
    templates.routes.js
    issuance.routes.js
    me-letters.routes.js
  templates/seed.js        # IN/NZ system LetterTemplate seeds
  fonts/NotoSans-Regular.ttf  fonts/NotoSans-Bold.ttf   # bundled Unicode TTFs (₹/non-Latin safe)
```

Mount `letterheads`/`templates`/`issuance` routes under `/api/hr/letters` and `me-letters` under `/api/hr/me/letters` (`routes/index.js`).

### 4.1 `renderLetter.js` — pure pdf-lib overlay (the core)

**Library decision: `pdf-lib` + `@pdf-lib/fontkit`** (single lib, no combo). Why:
- pdfkit (the only PDF dep today) is **generation-only** — it cannot import an existing PDF page as a background (`doc.image()` takes only raster PNG/JPG). Letterhead overlay is out of its scope.
- pdf-lib is **pure JS, zero native deps** (unlike the deprecated/unmaintained muhammara/hummus C++ addons — do not use), actively maintained, multi-million weekly downloads. It does the whole job: `PDFDocument.load(letterheadBytes)` → `getPage(0)` gives the real A4 page to draw on; `page.drawText/drawRectangle/drawImage`; `embedPng` for signature images; `doc.save()` → flattened bytes (baked into the content stream → not user-editable). It also **closes the deferred e-sign re-stamp** (`builtin.js:24-30`): once installed, the "keep original + HTML cert" fallback can `drawImage(signaturePng)` onto the final page.
- The `pdf-lib + pdf2pic` / `pdf-lib + pdfkit` combos add a rasterizer or second engine for no benefit. Keep pdfkit for the from-scratch payslip and the no-letterhead fallback; add pdf-lib for the overlay. They coexist.

**Two gotchas baked into the implementation:**
1. **Origin is BOTTOM-LEFT.** A4 = 595.28 × 841.89 pt (72 pt/in). We store rects normalized top-left; convert at render: `absY_bottomLeft = H − (yNorm·H) − heightPt`. Always read `page.getSize()` (uploaded letterheads can be off-A4 or rotated — also honour `page.getRotation()`), never assume 595×842.
2. **Standard fonts are WinAnsi/Latin-1 only** — the ₹ glyph and non-Latin text throw on `drawText`. We **must** embed a bundled Unicode TTF: `doc.registerFontkit(fontkit); const font = await doc.embedFont(ttfBytes, { subset:true })`. Bundle Noto Sans in `letters/fonts/`, load once per render, subset to keep output small.

**Body overflow:** pdf-lib has no auto-wrap/auto-pagination — we own it. Greedy-wrap with `font.widthOfTextAtSize(word, size)` to the writing-area width, advance `y` by `size + lineGap`; when the cursor crosses the writing-area bottom, start a new page per `overflowPolicy`: `repeat-letterhead` (copy the original letterhead page — branded every page; the correct default) or `blank-continuation` (plain A4 body only). Field anchors (date/refNo/authority/signature) render on page 1 (signature on last page if `signatureOnLastPage`).

```js
// backend/src/hr/letters/renderLetter.js — PURE: caller supplies bytes, this draws + saves.
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

/**
 * @param {Buffer}  args.letterheadPdf  bytes of the uploaded A4 letterhead PDF
 * @param {Object}  args.layout         CompanyLetterhead.layoutJson (normalized, top-left origin)
 * @param {string}  args.bodyText       fully merged letter body (fields already resolved)
 * @param {Object}  args.fields         { date, refNo, authority, subject } resolved strings
 * @param {Buffer} [args.signaturePng]  optional authority signature image (fields.signature box)
 * @param {Buffer}  args.fontBytes      bundled Unicode TTF (₹/non-Latin safe)
 * @param {Buffer} [args.fontBoldBytes]
 * @param {Object} [args.opts]          { overflowPolicy, signatureOnLastPage, watermark }
 * @returns {Promise<Buffer>}           flattened PDF
 */
async function renderLetter({ letterheadPdf, layout, bodyText, fields, signaturePng, fontBytes, opts }) {
  const doc = await PDFDocument.load(letterheadPdf);
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  const page0 = doc.getPage(0);
  const { width: W, height: H } = page0.getSize();
  // 1) draw fields (date/refNo/authority/subject) on page 1 at normalized→abs anchors (Y-flipped)
  // 2) wrap + paginate bodyText within layout.writingArea; addPage per overflowPolicy
  // 3) if opts.watermark: diagonal "DRAFT — NOT VALID" / "REVOKED" overlay
  // 4) if signaturePng: page.drawImage(await doc.embedPng(signaturePng), signatureBox)
  return Buffer.from(await doc.save());
}
module.exports = { renderLetter };
```

Install: `cd backend && npm i pdf-lib @pdf-lib/fontkit` + commit the two Noto Sans TTFs.

### 4.2 `mergeFields.js` — placeholder resolver (see §8 catalog)

Pure: `resolveMergeData({ employee, business, comp, entity, locale, now, refNo, authority, perms }) → { values, missingRequired[] }`. Locale-aware date/number/currency formatting (`en-IN` → `dd/MM/yyyy` + `₹` + Indian digit grouping; `en-NZ` → `dd/MM/yyyy` + `NZ$`). Comp fields (`comp.*`) are **masked unless `perms.canViewCompensation`** — when masked the resolver returns `"••••"` and flags it so the wizard surfaces a "salary hidden" notice (reuses F5 masking posture). `renderMerge(bodyMarkdown, values)` does the `{{token}}` substitution against the declared allow-list only (unknown tokens → flagged, never echoed raw — XSS-safe, see §9).

### 4.3 `letters.service.js` — orchestrator (one `$transaction` for the ref-no + insert)

`issueLetter(tx, { businessId, entityId, actorUserId, perms, templateId, employeeId, overrides, mode })`:
1. Load + **tenant-scope** template, employee (F1 — caller already passed `withEmployeeScope`), resolve letterhead (template default → category binding → tenant default → none⇒fallback), load comp snapshot (masking-aware), `TenantBrand`.
2. `resolveMergeData` → if `missingRequired.length` and `mode!=='draft'`, **422** with the missing field list.
3. Render: if letterhead → `renderLetter` (pdf-lib overlay); else → `letterPdfFallback` (pdfkit branded). `mode==='preview'` ⇒ watermark "DRAFT — NOT VALID", **no** ref-no, **no** persistence — return bytes to stream.
4. For `mode==='issue'`: **inside `tx`** mint ref-no (`allocateCode(tx, { businessId, entityId, scope:'LETTER', prefix, padding:4, periodKey: taxYear })` — §7) → `sha256(pdf)` → `s3.uploadDataUrl({ scope:'letter', businessId })` (inline fallback) → insert `IssuedLetter` (status `ISSUED`, snapshot `renderedBody`/`mergeDataJson`/`templateVersionAtIssue`/`letterheadHash`/`seqValue`/`seqPeriodKey`) → write `EmployeeDocument` (`EMPLOYEE_VISIBLE`) + set `employeeDocumentId` → `writeAudit` (CREATE/ISSUE). If `template.requiresSignature` → instead create envelope (status `PENDING_SIGNATURE`, ref-no deferred to COMPLETED).
5. `reissueLetter`: clone snapshot of source → new `DRAFT`→`ISSUED` with **new** ref-no, set `supersedesLetterId`, set source `supersededByLetterId` (source stays ISSUED for history). `revokeLetter`: require reason → `status:VOIDED` + `voidedAt`/`voidedBy`/`voidReason` → flip the linked `EmployeeDocument` to `HR_ONLY` (or struck-through per config) → notify employee → audit. Ref-no is **burned, never reused**.

`writeAudit` reuses the F4 audit-log convention (append-only); the SHA-256 `fileHash` on every issued PDF is the integrity anchor; e-sign letters additionally carry the HMAC-sealed audit cert from `builtin.js`.

### 4.4 RBAC posture (additive to `rbac.js` — no migration; `permissions` is JSON)

Add one key to `PERMISSIONS`:
```js
canManageLetters: 'Letters config: letterheads, templates, ref schemes, revoke (the admin/checker key)',
```
Grant in `SYSTEM_ROLES`: **HR-Admin** gets `canManageLetters: true` (alongside the existing `canGenerateLetters: true`); Owner inherits (all-true); Finance/Manager: none.

- **`canGenerateLetters`** (exists) = the **maker/issue** key: preview/issue/re-issue a letter against a *scoped* employee. Already wired into `POST /api/hr/esign/envelopes` (`esign.routes.js:54`), so contract-signature flows already accept it.
- **`canManageLetters`** (new) = the **config/checker** key: letterhead CRUD + layout, template CRUD/publish, ref-scheme edit, **revoke**.
- **Scope:** issuance + per-employee history run through `withEmployeeScope('canGenerateLetters')` (out-of-band subject ⇒ 404). Config endpoints are tenant-level under `canManageLetters` (no employee scope). **Every** query is `where: { businessId }`-scoped; cross-tenant ids ⇒ 404.
- **SoD hook (v1):** revoke requires `canManageLetters` (distinct from the `canGenerateLetters` issuer). The `canApproveLetters` maker/checker queue is reserved (status enum carries `PENDING_*`) but the approval UI is v1.1.

### 4.5 Endpoint surface

**hr-admin — letterheads** (`/api/hr/letters/letterheads`, `protect` + `requirePermission('canManageLetters')`):
| Verb | Path | Notes |
|---|---|---|
| GET | `/letterheads` | list (tenant-scoped, `isActive` filter) |
| POST | `/letterheads` | upload PDF (`validateDocDataUrl`, ≤10MB, MIME=pdf) → measure `page.getSize()` → store → row |
| GET | `/letterheads/:id` | one (incl. `fileUrl` for the picker to rasterize client-side) |
| PUT | `/letterheads/:id/layout` | save normalized `layoutJson` (schema-validated, rects ∈ [0,1]) |
| PUT | `/letterheads/:id` | name/code/category-binding/isDefault/isActive (enforces partial-unique) |
| DELETE | `/letterheads/:id` | soft-delete (`deletedAt`); refuse if referenced by ISSUED letters? no — SetNull keeps history |

**hr-admin — templates** (`/api/hr/letters/templates`, `requirePermission('canManageLetters')`):
GET list / POST create / GET one / PUT update (bumps `version`) / POST `:id/publish` (`isActive=true`) / POST `:id/archive` / DELETE (soft; refuse on `isSystem`). GET `/merge-fields?category=&country=` returns the placeholder catalog palette (§8).

**hr-admin — issuance** (`/api/hr/letters`, `requirePermission('canGenerateLetters')` + `withEmployeeScope` where an employee is named):
| Verb | Path | Notes |
|---|---|---|
| POST | `/preview` | body `{ templateId, employeeId, overrides }` → streams a watermarked PDF (`mode:'preview'`), no persistence |
| POST | `/issue` | `{ templateId, employeeId, overrides, documentRequestId? }` → `$transaction` issue → returns `{ referenceNo, issuedLetterId, fileUrl }`; CONTRACT ⇒ opens envelope, returns `PENDING_SIGNATURE` |
| POST | `/:id/reissue` | new ref-no + supersede link |
| POST | `/:id/revoke` | `requirePermission('canManageLetters')` + `{ reason }` (required) → VOIDED |
| GET | `/register` | tenant register: filters (category/status/date/issuer/country), search (refNo/employee), pagination; CSV export |
| GET | `/:id` | one issued letter (provenance + snapshot) |
| GET | `/:id/download` | stream the issued PDF (`Content-Disposition: attachment`, reuses payslip-serving pattern) |
| GET | `/employees/:employeeId/letters` | per-employee history (supersede chains), `withEmployeeScope('canGenerateLetters')` |

**ESS — my letters** (`/api/hr/me/letters`, `protect` + `attachSelfEmployee`):
| Verb | Path | Notes |
|---|---|---|
| GET | `/` | own ISSUED, non-voided letters (`employeeId == self`), with `fileHash` tamper badge |
| GET | `/:id/download` | stream own letter PDF (self-only; out-of-band ⇒ 404) |
| POST | `/requests` | request a letter (reuses `DocumentRequest`: `templateKind`/`purpose`) → lands in HR queue |

ESS terminated-employee access honours the existing F4 ESS-lockout window (relieving/experience remain downloadable for the configured window).

---

## 5. Frontend

### 5.1 hr-admin (`apps/hr-admin/app/letters/`)

- **Template Library** (`/letters/templates`): grid of letter types (system IN/NZ + custom) → template cards with version/status. **Template editor:** body textarea with a **merge-field inserter drawer** (typeahead palette from `GET /merge-fields`, inserts `{{employee.name}}` etc.; unknown/empty flagged before publish), country/locale toggle (surfaces IN vs NZ wording variants), default-letterhead picker, `requiresSignature` toggle, ref-prefix override. Edit ⇒ new DRAFT version; **Publish** freezes. Live preview = `POST /preview` rendered onto the selected letterhead at A4.
- **Letterhead Manager** (`/letters/letterheads`): upload A4 PDF (client-side validated PDF/≤10MB). **Visual position-picker:** rasterize page 1 client-side via **pdf.js / react-pdf** into a `<canvas>`; overlay draggable/resizable boxes for: (1) **writing area** (body box), (2) **date**, (3) **ref-no**, (4) **authority name** (pre-signature line), (5) **signature image** box. Snap-to-grid, margin guides, zoom. On save, convert canvas px → **normalized [0,1] top-left** rects → `PUT /:id/layout`. "What you place is what you get" — the preview is the real render path (`POST /preview` with sample data). Assignment: mark **Default (fixed)** or bind **per LetterCategory**; resolution order shown (template override → category → tenant default).
- **Issue-a-Letter Wizard** (`/letters/issue`): (1) pick type + template version → (2) pick employee (search; F1-scoped, out-of-scope hidden) → (3) **auto-merge & review** (fields resolved into an editable live preview via `POST /preview`; missing-required blocked; salary/bank masked unless `canViewCompensation` with a "hidden" notice) → (4) letterhead + signature auto-selected (overridable) → (5) issue date + optional custom paragraph + watermark choice → (6) **Save Draft · Issue now**. On issue: ref-no minted, flattened PDF rendered, `EmployeeDocument` written, audit chained, optional e-sign envelope.
- **Letter Register** (`/letters/register`): tenant table (ref no · type · employee · status · issued-by · issued-at), filters + full-text + **CSV export**. Row actions: view · download · **revoke** (reason modal, audited, employee notified) · **re-issue** (clones snapshot → new ref, supersede link) · resend (v1.1).
- **Per-employee history tab** (also on the employee profile): every letter issued to that person + supersede chains visualized.

### 5.2 ESS (`apps/ess/app/`)

- **My Letters** (filter on the existing `/documents` page or a dedicated `/letters` route): lists own ISSUED non-voided letters via `GET /api/hr/me/letters`; view inline / download PDF; **tamper/integrity badge** from `fileHash`; voided letters shown struck-through with a notice (or hidden, configurable). No change needed to the base documents page — `EMPLOYEE_VISIBLE` letters already surface there; the dedicated view adds ref-no + category filtering.
- **Request a Letter:** simple form (type + purpose) → `POST /api/hr/me/letters/requests` (reuses `DocumentRequest`) → HR fulfils from the register; closes the most common HR ticket.

### 5.3 Universal states
Empty (no templates/letterheads yet → guided setup CTA), loading skeletons, error toasts, masked-salary notice, out-of-scope = invisible (not a 403 wall).

---

## 6. Reference-number scheme

- **Reuse `NumberSequence` + `codes.js`** — no new counter table. Scope `"LETTER"`, one row per `(businessId, entityId, "LETTER", periodKey)` where `periodKey` = the entity tax year (`"2026-27"` IN FY Apr–Mar; calendar year NZ) → **yearly reset** via the existing `periodKey` column.
- **Atomic + concurrency-safe:** `allocateCode` runs **inside the same `$transaction`** as the `IssuedLetter` insert. The increment is `UPDATE "NumberSequence" SET "nextValue" = "nextValue" + 1 ... RETURNING` (row-level lock); the `@@unique([businessId, entityId, scope, periodKey])` is the backstop against a duplicate create racing in (caller retries on P2002, the existing pattern). The `@@unique([businessId, referenceNo])` on `IssuedLetter` is the final collision backstop.
- **Format:** `referenceNo = ${prefix}/${year}/${pad(value, 4)}` → e.g. `ACME/HR/2026/0001`. `prefix` from `LetterTemplate.refNoPrefix` → else tenant config → else `"LTR"`. Persist `seqValue`/`seqPeriodKey`/`seqScope` on the row for audit/regeneration.
- **Gap-tolerant (recommended default):** a rolled-back issuance burns its number — acceptable; reference numbers are **monotonic, not gapless**. (If a strictly gapless register is ever mandated, the increment + insert already share one tx/connection, so a rollback un-consumes — but the default is gap-tolerant.) **Re-issue** mints a *new* ref-no (superseded row retained, marked); **revoke** burns the ref-no permanently (never reused).
- **`codes.js` extension:** add `LETTER: { prefix: 'LTR-', padding: 4 }` to `SCOPE_DEFAULTS`, and thread `periodKey` through `allocateCode` (today it hardcodes `periodKey: null` in the find-or-create — pass the caller's `periodKey` so the yearly-reset row is found/created correctly). This is the only change to `codes.js`; the lifecycle scopes (ONBOARD/OFFBOARD/SEP) are unaffected (they pass no `periodKey`).

---

## 7. Merge-field / placeholder catalog

Placeholders are `{{namespace.field}}`, validated against the template's `mergeFieldsJson` allow-list. Comp fields are **masked unless `canViewCompensation`**. Date/number/currency formatted by `locale`.

| Namespace | Field | Source | IN vs NZ note |
|---|---|---|---|
| `employee` | `name`, `firstName`, `lastName`, `code`, `designation`, `department`, `dateOfJoining`, `lastWorkingDay`, `tenureYears`, `employmentType`, `workLocation`, `email`, `phone` | `Employee` | LWD/tenure only for offboarding-origin letters |
| `employee` | `pan`, `uan`, `pfNumber`, `esiNumber` | IN statutory ids | **IN only** (PF/UAN/ESI/PT) |
| `employee` | `irdNumber`, `taxCode`, `kiwiSaverRate` | NZ statutory ids | **NZ only** (IRD/PAYE/KiwiSaver) |
| `employee` | `bankName`, `bankAccountMasked`, `ifsc`/`bankBranch` | bank (always masked tail-4) | `ifsc` IN; sort-code/account NZ |
| `comp` | `ctcAnnual`, `basic`, `hra`, `grossMonthly`, `netMonthly`, `da`, `specialAllowance` | comp snapshot (**masked**) | IN: CTC + Basic/HRA/PF/ESI/PT split. NZ: hourly/annual NZD, no HRA |
| `company` | `legalName`, `tradeName`, `addressBlock`, `registeredAddress`, `cin`, `gstin`, `nzbn`, `logoUrl`, `signatoryName`, `signatoryDesignation` | `Business`/`TenantBrand`/entity | IN footer: CIN/GSTIN. NZ footer: NZBN |
| `date` | `today`, `issueDate`, `effectiveDate` | issuance | format by locale (`dd/MM/yyyy`) |
| `letter` | `refNo`, `subject`, `purpose`, `addressee` | issuance | addressee = embassy/bank for proof letters |
| `authority` | `name`, `designation` | `CompanyLetterhead`/template signatory | the pre-signature line |

**Wording variants** are carried by seeding two `LetterTemplate` rows per category (`countryCode='IN'`/`'NZ'`, distinct `bodyMarkdown`) — e.g. India bonafide uses "To Whomsoever It May Concern" + CTC/PF references; NZ employment-proof references IRD/KiwiSaver/Holidays-Act entitlements. The wizard picks the variant matching the employee's entity country.

---

## 8. Slice plan (independently buildable, ordered)

Each slice is shippable and testable on its own. Slices 9A→9B are the foundation; 9C/9D/9E/9F can then proceed in parallel.

### Slice 9A — Schema + RBAC + ref-no plumbing (foundation)
- **Files:** `backend/prisma/schema.prisma` (3 models + 2 enums + 3 back-relations + `SignatureEnvelope.issuedLetterId`), new migration (+ raw-SQL partial-unique indexes), `backend/src/core/lib/rbac.js` (`canManageLetters` + HR-Admin grant), `backend/src/hr/lifecycle/lib/codes.js` (`LETTER` scope + `periodKey` threading).
- **Acceptance:** `prisma migrate` applies clean; partial-unique indexes reject a 2nd default / 2nd per-category letterhead; `allocateCode(tx, {scope:'LETTER', periodKey:'2026-27'})` returns `LTR-0001`, increments atomically, resets across `periodKey`; `effectivePermissions` shows `canManageLetters` for HR-Admin only; existing lifecycle code scopes unchanged.

### Slice 9B — Render engine + merge resolver (pure, no routes)
- **Files:** `backend/package.json` (+`pdf-lib`,`@pdf-lib/fontkit`), `letters/fonts/NotoSans-*.ttf`, `letters/renderLetter.js`, `letters/letterPdfFallback.js`, `letters/mergeFields.js`, unit tests.
- **Acceptance:** `renderLetter` overlays merged body + date/refNo/authority onto a fixture A4 PDF, Y-flip correct, ₹ renders (embedded TTF), long body paginates per both `overflowPolicy` values, signature PNG drawn in its box, output flattens to a valid PDF Buffer; `letterPdfFallback` renders a branded no-letterhead letter; `resolveMergeData` resolves all §8 fields, flags `missingRequired`, masks `comp.*` without `canViewCompensation`; `renderMerge` ignores unknown tokens (no raw echo). All pure — no DB/network.

### Slice 9C — Letterhead manager + visual picker (config)
- **Files:** `letters/controllers/letterheads.controller.js`, `letters/routes/letterheads.routes.js`, mount in `routes/index.js`, `apps/hr-admin/app/letters/letterheads/*` (upload + pdf.js canvas + draggable rects → normalized save), shared `useLetterheadLayout` hook.
- **Acceptance:** upload rejects non-PDF/>10MB/non-A4-warned, stores with measured `pageWidthPt/HeightPt` + server `fileHash`; picker rasterizes page 1, drag/resize 5 zones, save persists normalized [0,1] top-left `layoutJson`; default/per-category binding enforces partial-unique (2nd default ⇒ 409); all tenant-scoped (cross-tenant id ⇒ 404); `canManageLetters` required (others ⇒ 403).

### Slice 9D — Template library + seeds (config)
- **Files:** `letters/controllers/templates.controller.js`, `letters/routes/templates.routes.js`, `letters/templates/seed.js` (IN+NZ for EXPERIENCE/BONAFIDE/EMPLOYMENT_PROOF/SALARY_PROOF/BANK/CONTRACT + CUSTOM scaffold), `apps/hr-admin/app/letters/templates/*` (editor + merge-field inserter + country toggle + live preview).
- **Acceptance:** CRUD + publish/archive tenant-scoped under `canManageLetters`; edit bumps `version`; `isSystem` rows non-deletable; `GET /merge-fields` returns the §8 palette filtered by category/country; seed creates IN+NZ variants with correct statutory wording; live preview round-trips through `POST /preview` (needs 9E preview route — until then, client-only mock).

### Slice 9E — Issue / preview / re-issue / revoke + register (the engine)
- **Files:** `letters/letters.service.js`, `letters/controllers/issuance.controller.js`, `letters/routes/issuance.routes.js`, mount; `apps/hr-admin/app/letters/issue/*` (wizard) + `apps/hr-admin/app/letters/register/*` (table + actions) + per-employee history tab.
- **Acceptance:** `POST /preview` streams a watermarked PDF with no persistence/ref-no; `POST /issue` (in one `$transaction`) mints `ACME/HR/2026/0001`, renders flattened PDF, stores via S3 (inline fallback), writes `IssuedLetter` ISSUED + `EmployeeDocument` `EMPLOYEE_VISIBLE` + audit; missing-required ⇒ 422 with field list; out-of-scope employee ⇒ 404 (not 403); `reissue` mints a new ref + supersede chain (source retained); `revoke` (needs `canManageLetters` + reason) ⇒ VOIDED + ESS notice + audit, ref-no burned; register filters/searches/exports CSV; CONTRACT/`requiresSignature` ⇒ `PENDING_SIGNATURE` envelope, ref-no minted on COMPLETED.

### Slice 9F — ESS My-Letters + DocumentRequest fulfilment + offboarding rewrite
- **Files:** `letters/routes/me-letters.routes.js` + controller, `apps/ess/app/letters/*` (list + download + tamper badge + request form), wire `DocumentRequest.generatedDocumentId` on fulfilment, **rewrite** `offboarding.controller.js:951-1037` `generateLetters` to call `letters.service.issueLetter()` (keep SETTLED gate + elevated override + audit; delete inline HTML).
- **Acceptance:** ESS lists/downloads own ISSUED non-voided letters (self-only, out-of-band ⇒ 404), tamper badge reflects `fileHash`, voided shown struck-through; `POST /requests` creates a `DocumentRequest`; HR issuing against a request sets `generatedDocumentId` + flips status FULFILLED; offboarding relieving/experience now produces a real letterhead PDF with a ref-no via the shared engine; the old `data:text/html` path is gone.

---

## 9. Security & edge cases

- **PDF/image upload:** reuse `validateDocDataUrl` — base64 data-URL only, **10MB cap** (decoded-size pre-check before allocation, DoS guard), **MIME allow-list** (letterhead = `application/pdf`; signature image = PNG/JPG), **server-computed `sha256`** (never trust client `mimeType`/`sizeBytes`). Measure `page.getSize()` on the uploaded letterhead; warn/refuse wildly non-A4 pages. Multi-page letterhead PDFs use page 1 only as the underlay.
- **XSS in templates:** `bodyMarkdown` is **merge-fields-only — no raw HTML/script** (matches `DocumentTemplate`'s documented constraint). The renderer draws **text** via pdf-lib `drawText` (no HTML parsing → no script execution surface). `renderMerge` substitutes only declared allow-list tokens; unknown tokens are flagged, never echoed. The hr-admin editor stores plain text; if any rich preview is added it must escape (no `dangerouslySetInnerHTML` on un-escaped body).
- **Tenant isolation:** every model carries `businessId` + `business @relation(onDelete:Cascade)`; every query is `where:{ businessId }`-scoped; cross-tenant id ⇒ **404**. `s3.uploadDataUrl` keys are `businessId/scope-…` (no cross-tenant key guessing); `isOurUrl` guards download proxying.
- **Authority / SoD:** revoke requires `canManageLetters` (config key), distinct from the `canGenerateLetters` issuer. CONTRACT e-sign reuses the built-in provider's existing SoD (signer ≠ a self-approve loop). The `canApproveLetters` maker/checker queue is reserved for v1.1; the status enum already models `PENDING_*`.
- **Scope (IDOR):** issuance, download, per-employee history all run through `withEmployeeScope` / `attachSelfEmployee`; an out-of-band or other-tenant employee is invisible (404), never a 403 wall (F1 posture). ESS download is self-only.
- **Immutability / audit:** `IssuedLetter` is **never soft-deleted** (legal record); re-issue/void are explicit, audited (append-only `writeAudit`), and `mergeDataJson`/`renderedBody`/`templateVersionAtIssue`/`letterheadHash` freeze the exact issued content. Every issued PDF carries a SHA-256 `fileHash` (tamper badge); e-sign letters add the HMAC-sealed audit cert. Re-issue retains the superseded row; revoke burns the ref-no permanently.
- **Compensation masking:** `comp.*` merge fields resolve to `••••` without `canViewCompensation`; the wizard surfaces a "salary hidden" notice and the issued letter omits/masks the figure (honours F5 disclosure rules).
- **Concurrency:** ref-no minting is atomic inside the issuance `$transaction` (`UPDATE…RETURNING` row-lock + `@@unique` backstop + `@@unique([businessId, referenceNo])`); concurrent issuances cannot collide.
- **Terminated-employee ESS:** download honours the F4 ESS-lockout window (relieving/experience downloadable for the configured grace period post-exit).
