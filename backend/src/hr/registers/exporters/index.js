'use strict';

/*
 * exporters/index.js — format dispatch for a projected register (Feature 32).
 * Each formatter returns the filing-module contract { fileName, contentType,
 * content }. PDF is async (pdfkit stream); CSV/XLSX are sync. `exportRegister`
 * normalises to a Promise.
 */

const { buildCsv } = require('./csvExport');
const { buildXlsx } = require('./xlsxExport');
const { buildPdf } = require('./pdfExport');

const FORMATS = Object.freeze(['PDF', 'XLSX', 'CSV']);

async function exportRegister(format, register, opts = {}) {
  const f = String(format || 'PDF').toUpperCase();
  if (f === 'CSV') return buildCsv(register, opts);
  if (f === 'XLSX') return buildXlsx(register, opts);
  if (f === 'PDF') return buildPdf(register, opts);
  const e = new Error(`Unsupported export format "${format}"`);
  e.code = 'BAD_FORMAT';
  throw e;
}

module.exports = { exportRegister, buildCsv, buildXlsx, buildPdf, FORMATS };
