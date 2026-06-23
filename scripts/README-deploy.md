# DriftHR deploy runbook

Self-hosted on EC2. The edge router (`apps/router`, PM2 `drifthr-router`, `:3099`)
fronts every surface; nginx OR a cloudflared tunnel sends all hosts to it. See
`DEPLOY_POLICY.md` for the branch/promotion model. This file is the operational
runbook.

## Fleet & ports

| PM2 process        | Mode    | Port | Serves                                          |
| ------------------ | ------- | ---- | ----------------------------------------------- |
| `drifthr-backend`  | cluster | 5000 | `/api/*` (BACKEND_PORT)                          |
| `drifthr-scheduler`| fork    | 5001 | cron/scheduled jobs (BACKEND_RUN_SCHEDULER=1)    |
| `drifthr-router`   | cluster | 3099 | edge host-router (nginx/tunnel proxy here)       |
| `platform`         | cluster | 3000 | drifthr.com / www / admin.drifthr.com            |
| `hr-admin`         | cluster | 3010 | app.drifthr.com tenant HR console                |
| `ess`              | cluster | 3020 | `<slug>.drifthr.com` + bound custom domains      |

Router host-routing: apex/www→platform, admin→platform/superadmin, app→hr-admin,
`<slug>` + custom domains→ess, `/api/*`→backend.

## 1. First-time box setup

```bash
# Node 20 + pm2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx redis-server postgresql
sudo npm i -g pm2

# cloudflared (if using the tunnel option instead of direct nginx origin)
# see https://pkg.cloudflare.com for the apt repo, then `sudo apt-get install cloudflared`

# Clone repo into the env-specific dir (drifthr for staging, drifthr-prod for prod)
git clone <REPO_URL> /home/ubuntu/drifthr-prod && cd /home/ubuntu/drifthr-prod

# Per-box .env files (gitignored) — copy from the templates and fill in:
cp backend/.env.example      backend/.env
cp apps/platform/.env.example apps/platform/.env
cp apps/hr-admin/.env.example apps/hr-admin/.env
cp apps/ess/.env.example      apps/ess/.env
#   edit each: PLATFORM_DOMAIN, DATABASE_URL, JWT_SECRET, SES, Cloudflare token…

# Install deps + build the three frontends
( cd backend && npm ci )
for app in platform hr-admin ess; do ( cd apps/$app && npm ci && npm run build ); done
```

## 2. Database

```bash
cd backend
npx prisma migrate deploy        # forward-only; apply all pending migrations
# npx prisma db seed             # only if a seed is defined and intended
```

## 3. Start / reload the fleet

```bash
# prod box:
pm2 startOrReload ecosystem.config.js --update-env --env production
# staging box:
pm2 startOrReload ecosystem.config.js --update-env
pm2 save                          # persist process list
pm2 startup                       # one-time: install the boot service, then `pm2 save`
```

## 4. nginx (direct origin) OR cloudflared (tunnel) — pick one

```bash
# Option A — nginx terminates TLS, proxies all hosts → router :3099
sudo cp scripts/nginx-drifthr-prod.conf /etc/nginx/sites-available/drifthr.conf
sudo ln -sf /etc/nginx/sites-available/drifthr.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
# TLS: provision the drifthr.com wildcard cert (certbot DNS-01 or CF origin cert).

# Option B — cloudflared tunnel (no public origin IP needed)
sudo cp scripts/cloudflared-drifthr-prod.yml /etc/cloudflared/config.yml
sudo cloudflared service install
sudo systemctl enable --now cloudflared
# then route DNS (see the route-dns comments in the yml).
```

## 5. Ship a frontend update

```bash
# build + push tarball (CI or local)
cd apps/<platform|hr-admin|ess> && npm ci && npm run build && tar -czf <app>.tar.gz .next
aws s3 cp <app>.tar.gz s3://${DRIFTHR_DEPLOY_BUCKET}/<staging|prod>/<app>.tar.gz \
  --region ${AWS_REGION:-ap-south-1}

# swap + restart on the box (via SSM or on-box):
DRIFTHR_DEPLOY_BUCKET=<BUCKET> ./scripts/drifthr-deploy-app.sh <staging|prod> <app>
```

## 6. DNS + Cloudflare-for-SaaS

- In the `drifthr.com` Cloudflare zone, point the **apex + `www` + `app` +
  `admin` + wildcard `*.drifthr.com`** at the box (A/AAAA for direct nginx, or
  tunnel CNAMEs via `cloudflared tunnel route dns`).
- Enable **Cloudflare for SaaS**: set the fallback origin to the box's edge
  hostname (`CLOUDFLARE_CUSTOM_HOSTNAME_FALLBACK_ORIGIN`). The backend creates a
  **custom hostname** per bound tenant domain using `CLOUDFLARE_API_TOKEN`. Those
  domains reach the box through the same path; the router resolves them by
  `X-Tenant-Host` → ESS app.

## 7. Health checks

```bash
pm2 status                                              # all processes online
curl -sf http://127.0.0.1:5000/api/health    && echo OK # backend (adjust path)
curl -sf http://127.0.0.1:3099/ -H 'Host: drifthr.com'  # router → platform
curl -sf http://127.0.0.1:3010/ -H 'Host: app.drifthr.com'   # hr-admin via router
curl -sfI https://drifthr.com/                          # end-to-end through TLS
pm2 logs drifthr-router --lines 50                      # routing errors
```
