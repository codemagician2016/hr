const MODE_SANDBOX = 'sandbox';
const MODE_LIVE = 'live';

const DEFAULT_BASE_URLS = Object.freeze({
  OPENPROVIDER: {
    // The legacy CTE sandbox (api.cte.openprovider.eu) is retired; the current
    // sandbox is plain HTTP on a custom port. Override via OPENPROVIDER_API_BASE_*.
    sandbox: 'http://api.sandbox.openprovider.nl:8480/v1beta',
    live: 'https://api.openprovider.eu/v1beta',
  },
});

function getDomainResellerMode(env = process.env) {
  const mode = String(env.DOMAIN_RESELLER_MODE || MODE_SANDBOX).trim().toLowerCase();
  if (mode === MODE_LIVE) return MODE_LIVE;
  return MODE_SANDBOX;
}

function envNameFor(registrar, suffix) {
  if (registrar === 'OPENPROVIDER') return `OPENPROVIDER_${suffix}`;
  return '';
}

function csv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getRegistrarConfig(registrar, env = process.env) {
  const mode = getDomainResellerMode(env);
  const defaults = DEFAULT_BASE_URLS[registrar];
  if (!defaults) {
    throw new Error(`Unknown domain registrar '${registrar}'`);
  }

  const sandboxEnv = envNameFor(registrar, 'API_BASE_SANDBOX');
  const liveEnv = envNameFor(registrar, 'API_BASE_LIVE');
  const baseUrl = mode === MODE_LIVE
    ? (env[liveEnv] || defaults.live)
    : (env[sandboxEnv] || defaults.sandbox);

  return {
    registrar,
    mode,
    baseUrl,
    username: env.OPENPROVIDER_USERNAME || '',
    password: env.OPENPROVIDER_PASSWORD || '',
    // Customer handle (e.g. AB123456-XX) used as owner/admin/tech/billing on
    // registrations + transfers. Create it once in the Openprovider CP or via
    // POST /v1beta/customers, then set OPENPROVIDER_CUSTOMER_HANDLE.
    customerHandle: env.OPENPROVIDER_CUSTOMER_HANDLE || '',
    // Optional explicit client IP for the auth/login call; if blank Openprovider
    // uses the request source IP (which must be on the CP IP whitelist).
    authIp: env.OPENPROVIDER_AUTH_IP || '',
    nameservers: csv(env.DOMAIN_RESELLER_NAMESERVERS || env.OPENPROVIDER_NAMESERVERS),
    hasCredentials: Boolean(env.OPENPROVIDER_USERNAME && env.OPENPROVIDER_PASSWORD),
  };
}

module.exports = {
  DEFAULT_BASE_URLS,
  MODE_LIVE,
  MODE_SANDBOX,
  getDomainResellerMode,
  getRegistrarConfig,
};
