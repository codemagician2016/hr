const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const {
  getJwtSecret,
  readOperatorToken,
  readOperatorRefreshToken,
  setTokenCookie,
  readCustomerToken,
  readCustomerRefreshToken,
  setCustomerTokenCookie,
  resolveOperatorCookieHost,
} = require('../utils/generateToken');
const { effectivePermissions, SYSTEM_ROLES, SYSTEM_ROLE_SCOPES, SYSTEM_ROLE_COMP_VISIBILITY } = require('../lib/rbac');
const { ROLES } = require('../lib/roles');
const { resolveVertical } = require('../lib/vertical');
const { routableCustomDomainWhere } = require('../lib/customDomainRouting');
const { hostCandidates } = require('../lib/mobileHost');

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  businessId: true,
  avatarUrl: true,
  subtitle: true,
  bio: true,
  isActive: true,
  showOnWebsite: true,
  isServiceProvider: true,
  businessRoleId: true,
  passwordChangedAt: true,
  businessRole: { select: { id: true, name: true, permissions: true, isSystem: true, defaultScope: true, compVisibility: true } },
};

const CUSTOMER_SELECT = {
  id: true,
  email: true,
  name: true,
  businessId: true,
  phone: true,
  dateOfBirth: true,
  avatarUrl: true,
  preferredLanguage: true,
  calendarFeedToken: true,
  passwordChangedAt: true,
};

// A JWT issued before the account's last password change is revoked. 5s skew
// buffer so a token minted the same second as the change (iat floors to the
// second) is never wrongly rejected. No-op when passwordChangedAt is null
// (every existing session), so this only ever revokes post-reset.
function tokenPredatesPasswordChange(decoded, passwordChangedAt) {
  if (!passwordChangedAt || !decoded?.iat) return false;
  return (decoded.iat * 1000) < (passwordChangedAt.getTime() - 5000);
}

function isExpiredTokenError(err) {
  return err?.name === 'TokenExpiredError';
}

function tokenError(message, statusCode = 401) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function assertAccessToken(decoded) {
  if (decoded?.tokenUse && decoded.tokenUse !== 'access') {
    throw tokenError('Expected access token');
  }
}

function assertRefreshToken(decoded) {
  if (decoded?.tokenUse !== 'refresh') {
    throw tokenError('Expected refresh token');
  }
}

function verifyAccessToken(token) {
  const decoded = jwt.verify(token, getJwtSecret());
  assertAccessToken(decoded);
  return decoded;
}

function verifyRefreshToken(token) {
  const decoded = jwt.verify(token, getJwtSecret());
  assertRefreshToken(decoded);
  return decoded;
}

async function resolveTenantBusinessId(req) {
  const host = resolveOperatorCookieHost(req);
  if (!host) return null;

  const platformDomain = (
    process.env.PLATFORM_DOMAIN
    || process.env.NEXT_PUBLIC_PLATFORM_DOMAIN
    || 'sitepresso.com'
  ).toLowerCase();
  const platformSuffix = `.${platformDomain}`;
  const aapkaSuffix = '.aapkatech.com';

  const lookupByHost = async (h) => {
    if (h.endsWith(platformSuffix)) {
      const sub = h.slice(0, -platformSuffix.length);
      if (sub && !sub.includes('.')) {
        const biz = await prisma.business.findUnique({ where: { slug: sub }, select: { id: true } });
        return biz?.id || null;
      }
    }

    if (h.endsWith(aapkaSuffix)) {
      const sub = h.slice(0, -aapkaSuffix.length);
      if (sub && !sub.includes('.')) {
        const biz = await prisma.business.findUnique({ where: { slug: sub }, select: { id: true } });
        return biz?.id || null;
      }
    }

    // BYO custom-domain lookup, re-enabled for the white-label ESS: a tenant's
    // own domain (e.g. careers.acme.com) must resolve to its businessId so the
    // cross-tenant session guard below can reject a customer session that belongs
    // to a different business. Uses the same routable-host filter as the public
    // tenant resolver (core/lib/customDomainRouting + internal.routes /tenant-route).
    // Returns null when the host is not a connected custom domain, so platform
    // subdomains and unknown hosts behave exactly as before.
    const customDomainWhere = routableCustomDomainWhere(h);
    if (!customDomainWhere) return null;
    const biz = await prisma.business.findFirst({
      where: { subscription: { is: customDomainWhere } },
      select: { id: true },
    });
    return biz?.id || null;
  };

  // Feature 41 — mobile-web hosts: exact host first, then its m-alias base
  // (m-acme.drifthr.com → acme.drifthr.com, m.acme.com → acme.com).
  for (const candidate of hostCandidates(host)) {
    const id = await lookupByHost(candidate);
    if (id) return id;
  }
  return null;
}

