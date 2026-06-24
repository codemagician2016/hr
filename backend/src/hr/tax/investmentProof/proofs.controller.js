'use strict';

/**
 * proofs.controller.js — Feature 20 slice 20c. The HR proof-VERIFICATION console,
 * mounted at /api/hr/proofs and /api/hr/employees/:employeeId/proofs. Operator session
 * (req.user); every per-employee route is FEATURE-1 SCOPED via withEmployeeScope, so a
 * manager hitting an out-of-team employee resolves to 404 (IDOR-safe, never 403).
 *
 * RBAC: reading = canViewEmployees; accept/reject = canManageEmployees (same gate the
 * existing verifyDocument uses). SoD: the operator's own linked Employee ≠ the proof's
 * employee — an employee can never self-verify their own proof (mirrors
 * profileChangeAdmin's operatorEmployeeId guard). The accept caps verifiedAmount at the
 * proof's declaredAmount (a fat-fingered verify can't inflate relief); reject requires a
 * mandatory reason. Each verdict fires a notifyHrEvent to the employee.
 *
 * The proof-file route is SSRF-guarded (s3.isOurUrl): a data-URL is decoded inline, our
 * bucket URL is redirected, anything else → 404 (refuse to proxy arbitrary URLs).
 */

const prisma = require('../../../core/lib/prisma');
const s3 = require('../../../core/lib/s3');
const { scopeWhere } = require('../../lib/scopeResolver');
const { notifyHrEvent } = require('../../integrations/notifications');
const { CLAIM_TYPE_META } = require('./claimTypes');

const PROOF_PUBLIC = [
  'id', 'employeeId', 'windowId', 'financialYear', 'claimType', 'subSection',
  'declaredAmount', 'verifiedAmount', 'fileUrl', 'fileHash', 'mimeType', 'sizeBytes',
  'originalName', 'landlordName', 'landlordPan', 'rentMonthsCovered', 'status',
  'rejectReason', 'verifiedById', 'verifiedAt', 'createdAt', 'updatedAt',
];
function publicProof(p) {
  if (!p) return null;
  const out = {};
  for (const f of PROOF_PUBLIC) if (p[f] !== undefined) out[f] = p[f];
  return out;
}

function toNum(v) {
  if (v == null) return 0;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// The operator's own linked Employee id (for the SoD guard). Mirrors profileChangeAdmin.
async function operatorEmployeeId(req) {
  if (req.user && req.user.employeeId !== undefined && req.user.employeeId !== null) return req.user.employeeId;
  if (!req.user || !req.user.id) return null;
  const emp = await prisma.employee.findFirst({
    where: { userId: req.user.id, businessId: req.user.businessId, deletedAt: null },
    select: { id: true },
  });
  return emp ? emp.id : null;
}

// Best-effort employee-notify on a verdict (never fails the verify on a notify error).
async function notifyEmployee({ businessId, employeeId, event, variables }) {
  try {
    const emp = await prisma.employee.findFirst({
      where: { id: employeeId, businessId },
      select: { workEmail: true, personalEmail: true, firstName: true },
    });
    const recipientEmail = emp ? (emp.workEmail || emp.personalEmail) : null;
    if (!recipientEmail) return;
    const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } });
    await notifyHrEvent({
      businessId,
      event,
      recipientEmail,
      variables: { NAME: (emp && emp.firstName) || 'there', BIZ: (biz && biz.name) || 'your company', ...variables },
      triggeredBy: 'INVESTMENT_PROOF_VERDICT',
    });
  } catch (_e) { /* notify is best-effort */ }
}

