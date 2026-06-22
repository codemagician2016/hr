const { SESClient, SendEmailCommand, SendRawEmailCommand } = require('@aws-sdk/client-ses');
const prisma = require('../lib/prisma');
const { EMAIL_EVENTS, categoryForEmailEvent } = require('../lib/emailEvents');
const { generateGoogleCalendarLink, zonedDateTimeToUtc } = require('./calendarLinks');
const { renderSingleAppointmentCalendar } = require('./calendarIcs');
const { tFor } = require('../../i18n/translator');
const { DEFAULT_CURRENCY } = require('../lib/currency');

const ses = new SESClient({
  region: process.env.AWS_REGION,
  // When explicit keys are provided (local/dev), use them. Otherwise fall back to
  // the default AWS credential provider chain — i.e. the EC2 instance role — so
  // production needs no long-lived access keys in its environment.
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }
    : {}),
});

const EMAIL_PALETTE = buildEmailPalette();

function currentEmailProvider() {
  return String(process.env.EMAIL_TRANSPORT_MODE || '').toLowerCase() === 'stub'
    ? 'EMAIL_STUB'
    : 'AWS_SES';
}

function buildEmailPalette() {
  // Light, airy palette. Primary is the indigo accent used across the app
  // UI — it only appears on buttons, the OTP block, and small highlights.
  // Hero is a soft white panel instead of a dark gradient, keeping the
  // reading surface bright and friendly in any mail client.
  const primary = '#4F46E5';
  const primaryAlt = '#6366F1';
  const accent = '#10B981';
  const surface = '#FFFFFF';
  const bg = '#F5F7FB';
  const text = '#0F172A';
  const muted = '#64748B';

  return {
    primary,
    primaryAlt,
    accent,
    accentSoft: '#ECFDF5',
    accentBorder: '#A7F3D0',
    onPrimary: '#FFFFFF',
    bg,
    surface,
    text,
    muted,
    border: '#E5E9F2',
    soft: '#F8FAFC',
    softBorder: '#E2E8F0',
    subtle: '#EEF2F7',
    success: '#059669',
    successSoft: '#ECFDF5',
    successBorder: '#A7F3D0',
    danger: '#DC2626',
    dangerSoft: '#FEF2F2',
    dangerBorder: '#FECACA',
  };
}

// Email routing — see backend/src/lib/emailOverride.js for the rule.
// Single env var: DEPLOY_ENV=production → real recipient. Anything else
// → staging inbox. Safe-by-default: missing DEPLOY_ENV reroutes mail.
const { resolveRecipient, isProductionDeploy } = require('../lib/emailOverride');

function wrapBase64(content) {
  return Buffer.from(String(content || ''), 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n')
    .trim();
}

function encodeMimeWord(value) {
  return `=?UTF-8?B?${Buffer.from(String(value || ''), 'utf8').toString('base64')}?=`;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, '\'')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildRawMimeEmail({ to, subject, htmlBody, attachments = [], envHeader = null }) {
  const mixedBoundary = `ae-mixed-${Date.now().toString(36)}`;
  const altBoundary = `ae-alt-${Math.random().toString(36).slice(2, 10)}`;
  const headers = [
    `From: ${process.env.SES_FROM_EMAIL}`,
    `To: ${to}`,
    `Subject: ${encodeMimeWord(subject)}`,
    'MIME-Version: 1.0',
    ...(envHeader ? [`X-Env: ${envHeader}`] : []),
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    '',
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(stripHtml(htmlBody)),
    '',
    `--${altBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(htmlBody),
    '',
    `--${altBoundary}--`,
  ];

  attachments.forEach((attachment) => {
    headers.push(
      `--${mixedBoundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      ...(attachment.contentType.startsWith('text/calendar') ? ['Content-Class: urn:content-classes:calendarmessage'] : []),
      '',
      wrapBase64(attachment.content),
      ''
    );
  });

  headers.push(`--${mixedBoundary}--`, '');
  return Buffer.from(headers.join('\r\n'));
}

async function sendEmail(to, subject, htmlBody, options = {}) {
  const { requestedRecipient, actualRecipient, overrideApplied } = resolveRecipient(to);
  // D2 — prefix subject with [STAGING] on non-production deployments so
  // test emails are clearly distinguishable in any inbox.
  const isProduction = isProductionDeploy();
  const stagingSubject = isProduction ? subject : `[STAGING] ${subject}`;
  const subjectLine = overrideApplied ? `[To: ${requestedRecipient}] ${stagingSubject}` : stagingSubject;
  const attachments = Array.isArray(options.attachments) ? options.attachments.filter(Boolean) : [];
  const provider = currentEmailProvider();

  if (provider === 'EMAIL_STUB') {
    return {
      provider,
      messageId: `stub-${Date.now().toString(36)}`,
      requestedRecipient,
      actualRecipient,
      overrideApplied,
    };
  }

  if (attachments.length > 0) {
    const rawCommand = new SendRawEmailCommand({
      RawMessage: {
        Data: buildRawMimeEmail({
          to: actualRecipient,
          subject: subjectLine,
          htmlBody,
          attachments,
          envHeader: isProduction ? null : 'staging',
        }),
      },
      Source: process.env.SES_FROM_EMAIL,
      Destinations: [actualRecipient],
    });

    const response = await ses.send(rawCommand);
    return {
      provider,
      messageId: response?.MessageId || null,
      requestedRecipient,
      actualRecipient,
      overrideApplied,
    };
  }

  // D2 — staging sends always use the raw MIME path so the X-Env header
  // is included. Production sends with no attachments use the cheaper
  // SendEmailCommand.
  if (!isProduction) {
    const rawCommand = new SendRawEmailCommand({
      RawMessage: {
        Data: buildRawMimeEmail({
          to: actualRecipient,
          subject: subjectLine,
          htmlBody,
          attachments: [],
          envHeader: 'staging',
        }),
      },
      Source: process.env.SES_FROM_EMAIL,
      Destinations: [actualRecipient],
    });
    const response = await ses.send(rawCommand);
    return {
      provider,
      messageId: response?.MessageId || null,
      requestedRecipient,
      actualRecipient,
      overrideApplied,
    };
  }

  const command = new SendEmailCommand({
    Source: process.env.SES_FROM_EMAIL,
    Destination: {
      ToAddresses: [actualRecipient],
    },
    Message: {
      Subject: { Data: subjectLine, Charset: 'UTF-8' },
      Body: {
        Html: { Data: htmlBody, Charset: 'UTF-8' },
      },
    },
  });

  const response = await ses.send(command);
  return {
    provider,
    messageId: response?.MessageId || null,
    requestedRecipient,
    actualRecipient,
    overrideApplied,
  };
}

async function createEmailDeliveryLog(payload) {
  try {
    return await prisma.emailDelivery.create({
      data: payload,
      select: { id: true },
    });
  } catch (err) {
    console.error('[email] create log failed:', err?.message || err);
    return null;
  }
}

async function updateEmailDeliveryLog(id, data) {
  if (!id) return;
  try {
    await prisma.emailDelivery.update({
      where: { id },
      data,
    });
  } catch (err) {
    console.error('[email] update log failed:', err?.message || err);
  }
}

async function sendTrackedEmail({
  eventKey,
  category,
  to,
  recipientName = null,
  subject,
  htmlBody,
  attachments = null,
  businessId = null,
  userId = null,
  customerId = null,
  appointmentId = null,
  subscriptionId = null,
  metadata = null,
}) {
  const senderEmail = process.env.SES_FROM_EMAIL || null;
  const provider = currentEmailProvider();
  const { actualRecipient, overrideApplied } = resolveRecipient(to);
  const normalizedAttachments = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  const attachmentMetadata = normalizedAttachments.length > 0
    ? {
        attachmentCount: normalizedAttachments.length,
        attachments: normalizedAttachments.map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.contentType,
        })),
      }
    : null;
  const delivery = await createEmailDeliveryLog({
    eventKey,
    category: category || categoryForEmailEvent(eventKey),
    provider,
    senderEmail,
    recipientEmail: to,
    actualRecipientEmail: actualRecipient,
    recipientName,
    subject,
    status: 'PENDING',
    businessId,
    userId,
    customerId,
    appointmentId,
    subscriptionId,
    metadata: attachmentMetadata
      ? { ...(metadata || {}), ...attachmentMetadata }
      : metadata,
    overrideApplied,
    attemptedAt: new Date(),
  });

  try {
    const result = await sendEmail(to, subject, htmlBody, { attachments: normalizedAttachments });
    await updateEmailDeliveryLog(delivery?.id, {
      status: 'SENT',
      provider: result?.provider || provider,
      providerMessageId: result?.messageId || null,
      actualRecipientEmail: result?.actualRecipient || actualRecipient,
      overrideApplied: Boolean(result?.overrideApplied),
      sentAt: new Date(),
    });
    return result;
  } catch (err) {
    await updateEmailDeliveryLog(delivery?.id, {
      status: 'FAILED',
      provider,
      errorMessage: String(err?.message || err),
      actualRecipientEmail: actualRecipient,
      overrideApplied,
    });
    throw err;
  }
}

function buildAppointmentIcsAttachment(ctx) {
  if (!ctx?.appointmentId || !ctx?.date || !ctx?.startTime || !ctx?.endTime) return null;
  const method = ctx.icsMethod || 'REQUEST';
  return {
    filename: `appointment-${ctx.appointmentId}.ics`,
    contentType: `text/calendar; method=${method}; charset=UTF-8`,
    content: renderSingleAppointmentCalendar(ctx, {
      method,
      sequence: ctx.icsSequence || ctx.updatedAt || null,
      attendeeEmail: ctx.recipientEmail || '',
      organizerEmail: process.env.SES_FROM_EMAIL || '',
    }),
  };
}

function buildAppointmentInviteAttachment(ctx, recipientEmail) {
  return buildAppointmentIcsAttachment({
    ...ctx,
    status: 'CONFIRMED',
    recipientEmail,
    icsMethod: 'REQUEST',
    icsSequence: ctx.updatedAt ?? null,
  });
}

