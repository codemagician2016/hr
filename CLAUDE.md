## Playbook lockstep (REQUIRED)

A feature is **not done** until `qa/playbook.json` reflects it and `./qa/sync.sh` has been run. When you build or change a feature, update `qa/playbook.json` (the feature + its use cases: login, screen URL, steps, expected result) in the SAME change, then run `./qa/sync.sh` to push it to the QA Portal so it is immediately testable. See `qa/PLAYBOOK_POLICY.md`. A pre-commit hook enforces this.

## Engineering standards (REQUIRED)

Follow the org standards at `/Users/kp/standards` (github.com/codemagician2016/standards — see STANDARDS.md). In particular: the deploy policy (git = record/rollback ledger, no Action on push, manual tarball → S3 → SSM, dev → stag → main, **per-request**), the **playbook lockstep** (a feature is not done until `qa/playbook.json` reflects it and `./qa/sync.sh` is run; a pre-commit hook enforces it), **secrets never in git**, and keep an up-to-date `ARCHITECTURE.md`. Tooling/infra cheat-sheet (AWS/CF/test CLI + box/tunnel map): `/Users/kp/standards/reference/TOOLING.md`.
