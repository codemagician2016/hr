'use strict';

/**
 * issuance.controller.js — the Letters issuance HTTP surface (Feature 9 §4.5,
 * slice 9E). Mounted at /api/hr/letters. Thin adapter over letters.service.js
 * (the orchestrator owns all the rendering / ref-no / persistence logic).
 *
 * RBAC posture (§4.4):
 *   - preview/issue/reissue + per-employee history → canGenerateLetters (maker)
 *     + withEmployeeScope (out-of-band subject ⇒ 404, never 403).
 *   - revoke → canManageLetters (config/checker key, distinct from the issuer).
 *   - register/get/download → canGenerateLetters, tenant-scoped (cross-tenant id
 *     ⇒ 404). Every query is `where:{ businessId }`-scoped.
 */

const prisma = require('../../../core/lib/prisma');
const { scopeAllows } = require('../../lib/scopeResolver');
const { effectivePermissions } = require('../../../core/lib/rbac');
const s3 = require('../../../core/lib/s3');
const service = require('../letters.service');

// Map a thrown ServiceError (carries .status) to an HTTP response; anything else
// bubbles to the express error handler.
function sendServiceError(res, err) {
  if (err && typeof err.status === 'number') {
    const body = { message: err.message || 'Request failed' };
    if (err.missingRequired) body.missingRequired = err.missingRequired;
    if (err.code) body.code = err.code;
    return res.status(err.status).json(body);
  }
  return null;
}

function permsOf(req) {
  return effectivePermissions(req.user) || {};
}

// Out-of-scope subject ⇒ 404 (IDOR-safe). req.scope is set by withEmployeeScope.
function subjectInScope(req, employeeId) {
  if (!employeeId) return true; // company-wide letter (no subject)
  if (!req.scope || req.scope.kind === 'ALL') return true;
  return scopeAllows(req.scope, employeeId);
}

// Stream a PDF buffer as a download/inline response (payslip-serving pattern).
function streamPdf(res, { buffer, fileName, inline }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${(fileName || 'letter').replace(/[^\w.\-]/g, '_')}.pdf"`
  );
  res.setHeader('Content-Length', buffer.length);
  return res.status(200).send(buffer);
}

// Resolve a stored letter's PDF bytes: an inline data URL (dev/test) or an
// http(s) URL on OUR bucket (SSRF-guarded proxy).
async function letterBytes(fileUrl) {
  if (typeof fileUrl !== 'string' || !fileUrl) return null;
  if (fileUrl.startsWith('data:')) {
    const m = /^data:[^;,]+;base64,(.*)$/i.exec(fileUrl);
    return m ? Buffer.from(m[1], 'base64') : null;
  }
  if (!s3.isOurUrl(fileUrl)) return null;
  try {
    const r = await fetch(fileUrl);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch (_e) {
    return null;
  }
}

// ── POST /preview — watermarked PDF, no persistence, no ref-no ────────────────
async function preview(req, res, next) {
  try {
    const { businessId } = req.user;
    const { templateId, employeeId = null, overrides = {} } = req.body || {};
    if (!templateId) return res.status(400).json({ message: 'templateId is required' });
    if (!subjectInScope(req, employeeId)) return res.status(404).json({ message: 'Not found' });

    const out = await service.issueLetter(prisma, {
      businessId,
      actorUserId: req.user.id,
      perms: permsOf(req),
      templateId,
      employeeId,
      overrides,
      mode: 'preview',
    });
    return streamPdf(res, { buffer: out.pdf, fileName: 'preview', inline: true });
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    return next(err);
  }
}

// ── POST /issue — atomic issue (ref-no + render + store + rows + audit) ───────
async function issue(req, res, next) {
  try {
    const { businessId } = req.user;
    const { templateId, employeeId = null, overrides = {}, documentRequestId = null, signers } = req.body || {};
    if (!templateId) return res.status(400).json({ message: 'templateId is required' });
    if (!subjectInScope(req, employeeId)) return res.status(404).json({ message: 'Not found' });

    const out = await service.issueLetter(prisma, {
      businessId,
      actorUserId: req.user.id,
      perms: permsOf(req),
      templateId,
      employeeId,
      overrides,
      mode: 'issue',
      documentRequestId,
      signers,
    });
    return res.status(201).json(out);
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    return next(err);
  }
}

// ── POST /:id/reissue — new ref-no + supersede chain ──────────────────────────
async function reissue(req, res, next) {
  try {
    const { businessId } = req.user;
    const { overrides = {} } = req.body || {};

    // Scope guard on the source's subject employee (out-of-band ⇒ 404).
    const source = await prisma.issuedLetter.findFirst({
      where: { id: req.params.id, businessId },
      select: { id: true, employeeId: true },
    });
    if (!source) return res.status(404).json({ message: 'Letter not found' });
    if (!subjectInScope(req, source.employeeId)) return res.status(404).json({ message: 'Letter not found' });

    const out = await service.reissueLetter(prisma, {
      businessId,
      actorUserId: req.user.id,
      perms: permsOf(req),
      sourceId: req.params.id,
      overrides,
    });
    return res.status(201).json(out);
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    return next(err);
  }
}

// ── POST /:id/revoke — VOID (canManageLetters + reason) ───────────────────────
async function revoke(req, res, next) {
  try {
    const { businessId } = req.user;
    const reason = (req.body && req.body.reason) || '';

    const exists = await prisma.issuedLetter.findFirst({
      where: { id: req.params.id, businessId },
      select: { id: true },
    });
    if (!exists) return res.status(404).json({ message: 'Letter not found' });

    const out = await service.revokeLetter(prisma, {
      businessId,
      actorUserId: req.user.id,
      perms: permsOf(req),
      id: req.params.id,
      reason,
    });
    return res.status(200).json(out);
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    return next(err);
  }
}

// ── GET /register — tenant register: filters + search + pagination + CSV ───────
async function register(req, res, next) {
  try {
    const { businessId } = req.user;
    const q = req.query || {};
    const where = { businessId };
    if (q.category) where.category = String(q.category);
    if (q.status) where.status = String(q.status);
    if (q.entityId) where.entityId = String(q.entityId);
    if (q.issuedBy) where.issuedBy = String(q.issuedBy);
    if (q.from || q.to) {
      where.issuedAt = {};
      if (q.from) where.issuedAt.gte = new Date(String(q.from));
      if (q.to) where.issuedAt.lte = new Date(String(q.to));
    }
    if (q.search) {
      const s = String(q.search).trim();
      where.OR = [
        { referenceNo: { contains: s, mode: 'insensitive' } },
        { subject: { contains: s, mode: 'insensitive' } },
        { employee: { is: { firstName: { contains: s, mode: 'insensitive' } } } },
        { employee: { is: { lastName: { contains: s, mode: 'insensitive' } } } },
        { employee: { is: { code: { contains: s, mode: 'insensitive' } } } },
      ];
    }

    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize, 10) || 25));
    const csv = q.format === 'csv' || q.csv === 'true';

    const select = {
      id: true, referenceNo: true, category: true, status: true, subject: true,
      entityId: true, issuedBy: true, issuedAt: true, createdAt: true,
      supersedesLetterId: true, supersededByLetterId: true, voidedAt: true,
      employee: { select: { id: true, firstName: true, lastName: true, code: true } },
    };

    if (csv) {
      const rows = await prisma.issuedLetter.findMany({
        where, select, orderBy: { createdAt: 'desc' }, take: 5000,
      });
      const out = toCsv(rows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="letters-register.csv"');
      return res.status(200).send(out);
    }

    const [total, items] = await Promise.all([
      prisma.issuedLetter.count({ where }),
      prisma.issuedLetter.findMany({
        where, select, orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize, take: pageSize,
      }),
    ]);
    return res.json({
      items: items.map(publicRow),
      page, pageSize, total, totalPages: Math.ceil(total / pageSize),
    });
  } catch (err) { return next(err); }
}

