'use strict';

/**
 * payroll.controller.js — thin HTTP layer over service.js (the orchestrator).
 *
 * Every operator handler is tenant-scoped by req.user.businessId; the ESS (/me)
 * handlers are scoped by req.customer.businessId (customer session). Controllers
 * carry NO payroll logic — they validate the request shape, call the service,
 * and translate a PayRunError into the right status code.
 */

const crypto = require('crypto');
const service = require('./service');
const { renderPayslipPdf } = require('./payslipPdf');

/** Translate a thrown error into an HTTP response (PayRunError carries a code). */
function handleError(res, err) {
  const status = err && err.statusCode ? err.statusCode
    : err && err.code && CODE_STATUS[err.code] ? CODE_STATUS[err.code]
    : 500;
  const body = { message: err && err.message ? err.message : 'Internal error' };
  if (err && err.code) body.code = err.code;
  // Surface the structured bank-detail offender list so the operator UI can show
  // exactly which employees to fix (finding #22) — never a bare 500.
  if (err && Array.isArray(err.offenders)) body.offenders = err.offenders;
  if (status === 500) {
    // eslint-disable-next-line no-console
    console.error('[payroll.controller]', err && err.stack ? err.stack : err);
  }
  return res.status(status).json(body);
}

const CODE_STATUS = {
  NOT_FOUND: 404,
  MISSING_FIELDS: 400,
  BAD_STATE: 400,
  NOT_CALCULATED: 409,
  MAKER_CHECKER: 409,
  OPEN_BLOCKERS: 409,
  STALE_TRANSITION: 409,
  STALE_TOTALS: 409,
  NOT_REVIEWED: 409,
  CANNOT_CANCEL: 409,
  CANNOT_REOPEN: 409,
  CLOSE_BLOCKED: 409,
  ILLEGAL_TRANSITION: 409,
  IMMUTABLE_RUN_VIOLATION: 409,
  UNKNOWN_FILE_KIND: 400,
  COUNTRY_MISMATCH: 400,
  MISSING_BANK_DETAILS: 422,
  BANK_FIELD_TOO_LONG: 422,
};

// ── Operator: runs ──────────────────────────────────────────────────────────

async function createRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const { entityId, payCalendarId, periodStart, periodEnd } = req.body || {};
    const run = await service.createRun({ businessId, actorId, entityId, payCalendarId, periodStart, periodEnd });
    res.status(201).json(run);
  } catch (err) { handleError(res, err); }
}

async function computeRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    // Seam #1 fix: thread the freeze flag from HTTP so the operator can freeze
    // attendance atomically as part of compute (?freeze=1 or body.freezeAttendance).
    const freezeAttendance =
      (req.body && (req.body.freezeAttendance === true || req.body.freeze === true)) ||
      req.query.freeze === '1' || req.query.freeze === 'true';
    const detail = await service.computeRun({ businessId, actorId, payRunId: req.params.id, freezeAttendance });
    res.json(detail);
  } catch (err) { handleError(res, err); }
}

/** Dedicated freeze endpoint — compute with freezeAttendance:true. */
async function freezeRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const detail = await service.computeRun({ businessId, actorId, payRunId: req.params.id, freezeAttendance: true });
    res.json(detail);
  } catch (err) { handleError(res, err); }
}

async function approveRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    // SECURITY (finding #2 + #3): four-eyes and the totals-staleness check are
    // SERVER-SIDE invariants resolved inside the service from tenant policy +
    // persisted totals. The request body CANNOT supply fourEyes/totalsHash to
    // weaken separation-of-duties or the STALE_TOTALS gate. Any such field is
    // intentionally ignored here.
    const detail = await service.approveRun({ businessId, actorId, payRunId: req.params.id });
    res.json(detail);
  } catch (err) { handleError(res, err); }
}

