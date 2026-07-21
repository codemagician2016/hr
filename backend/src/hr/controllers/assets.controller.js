'use strict';
// Asset register + assignment lifecycle. Tenant-scoped by req.user.businessId;
// soft-delete via deletedAt on Asset (AssetAssignment is NOT soft-deleted — it
// has no deletedAt column; its lifecycle is the returnedAt stamp). The interesting
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
// Allow-listed against the REAL Asset schema (schema.prisma L8357): the human
// code is `code` (NOT `assetTag`), warranty is `warrantyExpiry`, and there are
// no make/model columns. Writing unknown fields makes Prisma throw at runtime.
const ASSET_WRITABLE = [
  'code', 'name', 'category', 'serialNumber',
  'purchaseDate', 'purchaseCost', 'currencyCode', 'warrantyExpiry',
  'condition', 'status',
];
const ASSET_DATE_FIELDS = ['purchaseDate', 'warrantyExpiry'];
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
        { code: { contains: q, mode: 'insensitive' } },
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
        // The relation is `assignments` (schema L8376); AssetAssignment has no
        // soft-delete column, so no deletedAt filter here.
        assignments: {
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
    const { code, name } = req.body;
    if (!code || !name) {
      return res.status(400).json({ message: 'code and name are required' });
    }
    const data = { ...pickAsset(req.body), businessId };
    if (data.status === undefined) data.status = 'AVAILABLE';
    const asset = await prisma.asset.create({ data });
    res.status(201).json(asset);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'An asset with that code already exists' });
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
    if (e.code === 'P2002') return res.status(409).json({ message: 'An asset with that code already exists' });
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
      where: { assetId: req.params.id, businessId, returnedAt: null },
    });
    if (open) return res.status(409).json({ message: 'Asset is currently assigned; return it before deleting' });
    await prisma.asset.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// ── Assignment lifecycle ─────────────────────────────────────────────────────
const ASSIGNMENT_INCLUDE = {
  asset: { select: { id: true, code: true, name: true, category: true, status: true } },
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

    // AssetAssignment has no soft-delete column — do NOT filter deletedAt here.
    const where = { businessId };
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
      where: { id: req.params.id, businessId },
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
      where: { assetId, businessId, returnedAt: null },
    });
    if (openExisting) {
      return res.status(409).json({ message: 'Asset is already assigned; return it before reassigning' });
    }

    // Program Phase 2 — the hand-over rides the approval engine. The ASSET
    // consumer CREATES the assignment on approval; the built-in AUTO_APPROVE
    // default terminalizes inside this same tx (identical to the old direct
    // create), while a tenant-authored chain leaves it pending (202).
    const engine = require('../approvals/engine');
    require('../approvals/consumers.asset');
    const result = await prisma.$transaction(async (tx) => {
      const rec = await tx.employmentRecord.findFirst({
        where: { businessId, employeeId, isCurrent: true },
        orderBy: { effectiveFrom: 'desc' },
        select: { departmentId: true, gradeId: true, locationId: true },
      });
      const opened = await engine.openRequest({
        businessId,
        module: 'ASSET',
        entityType: 'Asset',
        entityId: assetId,
        requesterEmployeeId: employeeId,
        payload: {
          assignment: {
            assetId,
            employeeId,
            assignedAt: req.body.assignedAt || null,
            conditionOut: req.body.conditionOut !== undefined ? req.body.conditionOut : null,
            notes: req.body.notes !== undefined ? req.body.notes : null,
          },
          assetName: asset.name || asset.assetTag || null,
        },
        ctx: {
          entityId: assetId,
          departmentId: rec ? rec.departmentId : null,
          employeeLevel: rec ? rec.gradeId : null,
          locationId: rec ? rec.locationId : null,
        },
      }, tx);
      if (opened.terminal && opened.approvalRequest.status === 'APPROVED') {
        const assignment = await tx.assetAssignment.findFirst({
          where: { assetId, businessId, returnedAt: null },
          include: ASSIGNMENT_INCLUDE,
          orderBy: { assignedAt: 'desc' },
        });
        return { assignment };
      }
      return { pending: opened.approvalRequest };
    });
    if (result.assignment) return res.status(201).json(result.assignment);
    return res.status(202).json({
      pendingApproval: true,
      approvalRequestId: result.pending.id,
      message: 'Assignment awaits approval per your ASSET workflow.',
    });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'Asset is already assigned' });
    next(e);
  }
}

