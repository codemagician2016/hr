'use strict';

/**
 * redemption.service.js — Feature 35 §4.5. Catalog + redemption (spend points).
 *
 * Debit timing (spec §8): v1 debits ON APPROVAL, not on submit — a rejected or
 * cancelled redemption never moved points. The approve core (approveRedemptionTx)
 * re-checks the balance IN-TX via pointsLedger.debit's fail-close + version lock, so
 * two concurrent redemptions can never overspend; the stock decrement is guarded
 * (updateMany where stock > 0). Shared by the REDEMPTION consumer's onApprove and
 * the config-gated auto-approve (no-engine) path.
 *
 * Fulfilment: MANUAL / VOUCHER_CODE stamp fulfilmentRef; COMP_OFF_GRANT best-effort
 * mints an F30 HR_GRANT comp-off credit (finalizeCredit) — fail-soft with a note.
 */

const prismaDefault = require('../../core/lib/prisma');
const engine = require('../approvals/engine');
const pointsLedger = require('./pointsLedger');
const { getConfig } = require('./config');
const { notifyHrEvent } = require('../integrations/notifications');

function emailOf(emp) { return emp ? (emp.workEmail || emp.personalEmail || null) : null; }

// ── PURE helpers (unit-tested, no DB) ────────────────────────────────────────
/** India FY window (Apr 1 → next Apr 1) containing `now` — the ₹5k perquisite year. */
function fyWindow(now = new Date()) {
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return { start: new Date(y, 3, 1), end: new Date(y + 1, 3, 1), label: `${y}-${String((y + 1) % 100).padStart(2, '0')}` };
}

const TAXABLE_PERQUISITE_LIMIT_INR = 5000; // gifts rule, Section 17(2) (spec §1)

/**
 * PURE — aggregate redeemed ₹ per employee and flag who crossed the ₹5,000/yr
 * perquisite line. rows: [{ employeeId, inrValue }] (already FY-filtered).
 */
function aggregateTaxablePerks(rows, limit = TAXABLE_PERQUISITE_LIMIT_INR) {
  const byEmp = new Map();
  for (const r of rows || []) {
    if (!r || !r.employeeId) continue;
    const v = Number(r.inrValue) || 0;
    if (v <= 0) continue;
    byEmp.set(r.employeeId, (byEmp.get(r.employeeId) || 0) + v);
  }
  return [...byEmp.entries()]
    .map(([employeeId, totalInr]) => ({ employeeId, totalInr, crossesLimit: totalInr > limit }))
    .sort((a, b) => b.totalInr - a.totalInr);
}

