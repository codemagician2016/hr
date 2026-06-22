'use strict';
// Asset register + assignment lifecycle. Tenant-scoped by req.user.businessId;
// soft-delete via deletedAt on both Asset and AssetAssignment. The interesting
// domain logic is the assign -> return transition on AssetAssignment:
//   assign  -> creates an OPEN assignment (returnedAt = null) and flips the
//              underlying Asset to ASSIGNED.
//   return  -> stamps returnedAt + the return `condition`, closes the
//              assignment, and flips the Asset back to AVAILABLE.
// An asset can only have one OPEN assignment at a time (enforced here, not just
// by the DB) so the register always reflects who currently holds each item.
const prisma = require('../../core/lib/prisma');

// ── Asset register ───────────────────────────────────────────────────────────
// Allow-list of directly-assignable Asset fields (never trust the body wholesale).
const ASSET_WRITABLE = [
  'assetTag', 'name', 'category', 'serialNumber', 'make', 'model',
  'purchaseDate', 'purchaseCost', 'currencyCode', 'warrantyExpiresAt',
  'condition', 'status', 'notes',
];
const ASSET_DATE_FIELDS = ['purchaseDate', 'warrantyExpiresAt'];
// Money fields are Prisma Decimal — pass through untouched (never parseInt).

function pickAsset(body) {
  const out = {};
  for (const f of ASSET_WRITABLE) if (body[f] !== undefined) out[f] = body[f];
  for (const d of ASSET_DATE_FIELDS) if (out[d] != null) out[d] = new Date(out[d]);
  return out;
}

async function listAssets(req, res, next) {
  try {
    const { businessId } = req.user;
    const { status, category, q, page = '1', pageSize = '25' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const where = { businessId, deletedAt: null };
    if (status) where.status = status;
    if (category) where.category = category;
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { assetTag: { contains: q, mode: 'insensitive' } },
        { serialNumber: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.asset.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.asset.count({ where }),
    ]);
    res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take });
  } catch (e) { next(e); }
}

async function getAsset(req, res, next) {
  try {
    const { businessId } = req.user;
    const asset = await prisma.asset.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: {
        assetAssignments: {
          where: { deletedAt: null },
          orderBy: { assignedAt: 'desc' },
          include: { employee: { select: { id: true, code: true, firstName: true, lastName: true } } },
        },
      },
    });
    if (!asset) return res.status(404).json({ message: 'Asset not found' });
    res.json(asset);
  } catch (e) { next(e); }
}

async function createAsset(req, res, next) {
  try {
    const { businessId } = req.user;
    const { assetTag, name } = req.body;
    if (!assetTag || !name) {
      return res.status(400).json({ message: 'assetTag and name are required' });
    }
    const data = { ...pickAsset(req.body), businessId };
    if (data.status === undefined) data.status = 'AVAILABLE';
    const asset = await prisma.asset.create({ data });
    res.status(201).json(asset);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'An asset with that tag already exists' });
    next(e);
  }
}

async function updateAsset(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.asset.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Asset not found' });
    const asset = await prisma.asset.update({ where: { id: req.params.id }, data: pickAsset(req.body) });
    res.json(asset);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'An asset with that tag already exists' });
    next(e);
  }
}

async function removeAsset(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.asset.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'Asset not found' });
    // Block deleting an asset that is still out with an employee.
    const open = await prisma.assetAssignment.findFirst({
      where: { assetId: req.params.id, businessId, returnedAt: null, deletedAt: null },
    });
    if (open) return res.status(409).json({ message: 'Asset is currently assigned; return it before deleting' });
    await prisma.asset.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// ── Assignment lifecycle ─────────────────────────────────────────────────────
const ASSIGNMENT_INCLUDE = {
  asset: { select: { id: true, assetTag: true, name: true, category: true, status: true } },
  employee: { select: { id: true, code: true, firstName: true, lastName: true } },
};

