# Feature 60 — Master Program Phase 4 wave 2: mobile Recognition parity

Second mobile-parity wave. Brings the full Rewards & Recognition loop to the
Flutter app (apps/mobile, served to web at m-<slug>.drifthr.com) as a thin
client over the `/api/hr/me/*` endpoints shipped + E2E-proven in Phase 3
wave 2 (e2e-p3-rnr 26/26). No backend work; mobile-web only, no store pushes.

## What shipped (features/recognition/)
A 5-tab screen + a pushed Give flow:
- **Wall** — recent recognitions (giver→recipients, value/badge chips,
  message, points, own PENDING/REJECTED pill); "Give" FAB → give screen
  (multi-select colleague picker via /me/directory, value/badge from
  /me/recognition/values, points, visibility → POST /me/recognitions; the
  needsApproval amber banner; 409 daily-cap surfaced verbatim).
- **Wallet** — balance card (+₹ shadow, lifetime) + signed ledger
  (/me/wallet, /me/wallet/ledger).
- **Rewards** — catalog grid with affordability/stock gating (/me/catalog) →
  redeem confirm (POST /me/redemptions, insufficient-points verbatim) +
  my-redemptions with cancel-while-pending.
- **Awards** — open cycles (/me/award-cycles) → nominate sheet (single-select
  picker + citation, POST /me/award-nominations) + my nominations {made, won}.
- **Leaderboard** — earners/givers segmented + month/quarter/allTime chips
  (/me/recognition/leaderboard), medals, own row highlighted (floated to top
  if beyond the top 50).

Shared `ColleagueSearchField` (debounced /me/directory, self+leavers excluded
server-side): multi-select for Give (removable chips, excludeIds), single for
Nominate. Selecting a badge prefills pointsEach with its defaultPoints
(mirrors the server). Wired endpoints.dart + routes /recognition +
/recognition/give + More-sheet tile + Home quick-link.

## Verification (mobile gate)
- `flutter analyze lib/` → 0 errors (one pre-existing-style deprecation info,
  consistent with the other form screens).
- `flutter build web --release ...` → succeeded (main.dart.js 3.3M).
- Shipped → m-demo-staging.drifthr.com serves the bundle.
- Underlying APIs carry the passing e2e-p3-rnr suite (26/26) from Phase 3.

## Manual test (m-demo-staging.drifthr.com)
1. More → Recognition → Give → pick a colleague, a value, +10 points → posts
   to the Wall (or shows "manager will approve" if over threshold); a repeat
   to the same colleague shows the daily-cap message.
2. Wallet shows the balance + ledger; Rewards → redeem an affordable item →
   pending → cancel restores the balance.
3. Awards → nominate a colleague with a citation; Leaderboard → toggle
   earners/givers + period, your row is highlighted.

## Next
Mobile wave 3: helpdesk / documents / directory / comp-off. Then Phase 4
workforce backend features (OT pre-approval, open shifts, careers CMS,
variable-pay, loan interest) — fetch-E2E-able backend waves.
