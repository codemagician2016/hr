'use strict';

const { ECOM_PERMISSIONS, ECOM_SYSTEM_ROLES } = require('./ecomPermissionCatalog');

function isEcommerceBusiness(business) {
  return String(business?.vertical || '').toUpperCase() === 'ECOMMERCE';
}

function staffPortalPathForBusiness(business) {
  const slug = business?.slug;
  if (!slug) return '/business';
  return isEcommerceBusiness(business) ? `/${slug}/staff/manager` : `/${slug}/staff`;
}

function staffPortalUrlForBusiness(business, platformBaseUrl) {
  return `${String(platformBaseUrl || '').replace(/\/$/, '')}${staffPortalPathForBusiness(business)}`;
}

async function ensureEcomPermissionCatalog(prisma) {
  for (const perm of ECOM_PERMISSIONS) {
    await prisma.ecomPermission.upsert({
      where: { key: perm.key },
      update: {
        area: perm.area,
        label: perm.label,
        description: perm.description || null,
        weight: perm.weight,
      },
      create: {
        key: perm.key,
        area: perm.area,
        label: perm.label,
        description: perm.description || null,
        weight: perm.weight,
      },
    });
  }
}

async function ensureEcomSystemRole({ prisma, businessId, roleName = 'Manager' }) {
  if (!businessId) return null;
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true, vertical: true },
  });
  if (!isEcommerceBusiness(business)) return null;

  const preset = ECOM_SYSTEM_ROLES[roleName];
  if (!preset) return null;

  const role = await prisma.businessRole.upsert({
    where: { businessId_name: { businessId, name: roleName } },
    update: { isSystem: true },
    create: {
      businessId,
      name: roleName,
      isSystem: true,
      permissions: {},
    },
    select: { id: true, name: true, isSystem: true },
  });

  await ensureEcomPermissionCatalog(prisma);

  const grantKeys = preset === '*' ? ECOM_PERMISSIONS.map((perm) => perm.key) : preset;
  const permissions = await prisma.ecomPermission.findMany({
    where: { key: { in: grantKeys } },
    select: { id: true, key: true },
  });

  const existingGrants = await prisma.ecomRolePermissionGrant.findMany({
    where: { roleId: role.id, locationId: null },
    select: { permission: { select: { key: true } } },
  });
  const existingKeys = new Set(existingGrants.map((grant) => grant.permission.key));
  const targetKeys = new Set(grantKeys);
  const grantsAlreadySynced =
    existingKeys.size === targetKeys.size &&
    [...targetKeys].every((key) => existingKeys.has(key));

  if (grantsAlreadySynced) return role;

  await prisma.$transaction([
    prisma.ecomRolePermissionGrant.deleteMany({ where: { roleId: role.id } }),
    ...(permissions.length ? [
      prisma.ecomRolePermissionGrant.createMany({
        data: permissions.map((permission) => ({
          businessId,
          roleId: role.id,
          permissionId: permission.id,
          locationId: null,
        })),
        skipDuplicates: true,
      }),
    ] : []),
  ]);

  return role;
}

async function ensureEcomSystemRoles({ prisma, businessId }) {
  const roles = [];
  for (const roleName of Object.keys(ECOM_SYSTEM_ROLES)) {
    const role = await ensureEcomSystemRole({ prisma, businessId, roleName });
    if (role) roles.push(role);
  }
  return roles;
}

async function ensureDefaultEcomStaffRole({ prisma, businessId, userId, roleId = null }) {
  if (!businessId || !userId) return null;

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true, vertical: true },
  });
  if (!isEcommerceBusiness(business)) return null;

  let role = null;
  if (roleId) {
    role = await prisma.businessRole.findFirst({
      where: { id: roleId, businessId },
      select: { id: true, name: true, isSystem: true },
    });
    if (!role) {
      const err = new Error('Role not found in this business');
      err.statusCode = 400;
      throw err;
    }
  } else {
    role = await ensureEcomSystemRole({ prisma, businessId, roleName: 'Manager' });
  }

  await prisma.user.update({
    where: { id: userId },
    data: { businessRoleId: role.id },
  });

  return role;
}

module.exports = {
  ensureDefaultEcomStaffRole,
  ensureEcomSystemRole,
  ensureEcomSystemRoles,
  isEcommerceBusiness,
  staffPortalPathForBusiness,
  staffPortalUrlForBusiness,
};
