#!/bin/bash
# ONE-TIME migration: move staging from finalstaging.sitepresso.com → aapkatech.com
#
# Run on the staging EC2 (via EC2 Instance Connect):
#   bash /home/ubuntu/appointease/scripts/migrate-to-aapkatech-staging.sh
#
# Works whether run as root or as ubuntu — PM2 commands automatically
# drop to the ubuntu user when the script is launched as root.
#
# Idempotent: safe to re-run if anything is half-done.

set -euo pipefail

REPO=/home/ubuntu/appointease
echo "=== Sitepresso staging migration → aapkatech.com ==="

# PM2 runs as the ubuntu user. If we're root, drop to ubuntu for pm2/builds.
# Always go through `bash -c` so the call sites can pass a single quoted
# string (e.g. "cd … && npm run build") and have it shell-interpreted.
if [ "$(id -un)" = "ubuntu" ]; then
  run_as_user() { bash -lc "$*"; }
else
  run_as_user() { sudo -iu ubuntu bash -c "$*"; }
fi

# 1. Backend env
sed -i 's|^PLATFORM_DOMAIN=.*|PLATFORM_DOMAIN=aapkatech.com|' "$REPO/backend/.env"
sed -i 's|^FRONTEND_URL=.*|FRONTEND_URL=https://aapkatech.com|' "$REPO/backend/.env"
echo "✅ backend env updated"

# 2. Platform env
cat > "$REPO/apps/platform/.env" <<'EOF'
NEXT_PUBLIC_API_URL=https://api.aapkatech.com
NEXT_PUBLIC_GOOGLE_CLIENT_ID=1023863517316-oqoir7mec30cgvssaopap59e9r6n9vc7.apps.googleusercontent.com
NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=
NEXT_PUBLIC_PADDLE_ENVIRONMENT=sandbox
NEXT_PUBLIC_PLATFORM_DOMAIN=aapkatech.com
EOF
echo "✅ platform env updated"

# 3. Business env
cat > "$REPO/business/.env" <<'EOF'
NEXT_PUBLIC_API_URL=https://api.aapkatech.com
NEXT_PUBLIC_PLATFORM_DOMAIN=aapkatech.com
NEXT_PUBLIC_PLATFORM_URL=https://aapkatech.com
EOF
echo "✅ business env updated"

# 4. Nginx config — drop old, install new
sudo rm -f /etc/nginx/sites-enabled/appointease /etc/nginx/sites-enabled/sitepresso-staging

sudo tee /etc/nginx/sites-available/aapkatech-staging > /dev/null <<'EOF'
# Platform → port 3000 (apex + www; without www the wildcard block below
# catches it and serves the business app instead)
server {
    listen 80;
    server_name aapkatech.com www.aapkatech.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# Backend API → port 5000
server {
    listen 80;
    server_name api.aapkatech.com;
    client_max_body_size 30M;
    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# Tenant storefronts (any other subdomain) → business app port 3001
server {
    listen 80;
    server_name *.aapkatech.com;
    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/aapkatech-staging /etc/nginx/sites-enabled/aapkatech-staging
sudo nginx -t && sudo systemctl reload nginx
echo "✅ nginx reloaded"

# 5. Reload backend (as ubuntu so pm2 finds the daemon)
run_as_user "pm2 reload appointease-backend --update-env"
echo "✅ backend reloaded"

# 6. Rebuild platform
run_as_user "cd $REPO/platform && npm run build && pm2 restart appointease-platform --update-env"
echo "✅ platform rebuilt"

# 7. Build + start business
# Always recreate the PM2 entry from inside the business dir. `pm2 start npm`
# saves the CWD at registration time, so if a prior entry was created from a
# wrong directory (e.g. /home/ubuntu) every restart fails with ENOENT on
# package.json. Delete + re-create from the correct cwd is idempotent and
# fixes any historical mis-registration.
run_as_user "cd $REPO/business && npm install --silent && npm run build"
run_as_user "cd $REPO/business && pm2 delete appointease-business 2>/dev/null || true; cd $REPO/business && pm2 start npm --name appointease-business -- start"
run_as_user "pm2 save"
echo "✅ business built + running"

echo ""
run_as_user "pm2 list"
echo ""
echo "=== Migration complete ==="
echo "Test: https://aapkatech.com (platform)"
echo "Test: https://api.aapkatech.com/health (backend)"
echo "Test: https://shreya.aapkatech.com (tenant storefront)"