// Seed the HR system roles (Owner / HR-Admin / Finance / Manager) for a
// business on first operator login. Modelled on the removed booking/shop
// vertical role auto-provisioners: it upserts one BusinessRole row per
// SYSTEM_ROLES preset, keeping the permissions JSON in sync with the catalog
// so a permission added to rbac.js propagates to existing tenants on their
// next operator login.
//
// Idempotent — safe to call on every login. Returns the upserted system
// roles; null businessId is a no-op.
async function ensureDefaultHrRole({ businessId }) {
  if (!businessId) return null;
  const roles = [];
  for (const [roleName, preset] of Object.entries(SYSTEM_ROLES)) {
    const defaultScope = SYSTEM_ROLE_SCOPES[roleName] || 'ALL';
    const compVisibility = SYSTEM_ROLE_COMP_VISIBILITY[roleName] || 'NONE';
    const role = await prisma.businessRole.upsert({
      where: { businessId_name: { businessId, name: roleName } },
      update: {
        isSystem: true,
        permissions: preset,
        defaultScope,
        compVisibility,
      },
      create: {
        businessId,
        name: roleName,
        isSystem: true,
        permissions: preset,
        defaultScope,
        compVisibility,
      },
      select: { id: true, name: true, permissions: true, isSystem: true, defaultScope: true, compVisibility: true },
    });
    roles.push(role);
  }
  return roles;
}

async function authenticateOperator(req, res) {
  let decoded = null;
  const accessToken = readOperatorToken(req);

  if (accessToken) {
    try {
      decoded = verifyAccessToken(accessToken);
    } catch (err) {
      if (!isExpiredTokenError(err)) throw err;
    }
  }

  if (!decoded) {
    const refreshToken = readOperatorRefreshToken(req);
    if (!refreshToken) throw tokenError('Not authenticated');
    decoded = verifyRefreshToken(refreshToken);
    if (decoded?.type === 'customer') throw tokenError('Not authenticated');
    setTokenCookie(res, { id: decoded.id }, req);
  }

  if (!decoded?.id || decoded?.type === 'customer') throw tokenError('Not authenticated');

  const user = await prisma.user.findUnique({
    where: { id: decoded.id },
    select: USER_SELECT,
  });

  if (!user || !user.isActive) throw tokenError('User not found or inactive');
  if (tokenPredatesPasswordChange(decoded, user.passwordChangedAt)) {
    throw tokenError('Please sign in again — your password was changed.');
  }
  // Seed the HR system roles for this tenant on first operator login.
  // Idempotent; keeps existing tenants' system-role permissions in sync
  // with the rbac.js catalog. Role *assignment* to a user is an explicit
  // admin action — we no longer auto-assign a vertical role here.
  if (user.businessId) {
    try {
      const systemRoles = await ensureDefaultHrRole({ businessId: user.businessId });
      // If this operator already carries a system role, refresh its
      // permissions from the freshly-seeded catalog so an updated preset
      // takes effect without a re-login round-trip.
      if (systemRoles && user.businessRole?.isSystem && user.businessRole?.name) {
        const refreshed = systemRoles.find((r) => r.name === user.businessRole.name);
        if (refreshed) {
          user.businessRole = {
            id: refreshed.id,
            name: refreshed.name,
            permissions: refreshed.permissions || {},
            isSystem: refreshed.isSystem,
          };
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[authenticateOperator] ensureDefaultHrRole failed', err?.message || err);
    }
  }
  return user;
}

async function authenticateCustomer(req, res) {
  let decoded = null;
  const accessToken = readCustomerToken(req);

  if (accessToken) {
    try {
      decoded = verifyAccessToken(accessToken);
    } catch (err) {
      if (!isExpiredTokenError(err)) throw err;
    }
  }

  if (!decoded) {
    const refreshToken = readCustomerRefreshToken(req);
    if (!refreshToken) throw tokenError('Not authenticated');
    decoded = verifyRefreshToken(refreshToken);
    setCustomerTokenCookie(res, { id: decoded.id, businessId: decoded.businessId }, req);
  }

  if (decoded?.type !== 'customer' || !decoded?.id || !decoded?.businessId) {
    throw tokenError('Not a customer session');
  }

  // Active + non-anonymised only — a deactivated or purged (anonymised)
  // customer's existing session must stop resolving, not just be blocked at
  // the login form. A soft-deleted-but-active account (pendingDeletionAt set)
  // still resolves so the owner can sign in to undo.
  const customer = await prisma.customer.findFirst({
    where: { id: decoded.id, businessId: decoded.businessId, isActive: true, anonymisedAt: null },
    select: CUSTOMER_SELECT,
  });

  if (!customer) throw tokenError('Customer not found or inactive');
  if (tokenPredatesPasswordChange(decoded, customer.passwordChangedAt)) {
    throw tokenError('Please sign in again — your password was changed.');
  }

  const tenantBusinessId = await resolveTenantBusinessId(req);
  if (tenantBusinessId && tenantBusinessId !== customer.businessId) {
    throw tokenError('Customer session belongs to another business', 403);
  }

  return customer;
}

async function requireAuth(req, res, next) {
  try {
    req.user = await authenticateOperator(req, res);
    req.authType = 'user';
    return next();
  } catch (err) {
    const message = err.message === 'Not authenticated' ? 'Not authenticated' : err.message || 'Invalid or expired token';
    return res.status(err.statusCode || 401).json({ message });
  }
}

const protect = requireAuth;

function requireRole(...allowedRoles) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
    if (req.user.role === ROLES.SUPER_ADMIN || allowedRoles.includes(req.user.role)) return next();
    return res.status(403).json({ message: 'Forbidden: insufficient permissions' });
  };
}

