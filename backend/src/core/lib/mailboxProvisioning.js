// ============================================================================
// Mailbox provisioning service — the orchestrator behind the reseller email
// product. Generates credentials, creates the account in Zoho, publishes the
// mail DNS where we can, emails the customer their login, and persists a
// Mailbox row with a Domain-style status (PENDING -> ACTIVE / FAILED). It
// never throws into the caller's happy path: failures land as FAILED status
// so onboarding/launch still completes and the mailbox can be retried.
// ============================================================================

const crypto = require('crypto');
const prisma = require('./prisma');
const zoho = require('./zohoMail');
const cloudflareDns = require('./cloudflareDns');
const { sendMailboxCredentialsEmail } = require('../utils/email');

// Strong, Zoho-compliant temporary password (upper, lower, digit, symbol).
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const symbol = '!@#$%^&*?';
  const all = upper + lower + digit + symbol;
  const pick = (set) => set[crypto.randomInt(set.length)];
  const base = [pick(upper), pick(lower), pick(digit), pick(symbol)];
  while (base.length < 14) base.push(pick(all));
  // Fisher-Yates shuffle so the guaranteed chars aren't always first.
  for (let i = base.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [base[i], base[j]] = [base[j], base[i]];
  }
  return base.join('');
}

function loginUrlForRegion() {
  const region = String(process.env.ZOHO_MAIL_REGION || 'in').trim().toLowerCase() || 'in';
  return `https://mail.zoho.${region}`;
}

async function upsertMailbox({ businessId, address, domain, patch = {} }) {
  const existing = await prisma.mailbox.findUnique({ where: { businessId_address: { businessId, address } } }).catch(() => null);
  if (existing) {
    return prisma.mailbox.update({ where: { id: existing.id }, data: { domain, ...patch } });
  }
  return prisma.mailbox.create({ data: { businessId, address, domain, ...patch } });
}

// Provision (or retry) a mailbox. Returns the Mailbox row.
async function provisionMailbox({ businessId, localPart, domain, deliverTo, businessName }) {
  const local = String(localPart || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const cleanDomain = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.$/, '');
  if (!businessId) throw new Error('businessId required');
  if (!local || !cleanDomain) throw new Error('A mailbox address and connected domain are required');
  const address = `${local}@${cleanDomain}`;
  const recipient = String(deliverTo || '').trim() || null;

  // Record the intent immediately.
  let mailbox = await upsertMailbox({ businessId, address, domain: cleanDomain, patch: { status: 'PROVISIONING', statusMessage: 'Creating your mailbox…', deliveredTo: recipient } });

  // Not wired to Zoho yet → keep it queued, don't fail the caller.
  if (!zoho.isConfigured()) {
    return upsertMailbox({ businessId, address, domain: cleanDomain, patch: { status: 'PENDING', statusMessage: 'Queued — awaiting email provider activation. We’ll create the mailbox and email the login shortly.' } });
  }

  try {
    const cfg = zoho.zohoConfig();
    await zoho.addDomain(cleanDomain);
    const { dkim } = await zoho.getDomain(cleanDomain);

    const password = generatePassword();
    const account = await zoho.createAccount({ emailAddress: address, password, displayName: businessName || local });

    const records = zoho.mailDnsRecords(cleanDomain, { region: cfg.region, dkim });
    const dns = await cloudflareDns.writeRecords(cleanDomain, records);

    if (recipient) {
      await sendMailboxCredentialsEmail(recipient, {
        businessName,
        address,
        password,
        loginUrl: loginUrlForRegion(),
        dnsRecords: records,
        dnsManaged: dns.managed,
      }, { businessId });
    }

    mailbox = await upsertMailbox({
      businessId,
      address,
      domain: cleanDomain,
      patch: {
        status: 'ACTIVE',
        statusMessage: dns.managed
          ? 'Mailbox created and DNS configured. Credentials emailed to the customer.'
          : 'Mailbox created. Add the mail DNS records at the domain provider so delivery starts (records included in the credentials email).',
        zohoZoid: cfg.zoid,
        zohoAccountId: account.zohoAccountId,
        dnsManaged: dns.managed,
        deliveredTo: recipient,
        credentialsSentAt: recipient ? new Date() : null,
      },
    });
    return mailbox;
  } catch (err) {
    return upsertMailbox({ businessId, address, domain: cleanDomain, patch: { status: 'FAILED', statusMessage: `Provisioning failed: ${err.message}` } });
  }
}

module.exports = { provisionMailbox, generatePassword };
