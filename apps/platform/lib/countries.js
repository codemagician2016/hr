// Country list used by the business onboarding + admin Settings forms.
// ISO-3166-1 alpha-2 code, display name, address placeholder tuned to the
// local postal style, and one-or-more IANA time zones. When a country has
// exactly one time zone, we auto-populate business.timezone and lock the
// dropdown; when it has multiple, the owner picks from the list.

export const COUNTRIES = [
  { code: 'IN', name: 'India',          placeholder: '123 MG Road, Bengaluru, Karnataka 560001', timezones: [{ tz: 'Asia/Kolkata', label: 'India (IST, UTC+05:30)' }] },
  { code: 'NZ', name: 'New Zealand',    placeholder: '123 Queen Street, Auckland 1010',          timezones: [{ tz: 'Pacific/Auckland', label: 'Auckland / most of NZ (NZST/NZDT)' }, { tz: 'Pacific/Chatham', label: 'Chatham Islands' }] },
  { code: 'US', name: 'United States',  placeholder: '123 Main St, Springfield, IL 62701',       timezones: [
    { tz: 'America/New_York',    label: 'Eastern (ET) — New York, Atlanta, Miami' },
    { tz: 'America/Chicago',     label: 'Central (CT) — Chicago, Dallas, Houston' },
    { tz: 'America/Denver',      label: 'Mountain (MT) — Denver, Salt Lake City' },
    { tz: 'America/Phoenix',     label: 'Arizona (MST, no DST)' },
    { tz: 'America/Los_Angeles', label: 'Pacific (PT) — LA, SF, Seattle' },
    { tz: 'America/Anchorage',   label: 'Alaska (AKT)' },
    { tz: 'Pacific/Honolulu',    label: 'Hawaii (HST)' },
  ] },
  { code: 'GB', name: 'United Kingdom', placeholder: '221B Baker Street, London NW1 6XE',        timezones: [{ tz: 'Europe/London', label: 'UK (GMT/BST)' }] },
  { code: 'CA', name: 'Canada',         placeholder: '123 Yonge Street, Toronto, ON M5H 2N2',    timezones: [
    { tz: 'America/Toronto',    label: 'Eastern — Toronto, Ottawa' },
    { tz: 'America/Winnipeg',   label: 'Central — Winnipeg' },
    { tz: 'America/Edmonton',   label: 'Mountain — Calgary, Edmonton' },
    { tz: 'America/Vancouver',  label: 'Pacific — Vancouver' },
    { tz: 'America/Halifax',    label: 'Atlantic — Halifax' },
    { tz: 'America/St_Johns',   label: 'Newfoundland' },
  ] },
  { code: 'AU', name: 'Australia',      placeholder: '123 George Street, Sydney NSW 2000',       timezones: [
    { tz: 'Australia/Sydney',    label: 'Eastern (AEST/AEDT) — Sydney, Melbourne, Brisbane' },
    { tz: 'Australia/Adelaide',  label: 'Central (ACST) — Adelaide' },
    { tz: 'Australia/Perth',     label: 'Western (AWST) — Perth' },
    { tz: 'Australia/Darwin',    label: 'Central — Darwin (no DST)' },
    { tz: 'Australia/Hobart',    label: 'Tasmania — Hobart' },
  ] },
  { code: 'SG', name: 'Singapore',      placeholder: '1 Raffles Place, Singapore 048616',        timezones: [{ tz: 'Asia/Singapore', label: 'Singapore (SGT)' }] },
  { code: 'AE', name: 'UAE',            placeholder: 'Sheikh Zayed Road, Dubai',                 timezones: [{ tz: 'Asia/Dubai', label: 'UAE (GST, UTC+04:00)' }] },
  { code: 'DE', name: 'Germany',        placeholder: 'Hauptstraße 1, 10178 Berlin',              timezones: [{ tz: 'Europe/Berlin', label: 'Germany (CET/CEST)' }] },
  { code: 'FR', name: 'France',         placeholder: '1 Rue de Rivoli, 75001 Paris',             timezones: [{ tz: 'Europe/Paris', label: 'France (CET/CEST)' }] },
  { code: 'IT', name: 'Italy',          placeholder: 'Via Roma 1, 00184 Roma',                   timezones: [{ tz: 'Europe/Rome', label: 'Italy (CET/CEST)' }] },
  { code: 'ES', name: 'Spain',          placeholder: 'Calle Mayor 1, 28013 Madrid',              timezones: [{ tz: 'Europe/Madrid', label: 'Spain (CET/CEST)' }, { tz: 'Atlantic/Canary', label: 'Canary Islands (WET/WEST)' }] },
  { code: 'NL', name: 'Netherlands',    placeholder: 'Dam 1, 1012 JS Amsterdam',                 timezones: [{ tz: 'Europe/Amsterdam', label: 'Netherlands (CET/CEST)' }] },
  { code: 'IE', name: 'Ireland',        placeholder: 'O\u2019Connell Street, Dublin 1',          timezones: [{ tz: 'Europe/Dublin', label: 'Ireland (GMT/IST)' }] },
  { code: 'JP', name: 'Japan',          placeholder: '1-1-1 Shibuya, Shibuya-ku, Tokyo 150-0002', timezones: [{ tz: 'Asia/Tokyo', label: 'Japan (JST, UTC+09:00)' }] },
  { code: 'KR', name: 'South Korea',    placeholder: '1 Sejong-daero, Jung-gu, Seoul',           timezones: [{ tz: 'Asia/Seoul', label: 'Korea (KST, UTC+09:00)' }] },
  { code: 'BR', name: 'Brazil',         placeholder: 'Av. Paulista 1000, São Paulo, SP 01310-100', timezones: [
    { tz: 'America/Sao_Paulo', label: 'Brasília — São Paulo, Rio' },
    { tz: 'America/Manaus',    label: 'Amazon — Manaus' },
    { tz: 'America/Fortaleza', label: 'Northeast — Fortaleza' },
    { tz: 'America/Noronha',   label: 'Fernando de Noronha' },
  ] },
  { code: 'MX', name: 'Mexico',         placeholder: 'Av. Reforma 100, Cuauhtémoc, CDMX 06030',   timezones: [
    { tz: 'America/Mexico_City', label: 'Central — Mexico City' },
    { tz: 'America/Monterrey',   label: 'Central — Monterrey' },
    { tz: 'America/Chihuahua',   label: 'Mountain — Chihuahua' },
    { tz: 'America/Mazatlan',    label: 'Mountain — Mazatlan' },
    { tz: 'America/Tijuana',     label: 'Pacific — Tijuana' },
    { tz: 'America/Cancun',      label: 'Eastern — Cancún (no DST)' },
  ] },
  { code: 'ZA', name: 'South Africa',   placeholder: '1 Long Street, Cape Town, 8001',           timezones: [{ tz: 'Africa/Johannesburg', label: 'South Africa (SAST, UTC+02:00)' }] },
  { code: 'PK', name: 'Pakistan',       placeholder: 'Mall Road, Lahore',                         timezones: [{ tz: 'Asia/Karachi', label: 'Pakistan (PKT, UTC+05:00)' }] },
  { code: 'BD', name: 'Bangladesh',     placeholder: 'Gulshan Avenue, Dhaka 1212',               timezones: [{ tz: 'Asia/Dhaka', label: 'Bangladesh (BST, UTC+06:00)' }] },
  { code: 'LK', name: 'Sri Lanka',      placeholder: 'Galle Road, Colombo 03',                    timezones: [{ tz: 'Asia/Colombo', label: 'Sri Lanka (IST, UTC+05:30)' }] },
  { code: 'NP', name: 'Nepal',          placeholder: 'Thamel, Kathmandu 44600',                   timezones: [{ tz: 'Asia/Kathmandu', label: 'Nepal (NPT, UTC+05:45)' }] },
  { code: 'NG', name: 'Nigeria',        placeholder: '1 Victoria Island, Lagos',                  timezones: [{ tz: 'Africa/Lagos', label: 'Nigeria (WAT, UTC+01:00)' }] },
  { code: 'KE', name: 'Kenya',          placeholder: 'Kenyatta Avenue, Nairobi',                  timezones: [{ tz: 'Africa/Nairobi', label: 'Kenya (EAT, UTC+03:00)' }] },
  { code: 'EG', name: 'Egypt',          placeholder: 'Tahrir Square, Cairo',                      timezones: [{ tz: 'Africa/Cairo', label: 'Egypt (EET)' }] },
  { code: 'TR', name: 'Turkey',         placeholder: 'İstiklal Caddesi, Beyoğlu, Istanbul',       timezones: [{ tz: 'Europe/Istanbul', label: 'Turkey (TRT, UTC+03:00)' }] },
  { code: 'PH', name: 'Philippines',    placeholder: '1 Ayala Avenue, Makati, Metro Manila',      timezones: [{ tz: 'Asia/Manila', label: 'Philippines (PST, UTC+08:00)' }] },
  { code: 'MY', name: 'Malaysia',       placeholder: 'Jalan Ampang, 50450 Kuala Lumpur',          timezones: [{ tz: 'Asia/Kuala_Lumpur', label: 'Malaysia (MYT, UTC+08:00)' }] },
  { code: 'ID', name: 'Indonesia',      placeholder: 'Jl. Sudirman, Jakarta 10220',               timezones: [
    { tz: 'Asia/Jakarta',   label: 'Western — Jakarta, Bali' },
    { tz: 'Asia/Makassar',  label: 'Central — Makassar' },
    { tz: 'Asia/Jayapura',  label: 'Eastern — Jayapura' },
  ] },
  { code: 'TH', name: 'Thailand',       placeholder: 'Sukhumvit Road, Bangkok 10110',             timezones: [{ tz: 'Asia/Bangkok', label: 'Thailand (ICT, UTC+07:00)' }] },
  { code: 'VN', name: 'Vietnam',        placeholder: 'Nguyen Hue Street, District 1, Ho Chi Minh City', timezones: [{ tz: 'Asia/Ho_Chi_Minh', label: 'Vietnam (ICT, UTC+07:00)' }] },
];

export const DEFAULT_COUNTRY = 'IN';
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
export const DEFAULT_ADDRESS_PLACEHOLDER = '123 Main St, City';

export function getCountry(code) {
  if (!code) return null;
  const up = String(code).toUpperCase();
  return COUNTRIES.find((c) => c.code === up) || null;
}

export function addressPlaceholderFor(code) {
  return getCountry(code)?.placeholder || DEFAULT_ADDRESS_PLACEHOLDER;
}

// Returns the list of IANA timezones available for a country.
export function timezonesFor(code) {
  return getCountry(code)?.timezones || [{ tz: DEFAULT_TIMEZONE, label: 'India (IST)' }];
}

// Default timezone for a country — first entry in its timezones list.
// Used when the owner picks a country for the first time so the timezone
// dropdown isn't empty.
export function defaultTimezoneFor(code) {
  return timezonesFor(code)[0]?.tz || DEFAULT_TIMEZONE;
}
