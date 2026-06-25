#!/bin/bash
# Block a feature-code change that didn't update qa/playbook.json.
# Genuine non-feature commit? override:  PLAYBOOK_SKIP=1 git commit ...
[ "${PLAYBOOK_SKIP:-0}" = "1" ] && exit 0
STAGED=$(git diff --cached --name-only)
CODE=$(printf '%s\n' "$STAGED" | grep -vE '^(qa/|docs/|.*\.md$|.*lock.*|.*\.txt$|.*\.json$|.*\.ya?ml$)' | grep -E '\.(js|jsx|ts|tsx|dart|go|py|rb|java|kt|vue|svelte|sql|prisma|php)$' || true)
PB=$(printf '%s\n' "$STAGED" | grep -E '^qa/playbook\.json$' || true)
if [ -n "$CODE" ] && [ -z "$PB" ]; then
  echo "⛔ Playbook lockstep: you changed feature code but not qa/playbook.json."
  echo "   A feature isn't done until its playbook reflects it (so testers can test it)."
  echo "   Update qa/playbook.json (feature + use cases), then run ./qa/sync.sh."
  echo "   Genuinely non-feature commit? re-run:  PLAYBOOK_SKIP=1 git commit ..."
  exit 1
fi
exit 0
