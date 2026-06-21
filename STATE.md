# STATE — Resume Guide

White-label **HRMS & Payroll SaaS** (multi-tenant, India + New Zealand), forked from Sitepresso.
**To resume: open this project and say "continue". Read this file + ROADMAP.md + docs/19-delivery-plan.md + docs/17-reuse-map.md.**

## Where we are (updated 2026-06-22, commit 7da3ce3)
- **Repo:** branch `development` pushed to `github.com/codemagician2016/hr`. `staging`/`main` LOCAL only — **push to `development` only** until domains provided.
- **Plan:** complete + verified in `docs/` (`00-18` specs + `reviews/` + `README.md` index + `19-delivery-plan.md`). The delivery plan defines 6 correctness-gated phases (P0 Foundation → P1 Core HR → P2 IN Payroll → P3 NZ Payroll → P4 Polish → P5 Talent).

## DONE (Phase 0)
- ✅ Forked reusable Sitepresso layers: `apps/{platform,router}`, `packages/{ui,admin-core,theme-engine,types}`, `backend/src/{core,domains,superadmin,i18n,lib}`. Website/commerce/chat/qa verticals NOT copied / deleted.
- ✅ Scope rename `@sitepresso/*` → `@hr/*` (30 files, 0 remaining).
- ✅ `backend/src/index.js` rewired: all booking/shop/web/qa vertical routes removed; SaaS substrate kept (auth, tenant, billing, subscription, notifications, rbac, upload, locale, geo, integrations, ai). Parses clean, **0 dangling vertical imports**. `PLATFORM_DOMAIN` → `hr.com`.
- ✅ Root `package.json` → name `hr-platform`, workspaces `apps/*`+`packages/*`, vertical scripts dropped.

## NEXT (Phase 0 remaining — ordered)
1. **Router rewire** (`apps/router/index.js`): collapse `PUBLIC_PORTS`/`SUB_APP_PORTS`/`CUSTOMER_PATHS` (booking/shop/web) + the `resolveRoute` decision tree to 3 HR surfaces per `docs/17-reuse-map.md` §3.2 — PLATFORM_PORT=3000 (hr.com + admin.hr.com), HR_ADMIN_PORT=3010 (app.hr.com), ESS_PORT=3020 (`<slug>.hr.com`/custom domain). Add `hr` to `RESERVED_SUBDOMAINS`. Re-enable custom-domain lookup (§3.3). *Full tree rewire — do carefully, not partial.*
2. **`apps/platform` ecom decouple**: remove broken `@hr/ecom-ui` dep (`apps/platform/package.json`, `next.config.js` transpilePackages, delete `apps/platform/components/ecom-ui/` shims) + strip ecom/booking admin-shell tabs so platform installs/builds.
3. **theme-engine slim** to 5 fixed styles: delete `profession-registry.mjs`/`profession-styles.mjs`, keep engine (compose/registry); `StoreBrand`→`TenantBrand` (logo + 1 color + styleKey + domain). Per `docs/17` §8.
4. **auth + RBAC** (`docs/17` §2.1–2.2): strip vertical auto-role provisioning from `core/middleware/auth.middleware.js`, add `ensureDefaultHrRole`; replace `core/lib/rbac.js` PERMISSIONS catalog + presets with HR set (Owner/HR-Admin/Finance/Manager/Employee).
5. **billing trim** (`docs/17` §2.3): trim `core/lib/billing/gatewayRouter.js` to SaaS-subscription half (delete buyer-side payments/stripeConnect); confirm IN→Razorpay/INR, NZ→Stripe/NZD, RoW→Paddle survive; reseed `PricingTier`/`TierFeature` as HR plans (Starter/Growth/Enterprise).
6. **Prisma HR models** (`docs/03-data-model.md`, ~74 models): mine schema *shapes* from booking (`StaffLeave`,`BusinessHoliday`,`StaffSchedule`) + shop (`EcomRolePermissionGrant`,`BusinessLocation`); add HR models (Employee, Org, SalaryStructure, PayRun, LeaveLedger, AttendancePayInput, StatutoryProfile IN/NZ…); pin `region` column day-one; migrate.
7. **Scaffold** `apps/hr-admin` (app.hr.com), `apps/ess` (tenant.com), `backend/src/hr/*` from the `(unified-admin)` + customer-sub-app shells.
8. **Cosmetic**: replace remaining 47 `@sitepresso` brand/email refs (legal pages, pricing/demo seeds) during content rebrand.

## P0-gating founder decisions (defaulting per plan unless told otherwise)
- #5 Employee identity → **new `Employee` model** (reuse only auth columns from `Customer`).
- #6 Data residency → **pin `region` column** day-one (IN `ap-south-1`, NZ `ap-southeast-2`).
- #4 Multi-entity → **one tenant = one billing account, multiple legal entities/pay-groups**.
- Full ~20-decision list: `docs/README.md` §4.

## Build discipline
- Make incremental, **committed** progress (session limits can cut off mid-task). Commit + push to `development` after each coherent step.
- Verify edits statically (`node --check`) before commit; full `turbo build` deferred until platform ecom-decouple done.
