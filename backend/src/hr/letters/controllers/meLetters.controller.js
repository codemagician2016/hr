'use strict';

/**
 * meLetters.controller.js — Employee Self-Service (ESS) "My Letters" surface
 * (Feature 09 §3.6, §4.5 ESS table, §5.2, slice 9F). Mounted at /api/hr/me/letters.
 *
 * SELF-ONLY by construction (mirror of meDocuments / meSeparation / mePayslips):
 * the subject employee is resolved ENTIRELY from the CUSTOMER session
 * (workEmail / personalEmail / linked User). There is NO `:employeeId` in any
 * path, so a cross-employee read is structurally impossible. Cross-tenant is
 * blocked by `businessId` on every where-clause. An out-of-band letter id (another
 * employee's, another tenant's, or a non-ISSUED/voided one) resolves to 404 — never
 * a 403 wall (F1 IDOR posture).
 *
 *   GET  /                 → the caller's own ISSUED, non-voided IssuedLetter rows,
 *                            with the `fileHash` integrity/tamper anchor for the ESS badge.
 *   GET  /:id/download     → stream the caller's own issued letter PDF (self-only;
 *                            out-of-band ⇒ 404). Honours the F4 ESS terminated-employee
 *                            posture: reads of final letters stay open (relieving/experience
 *                            are exactly what a leaver needs post-exit).
 *   POST /requests         → ask HR for a letter (reuses DocumentRequest → HR queue).
 *                            A WRITE → blocked for a separated (TERMINATED/RETIRED/inactive)
 *                            leaver, matching the F4 ESS-lockout window (read-only stays open).
 *
 * DocumentRequest fulfilment hook (`fulfilLetterRequest`) is exported for the 9E
 * issuance path to call when HR issues a letter against an ESS request: it links the
 * IssuedLetter ↔ DocumentRequest, copies the letter's EmployeeDocument onto
 * DocumentRequest.generatedDocumentId, and advances the request status.
 */

const prisma = require('../../../core/lib/prisma');
const { isOurUrl } = require('../../../core/lib/s3');

// ── self-resolution (mirror of documents/meSeparation resolveSelfEmployee) ───
// A customer's portal identity links to an Employee via matching workEmail /
// personalEmail, or via the linked User. Tenant-scoped. Returns the row we need
// (id + the directory-status bits for the lockout check) or null.
async function resolveSelfEmployee(businessId, customer) {
  if (!customer || !customer.email) return null;
  const select = { id: true, status: true, isActive: true };
  const byEmail = await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, OR: [{ workEmail: customer.email }, { personalEmail: customer.email }] },
    select,
  });
  if (byEmail) return byEmail;
  const byUser = await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, user: { is: { email: customer.email } } },
    select,
  });
  return byUser || null;
}

// F4 ESS-lockout posture: a TERMINATED/RETIRED (or deactivated) leaver keeps NO
// WRITE surface; READ of their final letters stays open (relieving/experience are
// exactly what they need post-exit). Mirrors meSeparation.isSeparatedEmployee.
const SEPARATED_STATUSES = new Set(['TERMINATED', 'RETIRED']);
function isSeparatedEmployee(employee) {
  if (!employee) return false;
  if (employee.isActive === false) return true;
  return SEPARATED_STATUSES.has(employee.status);
}

// What the ESS list/download considers "the employee's own, currently valid"
// letter: ISSUED and not voided. DRAFT / PENDING_SIGNATURE / VOIDED never surface.
function myLetterWhere(businessId, employeeId) {
  return { businessId, employeeId, status: 'ISSUED', voidedAt: null };
}

function serializeLetter(l) {
  return {
    id: l.id,
    referenceNo: l.referenceNo,
    category: l.category,
    subject: l.subject,
    status: l.status,
    fileHash: l.fileHash || null,   // ESS tamper/integrity badge anchor
    mimeType: l.mimeType || 'application/pdf',
    sizeBytes: l.sizeBytes || null,
    issuedAt: l.issuedAt || null,
    createdAt: l.createdAt,
    // a struck-through hint is only meaningful in the register; the ESS list filters
    // voided out, but we expose the flag for completeness/forward-compat.
    voided: !!l.voidedAt,
  };
}

