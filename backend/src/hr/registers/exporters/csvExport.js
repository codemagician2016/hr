'use strict';

/*
 * csvExport.js — CSV formatter for a projected register (Feature 32). PURE.
 *
 * Takes the projector's { columns, rows, totals, meta } and returns the
 * filing-module contract { fileName, contentType, content } (a Buffer-able
 * string). Reuses the csvCell() escaper shape from payroll/filing/india.js. A CSV
 * opens directly in Excel, satisfying the "Excel/CSV" export requirement without
 * a new dependency; the xlsx exporter falls back to this when xlsx is unavailable.
 */

/** RFC-4180 cell escaping (quote + double inner quotes when needed). */
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function titleBlockLines(register, header) {
  const meta = register.meta || {};
  const out = [];
  out.push([meta.formLabel || 'Statutory Register']);
  if (meta.actLabel) out.push([meta.actLabel]);
  if (header) {
    const name = header.tradeName || header.legalName || '';
    if (name) out.push([`Establishment: ${name}`]);
    const addr = [header.addressLine1, header.addressLine2, header.city, header.stateCode, header.postalCode].filter(Boolean).join(', ');
    if (addr) out.push([`Address: ${addr}`]);
    const regs = [];
    if (header.pan) regs.push(`PAN ${header.pan}`);
    if (header.tan) regs.push(`TAN ${header.tan}`);
    if (regs.length) out.push([regs.join('  ')]);
  }
  if (meta.periodLabel) out.push([`Period: ${meta.periodLabel}`]);
  return out;
}

/**
 * buildCsv(register, opts) → { fileName, contentType, content }.
 * @param {object} register  projector output { columns, rows, totals, meta }
 * @param {object} [opts]    { header (entity title block), fileBase }
 */
function buildCsv(register, opts = {}) {
  const columns = register.columns || [];
  const rows = register.rows || [];
  const totals = (register.totals && register.totals.byColumn) || {};
  const lines = [];

  // Title block (each on its own line, single cell).
  for (const tb of titleBlockLines(register, opts.header)) {
    lines.push(tb.map(csvCell).join(','));
  }
  lines.push(''); // blank separator

  // Header row.
  lines.push(columns.map((c) => csvCell(c.label)).join(','));

  // Body.
  for (const r of rows) {
    lines.push((r.cells || []).map((cell) => csvCell(cell && cell.text != null ? cell.text : '')).join(','));
  }

  // Control-totals footer (only under columns that have a total).
  const hasTotals = columns.some((c) => totals[c.key]);
  if (hasTotals) {
    lines.push(columns.map((c, i) => {
      if (i === 0) return csvCell('TOTAL');
      const t = totals[c.key];
      return csvCell(t ? t.display : '');
    }).join(','));
  }

  const fileBase = opts.fileBase || `register_${(register.meta && register.meta.formCode) || 'export'}`;
  return {
    fileName: `${fileBase}.csv`,
    contentType: 'text/csv; charset=utf-8',
    content: '﻿' + lines.join('\r\n'), // BOM so Excel renders ₹/½ correctly
  };
}

module.exports = { buildCsv, csvCell };
