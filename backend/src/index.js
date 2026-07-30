require('dotenv').config();
const path = require('path');
// Init Sentry BEFORE loading express so it can instrument the module.
// No-op if SENTRY_DSN isn't set.
const { Sentry, initSentry } = require('./core/lib/sentry');
initSentry();

// ── Process-level safety net ────────────────────────────────────────────────
// Express 4 does NOT forward a rejected async handler to the error middleware,
// so a single unhandled rejection (e.g. a stray Prisma validation error in one
// request) used to TERMINATE the Node process — PM2 then restarted it, and any
// in-flight request (including a tenant clicking "connect payments") returned
// 502 during the restart window. A whole-API crash must never be the blast
// radius of one bad request, so we log + report and keep serving. A genuinely
// fatal fault (OOM, port bind) still exits on its own; the PM2 watchdog covers
// that. Do not remove without restoring per-route async error forwarding.
function reportProcessFault(kind, err) {
  const detail = err instanceof Error ? (err.stack || err.message) : err;
  console.error(`[${kind}]`, detail);
  try { Sentry.captureException(err); } catch { /* Sentry optional */ }
}
process.on('unhandledRejection', (reason) => reportProcessFault('unhandledRejection', reason));
process.on('uncaughtException', (err) => reportProcessFault('uncaughtException', err));

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const prisma = require('./core/lib/prisma');

const authRoutes = require('./core/routes/auth.routes');
const businessRoutes = require('./core/routes/business.routes');
const publicPricingRoutes = require('./core/routes/publicPricing.routes');
const subscriptionRoutes = require('./core/routes/subscription.routes');
const adminCouponRoutes = require('./core/routes/adminCoupon.routes');
const adminRoutes = require('./superadmin/routes/admin.routes');
const pricingAdminRoutes = require('./core/routes/pricing.routes');
const tenantRoutes = require('./core/routes/tenant.routes');
const customerRoutes = require('./core/routes/customer.routes');
const notificationRoutes = require('./core/routes/notification.routes');
const inboxRoutes = require('./core/routes/inbox.routes');
// /api/chat (aapkachat widget/AI) removed — deleted chat product, not part of DriftHR.
const uploadRoutes = require('./core/routes/upload.routes');
const localeRoutes = require('./core/routes/locale.routes');
const { handlePaddleWebhook } = require('./core/controllers/paddle.controller');
const { handleStripeWebhook } = require('./core/controllers/stripe.controller');
const { handleRazorpayWebhook } = require('./core/controllers/razorpay.controller');
const asyncHandler = require('./core/middleware/asyncHandler');
const { initScheduler } = require('./core/lib/scheduler');
const { routableCustomDomainWhere } = require('./core/lib/customDomainRouting');
const { runStartupTasks } = require('./core/lib/startupTasks');

const app = express();

// Behind nginx — trust the first proxy so req.ip / X-Forwarded-For resolve
// to the real client IP. Required for express-rate-limit to key per-user.
app.set('trust proxy', 1);

// Security response headers. X-Frame-Options is intentionally omitted
// because the platform admin previews tenant storefronts in an iframe
// (cross-subdomain) and the "paste-anywhere book-now button" embed feature
// wants third-party sites to embed the booking flow. Iframe policy is
// instead enforced via CSP frame-ancestors at the nginx layer when needed.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0'); // modern browsers ignore; '0' is the safer recommendation now
  // HSTS in production — force HTTPS for a year incl. subdomains. Safe behind
  // Cloudflare/our TLS; everything is already served over https.
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

const PLATFORM_DOMAIN = (process.env.PLATFORM_DOMAIN || 'hr.com').toLowerCase();