function buildAppointmentCancelAttachment(ctx, recipientEmail) {
  return buildAppointmentIcsAttachment({
    ...ctx,
    status: 'CANCELLED',
    recipientEmail,
    icsMethod: 'CANCEL',
    icsSequence: ctx.updatedAt ?? null,
  });
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function emailStyles(palette) {
  return `
    body { margin: 0; padding: 32px 0; background: ${palette.bg}; font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; color: ${palette.text}; }
    .shell { width: 100%; padding: 0 14px; box-sizing: border-box; }
    .container { max-width: 620px; margin: 0 auto; background: ${palette.surface}; border-radius: 20px; overflow: hidden; border: 1px solid ${palette.border}; box-shadow: 0 4px 24px rgba(15, 23, 42, 0.06); }
    .hero { padding: 28px 32px 24px; background: ${palette.surface}; border-bottom: 1px solid ${palette.subtle}; }
    .hero-top { margin-bottom: 16px; }
    .brand-pill { display: inline-block; padding: 6px 12px; border-radius: 999px; background: #EEF2FF; border: 1px solid #C7D2FE; color: ${palette.primary}; font-size: 11px; line-height: 1; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 700; }
    .hero-kicker { margin: 0 0 8px; font-size: 11px; line-height: 1.4; letter-spacing: 0.14em; text-transform: uppercase; color: ${palette.muted}; font-weight: 700; }
    .hero h1 { margin: 0; font-size: 26px; line-height: 1.2; letter-spacing: -0.02em; color: ${palette.text}; font-weight: 700; }
    .hero-copy { margin: 10px 0 0; max-width: 500px; font-size: 15px; line-height: 1.65; color: ${palette.muted}; }
    .body { padding: 28px 32px 24px; color: ${palette.text}; }
    .body p { margin: 0 0 14px; line-height: 1.65; color: ${palette.text}; font-size: 15px; }
    .lead { font-size: 16px; line-height: 1.65; color: ${palette.text}; }
    .muted { color: ${palette.muted}; font-size: 13px; }
    .panel { margin: 20px 0; padding: 18px 20px; background: ${palette.soft}; border: 1px solid ${palette.softBorder}; border-radius: 14px; }
    .panel-label { margin: 0 0 12px; font-size: 11px; line-height: 1.4; letter-spacing: 0.12em; text-transform: uppercase; color: ${palette.muted}; font-weight: 700; }
    .step { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
    .step:last-child { margin-bottom: 0; }
    .step-num { width: 26px; height: 26px; border-radius: 999px; background: ${palette.primary}; color: ${palette.onPrimary}; font-size: 12px; font-weight: 700; line-height: 26px; text-align: center; flex-shrink: 0; }
    .step-text { font-size: 14px; color: ${palette.text}; line-height: 1.6; padding-top: 2px; }
    .checklist { margin: 14px 0 0; }
    .check-item { display: block; margin-bottom: 10px; }
    .check-dot { display: inline-block; width: 6px; height: 6px; margin-right: 10px; border-radius: 999px; background: ${palette.accent}; vertical-align: middle; }
    .check-copy { display: inline; color: ${palette.text}; font-size: 14px; line-height: 1.6; }
    .notice { margin: 18px 0; padding: 14px 16px; background: #EEF2FF; border: 1px solid #C7D2FE; border-radius: 12px; }
    .notice.notice-success { background: ${palette.successSoft}; border-color: ${palette.successBorder}; }
    .notice.notice-danger { background: ${palette.dangerSoft}; border-color: ${palette.dangerBorder}; }
    .notice-title { margin: 0 0 4px; font-size: 12px; line-height: 1.4; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 700; color: ${palette.primary}; }
    .notice.notice-success .notice-title { color: ${palette.success}; }
    .notice.notice-danger .notice-title { color: ${palette.danger}; }
    .notice p { margin: 0; font-size: 14px; line-height: 1.6; color: ${palette.text}; }
    .details { width: 100%; border-collapse: collapse; }
    .details td { padding: 10px 0; font-size: 14px; vertical-align: top; color: ${palette.text}; border-top: 1px solid ${palette.subtle}; }
    .details tr:first-child td { border-top: none; padding-top: 0; }
    .details td.label { width: 120px; color: ${palette.muted}; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 700; }
    .badge { display: inline-block; margin: 4px 0 0; padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; }
    .status-success { background: ${palette.successSoft}; color: ${palette.success}; border: 1px solid ${palette.successBorder}; }
    .status-danger { background: ${palette.dangerSoft}; color: ${palette.danger}; border: 1px solid ${palette.dangerBorder}; }
    .btn { display: inline-block; margin: 18px 0 6px; padding: 12px 22px; border-radius: 10px; background: ${palette.primary}; color: ${palette.onPrimary} !important; text-decoration: none; font-size: 14px; font-weight: 600; letter-spacing: 0.01em; }
    .otp-shell { margin: 20px 0 12px; padding: 20px 16px; border-radius: 14px; background: #EEF2FF; border: 1px solid #C7D2FE; text-align: center; }
    .otp-label { margin: 0 0 10px; font-size: 11px; line-height: 1.4; letter-spacing: 0.14em; text-transform: uppercase; color: ${palette.muted}; font-weight: 700; }
    .otp { margin: 0; font-size: 32px; font-weight: 700; letter-spacing: 10px; color: ${palette.primary}; text-align: center; font-family: 'SF Mono', 'Menlo', 'Consolas', monospace; }
    .signature { margin-top: 24px; padding-top: 16px; border-top: 1px solid ${palette.subtle}; }
    .signature p { margin: 0 0 4px; font-size: 14px; color: ${palette.text}; }
    .signature-name { font-size: 13px; color: ${palette.text}; font-weight: 600; }
    .signature .muted { font-size: 13px; color: ${palette.muted}; }
    .footer { padding: 18px 32px 22px; background: ${palette.soft}; border-top: 1px solid ${palette.subtle}; }
    .footer-brand { margin: 0 0 6px; font-size: 11px; line-height: 1.4; letter-spacing: 0.14em; text-transform: uppercase; color: ${palette.primary}; font-weight: 700; }
    .footer-copy { color: ${palette.muted}; font-size: 12px; line-height: 1.6; }
    a { color: ${palette.primary}; }
    @media only screen and (max-width: 620px) {
      body { padding: 16px 0; }
      .hero, .body, .footer { padding-left: 22px; padding-right: 22px; }
      .hero h1 { font-size: 22px; }
      .details td, .body p { font-size: 14px; }
      .details td.label { width: 100px; }
      .otp { font-size: 28px; letter-spacing: 7px; }
    }
  `;
}

function renderEmail({ eyebrow = 'DriftHR', title, lead = '', introHtml = '', bodyHtml = '', footerHtml = '', headHtml = '' }) {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        ${headHtml}
        <style>${emailStyles(EMAIL_PALETTE)}</style>
      </head>
      <body>
        <div class="shell">
          <div class="container">
            <div class="hero">
              <div class="hero-top">
                <span class="brand-pill">DriftHR</span>
              </div>
              <p class="hero-kicker">${escapeHtml(eyebrow)}</p>
              <h1>${title}</h1>
              ${lead ? `<p class="hero-copy">${lead}</p>` : ''}
            </div>
            <div class="body">
              ${introHtml}
              ${bodyHtml}
            </div>
            <div class="footer">
              <p class="footer-brand">DriftHR</p>
              <div class="footer-copy">${footerHtml}</div>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;
}

function renderDetailsTable(rows, options = {}) {
  return `
    <div class="panel">
      ${options.title ? `<p class="panel-label">${escapeHtml(options.title)}</p>` : ''}
      <table class="details" role="presentation">
        ${rows.map(([label, value]) => `
          <tr>
            <td class="label">${escapeHtml(label)}</td>
            <td>${value}</td>
          </tr>
        `).join('')}
      </table>
    </div>
  `;
}

function renderChecklist(items = []) {
  if (!items.length) return '';
  return `
    <div class="panel">
      <p class="panel-label">What Happens Next</p>
      <div class="checklist">
        ${items.map((item) => `
          <div class="check-item">
            <span class="check-dot"></span><span class="check-copy">${item}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderNotice(title, body, tone = 'default') {
  return `
    <div class="notice${tone === 'success' ? ' notice-success' : tone === 'danger' ? ' notice-danger' : ''}">
      <p class="notice-title">${escapeHtml(title)}</p>
      <p>${body}</p>
    </div>
  `;
}

function renderSignature(name = 'The DriftHR team', note = '') {
  return `
    <div class="signature">
      <p>Thanks,</p>
      <p class="signature-name">${escapeHtml(name)}</p>
      ${note ? `<p class="muted">${note}</p>` : ''}
    </div>
  `;
}

function formatHumanDate(dateStr) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${dateStr}T00:00:00.000Z`));
  } catch {
    return dateStr;
  }
}

function optionalText(value) {
  const str = String(value || '').trim();
  return str || undefined;
}

function buildPostalAddressSchema(ctx) {
  const postalAddress = {
    '@type': 'PostalAddress',
    streetAddress: optionalText(ctx.address),
    addressLocality: optionalText(ctx.city || ctx.addressLocality),
    addressRegion: optionalText(ctx.state),
    postalCode: optionalText(ctx.postalCode),
    addressCountry: optionalText(ctx.country),
  };

  return Object.keys(postalAddress).length > 1 ? postalAddress : null;
}

function buildAppointmentMarkup(ctx, options = {}) {
  if (!ctx?.appointmentId || !ctx?.userName || !ctx?.date || !ctx?.startTime || !ctx?.endTime) return '';

  try {
    const startDate = zonedDateTimeToUtc(ctx.date, ctx.startTime, ctx.timezone || 'UTC').toISOString();
    const endDate = zonedDateTimeToUtc(ctx.date, ctx.endTime, ctx.timezone || 'UTC').toISOString();
    const googleUrl = generateGoogleCalendarLink({ ...ctx, status: options.status || 'CONFIRMED' });
    const postalAddress = buildPostalAddressSchema(ctx);
    const serviceName = optionalText(ctx.serviceName) || 'Appointment';
    const businessName = optionalText(ctx.businessName) || 'DriftHR';
    const staffName = optionalText(ctx.staffName);
    const eventDescription = [
      `${serviceName} appointment`,
      staffName ? `with ${staffName}` : '',
      `at ${businessName}`,
    ].filter(Boolean).join(' ');
    const schema = {
      '@context': 'http://schema.org',
      '@type': 'EventReservation',
      reservationNumber: ctx.appointmentId,
      reservationStatus: options.reservationStatus || 'http://schema.org/Confirmed',
      underName: {
        '@type': 'Person',
        name: ctx.userName,
        ...(optionalText(ctx.recipientEmail) ? { email: optionalText(ctx.recipientEmail) } : {}),
      },
      reservationFor: {
        '@type': 'Event',
        name: serviceName,
        description: eventDescription,
        startDate,
        endDate,
        location: {
          '@type': 'Place',
          name: businessName,
          ...(postalAddress ? { address: postalAddress } : {}),
        },
        ...(staffName ? {
          performer: {
            '@type': 'Person',
            name: staffName,
          },
        } : {}),
      },
      bookingAgent: {
        '@type': 'Organization',
        name: 'DriftHR',
        ...(optionalText(process.env.FRONTEND_URL) ? { url: optionalText(process.env.FRONTEND_URL) } : {}),
      },
      bookingTime: new Date().toISOString(),
      modifiedTime: new Date().toISOString(),
    };

    if (googleUrl) {
      schema.action = {
        '@type': 'ViewAction',
        name: 'Add to Calendar',
        url: googleUrl,
      };
    }

    return `<script type="application/ld+json">${JSON.stringify(schema).replace(/<\/script/gi, '<\\/script')}</script>`;
  } catch {
    return '';
  }
}

async function sendWelcomeEmail(to, name, options = {}) {
  const platformUrl = process.env.FRONTEND_URL || 'https://sitepresso.com';
  const safeName = escapeHtml(name);
  const subject = `Welcome to DriftHR, ${name}`;
  const html = renderEmail({
    eyebrow: 'Welcome',
    title: `You’re in, ${name}`,
    lead: 'Your account is verified. Next stop: set up your booking page in a few minutes.',
    introHtml: `
      <p>Hi ${safeName},</p>
      <p class="lead">Thanks for joining DriftHR. We built this to get your booking page live fast — so let&rsquo;s finish setup and get you ready to take your first appointment.</p>
    `,
    bodyHtml: `
      ${renderChecklist([
        '<strong>Finish onboarding</strong> — your business name, address, and a couple of services.',
        '<strong>Add your team</strong> (or just yourself) and set your hours.',
        '<strong>Share your booking link</strong> with customers — you can always tweak later.',
      ])}
      ${renderNotice('Tip', 'Most people finish setup in one sitting — it takes about 5 minutes. You can change anything later from your admin dashboard.')}
      <a href="${escapeHtml(platformUrl)}/onboarding" class="btn">Finish setup →</a>
      <p class="muted">Already started? Your progress is saved — just head back to <a href="${escapeHtml(platformUrl)}/onboarding">${escapeHtml(platformUrl)}/onboarding</a>.</p>
      ${renderSignature('The DriftHR team', 'Reply to this email anytime — a real person will get back to you.')}
    `,
    footerHtml: `&copy; ${new Date().getFullYear()} DriftHR. All rights reserved.`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.USER_WELCOME,
    to,
    recipientName: name,
    subject,
    htmlBody: html,
    businessId: options.businessId || null,
    userId: options.userId || null,
    metadata: options.metadata || null,
  });
}

async function sendPasswordResetOtpEmail(to, name, otp, options = {}) {
  const safeName = escapeHtml(name);
  const safeOtp = escapeHtml(otp);
  const t = tFor(options.locale);
  const subject = t('passwordResetOtp.subject');
  const html = renderEmail({
    eyebrow: t('passwordResetOtp.eyebrow'),
    title: t('passwordResetOtp.title'),
    lead: t('passwordResetOtp.lead'),
    introHtml: `
      <p>${escapeHtml(t('common.greeting', { name }))},</p>
      <p class="lead">${escapeHtml(t('passwordResetOtp.intro'))}</p>
    `,
    bodyHtml: `
      <div class="otp-shell">
        <p class="otp-label">${escapeHtml(t('passwordResetOtp.codeLabel'))}</p>
        <div class="otp">${safeOtp}</div>
      </div>
      ${renderNotice(t('passwordResetOtp.noticeTitle'), t('passwordResetOtp.noticeBody'))}
    `,
    footerHtml: escapeHtml(t('passwordResetOtp.footer')),
  });

  await sendTrackedEmail({
    eventKey: options.eventKey || EMAIL_EVENTS.USER_PASSWORD_RESET_OTP,
    to,
    recipientName: name,
    subject,
    htmlBody: html,
    businessId: options.businessId || null,
    userId: options.userId || null,
    customerId: options.customerId || null,
    metadata: {
      otpLength: String(otp || '').length,
      ...(options.metadata || {}),
    },
  });
}

// Shared signup-OTP + password-reset-OTP builder so we keep one template
// design. The caller supplies the tone (eyebrow / title / lead / etc) and
// we wrap the code in the same light styled container.
async function sendOtpStyledEmail(to, name, otp, subject, config, options = {}) {
  const safeName = escapeHtml(name || 'there');
  const safeOtp = escapeHtml(otp);
  const html = renderEmail({
    eyebrow: config.eyebrow,
    title: config.title,
    lead: config.lead,
    introHtml: `
      <p>Hi ${safeName},</p>
      <p class="lead">${config.intro}</p>
    `,
    bodyHtml: `
      <div class="otp-shell">
        <p class="otp-label">${escapeHtml(config.codeLabel || 'Verification code')}</p>
        <div class="otp">${safeOtp}</div>
      </div>
      ${config.noticeTitle ? renderNotice(config.noticeTitle, config.noticeBody) : ''}
      ${config.signatureNote ? renderSignature('The DriftHR team', config.signatureNote) : ''}
    `,
    footerHtml: config.footer || 'Didn&rsquo;t request this? You can safely ignore this email.',
  });

  await sendTrackedEmail({
    eventKey: options.eventKey,
    to,
    recipientName: name,
    subject,
    htmlBody: html,
    businessId: options.businessId || null,
    userId: options.userId || null,
    customerId: options.customerId || null,
    metadata: {
      otpLength: String(otp || '').length,
      ...(options.metadata || {}),
    },
  });
}

// Customer-side signup OTP (for storefront bookings). Friendly, short,
// branded to the business rather than DriftHR platform-speak.
async function sendCustomerSignupOtpEmail(to, name, otp, options = {}) {
  const t = tFor(options.locale);
  return sendOtpStyledEmail(to, name, otp, t('customerSignupOtp.subject'), {
    eyebrow: t('customerSignupOtp.eyebrow'),
    title: t('customerSignupOtp.title'),
    lead: t('customerSignupOtp.lead'),
    intro: t('customerSignupOtp.intro'),
    codeLabel: t('customerSignupOtp.codeLabel'),
    noticeTitle: t('customerSignupOtp.noticeTitle'),
    noticeBody: t('customerSignupOtp.noticeBody'),
    footer: t('customerSignupOtp.footer'),
  }, { ...options, eventKey: options.eventKey || EMAIL_EVENTS.CUSTOMER_SIGNUP_OTP });
}

// Sent right after signup to verify the new user's email. Distinct from
// the password-reset OTP — different tone, different subject, different
// copy — so the customer can't mistake a welcome email for a "someone is
// trying to reset your password" alert.
async function sendUserSignupOtpEmail(to, name, otp, options = {}) {
  const safeName = escapeHtml(name);
  const safeOtp = escapeHtml(otp);
  const subject = 'Verify your email to get started';
  const html = renderEmail({
    eyebrow: 'Verify your email',
    title: 'Welcome to DriftHR',
    lead: 'One small step before you set up your business — verify your email with the code below.',
    introHtml: `
      <p>Hi ${safeName},</p>
      <p class="lead">Thanks for signing up. Enter this code on the verification screen to confirm your email. It expires in 10 minutes.</p>
    `,
    bodyHtml: `
      <div class="otp-shell">
        <p class="otp-label">Email verification code</p>
        <div class="otp">${safeOtp}</div>
      </div>
      ${renderNotice('Why verify?', 'A verified email keeps your account secure and makes sure booking confirmations and reminders reach you.')}
      ${renderSignature('The DriftHR team', 'See you on the other side of the form.')}
    `,
    footerHtml: 'Didn&rsquo;t sign up? You can safely ignore this email.',
  });

  await sendTrackedEmail({
    eventKey: options.eventKey || EMAIL_EVENTS.USER_SIGNUP_OTP,
    to,
    recipientName: name,
    subject,
    htmlBody: html,
    businessId: options.businessId || null,
    userId: options.userId || null,
    customerId: options.customerId || null,
    metadata: {
      otpLength: String(otp || '').length,
      ...(options.metadata || {}),
    },
  });
}

// Build a "Join the meeting" CTA block for virtual appointments. Returns
// empty string when no URL is present, so we can unconditionally
// concatenate it into bodyHtml. Used by the booked / reschedule /
// reminder templates.
function renderMeetingLink(meetingUrl) {
  if (!meetingUrl) return '';
  return `
    <div style="margin:20px 0; padding:16px; border:1px solid #C7D2FE; background:#EEF2FF; border-radius:12px;">
      <p style="margin:0 0 8px; font-size:11px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:#4F46E5;">Online appointment</p>
      <p style="margin:0 0 12px; font-size:14px; color:#1E1B4B;">Join via the link below at your appointment time.</p>
      <a href="${meetingUrl}" class="btn-primary" style="display:inline-block; padding:10px 22px; background:#4F46E5; color:#fff; text-decoration:none; border-radius:10px; font-weight:600; font-size:13px;">Join the meeting</a>
      <p style="margin:10px 0 0; font-size:11px; color:#6B7280; word-break:break-all;">Or paste this link into your browser: <span style="color:#4F46E5;">${escapeHtml(meetingUrl)}</span></p>
    </div>
  `;
}

async function sendAppointmentBookedEmail(to, ctx) {
  if (ctx.bookingKind === 'restaurant') {
    const subject = `Reservation confirmed at ${ctx.businessName}`;
    const html = renderEmail({
      eyebrow: 'Table reservation',
      title: `We saved your table, ${escapeHtml(ctx.userName)}`,
      lead: `Your reservation at ${escapeHtml(ctx.businessName)} is confirmed.`,
      introHtml: `
        <p>Hi ${escapeHtml(ctx.userName)},</p>
        <p class="lead">Your table reservation is confirmed. The host stand has your party size, time, and guest notes.</p>
      `,
      bodyHtml: renderDetailsTable([
        ['Experience', `<strong>${escapeHtml(ctx.serviceName)}</strong>`],
        ['Host', escapeHtml(ctx.staffName || 'Host stand')],
        ['Date', escapeHtml(ctx.date)],
        ['Time', `${escapeHtml(ctx.startTime)} - ${escapeHtml(ctx.endTime)}`],
      ], { title: 'Reservation details' })
        + renderNotice('Before you arrive', 'Please contact the restaurant if your party size changes or you expect to be late.')
        + renderSignature(),
      footerHtml: `You&rsquo;re receiving this because you reserved a table at ${escapeHtml(ctx.businessName)}.`,
    });

    await sendTrackedEmail({
      eventKey: EMAIL_EVENTS.BOOKING_CREATED_CUSTOMER,
      to,
      recipientName: ctx.userName,
      subject,
      htmlBody: html,
      businessId: ctx.businessId || null,
      userId: ctx.userId || null,
      customerId: ctx.customerId || null,
      appointmentId: ctx.appointmentId || null,
      metadata: {
        serviceName: ctx.serviceName,
        staffName: ctx.staffName,
        date: ctx.date,
        startTime: ctx.startTime,
        endTime: ctx.endTime,
        bookingKind: ctx.bookingKind,
      },
    });
    return;
  }

  const t = tFor(ctx.locale);
  const subject = t('appointmentBooked.subjectPending', { businessName: ctx.businessName });

  const html = renderEmail({
    eyebrow: t('appointmentBooked.eyebrow'),
    title: t('appointmentBooked.title', { name: ctx.userName }),
    lead: t('appointmentBooked.lead'),
    introHtml: `
      <p>${escapeHtml(t('common.greeting', { name: ctx.userName }))},</p>
      <p class="lead">${escapeHtml(t('appointmentBooked.introPending', { businessName: ctx.businessName }))}</p>
    `,
    bodyHtml: renderDetailsTable([
      [t('appointmentBooked.labelService'), `<strong>${escapeHtml(ctx.serviceName)}</strong>`],
      [t('appointmentBooked.labelStaff'), escapeHtml(ctx.staffName)],
      [t('appointmentBooked.labelDate'), escapeHtml(ctx.date)],
      [t('appointmentBooked.labelTime'), `${escapeHtml(ctx.startTime)} - ${escapeHtml(ctx.endTime)}`],
    ], { title: t('appointmentBooked.detailsHeader') })
      + renderMeetingLink(ctx.meetingUrl)
      + renderNotice(t('appointmentBooked.detailsHeader'), t('appointmentBooked.introPending', { businessName: ctx.businessName })) + renderSignature(),
    footerHtml: escapeHtml(t('appointmentBooked.footer', { businessName: ctx.businessName })),
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.BOOKING_CREATED_CUSTOMER,
    to,
    recipientName: ctx.userName,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    userId: ctx.userId || null,
    customerId: ctx.customerId || null,
    appointmentId: ctx.appointmentId || null,
    metadata: {
      serviceName: ctx.serviceName,
      staffName: ctx.staffName,
      date: ctx.date,
      startTime: ctx.startTime,
      endTime: ctx.endTime,
    },
  });
}

async function sendStaffNewAppointmentEmail(to, ctx) {
  if (ctx.bookingKind === 'restaurant') {
    const subject = `New reservation: ${ctx.userName} - ${ctx.date} ${ctx.startTime}`;
    const attachments = [buildAppointmentInviteAttachment(ctx, to)];
    const html = renderEmail({
      eyebrow: 'Host stand',
      title: 'New table reservation',
      lead: 'A guest reserved a table online. Review party size, timing, seating notes, and policy details before service.',
      introHtml: `
        <p>Hi ${escapeHtml(ctx.staffName || 'Team')},</p>
        <p class="lead">A new reservation just came in for <strong>${escapeHtml(ctx.businessName)}</strong>.</p>
      `,
      bodyHtml: renderDetailsTable([
        ['Guest', `<strong>${escapeHtml(ctx.userName)}</strong>`],
        ['Experience', escapeHtml(ctx.serviceName)],
        ['Date', escapeHtml(ctx.date)],
        ['Time', `${escapeHtml(ctx.startTime)} - ${escapeHtml(ctx.endTime)}`],
      ], { title: 'Reservation snapshot' })
        + renderNotice('Next step', 'Open the host stand to assign, seat, mark arrived, or collect payment if a deposit or prepaid rule applies.')
        + renderSignature(),
      footerHtml: `You&rsquo;re receiving this because you manage reservations at ${escapeHtml(ctx.businessName)}.`,
    });

    await sendTrackedEmail({
      eventKey: EMAIL_EVENTS.BOOKING_CREATED_STAFF,
      to,
      recipientName: ctx.staffName,
      subject,
      htmlBody: html,
      attachments,
      businessId: ctx.businessId || null,
      userId: ctx.staffUserId || null,
      appointmentId: ctx.appointmentId || null,
      metadata: {
        customerName: ctx.userName,
        serviceName: ctx.serviceName,
        date: ctx.date,
        startTime: ctx.startTime,
        endTime: ctx.endTime,
        bookingKind: ctx.bookingKind,
      },
    });
    return;
  }

  const subject = `New appointment: ${ctx.userName} — ${ctx.date} ${ctx.startTime}`;
  const markupCtx = { ...ctx, recipientEmail: to };
  const attachments = [buildAppointmentInviteAttachment(ctx, to)];

  const html = renderEmail({
    eyebrow: 'Staff Alert',
    title: 'A new booking needs your attention',
    lead: 'A customer has requested time on your calendar. Review the request promptly to keep the booking experience sharp.',
    introHtml: `
      <p>Hi ${escapeHtml(ctx.staffName)},</p>
      <p class="lead">A new appointment request just came in for <strong>${escapeHtml(ctx.businessName)}</strong>.</p>
    `,
    bodyHtml: renderDetailsTable([
      ['Customer', `<strong>${escapeHtml(ctx.userName)}</strong>`],
      ['Service', escapeHtml(ctx.serviceName)],
      ['Date', escapeHtml(ctx.date)],
      ['Time', `${escapeHtml(ctx.startTime)} - ${escapeHtml(ctx.endTime)}`],
    ], { title: 'Request Snapshot' }) + renderNotice('Next step', 'Log in to your staff dashboard to confirm, reschedule, or manage the request before the customer is left waiting.') + renderSignature(),
    footerHtml: `You&rsquo;re receiving this because you&rsquo;re listed as staff at ${escapeHtml(ctx.businessName)}.`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.BOOKING_CREATED_STAFF,
    to,
    recipientName: ctx.staffName,
    subject,
    htmlBody: html,
    attachments,
    businessId: ctx.businessId || null,
    userId: ctx.staffUserId || null,
    appointmentId: ctx.appointmentId || null,
    metadata: {
      customerName: ctx.userName,
      serviceName: ctx.serviceName,
      date: ctx.date,
      startTime: ctx.startTime,
      endTime: ctx.endTime,
    },
  });
}

async function sendAppointmentStatusEmail(to, ctx) {
  const t = tFor(ctx.locale);
  const isConfirmed = ctx.status === 'CONFIRMED';
  const title = isConfirmed
    ? t('appointmentStatus.titleConfirmed', { name: ctx.userName })
    : t('appointmentStatus.titleCancelled');
  const subject = isConfirmed
    ? t('appointmentStatus.subjectConfirmed', { businessName: ctx.businessName })
    : t('appointmentStatus.subjectCancelled', { businessName: ctx.businessName });
  const markupCtx = { ...ctx, recipientEmail: to };
  const intro = isConfirmed
    ? t('appointmentStatus.introConfirmed', { businessName: ctx.businessName })
    : t('appointmentStatus.introCancelled', { businessName: ctx.businessName });

  const badgeClass = isConfirmed ? 'status-success' : 'status-danger';
  const badgeLabel = isConfirmed
    ? t('appointmentStatus.eyebrowConfirmed')
    : t('appointmentStatus.eyebrowCancelled');
  const summaryHtml = isConfirmed
    ? `<p>${escapeHtml(t('appointmentStatus.leadConfirmed', { businessName: ctx.businessName }))} — <strong>${escapeHtml(ctx.serviceName)}</strong> · <strong>${escapeHtml(formatHumanDate(ctx.date))}</strong> · <strong>${escapeHtml(ctx.startTime)} - ${escapeHtml(ctx.endTime)}</strong> · <strong>${escapeHtml(ctx.staffName)}</strong></p>`
    : `<p>${escapeHtml(t('appointmentStatus.leadCancelled', { businessName: ctx.businessName }))} <strong>${escapeHtml(ctx.serviceName)}</strong> · <strong>${escapeHtml(formatHumanDate(ctx.date))}</strong> · <strong>${escapeHtml(ctx.startTime)} - ${escapeHtml(ctx.endTime)}</strong> · <strong>${escapeHtml(ctx.staffName)}</strong></p>`;
  const attachments = isConfirmed ? [buildAppointmentInviteAttachment(ctx, to)] : [buildAppointmentCancelAttachment(ctx, to)];

  const html = renderEmail({
    eyebrow: isConfirmed ? t('appointmentStatus.eyebrowConfirmed') : t('appointmentStatus.eyebrowCancelled'),
    title,
    lead: isConfirmed
      ? t('appointmentStatus.leadConfirmed', { businessName: ctx.businessName })
      : t('appointmentStatus.leadCancelled', { businessName: ctx.businessName }),
    headHtml: isConfirmed ? buildAppointmentMarkup({ ...markupCtx, status: 'CONFIRMED' }) : '',
    introHtml: `
      <p>${escapeHtml(t('common.greeting', { name: ctx.userName }))},</p>
      <p class="lead">${escapeHtml(intro)}</p>
      <span class="badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>
    `,
    bodyHtml: summaryHtml + renderDetailsTable([
      [t('appointmentBooked.labelService'), `<strong>${escapeHtml(ctx.serviceName)}</strong>`],
      [t('appointmentBooked.labelStaff'), escapeHtml(ctx.staffName)],
      [t('appointmentBooked.labelDate'), escapeHtml(ctx.date)],
      [t('appointmentBooked.labelTime'), `${escapeHtml(ctx.startTime)} - ${escapeHtml(ctx.endTime)}`],
    ], { title: isConfirmed ? t('appointmentStatus.eyebrowConfirmed') : t('appointmentStatus.eyebrowCancelled') })
      + (isConfirmed ? renderMeetingLink(ctx.meetingUrl) : '')
      + (isConfirmed
        ? ''
        : `<p style="margin-top:16px;"><a href="https://${escapeHtml(ctx.businessSlug || '')}.${escapeHtml(process.env.PLATFORM_DOMAIN || 'sitepresso.com')}/book" class="btn">${escapeHtml(t('appointmentStatus.rebookCta'))}</a></p>`)
      + renderSignature(),
    footerHtml: escapeHtml(t('appointmentStatus.footer', { businessName: ctx.businessName })),
  });

  await sendTrackedEmail({
    eventKey: isConfirmed ? EMAIL_EVENTS.APPOINTMENT_CONFIRMED : EMAIL_EVENTS.APPOINTMENT_CANCELLED,
    to,
    recipientName: ctx.userName,
    subject,
    htmlBody: html,
    attachments,
    businessId: ctx.businessId || null,
    userId: ctx.userId || null,
    customerId: ctx.customerId || null,
    appointmentId: ctx.appointmentId || null,
    metadata: {
      serviceName: ctx.serviceName,
      staffName: ctx.staffName,
      date: ctx.date,
      startTime: ctx.startTime,
      endTime: ctx.endTime,
      status: ctx.status,
    },
  });
}

async function sendAppointmentRescheduledEmail(to, ctx) {
  const t = tFor(ctx.locale);
  const subject = t('appointmentRescheduled.subject', { businessName: ctx.businessName });
  const markupCtx = { ...ctx, recipientEmail: to };
  const attachments = [buildAppointmentInviteAttachment(ctx, to)];
  const html = renderEmail({
    eyebrow: t('appointmentRescheduled.eyebrow'),
    title: t('appointmentRescheduled.title'),
    lead: t('appointmentRescheduled.lead'),
    headHtml: buildAppointmentMarkup({ ...markupCtx, status: 'CONFIRMED' }),
    introHtml: `
      <p>${escapeHtml(t('common.greeting', { name: ctx.userName }))},</p>
      <p class="lead">${escapeHtml(t('appointmentRescheduled.intro', { businessName: ctx.businessName }))}</p>
      <span class="badge status-success">${escapeHtml(t('appointmentRescheduled.badge'))}</span>
    `,
    bodyHtml: `
      <p>${escapeHtml(t('appointmentRescheduled.summary', { serviceName: ctx.serviceName, date: formatHumanDate(ctx.date), startTime: ctx.startTime, endTime: ctx.endTime, staffName: ctx.staffName }))}</p>
    ` + renderDetailsTable([
      [t('appointmentBooked.labelService'), `<strong>${escapeHtml(ctx.serviceName)}</strong>`],
      [t('appointmentBooked.labelStaff'), escapeHtml(ctx.staffName)],
      [t('appointmentRescheduled.labelPrevious'), `${escapeHtml(ctx.previousDate)} · ${escapeHtml(ctx.previousStartTime)} - ${escapeHtml(ctx.previousEndTime)}`],
      [t('appointmentRescheduled.labelNewSlot'), `${escapeHtml(ctx.date)} · ${escapeHtml(ctx.startTime)} - ${escapeHtml(ctx.endTime)}`],
    ], { title: t('appointmentRescheduled.detailsHeader') }) + renderNotice(t('appointmentRescheduled.noticeTitle'), t('appointmentRescheduled.noticeBody')) + renderSignature(),
    footerHtml: `Appointment ID: ${escapeHtml(ctx.appointmentId)}`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.APPOINTMENT_RESCHEDULED,
    to,
    recipientName: ctx.userName,
    subject,
    htmlBody: html,
    attachments,
    businessId: ctx.businessId || null,
    userId: ctx.userId || null,
    customerId: ctx.customerId || null,
    appointmentId: ctx.appointmentId || null,
    metadata: {
      serviceName: ctx.serviceName,
      staffName: ctx.staffName,
      previousDate: ctx.previousDate,
      previousStartTime: ctx.previousStartTime,
      previousEndTime: ctx.previousEndTime,
      date: ctx.date,
      startTime: ctx.startTime,
      endTime: ctx.endTime,
    },
  });
}

async function sendStaffAppointmentRescheduledEmail(to, ctx) {
  const subject = `Rescheduled: ${ctx.userName} — ${ctx.date} ${ctx.startTime}`;
  const attachments = [buildAppointmentInviteAttachment(ctx, to)];

  const html = renderEmail({
    eyebrow: 'Staff Alert',
    title: 'Appointment rescheduled',
    lead: "A customer's appointment has been moved to a new time. An updated calendar file is attached.",
    introHtml: `
      <p>Hi ${escapeHtml(ctx.staffName)},</p>
      <p class="lead"><strong>${escapeHtml(ctx.userName)}</strong>'s appointment has been rescheduled.</p>
    `,
    bodyHtml: renderDetailsTable([
      ['Customer', `<strong>${escapeHtml(ctx.userName)}</strong>`],
      ['Service', escapeHtml(ctx.serviceName)],
      ['Previous', `${escapeHtml(ctx.previousDate)} · ${escapeHtml(ctx.previousStartTime)} - ${escapeHtml(ctx.previousEndTime)}`],
      ['New slot', `${escapeHtml(ctx.date)} · ${escapeHtml(ctx.startTime)} - ${escapeHtml(ctx.endTime)}`],
    ], { title: 'Updated Appointment' }) + renderNotice('Updated invite attached', 'Use the attached <strong>.ics</strong> file to replace the previous calendar entry with the new confirmed time.') + renderSignature(),
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.APPOINTMENT_RESCHEDULED,
    category: 'STAFF_NOTIFICATION',
    to,
    recipientName: ctx.staffName,
    subject,
    htmlBody: html,
    attachments,
    businessId: ctx.businessId || null,
    userId: ctx.staffUserId || null,
    appointmentId: ctx.appointmentId || null,
  });
}

async function sendStaffAppointmentCancelledEmail(to, ctx) {
  const subject = `Cancelled: ${ctx.userName} — ${ctx.date} ${ctx.startTime}`;
  const attachments = [buildAppointmentCancelAttachment(ctx, to)];

  const html = renderEmail({
    eyebrow: 'Staff Alert',
    title: 'Appointment cancelled',
    lead: "A customer's appointment has been cancelled. A cancellation calendar file is attached to free up your schedule.",
    introHtml: `
      <p>Hi ${escapeHtml(ctx.staffName)},</p>
      <p class="lead"><strong>${escapeHtml(ctx.userName)}</strong>'s appointment has been cancelled.</p>
      <span class="badge status-danger">Cancelled</span>
    `,
    bodyHtml: renderDetailsTable([
      ['Customer', `<strong>${escapeHtml(ctx.userName)}</strong>`],
      ['Service', escapeHtml(ctx.serviceName)],
      ['Date', escapeHtml(ctx.date)],
      ['Time', `${escapeHtml(ctx.startTime)} - ${escapeHtml(ctx.endTime)}`],
    ], { title: 'Cancelled Appointment' }) + renderSignature(),
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.APPOINTMENT_CANCELLED,
    category: 'STAFF_NOTIFICATION',
    to,
    recipientName: ctx.staffName,
    subject,
    htmlBody: html,
    attachments,
    businessId: ctx.businessId || null,
    userId: ctx.staffUserId || null,
    appointmentId: ctx.appointmentId || null,
  });
}

async function sendCustomerWelcomeEmail(to, name, options = {}) {
  const t = tFor(options.locale);
  const businessName = options.businessName || 'our booking platform';
  const subject = t('customerWelcome.subject', { businessName });
  const html = renderEmail({
    eyebrow: t('customerWelcome.eyebrow'),
    title: t('customerWelcome.title'),
    lead: t('customerWelcome.lead'),
    introHtml: `
      <p>${escapeHtml(t('common.greeting', { name }))},</p>
      <p class="lead">${escapeHtml(t('customerWelcome.intro', { businessName }))}</p>
    `,
    bodyHtml: `
      ${renderNotice(t('customerWelcome.noticeTitle'), t('customerWelcome.noticeBody'))}
      ${renderSignature(`${businessName}`)}
    `,
    footerHtml: escapeHtml(t('customerWelcome.footer', { businessName })),
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.CUSTOMER_WELCOME,
    to,
    recipientName: name,
    subject,
    htmlBody: html,
    businessId: options.businessId || null,
    customerId: options.customerId || null,
    metadata: options.metadata || null,
  });
}

async function sendStaffInviteEmail(to, name, inviteLink, tempPassword, options = {}) {
  const safeName = escapeHtml(name);
  const subject = `You have been invited to join ${options.businessName}`;
  const html = renderEmail({
    eyebrow: 'Team Invitation',
    title: 'You&rsquo;ve been invited to the team',
    lead: 'Your access has been prepared so you can sign in, review your calendar, and start managing appointments smoothly.',
    introHtml: `
      <p>Hi ${safeName},</p>
      <p class="lead">You&rsquo;ve been invited to join <strong>${escapeHtml(options.businessName)}</strong> as a staff member on DriftHR.</p>
    `,
    bodyHtml: `
      ${renderNotice('Temporary access', 'Use the credentials below for your first sign-in. After logging in, update your password so your account is fully secured.')}
      ${renderDetailsTable([
        ['Email', escapeHtml(to)],
        ['Password', escapeHtml(tempPassword)]
      ], { title: 'Sign-In Details' })}
      <a href="${escapeHtml(inviteLink)}" class="btn">Accept Invitation</a>
      <p class="muted">If the button doesn&rsquo;t open automatically, copy the invite link from your original message and sign in manually.</p>
      ${renderSignature()}
    `,
    footerHtml: `This invitation was sent by an admin of ${escapeHtml(options.businessName)}.`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.STAFF_INVITE,
    to,
    recipientName: name,
    subject,
    htmlBody: html,
    businessId: options.businessId || null,
    metadata: options.metadata || null,
  });
}

async function sendRiderInviteEmail(to, name, inviteLink, tempPassword, options = {}) {
  const safeName = escapeHtml(name);
  const subject = `You have been invited to deliver for ${options.businessName}`;
  const html = renderEmail({
    eyebrow: 'Rider Invitation',
    title: 'Your rider access is ready',
    lead: 'Sign in to see assigned deliveries, customer drop details, and route updates for your store.',
    introHtml: `
      <p>Hi ${safeName},</p>
      <p class="lead">You&rsquo;ve been invited to join <strong>${escapeHtml(options.businessName)}</strong> as a delivery rider on DriftHR.</p>
    `,
    bodyHtml: `
      ${renderNotice('Temporary access', 'Use the credentials below for your first sign-in. After logging in, update your password so your account is fully secured.')}
      ${renderDetailsTable([
        ['Email', escapeHtml(to)],
        ['Password', escapeHtml(tempPassword)]
      ], { title: 'Sign-In Details' })}
      <a href="${escapeHtml(inviteLink)}" class="btn">Open Rider Portal</a>
      <p class="muted">If the button doesn&rsquo;t open automatically, copy this link into your browser: ${escapeHtml(inviteLink)}</p>
      ${renderSignature(`${escapeHtml(options.businessName)} Team`)}
    `,
    footerHtml: `This rider invitation was sent by an admin of ${escapeHtml(options.businessName)}.`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.RIDER_INVITE,
    to,
    recipientName: name,
    subject,
    htmlBody: html,
    businessId: options.businessId || null,
    metadata: options.metadata || null,
  });
}

async function sendAdminNewAppointmentEmail(to, ctx) {
  const subject = `New appointment: ${ctx.userName} — ${ctx.date} ${ctx.startTime}`;

  const html = renderEmail({
    eyebrow: 'Admin Alert',
    title: 'A new booking just landed',
    lead: 'Your schedule has fresh activity. Review the details below so the customer experience stays fast and well managed.',
    introHtml: `
      <p>Hello,</p>
      <p class="lead">A new appointment has been booked at <strong>${escapeHtml(ctx.businessName)}</strong>.</p>
    `,
    bodyHtml: renderDetailsTable([
      ['Customer', `<strong>${escapeHtml(ctx.userName)}</strong>`],
      ['Service', escapeHtml(ctx.serviceName)],
      ['Staff', escapeHtml(ctx.staffName)],
      ['Date', escapeHtml(ctx.date)],
      ['Time', `${escapeHtml(ctx.startTime)} - ${escapeHtml(ctx.endTime)}`],
    ], { title: 'Booking Snapshot' }) + renderSignature(),
    footerHtml: `You&rsquo;re receiving this because you&rsquo;re an admin at ${escapeHtml(ctx.businessName)}.`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.BOOKING_CREATED_ADMIN,
    to,
    recipientName: 'Admin',
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    appointmentId: ctx.appointmentId || null,
    metadata: {
      customerName: ctx.userName,
      serviceName: ctx.serviceName,
      staffName: ctx.staffName,
      date: ctx.date,
      startTime: ctx.startTime,
      endTime: ctx.endTime,
    },
  });
}

// Blog comment notification — fires when a new comment lands as PENDING
// (auto-approved comments don't notify; routine activity). Recipient is
// the tenant admin's email; ctx carries the post + comment fields.
async function sendBlogCommentNewAdminEmail(to, ctx) {
  const subject = `New blog comment awaiting moderation — "${ctx.postTitle}"`;
  const moderationUrl = ctx.moderationUrl || '';
  const html = renderEmail({
    eyebrow: 'Moderation queue',
    title: 'A new blog comment is waiting',
    lead: 'Approve or reject from your dashboard. Pre-moderation keeps the comment hidden until you act.',
    introHtml: `
      <p>Hello,</p>
      <p class="lead">Someone left a new comment on <strong>${escapeHtml(ctx.postTitle)}</strong>.</p>
    `,
    bodyHtml: renderDetailsTable([
      ['From', `<strong>${escapeHtml(ctx.authorName)}</strong>`],
      ['Email', escapeHtml(ctx.authorEmail || 'N/A')],
      ['Type', ctx.authorType === 'CUSTOMER' ? 'Logged-in customer' : 'Guest'],
      ['Post', escapeHtml(ctx.postTitle)],
    ], { title: 'Comment details' }) + `
      <div class="panel">
        <p class="panel-label">Comment</p>
        <p style="margin-top: 8px; white-space: pre-wrap;">${escapeHtml(ctx.body)}</p>
      </div>
      ${moderationUrl ? `<p style="margin-top: 16px;"><a href="${moderationUrl}" style="background: #1A1714; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Open moderation queue</a></p>` : ''}
      ${renderSignature()}
    `,
    footerHtml: `You can disable these notifications under <strong>Blog &rsaquo; Settings</strong>.`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.BLOG_COMMENT_NEW_ADMIN,
    to,
    recipientName: 'Admin',
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    metadata: { commentId: ctx.commentId, postSlug: ctx.postSlug },
  });
}

async function sendEnquiryReceivedAdminEmail(to, ctx) {
  const subject = `New Website Enquiry: ${ctx.subject || 'Contact Form Submission'}`;
  const html = renderEmail({
    eyebrow: 'Inbox Update',
    title: 'A new website enquiry arrived',
    lead: 'Someone reached out through your storefront. A fast, thoughtful reply usually creates the strongest conversion opportunity.',
    introHtml: `
      <p>Hello,</p>
      <p class="lead">You have received a new enquiry via your storefront contact form.</p>
    `,
    bodyHtml: renderDetailsTable([
      ['Name', `<strong>${escapeHtml(ctx.name)}</strong>`],
      ['Email', escapeHtml(ctx.email || 'N/A')],
      ['Phone', escapeHtml(ctx.phone || 'N/A')],
      ['Subject', escapeHtml(ctx.subject || 'N/A')],
    ], { title: 'Contact Details' }) + `
      <div class="panel">
        <p class="panel-label">Message</p>
        <p style="margin-top: 8px; white-space: pre-wrap;">${escapeHtml(ctx.message)}</p>
      </div>
      ${renderNotice('Recommended response window', 'Following up while the enquiry is still fresh usually gives you the best chance of turning interest into a booking.')}
      ${renderSignature()}
    `,
    footerHtml: `You&rsquo;re receiving this because you&rsquo;re an admin at ${escapeHtml(ctx.businessName)}.`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.ENQUIRY_RECEIVED_ADMIN,
    to,
    recipientName: 'Admin',
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    metadata: {
      enquiryName: ctx.name,
      enquiryEmail: ctx.email,
    },
  });
}

async function sendEnquiryAutoReplyEmail(to, ctx) {
  const t = tFor(ctx.locale);
  const subject = t('enquiryAutoReply.subject', { businessName: ctx.businessName });
  const html = renderEmail({
    eyebrow: t('enquiryAutoReply.eyebrow'),
    title: t('enquiryAutoReply.title'),
    lead: t('enquiryAutoReply.lead'),
    introHtml: `
      <p>${escapeHtml(t('common.greeting', { name: ctx.name }))},</p>
      <p class="lead">${escapeHtml(t('enquiryAutoReply.intro', { businessName: ctx.businessName }))}</p>
    `,
    bodyHtml: `
      <p>${escapeHtml(t('enquiryAutoReply.body'))}</p>
      <div class="panel">
        <p class="panel-label">${escapeHtml(t('enquiryAutoReply.yourMessage'))}</p>
        <p style="margin-top: 8px; white-space: pre-wrap;">${escapeHtml(ctx.message)}</p>
      </div>
      ${renderSignature(`${ctx.businessName} Team`)}
    `,
    footerHtml: escapeHtml(t('enquiryAutoReply.footer', { businessName: ctx.businessName })),
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.ENQUIRY_AUTO_REPLY_CUSTOMER,
    to,
    recipientName: ctx.name,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    metadata: {
      businessName: ctx.businessName,
    },
  });
}

async function sendLeaveRequestAdminEmail(to, ctx) {
  const subject = `New Leave Request from ${ctx.staffName}`;
  const html = renderEmail({
    eyebrow: 'Scheduling Review',
    title: 'A leave request is awaiting approval',
    lead: 'One of your team members has submitted a leave request that may affect upcoming availability.',
    introHtml: `
      <p>Hello,</p>
      <p class="lead"><strong>${escapeHtml(ctx.staffName)}</strong> has submitted a new leave request.</p>
    `,
    bodyHtml: renderDetailsTable([
      ['Staff', `<strong>${escapeHtml(ctx.staffName)}</strong>`],
      ['Start Date', escapeHtml(ctx.startDate)],
      ['End Date', escapeHtml(ctx.endDate)],
      ['Reason', escapeHtml(ctx.reason || 'None provided')],
    ], { title: 'Leave Request' }) + renderNotice('Next step', 'Review the request in your admin dashboard so staff availability and affected bookings stay accurate.') + renderSignature(),
    footerHtml: `You&rsquo;re receiving this because you&rsquo;re an admin at ${escapeHtml(ctx.businessName)}.`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.LEAVE_REQUEST_SUBMITTED_ADMIN,
    to,
    recipientName: 'Admin',
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    metadata: {
      staffName: ctx.staffName,
      startDate: ctx.startDate,
      endDate: ctx.endDate,
    },
  });
}

async function sendLeaveStatusStaffEmail(to, ctx) {
  const isApproved = ctx.status === 'APPROVED';
  const badgeClass = isApproved ? 'status-success' : 'status-danger';
  const badgeLabel = isApproved ? 'Approved' : 'Rejected';
  const subject = `Leave Request ${badgeLabel} — ${ctx.businessName}`;
  
  const html = renderEmail({
    eyebrow: 'Leave Request Update',
    title: `Leave Request ${badgeLabel}`,
    lead: isApproved
      ? 'Your time away has been approved and your schedule can now be planned around it with confidence.'
      : 'Your request was reviewed, but it could not be approved in its current form.',
    introHtml: `
      <p>Hi ${escapeHtml(ctx.staffName)},</p>
      <p class="lead">Your leave request at <strong>${escapeHtml(ctx.businessName)}</strong> has been reviewed.</p>
      <span class="badge ${badgeClass}">${badgeLabel}</span>
    `,
    bodyHtml: renderDetailsTable([
      ['Start Date', escapeHtml(ctx.startDate)],
      ['End Date', escapeHtml(ctx.endDate)],
    ], { title: 'Leave Dates' }) + renderSignature(),
    footerHtml: `You&rsquo;re receiving this because you submitted a leave request at ${escapeHtml(ctx.businessName)}.`,
  });

  await sendTrackedEmail({
    eventKey: isApproved ? EMAIL_EVENTS.LEAVE_REQUEST_APPROVED_STAFF : EMAIL_EVENTS.LEAVE_REQUEST_REJECTED_STAFF,
    to,
    recipientName: ctx.staffName,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    metadata: {
      status: ctx.status,
      startDate: ctx.startDate,
      endDate: ctx.endDate,
    },
  });
}

async function sendBookingReminderEmail(to, options = {}) {
  const safeBusinessName = escapeHtml(options.businessName);
  const safeServiceName = escapeHtml(options.serviceName);
  const safeStaffName = escapeHtml(options.staffName);
  const safeDate = escapeHtml(options.date);
  const safeStartTime = escapeHtml(options.startTime);

  const t = tFor(options.locale);
  const is2h = options.reminderType === '2h';
  // 2-hour reminders fall under "today"; 24-hour reminders fall under "tomorrow".
  const whenKey = is2h ? 'bookingReminder.whenToday' : 'bookingReminder.whenTomorrow';
  const when = t(whenKey);

  const html = renderEmail({
    eyebrow: t('bookingReminder.eyebrow'),
    title: t('bookingReminder.title', { when, name: options.userName || '' }),
    lead: t('bookingReminder.lead'),
    introHtml: `
      <p>${escapeHtml(t('common.greeting', { name: options.userName || t('common.greetingFallback') }))},</p>
      <p class="lead">${escapeHtml(t('bookingReminder.intro', { businessName: options.businessName, when, time: options.startTime }))}</p>
    `,
    bodyHtml: `
      ${renderDetailsTable([
        [t('appointmentBooked.labelService'), safeServiceName],
        [t('appointmentBooked.labelDate'), safeDate],
        [t('appointmentBooked.labelTime'), safeStartTime],
        [t('appointmentBooked.labelStaff'), safeStaffName],
      ], { title: t('appointmentBooked.detailsHeader') })}
      ${renderNotice(t('bookingReminder.needToReschedule'), t('bookingReminder.needToRescheduleBody', { businessName: options.businessName }))}
      ${renderSignature()}
    `,
    footerHtml: escapeHtml(t('bookingReminder.footer', { businessName: options.businessName })),
  });

  const subject = is2h
    ? t('bookingReminder.subjectToday', { businessName: options.businessName })
    : t('bookingReminder.subject', { businessName: options.businessName });

  return sendTrackedEmail({
    eventKey: is2h ? EMAIL_EVENTS.BOOKING_REMINDER_2H : EMAIL_EVENTS.BOOKING_REMINDER_24H,
    to,
    recipientName: options.userName,
    subject,
    htmlBody: html,
    businessId: options.businessId,
    appointmentId: options.appointmentId,
    customerId: options.customerId,
    userId: options.userId,
    metadata: {
      serviceName: options.serviceName,
      date: options.date,
      startTime: options.startTime,
    },
  });
}

async function sendStaffInviteReminderEmail(to, name, inviteLink, options = {}) {
  const safeName = escapeHtml(name);
  const subject = `Reminder: Join ${options.businessName} on DriftHR`;
  const html = renderEmail({
    eyebrow: 'Invitation Reminder',
    title: 'Your staff invitation is still waiting',
    lead: 'Your team access is ready. Finish setup so you can start managing your schedule without delay.',
    introHtml: `
      <p>Hi ${safeName},</p>
      <p class="lead">This is a reminder that you have a pending invitation to join <strong>${escapeHtml(options.businessName)}</strong> as a staff member on DriftHR.</p>
    `,
    bodyHtml: `
      ${renderNotice('Ready when you are', 'Use the temporary password from your original invitation email, then complete your setup once you sign in.')}
      <a href="${escapeHtml(inviteLink)}" class="btn">Complete Staff Setup</a>
      ${renderSignature()}
    `,
    footerHtml: `This reminder was sent automatically on behalf of ${escapeHtml(options.businessName)}.`,
  });

  return sendTrackedEmail({
    eventKey: EMAIL_EVENTS.STAFF_INVITE_REMINDER,
    to,
    recipientName: name,
    subject,
    htmlBody: html,
    businessId: options.businessId,
    userId: options.userId,
    metadata: {
      businessName: options.businessName,
      loginUrl: inviteLink,
    },
  });
}

async function sendTrialExpiringEmail(to, name, options = {}) {
  const safeName = escapeHtml(name);
  const html = renderEmail({
    eyebrow: 'Billing Reminder',
    title: 'Your trial ends soon',
    lead: 'You&rsquo;re close to the end of your trial window. Update billing now to avoid any interruption in premium features.',
    introHtml: `
      <p>Hi ${safeName},</p>
      <p class="lead">We hope you&rsquo;ve been enjoying DriftHR.</p>
    `,
    bodyHtml: `
      ${renderNotice('3 days remaining', `Your trial for <strong>${escapeHtml(options.businessName)}</strong> ends soon. To keep everything running without interruption, update your billing details now.`)}
      <a href="${escapeHtml(options.billingUrl || '#')}" class="btn">Update Billing Details</a>
      ${renderSignature()}
    `,
    footerHtml: `If you have already upgraded, you can ignore this message.`,
  });

  return sendTrackedEmail({
    eventKey: EMAIL_EVENTS.TRIAL_EXPIRING,
    to,
    recipientName: name,
    subject: `Action Required: Your DriftHR trial expires in 3 days`,
    htmlBody: html,
    businessId: options.businessId,
    metadata: { businessName: options.businessName },
  });
}

async function sendSubscriptionStartedEmail(to, name, options = {}) {
  const safeName = escapeHtml(name);
  const html = renderEmail({
    eyebrow: 'Subscription Active',
    title: 'Your premium plan is live',
    lead: 'Everything is active and ready. You now have uninterrupted access to the premium experience for your business.',
    introHtml: `
      <p>Hi ${safeName},</p>
      <p class="lead">Welcome to the premium tier. Your subscription for <strong>${escapeHtml(options.businessName)}</strong> is now active.</p>
    `,
    bodyHtml: `
      ${renderNotice('Receipt sent', 'Your official receipt has been emailed separately by our payment partner, Paddle.')}
      <a href="${escapeHtml(options.dashboardUrl || '#')}" class="btn">Go to Dashboard</a>
      ${renderSignature()}
    `,
    footerHtml: `Thank you for your business.`,
  });

  return sendTrackedEmail({
    eventKey: EMAIL_EVENTS.SUBSCRIPTION_STARTED,
    to,
    recipientName: name,
    subject: `Welcome to DriftHR Premium`,
    htmlBody: html,
    businessId: options.businessId,
    metadata: { businessName: options.businessName },
  });
}

async function sendPaymentFailedEmail(to, name, options = {}) {
  const safeName = escapeHtml(name);
  const html = renderEmail({
    eyebrow: 'Billing Action Required',
    title: 'We couldn&rsquo;t process your payment',
    lead: 'Your latest subscription payment did not go through. Update your billing details to avoid any service interruption.',
    introHtml: `
      <p>Hi ${safeName},</p>
      <p class="lead">We were unable to process the latest payment for <strong>${escapeHtml(options.businessName)}</strong>.</p>
    `,
    bodyHtml: `
      ${renderNotice('Please update billing', 'To avoid disruption to your service, update your payment method now. We&rsquo;ll automatically retry the charge once the details are refreshed.', 'danger')}
      <a href="${escapeHtml(options.billingUrl || '#')}" class="btn">Update Payment Method</a>
      ${renderSignature()}
    `,
    footerHtml: `If you have recently updated your payment details, please ignore this email.`,
  });

  return sendTrackedEmail({
    eventKey: EMAIL_EVENTS.PAYMENT_FAILED,
    to,
    recipientName: name,
    subject: `Action Required: Payment failed for DriftHR`,
    htmlBody: html,
    businessId: options.businessId,
    metadata: { businessName: options.businessName },
  });
}

async function sendSubscriptionCancelledEmail(to, name, options = {}) {
  const safeName = escapeHtml(name);
  const html = renderEmail({
    eyebrow: 'Subscription Update',
    title: 'Your subscription has been cancelled',
    lead: 'Your plan has been marked for cancellation, but you&rsquo;ll keep access until the end of the current billing period.',
    introHtml: `
      <p>Hi ${safeName},</p>
      <p class="lead">Your premium subscription for <strong>${escapeHtml(options.businessName)}</strong> has been cancelled.</p>
    `,
    bodyHtml: `
      ${renderNotice('Access remains active', 'You will continue to have premium access until the end of your current billing period. After that, access will pause unless you reactivate a paid plan.')}
      <a href="${escapeHtml(options.billingUrl || '#')}" class="btn">Reactivate Subscription</a>
      ${renderSignature()}
    `,
    footerHtml: `Thank you for having tried DriftHR.`,
  });

  return sendTrackedEmail({
    eventKey: EMAIL_EVENTS.SUBSCRIPTION_CANCELLED,
    to,
    recipientName: name,
    subject: `Your DriftHR subscription has been cancelled`,
    htmlBody: html,
    businessId: options.businessId,
    metadata: { businessName: options.businessName },
  });
}

// Sent ~24h after a COMPLETED appointment to ask for a review. Business
// admin configures their review link (Google / Yelp / internal) in
// settings; if they haven't, we skip this email entirely (handled in
// the scheduler, not here).
// Sent when the business admin / staff marks an appointment COMPLETED.
// Friendly "thanks for visiting" + a review CTA that deep-links to
// whatever platform the business configured in Settings → Review link.
// Tracked with eventKey APPOINTMENT_REVIEW_REQUEST so the 24h review
// scheduler's dedup sees it and doesn't double-send.
function formatAppointmentAmount(amount, currency = DEFAULT_CURRENCY) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return 'Not charged';
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency || DEFAULT_CURRENCY,
      maximumFractionDigits: numeric % 1 === 0 ? 0 : 2,
    }).format(numeric);
  } catch {
    return `${currency || DEFAULT_CURRENCY} ${numeric.toFixed(numeric % 1 === 0 ? 0 : 2)}`;
  }
}

function renderAppointmentInvoiceBlock(ctx = {}) {
  const invoice = ctx.invoice || {};
  const amount = invoice.finalPrice ?? invoice.originalPrice ?? ctx.finalPrice ?? ctx.originalPrice;
  const paidAmount = invoice.paidAmount ?? ctx.paidAmount;
  const paymentStatus = String(invoice.paymentStatus || ctx.paymentStatus || 'UNPAID').replace(/_/g, ' ');
  const paymentMethod = invoice.paymentMethod || ctx.paymentMethod || 'Not recorded';
  const currency = invoice.currency || ctx.currency || DEFAULT_CURRENCY;
  return renderDetailsTable([
    ['Service', `<strong>${escapeHtml(ctx.serviceName || 'Appointment')}</strong>`],
    ['Date', escapeHtml(formatHumanDate(ctx.date))],
    ['Time', `${escapeHtml(ctx.startTime || '')} - ${escapeHtml(ctx.endTime || '')}`],
    ['Provider', escapeHtml(ctx.staffName || 'Provider')],
    ['Invoice amount', `<strong>${escapeHtml(formatAppointmentAmount(amount, currency))}</strong>`],
    ['Payment status', escapeHtml(paymentStatus)],
    ['Paid amount', escapeHtml(formatAppointmentAmount(paidAmount || 0, currency))],
    ['Payment method', escapeHtml(paymentMethod)],
  ], { title: 'Invoice / receipt' });
}

function renderPrescriptionSummaryBlock(prescription, options = {}) {
  if (!prescription) return '';
  const clinical = prescription.clinical || {};
  const medicines = Array.isArray(prescription.medicines) ? prescription.medicines : [];
  const medicineHtml = medicines.length
    ? `
      <div class="panel" style="margin-top:16px;">
        <p class="panel-label">Medicines</p>
        ${medicines.map((medicine, index) => {
          const main = [medicine.name, medicine.strength].filter(Boolean).join(' ');
          const schedule = [medicine.dose, medicine.frequency, medicine.duration, medicine.timing].filter(Boolean).join(' · ');
          return `
            <div style="padding:${index === 0 ? '0' : '12px 0 0'} 0; ${index === 0 ? '' : 'border-top:1px solid #E5E9F2;'}">
              <p style="margin:0; font-weight:700; color:#0F172A;">${index + 1}. ${escapeHtml(main || 'Medicine')}</p>
              ${schedule ? `<p style="margin:4px 0 0; color:#475569; font-size:13px;">${escapeHtml(schedule)}</p>` : ''}
              ${medicine.instructions ? `<p style="margin:4px 0 0; color:#64748B; font-size:12px;">${escapeHtml(medicine.instructions)}</p>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `
    : '';
  const rows = [
    ['Patient', escapeHtml(prescription.patientName || 'Patient')],
    ['Diagnosis', escapeHtml(clinical.diagnosis || 'Not specified')],
    ['Advice', escapeHtml(clinical.advice || 'As advised')],
    ['Follow-up', escapeHtml(clinical.followUp || 'As advised')],
  ];
  return renderDetailsTable(rows, { title: options.title || 'Prescription' }) + medicineHtml;
}

async function sendAppointmentCompletedEmail(to, ctx) {
  const t = tFor(ctx.locale);
  const subject = t('appointmentCompleted.subject', { businessName: ctx.businessName });

  const platformDomain = process.env.PLATFORM_DOMAIN || 'sitepresso.com';
  const platformBaseUrl = (process.env.NEXT_PUBLIC_PLATFORM_URL || process.env.FRONTEND_URL || `https://${platformDomain}`).replace(/\/$/, '');
  const rebookUrl = ctx.businessSlug ? `${platformBaseUrl}/${ctx.businessSlug}` : platformBaseUrl;
  const reviewLink = ctx.reviewLink || null;

  const primaryHref = reviewLink || rebookUrl;
  const primaryLabel = reviewLink ? t('appointmentCompleted.ctaReview') : t('appointmentCompleted.ctaRebook');
  const secondaryLinkLabel = t('appointmentCompleted.secondaryRebookLink');
  // We hand-stitch the secondary line so the {link} placeholder becomes a real <a>.
  const secondaryTemplate = t('appointmentCompleted.secondaryRebook', { link: '__LINK__' });
  const secondaryHtml = reviewLink
    ? `<p class="muted" style="text-align:center; font-size:12px; margin-top:12px;">${escapeHtml(secondaryTemplate).replace('__LINK__', `<a href="${rebookUrl}">${escapeHtml(secondaryLinkLabel)}</a>`)}</p>`
    : '';

  const ctaHtml = `
    <div style="text-align:center; margin:28px 0 6px;">
      <a href="${primaryHref}" class="btn-primary" style="display:inline-block; padding:12px 28px; background:#4F46E5; color:#fff; text-decoration:none; border-radius:10px; font-weight:600; font-size:14px;">
        ${escapeHtml(primaryLabel)}
      </a>
    </div>
    ${secondaryHtml}
  `;

  const introKey = ctx.staffName ? 'appointmentCompleted.introWithStaff' : 'appointmentCompleted.introNoStaff';

  const html = renderEmail({
    eyebrow: t('appointmentCompleted.eyebrow'),
    title: t('appointmentCompleted.title'),
    lead: t('appointmentCompleted.lead', { businessName: ctx.businessName }),
    introHtml: `
      <p>${escapeHtml(t('common.greeting', { name: ctx.userName }))},</p>
      <p class="lead">${escapeHtml(t(introKey, { serviceName: ctx.serviceName, staffName: ctx.staffName || '', date: formatHumanDate(ctx.date) }))}</p>
    `,
    bodyHtml:
      renderAppointmentInvoiceBlock(ctx)
      + (ctx.prescription
        ? renderPrescriptionSummaryBlock(ctx.prescription, { title: 'Prescription included' })
        : (ctx.isDoctorClinic ? renderNotice('Prescription not included yet', 'If your doctor adds or updates a prescription later, we will email you separately.') : ''))
      + ctaHtml
      + (reviewLink ? renderNotice(t('appointmentCompleted.noticeTitle'), t('appointmentCompleted.noticeBody')) : '')
      + renderSignature(ctx.businessName, t('appointmentCompleted.signOff')),
    footerHtml: `Appointment ID: ${escapeHtml(ctx.appointmentId)}`,
  });

  await sendTrackedEmail({
    // Use APPOINTMENT_REVIEW_REQUEST so the 24h cron dedupes against it.
    // If ctx.reviewLink is missing, we still mark it so no second email
    // follows — the customer got their thank-you, that's enough.
    eventKey: EMAIL_EVENTS.APPOINTMENT_REVIEW_REQUEST,
    to,
    recipientName: ctx.userName,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    userId: ctx.userId || null,
    customerId: ctx.customerId || null,
    appointmentId: ctx.appointmentId || null,
    metadata: {
      serviceName: ctx.serviceName,
      staffName: ctx.staffName,
      date: ctx.date,
      trigger: 'status_completed',
      hasReviewLink: !!reviewLink,
      hasPrescription: !!ctx.prescription,
      paymentStatus: ctx.invoice?.paymentStatus || ctx.paymentStatus || null,
    },
  });
}

async function sendPrescriptionReadyEmail(to, ctx) {
  const isUpdate = ctx.kind === 'updated';
  const subject = isUpdate
    ? `Your prescription has been updated by ${ctx.businessName}`
    : `Your prescription is ready from ${ctx.businessName}`;
  const platformDomain = process.env.PLATFORM_DOMAIN || 'sitepresso.com';
  const platformBaseUrl = (process.env.NEXT_PUBLIC_PLATFORM_URL || process.env.FRONTEND_URL || `https://${platformDomain}`).replace(/\/$/, '');
  const appointmentUrl = ctx.businessSlug ? `${platformBaseUrl}/${ctx.businessSlug}` : platformBaseUrl;
  const html = renderEmail({
    eyebrow: isUpdate ? 'Prescription updated' : 'Prescription ready',
    title: isUpdate ? 'Your prescription was updated' : 'Your prescription is ready',
    lead: `${escapeHtml(ctx.businessName)} has ${isUpdate ? 'updated' : 'shared'} the prescription for your appointment.`,
    introHtml: `
      <p>Hi ${escapeHtml(ctx.userName || 'there')},</p>
      <p class="lead">This is for your ${escapeHtml(ctx.serviceName || 'appointment')} with ${escapeHtml(ctx.staffName || 'your provider')} on ${escapeHtml(formatHumanDate(ctx.date))}.</p>
    `,
    bodyHtml:
      renderPrescriptionSummaryBlock(ctx.prescription, { title: isUpdate ? 'Updated prescription' : 'Prescription' })
      + renderAppointmentInvoiceBlock(ctx)
      + `
        <div style="text-align:center; margin:28px 0 6px;">
          <a href="${escapeHtml(appointmentUrl)}" class="btn-primary" style="display:inline-block; padding:12px 28px; background:#4F46E5; color:#fff; text-decoration:none; border-radius:10px; font-weight:600; font-size:14px;">
            View appointment
          </a>
        </div>
      `
      + renderSignature(ctx.businessName, 'Please contact the clinic if anything looks incorrect.'),
    footerHtml: `Appointment ID: ${escapeHtml(ctx.appointmentId || '')}`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.PRESCRIPTION_READY,
    to,
    recipientName: ctx.userName,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    userId: ctx.userId || null,
    customerId: ctx.customerId || null,
    appointmentId: ctx.appointmentId || null,
    metadata: {
      kind: isUpdate ? 'updated' : 'new',
      serviceName: ctx.serviceName,
      staffName: ctx.staffName,
      date: ctx.date,
      medicineCount: Array.isArray(ctx.prescription?.medicines) ? ctx.prescription.medicines.length : 0,
    },
  });
}

// Sent when the business admin / staff marks an appointment NO_SHOW.
// Polite but honest — "we missed you" — with a clear rebook CTA so the
// customer can recover without feeling scolded.
async function sendAppointmentNoShowEmail(to, ctx) {
  const t = tFor(ctx.locale);
  const subject = t('appointmentNoShow.subject', { businessName: ctx.businessName });

  const platformDomain = process.env.PLATFORM_DOMAIN || 'sitepresso.com';
  const platformBaseUrl = (process.env.NEXT_PUBLIC_PLATFORM_URL || process.env.FRONTEND_URL || `https://${platformDomain}`).replace(/\/$/, '');
  const rebookUrl = ctx.businessSlug ? `${platformBaseUrl}/${ctx.businessSlug}` : platformBaseUrl;

  const rebookButtonHtml = `
    <div style="text-align:center; margin:28px 0;">
      <a href="${rebookUrl}" class="btn-primary" style="display:inline-block; padding:12px 28px; background:#4F46E5; color:#fff; text-decoration:none; border-radius:10px; font-weight:600; font-size:14px;">
        ${escapeHtml(t('appointmentNoShow.ctaRebook'))}
      </a>
    </div>
  `;

  const introKey = ctx.staffName ? 'appointmentNoShow.introWithStaff' : 'appointmentNoShow.introNoStaff';

  const html = renderEmail({
    eyebrow: t('appointmentNoShow.eyebrow'),
    title: t('appointmentNoShow.title'),
    lead: t('appointmentNoShow.lead', { serviceName: ctx.serviceName, businessName: ctx.businessName }),
    introHtml: `
      <p>${escapeHtml(t('common.greeting', { name: ctx.userName }))},</p>
      <p class="lead">${escapeHtml(t(introKey, { serviceName: ctx.serviceName, staffName: ctx.staffName || '', date: formatHumanDate(ctx.date), startTime: ctx.startTime }))}</p>
      <p>${escapeHtml(t('appointmentNoShow.introSecond'))}</p>
    `,
    bodyHtml:
      rebookButtonHtml
      + renderNotice(t('appointmentNoShow.noticeTitle'), t('appointmentNoShow.noticeBody'))
      + renderSignature(ctx.businessName, t('appointmentNoShow.signOff')),
    footerHtml: `Appointment ID: ${escapeHtml(ctx.appointmentId)}`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.APPOINTMENT_NO_SHOW,
    to,
    recipientName: ctx.userName,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    userId: ctx.userId || null,
    customerId: ctx.customerId || null,
    appointmentId: ctx.appointmentId || null,
    metadata: {
      serviceName: ctx.serviceName,
      staffName: ctx.staffName,
      date: ctx.date,
      startTime: ctx.startTime,
      endTime: ctx.endTime,
    },
  });
}

async function sendAppointmentReviewRequestEmail(to, ctx) {
  const t = tFor(ctx.locale);
  const subject = t('appointmentReviewRequest.subject', { businessName: ctx.businessName });

  const reviewButtonHtml = `
    <div style="text-align:center; margin:28px 0;">
      <a href="${ctx.reviewLink}" class="btn-primary" style="display:inline-block; padding:12px 28px; background:#4F46E5; color:#fff; text-decoration:none; border-radius:10px; font-weight:600; font-size:14px;">
        ${escapeHtml(t('appointmentReviewRequest.ctaReview'))}
      </a>
    </div>
  `;

  const introKey = ctx.staffName ? 'appointmentReviewRequest.introWithStaff' : 'appointmentReviewRequest.introNoStaff';

  const html = renderEmail({
    eyebrow: t('appointmentReviewRequest.eyebrow'),
    title: t('appointmentReviewRequest.title'),
    lead: t('appointmentReviewRequest.lead', { businessName: ctx.businessName }),
    introHtml: `
      <p>${escapeHtml(t('common.greeting', { name: ctx.userName }))},</p>
      <p class="lead">${escapeHtml(t(introKey, { businessName: ctx.businessName, serviceName: ctx.serviceName, staffName: ctx.staffName || '', date: formatHumanDate(ctx.date) }))}</p>
      <p>${escapeHtml(t('appointmentReviewRequest.introSecond'))}</p>
    `,
    bodyHtml:
      reviewButtonHtml
      + `<p class="muted" style="text-align:center; font-size:12px;">${escapeHtml(t('appointmentReviewRequest.ctaSubtext'))}</p>`
      + renderSignature(ctx.businessName, t('appointmentReviewRequest.signOff')),
    footerHtml: `Appointment ID: ${escapeHtml(ctx.appointmentId)}`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.APPOINTMENT_REVIEW_REQUEST,
    to,
    recipientName: ctx.userName,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    userId: ctx.userId || null,
    customerId: ctx.customerId || null,
    appointmentId: ctx.appointmentId || null,
    metadata: {
      serviceName: ctx.serviceName,
      staffName: ctx.staffName,
      date: ctx.date,
      reviewLink: ctx.reviewLink,
    },
  });
}

// Post-delivery review request for ecommerce orders. Reuses the generic
// appointmentReviewRequest copy (it's about reviewing the business, not a
// service), so no new i18n keys are needed.
async function sendOrderReviewRequestEmail(to, ctx) {
  const t = tFor(ctx.locale);
  const subject = t('appointmentReviewRequest.subject', { businessName: ctx.businessName });

  const reviewButtonHtml = `
    <div style="text-align:center; margin:28px 0;">
      <a href="${ctx.reviewLink}" class="btn-primary" style="display:inline-block; padding:12px 28px; background:#4F46E5; color:#fff; text-decoration:none; border-radius:10px; font-weight:600; font-size:14px;">
        ${escapeHtml(t('appointmentReviewRequest.ctaReview'))}
      </a>
    </div>
  `;

  const html = renderEmail({
    eyebrow: t('appointmentReviewRequest.eyebrow'),
    title: t('appointmentReviewRequest.title'),
    lead: t('appointmentReviewRequest.lead', { businessName: ctx.businessName }),
    introHtml: `
      <p>${escapeHtml(t('common.greeting', { name: ctx.userName }))},</p>
      <p class="lead">${escapeHtml(t('appointmentReviewRequest.introNoStaff', { businessName: ctx.businessName, serviceName: ctx.serviceName || 'your recent order', staffName: '', date: formatHumanDate(ctx.date) }))}</p>
      <p>${escapeHtml(t('appointmentReviewRequest.introSecond'))}</p>
    `,
    bodyHtml:
      reviewButtonHtml
      + `<p class="muted" style="text-align:center; font-size:12px;">${escapeHtml(t('appointmentReviewRequest.ctaSubtext'))}</p>`
      + renderSignature(ctx.businessName, t('appointmentReviewRequest.signOff')),
    footerHtml: `Order #${escapeHtml(String(ctx.orderId || '').slice(-8))}`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.ORDER_REVIEW_REQUEST,
    to,
    recipientName: ctx.userName,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    customerId: ctx.customerId || null,
    metadata: { orderId: ctx.orderId, reviewLink: ctx.reviewLink },
  });
}

// Sent to the customer when a pending appointment auto-cancels because its
// time passed without being confirmed. Apologetic tone + a clear "book
// again" CTA so we don't just ghost the customer.
async function sendAppointmentAutoCancelledEmail(to, ctx) {
  const t = tFor(ctx.locale);
  const subject = t('appointmentAutoCancelled.subject', { businessName: ctx.businessName });

  const platformDomain = process.env.PLATFORM_DOMAIN || 'sitepresso.com';
  const platformBaseUrl = (process.env.NEXT_PUBLIC_PLATFORM_URL || process.env.FRONTEND_URL || `https://${platformDomain}`).replace(/\/$/, '');
  const rebookUrl = ctx.businessSlug
    ? `${platformBaseUrl}/${ctx.businessSlug}`
    : platformBaseUrl;

  const rebookButtonHtml = `
    <div style="text-align:center; margin:28px 0;">
      <a href="${rebookUrl}" class="btn-primary" style="display:inline-block; padding:12px 28px; background:#4F46E5; color:#fff; text-decoration:none; border-radius:10px; font-weight:600; font-size:14px;">
        ${escapeHtml(t('appointmentAutoCancelled.ctaRebook'))}
      </a>
    </div>
  `;

  // Hand-stitch the directLink so {url} becomes a real <a>.
  const directLinkTemplate = t('appointmentAutoCancelled.directLink', { url: '__URL__' });
  const directLinkHtml = `<p class="muted" style="text-align:center; font-size:12px;">${escapeHtml(directLinkTemplate).replace('__URL__', `<a href="${rebookUrl}" style="color:#4F46E5;">${escapeHtml(rebookUrl)}</a>`)}</p>`;

  const html = renderEmail({
    eyebrow: t('appointmentAutoCancelled.eyebrow'),
    title: t('appointmentAutoCancelled.title'),
    lead: t('appointmentAutoCancelled.lead'),
    introHtml: `
      <p>${escapeHtml(t('common.greeting', { name: ctx.userName }))},</p>
      <p class="lead">${escapeHtml(t('appointmentAutoCancelled.intro', { serviceName: ctx.serviceName, businessName: ctx.businessName }))}</p>
      <span class="badge status-danger">${escapeHtml(t('appointmentAutoCancelled.badge'))}</span>
    `,
    bodyHtml:
      renderDetailsTable([
        [t('appointmentAutoCancelled.labelService'), `<strong>${escapeHtml(ctx.serviceName)}</strong>`],
        [t('appointmentAutoCancelled.labelStaff'),   escapeHtml(ctx.staffName || '—')],
        [t('appointmentAutoCancelled.labelDate'),    escapeHtml(formatHumanDate(ctx.date))],
        [t('appointmentAutoCancelled.labelTime'),    `${escapeHtml(ctx.startTime)} – ${escapeHtml(ctx.endTime)}`],
      ], { title: t('appointmentAutoCancelled.detailsHeader') })
      + renderNotice(t('appointmentAutoCancelled.noticeTitle'), t('appointmentAutoCancelled.noticeBody'))
      + rebookButtonHtml
      + directLinkHtml
      + renderSignature(ctx.businessName, t('appointmentAutoCancelled.signOff')),
    footerHtml: `Appointment ID: ${escapeHtml(ctx.appointmentId)}`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.APPOINTMENT_AUTO_CANCELLED,
    to,
    recipientName: ctx.userName,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    userId: ctx.userId || null,
    customerId: ctx.customerId || null,
    appointmentId: ctx.appointmentId || null,
    metadata: {
      serviceName: ctx.serviceName,
      staffName: ctx.staffName,
      date: ctx.date,
      startTime: ctx.startTime,
      endTime: ctx.endTime,
      reason: 'auto_cancel_time_passed',
    },
  });
}

// Sent to a customer when the business admin uses the bulk-message
// action on the appointments tab. Generic envelope: subject + body
// composed by the admin, plus a small footer pointing back to the
// business so the customer recognises the sender.
async function sendAdminBulkMessageEmail(to, ctx) {
  const subject = ctx.subject;
  const html = renderEmail({
    eyebrow: ctx.businessName || 'Message',
    title: ctx.subject,
    lead: '',
    introHtml: `<p>Hi ${escapeHtml(ctx.name || 'there')},</p>`,
    bodyHtml:
      `<div style="white-space: pre-wrap; font-size: 14px; line-height: 1.7; color: #334155;">${escapeHtml(ctx.body)}</div>`
      + renderSignature(ctx.businessName || 'The team', ''),
    footerHtml: `Sent on behalf of ${escapeHtml(ctx.businessName || 'your booking')}.`,
  });
  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.ADMIN_BULK_MESSAGE,
    to,
    recipientName: ctx.name,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    customerId: ctx.customerId || null,
    appointmentId: ctx.appointmentId || null,
    metadata: { sentBy: 'admin_bulk_action' },
  });
}

// Sent to a waitlist customer when a slot opens that matches their
// preferences. Friendly tone — they signalled demand, now we're
// delivering. Single big "Book this slot" CTA pointing at the deep-
// link the controller built.
async function sendWaitlistSlotOpenEmail(to, ctx) {
  const subject = `A slot just opened at ${ctx.businessName}`;
  const bookHref = ctx.bookHref || '#';

  const buttonHtml = `
    <div style="text-align:center; margin:28px 0;">
      <a href="${bookHref}" class="btn-primary" style="display:inline-block; padding:12px 28px; background:#4F46E5; color:#fff; text-decoration:none; border-radius:10px; font-weight:600; font-size:14px;">
        Book this slot
      </a>
    </div>
  `;

  const html = renderEmail({
    eyebrow: 'Slot available',
    title: `Your waitlist slot just opened`,
    lead: `A booking matching your preferences at ${ctx.businessName} is now available. First come, first served.`,
    introHtml: `
      <p>Hi ${escapeHtml(ctx.name)},</p>
      <p class="lead">A slot at <strong>${escapeHtml(ctx.businessName)}</strong> just opened up that matches your waitlist preferences. Book it before someone else does.</p>
    `,
    bodyHtml:
      renderDetailsTable([
        ['Service', `<strong>${escapeHtml(ctx.serviceName || '—')}</strong>`],
        ['With',    escapeHtml(ctx.staffName || '—')],
        ['Date',    escapeHtml(formatHumanDate(ctx.date))],
        ['Time',    `${escapeHtml(ctx.startTime || '')}${ctx.endTime ? ` – ${escapeHtml(ctx.endTime)}` : ''}`],
      ], { title: 'Available slot' })
      + buttonHtml
      + `<p class="muted" style="text-align:center; font-size:12px;">Or open <a href="${bookHref}" style="color:#4F46E5;">${escapeHtml(bookHref)}</a> directly.</p>`
      + renderSignature(ctx.businessName, 'Thanks for waiting — we appreciate it.'),
    footerHtml: `You’re receiving this because you joined the waitlist for ${escapeHtml(ctx.businessName)}.`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.WAITLIST_SLOT_OPEN,
    to,
    recipientName: ctx.name,
    subject,
    htmlBody: html,
    metadata: {
      businessSlug: ctx.businessSlug,
      serviceName: ctx.serviceName,
      staffName: ctx.staffName,
      date: ctx.date,
      startTime: ctx.startTime,
      endTime: ctx.endTime,
    },
  });
}

// E-commerce — order confirmation to the buyer. Fired immediately after
// /api/storefront/<slug>/checkout creates the Order. ctx shape:
//   { businessName, businessSlug, customerName, customerEmail,
//     orderId, orderShortId, currency, items[], subtotalMinor,
//     shippingMinor, taxMinor, totalMinor, shippingAddress, notes,
//     orderUrl, supportEmail }
async function sendOrderReceivedCustomerEmail(to, ctx) {
  const businessName = ctx.businessName || 'DriftHR';
  const subject = `Action required: complete payment for order #${ctx.orderShortId}`;
  const itemsRows = (ctx.items || []).map((item) => [
    `<strong>${escapeHtml(item.productName)}</strong>`
      + ` <span style="color:#6b7280;">× ${item.quantity}</span>`,
    `<span style="white-space:nowrap;">${escapeHtml(formatMinor(item.lineTotalMinor, ctx.currency))}</span>`,
  ]);
  const totalsRows = [
    ['Subtotal', escapeHtml(formatMinor(ctx.subtotalMinor, ctx.currency))],
  ];
  if (ctx.shippingMinor > 0) totalsRows.push(['Shipping', escapeHtml(formatMinor(ctx.shippingMinor, ctx.currency))]);
  if (ctx.taxMinor > 0) totalsRows.push(['Tax', escapeHtml(formatMinor(ctx.taxMinor, ctx.currency))]);
  totalsRows.push([`<strong>Total</strong>`, `<strong>${escapeHtml(formatMinor(ctx.totalMinor, ctx.currency))}</strong>`]);

  const addr = ctx.shippingAddress || {};
  const addressBlock = [
    escapeHtml(ctx.customerName),
    escapeHtml(addr.line1 || ''),
    addr.line2 ? escapeHtml(addr.line2) : null,
    escapeHtml(`${addr.city || ''}${addr.state ? ', ' + addr.state : ''} ${addr.postalCode || ''}`.trim()),
    escapeHtml(addr.country || ''),
  ].filter(Boolean).join('<br />');

  // Order is PENDING at this point — payment hasn't happened yet. Email
  // copy makes the "complete payment" action unmistakable; the seller's
  // separate "order confirmed" email fires after the PAID transition via
  // sendOrderPaidEmail.
  const payUrl = ctx.orderUrl
    ? (ctx.orderUrl.includes('?') ? `${ctx.orderUrl}&pay=auto` : `${ctx.orderUrl}?pay=auto`)
    : null;
  const html = renderEmail({
    eyebrow: 'Action required',
    title: `Complete your payment, ${escapeHtml(ctx.customerName.split(' ')[0] || 'there')}.`,
    lead: `Your order at ${escapeHtml(businessName)} is reserved but <strong>not yet confirmed</strong>. Click below to pay — we'll send a separate receipt once payment clears. Unpaid orders expire after 30 minutes.`,
    introHtml: `
      <p>Order ID: <span style="font-family: monospace; color:#374151;">#${escapeHtml(ctx.orderShortId)}</span></p>
    `,
    bodyHtml: `
      ${payUrl ? `
        <p style="margin: 0 0 24px;">
          <a href="${escapeHtml(payUrl)}" style="display:inline-block; padding:14px 28px; border-radius:8px; background:#1F8A4C; color:#ffffff; text-decoration:none; font-weight:700; font-size:15px;">Complete payment →</a>
        </p>
      ` : ''}
      ${renderDetailsTable(itemsRows, { title: 'Items' })}
      ${renderDetailsTable(totalsRows, { title: 'Totals' })}
      <div class="panel">
        <p class="panel-label">Shipping to</p>
        <p style="margin-top: 8px;">${addressBlock}</p>
      </div>
      ${ctx.notes ? `
        <div class="panel">
          <p class="panel-label">Your note</p>
          <p style="margin-top: 8px; white-space: pre-wrap;">${escapeHtml(ctx.notes)}</p>
        </div>
      ` : ''}
      ${renderSignature(`${escapeHtml(businessName)} Team`, ctx.supportEmail ? `Questions? Reply to this email or write to ${escapeHtml(ctx.supportEmail)}.` : '')}
    `,
    footerHtml: `You received this email because you placed an order at ${escapeHtml(businessName)}.`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.ORDER_RECEIVED,
    to,
    recipientName: ctx.customerName,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    metadata: {
      orderId: ctx.orderId,
      orderShortId: ctx.orderShortId,
      totalMinor: ctx.totalMinor,
      currency: ctx.currency,
    },
  });
}

// E-commerce — admin notification when a new order lands. Same ctx as
// sendOrderReceivedCustomerEmail, plus `adminUrl` linking to the order
// detail in admin.
async function sendOrderReceivedAdminEmail(to, ctx) {
  const businessName = ctx.businessName || 'Your shop';
  const subject = `New order #${ctx.orderShortId} — ${escapeHtml(formatMinor(ctx.totalMinor, ctx.currency))}`;
  const itemsRows = (ctx.items || []).map((item) => [
    `<strong>${escapeHtml(item.productName)}</strong> <span style="color:#6b7280;">× ${item.quantity}</span>`,
    `<span style="white-space:nowrap;">${escapeHtml(formatMinor(item.lineTotalMinor, ctx.currency))}</span>`,
  ]);

  const addr = ctx.shippingAddress || {};
  const addressBlock = [
    escapeHtml(ctx.customerName),
    escapeHtml(addr.line1 || ''),
    addr.line2 ? escapeHtml(addr.line2) : null,
    escapeHtml(`${addr.city || ''}${addr.state ? ', ' + addr.state : ''} ${addr.postalCode || ''}`.trim()),
    escapeHtml(addr.country || ''),
  ].filter(Boolean).join('<br />');

  const html = renderEmail({
    eyebrow: 'New order',
    title: `New order #${escapeHtml(ctx.orderShortId)} — ${escapeHtml(formatMinor(ctx.totalMinor, ctx.currency))}`,
    lead: `${escapeHtml(ctx.customerName)} just placed an order on ${escapeHtml(businessName)}.`,
    introHtml: `
      <p>Email: <a href="mailto:${escapeHtml(ctx.customerEmail)}">${escapeHtml(ctx.customerEmail)}</a></p>
      ${ctx.customerPhone ? `<p>Phone: ${escapeHtml(ctx.customerPhone)}</p>` : ''}
    `,
    bodyHtml: `
      ${renderDetailsTable(itemsRows, { title: 'Items' })}
      <div class="panel">
        <p class="panel-label">Ship to</p>
        <p style="margin-top: 8px;">${addressBlock}</p>
      </div>
      ${ctx.notes ? `
        <div class="panel">
          <p class="panel-label">Customer note</p>
          <p style="margin-top: 8px; white-space: pre-wrap;">${escapeHtml(ctx.notes)}</p>
        </div>
      ` : ''}
      ${ctx.adminUrl ? `
        <p style="margin-top: 24px;">
          <a href="${escapeHtml(ctx.adminUrl)}" style="display:inline-block; padding:10px 18px; border-radius:8px; background:#111827; color:#ffffff; text-decoration:none; font-weight:600;">Open in admin</a>
        </p>
      ` : ''}
      ${renderNotice('Next step', 'Confirm payment with the customer (WhatsApp / bank / cash) then mark the order PAID from the admin panel to start fulfillment.')}
      ${renderSignature()}
    `,
    footerHtml: `You&rsquo;re receiving this because you&rsquo;re an admin at ${escapeHtml(businessName)}.`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.ORDER_RECEIVED_ADMIN,
    to,
    recipientName: 'Admin',
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    metadata: {
      orderId: ctx.orderId,
      orderShortId: ctx.orderShortId,
      totalMinor: ctx.totalMinor,
      currency: ctx.currency,
    },
  });
}

// Money formatter for emails. Mirrors the storefront formatter so amounts
// match. Falls back to "<currency> <decimal>" if Intl errors out (rare).
function formatMinor(minor, currency = DEFAULT_CURRENCY) {
  if (minor === undefined || minor === null) return '';
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(minor / 100);
  } catch {
    return `${currency} ${minor / 100}`;
  }
}

// Shared block — items list rendered as a small two-column table. Used
// by every status email so the reader always sees the line items.
function renderOrderItemsBlock(ctx) {
  const rows = (ctx.items || []).map((item) => [
    `<strong>${escapeHtml(item.productName)}</strong>`
      + ` <span style="color:#6b7280;">× ${item.quantity}</span>`,
    `<span style="white-space:nowrap;">${escapeHtml(formatMinor(item.lineTotalMinor, ctx.currency))}</span>`,
  ]);
  return renderDetailsTable(rows, { title: 'Items' });
}

function renderShippingBlock(ctx) {
  const addr = ctx.shippingAddress || {};
  const lines = [
    escapeHtml(ctx.customerName),
    escapeHtml(addr.line1 || ''),
    addr.line2 ? escapeHtml(addr.line2) : null,
    escapeHtml(`${addr.city || ''}${addr.state ? ', ' + addr.state : ''} ${addr.postalCode || ''}`.trim()),
    escapeHtml(addr.country || ''),
  ].filter(Boolean).join('<br />');
  return `
    <div class="panel">
      <p class="panel-label">Shipping to</p>
      <p style="margin-top: 8px;">${lines}</p>
    </div>
  `;
}

// E-commerce — payment confirmed. Fired when admin transitions an order
// from PENDING → PAID. Reassures the customer that their money landed
// and gives them a fulfillment timeline expectation.
async function sendOrderPaidEmail(to, ctx) {
  const businessName = ctx.businessName || 'DriftHR';
  const subject = `Payment confirmed for order #${ctx.orderShortId} — ${businessName}`;
  const html = renderEmail({
    eyebrow: 'Payment received',
    title: `Thanks ${escapeHtml(ctx.customerName.split(' ')[0] || 'there')} — your payment is in.`,
    lead: `${escapeHtml(businessName)} has confirmed payment for your order. We're getting it ready for you now.`,
    introHtml: `<p>Order ID: <span style="font-family: monospace; color:#374151;">#${escapeHtml(ctx.orderShortId)}</span></p>`,
    bodyHtml: `
      ${renderOrderItemsBlock(ctx)}
      ${renderDetailsTable([
        ['Total paid', `<strong>${escapeHtml(formatMinor(ctx.totalMinor, ctx.currency))}</strong>`],
      ], { title: 'Total' })}
      ${renderShippingBlock(ctx)}
      ${renderNotice("What's next", `${escapeHtml(businessName)} is preparing your order. You'll get another email when it ships out for delivery.`)}
      ${ctx.orderUrl ? `
        <p style="margin-top: 24px;">
          <a href="${escapeHtml(ctx.orderUrl)}" style="display:inline-block; padding:10px 18px; border-radius:8px; background:#10b981; color:#ffffff; text-decoration:none; font-weight:600;">View your order</a>
        </p>
      ` : ''}
      ${renderSignature(`${escapeHtml(businessName)} Team`)}
    `,
    footerHtml: `Receipt for order #${escapeHtml(ctx.orderShortId)} from ${escapeHtml(businessName)}.`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.ORDER_PAID,
    to,
    recipientName: ctx.customerName,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    metadata: { orderId: ctx.orderId, orderShortId: ctx.orderShortId, totalMinor: ctx.totalMinor, currency: ctx.currency },
  });
}

// E-commerce — order is on its way. Fired when admin transitions
// PACKING → OUT_FOR_DELIVERY. Sets the customer's expectation that they
// should be available to receive it today/tomorrow.
async function sendOrderOutForDeliveryEmail(to, ctx) {
  const businessName = ctx.businessName || 'DriftHR';
  const subject = `Out for delivery — order #${ctx.orderShortId}`;
  const html = renderEmail({
    eyebrow: 'On the way',
    title: `${escapeHtml(ctx.customerName.split(' ')[0] || 'Hi')}, your order is out for delivery 🚚`,
    lead: `${escapeHtml(businessName)} has handed your order over for delivery.`,
    introHtml: `<p>Order ID: <span style="font-family: monospace; color:#374151;">#${escapeHtml(ctx.orderShortId)}</span></p>`,
    bodyHtml: `
      ${renderShippingBlock(ctx)}
      ${renderOrderItemsBlock(ctx)}
      ${renderNotice('Heads up', 'Please make sure someone is available to receive the order today. If anything goes wrong, reply to this email and we\'ll sort it out.')}
      ${ctx.orderUrl ? `
        <p style="margin-top: 24px;">
          <a href="${escapeHtml(ctx.orderUrl)}" style="display:inline-block; padding:10px 18px; border-radius:8px; background:#4f46e5; color:#ffffff; text-decoration:none; font-weight:600;">Track your order</a>
        </p>
      ` : ''}
      ${renderSignature(`${escapeHtml(businessName)} Team`)}
    `,
    footerHtml: `Delivery update for order #${escapeHtml(ctx.orderShortId)} from ${escapeHtml(businessName)}.`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.ORDER_OUT_FOR_DELIVERY,
    to,
    recipientName: ctx.customerName,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    metadata: { orderId: ctx.orderId, orderShortId: ctx.orderShortId },
  });
}

// E-commerce — Click & Collect order is ready at the pickup counter.
// Fired when admin transitions PACKING → READY_FOR_PICKUP. Surfaces the
// pickup code prominently (buyer reads it to staff) and the location
// address + hours so the buyer can plan their visit.
async function sendOrderReadyForPickupEmail(to, ctx) {
  const businessName = ctx.businessName || 'DriftHR';
  const subject = `Ready for pickup — order #${ctx.orderShortId}`;
  const pickup = ctx.pickup || {};
  const code = pickup.code || '——';
  const addressParts = [
    pickup.addressLine1, pickup.addressLine2, pickup.city,
    pickup.region, pickup.postalCode, pickup.countryCode,
  ].filter(Boolean).map(escapeHtml).join(', ');
  const html = renderEmail({
    eyebrow: 'Ready when you are',
    title: `${escapeHtml(ctx.customerName.split(' ')[0] || 'Hi')}, your order is ready for pickup 🛍️`,
    lead: `${escapeHtml(businessName)} has packed your order — show this code at the counter to collect.`,
    introHtml: `<p>Order ID: <span style="font-family: monospace; color:#374151;">#${escapeHtml(ctx.orderShortId)}</span></p>`,
    bodyHtml: `
      <div style="margin: 24px 0; padding: 20px; border: 2px dashed #16a34a; border-radius: 12px; background: #f0fdf4; text-align: center;">
        <p style="margin: 0; font-size: 11px; color: #166534; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;">Pickup code</p>
        <p style="margin: 8px 0 0; font-size: 32px; font-weight: 800; color: #14532d; letter-spacing: 6px; font-family: monospace;">${escapeHtml(code)}</p>
      </div>
      <table style="width:100%; margin: 16px 0; border-collapse: collapse;">
        <tr><td style="padding: 6px 0; font-size: 12px; color:#6b7280; width: 90px;">Where</td>
            <td style="padding: 6px 0; font-size: 14px; color:#111827; font-weight: 600;">${escapeHtml(pickup.locationName || 'Pickup counter')}</td></tr>
        <tr><td style="padding: 6px 0; font-size: 12px; color:#6b7280;">Address</td>
            <td style="padding: 6px 0; font-size: 14px; color:#111827;">${addressParts}</td></tr>
        ${pickup.contactPhone ? `<tr><td style="padding: 6px 0; font-size: 12px; color:#6b7280;">Phone</td>
            <td style="padding: 6px 0; font-size: 14px; color:#111827;">${escapeHtml(pickup.contactPhone)}</td></tr>` : ''}
        ${pickup.instructions ? `<tr><td style="padding: 6px 0; font-size: 12px; color:#6b7280;">Note</td>
            <td style="padding: 6px 0; font-size: 14px; color:#111827;">${escapeHtml(pickup.instructions)}</td></tr>` : ''}
      </table>
      ${renderOrderItemsBlock(ctx)}
      ${ctx.orderUrl ? `
        <p style="margin-top: 24px;">
          <a href="${escapeHtml(ctx.orderUrl)}" style="display:inline-block; padding:10px 18px; border-radius:8px; background:#16a34a; color:#ffffff; text-decoration:none; font-weight:600;">View order</a>
        </p>
      ` : ''}
      ${renderSignature(`${escapeHtml(businessName)} Team`)}
    `,
    footerHtml: `Pickup notification for order #${escapeHtml(ctx.orderShortId)} from ${escapeHtml(businessName)}.`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.ORDER_READY_FOR_PICKUP,
    to,
    recipientName: ctx.customerName,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    metadata: { orderId: ctx.orderId, orderShortId: ctx.orderShortId, pickupCode: code },
  });
}

// E-commerce (grocery) — an out-of-stock item was substituted while picking
// and needs the customer's decision. Lists each proposed swap and links to the
// order page where they approve or decline (decline = refund those items).
async function sendSubstitutionProposedEmail(to, ctx) {
  const businessName = ctx.businessName || 'DriftHR';
  const subject = `Action needed — a substitution on order #${ctx.orderShortId}`;
  const proposed = (ctx.items || []).filter(
    (it) => it.fulfillmentStatus === 'SUBSTITUTED' && it.substitutionStatus === 'PROPOSED',
  );
  if (proposed.length === 0) return; // nothing to ask about
  const money = (minor) => {
    if (minor == null) return '';
    try {
      return new Intl.NumberFormat('en', { style: 'currency', currency: ctx.currency || 'INR', maximumFractionDigits: 0 }).format(minor / 100);
    } catch { return `${minor / 100}`; }
  };
  const rows = proposed.map((it) => `
    <tr>
      <td style="padding: 10px 0; border-bottom: 1px solid #f3f4f6;">
        <p style="margin:0; font-size:13px; color:#9ca3af; text-decoration:line-through;">${escapeHtml(it.productName)}</p>
        <p style="margin:2px 0 0; font-size:14px; color:#111827; font-weight:600;">→ ${escapeHtml(it.substituteProductName || 'Replacement')}${it.substitutePriceMinor != null ? ` <span style="color:#6b7280; font-weight:400;">(${money(it.substitutePriceMinor)} each)</span>` : ''}</p>
      </td>
    </tr>`).join('');
  const html = renderEmail({
    eyebrow: 'Quick decision needed',
    title: `${escapeHtml(ctx.customerName?.split(' ')[0] || 'Hi')}, we found a replacement 🔁`,
    lead: `${escapeHtml(businessName)} was out of stock on ${proposed.length === 1 ? 'an item' : 'some items'} in your order and picked a close substitute. Approve to keep it, or decline for a refund on those items.`,
    introHtml: `<p>Order ID: <span style="font-family: monospace; color:#374151;">#${escapeHtml(ctx.orderShortId)}</span></p>`,
    bodyHtml: `
      <table style="width:100%; margin: 8px 0 16px; border-collapse: collapse;">${rows}</table>
      ${ctx.orderUrl ? `
        <p style="margin-top: 8px;">
          <a href="${escapeHtml(ctx.orderUrl)}" style="display:inline-block; padding:10px 18px; border-radius:8px; background:#16a34a; color:#ffffff; text-decoration:none; font-weight:600;">Review &amp; decide</a>
        </p>
      ` : ''}
      ${renderSignature(`${escapeHtml(businessName)} Team`)}
    `,
    footerHtml: `Substitution request for order #${escapeHtml(ctx.orderShortId)} from ${escapeHtml(businessName)}.`,
  });
  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.ORDER_SUBSTITUTION_PROPOSED,
    to,
    recipientName: ctx.customerName,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    metadata: { orderId: ctx.orderId, orderShortId: ctx.orderShortId, proposedCount: proposed.length },
  });
}

