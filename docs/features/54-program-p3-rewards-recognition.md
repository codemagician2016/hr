# Feature 54 — Master Program Phase 3 wave 2: Rewards & Recognition

Implements the build-ready spec docs/features/35-rewards-recognition.md — the
peer-driven, points-backed recognition loop layered over four existing
engines: the engagement feed, F10 approvals, F9 letters, and the proven
append-only wallet-ledger pattern.

## What shipped

### The loop
Peer kudos (value-tagged, optional badge, optional points) → optional budget
approval (engine) → points post to an append-only wallet → recognition wall
(feed projection) → nomination awards (committee via engine) → certificate
(F9 letters) + points prize → redemption catalog (fulfilment via engine) →
leaderboards derived from the ledger.

### Data model (11 models + 10 enums)
CompanyValue, RecognitionBadge, Recognition (+announcementId feed link),
PointsWallet + PointsLedgerEntry (version-locked balance, signed entries —
balance ≡ Σ entries), RecognitionBudget (GIVER > DEPT > ENTITY > TENANT
precedence), AwardCycle (+committeeUserIds), AwardNomination, RewardCatalogItem
(taxable perquisite flag), Redemption. Three new WorkflowModules:
RECOGNITION / AWARD / REDEMPTION — 20 of 20 modules now consumer-registered.

### Engine integration (behaviour-preserving defaults)
- RECOGNITION → giver's manager, but the domain only opens a request when
  points exceed the tenant threshold or breach budget (default threshold null
  = never routes; pure kudos always instant).
- AWARD → HR fallback; the per-cycle committee is pinned post-open as a
  parallel all-of level (minApprovals = committee size); requester = nominee
  so engine SoD blocks self-approval.
- REDEMPTION → HR (the fulfilment desk holds canFulfilRedemptions);
  redemptionRequiresApproval=false flips to inline auto-approve.

### India-first economics
Points carry an optional ₹ rate (pointsToInrRate; 0 = pure-kudos program);
catalog leans on perks (comp-off day via F30 mint, WFH day, vouchers, charity);
taxable-perk redemptions are flagged and an FY report totals per-employee
perquisite value (Section 17(2) gifts-rule awareness; no TDS computation v1).

### Ledger discipline
Every credit/debit is one signed ledger row through a single chokepoint
(version-locked, fail-closed debit, race-retried). FIFO points expiry runs
nightly 03:40 (one negative EXPIRY row, idempotent); award-cycle lifecycle
06:50 (window flips + certificate catch-up). 89 unit checks (ledger 38 incl.
overspend-race refusal; budget 30; leaderboard 21).

### Config & seeds
Program switches on Business.featureFlags.recognition (F45 idiom):
approvalPointsThreshold, redemptionRequiresApproval, pointsToInrRate,
pointsExpiryMonths. Idempotent per-tenant seeds (5 India-first values,
5 badges, 6 catalog items, RNR-AWARD-CERT letter template) via
/seed-defaults + lazy first-use.

### APIs
Admin `/api/hr/recognition/*` (canManageRecognition; fulfil under
canFulfilRedemptions): config, values, badges, budgets, catalog, award
cycles (+shortlist/decide/close), redemptions queue + fulfil, points/adjust,
leaderboard + taxable-perks reports, seed-defaults. ESS `/api/hr/me/*`:
give/list recognitions, wallet + ledger, award cycles + nominations,
catalog + redemptions (+cancel), leaderboard. Approvals ride the existing
F10 inboxes — no new approval endpoints. 7 notification templates
(tenant-editable per P1.6).

### UIs
hr-admin `/recognition` (Program / Budgets / Catalog / Awards / Redemptions /
Leaderboard tabs); ESS `/recognition` (Wall + give modal, wallet + ledger,
rewards catalog + redeem, award nominations).

## Manual test (staging)
1. ESS → Recognition → Give: pick a colleague, value, message (+10 points) →
   appears on the wall; wallet ledger shows the credit.
2. Redeem a catalog item → redemption pends (HR approval default) → admin
   Redemptions queue → approve via inbox → Fulfil with a voucher code.
3. Awards: create a cycle with a committee → ESS nominate with citation →
   shortlist → decide → committee approval → winner gets certificate + prize.
4. Set approvalPointsThreshold=5 → a 10-point give now says "manager will
   approve the points first" and the wallet stays unchanged until approved.

## E2E evidence
`qa/e2e/e2e-p3-rnr.js` on live staging: seeded values/catalog, pure kudos +
points kudos (instant below threshold), wall listing, admin points adjust →
wallet balance + ledger row, redemption request + cancel (balance intact),
ESS leaderboard, award cycle → ESS nomination → shortlist → decide, config
patch roundtrip, cleanup (points adjusted back, cycle closed).
Unit: pointsLedger 38 + budget 30 + leaderboard 21 = 89/89.
