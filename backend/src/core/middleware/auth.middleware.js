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
const { effectivePermissions } = require('../lib/rbac');
const { ROLES } = require('../lib/roles');
const { ensureDefaultEcomStaffRole } = require('../lib/ecomStaffPortal');
const { ensureAppointmentSystemRole, ensureDefaultAppointmentStaffRole } = require('../lib/appointmentStaffPortal');
const { resolveVertical } = require('../lib/vertical');

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
  businessRole: { select: { id: true, name: true, permissions: true, isSystem: true } },
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

  if (host.endsWith(platformSuffix)) {
    const sub = host.slice(0, -platformSuffix.length);
    if (sub && !sub.includes('.')) {
      const biz = await prisma.business.findUnique({ where: { slug: sub }, select: { id: true } });
      return biz?.id || null;
    }
  }

  if (host.endsWith(aapkaSuffix)) {
    const sub = host.slice(0, -aapkaSuffix.length);
    if (sub && !sub.includes('.')) {
      const biz = await prisma.business.findUnique({ where: { slug: sub }, select: { id: true } });
      return biz?.id || null;
    }
  }

  // BYO custom-domain lookup retired 2026-05-10 (Cloudflare orange-cloud +
  // GA decommission). All hosts are now platform subdomains.
  return null;
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
  if (user.role === ROLES.STAFF && user.businessId && user.businessRole?.isSystem && user.businessRole?.name) {
    const refreshedAppointmentRole = await ensureAppointmentSystemRole({
      prisma,
      businessId: user.businessId,
      roleName: user.businessRole.name,
    });
    if (refreshedAppointmentRole) {
      user.businessRole = {
        id: refreshedAppointmentRole.id,
        name: refreshedAppointmentRole.name,
        permissions: refreshedAppointmentRole.permissions || {},
        isSystem: refreshedAppointmentRole.isSystem,
      };
    }
  }
  if (user.role === ROLES.STAFF && user.businessId && !user.businessRoleId) {
    const appointmentRole = await ensureDefaultAppointmentStaffRole({
      prisma,
      businessId: user.businessId,
      userId: user.id,
    });
    if (appointmentRole) {
      user.businessRoleId = appointmentRole.id;
      user.businessRole = {
        id: appointmentRole.id,
        name: appointmentRole.name,
        permissions: appointmentRole.permissions || {},
        isSystem: appointmentRole.isSystem,
      };
      user.isServiceProvider = true;
      return user;
    }

    const ecomRole = await ensureDefaultEcomStaffRole({
      prisma,
      businessId: user.businessId,
      userId: user.id,
    });
    if (ecomRole) {
      user.businessRoleId = ecomRole.id;
      user.businessRole = {
        id: ecomRole.id,
        name: ecomRole.name,
        permissions: {},
        isSystem: ecomRole.isSystem,
      };
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
  requireEcomPermission,
  requireAppointmentAdmin,
  requireEcomManager,
  authenticateOperator,
  authenticateCustomer,
  resolveTenantBusinessId,
};
