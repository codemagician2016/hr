# Feature 63 — Master Program Phase 4 workforce wave B: Careers CMS

Turns the public careers portal from a hardcoded jobs board into a
tenant-editable page. Audit build-order #3 (small).

## What shipped
- **CareersPage** model (one per tenant, businessId @unique): headline,
  subheadline, aboutHtml, cultureHtml, heroImageUrl, customSectionsJson
  ([{title,bodyHtml,order}]), socialLinksJson, perksJson, isPublished,
  brandId (soft ref — no FK, deleting a brand never orphans the page).
- Admin CRUD (/api/hr/recruitment, canManageHiring): GET (page or empty
  default), PUT (upsert, never touches isPublished), publish / unpublish.
- **Public board surface**: the unauth GET /api/public/careers/:slug now
  returns `page` (content-only, **null unless isPublished**) + `brand`
  (logo/colors/footer from the active TenantBrand) alongside jobs — the
  frontend falls back to today's copy when either is null.
- **HTML safety (defence-in-depth)**: aboutHtml/cultureHtml/customSection
  bodies are sanitized ON WRITE — a tag allowlist drops
  script/iframe/object/embed/style with their content, strips every on*
  handler, and neutralizes javascript:/vbscript:/non-image data: URLs even
  after entity/whitespace de-obfuscation. The public render trusts the stored
  (already-sanitized) HTML. Regex allowlist for v1; sanitize-html/DOMPurify
  noted as the production upgrade.
- **Draft-leak guarantee**: the public projection returns null unless
  published and emits only the 8 content fields — never isPublished, brandId,
  updatedByUserId, or ids.

## UI
- Settings → Careers page: form (headline/subheadline/hero + About/Culture
  rich text + custom sections with reorder + social links + perks), Save
  (PUT) vs Publish/Unpublish (separate control, Draft/Published badge), a
  Preview link to /careers/<slug>.
- Public careers page renders the brand (logo/colors/footer) + published page
  (hero, about, culture, custom sections, perks, social) with an exact
  fallback to today's hardcoded copy when no CMS page is published (non-
  breaking for existing tenants). Jobs list + apply untouched.

## Manual test (staging)
1. Settings → Careers page → fill headline + About (paste some HTML incl. a
   <script> — it's stripped on save) → Save → Publish.
2. Open /careers/demo → the published headline/about + tenant brand render;
   Unpublish → the page reverts to the default board copy.

## E2E evidence
`qa/e2e/e2e-p4-careers.js` on live staging: empty-default GET, upsert with a
hostile `<script>`/`onclick`/`javascript:` payload → sanitized on write (tags
stripped, text kept), draft NOT on the public board (page:null), publish →
content appears with no draft-only fields leaked, unpublish → hidden again,
cleanup. Units: careersPage 52 (sanitizer + public projection + draft-leak).
