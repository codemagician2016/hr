'use strict';

/**
 * taxWindow.controller.js — Feature 20 slice 20a. The InvestmentDeclarationWindow
 * admin surface, mounted at /api/hr/tax-windows. Operator session (req.user); tenant
 * -scoped on every query. RBAC: read = canViewPayrollReports, write = canManageStatutory
 * (the window directly moves TDS money — a statutory-config concern, like PF/PT setup).
 *
 * The window is the LOCK PRIMITIVE: opensAt ≤ closesAt ≤ proofDeadline (the date the
 * assembler flips DECLARED→VERIFIED). One window per FY per country (@@unique). Status
 * transitions DRAFT→OPEN→CLOSED→LOCKED are monotonic (never backwards) so a re-opened
 * window can't silently un-lock TDS.
 */

const prisma = require('../../../core/lib/prisma');

const FY_RE = /^\d{4}-\d{2}$/; // "2026-27"
const WIN_PUBLIC = [
  'id', 'businessId', 'financialYear', 'countryCode', 'opensAt', 'closesAt',
  'proofDeadline', 'status', 'notes', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt', 'version',
];

function publicWindow(w) {
  if (!w) return null;
  const out = {};
  for (const f of WIN_PUBLIC) if (w[f] !== undefined) out[f] = w[f];
  return out;
}

