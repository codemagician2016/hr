const jwt = require('jsonwebtoken');

const ACCESS_TOKEN_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
const REFRESH_TOKEN_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
const ACCESS_TOKEN_MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const OPERATOR_COOKIE_NAME = 'ae_operator';
const OPERATOR_REFRESH_COOKIE_NAME = 'ae_operator_refresh';
const CUSTOMER_COOKIE_NAME = 'token';
const CUSTOMER_REFRESH_COOKIE_NAME = 'token_refresh';

function getJwtSecret() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
  return process.env.JWT_SECRET;
}

function cleanPayload(payload) {
  const decoded = typeof payload === 'string' ? jwt.decode(payload) : payload;
  const {
    exp: _exp,
    iat: _iat,
    nbf: _nbf,
    jti: _jti,
    tokenUse: _tokenUse,
    ...clean
  } = decoded || {};
  return clean;
}

function generateAccessToken(payload) {
  return jwt.sign({ ...cleanPayload(payload), tokenUse: 'access' }, getJwtSecret(), {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  });
}

function generateRefreshToken(payload) {
  return jwt.sign({ ...cleanPayload(payload), tokenUse: 'refresh' }, getJwtSecret(), {
    expiresIn: REFRESH_TOKEN_EXPIRES_IN,
  });
}

function generateToken(payload) {
  return generateAccessToken(payload);
}

function generateCustomerAccessToken(payload) {
  return generateAccessToken({ type: 'customer', ...cleanPayload(payload) });
}

function generateCustomerRefreshToken(payload) {
  return generateRefreshToken({ type: 'customer', ...cleanPayload(payload) });
}

function normaliseHost(raw) {
  return String(raw || '').split(':')[0].trim().toLowerCase();
}

function firstHeaderValue(raw) {
  return String(raw || '')
    .split(',')
    .map((part) => part.trim())
    .find(Boolean) || '';
}

function hostFromUrlHeader(raw) {
  const value = firstHeaderValue(raw);
  if (!value) return '';
  try {
    return normaliseHost(new URL(value).host);
  } catch {
    return '';
  }
}

function getHeader(requestLike, name) {
  if (!requestLike || typeof requestLike === 'string') return '';
  if (typeof requestLike.get === 'function') {
    return requestLike.get(name) || requestLike.get(name.toLowerCase()) || '';
  }
  const headers = requestLike.headers || {};
  return headers[name]
    || headers[name.toLowerCase()]
    || headers[name.toUpperCase()]
    || '';
}

function resolveOperatorCookieHost(requestLike) {
  if (typeof requestLike === 'string') return normaliseHost(requestLike);

  const tenantHost = normaliseHost(getHeader(requestLike, 'x-tenant-host'));
  if (tenantHost) return tenantHost;

  const originHost = hostFromUrlHeader(getHeader(requestLike, 'origin'));
  if (originHost) return originHost;

  const forwardedHost = normaliseHost(firstHeaderValue(getHeader(requestLike, 'x-forwarded-host')));
  if (forwardedHost) return forwardedHost;

  const refererHost = hostFromUrlHeader(getHeader(requestLike, 'referer'));
  if (refererHost) return refererHost;

  return normaliseHost(getHeader(requestLike, 'host'));
}

function configuredCookieDomain() {
  const raw = process.env.AUTH_COOKIE_DOMAIN || '.aapkatech.com';
  return (raw.startsWith('.') ? raw : `.${raw}`).toLowerCase();
}

function hostMatchesCookieDomain(host, domain = configuredCookieDomain()) {
  const bareDomain = domain.replace(/^\./, '');
  return host === bareDomain || host.endsWith(domain);
}

