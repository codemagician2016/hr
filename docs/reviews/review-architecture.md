# Adversarial Review — 02-system-architecture.md

**Reviewer role:** Senior skeptic / stress-tester
**Target:** `/Users/kp/docs/02-system-architecture.md`
**Verified against:** `/Users/kp/sitepresso` (read-only), live code, 2026-06-22
**Verdict:** needs-fixes (now corrected in place) — strong, well-grounded doc with a handful of real reuse-claim errors and two material architectural over-claims.

---

## Summary

This is an unusually well-grounded design doc. The overwhelming majority of its file-path and line-number citations are **accurate** against the real Sitepresso tree. The errors I found were of three kinds: (1) a few fabricated/incorrect reuse paths, (2) DB-level guarantees claimed that don't exist in the fork base, and (3) two architectural mechanisms (region routing, queue exactly-once) described as cheaper/stronger than they actually are. All are fixed in place.

---

## What I verified TRUE (grounded in real code)

| Doc claim | Verified |
|---|---|
| 162 Prisma models, 421 `businessId` refs | TRUE — `grep -c` confirms both exactly |
| `Business` L108, `Subscription` L1500, `Customer` L1088, `User` L18 | TRUE |
| Custom-domain fields on Subscription L1568–1587 (`customDomain`, `customDomainVerified`, `customHostnameId`, `customDomainStatus`, `customDomainStatusMessage`, `customDomainCheckedAt`) | TRUE — exact lines |
| `Business` fields: slug L111, slugLastChangedAt L112, country L123, isActive L163, suspendedReason L164, suspendedAt L165, pendingDeletionAt L169, anonymisedAt L170 | TRUE — every line exact |
| `ROUTABLE_CUSTOM_DOMAIN_STATUSES = ['ACTIVE','PENDING_DNS','PENDING_SSL','FAILED']` at customDomainRouting.js L1 | TRUE — verbatim |
| `co.in`/`co.nz`/`com.au` second-level suffix handling, `isLikelyApexDomain`, `customDomainLookupHosts` | TRUE |
| Router fns/lines: RESERVED_SUBDOMAINS L81, ADMIN_HOST_ALLOWED_PREFIXES L679, adminHostLoginRedirectUrl L688, unauthenticatedDashboardRedirectUrl L709, unifiedAdminRedirectUrl L726, tenantNotFoundRoute L577, servePublicMicrocache L235, domainRedirectUrl L463, hasPrivateCookie L103, STOREFRONT_NO_CACHE_PREFIXES L160 | TRUE — all confirmed |
| `x-tenant-host` forwarded on EVERY proxied request (index.js L813–814) | TRUE — verbatim incl. the "on EVERY proxied request" comment |
| `RESERVED_SUBDOMAINS` set contents `www,api,admin,app,mail,platform,m,test` | TRUE |
| auth.middleware: resolveTenantBusinessId L92, authenticateCustomer L207, cross-host 403 guard L244–247, JWT `type==='customer'` check L226 | TRUE — the 403 guard is verbatim |
| **"Sitepresso retired BYO custom-domain lookup at L120; we re-enable it"** | TRUE — the code comment literally says "BYO custom-domain lookup retired 2026-05-10". A subtle, load-bearing, correct claim. |
| internal.routes.js uses `routableCustomDomainWhere(host)` + `findFirst` for host, `findUnique` for slug, writes back via `setTenantVertical` | TRUE |
| `sweepExpiredDeletions` 30-day grace (`GRACE_PERIOD_DAYS = 30`) | TRUE |
| **No BullMQ / no `bull`** in backend deps (only `ioredis`, `node-cron`) | TRUE — the doc's central "queue gap" premise is correct |
| scheduler.js fns: processCustomDomainProvisioning L560, processPaddleWebhookRetries L677, processStripeWebhookRetries L690, initScheduler L941 | TRUE |
| ecosystem.config.js: `sitepresso-backend` (cluster), `sitepresso-scheduler` (fork, `scheduler-worker.js`), `max_memory_restart` discipline | TRUE |
| Customer model is a real isolated principal: businessId L1090, isActive, pendingDeletionAt, anonymisedAt, passwordChangedAt, `@@unique([businessId,email])` L1163 | TRUE — §5.4 reuse claim fully grounded |
| findOwned.js "fetch IFF businessId matches, else 404" | TRUE — exact semantics |
| All billing controllers + libs (razorpay/stripe/paddle controllers, billingLedger, subscriptionMaterializer, subscriptionInvoice, billingAccess, featuresCatalog) | TRUE — all exist |
| wrangler.toml has `ROUTER_CACHE` KV namespace | TRUE |
| Compliance figures spot-checked: ACC max levy $2,741.22 = 1.75% × $156,641 (exact); ESI 4% total; gratuity 15/26; EPS cap ₹1,250 (8.33%×15,000 rounded) | TRUE — arithmetic sound |

---

## What was WRONG — and fixed in place

1. **`packages/i18n` does not exist (factual reuse error).** i18n lives **inside the apps** (`apps/platform/i18n/{config,request}.js`, next-intl), not as a shared package. The doc cited `packages/i18n` as REUSE in the monorepo tree (§1.1), §1.3, and the reuse map (§10).
   - **Fix:** removed `packages/i18n` from the tree; added §1.4 correction note; rewrote the §1.3 and §10 i18n entries to say it is per-app next-intl and any shared package is NEW. Also noted live `SUPPORTED_LOCALES=['en','hi','es','fr','de','it','pt-BR']` (ship en+hi).