// Parse a 'YYYY-MM-DD' date-only string into a UTC Date (the column is @db.Date).
function parseDateOnly(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null;
  const d = new Date(`${v.trim()}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Order guard: opensAt ≤ closesAt ≤ proofDeadline. Returns an error message or null.
function checkOrder(opensAt, closesAt, proofDeadline) {
  if (opensAt > closesAt) return 'opensAt must be on or before closesAt';
  if (closesAt > proofDeadline) return 'closesAt must be on or before proofDeadline';
  return null;
}

// ── GET /api/hr/tax-windows?fy=2026-27 ───────────────────────────────────────
// List windows for the tenant (optionally one FY). Includes a quick proof rollup.
async function listWindows(req, res, next) {
  try {
    const { businessId } = req.user;
    const fy = typeof req.query.fy === 'string' && FY_RE.test(req.query.fy) ? req.query.fy : null;
    const where = { businessId, ...(fy ? { financialYear: fy } : {}) };
    const windows = await prisma.investmentDeclarationWindow.findMany({
      where,
      orderBy: [{ financialYear: 'desc' }, { createdAt: 'desc' }],
    });

    // Per-window proof counts (employees who uploaded + pending verify), tenant-scoped.
    const out = [];
    for (const w of windows) {
      const [uploaders, pending, accepted] = await Promise.all([
        prisma.investmentProof.findMany({
          where: { businessId, windowId: w.id, deletedAt: null },
          select: { employeeId: true },
          distinct: ['employeeId'],
        }),
        prisma.investmentProof.count({ where: { businessId, windowId: w.id, deletedAt: null, status: 'PENDING' } }),
        prisma.investmentProof.count({ where: { businessId, windowId: w.id, deletedAt: null, status: 'ACCEPTED' } }),
      ]);
      out.push({
        ...publicWindow(w),
        stats: { uploaders: uploaders.length, pendingProofs: pending, acceptedProofs: accepted },
      });
    }
    res.json({ windows: out });
  } catch (e) { next(e); }
}

// ── GET /api/hr/tax-windows/:id ──────────────────────────────────────────────
async function getWindow(req, res, next) {
  try {
    const { businessId } = req.user;
    const w = await prisma.investmentDeclarationWindow.findFirst({ where: { id: req.params.id, businessId } });
    if (!w) return res.status(404).json({ message: 'Window not found' });
    res.json(publicWindow(w));
  } catch (e) { next(e); }
}

// ── POST /api/hr/tax-windows ─────────────────────────────────────────────────
// Create OR update (upsert by FY+country) a window. Guards: FY format, date order,
// one-per-FY. Editing dates is allowed while DRAFT/OPEN; once CLOSED the deadline is
// frozen (changing the TDS-flip date after lock would be a §201 hazard).
async function createWindow(req, res, next) {
  try {
    const { businessId } = req.user;
    const body = req.body || {};
    const fy = typeof body.financialYear === 'string' ? body.financialYear.trim() : '';
    if (!FY_RE.test(fy)) return res.status(422).json({ message: 'financialYear must be "YYYY-YY" (e.g. 2026-27)' });
    const countryCode = (typeof body.countryCode === 'string' ? body.countryCode.trim().toUpperCase() : 'IN') || 'IN';
    if (countryCode !== 'IN') return res.status(422).json({ message: 'Investment-proof windows are India-only.' });

    const opensAt = parseDateOnly(body.opensAt);
    const closesAt = parseDateOnly(body.closesAt);
    const proofDeadline = parseDateOnly(body.proofDeadline);
    if (!opensAt || !closesAt || !proofDeadline) {
      return res.status(422).json({ message: 'opensAt, closesAt and proofDeadline are required as YYYY-MM-DD' });
    }
    const orderErr = checkOrder(opensAt, closesAt, proofDeadline);
    if (orderErr) return res.status(422).json({ message: orderErr });

    const existing = await prisma.investmentDeclarationWindow.findFirst({
      where: { businessId, financialYear: fy, countryCode },
    });

    // A LOCKED window is immutable (verification frozen). A CLOSED window keeps its
    // proofDeadline (don't move the TDS-flip date after verification began).
    if (existing && existing.status === 'LOCKED') {
      return res.status(409).json({ message: 'This window is LOCKED and can no longer be edited.' });
    }
    const data = {
      opensAt, closesAt, proofDeadline,
      notes: typeof body.notes === 'string' ? body.notes : (existing ? existing.notes : null),
    };
    if (existing && existing.status === 'CLOSED') {
      // Keep the frozen deadline; only notes/opensAt/closesAt edits are cosmetic now.
      data.proofDeadline = existing.proofDeadline;
    }

    let saved;
    if (existing) {
      saved = await prisma.investmentDeclarationWindow.update({
        where: { id: existing.id },
        data: { ...data, updatedBy: req.user.id, version: { increment: 1 } },
      });
    } else {
      saved = await prisma.investmentDeclarationWindow.create({
        data: { businessId, financialYear: fy, countryCode, status: 'DRAFT', createdBy: req.user.id, updatedBy: req.user.id, ...data },
      });
    }
    res.status(existing ? 200 : 201).json(publicWindow(saved));
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A window already exists for that FY.' });
    next(e);
  }
}

// Monotonic status transition: DRAFT→OPEN→CLOSED→LOCKED. Reuse for the three actions.
const STATUS_ORDER = { DRAFT: 0, OPEN: 1, CLOSED: 2, LOCKED: 3 };
async function transition(req, res, next, target) {
  try {
    const { businessId } = req.user;
    const w = await prisma.investmentDeclarationWindow.findFirst({ where: { id: req.params.id, businessId } });
    if (!w) return res.status(404).json({ message: 'Window not found' });
    const from = STATUS_ORDER[w.status];
    const to = STATUS_ORDER[target];
    if (to !== from + 1) {
      return res.status(409).json({ message: `Cannot move a ${w.status} window to ${target}.` });
    }
    const saved = await prisma.investmentDeclarationWindow.update({
      where: { id: w.id },
      data: { status: target, updatedBy: req.user.id, version: { increment: 1 } },
    });
    res.json(publicWindow(saved));
  } catch (e) { next(e); }
}

const openWindow = (req, res, next) => transition(req, res, next, 'OPEN');
const closeWindow = (req, res, next) => transition(req, res, next, 'CLOSED');
const lockWindow = (req, res, next) => transition(req, res, next, 'LOCKED');

module.exports = {
  listWindows, getWindow, createWindow, openWindow, closeWindow, lockWindow,
  _internals: { checkOrder, parseDateOnly },
};