// List assignments. Filterable by employeeId, assetId, and `open` (open=true ->
// only currently-held assets, i.e. returnedAt is null).
async function listAssignments(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, assetId, open, page = '1', pageSize = '25' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const where = { businessId, deletedAt: null };
    if (employeeId) where.employeeId = employeeId;
    if (assetId) where.assetId = assetId;
    if (open === 'true') where.returnedAt = null;
    else if (open === 'false') where.returnedAt = { not: null };

    const [items, total] = await Promise.all([
      prisma.assetAssignment.findMany({
        where, include: ASSIGNMENT_INCLUDE, orderBy: { assignedAt: 'desc' }, skip, take,
      }),
      prisma.assetAssignment.count({ where }),
    ]);
    res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take });
  } catch (e) { next(e); }
}

async function getAssignment(req, res, next) {
  try {
    const { businessId } = req.user;
    const item = await prisma.assetAssignment.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: ASSIGNMENT_INCLUDE,
    });
    if (!item) return res.status(404).json({ message: 'Assignment not found' });
    res.json(item);
  } catch (e) { next(e); }
}

// Assign an asset to an employee. Validates that both belong to the tenant, the
// asset is not soft-deleted, and the asset is not already out on another open
// assignment. Creates the OPEN assignment and flips the Asset to ASSIGNED in one
// transaction so the register can never drift from the assignment ledger.
async function assign(req, res, next) {
  try {
    const { businessId } = req.user;
    const { assetId, employeeId } = req.body;
    if (!assetId || !employeeId) {
      return res.status(400).json({ message: 'assetId and employeeId are required' });
    }

    const asset = await prisma.asset.findFirst({ where: { id: assetId, businessId, deletedAt: null } });
    if (!asset) return res.status(404).json({ message: 'Asset not found' });

    const employee = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null } });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const openExisting = await prisma.assetAssignment.findFirst({
      where: { assetId, businessId, returnedAt: null, deletedAt: null },
    });
    if (openExisting) {
      return res.status(409).json({ message: 'Asset is already assigned; return it before reassigning' });
    }

    const data = {
      businessId,
      assetId,
      employeeId,
      assignedAt: req.body.assignedAt ? new Date(req.body.assignedAt) : new Date(),
      conditionOut: req.body.conditionOut !== undefined ? req.body.conditionOut : undefined,
      notes: req.body.notes !== undefined ? req.body.notes : undefined,
      status: 'ASSIGNED',
    };
    for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];

    const [assignment] = await prisma.$transaction([
      prisma.assetAssignment.create({ data, include: ASSIGNMENT_INCLUDE }),
      prisma.asset.update({ where: { id: assetId }, data: { status: 'ASSIGNED' } }),
    ]);
    res.status(201).json(assignment);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'Asset is already assigned' });
    next(e);
  }
}

// Return an asset: stamp returnedAt + the return `condition`, close the
// assignment, and flip the Asset back to AVAILABLE. Idempotency guard — a
// already-returned assignment yields 409 rather than silently re-closing.
async function returnAsset(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.assetAssignment.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ message: 'Assignment not found' });
    if (existing.returnedAt) {
      return res.status(409).json({ message: 'Assignment has already been returned' });
    }

    const returnedAt = req.body.returnedAt ? new Date(req.body.returnedAt) : new Date();
    const data = { returnedAt, status: 'RETURNED' };
    if (req.body.condition !== undefined) data.condition = req.body.condition;
    if (req.body.notes !== undefined) data.notes = req.body.notes;

    const [assignment] = await prisma.$transaction([
      prisma.assetAssignment.update({ where: { id: existing.id }, data, include: ASSIGNMENT_INCLUDE }),
      prisma.asset.update({ where: { id: existing.assetId }, data: { status: 'AVAILABLE' } }),
    ]);
    res.json(assignment);
  } catch (e) { next(e); }
}

module.exports = {
  listAssets, getAsset, createAsset, updateAsset, removeAsset,
  listAssignments, getAssignment, assign, returnAsset,
};
