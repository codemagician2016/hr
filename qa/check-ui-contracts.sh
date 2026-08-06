#!/usr/bin/env bash
# check-ui-contracts.sh — catch value-vs-event misuse of the shared inputs.
#
# TextInput/TextArea/DateInput/TimeInput (packages/ui/admin.js) hand their
# onChange the STRING VALUE, not the DOM event. Writing the event form:
#
#     onChange={(e) => setX(e.target.value)}
#
# does NOT fail the build or the render — `e` is the string, `e.target` is
# undefined, and it throws on the FIRST KEYSTROKE. The field silently refuses to
# accept typing and looks disabled. That shipped to a customer as "unable to type
# in new job form", across 18 call sites, because nothing mechanical caught it.
#
# Run standalone or from pre-commit.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

HITS=$(grep -rnE "<(TextInput|TextArea|DateInput|TimeInput)[^>]*onChange=\{\(e\)" \
  "$ROOT/apps" --include='*.js' 2>/dev/null || true)

if [ -n "$HITS" ]; then
  echo
  echo "  ✗ Shared input components pass a VALUE to onChange, not an event."
  echo
  printf '%s\n' "$HITS" | sed "s|$ROOT/||" | sed 's/^/      /'
  echo
  echo "    Fix:  onChange={(e) => setX(e.target.value)}   →   onChange={(v) => setX(v)}"
  echo
  echo "    These throw on the first keystroke, so the field looks disabled rather"
  echo "    than erroring — the build and a page load both stay green."
  echo
  exit 1
fi

echo "[check-ui-contracts] ok — no value/event misuse of the shared inputs"
