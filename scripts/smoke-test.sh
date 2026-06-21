#!/usr/bin/env bash
# Sitepresso smoke test — feature-lock verification.
#
# Hits every critical user-facing URL + API endpoint and fails loudly if
# anything regresses. Run after every deploy; exits non-zero if any check
# fails so the auto-deploy pipeline can flag it.
#
# Usage:
#   scripts/smoke-test.sh [staging|prod] [--verbose] [--backend-only|--full]
#
# Exit codes:
#   0   all checks passed
#   1   one or more checks failed (details printed)
#   2   bad arguments
#
# Add new features to the FEATURES array below — that's the "lock". If a
# future change breaks one, this script catches it.

set -uo pipefail
# NOTE: -e intentionally OFF. The check_url/check_header functions track
# pass/fail via counters; we want the script to keep running through every
# URL even when one fails, then summarise + exit 1 at the end if any
# failed. With -e on, the first failing check would abort the run and you'd
# see a misleading "still passing" report.

ENV="staging"
if [[ $# -gt 0 && "${1:-}" != --* ]]; then
  ENV="$1"
  shift
fi
VERBOSE=0
SMOKE_SCOPE="${SMOKE_SCOPE:-full}"
for arg in "$@"; do
  case "$arg" in
    --verbose) VERBOSE=1 ;;
    --backend|--backend-only) SMOKE_SCOPE="backend" ;;
    --full) SMOKE_SCOPE="full" ;;
    *)
      echo "Usage: $0 [staging|prod] [--verbose] [--backend-only|--full]" >&2
      exit 2
      ;;
  esac
done

case "$ENV" in
  staging)
    APP="https://aapkatech.com"
    APP_WWW="https://www.aapkatech.com"
    APP_UNIFIED="https://app.aapkatech.com"
    API="https://api.aapkatech.com"
    ADMIN="https://admin.aapkatech.com"
    TENANT="https://shreya.aapkatech.com"
    TENANT_SLUG="shreya"
    TENANT_KIND="booking"
    WEB_TENANT="https://loominfo.aapkatech.com"
    WEB_TENANT_SLUG="loominfo"
    SHOP_TENANT_SLUG="${SMOKE_SHOP_TENANT_STAGING:-ecom}"
    SHOP_TENANT="https://${SHOP_TENANT_SLUG}.aapkatech.com"
    CUSTOM_TENANT="${SMOKE_CUSTOM_TENANT_STAGING:-}"
    ;;
  prod)
    APP="https://sitepresso.com"
    APP_WWW="https://www.sitepresso.com"
    APP_UNIFIED="https://app.sitepresso.com"
    API="https://api.sitepresso.com"
    ADMIN="https://admin.sitepresso.com"
    TENANT="https://taxfixy.sitepresso.com"
    TENANT_SLUG="taxfixy"
    TENANT_KIND="web"
    WEB_TENANT="https://taxfixy.sitepresso.com"
    WEB_TENANT_SLUG="taxfixy"
    SHOP_TENANT_SLUG="${SMOKE_SHOP_TENANT_PROD:-}"
    SHOP_TENANT="${SHOP_TENANT_SLUG:+https://${SHOP_TENANT_SLUG}.sitepresso.com}"
    CUSTOM_TENANT="${SMOKE_CUSTOM_TENANT_PROD:-}"
    ;;
  *)
    echo "Usage: $0 [staging|prod] [--verbose] [--backend-only|--full]" >&2
    exit 2
    ;;
esac

case "$SMOKE_SCOPE" in
  full|backend) ;;
  *)
    echo "Usage: $0 [staging|prod] [--verbose] [--backend-only|--full]" >&2
    exit 2
    ;;
esac

PASS=0
FAIL=0
FAILED_CHECKS=()

