/**
 * Middleware that accepts EITHER a User token (staff/admin) or a Customer token.
 * Sets req.user (for User) or req.customer (for Customer).
 *
 * Vertical-isolation safety: when the request comes from an operator surface
 * (admin host `app.<platform>` / `admin.<platform>`, OR a path-based admin URL
 * like `/dashboard`, `/<vertical>/admin`, `/<vertical>/staff`), operator auth
 * is tried FIRST. Otherwise customer auth is tried first.
 *
 * Why: a single human can hold BOTH cookies in the browser — operator cookie
 * from their seller console + customer cookie from booking at a different
 * business. Without context-aware ordering, opening the seller console would
 * surface their CUSTOMER notifications (e.g. "Your appointment at Water is
 * booked") inside the operator inbox — a vertical-isolation leak.
 *
 * 2026-05-12 incident #1 (baab6f4): leaked at app.sitepresso.com/dashboard.
 * Fixed by host check.
 * 2026-05-12 incident #2 (this commit): leaked at sitepresso.com/ecom/admin
 * because the API is served at api.sitepresso.com — host check never matched.
 * Fix: also inspect Origin/Referer to recognise operator surfaces by their
 * page URL, not the API host.
 */
const { authenticateCustomer, authenticateOperator } = require('./auth.middleware');

function firstHeader(value) {
  return String(value || '').split(',').map((s) => s.trim()).find(Boolean) || '';
}

function platformDomain() {
  return String(process.env.PLATFORM_DOMAIN || 'sitepresso.com').toLowerCase();
}

function isOperatorHostname(hostname) {
  if (!hostname) return false;
  const platform = platformDomain();
  return hostname === `app.${platform}` || hostname === `admin.${platform}`;
}

// Path-based operator surfaces. Per the locked URL topology:
//   - /dashboard                 (operator console on app.<platform>)
//   - /<vertical>/admin          (seller console — e.g. /ecom/admin)
//   - /<vertical>/staff          (staff console)
//   - /<slug>/admin, /<slug>/staff (tenant-scoped admin under platform host)
// Anything else (storefronts, booking pages, marketing) stays customer-first.
const OPERATOR_PATH_RE = /^\/(?:[a-z0-9-]+\/)?(?:admin|staff|dashboard)(?:\/|$|\?)/i;

function isOperatorPath(pathname) {
  if (!pathname) return false;
  return OPERATOR_PATH_RE.test(pathname);
}

function parseUrlSafe(value) {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isOperatorSurface(req) {
  const host = firstHeader(req.headers['x-forwarded-host'] || req.headers.host).toLowerCase().split(':')[0];
  if (isOperatorHostname(host)) return true;

  // Origin only carries scheme+host (no path) — useful when the API is on a
  // separate subdomain (api.<platform>) and the page host is app.<platform>.
  const origin = parseUrlSafe(firstHeader(req.headers.origin));
  if (origin && isOperatorHostname(origin.hostname.toLowerCase())) return true;

  // Referer carries the full page URL — needed for path-based admin (e.g.
  // sitepresso.com/ecom/admin) where the host alone is the apex.
  const referer = parseUrlSafe(firstHeader(req.headers.referer));
  if (referer) {
    if (isOperatorHostname(referer.hostname.toLowerCase())) return true;
    if (isOperatorPath(referer.pathname)) return true;
  }

  return false;
}

async function customerOrUser(req, res, next) {
  const operatorFirst = isOperatorSurface(req);

  if (operatorFirst) {
    try {
      req.user = await authenticateOperator(req, res);
      req.authType = 'user';
      return next();
    } catch {
      // Fall through to customer auth — rare on operator surfaces but keeps
      // shared endpoints reachable for guest preview / public docs.
    }
    try {
      req.customer = await authenticateCustomer(req, res);
      req.authType = 'customer';
      return next();
    } catch (err) {
      return res.status(err.statusCode || 401).json({ message: err.message || 'Not authenticated' });
    }
  }

  try {
    req.customer = await authenticateCustomer(req, res);
    req.authType = 'customer';
    return next();
  } catch {
    // Fall through to operator auth for shared staff/customer endpoints.
  }

  try {
    req.user = await authenticateOperator(req, res);
    req.authType = 'user';
    return next();
  } catch (err) {
    return res.status(err.statusCode || 401).json({ message: err.message || 'Not authenticated' });
  }
}

async function customerOrUserOptional(req, res, next) {
  const operatorFirst = isOperatorSurface(req);

  async function tryOperator() {
    try {
      req.user = await authenticateOperator(req, res);
      req.authType = 'user';
      return true;
    } catch {
      return false;
    }
  }

  async function tryCustomer() {
    try {
      req.customer = await authenticateCustomer(req, res);
      req.authType = 'customer';
      return true;
    } catch {
      return false;
    }
  }

  if (operatorFirst) {
    if (await tryOperator()) return next();
    if (await tryCustomer()) return next();
    return next();
  }

  if (await tryCustomer()) return next();
  if (await tryOperator()) return next();
  return next();
}

module.exports = { customerOrUser, customerOrUserOptional, isOperatorSurface };
