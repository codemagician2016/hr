# STATE — Resume Guide

White-label **HRMS & Payroll SaaS** (multi-tenant, India + New Zealand), forked from Sitepresso.
**To resume: open this project and say "continue". Read this file + ROADMAP.md + docs/.**

## Where we are (2026-06-22)
- **Repo:** branch `development` pushed to `github.com/codemagician2016/hr`. `staging`/`main` are LOCAL only — **push to `development` only** until domains are provided.
- **Plan:** elite-team workflow wrote production-grade specs in `docs/` (`00-18` + `reviews/`). `docs/README.md` (index) + `docs/19-delivery-plan.md` may be pending if the run was interrupted — regenerate if missing.
- **Build (Phase 0, in progress):** forked reusable Sitepresso layers:
  - `apps/`: `platform` (super-admin), `router` (tenant + custom-domain routing)
  - `packages/`: `ui`, `admin-core`, `theme-engine`, `types`
  - `backend/src/`: `core`, `domains`, `superadmin`, `i18n`, `lib` (website/chat/qa verticals stripped)

## KNOWN WIP (not yet building — fix on resume)
- `backend/src/index.js` has ~34 refs to removed modules (booking/shop/web).
- root `package.json` workspaces still list website verticals.
- Prisma schema still has website/commerce models.

## Next steps (Phase 0 → full product, NO MVP)
1. Read `ROADMAP.md`, `docs/19-delivery-plan.md`, `docs/17-reuse-map.md`, `docs/02-system-architecture.md`, `docs/03-data-model.md`.
2. Rewire fork: clean `backend/src/index.js`, update `package.json` workspaces + `turbo.json`.
3. Slim `theme-engine` to ~5 fixed styles (delete profession-theme catalog).
4. Prisma: drop website/commerce models; add HR models per `docs/03-data-model.md`; migrate.
5. Scaffold HR vertical: `apps/hr/{admin,employee}`, `backend/src/hr/*`, HR vertical enum, router ports.
6. Wire signup → company-setup wizard → branded tenant portal smoke test.
7. Build modules (Phase 1+), payroll engine + IN/NZ compliance (Phase 2/3) with golden-dataset QA.