2. **`apps/shop-mobile` does not exist (fabricated path).** Only `apps/chat-mobile` (Flutter, `pubspec.yaml` confirmed) exists. Doc referenced "chat-mobile/shop-mobile Flutter pattern" in §1.1 and §13.3.
   - **Fix:** corrected both to reference `apps/chat-mobile` only; logged in §1.4.

3. **`Subscription.customDomain` is NOT `@unique` (false DB guarantee).** §4.4 claimed "Two tenants claim the same domain → Unique constraint on `customDomain`; second claim rejected at bind time." The live schema has no `@unique`/`@@unique` on `customDomain` — it is a plain `String?`. Sitepresso relies on a controller pre-check + Cloudflare per-hostname uniqueness. Presenting a non-existent DB invariant as a security control is exactly the kind of gap that double-binds a domain under a race.
   - **Fix:** rewrote the §4.4 cell to mark this a GAP, require a NEW partial unique index on the `TenantDomain` model, and keep the app-layer + Cloudflare checks as additional layers.

4. **Razorpay reconcile function name imprecision.** Doc cited `reconcileStuckRazorpaySubscriptions` "in scheduler.js L703"; the scheduler task is actually `reconcileStuckRazorpaySubscriptionsTask` (L703), which delegates to `reconcileStuckRazorpaySubscriptions` in `razorpay.controller.js`.
   - **Fix:** corrected both occurrences (§0.5, §7.5).

5. **`Business.vertical` has no `HR` value today.** §2.1 said the router resolves "a fixed `HR` vertical" without noting the enum is currently `'STATIC'|'APPOINTMENT'|'ECOMMERCE'` (default `APPOINTMENT`, L227).
   - **Fix:** added a parenthetical in §2.1 noting we replace the enum domain with `HR` during the fork.

---

## Architectural over-claims corrected (the substantive ones)

6. **Region/data-residency routing was over-claimed (§9.2, §0.6).** The doc said "the backend selects the regional Postgres at the connection layer ... from day one." The fork ships a **single global `PrismaClient` singleton** bound to one `DATABASE_URL`, with a `Proxy` forcing every stray `new PrismaClient()` (≈15 call sites) to return that one instance. A single process cannot transparently switch regional connections.
   - **Fix:** rewrote §9.2 to present the two honest options — **deploy-per-region fleet (recommended for launch)** vs. a single-fleet per-region client map (a real refactor that removes the Proxy). Updated the §0.6 north star to say residency = deploy-per-region, not in-process switching, and that the `region` column must be pinned day one so the split is config not migration.

7. **RLS session-var hazard with pooled connections (§5.3).** The doc proposed `SET app.current_business_id` "per transaction" but didn't flag that the fork uses ONE shared pool — a plain `SET` leaks across pooled connections (a cross-tenant breach worse than no RLS), and PgBouncer transaction-pooling forbids session-level `SET`.
   - **Fix:** rewrote §5.3 item 2 to mandate `SET LOCAL` inside an explicit `prisma.$transaction(...)`, called out the PgBouncer constraint, and noted none of this (no `$extends`, no `$transaction` session-var, no RLS) exists in the fork — it is all NEW.

8. **Prisma scoping extension vs. the singleton/Proxy (§5.3 item 1).** `$extends` returns a *new* client; applied naively it would be bypassed by the Proxy-forced legacy `new PrismaClient()` call sites.
   - **Fix:** added an implementation note: apply `$extends` at the singleton definition and point the Proxy at the extended instance, or stray instantiations bypass scoping.

9. **BullMQ `jobId` is not exactly-once (§7.3) — payroll double-pay risk.** The doc leaned on `payrun:{businessId}:{periodId}` jobId for "exactly-once per (tenant, period)." BullMQ dedups only while the job is active/waiting; after completion/eviction the same jobId re-enqueues. For a money-moving pay run this is the difference between "usually don't double-pay" and "provably can't."
   - **Fix:** added a critical note requiring a DB unique constraint `@@unique([businessId, periodId, sequence])` on `PayRun`, created before enqueue inside a transaction, as the real source of exactly-once; the queue job is just the executor.

---

## Residual risks / open items (not fixed — flagged for the founder)

- **§13.3 Q1 (single multi-region cluster vs. separate stacks)** now has a clear technical answer implied by §9.2: the singleton pushes hard toward deploy-per-region. Recommend committing to that.
- **Custom-domain uniqueness race** (item 3) and **RLS pooling** (item 7) are the top two pre-launch isolation workstreams; both are NEW, neither is inherited.
- Compliance figures (ESI ₹30,000 proposal, Form 16→130 / 24Q→138 renumbering timing) are flagged as effective-date-driven in the rule tables — correct approach; left as-is.

---

## Verdict rationale

The doc earns **needs-fixes** rather than major-gaps: its core thesis (row-level `businessId` isolation, host routing, custom-domain/SSL reuse, BullMQ for pay-run/filing, pure calc packages, versioned rule tables) is sound and its reuse map is ~90% accurate to the real code. But three of the corrected items (customDomain uniqueness, region routing, BullMQ exactly-once) were guarantees stated more strongly than the fork supports — material for a payroll product handling money and PII. With the in-place fixes, the doc is now production-honest.
