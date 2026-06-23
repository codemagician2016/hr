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
const { scopeAllows, resolveAccessibleEmployeeIds } = require('../../lib/scopeResolver');
const { effectivePermissions } = require('../../../core/lib/rbac');
const { redactLetterForViewer } = require('../redactLetter');
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

// Constrain a register `where` to the actor's data-scope band. ALL ⇒ no filter
// (fast path). A narrower band (TEAM/SELF/NONE) ⇒ only letters for in-scope
// employees PLUS company-wide letters (employeeId == null) — mirrors the
// subjectInScope posture used by getOne/download so a scoped issuer can't read
// the whole tenant register (IDOR). NONE/empty scope ⇒ company-wide letters only.
//
// req.scope is normally populated by withEmployeeScope on the route; if it isn't
// (defense-in-depth / a mount path that skipped the middleware), we resolve the
// band here so the register can NEVER silently fall open to the whole tenant.
async function applyRegisterScope(where, req) {
  let scope = req.scope;
  if (!scope) scope = await resolveAccessibleEmployeeIds(req.user, 'canGenerateLetters');
  if (!scope || scope.kind === 'ALL') return where;
  const ids = scope.kind === 'IDS' && scope.ids ? [...scope.ids] : [];
  where.AND = (where.AND || []).concat([{
    OR: [{ employeeId: { in: ids } }, { employeeId: null }],
  }]);
  return where;
}

// Resolve issuer user ids → a { id: { name, email } } map in one batched query.
// `issuedBy` is a bare userId string on IssuedLetter (no Prisma relation), so the
// register would otherwise render a raw UUID; we join the User here for a human
// "Issued by" label, keeping the id available as a secondary audit field.
async function resolveIssuers(ids) {
  const distinct = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!distinct.length) return {};
  const users = await prisma.user.findMany({
    where: { id: { in: distinct } },
    select: { id: true, name: true, email: true },
  });
  const map = {};
  for (const u of users) map[u.id] = { name: u.name, email: u.email };
  return map;
}

// Best human label for an issuer: name → email → the raw id (so it's never blank).
function issuerName(issuerMap, issuedBy) {
  const u = issuedBy ? issuerMap[String(issuedBy)] : null;
  return (u && (u.name || u.email)) || issuedBy || '';
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
    // Surface the masked comp keys to the wizard so the "salary figures hidden"
    // notice can show on the LIVE preview (before issuing). The body is a PDF
    // stream, so we pass the (non-sensitive — just field names) list via a header.
    if (Array.isArray(out.masked) && out.masked.length) {
      res.setHeader('X-Letter-Masked', out.masked.join(','));
      res.setHeader('Access-Control-Expose-Headers', 'X-Letter-Masked');
    }
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

    // F1 scope: a non-ALL (TEAM/SELF/…) issuer sees only in-scope employees'
    // letters + company-wide letters — never the whole tenant register.
    await applyRegisterScope(where, req);

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
      const issuers = await resolveIssuers(rows.map((r) => r.issuedBy));
      const out = toCsv(rows, issuers);
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
    const issuers = await resolveIssuers(items.map((r) => r.issuedBy));
    return res.json({
      items: items.map((r) => publicRow(r, issuers)),
      page, pageSize, total, totalPages: Math.ceil(total / pageSize),
    });
  } catch (err) { return next(err); }
}

