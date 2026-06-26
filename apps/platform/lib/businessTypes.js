// India business/entity types for the onboarding wizard. Mirrors
// apps/hr-admin/lib/businessTypes.js (separate app, can't share the import).
// The onboarding asks the business type FIRST, then shows the right primary
// registration field (CIN for companies, LLPIN for an LLP, a Registrar-of-Firms
// number for a partnership, nothing for a proprietorship/HUF).

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

// Returns onboarding-relevant field spec for the India entity step.
export function specForBusinessType(type) {
  const company = (placeholder) => ({
    legalNamePlaceholder: 'Acme Technologies Pvt Ltd',
    primaryId: { show: true, label: 'CIN', placeholder, hint: 'Corporate Identity Number from the MCA.' },
    panLabel: 'Company PAN', panPlaceholder: 'AAACX1234X',
    proprietor: false,
  });
  switch (type) {
    case 'private_limited': return company('U72200MH2020PTC345678');
    case 'opc': return { ...company('U74999DL2021OPC123456'), legalNamePlaceholder: 'Acme (OPC) Private Limited' };
    case 'public_limited': return { ...company('L17110MH1973PLC019786'), legalNamePlaceholder: 'Acme Industries Limited' };
    case 'section_8': return { ...company('U85300KA2019NPL145678'), legalNamePlaceholder: 'Acme Foundation' };
    case 'llp':
      return {
        legalNamePlaceholder: 'Acme Advisory LLP',
        primaryId: { show: true, label: 'LLPIN', placeholder: 'AAB-1234', hint: 'LLP Identification Number from the MCA.' },
        panLabel: 'LLP PAN', panPlaceholder: 'AAAFL1234C', proprietor: false,
      };
    case 'partnership_firm':
      return {
        legalNamePlaceholder: 'Sharma & Associates',
        primaryId: { show: true, label: 'Firm registration no. (RoF)', placeholder: 'If registered with the Registrar of Firms', hint: 'Optional — only registered firms have this.' },
        panLabel: 'Firm PAN', panPlaceholder: 'AAAFL1234C', proprietor: false,
      };
    case 'sole_proprietorship':
      return {
        legalNamePlaceholder: 'Sharma Traders',
        primaryId: { show: false },
        panLabel: "Proprietor's PAN", panPlaceholder: 'ABCPK1234E', proprietor: true,
      };
    case 'huf':
      return {
        legalNamePlaceholder: 'Sharma (HUF)',
        primaryId: { show: false },
        panLabel: 'HUF PAN', panPlaceholder: 'AAAHX1234A', proprietor: false,
      };
    case 'trust':
    case 'society':
    case 'cooperative_society':
      return {
        legalNamePlaceholder: 'Acme Charitable Trust',
        primaryId: { show: true, label: 'Registration number', placeholder: 'State registration number', hint: 'Trust / Society / Cooperative registration number.' },
        panLabel: 'PAN', panPlaceholder: 'AAATX1234A', proprietor: false,
      };
    default:
      return {
        legalNamePlaceholder: 'Acme Technologies Pvt Ltd',
        primaryId: { show: true, label: 'Registration no. (CIN / LLPIN)', placeholder: 'U72900KA2020PTC123456', hint: 'Your primary government registration number.' },
        panLabel: 'PAN', panPlaceholder: 'ABCDE1234F', proprietor: false,
      };
  }
}
