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
    const detail = await service.computeRun({ businessId, actorId, payRunId: req.params.id });
    res.json(detail);
  } catch (err) { handleError(res, err); }
}

async function approveRun(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const fourEyes = req.body && req.body.fourEyes === false ? false : true;
    const detail = await service.approveRun({ businessId, actorId, payRunId: req.params.id, fourEyes });
    res.json(detail);
  } catch (err) { handleError(res, err); }
}

async function listRuns(req, res) {
  try {
    const { businessId } = req.user;
    const { entityId, status, page, pageSize } = req.query;
    const out = await service.listRuns({ businessId, entityId, status, page, pageSize });
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

module.exports = {
  createRun,
  computeRun,
  approveRun,
  listRuns,
  getRun,
  getRunPayslips,
  getPayslip,
  getFile,
  getMyPayslips,
  getMyPayslip,
};
