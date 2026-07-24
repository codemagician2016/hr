#!/bin/bash
# Repeatable perf benchmark. Usage: perfbench.sh <label>
LABEL="${1:-run}"
echo "=== PERF BENCH [$LABEL] $(date -u +%H:%M:%SZ) ==="
echo "-- page TTFB (3 runs, median matters) --"
for u in https://app-staging.drifthr.com/ https://m-demo-staging.drifthr.com/; do
  ts=""
  for i in 1 2 3; do
    t=$(curl -s -o /dev/null -m 30 -w '%{time_starttransfer}' "$u" 2>/dev/null)
    ts="$ts $t"
  done
  sz=$(curl -s -o /dev/null -m 30 -w '%{size_download}' "$u" 2>/dev/null)
  printf '  %-42s ttfb:%s  html=%sB\n' "$u" "$ts" "$sz"
done
echo "-- first-load asset weight (login page) --"
HTML=$(curl -s -L -m 30 https://app-staging.drifthr.com/ 2>/dev/null)
echo "$HTML" | grep -oE '/_next/static/[^"]+\.(js|css)' | sort -u > /tmp/pb_assets.txt
N=$(wc -l < /tmp/pb_assets.txt | tr -d ' ')
TOT=0
while read a; do
  s=$(curl -s -o /dev/null -m 20 -w '%{size_download}' "https://app-staging.drifthr.com$a" 2>/dev/null)
  TOT=$((TOT + s))
done < /tmp/pb_assets.txt
echo "  assets=$N  total_transferred=${TOT}B (~$((TOT/1024))KB brotli)"
echo "=== END [$LABEL] ==="
