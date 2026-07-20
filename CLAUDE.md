## Playbook (RETIRED as of 2026-07-20)

The playbook/QA-portal process is **stopped**. Do NOT update `qa/playbook.json` and do NOT run `./qa/sync.sh` as part of building features. Only touch the playbook when the user explicitly asks for it. (The pre-commit check `qa/check-playbook.sh` is neutered to a no-op; manual test guidance now lives in each feature's doc under `docs/features/`.)

## Engineering standards (REQUIRED)

Follow the org standards at `/Users/kp/standards` (github.com/codemagician2016/standards — see STANDARDS.md). In particular: the deploy policy (git = record/rollback ledger, no Action on push, manual tarball → S3 → SSM, dev → stag → main, **per-request**), **secrets never in git**, and keep an up-to-date `ARCHITECTURE.md`. (Playbook lockstep is RETIRED — see above.) Tooling/infra cheat-sheet (AWS/CF/test CLI + box/tunnel map): `/Users/kp/standards/reference/TOOLING.md`.