// E-commerce (grocery) — the order total changed during picking (actual
// weights, shorted items, accepted substitutions). Sent once as the order
// leaves picking. Shows the original vs adjusted total and any refund.
async function sendOrderAdjustedEmail(to, ctx) {
  const businessName = ctx.businessName || 'DriftHR';
  const subject = `Your order #${ctx.orderShortId} total was updated`;
  const money = (minor) => {
    if (minor == null) return '';
    try {
      return new Intl.NumberFormat('en', { style: 'currency', currency: ctx.currency || 'INR', maximumFractionDigits: 0 }).format(minor / 100);
    } catch { return `${minor / 100}`; }
  };
  const refunded = ctx.refundedMinor || 0;
  const html = renderEmail({
    eyebrow: 'Order updated',
    title: `${escapeHtml(ctx.customerName?.split(' ')[0] || 'Hi')}, your order total changed`,
    lead: `While picking your order, ${escapeHtml(businessName)} adjusted it for actual weights, out-of-stock items, or substitutions.`,
    introHtml: `<p>Order ID: <span style="font-family: monospace; color:#374151;">#${escapeHtml(ctx.orderShortId)}</span></p>`,
    bodyHtml: `
      <table style="width:100%; margin: 8px 0 16px; border-collapse: collapse;">
        <tr><td style="padding:6px 0; font-size:13px; color:#6b7280;">Originally charged</td>
            <td style="padding:6px 0; font-size:14px; color:#9ca3af; text-align:right; text-decoration:line-through;">${money(ctx.totalMinor)}</td></tr>
        <tr><td style="padding:6px 0; font-size:13px; color:#111827; font-weight:600;">New total</td>
            <td style="padding:6px 0; font-size:16px; color:#111827; font-weight:800; text-align:right;">${money(ctx.adjustedTotalMinor)}</td></tr>
        ${refunded > 0 ? `<tr><td style="padding:6px 0; font-size:13px; color:#166534; font-weight:600;">Refunded to you</td>
            <td style="padding:6px 0; font-size:14px; color:#166534; font-weight:700; text-align:right;">${money(refunded)}</td></tr>` : ''}
      </table>
      ${renderOrderItemsBlock(ctx)}
      ${ctx.orderUrl ? `
        <p style="margin-top: 16px;">
          <a href="${escapeHtml(ctx.orderUrl)}" style="display:inline-block; padding:10px 18px; border-radius:8px; background:#16a34a; color:#ffffff; text-decoration:none; font-weight:600;">View order</a>
        </p>` : ''}
      ${renderSignature(`${escapeHtml(businessName)} Team`)}
    `,
    footerHtml: `Order total update for #${escapeHtml(ctx.orderShortId)} from ${escapeHtml(businessName)}.`,
  });
  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.ORDER_ADJUSTED,
    to,
    recipientName: ctx.customerName,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    metadata: { orderId: ctx.orderId, orderShortId: ctx.orderShortId, adjustedTotalMinor: ctx.adjustedTotalMinor, refundedMinor: refunded },
  });
}

