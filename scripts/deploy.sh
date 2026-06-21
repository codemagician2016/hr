#!/bin/bash
# Box-side deploy — runs AFTER a tarball is extracted over the repo dir.
#
# Replaces the old git-pull / Vercel / BACKEND-ONLY script. That script could not
# run on the current boxes (they are tarball-extracted, no .git → `git fetch`
# fatals) and, worse, it *pruned* the frontend PM2 processes — so storefronts +
# all staff/customer sub-apps silently went missing (the tenant-502 root cause).
#
# This deploy builds + reloads the WHOLE fleet declared in ecosystem.config.js,
# applies DB migrations, and gates on a health smoke test.
#
# Per DEPLOY_POLICY.md the operator runs, from local:
#   git archive --format=tar.gz -o /tmp/sp.tgz <branch>
#   aws s3 cp /tmp/sp.tgz s3://sp-deploy-624517878372/sp-<branch>.tgz
#   # then SSM the box to: backup → extract over $REPO → run THIS script as ubuntu:
#   sudo -u ubuntu -H ENV_LABEL=<staging|prod> bash $REPO/scripts/deploy.sh
#
# Env:
#   ENV_LABEL  staging | prod   (prod reloads sp-router with --env production so
#                                PLATFORM_DOMAIN=sitepresso.com)
#   REPO       repo dir (default /home/ubuntu/sitepresso)
#   FORCE_DEPS=1   run `npm ci` even if node_modules/package manifests look current
#
# NOTE: run as the `ubuntu` user (owns PM2 + the repo). Not `set -e`: we handle
# errors explicitly so the health gate always reports.

set -uo pipefail

REPO="${REPO:-/home/ubuntu/sitepresso}"
ENV_LABEL="${ENV_LABEL:-staging}"
export ENV_LABEL
LOG="/home/ubuntu/sitepresso-deploy.log"

log() { echo "$(date -Is) [${ENV_LABEL}] $*" | tee -a "$LOG"; }
fatal() { log "FATAL: $*"; exit 1; }

hash_files() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

dependency_fingerprint() {
  {
    [ -f package-lock.json ] && hash_files package-lock.json
    # backend is a STANDALONE npm project (not a root workspace) with its own
    # lockfile — include it so a backend-only dependency change flips the hash.
    [ -f backend/package-lock.json ] && hash_files backend/package-lock.json
    find . \( -name node_modules -o -name .next -o -name .turbo -o -name build -o -name dist -o -name coverage \) -type d -prune -o -name package.json -type f -print | sort | while IFS= read -r file; do
      hash_files "$file"
    done
  } | hash_files | awk '{print $1}'
}

cd "$REPO" || fatal "repo dir $REPO not found"
[ -f ecosystem.config.js ] || fatal "ecosystem.config.js missing — extract the tarball first"
START=$(date +%s)
log "===== deploy start ($REPO, commit $(cat .build-commit 2>/dev/null || echo '?')) ====="

# Standalone owned-product URLs used by Next builds and PM2 runtime. The
# AapkaRider console reads these in server components, but Next also snapshots
# NEXT_PUBLIC_* during build, so export them before the Turbo build.
if [ "$ENV_LABEL" = "prod" ]; then
  export AAPKARIDER_PUBLIC_URL="https://rider-api.sitepresso.com"
  export AAPKARIDER_CONSOLE_URL="https://rider.sitepresso.com"
  export NEXT_PUBLIC_AAPKARIDER_API_URL="https://rider-api.sitepresso.com"
else
  export AAPKARIDER_PUBLIC_URL="https://rider-api.aapkatech.com"
  export AAPKARIDER_CONSOLE_URL="https://rider.aapkatech.com"
  export NEXT_PUBLIC_AAPKARIDER_API_URL="https://rider-api.aapkatech.com"
