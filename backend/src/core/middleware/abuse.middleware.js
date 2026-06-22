// ============================================================================
// Abuse-prevention middleware: rate limiting, honeypot, Cloudflare Turnstile.
// Applied to all public write endpoints that trigger email or store free-form
// user input. Graceful fallback: if TURNSTILE_SECRET is not set, Turnstile is
// skipped (dev + pre-key production); honeypot + rate limit still apply.
// ============================================================================

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

// Comma-separated list of IPs (IPv4 or IPv6) that bypass all rate limits.
// Meant for the owner's home IP during dev so a legitimate burst of test
// traffic doesn't lock them out of their own login page.
const RATE_LIMIT_SKIP_IPS = new Set(
  String(process.env.RATE_LIMIT_SKIP_IPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

function extractClientIp(req) {
  // Cloudflare sets cf-connecting-ip on every proxied request — most reliable
  // when behind CF. Fall back to the first X-Forwarded-For entry (set by
  // nginx via $proxy_add_x_forwarded_for), then req.ip.
  const cf = (req.headers['cf-connecting-ip'] || '').toString().trim();
  if (cf) return cf;
  const xff = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  return xff || req.ip || '';
}

// ---------------------------------------------------------------------------
// Rate limiter factory — per-IP, sliding window, JSON response on limit hit.
//
// Uses express-rate-limit's ipKeyGenerator helper to correctly handle IPv6
// (it normalises the /64 prefix so a single IPv6 client can't rotate the
// low 64 bits to evade the limit). Prior custom keyGenerator emitted an
// ERR_ERL_KEY_GEN_IPV6 warning on every startup.
// ---------------------------------------------------------------------------
function makeRateLimiter({ windowMs, max, name, keyGenerator }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => RATE_LIMIT_SKIP_IPS.has(extractClientIp(req)),
    keyGenerator: keyGenerator || ((req) => ipKeyGenerator(extractClientIp(req))),
    // Custom handler so the error tells the user exactly when to retry instead
    // of the generic "try again later." express-rate-limit sets `req.rateLimit`
    // with .resetTime — we use it to compute a human-readable wait.
    handler: (req, res) => {
      const resetMs = req.rateLimit?.resetTime?.getTime?.() || (Date.now() + windowMs);
      const waitSec = Math.max(1, Math.ceil((resetMs - Date.now()) / 1000));
      const waitMin = Math.ceil(waitSec / 60);
      const human = waitMin >= 60
        ? `${Math.ceil(waitMin / 60)} hour${Math.ceil(waitMin / 60) === 1 ? '' : 's'}`
        : `${waitMin} minute${waitMin === 1 ? '' : 's'}`;
      res.setHeader('Retry-After', waitSec);
      return res.status(429).json({
        message: `Too many requests. Please try again in ${human}.`,
        retryAfterSec: waitSec,
        retryAt: new Date(resetMs).toISOString(),
      });
    },
  });
}

// Tight limit for the public enquiry form: 5 submissions per 10 minutes per IP
const enquiryLimiter = makeRateLimiter({ windowMs: 10 * 60 * 1000, max: 5,  name: 'enquiry' });
// Moderate limit for signup / password-reset: 10 per 15 minutes
const authLimiter    = makeRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, name: 'auth'    });
// Looser limit for booking (real customers, may retry): 20 per 15 minutes
const bookingLimiter = makeRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, name: 'booking' });
// Public buyer-payment endpoints (order create + Razorpay success callback):
// real shoppers may retry, but unauthenticated, so cap abuse — 30 per 15 min.
const paymentLimiter = makeRateLimiter({ windowMs: 15 * 60 * 1000, max: 30, name: 'payment' });
// Sensitive payroll mutations (compute / approve). These are authenticated
// operator actions, so we key per-IP AND per-tenant: a single tenant can't
// hammer compute/approve in a tight loop (each is a heavy, money-moving op),
// and one noisy tenant on a shared NAT can't exhaust the limit for another.
// 20 mutations per 5 minutes per (tenant, IP). Falls back to IP-only before
// auth resolves req.user (the route's `protect` runs first, so businessId is
// normally present here).
const payrollMutationLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 20,
  name: 'payroll-mutation',
  keyGenerator: (req) => {
    const ipKey = ipKeyGenerator(extractClientIp(req));
    const tenant = req.user?.businessId;
    return tenant ? `pay:${tenant}:${ipKey}` : `pay:ip:${ipKey}`;
  },
});

// Public API (/api/v1, /api/public-api): key on the API-key id, not the IP, so
// a single leaked key can't be hammered unthrottled and shared-NAT callers
// aren't lumped together. 120 req/min/key; falls back to IP before the key
// resolves (e.g. a missing/invalid key, which requireApiKey rejects anyway).
const apiKeyLimiter = makeRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'apikey',
  keyGenerator: (req) => (req.apiKey?.id ? `key:${req.apiKey.id}` : ipKeyGenerator(extractClientIp(req))),
});

// ---------------------------------------------------------------------------
// Honeypot — reject any request whose body contains a non-empty 'hp_field'.
// The field is a hidden <input> on the real form; real users won't touch it.
// ---------------------------------------------------------------------------
function honeypot(req, res, next) {
  if (req.body && typeof req.body.hp_field === 'string' && req.body.hp_field.trim().length > 0) {
    // Intentionally return a 200 so bots think it worked — don't tip them off.
    return res.status(200).json({ ok: true });
  }
  next();
}

// ---------------------------------------------------------------------------
// Cloudflare Turnstile verification. Reads token from req.body.cf_turnstile,
// calls the siteverify endpoint, and rejects 403 on failure. Skipped entirely
// when TURNSTILE_SECRET is unset so dev + pre-key prod keep working.
// ---------------------------------------------------------------------------
async function verifyTurnstile(req, res, next) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return next(); // graceful no-op when the key isn't configured

  const token = req.body?.cf_turnstile;
  const host = String(req.headers.host || '').toLowerCase();
  const isLocalDev = process.env.NODE_ENV !== 'production'
    && (host.startsWith('localhost') || host.startsWith('127.0.0.1'));
  if (!token && isLocalDev) return next();
  if (!token) {
    return res.status(400).json({ message: 'Captcha missing. Please reload and try again.' });
  }

  try {
    const xff = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
    const ip = xff || req.socket?.remoteAddress || '';
    const body = new URLSearchParams({ secret, response: token, remoteip: ip });
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = await resp.json();
    // hostname-mismatch alone is not fatal — tenant custom domains won't be
    // pre-registered in Turnstile; the token signature is still verified.
    const fatalCodes = (data['error-codes'] || []).filter((c) => c !== 'hostname-mismatch');
    if (!data.success && fatalCodes.length > 0) {
      return res.status(403).json({ message: 'Captcha check failed. Please try again.' });
    }
    return next();
  } catch (err) {
    // If Cloudflare is unreachable we fail open — better than blocking real
    // users because of a third-party outage. The other layers still apply.
    console.warn('[turnstile] siteverify error, failing open:', err.message);
    return next();
  }
}

module.exports = {
  enquiryLimiter,
  authLimiter,
  bookingLimiter,
  paymentLimiter,
  apiKeyLimiter,
  payrollMutationLimiter,
  honeypot,
  verifyTurnstile,
};