function publicRow(r, issuerMap = {}) {
  const emp = r.employee;
  return {
    id: r.id,
    referenceNo: r.referenceNo,
    category: r.category,
    status: r.status,
    subject: r.subject,
    entityId: r.entityId,
    issuedBy: r.issuedBy, // raw userId — secondary audit field
    issuedByName: issuerName(issuerMap, r.issuedBy),
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

function toCsv(rows, issuerMap = {}) {
  const header = ['referenceNo', 'category', 'status', 'employee', 'employeeCode', 'issuedByName', 'issuedById', 'issuedAt'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    const emp = r.employee ? [r.employee.firstName, r.employee.lastName].filter(Boolean).join(' ').trim() : '';
    lines.push([
      esc(r.referenceNo), esc(r.category), esc(r.status), esc(emp),
      esc(r.employee ? r.employee.code : ''),
      esc(issuerName(issuerMap, r.issuedBy)), esc(r.issuedBy),
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
    // Re-mask the persisted comp snapshot at the read boundary: the row's
    // mergeDataJson/renderedBody were minted with the ISSUER's perms and may carry
    // absolute salary. A non-ABSOLUTE viewer gets comp.* masked + renderedBody
    // omitted (the masked-at-render PDF stays available via /download).
    const redacted = redactLetterForViewer(letter, req.user);
    // Human "Issued by" label (the raw id stays as a secondary audit field). Spread
    // into a NEW object so we never mutate the redacted row / live snapshot.
    const issuers = await resolveIssuers([letter.issuedBy]);
    return res.json({ ...redacted, issuedByName: issuerName(issuers, letter.issuedBy) });
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

// ── GET /requests — PENDING ESS letter requests (the Issue-area "Requests" queue) ─
// An employee's "request a letter" creates a DocumentRequest; HR never saw it.
// This surfaces the OPEN ones (not yet fulfilled, not rejected/cancelled) so HR can
// action them. Scope-constrained: a non-ALL (TEAM/SELF) issuer sees only requests
// for in-scope employees (never the whole tenant — F1 IDOR posture, mirrors the
// register). A request is "open" iff generatedDocumentId is null AND status is not
// REJECTED/CANCELLED (the fulfilment hook sets generatedDocumentId + APPROVED).
const OPEN_REQUEST_WHERE = {
  generatedDocumentId: null,
  status: { notIn: ['REJECTED', 'CANCELLED'] },
};

// Build the scope-constrained where for the letter-requests queue. ALL ⇒ tenant
// only; a narrower band ⇒ restrict to in-scope employeeIds (NONE ⇒ empty set →
// matches nothing). DocumentRequest always has an employeeId (no company-wide rows),
// so — unlike the register — we do NOT add an `employeeId: null` branch.
async function requestScopeWhere(req, businessId) {
  const where = { businessId, ...OPEN_REQUEST_WHERE };
  let scope = req.scope;
  if (!scope) scope = await resolveAccessibleEmployeeIds(req.user, 'canGenerateLetters');
  if (scope && scope.kind !== 'ALL') {
    const ids = scope.kind === 'IDS' && scope.ids ? [...scope.ids] : [];
    where.employeeId = { in: ids };
  }
  return where;
}

const REQUEST_KIND_LABELS = {
  OFFER_LETTER: 'Offer Letter', APPOINTMENT_LETTER: 'Appointment Letter',
  CONFIRMATION_LETTER: 'Confirmation Letter', PROMOTION_LETTER: 'Promotion Letter',
  RELIEVING_LETTER: 'Relieving Letter', EXPERIENCE_LETTER: 'Experience Certificate',
  SALARY_CERTIFICATE: 'Salary Certificate', WARNING_LETTER: 'Warning Letter',
  PAYSLIP: 'Payslip', FORM16: 'Form 16', FNF_STATEMENT: 'Full & Final Statement',
  POLICY_ACK: 'Policy Acknowledgement', OTHER: 'Letter',
};

async function requestsQueue(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = await requestScopeWhere(req, businessId);
    const rows = await prisma.documentRequest.findMany({
      where,
      orderBy: { createdAt: 'asc' }, // oldest first — work the queue FIFO
      take: 200,
      select: {
        id: true, templateKind: true, purpose: true, status: true, createdAt: true,
        employee: { select: { id: true, firstName: true, lastName: true, code: true } },
      },
    });
    const items = rows.map((r) => ({
      id: r.id,
      templateKind: r.templateKind,
      templateKindLabel: REQUEST_KIND_LABELS[r.templateKind] || r.templateKind,
      purpose: r.purpose || null,
      status: r.status,
      createdAt: r.createdAt,
      employee: r.employee ? {
        id: r.employee.id,
        name: [r.employee.firstName, r.employee.lastName].filter(Boolean).join(' ').trim(),
        code: r.employee.code,
      } : null,
    }));
    return res.json({ items, total: items.length });
  } catch (err) { return next(err); }
}

// ── GET /requests/count — pending-request badge count (scope-constrained) ─────
async function requestsCount(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = await requestScopeWhere(req, businessId);
    const count = await prisma.documentRequest.count({ where });
    return res.json({ count });
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
  requestsQueue,
  requestsCount,
  _internals: { toCsv, publicRow, letterBytes, resolveIssuers, issuerName, requestScopeWhere },
};