// ── GET /api/hr/proofs?fy=&status=PENDING&page= — the tenant/team verify queue ──
// Scoped: HR (ALL band) sees the tenant; a manager sees only their team's proofs.
async function listProofQueue(req, res, next) {
  try {
    const { businessId } = req.user;
    const fy = typeof req.query.fy === 'string' && /^\d{4}-\d{2}$/.test(req.query.fy) ? req.query.fy : null;
    const status = typeof req.query.status === 'string' && ['PENDING', 'ACCEPTED', 'REJECTED'].includes(req.query.status)
      ? req.query.status : 'PENDING';
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 100);

    // F1 scope: ALL band → no extra filter; team band → employeeId IN the sub-tree;
    // NONE → matches nothing. scopeWhere returns {} | { employeeId: { in: [...] } }.
    const where = {
      businessId, deletedAt: null, status,
      ...(fy ? { financialYear: fy } : {}),
      ...scopeWhere(req.scope, 'employeeId'),
    };

    const [total, rows] = await Promise.all([
      prisma.investmentProof.count({ where }),
      prisma.investmentProof.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { employee: { select: { id: true, code: true, firstName: true, middleName: true, lastName: true } } },
      }),
    ]);

    const items = rows.map((p) => ({
      ...publicProof(p),
      employee: p.employee ? {
        id: p.employee.id, code: p.employee.code,
        name: [p.employee.firstName, p.employee.middleName, p.employee.lastName].filter(Boolean).join(' ') || p.employee.code,
      } : null,
      claimLabel: CLAIM_TYPE_META[p.claimType] ? CLAIM_TYPE_META[p.claimType].label : p.claimType,
    }));
    res.json({ items, total, page, pageSize });
  } catch (e) { next(e); }
}

// ── GET /api/hr/employees/:employeeId/proofs?fy= — per-employee drill-down ──────
// All proofs for one employee, grouped by claimType, with declared vs Σverified vs
// pending per section so HR sees exactly what feeds TDS at the deadline.
async function listEmployeeProofs(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;
    const fy = typeof req.query.fy === 'string' && /^\d{4}-\d{2}$/.test(req.query.fy) ? req.query.fy : null;
    const where = { businessId, employeeId, deletedAt: null, ...(fy ? { financialYear: fy } : {}) };
    const proofs = await prisma.investmentProof.findMany({ where, orderBy: { createdAt: 'desc' } });
    const sp = await prisma.statutoryProfile.findFirst({ where: { businessId, employeeId } });

    // Group + summarise per claim type (declared from SP, Σaccepted/Σpending from proofs).
    const groups = [];
    for (const ct of Object.keys(CLAIM_TYPE_META)) {
      const meta = CLAIM_TYPE_META[ct];
      const declared = sp ? toNum(sp[meta.spField]) : 0;
      const mine = proofs.filter((p) => p.claimType === ct);
      if (declared <= 0 && mine.length === 0) continue;
      let accepted = 0; let pending = 0;
      for (const p of mine) {
        if (p.status === 'ACCEPTED' && p.verifiedAmount != null) accepted += toNum(p.verifiedAmount);
        else if (p.status === 'PENDING') pending += toNum(p.declaredAmount);
      }
      groups.push({
        claimType: ct, label: meta.label, declared,
        verified: Math.min(declared, accepted), pendingAmount: pending,
        proofs: mine.map(publicProof),
      });
    }
    res.json({ employeeId, financialYear: fy, regime: sp && sp.taxRegime ? sp.taxRegime : 'NEW', groups });
  } catch (e) { next(e); }
}

// Shared loader: tenant + scope already enforced by the route; load the live proof.
async function loadProof(req, res) {
  const { businessId } = req.user;
  const { employeeId, id } = req.params;
  const proof = await prisma.investmentProof.findFirst({
    where: { id, businessId, employeeId, deletedAt: null },
  });
  if (!proof) { res.status(404).json({ message: 'Proof not found' }); return null; }
  return proof;
}

