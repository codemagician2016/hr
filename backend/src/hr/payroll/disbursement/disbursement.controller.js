'use strict';

/**
 * disbursement.controller.js — thin HTTP layer over disbursement.service.js for
 * India salary disbursement. Every handler is tenant-scoped by req.user.businessId;
 * the service throws PayRunError (reusing the payroll code vocabulary) which we map
 * to a status code here. Controllers carry NO disbursement logic.
 *
 * Routes (mounted in payroll.routes.js — a SHARED file, FLAGGED there):
 *   POST /runs/:id/disbursement          create a batch         canRunPayroll
 *   GET  /runs/:id/disbursement          list a run's batches   canViewPayrollReports
 *   GET  /disbursement/:batchId          batch + lines (paged)  canViewPayrollReports
 *   GET  /disbursement/:batchId/file     download advice file   canRunPayroll
 *   POST /disbursement/:batchId/reconcile apply UTR/status      canRunPayroll
 */

const service = require('./disbursement.service');

// Same mapping the payroll controller uses (kept local — that map isn't exported).
const CODE_STATUS = {
  NOT_FOUND: 404,
  MISSING_FIELDS: 400,
  BAD_STATE: 400,
  STALE_TOTALS: 409,
  COUNTRY_UNSUPPORTED: 422,
  MISSING_BANK_DETAILS: 422,
  UNKNOWN_BANK: 400,
  BAD_INPUT: 422,
  GATEWAY_NOT_IMPLEMENTED: 501,
};

function handleError(res, err) {
  const status = err && err.statusCode ? err.statusCode
    : err && err.code && CODE_STATUS[err.code] ? CODE_STATUS[err.code]
    : 500;
  const body = { message: err && err.message ? err.message : 'Internal error' };
  if (err && err.code) body.code = err.code;
  // Surface the structured flagged-employee list so the UI can show exactly who to fix.
  if (err && Array.isArray(err.offenders)) body.offenders = err.offenders;
  if (status === 500) {
    // eslint-disable-next-line no-console
    console.error('[disbursement.controller]', err && err.stack ? err.stack : err);
  }
  return res.status(status).json(body);
}

/** POST /runs/:id/disbursement — create a batch for the run on a bank rail. */
async function createBatch(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const { bank, debitAccount, valueDate, narration } = req.body || {};
    const batch = await service.createBatch({
      businessId, actorId, payRunId: req.params.id, bank, debitAccount, valueDate, narration,
    });
    res.status(201).json(batch);
  } catch (err) { handleError(res, err); }
}

/** GET /runs/:id/disbursement — list a run's batches (paginated). */
async function listBatches(req, res) {
  try {
    const { businessId } = req.user;
    const { page, pageSize } = req.query;
    const out = await service.listBatches({ businessId, payRunId: req.params.id, page, pageSize });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

/** GET /disbursement/:batchId — batch + per-employee lines (paginated). */
async function getBatch(req, res) {
  try {
    const { businessId } = req.user;
    const { page, pageSize } = req.query;
    const out = await service.getBatch({ businessId, batchId: req.params.batchId, page, pageSize });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

/** GET /disbursement/:batchId/file — download the bank salary-advice file. */
async function downloadFile(req, res) {
  try {
    const { businessId } = req.user;
    const file = await service.generateFile({ businessId, batchId: req.params.batchId });
    res.setHeader('Content-Type', file.contentType || 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('X-Payout-File-Meta', Buffer.from(JSON.stringify(file.meta || {})).toString('base64'));
    res.status(200).send(file.content);
  } catch (err) { handleError(res, err); }
}

/**
 * POST /disbursement/:batchId/reconcile — apply a UTR/status upload.
 *
 * Accepts EITHER a parsed `rows` array (JSON) OR a raw `csv` string (the bank's
 * UTR/status export). The CSV is parsed server-side into the row shape the
 * service expects: columns (case-insensitive) employeeCode|employeeId,
 * accountNumber, ifsc, status, utr, failureReason.
 */
async function reconcile(req, res) {
  try {
    const { businessId, id: actorId } = req.user;
    const body = req.body || {};
    let rows = Array.isArray(body.rows) ? body.rows : null;
    if (!rows && typeof body.csv === 'string') rows = parseReconcileCsv(body.csv);
    if (!rows) {
      return res.status(400).json({ message: 'Provide rows[] or a csv string to reconcile.', code: 'MISSING_FIELDS' });
    }
    const out = await service.reconcile({ businessId, actorId, batchId: req.params.batchId, rows });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

/**
 * parseReconcileCsv — minimal, dependency-free CSV → rows. Header-driven (maps the
 * known column aliases). Handles quoted cells + embedded commas. PURE-ish (no IO).
 */
function parseReconcileCsv(text) {
  const records = parseCsv(String(text));
  if (!records.length) return [];
  const header = records[0].map((h) => normalizeKey(h));
  const colIndex = (aliases) => {
    for (const a of aliases) { const i = header.indexOf(a); if (i !== -1) return i; }
    return -1;
  };
  const iEmpCode = colIndex(['employeecode', 'empcode', 'code', 'employeeid_code']);
  const iEmpId = colIndex(['employeeid', 'empid']);
  const iAcct = colIndex(['accountnumber', 'account', 'accountno', 'beneficiaryaccountno', 'accno']);
  const iIfsc = colIndex(['ifsc', 'ifsccode']);
  const iStatus = colIndex(['status', 'transactionstatus', 'paymentstatus']);
  const iUtr = colIndex(['utr', 'utrnumber', 'referenceno', 'reference', 'txnref']);
  const iReason = colIndex(['failurereason', 'reason', 'remarks', 'rejectreason']);

  const rows = [];
  for (let r = 1; r < records.length; r += 1) {
    const cells = records[r];
    if (!cells || cells.every((c) => String(c).trim() === '')) continue;
    rows.push({
      employeeCode: iEmpCode !== -1 ? trimOrUndef(cells[iEmpCode]) : undefined,
      employeeId: iEmpId !== -1 ? trimOrUndef(cells[iEmpId]) : undefined,
      accountNumber: iAcct !== -1 ? trimOrUndef(cells[iAcct]) : undefined,
      ifsc: iIfsc !== -1 ? trimOrUndef(cells[iIfsc]) : undefined,
      status: iStatus !== -1 ? trimOrUndef(cells[iStatus]) : undefined,
      utr: iUtr !== -1 ? trimOrUndef(cells[iUtr]) : undefined,
      failureReason: iReason !== -1 ? trimOrUndef(cells[iReason]) : undefined,
    });
  }
  return rows;
}

function normalizeKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function trimOrUndef(v) {
  const s = String(v == null ? '' : v).trim();
  return s === '' ? undefined : s;
}

/** Tiny RFC-4180-ish CSV parser (handles quotes, embedded commas + CRLF). */
function parseCsv(text) {
  const out = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else { field += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = ''; out.push(row); row = [];
    } else if (c === '\r') {
      // swallow; the \n handler closes the row
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); out.push(row); }
  return out;
}

module.exports = {
  createBatch,
  listBatches,
  getBatch,
  downloadFile,
  reconcile,
  _internals: { parseReconcileCsv, parseCsv },
};
