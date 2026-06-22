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

log "prisma generate + migrate deploy (drifthr_hms)"
npx prisma generate 2>&1 | tail -2
npx prisma migrate deploy 2>&1 | tail -8

cd "$ROOT"
log "pm2 startOrReload — ONLY drifthr-hms-* (siblings untouched)"
pm2 startOrReload deploy/ecosystem.staging.config.js --update-env \
  --only drifthr-hms-backend,drifthr-hms-router,drifthr-hms-platform,drifthr-hms-hr-admin,drifthr-hms-ess
pm2 save
log "done — drifthr-hms processes:"
pm2 list | grep -E "drifthr-hms|name" || true
