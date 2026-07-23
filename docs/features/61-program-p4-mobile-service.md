# Feature 61 — Master Program Phase 4 wave 3: mobile service parity (Helpdesk · Documents · Directory · Comp-off)

Third and final mobile-parity wave — completes the high-value ESS→mobile
coverage. Four Flutter screens (apps/mobile), thin clients over existing
`/api/hr/me/*` endpoints; mobile-web only, no store pushes.

## What shipped (apps/mobile/lib/features)
- **Helpdesk** — list (status pills, SLA-breach flag) + Raise FAB (category
  from /me/helpdesk/reference, subject/description/priority) + detail thread
  (reply, reopen, rate 1-5) over /me/helpdesk/tickets. Statuses OPEN/
  IN_PROGRESS/WAITING_ON_EMPLOYEE/RESOLVED/CLOSED/REOPENED gate the actions.
- **Documents** — /me/documents list (category, expiry/expiring flags,
  signature status); tap opens the file via a generalized openFileUrl()
  (decodes inline data URLs, fetches http(s) URLs). Note: docs expose a
  `fileUrl` (S3 or inline) rather than an authenticated /:id/download route —
  a private non-presigned S3 URL is the one case that can't open without a
  future backend download endpoint (surfaced as a friendly message).
- **Directory** — debounced /me/directory search + profile detail (entity/
  location/manager/reports, privacy-respecting fields) + my contact-visibility
  preferences (GET/PATCH /me/directory/preferences).
- **Comp-off** — read-only balance (/me/comp-off/balance) + credit lots with
  expiry (/me/comp-off/credits); "Apply" routes to /leave (availing a comp-off
  is a leave request on the COMP_OFF type, matching the backend flow).

Wired endpoints.dart + 7 routes + 4 More-sheet tiles + Helpdesk/Directory home
quick-links. Generalized the PDF/file openers (openPdfBytes gained an optional
mime param; new openFileUrl) — backward compatible.

## Verification (mobile gate)
- flutter analyze lib/ → 0 errors (only pre-existing app-wide style lints; the
  two my code introduced were fixed).
- flutter build web --release ... → succeeded (main.dart.js 3.4M).
- Shipped → m-demo-staging.drifthr.com serves the bundle.
- Underlying /me/helpdesk|documents|directory|comp-off endpoints are the same
  ones the ESS web app uses (unchanged, already in production).

## Manual test (m-demo-staging.drifthr.com)
1. More → Helpdesk → Raise a ticket → reply on the thread → (when resolved)
   rate it.
2. More → Documents → tap a doc → it opens/downloads.
3. More → Directory → search a colleague → open their profile; toggle your own
   phone visibility.
4. More → Comp-off → balance + credit lots with expiry; Apply → /leave.

## Mobile parity status
The Flutter app now covers: home, attendance (+face), leave, approvals,
profile, compensation, tax projection, payslips, letters, expenses (from
before) + **feed/social, notifications, surveys, recognition, helpdesk,
documents, directory, comp-off** (Phase 4 waves 1-3). Remaining ESS-only
(lower mobile value): performance, learning, shifts/swaps, separation, FBP,
tax declaration/proofs, onboarding, team/manager, careers — candidates for a
future pass. Phase 4 now pivots to the **workforce backend features**.
