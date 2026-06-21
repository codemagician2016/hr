#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const isWin = process.platform === 'win32';
const API_PORT = Number(process.env.SITEPRESSO_API_PORT || 5050);
const API_URL = `http://localhost:${API_PORT}`;

const colors = ['36', '35', '32', '33', '34', '31', '90', '96', '95', '92', '93', '94'];

function color(index, text) {
  if (!process.stdout.isTTY) return text;
  return `\x1b[${colors[index % colors.length]}m${text}\x1b[0m`;
}

function workspace(name) {
  return { cmd: npm, args: ['run', 'dev', `--workspace=${name}`], cwd: ROOT };
}

function prefixRun(prefix, script) {
  return { cmd: npm, args: ['--prefix', prefix, 'run', script], cwd: ROOT };
}

const sharedEnv = {
  NODE_ENV: 'development',
  NEXT_PUBLIC_API_URL: API_URL,
  NEXT_PUBLIC_PLATFORM_DOMAIN: 'localhost',
  NEXT_PUBLIC_PLATFORM_URL: 'http://localhost:3099',
  NEXT_PUBLIC_PLATFORM_ORIGIN: 'http://localhost:3099',
  NEXT_PUBLIC_WEB_PUBLIC_PORT: '3003',
  PLATFORM_DOMAIN: 'localhost',
  PLATFORM_PROTOCOL: 'http',
  FRONTEND_URL: 'http://localhost:3099',
  ROUTER_REDIRECT_PROTOCOL: 'http',
  BACKEND_PORT: String(API_PORT),
  PLATFORM_PORT: '3000',
};

const services = {
  backend: {
    label: 'api',
    port: API_PORT,
    run: prefixRun('backend', 'dev'),
    env: {
      PORT: String(API_PORT),
      BACKEND_RUN_SCHEDULER: '0',
      BACKEND_RUN_STARTUP_TASKS: '0',
    },
    url: `${API_URL}/version`,
  },
  platform: {
    label: 'platform',
    port: 3000,
    run: workspace('sitepresso-platform'),
    env: { PORT: '3000' },
    url: 'http://localhost:3000',
  },
  router: {
    label: 'router',
    port: 3099,
    run: workspace('@sitepresso/router'),
    env: { PORT: '3099' },
    url: 'http://localhost:3099',
  },
  qaPortal: {
    label: 'qa-portal',
    port: 3801,
    run: workspace('@sitepresso/qa-portal'),
    env: { PORT: '3801' },
    url: 'http://localhost:3801',
  },
  bookingPublic: {
    label: 'booking-public',
    port: 3001,
    run: workspace('@sitepresso/booking-public'),
    url: 'http://legal-demo.localhost:3099',
  },
  bookingStaff: {
    label: 'booking-staff',
    port: 3012,
    run: workspace('@sitepresso/booking-staff'),
    url: 'http://legal-demo.localhost:3099/staff',
  },
  bookingCustomer: {
    label: 'booking-customer',
    port: 3013,
    run: workspace('@sitepresso/booking-customer'),
    url: 'http://legal-demo.localhost:3099/dashboard',
  },
  shopPublic: {
    label: 'shop-public',
    port: 3002,
    run: workspace('@sitepresso/shop-public'),
    url: 'http://grocery-demo.localhost:3099/shop',
  },
  shopManager: {
    label: 'shop-manager',
    port: 3022,
    run: workspace('@sitepresso/shop-staff-manager'),
    url: 'http://grocery-demo.localhost:3099/staff/manager',
  },
  shopDelivery: {
    label: 'shop-delivery',
    port: 3023,
    run: workspace('@sitepresso/shop-staff-delivery'),
    url: 'http://grocery-demo.localhost:3099/staff/delivery',
  },
  shopCustomer: {
    label: 'shop-customer',
    port: 3024,
    run: workspace('@sitepresso/shop-customer'),
    url: 'http://grocery-demo.localhost:3099/account',
  },
  webPublic: {
    label: 'web-public',
    port: 3003,
    run: workspace('@sitepresso/web-public'),
    url: 'http://corp-demo.localhost:3099',
  },
  webStaff: {
    label: 'web-staff',
    port: 3032,
    run: workspace('@sitepresso/web-staff'),
    url: 'http://corp-demo.localhost:3099/staff',
  },
  webCustomer: {
    label: 'web-customer',
    port: 3033,
    run: workspace('@sitepresso/web-customer'),
    url: 'http://corp-demo.localhost:3099/enquiries',
  },
};

const profiles = {
  backend: ['backend'],
  platform: ['platform'],
  router: ['router'],
  qa: ['backend', 'qaPortal'],
  'qa-portal': ['backend', 'qaPortal'],
  'booking-public': ['bookingPublic'],
  'booking-staff': ['bookingStaff'],
  'booking-customer': ['bookingCustomer'],
  'shop-public': ['shopPublic'],
  'shop-manager': ['shopManager'],
  'shop-delivery': ['shopDelivery'],
  'shop-customer': ['shopCustomer'],
  'web-public': ['webPublic'],
  'web-staff': ['webStaff'],
  'web-customer': ['webCustomer'],
  verticals: ['backend', 'platform', 'router', 'bookingPublic', 'shopPublic', 'webPublic'],
  all: [
    'backend',
    'platform',
    'router',
    'bookingPublic',
    'bookingStaff',
    'bookingCustomer',
    'shopPublic',
    'shopManager',
    'shopDelivery',
    'shopCustomer',
    'webPublic',
    'webStaff',
    'webCustomer',
  ],
  booking: ['backend', 'platform', 'router', 'bookingPublic', 'bookingStaff', 'bookingCustomer'],
  shop: ['backend', 'platform', 'router', 'shopPublic', 'shopManager', 'shopDelivery', 'shopCustomer'],
  web: ['backend', 'platform', 'router', 'webPublic', 'webStaff', 'webCustomer'],
};

