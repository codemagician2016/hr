#!/usr/bin/env bash
# Box-side deploy for DriftHR HMS (staging). Runs on the shared EC2 box as `ubuntu`
# AFTER the tarball is extracted to /home/ubuntu/drifthr-hms. Mirrors the old
# drifthr/sitepresso deploy.sh but ONLY ever touches drifthr-hms-* PM2 apps (--only),
# so the ~25 sibling products on this shared box are never disturbed.
# The Next apps are PREBUILT locally and shipped — we do NOT `next build` here
# (protects siblings from an OOM-kill on a 1GiB-free box).
set -euo pipefail
ROOT=/home/ubuntu/drifthr-hms
cd "$ROOT"
log() { echo "[box-deploy] $*"; }

[ -f "$ROOT/backend/.env" ] || { echo "FATAL: $ROOT/backend/.env missing (set it once via SSM)"; exit 1; }
log "node $(node -v)  pm2 $(pm2 -v 2>/dev/null)"

log "strip mac metadata"
find "$ROOT" \( -name '._*' -o -name '.DS_Store' -o -name '__MACOSX' \) -prune -exec rm -rf {} + 2>/dev/null || true

log "root npm ci (apps + packages workspaces)"
npm ci --no-audit --no-fund 2>&1 | tail -3 || npm install --no-audit --no-fund 2>&1 | tail -3

log "backend npm ci"
cd "$ROOT/backend"
npm ci --no-audit --no-fund 2>&1 | tail -3 || npm install --no-audit --no-fund 2>&1 | tail -3

log "prisma generate"
npx prisma generate 2>&1 | tail -2

# ── schema sync (these DBs are db-push-managed; migrate ledger is intentionally
#    stale so `migrate deploy` fails on drift) ──────────────────────────────────
# db push runs as the APP db user. Past psql-as-postgres migrations left some
# objects postgres-owned, so the app user can't ALTER an enum ("must be owner of
# type ApplicationSource") or CREATE tables. Best-effort realign ownership + grant
# CREATE to the app user first (needs postgres; harmless no-op if unavailable).
# Idempotent — once realigned, future pushes need no superuser step. All guarded
# with `|| true` so a locked-down box never aborts the whole deploy here.
DB=drifthr_hms
APPUSER=$(sudo -u postgres psql -d "$DB" -tAc "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='Attendance'" 2>/dev/null | tr -d '[:space:]' || true)
if [ -n "$APPUSER" ]; then
  sudo -u postgres psql -d "$DB" -tAc "SELECT format('ALTER TABLE %I OWNER TO %I;', tablename, '$APPUSER') FROM pg_tables WHERE schemaname='public' AND tableowner <> '$APPUSER'" 2>/dev/null | sudo -u postgres psql -d "$DB" -q -v ON_ERROR_STOP=0 >/dev/null 2>&1 || true
  sudo -u postgres psql -d "$DB" -tAc "SELECT format('ALTER TYPE %I OWNER TO %I;', t.typname, '$APPUSER') FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e' AND pg_get_userbyid(t.typowner) <> '$APPUSER'" 2>/dev/null | sudo -u postgres psql -d "$DB" -q -v ON_ERROR_STOP=0 >/dev/null 2>&1 || true
  sudo -u postgres psql -d "$DB" -c "GRANT CREATE, USAGE ON SCHEMA public TO \"$APPUSER\";" >/dev/null 2>&1 || true
  log "realigned object ownership + granted CREATE to $APPUSER (best-effort)"
fi

log "prisma db push (additive schema sync; no --accept-data-loss → refuses drops)"
npx prisma db push --skip-generate 2>&1 | tail -14
# ── partial UNIQUE indexes ────────────────────────────────────────────────────
# Prisma's schema language cannot express an index with a WHERE clause, so the
# nine in prisma/sql/partial-indexes.sql exist ONLY in raw SQL — which `db push`
# never executes. Result: on a box only ever deployed this way, none of them are
# present. A prod audit found 1264 indexes and zero partial ones, meaning every
# one of these data-integrity guards was missing on a live system (duplicate
# onboarding journeys per offer, duplicate employees on one work email, duplicate
# active Form 16s, duplicate arrear cycles...). Reapply them after every push.
# Idempotent and non-fatal — see the script header.
log "reapplying partial UNIQUE indexes (db push cannot create them)"
node scripts/apply-partial-indexes.js 2>&1 | tail -20 || log "WARN: partial-index apply failed (non-fatal)"

