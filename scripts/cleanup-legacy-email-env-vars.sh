#!/usr/bin/env bash
# Removes the legacy email-override env vars from both backend .env
# files on the EC2. They were superseded on 2026-04-30 by DEPLOY_ENV
# (single-rule routing — see backend/src/lib/emailOverride.js). The
# new code doesn't read them; they sit in the .env files looking
# load-bearing when they aren't.
#
# Run this on the EC2 (or via ssh) AFTER confirming /api/internal/email-mode
# returns the right mode on both deployments.
#
# Usage (on the EC2):
#   bash /home/ubuntu/sitepresso/scripts/cleanup-legacy-email-env-vars.sh
#
# Or from a laptop with SSH:
#   ssh -i ~/.ssh/appointease-key.pem ubuntu@<host> \
#     bash /home/ubuntu/sitepresso/scripts/cleanup-legacy-email-env-vars.sh

set -euo pipefail

cleanup() {
  local env_path=$1
  local label=$2
  if [[ ! -f "$env_path" ]]; then
    echo "  ✗ ${label}: ${env_path} does not exist; skipping"
    return
  fi
  if ! grep -qE '^(FORCE_EMAIL_OVERRIDE|EMAIL_OVERRIDE)=' "$env_path"; then
    echo "  ✓ ${label}: already clean (no FORCE_EMAIL_OVERRIDE / EMAIL_OVERRIDE lines)"
    return
  fi
  cp "$env_path" "${env_path}.bak-$(date +%s)"
  # Strip both vars; -i.bak handles macOS too if anyone runs this locally.
  sed -i.tmpbak -E '/^(FORCE_EMAIL_OVERRIDE|EMAIL_OVERRIDE)=/d' "$env_path"
  rm -f "${env_path}.tmpbak"
  echo "  ✓ ${label}: legacy lines removed (backup at ${env_path}.bak-*)"
}

echo "Cleaning legacy email-override env vars (no longer read by the code):"
cleanup /home/ubuntu/sitepresso/backend/.env       "staging "
cleanup /home/ubuntu/sitepresso-prod/backend/.env  "prod    "

echo
echo "Restart backends so pm2 picks up the trimmed env (idempotent):"
pm2 restart sitepresso-backend       --update-env > /dev/null 2>&1 && echo "  ✓ sitepresso-backend restarted"
pm2 restart sitepresso-prod-backend  --update-env > /dev/null 2>&1 && echo "  ✓ sitepresso-prod-backend restarted"

echo
echo "Verify with:"
echo "  curl -s https://api.aapkatech.com/api/internal/email-mode  # expect mode=staging"
echo "  curl -s https://api.sitepresso.com/api/internal/email-mode # expect mode=production"
