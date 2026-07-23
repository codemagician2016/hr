# Feature 59 — Master Program Phase 4 wave 1: mobile engagement parity (Feed · Notifications · Surveys)

First Phase-4 (mobile parity) wave. The Flutter app (apps/mobile, served to
web at m-<slug>.drifthr.com) already covered home / attendance / leave /
approvals / profile / compensation / payslips / letters / expenses / tax —
this adds the top-ranked missing engagement surfaces, each a thin client over
`/api/hr/me/*` endpoints already shipped and E2E-proven in Phase 3. No backend
work; **mobile-web only, no store pushes.**

## What shipped (Flutter, apps/mobile/lib)

### Feed + social (features/feed/)
- Paginated engagement wall (pinned-first, pull-to-refresh + scroll load-more),
  unread styling, per-card reaction bar (👍🎉🙌💡❤️, single reaction per
  person, tap to set/replace/clear via PUT/DELETE), comment count, optional
  celebrations strip.
- Post detail: full body, reaction bar, threaded (one-level) comments with
  edit/delete on own, marks-read-on-open, and an @mention composer — typing
  `@` fires a debounced `/me/directory?q=` lookup and inserts the backend's
  `@[Name]` bracket form (resolved server-side).

### Notifications (features/notifications/)
- Inbox over the P3 notification layer: type-aware labels (FEED_MENTION
  "mentioned you", FEED_COMMENT "commented", generic others), tap →
  mark-read + jump to feed, "Mark all read", graceful `unlinked` empty state.
- A bell with an unread `Badge.count` in the home app bar (invalidated on
  refresh), mirroring the existing approvals-badge pattern.

### Surveys (features/surveys/)
- Open-pulse list with Done/Pending/Dismissed chips + anonymity lock note.
- Per-type fill form (number pills for SCALE/LIKERT, 0–10 for NPS, radio
  SINGLE, checkbox MULTI +Other, textarea TEXT, required markers) → submit
  returns a receipt thank-you; dismiss; verbatim 422 (missing required) / 409
  (already submitted).

## Wiring
- endpoints.dart: directory, feed (+reaction/comments/read/read-all/
  unread-count/celebrations), notifications (+unread/read/read-all), surveys
  (+detail/submit/dismiss).
- Routes /feed, /feed/:id, /notifications, /surveys, /surveys/:occurrenceId
  (parentNavigatorKey _rootKey); More-sheet tiles for all three; a Feed
  quick-link + notification bell on Home.
- X-Tenant-Host + cookie/Bearer auth are automatic via the existing dio
  interceptor; live FutureProviders + pull-to-refresh (no offline cache), no
  l10n — matching the app's conventions.

## Verification (the mobile-wave gate)
A Flutter-web app is a CanvasKit surface, not DOM forms, so it can't be
fetch-E2E'd like the web apps. The gate is therefore:
- `flutter analyze lib/` → **0 errors** (only pre-existing framework
  deprecation infos).
- `flutter build web --release --dart-define=API_URL= --dart-define=
  PLATFORM_DOMAIN=staging.drifthr.com` → **succeeds** (exactly what
  ship-staging.sh runs) → served at m-demo-staging.drifthr.com.
- The underlying `/api/hr/me/engagement/feed|surveys` + `/me/notifications` +
  `/me/recognition` + `/me/directory` endpoints already carry passing live
  E2Es from Phase 3 waves 1/5/6 (qa/e2e/e2e-p3-surveys.js, e2e-p3-feed.js).

## Manual test (m-demo-staging.drifthr.com, mobile browser)
1. Log in (org ID `demo`, Priya) → Home shows the Feed quick-link + a bell.
2. Feed → react to a post; open one → comment with `@` (pick a colleague from
   the suggestion list) → the mention resolves; reply nests; edit shows
   "(edited)".
3. Bell → the inbox lists notifications; tap one → jumps to the feed; mark all
   read clears the badge.
4. Surveys → open a pulse → fill (pills/radio/text) → submit → receipt; the
   chip flips to Done.

## Next mobile waves
Recognition (give/wallet/leaderboard/redeem/nominate); then helpdesk /
documents / directory / comp-off. All thin clients over shipped `/me/*` APIs.
