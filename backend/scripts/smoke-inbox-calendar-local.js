const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { PrismaClient } = require('@prisma/client');
const { EMAIL_EVENTS } = require('../src/lib/emailEvents');

const prisma = new PrismaClient();

const BACKEND_ROOT = path.resolve(__dirname, '..');
const EXPLICIT_API_BASE_URL = String(process.env.LOCAL_API_URL || '').trim().replace(/\/$/, '');
const DEFAULT_API_PORT = Number(process.env.SMOKE_API_PORT || 3101);
const PRIMARY_DEV_PORT = Number(process.env.PORT || 3001);

const TEST_PASSWORD = 'Password123!';

function log(step, detail) {
  const suffix = detail ? ` ${detail}` : '';
  console.log(`[inbox-smoke] ${step}${suffix}`);
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEmailDelivery(eventKey, appointmentId) {
  let latest = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const delivery = await prisma.emailDelivery.findFirst({
      where: { eventKey, appointmentId },
      orderBy: { createdAt: 'desc' },
      select: {
        status: true,
        subject: true,
        metadata: true,
        actualRecipientEmail: true,
        errorMessage: true,
      },
    });
    if (delivery) {
      latest = delivery;
      if (delivery.status === 'SENT') return delivery;
      if (delivery.status === 'FAILED') {
        fail(
          `Email delivery ${eventKey} failed for appointment ${appointmentId}: ${delivery.errorMessage || 'Unknown error'}.`
        );
      }
    }
    await wait(500);
  }
  const latestStatus = latest?.status ? ` Last seen status: ${latest.status}.` : '';
  fail(`Timed out waiting for email delivery ${eventKey} for appointment ${appointmentId}.${latestStatus}`);
}

function assertAttachmentMetadata(delivery, eventKey) {
  const attachmentCount = Number(delivery?.metadata?.attachmentCount || 0);
  const attachments = Array.isArray(delivery?.metadata?.attachments) ? delivery.metadata.attachments : [];
  assert(attachmentCount >= 1, `${eventKey} email should record at least one attachment.`);
  assert(
    attachments.some((item) => String(item?.filename || '').endsWith('.ics')),
    `${eventKey} email should include an .ics attachment in metadata.`
  );
}

async function isHealthy(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/health`);
    if (!res.ok) return false;
    const body = await res.json().catch(() => ({}));
    return body?.status === 'ok';
  } catch {
    return false;
  }
}

function reservePort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const resolvedPort = typeof address === 'object' && address ? address.port : port;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(resolvedPort);
      });
    });
  });
}

async function findAvailablePort(preferredPort) {
  try {
    return await reservePort(preferredPort);
  } catch {
    return reservePort(0);
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;

  child.kill('SIGINT');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    wait(5000),
  ]);

  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      wait(5000),
    ]);
  }

  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

async function ensureBackend() {
  if (EXPLICIT_API_BASE_URL) {
    if (!await isHealthy(EXPLICIT_API_BASE_URL)) {
      fail(`Configured LOCAL_API_URL is not reachable: ${EXPLICIT_API_BASE_URL}`);
    }
    return { apiBaseUrl: EXPLICIT_API_BASE_URL, startedServer: false, shutdown: async () => {} };
  }

  const candidateUrls = [
    `http://localhost:${DEFAULT_API_PORT}`,
    `http://localhost:${PRIMARY_DEV_PORT}`,
  ].filter((value, index, array) => array.indexOf(value) === index);

  for (const baseUrl of candidateUrls) {
    if (await isHealthy(baseUrl)) {
      return { apiBaseUrl: baseUrl, startedServer: false, shutdown: async () => {} };
    }
  }

  const port = await findAvailablePort(DEFAULT_API_PORT);
  const baseUrl = `http://localhost:${port}`;
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: BACKEND_ROOT,
    env: {
      ...process.env,
      EMAIL_TRANSPORT_MODE: 'stub',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let recentLogs = '';
  const capture = (chunk) => {
    recentLogs += chunk.toString();
    if (recentLogs.length > 8000) recentLogs = recentLogs.slice(-8000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await isHealthy(baseUrl)) {
      return {
        apiBaseUrl: baseUrl,
        startedServer: true,
        shutdown: async () => stopChild(child),
      };
    }
    if (child.exitCode !== null) {
      fail(`Temporary backend exited before becoming healthy.\n${recentLogs.trim()}`);
    }
    await wait(500);
  }

  await stopChild(child);
  fail(`Temporary backend did not become healthy at ${baseUrl}.\n${recentLogs.trim()}`);
}

