#!/usr/bin/env bash
# ship.sh — the ONE deploy command for Sitepresso. See DEPLOY_POLICY.md.
#
#   scripts/ship.sh staging   → archives `staging` branch → deploys to staging box
#   scripts/ship.sh prod      → archives `main`    branch → deploys to prod box
#
# Replaces the 6-step manual tarball+SSM dance. It git-archives the COMMITTED
# branch tip, uploads to the deploy bucket, then SSMs the right box to backup,
# pull (fresh — see stale-tarball note), extract, and run scripts/deploy.sh.
# Never hand-edit a box; only ship.
#
# Promotion discipline (keeps branches from diverging — the thing that caused the
# 2026-06-03 infra-merge mess): commit ONLY to `development`. Promote with
# `git checkout staging && git merge --ff-only development` (then `ship staging`),
# and `git checkout main && git merge --ff-only staging` (then `ship prod`). If a
# --ff-only ever fails, someone hand-committed to a deploy branch — fix THAT,
# never resolve it with a parallel merge.
set -euo pipefail

ENV="${1:-}"
case "$ENV" in
  staging) BRANCH=staging; IID=i-0b56a46bbd9c4fd60; LABEL=staging ;;
  prod)    BRANCH=main;    IID=i-0edf302e16d3c8d35; LABEL=prod ;;
  *) echo "usage: $(basename "$0") <staging|prod>"; exit 2 ;;
esac

# Pinned AWS context (see DEPLOY_POLICY.md → "AWS CLI").
export PATH="/Users/kp/Library/Python/3.9/bin:$PATH"
export AWS_PROFILE="${AWS_PROFILE:-admin}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-south-1}"
BUCKET="s3://sp-deploy-624517878372"
KEY="sp-${BRANCH}.tgz"

COMMIT=$(git rev-parse --short "$BRANCH")
echo "▶ ship $ENV  (branch=$BRANCH  box=$IID  commit=$COMMIT)"
git log --oneline -1 "$BRANCH" | sed 's/^/   /'

# 1) Build + upload the tarball from the committed branch tip.
git archive --format=tar.gz -o "/tmp/$KEY" "$BRANCH"
aws s3 cp "/tmp/$KEY" "$BUCKET/$KEY" >/dev/null
echo "   ✓ uploaded $KEY"

# 2) Deploy on the box. rm the (possibly root-owned) stale tarball FIRST — a
#    root-owned /tmp/sp-*.tgz silently blocks the sudo -u ubuntu pull (sticky
#    /tmp) and you'd extract stale code. Then prune old rollback archives before
#    taking the next backup so deploys cannot fill the box, pull fresh, extract,
#    deploy.
CID=$(aws ssm send-command --instance-ids "$IID" --document-name AWS-RunShellScript \
  --comment "ship $ENV $COMMIT" --timeout-seconds 600 \
  --parameters commands="[
    \"rm -f /tmp/$KEY\",
    \"sudo -u ubuntu -H bash -c 'ls -1t /home/ubuntu/sp-prebackup*.tgz 2>/dev/null | tail -n +6 | xargs -r rm -f'\",
    \"sudo -u ubuntu -H bash -c 'cd /home/ubuntu && tar czf sp-prebackup-\$(date +%s).tgz sitepresso 2>/dev/null'\",
    \"sudo -u ubuntu -H bash -c 'aws s3 cp $BUCKET/$KEY /tmp/$KEY'\",
    \"sudo -u ubuntu -H bash -c 'tar xzf /tmp/$KEY -C /home/ubuntu/sitepresso'\",
    \"sudo -u ubuntu -H bash -c 'echo $COMMIT > /home/ubuntu/sitepresso/.build-commit'\",
    \"sudo -u ubuntu -H ENV_LABEL=$LABEL bash /home/ubuntu/sitepresso/scripts/deploy.sh\"
  ]" --query Command.CommandId --output text)
echo "   ▸ ssm $CID — deploying…"

# 3) Wait + report the smoke gate.
while :; do
  ST=$(aws ssm list-command-invocations --command-id "$CID" --query "CommandInvocations[0].Status" --output text 2>/dev/null || echo Pending)
  case "$ST" in Success|Failed|TimedOut|Cancelled) break ;; esac
  sleep 6
done
aws ssm get-command-invocation --command-id "$CID" --instance-id "$IID" \
  --query StandardOutputContent --output text 2>/dev/null \
  | grep -iE "SMOKE:|deploy complete|FATAL|✗ down|✗ " | sed 's/^/   /' || true

if [ "$ST" = "Success" ]; then
  echo "✓ ship $ENV done ($COMMIT)"
else
  echo "✗ ship $ENV FAILED ($ST). Inspect:"
  echo "   aws ssm get-command-invocation --command-id $CID --instance-id $IID --query StandardOutputContent --output text"
  exit 1
fi

# ── Playbook lockstep: auto-sync the QA playbook after a successful deploy ──
# Runs LOCALLY (reads the token from the gitignored qa/.env), so no secret on the
# box. Non-fatal — a sync hiccup never affects the deploy that already succeeded.
if [ -f qa/sync.sh ]; then
  bash qa/sync.sh >/dev/null 2>&1 && echo "   ✓ playbook synced" || echo "   ⚠ playbook sync skipped (set qa/.env token)"
fi
