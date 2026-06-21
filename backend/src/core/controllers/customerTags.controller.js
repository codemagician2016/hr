// CRM tags + segments controller. BUSINESS_ADMIN scope.
'use strict';

const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');
const prisma = new PrismaClient();

async function resolveBusinessId(req) { return req.user?.businessId || null; }

// ─── TAGS ────────────────────────────────────────────────────────────────────
async function listTags(req, res) {
  const businessId = await resolveBusinessId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const tags = await prisma.customerTag.findMany({
    where: { businessId },
    include: { _count: { select: { assignments: true } } },
    orderBy: { name: 'asc' },
  });
  res.json({ tags });
}

const tagSchema = z.object({
  name: z.string().min(1).max(60),
  color: z.union([z.string().regex(/^#[0-9a-fA-F]{6}$/), z.null()]).optional(),
});

async function createTag(req, res) {
  const businessId = await resolveBusinessId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const parsed = tagSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid', issues: parsed.error.issues });
  try {
    const tag = await prisma.customerTag.create({
      data: { businessId, name: parsed.data.name, color: parsed.data.color || null },
    });
    res.status(201).json(tag);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ message: 'Tag name already exists' });
    throw err;
  }
}

async function updateTag(req, res) {
  const businessId = await resolveBusinessId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const parsed = tagSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid', issues: parsed.error.issues });
  const existing = await prisma.customerTag.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.businessId !== businessId) return res.status(404).json({ message: 'Not found' });
  const tag = await prisma.customerTag.update({ where: { id: req.params.id }, data: parsed.data });
  res.json(tag);
}

async function deleteTag(req, res) {
  const businessId = await resolveBusinessId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const existing = await prisma.customerTag.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.businessId !== businessId) return res.status(404).json({ message: 'Not found' });
  await prisma.customerTag.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
}

// ─── ASSIGNMENTS ─────────────────────────────────────────────────────────────
const assignSchema = z.object({
  customerIds: z.array(z.string()).min(1),
  tagId: z.string().min(1),
  action: z.enum(['add', 'remove']),
});

async function bulkAssign(req, res) {
  const businessId = await resolveBusinessId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid', issues: parsed.error.issues });

  const tag = await prisma.customerTag.findUnique({ where: { id: parsed.data.tagId } });
  if (!tag || tag.businessId !== businessId) return res.status(404).json({ message: 'Tag not found' });

  // Verify all customers belong to this business
  const customers = await prisma.customer.findMany({
    where: { id: { in: parsed.data.customerIds }, businessId },
    select: { id: true },
  });
  const validIds = customers.map((c) => c.id);
  if (!validIds.length) return res.status(400).json({ message: 'No matching customers' });

  if (parsed.data.action === 'add') {
    const data = validIds.map((id) => ({ customerId: id, tagId: tag.id }));
    await prisma.customerTagAssignment.createMany({ data, skipDuplicates: true });
  } else {
    await prisma.customerTagAssignment.deleteMany({
      where: { customerId: { in: validIds }, tagId: tag.id },
    });
  }
  res.json({ ok: true, affected: validIds.length });
}

// ─── SEGMENTS ────────────────────────────────────────────────────────────────
const segmentSchema = z.object({
  name: z.string().min(1).max(100),
  filter: z.record(z.string(), z.any()).default({}),
});

async function listSegments(req, res) {
  const businessId = await resolveBusinessId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const segments = await prisma.customerSegment.findMany({
    where: { businessId }, orderBy: { name: 'asc' },
  });
  res.json({ segments });
}

async function createSegment(req, res) {
  const businessId = await resolveBusinessId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const parsed = segmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid', issues: parsed.error.issues });
  const seg = await prisma.customerSegment.create({
    data: { businessId, name: parsed.data.name, filter: parsed.data.filter },
  });
  res.status(201).json(seg);
}

async function updateSegment(req, res) {
  const businessId = await resolveBusinessId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const parsed = segmentSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid', issues: parsed.error.issues });
  const existing = await prisma.customerSegment.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.businessId !== businessId) return res.status(404).json({ message: 'Not found' });
  const seg = await prisma.customerSegment.update({ where: { id: req.params.id }, data: parsed.data });
  res.json(seg);
}

async function deleteSegment(req, res) {
  const businessId = await resolveBusinessId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const existing = await prisma.customerSegment.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.businessId !== businessId) return res.status(404).json({ message: 'Not found' });
  await prisma.customerSegment.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
}

// Execute a segment filter — returns matching customer IDs.
// Filter shape: { tagIds: [], hasUpcoming: bool, lastVisitDaysAgo: {gte,lte}, hasEmail: bool, hasPhone: bool }
async function evaluateSegment({ businessId, filter = {} }) {
  const where = { businessId };
  if (filter.hasEmail === true)  where.email = { not: '' };
  if (filter.hasPhone === true)  where.phone = { not: null };
  if (Array.isArray(filter.tagIds) && filter.tagIds.length) {
    where.tagAssignments = { some: { tagId: { in: filter.tagIds } } };
  }
  if (filter.lastVisitDaysAgo?.gte != null || filter.lastVisitDaysAgo?.lte != null) {
    const lo = filter.lastVisitDaysAgo.lte != null
      ? new Date(Date.now() - filter.lastVisitDaysAgo.lte * 86400 * 1000) : null;
    const hi = filter.lastVisitDaysAgo.gte != null
      ? new Date(Date.now() - filter.lastVisitDaysAgo.gte * 86400 * 1000) : null;
    where.appointments = {
      some: {
        status: 'COMPLETED',
        ...(lo && { startTime: { gte: lo } }),
        ...(hi && { startTime: { lte: hi } }),
      },
    };
  }
  return prisma.customer.findMany({
    where, select: { id: true, name: true, email: true, phone: true },
    take: 1000,
  });
}

async function previewSegment(req, res) {
  const businessId = await resolveBusinessId(req);
  if (!businessId) return res.status(403).json({ message: 'No business in scope' });
  const filter = req.body?.filter || {};
  const customers = await evaluateSegment({ businessId, filter });
  res.json({ count: customers.length, customers: customers.slice(0, 100) });
}

module.exports = {
  listTags, createTag, updateTag, deleteTag,
  bulkAssign,
  listSegments, createSegment, updateSegment, deleteSegment, previewSegment,
  evaluateSegment,
};
