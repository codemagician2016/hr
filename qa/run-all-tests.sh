#!/usr/bin/env bash
# run-all-tests.sh — run EVERY test suite in the repo and print a per-suite
# pass/fail matrix, so "does feature X still work end-to-end?" has an answer you
# can read in one screen instead of 300 files you have to remember to run.
#
#   bash qa/run-all-tests.sh              # everything
#   bash qa/run-all-tests.sh payroll      # only suites whose path matches 'payroll'
#
# Live-DB suites run against the ISOLATED hr_test schema (never the dev public
# schema) — same convention the individual suites already document. A suite that
# needs a DB self-skips when DATABASE_URL is unset, so this is safe to run
# anywhere; skipped is reported distinctly from passed so a skip can never be
# mistaken for coverage.
set -uo pipefail
# Job control off: the watchdog below is killed on every successful suite, and
# with monitor mode on the shell prints a "Killed: 9" line for each one, which
# buries the actual results.
set +m
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/backend"

FILTER="${1:-}"
PER_SUITE_TIMEOUT="${TEST_TIMEOUT:-300}"

# Live schema for the DB-backed suites (repo .env DATABASE_URL + ?schema=hr_test).
BASE_URL="$(grep -m1 '^DATABASE_URL' .env 2>/dev/null | cut -d'"' -f2 || true)"
if [ -n "$BASE_URL" ]; then
  export DATABASE_URL="${BASE_URL}?schema=hr_test"
  echo "DB suites → hr_test schema"
else
  echo "WARNING: no DATABASE_URL in backend/.env — every DB-backed suite will SKIP, not pass."
fi

PASS=0; FAIL=0; SKIP=0
FAILED_SUITES=""
RESULTS="$(mktemp)"

# macOS has no coreutils `timeout`; emulate with a watchdog subshell.
run_with_timeout() {
  local secs="$1"; shift
  "$@" >"$OUT" 2>&1 &
  local pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) 2>/dev/null &
  local watchdog=$!
  # disown so the shell drops it from the job table — otherwise killing the
  # watchdog after every passing suite prints a "Killed: 9" line that buries
  # the results we actually came for.
  disown "$watchdog" 2>/dev/null || true
  wait "$pid" 2>/dev/null; local code=$?
  kill -9 "$watchdog" 2>/dev/null
  return $code
}

run_suite() {
  local file="$1" label="$2"
  [ -n "$FILTER" ] && [[ "$file" != *"$FILTER"* ]] && return 0
  OUT="$(mktemp)"
  # Two runners live in this repo. A suite written with describe()/it() needs
  # jest; running it with plain `node` throws "describe is not defined", which
  # looks like a broken feature and is really a dispatch mistake. Pick by content.
  if grep -qE "^\s*(describe|test|it)\(" "$file" 2>/dev/null; then
    run_with_timeout "$PER_SUITE_TIMEOUT" npx jest --silent "$file"
  else
    run_with_timeout "$PER_SUITE_TIMEOUT" node "$file"
  fi
  local code=$?
  # A suite that prints an explicit skip (no DB, no toolchain) is NOT a pass.
  # Echo every verdict live as well as recording it — a run this long is
  # unreadable if the first sign of progress is the summary 40 minutes in.
  if grep -qiE '^\[skip\]|\[skip\] ' "$OUT" && [ $code -eq 0 ]; then
    SKIP=$((SKIP+1)); printf 'SKIP  %s\n' "$label" | tee -a "$RESULTS"
  elif [ $code -eq 0 ]; then
    PASS=$((PASS+1)); printf 'PASS  %s\n' "$label" | tee -a "$RESULTS"
  else
    FAIL=$((FAIL+1)); FAILED_SUITES="$FAILED_SUITES$label\n"
    printf 'FAIL  %s  (exit %s)\n' "$label" "$code" | tee -a "$RESULTS"
    { echo "----- $label -----"; tail -25 "$OUT"; echo; } >>"$RESULTS.detail"
  fi
  rm -f "$OUT"
}

echo
echo "=== module suites (backend/src/**/__tests__) ==="
while IFS= read -r f; do
  run_suite "$f" "${f#./}"
done < <(find ./src -path '*__tests__*' -name '*.test.js' | sort)

echo "=== integration / e2e (backend/test/e2e) ==="
while IFS= read -r f; do
  run_suite "$f" "${f#./}"
done < <(find ./test/e2e -name '*.js' | sort)

echo "=== feature e2e (qa/e2e) ==="
while IFS= read -r f; do
  run_suite "$f" "qa/e2e/$(basename "$f")"
done < <(find "$ROOT/qa/e2e" -name '*.js' | sort)

echo
echo "════════════════════ RESULTS ════════════════════"
sort "$RESULTS" | grep '^FAIL' || true
echo "─────────────────────────────────────────────────"
printf 'PASS %s   FAIL %s   SKIP %s   (total %s)\n' "$PASS" "$FAIL" "$SKIP" "$((PASS+FAIL+SKIP))"
if [ -f "$RESULTS.detail" ]; then
  echo
  echo "════════════════════ FAILURE DETAIL ════════════════════"
  cat "$RESULTS.detail"
fi
rm -f "$RESULTS" "$RESULTS.detail"
[ "$FAIL" -eq 0 ]
