//
// gstReport.controller.js — platform-owner (super-admin) GST reporting.
// Exports the self-billed India (Paperbyte) tax invoices for a period as CSV,
// ready to reconcile against GSTR-1 (B2B + B2C, with buyer GSTIN + tax split).
//
const { buildIndiaGstReport } = require('../../core/lib/subscriptionInvoice');

function csvCell(value) {
  return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
}
function money(minor) {
  return (Math.round(Number(minor) || 0) / 100).toFixed(2);
}

// GET /api/admin/gst/india-invoices?from=YYYY-MM-DD&to=YYYY-MM-DD
async function getIndiaGstReport(req, res) {
  const from = String(req.query.from || '').trim() || null;
  const to = String(req.query.to || '').trim() || null;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !dateRe.test(from)) || (to && !dateRe.test(to))) {
    return res.status(400).json({ message: 'from/to must be YYYY-MM-DD dates.' });
  }

  const rows = await buildIndiaGstReport({ from, to });

  // JSON for a UI preview; CSV (default) for filing.
  if (String(req.query.format || 'csv').toLowerCase() === 'json') {
    return res.json({ from, to, count: rows.length, rows });
  }

  const header = [
    'Invoice No', 'Date', 'Type', 'Buyer', 'Buyer GSTIN', 'Place of supply',
    'Taxable', 'CGST', 'SGST', 'IGST', 'GST %', 'Total', 'Currency',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.invoiceNumber, r.date, r.type, r.buyerName, r.buyerGstin, r.placeOfSupply,
      money(r.taxableMinor), money(r.cgstMinor), money(r.sgstMinor), money(r.igstMinor),
      r.gstRate, money(r.totalMinor), r.currency,
    ].map(csvCell).join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="india-gst-${from || 'all'}-to-${to || 'all'}.csv"`);
  return res.send(lines.join('\n'));
}

module.exports = { getIndiaGstReport };
