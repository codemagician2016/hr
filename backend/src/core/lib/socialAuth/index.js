'use strict';

// Provider-agnostic social-login core.
//
//   - Provider registry: add a file under ./providers and one line below.
//   - resolveTenantByHost(): maps a request host to a business, for BOTH
//     platform subdomains (<slug>.<PLATFORM_DOMAIN>) and verified custom
//     domains. This is the controlled, server-side re-enablement of
//     custom-domain auth (the broad DNS pipeline retired 2026-05-10 is
//     unrelated — that was orange-cloud routing, not this lookup).
//   - issueAuthCode()/consumeAuthCode(): a short-lived, single-use code
//     bridging the platform origin (where the OAuth SDK lives) back to the
//     tenant host (where the JWT cookie must be set). Redis-backed so it
//     survives multiple backend instances; falls back to in-memory in dev.

const prisma = require('../prisma');
const { getRedis } = require('../redis');

// ── Provider registry ───────────────────────────────────────────────
// Each provider exports { name, isConfigured(), verify(credential) }.
const PROVIDERS = {
  google: require('./providers/google'),
  // apple:     require('./providers/apple'),
  // microsoft: require('./providers/microsoft'),
};

function getProvider(name) {
  return PROVIDERS[String(name || '').toLowerCase()] || null;
}

// Providers the server is actually able to verify tokens for right now.
function listConfiguredProviders() {
  return Object.values(PROVIDERS)
    .filter((p) => {
      try { return p.isConfigured(); } catch { return false; }
    })
    .map((p) => p.name);
}

// ── Host → tenant resolution ────────────────────────────────────────
function normaliseHost(raw) {
  return String(raw || '').toLowerCase().split(':')[0].trim();
}

async function resolveTenantByHost(rawHost) {
  const host = normaliseHost(rawHost);
  if (!host) return null;

  const platformDomain = (process.env.PLATFORM_DOMAIN || 'sitepresso.com').toLowerCase();
  const suffix = `.${platformDomain}`;

  // Platform subdomain: <slug>.<PLATFORM_DOMAIN>
  if (host === platformDomain) return null; // bare platform host is not a tenant
  if (host.endsWith(suffix)) {
    const sub = host.slice(0, -suffix.length);
    if (!sub || sub.includes('.')) return null; // www / multi-level → not a tenant login host
    const biz = await prisma.business.findUnique({
      where: { slug: sub },
      select: { id: true, slug: true },
    });
    return biz ? { businessId: biz.id, slug: biz.slug, host } : null;
  }

  // Otherwise treat it as a BYO custom domain — only if it's verified and
  // ACTIVE (same contract the router uses for /tenant-vertical?host=).
  const biz = await prisma.business.findFirst({
    where: {
      subscription: {
        is: {
          customDomain: host,
          customDomainVerified: true,
          customDomainStatus: 'ACTIVE',
        },
      },
    },
    select: { id: true, slug: true },
  });
  return biz ? { businessId: biz.id, slug: biz.slug, host } : null;
}

// ── One-time code store ─────────────────────────────────────────────
const CODE_TTL_SECONDS = 90;
const KEY_PREFIX = 'social:authcode:';

// In-memory fallback (single-process dev only). Map<code, {payload, expiresAt}>
const memStore = new Map();
function memSweep() {
  if (memStore.size < 200) return;
  const now = Date.now();
  for (const [k, v] of memStore) if (v.expiresAt <= now) memStore.delete(k);
}

const crypto = require('crypto');
function newCode() {
  return crypto.randomBytes(32).toString('hex');
}

async function issueAuthCode(payload) {
  const code = newCode();
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(KEY_PREFIX + code, JSON.stringify(payload), 'EX', CODE_TTL_SECONDS);
      return code;
    } catch {
      /* fall through to memory */
    }
  }
  memSweep();
  memStore.set(code, { payload, expiresAt: Date.now() + CODE_TTL_SECONDS * 1000 });
  return code;
}

// Atomic single-use consume (GET+DEL in one round-trip via Lua).
const CONSUME_LUA =
  "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v";

async function consumeAuthCode(code) {
  if (!code) return null;
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.eval(CONSUME_LUA, 1, KEY_PREFIX + code);
      if (raw) return JSON.parse(raw);
      // not in Redis — fall through in case it was issued in-memory
    } catch {
      /* fall through to memory */
    }
  }
  const entry = memStore.get(code);
  if (!entry) return null;
  memStore.delete(code);
  if (entry.expiresAt <= Date.now()) return null;
  return entry.payload;
}

module.exports = {
  getProvider,
  listConfiguredProviders,
  resolveTenantByHost,
  issueAuthCode,
  consumeAuthCode,
};