function usesSharedCookieDomain(requestLike) {
  const host = resolveOperatorCookieHost(requestLike);
  // Host-driven decision (preserves the Codex host-scoped cookie design):
  //  - platform host under AUTH_COOKIE_DOMAIN (e.g. *.sitepresso.com) →
  //    shared, cross-subdomain cookie. UNCHANGED from before.
  //  - a verified BYO custom domain (host known but NOT under that domain)
  //    → host-only cookie. A Domain=.sitepresso.com cookie is rejected by
  //    the browser on a custom domain, so this is the only thing that lets
  //    Google / social sign-in actually persist there.
  //  - host unknown (proxy stripped every host hint): keep the legacy
  //    production safety-net so platform-subdomain logins never regress.
  if (host) return hostMatchesCookieDomain(host);
  return process.env.NODE_ENV === 'production';
}

function presentCookieNames(requestLike, baseName) {
  const cookies = requestLike?.cookies || {};
  return Object.keys(cookies).filter((name) => (
    name.startsWith(`${baseName}_`)
    && (baseName === OPERATOR_REFRESH_COOKIE_NAME || (
      name !== OPERATOR_REFRESH_COOKIE_NAME
      && !name.startsWith(`${OPERATOR_REFRESH_COOKIE_NAME}_`)
    ))
    && (baseName === CUSTOMER_REFRESH_COOKIE_NAME || (
      name !== CUSTOMER_REFRESH_COOKIE_NAME
      && !name.startsWith(`${CUSTOMER_REFRESH_COOKIE_NAME}_`)
    ))
  ));
}

function buildScopedCookieName(baseName, requestLike) {
  if (usesSharedCookieDomain(requestLike)) return baseName;

  const host = resolveOperatorCookieHost(requestLike);
  const suffix = (host || 'default')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const derived = `${baseName}_${suffix}`;

  if (typeof requestLike !== 'string') {
    const present = presentCookieNames(requestLike, baseName);
    if (present.includes(derived)) return derived;
    if (present.length === 1) return present[0];
  }

  return derived;
}

function buildOperatorCookieName(requestLike) {
  return buildScopedCookieName(OPERATOR_COOKIE_NAME, requestLike);
}

function buildOperatorRefreshCookieName(requestLike) {
  return buildScopedCookieName(OPERATOR_REFRESH_COOKIE_NAME, requestLike);
}

function listScopedCookieNames(baseName, requestLike) {
  const names = new Set([baseName, buildScopedCookieName(baseName, requestLike)]);
  for (const name of presentCookieNames(requestLike, baseName)) names.add(name);
  return Array.from(names).filter(Boolean);
}

function cookieOptions(maxAge, requestLike) {
  const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge,
    path: '/',
  };
  if (usesSharedCookieDomain(requestLike)) {
    options.domain = configuredCookieDomain();
    options.secure = true;
  }
  return options;
}

function clearOptions(options) {
  const { maxAge: _ignored, ...clearOpts } = options;
  return clearOpts;
}

function readBearerToken(req) {
  const header = getHeader(req, 'authorization');
  const match = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  return match ? match[1].trim() : null;
}

function readFirstCookie(req, cookieNames) {
  for (const cookieName of cookieNames) {
    if (req?.cookies?.[cookieName]) return req.cookies[cookieName];
  }
  return null;
}

function setCookiePair(res, requestLike, accessName, refreshName, accessToken, refreshToken) {
  const accessOptions = cookieOptions(ACCESS_TOKEN_MAX_AGE_MS, requestLike);
  const refreshOptions = cookieOptions(REFRESH_TOKEN_MAX_AGE_MS, requestLike);

  for (const cookieName of listScopedCookieNames(accessName, requestLike)) {
    res.clearCookie(cookieName, clearOptions(accessOptions));
  }
  for (const cookieName of listScopedCookieNames(refreshName, requestLike)) {
    res.clearCookie(cookieName, clearOptions(refreshOptions));
  }

  res.cookie(buildScopedCookieName(accessName, requestLike), accessToken, accessOptions);
  if (refreshToken) {
    res.cookie(buildScopedCookieName(refreshName, requestLike), refreshToken, refreshOptions);
  }
}

function listOperatorCookieNames(requestLike) {
  return listScopedCookieNames(OPERATOR_COOKIE_NAME, requestLike);
}

function listOperatorRefreshCookieNames(requestLike) {
  return listScopedCookieNames(OPERATOR_REFRESH_COOKIE_NAME, requestLike);
}

