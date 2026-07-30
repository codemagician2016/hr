// Pure formatters for the appointment export endpoints.
//
// Two formats:
//   * CSV  — RFC 4180-ish, suited for spreadsheets / accounting tools.
//   * iCal — RFC 5545 VEVENT calendar feed; importable into Google
//            Calendar / Apple Calendar / Outlook.
//
// Pure: input is appointment rows (already scoped to the right
// business + date range by the caller), output is a string. The HTTP
// controllers set the right MIME + Content-Disposition headers.

const CSV_COLUMNS = [
  'Date', 'Start', 'End', 'Customer', 'Email', 'Phone',
  'Service', 'Staff', 'Status', 'Notes', 'Price',
];

// Quote per RFC 4180: wrap in " when the field contains a comma, "
// or newline; double any existing quotes. Also neutralise formula-injection:
// a leading = + - @ (customer-controlled name/notes) is prefixed with ' so the
// tenant admin opening the CSV in Excel/Sheets sees text, not a live formula.
const FORMULA_LEAD = new Set(['=', '+', '-', '@', '\t', '\r']);
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (s.length && FORMULA_LEAD.has(s[0])) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function isoDay(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function priceFor(appt) {
  if (typeof appt.finalPrice === 'number') return appt.finalPrice;
  if (typeof appt.originalPrice === 'number') return appt.originalPrice;
  if (appt.service && typeof appt.service.price === 'number') return appt.service.price;
  return '';
}

function customerNameFor(appt) {
  return appt.customer?.name || appt.user?.name || appt.customerName || '';
}
function customerEmailFor(appt) {
  return appt.customer?.email || appt.user?.email || appt.customerEmail || '';
}
function customerPhoneFor(appt) {
  return appt.customer?.phone || appt.user?.phone || appt.customerPhone || '';
}

function toCsv(appointments) {
  const rows = [CSV_COLUMNS.map(csvCell).join(',')];
  for (const a of appointments) {
    rows.push([
      isoDay(a.date),
      a.startTime || '',
      a.endTime || '',
      customerNameFor(a),
      customerEmailFor(a),
      customerPhoneFor(a),
      a.service?.name || '',
      a.staff?.name || '',
      a.status || '',
      a.notes || '',
      priceFor(a),
    ].map(csvCell).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

// ---------- iCal ----------
//
// Compose a date + HH:MM into a UTC iCal stamp. We don't have the
// business's timezone in every appointment row (yet), so we anchor
// each event in the date's UTC midnight and add the local clock-time
// offset. Ends up equivalent to "this is the local time on this date"
// for clients that interpret the Z suffix; good enough for export
// today, refine when we surface the timezone.
function toIcalStamp(date, hhmm) {
  if (!date) return '';
  const d = date instanceof Date ? new Date(date) : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  d.setUTCHours(h || 0, m || 0, 0, 0);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// Escape per RFC 5545 §3.3.11: backslash, comma, semicolon, newline.
function icalText(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// Fold long lines per RFC 5545 §3.1: wrap at 75 octets, prefixing
// continuation lines with a single space. We approximate with chars
// since ASCII-7 covers everything we emit here.
function fold(line) {
  if (line.length <= 75) return line;
  const out = [];
  let i = 0;
  while (i < line.length) {
    out.push((i === 0 ? '' : ' ') + line.slice(i, i + 73));
    i += 73;
  }
  return out.join('\r\n');
}

function buildVEvent(appt, businessName) {
  const uid = `${appt.id}@sitepresso`;
  const dtstart = toIcalStamp(appt.date, appt.startTime);
  const dtend   = toIcalStamp(appt.date, appt.endTime);
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const summary = [appt.service?.name, businessName].filter(Boolean).join(' · ');
  const descriptionParts = [];
  const customer = customerNameFor(appt);
  if (customer) descriptionParts.push(`Customer: ${customer}`);
  if (appt.staff?.name) descriptionParts.push(`Staff: ${appt.staff.name}`);
  if (appt.status) descriptionParts.push(`Status: ${appt.status}`);
  if (appt.notes) descriptionParts.push(`Notes: ${appt.notes}`);

  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    dtstart && `DTSTART:${dtstart}`,
    dtend && `DTEND:${dtend}`,
    summary && `SUMMARY:${icalText(summary)}`,
    descriptionParts.length && `DESCRIPTION:${icalText(descriptionParts.join('\n'))}`,
    `STATUS:${appt.status === 'CANCELLED' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
  ].filter(Boolean);
  return lines.map(fold).join('\r\n');
}

function toIcal(appointments, { businessName = 'Sitepresso' } = {}) {
  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//Sitepresso//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icalText(businessName)} appointments`,
  ].join('\r\n');
  const body = appointments.map((a) => buildVEvent(a, businessName)).join('\r\n');
  const tail = 'END:VCALENDAR';
  return [head, body, tail].filter(Boolean).join('\r\n') + '\r\n';
}

module.exports = { toCsv, toIcal, CSV_COLUMNS };
