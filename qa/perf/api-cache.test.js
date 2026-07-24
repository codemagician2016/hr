'use strict';
/* Guards the client API cache/dedupe semantics added in the 2026-07-24 perf pass
 * (apps/hr-admin/lib/api.js — apps/ess/lib/api.js mirrors it).
 *
 * The last assertion is a SECURITY guard, not a perf one: these modules can run in
 * Next server components, where a module-level cache would be shared across every
 * user of the Node process and leak one session's data into another. If someone
 * removes the `isBrowser` gate, this test fails.
 *
 * Run:  node qa/perf/api-cache.test.js       (bundles the ESM lib to CJS via esbuild)
 */
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'apps', 'hr-admin', 'lib', 'api.js');
const OUT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apicache-')), 'api.cjs');
execFileSync('npx', ['--yes', 'esbuild', SRC, '--bundle=false', '--format=cjs', `--outfile=${OUT}`, '--log-level=error'], { stdio: 'inherit' });

let calls = [];
function installBrowserEnv() {
  global.window = {};
  global.structuredClone = (v) => JSON.parse(JSON.stringify(v));
  global.fetch = async (url, init) => {
    calls.push((init && init.method) || 'GET');
    return { ok: true, status: 200, json: async () => ({ url, n: calls.length }) };
  };
}
const fresh = () => { delete require.cache[require.resolve(OUT)]; return require(OUT); };

(async () => {
  installBrowserEnv();
  const api = fresh();

  calls = [];
  const [a, b] = await Promise.all([api.get('/api/auth/me'), api.get('/api/auth/me')]);
  assert.strictEqual(calls.length, 1, 'concurrent identical GETs must dedupe to one request');
  assert.deepStrictEqual(a, b);

  calls = [];
  await api.get('/api/auth/me');
  assert.strictEqual(calls.length, 0, 'a repeat GET inside the TTL must be served from cache');

  const r1 = await api.get('/api/auth/me');
  r1.n = 9999;
  const r2 = await api.get('/api/auth/me');
  assert.notStrictEqual(r2.n, 9999, 'cached values must be cloned so a caller cannot corrupt the cache');

  calls = [];
  await api.post('/api/hr/anything', {});
  await api.get('/api/auth/me');
  assert.strictEqual(calls.length, 2, 'any write must invalidate the cache so the next read refetches');

  calls = [];
  await api.get('/api/hr/employees');
  await api.get('/api/hr/employees');
  assert.strictEqual(calls.length, 2, 'endpoints outside the allowlist must never be cached');

  // SECURITY: server component context (no window) must never cache.
  delete global.window;
  const srv = fresh();
  calls = [];
  await srv.get('/api/auth/me');
  await srv.get('/api/auth/me');
  assert.strictEqual(calls.length, 2, 'SERVER-SIDE CACHING would leak one session to another user');

  console.log('api-cache: 6 checks passed (incl. server-context no-cache security guard)');
})().catch((e) => { console.error('api-cache FAILED:', e.message); process.exit(1); });
