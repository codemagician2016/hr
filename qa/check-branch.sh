#!/usr/bin/env bash
# check-branch.sh — refuse commits made directly on a DEPLOY branch.
#
# Why this exists: deploy/ship-staging.sh and deploy/ship-prod.sh must be run
# from `staging` and `main` respectively, and they leave you parked there. The
# next commit then lands on a deploy branch instead of `development`, silently
# inverting the dev -> staging -> main ladder. That happened three times in one
# session; each time it was caught by luck rather than by design, and once it put
# four commits on `main` that were never meant to be there.
#
# The ladder only works if work is authored in one place. This makes the mistake
# impossible rather than merely unlikely.
#
# Escape hatch, for the rare legitimate hotfix authored on a deploy branch:
#   ALLOW_DEPLOY_BRANCH_COMMIT=1 git commit ...
set -uo pipefail

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"

# Detached HEAD (rebase, bisect, cherry-pick) is not a branch mistake — let it be.
[ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ] && exit 0

case "$BRANCH" in
  staging|main)
    if [ "${ALLOW_DEPLOY_BRANCH_COMMIT:-}" = "1" ]; then
      echo "[check-branch] committing on '$BRANCH' — allowed via ALLOW_DEPLOY_BRANCH_COMMIT=1"
      exit 0
    fi
    cat >&2 <<EOF

  ✗ Refusing to commit on '$BRANCH' — that is a DEPLOY branch, not a work branch.

    Deploy branches are a record of what shipped. Work is authored on
    'development' and promoted:  development -> staging -> main.

    You are most likely here because a ship script left you on '$BRANCH'.

    To move what you have onto development:

        git stash                 # if you have staged/unstaged work
        git checkout development
        git stash pop
        git commit ...

    If commits are ALREADY on '$BRANCH' and unpushed, fast-forward development
    to pick them up, then re-push the ladder in order:

        git checkout development && git merge --ff-only $BRANCH
        git push origin development
        git checkout staging && git merge --ff-only development && git push origin staging
        git checkout main    && git merge --ff-only staging     && git push origin main

    Genuinely need to commit here (a hotfix authored on the deploy branch)?

        ALLOW_DEPLOY_BRANCH_COMMIT=1 git commit ...

EOF
    exit 1
    ;;
esac

exit 0
