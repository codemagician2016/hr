#!/bin/bash
# Post-deploy smoke test + standalone health check.
#
# HARD GATE: every required local service must respond (catches the root cause of
# the tenant-502s — a storefront/sub-app silently not running). A service is
# "down" only if the connection is refused (curl code 000); any HTTP status
# (200/307/404/…) means the process is up and serving.
#
# ADVISORY: public URLs, which can lag behind DNS/CDN and shouldn't fail a deploy.
#
# Usage:  scripts/smoke.sh [staging|prod]
# Exit 0 = healthy, 1 = a required service is down.

set -uo pipefail
ENV_LABEL="${1:-staging}"
case "$ENV_LABEL" in
  prod) DOMAIN="sitepresso.com" ;;
  *)    DOMAIN="aapkatech.com" ;;
esac

fail=0
echo "== smoke (${ENV_LABEL} / ${DOMAIN}) =="

# Required local services — must match ecosystem.config.js + apps/router/index.js.
# "port:name"
SERVICES="\
5000:backend 3099:router 3000:platform 3700:aapkarider-api 3701:aapkarider-console 3801:qa-portal \
3001:booking-public 3012:booking-staff 3013:booking-customer \
3002:shop-public 3022:shop-staff-manager 3023:shop-staff-delivery 3024:shop-customer \
3003:web-public 3032:web-staff 3033:web-customer"

# Probe a URL; retry up to 3× to tolerate a service still accepting its first
# connections right after a reload. Echoes the final HTTP code ("000" = refused).
# NB: curl -w already prints "000" on failure, so do NOT add `|| echo 000`
# (it concatenates into "000000" and defeats the down check).
probe() {
  local url="$1" code=""
  for _ in 1 2 3; do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 6 "$url" 2>/dev/null)
    code=${code:-000}
    [ "$code" != "000" ] && break
    sleep 2
  done
  echo "$code"
}

echo "-- local services (hard gate) --"
for s in $SERVICES; do
  port="${s%%:*}"; name="${s##*:}"
  code=$(probe "http://localhost:${port}/")
  if [ "$code" = "000" ]; then
    echo "  ✗ DOWN  ${name} (:${port})"; fail=1
  else
    echo "  ✓ up    ${name} (:${port}) [${code}]"
  fi
done

# Backend health endpoint (hard)
ver=$(probe "http://localhost:5000/version")
if [ "$ver" = "200" ]; then echo "  ✓ backend /version [200]"; else echo "  ✗ backend /version [${ver}]"; fail=1; fi

# Standalone AapkaRider API health (hard)
rider=$(probe "http://localhost:3700/health")
if [ "$rider" = "200" ]; then echo "  ✓ aapkarider /health [200]"; else echo "  ✗ aapkarider /health [${rider}]"; fail=1; fi

echo "-- public URLs (advisory) --"
for u in "https://api.${DOMAIN}/api/subscription/paddle-config" "https://app.${DOMAIN}/" "https://rider-api.${DOMAIN}/health" "https://rider.${DOMAIN}/" "https://test.aapkatech.com/"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 12 -L "$u" 2>/dev/null || echo 000)
  echo "  ${code}  ${u}"
done

if [ "$fail" = "0" ]; then echo "SMOKE: PASS"; exit 0; else echo "SMOKE: FAIL (a required service is down)"; exit 1; fi
