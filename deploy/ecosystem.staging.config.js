// DriftHR HMS — STAGING PM2 fleet for the SHARED staging box (i-0b56a46bbd9c4fd60).
//
// Declares ONLY drifthr-hms-* apps. box-deploy.sh reloads with `--only` so the ~25
// sibling products on this box are NEVER touched (shared-box safety, same law as the
// old drifthr/sitepresso deploys).
//
// Ports 4210-4214 — verified free on the box (4200/4201 = old drifthr app, 5000/3000/
// 3099 = sitepresso). Single-instance forks + memory caps because the box has ~1GiB
// free; the Next apps are PREBUILT locally and shipped, so nothing heavy builds here.
//
// PLATFORM_DOMAIN=staging.drifthr.com → the router host-routes:
//   staging.drifthr.com            → platform (marketing)
//   admin.staging.drifthr.com      → platform (super-admin console)
//   app.staging.drifthr.com        → hr-admin (tenant HR console)
//   <slug>.staging.drifthr.com     → ess (white-label employee self-service)
//   any host + /api/*              → backend
const path = require('path');
const ROOT = '/home/ubuntu/drifthr-hms';

function nextApp(name, dir, port) {
  return {
    name,
    cwd: path.join(ROOT, dir),
    script: path.join(ROOT, 'scripts/next-pm2-server.js'),
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_memory_restart: '420M',
    kill_timeout: 8000,
    env: { NODE_ENV: 'production', PORT: String(port), NEXT_APP_DIR: path.join(ROOT, dir) },
  };
}

module.exports = {
  apps: [
    {
      name: 'drifthr-hms-backend',
      cwd: path.join(ROOT, 'backend'),
      script: 'src/index.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '520M',
      kill_timeout: 10000,
      // PORT/scheduler here; secrets (DATABASE_URL, JWT_SECRET, …) come from backend/.env.
      env: {
        NODE_ENV: 'production',
        PORT: '4201', // takes over the old drifthr-api port (tunnel api-staging → 4201)
        BACKEND_RUN_SCHEDULER: '1',
        BACKEND_RUN_STARTUP_TASKS: '1',
      },
    },
    {
      name: 'drifthr-hms-router',
      cwd: path.join(ROOT, 'apps/router'),
      script: 'index.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: '4200', // takes over the old drifthr-web port (tunnel staging/app-/admin-staging → 4200)
        BACKEND_PORT: '4201',
        PLATFORM_PORT: '4212',
        HR_ADMIN_PORT: '4213',
        ESS_PORT: '4214',
        PLATFORM_DOMAIN: 'staging.drifthr.com',
        REDIS_URL: 'redis://localhost:6379/5', // DB 5 — isolated from sibling routers
        // Hyphenated 1-level staging hosts → canonical dotted form (Universal-SSL safe).
        ROUTER_HOST_ALIAS: JSON.stringify({
          'app-staging.drifthr.com': 'app.staging.drifthr.com',
          'admin-staging.drifthr.com': 'admin.staging.drifthr.com',
          'api-staging.drifthr.com': 'api.staging.drifthr.com',
          'demo-staging.drifthr.com': 'demo.staging.drifthr.com',
        }),
      },
    },
    nextApp('drifthr-hms-platform', 'apps/platform', 4212),
    nextApp('drifthr-hms-hr-admin', 'apps/hr-admin', 4213),
    nextApp('drifthr-hms-ess', 'apps/ess', 4214),
  ],
};