# check_url <name> <url> <expected_status> [grep_pattern_must_match] [grep_pattern_must_NOT_match]
check_url() {
  local name="$1" url="$2" expected="$3" must="${4:-}" mustnot="${5:-}"
  local response status body
  response=$(curl -s -o /tmp/smoke-body-$$ -w "%{http_code}" --max-time 15 "$url" 2>&1) || {
    FAIL=$((FAIL+1))
    FAILED_CHECKS+=("$name :: curl error")
    [[ $VERBOSE -eq 1 ]] && echo "  ✗ $name :: curl error"
    return
  }
  status="$response"
  body=$(cat /tmp/smoke-body-$$ 2>/dev/null || echo "")
  rm -f /tmp/smoke-body-$$

  if [[ "$status" != "$expected" ]]; then
    FAIL=$((FAIL+1))
    FAILED_CHECKS+=("$name :: HTTP $status (expected $expected)")
    [[ $VERBOSE -eq 1 ]] && echo "  ✗ $name :: HTTP $status (expected $expected)"
    return
  fi

  if [[ -n "$must" ]] && ! echo "$body" | grep -qE "$must"; then
    FAIL=$((FAIL+1))
    FAILED_CHECKS+=("$name :: missing expected pattern '$must'")
    [[ $VERBOSE -eq 1 ]] && echo "  ✗ $name :: missing '$must'"
    return
  fi

  if [[ -n "$mustnot" ]] && echo "$body" | grep -qE "$mustnot"; then
    FAIL=$((FAIL+1))
    FAILED_CHECKS+=("$name :: forbidden pattern matched '$mustnot'")
    [[ $VERBOSE -eq 1 ]] && echo "  ✗ $name :: forbidden '$mustnot'"
    return
  fi

  PASS=$((PASS+1))
  [[ $VERBOSE -eq 1 ]] && echo "  ✓ $name"
}

# check_post <name> <url> <json_body> <expected_status> [body_must_match]
# POST variant of check_url for proving API endpoints are alive (e.g. login
# returns 401 not 500/timeout). Uses bogus payloads so it can run on prod
# without mutating data.
check_post() {
  local name="$1" url="$2" body="$3" expected="$4" must="${5:-}"
  local response status resp_body
  response=$(curl -s -o /tmp/smoke-body-$$ -w "%{http_code}" --max-time 15 \
    -X POST -H 'Content-Type: application/json' -d "$body" "$url" 2>&1) || {
    FAIL=$((FAIL+1))
    FAILED_CHECKS+=("$name :: curl error")
    [[ $VERBOSE -eq 1 ]] && echo "  ✗ $name :: curl error"
    return
  }
  status="$response"
  resp_body=$(cat /tmp/smoke-body-$$ 2>/dev/null || echo "")
  rm -f /tmp/smoke-body-$$
  if [[ "$status" != "$expected" ]]; then
    FAIL=$((FAIL+1))
    FAILED_CHECKS+=("$name :: HTTP $status (expected $expected)")
    [[ $VERBOSE -eq 1 ]] && echo "  ✗ $name :: HTTP $status (expected $expected)"
    return
  fi
  if [[ -n "$must" ]] && ! echo "$resp_body" | grep -qE "$must"; then
    FAIL=$((FAIL+1))
    FAILED_CHECKS+=("$name :: missing expected pattern '$must'")
    [[ $VERBOSE -eq 1 ]] && echo "  ✗ $name :: missing '$must'"
    return
  fi
  PASS=$((PASS+1))
  [[ $VERBOSE -eq 1 ]] && echo "  ✓ $name"
}

# check_header <name> <url> <header_pattern_must_match> [header_pattern_must_NOT_match]
# Inspects HTTP response headers (case-insensitive). Use to verify CSP /
# CORS / X-Frame-Options behavior — class of bugs that pass status-code
# smoke but break interactive features (e.g. iframe embedding).
check_header() {
  local name="$1" url="$2" must="${3:-}" mustnot="${4:-}"
  local headers
  headers=$(curl -sI --max-time 15 "$url" 2>&1) || {
    FAIL=$((FAIL+1))
    FAILED_CHECKS+=("$name :: curl error fetching headers")
    [[ $VERBOSE -eq 1 ]] && echo "  ✗ $name :: curl error"
    return
  }
  if [[ -n "$must" ]] && ! echo "$headers" | grep -qiE "$must"; then
    FAIL=$((FAIL+1))
    FAILED_CHECKS+=("$name :: missing required header '$must'")
    [[ $VERBOSE -eq 1 ]] && echo "  ✗ $name :: missing header '$must'"
    return
  fi
  if [[ -n "$mustnot" ]] && echo "$headers" | grep -qiE "$mustnot"; then
    FAIL=$((FAIL+1))
    FAILED_CHECKS+=("$name :: forbidden header present '$mustnot'")
    [[ $VERBOSE -eq 1 ]] && echo "  ✗ $name :: forbidden header '$mustnot'"
    return
  fi
  PASS=$((PASS+1))
  [[ $VERBOSE -eq 1 ]] && echo "  ✓ $name"
}