const aliases = {
  public: 'verticals',
  full: 'all',
  static: 'web',
};

function usage() {
  console.log(`Usage: node scripts/dev-local.js [profile]

Profiles:
  verticals  backend + platform + router + public apps for all 3 verticals
  all        backend + platform + router + every vertical leaf app
  qa         backend + QA testing portal
  booking    booking public/staff/customer only
  shop       shop public/manager/delivery/customer only
  web        static web public/staff/customer only

Single-service profiles such as backend, router, booking-public, shop-manager,
and web-customer also work.

Daily commands:
  npm run dev:verticals
  npm run dev:all

Options:
  --dry-run    Print the commands that would run, then exit
`);
}

function canBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      resolve({ ok: false, code: err.code || 'ERROR' });
    });
    server.once('listening', () => {
      server.close(() => resolve({ ok: true }));
    });
    server.listen(port);
  });
}

async function assertPortsAvailable(selected) {
  const checks = await Promise.all(selected.map(async (name) => {
    const svc = services[name];
    if (!svc.port) return null;
    const result = await canBindPort(svc.port);
    return result.ok ? null : { label: svc.label, port: svc.port, code: result.code };
  }));
  const busy = checks.filter(Boolean);
  if (busy.length === 0) return;

  console.error('Cannot start Sitepresso local dev because these ports are unavailable:\n');
  for (const item of busy) {
    console.error(`  ${String(item.port).padEnd(5)} ${item.label} (${item.code})`);
  }
  console.error('\nStop the existing process on that port, then rerun the command.');
  process.exit(1);
}

function writePrefixed(label, index, stream, chunk, buffers) {
  const key = `${label}:${stream === process.stderr ? 'err' : 'out'}`;
  buffers[key] = (buffers[key] || '') + chunk.toString();
  const lines = buffers[key].split(/\r?\n/);
  buffers[key] = lines.pop() || '';
  for (const line of lines) {
    if (!line) continue;
    stream.write(`${color(index, `[${label}]`)} ${line}\n`);
  }
}

function printUrls(profileName, selected) {
  console.log(`\nSitepresso local dev profile: ${profileName}`);
  console.log('Press Ctrl+C to stop all processes.\n');

  const rows = selected
    .map((name) => services[name])
    .filter((svc) => svc.url)
    .map((svc) => `  ${svc.label.padEnd(17)} ${svc.url}`);
  console.log(rows.join('\n'));

  if (selected.includes('router')) {
    console.log(`
Demo tenant routes through the local router:
  Appointment       http://legal-demo.localhost:3099
  E-commerce        http://grocery-demo.localhost:3099/shop
  Static web        http://corp-demo.localhost:3099

Run "npm run local:setup" once if those demo slugs are missing.`);
  }
  console.log('');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const dryRun = argv.includes('--dry-run');
  const rawProfile = argv.find((arg) => !arg.startsWith('-')) || 'verticals';
  const profileName = aliases[rawProfile] || rawProfile;
  const selected = profiles[profileName];
  if (!selected) {
    console.error(`Unknown local dev profile: ${rawProfile}\n`);
    usage();
    process.exit(1);
  }

  if (dryRun) {
    printUrls(profileName, selected);
    console.log('Commands:');
    for (const name of selected) {
      const svc = services[name];
      console.log(`  ${svc.label.padEnd(17)} ${[svc.run.cmd, ...svc.run.args].join(' ')}`);
    }
    return;
  }

  await assertPortsAvailable(selected);
  printUrls(profileName, selected);

  let stopping = false;
  const children = [];
  const buffers = {};

  function stopAll(signal = 'SIGTERM') {
    if (stopping) return;
    stopping = true;
    console.log('\nStopping Sitepresso local dev processes...');
    for (const child of children) {
      if (!child.pid || child.killed) continue;
      try {
        if (isWin) child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {}
    }
    setTimeout(() => process.exit(process.exitCode || 0), 1500).unref();
  }

  process.on('SIGINT', () => stopAll('SIGINT'));
  process.on('SIGTERM', () => stopAll('SIGTERM'));

  selected.forEach((name, index) => {
    const svc = services[name];
    const env = { ...process.env, ...sharedEnv, ...(svc.env || {}) };
    const child = spawn(svc.run.cmd, svc.run.args, {
      cwd: svc.run.cwd,
      env,
      detached: !isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);

    child.stdout.on('data', (chunk) => writePrefixed(svc.label, index, process.stdout, chunk, buffers));
    child.stderr.on('data', (chunk) => writePrefixed(svc.label, index, process.stderr, chunk, buffers));
    child.on('exit', (code, signal) => {
      if (stopping) return;
      process.exitCode = code || (signal ? 1 : 0);
      console.error(`${color(index, `[${svc.label}]`)} exited with ${signal || code}`);
      stopAll();
    });
    child.on('error', (err) => {
      if (stopping) return;
      process.exitCode = 1;
      console.error(`${color(index, `[${svc.label}]`)} failed to start: ${err.message}`);
      stopAll();
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
