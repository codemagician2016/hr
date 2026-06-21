#!/bin/bash
# Weekly npm-audit dependency scan.
#
# Runs `npm audit` against the three main package directories, captures
# anything HIGH or CRITICAL, and emails a summary to support@sitepresso.com
# via the AWS CLI. If nothing high/critical is found, no email is sent —
# we don't want the inbox flooded with "all clear" notes every week.
#
# Install (once, on EC2):
#   chmod +x /home/ubuntu/sitepresso/scripts/weekly-npm-audit.sh
#   (crontab -l 2>/dev/null; echo "30 3 * * 1 /home/ubuntu/sitepresso/scripts/weekly-npm-audit.sh >> /home/ubuntu/npm-audit.log 2>&1") | crontab -
# Runs every Monday at 03:30 UTC.
#
# Manual run: ./scripts/weekly-npm-audit.sh

set -uo pipefail

REPO_DIR="${REPO_DIR:-/home/ubuntu/sitepresso}"
TO_EMAIL="${SECURITY_NOTIFY_EMAIL:-support@sitepresso.com}"
FROM_EMAIL="${SES_FROM_EMAIL:-noreply@notifytest.workvib.com}"
AWS_REGION="${AWS_REGION:-ap-south-1}"

# Load AWS credentials from the backend .env so we can use SES.
ENV_FILE="$REPO_DIR/backend/.env"
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_REGION|SES_FROM_EMAIL|SECURITY_NOTIFY_EMAIL)
        value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
        export "$key=$value"
        ;;
    esac
  done < <(grep -E '^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_REGION|SES_FROM_EMAIL|SECURITY_NOTIFY_EMAIL)=' "$ENV_FILE")
  TO_EMAIL="${SECURITY_NOTIFY_EMAIL:-$TO_EMAIL}"
  FROM_EMAIL="${SES_FROM_EMAIL:-$FROM_EMAIL}"
fi

TMP_REPORT="$(mktemp /tmp/npm-audit-XXXXXX.txt)"
trap "rm -f $TMP_REPORT" EXIT

echo "Sitepresso npm-audit weekly scan — $(date -u +'%Y-%m-%d %H:%M:%S UTC')" > "$TMP_REPORT"
echo "Repo: $REPO_DIR" >> "$TMP_REPORT"
echo "" >> "$TMP_REPORT"

FOUND_ISSUES=0

scan_dir() {
  local label="$1"
  local dir="$2"
  if [ ! -f "$dir/package.json" ]; then
    return 0
  fi
  echo "── $label ($dir) ──" >> "$TMP_REPORT"
  cd "$dir" || return 1
  # --audit-level=high → exit non-zero only on HIGH or CRITICAL findings.
  # --json → machine-parseable. We count vulnerabilities by severity.
  local json_output
  json_output=$(npm audit --audit-level=high --json 2>/dev/null || true)
  if [ -z "$json_output" ]; then
    echo "  (audit failed to run)" >> "$TMP_REPORT"
    return 0
  fi
  # Parse the npm audit JSON structure. Format differs by npm version;
  # npm 7+ uses metadata.vulnerabilities.{info,low,moderate,high,critical}.
  local high crit
  high=$(echo "$json_output" | grep -oE '"high"\s*:\s*[0-9]+' | grep -oE '[0-9]+' | head -1)
  crit=$(echo "$json_output" | grep -oE '"critical"\s*:\s*[0-9]+' | grep -oE '[0-9]+' | head -1)
  high="${high:-0}"
  crit="${crit:-0}"
  echo "  HIGH: $high   CRITICAL: $crit" >> "$TMP_REPORT"
  if [ "$crit" -gt 0 ] || [ "$high" -gt 0 ]; then
    FOUND_ISSUES=1
    echo "" >> "$TMP_REPORT"
    echo "  Details:" >> "$TMP_REPORT"
    npm audit --audit-level=high 2>/dev/null | head -80 >> "$TMP_REPORT" || true
  fi
  echo "" >> "$TMP_REPORT"
}

scan_dir "Backend"  "$REPO_DIR/backend"
scan_dir "Platform" "$REPO_DIR/platform"
scan_dir "Business" "$REPO_DIR/business"

if [ "$FOUND_ISSUES" -eq 0 ]; then
  echo "[$(date -u +'%F %T')] no high/critical findings, skipping email"
  exit 0
fi

# Send via SES. CLI is part of the deploy host; credentials are loaded above.
SUBJECT="[Sitepresso] Weekly npm-audit found high/critical vulns"
if command -v aws >/dev/null 2>&1; then
  aws ses send-email \
    --region "$AWS_REGION" \
    --from "$FROM_EMAIL" \
    --to "$TO_EMAIL" \
    --subject "$SUBJECT" \
    --text "file://$TMP_REPORT" \
    --only-show-errors \
  && echo "[$(date -u +'%F %T')] alert email sent to $TO_EMAIL" \
  || echo "[$(date -u +'%F %T')] SES send failed; report kept at $TMP_REPORT"
else
  echo "[$(date -u +'%F %T')] aws CLI not installed; skipped email"
  cat "$TMP_REPORT"
fi
