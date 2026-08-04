# DriftHR Deploy Policy

> Modeled on the Sitepresso deploy policy. The one rule to internalize:
>
> **Git is a record / rollback ledger, not a deployer.** Pushing to a branch
> does not move bits to a server. Deploys are an explicit, scripted action that
> builds an artifact and ships it to a box. The branch only records *what* is
> (or was) deployed, so we can audit and roll back.

DriftHR is self-hosted on EC2 boxes. There is no Vercel/managed frontend — the
edge router (`apps/router`, PM2 `drifthr-router`, `:3099`) fronts every surface
on the box, so all deploys are "push a build to the box + reload PM2".

---

## Branch model

| Branch        | Runs where        | PLATFORM_DOMAIN          | Promotion           |
| ------------- | ----------------- | ------------------------ | ------------------- |
| `development` | local dev only    | `localhost`              | merge → `staging`   |
| `staging`     | staging EC2 box   | `staging.drifthr.com`    | merge → `main`      |
| `main`        | prod EC2 box      | `drifthr.com`            | tag/rollback ledger |

- Never deploy off a feature branch. Merge to `staging`, deploy, verify, then
  fast-forward `main`.
- A commit being on `main` does NOT mean it is live. Live = "the artifact built
  from this commit was shipped and PM2 reloaded." Record the deployed commit
  (`BUILD_COMMIT`) so the ledger and the box agree.
- **Never author a commit on `staging` or `main`.** They are a record of what
  shipped; work is authored on `development` and promoted. This is easy to get
  wrong because the ship scripts must be run from the deploy branch and used to
  leave you parked there — the next commit then lands on `staging`/`main` and
  silently inverts the ladder. Two guards now exist:
  - `deploy/ship-staging.sh` / `ship-prod.sh` return you to `development` on the
    way out, including when the ship fails.
  - A pre-commit hook (`qa/check-branch.sh`) refuses commits on a deploy branch
    and prints the recovery steps. Override for a genuine hotfix authored there:
    `ALLOW_DEPLOY_BRANCH_COMMIT=1 git commit …`

  `.git/hooks` is not version-controlled, so after cloning run once:

  ```bash
  bash qa/install-hooks.sh
  ```

---

## Frontend deploy (platform / hr-admin / ess)

Each Next app is built into a `.next` tarball, pushed to S3, and hot-swapped on
the box. App is one of `platform | hr-admin | ess`.

1. **Build** (CI or locally, from the app dir):
   ```bash
   cd apps/<app> && npm ci && npm run build
   tar -czf <app>.tar.gz .next
   ```
2. **Ship to S3**:
   ```bash
   aws s3 cp <app>.tar.gz \
     s3://${DRIFTHR_DEPLOY_BUCKET}/<staging|prod>/<app>.tar.gz \
     --region ${AWS_REGION:-ap-south-1}
   ```
3. **Swap + reload on the box** via SSM Run Command (no SSH keys needed):
   ```bash
   aws ssm send-command \
     --instance-ids <BOX_INSTANCE_ID> \
     --document-name AWS-RunShellScript \
     --parameters 'commands=["sudo -u ubuntu DRIFTHR_DEPLOY_BUCKET=<BUCKET> /home/ubuntu/drifthr-deploy-app.sh <env> <app>"]' \
     --region ${AWS_REGION:-ap-south-1}
   ```
   `drifthr-deploy-app.sh` downloads the tarball, swaps `.next`, and
   `pm2 restart`s the app.

**Alternative (no S3): `git archive` + SSM.** Push to the branch, then on the
box `git fetch && git checkout <sha>`, `npm ci && npm run build`, `pm2 reload`.
Slower (builds on the box) but needs no bucket. S3 + prebuilt tarball is preferred.

---

## Backend deploy (drifthr-backend / drifthr-scheduler)

Backend ships as source (code on the box) + a migration step. Order matters —
migrate the DB **before** reloading code that expects the new schema.

```bash
# on the box, in the repo dir
git fetch && git checkout <sha>
cd backend && npm ci
npx prisma migrate deploy          # apply pending migrations (forward-only)
pm2 reload drifthr-backend --update-env
pm2 restart drifthr-scheduler --update-env
```

- `prisma migrate deploy` is forward-only and idempotent. Never run
  `migrate dev` / `db push` against staging or prod.
- Reload (not restart) the API cluster for zero-downtime; the scheduler is a
  single fork, so restart it.

---

## Rollback

- **Frontend**: keep the previous `<app>.tar.gz` in S3 (versioned bucket or a
  `prev/` prefix). Re-run `drifthr-deploy-app.sh <env> <app>` after restoring the
  old key, or `aws s3 cp` the prior version back over the current key and re-run.
- **Backend code**: `git checkout <previous-sha>`, `npm ci`, `pm2 reload`.
- **Backend schema**: migrations are forward-only. Roll back by shipping a NEW
  migration that reverses the change — do NOT hand-edit `_prisma_migrations`.
  Always take a DB snapshot before a risky migration so you have an escape hatch.
- **Whole box**: `pm2 startOrReload ecosystem.config.js` re-resurrects the fleet
  to the declared state.

---

## Secrets

- All secrets live in per-box, gitignored `.env` files (see `*/.env.example`).
- Never commit real credentials. Deploy scripts read bucket/region/box IDs from
  the environment or `<PLACEHOLDER>`s filled in by the operator.
- AWS access on the box is via the EC2 **instance IAM role** (S3 read, SES send),
  not long-lived keys baked into env where avoidable.

---

## Placeholders to fill before first deploy

| Placeholder              | What it is                                            |
| ------------------------ | ----------------------------------------------------- |
| `<BOX_INSTANCE_ID>`      | EC2 instance ID of the staging / prod box             |
| `${DRIFTHR_DEPLOY_BUCKET}` / `<BUCKET>` | S3 bucket for build tarballs           |
| `${AWS_REGION}`          | AWS region (default `ap-south-1`)                     |
| `<sha>`                  | the git commit being deployed (the ledger entry)      |
| `drifthr.com` specifics  | apex/wildcard domain, cert paths, Cloudflare zone/IDs |
