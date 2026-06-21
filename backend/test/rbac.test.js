// Effective-permissions resolver + requirePermission middleware unit tests.

const { effectivePermissions, LEGACY_ROLE_PERMS, SYSTEM_ROLES } = require('../src/core/lib/rbac');
const { roleImpliesServiceProvider } = require('../src/core/lib/appointmentStaffPortal');
const {
  requirePermission,
  requireSuperAdmin,
  requireBusinessAdmin,
  requireStaff,
} = require('../src/core/middleware/auth.middleware');

describe('effectivePermissions', () => {
  test('SUPER_ADMIN with no businessRole gets every permission', () => {
    const perms = effectivePermissions({ role: 'SUPER_ADMIN' });
    expect(perms.canManageStaff).toBe(true);
    expect(perms.canEditBilling).toBe(true);
  });

  test('BUSINESS_ADMIN with no businessRole gets the Owner preset (all true)', () => {
    const perms = effectivePermissions({ role: 'BUSINESS_ADMIN' });
    expect(perms.canManageProducts).toBe(true);
    expect(perms.canManageMarketing).toBe(true);
  });

  test('STAFF with no businessRole inherits the Doctor/provider preset', () => {
    const perms = effectivePermissions({ role: 'STAFF' });
    expect(perms.canViewOwnAppointments).toBe(true);
    expect(perms.canManageOwnAppointments).toBe(true);
    expect(perms.canManageCustomers).toBeFalsy();
    expect(perms.canEditServices).toBeFalsy();
    expect(perms.canEditBilling).toBeFalsy();
  });

  test('USER role gets nothing', () => {
    const perms = effectivePermissions({ role: 'USER' });
    expect(perms.canManageProducts).toBeFalsy();
    expect(Object.values(perms || {}).some(Boolean)).toBe(false);
  });

  test('custom businessRole overrides the legacy fallback', () => {
    const user = {
      role: 'BUSINESS_ADMIN', // would normally grant everything
      businessRole: { permissions: { canEditServices: false, canManageMarketing: true } },
    };
    const perms = effectivePermissions(user);
    expect(perms.canEditServices).toBe(false); // explicitly revoked
    expect(perms.canManageMarketing).toBe(true);
    // keys NOT in the custom role aren't auto-true
    expect(perms.canManageProducts).toBeUndefined();
  });

  test('legacy presets cover every PERMISSIONS key for Owner', () => {
    const owner = LEGACY_ROLE_PERMS.SUPER_ADMIN;
    expect(Object.values(owner).every(Boolean)).toBe(true);
  });
});

describe('appointment role presets', () => {
  test('Doctor is bookable and clinical, FrontDesk is desk/payment only', () => {
    expect(SYSTEM_ROLES.Doctor.canReceiveAppointments).toBe(true);
    expect(SYSTEM_ROLES.Doctor.canWriteClinicalDocuments).toBe(true);
    expect(SYSTEM_ROLES.FrontDesk.canManageWalkIns).toBe(true);
    expect(SYSTEM_ROLES.FrontDesk.canRecordPayments).toBe(true);
    expect(SYSTEM_ROLES.FrontDesk.canWriteClinicalDocuments).toBeFalsy();
  });

  test('service-provider default follows appointment role intent', () => {
    expect(roleImpliesServiceProvider({ name: 'Doctor', permissions: SYSTEM_ROLES.Doctor })).toBe(true);
    expect(roleImpliesServiceProvider({ name: 'FrontDesk', permissions: SYSTEM_ROLES.FrontDesk })).toBe(false);
  });
});

describe('requirePermission middleware', () => {
  function fakeRes() {
    return {
      statusCode: 200,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
  }

  test('401 when no user is attached', () => {
    const mw = requirePermission('canEditServices');
    const req = {};
    const res = fakeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  test('SUPER_ADMIN bypasses every permission check', () => {
    const mw = requirePermission('canEditBilling');
    const req = { user: { role: 'SUPER_ADMIN' } };
    const res = fakeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  test('BUSINESS_ADMIN with no custom role passes (legacy fallback)', () => {
    const mw = requirePermission('canManageProducts');
    const req = { user: { role: 'BUSINESS_ADMIN' } };
    const res = fakeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  test('BUSINESS_ADMIN with a custom role that revokes the perm gets 403', () => {
    const mw = requirePermission('canEditServices');
    const req = {
      user: {
        role: 'BUSINESS_ADMIN',
        businessRole: { permissions: { canEditServices: false } },
      },
    };
    const res = fakeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.missingPermission).toBe('canEditServices');
  });

  test('STAFF with the Manager preset can edit services', () => {
    const mw = requirePermission('canEditServices');
    const req = {
      user: { role: 'STAFF', businessRole: { permissions: SYSTEM_ROLES.Manager } },
    };
    const res = fakeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
});

describe('named role middleware', () => {
  function fakeRes() {
    return {
      statusCode: 200,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
  }

  function run(mw, role) {
    const req = role ? { user: { role } } : {};
    const res = fakeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    return { res, nextCalled };
  }

  test('requireSuperAdmin only allows SUPER_ADMIN', () => {
    expect(run(requireSuperAdmin, 'SUPER_ADMIN').nextCalled).toBe(true);
    expect(run(requireSuperAdmin, 'BUSINESS_ADMIN').res.statusCode).toBe(403);
  });

  test('requireBusinessAdmin allows BUSINESS_ADMIN and SUPER_ADMIN only', () => {
    expect(run(requireBusinessAdmin, 'SUPER_ADMIN').nextCalled).toBe(true);
    expect(run(requireBusinessAdmin, 'BUSINESS_ADMIN').nextCalled).toBe(true);
    expect(run(requireBusinessAdmin, 'STAFF').res.statusCode).toBe(403);
  });

  test('requireStaff allows STAFF, BUSINESS_ADMIN, and SUPER_ADMIN', () => {
    expect(run(requireStaff, 'SUPER_ADMIN').nextCalled).toBe(true);
    expect(run(requireStaff, 'BUSINESS_ADMIN').nextCalled).toBe(true);
    expect(run(requireStaff, 'STAFF').nextCalled).toBe(true);
    expect(run(requireStaff, 'USER').res.statusCode).toBe(403);
  });
});
