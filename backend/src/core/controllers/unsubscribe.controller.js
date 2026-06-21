// One-click unsubscribe handler. Mounted unauthenticated at
// /api/unsubscribe so an email recipient (who isn't logged in) can opt out
// with a single click. Records a CustomerMarketingOptOut row.
//
// URL format: /api/unsubscribe?e=<email>&c=<campaignKey>&b=<businessId>
//   - c omitted = global opt-out for that tenant
//   - GET shows a tiny confirmation page
//   - POST records the opt-out (HTML form on the page submits to itself)
'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const { CAMPAIGNS_BY_KEY } = require('../lib/marketing/campaigns');

function htmlPage({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
           background: #f9fafb; margin: 0; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: white; border-radius: 16px; padding: 40px; max-width: 480px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.04); }
    h1 { font-size: 22px; font-weight: 700; color: #111827; margin: 0 0 8px 0; }
    p { color: #6b7280; line-height: 1.6; font-size: 14px; }
    button, .btn { display: inline-block; padding: 10px 20px; border-radius: 8px;
                   border: 0; background: #4f46e5; color: white; font-weight: 600;
                   font-size: 14px; cursor: pointer; text-decoration: none; }
    .btn-secondary { background: white; color: #374151; border: 1px solid #d1d5db; }
    .row { display: flex; gap: 8px; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="card">
    ${body}
  </div>
</body>
</html>`;
}

// GET /api/unsubscribe?e=...&c=...&b=...
async function getPage(req, res) {
  const { e: email, c: campaignKey, b: businessId } = req.query;
  if (!email || !businessId) {
    return res.status(400).type('html').send(htmlPage({
      title: 'Invalid unsubscribe link',
      body: '<h1>Invalid link</h1><p>This unsubscribe link is incomplete. If you received an email and want to opt out, please reply with "STOP".</p>',
    }));
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { name: true },
  });
  const campaign = campaignKey ? CAMPAIGNS_BY_KEY[campaignKey] : null;

  const scopeText = campaign
    ? `the <strong>${campaign.displayName}</strong> emails`
    : `all marketing emails`;

  res.type('html').send(htmlPage({
    title: 'Unsubscribe',
    body: `
      <h1>Unsubscribe</h1>
      <p>You're about to unsubscribe <strong>${email}</strong> from ${scopeText} from <strong>${business?.name || 'this business'}</strong>.</p>
      <p>You'll still receive transactional messages (booking confirmations, reminders, etc.) — those aren't marketing.</p>
      <form method="POST" action="/api/unsubscribe?e=${encodeURIComponent(email)}${campaignKey ? `&c=${encodeURIComponent(campaignKey)}` : ''}&b=${encodeURIComponent(businessId)}">
        <div class="row">
          <button type="submit">Confirm unsubscribe</button>
          <a class="btn btn-secondary" href="https://sitepresso.com">Cancel</a>
        </div>
      </form>
    `,
  }));
}

// POST /api/unsubscribe?e=...&c=...&b=...
async function confirm(req, res) {
  const { e: email, c: campaignKey, b: businessId } = req.query;
  if (!email || !businessId) {
    return res.status(400).type('html').send(htmlPage({
      title: 'Invalid unsubscribe',
      body: '<h1>Invalid link</h1><p>Missing required fields.</p>',
    }));
  }

  try {
    // Try to find the customer row by email; if found, record by customerId
    // (more robust). Otherwise record by email.
    const customer = await prisma.customer.findFirst({
      where: { businessId, email },
      select: { id: true },
    });

    await prisma.customerMarketingOptOut.upsert({
      where: customer
        ? { businessId_customerId_campaignKey: {
            businessId, customerId: customer.id, campaignKey: campaignKey || null,
          } }
        : { businessId_recipientEmail_campaignKey: {
            businessId, recipientEmail: email, campaignKey: campaignKey || null,
          } },
      update: { source: 'CUSTOMER_LINK' },
      create: {
        businessId,
        ...(customer ? { customerId: customer.id } : { recipientEmail: email }),
        campaignKey: campaignKey || null,
        source: 'CUSTOMER_LINK',
      },
    });

    res.type('html').send(htmlPage({
      title: 'Unsubscribed',
      body: `
        <h1>You're unsubscribed ✓</h1>
        <p>We won't send you ${campaignKey ? 'these specific marketing' : 'any marketing'} messages from this business anymore.</p>
        <p>Made a mistake? Reply to any email from us and we'll undo it.</p>
      `,
    }));
  } catch (err) {
    console.error('[unsubscribe.confirm]', err);
    res.status(500).type('html').send(htmlPage({
      title: 'Error',
      body: '<h1>Something went wrong</h1><p>We couldn\'t complete your unsubscribe right now. Please try again or reply STOP.</p>',
    }));
  }
}

module.exports = { getPage, confirm };
