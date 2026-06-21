function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureRegistrarException(err, context = {}) {
  const sentry = global.Sentry || global.__SENTRY__;
  if (sentry?.captureException) {
    sentry.captureException(err, { tags: { area: 'domain-reseller', registrar: context.registrar || 'unknown' }, extra: context });
  }
}

async function withRegistrarRetry(context, fn, options = {}) {
  const attempts = options.attempts || 3;
  const baseDelayMs = options.baseDelayMs || 250;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (err?.retryable === false) break;
      if (attempt >= attempts) break;
      await sleep(baseDelayMs * (2 ** (attempt - 1)));
    }
  }
  captureRegistrarException(lastError, { ...context, attempts });
  throw lastError;
}

module.exports = {
  captureRegistrarException,
  withRegistrarRetry,
};
