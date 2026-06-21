//
// subscriptionInvoice.js — our own GST tax invoice for SELF-BILLED India
// (Razorpay) subscription charges. Assigns a gapless sequential number, computes
// the CGST/SGST-vs-IGST split, and renders a printable (A4) HTML invoice the
// buyer saves as PDF. Paddle/Stripe issue their own invoices elsewhere.
//
const prisma = require('./prisma');
const { SELLER, GST, NUMBERING, indianFinancialYear } = require('./invoiceConfig');

// ── invoice numbering ────────────────────────────────────────────────────────
// One gapless series per Indian financial year, assigned once per paid row.
async function ensureInvoiceNumber(paymentAttempt) {
  if (paymentAttempt.invoiceNumber) return paymentAttempt.invoiceNumber;
  const fy = indianFinancialYear(paymentAttempt.createdAt || new Date());
  const series = `IN-${fy}`;
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.paymentAttempt.findUnique({
      where: { id: paymentAttempt.id },
      select: { invoiceNumber: true },
    });
    if (fresh?.invoiceNumber) return fresh.invoiceNumber;
    const counter = await tx.invoiceCounter.upsert({
      where: { series },
      create: { series, lastValue: 1 },
      update: { lastValue: { increment: 1 } },
    });
    const number = NUMBERING.format({ prefix: NUMBERING.prefix, fy, n: counter.lastValue });
    await tx.paymentAttempt.update({ where: { id: paymentAttempt.id }, data: { invoiceNumber: number } });
    return number;
  });
}

// ── GST computation ──────────────────────────────────────────────────────────
// `basis` decides whether the captured amount already includes GST (default) or
// was grossed up. We currently always decompose the captured amount so the
// invoice total equals what the gateway charged.
function buyerStateCode({ taxId, state }) {
  const gstin = String(taxId || '').trim();
  if (/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]/.test(gstin)) return gstin.slice(0, 2);
  // Fall back to a name match for the seller's own state (intra-state).
  if (String(state || '').trim().toLowerCase() === SELLER.stateName.toLowerCase()) return SELLER.stateCode;
  return null; // unknown → treat as inter-state (IGST)
}

