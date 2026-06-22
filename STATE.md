# STATE — Resume Guide

White-label **HRMS & Payroll SaaS** (multi-tenant, India + New Zealand), forked from Sitepresso.
**To resume: open this project and say "continue". Read this file + ROADMAP.md + docs/19-delivery-plan.md + docs/17-reuse-map.md.**

## Where we are (updated 2026-06-22, HEAD aec53d6)
- **Repo:** branch `development` pushed to `github.com/codemagician2016/hr`. `staging`/`main` LOCAL only — **push to `development` only** until domains provided.
- **Plan:** complete + verified in `docs/` (`00-18` + `reviews/` + `README.md` + `19-delivery-plan.md`). 6 correctness-gated phases (P0 Foundation → P1 Core HR → P2 IN Payroll → P3 NZ Payroll → P4 Polish → P5 Talent).

## DONE — Phase 0 fork is coherent (the SaaS substrate is rewired & loadable)
- ✅ Forked reusable layers: `apps/{platform,router}`, `packages/{ui,admin-core,theme-engine,types}`, `backend/src/{core,domains,superadmin,i18n,lib}`.
- ✅ Scope rename `@sitepresso/*`→`@hr/*`. Root `package.json`→`hr-platform`, workspaces `apps/*`+`packages/*`. `PLATFORM_DOMAIN`→`hr.com`.
- ✅ **Backend de-verticalized**: deleted ecom storefront/buyer-payments/coupon routes; trimmed business/customer/subscription routes; rewired `tenant.controller` theme to `@hr/theme-engine`. **0 requires to deleted verticals; all 239 backend/src files parse.**
- ✅ **Router** (`apps/router/index.js` + `cloudflare-worker.js`) → 3 HR surfaces: admin.hr.com→3000, app.hr.com→3010, hr.com→3000, `<slug>.hr.com`/custom-domain→ESS 3020. Host→tenant + custom-domain + microcache preserved.
- ✅ **`apps/platform`** decoupled from deleted `@hr/ecom-ui` (shims + 14 ecom tabs removed; admin-shell cleaned).
- ✅ **auth/RBAC** → 15 HR permissions + presets Owner/HR-Admin/Finance/Manager; `ensureDefaultHrRole`.
- ✅ **White-label theming** → 5 fixed styles × 12 curated colors; per-tenant `{styleKey,colorKey,logoUrl}`; `HR` added to `@hr/types` VERTICALS.

## NEXT — ordered
1. **HR Prisma models** (`docs/03-data-model.md`, ~74 models) — THE P1 foundation, IN PROGRESS. Add Employee, Org/LegalEntity, Compensation/PayComponent, PayRun/PayRunLine/Payslip, LeaveLedger/LeavePolicy/LeaveRequest, Attendance/Shift/AttendancePayInput, StatutoryProfile (IN: PAN/UAN/PF/ESI/PT; NZ: IRD/KiwiSaver/taxCode), Document, Asset, etc. Tenant-scoped by `businessId`; money `Decimal`/`BigInt` (never Int); effective-dated; pin `region` column. Brand fields (`styleKey`,`colorKey`,`logoUrl`) for the theme resolver. Mine shapes from booking/shop. KEEP existing vertical models for now (surviving code still refs `prisma.appointment` etc.).
2. **Scaffold** `apps/hr-admin` (app.hr.com), `apps/ess` (tenant.com), `backend/src/hr/*` from the `(unified-admin)` + customer-sub-app shells.
3. **billing trim**: remove now-dead buyer-side fns from `core/lib/billing/gatewayRouter.js`; reseed `PricingTier`/`TierFeature` as HR plans (Starter/Growth/Enterprise).
4. **Cosmetic**: rebrand remaining `@sitepresso` content (legal pages, pricing/demo seeds).

## Follow-up TODOs (flagged by fork passes — backlog)
- **AdminCoupon (SaaS promo codes) is DARK** — its controller was in deleted `booking/`; re-home `adminCoupon.controller.js` into `core/controllers/` + re-register `/api/admin/subscription-coupons` (reuse-map §2.3.1 = REUSE). TODO markers in `subscription.routes.js` + `index.js`.
- **Custom-domain re-enable** in backend (`resolveTenantBusinessId`/`routableCustomDomainWhere` retired 2026-05-10) for white-label ESS.
- **Router internal endpoint**: rename `/api/internal/tenant-vertical` → vertical-agnostic existence probe; update both router files' call sites (NOTE-FOR-LEAD markers left).
- **Dead vertical surface**: remove `customer.routes.js` appointment/matters routes + vertical Prisma models (Appointment/Product/Order) when HR routes land.
- **Deploy-time**: cloudflare-worker Vercel project names + `wrangler` zone (`hr.com`); decide `qa-portal` passthrough.

## P0/P1 founder decisions (defaulting per plan unless told otherwise)
- #5 Employee identity → **new `Employee` model** (auth columns only from Customer).
- #6 Data residency → **pin `region` column** (IN `ap-south-1`, NZ `ap-southeast-2`).
- #4 Multi-entity → **one tenant = one billing account, multiple legal entities/pay-groups**.
- Full ~20-decision list: `docs/README.md` §4.

## Build discipline
- Incremental, **committed** progress (session limits cut off mid-task). Commit + push to `development` after each coherent step.
- Verify statically (`node --check`); full `turbo build` / `prisma validate` deferred until `npm install` (node_modules absent in this checkout).
