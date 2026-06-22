'use strict';
// Employee documents + document requests. Tenant-scoped by req.user.businessId and
// always further scoped to a single employee (the :employeeId route param). Two
// resources:
//   - EmployeeDocument: upload metadata (type, name, url, issuedAt, expiresAt).
//     Soft-deleted via deletedAt. Reads are expiry-aware: each row is annotated
//     with `expired` / `expiringSoon`, and the list supports an `expiring` filter.
//   - DocumentRequest: an employee asks HR for a document (e.g. an employment
//     letter). HR fulfils it, which transitions status and (optionally) links the
//     produced EmployeeDocument. Lifecycle: PENDING -> IN_PROGRESS -> FULFILLED,
//     or PENDING/IN_PROGRESS -> REJECTED / CANCELLED.
//
// NOTE: the EmployeeDocument and DocumentRequest models are declared as relations
// on Business/Employee in schema.prisma but their `model` blocks are not yet
// written. This controller targets the delegates those relations imply
// (`prisma.employeeDocument`, `prisma.documentRequest`) and the field shape
// documented in the route file / module notes. It follows the AppointmentDocument
// convention of string-typed `type`/`status` columns so no new enums are required.
const prisma = require('../../core/lib/prisma');

// Default window (days) within which an unexpired document counts as "expiring soon".
const DEFAULT_EXPIRING_DAYS = 30;

// ---- EmployeeDocument ------------------------------------------------------

const DOC_WRITABLE = ['type', 'name', 'url', 'fileName', 'mimeType', 'fileSize', 'notes', 'issuedAt', 'expiresAt'];
const DOC_DATE_FIELDS = ['issuedAt', 'expiresAt'];

function pickDoc(body) {
  const out = {};
  for (const f of DOC_WRITABLE) if (body[f] !== undefined) out[f] = body[f];
  for (const d of DOC_DATE_FIELDS) if (out[d] != null) out[d] = new Date(out[d]);
  return out;
}

// Annotate a document row with expiry state relative to `now` / a soon-window.
function annotateExpiry(doc, now, soonMs) {
  const exp = doc.expiresAt ? new Date(doc.expiresAt) : null;
  const expired = !!(exp && exp.getTime() < now);
  const expiringSoon = !!(exp && !expired && exp.getTime() - now <= soonMs);
  return { ...doc, expired, expiringSoon };
}

// Resolve and tenant-scope the employee referenced by the route. Returns the
// employee row, or null if it does not belong to this tenant.
async function findEmployee(businessId, employeeId) {
  return prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null } });
}

async function listDocuments(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;
    const emp = await findEmployee(businessId, employeeId);
    if (!emp) return res.status(404).json({ message: 'Employee not found' });

    const { type, q, expiring, page = '1', pageSize = '25' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const soonDays = Math.max(parseInt(req.query.expiringDays, 10) || DEFAULT_EXPIRING_DAYS, 0);
    const now = Date.now();
    const soonMs = soonDays * 24 * 60 * 60 * 1000;

    const where = { businessId, employeeId, deletedAt: null };
    if (type) where.type = type;
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { type: { contains: q, mode: 'insensitive' } },
      ];
    }
    // `expiring=true` restricts to docs whose expiry falls within the soon-window
    // (still in the future). `expiring=expired` restricts to already-expired docs.
    if (expiring === 'true') {
      where.expiresAt = { gte: new Date(now), lte: new Date(now + soonMs) };
    } else if (expiring === 'expired') {
      where.expiresAt = { lt: new Date(now) };
    }

    const [rows, total] = await Promise.all([
      prisma.employeeDocument.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.employeeDocument.count({ where }),
    ]);
    const items = rows.map((d) => annotateExpiry(d, now, soonMs));
    res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take });
  } catch (e) { next(e); }
}

async function getDocument(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, id } = req.params;
    const doc = await prisma.employeeDocument.findFirst({
      where: { id, businessId, employeeId, deletedAt: null },
    });
    if (!doc) return res.status(404).json({ message: 'Document not found' });
    res.json(annotateExpiry(doc, Date.now(), DEFAULT_EXPIRING_DAYS * 24 * 60 * 60 * 1000));
  } catch (e) { next(e); }
}

async function createDocument(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;
    const emp = await findEmployee(businessId, employeeId);
    if (!emp) return res.status(404).json({ message: 'Employee not found' });

    const { type, name, url } = req.body;
    if (!type || !name || !url) {
      return res.status(400).json({ message: 'type, name and url are required' });
    }
    const data = { ...pickDoc(req.body), businessId, employeeId, uploadedById: req.user.id };
    const doc = await prisma.employeeDocument.create({ data });
    res.status(201).json(doc);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A document with that identity already exists' });
    next(e);
  }
}

async function updateDocument(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, id } = req.params;
    const existing = await prisma.employeeDocument.findFirst({
      where: { id, businessId, employeeId, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ message: 'Document not found' });
    const doc = await prisma.employeeDocument.update({ where: { id }, data: pickDoc(req.body) });
    res.json(doc);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A document with that identity already exists' });
    next(e);
  }
}

