# nginx configs (staging + prod)

`aapkatech.com` (staging) and `sitepresso.com` (prod) use the same nginx
shape in front of the Docker compose stack. The compose services bind to host
ports via `network_mode: host`, so nginx proxies to `127.0.0.1:<port>`.

For prod tunnel traffic, `cloudflared` can bypass nginx and route directly to
the same local compose ports; see `docs/CLOUDFLARE_TUNNEL_PROD.md`. Keep this
nginx config healthy anyway: it is the direct-origin rollback path and still
documents the intended host-to-port routing.

## Files

| File | Active path on EC2 | What it covers |
|---|---|---|
| `nginx-aapkatech-staging.conf` | `/etc/nginx/sites-enabled/aapkatech-staging` | apex, api, admin, wildcard tenant subdomain (staging) |
| `nginx-app-aapkatech.conf` | `/etc/nginx/sites-enabled/app.aapkatech` | `app.aapkatech.com` unified-admin (staging) |
| `nginx-sitepresso-prod.conf` | `/etc/nginx/sites-enabled/sitepresso-prod` | apex, api, admin, app, wildcard tenant subdomain (prod) |
| `nginx-hardening.conf` | `/etc/nginx/conf.d/sitepresso-hardening.conf` | shared rate-limit + connection-limit zones |

## Port map

| Service | Staging port | Prod port |
|---|---|---|
| backend (Express)     | 5000 | 5000 |
| platform (Next.js)    | 3000 | 3000 |
| tenant router         | 3099 | 3099 |
| booking public        | 3001 | 3001 |
| shop public           | 3002 | 3002 |
| web public            | 3003 | 3003 |

## The /api/ block

Each platform-fronting host (apex, admin, app) has a `location /api/` block
that proxies **directly** to the backend on `127.0.0.1`. Without it, Next.js's
`/api/:path*` rewrite tries to fetch through the public DNS (`api.<domain>`),
the EC2 hairpins out to Cloudflare/CrowdSec and back, the loopback HTTPS
handshake gets dropped, and POST /api/auth/login times out. We hit this
2026-04-30 — super-admin login was 500ing.

If you add a new host that proxies to the platform, copy the `/api/` block
template from one of the existing hosts.

## Deploying a change

1. Edit the file in `scripts/`.
2. SCP to the EC2:
   ```bash
   scp -i ~/.ssh/appointease-key.pem scripts/nginx-aapkatech-staging.conf \
       ubuntu@13.234.124.224:/tmp/aapkatech-staging.new
   ```
3. SSH and swap, validate, reload:
   ```bash
   ssh -i ~/.ssh/appointease-key.pem ubuntu@13.234.124.224
   sudo cp /etc/nginx/sites-enabled/aapkatech-staging \
           /etc/nginx/sites-enabled/aapkatech-staging.bak-$(date +%s)
   sudo cp /tmp/aapkatech-staging.new /etc/nginx/sites-enabled/aapkatech-staging
   sudo nginx -t && sudo systemctl reload nginx
   ```
4. Verify with the smoke test:
   ```bash
   scripts/smoke-test.sh staging
   ```

## What the smoke test catches

`scripts/smoke-test.sh` covers, among many other things:

- POST `/api/auth/login` on the apex, app.\*, and admin.\* hosts returns 400
  (not 500/timeout) — proves the `/api/` proxy block is in place.
- The version endpoint on each host reports the right `app` field
  (`platform` for apex/admin/app, `business` for tenant subdomains) — proves
  the `proxy_pass` ports are correct.

If you ever change a host's upstream port and forget to update the matching
nginx server block, smoke fails fast.