echo "════════════════════════════════════════════════════════════════════"
echo "  Sitepresso smoke test — environment: $ENV, scope: $SMOKE_SCOPE"
echo "════════════════════════════════════════════════════════════════════"
echo

if [[ "$SMOKE_SCOPE" == "backend" ]]; then
  echo "▸ Auth API"
  check_post "Login API rejects bad creds" \
    "$API/api/auth/login" \
    '{"email":"smoke-test-nobody@aapkatech.com","password":"definitely-wrong"}' \
    401 "Invalid email or password"
else

# ─── Marketing landing pages ────────────────────────────────────────────────
echo "▸ Landing + marketing pages"
check_url "Landing apex"           "$APP/"               200 "Sitepresso"
check_url "Landing www"            "$APP_WWW/"           200 "Sitepresso"
check_url "Pricing fragment"       "$APP/#pricing"       200 ""
check_url "Legal/terms"            "$APP/legal/terms"    200 ""
check_url "Legal/privacy"          "$APP/legal/privacy"  200 ""
check_url "Legal/refund"           "$APP/legal/refund"   200 ""
check_url "Legal/cookies"          "$APP/legal/cookies"  200 ""
check_url "Legal/dpa"              "$APP/legal/dpa"      200 ""
check_url "Legal/sub-processors"   "$APP/legal/sub-processors" 200 ""

# ─── Auth pages ─────────────────────────────────────────────────────────────
echo "▸ Auth pages"
check_url "Login page"             "$APP/login"          200 "(?i)sign.in|email"
check_url "Signup page"            "$APP/signup"         200 ""
check_url "Forgot password page"   "$APP/forgot-password" 200 ""
# Login API alive — bogus creds should return 401, not 500/timeout.
# Catches deploy-time regressions in auth.controller / auth.middleware /
# CORS allow-list / nginx /api forwarding.
check_post "Login API rejects bad creds" \
  "$API/api/auth/login" \
  '{"email":"smoke-test-nobody@aapkatech.com","password":"definitely-wrong"}' \
  401 "Invalid email or password"

# Login through each platform-fronting host. The browser's actual
# login form posts to /api/auth/login on whichever host the page is
# loaded from, which in turn relies on nginx's /api/ block proxying
# to the backend on the loopback. Without this nginx block, the
# fallback path is Next.js's rewrite which hairpins through the
# public DNS and times out (CrowdSec / Cloudflare drop the loopback
# HTTPS handshake — the bug super-admin login hit on 2026-04-30).
# An empty body should return 400 from the auth.controller — anything
# else (timeout, 500, 502) means the nginx /api/ proxy block is gone
# or pointing at the wrong upstream.
check_post "Login proxy on apex host"     "$APP/api/auth/login"         '{}' 400 ""
check_post "Login proxy on app.* host"    "$APP_UNIFIED/api/auth/login" '{}' 400 ""
check_post "Login proxy on admin.* host"  "$ADMIN/api/auth/login"       '{}' 400 ""
# The unified-admin host (app.*) serves the same Next.js app but via
# different nginx server block — login + dashboard render here too.
# A blank smoke for /login on apex doesn't catch app.* breakage.
check_url "Login page (app.* host)"   "$APP_UNIFIED/login"      200 "(?i)sign.in|email"
check_url "Dashboard (app.* host)"    "$APP_UNIFIED/dashboard"  200 ""

# ─── Super-admin (re-skinned login) ─────────────────────────────────────────
echo "▸ Super-admin domain"
check_url "Admin domain root"      "$ADMIN/"             200 ""
check_url "Admin domain login"     "$ADMIN/login"        200 ""

# ─── Onboarding ─────────────────────────────────────────────────────────────
echo "▸ Onboarding"
check_url "Onboarding page" "$APP/onboarding"     200 ""

# ─── Storefront (tenant subdomain) ──────────────────────────────────────────
echo "▸ Storefront"
check_url "Storefront landing"     "$TENANT/"            200 ""
if [[ "$TENANT_KIND" == "booking" ]]; then
  check_url "Storefront book page" "$TENANT/book"        200 ""
else
  check_url "Web tenant blog page" "$WEB_TENANT/blog"    200 ""
fi
if [[ -n "${CUSTOM_TENANT:-}" ]]; then
  check_url "Custom domain landing" "$CUSTOM_TENANT/"    200 ""
fi