function setTokenCookie(res, payloadOrAccessToken, requestLike) {
  const payload = cleanPayload(payloadOrAccessToken);
  const accessToken = typeof payloadOrAccessToken === 'string'
    ? payloadOrAccessToken
    : generateAccessToken(payload);
  const refreshToken = payload.id ? generateRefreshToken(payload) : null;
  setCookiePair(res, requestLike, OPERATOR_COOKIE_NAME, OPERATOR_REFRESH_COOKIE_NAME, accessToken, refreshToken);
}

function clearTokenCookie(res, requestLike) {
  const accessOptions = cookieOptions(ACCESS_TOKEN_MAX_AGE_MS, requestLike);
  const refreshOptions = cookieOptions(REFRESH_TOKEN_MAX_AGE_MS, requestLike);
  for (const cookieName of listOperatorCookieNames(requestLike)) {
    res.clearCookie(cookieName, clearOptions(accessOptions));
  }
  for (const cookieName of listOperatorRefreshCookieNames(requestLike)) {
    res.clearCookie(cookieName, clearOptions(refreshOptions));
  }
}

function readOperatorToken(req) {
  return readFirstCookie(req, listOperatorCookieNames(req)) || readBearerToken(req);
}

function readOperatorRefreshToken(req) {
  return readFirstCookie(req, listOperatorRefreshCookieNames(req));
}

function setCustomerTokenCookie(res, payloadOrAccessToken, requestLike) {
  const payload = cleanPayload(payloadOrAccessToken);
  const accessToken = typeof payloadOrAccessToken === 'string'
    ? payloadOrAccessToken
    : generateCustomerAccessToken(payload);
  const refreshToken = payload.id ? generateCustomerRefreshToken(payload) : null;
  setCookiePair(res, requestLike, CUSTOMER_COOKIE_NAME, CUSTOMER_REFRESH_COOKIE_NAME, accessToken, refreshToken);
}

function clearCustomerTokenCookie(res, requestLike) {
  const accessOptions = cookieOptions(ACCESS_TOKEN_MAX_AGE_MS, requestLike);
  const refreshOptions = cookieOptions(REFRESH_TOKEN_MAX_AGE_MS, requestLike);
  for (const cookieName of listScopedCookieNames(CUSTOMER_COOKIE_NAME, requestLike)) {
    res.clearCookie(cookieName, clearOptions(accessOptions));
  }
  for (const cookieName of listScopedCookieNames(CUSTOMER_REFRESH_COOKIE_NAME, requestLike)) {
    res.clearCookie(cookieName, clearOptions(refreshOptions));
  }
}

function readCustomerToken(req) {
  return readFirstCookie(req, listScopedCookieNames(CUSTOMER_COOKIE_NAME, req)) || readBearerToken(req);
}

function readCustomerRefreshToken(req) {
  return readFirstCookie(req, listScopedCookieNames(CUSTOMER_REFRESH_COOKIE_NAME, req));
}

module.exports = {
  ACCESS_TOKEN_EXPIRES_IN,
  REFRESH_TOKEN_EXPIRES_IN,
  ACCESS_TOKEN_MAX_AGE_MS,
  REFRESH_TOKEN_MAX_AGE_MS,
  OPERATOR_COOKIE_NAME,
  OPERATOR_REFRESH_COOKIE_NAME,
  CUSTOMER_COOKIE_NAME,
  CUSTOMER_REFRESH_COOKIE_NAME,
  getJwtSecret,
  generateToken,
  generateAccessToken,
  generateRefreshToken,
  generateCustomerAccessToken,
  generateCustomerRefreshToken,
  setTokenCookie,
  clearTokenCookie,
  readOperatorToken,
  readOperatorRefreshToken,
  setCustomerTokenCookie,
  clearCustomerTokenCookie,
  readCustomerToken,
  readCustomerRefreshToken,
  resolveOperatorCookieHost,
  buildOperatorCookieName,
  buildOperatorRefreshCookieName,
  configuredCookieDomain,
  usesSharedCookieDomain,
};
