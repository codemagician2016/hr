'use strict';

/*
 * xlsxExport.js — Excel formatter for a projected register (Feature 32).
 *
 * Uses `xlsx` (declared in backend/package.json as ^0.18.5) when present. Because
 * `xlsx` is an OPTIONAL dependency (not always installed in every environment),
 * this module LAZILY requires it and FALLS BACK to the CSV exporter when it is
 * unavailable — so the export endpoint always succeeds with a valid spreadsheet-
 * openable file and we add NO hard new dependency. Returns the filing contract
 * { fileName, contentType, content (Buffer) }.
 */

const { buildCsv } = require('./csvExport');

function tryRequireXlsx() {
  try {
    // eslint-disable-next-line global-require
    return require('xlsx');
  } catch (_e) {
    return null;
  }
}

function titleAoa(register, header) {
  const meta = register.meta || {};
  const aoa = [];
  aoa.push([meta.formLabel || 'Statutory Register']);
  if (meta.actLabel) aoa.push([meta.actLabel]);
  if (header) {
    const name = header.tradeName || header.legalName || '';
    if (name) aoa.push([`Establishment: ${name}`]);
    const addr = [header.addressLine1, header.addressLine2, header.city, header.stateCode, header.postalCode].filter(Boolean).join(', ');
    if (addr) aoa.push([`Address: ${addr}`]);
    const regs = [];
    if (header.pan) regs.push(`PAN ${header.pan}`);
    if (header.tan) regs.push(`TAN ${header.tan}`);
    if (regs.length) aoa.push([regs.join('  ')]);
  }
  if (meta.periodLabel) aoa.push([`Period: ${meta.periodLabel}`]);
  aoa.push([]); // blank separator
  return aoa;
}

/**
 * buildXlsx(register, opts) → { fileName, contentType, content }.
 * Falls back to CSV (with a .csv name + text/csv type) when xlsx is unavailable.
 */
function buildXlsx(register, opts = {}) {
  const XLSX = tryRequireXlsx();
  if (!XLSX) {
    // graceful degrade — still a spreadsheet-openable artefact.
    return buildCsv(register, opts);
  }

  const columns = register.columns || [];
  const rows = register.rows || [];
  const totals = (register.totals && register.totals.byColumn) || {};

  const aoa = titleAoa(register, opts.header);
  aoa.push(columns.map((c) => c.label));
  for (const r of rows) {
    aoa.push((r.cells || []).map((cell) => (cell && cell.text != null ? cell.text : '')));
  }
  const hasTotals = columns.some((c) => totals[c.key]);
  if (hasTotals) {
    aoa.push(columns.map((c, i) => (i === 0 ? 'TOTAL' : (totals[c.key] ? totals[c.key].display : ''))));
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Column widths from label length (a reasonable default).
  ws['!cols'] = columns.map((c) => ({ wch: Math.max(8, Math.min(40, String(c.label).length + 4)) }));
  const wb = XLSX.utils.book_new();
  const sheetName = String((register.meta && register.meta.formCode) || 'Register').slice(0, 31);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fileBase = opts.fileBase || `register_${(register.meta && register.meta.formCode) || 'export'}`;
  return {
    fileName: `${fileBase}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: buf,
  };
}

module.exports = { buildXlsx };
