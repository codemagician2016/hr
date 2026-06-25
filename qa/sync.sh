#!/bin/bash
# Push this project's playbook to the QA Portal so testers can test it immediately.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f qa/.env ] && { set -a; . qa/.env; set +a; }
: "${QA_PORTAL_URL:=https://test.vedicbyte.in}"
[ -z "${QA_AGENT_TOKEN:-}" ] && { echo "Set QA_AGENT_TOKEN in qa/.env (copy qa/.env.example)"; exit 1; }
echo "Syncing qa/playbook.json -> $QA_PORTAL_URL"
curl -fsS -X POST "$QA_PORTAL_URL/api/qa/agent/playbook/import" \
  -H "Authorization: Bearer $QA_AGENT_TOKEN" -H "Content-Type: application/json" \
  --data-binary @qa/playbook.json
echo