fi
export AAPKARIDER_API_URL="http://127.0.0.1:3700"
export AAPKARIDER_WORKSPACE_ID="${AAPKARIDER_WORKSPACE_ID:-demo}"
export NEXT_PUBLIC_AAPKARIDER_WORKSPACE_ID="${NEXT_PUBLIC_AAPKARIDER_WORKSPACE_ID:-$AAPKARIDER_WORKSPACE_ID}"

# ── 1) Dependencies (conditional, but package-manifest aware) ──
DEPS_HASH_FILE="$REPO/.deps-fingerprint"
CURRENT_DEPS_HASH="$(dependency_fingerprint)"
PREVIOUS_DEPS_HASH="$(cat "$DEPS_HASH_FILE" 2>/dev/null || true)"
if [ ! -d node_modules ] || [ ! -d backend/node_modules ] || [ "${FORCE_DEPS:-0}" = "1" ] || [ "$CURRENT_DEPS_HASH" != "$PREVIOUS_DEPS_HASH" ]; then
  log "npm ci (workspace install)"
  npm ci 2>&1 | tee -a "$LOG"
  [ "${PIPESTATUS[0]}" = "0" ] || fatal "npm ci failed"
  # The root workspace install above does NOT cover backend/ (it is a standalone
  # npm project, not a workspace member), so backend dependency changes would
  # otherwise never reach the box. Install it explicitly from its own lockfile.
  log "npm ci (backend standalone)"
  ( cd backend && npm ci ) 2>&1 | tee -a "$LOG"
  [ "${PIPESTATUS[0]}" = "0" ] || fatal "backend npm ci failed"
  echo "$CURRENT_DEPS_HASH" > "$DEPS_HASH_FILE"
else
  log "deps: package manifests unchanged (FORCE_DEPS=1 to reinstall)"
fi

# ── 2) Database migrations (auto-resolve a half-applied migration, then deploy) ──
(
  cd backend || exit 1
  node -e "const{PrismaClient}=require('@prisma/client');const db=new PrismaClient();db.\$executeRaw\`UPDATE _prisma_migrations SET rolled_back_at=NOW() WHERE finished_at IS NULL AND started_at IS NOT NULL AND rolled_back_at IS NULL\`.then(n=>{if(n>0)console.log('[deploy] resolved',n,'failed migration(s)')}).finally(()=>db.\$disconnect())" 2>/dev/null || true
  log "prisma migrate deploy"
  npx prisma migrate deploy 2>&1 | tee -a "$LOG"
  [ "${PIPESTATUS[0]}" = "0" ] || exit 1
  log "prisma generate"
  npx prisma generate 2>&1 | tee -a "$LOG"
  [ "${PIPESTATUS[0]}" = "0" ] || exit 1
) || fatal "database migration/generate failed"

# ── 3) Build the Sitepresso fleet. Turbo cache ⇒ only changed apps rebuild.
#       --concurrency=2 bounds peak memory (the box OOM-crashed building many
#       Next apps at once). ──
BUILD_FILTERS=(
  --filter=@sitepresso/aapkarider-console
  --filter=@sitepresso/qa-portal
  --filter=sitepresso-platform
  --filter=@sitepresso/booking-public
  --filter=@sitepresso/booking-staff
  --filter=@sitepresso/booking-customer
  --filter=@sitepresso/shop-public
  --filter=@sitepresso/shop-staff-manager
  --filter=@sitepresso/shop-staff-delivery
  --filter=@sitepresso/shop-customer
  --filter=@sitepresso/web-public
  --filter=@sitepresso/web-staff
  --filter=@sitepresso/web-customer
)
log "turbo run build --concurrency=2 ${BUILD_FILTERS[*]}"
npx turbo run build --concurrency=2 "${BUILD_FILTERS[@]}" 2>&1 | tail -50 | tee -a "$LOG"
[ "${PIPESTATUS[0]}" = "0" ] || fatal "turbo build failed"