function requireAnyRole(allowedRoles) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
    if (allowedRoles.includes(req.user.role)) return next();
    return res.status(403).json({ message: 'Forbidden: insufficient permissions' });
  };
}

const requireSuperAdmin = requireAnyRole([ROLES.SUPER_ADMIN]);
const requireBusinessAdmin = requireAnyRole([ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN]);
const requireStaff = requireAnyRole([ROLES.STAFF, ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN]);

async function requireCustomer(req, res, next) {
  try {
    req.customer = await authenticateCustomer(req, res);
    req.authType = 'customer';
    return next();
  } catch (err) {
    return res.status(err.statusCode || 401).json({ message: err.message || 'Invalid or expired token' });
  }
}

function requirePermission(key) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
    if (req.user.role === ROLES.SUPER_ADMIN) return next();
    const perms = effectivePermissions(req.user);
    if (perms && perms[key]) return next();
    return res.status(403).json({
      message: `Forbidden: missing permission "${key}"`,
      missingPermission: key,
    });
  };
}

// OR-semantics gate: allow the request if the caller holds ANY of `keys`.
// Used for shared read endpoints reachable by several personas (e.g. the payroll
// entity picker, needed by run-payroll AND reports/statutory-only roles).
function requireAnyPermission(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
    if (req.user.role === ROLES.SUPER_ADMIN) return next();
    const perms = effectivePermissions(req.user);
    if (perms && list.some((k) => perms[k])) return next();
    return res.status(403).json({
      message: `Forbidden: missing permission (one of "${list.join('", "')}")`,
      missingPermission: list,
    });
  };
}

// ECOMMERCE Path B (2026-05-01) — relational permission middleware.
//
// Reads from the EcomRolePermissionGrant table (24-permission catalog,
// see backend/src/lib/ecomPermissionCatalog.js). Used by all `/api/ecom/*`
// routes so a tenant with a custom ECOM role (Manager, Inventory, Support,
// Marketing, ReadOnly, or any user-defined role) is properly scoped.
//
// Bypass rules (in priority order):
//   1. SUPER_ADMIN — Sitepresso staff, full access
//   2. BUSINESS_ADMIN with no `businessRoleId` — back-compat: legacy
//      tenants who never adopted custom roles keep working as owner.
//   3. System "Owner" role — explicit "*" grant.
//   4. Otherwise — query EcomRolePermissionGrant for (roleId, key) and
//      allow tenant-wide grants, or location-scoped grants when the
//      request is explicitly scoped to that location.
function ecomRequestedLocationId(req) {
  const candidates = [
    req.query?.locationId,
    req.body?.locationId,
    req.params?.locationId,
    req.body?.toLocationId,
    req.body?.fromLocationId,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value && value !== 'ALL') return value;
  }
  return null;
}