// ── ESS: browse + redeem + track + cancel ────────────────────────────────────
async function listCatalog({ businessId, employeeId }) {
  const config = await getConfig(businessId);
  if (!config.pointsEnabled) return { pointsEnabled: false, items: [], balance: 0 };
  const [items, wallet] = await Promise.all([
    prismaDefault.catalogItem.findMany({
      where: { businessId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    prismaDefault.pointsWallet.findFirst({ where: { businessId, employeeId } }),
  ]);
  const balance = wallet ? wallet.balance : 0;
  return {
    pointsEnabled: true,
    inrPerPoint: config.inrPerPoint,
    balance,
    items: items.map((i) => ({
      id: i.id,
      name: i.name,
      description: i.description,
      category: i.category,
      pointsCost: i.pointsCost,
      inrValue: i.inrValue,
      inStock: i.stock == null || i.stock > 0,
      imageUrl: i.imageUrl,
      affordable: balance >= i.pointsCost,
    })),
  };
}

/**
 * redeem({ businessId, employee, catalogItemId }) — creates the PENDING redemption
 * and either routes it through F10 (redemptionRequiresApproval) or auto-approves
 * inline (debit + stock + APPROVED in the same tx).
 */
async function redeem({ businessId, employee, catalogItemId, now = new Date() }) {
  const config = await getConfig(businessId);
  if (!config.pointsEnabled) return { conflict: 'POINTS_DISABLED', message: 'The points program is not enabled' };

  const item = await prismaDefault.catalogItem.findFirst({ where: { id: String(catalogItemId || ''), businessId, isActive: true } });
  if (!item) return { notFound: true };
  if (item.stock != null && item.stock <= 0) return { conflict: 'OUT_OF_STOCK', message: 'This reward is out of stock' };

  const wallet = await prismaDefault.pointsWallet.findFirst({ where: { businessId, employeeId: employee.id } });
  if (!wallet || wallet.balance < item.pointsCost) {
    return { conflict: 'INSUFFICIENT_POINTS', message: `You need ${item.pointsCost} points (you have ${wallet ? wallet.balance : 0})` };
  }

  try {
    const redemption = await prismaDefault.$transaction(async (tx) => {
      let row = await tx.redemption.create({
        data: {
          businessId,
          employeeId: employee.id,
          catalogItemId: item.id,
          pointsSpent: item.pointsCost,
          status: 'PENDING',
        },
      });
      if (config.redemptionRequiresApproval) {
        const opened = await engine.openRequest({
          businessId,
          module: 'REDEMPTION',
          entityType: 'Redemption',
          entityId: row.id,
          requesterEmployeeId: employee.id,
          payload: { itemName: item.name, pointsCost: item.pointsCost, inrValue: item.inrValue, category: item.category },
          ctx: { amount: item.pointsCost },
        }, tx);
        await tx.redemption.updateMany({ where: { id: row.id }, data: { approvalRequestId: opened.approvalRequest.id } });
      } else {
        // Auto-approve path (spec §4.5 step 2 else-branch) — no engine round-trip.
        await approveRedemptionTx(tx, { redemptionId: row.id, decidedByUserId: null, now });
      }
      row = await tx.redemption.findFirst({ where: { id: row.id } });
      return row;
    });
    if (redemption.status === 'APPROVED') notifyRedemption(redemption.id, 'redemption.approved').catch(() => {});
    return { redemption };
  } catch (e) {
    if (e && (e.code === 'INSUFFICIENT_POINTS' || e.code === 'OUT_OF_STOCK')) {
      return { conflict: e.code, message: e.message };
    }
    throw e;
  }
}

/**
 * The APPROVE core — debit the wallet (fail-closes on a short balance), decrement
 * stock (guarded), PENDING → APPROVED. Idempotent via the ledgerEntryId guard +
 * conditional status flip. Runs inside the caller's tx (consumer or auto-approve).
 */
async function approveRedemptionTx(tx, { redemptionId, decidedByUserId = null, now = new Date() }) {
  const redemption = await tx.redemption.findFirst({ where: { id: redemptionId } });
  if (!redemption || redemption.status !== 'PENDING' || redemption.ledgerEntryId) return null;

  const item = await tx.catalogItem.findFirst({ where: { id: redemption.catalogItemId } });
  if (!item) return null;

  // Stock re-check + version-safe decrement (only for finite-stock items).
  if (item.stock != null) {
    const dec = await tx.catalogItem.updateMany({
      where: { id: item.id, stock: { gt: 0 } },
      data: { stock: { decrement: 1 } },
    });
    if (dec.count === 0) {
      const e = new Error('This reward is out of stock');
      e.code = 'OUT_OF_STOCK';
      e.statusCode = 409;
      throw e;
    }
  }

  // Balance re-check + debit (throws INSUFFICIENT_POINTS → the whole tx rolls back,
  // so the stock decrement above can never leak).
  const { entry } = await pointsLedger.debit(tx, {
    businessId: redemption.businessId,
    employeeId: redemption.employeeId,
    points: redemption.pointsSpent,
    reason: 'REDEMPTION',
    refType: 'Redemption',
    refId: redemption.id,
    createdByUserId: decidedByUserId,
  });

  const flip = await tx.redemption.updateMany({
    where: { id: redemption.id, status: 'PENDING', ledgerEntryId: null },
    data: { status: 'APPROVED', ledgerEntryId: entry.id },
  });
  if (flip.count === 0) {
    // Lost the idempotency race — reverse the debit so Σ stays true.
    await pointsLedger.credit(tx, {
      businessId: redemption.businessId,
      employeeId: redemption.employeeId,
      points: redemption.pointsSpent,
      reason: 'REVERSAL',
      refType: 'Redemption',
      refId: redemption.id,
      note: 'Duplicate approve reversal',
    });
    return null;
  }
  return { redemption: { ...redemption, status: 'APPROVED', ledgerEntryId: entry.id } };
}

const LIST_INCLUDE = {
  catalogItem: { select: { id: true, name: true, category: true, pointsCost: true, inrValue: true, fulfilmentType: true, isTaxablePerk: true } },
};

async function listMine({ businessId, employeeId, page = 1, pageSize = 20 }) {
  const take = Math.max(1, Math.min(50, Number(pageSize) || 20));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;
  const where = { businessId, employeeId };
  const [items, total] = await Promise.all([
    prismaDefault.redemption.findMany({ where, include: LIST_INCLUDE, orderBy: { createdAt: 'desc' }, skip, take }),
    prismaDefault.redemption.count({ where }),
  ]);
  return { items, total, page: Math.max(1, Number(page) || 1), pageSize: take };
}

/** ESS cancel — own + PENDING only. Withdraws the engine request when one exists. */
async function cancel({ businessId, employee, redemptionId }) {
  const redemption = await prismaDefault.redemption.findFirst({
    where: { id: redemptionId, businessId, employeeId: employee.id },
  });
  if (!redemption) return { notFound: true };
  if (redemption.status !== 'PENDING') {
    return { conflict: 'NOT_PENDING', message: `Redemption is ${redemption.status}, only PENDING can be cancelled` };
  }
  if (redemption.approvalRequestId) {
    try {
      await engine.withdraw({ approvalRequestId: redemption.approvalRequestId, actorUserId: employee.userId || 'REQUESTER', comment: 'Redemption cancelled by employee' });
    } catch (e) {
      if (!(e && (e.code === 'NOT_OPEN' || e.code === 'NOT_FOUND'))) throw e;
    }
  }
  // The consumer's onCancel flips PENDING→CANCELLED; the direct flip below covers
  // the no-engine path AND is a safe no-op after the consumer already flipped.
  await prismaDefault.redemption.updateMany({
    where: { id: redemption.id, status: 'PENDING' },
    data: { status: 'CANCELLED' },
  });
  return { cancelled: true };
}

// ── operator: queue + fulfil + taxable-perks report ──────────────────────────
async function adminQueue({ businessId, status, page = 1, pageSize = 25 }) {
  const take = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;
  const where = { businessId };
  where.status = status && ['PENDING', 'APPROVED', 'FULFILLED', 'REJECTED', 'CANCELLED'].includes(status) ? status : 'APPROVED';
  const [items, total] = await Promise.all([
    prismaDefault.redemption.findMany({
      where,
      include: {
        ...LIST_INCLUDE,
        employee: { select: { id: true, code: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'asc' },
      skip, take,
    }),
    prismaDefault.redemption.count({ where }),
  ]);
  return { items, total, page: Math.max(1, Number(page) || 1), pageSize: take };
}

/**
 * Fulfil an APPROVED redemption (canFulfilRedemptions). VOUCHER_CODE/MANUAL stamp
 * the passed fulfilmentRef; COMP_OFF_GRANT best-effort mints an F30 comp-off credit.
 */
async function fulfil({ businessId, actorUserId, redemptionId, fulfilmentRef = null, now = new Date() }) {
  const redemption = await prismaDefault.redemption.findFirst({
    where: { id: redemptionId, businessId },
    include: { catalogItem: true },
  });
  if (!redemption) return { notFound: true };
  if (redemption.status !== 'APPROVED') {
    return { conflict: 'NOT_APPROVED', message: `Redemption is ${redemption.status}, only APPROVED can be fulfilled` };
  }
  if (redemption.catalogItem.fulfilmentType === 'VOUCHER_CODE' && !(fulfilmentRef && String(fulfilmentRef).trim())) {
    return { error: 'fulfilmentRef (the voucher code) is required for a voucher reward' };
  }

  let ref = fulfilmentRef ? String(fulfilmentRef).trim().slice(0, 500) : null;

  const flipped = await prismaDefault.$transaction(async (tx) => {
    // COMP_OFF_GRANT — mint the F30 credit atomically with the FULFILLED flip.
    if (redemption.catalogItem.fulfilmentType === 'COMP_OFF_GRANT') {
      const creditId = await grantCompOffTx(tx, { businessId, employeeId: redemption.employeeId, actorUserId, redemption, now });
      ref = creditId ? `comp-off:${creditId}` : (ref || 'comp-off: manual grant required (no COMP_OFF leave type)');
    }
    const flip = await tx.redemption.updateMany({
      where: { id: redemption.id, status: 'APPROVED' },
      data: { status: 'FULFILLED', fulfilmentRef: ref, fulfilledByUserId: actorUserId || null, fulfilledAt: now },
    });
    return flip.count > 0;
  });
  if (!flipped) return { conflict: 'NOT_APPROVED', message: 'The redemption changed under you — reload and retry' };

  notifyRedemption(redemption.id, 'redemption.fulfilled').catch(() => {});
  const fresh = await prismaDefault.redemption.findFirst({ where: { id: redemption.id }, include: LIST_INCLUDE });
  return { redemption: fresh };
}

/** Best-effort F30 comp-off HR_GRANT mint. Returns the credit id or null. */
async function grantCompOffTx(tx, { businessId, employeeId, actorUserId, redemption, now }) {
  try {
    const { resolveCompOffType } = require('../leave/compoff/compOffConfig');
    const { finalizeCredit } = require('../leave/compoff/finalizeCredit');
    const typeCtx = await resolveCompOffType(businessId, { tx });
    if (!typeCtx || !typeCtx.leaveType) return null; // no COMP_OFF type — leave a manual note
    const expiryDays = (typeCtx.config && typeCtx.config.expiryDays) || 60;
    const credit = await tx.compOffCredit.create({
      data: {
        businessId,
        employeeId,
        sourceDate: now,
        sourceKind: 'HR_GRANT',
        quantity: 1,
        earnedOn: now,
        expiresOn: new Date(now.getTime() + expiryDays * 24 * 3600 * 1000),
        status: 'PENDING',
        grantedBy: actorUserId || null,
        reason: `R&R redemption ${redemption.id}`,
      },
    });
    const employment = await tx.employmentRecord.findFirst({
      where: { businessId, employeeId, isCurrent: true },
      select: { entity: { select: { taxYearStartMonth: true } } },
    });
    await finalizeCredit(tx, {
      credit,
      leaveTypeId: typeCtx.leaveType.id,
      taxYearStartMonth: (employment && employment.entity && employment.entity.taxYearStartMonth) || 4,
      decidedBy: actorUserId || null,
    });
    return credit.id;
  } catch (e) {
    console.error('[redemption fulfil] comp-off grant failed:', e.message);
    return null;
  }
}

/** Finance export — FY ₹ rollup of redeemed value per employee (spec §8 flags-only). */
async function taxablePerksReport({ businessId, now = new Date() }) {
  const { start, end, label } = fyWindow(now);
  const rows = await prismaDefault.redemption.findMany({
    where: {
      businessId,
      status: { in: ['APPROVED', 'FULFILLED'] },
      createdAt: { gte: start, lt: end },
      catalogItem: { inrValue: { not: null } },
    },
    select: {
      employeeId: true,
      catalogItem: { select: { inrValue: true, isTaxablePerk: true } },
    },
  });
  const agg = aggregateTaxablePerks(rows.map((r) => ({ employeeId: r.employeeId, inrValue: r.catalogItem.inrValue })));
  const dir = agg.length
    ? await prismaDefault.employee.findMany({
        where: { businessId, id: { in: agg.map((a) => a.employeeId) } },
        select: { id: true, code: true, firstName: true, lastName: true },
      })
    : [];
  const byId = new Map(dir.map((e) => [e.id, e]));
  return {
    financialYear: label,
    limitInr: TAXABLE_PERQUISITE_LIMIT_INR,
    rows: agg.map((a) => {
      const e = byId.get(a.employeeId);
      return {
        ...a,
        code: e ? e.code : null,
        name: e ? [e.firstName, e.lastName].filter(Boolean).join(' ') : null,
      };
    }),
  };
}

// ── notification (fire-and-forget) ───────────────────────────────────────────
async function notifyRedemption(redemptionId, event) {
  const r = await prismaDefault.redemption.findFirst({
    where: { id: redemptionId },
    include: {
      catalogItem: { select: { name: true } },
      employee: { select: { firstName: true, workEmail: true, personalEmail: true, phone: true, countryCode: true } },
    },
  });
  if (!r || !r.employee) return;
  const email = emailOf(r.employee);
  if (!email && !r.employee.phone) return;
  const wallet = await prismaDefault.pointsWallet.findFirst({ where: { businessId: r.businessId, employeeId: r.employeeId } });
  await notifyHrEvent({
    businessId: r.businessId,
    event,
    recipientEmail: email,
    recipientPhone: r.employee.phone || undefined,
    recipientCountry: r.employee.countryCode || undefined,
    variables: {
      NAME: r.employee.firstName || 'there',
      ITEM: r.catalogItem ? r.catalogItem.name : 'your reward',
      POINTS: String(r.pointsSpent),
      BALANCE: String(wallet ? wallet.balance : 0),
      REF: r.fulfilmentRef ? ` — ${r.fulfilmentRef}` : '',
      BIZ: '',
    },
    triggeredBy: `HR_REDEMPTION:${event}:${r.id}`,
  });
}

module.exports = {
  fyWindow,
  aggregateTaxablePerks,
  TAXABLE_PERQUISITE_LIMIT_INR,
  listCatalog,
  redeem,
  approveRedemptionTx,
  listMine,
  cancel,
  adminQueue,
  fulfil,
  taxablePerksReport,
  notifyRedemption,
};
