// Country-aware address configuration shared by onboarding + Billing & Plan.
// Each country maps to a "profile" that decides the field layout, labels, the
// state list (where a dropdown is correct), and the tax-ID treatment.
//
//   IN  → PIN drives state/city; State dropdown; GSTIN (validated).
//   NZ  → Google Places search; GST hidden (you're GST-free).
//   US  → State dropdown + ZIP; no buyer tax id (Paddle is MoR, handles tax).
//   else→ universal address theme (UK / EU / rest of world); VAT optional.

export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa',
  'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland',
  'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];

export const US_STATES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
  'Delaware', 'District of Columbia', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois',
  'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts',
  'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
  'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota',
  'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota',
  'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia',
  'Wisconsin', 'Wyoming',
];

// GSTIN: 2-digit state code, 10-char PAN, entity digit, 'Z', checksum char.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
export function isValidGstin(v) {
  return GSTIN_RE.test(String(v || '').trim().toUpperCase());
}

const PROFILES = {
  IN: {
    kind: 'IN',
    postalLabel: 'PIN code',
    postalPlaceholder: '201301',
    stateLabel: 'State',
    states: INDIAN_STATES,
    cityLabel: 'City / District',
    tax: { show: true, required: 'B2B', label: 'GSTIN', placeholder: '09AAACP1234A1Z5', validate: isValidGstin, invalidMsg: 'Enter a valid 15-character GSTIN.' },
  },
  US: {
    kind: 'US',
    postalLabel: 'ZIP code',
    postalPlaceholder: '10001',
    stateLabel: 'State',
    states: US_STATES,
    cityLabel: 'City',
    tax: { show: false },
  },
  NZ: {
    kind: 'NZ',
    postalLabel: 'Postcode',
    postalPlaceholder: '1010',
    stateLabel: 'Region',
    states: null,
    cityLabel: 'City / Suburb',
    tax: { show: false },
  },
  GENERIC: {
    kind: 'GENERIC',
    postalLabel: 'Postal code',
    postalPlaceholder: '',
    stateLabel: 'State / Region',
    states: null,
    cityLabel: 'City / Town',
    tax: { show: true, required: false, label: 'VAT / Tax ID (optional)', placeholder: 'e.g. GB123456789', validate: null },
  },
};

export function addressProfile(country) {
  const c = String(country || '').trim().toUpperCase();
  if (c === 'IN') return PROFILES.IN;
  if (c === 'NZ') return PROFILES.NZ;
  if (c === 'US') return PROFILES.US;
  return PROFILES.GENERIC;
}