function addMinutes(hhmm, minutes) {
  const [hours, mins] = String(hhmm).split(':').map(Number);
  const total = hours * 60 + mins + minutes;
  const nextHours = Math.floor(total / 60).toString().padStart(2, '0');
  const nextMins = (total % 60).toString().padStart(2, '0');
  return `${nextHours}:${nextMins}`;
}

function nextWeekdayIso() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date.toISOString().slice(0, 10);
}

class Session {
  constructor(apiBaseUrl, name) {
    this.apiBaseUrl = apiBaseUrl;
    this.name = name;
    this.cookieHeader = '';
  }

  captureCookie(res) {
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [];
    const rawHeader = [
      ...setCookies,
      res.headers.get('set-cookie'),
    ].filter(Boolean).join('\n');

    const match = rawHeader.match(/(?:^|[\n,])\s*((?:ae_operator(?:_[^=;\s]+)?)|token)=([^;\s]+)/);
    if (match) this.cookieHeader = `${match[1]}=${match[2]}`;
  }

  async request(pathname, { method = 'GET', json, headers = {} } = {}) {
    const finalHeaders = { ...headers };
    if (this.cookieHeader) finalHeaders.Cookie = this.cookieHeader;
    if (json !== undefined) finalHeaders['Content-Type'] = 'application/json';

    const res = await fetch(`${this.apiBaseUrl}${pathname}`, {
      method,
      headers: finalHeaders,
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    this.captureCookie(res);

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body?.message || `${method} ${pathname} failed with ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(`GET ${url} failed with ${res.status}`);
  return body;
}

async function fetchText(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) fail(`GET ${url} failed with ${res.status}`);
  return text;
}

async function main() {
  let backend = null;
  const stamp = Date.now();
  const ownerEmail = `inbox-owner-${stamp}@example.com`;
  const staffEmail = `inbox-staff-${stamp}@example.com`;
  const customerEmail = `inbox-customer-${stamp}@example.com`;
  const slug = `inbox-smoke-${stamp}`;
  const businessName = `Inbox Smoke ${stamp}`;

  try {
    backend = await ensureBackend();
    const apiBaseUrl = backend.apiBaseUrl;
    const owner = new Session(apiBaseUrl, 'owner');
    const staff = new Session(apiBaseUrl, 'staff');
    const customer = new Session(apiBaseUrl, 'customer');

    log('starting', `api=${apiBaseUrl}${backend.startedServer ? ' (temporary backend started automatically)' : ''}`);

    log('registering owner', ownerEmail);
    await owner.request('/api/auth/register', {
      method: 'POST',
      json: {
        name: 'Inbox Owner',
        email: ownerEmail,
        password: TEST_PASSWORD,
        acceptTerms: true,
      },
    });

    try {
      await owner.request('/api/auth/send-otp', {
        method: 'POST',
        json: { email: ownerEmail },
      });
    } catch (err) {
      if (!String(err.message || '').includes('Failed to send OTP email')) throw err;
      log('owner otp email unavailable locally', 'continuing with DB-stored OTP');
    }

    const ownerOtp = await prisma.user.findUnique({
      where: { email: ownerEmail },
      select: { emailOtp: true },
    });
    assert(ownerOtp?.emailOtp, 'Owner OTP was not stored.');

    await owner.request('/api/auth/verify-otp', {
      method: 'POST',
      json: {
        email: ownerEmail,
        otp: ownerOtp.emailOtp,
      },
    });

    log('setting up business', slug);
    const setup = await owner.request('/api/business/setup', {
      method: 'POST',
      json: {
        name: businessName,
        slug,
        country: 'IN',
        timezone: 'Asia/Kolkata',
        category: 'dental',
        email: ownerEmail,
      },
    });
    const businessId = setup?.business?.id;
    assert(businessId, 'Business setup did not return a business id.');

    await prisma.business.update({
      where: { id: businessId },
      data: { isActive: true },
    });

    const ownerRecord = await prisma.user.findUnique({
      where: { email: ownerEmail },
      select: { id: true, businessId: true, role: true, isServiceProvider: true },
    });
    assert(ownerRecord?.businessId === businessId, 'Owner was not attached to the new business.');
    assert(ownerRecord?.role === 'BUSINESS_ADMIN', 'Owner was not promoted to BUSINESS_ADMIN.');
    assert(ownerRecord?.isServiceProvider === true, 'Owner should be bookable as a service provider.');

    log('inviting staff', staffEmail);
    await owner.request('/api/business/staff', {
      method: 'POST',
      json: {
        email: staffEmail,
        name: 'Inbox Staff',
      },
    });

    const staffRecord = await prisma.user.findUnique({
      where: { email: staffEmail },
      select: { id: true, businessId: true, role: true, isServiceProvider: true },
    });
    assert(staffRecord?.businessId === businessId, 'Staff user was not attached to the new business.');
    assert(staffRecord?.role === 'STAFF', 'Invited user was not assigned STAFF role.');
    assert(staffRecord?.isServiceProvider === true, 'Invited staff should be bookable as a service provider.');

    log('resetting staff password for smoke login');
    try {
      await staff.request('/api/auth/forgot-password', {
        method: 'POST',
        json: { email: staffEmail },
      });
    } catch (err) {
      if (!String(err.message || '').includes('Failed to send OTP')) throw err;
      log('staff password-reset email unavailable locally', 'continuing with DB-stored OTP');
    }

    const staffOtp = await prisma.user.findUnique({
      where: { email: staffEmail },
      select: { emailOtp: true },
    });
    assert(staffOtp?.emailOtp, 'Staff password-reset OTP was not stored.');

    await staff.request('/api/auth/reset-password', {
      method: 'POST',
      json: {
        email: staffEmail,
        otp: staffOtp.emailOtp,
        password: TEST_PASSWORD,
      },
    });

    await staff.request('/api/auth/login', {
      method: 'POST',
      json: {
        email: staffEmail,
        password: TEST_PASSWORD,
      },
    });

    log('loading public booking surface');
    const publicBooking = await fetchJson(`${apiBaseUrl}/api/booking/${slug}`);
    assert(publicBooking?.bookingOpen === true, 'Booking should be open after business activation.');
    assert(Array.isArray(publicBooking?.staff) && publicBooking.staff.length >= 2, 'Public booking surface did not expose both admin and invited staff.');

    log('registering customer', customerEmail);
    await customer.request('/api/customer/register', {
      method: 'POST',
      json: {
        businessId,
        name: 'Inbox Customer',
        email: customerEmail,
        password: TEST_PASSWORD,
        acceptTerms: true,
      },
    });

    const customerOtp = await prisma.customer.findFirst({
      where: { businessId, email: customerEmail },
      select: { id: true, emailOtp: true },
    });
    assert(customerOtp?.emailOtp, 'Customer OTP was not stored.');

    await customer.request('/api/customer/verify-otp', {
      method: 'POST',
      json: {
        businessId,
        email: customerEmail,
        otp: customerOtp.emailOtp,
      },
    });

    const bookDate = nextWeekdayIso();
    log('loading slots', bookDate);
    const slots = await fetchJson(`${apiBaseUrl}/api/booking/${slug}/slots?staffId=${encodeURIComponent(staffRecord.id)}&date=${bookDate}`);
    assert(Array.isArray(slots?.slots) && slots.slots.length >= 2, 'Expected at least two available slots for the smoke booking.');

    const firstStart = slots.slots[0];
    const secondStart = slots.slots[1];

    log('creating booking', `${bookDate} ${firstStart}`);
    const booking = await customer.request(`/api/booking/${slug}`, {
      method: 'POST',
      json: {
        staffId: staffRecord.id,
        date: bookDate,
        startTime: firstStart,
        notes: 'Smoke test booking',
      },
    });
    assert(booking?.appointment?.id, 'Booking did not return an appointment id.');

    const appointmentId = booking.appointment.id;

    log('checking customer inbox after booking');
    const customerInboxAfterBooking = await customer.request('/api/inbox');
    assert(customerInboxAfterBooking.unreadCount >= 1, 'Customer inbox should contain at least one unread notification.');
    assert(
      customerInboxAfterBooking.notifications.some((item) => item.type === 'booking_created' && item.appointmentId === appointmentId),
      'Customer inbox did not include the new booking notification.'
    );

    log('checking admin inbox after booking');
    const ownerInboxAfterBooking = await owner.request('/api/inbox');
    assert(
      ownerInboxAfterBooking.notifications.some((item) => item.type === 'booking_created' && item.appointmentId === appointmentId),
      'Admin inbox did not include the new booking notification.'
    );

    log('checking staff inbox after booking');
    const staffInboxAfterBooking = await staff.request('/api/inbox');
    assert(
      staffInboxAfterBooking.notifications.some((item) => item.type === 'booking_created' && item.appointmentId === appointmentId),
      'Staff inbox did not include the new booking notification.'
    );

    log('checking staff calendar feed link');
    const staffCalendar = await staff.request('/api/inbox/calendar-feed');
    assert(staffCalendar?.links?.httpsUrl, 'Staff calendar links were not returned.');
    assert(
      new URL(staffCalendar.links.httpsUrl).origin === apiBaseUrl,
      `Staff calendar link should use the current API origin (${apiBaseUrl}).`
    );
    const staffFeedUrl = staffCalendar.links.httpsUrl.replace(/^https?:\/\/[^/]+/, apiBaseUrl);
    const staffCalendarFeedBefore = await fetchText(staffFeedUrl);
    assert(staffCalendarFeedBefore.includes('BEGIN:VCALENDAR'), 'Staff ICS feed did not render a calendar.');
    assert(staffCalendarFeedBefore.includes(`UID:appointment-${appointmentId}@sitepresso.com`), 'Staff ICS feed did not include the booked appointment.');

    log('checking customer calendar feed link');
    const customerCalendar = await customer.request('/api/inbox/calendar-feed');
    assert(customerCalendar?.links?.httpsUrl, 'Customer calendar links were not returned.');
    assert(
      new URL(customerCalendar.links.httpsUrl).origin === apiBaseUrl,
      `Customer calendar link should use the current API origin (${apiBaseUrl}).`
    );
    const customerFeedUrl = customerCalendar.links.httpsUrl.replace(/^https?:\/\/[^/]+/, apiBaseUrl);
    const customerCalendarFeedBefore = await fetchText(customerFeedUrl);
    assert(customerCalendarFeedBefore.includes('BEGIN:VCALENDAR'), 'Customer ICS feed did not render a calendar.');
    assert(customerCalendarFeedBefore.includes(`UID:appointment-${appointmentId}@sitepresso.com`), 'Customer ICS feed did not include the booked appointment.');

    log('confirming appointment as staff');
    await staff.request(`/api/appointments/${appointmentId}/status`, {
      method: 'PUT',
      json: { status: 'CONFIRMED' },
    });

    const confirmedDelivery = await waitForEmailDelivery(EMAIL_EVENTS.APPOINTMENT_CONFIRMED, appointmentId);
    assertAttachmentMetadata(confirmedDelivery, EMAIL_EVENTS.APPOINTMENT_CONFIRMED);

    log('rescheduling appointment as staff', secondStart);
    await staff.request(`/api/appointments/${appointmentId}/reschedule`, {
      method: 'PUT',
      json: {
        date: bookDate,
        startTime: secondStart,
        endTime: addMinutes(secondStart, 30),
      },
    });

    const rescheduledDelivery = await waitForEmailDelivery(EMAIL_EVENTS.APPOINTMENT_RESCHEDULED, appointmentId);
    assertAttachmentMetadata(rescheduledDelivery, EMAIL_EVENTS.APPOINTMENT_RESCHEDULED);

    const customerInboxAfterReschedule = await customer.request('/api/inbox');
    assert(
      customerInboxAfterReschedule.notifications.some((item) => item.type === 'appointment_rescheduled' && item.appointmentId === appointmentId),
      'Customer inbox did not include the reschedule notification.'
    );

    const ownerInboxAfterReschedule = await owner.request('/api/inbox');
    assert(
      ownerInboxAfterReschedule.notifications.some((item) => item.type === 'appointment_rescheduled' && item.appointmentId === appointmentId),
      'Admin inbox did not include the staff-driven reschedule notification.'
    );

    log('marking one notification as read');
    const firstUnread = customerInboxAfterReschedule.notifications.find((item) => !item.readAt);
    assert(firstUnread, 'Expected at least one unread customer notification.');
    await customer.request(`/api/inbox/${firstUnread.id}/read`, {
      method: 'POST',
      json: {},
    });

    log('cancelling appointment as staff');
    await staff.request(`/api/appointments/${appointmentId}/status`, {
      method: 'PUT',
      json: { status: 'CANCELLED' },
    });

    const ownerInboxAfterCancel = await owner.request('/api/inbox');
    assert(
      ownerInboxAfterCancel.notifications.some((item) => item.type === 'appointment_cancelled' && item.appointmentId === appointmentId),
      'Admin inbox did not include the staff-driven cancellation notification.'
    );

    const customerInboxAfterCancel = await customer.request('/api/inbox');
    assert(
      customerInboxAfterCancel.notifications.some((item) => item.type === 'appointment_cancelled' && item.appointmentId === appointmentId),
      'Customer inbox did not include the cancellation notification.'
    );

    log('marking all customer notifications as read');
    await customer.request('/api/inbox/read-all', {
      method: 'POST',
      json: {},
    });

    const unreadAfterMarkAll = await customer.request('/api/inbox?filter=unread');
    assert(unreadAfterMarkAll.unreadCount === 0, 'Unread count should be zero after mark-all-read.');
    assert(unreadAfterMarkAll.notifications.length === 0, 'Unread filter should return no rows after mark-all-read.');

    log('checking cancelled calendar feed state');
    const customerCalendarFeedAfter = await fetchText(customerFeedUrl);
    assert(customerCalendarFeedAfter.includes('STATUS:CANCELLED'), 'Cancelled appointment was not reflected in the customer ICS feed.');
    const staffCalendarFeedAfter = await fetchText(staffFeedUrl);
    assert(staffCalendarFeedAfter.includes('STATUS:CANCELLED'), 'Cancelled appointment was not reflected in the staff ICS feed.');

    console.log('');
    console.log('Local inbox/calendar smoke test passed.');
    console.log(`Business slug: ${slug}`);
    console.log(`Appointment id: ${appointmentId}`);
    console.log(`Customer calendar feed: ${customerFeedUrl}`);
  } finally {
    if (backend) await backend.shutdown();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('');
  console.error('Local inbox/calendar smoke test failed.');
  console.error(err?.message || err);
  process.exitCode = 1;
});