# ─── Iframe-embeddability checks (catches the X-Frame-Options regression) ───
# The web editor admin embeds the storefront as an iframe. If nginx or
# the app injects X-Frame-Options:SAMEORIGIN, the cross-subdomain embed
# breaks silently — page returns 200 but the iframe is blank.
# This check asserts X-Frame-Options is NOT present; that legacy header
# conflicts with cross-subdomain iframe previews even when the page is healthy.
echo "▸ Iframe-embeddability (admin editor preview canvas)"
check_header "Storefront does NOT set X-Frame-Options" "$TENANT/" "" "x-frame-options:"

# ─── Tenant admin (platform-path) ───────────────────────────────────────────
echo "▸ Tenant admin"
check_url "Tenant admin overview" "$APP_WWW/$TENANT_SLUG/admin"               200 ""
check_url "Tenant admin content" "$APP_WWW/$TENANT_SLUG/admin?tab=content"   200 ""
check_url "Tenant admin scheduling" "$APP_WWW/$TENANT_SLUG/admin?tab=scheduling" 200 ""
check_url "Tenant admin services" "$APP_WWW/$TENANT_SLUG/admin?tab=services"  200 ""
check_url "Tenant admin settings" "$APP_WWW/$TENANT_SLUG/admin?tab=settings"  200 ""

fi

# ─── API health + critical endpoints ────────────────────────────────────────
echo "▸ Backend API"
check_url "API /health"            "$API/health"         200 '"ok"|"db":\{"ok":true\}'
check_url "Public pricing"         "$API/api/public/pricing" 200 '"tiers"'
check_url "Public pricing IN"      "$API/api/public/pricing?country=IN&vertical=APPOINTMENT" 200 '"tiers"'

# Auth-gated endpoints — expect 401, not 500.
echo "▸ Auth-gated endpoints (expect 401)"
check_url "Admin businesses (401)" "$API/api/admin/businesses"               401 "Not authenticated|Unauthorized"
check_url "Notification access (401)" "$API/api/admin/notification-access"   401 ""
check_url "Marketing automation (401)" "$API/api/marketing-automation"       401 ""
check_url "Notification config (401)" "$API/api/notification-config"         401 ""

# ─── Webhooks (public, POST-only — GET returns 404 from Express) ───────────
echo "▸ Webhooks"
check_url "Twilio inbound webhook (GET 404)"  "$API/api/notifications/webhook/twilio/inbound" 404 ""

# ─── Unsubscribe page ───────────────────────────────────────────────────────
echo "▸ Unsubscribe"
check_url "Unsubscribe missing args" "$API/api/unsubscribe" 400 "Invalid"
check_url "Unsubscribe valid"        "$API/api/unsubscribe?e=test%40example.com&b=foo" 200 "Unsubscribe"

# ─── Sprint 1.3 endpoints ───────────────────────────────────────────────────
echo "▸ Sprint 1.3 — Intake forms"
check_url "Intake forms list (auth-gated, 401)" "$API/api/intake-forms"            401 ""
check_url "Public form 404 expected"            "$API/api/intake-forms/public/nope" 404 ""
check_url "Submissions list (auth-gated, 401)"  "$API/api/intake-submissions"      401 ""

# ─── Sprint 1.4 endpoints ───────────────────────────────────────────────────
echo "▸ Sprint 1.4 — CRM tags & segments"
check_url "CRM tags (auth-gated, 401)"          "$API/api/crm/tags"                401 ""
check_url "CRM segments (auth-gated, 401)"      "$API/api/crm/segments"            401 ""

# ─── Sprint 2.3 endpoints ───────────────────────────────────────────────────
echo "▸ Sprint 2.3 — Discount codes on storefront"
# POST endpoint: GET should 404
if [[ -n "${SHOP_TENANT_SLUG:-}" ]]; then
  check_url "Storefront coupon validate (GET 404)" "$API/api/storefront/$SHOP_TENANT_SLUG/coupon/validate" 404 ""
else
  echo "  - Storefront coupon validate skipped (SMOKE_SHOP_TENANT_${ENV^^} not configured)"
fi

# ─── Sprint 1.5 endpoints ───────────────────────────────────────────────────
echo "▸ Sprint 1.5 — Multi-location"
check_url "Locations admin (auth-gated, 401)" "$API/api/locations" 401 ""
# 1.5b / Multi-store — ecommerce-only public location selector.
# Keep this separate from TENANT_SLUG, which may be a booking or web tenant.
if [[ -n "${SHOP_TENANT_SLUG:-}" ]]; then
  check_url "Shop locations public (200 array)"     "$API/api/storefront/$SHOP_TENANT_SLUG/locations" 200 "locations"
  check_url "Shop multi-store resolve (400 missing pin)"  "$API/api/storefront/$SHOP_TENANT_SLUG/locations/resolve" 400 ""
  check_url "Shop multi-store resolve (200 not serviceable)" "$API/api/storefront/$SHOP_TENANT_SLUG/locations/resolve?postalCode=999999" 200 "serviceable"