// ── POST /api/hr/employees/:employeeId/proofs/:id/accept — { verifiedAmount } ───
async function acceptProof(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;
    // SoD: the operator cannot verify a proof belonging to their own employee record.
    const selfEmp = await operatorEmployeeId(req);
    if (selfEmp && selfEmp === employeeId) {
      return res.status(403).json({ message: 'You cannot verify your own investment proof.', code: 'SOD_VIOLATION' });
    }
    const proof = await loadProof(req, res);
    if (!proof) return undefined;
    if (proof.status === 'ACCEPTED') {
      return res.status(409).json({ message: 'This proof is already accepted. Reject it first to re-verify.' });
    }

    // verifiedAmount defaults to the declared amount; HR may trim DOWN, never UP.
    const declared = toNum(proof.declaredAmount);
    let verifiedAmount = req.body && req.body.verifiedAmount != null ? toNum(req.body.verifiedAmount) : declared;
    if (!(verifiedAmount >= 0)) return res.status(422).json({ message: 'verifiedAmount must be a non-negative number.' });
    if (verifiedAmount > declared) {
      return res.status(422).json({ message: `verifiedAmount (${verifiedAmount}) cannot exceed the declared amount (${declared}).`, code: 'VERIFIED_EXCEEDS_DECLARED' });
    }

    const saved = await prisma.investmentProof.update({
      where: { id: proof.id },
      data: {
        status: 'ACCEPTED',
        verifiedAmount,
        rejectReason: null,
        verifiedById: req.user.id,
        verifiedAt: new Date(),
        version: { increment: 1 },
      },
    });
    await notifyEmployee({
      businessId, employeeId, event: 'proof.accepted',
      variables: {
        CLAIM: CLAIM_TYPE_META[proof.claimType] ? CLAIM_TYPE_META[proof.claimType].label : proof.claimType,
        FY: proof.financialYear,
        AMOUNT: `₹${verifiedAmount.toLocaleString('en-IN')}`,
      },
    });
    res.json(publicProof(saved));
  } catch (e) { next(e); }
}

// ── POST /api/hr/employees/:employeeId/proofs/:id/reject — { rejectReason } ─────
async function rejectProof(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;
    const selfEmp = await operatorEmployeeId(req);
    if (selfEmp && selfEmp === employeeId) {
      return res.status(403).json({ message: 'You cannot verify your own investment proof.', code: 'SOD_VIOLATION' });
    }
    const reason = req.body && typeof req.body.rejectReason === 'string' ? req.body.rejectReason.trim() : '';
    if (!reason) return res.status(422).json({ message: 'A rejection reason is required.', code: 'REJECT_REASON_REQUIRED' });

    const proof = await loadProof(req, res);
    if (!proof) return undefined;

    const saved = await prisma.investmentProof.update({
      where: { id: proof.id },
      data: {
        status: 'REJECTED',
        verifiedAmount: null,
        rejectReason: reason.slice(0, 1000),
        verifiedById: req.user.id,
        verifiedAt: new Date(),
        version: { increment: 1 },
      },
    });
    await notifyEmployee({
      businessId, employeeId, event: 'proof.rejected',
      variables: {
        CLAIM: CLAIM_TYPE_META[proof.claimType] ? CLAIM_TYPE_META[proof.claimType].label : proof.claimType,
        FY: proof.financialYear,
        REASON: reason.slice(0, 200),
        LINK: '',
      },
    });
    res.json(publicProof(saved));
  } catch (e) { next(e); }
}

// ── GET /api/hr/employees/:employeeId/proofs/:id/file — stream/redirect (SSRF) ──
async function getProofFile(req, res, next) {
  try {
    const proof = await loadProof(req, res);
    if (!proof) return undefined;
    const url = proof.fileUrl;
    const mime = proof.mimeType || 'application/octet-stream';
    const fileName = `proof-${proof.id}`;

    if (typeof url === 'string' && url.startsWith('data:')) {
      const m = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(url);
      if (!m || !m[2]) return res.status(404).json({ message: 'File not found' });
      const buffer = Buffer.from(m[3] || '', 'base64');
      res.setHeader('Content-Type', m[1] || mime);
      res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
      res.setHeader('Content-Length', buffer.length);
      return res.send(buffer);
    }
    if (s3.isOurUrl(url)) return res.redirect(url);
    // Non-data, non-ours URL → 404 (SSRF guard: refuse to proxy arbitrary URLs).
    return res.status(404).json({ message: 'File not found' });
  } catch (e) { next(e); }
}

module.exports = {
  listProofQueue, listEmployeeProofs, acceptProof, rejectProof, getProofFile,
  _internals: { operatorEmployeeId, publicProof },
};
