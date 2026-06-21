// ecosystem.config.js — SINGLE SOURCE OF TRUTH for the Sitepresso service fleet.
//
// Every Sitepresso process that must run on an EC2 box is declared here. This is
// what `scripts/deploy.sh` reloads on deploy and what PM2 resurrects on reboot.
// Before this file existed, services were started by hand and silently went
// missing (e.g. shop + all staff/customer sub-apps were down, causing 502s).
//
//   staging (aapkatech.com):  pm2 startOrReload ecosystem.config.js --update-env
//   prod    (sitepresso.com): pm2 startOrReload ecosystem.config.js --update-env --env production
//
// Ports are owned by each app's own `start` script (`next start -p <port>`) and
// must match apps/router/index.js (PUBLIC_PORTS / SUB_APP_PORTS). See
// packages/config/ports.js once the port source-of-truth is consolidated.
//
// Config: backend + every Next app read their OWN per-box .env files
// (.env / .env.local / .env.production, gitignored). Only sp-router has no .env,
// so its env is injected here — PLATFORM_DOMAIN is the only value that differs
// per box, handled via env_production.

const path = require('path');
const ROOT = __dirname;
const ENV_LABEL = process.env.ENV_LABEL || 'staging';

function intEnv(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// A Next.js app started via `npm start`. The port lives in the app's own
// `start` script; runtime config comes from its own .env files. 500M cap guards
// the shared box (it previously OOM-crashed running many Next apps at once).
function nextApp(name, dir, env = {}, envProduction = {}) {
  return {
    name,
    cwd: path.join(ROOT, dir),
    script: 'npm',
    args: 'start',
    autorestart: true,
    max_memory_restart: '500M',
    env: { NODE_ENV: 'production', ...env },
    env_production: { NODE_ENV: 'production', ...env, ...envProduction },
  };
}

function clusteredNextApp(name, dir, port, env = {}, envProduction = {}) {
  const defaultInstances = ENV_LABEL === 'prod' ? 1 : 3;
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
    // ── API ── (reads backend/.env)
    {
      name: 'sitepresso-backend',
      cwd: path.join(ROOT, 'backend'),
      script: 'src/index.js',
      exec_mode: 'cluster',
      instances: intEnv('BACKEND_INSTANCES', ENV_LABEL === 'prod' ? 1 : 2),
      autorestart: true,
      max_memory_restart: '700M',
      kill_timeout: 10000,
      listen_timeout: 15000,
      env: {
        NODE_ENV: 'production',
        PORT: '5000',
        BACKEND_RUN_SCHEDULER: '0',
        BACKEND_RUN_STARTUP_TASKS: '0',
      },
    },
    {
      name: 'sitepresso-scheduler',
      cwd: path.join(ROOT, 'backend'),
      script: 'src/scheduler-worker.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '400M',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        BACKEND_RUN_SCHEDULER: '1',
        BACKEND_RUN_STARTUP_TASKS: '1',
      },
    },

    // ── Edge router ── (no .env file → env injected here; only PLATFORM_DOMAIN
    //    differs per box). Must point BACKEND_PORT at the backend's port.
    {
      name: 'sp-router',
      cwd: path.join(ROOT, 'apps/router'),
      script: 'index.js',
      exec_mode: 'cluster',
      instances: intEnv('SP_ROUTER_INSTANCES', ENV_LABEL === 'prod' ? 1 : 3),
      autorestart: true,
      max_memory_restart: '500M',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        PLATFORM_DOMAIN: 'aapkatech.com', // staging
        BACKEND_PORT: '5000',
        PORT: '3099',
        REDIS_URL: 'redis://localhost:6379',
      },
      env_production: {
        NODE_ENV: 'production',
        PLATFORM_DOMAIN: 'sitepresso.com', // prod
        BACKEND_PORT: '5000',
        PORT: '3099',
        REDIS_URL: 'redis://localhost:6379',
      },
    },

    // ── Operator console ──
    clusteredNextApp('platform', 'apps/platform', 3000),

    // ── Standalone product: AapkaRider ──
    // Mirrors the owned-app shape used by AapkaChat: a product console host
    // plus a separate API host, both managed by the Sitepresso deploy fleet.
    {
      name: 'aapkarider-server',
      cwd: path.join(ROOT, 'apps/aapkarider-server'),
      script: 'npm',
      args: 'start',
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: '3700',
        AAPKARIDER_PUBLIC_URL: 'https://rider-api.aapkatech.com',
        AAPKARIDER_CONSOLE_URL: 'https://rider.aapkatech.com',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: '3700',
        AAPKARIDER_PUBLIC_URL: 'https://rider-api.sitepresso.com',
        AAPKARIDER_CONSOLE_URL: 'https://rider.sitepresso.com',
      },
    },
    nextApp('aapkarider-console', 'apps/aapkarider-console', {
      PORT: '3701',
      AAPKARIDER_API_URL: 'http://127.0.0.1:3700',
      NEXT_PUBLIC_AAPKARIDER_API_URL: 'https://rider-api.aapkatech.com',
      AAPKARIDER_WORKSPACE_ID: 'demo',
      NEXT_PUBLIC_AAPKARIDER_WORKSPACE_ID: 'demo',
    }, {
      NEXT_PUBLIC_AAPKARIDER_API_URL: 'https://rider-api.sitepresso.com',
    }),

    // ── Internal QA testing portal ──
    nextApp('qa-portal', 'apps/qa-portal', {
      PORT: '3801',
      NEXT_PUBLIC_API_URL: 'https://api.aapkatech.com',
    }, {
      NEXT_PUBLIC_API_URL: 'https://api.sitepresso.com',
    }),

    // ── Booking vertical (Prisma APPOINTMENT) ──
    nextApp('booking-public', 'apps/booking/public'), // :3001
    nextApp('booking-staff', 'apps/booking/staff'), // :3012
    nextApp('booking-customer', 'apps/booking/customer'), // :3013

    // ── Shop vertical (Prisma ECOMMERCE) ──
    nextApp('shop-public', 'apps/shop/public'), // :3002
    nextApp('shop-staff-manager', 'apps/shop/staff/manager'), // :3022
    nextApp('shop-staff-delivery', 'apps/shop/staff/delivery'), // :3023
    nextApp('shop-customer', 'apps/shop/customer'), // :3024

    // ── Web vertical (Prisma STATIC) ──
    nextApp('web-public', 'apps/web/public'), // :3003
    nextApp('web-staff', 'apps/web/staff'), // :3032
    nextApp('web-customer', 'apps/web/customer'), // :3033
  ],
};