function publicRow(r) {
  const emp = r.employee;
  return {
    id: r.id,
    referenceNo: r.referenceNo,
    category: r.category,
    status: r.status,
    subject: r.subject,
    entityId: r.entityId,
    issuedBy: r.issuedBy,
    issuedAt: r.issuedAt,
    createdAt: r.createdAt,
    supersedesLetterId: r.supersedesLetterId,
    supersededByLetterId: r.supersededByLetterId,
    voidedAt: r.voidedAt,
    employee: emp ? {
      id: emp.id,
      name: [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim(),
      code: emp.code,
    } : null,
  };
}

function toCsv(rows) {
  const header = ['referenceNo', 'category', 'status', 'employee', 'employeeCode', 'issuedBy', 'issuedAt'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    const emp = r.employee ? [r.employee.firstName, r.employee.lastName].filter(Boolean).join(' ').trim() : '';
    lines.push([
      esc(r.referenceNo), esc(r.category), esc(r.status), esc(emp),
      esc(r.employee ? r.employee.code : ''), esc(r.issuedBy),
      esc(r.issuedAt ? new Date(r.issuedAt).toISOString() : ''),
    ].join(','));
  }
  return lines.join('\r\n');
}

// ── GET /:id — one issued letter (provenance + snapshot), scoped ──────────────
async function getOne(req, res, next) {
  try {
    const { businessId } = req.user;
    const letter = await prisma.issuedLetter.findFirst({
      where: { id: req.params.id, businessId },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, code: true } },
        template: { select: { id: true, name: true, code: true, category: true } },
        letterhead: { select: { id: true, name: true, code: true } },
      },
    });
    if (!letter) return res.status(404).json({ message: 'Letter not found' });
    if (!subjectInScope(req, letter.employeeId)) return res.status(404).json({ message: 'Letter not found' });
    return res.json(letter);
  } catch (err) { return next(err); }
}

// ── GET /:id/download — stream the issued PDF (attachment), scoped ────────────
async function download(req, res, next) {
  try {
    const { businessId } = req.user;
    const letter = await prisma.issuedLetter.findFirst({
      where: { id: req.params.id, businessId },
      select: { id: true, referenceNo: true, fileUrl: true, employeeId: true },
    });
    if (!letter) return res.status(404).json({ message: 'Letter not found' });
    if (!subjectInScope(req, letter.employeeId)) return res.status(404).json({ message: 'Letter not found' });

    const buf = await letterBytes(letter.fileUrl);
    if (!buf) return res.status(404).json({ message: 'File not available' });
    const name = (letter.referenceNo || 'letter').replace(/\//g, '-');
    return streamPdf(res, { buffer: buf, fileName: name });
  } catch (err) { return next(err); }
}

// ── GET /employees/:employeeId/letters — per-employee history (supersede chains) ─
async function employeeLetters(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;
    // withEmployeeScope already 404'd an out-of-band employeeId via idParam.
    const letters = await prisma.issuedLetter.findMany({
      where: { businessId, employeeId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, referenceNo: true, category: true, status: true, subject: true,
        issuedBy: true, issuedAt: true, createdAt: true,
        supersedesLetterId: true, supersededByLetterId: true, voidedAt: true, voidReason: true,
      },
    });
    return res.json({ employeeId, items: letters });
  } catch (err) { return next(err); }
}

module.exports = {
  preview,
  issue,
  reissue,
  revoke,
  register,
  getOne,
  download,
  employeeLetters,
  _internals: { toCsv, publicRow, letterBytes },
};