const configuredMobileOrigins = (process.env.MOBILE_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const configuredChatOrigins = (process.env.CHAT_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Explicit allow-list (exact string match)
// Explicit extra origins (comma-separated). Needed when the live hosts are NOT
// subdomains of PLATFORM_DOMAIN — e.g. hyphenated staging hosts
// app-staging.drifthr.com while PLATFORM_DOMAIN=staging.drifthr.com.
const configuredCorsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins = new Set([
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:3030',
  `https://${PLATFORM_DOMAIN}`,
  `https://m.${PLATFORM_DOMAIN}`,
  `https://m.ecom.${PLATFORM_DOMAIN}`,
  ...configuredMobileOrigins,
  ...configuredChatOrigins,
  ...configuredCorsOrigins,
]);

// Regex matches any subdomain of the platform.
const PLATFORM_SUBDOMAIN_RE = new RegExp(
  `^https?://[a-z0-9-]+\\.${PLATFORM_DOMAIN.replace(/\./g, '\\.')}$`,
  'i'
);

// Mobile apps are served from m.<tenant-domain> for branded storefronts.
// Example: m.ecom.aapkatech.com talks to api.aapkatech.com with cookies.
const PLATFORM_MOBILE_SUBDOMAIN_RE = new RegExp(
  `^https?://m\\.[a-z0-9-]+\\.${PLATFORM_DOMAIN.replace(/\./g, '\\.')}$`,
  'i'
);

// Local dev frontends move between ports (3101, 3103, etc.) and developers
// often use either localhost, tenant.localhost, or 127.0.0.1 in the browser.
// Keep production strict, but allow loopback origins during local development.
const LOCAL_DEV_ORIGIN_RE = /^https?:\/\/(?:(?:[a-z0-9-]+\.)*localhost|127\.0\.0\.1)(?::\d+)?$/i;
const allowLocalDevOrigins = process.env.NODE_ENV !== 'production';

const customDomainOriginCache = new Map();

function hostFromOrigin(origin) {
  try {
    return new URL(origin).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

// Bound the cache so an unauthenticated flood of unique `Origin` headers can't
// grow it without limit (memory-exhaustion DoS). Simple size cap + insertion-
// order eviction (Map preserves insertion order) keeps it dependency-free.
const CUSTOM_DOMAIN_ORIGIN_CACHE_MAX = 5000;

async function isAllowedCustomDomainOrigin(origin) {
  const host = hostFromOrigin(origin);
  if (!host || host === PLATFORM_DOMAIN || host.endsWith(`.${PLATFORM_DOMAIN}`)) return false;

  const cached = customDomainOriginCache.get(host);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.allowed;

  const match = await prisma.subscription.findFirst({
    where: routableCustomDomainWhere(host),
    select: { businessId: true },
  });
  const allowed = Boolean(match);
  if (customDomainOriginCache.size >= CUSTOM_DOMAIN_ORIGIN_CACHE_MAX) {
    // Evict the oldest entry (and opportunistically the stale one we just read).
    const oldest = customDomainOriginCache.keys().next().value;
    if (oldest !== undefined) customDomainOriginCache.delete(oldest);
  }
  customDomainOriginCache.set(host, { allowed, expiresAt: now + 60_000 });
  return allowed;
}

async function isOriginAllowed(origin) {
  if (allowedOrigins.has(origin)) return true;
  if (allowLocalDevOrigins && LOCAL_DEV_ORIGIN_RE.test(origin)) return true;
  if (PLATFORM_SUBDOMAIN_RE.test(origin)) return true;
  if (PLATFORM_MOBILE_SUBDOMAIN_RE.test(origin)) return true;
  if (await isAllowedCustomDomainOrigin(origin)) return true;
  return false;
}

async function originCheck(origin, callback) {
  // No origin = server-to-server / curl / same-origin — allow
  if (!origin) return callback(null, true);

  if (await isOriginAllowed(origin)) return callback(null, true);

  // Feature 41 — mobile-web hosts: an `m-<host>` / `m.<host>` origin is allowed
  // exactly when its BASE host's origin is (m-demo-staging inherits
  // demo-staging's allowance; m.acme.com inherits acme.com's bound-domain
  // allowance). Single rule via core/lib/mobileHost.js — no per-host env
  // entries, and every future tenant's m-host works untouched.
  {
    const { hostCandidates } = require('./core/lib/mobileHost');
    const candidates = hostCandidates(hostFromOrigin(origin));
    if (candidates.length > 1) {
      const proto = origin.toLowerCase().startsWith('http://') ? 'http://' : 'https://';
      if (await isOriginAllowed(`${proto}${candidates[1]}`)) return callback(null, true);
    }
  }

  return callback(new Error(`Origin ${origin} not allowed by CORS`));
}

app.use(cors({
  origin: originCheck,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Host', 'X-Cart-Session'],
}));

// Paddle signs the raw JSON payload, so the webhook endpoint must run
// BEFORE the global JSON parser touches req.body. Do not reorder.
app.post('/api/paddle/webhook', express.raw({ type: 'application/json' }), handlePaddleWebhook);
// Stripe also verifies against the raw body — same ordering requirement.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
// Razorpay SUBSCRIPTION webhook (HMAC over raw body). Distinct from the
// ecommerce-order webhook at /api/payments/razorpay/webhook.
app.post('/api/razorpay/webhook', express.raw({ type: 'application/json' }), handleRazorpayWebhook);
// AapkaConnect inbound webhooks (any connected provider) — HMAC-verified over the
// RAW body, so they live here before express.json() for the same reason as above.
app.post('/api/integrations/:id/webhook', express.raw({ type: 'application/json' }), asyncHandler(require('./core/controllers/integrations.controller').receiveWebhook));

// FLAG (Feature 28 — biometric push door): the device punch ingest webhook. Mounted
// here BEFORE express.json() so the body arrives as TEXT — a ZK ADMS terminal POSTs
// TAB-SEPARATED ATTLOG (text/plain), Cams/Matrix POST JSON; the per-vendor adapter
// parses the literal string. Device-secret auth (X-Device-Secret), NOT operator JWT
// — devices carry no session, exactly like the webhook surface above. Per-serial
// rate limit guards a chatty/looping terminal. Idempotent by dedupKey (retry-safe).
{
  const rateLimit = require('express-rate-limit');
  const { ipKeyGenerator } = require('express-rate-limit');
  const { extractClientIp } = require('./core/middleware/abuse.middleware');
  const biometricIngestLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600, // a busy gate rarely exceeds ~10/s; well above real device cadence
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `biometric:${req.params.deviceSerial || 'unknown'}`,
    message: { message: 'rate limit exceeded for this device' },
  });
  // Per-serial keying alone lets a distributed spray of DISTINCT random serials
  // bypass the cap (each unknown serial still runs a DB lookup). A coarse
  // per-IP ceiling in front bounds that: a real site's gateways behind one IP
  // stay well under 3000/min, an attacker rotating serials from one IP does not.
  const biometricIngestIpLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 3000,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `biometric-ip:${ipKeyGenerator(extractClientIp(req))}`,
    message: { message: 'rate limit exceeded' },
  });
  app.post(
    '/api/hr/biometric/ingest/:deviceSerial',
    biometricIngestIpLimiter,
    biometricIngestLimiter,
    express.text({ type: () => true, limit: '5mb' }),
    asyncHandler(require('./hr/attendance/biometric/webhook.controller').ingestPunch),
  );
}