# ── 3b) Config self-check (ADVISORY) — revoked Paddle key / dead price catalog /
#        missing secrets / unsafe launch-free config. Loud but NON-BLOCKING: a
#        billing/config issue must not wedge a CODE deploy (it repeatedly aborted
#        prod deploys after pm2 reload-stage, leaving old code running). Failures
#        are logged prominently; fix them out-of-band. ──
if [ -f "$REPO/backend/scripts/verify-config.js" ]; then
  log "config: verify-config.js (advisory)"
  ( cd "$REPO/backend" && node -r dotenv/config scripts/verify-config.js ) 2>&1 | tee -a "$LOG"
  [ "${PIPESTATUS[0]}" = "0" ] || log "config: self-check reported issues (ADVISORY — not blocking the deploy; fix config separately)"
fi

# ── 4) Reload the fleet from the manifest. startOrReload starts any missing
#       service and reloads the rest; it only touches apps named in
#       ecosystem.config.js, so sibling products (wms/chat/workvib) are untouched. ──
ENV_FLAG=""
[ "$ENV_LABEL" = "prod" ] && ENV_FLAG="--env production"
log "pm2 startOrReload ecosystem.config.js ${ENV_FLAG}"
pm2 startOrReload ecosystem.config.js --update-env $ENV_FLAG 2>&1 | tail -25 | tee -a "$LOG"
[ "${PIPESTATUS[0]}" = "0" ] || fatal "pm2 reload failed"

# PM2 does not change an existing app's fork/cluster shape during startOrReload.
# Recreate only the Sitepresso apps whose process mode/instance count is part of
# this deployment contract. Never delete all apps; sibling products share PM2.
PM2_RECREATE_ON_DEPLOY="${PM2_RECREATE_ON_DEPLOY:-sitepresso-backend sitepresso-scheduler platform sp-router}"
for app in $PM2_RECREATE_ON_DEPLOY; do
  log "pm2 recreate $app (apply mode/instance changes)"
  pm2 delete "$app" >/dev/null 2>&1 || true
  pm2 start ecosystem.config.js --only "$app" --update-env $ENV_FLAG 2>&1 | tail -20 | tee -a "$LOG"
  [ "${PIPESTATUS[0]}" = "0" ] || fatal "pm2 recreate failed for $app"
done

pm2 save >/dev/null 2>&1 || true
sleep 5 # let reloaded listeners settle before the health gate

# ── 5) One-time, idempotent, sentinel-guarded data seeds ──
run_seed() { # <sentinel> <script-rel-path> <label>
  local sentinel="$REPO/$1" script="$REPO/$2" label="$3"
  case "$ENV_LABEL" in staging|prod) ;; *) return 0 ;; esac
  [ -f "$sentinel" ] && { log "seed $label: already applied"; return 0; }
  [ -f "$script" ]   || { log "seed $label: script missing, skipping"; return 0; }
  log "seed $label: applying"
  ( cd "$REPO/backend" && node -r dotenv/config "$script" ) && touch "$sentinel" && log "seed $label: done"
}
run_seed ".pricing-seed-20260604-ai-ecom.done" "backend/prisma/seeds/pricing.seed.js" "pricing"
run_seed ".taxfixy-seed-pages-20260519b.done" "backend/scripts/seed-taxfixy-web.js" "taxfixy"
run_seed ".it-services-seed-loominfo-paperbyte-20260519.done" "backend/scripts/seed-it-services-websites.js" "it-services"

# ── 6) Health gate — fail the deploy if any required service is down ──
if [ -x "$REPO/scripts/smoke.sh" ]; then
  log "health: running scripts/smoke.sh"
  bash "$REPO/scripts/smoke.sh" "$ENV_LABEL" 2>&1 | tee -a "$LOG"
  [ "${PIPESTATUS[0]}" = "0" ] || fatal "smoke test failed — deploy unhealthy"
else
  log "health: smoke.sh missing — backend-only check"
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:5000/version" 2>/dev/null || echo 000)
  [ "$code" = "200" ] || fatal "backend /version returned $code"
fi

log "===== deploy complete ($(($(date +%s) - START))s) ====="
