'use strict';

const { SYSTEM_ROLES } = require('./rbac');

function isAppointmentBusiness(business) {
  return String(business?.vertical || '').toUpperCase() === 'APPOINTMENT';
}

function roleImpliesServiceProvider(role) {
  const permissions = role?.permissions || SYSTEM_ROLES[role?.name] || {};
  return !!permissions.canReceiveAppointments || String(role?.name || '') === 'Doctor';
}

async function ensureAppointmentSystemRole({ prisma, businessId, roleName = 'Doctor' }) {
  if (!businessId) return null;
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true, vertical: true },
  });
  if (!isAppointmentBusiness(business)) return null;

  const preset = SYSTEM_ROLES[roleName];
  if (!preset) return null;

  return prisma.businessRole.upsert({
    where: { businessId_name: { businessId, name: roleName } },
    update: {
      isSystem: true,
      permissions: preset,
    },
    create: {
      businessId,
      name: roleName,
      isSystem: true,
      permissions: preset,
    },
    select: { id: true, name: true, permissions: true, isSystem: true },
  });
}

async function ensureAppointmentSystemRoles({ prisma, businessId }) {
  const roles = [];
  for (const roleName of Object.keys(SYSTEM_ROLES)) {
    const role = await ensureAppointmentSystemRole({ prisma, businessId, roleName });
    if (role) roles.push(role);
  }
  return roles;
}

async function resolveAppointmentRole({ prisma, businessId, roleId = null, defaultRoleName = 'Doctor' }) {
  if (!businessId) return null;
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true, vertical: true },
  });
  if (!isAppointmentBusiness(business)) return null;

  if (roleId) {
    const role = await prisma.businessRole.findFirst({
      where: { id: roleId, businessId },
      select: { id: true, name: true, permissions: true, isSystem: true },
    });
    if (!role) {
      const err = new Error('Role not found in this business');
      err.statusCode = 400;
      throw err;
    }
    return role;
  }

  return ensureAppointmentSystemRole({ prisma, businessId, roleName: defaultRoleName });
}

async function ensureDefaultAppointmentStaffRole({ prisma, businessId, userId, roleId = null }) {
  if (!businessId || !userId) return null;
  const role = await resolveAppointmentRole({ prisma, businessId, roleId, defaultRoleName: 'Doctor' });
  if (!role) return null;

  await prisma.user.update({
    where: { id: userId },
    data: {
      businessRoleId: role.id,
      isServiceProvider: roleImpliesServiceProvider(role),
    },
  });

  return role;
}

module.exports = {
  ensureAppointmentSystemRole,
  ensureAppointmentSystemRoles,
  ensureDefaultAppointmentStaffRole,
  isAppointmentBusiness,
  roleImpliesServiceProvider,
  resolveAppointmentRole,
};
