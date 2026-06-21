// Sentry wiring for the backend. No-op if SENTRY_DSN isn't set, so the
// app runs fine without it in dev / before the owner has created an
// account. Errors keep going to PM2 logs either way; Sentry just adds
// a second destination that alerts + deduplicates + shows stack traces.
const Sentry = require('@sentry/node');

let initialised = false;

function initSentry() {
  if (initialised) return Sentry;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('[Sentry] SENTRY_DSN not set — error tracking disabled.');
    return Sentry;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    // Sample every error (they're rare by definition). For performance
    // traces we sample 10% — enough to spot patterns, cheap enough to
    // stay inside the free plan.
    tracesSampleRate: 0.1,
    // Strip sensitive headers before the event leaves the server.
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers.cookie;
        delete event.request.headers.authorization;
      }
      return event;
    },
  });
  initialised = true;
  console.log(`[Sentry] initialised — env=${process.env.NODE_ENV || 'development'}`);
  return Sentry;
}

module.exports = { Sentry, initSentry };
