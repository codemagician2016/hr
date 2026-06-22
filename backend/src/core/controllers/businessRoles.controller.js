'use strict';
const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');
const { PERMISSIONS, SYSTEM_ROLES, validatePermissions } = require('../lib/rbac');
const { writeAudit } = require('../lib/audit');

const prisma = new PrismaClient();
async function bizId(req) { return req.user?.businessId || null; }

async function listPermissions(req, res) {
  res.json({ permissions: PERMISSIONS, systemRoles: SYSTEM_ROLES });
}

async function listRoles(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const roles = await prisma.businessRole.findMany({
    where: { businessId }, orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
  });
  res.json({ roles });
}

const schema = z.object({
  name: z.string().min(1).max(60),
  permissions: z.record(z.string(), z.boolean()).default({}),
});

async function createRole(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid', issues: parsed.error.issues });
  const v = validatePermissions(parsed.data.permissions);
  if (!v.ok) return res.status(400).json({ message: v.error });
  try {
    const role = await prisma.businessRole.create({ data: { businessId, ...parsed.data } });
    await writeAudit({
      businessId,
      actorId: req.user?.id,
      action: 'role.change',
      entityType: 'BusinessRole',
      entityId: role.id,
      meta: { op: 'create', name: role.name, permissions: parsed.data.permissions },
    });
    res.status(201).json(role);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ message: 'Role name already exists' });
    throw err;
  }
}

async function updateRole(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const parsed = schema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid', issues: parsed.error.issues });
  if (parsed.data.permissions) {
    const v = validatePermissions(parsed.data.permissions);
    if (!v.ok) return res.status(400).json({ message: v.error });
  }
  const existing = await prisma.businessRole.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.businessId !== businessId) return res.status(404).json({ message: 'Not found' });
  if (existing.isSystem && parsed.data.name && parsed.data.name !== existing.name) {
    return res.status(400).json({ message: 'Cannot rename system role' });
  }
  const role = await prisma.businessRole.update({ where: { id: req.params.id }, data: parsed.data });
  await writeAudit({
    businessId,
    actorId: req.user?.id,
    action: 'role.change',
    entityType: 'BusinessRole',
    entityId: role.id,
    meta: {
      op: 'update',
      name: role.name,
      before: { name: existing.name, permissions: existing.permissions },
      after: parsed.data,
    },
  });
  res.json(role);
}

async function deleteRole(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const existing = await prisma.businessRole.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.businessId !== businessId) return res.status(404).json({ message: 'Not found' });
  if (existing.isSystem) return res.status(400).json({ message: 'Cannot delete system role' });
  await prisma.businessRole.delete({ where: { id: req.params.id } });
  await writeAudit({
    businessId,
    actorId: req.user?.id,
    action: 'role.change',
    entityType: 'BusinessRole',
    entityId: existing.id,
    meta: { op: 'delete', name: existing.name },
  });
  res.json({ ok: true });
}

// POST /seed-system-roles — idempotent seeding for a tenant. Called once
// when admin first opens the RBAC tab; tenants auto-get the HR system-role
// presets (Owner / HR-Admin / Finance / Manager). Same upsert as
// ensureDefaultHrRole, exposed as an explicit admin action.
async function seedSystemRoles(req, res) {
  const businessId = await bizId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  let n = 0;
  let updated = 0;
  for (const [name, perms] of Object.entries(SYSTEM_ROLES)) {
    const existing = await prisma.businessRole.findUnique({ where: { businessId_name: { businessId, name } } });
    if (existing) {
      await prisma.businessRole.update({
        where: { id: existing.id },
        data: { permissions: perms, isSystem: true },
      });
      updated++;
    } else {
      await prisma.businessRole.create({
        data: { businessId, name, permissions: perms, isSystem: true },
      });
      n++;
    }
  }
  res.json({ ok: true, created: n, updated });
}

module.exports = { listPermissions, listRoles, createRole, updateRole, deleteRole, seedSystemRoles };
