#!/usr/bin/env bash
# install-hooks.sh — install this repo's git hooks.
#
# .git/hooks is not version-controlled, so a fresh clone has no hooks at all.
# Run this once after cloning:
#
#   bash qa/install-hooks.sh
#
# Installs a pre-commit hook that runs:
#   qa/check-branch.sh       refuses commits on the staging/main deploy branches
#   qa/check-ui-contracts.sh catches value-vs-event misuse of the shared inputs
#   qa/check-playbook.sh  retired playbook check (a no-op; kept so the hook
#                         shape matches what the other repos expect)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/.git/hooks/pre-commit"

mkdir -p "$ROOT/.git/hooks"
cat > "$HOOK" <<'HOOK_EOF'
#!/bin/bash
ROOT="$(git rev-parse --show-toplevel)"
# Deploy branches are a shipped-record, not a work branch — see qa/check-branch.sh.
bash "$ROOT/qa/check-branch.sh" || exit 1
bash "$ROOT/qa/check-ui-contracts.sh" || exit 1
bash "$ROOT/qa/check-playbook.sh" || exit 1
HOOK_EOF
chmod +x "$HOOK"

echo "installed $HOOK"
echo "  - refuses commits on 'staging' and 'main' (override: ALLOW_DEPLOY_BRANCH_COMMIT=1)"