// E-commerce — delivery confirmed. Fired when admin transitions
// OUT_FOR_DELIVERY → DELIVERED. Wraps up the order lifecycle and
// invites a follow-up purchase.
async function sendOrderDeliveredEmail(to, ctx) {
  const businessName = ctx.businessName || 'DriftHR';
  const subject = `Delivered — order #${ctx.orderShortId}`;
  const shopUrl = (() => {
    if (!ctx.orderUrl) return null;
    try {
      const u = new URL(ctx.orderUrl);
      return `${u.protocol}//${u.host}/shop`;
    } catch { return null; }
  })();
  const html = renderEmail({
    eyebrow: 'Delivered',
    title: `Your order from ${escapeHtml(businessName)} has been delivered ✅`,
    lead: `Thanks for shopping with ${escapeHtml(businessName)}. Hope you love your order — we'd love to see you back soon.`,
    introHtml: `<p>Order ID: <span style="font-family: monospace; color:#374151;">#${escapeHtml(ctx.orderShortId)}</span></p>`,
    bodyHtml: `
      ${renderOrderItemsBlock(ctx)}
      ${renderNotice('Something not right?', `Reply to this email within 7 days and ${escapeHtml(businessName)} will sort out a refund or replacement.`)}
      ${shopUrl ? `
        <p style="margin-top: 24px;">
          <a href="${escapeHtml(shopUrl)}" style="display:inline-block; padding:10px 18px; border-radius:8px; background:#111827; color:#ffffff; text-decoration:none; font-weight:600;">Visit the shop again</a>
        </p>
      ` : ''}
      ${renderSignature(`${escapeHtml(businessName)} Team`)}
    `,
    footerHtml: `Delivery confirmation for order #${escapeHtml(ctx.orderShortId)} from ${escapeHtml(businessName)}.`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.ORDER_DELIVERED,
    to,
    recipientName: ctx.customerName,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    metadata: { orderId: ctx.orderId, orderShortId: ctx.orderShortId },
  });
}