// GET / — the caller's OWN ISSUED, non-voided letters. Subject is session-derived;
// no id from the body → a cross-employee read is structurally impossible.
async function listMyLetters(req, res, next) {
  try {
    const { businessId } = req.customer;
    const employee = await resolveSelfEmployee(businessId, req.customer);
    if (!employee) return res.json({ items: [], total: 0 });

    const rows = await prisma.issuedLetter.findMany({
      where: myLetterWhere(businessId, employee.id),
      orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
    });
    const items = rows.map(serializeLetter);
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

// GET /:id/download — stream the caller's own issued letter PDF (self-only).
// An out-of-band id (another employee's, another tenant's, draft/voided) ⇒ 404.
async function downloadMyLetter(req, res, next) {
  try {
    const { businessId } = req.customer;
    const employee = await resolveSelfEmployee(businessId, req.customer);
    // No linked employee → nothing is "theirs" → 404 (never 403).
    if (!employee) return res.status(404).json({ message: 'Letter not found' });

    const letter = await prisma.issuedLetter.findFirst({
      where: { id: req.params.id, ...myLetterWhere(businessId, employee.id) },
    });
    if (!letter || !letter.fileUrl) return res.status(404).json({ message: 'Letter not found' });

    const fileName = `${(letter.referenceNo || letter.id).replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`;
    const mime = letter.mimeType || 'application/pdf';

    // The issued PDF is stored either inline as a base64 data URL (S3-not-configured
    // fallback) or as an object-storage URL (our bucket). Inline → decode + stream;
    // our bucket → redirect (the object is public/immutable). A non-data, non-ours
    // URL is refused (SSRF guard — we never proxy arbitrary URLs).
    if (letter.fileUrl.startsWith('data:')) {
      const m = /^data:([^;]+);base64,(.+)$/s.exec(letter.fileUrl);
      if (!m) return res.status(404).json({ message: 'Letter not found' });
      const buffer = Buffer.from(m[2], 'base64');
      res.setHeader('Content-Type', m[1] || mime);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Length', buffer.length);
      return res.send(buffer);
    }
    if (isOurUrl(letter.fileUrl)) {
      return res.redirect(letter.fileUrl);
    }
    return res.status(404).json({ message: 'Letter not found' });
  } catch (e) { next(e); }
}

// POST /requests — ask HR for a letter (reuses DocumentRequest → HR queue).
// A WRITE → blocked for a separated leaver (F4 ESS-lockout window: read-only stays
// open, write surface is closed). Validates templateKind against the enum.
const TEMPLATE_KINDS = new Set([
  'OFFER_LETTER', 'APPOINTMENT_LETTER', 'CONFIRMATION_LETTER', 'PROMOTION_LETTER',
  'RELIEVING_LETTER', 'EXPERIENCE_LETTER', 'SALARY_CERTIFICATE', 'WARNING_LETTER',
  'PAYSLIP', 'FORM16', 'FNF_STATEMENT', 'POLICY_ACK', 'OTHER',
]);

async function createLetterRequest(req, res, next) {
  try {
    const { businessId } = req.customer;
    const employee = await resolveSelfEmployee(businessId, req.customer);
    if (!employee) return res.status(404).json({ message: 'No employee record is linked to your account' });
    // F4 ESS-lockout: a separated leaver cannot open a new request (write surface closed).
    if (isSeparatedEmployee(employee)) {
      return res.status(403).json({ message: 'Your account is no longer active; this action is unavailable', reason: 'separated' });
    }

    const { templateKind, purpose } = req.body || {};
    if (!templateKind) return res.status(400).json({ message: 'templateKind is required' });
    if (!TEMPLATE_KINDS.has(templateKind)) {
      return res.status(422).json({ message: `Invalid templateKind: ${templateKind}`, types: [...TEMPLATE_KINDS] });
    }

    const created = await prisma.documentRequest.create({
      data: { businessId, employeeId: employee.id, templateKind, purpose: purpose ? String(purpose).slice(0, 2000) : null, status: 'PENDING' },
    });
    res.status(201).json(created);
  } catch (e) { next(e); }
}

// ── DocumentRequest fulfilment hook (Feature 09 §3.6, §8 slice 9F) ───────────
//
// Called by the 9E issuance path when HR issues a letter against an ESS letter
// request. Links the IssuedLetter ↔ DocumentRequest (IssuedLetter.documentRequestId),
// copies the letter's EmployeeDocument onto DocumentRequest.generatedDocumentId, and
// advances the request status to "fulfilled".
//
// MERGE TODO (9E / 9A coordination): the spec (§3.6) flips DocumentRequest.status →
// FULFILLED, but the live `RequestStatus` enum (schema L9012) is
// PENDING/APPROVED/REJECTED/CANCELLED — there is NO `FULFILLED` value and I must NOT
// touch schema.prisma (9A owns it). I therefore use APPROVED as the terminal
// "HR-fulfilled" status, with `generatedDocumentId` set as the authoritative
// fulfilment signal (a request is "fulfilled" iff generatedDocumentId != null). When
// 9A adds a FULFILLED enum value at merge, change the single `status: 'APPROVED'`
// literal below to `status: 'FULFILLED'`. The link writes (documentRequestId +
// generatedDocumentId) are status-independent and need no change.
//
// Designed to run INSIDE the issuance `$transaction`: pass the tx client as `db`
// (defaults to the shared prisma when omitted, e.g. a post-commit best-effort call).
// Idempotent + tenant-safe: only updates a PENDING request belonging to the same
// (businessId, employeeId) as the issued letter; a missing/foreign request is a no-op.
const FULFILLED_REQUEST_STATUS = 'APPROVED'; // MERGE TODO: → 'FULFILLED' once 9A adds the enum value

async function fulfilLetterRequest(db, { businessId, documentRequestId, issuedLetterId, employeeDocumentId, employeeId }) {
  const client = db || prisma;
  if (!documentRequestId) return { fulfilled: false, reason: 'no-request' };

  const where = { id: documentRequestId, businessId };
  if (employeeId) where.employeeId = employeeId;
  const request = await client.documentRequest.findFirst({ where });
  if (!request) return { fulfilled: false, reason: 'not-found' };

  await client.documentRequest.update({
    where: { id: request.id },
    data: {
      generatedDocumentId: employeeDocumentId || request.generatedDocumentId || null,
      status: FULFILLED_REQUEST_STATUS,
    },
  });
  if (issuedLetterId) {
    await client.issuedLetter.update({
      where: { id: issuedLetterId },
      data: { documentRequestId: request.id },
    });
  }
  return { fulfilled: true, documentRequestId: request.id, status: FULFILLED_REQUEST_STATUS };
}

module.exports = {
  // ESS self-service (customer session)
  listMyLetters,
  downloadMyLetter,
  createLetterRequest,
  // DocumentRequest fulfilment hook (called by 9E issuance — see MERGE TODO above)
  fulfilLetterRequest,
  // exported for reuse/tests
  resolveSelfEmployee,
  isSeparatedEmployee,
  FULFILLED_REQUEST_STATUS,
};