# realign any table the push created postgres-owned (belt-and-braces).
[ -n "$APPUSER" ] && (sudo -u postgres psql -d "$DB" -tAc "SELECT format('ALTER TABLE %I OWNER TO %I;', tablename, '$APPUSER') FROM pg_tables WHERE schemaname='public' AND tableowner <> '$APPUSER'" 2>/dev/null | sudo -u postgres psql -d "$DB" -q -v ON_ERROR_STOP=0 >/dev/null 2>&1 || true)

# ── one-time backfill: grant the Talent Acquisition add-on to EXISTING tenants so
#    the new entitlement gate doesn't cut off tenants already using recruitment.
#    Sentinel-guarded → runs ONCE; new tenants must buy the add-on. ─────────────
SENTINEL="$ROOT/.talent-addon-backfill.done"
if [ ! -f "$SENTINEL" ]; then
  log "backfill: granting talent_acquisition to existing tenants (one-time)"
  ( set -a; . "$ROOT/backend/.env" 2>/dev/null; set +a
    node -e 'const p=require("./src/core/lib/prisma");(async()=>{const bs=await p.business.findMany({select:{id:true,featureFlags:true}});let n=0;for(const b of bs){const f=(b.featureFlags&&typeof b.featureFlags==="object")?b.featureFlags:{};const a=(f.addOns&&typeof f.addOns==="object")?f.addOns:{};if(a.talent_acquisition===true)continue;a.talent_acquisition=true;await p.business.update({where:{id:b.id},data:{featureFlags:{...f,addOns:a}}});n++;}console.log("[box-deploy] granted talent_acquisition to",n,"tenant(s)");await p.$disconnect();})().catch(e=>console.error("[box-deploy] backfill err:",e.message));'
  ) && touch "$SENTINEL" || true
fi

# ── backfill new permission keys into persisted roles ────────────────────────
# SYSTEM_ROLES is the preset; a tenant's roles are COPIES made at provision time.
# Any feature that adds a permission key leaves existing tenants a key short and
# their admins get an unexplained 403 on the new screen. Additive + idempotent
# (only adds keys a role has never seen), so it is safe on every deploy.
log "sync role permissions (additive backfill)"
( set -a; . "$ROOT/backend/.env" 2>/dev/null; set +a
  node scripts/sync-role-permissions.js 2>&1 | tail -20 ) || log "WARN: role-permission sync failed (non-fatal)"

cd "$ROOT"
APPS="drifthr-hms-backend drifthr-hms-router drifthr-hms-platform drifthr-hms-hr-admin drifthr-hms-ess drifthr-hms-mobile-web"
if [ "${DRIFTHR_ENV:-staging}" = "prod" ]; then
  # Restart only the apps this box actually runs. prod has no mobile-web, and
  # `pm2 restart` hard-fails on an unknown name — under `set -e` that aborted the
  # deploy before `pm2 save`, leaving pm2's saved state stale after a prod ship.
  # (Staging takes the startOrReload path below, which STARTS missing apps by
  # design, so it must not be filtered down to what is already running.)
  RUNNING=""
  for a in $APPS; do
    pm2 describe "$a" >/dev/null 2>&1 && RUNNING="$RUNNING $a"
  done
  [ -n "$RUNNING" ] || { echo "FATAL: no drifthr-hms-* app is running on this prod box"; exit 1; }
  # PROD reload BY NAME so each app keeps its LIVE env/ports exactly (43xx,
  # PLATFORM_DOMAIN=drifthr.com) — no ecosystem config imposed, so there is zero
  # risk of a port/domain drift on production. New code loads from the extracted
  # .next/backend on disk. (There is no prod ecosystem file; the fleet runs from
  # pm2's saved state.)
  # restart (not reload) BY NAME: fork-mode Next apps don't reliably pick up a new
  # .next on `pm2 reload`, so restart to load the fresh build. Each app keeps its
  # LIVE env/ports (43xx / PLATFORM_DOMAIN=drifthr.com) — no ecosystem config imposed.
  log "pm2 restart (prod, by name — loads new build, preserves live env/ports)"
  pm2 restart $RUNNING
else
  # STAGING uses the checked-in config (starts any missing app; siblings untouched).
  log "pm2 startOrReload — ONLY drifthr-hms-* (staging config)"
  pm2 startOrReload deploy/ecosystem.staging.config.js --update-env \
    --only drifthr-hms-backend,drifthr-hms-router,drifthr-hms-platform,drifthr-hms-hr-admin,drifthr-hms-ess,drifthr-hms-mobile-web
fi
pm2 save
log "done — drifthr-hms processes:"
pm2 list | grep -E "drifthr-hms|name" || true