async function sendOrderDeliveryAttemptFailedEmail(to, ctx) {
  const businessName = ctx.businessName || 'DriftHR';
  const subject = `Delivery attempt update — order #${ctx.orderShortId}`;
  const html = renderEmail({
    eyebrow: 'Delivery update',
    title: `We could not complete delivery for order #${escapeHtml(ctx.orderShortId)}`,
    lead: `${escapeHtml(businessName)} tried to deliver your order, but the handoff could not be completed.`,
    introHtml: `<p>Order ID: <span style="font-family: monospace; color:#374151;">#${escapeHtml(ctx.orderShortId)}</span></p>`,
    bodyHtml: `
      ${renderNotice('What happened', escapeHtml(ctx.attemptNote || 'The rider marked this delivery attempt as unsuccessful.'))}
      ${renderShippingBlock(ctx)}
      ${renderOrderItemsBlock(ctx)}
      ${ctx.orderUrl ? `
        <p style="margin-top: 24px;">
          <a href="${escapeHtml(ctx.orderUrl)}" style="display:inline-block; padding:10px 18px; border-radius:8px; background:#4f46e5; color:#ffffff; text-decoration:none; font-weight:600;">View your order</a>
        </p>
      ` : ''}
      ${renderSignature(`${escapeHtml(businessName)} Team`)}
    `,
    footerHtml: `Delivery attempt update for order #${escapeHtml(ctx.orderShortId)} from ${escapeHtml(businessName)}.`,
  });

  await sendTrackedEmail({
    eventKey: EMAIL_EVENTS.ORDER_DELIVERY_ATTEMPT_FAILED,
    to,
    recipientName: ctx.customerName,
    subject,
    htmlBody: html,
    businessId: ctx.businessId || null,
    metadata: { orderId: ctx.orderId, orderShortId: ctx.orderShortId, attemptNote: ctx.attemptNote || null },
  });
}

