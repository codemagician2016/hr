const RENEWAL_NOTICE_DAYS = Object.freeze([60, 30, 15, 7, 1]);
const NOTICE_STATUSES = Object.freeze(['ACTIVE', 'EXPIRING']);

function renewalWindow(now = new Date(), days) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() + days);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function renewalNoticeWindows(now = new Date()) {
  return RENEWAL_NOTICE_DAYS.map((days) => ({
    days,
    ...renewalWindow(now, days),
  }));
}

function startOfUtcDay(now = new Date()) {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function defaultDomainRenewalEmail({ domain, days }) {
  const expires = domain.expiresAt
    ? new Date(domain.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'soon';
  if (days <= 7 && !domain.autoRenew) {
    return {
      subject: `${domain.name} expires in ${days} day${days === 1 ? '' : 's'}`,
      html: `<p>${domain.name} expires on ${expires}. Renewal reminders are off, so renew it from your Sitepresso Domains tab now.</p>`,
    };
  }
  if (domain.autoRenew) {
    return {
      subject: `${domain.name} renewal is due in ${days} day${days === 1 ? '' : 's'}`,
      html: `<p>${domain.name} expires on ${expires}. Renewal reminders are on. Open your Sitepresso Domains tab and complete secure checkout to renew it.</p>`,
    };
  }
  return {
    subject: `${domain.name} renewal reminder`,
    html: `<p>${domain.name} expires on ${expires}. Renew it from your Sitepresso Domains tab to keep it active.</p>`,
  };
}

async function sendDomainNotice({ domain, days, listRecipients, sendEmail }) {
  if (!listRecipients || !sendEmail) return { sent: 0, skipped: true };
  const recipients = await listRecipients(domain.businessId).catch(() => []);
  const email = defaultDomainRenewalEmail({ domain, days });
  let sent = 0;
  for (const recipient of recipients) {
    if (!recipient?.email) continue;
    await sendEmail(recipient.email, email.subject, email.html);
    sent += 1;
  }
  return { sent };
}

async function runDomainRenewalCron({
  prisma,
  now = new Date(),
  startRenewal,
  renewDomain,
  expireDomain,
  listRecipients,
  sendEmail,
  logger = console,
} = {}) {
  if (!prisma?.domain) {
    throw new Error('Domain renewal cron requires prisma.domain.');
  }

  const windows = renewalNoticeWindows(now);
  const notices = [];
  for (const window of windows) {
    const domains = await prisma.domain.findMany({
      where: {
        expiresAt: { gte: window.start, lt: window.end },
        status: { in: NOTICE_STATUSES },
      },
    });
    for (const domain of domains) {
      if (window.days <= 14 && domain.status !== 'EXPIRING') {
        await prisma.domain.update({
          where: { id: domain.id },
          data: {
            status: 'EXPIRING',
            statusMessage: `Domain expires in ${window.days} day${window.days === 1 ? '' : 's'}.`,
          },
        });
      }
      const notice = await sendDomainNotice({ domain, days: window.days, listRecipients, sendEmail });
      notices.push({ domainId: domain.id, domain: domain.name, days: window.days, ...notice });
    }
  }

  const today = startOfUtcDay(now);
  const expired = await prisma.domain.findMany({
    where: {
      expiresAt: { lt: today },
      status: { in: ['ACTIVE', 'EXPIRING'] },
    },
  });

  const renewals = [];
  for (const domain of expired) {
    if (domain.autoRenew && domain.renewalPaymentStatus === 'PENDING') {
      const dueAt = domain.renewalPaymentDueAt ? new Date(domain.renewalPaymentDueAt) : null;
      if (dueAt && dueAt >= now) {
        renewals.push({
          domainId: domain.id,
          domain: domain.name,
          renewed: false,
          paymentPending: true,
          transactionId: domain.renewalPaddleTransactionId || null,
        });
        continue;
      }
      logger.warn?.('[domain-renewal] pending renewal payment overdue', domain.name);
    }
    if (domain.autoRenew) {
      logger.warn?.('[domain-renewal] renewal reminder enabled but no confirmed payment exists', domain.name);
    }
    if (expireDomain) {
      try {
        await expireDomain(domain);
      } catch (err) {
        logger.error?.('[domain-renewal] expiry cleanup failed', domain.name, err?.message || err);
      }
    }
    await prisma.domain.update({
      where: { id: domain.id },
      data: {
        status: 'EXPIRED',
        autoRenew: false,
        customHostnameId: null,
        statusMessage: 'Domain expired. The Sitepresso subdomain remains available as a fallback.',
      },
    });
    renewals.push({ domainId: domain.id, domain: domain.name, renewed: false, expired: true });
  }

  return { notices, renewals };
}

module.exports = {
  NOTICE_STATUSES,
  RENEWAL_NOTICE_DAYS,
  runDomainRenewalCron,
  renewalNoticeWindows,
  renewalWindow,
  startOfUtcDay,
};
