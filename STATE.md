> **ACTIVE PROGRAM (2026-07-21): the 5-phase "fully custom & dynamic" build is IN PROGRESS.**
> Session-resume source of truth: `/Users/kp/.claude/projects/-Users-kp-hr/memory/master-custom-program.md`
> (RESUME PROTOCOL at the top) + the locked plan `docs/MASTER-PLAN-CUSTOM-DYNAMIC.md` + per-wave docs
> `docs/features/46-52`. Phase 1 ✅ (commits 70ac4cb…0861d6e) · Phase 2 Wave A ✅ (cd6ce6a) ·
> Wave 2B built/deployed, commit pending E2E. The sections below describe the ORIGINAL pre-staging build.

# STATE — DriftHR (Release Candidate)

**DriftHR** — "Effortless HR & payroll." Multi-tenant, white-label HRMS & Payroll SaaS (India 🇮🇳 + New Zealand 🇳🇿), forked from Sitepresso. Brand: teal `#16B6A6` / ink `#16243B`, Manrope. Kit in `drifthr-brand-kit/`.
**Repo:** branch `development` on `github.com/codemagician2016/hr` (push to `development` only until staging domains are provided). **42 commits.**

## Status: RELEASE CANDIDATE — every sandbox-verifiable gate is GREEN
Run the full sweep any time (≈ what CI should gate on):
- `cd backend && npx prisma validate` → valid
- `node backend/test/boot.test.js` → app require-graph resolves (server boots)
- payroll golden: `node backend/src/hr/payroll/__tests__/india.golden.test.js` (120/120) + `nz.golden.test.js` (63/63) + `orchestration.test.js` (26/26) + `filing/__tests__/filing.test.js`
- `node backend/src/hr/integrations/accounting.test.js` (GL balanced) · `node --test backend/src/hr/reports/aggregations.test.js` (9/9) · talent offer 50%-rule
- LIVE-DB (isolated `hr_test` schema): isolation IDOR 15/15 + full e2e 71/71 (build URL = DATABASE_URL + `?schema=hr_test`)
- 3 web apps `next build` exit 0 (hr-admin, ess, platform); mobile (apps/hr-mobile) needs Expo toolchain.

## Local DB (testing only)
No CREATEDB rights here, so tests use an **isolated `hr_test` schema inside `sitepresso_local`** (public schema untouched). Already migrated (`prisma db push`) + seeded (`backend/prisma/seed-hr.js`: demo tenant, IN+NZ entities, 5 employees, 2 pay runs). Real IN+NZ pay runs COMPUTE correctly end-to-end against it.

## What exists
- **Backend** (`backend/src`): core (auth/RBAC/billing/notifications/domains), HR API `/api/hr/*` (employees, org, leave, attendance, compensation, documents, assets, expenses, loans, **payroll** run→payslip→filing, recruitment, performance, reports, integrations), super-admin, audit log, rate limits, webhooks, public API. Boots clean.
- **Payroll**: pure engine (integer minor units) + IN (TDS/§87A/EPF/ESI/PT-13-states/gratuity/BALANCING) + NZ (PAYE/KiwiSaver/ESCT/ACC/student-loan/**Holidays Act**) + filing (ECR/ESIC/24Q · EI/bank). Golden-tested + real-DB-proven.
- **Frontends**: `apps/hr-admin` (HR console, all modules), `apps/ess` (white-label ESS), `apps/platform` (marketing + super-admin + onboarding), `apps/hr-mobile` (Expo scaffold). DriftHR-branded, WCAG pass.
- **Data**: 236 Prisma models, `prisma validate` clean, baseline migration `backend/prisma/migrations/00000000000000_init` (234 tables).

## Remaining = STAGING GATE (needs infra — cannot run in this sandbox)
1. Provision real Postgres → `cd backend && npx prisma migrate deploy` → `npm run prisma:seed:hr` (or real onboarding).
2. Deploy backend (PM2/container) + the 3 Next apps; set env (DATABASE_URL, gateway keys, Cloudflare-for-SaaS, SES, JWT, PLATFORM_DOMAIN=the real domain).
3. Wire the router host map to the real domains (admin/app/tenant); custom-domain binding (Cloudflare-for-SaaS) live test.
4. Live: gateway sandboxes (Razorpay IN / Stripe NZ / Paddle RoW), IRD payday-filing + EPFO/ESIC submission, accounting (Xero/Tally/Zoho).
5. `expo` build the mobile app; load test (10k-employee pay run); external pen-test; legal sign-off (Holidays Act citations, IN labour-code).

## Founder decisions still open: `docs/README.md` §4 (pricing points, payout depth, FBT scope, regions).