else
  echo "  - Shop public locations skipped (SMOKE_SHOP_TENANT_${ENV^^} not configured)"
fi

# ─── Sprint 1.6 endpoints ───────────────────────────────────────────────────
echo "▸ Sprint 1.6 — RBAC"
check_url "RBAC roles (auth-gated, 401)" "$API/api/rbac/roles" 401 ""
check_url "RBAC permissions (auth-gated, 401)" "$API/api/rbac/permissions" 401 ""

# ─── Sprint 1.7 endpoints ───────────────────────────────────────────────────
echo "▸ Sprint 1.7 — Public API + webhooks"
check_url "API keys (auth-gated, 401)" "$API/api/public-api/keys" 401 ""
check_url "Webhooks (auth-gated, 401)" "$API/api/public-api/webhooks" 401 ""

# 1.7b — public read endpoints under /api/v1/*. Each route requires a
# Bearer API key; without one the middleware should 401, proving both
# the route is mounted and the auth gate is in place.
check_url "v1 whoami (401 without key)"        "$API/api/v1/whoami"        401 ""
check_url "v1 appointments (401 without key)"  "$API/api/v1/appointments"  401 ""
check_url "v1 customers (401 without key)"     "$API/api/v1/customers"     401 ""
check_url "v1 products (401 without key)"      "$API/api/v1/products"      401 ""
check_url "v1 orders (401 without key)"        "$API/api/v1/orders"        401 ""
check_url "v1 services (401 without key)"      "$API/api/v1/services"      401 ""

# ─── Sprint 2.1 + 2.2 endpoints ─────────────────────────────────────────────
echo "▸ Sprints 2.1 + 2.2 — Payment accounts (Razorpay + Stripe)"
check_url "Payment accounts (auth-gated, 401)"          "$API/api/payments/accounts"            401 ""
# 2.1b/2.2b — buyer-side payment-order endpoint. POST-only; verb-mismatch
# GET should return 404 (handler not registered for GET) so we know the
# route file is mounted without burning a real order.
check_url "Payment-order POST mount (GET=404)"          "$API/api/payments/order"               404 ""
check_url "Razorpay buyer-success POST mount (GET=404)" "$API/api/payments/razorpay/success"    404 ""

# Sprints 2.4-2.6 are schema-only — no new HTTP endpoints to smoke beyond
# what already exists (marketing campaigns + product/business endpoints).

# ─── Sprints 2.7 + 2.8 + 3.2 + 3.3 endpoints ────────────────────────────────
echo "▸ Sprint 3.2 — Blog engine"
check_url "Blog admin (auth-gated, 401)" "$API/api/blog" 401 ""
check_url "Blog admin getOne (401)"      "$API/api/blog/00000000-0000-0000-0000-000000000000" 401 ""
check_url "Blog public 404 expected"     "$API/api/blog/public/nope" 404 ""

# Blog routes should render for both booking and static-web tenants.
if [[ "$SMOKE_SCOPE" != "backend" ]]; then
  check_url "Blog index renders"  "$WEB_TENANT/blog" 200 ""
  # Same chrome assertion on the article route — verifies the dynamic
  # segment still resolves (client-side fetch will then 404 + show the
  # friendly Post-not-found UI; the curl smoke can't see post-hydration).
  check_url "Blog article route resolves"         "$WEB_TENANT/blog/__nonexistent__" 200 ""
else
  echo "  - Blog route render checks skipped (backend-only smoke)"
fi

# 3.2b — comments + likes + settings (added in commit 1).
# Public endpoints accept anyone; verify they're alive (404 for unknown post,
# not 500). Admin endpoints must require auth (401 without session).
check_url "Blog public comments 404"      "$API/api/blog/public/$WEB_TENANT_SLUG/__nonexistent__/comments" 404 ""
check_url "Blog public like state 404"    "$API/api/blog/public/$WEB_TENANT_SLUG/__nonexistent__/like"     404 ""
check_url "Blog admin settings (401)"     "$API/api/blog/settings"   401 ""
check_url "Blog admin comments (401)"     "$API/api/blog/comments"   401 ""
# 3.2b polish — RSS 2.0 feed for the tenant
check_url "Blog RSS feed renders"         "$API/api/blog/public/$WEB_TENANT_SLUG/rss.xml" 200 "<rss"
# 3.2c — Blog categories (admin gated, public listing alive)
check_url "Blog admin categories (401)"   "$API/api/blog/categories" 401 ""
check_url "Blog public categories alive"  "$API/api/blog/public/$WEB_TENANT_SLUG/categories" 200 "categories"

