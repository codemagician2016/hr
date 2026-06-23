#!/bin/bash
# EC2-side deploy script — adapted from sitepresso-deploy-app.sh.
# Downloads a pre-built Next.js tarball from S3 and hot-swaps the app's .next
# dir, then restarts the corresponding PM2 process. Run on the box (via SSM or
# SSH), NOT from a laptop.
#
# Usage: drifthr-deploy-app.sh <env> <app>
#   env: staging | prod
#   app: platform | hr-admin | ess
#
# Called as: sudo -u ubuntu /home/ubuntu/drifthr-deploy-app.sh prod platform
#
# Required env (placeholders — set on the box / via SSM, NEVER hard-code here):
#   DRIFTHR_DEPLOY_BUCKET   S3 bucket holding the build tarballs
#   AWS_REGION              AWS region (defaults to ap-south-1)
# The box's IAM instance role must grant s3:GetObject on the bucket.

set -euo pipefail

ENV_LABEL=${1:?'Usage: drifthr-deploy-app.sh <staging|prod> <platform|hr-admin|ess>'}
APP=${2:?'Usage: drifthr-deploy-app.sh <staging|prod> <platform|hr-admin|ess>'}

# Secret/account-specific values come from the environment — placeholders only.
S3_BUCKET="${DRIFTHR_DEPLOY_BUCKET:?set DRIFTHR_DEPLOY_BUCKET to the deploy S3 bucket}"
AWS_REGION="${AWS_REGION:-ap-south-1}"

case "$ENV_LABEL" in
  staging)
    REPO_DIR="/home/ubuntu/drifthr"
    PM2_PREFIX="drifthr"
    ;;
  prod)
    REPO_DIR="/home/ubuntu/drifthr-prod"
    PM2_PREFIX="drifthr-prod"
    ;;
  *)
    echo "[deploy-app] ERROR: unknown env '$ENV_LABEL' — expected staging or prod"
    exit 1
    ;;
esac

case "$APP" in
  platform|hr-admin|ess) ;;
  *)
    echo "[deploy-app] ERROR: unknown app '$APP' — expected platform, hr-admin, or ess"
    exit 1
    ;;
esac

# PM2 process names are unprefixed in ecosystem.config.js (platform/hr-admin/ess).
# Allow a prefixed override via PM2_USE_PREFIX=1 if both staging+prod run on one box.
if [ "${PM2_USE_PREFIX:-0}" = "1" ]; then
  PM2_NAME="${PM2_PREFIX}-${APP}"
else
  PM2_NAME="${APP}"
fi

APP_DIR="$REPO_DIR/apps/$APP"
S3_KEY="s3://${S3_BUCKET}/${ENV_LABEL}/${APP}.tar.gz"
TMP_FILE="/tmp/${ENV_LABEL}-${APP}-build.tar.gz"

echo "[deploy-app] ENV=$ENV_LABEL  APP=$APP  PM2=$PM2_NAME  REGION=$AWS_REGION"
echo "[deploy-app] Downloading $S3_KEY"
aws s3 cp "$S3_KEY" "$TMP_FILE" --region "$AWS_REGION"

echo "[deploy-app] Swapping $APP_DIR/.next"
rm -rf "${APP_DIR}/.next"
# Tarball is built as `tar -czf <app>.tar.gz .next` from the app dir, so it
# extracts the .next tree directly into $APP_DIR.
tar -xzf "$TMP_FILE" -C "$APP_DIR"
rm -f "$TMP_FILE"

echo "[deploy-app] Restarting PM2: $PM2_NAME"
if pm2 list | grep -q "$PM2_NAME"; then
  pm2 restart "$PM2_NAME" --update-env
  echo "[deploy-app] Done — $PM2_NAME restarted"
else
  echo "[deploy-app] WARNING: $PM2_NAME not in PM2 — run a first-time"
  echo "[deploy-app]          'pm2 startOrReload ecosystem.config.js' on this box."
  exit 1
fi
