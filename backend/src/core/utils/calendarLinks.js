function getTimeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const values = {};
  parts.forEach((part) => {
    if (part.type !== 'literal') values[part.type] = part.value;
  });

  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToUtc(dateStr, timeStr, timeZone) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const [hour, minute] = String(timeStr || '00:00').split(':').map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour || 0, minute || 0, 0));
  const offset = getTimeZoneOffsetMs(utcGuess, timeZone || 'UTC');
  return new Date(utcGuess.getTime() - offset);
}

function formatGoogleCalendarUtcStamp(dateStr, timeStr, timeZone) {
  // Google Calendar format requires YYYYMMDDTHHMMSSZ
  try {
    return zonedDateTimeToUtc(dateStr, timeStr, timeZone)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
  } catch (e) {
    return null;
  }
}

function generateGoogleCalendarLink(ctx) {
  if (!ctx || !ctx.date || !ctx.startTime) return null;

  const tz = ctx.timezone || 'UTC';
  const startStamp = formatGoogleCalendarUtcStamp(ctx.date, ctx.startTime, tz);
  const endStamp = formatGoogleCalendarUtcStamp(ctx.date, ctx.endTime, tz);
  
  if (!startStamp || !endStamp) return null;

  const title = ctx.serviceName || 'Appointment';
  const details = `Business: ${ctx.businessName || 'Sitepresso'}
Status: ${ctx.status || 'CONFIRMED'}
With: ${ctx.staffName || 'Staff'}`;
  const location = [ctx.address, ctx.state, ctx.country]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(', ') || ctx.businessName || '';

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${startStamp}/${endStamp}`,
    details: details,
    location: location,
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function generateAppleCalendarLink(appointmentId) {
  if (!appointmentId) return null;
  // .ics download is an API endpoint — must come from api.<domain>,
  // not the platform frontend. Used to fall back to NEXT_PUBLIC_PLATFORM_URL
  // (= aapkatech.com) which is the wrong host. resolveApiBaseUrl() picks
  // the right one regardless of which frontend the user clicked from.
  const { resolveApiBaseUrl } = require('./apiBaseUrl');
  let baseUrl = resolveApiBaseUrl();
  // Local dev override — if no explicit API URL is set and PLATFORM_DOMAIN
  // is unset (i.e. resolveApiBaseUrl returned the prod default), fall back
  // to localhost:PORT so dev machines don't link to a remote URL.
  const isLocal = !process.env.PUBLIC_API_URL && !process.env.NEXT_PUBLIC_API_URL && !process.env.PLATFORM_DOMAIN && process.env.PORT;
  if (isLocal) {
    baseUrl = `http://localhost:${process.env.PORT}`;
  }
  return `${baseUrl.replace(/\/$/, '')}/api/calendar/appointment/${appointmentId}.ics`;
}

module.exports = {
  generateGoogleCalendarLink,
  generateAppleCalendarLink,
  zonedDateTimeToUtc,
};