// Return an asset: stamp returnedAt + the return condition (the schema field is
// `conditionIn`, NOT `condition` — writing the latter makes Prisma throw), close
// the assignment, and update the Asset register. The assignment status, the asset
// status and the recovery seam are kept CONSISTENT with the physical outcome:
//
//   outcome            AssetAssignment.status   Asset.status   recovery
//   ────────────────   ──────────────────────   ────────────   ────────
//   lost (lost=true)   LOST                     LOST           yes (if amount)
//   damaged            DAMAGED                  IN_REPAIR      yes (if amount)
//   retired (EOL)      RETURNED / PENDING_REC   RETIRED        optional
//   clean return       RETURNED                 AVAILABLE      no
//
// A non-zero recoveryAmount on an otherwise-clean return parks the assignment at
// PENDING_RECOVERY (the FnF `assetRecoveryAmount` deduction, Feature 4 §4.3, reads
// it). Idempotency guard: an already-returned assignment yields 409.
//
// Enum values are validated against the real schema (AssetAssignmentStatus /
// AssetStatus / AssetCondition) so a bad input is a 422, never a Prisma 500.
const ASSET_CONDITIONS = new Set(['NEW', 'GOOD', 'FAIR', 'DAMAGED', 'RETIRED']);
async function returnAsset(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.assetAssignment.findFirst({
      where: { id: req.params.id, businessId },
    });
    if (!existing) return res.status(404).json({ message: 'Assignment not found' });
    if (existing.returnedAt) {
      return res.status(409).json({ message: 'Assignment has already been returned' });
    }

    const returnedAt = req.body.returnedAt ? new Date(req.body.returnedAt) : new Date();
    const conditionIn = req.body.conditionIn !== undefined ? req.body.conditionIn : undefined;
    if (conditionIn !== undefined && !ASSET_CONDITIONS.has(conditionIn)) {
      return res.status(422).json({ message: `Invalid return condition: ${conditionIn}` });
    }
    const lost = req.body.lost === true;
    const hasRecovery = req.body.recoveryAmount !== undefined
      && req.body.recoveryAmount !== null
      && Number(req.body.recoveryAmount) > 0;

    // Resolve the consistent (assignment status, asset status) pair from the
    // physical outcome — lost/damaged take precedence, then retired, then a clean
    // return (which parks at PENDING_RECOVERY only when money is owed).
    let assignmentStatus;
    let assetStatus;
    if (lost) {
      assignmentStatus = 'LOST';
      assetStatus = 'LOST';
    } else if (conditionIn === 'DAMAGED') {
      assignmentStatus = 'DAMAGED';
      assetStatus = 'IN_REPAIR';
    } else if (conditionIn === 'RETIRED') {
      // End-of-life: the asset is retired; the assignment closes as RETURNED
      // (or PENDING_RECOVERY when a recovery amount is owed for it).
      assignmentStatus = hasRecovery ? 'PENDING_RECOVERY' : 'RETURNED';
      assetStatus = 'RETIRED';
    } else {
      // Clean return — but if a recovery amount is owed, park for FnF recovery.
      assignmentStatus = hasRecovery ? 'PENDING_RECOVERY' : 'RETURNED';
      assetStatus = 'AVAILABLE';
    }

    const data = { returnedAt, status: assignmentStatus };
    if (conditionIn !== undefined) data.conditionIn = conditionIn;
    if (req.body.notes !== undefined) data.notes = req.body.notes;
    if (req.body.recoveryAmount !== undefined) data.recoveryAmount = req.body.recoveryAmount;

    const [assignment] = await prisma.$transaction([
      prisma.assetAssignment.update({ where: { id: existing.id }, data, include: ASSIGNMENT_INCLUDE }),
      prisma.asset.update({
        where: { id: existing.assetId },
        data: {
          status: assetStatus,
          // Mirror the return condition onto the asset register when a concrete
          // condition was recorded (DAMAGED/RETIRED/FAIR/GOOD/NEW).
          ...(conditionIn ? { condition: conditionIn } : {}),
        },
      }),
    ]);
    res.json(assignment);
  } catch (e) { next(e); }
}

module.exports = {
  listAssets, getAsset, createAsset, updateAsset, removeAsset,
  listAssignments, getAssignment, assign, returnAsset,
};
