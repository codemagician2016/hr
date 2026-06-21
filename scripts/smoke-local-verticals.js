#!/usr/bin/env node
'use strict';

const http = require('http');

const OK_STATUSES = new Set([200, 204, 301, 302, 307, 308]);
const API_PORT = Number(process.env.SITEPRESSO_API_PORT || 5050);

function request({ name, port, path = '/', host = `localhost:${port}`, bodyIncludes, jsonVertical }) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { Host: host },
        timeout: 20000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 4000) body = body.slice(0, 4000);
        });
        res.on('end', () => {
          const statusOk = OK_STATUSES.has(res.statusCode);
          let bodyOk = !bodyIncludes || body.includes(bodyIncludes);
          if (jsonVertical) {
            try {
              bodyOk = JSON.parse(body).vertical === jsonVertical;
            } catch {
              bodyOk = false;
            }
          }
          resolve({
            name,
            ok: statusOk && bodyOk,
            status: res.statusCode,
            detail: bodyOk ? '' : `body did not match ${jsonVertical ? `vertical=${jsonVertical}` : bodyIncludes}`,
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => {
      resolve({ name, ok: false, status: 'ERR', detail: err.message });
    });
    req.end();
  });
}

const checks = [
  { name: 'backend /version', port: API_PORT, path: '/version' },
  {
    name: 'demo tenant appointment vertical',
    port: API_PORT,
    path: '/api/internal/tenant-vertical?slug=legal-demo',
    jsonVertical: 'booking',
  },
  {
    name: 'demo tenant ecommerce vertical',
    port: API_PORT,
    path: '/api/internal/tenant-vertical?slug=grocery-demo',
    jsonVertical: 'shop',
  },
  {
    name: 'demo tenant static vertical',
    port: API_PORT,
    path: '/api/internal/tenant-vertical?slug=corp-demo',
    jsonVertical: 'web',
  },
  { name: 'platform direct', port: 3000, path: '/' },
  { name: 'booking public direct', port: 3001, path: '/', host: 'legal-demo.localhost:3001' },
  { name: 'shop public direct', port: 3002, path: '/shop', host: 'grocery-demo.localhost:3002' },
  { name: 'web public direct', port: 3003, path: '/', host: 'corp-demo.localhost:3003' },
  { name: 'router platform', port: 3099, path: '/', host: 'localhost:3099' },
  { name: 'router appointment tenant', port: 3099, path: '/', host: 'legal-demo.localhost:3099' },
  { name: 'router ecommerce tenant', port: 3099, path: '/shop', host: 'grocery-demo.localhost:3099' },
  { name: 'router static tenant', port: 3099, path: '/', host: 'corp-demo.localhost:3099' },
];

async function main() {
  console.log('Sitepresso local vertical smoke\n');

  const results = [];
  for (const check of checks) {
    const result = await request(check);
    results.push(result);
    const status = String(result.status).padEnd(3);
    console.log(`${result.ok ? 'ok  ' : 'fail'} ${status} ${result.name}${result.detail ? ` - ${result.detail}` : ''}`);
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    console.log('Make sure "npm run local:setup" has seeded the demo tenants and "npm run dev:verticals" is running.');
    process.exit(1);
  }

  console.log('\nAll local vertical checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