function computeGst({ amountMinor, taxId, state }) {
  const rate = GST.ratePct;
  const gross = Math.max(0, Math.round(Number(amountMinor) || 0));
  let taxableMinor;
  let gstMinor;
  if (GST.basis === 'ADDED_ON_TOP') {
    taxableMinor = gross;
    gstMinor = Math.round((gross * rate) / 100);
  } else {
    // INCLUSIVE_OF_CHARGE — back out the tax from the captured amount.
    taxableMinor = Math.round(gross / (1 + rate / 100));
    gstMinor = gross - taxableMinor;
  }
  const sellerCode = SELLER.stateCode;
  const code = buyerStateCode({ taxId, state });
  const intraState = code != null && code === sellerCode;
  if (intraState) {
    const cgstMinor = Math.floor(gstMinor / 2);
    return {
      rate,
      taxableMinor,
      intraState: true,
      cgstMinor,
      sgstMinor: gstMinor - cgstMinor,
      igstMinor: 0,
      gstMinor,
      totalMinor: taxableMinor + gstMinor,
    };
  }
  return {
    rate,
    taxableMinor,
    intraState: false,
    cgstMinor: 0,
    sgstMinor: 0,
    igstMinor: gstMinor,
    gstMinor,
    totalMinor: taxableMinor + gstMinor,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(minor) {
  return (Math.round(Number(minor) || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
// Indian-system rupees in words (used by GST invoices).
function rupeesInWords(minor) {
  const rupees = Math.floor((Math.round(Number(minor) || 0)) / 100);
  const paise = Math.round((Math.round(Number(minor) || 0)) % 100);
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n) => (n < 20 ? a[n] : `${b[Math.floor(n / 10)]}${n % 10 ? ' ' + a[n % 10] : ''}`);
  const three = (n) => (n >= 100 ? `${a[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' + two(n % 100) : ''}` : two(n));
  function words(n) {
    if (n === 0) return 'Zero';
    const crore = Math.floor(n / 10000000); n %= 10000000;
    const lakh = Math.floor(n / 100000); n %= 100000;
    const thousand = Math.floor(n / 1000); n %= 1000;
    const hundred = n;
    let out = '';
    if (crore) out += `${three(crore)} Crore `;
    if (lakh) out += `${two(lakh)} Lakh `;
    if (thousand) out += `${two(thousand)} Thousand `;
    if (hundred) out += three(hundred);
    return out.trim();
  }
  let str = `${words(rupees)} Rupees`;
  if (paise) str += ` and ${two(paise)} Paise`;
  return `${str} Only`;
}

// ── assemble + render ────────────────────────────────────────────────────────
function buildInvoiceData({ business, paymentAttempt, planName, invoiceNumber }) {
  const isBusiness = String(business.billingPurchaserType || 'INDIVIDUAL').toUpperCase() === 'BUSINESS';
  const buyerName = isBusiness
    ? (business.billingBusinessName || business.name || business.billingContactName || '')
    : (business.billingContactName || business.name || '');
  const buyerAddress = [
    business.billingAddressLine1,
    business.billingAddressLine2,
    [business.billingCity, business.billingState, business.billingPostalCode].filter(Boolean).join(', '),
  ].filter((l) => l && String(l).trim());
  const tax = computeGst({
    amountMinor: paymentAttempt.amountMinor,
    taxId: business.billingTaxId,
    state: business.billingState,
  });
  return {
    invoiceNumber,
    issuedAt: paymentAttempt.createdAt || new Date(),
    currency: (paymentAttempt.currencyCode || 'INR').toUpperCase(),
    buyer: {
      isBusiness,
      name: buyerName,
      email: business.billingEmail || business.email || '',
      gstin: isBusiness ? (business.billingTaxId || '') : '',
      addressLines: buyerAddress,
      placeOfSupply: business.billingState || business.state || '—',
    },
    line: {
      description: planName || 'Sitepresso subscription',
      sac: SELLER.sacCode,
      sacDescription: SELLER.sacDescription,
    },
    tax,
  };
}

function renderInvoiceHtml(d) {
  const sym = d.currency === 'INR' ? '₹' : `${d.currency} `;
  const taxRows = d.tax.intraState
    ? `<tr><td>CGST</td><td class="r">${d.tax.rate / 2}%</td><td class="r">${sym}${money(d.tax.cgstMinor)}</td></tr>
       <tr><td>SGST</td><td class="r">${d.tax.rate / 2}%</td><td class="r">${sym}${money(d.tax.sgstMinor)}</td></tr>`
    : `<tr><td>IGST</td><td class="r">${d.tax.rate}%</td><td class="r">${sym}${money(d.tax.igstMinor)}</td></tr>`;
  const sellerAddr = SELLER.addressLines.map((l) => esc(l)).join('<br>');
  const buyerAddr = d.buyer.addressLines.length ? d.buyer.addressLines.map((l) => esc(l)).join('<br>') : '<span class="muted">No address on file</span>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tax Invoice ${esc(d.invoiceNumber)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #111827; margin: 0; background: #f3f4f6; }
  .sheet { max-width: 800px; margin: 24px auto; background: #fff; padding: 40px; border: 1px solid #e5e7eb; border-radius: 8px; }
  .toolbar { max-width: 800px; margin: 16px auto 0; display: flex; justify-content: flex-end; }
  .btn { background: #4f46e5; color: #fff; border: 0; padding: 10px 18px; border-radius: 8px; font-weight: 600; font-size: 14px; cursor: pointer; }
  h1 { font-size: 22px; letter-spacing: .04em; margin: 0; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111827; padding-bottom: 16px; }
  .seller { font-size: 13px; line-height: 1.5; }
  .seller .name { font-weight: 700; font-size: 15px; }
  .meta { text-align: right; font-size: 13px; line-height: 1.7; }
  .meta .k { color: #6b7280; }
  .parties { display: flex; gap: 32px; margin-top: 24px; font-size: 13px; line-height: 1.5; }
  .parties h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; margin: 0 0 6px; }
  .parties .col { flex: 1; }
  table { width: 100%; border-collapse: collapse; margin-top: 24px; font-size: 13px; }
  th { text-align: left; background: #f9fafb; padding: 10px; border-bottom: 1px solid #e5e7eb; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; }
  td { padding: 10px; border-bottom: 1px solid #f3f4f6; }
  td.r, th.r { text-align: right; }
  .totals { width: 320px; margin-left: auto; margin-top: 8px; font-size: 13px; }
  .totals td { padding: 6px 10px; }
  .totals .grand td { font-weight: 700; font-size: 15px; border-top: 2px solid #111827; }
  .words { margin-top: 16px; font-size: 12px; color: #374151; }
  .foot { margin-top: 28px; font-size: 11px; color: #6b7280; line-height: 1.6; border-top: 1px solid #e5e7eb; padding-top: 14px; }
  .muted { color: #9ca3af; }
  @media print { body { background: #fff; } .toolbar { display: none; } .sheet { border: 0; margin: 0; max-width: none; padding: 0; } }
</style></head>
<body>
  <div class="toolbar"><button class="btn" onclick="window.print()">Print / Save as PDF</button></div>
  <div class="sheet">
    <div class="head">
      <div class="seller">
        <div class="name">${esc(SELLER.legalName)}</div>
        ${sellerAddr}<br>
        <strong>GSTIN:</strong> ${esc(SELLER.gstin)}${SELLER.companyNumber ? `<br><strong>CIN:</strong> ${esc(SELLER.companyNumber)}` : ''}
      </div>
      <div class="meta">
        <h1>TAX INVOICE</h1>
        <div><span class="k">Invoice #</span> <strong>${esc(d.invoiceNumber)}</strong></div>
        <div><span class="k">Date</span> ${esc(fmtDate(d.issuedAt))}</div>
        <div><span class="k">Place of supply</span> ${esc(d.buyer.placeOfSupply)}</div>
      </div>
    </div>

    <div class="parties">
      <div class="col">
        <h3>Bill to</h3>
        <strong>${esc(d.buyer.name) || '<span class="muted">Customer</span>'}</strong><br>
        ${buyerAddr}
        ${d.buyer.gstin ? `<br><strong>GSTIN:</strong> ${esc(d.buyer.gstin)}` : ''}
        ${d.buyer.email ? `<br>${esc(d.buyer.email)}` : ''}
      </div>
      <div class="col">
        <h3>Supply</h3>
        ${d.buyer.isBusiness ? 'B2B (registered business)' : 'B2C'}<br>
        Reverse charge: <strong>No</strong>
      </div>
    </div>

    <table>
      <thead><tr><th>Description</th><th>SAC</th><th class="r">Taxable value</th></tr></thead>
      <tbody>
        <tr>
          <td>${esc(d.line.description)}<br><span class="muted">${esc(d.line.sacDescription)}</span></td>
          <td>${esc(d.line.sac)}</td>
          <td class="r">${sym}${money(d.tax.taxableMinor)}</td>
        </tr>
      </tbody>
    </table>

    <table class="totals">
      <tr><td>Taxable value</td><td></td><td class="r">${sym}${money(d.tax.taxableMinor)}</td></tr>
      ${taxRows}
      <tr class="grand"><td>Total</td><td></td><td class="r">${sym}${money(d.tax.totalMinor)}</td></tr>
    </table>

    <div class="words"><strong>Amount in words:</strong> ${esc(rupeesInWords(d.tax.totalMinor))}</div>

    <div class="foot">
      Whether GST is payable on reverse charge basis: No.<br>
      This is a computer-generated invoice and does not require a physical signature.<br>
      Questions about this invoice? ${esc(SELLER.email)}
    </div>
  </div>
</body></html>`;
}

// Build a GSTR-1-style report of self-billed India invoices in a date range
// (for the platform owner / Paperbyte to file GST returns). Assigns an invoice
// number to any paid India row that lacks one (so the series stays complete),
// then computes the per-row tax breakdown.
async function buildIndiaGstReport({ from, to } = {}) {
  const where = { provider: 'razorpay', status: 'COMPLETED' };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(`${to}T23:59:59.999Z`);
  }
  const rows = await prisma.paymentAttempt.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    include: {
      business: {
        select: {
          name: true, email: true,
          billingPurchaserType: true, billingBusinessName: true, billingContactName: true,
          billingEmail: true, billingTaxId: true, billingState: true, billingCountry: true,
          billingAddressLine1: true, billingAddressLine2: true, billingCity: true, billingPostalCode: true,
          subscription: { select: { billingCycle: true, tier: { select: { name: true } } } },
        },
      },
    },
  });
  const out = [];
  for (const row of rows) {
    const invoiceNumber = await ensureInvoiceNumber(row);
    const planName = row.business?.subscription?.tier?.name || 'Subscription';
    const data = buildInvoiceData({ business: row.business || {}, paymentAttempt: row, planName, invoiceNumber });
    out.push({
      invoiceNumber,
      date: row.createdAt ? row.createdAt.toISOString().slice(0, 10) : '',
      type: data.buyer.isBusiness ? 'B2B' : 'B2C',
      buyerName: data.buyer.name,
      buyerGstin: data.buyer.gstin || '',
      placeOfSupply: data.buyer.placeOfSupply,
      currency: data.currency,
      taxableMinor: data.tax.taxableMinor,
      cgstMinor: data.tax.cgstMinor,
      sgstMinor: data.tax.sgstMinor,
      igstMinor: data.tax.igstMinor,
      gstRate: data.tax.rate,
      totalMinor: data.tax.totalMinor,
    });
  }
  return out;
}

module.exports = { ensureInvoiceNumber, computeGst, buildInvoiceData, renderInvoiceHtml, rupeesInWords, buildIndiaGstReport };