module.exports = {
  sendEmail,
  sendTrackedEmail,
  sendWelcomeEmail,
  sendPasswordResetOtpEmail,
  sendUserSignupOtpEmail,
  sendCustomerSignupOtpEmail,
  sendAppointmentBookedEmail,
  sendStaffNewAppointmentEmail,
  sendAppointmentStatusEmail,
  sendAppointmentRescheduledEmail,
  sendStaffAppointmentRescheduledEmail,
  sendStaffAppointmentCancelledEmail,
  sendAppointmentAutoCancelledEmail,
  sendAppointmentCompletedEmail,
  sendPrescriptionReadyEmail,
  sendAppointmentNoShowEmail,
  sendAppointmentReviewRequestEmail,
  sendOrderReviewRequestEmail,
  sendCustomerWelcomeEmail,
  sendStaffInviteEmail,
  sendRiderInviteEmail,
  sendAdminNewAppointmentEmail,
  sendEnquiryReceivedAdminEmail,
  sendEnquiryAutoReplyEmail,
  sendLeaveRequestAdminEmail,
  sendLeaveStatusStaffEmail,
  sendBookingReminderEmail,
  sendStaffInviteReminderEmail,
  sendTrialExpiringEmail,
  sendSubscriptionStartedEmail,
  sendPaymentFailedEmail,
  sendSubscriptionCancelledEmail,
  sendWaitlistSlotOpenEmail,
  sendAdminBulkMessageEmail,
  sendOrderReceivedCustomerEmail,
  sendOrderReceivedAdminEmail,
  sendOrderPaidEmail,
  sendOrderOutForDeliveryEmail,
  sendOrderDeliveredEmail,
  sendOrderDeliveryAttemptFailedEmail,
  sendOrderReadyForPickupEmail,
  sendSubstitutionProposedEmail,
  sendOrderAdjustedEmail,
  sendBlogCommentNewAdminEmail,
};
