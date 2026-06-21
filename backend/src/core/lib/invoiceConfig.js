//
// invoiceConfig.js — seller details + GST settings for the SELF-BILLED India
// (Razorpay) tax invoice. The India GST entity is Paperbyte Technologies Pvt
// Ltd. Stripe (NZ) and Paddle (rest of world) are issued by the NZ entity
// (Loominfo Ltd) on the gateway side — this file only feeds the India invoice.
//

const SELLER = Object.freeze({
  legalName: 'Paperbyte Technologies Private Limited',
  // Registered place of business shown on the invoice (legal name is rendered
  // separately above these lines, so it's not repeated here).
  addressLines: [
    'Supertech Livingston, C1 501',
    'Crossings Republik, Ghaziabad',
    'Uttar Pradesh 201016, India',
  ],
  gstin: '09AAMCP6969N1Z8',     // state code 09 = Uttar Pradesh
  stateName: 'Uttar Pradesh',
  stateCode: '09',
  // Services Accounting Code for a SaaS subscription (right to use software).
  sacCode: '997331',
  sacDescription: 'Licensing services for the right to use computer software',
  email: 'support@sitepresso.com',
  // Optional company / CIN number printed under the name. Leave '' to hide.
  companyNumber: '',
});

const GST = Object.freeze({
  // SaaS in India is taxed at 18%.
  ratePct: 18,
  // How the GST relates to the amount actually charged by the gateway.
  //   'INCLUSIVE_OF_CHARGE' — the captured amount already includes GST; we
  //       decompose it (base = amount / 1.18, gst = amount − base). This makes
  //       the invoice total ALWAYS equal what was charged and needs NO change to
  //       the Razorpay plan amounts. (Current safe default.)
  //   'ADDED_ON_TOP' — only valid if the Razorpay plan amounts were grossed up
  //       by 18% so the gateway actually captured price×1.18. Not enabled until
  //       the India catalog is re-published.
  basis: 'INCLUSIVE_OF_CHARGE',
});

const NUMBERING = Object.freeze({
  // Sequential, gapless series. {fy} is the Indian financial year (Apr–Mar),
  // {n} is the zero-padded counter. Series key is per financial year.
  prefix: 'SP',
  // e.g. SP/26-27/000001
  format: ({ prefix, fy, n }) => `${prefix}/${fy}/${String(n).padStart(6, '0')}`,
});

// Indian financial year string for a date, e.g. 2026-06 → "26-27", 2026-02 → "25-26".
function indianFinancialYear(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0=Jan; Indian FY starts in April (m>=3)
  const startYear = m >= 3 ? y : y - 1;
  const endYear = startYear + 1;
  return `${String(startYear).slice(-2)}-${String(endYear).slice(-2)}`;
}

module.exports = { SELLER, GST, NUMBERING, indianFinancialYear };