async function removeDocument(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, id } = req.params;
    const existing = await prisma.employeeDocument.findFirst({
      where: { id, businessId, employeeId, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ message: 'Document not found' });
    await prisma.employeeDocument.update({ where: { id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// Tenant-wide expiry report across all employees: documents already expired or
// expiring within the window. Useful for an HR "documents needing attention"
// dashboard. Paginated; ordered by soonest expiry first.
async function expiringDocuments(req, res, next) {
  try {
    const { businessId } = req.user;
    const { page = '1', pageSize = '25' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const soonDays = Math.max(parseInt(req.query.expiringDays, 10) || DEFAULT_EXPIRING_DAYS, 0);
    const now = Date.now();
    const soonMs = soonDays * 24 * 60 * 60 * 1000;
    const includeExpired = req.query.includeExpired !== 'false';

    const upper = new Date(now + soonMs);
    const where = {
      businessId,
      deletedAt: null,
      expiresAt: includeExpired ? { not: null, lte: upper } : { gte: new Date(now), lte: upper },
    };

    const [rows, total] = await Promise.all([
      prisma.employeeDocument.findMany({ where, orderBy: { expiresAt: 'asc' }, skip, take }),
      prisma.employeeDocument.count({ where }),
    ]);
    const items = rows.map((d) => annotateExpiry(d, now, soonMs));
    res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take, windowDays: soonDays });
  } catch (e) { next(e); }
}

// ---- DocumentRequest -------------------------------------------------------

const REQ_WRITABLE = ['type', 'subject', 'purpose', 'notes'];

const REQ_OPEN_STATUSES = ['PENDING', 'IN_PROGRESS'];

function pickRequest(body) {
  const out = {};
  for (const f of REQ_WRITABLE) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

async function listRequests(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;
    const emp = await findEmployee(businessId, employeeId);
    if (!emp) return res.status(404).json({ message: 'Employee not found' });

    const { status, type, page = '1', pageSize = '25' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const where = { businessId, employeeId };
    if (status) where.status = status;
    if (type) where.type = type;

    const [items, total] = await Promise.all([
      prisma.documentRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.documentRequest.count({ where }),
    ]);
    res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take });
  } catch (e) { next(e); }
}

async function getRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, id } = req.params;
    const reqDoc = await prisma.documentRequest.findFirst({ where: { id, businessId, employeeId } });
    if (!reqDoc) return res.status(404).json({ message: 'Document request not found' });
    res.json(reqDoc);
  } catch (e) { next(e); }
}

async function createRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;
    const emp = await findEmployee(businessId, employeeId);
    if (!emp) return res.status(404).json({ message: 'Employee not found' });

    const { type } = req.body;
    if (!type) return res.status(400).json({ message: 'type is required' });

    const data = {
      ...pickRequest(req.body),
      businessId,
      employeeId,
      status: 'PENDING',
      requestedById: req.user.id,
    };
    const reqDoc = await prisma.documentRequest.create({ data });
    res.status(201).json(reqDoc);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A matching request already exists' });
    next(e);
  }
}

// Move an open request to IN_PROGRESS (HR has picked it up).
async function startRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, id } = req.params;
    const existing = await prisma.documentRequest.findFirst({ where: { id, businessId, employeeId } });
    if (!existing) return res.status(404).json({ message: 'Document request not found' });
    if (existing.status !== 'PENDING') {
      return res.status(409).json({ message: `Cannot start a request in status ${existing.status}` });
    }
    const reqDoc = await prisma.documentRequest.update({
      where: { id },
      data: { status: 'IN_PROGRESS', handledById: req.user.id },
    });
    res.json(reqDoc);
  } catch (e) { next(e); }
}

// Fulfil a request: transition to FULFILLED and optionally link the produced
// EmployeeDocument (must already exist, belong to this tenant + employee).
async function fulfilRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, id } = req.params;
    const existing = await prisma.documentRequest.findFirst({ where: { id, businessId, employeeId } });
    if (!existing) return res.status(404).json({ message: 'Document request not found' });
    if (!REQ_OPEN_STATUSES.includes(existing.status)) {
      return res.status(409).json({ message: `Cannot fulfil a request in status ${existing.status}` });
    }

    const data = {
      status: 'FULFILLED',
      handledById: req.user.id,
      fulfilledAt: new Date(),
    };
    if (req.body.notes !== undefined) data.notes = req.body.notes;

    const { documentId } = req.body;
    if (documentId) {
      const doc = await prisma.employeeDocument.findFirst({
        where: { id: documentId, businessId, employeeId, deletedAt: null },
      });
      if (!doc) return res.status(400).json({ message: 'Linked document not found for this employee' });
      data.documentId = documentId;
    }

    const reqDoc = await prisma.documentRequest.update({ where: { id }, data });
    res.json(reqDoc);
  } catch (e) { next(e); }
}

// Reject or cancel an open request. `reason` is recorded in notes.
async function rejectRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, id } = req.params;
    const existing = await prisma.documentRequest.findFirst({ where: { id, businessId, employeeId } });
    if (!existing) return res.status(404).json({ message: 'Document request not found' });
    if (!REQ_OPEN_STATUSES.includes(existing.status)) {
      return res.status(409).json({ message: `Cannot reject a request in status ${existing.status}` });
    }
    const data = { status: 'REJECTED', handledById: req.user.id };
    if (req.body.reason !== undefined) data.notes = req.body.reason;
    const reqDoc = await prisma.documentRequest.update({ where: { id }, data });
    res.json(reqDoc);
  } catch (e) { next(e); }
}

module.exports = {
  // EmployeeDocument
  listDocuments,
  getDocument,
  createDocument,
  updateDocument,
  removeDocument,
  expiringDocuments,
  // DocumentRequest
  listRequests,
  getRequest,
  createRequest,
  startRequest,
  fulfilRequest,
  rejectRequest,
};
