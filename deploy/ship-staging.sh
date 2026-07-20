#!/usr/bin/env bash
# ship-staging.sh — build DriftHR HMS locally, ship to the shared staging box, deploy.
# Local Next builds (NOT on the box) protect the ~25 siblings from an OOM-kill.
#   bash deploy/ship-staging.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="/Users/kp/Library/Python/3.9/bin:$PATH"
export AWS_PROFILE="${AWS_PROFILE:-admin}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-south-1}"
AWS=aws; command -v aws >/dev/null 2>&1 || AWS=/Users/kp/aws-cli/aws
IID="${DRIFTHR_IID:-i-0b56a46bbd9c4fd60}"
BUCKET="${DRIFTHR_BUCKET:-s3://sp-deploy-624517878372}"
KEY=drifthr-hms-staging.tgz
TAR="/tmp/$KEY"

# 1) Build the three Next apps locally.
export NEXT_PUBLIC_PLATFORM_DOMAIN=staging.drifthr.com
export NEXT_PUBLIC_PLATFORM_URL=https://staging.drifthr.com
for app in platform hr-admin ess; do
  echo "[ship] building apps/$app …"
  ( cd "apps/$app" && npm run build >"/tmp/drifthr-build-$app.log" 2>&1 ) \
    || { echo "BUILD FAILED apps/$app:"; tail -40 "/tmp/drifthr-build-$app.log"; exit 1; }
  echo "[ship]   ✓ apps/$app"
done

# 1b) Feature 41 — the employee app compiled to WEB (served on the m-<tenant>
#     mobile-web hosts by drifthr-hms-mobile-web). Same-origin API (API_URL
#     empty). Best-effort: no Flutter on this machine → ship without it (the
#     static server just 404s until a build ships).
FLUTTER="${FLUTTER_BIN:-/Users/kp/flutter/bin/flutter}"
if command -v "$FLUTTER" >/dev/null 2>&1; then
  echo "[ship] building apps/mobile (flutter web)…"
  ( cd apps/mobile && "$FLUTTER" build web --release \
      --dart-define=API_URL= \
      --dart-define=PLATFORM_DOMAIN=staging.drifthr.com \
      >/tmp/drifthr-build-mobile-web.log 2>&1 ) \
    && echo "[ship]   ✓ apps/mobile (web)" \
    || { echo "[ship]   ⚠ flutter web build failed (shipping without it):"; tail -10 /tmp/drifthr-build-mobile-web.log; }
else
  echo "[ship]   ⚠ flutter not found — shipping without the mobile web app"
fi
MOBILE_WEB_DIR=""
[ -d apps/mobile/build/web ] && MOBILE_WEB_DIR="apps/mobile/build/web"

# 2) Tarball: source + prebuilt .next; never node_modules/.git/.next-cache/secrets.
echo "[ship] tarball…"
tar --no-mac-metadata --no-xattrs \
  --exclude='*/node_modules' --exclude='node_modules' \
  --exclude='*/.next/cache' --exclude='.git' --exclude='*/.git' \
  --exclude='.deploy' --exclude='*/.env' --exclude='*/.env.*' \
  -czf "$TAR" \
  backend apps/platform apps/hr-admin apps/ess apps/router packages scripts deploy \
  package.json package-lock.json turbo.json .nvmrc $MOBILE_WEB_DIR
echo "[ship]   $(du -h "$TAR" | cut -f1)  $TAR"

# 3) Upload to S3.
$AWS s3 cp "$TAR" "$BUCKET/$KEY" >/dev/null
echo "[ship]   uploaded $BUCKET/$KEY"

# 4) SSM the box: backup → extract → box-deploy.sh (preserves backend/.env + node_modules).
node -e '
const fs=require("fs");
const BUCKET=process.argv[1], KEY=process.argv[2];
const script = [
  "set -e",
  "cd /home/ubuntu",
  "if [ -d drifthr-hms ]; then sudo -u ubuntu tar czf drifthr-hms-prebackup-$(date +%s).tgz --exclude=node_modules --exclude=.next drifthr-hms 2>/dev/null || true; fi",
  "ls -1t drifthr-hms-prebackup*.tgz 2>/dev/null | tail -n +4 | xargs -r rm -f || true",
  "sudo -u ubuntu aws s3 cp "+BUCKET+"/"+KEY+" /tmp/"+KEY,
  "sudo -u ubuntu mkdir -p /home/ubuntu/drifthr-hms",
  "sudo -u ubuntu tar xzf /tmp/"+KEY+" -C /home/ubuntu/drifthr-hms",
  "rm -f /tmp/"+KEY,
  "chown -R ubuntu:ubuntu /home/ubuntu/drifthr-hms",
  "sudo -u ubuntu -H bash /home/ubuntu/drifthr-hms/deploy/box-deploy.sh"
].join("\n");
fs.writeFileSync("/tmp/drifthr-ship-params.json", JSON.stringify({commands:[script]}));
' "$BUCKET" "$KEY"
CID=$($AWS ssm send-command --instance-ids "$IID" --document-name AWS-RunShellScript \
  --comment "ship drifthr-hms staging" --timeout-seconds 1500 \
  --parameters file:///tmp/drifthr-ship-params.json --query Command.CommandId --output text)
echo "[ship] ssm $CID — deploying on box (npm ci · prisma migrate · pm2 reload --only drifthr-hms-*)…"
ST=Pending
for i in $(seq 1 220); do
  ST=$($AWS ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query Status --output text 2>/dev/null || echo Pending)
  case "$ST" in Success|Failed|Cancelled|TimedOut) break;; esac
  sleep 5
done
echo "### deploy status: $ST"
$AWS ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query StandardOutputContent --output text | tail -40
echo "### stderr (tail):"
$AWS ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query StandardErrorContent --output text 2>/dev/null | tail -20