async function listRuns(req, res) {
  try {
    const { businessId } = req.user;
    const { entityId, status, type, includeFnf, taxYear, page, pageSize } = req.query;
    const out = await service.listRuns({ businessId, entityId, status, type, includeFnf, taxYear, page, pageSize });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

// ── Feature 7 — run orchestration / lifecycle past APPROVED ──────────────────

async function listRunEntities(req, res) {
  try {
    const { businessId } = req.user;
    const out = await service.listRunEntities({ businessId });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function getInputsChecklist(req, res) {
  try {
    const { businessId } = req.user;
    const out = await service.getInputsChecklist({ businessId, payRunId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function upsertOneTimeInput(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.upsertOneTimeInput({ businessId, actorId, payRunId: req.params.id, item: req.body || {} });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function getVariance(req, res) {
  try {
    const { businessId } = req.user;
    const out = await service.computeVariance({ businessId, payRunId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function submitRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.submitRun({ businessId, actorId, payRunId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function sendBackRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.sendBackRun({ businessId, actorId, payRunId: req.params.id, reason: (req.body || {}).reason });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function publishRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.publishRun({ businessId, actorId, payRunId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function disburseRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.disburseRun({ businessId, actorId, payRunId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function fileRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.fileRun({ businessId, actorId, payRunId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function closeRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.closeRun({ businessId, actorId, payRunId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function cancelRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.cancelRun({ businessId, actorId, payRunId: req.params.id, reason: (req.body || {}).reason });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function reopenRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const out = await service.reopenRun({ businessId, actorId, payRunId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function getRun(req, res) {
  try {
    const { businessId } = req.user;
    const detail = await service.getRun({ businessId, payRunId: req.params.id });
    res.json(detail);
  } catch (err) { handleError(res, err); }
}

async function getRunPayslips(req, res) {
  try {
    const { businessId } = req.user;
    const out = await service.getRunPayslips({ businessId, payRunId: req.params.id });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function getPayslip(req, res) {
  try {
    const { businessId } = req.user;
    const payslip = await service.getPayslip({ businessId, payslipId: req.params.id });
    res.json(payslip);
  } catch (err) { handleError(res, err); }
}

/**
 * getPayslipPdf — operator payslip as a branded `application/pdf` (finding #23).
 *
 * The operator "View" used to open the raw JSON API in a new tab. This renders
 * the SAME branded PDF the employee sees, from the payslip's frozen snapshotJson
 * (immutable source of truth) — no stored blob, a fresh render per request.
 * Scoping is by req.user.businessId via service.getPayslipPdfContext, behind the
 * canViewPayrollReports route gate. The bytes' SHA-256 is recorded best-effort
 * as tamper evidence (mirrors the ESS path) and never blocks the download.
 */
async function getPayslipPdf(req, res) {
  try {
    const { businessId } = req.user;
    const { payslip, employee, business } = await service.getPayslipPdfContext({
      businessId, payslipId: req.params.id,
    });

    const pdf = await renderPayslipPdf({ payslip, employee, business });

    try {
      const pdfHash = crypto.createHash('sha256').update(pdf).digest('hex');
      await service.recordPayslipPdfHash({ businessId, payslipId: payslip.id, pdfHash });
    } catch (_e) { /* non-fatal */ }

    const fileName = `${payslip.code || 'payslip'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    // inline so the operator's "View" opens the PDF in the browser tab.
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Length', pdf.length);
    res.status(200).send(pdf);
  } catch (err) { handleError(res, err); }
}

async function getFile(req, res) {
  try {
    const { businessId } = req.user;
    const file = await service.generateFile({ businessId, payRunId: req.params.id, kind: req.params.kind });
    res.setHeader('Content-Type', file.contentType || 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('X-Payroll-File-Meta', Buffer.from(JSON.stringify(file.meta || {})).toString('base64'));
    res.status(200).send(file.content);
  } catch (err) { handleError(res, err); }
}

// ── ESS (customer session): own payslips ────────────────────────────────────

async function getMyPayslips(req, res) {
  try {
    const { businessId } = req.customer;
    const out = await service.getMyPayslips({ businessId, customer: req.customer });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

async function getMyPayslip(req, res) {
  try {
    const { businessId } = req.customer;
    const payslip = await service.getMyPayslip({ businessId, customer: req.customer, payslipId: req.params.id });
    res.json(payslip);
  } catch (err) { handleError(res, err); }
}

/**
 * getMyPayslipPdf — the employee's OWN payslip as a branded `application/pdf`.
 *
 * Security (§6.6): the ESS download serves the employee's OWN payslip, NEVER the
 * run-level bank/statutory file. ALL scoping flows through the existing secure
 * path service.getMyPayslipPdfContext -> getMyPayslip, which enforces
 * employee-own + PUBLISHED|VIEWED and marks first view. We then render the
 * frozen snapshotJson (the immutable source of truth) into a PDF on demand —
 * no S3, no stored blob; a fresh render per request. A SHA-256 of the bytes is
 * recorded as tamper evidence (best-effort; never blocks the download).
 */
async function getMyPayslipPdf(req, res) {
  try {
    const { businessId } = req.customer;
    const { payslip, employee, business } = await service.getMyPayslipPdfContext({
      businessId, customer: req.customer, payslipId: req.params.id,
    });

    const pdf = await renderPayslipPdf({ payslip, employee, business });

    // Tamper-evidence: persist the SHA-256 of the rendered bytes. Best-effort —
    // a write failure must NOT fail the employee's download.
    try {
      const pdfHash = crypto.createHash('sha256').update(pdf).digest('hex');
      await service.recordPayslipPdfHash({ businessId, payslipId: payslip.id, pdfHash });
    } catch (_e) { /* non-fatal */ }

    const fileName = `${payslip.code || 'payslip'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', pdf.length);
    res.status(200).send(pdf);
  } catch (err) { handleError(res, err); }
}

module.exports = {
  createRun,
  computeRun,
  freezeRun,
  approveRun,
  listRuns,
  getRun,
  getRunPayslips,
  getPayslip,
  getPayslipPdf,
  getFile,
  getMyPayslips,
  getMyPayslip,
  getMyPayslipPdf,
  // Feature 7 — run orchestration / lifecycle
  listRunEntities,
  getInputsChecklist,
  upsertOneTimeInput,
  getVariance,
  submitRun,
  sendBackRun,
  publishRun,
  disburseRun,
  fileRun,
  closeRun,
  cancelRun,
  reopenRun,
};