echo "▸ Sprint 3.3 — Advanced SEO"
if [ "$ENV" = "prod" ]; then
  # Prod: a real web tenant's sitemap must be live + indexable.
  check_url "Tenant sitemap.xml"  "$API/api/seo/$WEB_TENANT_SLUG/sitemap.xml" 200 "urlset"
else
  # Staging/local are intentionally noindex (SEO_INDEXING_ENABLED gates to
  # the prod platform), so the sitemap is withheld. Assert that — it's the
  # guard that catches staging leaking into search.
  check_url "Sitemap withheld off-prod (noindex)"  "$API/api/seo/$WEB_TENANT_SLUG/sitemap.xml" 404 ""
fi
check_url "Tenant robots.txt"   "$API/api/seo/$TENANT_SLUG/robots.txt"  200 "User-agent"
# 3.3b — dynamic OG image (SVG)
check_url "Tenant OG image"     "$API/api/seo/$TENANT_SLUG/og-image.svg" 200 "svg"

echo "▸ Sprint 2.7b — Multi-store routing"
check_url "Store brands admin (auth-gated, 401)" "$API/api/store-brands"                 401 ""
if [[ -n "${SHOP_TENANT_SLUG:-}" ]]; then
  check_url "Store brands public"                  "$API/api/storefront/$SHOP_TENANT_SLUG/store-brands" 200 "brands"
else
  echo "  - Store brands public skipped (SMOKE_SHOP_TENANT_${ENV^^} not configured)"
fi

echo "▸ Email override sanity"
# /api/internal/email-mode reports whether THIS deploy is sending real
# customer mail or rerouting to the staging inbox. We hit a silent
# regression on 2026-04-30 where prod had FORCE_EMAIL_OVERRIDE=true
# baked in for months — every booking confirmation + password reset
# was going to the staging inbox instead of the customer. This check
# catches the same class of mistake at deploy time:
#   - on staging we expect "staging"
#   - on prod   we expect "production"
if [[ "$ENV" == "prod" ]]; then
  check_url "Email mode is production"  "$API/api/internal/email-mode" 200 '"mode":"production"'
else
  check_url "Email mode is staging"     "$API/api/internal/email-mode" 200 '"mode":"staging"'
fi

echo "▸ Sprint 3.3 — Pages CMS v2"
# Admin endpoints stay 401-gated without a session.
check_url "Pages admin list (401)"           "$API/api/business/pages"     401 ""
check_url "Site-nav admin GET (401)"         "$API/api/business/site-nav"  401 ""
check_url "Page presets admin (401)"         "$API/api/business/page-presets" 401 ""
check_url "Page from-preset admin (401)"     "$API/api/business/pages/from-preset" 401 ""
# Public storefront endpoints are alive — return JSON for a known tenant
# (the new byPlacement bucket should appear on /pages; siteNav can be null).
check_url "Pages public list returns byPlacement" "$API/api/storefront/$TENANT_SLUG/pages"     200 "byPlacement"
check_url "Site-nav public alive"                 "$API/api/storefront/$TENANT_SLUG/site-nav"  200 "siteNav"
# Public custom block-page route renders (regression check for the
# use(params) hotfix on 2026-04-30 — was 500ing on the parent route)
if [[ "$SMOKE_SCOPE" != "backend" ]]; then
  check_url "Custom block-page renders"             "$TENANT/pages/info/__nonexistent__" 200 "Loading|Page not found"
else
  echo "  - Custom block-page render skipped (backend-only smoke)"
fi

echo
echo "════════════════════════════════════════════════════════════════════"
if [[ $FAIL -eq 0 ]]; then
  echo "  ✓ All $PASS checks passed."
  echo "════════════════════════════════════════════════════════════════════"
  exit 0
fi

echo "  ✗ $FAIL of $((PASS+FAIL)) checks FAILED:"
for c in "${FAILED_CHECKS[@]}"; do echo "    • $c"; done
echo "════════════════════════════════════════════════════════════════════"
exit 1
