const { zonedDateTimeToUtc } = require('./calendarLinks');

function escapeIcsText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function formatUtcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function foldIcsLine(line) {
  if (line.length <= 75) return line;
  let folded = '';
  let remaining = line;
  while (remaining.length > 75) {
    folded += remaining.slice(0, 75) + '\r\n ';
    remaining = remaining.slice(75);
  }
  return folded + remaining;
}

function formatSequence(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    const numeric = Number.parseInt(value, 10);
    return Number.isFinite(numeric) ? String(Math.max(0, numeric)) : null;
  }
  return String(Math.max(0, Math.floor(date.getTime() / 1000)));
}

function buildLocationText(appt) {
  return [appt.business?.address, appt.business?.state, appt.business?.country]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(', ') || appt.business?.name || 'Sitepresso';
}

function buildAppointmentLines(appt, options = {}) {
  const businessName = appt.business?.name || 'Sitepresso';
  const dateStr = typeof appt.date === 'string'
    ? appt.date
    : new Date(appt.date).toISOString().slice(0, 10);
  const tz = appt.business?.timezone || 'UTC';
  const dtStart = zonedDateTimeToUtc(dateStr, appt.startTime, tz);
  const dtEnd = zonedDateTimeToUtc(dateStr, appt.endTime, tz);
  const titleParts = [
    appt.service?.name || 'Appointment',
    appt.staff?.name ? `with ${appt.staff.name}` : null,
  ].filter(Boolean);
  const descriptionLines = [
    `Business: ${businessName}`,
    `Status: ${appt.status || 'CONFIRMED'}`,
    appt.notes ? `Notes: ${appt.notes}` : null,
  ].filter(Boolean);
  const location = buildLocationText(appt);
  const sequence = formatSequence(options.sequence ?? appt.sequence ?? null);
  const organizerEmail = String(options.organizerEmail || '').trim() || null;
  const attendeeEmail = String(options.attendeeEmail || '').trim() || null;
  const attendeeName = String(options.attendeeName || appt.attendeeName || '').trim() || null;
  const status = (appt.status || 'CONFIRMED') === 'CANCELLED' ? 'CANCELLED' : 'CONFIRMED';
  const nowStamp = formatUtcStamp(new Date());

  const lines = [
    'BEGIN:VEVENT',
    `UID:appointment-${appt.id}@sitepresso.com`,
    `DTSTAMP:${nowStamp}`,
    `DTSTART:${formatUtcStamp(dtStart)}`,
    `DTEND:${formatUtcStamp(dtEnd)}`,
    `SUMMARY:${escapeIcsText(titleParts.join(' '))}`,
    `DESCRIPTION:${escapeIcsText(descriptionLines.join('\n'))}`,
    `LOCATION:${escapeIcsText(location)}`,
    `STATUS:${status}`,
  ];

  const lastModifiedDate = options.sequence instanceof Date ? options.sequence : (appt.updatedAt || new Date());
  lines.push(`LAST-MODIFIED:${formatUtcStamp(lastModifiedDate)}`);

  if (sequence) lines.push(`SEQUENCE:${sequence}`);
  if (organizerEmail) lines.push(`ORGANIZER;CN=${escapeIcsText(businessName)}:mailto:${escapeIcsText(organizerEmail)}`);
  if (attendeeEmail) {
    const attendeeCn = escapeIcsText(attendeeName || attendeeEmail);
    lines.push(`ATTENDEE;CN=${attendeeCn};CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${escapeIcsText(attendeeEmail)}`);
  }
  if ((options.method || 'PUBLISH') === 'REQUEST') lines.push('TRANSP:OPAQUE');

  lines.push('END:VEVENT');
  return lines;
}

function renderCalendarFeed({ calendarName, appointments }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sitepresso//Calendar Sync//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
  ];

  appointments.forEach((appt) => {
    lines.push(...buildAppointmentLines(appt, { method: 'PUBLISH' }));
  });

  lines.push('END:VCALENDAR');
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

function renderSingleAppointmentCalendar(ctx, options = {}) {
  const method = options.method || 'REQUEST';
  const sequence = options.sequence ?? ctx.sequence ?? ctx.updatedAt ?? null;
  const appointment = {
    id: ctx.appointmentId,
    date: ctx.date,
    startTime: ctx.startTime,
    endTime: ctx.endTime,
    status: ctx.status || 'CONFIRMED',
    notes: ctx.notes || '',
    attendeeName: ctx.userName,
    business: {
      name: ctx.businessName,
      address: ctx.address,
      state: ctx.state,
      country: ctx.country,
      timezone: ctx.timezone,
    },
    service: { name: ctx.serviceName },
    staff: { name: ctx.staffName },
    sequence,
    updatedAt: ctx.updatedAt,
  };

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sitepresso//Calendar Invite//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
  ];

  lines.push(
    `X-WR-CALNAME:${escapeIcsText(`Appointment at ${ctx.businessName || 'Sitepresso'}`)}`,
    `X-MICROSOFT-CDO-METHOD:${method}`,
    ...buildAppointmentLines(appointment, {
      method,
      sequence,
      organizerEmail: options.organizerEmail || process.env.SES_FROM_EMAIL || '',
      attendeeEmail: options.attendeeEmail || ctx.recipientEmail || '',
      attendeeName: ctx.userName,
    }),
    'END:VCALENDAR'
  );

  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

module.exports = {
  renderCalendarFeed,
  renderSingleAppointmentCalendar,
};
