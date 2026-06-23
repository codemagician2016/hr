// ecosystem.config.js — SINGLE SOURCE OF TRUTH for the DriftHR service fleet.
//
// Every DriftHR process that must run on an EC2 box is declared here. This is
// what `pm2 startOrReload` reloads on deploy and what PM2 resurrects on reboot.
// Declaring the whole fleet in one file prevents the classic "started by hand,
// silently went missing on reboot → 502s" failure mode.
//
//   staging (staging.drifthr.com): pm2 startOrReload ecosystem.config.js --update-env
//   prod    (drifthr.com):         pm2 startOrReload ecosystem.config.js --update-env --env production
//
// Ports are fixed and MUST match apps/router/index.js:
//   backend  5000   (BACKEND_PORT)
//   platform 3000   (PLATFORM_PORT)  → drifthr.com / www / admin.drifthr.com
//   hr-admin 3010   (HR_ADMIN_PORT)  → app.drifthr.com tenant HR console
//   ess      3020   (ESS_PORT)       → <slug>.drifthr.com + bound custom domains
//   router   3099   (PORT, edge)     → nginx proxies ALL hosts here; it host-routes
//
// Config model (per-box, gitignored, modeled on Sitepresso):
//   backend + every Next app read their OWN .env / .env.local / .env.production.
//   drifthr-router has no .env file, so its env is injected here — PLATFORM_DOMAIN
//   is the only value that differs per box, handled via env_production.

const path = require('path');
const ROOT = __dirname;
const ENV_LABEL = process.env.ENV_LABEL || 'staging';

// Parse a positive integer from the environment, falling back when unset/invalid.
// Used so per-box overrides (e.g. BACKEND_INSTANCES=4) work without editing this file.
function intEnv(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// A Next.js app run in cluster mode via the shared PM2 server shim. The port is
// injected here (and consumed by scripts/next-pm2-server.js); all other runtime
// config comes from the app's own .env files. 900M cap guards the shared box,
// which previously OOM-crashed running several Next apps at once.
function clusteredNextApp(name, dir, port, env = {}, envProduction = {}) {
  const defaultInstances = ENV_LABEL === 'prod' ? 1 : 2;
  return {
    name,
    cwd: path.join(ROOT, dir),
    script: path.join(ROOT, 'scripts/next-pm2-server.js'),
    exec_mode: 'cluster',
    instances: intEnv(`${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_INSTANCES`, defaultInstances),
    autorestart: true,
    max_memory_restart: '900M',
    kill_timeout: 10000,
    listen_timeout: 15000,
    env: {
      NODE_ENV: 'production',
      PORT: String(port),
      NEXT_APP_DIR: path.join(ROOT, dir),
      ...env,
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: String(port),
      NEXT_APP_DIR: path.join(ROOT, dir),
      ...env,
      ...envProduction,
    },
  };
}

module.exports = {
  apps: [
    // ── API ── (reads backend/.env). Cluster for throughput. The scheduler is a
    //    SEPARATE fork process so cron jobs run exactly once regardless of how
    //    many API workers are clustered; the API workers therefore disable it.
    {
      name: 'drifthr-backend',
      cwd: path.join(ROOT, 'backend'),
      script: 'src/index.js',
      exec_mode: 'cluster',
      instances: intEnv('BACKEND_INSTANCES', ENV_LABEL === 'prod' ? 2 : 1),
      autorestart: true,
      max_memory_restart: '700M',
      kill_timeout: 10000,
      listen_timeout: 15000,
      env: {
        NODE_ENV: 'production',
        PORT: '5000',
        BACKEND_RUN_SCHEDULER: '0',     // cron runs in drifthr-scheduler only
        BACKEND_RUN_STARTUP_TASKS: '0',
      },
    },
    {
      // Single fork worker that owns cron/scheduled jobs. backend/src/index.js
      // is the real entrypoint; BACKEND_RUN_SCHEDULER=1 turns on the scheduler
      // loop (see backend/src/core/lib/scheduler.js → initScheduler). If a
      // dedicated backend/src/scheduler-worker.js is added later, point `script`
      // at it; the env contract stays the same.
      name: 'drifthr-scheduler',
      cwd: path.join(ROOT, 'backend'),
      script: 'src/index.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '400M',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        PORT: '5001',                   // distinct from the API cluster's :5000
        BACKEND_RUN_SCHEDULER: '1',
        BACKEND_RUN_STARTUP_TASKS: '1',
      },
    },

    // ── Edge router ── (no .env file → env injected here; only PLATFORM_DOMAIN
    //    differs per box). nginx proxies EVERY host to this edge :3099, which
    //    then host-routes to platform / hr-admin / ess / backend. This is what
    //    makes tenant custom domains work via Cloudflare-for-SaaS.
    {
      name: 'drifthr-router',
      cwd: path.join(ROOT, 'apps/router'),
      script: 'index.js',
      exec_mode: 'cluster',
      instances: intEnv('DRIFTHR_ROUTER_INSTANCES', ENV_LABEL === 'prod' ? 2 : 1),
      autorestart: true,
      max_memory_restart: '500M',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        PLATFORM_DOMAIN: 'staging.drifthr.com', // staging
        BACKEND_PORT: '5000',
        PORT: '3099',
        PLATFORM_PORT: '3000',
        HR_ADMIN_PORT: '3010',
        ESS_PORT: '3020',
        REDIS_URL: 'redis://localhost:6379',
      },
      env_production: {
        NODE_ENV: 'production',
        PLATFORM_DOMAIN: 'drifthr.com', // prod
        BACKEND_PORT: '5000',
        PORT: '3099',
        PLATFORM_PORT: '3000',
        HR_ADMIN_PORT: '3010',
        ESS_PORT: '3020',
        REDIS_URL: 'redis://localhost:6379',
      },
    },

    // ── Marketing + operator/super-admin console ── drifthr.com / www / admin.
    clusteredNextApp('platform', 'apps/platform', 3000),

    // ── Tenant HR console ── app.drifthr.com (operator session, /dashboard).
    clusteredNextApp('hr-admin', 'apps/hr-admin', 3010),

    // ── Employee Self-Service ── <slug>.drifthr.com + bound custom domains
    //    (customer session; tenant resolved by Host / X-Tenant-Host).
    clusteredNextApp('ess', 'apps/ess', 3020),
  ],
};