// Raised from 10mb so a gallery with ~10 compressed images can still publish
// in a single request. Client-side compression keeps typical payloads small
// (see compressImageToDataUrl in ContentEditor.js) — this is just the ceiling.
app.use(express.json({ limit: '30mb' }));
app.use(cookieParser());

// Rich health check — DB connectivity + migration state + process info +
// env-var presence (no values). Returns 503 if DB is unreachable, 200 otherwise.
// UptimeRobot / AWS GA health checker / human admins hit this.
app.get('/health', async (req, res) => {
  try {
    const { runHealthCheck } = require('./core/lib/health');
    // Rich detail (env inventory, schema version, process info) is only for a
    // trusted caller: a valid HEALTH_DETAIL_TOKEN (header or query). Everyone
    // else gets the minimal status + DB up/down needed for uptime probes.
    const token = process.env.HEALTH_DETAIL_TOKEN;
    const provided = req.get('x-health-token') || req.query.token || '';
    const detailed = Boolean(token) && provided === token;
    const result = await runHealthCheck({ detailed });
    const httpStatus = result.status === 'ok' ? 200 : 503;
    res.status(httpStatus).json(result);
  } catch (err) {
    // Should never happen — runHealthCheck catches its own errors. Defensive
    // catch so a buggy health check doesn't 500 the entire app.
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// Cheap liveness probe — used when the rich /health is too slow / DB-down
// is acceptable (e.g. AWS GA TCP-only health check stays on the rich one).
app.get('/livez', (req, res) => {
  res.json({ status: 'ok', uptimeSec: Math.floor(process.uptime()) });
});

// Build/deploy visibility — shows the live commit hash + branch + build time.
// Compare with the latest commit on GitHub to know if a deploy is current.
// Public, no auth (it's just metadata about a running build).
//
// Reads commit + branch from .git/HEAD at startup (no env-var dependency
// so it works regardless of how PM2 was reloaded). Falls back to env vars
// if .git isn't present (e.g. some container runtimes).
const __versionCache = (() => {
  // Prefer env vars if explicitly set (deploy.sh sets these at build time).
  // Slice commit to 7 chars to match the .git/HEAD fallback path and what
  // the deploy verify step expects (it compares against `github.sha:0:7`).
  let commit = process.env.BUILD_COMMIT ? process.env.BUILD_COMMIT.slice(0, 7) : null;
  let branch = process.env.BUILD_BRANCH || null;
  let buildTime = process.env.BUILD_TIME || null;

  // Fallback: read .git/HEAD directly. Walks up from src/ to find .git.
  if (!commit) {
    try {
      const fs = require('fs');
      const path = require('path');
      // backend/src/index.js → backend/src → backend → repo-root (has .git)
      const repoRoot = path.resolve(__dirname, '..', '..');
      const gitDir = path.join(repoRoot, '.git');
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      if (head.startsWith('ref: ')) {
        const ref = head.slice(5);
        branch = branch || ref.replace('refs/heads/', '');
        commit = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim().slice(0, 7);
      } else {
        commit = head.slice(0, 7); // detached HEAD
      }
    } catch { /* leave as null */ }
  }
  return {
    commit: commit || 'unknown',
    branch: branch || 'unknown',
    buildTime: buildTime || 'unknown',
  };
})();

// Read a sibling app's `.build-info.json` (written by deploy.sh after a
// successful build). Returns 'unknown' shape if missing or malformed —
// front-ends will show 'unknown' until their next deploy actually builds.
function readSiblingBuildInfo(appName) {
  try {
    const fs = require('fs');
    const path = require('path');
    const file = path.resolve(__dirname, '..', '..', appName, '.build-info.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { commit: 'unknown', branch: 'unknown', buildTime: 'unknown' };
  }
}

// Current git HEAD on this checkout, read fresh on every /version hit
// (not cached at startup like __versionCache). Tells you what's
// checked out NOW — independent of whether each app has been
// rebuilt to match. If repo.commit != backend.commit, the new code
// is on disk but the backend hasn't reloaded yet.
function readRepoHead() {
  try {
    const fs = require('fs');
    const path = require('path');
    const repoRoot = path.resolve(__dirname, '..', '..');
    const gitDir = path.join(repoRoot, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5);
      const branch = ref.replace('refs/heads/', '');
      const commit = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim().slice(0, 7);
      return { commit, branch };
    }
    return { commit: head.slice(0, 7), branch: 'detached' };
  } catch {
    return { commit: 'unknown', branch: 'unknown' };
  }
}

app.get('/version', (req, res) => {
  // No-cache headers — when api.<host> goes behind Cloudflare orange-cloud
  // (planned 2026-05-10+ infra pivot), we need /version to bypass the
  // edge so deploy verification + uptime monitors always see fresh data.
  // CDN-Cache-Control + Cloudflare-CDN-Cache-Control cover the major edges.
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('CDN-Cache-Control', 'no-store');
  res.set('Cloudflare-CDN-Cache-Control', 'no-store');
  res.json({
    repo: readRepoHead(),
    backend: __versionCache,
    // Phase 2 (2026-05-10) moved platform/ → apps/platform/ — point the
    // build-info reader at the new path so /version stops claiming the
    // old May-9 build is still live. business/ still at root pending
    // Phase 4. readSiblingBuildInfo handles path separators.
    platform: readSiblingBuildInfo('apps/platform'),
    business: readSiblingBuildInfo('business'),
    serverStarted: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    // Top-level fields kept for backward compatibility with anything that
    // scraped the old shape (uptime monitors, smoke tests).
    ...__versionCache,
  });
});

// Enterprise SSO (SAML 2.0 SP + OIDC RP) — the PUBLIC login surface. Tenant
// slug rides the path (IdP-initiated SAML POSTs carry no tenant Host header).
// The SAML ACS parses its own urlencoded body on-route; everything else is
// GET, so mounting after express.json is safe. Session cookies are NOT set
// here — the flow ends in a one-time code exchanged at
// /api/customer/sso/exchange (ESS) or /api/auth/sso/exchange (operator).
app.use('/sso', require('./core/routes/sso.routes'));
// SCIM 2.0 provisioning (Okta / Azure AD / OneLogin) — bearer-only
// (ScimToken; the token IS the tenant — no session, no tenant-host
// resolution). The router carries its own application/scim+json body parser.
app.use('/scim/v2', require('./hr/scim/scim.routes'));

app.use('/api/auth', authRoutes);
app.use('/api/business', businessRoutes);
app.use('/api/public/pricing', publicPricingRoutes);
// Feature 12 — UNAUTHENTICATED public careers board + apply (tenant resolved
// from :businessSlug; hard-scoped; rate-limited; no score/knockout disclosure).
app.use('/api/public/careers', require('./hr/talent/routes').publicCareers);
// Feature 38 — candidate CAREERS PORTAL (entitlement-gated by talent_acquisition):
// public board/apply + passwordless magic-link accounts + self-service profile.
app.use('/api/careers', require('./hr/talent/careers/careersPortal.routes').publicRouter);
app.use('/api/candidate', require('./hr/talent/careers/careersPortal.routes').candidateRouter);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/admin/pricing', pricingAdminRoutes);
// Super-admin SaaS subscription promo codes (AdminCoupon). Controller +
// routes re-homed into core for the HR fork (reuse-map §2.3.1).
app.use('/api/admin/subscription-coupons', adminCouponRoutes);
app.use('/api/admin/notification-access', require('./core/routes/notificationAccess.routes'));
app.use('/api/admin', adminRoutes);
app.use('/api/tenant', tenantRoutes);
app.use('/api/customer', customerRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/notifications/webhook', require('./core/routes/notificationWebhook.routes'));
app.use('/api/notification-config', require('./core/routes/notificationConfig.routes'));
app.use('/api/unsubscribe', require('./core/routes/unsubscribe.routes'));
app.use('/api/locations', require('./core/routes/locations.routes'));
app.use('/api/rbac', require('./core/routes/businessRoles.routes'));
app.use('/api/public-api', require('./core/routes/publicApi.routes'));
app.use('/api/v1', require('./core/routes/publicV1.routes'));
app.use('/api/ai', require('./core/routes/ai.routes'));
app.use('/api/inbox', inboxRoutes);
// /api/chat removed (aapkachat product deleted).
app.use('/api/upload', uploadRoutes);
app.use('/api/locale', localeRoutes);
app.use('/api/internal', require('./core/routes/internal.routes'));
app.use('/api/geo', require('./core/routes/geo.routes'));
app.use('/api/integrations', require('./core/routes/integrations.routes'));
// HR vertical API (employees, org, and — as built — attendance/leave/payroll/compliance).
app.use('/api/hr', require('./hr/routes'));

// Sentry error handler — must come AFTER all routes but BEFORE any
// custom 500 handler. No-op if Sentry wasn't initialised.
Sentry.setupExpressErrorHandler(app);

// Fallback handler so errors still return 500 after Sentry captures them.
// Keeps our responses JSON instead of the default HTML error page.
//
// Info-disclosure guard: the full message + stack always go to the server log
// / Sentry, but the CLIENT only sees err.message for deliberate client-facing
// errors (4xx, or err.expose === true). Server-side faults (5xx) — including
// raw Prisma/DB errors that leak schema, column names and query fragments —
// return a generic message so the data model can't be mapped through errors.
app.use((err, _req, res, _next) => {
  console.error('[Unhandled]', err.message, err.stack);
  const status = err.status || err.statusCode || 500;
  const clientSafe = status < 500 || err.expose === true;
  res.status(status).json({ message: clientSafe ? (err.message || 'Error') : 'Internal server error' });
});

const PORT = process.env.PORT || 5000;

// Export the app so a boot smoke-test can require() the full route graph without
// binding a port; only listen when run directly.
if (require.main === module) app.listen(PORT, () => {
  console.log(`DriftHR backend running on port ${PORT}`);
  // Surface social-login readiness loudly at boot — a missing provider
  // credential otherwise fails silently as a confusing 401 at sign-in time.
  try {
    const { listConfiguredProviders } = require('./core/lib/socialAuth');
    const configured = listConfiguredProviders();
    if (configured.length) {
      console.log(`[social-auth] configured providers: ${configured.join(', ')}`);
    } else {
      console.warn('[social-auth] NO providers configured — social sign-in will return 503. Set GOOGLE_CLIENT_ID (must match the platform NEXT_PUBLIC_GOOGLE_CLIENT_ID).');
    }
  } catch (e) {
    console.warn('[social-auth] provider check failed:', e.message);
  }
  if (process.env.BACKEND_RUN_SCHEDULER !== '0') {
    initScheduler();
  } else {
    console.log('[Scheduler] disabled for API worker');
  }

  if (process.env.BACKEND_RUN_STARTUP_TASKS !== '0') {
    runStartupTasks();
  } else {
    console.log('[startup-tasks] disabled for API worker');
  }
});

module.exports = app;