function requireEcomPermission(key) {
  return async function (req, res, next) {
    try {
      if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
      if (req.user.role === ROLES.SUPER_ADMIN) return next();

      if (!req.user.businessId) {
        return res.status(403).json({ message: 'No business in scope' });
      }

      if (!req.businessVertical) {
        const business = await prisma.business.findUnique({
          where: { id: req.user.businessId },
          select: { vertical: true },
        });
        const vertical = resolveVertical(business?.vertical);
        if (vertical !== 'ECOMMERCE') {
          return res.status(404).json({ message: 'This feature is not available for this business vertical' });
        }
        req.businessVertical = vertical;
      }

      // BUSINESS_ADMIN without a custom role gets owner-equivalent access.
      // This is the back-compat path so tenants who haven't migrated to
      // ECOM roles keep working as before.
      if (req.user.role === ROLES.BUSINESS_ADMIN && !req.user.businessRoleId) {
        return next();
      }

      // System Owner role = "*". Skip the grant lookup.
      if (req.user.businessRole?.isSystem && req.user.businessRole?.name === 'Owner') {
        return next();
      }

      if (!req.user.businessRoleId) {
        return res.status(403).json({
          message: `Forbidden: no role assigned (missing permission "${key}")`,
          missingPermission: key,
        });
      }

      // Lazy-load grants once per request. A null locationId means the
      // permission applies across the tenant; a concrete locationId only
      // applies when the route/query/body is scoped to that same store.
      if (!req._ecomPerms) {
        const grants = await prisma.ecomRolePermissionGrant.findMany({
          where: {
            roleId: req.user.businessRoleId,
            // Honour expiry — null = no expiry, future = still valid.
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          select: { locationId: true, permission: { select: { key: true } } },
        });
        req._ecomPerms = grants.map((g) => ({
          key: g.permission.key,
          locationId: g.locationId || null,
        }));
      }

      const requestedLocationId = ecomRequestedLocationId(req);
      const hasGrant = req._ecomPerms.some((grant) => {
        if (grant.key !== key) return false;
        if (!grant.locationId) return true;
        return requestedLocationId && grant.locationId === requestedLocationId;
      });
      if (hasGrant) return next();

      return res.status(403).json({
        message: requestedLocationId
          ? `Forbidden: missing permission "${key}" at this location`
          : `Forbidden: missing tenant-wide permission "${key}"`,
        missingPermission: key,
        locationId: requestedLocationId,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[requireEcomPermission] failed', err?.message || err);
      return res.status(500).json({ message: 'Permission check failed' });
    }
  };
}

// ── Vertical-specific middleware wrappers ────────────────────────────────────
//
// Named guards for the APPOINTMENT and ECOMMERCE verticals. Semantically
// distinct from the generic requireBusinessAdmin/requireStaff so route files
// read as intent ("who can manage appointments?") rather than raw role names.
// Both combine requireAuth + role check in one hop; extend here if a vertical
// later needs additional pre-checks (e.g. vertical-feature-flag, plan gate).

// APPOINTMENT vertical — BUSINESS_ADMIN or SUPER_ADMIN.
// Staff read/write goes through requireStaff; this guard is for
// destructive/config operations that only admins should perform.
function requireAppointmentAdmin(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    return requireAnyRole([ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN])(req, res, next);
  });
}

// ECOMMERCE vertical base guard — any authenticated BUSINESS_ADMIN or SUPER_ADMIN.
// Per-resource permission checks (via requireEcomPermission) layer on top of
// this in individual routes. Staff access to ecom is mediated by EcomRolePermissionGrant
// so this guard is intentionally admin-only.
function requireEcomManager(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    return requireAnyRole([ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN])(req, res, next);
  });
}

module.exports = {
  protect,
  requireAuth,
  requireRole,
  requireSuperAdmin,
  requireBusinessAdmin,
  requireStaff,
  requireCustomer,
  requirePermission,
  requireAnyPermission,
  requireEcomPermission,
  requireAppointmentAdmin,
  requireEcomManager,
  authenticateOperator,
  authenticateCustomer,
  resolveTenantBusinessId,
  ensureDefaultHrRole,
};
