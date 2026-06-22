'use strict';

/**
 * integrations.controller.js — HTTP layer for HR integrations.
 *
 * Operator endpoints (req.user.businessId, RBAC via auth.middleware):
 *   GET  /api/hr/integrations/runs/:id/gl?format=xero|tally|zoho-json|zoho-csv
 *        → balanced GL journal export for a pay run, in the requested format.
 *   GET  /api/hr/integrations/runs/:id/gl/preview
 *        → the structured journal (lines + totals + balanced flag) — UI preview.
 *
 * Public read-only endpoints live in publicV1.routes.js / publicV1.controller.js.
 */

const payroll = require('../payroll/service');
const accounting = require('./accounting');

function handleError(res, err) {
  const status =
    err && err.statusCode ? err.statusCode :
    err && err.code === 'NOT_FOUND' ? 404 :
    err && (err.code === 'UNKNOWN_FORMAT') ? 400 :
    err && err.code === 'GL_UNBALANCED' ? 500 :
    500;
  if (status === 500) console.error('[hr.integrations.controller]', err && err.stack ? err.stack : err);
  return res.status(status).json({
    message: err && err.message ? err.message : 'Internal error',
    ...(err && err.code ? { code: err.code } : {}),
  });
}

// GET /runs/:id/gl?format=...
async function exportGl(req, res) {
  try {
    const businessId = req.user.businessId;
    const format = (req.query.format || 'xero').toString();
    const agg = await payroll.getRun({ businessId, payRunId: req.params.id });
    const out = accounting.exportRun(agg, format);
    res.type(out.contentType);
    if (typeof out.body === 'string') return res.send(out.body);
    return res.json(out.body);
  } catch (err) {
    return handleError(res, err);
  }
}

// GET /runs/:id/gl/preview — structured journal for UI (always JSON).
async function previewGl(req, res) {
  try {
    const businessId = req.user.businessId;
    const agg = await payroll.getRun({ businessId, payRunId: req.params.id });
    const journal = accounting.buildJournal(agg);
    return res.json({
      meta: journal.meta,
      currency: journal.currency,
      balanced: journal.balanced,
      totals: {
        debit: accounting.minorToStr(journal.totals.debitMinor),
        credit: accounting.minorToStr(journal.totals.creditMinor),
      },
      lines: journal.lines.map((l) => ({
        account: l.account,
        accountName: l.accountName,
        type: l.type,
        debit: l.debitMinor ? accounting.minorToStr(l.debitMinor) : null,
        credit: l.creditMinor ? accounting.minorToStr(l.creditMinor) : null,
      })),
      statutoryBreakdown: journal.statutoryBreakdown,
      formats: accounting.FORMATS,
    });
  } catch (err) {
    return handleError(res, err);
  }
}

module.exports = { exportGl, previewGl };
