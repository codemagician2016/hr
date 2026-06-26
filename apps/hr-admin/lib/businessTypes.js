// India business/entity types → which legal-registration fields apply.
// Source of truth for the company-profile form AND onboarding so a proprietor is
// never asked for a CIN, an LLP shows an LLPIN, etc. Storage stays generic: the
// primary registration id is saved in `registrationNo` (polymorphic — CIN /
// LLPIN / firm-reg / trust-reg), with `pan`, `tan`, `gstin`, `incorporationDate`
// universal. Only `businessType` (+ `proprietorName`) are new profile keys.
//
// Field rules below were web-researched + adversarially fact-checked against the
// Income-Tax PAN structure, MCA CIN/LLPIN formats and the RoF/RCS registries.

export const BUSINESS_TYPES = [
  { value: 'sole_proprietorship', label: 'Sole Proprietorship' },
  { value: 'partnership_firm', label: 'Partnership Firm' },
  { value: 'llp', label: 'Limited Liability Partnership (LLP)' },
  { value: 'private_limited', label: 'Private Limited Company' },
  { value: 'opc', label: 'One Person Company (OPC)' },
  { value: 'public_limited', label: 'Public Limited Company' },
  { value: 'section_8', label: 'Section 8 Company (Non-profit)' },
  { value: 'huf', label: 'Hindu Undivided Family (HUF)' },
  { value: 'trust', label: 'Trust' },
  { value: 'society', label: 'Society' },
  { value: 'cooperative_society', label: 'Cooperative Society' },
];

export const BUSINESS_TYPE_LABELS = Object.fromEntries(BUSINESS_TYPES.map((t) => [t.value, t.label]));

// Loose, warn-only formats (Indian govt formats drift; never hard-block a save).
export const FORMAT = {
  PAN: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
  TAN: /^[A-Z]{4}[0-9]{5}[A-Z]$/,
  GSTIN: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9][Zz][0-9A-Z]$/,
  CIN: /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/,
  LLPIN: /^[A-Z]{3}-?[0-9]{4}$/,
  PIN: /^[0-9]{6}$/,
};

const COMPANY = {
  legalNameLabel: 'Company legal name',
  legalNamePlaceholder: 'Acme Technologies Private Limited',
  primaryId: { show: true, key: 'registrationNo', label: 'CIN', placeholder: 'U72200MH2020PTC345678', hint: 'Corporate Identity Number issued by the MCA on incorporation (21 characters).', format: 'CIN' },
  pan: { label: 'Company PAN', placeholder: 'AAACX1234X', hint: "The company's 10-character PAN (4th character is ‘C’)." },
  incorporation: { show: true, label: 'Date of incorporation' },
  proprietor: false,
};

// Spec for the legal/registration block, by business type.
export function specForBusinessType(type) {
  switch (type) {
    case 'private_limited':
      return COMPANY;
    case 'opc':
      return { ...COMPANY, legalNamePlaceholder: 'Acme (OPC) Private Limited', primaryId: { ...COMPANY.primaryId, placeholder: 'U74999DL2021OPC123456' } };
    case 'public_limited':
      return { ...COMPANY, legalNamePlaceholder: 'Acme Industries Limited', primaryId: { ...COMPANY.primaryId, placeholder: 'L17110MH1973PLC019786' } };
    case 'section_8':
      return { ...COMPANY, legalNamePlaceholder: 'Acme Foundation', primaryId: { ...COMPANY.primaryId, placeholder: 'U85300KA2019NPL145678' } };
    case 'llp':
      return {
        legalNameLabel: 'LLP name', legalNamePlaceholder: 'Acme Advisory LLP',
        primaryId: { show: true, key: 'registrationNo', label: 'LLPIN', placeholder: 'AAB-1234', hint: 'LLP Identification Number issued by the MCA.', format: 'LLPIN' },
        pan: { label: 'LLP PAN', placeholder: 'AAAFL1234C', hint: "The LLP's PAN (4th character is ‘F’)." },
        incorporation: { show: true, label: 'Date of incorporation' },
        proprietor: false,
      };
    case 'partnership_firm':
      return {
        legalNameLabel: 'Firm name', legalNamePlaceholder: 'Sharma & Associates',
        primaryId: { show: true, key: 'registrationNo', label: 'Firm registration no. (RoF)', placeholder: 'If registered with the Registrar of Firms', hint: 'Only partnership firms registered with the Registrar of Firms have this — optional.' },
        pan: { label: 'Firm PAN', placeholder: 'AAAFL1234C', hint: "The firm's PAN (4th character is ‘F’)." },
        incorporation: { show: true, label: 'Date of formation' },
        proprietor: false,
      };
    case 'sole_proprietorship':
      return {
        legalNameLabel: 'Business / trade name', legalNamePlaceholder: 'Sharma Traders',
        primaryId: { show: false },
        pan: { label: "Proprietor's PAN (used as business PAN)", placeholder: 'ABCPK1234E', hint: 'A proprietorship has no separate PAN — it uses the proprietor’s own PAN (4th character ‘P’).' },
        incorporation: { show: true, label: 'Date of commencement of business' },
        proprietor: true,
      };
    case 'huf':
      return {
        legalNameLabel: 'HUF name', legalNamePlaceholder: 'Sharma (HUF)',
        primaryId: { show: false },
        pan: { label: 'HUF PAN', placeholder: 'AAAHX1234A', hint: 'The HUF’s PAN (4th character is ‘H’).' },
        incorporation: { show: false },
        proprietor: false,
      };
    case 'trust':
    case 'society':
    case 'cooperative_society':
      return {
        legalNameLabel: 'Registered name', legalNamePlaceholder: 'Acme Charitable Trust',
        primaryId: { show: true, key: 'registrationNo', label: 'Registration number', placeholder: 'State registration number', hint: 'Trust-deed / Society / Registrar of Cooperative Societies registration number from the state authority.' },
        pan: { label: 'PAN', placeholder: 'AAATX1234A', hint: 'PAN of the trust/society (4th character is usually ‘T’, sometimes ‘A’).' },
        incorporation: { show: true, label: 'Date of registration' },
        proprietor: false,
      };
    default:
      // Not yet chosen → generic, everything optional.
      return {
        legalNameLabel: 'Legal name', legalNamePlaceholder: 'Registered legal name',
        primaryId: { show: true, key: 'registrationNo', label: 'Registration number', placeholder: 'CIN / LLPIN / registration no.', hint: 'Your primary government registration number.' },
        pan: { label: 'PAN', placeholder: 'ABCDE1234F', hint: '10-character Permanent Account Number.' },
        incorporation: { show: true, label: 'Date of incorporation / registration' },
        proprietor: false,
      };
  }
}
