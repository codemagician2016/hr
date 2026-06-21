#!/bin/bash
# watchdog.sh — runtime self-heal for the Sitepresso fleet. Run from cron every
# few minutes (as the `ubuntu` user). For each required service, if its local
# port is refused twice in a row, restart it from ecosystem.config.js. Covers
# crashes / SSR hangs / OOM-kills that PM2's own autorestart can miss, and
# re-creates a process that somehow got deleted.
#
# Install (ubuntu crontab):
#   */3 * * * * /bin/bash /home/ubuntu/sitepresso/scripts/watchdog.sh

set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:/home/ubuntu/.npm-global/bin:$PATH"

REPO="${REPO:-/home/ubuntu/sitepresso}"
ENV_LABEL="${ENV_LABEL:-staging}"
ENV_FLAG=""
[ "$ENV_LABEL" = "prod" ] && ENV_FLAG="--env production"
LOG="/home/ubuntu/sitepresso-watchdog.log"

# port:pm2-name — must match ecosystem.config.js + smoke.sh
SERVICES="\
5000:sitepresso-backend 3099:sp-router 3000:platform \
3001:booking-public 3012:booking-staff 3013:booking-customer \
3002:shop-public 3022:shop-staff-manager 3023:shop-staff-delivery 3024:shop-customer \
3003:web-public 3032:web-staff 3033:web-customer"

probe() { local c; c=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:$1/" 2>/dev/null); echo "${c:-000}"; }

for s in $SERVICES; do
  port="${s%%:*}"; name="${s##*:}"
  [ "$(probe "$port")" = "000" ] || continue
  sleep 3
  [ "$(probe "$port")" = "000" ] || continue   # transient — ignore
  echo "$(date -Is) DOWN ${name} (:${port}) — restarting" >> "$LOG"
  pm2 restart "$name" >/dev/null 2>&1 \
    || pm2 start "$REPO/ecosystem.config.js" --only "$name" $ENV_FLAG >/dev/null 2>&1
done
