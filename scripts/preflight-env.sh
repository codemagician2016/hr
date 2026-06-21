#!/bin/bash
# =============================================================================
# Sitepresso preflight env check
# =============================================================================
# Run on the target EC2 BEFORE `docker compose up` to catch missing env vars
# that cause silent prod failures (login broken, emails not sending, etc).
#
# Exits non-zero with a clear error list if any REQUIRED var is missing or
# obviously wrong. Use:
#   ./scripts/preflight-env.sh /home/ubuntu/sitepresso/backend/.env production
#
# Add to deploy pipeline so prod gets the same validation staging gets.
# =============================================================================

set -uo pipefail

ENV_FILE="${1:-/home/ubuntu/sitepresso/backend/.env}"
EXPECTED_DEPLOY="${2:-production}"

if [ ! -r "$ENV_FILE" ]; then
  echo "❌ Cannot read env file: $ENV_FILE" >&2
  exit 1
fi

# Source it in a subshell so we don't pollute the caller's env
ERRORS=()
WARNINGS=()

check_required() {
  local var=$1
  local why=$2
  local value
  value=$(grep -E "^${var}=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ -z "$value" ]; then
    ERRORS+=("❌ ${var} missing or empty — ${why}")
  fi
}

check_match() {
  local var=$1
  local expected=$2
  local why=$3
  local value
  value=$(grep -E "^${var}=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ "$value" != "$expected" ]; then
    ERRORS+=("❌ ${var}='${value}' (expected '${expected}') — ${why}")
  fi
}

check_optional() {
  local var=$1
  local why=$2
  local value
  value=$(grep -E "^${var}=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ -z "$value" ]; then
    WARNINGS+=("⚠  ${var} not set — ${why}")
  fi
}

# ── Required for ANY environment ───────────────────────────────────
check_required DATABASE_URL "DB connection — without this, the app crashes on boot"
check_required JWT_SECRET "JWT signing — without this, no one can log in"
check_required JWT_REFRESH_SECRET "JWT refresh — sessions won't persist beyond 15 min"
check_required PLATFORM_DOMAIN "drives CORS + tenant routing"
check_required AUTH_COOKIE_DOMAIN "cookie scope — wrong value = login succeeds but session drops"

# AUTH_COOKIE_DOMAIN must start with a dot
auth_domain=$(grep -E "^AUTH_COOKIE_DOMAIN=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
if [ -n "$auth_domain" ] && [[ "$auth_domain" != .* ]]; then
  ERRORS+=("❌ AUTH_COOKIE_DOMAIN='${auth_domain}' must start with a dot (e.g. .sitepresso.com)")
fi

# Email — required for signup/forgot-password/OTP flows
check_required AWS_REGION "SES region — without this you get 'Region is missing' on every signup"
check_required AWS_ACCESS_KEY_ID "SES auth — without this all email sends fail"
check_required AWS_SECRET_ACCESS_KEY "SES auth"
check_required SES_FROM_EMAIL "from address — MUST be on a verified SES identity"

# ── Production-only checks ─────────────────────────────────────────
if [ "$EXPECTED_DEPLOY" = "production" ]; then
  check_match DEPLOY_ENV "production" "without this, ALL prod email gets redirected to staging inbox"
  check_match NODE_ENV "production" "Next.js / Prisma optimisations disabled otherwise"

  # Sanity: cookie domain should match platform domain
  platform=$(grep -E "^PLATFORM_DOMAIN=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ -n "$platform" ] && [ -n "$auth_domain" ]; then
    if [ "$auth_domain" != ".${platform}" ]; then
      ERRORS+=("❌ AUTH_COOKIE_DOMAIN='${auth_domain}' doesn't match PLATFORM_DOMAIN='${platform}' (expected '.${platform}')")
    fi
  fi
fi

# ── Optional but commonly needed in prod ───────────────────────────
check_optional TURNSTILE_SECRET "captcha — signup will work but bots can spam"
check_optional SENTRY_DSN "no error tracking"
check_optional PADDLE_API_KEY "billing disabled — only fine pre-launch"
check_optional PADDLE_WEBHOOK_SECRET "Paddle webhooks will fail closed"
check_optional PADDLE_CLIENT_TOKEN "Paddle checkout overlay will not render"
check_optional PADDLE_MAILBOX_PRICE_ID_MONTHLY "mailbox checkout disabled"
check_optional PADDLE_MAILBOX_PRICE_ID_ANNUAL "annual mailbox checkout disabled"
check_optional PADDLE_SMS_TOPUP_UNIT_PRICE_ID "optional reusable $1 SMS top-up unit price"
check_optional PADDLE_SMS_TOPUP_PRICE_ID_5 "optional $5 SMS top-up pack price"
check_optional PADDLE_SMS_TOPUP_PRICE_ID_20 "optional $20 SMS top-up pack price"
check_optional PADDLE_SMS_TOPUP_PRICE_ID_50 "optional $50 SMS top-up pack price"
# Social login: missing creds = /api/customer/social/* returns a clear 503.
# GOOGLE_CLIENT_ID MUST equal the platform build's NEXT_PUBLIC_GOOGLE_CLIENT_ID
# or every Google sign-in fails Google's audience check.
check_optional GOOGLE_CLIENT_ID "Google sign-in disabled until set (must match NEXT_PUBLIC_GOOGLE_CLIENT_ID baked into the platform image)"

# ── Report ─────────────────────────────────────────────────────────
echo "Preflight env check: $ENV_FILE (DEPLOY_ENV target: $EXPECTED_DEPLOY)"
echo "────────────────────────────────────────────────────────────────"

if [ ${#ERRORS[@]} -gt 0 ]; then
  printf '%s\n' "${ERRORS[@]}"
fi
if [ ${#WARNINGS[@]} -gt 0 ]; then
  printf '%s\n' "${WARNINGS[@]}"
fi
if [ ${#ERRORS[@]} -eq 0 ] && [ ${#WARNINGS[@]} -eq 0 ]; then
  echo "✓ All required vars set"
fi

echo "────────────────────────────────────────────────────────────────"
echo "Errors: ${#ERRORS[@]}    Warnings: ${#WARNINGS[@]}"

[ ${#ERRORS[@]} -eq 0 ]
