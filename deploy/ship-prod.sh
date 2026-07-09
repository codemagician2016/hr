#!/usr/bin/env bash
# ship-prod.sh — build DriftHR HMS locally with the PROD domain baked in, ship to the
# shared PROD box (i-0edf302e16d3c8d35), deploy. Mirrors ship-staging.sh but targets
# prod: box i-0edf, drifthr.com build domain, drifthr-hms-prod.tgz, and passes
# DRIFTHR_ENV=prod to box-deploy so it reloads the fleet BY NAME (preserving prod's
# live 43xx ports / PLATFORM_DOMAIN=drifthr.com — no ecosystem config imposed).
#   bash deploy/ship-prod.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="/Users/kp/Library/Python/3.9/bin:$PATH"
export AWS_PROFILE="${AWS_PROFILE:-admin}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-south-1}"
AWS=aws; command -v aws >/dev/null 2>&1 || AWS=/Users/kp/aws-cli/aws
IID="${DRIFTHR_IID:-i-0edf302e16d3c8d35}"
BUCKET="${DRIFTHR_BUCKET:-s3://sp-deploy-624517878372}"
KEY=drifthr-hms-prod.tgz
TAR="/tmp/$KEY"

# 1) Build the three Next apps locally with the PROD domain baked in.
export NEXT_PUBLIC_PLATFORM_DOMAIN=drifthr.com
export NEXT_PUBLIC_PLATFORM_URL=https://drifthr.com
for app in platform hr-admin ess; do
  echo "[ship] building apps/$app (prod)…"
  ( cd "apps/$app" && npm run build >"/tmp/drifthr-build-$app.log" 2>&1 ) \
    || { echo "BUILD FAILED apps/$app:"; tail -40 "/tmp/drifthr-build-$app.log"; exit 1; }
  echo "[ship]   ✓ apps/$app"
done

# 2) Tarball: source + prebuilt .next; never node_modules/.git/.next-cache/secrets.
echo "[ship] tarball…"
tar --no-mac-metadata --no-xattrs \
  --exclude='*/node_modules' --exclude='node_modules' \
  --exclude='*/.next/cache' --exclude='.git' --exclude='*/.git' \
  --exclude='.deploy' --exclude='*/.env' --exclude='*/.env.*' \
  -czf "$TAR" \
  backend apps/platform apps/hr-admin apps/ess apps/router packages scripts deploy \
  package.json package-lock.json turbo.json .nvmrc
echo "[ship]   $(du -h "$TAR" | cut -f1)  $TAR"

# 3) Upload to S3.
$AWS s3 cp "$TAR" "$BUCKET/$KEY" >/dev/null
echo "[ship]   uploaded $BUCKET/$KEY"

# 4) SSM the box: backup → extract → box-deploy.sh (DRIFTHR_ENV=prod). Preserves
#    backend/.env + node_modules on the box.
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
  "sudo -u ubuntu -H DRIFTHR_ENV=prod bash /home/ubuntu/drifthr-hms/deploy/box-deploy.sh"
].join("\n");
fs.writeFileSync("/tmp/drifthr-ship-params.json", JSON.stringify({commands:[script]}));
' "$BUCKET" "$KEY"
CID=$($AWS ssm send-command --instance-ids "$IID" --document-name AWS-RunShellScript \
  --comment "ship drifthr-hms prod" --timeout-seconds 1500 \
  --parameters file:///tmp/drifthr-ship-params.json --query Command.CommandId --output text)
echo "[ship] ssm $CID — deploying on PROD box (npm ci · realign+db push · backfill · pm2 reload drifthr-hms-*)…"
ST=Pending
for i in $(seq 1 220); do
  ST=$($AWS ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query Status --output text 2>/dev/null || echo Pending)
  case "$ST" in Success|Failed|Cancelled|TimedOut) break;; esac
  sleep 5
done
echo "### deploy status: $ST"
$AWS ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query StandardOutputContent --output text | tail -45
echo "### stderr (tail):"
$AWS ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query StandardErrorContent --output text 2>/dev/null | tail -20
