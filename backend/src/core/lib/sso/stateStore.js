'use strict';

// Short-lived OIDC login-state store, keyed by the OAuth round-trip `state`
// parameter (state → { tenant, target, nonce, codeVerifier, redirect }).
// Mirrors the socialAuth one-time-code store: Redis-backed (multi-instance
// safe) with an in-memory fallback for single-process dev. Single-use:
// takeState() atomically consumes.

const { getRedis } = require('../redis');

const TTL_SECONDS = 600; // the user may sit on the IdP login page for a while
const KEY_PREFIX = 'sso:state:';

const memStore = new Map();
function memSweep() {
  if (memStore.size < 500) return;
  const now = Date.now();
  for (const [k, v] of memStore) if (v.expiresAt <= now) memStore.delete(k);
}

async function putState(state, payload) {
  if (!state) throw new Error('putState requires a state key');
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(KEY_PREFIX + state, JSON.stringify(payload), 'EX', TTL_SECONDS);
      return;
    } catch { /* fall through to memory */ }
  }
  memSweep();
  memStore.set(state, { payload, expiresAt: Date.now() + TTL_SECONDS * 1000 });
}

const TAKE_LUA =
  "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v";

async function takeState(state) {
  if (!state) return null;
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.eval(TAKE_LUA, 1, KEY_PREFIX + state);
      if (raw) return JSON.parse(raw);
      // fall through — may have been issued in-memory
    } catch { /* fall through to memory */ }
  }
  const entry = memStore.get(state);
  if (!entry) return null;
  memStore.delete(state);
  if (entry.expiresAt <= Date.now()) return null;
  return entry.payload;
}

module.exports = { putState, takeState };
