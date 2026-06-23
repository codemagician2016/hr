'use strict';

/**
 * payroll.controller.js — thin HTTP layer over service.js (the orchestrator).
 *
 * Every operator handler is tenant-scoped by req.user.businessId; the ESS (/me)
 * handlers are scoped by req.customer.businessId (customer session). Controllers
 * carry NO payroll logic — they validate the request shape, call the service,
 * and translate a PayRunError into the right status code.
 */

const service = require('./service');

/** Translate a thrown error into an HTTP response (PayRunError carries a code). */
function handleError(res, err) {
  const status = err && err.statusCode ? err.statusCode
    : err && err.code && CODE_STATUS[err.code] ? CODE_STATUS[err.code]
    : 500;
  const body = { message: err && err.message ? err.message : 'Internal error' };
  if (err && err.code) body.code = err.code;
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
    const fourEyes = req.body && req.body.fourEyes === false ? false : true;
    const totalsHash = req.body && req.body.totalsHash ? req.body.totalsHash : undefined;
    const detail = await service.approveRun({ businessId, actorId, payRunId: req.params.id, fourEyes, totalsHash });
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
 * getMyPayslipPdf — the employee's OWN payslip rendered from its frozen snapshot.
 * Security fix (§6.6): the ESS download must serve the employee's payslip, NEVER
 * the run-level bank/statutory file. Server scopes to the employee + PUBLISHED.
 * We serve a clean text rendering of the snapshot (PDF binary generation is
 * out-of-scope per §3 — the snapshot is the source of truth).
 */
async function getMyPayslipPdf(req, res) {
  try {
    const { businessId } = req.customer;
    const payslip = await service.getMyPayslip({ businessId, customer: req.customer, payslipId: req.params.id });
    const snap = payslip.snapshotJson || {};
    const lines = [];
    lines.push(`PAYSLIP ${payslip.code}`);
    lines.push(`Period ${snap.periodStart || ''} - ${snap.periodEnd || ''}   Pay date ${snap.payDate || ''}`);
    lines.push('');
    lines.push('EARNINGS');
    for (const e of snap.earnings || []) lines.push(`  ${e.label || e.code}: ${snap.currencyCode} ${e.amount}`);
    lines.push(`  GROSS: ${snap.currencyCode} ${snap.gross}`);
    lines.push('');
    lines.push('DEDUCTIONS');
    for (const d of snap.employeeDeductions || []) lines.push(`  ${d.label || d.code}: ${snap.currencyCode} ${d.amount}`);
    lines.push(`  TOTAL DEDUCTIONS: ${snap.currencyCode} ${snap.totalDeductions}`);
    lines.push('');
    lines.push(`NET PAY: ${snap.currencyCode} ${snap.net}`);
    const body = lines.join('\n') + '\n';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${payslip.code}.txt"`);
    res.status(200).send(body);
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
