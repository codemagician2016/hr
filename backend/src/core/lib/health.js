// Rich health check used by UptimeRobot, AWS GA health checker, and human
// admins. Replaces the trivial { status: 'ok' } endpoint with a real probe
// of dependencies + process state.
//
// Returns 200 only when ALL critical checks pass (DB connectivity).
// Non-critical checks (memory headroom, etc.) are reported but don't fail
// the overall response — operators see them as warnings in the body.
//
// Designed to be fast (<100 ms typical) so it's safe to poll every 30s
// from a CDN health checker.

const prisma = require('./prisma');

const HEALTH_DB_TIMEOUT_MS = 1500;

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function dbCheck() {
  const start = Date.now();
  try {
    // SELECT 1 — cheapest possible round trip
    await withTimeout(prisma.$queryRaw`SELECT 1`, HEALTH_DB_TIMEOUT_MS, 'db');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err.message };
  }
}

async function migrationCheck() {
  try {
    // _prisma_migrations is created by `prisma migrate deploy`. We check the
    // most recent migration applied so an operator can grep the version
    // running. If the table doesn't exist, that's a deploy issue.
    const rows = await withTimeout(
      prisma.$queryRaw`SELECT migration_name, finished_at FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
      HEALTH_DB_TIMEOUT_MS,
      'migration',
    );
    if (rows.length === 0) {
      return { ok: false, error: 'No migrations applied' };
    }
    return {
      ok: true,
      latestMigration: rows[0].migration_name,
      appliedAt: rows[0].finished_at,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function processInfo() {
  const uptimeSec = Math.floor(process.uptime());
  const mem = process.memoryUsage();
  return {
    nodeVersion: process.version,
    uptimeSec,
    uptimeHuman:
      uptimeSec > 86400
        ? `${Math.floor(uptimeSec / 86400)}d ${Math.floor((uptimeSec % 86400) / 3600)}h`
        : uptimeSec > 3600
          ? `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`
          : `${Math.floor(uptimeSec / 60)}m`,
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    },
    pid: process.pid,
  };
}

function envSummary() {
  // Mirror the resolveRecipient() logic in utils/email.js so operators can
  // tell at a glance whether outgoing mail is being redirected to a single
  // test inbox vs. going to real recipients. Critical for staging where
  // we DO NOT want real customer mail to leak — and equally critical
  // before a real launch where the override MUST be off.
  const forceOverride = String(process.env.FORCE_EMAIL_OVERRIDE || '').toLowerCase() === 'true';
  const hasEmailOverride = !!process.env.EMAIL_OVERRIDE;
  const isProd = (process.env.NODE_ENV || 'development') === 'production';
  // The override fires when not-prod (any NODE_ENV other than 'production')
  // OR FORCE_EMAIL_OVERRIDE=true is explicitly set, AND EMAIL_OVERRIDE is
  // a non-empty string. If either condition is missing the recipient is
  // the real address.
  const emailRedirectActive = (!isProd || forceOverride) && hasEmailOverride;

  return {
    nodeEnv: process.env.NODE_ENV || 'development',
    // Pretty hostname so operators can tell staging vs prod at a glance.
    // Reads PLATFORM_DOMAIN if set (sitepresso.com on prod, aapkatech.com
    // on staging).
    platformDomain: process.env.PLATFORM_DOMAIN || null,
    // Email-redirect status. emailRedirectActive=true means EVERY outgoing
    // email goes to EMAIL_OVERRIDE instead of the real recipient. Safe for
    // staging; must be false in real prod.
    email: {
      forceOverride,
      hasEmailOverride,
      emailRedirectActive,
    },
    // Confirm critical env vars are set WITHOUT leaking values
    has: {
      DATABASE_URL: !!process.env.DATABASE_URL,
      JWT_SECRET: !!process.env.JWT_SECRET,
      // SES/S3 credentials: 'env-keys' when explicit AWS_ACCESS_KEY_ID is set,
      // otherwise 'instance-role' (the EC2 instance profile supplies creds).
      // Under role-based auth there are intentionally no keys in env — healthy,
      // not a missing-config warning.
      AWS_AUTH: process.env.AWS_ACCESS_KEY_ID ? 'env-keys' : 'instance-role',
      SES_FROM_EMAIL: !!process.env.SES_FROM_EMAIL,
      SENTRY_DSN: !!process.env.SENTRY_DSN,
      MSG91_API_KEY: !!process.env.MSG91_API_KEY,
      TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
      EMAIL_OVERRIDE: hasEmailOverride,
      FORCE_EMAIL_OVERRIDE: forceOverride,
    },
  };
}

// Run all checks in parallel for speed. Critical checks (DB) decide the
// overall HTTP status.
// `detailed` gates the info-disclosure-sensitive body (env provider inventory,
// migration/schema version, PID, Node version, memory). Unauthenticated callers
// (UptimeRobot / load-balancer probes) only need the status + DB up/down, so
// the default is the safe, minimal shape. index.js passes detailed:true only
// for an authenticated super-admin or a matching HEALTH_DETAIL_TOKEN.
async function runHealthCheck({ detailed = false } = {}) {
  const start = Date.now();
  const [db, migration] = await Promise.all([dbCheck(), migrationCheck()]);

  const ok = db.ok; // DB is the only "must-have" — migration check failure
                    // is informational (could be a fresh DB)

  if (!detailed) {
    return {
      status: ok ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checkLatencyMs: Date.now() - start,
      checks: { db: { ok: db.ok, latencyMs: db.latencyMs }, migration: { ok: migration.ok } },
    };
  }

  return {
    status: ok ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checkLatencyMs: Date.now() - start,
    checks: {
      db,
      migration,
    },
    process: processInfo(),
    env: envSummary(),
  };
}

module.exports = {
  runHealthCheck,
  // exposed for tests
  dbCheck,
  migrationCheck,
  processInfo,
  envSummary,
};
