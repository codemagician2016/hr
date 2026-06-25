# Playbook lockstep policy — DRIFTHR

**A feature is not "done" until its test playbook reflects it.**

When you build or change a feature in this repo, in the SAME change you MUST:
1. Update `qa/playbook.json` — add/modify the feature + its use cases (which login,
   the screen URL, click-by-click steps, and the expected result a tester verifies).
   Each use case needs a stable kebab `key` (unique within its feature).
2. Run `./qa/sync.sh` — pushes it to the QA Portal so testers see it immediately
   and can mark Pass/Fail and file bugs (which the AI fix-loop then picks up).

The pre-commit hook (`qa/check-playbook.sh`) blocks a feature-code commit that
didn't touch `qa/playbook.json`. Override a genuine non-feature commit with
`PLAYBOOK_SKIP=1 git commit …`. Project key on the portal: **DRIFTHR**.
The sync token lives in `qa/.env` (gitignored — copy `qa/.env.example`).
