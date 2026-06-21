#!/bin/bash
# EC2-side deploy script called by GitHub Actions (deploy-frontends.yml).
# Downloads a pre-built Next.js tarball from S3 and hot-swaps the .next dir.
#
# Usage: /home/ubuntu/sitepresso-deploy-app.sh <env> <app>
#   env: staging | prod
#   app: platform | business
#
# Called as: sudo -u ubuntu /home/ubuntu/sitepresso-deploy-app.sh staging platform

set -euo pipefail

ENV_LABEL=${1:?'Usage: sitepresso-deploy-app.sh <staging|prod> <platform|business>'}
APP=${2:?'Usage: sitepresso-deploy-app.sh <staging|prod> <platform|business>'}

S3_BUCKET="sitepresso-deploys-624517878372-ap-south-1-an"
AWS_REGION="ap-south-1"

case "$ENV_LABEL" in
  staging)
    REPO_DIR="/home/ubuntu/sitepresso"
    PM2_PREFIX="sitepresso"
    ;;
  prod)
    REPO_DIR="/home/ubuntu/sitepresso-prod"
    PM2_PREFIX="sitepresso-prod"
    ;;
  *)
    echo "[deploy-app] ERROR: unknown env '$ENV_LABEL' — expected staging or prod"
    exit 1
    ;;
esac

case "$APP" in
  platform|business) ;;
  *)
    echo "[deploy-app] ERROR: unknown app '$APP' — expected platform or business"
    exit 1
    ;;
esac

APP_DIR="$REPO_DIR/$APP"
PM2_NAME="${PM2_PREFIX}-${APP}"
S3_KEY="s3://${S3_BUCKET}/${ENV_LABEL}/${APP}.tar.gz"
TMP_FILE="/tmp/${ENV_LABEL}-${APP}-build.tar.gz"

echo "[deploy-app] ENV=$ENV_LABEL  APP=$APP  PM2=$PM2_NAME"
echo "[deploy-app] Downloading $S3_KEY"
aws s3 cp "$S3_KEY" "$TMP_FILE" --region "$AWS_REGION"

echo "[deploy-app] Extracting to $APP_DIR/.next"
rm -rf "${APP_DIR}/.next"
tar -xzf "$TMP_FILE" -C "$APP_DIR"
rm -f "$TMP_FILE"

echo "[deploy-app] Restarting PM2: $PM2_NAME"
if pm2 list | grep -q "$PM2_NAME"; then
  pm2 restart "$PM2_NAME" --update-env
  echo "[deploy-app] Done — $PM2_NAME restarted"
else
  echo "[deploy-app] WARNING: $PM2_NAME not in PM2 — apps may need first-time start"
fi
