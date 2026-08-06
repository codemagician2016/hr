#!/usr/bin/env bash
# purge-cache.sh — purge the Cloudflare cache for the DriftHR zone.
#
#   bash deploy/purge-cache.sh              # purge EVERYTHING on the zone
#   bash deploy/purge-cache.sh https://drifthr.com/ https://drifthr.com/pricing
#                                           # purge only those URLs (preferred)
#
# READ THIS BEFORE REACHING FOR IT — a purge is usually NOT the fix:
#
#   Next.js names every JS/CSS chunk by CONTENT HASH
#   (…/chunks/app/recruitment/form-templates/page-c0978c189f48acd6.js). A deploy
#   produces NEW filenames, so browsers cannot serve a stale bundle — there is
#   nothing to purge. If someone reports "the new feature isn't showing", the
#   cause is almost always one of:
#     • the deploy has not finished (the box step takes minutes after upload),
#     • they are on a different tenant/host than you think,
#     • the feature is gated (permission, entitlement, or a plan gate),
#     • a genuine bug.
#   Purging first hides which of those it was. Check the deploy landed first.
#
#   What a purge DOES help with: the HTML/RSC document layer, marketing pages,
#   images, and anything served with a long max-age at a stable URL.
#
# Credentials come from the environment — never hardcode them here:
#   CLOUDFLARE_API_TOKEN   token with Zone → Cache Purge (Edit) on this zone
#   CF_ZONE_ID             the drifthr.com zone id
# Both already exist on the boxes; export them locally to run this from a laptop.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (needs Zone → Cache Purge: Edit)}"
: "${CF_ZONE_ID:?set CF_ZONE_ID for the drifthr.com zone}"

API="https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache"

if [ "$#" -gt 0 ]; then
  # Targeted purge — always prefer this. Cloudflare accepts up to 30 URLs.
  FILES=$(printf '"%s",' "$@" | sed 's/,$//')
  BODY="{\"files\":[${FILES}]}"
  echo "[purge] $# URL(s) on zone ${CF_ZONE_ID}"
else
  BODY='{"purge_everything":true}'
  echo "[purge] EVERYTHING on zone ${CF_ZONE_ID} — every cached asset is refetched from origin."
  echo "[purge] Scoped to the drifthr.com zone only; sibling products on other domains are untouched."
fi

RESP=$(curl -sS -X POST "$API" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "$BODY")

# Report honestly: Cloudflare answers 200 with success:false on a permission or
# id error, so grepping the body beats trusting the HTTP status.
if printf '%s' "$RESP" | grep -q '"success":true'; then
  echo "[purge] done"
else
  echo "[purge] FAILED:"
  printf '%s\n' "$RESP" | head -20
  exit 1
fi
